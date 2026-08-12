import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { parseAsc } from '../../codecs/aac-config.ts';
import type { ByteSource, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { fixtureSource, loadFixture, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { WebmMuxer } from './ebml-write.ts';
import {
  WebmDriver,
  WebmModule,
  demuxWebm,
  parseWebm,
  webmPacketPayloadInfoFromBytes,
} from './webm-driver.ts';

// A real H.264-in-Matroska asset (ffprobe: h264 High 1280×720 + aac 48k/2ch) lives in the sibling
// acceptance corpus, not this project's manifest, so it is read by direct path — like the mpegts tests.
const MEDIA_TEST = new URL('../../../../media-test/fixtures/media/', import.meta.url).pathname;
async function bytesFromMediaTest(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${MEDIA_TEST}${name}`));
}

async function probeWithWebmDriver(
  src: ByteSource,
  signal?: AbortSignal,
): Promise<readonly TrackInfo[]> {
  if (WebmDriver.probe === undefined) throw new Error('WebmDriver.probe is not registered');
  return WebmDriver.probe(src, signal !== undefined ? { signal } : undefined);
}

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
    const dst = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    dst.set(this.#data);
  }
}

async function withEncodedChunkConstructors<T>(fn: () => Promise<T>): Promise<T> {
  const originalVideo = globalThis.EncodedVideoChunk;
  const originalAudio = globalThis.EncodedAudioChunk;
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    value: TestEncodedChunk as unknown as typeof EncodedVideoChunk,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    value: TestEncodedChunk as unknown as typeof EncodedAudioChunk,
  });
  try {
    return await fn();
  } finally {
    if (originalVideo === undefined) {
      Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
    } else {
      Object.defineProperty(globalThis, 'EncodedVideoChunk', {
        configurable: true,
        value: originalVideo,
      });
    }
    if (originalAudio === undefined) {
      Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    } else {
      Object.defineProperty(globalThis, 'EncodedAudioChunk', {
        configurable: true,
        value: originalAudio,
      });
    }
  }
}

// ── EBML builders ────────────────────────────────────────────────────────────────────────────────
const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
function sizeVint(n: number): number[] {
  if (n < 0x7f) return [0x80 | n];
  if (n < 0x3fff) return [0x40 | (n >> 8), n & 0xff];
  if (n < 0x1fffff) return [0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff];
  return [0x10 | (n >> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function leb128(n: number): number[] {
  const out: number[] = [];
  let remaining = n;
  do {
    const low = remaining % 128;
    remaining = Math.floor(remaining / 128);
    out.push(low | (remaining > 0 ? 0x80 : 0));
  } while (remaining > 0);
  return out;
}
function uintN(value: number, len: number): number[] {
  const out: number[] = [];
  for (let i = len - 1; i >= 0; i--) out.push((value / 256 ** i) & 0xff);
  return out;
}
function f64(value: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value, false);
  return [...b];
}
const el = (id: number[], data: number[]): number[] => [...id, ...sizeVint(data.length), ...data];

const E = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1],
  Duration: [0x44, 0x89],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackType: [0x83],
  TrackNumber: [0xd7],
  CodecID: [0x86],
  CodecPrivate: [0x63, 0xa2],
  DefaultDuration: [0x23, 0xe3, 0x83],
  Language: [0x22, 0xb5, 0x9c],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  AlphaMode: [0x53, 0xc0],
  Audio: [0xe1],
  SamplingFrequency: [0xb5],
  Channels: [0x9f],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timecode: [0xe7],
  SimpleBlock: [0xa3],
  BlockGroup: [0xa0],
  Block: [0xa1],
  BlockDuration: [0x9b],
  BlockAdditions: [0x75, 0xa1],
  BlockMore: [0xa6],
  BlockAdditional: [0xa5],
  BlockAddID: [0xee],
  ReferenceBlock: [0xfb],
  Void: [0xec],
};

describe('WebmDriver.supports', () => {
  it('recognizes EBML magic, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('movie_5.webm')).subarray(0, 16);
    expect(WebmDriver.supports({ direction: 'demux', head })).toBe(true);
    expect(WebmDriver.supports({ direction: 'demux', mime: 'video/webm' })).toBe(true);
    expect(WebmDriver.supports({ direction: 'demux', extension: 'mkv' })).toBe(true);
    expect(WebmDriver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(WebmDriver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('probe WebM across the real corpus', () => {
  it('projects the real declared VP9 alpha mode without scanning BlockAdditions', async () => {
    for (const bytes of [
      await loadFixture('bear-vp9-alpha.webm'),
      await bytesFromMediaTest('vp9_alpha.webm'),
    ]) {
      const tracks = await probeWithWebmDriver(fromBytes(bytes, { mime: 'video/webm' }));
      expect(tracks.find((track) => track.mediaType === 'video')).toMatchObject({
        codec: 'vp9',
        alpha: true,
      });
    }
  });

  it('movie_5.webm — vp9 video + opus audio, ~5 s', async () => {
    const info = await createMedia()
      .use(WebmModule)
      .probe(await fixtureSource('movie_5.webm'));
    expect(info.container).toBe('webm');
    expect(info.tracks.find((t) => t.type === 'video')?.codec).toBe('vp9');
    expect(info.tracks.find((t) => t.type === 'video')?.width).toBe(320);
    expect(info.tracks.find((t) => t.type === 'audio')?.codec).toBe('opus');
    expect(info.durationSec).toBeGreaterThan(4);
    expect(info.durationSec).toBeLessThan(6);
  });

  it('2x2-green.webm — tiny vp8 video', async () => {
    const info = await createMedia()
      .use(WebmModule)
      .probe(await fixtureSource('2x2-green.webm'));
    const video = info.tracks.find((t) => t.type === 'video');
    expect(video?.codec).toBe('vp8');
    expect(video?.width).toBe(2);
    expect(video?.height).toBe(2);
    expect(info.durationSec).toBeGreaterThan(0);
  });

  it('recorder_headerless.webm — consecutive unknown-size Clusters retain the complete timeline', async () => {
    const bytes = await bytesFromMediaTest('recorder_headerless.webm');
    const info = parseWebm(bytes);
    const demuxed = demuxWebm(bytes);
    const videoIndex = demuxed.info.tracks.findIndex((track) => track.mediaType === 'video');
    const frames = demuxed.framesByIndex[videoIndex] ?? [];

    // This MediaRecorder stream starts a second unknown-size Cluster at 1.680 s. Treating the first
    // Cluster as the Segment remainder truncates exactly 79 frames and the entire second GOP.
    expect(info.durationSec).toBe(2.98);
    expect(frames).toHaveLength(180);
    expect(frames[0]?.timestampUs).toBe(0);
    expect(frames.at(-1)?.timestampUs).toBe(2_980_000);
    expect(frames.filter((frame) => frame.keyframe).map((frame) => frame.timestampUs)).toEqual([
      0, 1_680_000,
    ]);
  });

  it.each(['movie_5.webm', '2x2-green.webm', 'white.webm'])(
    '%s probe matches its committed golden',
    async (id) => {
      const info = await createMedia()
        .use(WebmModule)
        .probe(await fixtureSource(id));
      expect(info).toEqual(await loadGoldenMetadata(id));
    },
  );

  it('WebmDriver.probe uses a bounded range prefix without opening a stream', async () => {
    const bytes = await loadFixture('movie_5.webm');
    const calls: Array<readonly [number, number]> = [];
    const src: ByteSource = {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        calls.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('metadata probe should prefer the seekable range source');
      },
    };

    const tracks = await probeWithWebmDriver(src);
    expect(calls).toEqual([[0, 8 * 1024]]);
    expect(tracks.find((track) => track.mediaType === 'video')?.codec).toBe('vp9');
    expect(tracks.find((track) => track.mediaType === 'audio')?.codec).toBe('opus');
  });

  it('reads small remote terminal-timeline WebM through one owned complete response', async () => {
    const bytes = await bytesFromMediaTest('recorder_headerless.webm');
    const reads: Array<readonly [number, number]> = [];
    let wholeReads = 0;
    const source: ByteSource & {
      readonly kind: 'url';
      readAll(signal?: AbortSignal): Promise<Uint8Array>;
    } = {
      kind: 'url',
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      readAll(): Promise<Uint8Array> {
        wholeReads++;
        return Promise.resolve(bytes);
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('small remote WebM should use the owned whole-read capability');
      },
    };
    const expected = await probeWithWebmDriver({
      size: bytes.byteLength,
      stream: () => new Blob([Uint8Array.from(bytes).buffer]).stream(),
    });

    expect(await probeWithWebmDriver(source)).toEqual(expected);
    expect(reads).toEqual([]);
    expect(wholeReads).toBe(1);
  });

  it('probes unknown-size remote terminal-timeline WebM in one bounded clamped range', async () => {
    const bytes = await bytesFromMediaTest('recorder_headerless.webm');
    const reads: Array<readonly [number, number]> = [];
    let learnedSize: number | undefined;
    const expected = await probeWithWebmDriver(fromBytes(bytes, { mime: 'video/webm' }));
    const source = {
      kind: 'url',
      get size(): number | undefined {
        return learnedSize;
      },
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        learnedSize = bytes.byteLength;
        return Promise.resolve(bytes.subarray(start, Math.min(end, bytes.byteLength)));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('unknown-size remote WebM probe should remain range-backed');
      },
    } as ByteSource & { readonly kind: 'url' };

    expect(await probeWithWebmDriver(source)).toEqual(expected);
    expect(reads).toEqual([[0, 256 * 1024]]);
  });

  it('uses the same one-read policy for small remote declared-timeline WebM metadata', async () => {
    const bytes = await loadFixture('movie_5.webm');
    const reads: Array<readonly [number, number]> = [];
    let wholeReads = 0;
    const expected = await probeWithWebmDriver(fromBytes(bytes, { mime: 'video/webm' }));

    const actual = await probeWithWebmDriver({
      kind: 'url',
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      readAll(): Promise<Uint8Array> {
        wholeReads++;
        return Promise.resolve(bytes);
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('small remote declared WebM should use the owned whole-read capability');
      },
    } as ByteSource & { readonly kind: 'url'; readAll(): Promise<Uint8Array> });

    expect(actual).toEqual(expected);
    expect(reads).toEqual([]);
    expect(wholeReads).toBe(1);
  });

  it('keeps large remote declared-timeline WebM on the bounded metadata prefix', async () => {
    const bytes = await bytesFromMediaTest('av1_720p_5s.webm');
    const reads: Array<readonly [number, number]> = [];

    await probeWithWebmDriver({
      kind: 'url',
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('large remote WebM metadata probe must remain bounded');
      },
    } as ByteSource & { readonly kind: 'url' });

    expect(reads).toEqual([[0, 8 * 1024]]);
  });

  it('keeps unknown-size large remote WebM bounded at the transfer crossover', async () => {
    const bytes = await bytesFromMediaTest('av1_720p_5s.webm');
    const reads: Array<readonly [number, number]> = [];
    let learnedSize: number | undefined;

    await probeWithWebmDriver({
      kind: 'url',
      get size(): number | undefined {
        return learnedSize;
      },
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        learnedSize = bytes.byteLength;
        return Promise.resolve(bytes.subarray(start, Math.min(end, bytes.byteLength)));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('unknown-size large remote WebM metadata probe must remain bounded');
      },
    } as ByteSource & { readonly kind: 'url' });

    expect(bytes.byteLength).toBeGreaterThan(256 * 1024);
    expect(reads).toEqual([[0, 256 * 1024]]);
  });

  it('rechecks cancellation after an unknown-size remote WebM range response', async () => {
    const bytes = await bytesFromMediaTest('recorder_headerless.webm');
    const controller = new AbortController();
    const reads: Array<readonly [number, number]> = [];
    let learnedSize: number | undefined;

    await expect(
      probeWithWebmDriver(
        {
          kind: 'url',
          get size(): number | undefined {
            return learnedSize;
          },
          range(start, end): Promise<Uint8Array> {
            reads.push([start, end]);
            learnedSize = bytes.byteLength;
            controller.abort('cancel unknown-size remote WebM probe');
            return Promise.resolve(bytes.subarray(start, Math.min(end, bytes.byteLength)));
          },
          stream(): ReadableStream<Uint8Array> {
            throw new Error('cancelled unknown-size remote WebM probe should remain range-backed');
          },
        } as ByteSource & { readonly kind: 'url' },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(reads).toEqual([[0, 256 * 1024]]);
  });

  it('rechecks cancellation after the owned small remote WebM response', async () => {
    const bytes = await bytesFromMediaTest('recorder_headerless.webm');
    const controller = new AbortController();
    let reads = 0;
    let wholeReads = 0;

    await expect(
      probeWithWebmDriver(
        {
          kind: 'url',
          size: bytes.byteLength,
          range(start, end): Promise<Uint8Array> {
            reads++;
            controller.abort('cancel small remote WebM probe');
            return Promise.resolve(bytes.subarray(start, end));
          },
          readAll(): Promise<Uint8Array> {
            wholeReads++;
            controller.abort('cancel small remote WebM probe');
            return Promise.resolve(bytes);
          },
          stream(): ReadableStream<Uint8Array> {
            throw new Error(
              'cancelled small remote WebM should use the owned whole-read capability',
            );
          },
        } as ByteSource & { readonly kind: 'url'; readAll(): Promise<Uint8Array> },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(reads).toBe(0);
    expect(wholeReads).toBe(1);
  });

  it('WebmDriver.probe matches demux track metadata on the real AV1 WebM fixture', async () => {
    const bytes = await bytesFromMediaTest('av1_720p_5s.webm');
    const probeTracks = await probeWithWebmDriver(fromBytes(bytes, { mime: 'video/webm' }));
    const demuxed = await WebmDriver.demux(fromBytes(bytes, { mime: 'video/webm' }));
    try {
      const withoutTailGapless = (tracks: readonly TrackInfo[]): TrackInfo[] =>
        tracks.map(({ gapless, ...track }) => ({
          ...track,
          ...(gapless?.leadingSamples !== undefined
            ? { gapless: { leadingSamples: gapless.leadingSamples } }
            : {}),
        }));
      // A bounded metadata probe can read CodecDelay/OpusHead at the front, while exact trailing
      // DiscardPadding and decoded sample totals live on the terminal BlockGroup. Keep probe bounded
      // and require every front-metadata field plus the leading delay to match full demux.
      expect(withoutTailGapless(probeTracks)).toEqual(withoutTailGapless(demuxed.tracks));
      expect(demuxed.tracks.find((track) => track.codec === 'opus')?.gapless).toMatchObject({
        leadingSamples: 312,
        trailingSamples: 648,
        totalSamples: 240_000,
      });
      expect(probeTracks.find((track) => track.mediaType === 'video')?.codec).toBe('av1');
    } finally {
      await demuxed.close();
    }
  });

  it('captures a modestly extended finite Tracks element in one bounded metadata range', async () => {
    const bytes = await bytesFromMediaTest('scenarios/demux/realworld_mdn_flower_webm/02.webm');
    const reads: Array<readonly [number, number]> = [];
    const source: ByteSource = {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('bounded WebM metadata probe must not open a stream');
      },
    };
    const tracks = await probeWithWebmDriver(source);
    expect(tracks.map((track) => [track.mediaType, track.codec])).toEqual([
      ['audio', 'vorbis'],
      ['video', 'vp8'],
    ]);
    expect(reads).toEqual([[0, 8 * 1024]]);
  });

  it('qualifies a large first VP9-alpha keyframe from one bounded metadata range', async () => {
    const bytes = await bytesFromMediaTest('scenarios/probe/vp9_alpha/vp9_alpha.webm');
    const reads: Array<readonly [number, number]> = [];
    const source: ByteSource = {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('bounded VP9-alpha metadata probe must not open a stream');
      },
    };

    const tracks = await probeWithWebmDriver(source);
    const fullTracks = await probeWithWebmDriver({
      size: bytes.byteLength,
      stream: () => new Blob([Uint8Array.from(bytes).buffer]).stream(),
    });
    expect(tracks).toEqual(fullTracks);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      codec: 'vp9',
      alpha: true,
      config: { codec: 'vp09.00.30.08', codedWidth: 640, codedHeight: 480 },
    });
    expect(reads).toEqual([[0, 8 * 1024]]);
  });

  it('does not qualify an unproven incomplete BlockGroup when its VP9 payload is an inter frame', async () => {
    const bytes = await bytesFromMediaTest('scenarios/probe/vp9_alpha/vp9_alpha.webm');
    const prefix = bytes.slice(0, 8 * 1024);
    // The first Block payload starts with a VP9 key-frame header. Flip only frame_type; the container
    // BlockGroup remains incomplete, so no absent-ReferenceBlock claim may override bitstream truth.
    const firstVp9Byte = prefix.indexOf(0x82, 430);
    expect(firstVp9Byte).toBeGreaterThan(430);
    prefix[firstVp9Byte] = (prefix[firstVp9Byte] ?? 0) | 0x04;

    const info = parseWebm(prefix, {
      scanClusters: false,
      sourceSizeBytes: bytes.byteLength,
    });
    expect(info.tracks[0]).toMatchObject({
      codec: 'vp9',
      decoderCodec: 'vp09',
      decoderCodecSource: 'unknown',
    });
  });

  it('jumps from complete declarations to one full parse when exact fps needs the terminal cluster', async () => {
    const bytes = await bytesFromMediaTest('scenarios/probe/vp9_alpha/01.webm');
    const reads: Array<readonly [number, number]> = [];
    const tracks = await probeWithWebmDriver({
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('known-size terminal-timeline probe must remain range-backed');
      },
    });
    const fullTracks = await probeWithWebmDriver({
      size: bytes.byteLength,
      stream: () => new Blob([Uint8Array.from(bytes).buffer]).stream(),
    });

    expect(tracks).toEqual(fullTracks);
    expect(tracks[0]).toMatchObject({
      codec: 'vp9',
      durationSec: 2.7,
      fps: 30,
      alpha: true,
      config: { codec: 'vp09.00.20.08', codedWidth: 320, codedHeight: 240 },
    });
    expect(reads).toEqual([
      [0, 8 * 1024],
      [0, bytes.byteLength],
    ]);
  });

  it('rejects a short terminal-timeline range instead of deriving fps from a partial Cluster', async () => {
    const bytes = await bytesFromMediaTest('scenarios/probe/vp9_alpha/01.webm');
    let reads = 0;
    await expect(
      probeWithWebmDriver({
        size: bytes.byteLength,
        range(start, end): Promise<Uint8Array> {
          reads++;
          const shortEnd = reads === 1 ? end : Math.min(end, 64 * 1024);
          return Promise.resolve(bytes.subarray(start, shortEnd));
        },
        stream(): ReadableStream<Uint8Array> {
          throw new Error('short known-size timeline probe must remain range-backed');
        },
      }),
    ).rejects.toMatchObject({
      code: 'unsupported-input',
      message: expect.stringContaining('before declared size'),
    });
    expect(reads).toBe(2);
  });

  it('rechecks cancellation after the terminal-timeline range resolves', async () => {
    const bytes = await bytesFromMediaTest('scenarios/probe/vp9_alpha/01.webm');
    const controller = new AbortController();
    let reads = 0;
    await expect(
      probeWithWebmDriver(
        {
          size: bytes.byteLength,
          range(start, end): Promise<Uint8Array> {
            reads++;
            if (reads === 2) controller.abort('cancel terminal scan');
            return Promise.resolve(bytes.subarray(start, end));
          },
          stream(): ReadableStream<Uint8Array> {
            throw new Error('cancelled known-size timeline probe must remain range-backed');
          },
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(reads).toBe(2);
  });

  it('WebmDriver.probe rejects a pre-aborted signal with the typed abort error', async () => {
    await expect(
      probeWithWebmDriver(await fixtureSource('movie_5.webm'), AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('webmPacketPayloadInfoFromBytes returns in-bounds packet payload views', async () => {
    const bytes = await loadFixture('movie_5.webm');
    const table = webmPacketPayloadInfoFromBytes(bytes);
    expect(table.tracks.map((track) => track.codec)).toContain('vp9');
    expect(table.tracks.map((track) => track.codec)).toContain('opus');
    expect(table.packets.length).toBeGreaterThan(0);

    const first = table.packets[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.size).toBe(first.data.byteLength);
    expect(first.offset).toBeDefined();
    if (first.offset !== undefined) {
      expect(first.offset).toBeGreaterThanOrEqual(0);
      expect(first.offset + first.size).toBeLessThanOrEqual(bytes.byteLength);
      expect(first.data).toEqual(bytes.subarray(first.offset, first.offset + first.size));
    }
    expect(table.tracks[first.trackIndex]).toBeDefined();
  });

  it('webmPacketPayloadInfoFromBytes exposes VPx alpha side data', async () => {
    const table = webmPacketPayloadInfoFromBytes(await loadFixture('bear-vp9-alpha.webm'));
    const alphaVideo = table.tracks.find(
      (track) => track.mediaType === 'video' && track.alpha === true,
    );
    expect(alphaVideo).toBeDefined();
    const alphaPackets = table.packets.filter((packet) => packet.alpha !== undefined);
    expect(alphaPackets.length).toBeGreaterThan(0);
    expect(alphaPackets[0]?.alpha?.byteLength).toBeGreaterThan(0);
    expect(alphaPackets[0]?.data.byteLength).toBeGreaterThan(0);
  });

  it('packetInfo range-scans diverse WebM clusters without retaining packet payloads', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    for (const { name, load } of [
      { name: 'movie_5.webm', load: () => loadFixture('movie_5.webm') },
      { name: 'bear-multitrack.webm', load: () => loadFixture('bear-multitrack.webm') },
      { name: 'bear-opus.webm', load: () => loadFixture('bear-opus.webm') },
      { name: 'bear-vp9-alpha.webm', load: () => loadFixture('bear-vp9-alpha.webm') },
      { name: 'recorder_headerless.webm', load: () => loadFixture('recorder_headerless.webm') },
      { name: 'h264_in_mkv.mkv', load: () => bytesFromMediaTest('h264_in_mkv.mkv') },
      { name: 'av1_720p_5s.webm', load: () => bytesFromMediaTest('av1_720p_5s.webm') },
      { name: 'vp8_720p_10s.webm', load: () => bytesFromMediaTest('vp8_720p_10s.webm') },
    ]) {
      const bytes = await load();
      const ranges: Array<readonly [number, number]> = [];
      let releases = 0;
      let streamCalls = 0;
      const actual = await packetInfo.call(WebmDriver, {
        size: bytes.byteLength,
        async range(start, end): Promise<Uint8Array> {
          ranges.push([start, end]);
          return bytes.slice(start, end);
        },
        releaseRange(): void {
          releases++;
        },
        stream(): ReadableStream<Uint8Array> {
          streamCalls++;
          throw new Error('finite WebM packet-info must stay range-backed');
        },
      });
      const payloadTable = webmPacketPayloadInfoFromBytes(bytes);
      const expectedPackets = payloadTable.packets.map((packet) => ({
        trackIndex: packet.trackIndex,
        ...(packet.offset !== undefined ? { offset: packet.offset } : {}),
        size: packet.size,
        ptsUs: packet.ptsUs,
        dtsUs: packet.dtsUs,
        ...(packet.durationUs !== undefined ? { durationUs: packet.durationUs } : {}),
        keyframe: packet.keyframe,
      }));
      expect(actual.tracks, name).toEqual(payloadTable.tracks);
      expect(actual.packets, name).toEqual(expectedPackets);
      expect(streamCalls, name).toBe(0);
      expect(ranges.length, name).toBeGreaterThan(1);
      expect(releases, `${name} released ranges`).toBe(ranges.length);
      if (bytes.byteLength > 256 * 1024) {
        expect(
          Math.max(...ranges.map(([start, end]) => end - start)),
          `${name} maximum physical range`,
        ).toBeLessThan(bytes.byteLength);
      }
    }
  });

  it('packetInfo never allocates a complete large finite Cluster', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [2]),
      ...el(E.CodecID, str('A_MPEG/L3')),
      ...el(E.Audio, [...el(E.SamplingFrequency, f64(48_000)), ...el(E.Channels, [2])]),
    ]);
    const clusterPayload = [...el(E.Timecode, [0])];
    for (let timestamp = 0; timestamp < 96; timestamp++) {
      clusterPayload.push(
        ...el(E.SimpleBlock, [
          0x81,
          (timestamp >> 8) & 0xff,
          timestamp & 0xff,
          0x80,
          ...new Array(4096).fill(timestamp & 0xff),
        ]),
      );
    }
    const bytes = Uint8Array.from([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [...el(E.Tracks, track), ...el(E.Cluster, clusterPayload)]),
    ]);
    const expected = webmPacketPayloadInfoFromBytes(bytes);
    const ranges: Array<readonly [number, number]> = [];
    const actual = await packetInfo.call(WebmDriver, {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        ranges.push([start, end]);
        return Promise.resolve(bytes.slice(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('large finite Cluster packet-info must remain range-backed');
      },
    });

    expect(actual.tracks).toEqual(expected.tracks);
    expect(actual.packets).toEqual(
      expected.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
    );
    expect(actual.packets).toHaveLength(96);
    expect(clusterPayload.length).toBeGreaterThan(256 * 1024);
    expect(Math.max(...ranges.map(([start, end]) => end - start))).toBeLessThan(
      clusterPayload.length,
    );
    expect(ranges).not.toContainEqual([0, bytes.byteLength]);
  });

  it('packetInfo skips one file-sized Block payload with constant post-prefix ranges', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...el(E.Video, [...el(E.PixelWidth, uintN(320, 2)), ...el(E.PixelHeight, [240])]),
    ]);
    const payloadSize = 512 * 1024;
    const payload = new Array(payloadSize).fill(0);
    // Valid 320x240 profile-0 VP9 keyframe header; the remaining half-megabyte is deliberately opaque.
    payload.splice(0, 16, 130, 73, 131, 66, 32, 19, 240, 14, 246, 0, 56, 36, 28, 24, 2, 0);
    const block = el(E.SimpleBlock, [0x81, 0, 0, 0x80, ...payload]);
    const bytes = Uint8Array.from([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Tracks, track),
        ...el(E.Info, el(E.Duration, f64(1000))),
        ...el(E.Cluster, [...el(E.Timecode, [0]), ...block]),
      ]),
    ]);
    const expected = webmPacketPayloadInfoFromBytes(bytes);
    const ranges: Array<readonly [number, number]> = [];
    let releases = 0;
    const actual = await packetInfo.call(WebmDriver, {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        ranges.push([start, end]);
        return Promise.resolve(bytes.slice(start, end));
      },
      releaseRange(response): void {
        releases++;
        const buffer = response.buffer as ArrayBuffer;
        structuredClone(buffer, { transfer: [buffer] });
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('a huge finite Block must remain on bounded ranges');
      },
    });

    expect(actual).toEqual({
      tracks: expected.tracks,
      packets: expected.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
    });
    expect(actual.packets).toHaveLength(1);
    expect(actual.packets[0]?.size).toBe(payloadSize);
    expect((actual.tracks[0]?.config as VideoDecoderConfig | undefined)?.codec).toMatch(
      /^vp09\.00\./,
    );
    expect(ranges[0]).toEqual([0, 256 * 1024]);
    expect(Math.max(...ranges.slice(1).map(([start, end]) => end - start))).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(ranges).not.toContainEqual([0, bytes.byteLength]);
    expect(releases).toBe(ranges.length);
  });

  it('packetInfo bounds Xiph lace-header work and releases every range on overflow', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [2]),
      ...el(E.CodecID, str('A_MPEG/L3')),
      ...el(E.Audio, [...el(E.SamplingFrequency, f64(48_000)), ...el(E.Channels, [2])]),
    ]);
    const bytes = Uint8Array.from([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.Duration, f64(20))),
        ...el(E.Tracks, track),
        ...el(E.Cluster, [
          ...el(E.Timecode, [0]),
          ...el(E.SimpleBlock, [0x81, 0, 0, 0x82, 1, ...new Array(2 * 1024 * 1024).fill(0xff)]),
        ]),
      ]),
    ]);
    const ranges: Array<readonly [number, number]> = [];
    let releases = 0;
    await expect(
      packetInfo.call(WebmDriver, {
        size: bytes.byteLength,
        range(start, end): Promise<Uint8Array> {
          ranges.push([start, end]);
          return Promise.resolve(bytes.slice(start, end));
        },
        releaseRange(response): void {
          releases++;
          const buffer = response.buffer as ArrayBuffer;
          structuredClone(buffer, { transfer: [buffer] });
        },
        stream(): ReadableStream<Uint8Array> {
          throw new Error('oversized Xiph lace header must remain range-backed');
        },
      }),
    ).rejects.toMatchObject({
      code: 'constraint-unsatisfied',
      detail: {
        constraint: 'webm-packet-info-xiph-lace-header-bytes',
        maxBytes: 1024 * 1024,
      },
    });
    expect(ranges[0]).toEqual([0, 256 * 1024]);
    expect(ranges).not.toContainEqual([0, bytes.byteLength]);
    expect(Math.max(...ranges.slice(1).map(([start, end]) => end - start))).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(releases).toBe(ranges.length);
  });

  it('packetInfo pre-scans late Info beyond a large Void before interpreting Cluster clocks', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...el(E.Video, [...el(E.PixelWidth, uintN(320, 2)), ...el(E.PixelHeight, [240])]),
    ]);
    const keyframe = [130, 73, 131, 66, 32, 19, 240, 14, 246, 0, 56, 36, 28, 24, 2, 0];
    const bytes = Uint8Array.from([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Tracks, track),
        ...el(E.Cluster, [
          ...el(E.Timecode, [0]),
          ...el(E.SimpleBlock, [0x81, 0, 0, 0x80, ...keyframe]),
          ...el(E.SimpleBlock, [0x81, 0, 10, 0x80, ...keyframe]),
        ]),
        ...el(E.Void, new Array(270 * 1024).fill(0)),
        ...el(E.Info, [...el(E.TimecodeScale, uintN(2_000_000, 4)), ...el(E.Duration, f64(20))]),
      ]),
    ]);
    const expected = webmPacketPayloadInfoFromBytes(bytes);
    const ranges: Array<readonly [number, number]> = [];
    const actual = await packetInfo.call(WebmDriver, {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        ranges.push([start, end]);
        return Promise.resolve(bytes.slice(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('late finite Info must remain range-backed');
      },
    });

    expect(actual).toEqual({
      tracks: expected.tracks,
      packets: expected.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
    });
    expect(actual.tracks[0]?.durationSec).toBe(0.04);
    expect((actual.tracks[0]?.config as VideoDecoderConfig | undefined)?.codec).toMatch(
      /^vp09\.00\./,
    );
    expect(actual.packets.map(({ ptsUs, durationUs }) => [ptsUs, durationUs])).toEqual([
      [0, 20_000],
      [20_000, 20_000],
    ]);
    expect(ranges).not.toContainEqual([0, bytes.byteLength]);
  });

  it('packetInfo discovers Tracks after a prefix-sized Void without materializing the source', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [2]),
      ...el(E.CodecID, str('A_MPEG/L3')),
      ...el(E.Audio, [...el(E.SamplingFrequency, f64(48_000)), ...el(E.Channels, [2])]),
    ]);
    const bytes = Uint8Array.from([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.Duration, f64(20))),
        ...el(E.Void, new Array(270 * 1024).fill(0)),
        ...el(E.Tracks, track),
        ...el(E.Cluster, [
          ...el(E.Timecode, [0]),
          ...el(E.SimpleBlock, [0x81, 0, 0, 0x80, 0x11]),
          ...el(E.SimpleBlock, [0x81, 0, 10, 0x80, 0x22]),
        ]),
      ]),
    ]);
    const expected = webmPacketPayloadInfoFromBytes(bytes);
    const ranges: Array<readonly [number, number]> = [];
    let releases = 0;
    const actual = await packetInfo.call(WebmDriver, {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        ranges.push([start, end]);
        return Promise.resolve(bytes.slice(start, end));
      },
      releaseRange(): void {
        releases++;
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('late finite Tracks must remain range-backed');
      },
    });

    expect(actual).toEqual({
      tracks: expected.tracks,
      packets: expected.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
    });
    expect(ranges).not.toContainEqual([0, bytes.byteLength]);
    expect(Math.max(...ranges.map(([start, end]) => end - start))).toBeLessThanOrEqual(256 * 1024);
    expect(releases).toBe(ranges.length);
  });

  it('packetInfo accepts a padded EBML Header beyond its prefix and types the bounded header cap', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [2]),
      ...el(E.CodecID, str('A_MPEG/L3')),
      ...el(E.Audio, [...el(E.SamplingFrequency, f64(48_000)), ...el(E.Channels, [2])]),
    ]);
    const segment = el(E.Segment, [
      ...el(E.Info, el(E.Duration, f64(20))),
      ...el(E.Tracks, track),
      ...el(E.Cluster, [
        ...el(E.Timecode, [0]),
        ...el(E.SimpleBlock, [0x81, 0, 0, 0x80, 0x11]),
        ...el(E.SimpleBlock, [0x81, 0, 10, 0x80, 0x22]),
      ]),
    ]);
    const bytes = Uint8Array.from([
      ...el(E.EBML, [...el(E.DocType, str('webm')), ...el(E.Void, new Array(270 * 1024).fill(0))]),
      ...segment,
    ]);
    const expected = webmPacketPayloadInfoFromBytes(bytes);
    const ranges: Array<readonly [number, number]> = [];
    let releases = 0;
    const actual = await packetInfo.call(WebmDriver, {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        ranges.push([start, end]);
        return Promise.resolve(bytes.slice(start, end));
      },
      releaseRange(): void {
        releases++;
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('padded EBML Header packetInfo must remain range-backed');
      },
    });
    expect(actual).toEqual({
      tracks: expected.tracks,
      packets: expected.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
    });
    expect(ranges).not.toContainEqual([0, bytes.byteLength]);
    expect(Math.max(...ranges.map(([start, end]) => end - start))).toBeLessThan(bytes.byteLength);
    expect(releases).toBe(ranges.length);

    const capped = Uint8Array.from([
      ...el(E.EBML, [...el(E.DocType, str('webm')), ...el(E.Void, new Array(1024 * 1024).fill(0))]),
      ...segment,
    ]);
    const cappedRanges: Array<readonly [number, number]> = [];
    await expect(
      packetInfo.call(WebmDriver, {
        size: capped.byteLength,
        range(start, end): Promise<Uint8Array> {
          cappedRanges.push([start, end]);
          return Promise.resolve(capped.slice(start, end));
        },
        stream(): ReadableStream<Uint8Array> {
          throw new Error('oversized EBML Header must fail before stream materialization');
        },
      }),
    ).rejects.toMatchObject({
      code: 'constraint-unsatisfied',
      detail: {
        constraint: 'webm-packet-info-metadata-bytes',
        kind: 'EBML Header',
        maxBytes: 1024 * 1024,
      },
    });
    expect(cappedRanges).toEqual([[0, 256 * 1024]]);
    expect(cappedRanges).not.toContainEqual([0, capped.byteLength]);
  });

  it('packetInfo skips large AV1 Padding OBUs and bounds pathological qualification walks', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const source = await bytesFromMediaTest('av1_720p_5s.webm');
    const payloadTable = webmPacketPayloadInfoFromBytes(source);
    const videoIndex = payloadTable.tracks.findIndex((trackInfo) => trackInfo.codec === 'av1');
    const realKeyframe = payloadTable.packets.find(
      (packet) => packet.trackIndex === videoIndex && packet.keyframe,
    )?.data;
    if (realKeyframe === undefined) throw new Error('expected a real AV1 keyframe');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_AV1')),
      ...el(E.Video, [...el(E.PixelWidth, uintN(1280, 2)), ...el(E.PixelHeight, uintN(720, 2))]),
    ]);
    const build = (paddingSize: number): Uint8Array => {
      const accessUnit = [
        0x7a,
        ...leb128(paddingSize),
        ...new Array(paddingSize).fill(0),
        ...realKeyframe,
      ];
      return Uint8Array.from([
        ...el(E.EBML, el(E.DocType, str('webm'))),
        ...el(E.Segment, [
          ...el(E.Info, el(E.Duration, f64(20))),
          ...el(E.Tracks, track),
          ...el(E.Void, new Array(270 * 1024).fill(0)),
          ...el(E.Cluster, [
            ...el(E.Timecode, [0]),
            ...el(E.SimpleBlock, [0x81, 0, 0, 0x80, ...accessUnit]),
          ]),
        ]),
      ]);
    };

    const bytes = build(70_000);
    const expected = webmPacketPayloadInfoFromBytes(bytes);
    const ranges: Array<readonly [number, number]> = [];
    let releases = 0;
    const actual = await packetInfo.call(WebmDriver, {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        ranges.push([start, end]);
        return Promise.resolve(bytes.slice(start, end));
      },
      releaseRange(response): void {
        releases++;
        const buffer = response.buffer as ArrayBuffer;
        structuredClone(buffer, { transfer: [buffer] });
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('AV1 OBU qualification must remain range-backed');
      },
    });
    expect(actual).toEqual({
      tracks: expected.tracks,
      packets: expected.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
    });
    expect((actual.tracks[0]?.config as VideoDecoderConfig | undefined)?.codec).toBe(
      'av01.0.05M.08',
    );
    expect(ranges).not.toContainEqual([0, bytes.byteLength]);
    expect(Math.max(...ranges.slice(1).map(([start, end]) => end - start))).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(releases).toBe(ranges.length);

    const capped = build(4 * 1024 * 1024 + 1);
    const cappedRanges: Array<readonly [number, number]> = [];
    const cappedActual = await packetInfo.call(WebmDriver, {
      size: capped.byteLength,
      range(start, end): Promise<Uint8Array> {
        cappedRanges.push([start, end]);
        return Promise.resolve(capped.slice(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('capped AV1 OBU qualification must remain range-backed');
      },
    });
    expect((cappedActual.tracks[0]?.config as VideoDecoderConfig | undefined)?.codec).toBe('av01');
    expect(cappedRanges).not.toContainEqual([0, capped.byteLength]);
    expect(Math.max(...cappedRanges.map(([start, end]) => end - start))).toBeLessThanOrEqual(
      256 * 1024,
    );
  });

  it('packetInfo caps aggregate retained codec qualification prefixes across many tracks', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const trackEntries: number[] = [];
    const clusterPayload = el(E.Timecode, [0]);
    const codedFrame = new Array(64 * 1024).fill(0);
    codedFrame.splice(0, 16, 130, 73, 131, 66, 32, 19, 240, 14, 246, 0, 56, 36, 28, 24, 2, 0);
    for (let trackNumber = 1; trackNumber <= 17; trackNumber++) {
      trackEntries.push(
        ...el(E.TrackEntry, [
          ...el(E.TrackNumber, [trackNumber]),
          ...el(E.TrackType, [1]),
          ...el(E.CodecID, str('V_VP9')),
          ...el(E.Video, [...el(E.PixelWidth, uintN(320, 2)), ...el(E.PixelHeight, [240])]),
        ]),
      );
      clusterPayload.push(...el(E.SimpleBlock, [0x80 | trackNumber, 0, 0, 0x80, ...codedFrame]));
    }
    const bytes = Uint8Array.from([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.Duration, f64(1000))),
        ...el(E.Tracks, trackEntries),
        ...el(E.Cluster, clusterPayload),
      ]),
    ]);
    const expectedPackets = webmPacketPayloadInfoFromBytes(bytes).packets.map(
      ({ data: _data, alpha: _alpha, ...packet }) => packet,
    );
    const ranges: Array<readonly [number, number]> = [];
    let releases = 0;
    const actual = await packetInfo.call(WebmDriver, {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        ranges.push([start, end]);
        return Promise.resolve(bytes.slice(start, end));
      },
      releaseRange(): void {
        releases++;
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('multitrack qualification must remain range-backed');
      },
    });

    expect(actual.packets).toEqual(expectedPackets);
    expect(actual.tracks).toHaveLength(17);
    expect(
      actual.tracks.filter((trackInfo) =>
        (trackInfo.config as VideoDecoderConfig | undefined)?.codec.startsWith('vp09.'),
      ),
    ).toHaveLength(16);
    expect((actual.tracks[16]?.config as VideoDecoderConfig | undefined)?.codec).toBe('vp09');
    expect(ranges).not.toContainEqual([0, bytes.byteLength]);
    expect(Math.max(...ranges.slice(1).map(([start, end]) => end - start))).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(releases).toBe(ranges.length);
  });

  it('packetInfo range-walk preserves lacing and late BlockGroup metadata before releasing windows', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP8')),
      ...el(E.Video, [...el(E.PixelWidth, [2]), ...el(E.PixelHeight, [2])]),
    ]);
    const xiphLaced = el(
      E.SimpleBlock,
      [0x81, 0, 0, 0x82, 2, 2, 3, 0x11, 0x12, 0x21, 0x22, 0x23, 0x31, 0x32, 0x33, 0x34],
    );
    const blockGroup = el(E.BlockGroup, [
      ...el(E.Block, [0x81, 0, 10, 0, 0x41, 0x42, 0x43, 0x44, 0x45]),
      ...el(E.ReferenceBlock, [0xff]),
      ...el(E.BlockDuration, [6]),
      ...el(
        E.BlockAdditions,
        el(E.BlockMore, [...el(E.BlockAdditional, [0xaa]), ...el(E.BlockAddID, [1])]),
      ),
    ]);
    const bytes = Uint8Array.from([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.Duration, f64(20))),
        ...el(E.Tracks, track),
        ...el(E.Cluster, [...el(E.Timecode, [0]), ...xiphLaced, ...blockGroup]),
      ]),
    ]);
    const expected = webmPacketPayloadInfoFromBytes(bytes);
    let reads = 0;
    let releases = 0;
    const actual = await packetInfo.call(WebmDriver, {
      size: bytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        reads++;
        return Promise.resolve(bytes.slice(start, end));
      },
      releaseRange(response): void {
        releases++;
        const buffer = response.buffer as ArrayBuffer;
        structuredClone(buffer, { transfer: [buffer] });
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('finite laced packet-info must remain range-backed');
      },
    });

    expect(actual.tracks).toEqual(expected.tracks);
    expect(actual.tracks[0]).toMatchObject({ alpha: true });
    expect(actual.packets).toEqual(
      expected.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
    );
    expect(actual.packets.map(({ size }) => size)).toEqual([2, 3, 4, 5]);
    expect(actual.packets.map(({ keyframe }) => keyframe)).toEqual([true, true, true, false]);
    expect(actual.packets[3]?.durationUs).toBe(6000);
    expect(releases).toBe(reads);
  });

  it('packetInfo preserves exact whole-source semantics across finite-source fallback shapes', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const bytes = await loadFixture('white.webm');
    const expected = await packetInfo.call(WebmDriver, fromBytes(bytes));
    const stream = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(bytes);
          controller.close();
        },
      });

    for (const source of [
      { stream },
      { size: bytes.byteLength, stream },
      { size: 0, range: async () => new Uint8Array(0), stream },
    ]) {
      expect(await packetInfo.call(WebmDriver, source)).toEqual(expected);
    }
  });

  it('packetInfo range-walks unknown-size Clusters and bounded attachment metadata', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const recorder = await bytesFromMediaTest('recorder_headerless.webm');
    const trailingVoid = Uint8Array.from(el(E.Void, new Array(320 * 1024).fill(0)));
    const paddedRecorder = new Uint8Array(recorder.byteLength + trailingVoid.byteLength);
    paddedRecorder.set(recorder);
    paddedRecorder.set(trailingVoid, recorder.byteLength);
    const recorderRanges: Array<readonly [number, number]> = [];
    const recorderExpected = webmPacketPayloadInfoFromBytes(paddedRecorder);
    const recorderActual = await packetInfo.call(WebmDriver, {
      size: paddedRecorder.byteLength,
      range(start, end): Promise<Uint8Array> {
        recorderRanges.push([start, end]);
        return Promise.resolve(paddedRecorder.slice(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('unknown-size Clusters must remain on the finite range walk');
      },
    });
    expect(recorderActual.tracks).toEqual(recorderExpected.tracks);
    expect(recorderActual.packets).toEqual(
      recorderExpected.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
    );
    expect(recorderRanges).not.toContainEqual([0, paddedRecorder.byteLength]);
    expect(Math.max(...recorderRanges.map(([start, end]) => end - start))).toBeLessThanOrEqual(
      256 * 1024,
    );

    const attachmentBytes = await bytesFromMediaTest('scenarios/demux/h264_in_mkv/03.mkv');
    const attachmentRanges: Array<readonly [number, number]> = [];
    const attachmentExpected = webmPacketPayloadInfoFromBytes(attachmentBytes);
    const attachmentActual = await packetInfo.call(WebmDriver, {
      size: attachmentBytes.byteLength,
      range(start, end): Promise<Uint8Array> {
        attachmentRanges.push([start, end]);
        return Promise.resolve(attachmentBytes.slice(start, end));
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('finite attachment metadata must stay range-backed');
      },
    });
    expect(attachmentActual.tracks).toEqual(attachmentExpected.tracks);
    expect(attachmentActual.packets).toEqual(
      attachmentExpected.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
    );
    expect(attachmentRanges).not.toContainEqual([0, attachmentBytes.byteLength]);
    expect(Math.max(...attachmentRanges.map(([start, end]) => end - start))).toBeLessThan(
      attachmentBytes.byteLength,
    );

    const ordinary = await loadFixture('movie_5.webm');
    let reads = 0;
    await expect(
      packetInfo.call(WebmDriver, {
        size: ordinary.byteLength,
        range(start, end): Promise<Uint8Array> {
          reads++;
          const prefix = new Uint8Array(end - start);
          prefix.set(ordinary.subarray(0, Math.min(16, prefix.byteLength)));
          return Promise.resolve(prefix);
        },
        stream(): ReadableStream<Uint8Array> {
          throw new Error('invalid finite metadata must not open the source stream');
        },
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/unsupported-input|demux-error/) });
    expect(reads).toBe(1);
  });

  it('packetInfo rejects short finite ranges and observes cancellation after an awaited read', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const bytes = await loadFixture('movie_5.webm');
    await expect(
      packetInfo.call(WebmDriver, {
        size: bytes.byteLength,
        range(start, end): Promise<Uint8Array> {
          return Promise.resolve(bytes.slice(start, end - 1));
        },
        stream: () => new ReadableStream<Uint8Array>(),
      }),
    ).rejects.toThrowError(/returned .* bytes for range/);

    const controller = new AbortController();
    await expect(
      packetInfo.call(
        WebmDriver,
        {
          size: bytes.byteLength,
          range(start, end): Promise<Uint8Array> {
            controller.abort('packet-info range completed after cancellation');
            return Promise.resolve(bytes.slice(start, end));
          },
          stream: () => new ReadableStream<Uint8Array>(),
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('packetInfo derives undeclared clocks while ignoring non-media and malformed block children', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [2]),
      ...el(E.CodecID, str('A_MPEG/L3')),
      ...el(E.Audio, [...el(E.SamplingFrequency, f64(48_000)), ...el(E.Channels, [2])]),
    ]);
    const emptyVideoTrack = el(E.TrackEntry, [
      ...el(E.TrackNumber, [2]),
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP8')),
    ]);
    const cluster = el(E.Cluster, [
      ...el(E.Timecode, [0]),
      ...el(E.SimpleBlock, [0]),
      ...el(E.BlockGroup, []),
      ...el(E.SimpleBlock, [0x81, 0x00, 0x00, 0x80, 0x11]),
      ...el(E.SimpleBlock, [0x81, 0x00, 0x0a, 0x80, 0x22]),
    ]);
    for (const info of [[], el(E.Info, [])]) {
      const bytes = new Uint8Array([
        ...el(E.EBML, el(E.DocType, str('webm'))),
        ...el(E.Segment, [...info, ...el(E.Tracks, [...track, ...emptyVideoTrack]), ...cluster]),
      ]);
      const table = await packetInfo.call(WebmDriver, fromBytes(bytes));
      expect(table.packets).toEqual([
        expect.objectContaining({ ptsUs: 0, dtsUs: 0, durationUs: 10_000, keyframe: true }),
        expect.objectContaining({
          ptsUs: 10_000,
          dtsUs: 10_000,
          durationUs: 10_000,
          keyframe: true,
        }),
      ]);
      expect(table.tracks[0]).toMatchObject({ codec: 'mp3' });
    }
  });

  it('packetInfo rejects finite Segment walks with no exact packet timeline', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [2]),
      ...el(E.CodecID, str('A_MPEG/L3')),
      ...el(E.Audio, el(E.Channels, [1])),
    ]);
    const wrap = (tail: number[]): Uint8Array =>
      new Uint8Array([
        ...el(E.EBML, el(E.DocType, str('webm'))),
        ...el(E.Segment, [...el(E.Tracks, track), ...tail]),
      ]);

    await expect(packetInfo.call(WebmDriver, fromBytes(wrap([])))).rejects.toThrowError(
      /contains no media blocks/,
    );
    await expect(
      packetInfo.call(
        WebmDriver,
        fromBytes(
          wrap(
            el(E.Cluster, [
              ...el(E.Timecode, [0]),
              ...el(E.SimpleBlock, [0x81, 0x00, 0x00, 0x80, 0x11]),
            ]),
          ),
        ),
      ),
    ).rejects.toThrowError(/has no exact duration/);
  });

  it('packetInfo rejects malformed or escaping finite Segment element headers', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [2]),
      ...el(E.CodecID, str('A_MPEG/L3')),
    ]);
    const metadata = el(E.Tracks, track);
    const wrap = (tail: number[]): Uint8Array =>
      new Uint8Array([
        ...el(E.EBML, el(E.DocType, str('webm'))),
        ...el(E.Segment, [...metadata, ...tail]),
      ]);
    for (const { tail, message } of [
      { tail: [0], message: /invalid EBML element header/ },
      { tail: E.Cluster, message: /invalid EBML element header/ },
      { tail: [...E.Cluster, 0x8a], message: /escapes the WebM Segment/ },
    ]) {
      await expect(packetInfo.call(WebmDriver, fromBytes(wrap(tail)))).rejects.toThrowError(
        message,
      );
    }

    const declaredPayload = [...metadata];
    const truncatedSegment = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...E.Segment,
      ...sizeVint(declaredPayload.length + 1),
      ...declaredPayload,
    ]);
    await expect(packetInfo.call(WebmDriver, fromBytes(truncatedSegment))).rejects.toThrowError(
      /truncated|escapes/,
    );
  });

  it('packetInfo qualifies VP9 and AV1 from a later keyframe, with capability-safe fallback', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const padding = el(E.Void, new Array(256 * 1024).fill(0));
    for (const { codec, codecId, source } of [
      { codec: 'vp9', codecId: 'V_VP9', source: await loadFixture('movie_5.webm') },
      { codec: 'av1', codecId: 'V_AV1', source: await bytesFromMediaTest('av1_720p_5s.webm') },
    ]) {
      const payloadTable = webmPacketPayloadInfoFromBytes(source);
      const trackIndex = payloadTable.tracks.findIndex((trackInfo) => trackInfo.codec === codec);
      const payload = payloadTable.packets.find(
        (packet) => packet.trackIndex === trackIndex && packet.keyframe,
      )?.data;
      const nonKeyPayload = payloadTable.packets.find(
        (packet) => packet.trackIndex === trackIndex && !packet.keyframe,
      )?.data;
      if (payload === undefined) throw new Error(`expected a ${codec} keyframe`);
      if (nonKeyPayload === undefined) throw new Error(`expected a ${codec} inter frame`);

      for (const variant of [
        { packetData: payload, keyframe: true, trackFacts: false, declaredDuration: true },
        { packetData: nonKeyPayload, keyframe: true, trackFacts: false, declaredDuration: true },
        { packetData: nonKeyPayload, keyframe: false, trackFacts: true, declaredDuration: false },
      ]) {
        const track = el(E.TrackEntry, [
          ...el(E.TrackNumber, [1]),
          ...el(E.TrackType, [1]),
          ...el(E.CodecID, str(codecId)),
          ...(variant.trackFacts
            ? [
                ...el(E.DefaultDuration, uintN(10_000_000, 4)),
                ...el(E.Video, [...el(E.PixelWidth, [1]), ...el(E.PixelHeight, [1])]),
              ]
            : []),
        ]);
        const block = variant.keyframe
          ? el(E.SimpleBlock, [0x81, 0x00, 0x00, 0x80, ...variant.packetData])
          : el(E.BlockGroup, [
              ...el(E.Block, [0x81, 0x00, 0x00, 0x00, ...variant.packetData]),
              ...el(E.ReferenceBlock, [0]),
              ...el(E.BlockDuration, [10]),
            ]);
        const bytes = new Uint8Array([
          ...el(E.EBML, el(E.DocType, str('webm'))),
          ...el(E.Segment, [
            ...el(
              E.Info,
              variant.declaredDuration
                ? [...el(E.TimecodeScale, uintN(1_000_000, 4)), ...el(E.Duration, f64(10))]
                : el(E.TimecodeScale, uintN(1_000_000, 4)),
            ),
            ...el(E.Tracks, track),
            ...padding,
            ...el(E.Cluster, [...el(E.Timecode, [0]), ...block]),
          ]),
        ]);
        const actual = await packetInfo.call(WebmDriver, fromBytes(bytes));
        const expected = webmPacketPayloadInfoFromBytes(bytes);
        expect(actual.tracks, codec).toEqual(expected.tracks);
        expect(actual.packets, codec).toEqual(
          expected.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
        );
      }

      const malformedTrack = el(E.TrackEntry, [
        ...el(E.TrackNumber, [1]),
        ...el(E.TrackType, [1]),
        ...el(E.CodecID, str(codecId)),
      ]);
      const malformed = new Uint8Array([
        ...el(E.EBML, el(E.DocType, str('webm'))),
        ...el(E.Segment, [
          ...el(E.Info, el(E.Duration, f64(10))),
          ...el(E.Tracks, malformedTrack),
          ...padding,
          ...el(E.Cluster, [
            ...el(E.Timecode, [0]),
            ...el(E.SimpleBlock, [0x81, 0x00, 0x00, 0x80, 0]),
          ]),
        ]),
      ]);
      if (codec === 'vp9') {
        await expect(packetInfo.call(WebmDriver, fromBytes(malformed))).rejects.toMatchObject({
          code: 'demux-error',
        });
      } else {
        expect(await packetInfo.call(WebmDriver, fromBytes(malformed))).toMatchObject({
          tracks: [expect.objectContaining({ codec: 'av1' })],
          packets: [expect.objectContaining({ size: 1, durationUs: 10_000 })],
        });
      }
    }
  });

  it('packetInfo reconstructs H.264 decode order from codec-private reorder depth', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const source = await bytesFromMediaTest('scenarios/demux/h264_in_mkv/01.mkv');
    const sourceTable = webmPacketPayloadInfoFromBytes(source);
    const videoIndex = sourceTable.tracks.findIndex((track) => track.codec === 'h264');
    const config = sourceTable.tracks[videoIndex]?.config;
    const rawDescription = config && 'description' in config ? config.description : undefined;
    if (rawDescription === undefined) throw new Error('expected H.264 codec private data');
    const description = ArrayBuffer.isView(rawDescription)
      ? new Uint8Array(rawDescription.buffer, rawDescription.byteOffset, rawDescription.byteLength)
      : new Uint8Array(rawDescription);
    const packets = sourceTable.packets
      .filter((packet) => packet.trackIndex === videoIndex)
      .slice(0, 8);
    expect(packets.some((packet) => packet.dtsUs !== packet.ptsUs)).toBe(true);
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_MPEG4/ISO/AVC')),
      ...el(E.CodecPrivate, [...description]),
    ]);
    const blocks = packets.flatMap((packet) => {
      const ticks = Math.round(packet.ptsUs / 1000);
      return el(E.SimpleBlock, [
        0x81,
        (ticks >> 8) & 0xff,
        ticks & 0xff,
        packet.keyframe ? 0x80 : 0,
        ...packet.data,
      ]);
    });
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('matroska'))),
      ...el(E.Segment, [
        ...el(E.Info, [...el(E.TimecodeScale, uintN(1_000_000, 4)), ...el(E.Duration, f64(1_000))]),
        ...el(E.Tracks, track),
        ...el(E.Cluster, [...el(E.Timecode, [0]), ...blocks]),
      ]),
    ]);
    const actual = await packetInfo.call(WebmDriver, fromBytes(bytes));
    const expected = webmPacketPayloadInfoFromBytes(bytes);
    expect(actual.tracks).toEqual(expected.tracks);
    expect(actual.packets).toEqual(
      expected.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
    );
    expect(actual.packets.some((packet) => packet.dtsUs !== packet.ptsUs)).toBe(true);
    // File order starts I,P,B..., so adjacent Block PTS would falsely make the first packets 167 ms.
    // Public packetInfo instead derives durations from adjacent presentation timestamps.
    expect(actual.packets.slice(0, 6).map((packet) => packet.durationUs)).toEqual([
      33_000, 33_000, 34_000, 33_000, 33_000, 34_000,
    ]);
  });

  it('packetInfo keeps explicit BlockDuration exact on a stream-only source without Duration', async () => {
    const packetInfo = WebmDriver.packetInfo;
    if (packetInfo === undefined) throw new Error('WebmDriver.packetInfo is not registered');
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [2]),
      ...el(E.CodecID, str('A_MPEG/L3')),
    ]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
        ...el(E.Tracks, track),
        ...el(E.Cluster, [
          ...el(E.Timecode, [0]),
          ...el(E.BlockGroup, [
            ...el(E.Block, [0x81, 0x00, 0x00, 0x00, 0x11]),
            ...el(E.BlockDuration, [10]),
          ]),
        ]),
      ]),
    ]);
    const table = await packetInfo.call(WebmDriver, {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    });
    expect(table.packets).toEqual([
      expect.objectContaining({ ptsUs: 0, dtsUs: 0, durationUs: 10_000, keyframe: true }),
    ]);
  });

  it('packetStats matches packetTable across a timestamp gap and exact terminal BlockDuration', async () => {
    const track = el(E.TrackEntry, [
      ...el(E.TrackNumber, [1]),
      ...el(E.TrackType, [2]),
      ...el(E.CodecID, str('A_MPEG/L3')),
    ]);
    const block = (relativeTicks: number, durationTicks: number, payload: number): number[] =>
      el(E.BlockGroup, [
        ...el(E.Block, [0x81, (relativeTicks >> 8) & 0xff, relativeTicks & 0xff, 0x00, payload]),
        ...el(E.BlockDuration, uintN(durationTicks, 2)),
      ]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, [...el(E.TimecodeScale, uintN(1_000_000, 4)), ...el(E.Duration, f64(2_000))]),
        ...el(E.Tracks, track),
        ...el(E.Cluster, [
          ...el(E.Timecode, [0]),
          ...block(0, 100, 0x11),
          ...block(1_000, 10, 0x22),
        ]),
      ]),
    ]);

    const demuxer = await WebmDriver.demux(fromBytes(bytes, { mime: 'video/webm' }));
    try {
      expect(demuxer.packetTable?.()).toEqual([
        expect.objectContaining({ ptsUs: 0, durationUs: 100_000 }),
        expect.objectContaining({ ptsUs: 1_000_000, durationUs: 10_000 }),
      ]);
      expect(demuxer.packetStats?.(0)).toEqual({
        packetCount: 2,
        totalSizeBytes: 2,
        decodeStartUs: 0,
        decodeEndUs: 1_010_000,
        presentationStartUs: 0,
        presentationEndUs: 1_010_000,
      });
    } finally {
      await demuxer.close();
    }
  });

  it('demux packet streams expose the parsed payload view as Packet.data', async () => {
    await withEncodedChunkConstructors(async () => {
      const bytes = await loadFixture('movie_5.webm');
      const demuxed = await WebmDriver.demux(fromBytes(bytes, { mime: 'video/webm' }));
      try {
        const video = demuxed.tracks.find((track) => track.mediaType === 'video');
        expect(video).toBeDefined();
        if (video === undefined) return;
        const reader = demuxed.packets(video.id).getReader();
        try {
          const { done, value } = await reader.read();
          expect(done).toBe(false);
          expect(value?.data).toBeDefined();
          if (value?.data === undefined) return;
          expect(value.sizeBytes).toBe(value.data.byteLength);
          const copied = new Uint8Array(value.chunk.byteLength);
          value.chunk.copyTo(copied);
          expect(value.data).toEqual(copied);
        } finally {
          reader.releaseLock();
        }
      } finally {
        await demuxed.close();
      }
    });
  });

  it('batches real VP9 packet pulls without changing the packet count', async () => {
    const NativeReadableStream = globalThis.ReadableStream;
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ReadableStream');
    let pulls = 0;
    class CountingReadableStream<R = unknown> extends NativeReadableStream<R> {
      constructor(source: UnderlyingSource<R> = {}, strategy?: QueuingStrategy<R>) {
        const originalPull = source.pull;
        super(
          originalPull === undefined
            ? source
            : {
                ...source,
                pull(controller): void | PromiseLike<void> {
                  pulls++;
                  return originalPull.call(source, controller);
                },
              },
          strategy,
        );
      }
    }
    Object.defineProperty(globalThis, 'ReadableStream', {
      configurable: true,
      value: CountingReadableStream as typeof ReadableStream,
    });
    try {
      await withEncodedChunkConstructors(async () => {
        const bytes = await bytesFromMediaTest('vp9_1080p_10s.webm');
        const demuxed = await WebmDriver.demux(fromBytes(bytes, { mime: 'video/webm' }));
        try {
          const video = demuxed.tracks.find((track) => track.mediaType === 'video');
          if (video === undefined) throw new Error('expected VP9 video track');
          const reader = demuxed.packets(video.id).getReader();
          let packets = 0;
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              packets++;
            }
          } finally {
            reader.releaseLock();
          }
          expect(packets).toBe(300);
        } finally {
          await demuxed.close();
        }
      });
    } finally {
      if (originalDescriptor === undefined) Reflect.deleteProperty(globalThis, 'ReadableStream');
      else Object.defineProperty(globalThis, 'ReadableStream', originalDescriptor);
    }
    expect(pulls).toBeLessThan(300 / 4);
  });

  it('H.264 Matroska packet streams expose SPS-derived DTS without changing chunk PTS', async () => {
    await withEncodedChunkConstructors(async () => {
      const bytes = await bytesFromMediaTest('scenarios/demux/h264_in_mkv/01.mkv');
      const demuxed = await WebmDriver.demux(fromBytes(bytes, { mime: 'video/x-matroska' }));
      try {
        const video = demuxed.tracks.find((track) => track.mediaType === 'video');
        if (video === undefined) throw new Error('expected H.264 video track');
        const reader = demuxed.packets(video.id).getReader();
        try {
          const first = await reader.read();
          const second = await reader.read();
          const third = await reader.read();
          expect(first.value?.chunk.timestamp).toBe(0);
          expect(first.value?.dtsUs).toBeUndefined();
          expect(second.value?.chunk.timestamp).toBe(167_000);
          expect(second.value?.dtsUs).toBe(33_000);
          expect(third.value?.chunk.timestamp).toBe(33_000);
          expect(third.value?.dtsUs).toBe(67_000);
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      } finally {
        await demuxed.close();
      }
    });
  });
});

describe('CodecPrivate → decoder description + canonical codec ids (real fixtures)', () => {
  it('h264_in_mkv.mkv — H.264 carries its avcC as config.description (decode unblocker)', async () => {
    const mkv = await bytesFromMediaTest('h264_in_mkv.mkv');
    // parseWebm reports the per-file DocType ('matroska' → 'mkv'); the codec ids are the canonical
    // harness-golden vocabulary (h264/aac), not the raw Matroska CodecIDs.
    const parsed = parseWebm(mkv);
    expect(parsed.container).toBe('mkv');
    const video = parsed.tracks.find((t) => t.mediaType === 'video');
    const audio = parsed.tracks.find((t) => t.mediaType === 'audio');
    expect(video?.codec).toBe('h264');
    expect(video).toMatchObject({ width: 1280, height: 720 });
    expect(audio?.codec).toBe('aac');

    // The H.264 track's WebCodecs decoder description IS the CodecPrivate = the avcC box; the demuxer
    // surfaces it on TrackInfo.config. Proof: present, non-empty, configurationVersion 1 (avcC byte 0).
    const demuxed = await WebmDriver.demux(fromBytes(mkv, { mime: 'video/x-matroska' }));
    const videoTrack = demuxed.tracks.find((t) => t.mediaType === 'video');
    expect(videoTrack?.codec).toBe('h264');
    const videoConfig = videoTrack?.config;
    const videoDescription =
      videoConfig && 'description' in videoConfig ? videoConfig.description : undefined;
    expect(videoDescription).toBeInstanceOf(Uint8Array);
    const avcC = videoDescription as Uint8Array;
    expect(avcC.byteLength).toBeGreaterThan(0);
    expect(avcC[0]).toBe(0x01); // avcC configurationVersion — proves this is the codec-private record

    const audioTrack = demuxed.tracks.find((t) => t.mediaType === 'audio');
    expect(audioTrack?.codec).toBe('aac');
    const audioConfig = audioTrack?.config;
    const audioDescription =
      audioConfig && 'description' in audioConfig ? audioConfig.description : undefined;
    expect(audioDescription).toBeInstanceOf(Uint8Array);
    const asc = parseAsc(audioDescription as Uint8Array);
    expect(asc).toMatchObject({ objectType: 2, sampleRate: 48_000, channels: 2 });
    await demuxed.close();
  });

  it('bear-multitrack.webm — raw A_PCM/INT/LIT is canonicalized to pcm-s16 (no raw-CodecID leak)', async () => {
    const info = parseWebm(await loadFixture('bear-multitrack.webm'));
    const codecs = info.tracks.map((t) => t.codec);
    // The multitrack asset carries VP8 + Vorbis + (Theora) + raw PCM. The PCM track must be the canonical
    // `pcm-s16` token, never the lowercased raw id `a_pcm/int/lit` that the old fall-through emitted.
    expect(codecs).toContain('pcm-s16');
    expect(codecs.some((c) => c.startsWith('a_pcm'))).toBe(false);
    expect(codecs).toContain('vp8');
    expect(codecs).toContain('vorbis');
  });

  it('bear-multitrack.webm — Vorbis carries Xiph-laced CodecPrivate as config.description', async () => {
    const demuxed = await WebmDriver.demux(await fixtureSource('bear-multitrack.webm'));
    const vorbis = demuxed.tracks.find((t) => t.codec === 'vorbis');
    expect(vorbis?.mediaType).toBe('audio');
    const config = vorbis?.config;
    const description = config && 'description' in config ? config.description : undefined;
    expect(description).toBeInstanceOf(Uint8Array);
    const xiph = description as Uint8Array;
    expect(xiph[0]).toBe(2); // three Vorbis headers: id, comment, setup
    expect(new TextDecoder().decode(xiph)).toContain('vorbis');
    await demuxed.close();
  });

  it('movie_5.webm — VP9 stays self-describing while Opus carries its mandatory OpusHead', async () => {
    const demuxed = await WebmDriver.demux(await fixtureSource('movie_5.webm'));
    const video = demuxed.tracks.find((track) => track.mediaType === 'video');
    expect(video?.codec).toBe('vp9');
    expect(video?.config !== undefined && 'description' in video.config).toBe(false);

    const audio = demuxed.tracks.find((track) => track.mediaType === 'audio');
    expect(audio?.codec).toBe('opus');
    const audioConfig = audio?.config;
    const description =
      audioConfig !== undefined && 'description' in audioConfig
        ? audioConfig.description
        : undefined;
    expect(description).toBeInstanceOf(Uint8Array);
    const opusHead = description as Uint8Array;
    expect(new TextDecoder().decode(opusHead.subarray(0, 8))).toBe('OpusHead');
    expect(
      new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength).getUint16(10, true),
    ).toBe(312);
    await demuxed.close();
  });
});

describe('parseWebm — EBML parsing', () => {
  it('proves alpha only from one complete standards-defined Video/AlphaMode=1 declaration', () => {
    const makeVideo = (
      videoChildren: readonly number[][],
      trackChildren: readonly number[][] = [],
    ): Uint8Array => {
      const track = el(E.TrackEntry, [
        ...el(E.TrackType, [1]),
        ...el(E.TrackNumber, [1]),
        ...el(E.CodecID, str('V_VP9')),
        ...trackChildren.flat(),
        ...el(E.Video, [
          ...el(E.PixelWidth, [2]),
          ...el(E.PixelHeight, [2]),
          ...videoChildren.flat(),
        ]),
      ]);
      return new Uint8Array([
        ...el(E.EBML, el(E.DocType, str('webm'))),
        ...el(E.Segment, [
          ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
          ...el(E.Tracks, track),
        ]),
      ]);
    };
    const alpha = (payload: readonly number[]): number[] => el(E.AlphaMode, [...payload]);

    expect(parseWebm(makeVideo([alpha([1])])).tracks[0]?.alpha).toBe(true);
    for (const candidate of [
      makeVideo([]),
      makeVideo([alpha([0])]),
      makeVideo([alpha([2])]),
      makeVideo([alpha([])]),
      makeVideo([alpha([0, 0, 0, 0, 0, 0, 0, 0, 1])]),
      // A finite uint that declares two payload bytes but contains only one is not positive proof.
      makeVideo([[...E.AlphaMode, 0x82, 0x01]]),
      makeVideo([alpha([1]), alpha([1])]),
      makeVideo([alpha([1]), alpha([0])]),
      // AlphaMode is a Video child; TrackEntry-level placement is malformed and ignored.
      makeVideo([], [alpha([1])]),
    ]) {
      expect(parseWebm(candidate).tracks[0]?.alpha).toBeUndefined();
    }
  });

  it('parses Duration when declared (video track)', () => {
    const info = el(E.Info, [
      ...el(E.TimecodeScale, uintN(1_000_000, 4)),
      ...el(E.Duration, f64(5000)),
    ]);
    const video = el(E.Video, [
      ...el(E.PixelWidth, uintN(640, 2)),
      ...el(E.PixelHeight, uintN(480, 2)),
    ]);
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...video,
    ]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [...info, ...el(E.Tracks, track)]),
    ]);
    const out = parseWebm(bytes);
    expect(out.container).toBe('webm');
    expect(out.durationSec).toBeCloseTo(5, 5);
    expect(out.tracks[0]).toMatchObject({
      mediaType: 'video',
      codec: 'vp9',
      width: 640,
      height: 480,
    });
  });

  it('projects an explicit ISO-639-2 Matroska track language through the public seam', async () => {
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.TrackNumber, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...el(E.Language, str('ENG')),
      ...el(E.Video, [...el(E.PixelWidth, [2]), ...el(E.PixelHeight, [2])]),
    ]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
        ...el(E.Tracks, track),
      ]),
    ]);

    expect(parseWebm(bytes).tracks[0]?.language).toBe('eng');
    const tracks = await probeWithWebmDriver(fromBytes(bytes, { mime: 'video/webm' }));
    expect(tracks[0]?.language).toBe('eng');
  });

  it('derives duration from clusters when Duration is absent (audio track)', () => {
    const info = el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4)));
    const audio = el(E.Audio, [...el(E.SamplingFrequency, f64(48000)), ...el(E.Channels, [2])]);
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [2]),
      ...el(E.CodecID, str('A_OPUS')),
      ...audio,
    ]);
    const block = el(E.SimpleBlock, [0x81, 0x01, 0xf4, 0x80]); // track 1, rel +500, flags
    const cluster = el(E.Cluster, [...el(E.Timecode, uintN(4000, 2)), ...block]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('matroska'))),
      ...el(E.Segment, [...info, ...el(E.Tracks, track), ...cluster]),
    ]);
    const out = parseWebm(bytes);
    expect(out.container).toBe('mkv'); // DocType matroska
    expect(out.durationSec).toBeCloseTo(4.5, 5); // (4000 + 500) ticks × 1e6ns / 1e9
    expect(out.tracks[0]).toMatchObject({
      mediaType: 'audio',
      codec: 'opus',
      sampleRate: 48000,
      channels: 2,
    });
  });

  it('rejects a non-EBML / track-less file', () => {
    expect(() => parseWebm(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrowError(MediaError);
    const empty = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, el(E.Info, [])),
    ]);
    expect(() => parseWebm(empty)).toThrowError(/no decodable tracks/);
  });

  it('rejects a Segment when the mandatory leading EBML header id was destroyed', () => {
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...el(E.Video, [...el(E.PixelWidth, [2]), ...el(E.PixelHeight, [2])]),
    ]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, el(E.Tracks, track)),
    ]);
    bytes[0] = 0x1b; // still a structurally parseable 4-byte id, but no longer the EBML header id

    expect(() => parseWebm(bytes)).toThrowError(/EBML header/);
  });

  it('rejects malformed required values and unknown fields in a complete EBML header', () => {
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...el(E.Video, [...el(E.PixelWidth, [2]), ...el(E.PixelHeight, [2])]),
    ]);
    const segment = el(E.Segment, el(E.Tracks, track));
    const validFields = [
      el(E.EBMLVersion, [1]),
      el(E.EBMLReadVersion, [1]),
      el(E.EBMLMaxIDLength, [4]),
      el(E.EBMLMaxSizeLength, [8]),
      el(E.DocType, str('webm')),
      el(E.DocTypeVersion, [2]),
      el(E.DocTypeReadVersion, [2]),
    ];
    const file = (fields: readonly number[][]): Uint8Array =>
      new Uint8Array([...el(E.EBML, fields.flat()), ...segment]);
    const replace = (index: number, value: number[]): number[][] =>
      validFields.map((field, fieldIndex) => (fieldIndex === index ? value : field));

    expect(parseWebm(file(validFields)).container).toBe('webm');
    for (const fields of [
      replace(0, el(E.EBMLVersion, [2])),
      replace(1, el(E.EBMLReadVersion, [2])),
      replace(2, el(E.EBMLMaxIDLength, [5])),
      replace(3, el(E.EBMLMaxSizeLength, [9])),
      replace(5, el(E.DocTypeVersion, [1])),
      [...validFields, el([0x42, 0x80], [1])],
      [...validFields, el(E.DocTypeReadVersion, [2])],
    ]) {
      expect(() => parseWebm(file(fields))).toThrowError(/EBML header/);
    }
  });

  it('maps codec ids (AVC→h264, HEVC→hevc, MPEG/L3→mp3, unknown→lowercase)', () => {
    const vid = el(E.Video, [...el(E.PixelWidth, [2]), ...el(E.PixelHeight, [2])]);
    const aud = el(E.Audio, el(E.Channels, [2]));
    const te = (type: number, codec: string, sub: number[]): number[] =>
      el(E.TrackEntry, [...el(E.TrackType, [type]), ...el(E.CodecID, str(codec)), ...sub]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
        ...el(E.Tracks, [
          ...te(1, 'V_MPEG4/ISO/AVC', vid),
          ...te(1, 'V_MPEGH/ISO/HEVC', vid),
          ...te(2, 'A_MPEG/L3', aud),
          ...te(2, 'A_WEIRD', aud),
          ...te(17, 'S_TEXT/UTF8', []), // subtitle → skipped
        ]),
      ]),
    ]);
    expect(parseWebm(bytes).tracks.map((t) => t.codec)).toEqual(['h264', 'hevc', 'mp3', 'a_weird']);
  });

  it('handles an unknown-size Segment and rejects a header without mandatory DocType', () => {
    const info = el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4)));
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.CodecID, str('V_VP8')),
      ...el(E.Video, [...el(E.PixelWidth, [4]), ...el(E.PixelHeight, [4])]),
    ]);
    const missingDocType = new Uint8Array([
      ...el(E.EBML, []),
      ...E.Segment,
      0xff,
      ...info,
      ...el(E.Tracks, track),
    ]);
    expect(() => parseWebm(missingDocType)).toThrowError(/DocType/);

    // A valid EBML header plus an unknown-size Segment (0xFF) extends the segment to EOF.
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...E.Segment,
      0xff,
      ...info,
      ...el(E.Tracks, track),
    ]);
    const out = parseWebm(bytes);
    expect(out.container).toBe('webm');
    expect(out.tracks[0]?.codec).toBe('vp8');
  });
});

describe('WebmDriver — demux seam + muxer', () => {
  it('demuxes a stream source; the packet seam is a typed gap in node', async () => {
    const bytes = await loadFixture('white.webm');
    const half = bytes.byteLength >> 1;
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes.subarray(0, half)); // two chunks → exercises the head-concat path
            c.enqueue(bytes.subarray(half));
            c.close();
          },
        }),
    };
    const demuxed = await WebmDriver.demux(streamSource);
    expect(demuxed.tracks[0]?.codec).toBe('vp8');
    // The blocks are parsed (demuxWebm runs in node); only the EncodedChunk WRAPPING needs WebCodecs,
    // so packets() is a typed capability gap in node and a bad track id is a typed demux error.
    expect(() => demuxed.packets(0)).toThrowError(CapabilityError);
    expect(() => demuxed.packets(99)).toThrowError(MediaError);
    await demuxed.close();
  });

  it('createMuxer returns a working WebmMuxer (round-trip validated in ebml-write.test.ts)', () => {
    const muxer = WebmDriver.createMuxer();
    expect(muxer).toBeInstanceOf(WebmMuxer);
  });

  it('streamCopy rejects unsupported target containers with a typed capability miss', async () => {
    const streamCopy = WebmDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('WebmDriver.streamCopy must be implemented');
    await expect(
      streamCopy(fromBytes(await loadFixture('movie_5.webm'), { mime: 'video/webm' }), {
        container: 'mp4',
      }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('streamCopy rejects a valid WebM track table with no packets', async () => {
    const streamCopy = WebmDriver.streamCopy;
    if (streamCopy === undefined) throw new Error('WebmDriver.streamCopy must be implemented');
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.TrackNumber, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...el(E.Video, [...el(E.PixelWidth, uintN(64, 1)), ...el(E.PixelHeight, uintN(64, 1))]),
    ]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
        ...el(E.Tracks, track),
      ]),
    ]);

    await expect(streamCopy(fromBytes(bytes, { mime: 'video/webm' }))).rejects.toBeInstanceOf(
      MediaError,
    );
  });
});

describe('demuxWebm — (Simple)Block → frames vs golden-packets (real .webm + .mkv)', () => {
  it('rejects a real file whose Cluster size header was destroyed instead of returning zero packets', async () => {
    const bytes = await loadFixture('movie_5.webm');
    const corrupted = bytes.slice();
    let clusterOffset = -1;
    for (let index = 0; index + E.Cluster.length <= corrupted.byteLength; index++) {
      if (E.Cluster.every((value, offset) => corrupted[index + offset] === value)) {
        clusterOffset = index;
        break;
      }
    }
    expect(clusterOffset).toBeGreaterThanOrEqual(0);
    corrupted[clusterOffset + E.Cluster.length] = 0xff;

    expect(() => demuxWebm(corrupted)).toThrowError(/no media blocks/);
  });

  it('rejects a real file with a truncated finite Segment element after the last Cluster', async () => {
    const bytes = await loadFixture('movie_5.webm');
    const corrupted = new Uint8Array(bytes.byteLength + 1);
    corrupted.set(bytes);
    corrupted[corrupted.byteLength - 1] = 0;

    // Grow the finite Segment size by one byte while leaving that final element header incomplete.
    const segmentOffset = bytes.findIndex(
      (_byte, index) =>
        index + E.Segment.length <= bytes.byteLength &&
        E.Segment.every((part, partIndex) => bytes[index + partIndex] === part),
    );
    expect(segmentOffset).toBeGreaterThanOrEqual(0);
    if (segmentOffset < 0) return;
    const sizeOffset = segmentOffset + E.Segment.length;
    expect(corrupted[sizeOffset]).toBeDefined();
    const sizeLastByte = sizeOffset + 7;
    expect(corrupted[sizeLastByte]).toBeDefined();
    corrupted[sizeLastByte] = (corrupted[sizeLastByte] ?? 0) + 1;

    expect(() => demuxWebm(corrupted)).toThrowError(/truncated|malformed|invalid EBML/i);
  });

  interface GoldenPacket {
    trackIndex: number;
    size: number;
    ptsUs: number;
    dtsUs: number;
    keyframe: boolean;
  }
  const GOLDEN_DIR = new URL('../../../../media-test/fixtures/golden/', import.meta.url).pathname;
  async function golden(name: string): Promise<GoldenPacket[]> {
    return JSON.parse(
      await readFile(`${GOLDEN_DIR}${name}.packets.json`, 'utf8'),
    ) as GoldenPacket[];
  }

  const H264_MKV_ROTATIONS = [
    {
      media: 'h264_in_mkv.mkv',
      golden: 'h264_in_mkv.mkv',
    },
    ...['01', '02', '03'].map((stem) => ({
      media: `scenarios/demux/h264_in_mkv/${stem}.mkv`,
      golden: `scenarios/demux/h264_in_mkv/${stem}.mkv`,
    })),
  ] as const;

  it.each(H264_MKV_ROTATIONS)(
    '$media — packet-info preserves global file order and exact ffprobe PTS/DTS',
    async ({ media, golden: goldenName }) => {
      const bytes = await bytesFromMediaTest(media);
      const table = webmPacketPayloadInfoFromBytes(bytes);
      const actual = table.packets.map(
        (packet): GoldenPacket => ({
          trackIndex: packet.trackIndex,
          size: packet.size,
          ptsUs: packet.ptsUs,
          dtsUs: packet.dtsUs,
          keyframe: packet.keyframe,
        }),
      );
      expect(actual).toEqual(await golden(goldenName));
    },
  );

  const PACKET_TABLE_GOLDENS = ['av1_720p_5s.webm', 'realworld_mdn_flower.webm'] as const;
  it.each(PACKET_TABLE_GOLDENS)(
    '$media — payload-free packetTable matches the baked golden',
    async (media) => {
      const bytes = await bytesFromMediaTest(media);
      const demuxed = await WebmDriver.demux(fromBytes(bytes, { mime: 'video/webm' }));
      try {
        const table = demuxed.packetTable?.();
        expect(table).toBeDefined();
        const actual =
          table?.map(
            (packet): GoldenPacket => ({
              trackIndex: packet.trackId,
              size: packet.sizeBytes,
              ptsUs: packet.ptsUs,
              dtsUs: packet.dtsUs,
              keyframe: packet.keyframe,
            }),
          ) ?? [];
        const expected = await golden(media);
        expect(actual.length).toBe(expected.length);
        for (const trackIndex of new Set(expected.map((packet) => packet.trackIndex))) {
          const actualTrack = actual.filter((packet) => packet.trackIndex === trackIndex);
          const expectedTrack = expected.filter((packet) => packet.trackIndex === trackIndex);
          const actualOrigin = actualTrack[0]?.ptsUs ?? 0;
          const expectedOrigin = expectedTrack[0]?.ptsUs ?? 0;
          expect(
            actualTrack.map((packet) => ({
              ...packet,
              ptsUs: packet.ptsUs - actualOrigin,
              dtsUs: packet.dtsUs - actualOrigin,
            })),
          ).toEqual(
            expectedTrack.map((packet) => ({
              ...packet,
              ptsUs: packet.ptsUs - expectedOrigin,
              dtsUs: packet.dtsUs - expectedOrigin,
            })),
          );
        }
      } finally {
        await demuxed.close();
      }
    },
  );

  it('attachment-bearing Matroska exposes JSON as other + JPEG as one MJPEG stream packet', async () => {
    const bytes = await bytesFromMediaTest('scenarios/demux/h264_in_mkv/03.mkv');
    const table = webmPacketPayloadInfoFromBytes(bytes);
    const probeTracks = await probeWithWebmDriver(fromBytes(bytes, { mime: 'video/x-matroska' }));
    expect(probeTracks).toEqual(table.tracks);
    expect(
      table.tracks.map((track) => ({
        mediaType: track.mediaType,
        codec: track.codec,
        nonMedia: track.nonMedia,
        fps: track.fps,
        config: track.config,
      })),
    ).toEqual([
      expect.objectContaining({ mediaType: 'video', codec: 'h264' }),
      expect.objectContaining({ mediaType: 'audio', codec: 'aac' }),
      expect.objectContaining({ mediaType: 'audio', codec: '', nonMedia: true }),
      expect.objectContaining({
        mediaType: 'video',
        codec: 'mjpeg',
        fps: 90_000,
        config: expect.objectContaining({ codedWidth: 480, codedHeight: 360 }),
      }),
    ]);
    expect(table.packets[0]).toMatchObject({
      trackIndex: 3,
      size: 30_915,
      ptsUs: 0,
      dtsUs: 0,
      keyframe: true,
    });
  });

  // A real H.264 .mkv, a real VP9/Opus .webm, and a real AV1/Opus .webm — Block parsing must reproduce
  // the harness golden packet list exactly: per-track count, byte-exact frame sizes, monotonic
  // origin-aligned timestamps (±1 ms), and keyframe flags (SimpleBlock 0x80 / BlockGroup ReferenceBlock).
  it.each(['h264_in_mkv.mkv', 'vp9_1080p_10s.webm', 'av1_720p_5s.webm'])(
    '%s — exact packet count + size + timestamp + keyframe per track',
    async (name) => {
      const want = await golden(name);
      const { info, framesByIndex } = demuxWebm(await bytesFromMediaTest(name));
      const total = framesByIndex.reduce((n, f) => n + f.length, 0);
      expect(total).toBe(want.length);

      info.tracks.forEach((_track, ti) => {
        const ours = framesByIndex[ti] ?? [];
        const gold = want.filter((g) => g.trackIndex === ti);
        expect(ours.length).toBe(gold.length);
        // Origin-align each track's timeline (the harness oracle does the same), then compare deltas.
        const oOrigin = ours[0]?.timestampUs ?? 0;
        const gOrigin = gold[0]?.ptsUs ?? 0;
        for (let i = 0; i < gold.length; i++) {
          const u = ours[i];
          const g = gold[i];
          if (!u || !g) throw new Error(`missing packet ${ti}:${i}`);
          expect(u.data.byteLength).toBe(g.size);
          expect(u.keyframe).toBe(g.keyframe);
          expect(Math.abs(u.timestampUs - oOrigin - (g.ptsUs - gOrigin))).toBeLessThanOrEqual(1000);
        }
        // Timestamps are non-decreasing in decode order (block/file order).
        for (let i = 1; i < ours.length; i++) {
          expect(ours[i]?.timestampUs).toBeGreaterThanOrEqual(ours[i - 1]?.timestampUs ?? 0);
        }
      });
    },
  );

  it('the H.264 .mkv frames + their avcC description form a valid VideoDecoderConfig', async () => {
    const mkv = await bytesFromMediaTest('h264_in_mkv.mkv');
    const frames = demuxWebm(mkv).framesByIndex;
    // The demuxer contract surfaces the decoder config (codec + dims + the avcC description) on
    // TrackInfo.config — exactly what `VideoDecoder.configure` needs for an H.264-in-Matroska decode.
    const demuxed = await WebmDriver.demux(fromBytes(mkv, { mime: 'video/x-matroska' }));
    const videoTrackInfo = demuxed.tracks.find((t) => t.mediaType === 'video');
    const config = videoTrackInfo?.config;
    if (!config || !('codedWidth' in config)) throw new Error('expected a video config');
    expect(config.codec).toBe('h264');
    expect(config.codedWidth).toBe(1280);
    expect(config.codedHeight).toBe(720);
    const description = 'description' in config ? config.description : undefined;
    expect(description).toBeInstanceOf(Uint8Array);
    expect((description as Uint8Array)[0]).toBe(0x01); // avcC configurationVersion
    // The first decodable frame is a keyframe with real bytes — the decode loop's first input.
    const videoIndex = demuxed.tracks.findIndex((t) => t.mediaType === 'video');
    expect(frames[videoIndex]?.[0]?.keyframe).toBe(true);
    expect((frames[videoIndex]?.[0]?.data.byteLength ?? 0) > 0).toBe(true);
    await demuxed.close();
  });

  it('bear-vp9-alpha.webm exposes VPx alpha BlockAdditions as frame side data', async () => {
    const { info, framesByIndex } = demuxWebm(await loadFixture('bear-vp9-alpha.webm'));
    const videoIndex = info.tracks.findIndex((track) => track.mediaType === 'video');
    const frames = framesByIndex[videoIndex] ?? [];
    expect(frames.length).toBeGreaterThan(0);

    const alphaFrames = frames.filter((frame) => frame.alpha !== undefined);
    expect(alphaFrames.length).toBeGreaterThan(0);
    expect(alphaFrames[0]?.alpha?.byteLength).toBeGreaterThan(0);
    expect(alphaFrames[0]?.alpha?.byteLength).not.toBe(alphaFrames[0]?.data.byteLength);
  });
});

describe('demuxWebm — lacing (none / Xiph / EBML / fixed) splits one block into N frames', () => {
  // Build a one-audio-track WebM whose single Cluster holds one laced SimpleBlock, then assert the
  // demuxer splits it into the expected per-frame byte lengths. Lacing is codec-agnostic framing, so a
  // hand-built block is the right unit subject (the real corpus is unlaced — see the golden tests above).
  function webmWithBlock(blockBody: number[]): Uint8Array {
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [2]),
      ...el(E.TrackNumber, [1]),
      ...el(E.CodecID, str('A_OPUS')),
      ...el(E.Audio, [...el(E.SamplingFrequency, f64(48000)), ...el(E.Channels, [1])]),
    ]);
    const cluster = el(E.Cluster, [
      ...el(E.Timecode, uintN(0, 1)),
      ...el(E.SimpleBlock, blockBody),
    ]);
    return new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
        ...el(E.Tracks, track),
        ...cluster,
      ]),
    ]);
  }
  // Block body prefix: track-number vint (0x81) + int16 timecode (0,0) + flags byte.
  const DATA9 = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22];

  it('no lacing → a single frame of the whole payload', () => {
    const { framesByIndex } = demuxWebm(webmWithBlock([0x81, 0, 0, 0x80, 0xaa, 0xbb, 0xcc]));
    expect(framesByIndex[0]?.map((f) => f.data.byteLength)).toEqual([3]);
  });

  it('reports every audio packet as independently decodable even when SimpleBlock omits its key bit', () => {
    const table = webmPacketPayloadInfoFromBytes(
      webmWithBlock([0x81, 0, 0, 0x00, 0xaa, 0xbb, 0xcc]),
    );
    expect(table.tracks[0]?.mediaType).toBe('audio');
    expect(table.packets).toHaveLength(1);
    expect(table.packets[0]?.keyframe).toBe(true);
  });

  it('Xiph lacing → frame sizes from the consecutive-byte size table', () => {
    // flags 0x80|0x02 (keyframe + Xiph); [count-1=2][size0=2][size1=3]; last frame (4) is implicit.
    const body = [0x81, 0, 0, 0x82, 2, 2, 3, ...DATA9];
    expect(demuxWebm(webmWithBlock(body)).framesByIndex[0]?.map((f) => f.data.byteLength)).toEqual([
      2, 3, 4,
    ]);
  });

  it('EBML lacing → first vint size then signed-vint deltas', () => {
    // flags 0x80|0x06; [count-1=2][vint size0=2 →0x82][signed delta +1 →0xC0]; last (4) implicit.
    const body = [0x81, 0, 0, 0x86, 2, 0x82, 0xc0, ...DATA9];
    expect(demuxWebm(webmWithBlock(body)).framesByIndex[0]?.map((f) => f.data.byteLength)).toEqual([
      2, 3, 4,
    ]);
  });

  it('fixed lacing → equal-size frames (payload ÷ frame count)', () => {
    // flags 0x80|0x04; [count-1=2]; 9 payload bytes / 3 = 3 each, no size table.
    const body = [0x81, 0, 0, 0x84, 2, ...DATA9];
    expect(demuxWebm(webmWithBlock(body)).framesByIndex[0]?.map((f) => f.data.byteLength)).toEqual([
      3, 3, 3,
    ]);
  });

  it('a BlockGroup with a ReferenceBlock is a delta frame; without one it is a keyframe', () => {
    // Two single-frame blocks in BlockGroups: the first has no ReferenceBlock (key), the second has one.
    const blk = (tc: number): number[] => [0x81, 0, tc, 0x00, 0xaa, 0xbb];
    const refBlock = el([0xfb], [0x01]); // ReferenceBlock = +1 (references a prior frame → delta)
    const cluster = el(E.Cluster, [
      ...el(E.Timecode, uintN(0, 1)),
      ...el([0xa0], el([0xa1], blk(0))), // BlockGroup → Block, no ReferenceBlock → keyframe
      ...el([0xa0], [...el([0xa1], blk(1)), ...refBlock]), // BlockGroup → Block + ReferenceBlock → delta
    ]);
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.TrackNumber, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...el(E.Video, [...el(E.PixelWidth, uintN(64, 1)), ...el(E.PixelHeight, uintN(64, 1))]),
    ]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
        ...el(E.Tracks, track),
        ...cluster,
      ]),
    ]);
    const frames = demuxWebm(bytes).framesByIndex[0] ?? [];
    expect(frames.map((f) => f.keyframe)).toEqual([true, false]);
  });

  it('a BlockGroup with BlockAddID=1 attaches VPx alpha side data to its single frame', () => {
    const color = [0xaa, 0xbb, 0xcc];
    const alpha = [0x11, 0x22, 0x33, 0x44];
    const block = [0x81, 0, 0, 0x00, ...color];
    const additions = el(
      E.BlockAdditions,
      el(E.BlockMore, [...el(E.BlockAddID, [0x01]), ...el(E.BlockAdditional, alpha)]),
    );
    const cluster = el(E.Cluster, [
      ...el(E.Timecode, uintN(0, 1)),
      ...el(E.BlockGroup, [...el(E.Block, block), ...additions]),
    ]);
    const track = el(E.TrackEntry, [
      ...el(E.TrackType, [1]),
      ...el(E.TrackNumber, [1]),
      ...el(E.CodecID, str('V_VP9')),
      ...el(E.Video, [...el(E.PixelWidth, uintN(64, 1)), ...el(E.PixelHeight, uintN(64, 1))]),
    ]);
    const bytes = new Uint8Array([
      ...el(E.EBML, el(E.DocType, str('webm'))),
      ...el(E.Segment, [
        ...el(E.Info, el(E.TimecodeScale, uintN(1_000_000, 4))),
        ...el(E.Tracks, track),
        ...cluster,
      ]),
    ]);

    const frame = demuxWebm(bytes).framesByIndex[0]?.[0];
    expect(frame?.data).toEqual(new Uint8Array(color));
    expect(frame?.alpha).toEqual(new Uint8Array(alpha));
  });
});
