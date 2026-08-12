import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { PacketStreams } from '../../api/types.ts';
import type { Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { WebmMuxer, WebmStreamingMuxer } from './ebml-write.ts';
import { elements, findChild } from './ebml.ts';
import { WebmModule, parseWebm } from './webm-driver.ts';

const SUBJECT = new URL(
  '../../../../media-test/fixtures/media/scenarios/metadata/write_mkv_tags/03.mkv',
  import.meta.url,
).pathname;

const EBML_ID = {
  Segment: 0x18538067,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
} as const;

class TestEncodedChunk {
  readonly type: EncodedVideoChunkType | EncodedAudioChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: EncodedVideoChunkInit | EncodedAudioChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#data = ArrayBuffer.isView(init.data)
      ? new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength).slice()
      : new Uint8Array(init.data).slice();
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: BufferSource): void {
    const bytes = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    bytes.set(this.#data);
  }
}

async function withEncodedChunkConstructors<T>(run: () => Promise<T>): Promise<T> {
  const originalVideo = globalThis.EncodedVideoChunk;
  const originalAudio = globalThis.EncodedAudioChunk;
  const chunkConstructor = TestEncodedChunk as unknown as typeof EncodedVideoChunk &
    typeof EncodedAudioChunk;
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    value: chunkConstructor,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    value: chunkConstructor,
  });
  try {
    return await run();
  } finally {
    if (originalVideo === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
    else
      Object.defineProperty(globalThis, 'EncodedVideoChunk', {
        configurable: true,
        value: originalVideo,
      });
    if (originalAudio === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    else
      Object.defineProperty(globalThis, 'EncodedAudioChunk', {
        configurable: true,
        value: originalAudio,
      });
  }
}

async function bytesFromOutput(
  output: Blob | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (output instanceof Blob) return new Uint8Array(await output.arrayBuffer());
  if (output instanceof ReadableStream) {
    const reader = output.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  throw new Error('expected mux output');
}

function attachmentPayloads(bytes: Uint8Array): Uint8Array[] {
  return parseWebm(bytes).tracks.flatMap((track) =>
    track.attachedFilePayload === undefined ? [] : [track.attachedFilePayload],
  );
}

function blockTrackEntryCount(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segment = findChild(view, 0, view.byteLength, EBML_ID.Segment);
  if (segment === undefined) throw new Error('expected Matroska Segment');
  const tracks = findChild(view, segment.dataStart, segment.dataEnd, EBML_ID.Tracks);
  if (tracks === undefined) throw new Error('expected Matroska Tracks');
  return [...elements(view, tracks.dataStart, tracks.dataEnd)].filter(
    (element) => element.id === EBML_ID.TrackEntry,
  ).length;
}

async function collectPackets(stream: ReadableStream<Packet>): Promise<Packet[]> {
  const reader = stream.getReader();
  const packets: Packet[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return packets;
      packets.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function publicPacketMux(
  input: Uint8Array,
  options: {
    readonly fragmented?: boolean;
    readonly prepared?: boolean;
    readonly cloneTracks?: boolean;
    readonly codecs?: readonly string[];
    readonly container?: 'mkv' | 'webm';
  } = {},
): Promise<Uint8Array> {
  const media = createMedia().use(WebmModule);
  const demuxed = await media.demux(fromBytes(input, { mime: 'video/x-matroska' }));
  try {
    const copyable = demuxed.tracks.filter(
      (track) =>
        track.config !== undefined &&
        (options.codecs === undefined || options.codecs.includes(track.codec)),
    );
    const descriptorTrack = (track: TrackInfo): TrackInfo =>
      options.cloneTracks === true ? structuredClone(track) : track;
    const tracks = options.prepared
      ? await Promise.all(
          copyable.map(async (track) => ({
            track: descriptorTrack(track),
            packetsArray: await collectPackets(demuxed.packets(track.id)),
          })),
        )
      : copyable.map((track) => ({
          track: descriptorTrack(track),
          packets: demuxed.packets(track.id),
        }));
    return bytesFromOutput(
      await media.mux(
        { tracks },
        {
          container: options.container ?? 'mkv',
          ...(options.fragmented === true ? { fragmented: true } : {}),
        },
      ),
    );
  } finally {
    await demuxed.close();
  }
}

interface FfprobeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly extradata_hash?: string;
  readonly disposition?: { readonly attached_pic?: number };
  readonly tags?: { readonly filename?: string; readonly mimetype?: string };
}

function ffprobeAvailable(): boolean {
  return spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
}

function ffprobeStreams(bytes: Uint8Array): readonly FfprobeStream[] {
  const directory = mkdtempSync(join(tmpdir(), 'aibrush-attachment-packet-seam-'));
  const path = join(directory, 'output.mkv');
  try {
    writeFileSync(path, bytes);
    const result = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_streams',
        '-show_data_hash',
        'sha256',
        '-show_entries',
        'stream=codec_name,codec_type,extradata_hash:stream_disposition=attached_pic:stream_tags=filename,mimetype',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(`ffprobe failed: ${result.stderr}`);
    return (
      (JSON.parse(result.stdout) as { readonly streams?: readonly FfprobeStream[] }).streams ?? []
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe('Matroska attachments — public demux to packet mux seam', () => {
  it('shares one exact side-data bundle on every ordinary track and marks both projections', async () => {
    const input = new Uint8Array(await readFile(SUBJECT));
    const driver = await createMedia()
      .use(WebmModule)
      .demux(fromBytes(input, { mime: 'video/x-matroska' }));
    try {
      const [video, audio, json, cover] = driver.tracks;
      const bundle = video?.containerSideData;
      expect(bundle?.[0]?.kind).toBe('matroska-attachments');
      expect(bundle?.[0]?.attachedFilePayloads).toHaveLength(2);
      expect(audio?.containerSideData).toBe(bundle);
      expect(json?.containerSideData).toBe(bundle);
      expect(cover?.containerSideData).toBe(bundle);
      expect(json?.containerProjection).toEqual({
        kind: 'matroska-attachment',
        sideDataIndex: 0,
        attachmentIndex: 0,
      });
      expect(cover?.containerProjection).toEqual({
        kind: 'matroska-attachment',
        sideDataIndex: 0,
        attachmentIndex: 1,
      });
    } finally {
      await driver.close();
    }
  });

  it('preserves ordered opaque attachments without authoring attachment Block tracks', async () => {
    await withEncodedChunkConstructors(async () => {
      const input = new Uint8Array(await readFile(SUBJECT));
      const media = createMedia().use(WebmModule);
      const demuxed = await media.demux(fromBytes(input, { mime: 'video/x-matroska' }));
      try {
        const copyable = demuxed.tracks.filter((track) => track.config !== undefined);
        expect(copyable.map((track) => track.codec)).toEqual(['h264', 'aac', 'mjpeg']);
        const streams: PacketStreams = {
          tracks: copyable.map((track) => ({
            track,
            packets: demuxed.packets(track.id),
          })),
        };
        const output = await bytesFromOutput(await media.mux(streams, { container: 'mkv' }));

        expect(attachmentPayloads(output)).toEqual(attachmentPayloads(input));
        expect(parseWebm(output).tracks).toHaveLength(4);
        expect(blockTrackEntryCount(output)).toBe(2);
      } finally {
        await demuxed.close();
      }
    });
  });

  it('cross-container remux excludes attachment projections from timed MP4 tracks', async () => {
    await withEncodedChunkConstructors(async () => {
      const input = new Uint8Array(await readFile(SUBJECT));
      const media = createMedia().use(WebmModule);
      const output = await bytesFromOutput(
        await media.remux(fromBytes(input, { mime: 'video/x-matroska' }), { to: 'mp4' }),
      );
      const info = await media.probe(fromBytes(output, { mime: 'video/mp4' }));

      expect(info.tracks.map((track) => track.type)).toEqual(['video', 'audio']);
      expect(info.tracks[0]?.codec).toMatch(/^avc1\./);
      expect(info.tracks[1]?.codec).toBe('mp4a.40.2');
    });
  });

  it('marks presentation-ordered Matroska audio packets with source-proven DTS', async () => {
    await withEncodedChunkConstructors(async () => {
      const input = new Uint8Array(await readFile(SUBJECT));
      const demuxed = await createMedia()
        .use(WebmModule)
        .demux(fromBytes(input, { mime: 'video/x-matroska' }));
      try {
        const audio = demuxed.tracks.find(
          (track) => track.mediaType === 'audio' && !track.nonMedia,
        );
        if (audio === undefined) throw new Error('expected timed audio track');
        const packets = await collectPackets(demuxed.packets(audio.id));
        expect(packets.length).toBeGreaterThan(1);
        expect(packets.every((packet) => packet.dtsUs === packet.chunk.timestamp)).toBe(true);
      } finally {
        await demuxed.close();
      }
    });
  });

  it('retains both attachments when ordinary selection keeps only H.264 or only AAC', async () => {
    await withEncodedChunkConstructors(async () => {
      const input = new Uint8Array(await readFile(SUBJECT));
      for (const codec of ['h264', 'aac'] as const) {
        const output = await publicPacketMux(input, { codecs: [codec] });
        expect(attachmentPayloads(output)).toEqual(attachmentPayloads(input));
        expect(blockTrackEntryCount(output)).toBe(1);
        expect(parseWebm(output).tracks.map((track) => track.codec)).toEqual(
          codec === 'h264' ? ['h264', '', 'mjpeg'] : ['aac', '', 'mjpeg'],
        );
      }
    });
  });

  it('preserves attachments through prepared arrays and fragmented MKV without duplication', async () => {
    await withEncodedChunkConstructors(async () => {
      const input = new Uint8Array(await readFile(SUBJECT));
      for (const options of [
        { prepared: true, cloneTracks: true },
        { fragmented: true },
      ] as const) {
        const output = await publicPacketMux(input, options);
        expect(attachmentPayloads(output)).toEqual(attachmentPayloads(input));
        expect(attachmentPayloads(output)).toHaveLength(2);
        expect(blockTrackEntryCount(output)).toBe(2);
        expect(parseWebm(output).tracks).toHaveLength(4);
      }
    });
  });

  it('preserves intentional byte-identical attachments inside one ordered bundle', async () => {
    const input = new Uint8Array(await readFile(SUBJECT));
    const payload = attachmentPayloads(input)[0];
    if (payload === undefined) throw new Error('expected attachment payload');
    const muxer = new WebmMuxer({ container: 'mkv' }, 'matroska');
    const trackId = muxer.addTrack({
      id: 0,
      mediaType: 'video',
      codec: 'vp9',
      config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
      containerSideData: [
        {
          kind: 'matroska-attachments',
          attachedFilePayloads: [payload, payload],
        },
      ],
    });
    muxer.addChunkStruct(trackId, {
      timestampUs: 0,
      durationUs: 1_000_000,
      key: true,
      data: Uint8Array.of(0x82),
    });
    const outputPromise = bytesFromOutput(muxer.output);
    await muxer.finalize();
    expect(attachmentPayloads(await outputPromise)).toEqual([payload, payload]);
  });

  it('snapshots manual attachments and exact-deduplicates the same whole side-data bundle', async () => {
    const input = new Uint8Array(await readFile(SUBJECT));
    const payloads = attachmentPayloads(input);
    expect(payloads).toHaveLength(2);
    const manualPayloads = payloads.map((payload) => payload.slice());
    const muxer = new WebmMuxer({ container: 'mkv' }, 'matroska');
    for (const payload of manualPayloads) muxer.addAttachment(payload);
    manualPayloads[0]?.fill(0);
    const trackId = muxer.addTrack({
      id: 0,
      mediaType: 'video',
      codec: 'vp9',
      config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
      containerSideData: [{ kind: 'matroska-attachments', attachedFilePayloads: payloads }],
    });
    muxer.addChunkStruct(trackId, {
      timestampUs: 0,
      durationUs: 1_000_000,
      key: true,
      data: Uint8Array.of(0x82),
    });
    const outputPromise = bytesFromOutput(muxer.output);
    await muxer.finalize();
    expect(attachmentPayloads(await outputPromise)).toEqual(payloads);
  });

  it('Cluster-on-write mux carries side data in the fragmented init and discards projection packets', async () => {
    const input = new Uint8Array(await readFile(SUBJECT));
    const demuxed = await withEncodedChunkConstructors(() =>
      createMedia()
        .use(WebmModule)
        .demux(fromBytes(input, { mime: 'video/x-matroska' })),
    );
    try {
      const h264 = demuxed.tracks.find((track) => track.codec === 'h264');
      const cover = demuxed.tracks.find((track) => track.codec === 'mjpeg');
      if (h264 === undefined || cover === undefined)
        throw new Error('expected H.264 and cover tracks');
      const muxer = new WebmStreamingMuxer({ timelineBaseUs: 0 }, 'matroska');
      const videoTrackId = muxer.addTrack(h264);
      const coverTrackId = muxer.addTrack(cover);
      const outputPromise = bytesFromOutput(muxer.output);
      await muxer.addChunkStruct(videoTrackId, {
        timestampUs: 0,
        durationUs: 1_000_000,
        key: true,
        data: Uint8Array.of(0x65, 0x88),
      });
      await muxer.addChunkStruct(coverTrackId, {
        timestampUs: 0,
        durationUs: 1_000_000,
        key: true,
        data: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
      });
      await muxer.finalize();
      const output = await outputPromise;
      expect(attachmentPayloads(output)).toEqual(attachmentPayloads(input));
      expect(blockTrackEntryCount(output)).toBe(1);
    } finally {
      await demuxed.close();
    }
  });

  it('typed-rejects Matroska attachment side data for a WebM target', async () => {
    await withEncodedChunkConstructors(async () => {
      const input = new Uint8Array(await readFile(SUBJECT));
      await expect(
        publicPacketMux(input, { container: 'webm', prepared: true }),
      ).rejects.toBeInstanceOf(CapabilityError);
    });
  });

  it.skipIf(!ffprobeAvailable())(
    'independent ffprobe re-import sees H.264, AAC, JSON, and attached MJPEG with exact JSON hash',
    async () => {
      await withEncodedChunkConstructors(async () => {
        const output = await publicPacketMux(new Uint8Array(await readFile(SUBJECT)));
        const streams = ffprobeStreams(output);
        expect(streams.map((stream) => stream.codec_type)).toEqual([
          'video',
          'audio',
          'attachment',
          'video',
        ]);
        expect(streams[2]).toMatchObject({
          extradata_hash: 'SHA256:eabfc35bc7fe8cfe1ee202c7d347d6cc6267ba25acde92d626b826743aa945e2',
          tags: { filename: 'info.json', mimetype: 'application/json' },
        });
        expect(streams[3]).toMatchObject({
          codec_name: 'mjpeg',
          disposition: { attached_pic: 1 },
          tags: { filename: 'cover.jpg', mimetype: 'image/jpeg' },
        });
      });
    },
  );
});
