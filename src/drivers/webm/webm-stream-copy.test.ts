import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { WebmMuxer } from './ebml-write.ts';
import { elements, findChild } from './ebml.ts';
import { WebmDriver, WebmModule, demuxWebm, parseWebm } from './webm-driver.ts';

const MEDIA_TEST = new URL('../../../../media-test/fixtures/media/', import.meta.url).pathname;

const GOLDEN_DIR = new URL('../../../../media-test/fixtures/golden/', import.meta.url).pathname;

interface GoldenPacket {
  trackIndex: number;
  size: number;
  ptsUs: number;
  dtsUs: number;
  keyframe: boolean;
}

interface PacketRow {
  trackIndex: number;
  ptsUs: number;
  size: number;
  keyframe: boolean;
  digest: string;
}

interface TrimCase {
  id: string;
  asset: string;
  container: 'webm' | 'mkv';
  startUs: number;
  endUs: number;
  toleranceSec: number;
}

async function mediaFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_TEST}${name}`));
}

async function goldenPackets(name: string): Promise<GoldenPacket[]> {
  return JSON.parse(await readFile(`${GOLDEN_DIR}${name}.packets.json`, 'utf8')) as GoldenPacket[];
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.byteLength;
  }
  return out;
}

async function outputBytes(
  output: Blob | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (output instanceof Blob) return new Uint8Array(await output.arrayBuffer());
  if (output instanceof ReadableStream) return collect(output);
  throw new Error('expected materialized trim output');
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const ATTACHMENT_ID = {
  Segment: 0x18538067,
  Attachments: 0x1941a469,
  AttachedFile: 0x61a7,
  FileName: 0x466e,
  FileMimeType: 0x4660,
  FileData: 0x465c,
  FileUID: 0x46ae,
} as const;

interface AttachmentSnapshot {
  readonly name: string;
  readonly mimeType: string;
  readonly uidHex: string;
  readonly dataSize: number;
  readonly attachedFilePayloadDigest: string;
  readonly dataDigest: string;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Test-only raw EBML walk: hashes complete AttachedFile payloads, including unknown/duplicate children. */
function attachmentSnapshots(bytes: Uint8Array): AttachmentSnapshot[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segment = findChild(view, 0, view.byteLength, ATTACHMENT_ID.Segment);
  if (segment === undefined) throw new Error('expected Matroska Segment');
  const attachments = findChild(
    view,
    segment.dataStart,
    segment.dataEnd,
    ATTACHMENT_ID.Attachments,
  );
  if (attachments === undefined) return [];
  const snapshots: AttachmentSnapshot[] = [];
  for (const attachedFile of elements(view, attachments.dataStart, attachments.dataEnd)) {
    if (attachedFile.id !== ATTACHMENT_ID.AttachedFile) continue;
    const children = [...elements(view, attachedFile.dataStart, attachedFile.dataEnd)];
    const childBytes = (id: number): Uint8Array => {
      const child = children.find((candidate) => candidate.id === id);
      if (child === undefined)
        throw new Error(`AttachedFile is missing child 0x${id.toString(16)}`);
      return bytes.subarray(child.dataStart, child.dataEnd);
    };
    const data = childBytes(ATTACHMENT_ID.FileData);
    snapshots.push({
      name: new TextDecoder().decode(childBytes(ATTACHMENT_ID.FileName)),
      mimeType: new TextDecoder().decode(childBytes(ATTACHMENT_ID.FileMimeType)),
      uidHex: hex(childBytes(ATTACHMENT_ID.FileUID)),
      dataSize: data.byteLength,
      attachedFilePayloadDigest: digest(
        bytes.subarray(attachedFile.dataStart, attachedFile.dataEnd),
      ),
      dataDigest: digest(data),
    });
  }
  return snapshots;
}

interface FfprobeStreamTruth {
  readonly index: number;
  readonly codecName?: string;
  readonly codecType?: string;
  readonly extradataSize?: number;
  readonly extradataHash?: string;
  readonly attachedPic: number;
  readonly filename?: string;
  readonly mimeType?: string;
}

interface FfprobeTruth {
  readonly streams: readonly FfprobeStreamTruth[];
  readonly coverPacketHash: string;
}

function ffprobeAvailable(): boolean {
  return spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
}

/** Independent reference re-import, including hashes for opaque JSON and attached-picture bytes. */
function ffprobeTruth(bytes: Uint8Array): FfprobeTruth {
  const dir = mkdtempSync(join(tmpdir(), 'aibrush-webm-attachments-'));
  const path = join(dir, 'subject.mkv');
  try {
    writeFileSync(path, bytes);
    const streamsResult = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_streams',
        '-show_data_hash',
        'sha256',
        '-show_entries',
        'stream=index,codec_name,codec_type,extradata_size,extradata_hash:stream_disposition=attached_pic:stream_tags=filename,mimetype',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' },
    );
    if (streamsResult.status !== 0) {
      throw new Error(`ffprobe stream re-import failed: ${streamsResult.stderr}`);
    }
    const parsedStreams = JSON.parse(streamsResult.stdout) as {
      streams?: Array<{
        index: number;
        codec_name?: string;
        codec_type?: string;
        extradata_size?: number;
        extradata_hash?: string;
        disposition?: { attached_pic?: number };
        tags?: { filename?: string; mimetype?: string };
      }>;
    };
    const packetResult = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_packets',
        '-show_data_hash',
        'sha256',
        '-select_streams',
        'v:1',
        '-show_entries',
        'packet=data_hash',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' },
    );
    if (packetResult.status !== 0) {
      throw new Error(`ffprobe cover-packet re-import failed: ${packetResult.stderr}`);
    }
    const parsedPackets = JSON.parse(packetResult.stdout) as {
      packets?: Array<{ data_hash?: string }>;
    };
    const coverPacketHash = parsedPackets.packets?.[0]?.data_hash;
    if (coverPacketHash === undefined)
      throw new Error('ffprobe found no attached-picture packet hash');
    return {
      streams: (parsedStreams.streams ?? []).map((stream) => ({
        index: stream.index,
        ...(stream.codec_name !== undefined ? { codecName: stream.codec_name } : {}),
        ...(stream.codec_type !== undefined ? { codecType: stream.codec_type } : {}),
        ...(stream.extradata_size !== undefined ? { extradataSize: stream.extradata_size } : {}),
        ...(stream.extradata_hash !== undefined ? { extradataHash: stream.extradata_hash } : {}),
        attachedPic: stream.disposition?.attached_pic ?? 0,
        ...(stream.tags?.filename !== undefined ? { filename: stream.tags.filename } : {}),
        ...(stream.tags?.mimetype !== undefined ? { mimeType: stream.tags.mimetype } : {}),
      })),
      coverPacketHash,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function packetRows(bytes: Uint8Array): PacketRow[] {
  const demux = demuxWebm(bytes);
  return demux.framesByIndex.flatMap((frames, trackIndex) =>
    frames.map((frame) => ({
      trackIndex,
      ptsUs: frame.timestampUs,
      size: frame.data.byteLength,
      keyframe: frame.keyframe,
      digest: digest(frame.data),
    })),
  );
}

function firstVideoTrackIndex(bytes: Uint8Array): number {
  const info = parseWebm(bytes);
  const index = info.tracks.findIndex((track) => track.mediaType === 'video');
  if (index < 0) throw new Error('expected a video track');
  return index;
}

async function streamCopyTrim(
  bytes: Uint8Array,
  trim: { startUs: number; endUs: number },
  container?: 'webm' | 'mkv',
): Promise<Uint8Array> {
  const streamCopy = WebmDriver.streamCopy;
  if (streamCopy === undefined) throw new Error('WebmDriver.streamCopy must be implemented');
  return collect(
    await streamCopy(
      fromBytes(bytes, { mime: container === 'mkv' ? 'video/x-matroska' : 'video/webm' }),
      {
        ...(container !== undefined ? { container } : {}),
        trim: { startSec: trim.startUs / 1e6, endSec: trim.endUs / 1e6 },
      },
    ),
  );
}

async function streamCopyAll(bytes: Uint8Array, fragmented = false): Promise<Uint8Array> {
  const streamCopy = WebmDriver.streamCopy;
  if (streamCopy === undefined) throw new Error('WebmDriver.streamCopy must be implemented');
  return collect(
    await streamCopy(fromBytes(bytes, { mime: 'video/x-matroska' }), {
      container: 'mkv',
      ...(fragmented ? { fragmented: true } : {}),
    }),
  );
}

function expectDurationWithin(bytes: Uint8Array, requestedUs: number, toleranceSec: number): void {
  const got = parseWebm(bytes).durationSec;
  const want = requestedUs / 1e6;
  expect(Math.abs(got - want)).toBeLessThanOrEqual(toleranceSec);
}

function assertOutputPacketsAreSourceSubset(source: Uint8Array, output: Uint8Array): void {
  const sourceRows = packetRows(source);
  const outputRows = packetRows(output);
  expect(outputRows.length).toBeGreaterThan(0);
  expect(outputRows.length).toBeLessThan(sourceRows.length);
  const sourceByTrack = new Map<number, string[]>();
  for (const row of sourceRows) {
    const key = `${row.size}:${row.keyframe}:${row.digest}`;
    const list = sourceByTrack.get(row.trackIndex) ?? [];
    list.push(key);
    sourceByTrack.set(row.trackIndex, list);
  }
  for (const row of outputRows) {
    const key = `${row.size}:${row.keyframe}:${row.digest}`;
    const list = sourceByTrack.get(row.trackIndex) ?? [];
    expect(list).toContain(key);
  }
}

describe('WebmDriver.streamCopy — Session 6 R3 keyframe trim', () => {
  const cases: readonly TrimCase[] = [
    {
      id: 'trim/vp9_keyframe_aligned',
      asset: 'vp9_1080p_10s.webm',
      container: 'webm',
      startUs: 1_000_000,
      endUs: 5_000_000,
      toleranceSec: 1.1,
    },
    {
      id: 'trim/mkv_keyframe_aligned',
      asset: 'h264_in_mkv.mkv',
      container: 'mkv',
      startUs: 1_000_000,
      endUs: 5_000_000,
      toleranceSec: 1.1,
    },
    {
      id: 'trim/av1_keyframe_aligned',
      asset: 'av1_720p_5s.webm',
      container: 'webm',
      startUs: 1_000_000,
      endUs: 4_000_000,
      toleranceSec: 0.5,
    },
    {
      id: 'trim/vp8_keyframe_aligned',
      asset: 'vp8_720p_10s.webm',
      container: 'webm',
      startUs: 1_000_000,
      endUs: 5_000_000,
      toleranceSec: 1.1,
    },
    {
      id: 'trim/vp9_alpha_keyframe_aligned',
      asset: 'vp9_alpha.webm',
      container: 'webm',
      startUs: 1_000_000,
      endUs: 3_000_000,
      toleranceSec: 0.5,
    },
  ];

  it.each(cases)(
    '$id re-emits a valid source-family EBML file whose video starts on a keyframe',
    async ({ asset, container, startUs, endUs, toleranceSec }) => {
      const source = await mediaFixture(asset);
      const output = await streamCopyTrim(source, { startUs, endUs });
      const info = parseWebm(output);
      expect(info.container).toBe(container);
      expectDurationWithin(output, endUs - startUs, toleranceSec);
      assertOutputPacketsAreSourceSubset(source, output);

      const videoTrackIndex = firstVideoTrackIndex(output);
      const videoRows = packetRows(output).filter((row) => row.trackIndex === videoTrackIndex);
      expect(videoRows[0]?.keyframe).toBe(true);
      expect(videoRows[0]?.ptsUs).toBe(0);
      expect(videoRows.some((row) => row.ptsUs < 0)).toBe(false);
      if (asset === 'vp9_alpha.webm') {
        const alphaFrames = demuxWebm(output).framesByIndex[videoTrackIndex] ?? [];
        expect(alphaFrames.length).toBeGreaterThan(0);
        expect(alphaFrames.every((frame) => frame.alpha !== undefined)).toBe(true);
      }
    },
  );

  it('trim/vp9_noop_full_range_idempotent reimports against the golden packet table without passthrough', async () => {
    const source = await mediaFixture('vp9_1080p_10s.webm');
    const output = await streamCopyTrim(source, { startUs: 0, endUs: 10_000_000 }, 'webm');
    expect(digest(output)).not.toBe(digest(source));
    expectDurationWithin(output, 10_000_000, 0.05);

    const outputRows = packetRows(output);
    const golden = await goldenPackets('vp9_1080p_10s.webm');
    expect(outputRows).toHaveLength(golden.length);

    const trackIds = new Set(golden.map((packet) => packet.trackIndex));
    for (const trackIndex of trackIds) {
      const gotRows = outputRows.filter((row) => row.trackIndex === trackIndex);
      const wantRows = golden.filter((packet) => packet.trackIndex === trackIndex);
      expect(gotRows).toHaveLength(wantRows.length);
      const gotOrigin = gotRows[0]?.ptsUs ?? 0;
      const wantOrigin = wantRows[0]?.ptsUs ?? 0;
      for (let i = 0; i < wantRows.length; i++) {
        const got = gotRows[i];
        const want = wantRows[i];
        if (got === undefined || want === undefined)
          throw new Error(`missing packet ${trackIndex}:${i}`);
        expect(got.size).toBe(want.size);
        expect(got.keyframe).toBe(want.keyframe);
        expect(Math.abs(got.ptsUs - gotOrigin - (want.ptsUs - wantOrigin))).toBeLessThanOrEqual(
          1000,
        );
      }
    }
  });

  it('same-container MKV stream copy preserves ordered AttachedFile payloads and re-probes four streams', async () => {
    const source = await mediaFixture('scenarios/metadata/write_mkv_tags/03.mkv');
    const output = await streamCopyAll(source);
    const expectedAttachments: readonly AttachmentSnapshot[] = [
      {
        name: 'info.json',
        mimeType: 'application/json',
        uidHex: '5ef0f49454fc4345',
        dataSize: 25_767,
        attachedFilePayloadDigest:
          '94809623d5fb191d9114f6824570bb0ac39b0b9b823f2b10baec88589723f69a',
        dataDigest: 'eabfc35bc7fe8cfe1ee202c7d347d6cc6267ba25acde92d626b826743aa945e2',
      },
      {
        name: 'cover.jpg',
        mimeType: 'image/jpeg',
        uidHex: '82dbaaf00f2e3caa',
        dataSize: 30_915,
        attachedFilePayloadDigest:
          '8319531570feb8684f066d3f62b3b38157f7bac310680aa91074280603fd9330',
        dataDigest: '2789c355e52b5cdd875fc70825887a22c18135a9c7bead2c5ce483ae16c3d1c8',
      },
    ];

    expect(digest(output)).not.toBe(digest(source));
    expect(attachmentSnapshots(source)).toEqual(expectedAttachments);
    expect(attachmentSnapshots(output)).toEqual(expectedAttachments);
    expect(
      parseWebm(output).tracks.map((track) => ({
        mediaType: track.mediaType,
        codec: track.codec,
        nonMedia: track.nonMedia,
        width: track.width,
        height: track.height,
      })),
    ).toEqual([
      expect.objectContaining({ mediaType: 'video', codec: 'h264' }),
      expect.objectContaining({ mediaType: 'audio', codec: 'aac' }),
      expect.objectContaining({ mediaType: 'audio', codec: '', nonMedia: true }),
      expect.objectContaining({ mediaType: 'video', codec: 'mjpeg', width: 480, height: 360 }),
    ]);
  });

  it.skipIf(!ffprobeAvailable())(
    'same-container MKV stream copy independently ffprobes with byte-identical JSON and JPEG attachments',
    async () => {
      const source = await mediaFixture('scenarios/metadata/write_mkv_tags/03.mkv');
      const output = await streamCopyAll(source);
      const sourceTruth = ffprobeTruth(source);
      expect(sourceTruth.streams.map((stream) => stream.codecType)).toEqual([
        'video',
        'audio',
        'attachment',
        'video',
      ]);
      expect(sourceTruth.streams[2]).toMatchObject({
        filename: 'info.json',
        mimeType: 'application/json',
        extradataHash: 'SHA256:eabfc35bc7fe8cfe1ee202c7d347d6cc6267ba25acde92d626b826743aa945e2',
      });
      expect(sourceTruth.streams[3]).toMatchObject({
        codecName: 'mjpeg',
        attachedPic: 1,
        filename: 'cover.jpg',
        mimeType: 'image/jpeg',
      });
      expect(sourceTruth.coverPacketHash).toBe(
        'SHA256:2789c355e52b5cdd875fc70825887a22c18135a9c7bead2c5ce483ae16c3d1c8',
      );
      expect(ffprobeTruth(output)).toEqual(sourceTruth);
    },
  );

  it('fragmented MKV copy retains attachments in the init segment', async () => {
    const source = await mediaFixture('scenarios/metadata/write_mkv_tags/03.mkv');
    const output = await streamCopyAll(source, true);
    expect(attachmentSnapshots(output)).toEqual(attachmentSnapshots(source));
    expect(parseWebm(output).tracks).toHaveLength(4);
  });

  it('opaque AttachedFile payloads preserve duplicate and unknown children in order', async () => {
    const source = await mediaFixture('scenarios/metadata/write_mkv_tags/03.mkv');
    const originalPayload = parseWebm(source).tracks.find(
      (track) => track.attachedFilePayload !== undefined,
    )?.attachedFilePayload;
    if (originalPayload === undefined) throw new Error('expected a real AttachedFile payload');
    // Valid EBML children appended to the real JSON attachment: a duplicate FileName, then an unknown
    // two-byte ID. A known-field rebuild would normalize/drop them; opaque stream copy must not.
    const duplicateFileName = Uint8Array.from([
      0x46, 0x6e, 0x89, 0x63, 0x6f, 0x70, 0x79, 0x2e, 0x6a, 0x73, 0x6f, 0x6e,
    ]);
    const unknownChild = Uint8Array.from([0x4a, 0xbc, 0x82, 0xde, 0xad]);
    const payload = concat([originalPayload, duplicateFileName, unknownChild]);

    const muxer = new WebmMuxer({ container: 'mkv' }, 'matroska');
    muxer.addAttachment(payload);
    const trackId = muxer.addTrack({
      id: 0,
      mediaType: 'video',
      codec: 'vp9',
      durationSec: 1,
      fps: 1,
      config: { codec: 'vp09.00.10.08', codedWidth: 1, codedHeight: 1 },
    });
    muxer.addChunkStruct(trackId, {
      timestampUs: 0,
      durationUs: 1_000_000,
      key: true,
      data: Uint8Array.of(0x82),
    });
    const outputPromise = collect(muxer.output);
    await muxer.finalize();
    const output = await outputPromise;
    expect(
      parseWebm(output).tracks.find((track) => track.attachedFilePayload !== undefined)
        ?.attachedFilePayload,
    ).toEqual(payload);

    const webmMuxer = new WebmMuxer();
    expect(() => webmMuxer.addAttachment(payload)).toThrow(CapabilityError);
  });

  it('public media.trim reaches WebM streamCopy without WebCodecs in Node', async () => {
    const source = await mediaFixture('vp9_1080p_10s.webm');
    const output = await outputBytes(
      await createMedia()
        .use(WebmModule)
        .trim(fromBytes(source, { mime: 'video/webm' }), {
          mode: 'keyframe',
          start: 1,
          end: 5,
        }),
    );
    expect(parseWebm(output).container).toBe('webm');
    expectDurationWithin(output, 4_000_000, 1.1);
    const videoRows = packetRows(output).filter(
      (row) => row.trackIndex === firstVideoTrackIndex(output),
    );
    expect(videoRows[0]?.keyframe).toBe(true);
  });
});
