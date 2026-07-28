import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ByteSource, TrackInfo } from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';
import { MpegTsDriver } from './mpegts-driver.ts';
import { detectFraming, parseTs } from './ts-parse.ts';

const DERIVED = new URL('../../../fixtures/media-derived/h264_720p.head.ts', import.meta.url);
const FULL_TS = new URL('../../../../media-test/fixtures/media/h264_ts.ts', import.meta.url);
const HAS_FULL_TS = existsSync(FULL_TS);
const SIZE_LADDER_URLS = ['01.ts', '02.ts', '03.ts', 'h264_ts.ts'].map((file) => ({
  file,
  url: new URL(
    `../../../../media-test/fixtures/media/scenarios/probe/h264_ts/${file}`,
    import.meta.url,
  ),
}));
const HAS_SIZE_LADDER = SIZE_LADDER_URLS.every(({ url }) => existsSync(url));
const TS_PACKET_BYTES = 188;
const INITIAL_SPARSE_WINDOW_BYTES = 128 * 1024;

interface RangeCall {
  readonly start: number;
  readonly end: number;
  readonly signal: AbortSignal | undefined;
}

interface ProbeSummary {
  readonly codec: string;
  readonly mediaType: string;
  readonly durationSec: number | undefined;
  readonly fps: number | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly sampleRate: number | undefined;
  readonly channels: number | undefined;
}

let realTs: Uint8Array;
let fullTs: Uint8Array | undefined;
let sizeLadder: { readonly file: string; readonly bytes: Uint8Array }[] = [];

beforeAll(async () => {
  realTs = new Uint8Array(await readFile(DERIVED));
  if (HAS_FULL_TS) fullTs = new Uint8Array(await readFile(FULL_TS));
  if (HAS_SIZE_LADDER) {
    sizeLadder = await Promise.all(
      SIZE_LADDER_URLS.map(async ({ file, url }) => ({
        file,
        bytes: new Uint8Array(await readFile(url)),
      })),
    );
  }
});

function repeatBytes(bytes: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(bytes.byteLength * count);
  for (let index = 0; index < count; index += 1) out.set(bytes, index * bytes.byteLength);
  return out;
}

function readPts(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) >> 1) & 0x07) * 2 ** 30 +
    (bytes[offset + 1] as number) * 2 ** 22 +
    (((bytes[offset + 2] as number) >> 1) & 0x7f) * 2 ** 15 +
    (bytes[offset + 3] as number) * 2 ** 7 +
    (((bytes[offset + 4] as number) >> 1) & 0x7f)
  );
}

function writePts(bytes: Uint8Array, offset: number, ticks: number): void {
  const value = ticks % 2 ** 33;
  const prefix = (bytes[offset] as number) & 0xf0;
  bytes[offset] = prefix | (Math.floor(value / 2 ** 29) & 0x0e) | 1;
  bytes[offset + 1] = Math.floor(value / 2 ** 22) & 0xff;
  bytes[offset + 2] = (Math.floor(value / 2 ** 14) & 0xfe) | 1;
  bytes[offset + 3] = Math.floor(value / 2 ** 7) & 0xff;
  bytes[offset + 4] = ((Math.floor(value) * 2) & 0xfe) | 1;
}

function shiftedCopy(bytes: Uint8Array, tickOffset: number): Uint8Array {
  const out = bytes.slice();
  for (let packetStart = 0; packetStart + TS_PACKET_BYTES <= out.byteLength; packetStart += 188) {
    const b1 = out[packetStart + 1] as number;
    const b3 = out[packetStart + 3] as number;
    if ((b1 & 0x40) === 0 || (b3 & 0x10) === 0) continue;
    let payload = packetStart + 4;
    if ((b3 & 0x20) !== 0) payload += 1 + (out[payload] as number);
    if (
      payload + 19 > packetStart + TS_PACKET_BYTES ||
      out[payload] !== 0 ||
      out[payload + 1] !== 0 ||
      out[payload + 2] !== 1
    ) {
      continue;
    }
    const flags = ((out[payload + 7] as number) >> 6) & 0x03;
    if ((flags & 0x02) !== 0) {
      const ptsOffset = payload + 9;
      writePts(out, ptsOffset, readPts(out, ptsOffset) + tickOffset);
    }
    if (flags === 0x03) {
      const dtsOffset = payload + 14;
      writePts(out, dtsOffset, readPts(out, dtsOffset) + tickOffset);
    }
  }
  return out;
}

function monotonicCopies(
  bytes: Uint8Array,
  count: number,
  transform?: (copy: Uint8Array, index: number) => Uint8Array,
): Uint8Array {
  const copies = Array.from({ length: count }, (_, index) => {
    const shifted = shiftedCopy(bytes, index * 90_000);
    return transform?.(shifted, index) ?? shifted;
  });
  const out = new Uint8Array(copies.reduce((total, copy) => total + copy.byteLength, 0));
  let offset = 0;
  for (const copy of copies) {
    out.set(copy, offset);
    offset += copy.byteLength;
  }
  return out;
}

function withoutH264Sps(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  for (let index = 0; index + 4 < out.byteLength; index += 1) {
    let headerOffset: number | undefined;
    if (out[index] === 0 && out[index + 1] === 0 && out[index + 2] === 1) {
      headerOffset = index + 3;
    } else if (
      out[index] === 0 &&
      out[index + 1] === 0 &&
      out[index + 2] === 0 &&
      out[index + 3] === 1
    ) {
      headerOffset = index + 4;
    }
    const header = headerOffset === undefined ? undefined : out[headerOffset];
    if (headerOffset !== undefined && header !== undefined && (header & 0x1f) === 7) {
      out[headerOffset] = (header & 0xe0) | 6;
    }
  }
  return out;
}

function withDiscontinuityIndicator(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  for (let packetStart = 0; packetStart + TS_PACKET_BYTES <= out.byteLength; packetStart += 188) {
    const adaptationFieldControl = ((out[packetStart + 3] as number) >> 4) & 0x03;
    if ((adaptationFieldControl & 0x02) === 0 || (out[packetStart + 4] as number) === 0) continue;
    out[packetStart + 5] = (out[packetStart + 5] as number) | 0x80;
    return out;
  }
  throw new Error('test MPEG-TS fixture has no adaptation field for a discontinuity flag');
}

/** MPEG-2 PSI CRC-32 (non-reflected polynomial/initial value; a complete section reduces to zero). */
function mpeg2Crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const value of bytes) {
    crc = (crc ^ (value << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000_0000) !== 0 ? ((crc << 1) ^ 0x04c1_1db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

function psiSectionStart(bytes: Uint8Array, packetStart: number): number | undefined {
  if (bytes[packetStart] !== 0x47 || ((bytes[packetStart + 1] as number) & 0x40) === 0) {
    return undefined;
  }
  const adaptationFieldControl = ((bytes[packetStart + 3] as number) >> 4) & 0x03;
  if ((adaptationFieldControl & 0x01) === 0) return undefined;
  let payloadStart = packetStart + 4;
  if ((adaptationFieldControl & 0x02) !== 0) {
    payloadStart += 1 + (bytes[payloadStart] as number);
  }
  const packetEnd = packetStart + TS_PACKET_BYTES;
  const pointer = bytes[payloadStart];
  if (pointer === undefined) return undefined;
  const sectionStart = payloadStart + 1 + pointer;
  return sectionStart < packetEnd ? sectionStart : undefined;
}

/**
 * Add an idle AAC declaration to the final PMT in the first sparse tail window. An earlier PMT in that
 * same window remains unchanged, producing a valid sampled A→B stream-set transition with a recomputed
 * section length, version, and CRC.
 */
function withTailPmtStreamAddition(bytes: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly tailStart: number;
} {
  if (bytes.byteLength % TS_PACKET_BYTES !== 0) {
    throw new Error('test MPEG-TS fixture is not packet aligned');
  }
  const out = bytes.slice();
  const tailStart =
    Math.floor((out.byteLength - INITIAL_SPARSE_WINDOW_BYTES) / TS_PACKET_BYTES) * TS_PACKET_BYTES;
  const tailPmtSections: { readonly packetStart: number; readonly sectionStart: number }[] = [];
  for (
    let packetStart = tailStart;
    packetStart + TS_PACKET_BYTES <= out.byteLength;
    packetStart += TS_PACKET_BYTES
  ) {
    const sectionStart = psiSectionStart(out, packetStart);
    if (sectionStart !== undefined && out[sectionStart] === 0x02) {
      tailPmtSections.push({ packetStart, sectionStart });
    }
  }
  if (tailPmtSections.length < 2) {
    throw new Error('test MPEG-TS tail must contain at least two PMTs');
  }

  const target = tailPmtSections.at(-1);
  if (target === undefined) throw new Error('test MPEG-TS tail has no final PMT');
  const sectionLength =
    (((out[target.sectionStart + 1] as number) & 0x0f) << 8) |
    (out[target.sectionStart + 2] as number);
  const sectionEnd = target.sectionStart + 3 + sectionLength;
  if (
    sectionEnd > target.packetStart + TS_PACKET_BYTES ||
    mpeg2Crc32(out.subarray(target.sectionStart, sectionEnd)) !== 0
  ) {
    throw new Error('test MPEG-TS PMT is incomplete or has an invalid CRC');
  }

  const addedEntryBytes = 5;
  const newSectionLength = sectionLength + addedEntryBytes;
  const oldCrcStart = sectionEnd - 4;
  const newCrcStart = oldCrcStart + addedEntryBytes;
  if (newCrcStart + 4 > target.packetStart + TS_PACKET_BYTES) {
    throw new Error('test MPEG-TS PMT packet has no room for another stream declaration');
  }

  out[target.sectionStart + 1] =
    ((out[target.sectionStart + 1] as number) & 0xf0) | ((newSectionLength >> 8) & 0x0f);
  out[target.sectionStart + 2] = newSectionLength & 0xff;
  const version = ((out[target.sectionStart + 5] as number) >> 1) & 0x1f;
  out[target.sectionStart + 5] =
    ((out[target.sectionStart + 5] as number) & 0xc1) | (((version + 1) & 0x1f) << 1);
  // stream_type 0x0f (ADTS AAC), elementary_PID 0x0102, ES_info_length 0.
  out.set([0x0f, 0xe1, 0x02, 0xf0, 0x00], oldCrcStart);
  const crc = mpeg2Crc32(out.subarray(target.sectionStart, newCrcStart));
  out[target.sectionStart + newSectionLength - 1] = (crc >>> 24) & 0xff;
  out[target.sectionStart + newSectionLength] = (crc >>> 16) & 0xff;
  out[target.sectionStart + newSectionLength + 1] = (crc >>> 8) & 0xff;
  out[target.sectionStart + newSectionLength + 2] = crc & 0xff;
  if (mpeg2Crc32(out.subarray(target.sectionStart, newCrcStart + 4)) !== 0) {
    throw new Error('test MPEG-TS PMT rewrite produced an invalid CRC');
  }
  return { bytes: out, tailStart };
}

function wrapPackets(bytes: Uint8Array, packetSize: 188 | 192 | 204): Uint8Array {
  if (packetSize === 188) return bytes;
  if (bytes.byteLength % TS_PACKET_BYTES !== 0) {
    throw new Error('test MPEG-TS fixture is not packet aligned');
  }
  const packetCount = bytes.byteLength / TS_PACKET_BYTES;
  const out = new Uint8Array(packetCount * packetSize);
  for (let index = 0; index < packetCount; index += 1) {
    const inputOffset = index * TS_PACKET_BYTES;
    const outputOffset = index * packetSize;
    const tsOffset = packetSize === 192 ? 4 : 0;
    out.set(bytes.subarray(inputOffset, inputOffset + TS_PACKET_BYTES), outputOffset + tsOffset);
    if (packetSize === 204) out.fill(0xa5, outputOffset + TS_PACKET_BYTES, outputOffset + 204);
  }
  return out;
}

function rangedSource(bytes: Uint8Array): {
  readonly source: ByteSource;
  readonly calls: RangeCall[];
  streamCalls(): number;
} {
  const calls: RangeCall[] = [];
  let streams = 0;
  return {
    calls,
    streamCalls: () => streams,
    source: {
      size: bytes.byteLength,
      stream(): ReadableStream<Uint8Array> {
        streams += 1;
        throw new Error('known-size ranged MPEG-TS probe must not open the full stream');
      },
      range(start, end, signal): Promise<Uint8Array> {
        calls.push({ start, end, signal });
        if (signal?.aborted) {
          return Promise.reject(new MediaError('aborted', 'operation aborted'));
        }
        return Promise.resolve(bytes.subarray(start, end));
      },
    },
  };
}

function withEdgeJunk(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength + 18);
  out.fill(0x5a, 0, 7);
  out.set(bytes, 7);
  out.fill(0xa5, 7 + bytes.byteLength);
  return out;
}

function summarizeTracks(tracks: readonly TrackInfo[]): ProbeSummary[] {
  return tracks.map((track) => {
    const config = track.config;
    return {
      codec: track.codec,
      mediaType: track.mediaType,
      durationSec: track.durationSec,
      fps: track.fps,
      width: config !== undefined && 'codedWidth' in config ? config.codedWidth : undefined,
      height: config !== undefined && 'codedHeight' in config ? config.codedHeight : undefined,
      sampleRate: config !== undefined && 'sampleRate' in config ? config.sampleRate : undefined,
      channels:
        config !== undefined && 'numberOfChannels' in config ? config.numberOfChannels : undefined,
    };
  });
}

function summarizeParsed(bytes: Uint8Array): ProbeSummary[] {
  return parseTs(bytes).tracks.map((track) => {
    const config = track.config;
    return {
      codec: track.stream.codec,
      mediaType: track.stream.mediaType,
      durationSec: track.durationSec,
      fps: track.fps,
      width: 'codedWidth' in config ? config.codedWidth : undefined,
      height: 'codedHeight' in config ? config.codedHeight : undefined,
      sampleRate: 'sampleRate' in config ? config.sampleRate : undefined,
      channels: 'numberOfChannels' in config ? config.numberOfChannels : undefined,
    };
  });
}

async function probe(source: ByteSource, signal?: AbortSignal): Promise<readonly TrackInfo[]> {
  const implementation = MpegTsDriver.probe;
  if (implementation === undefined) throw new Error('MPEG-TS metadata probe is not implemented');
  return implementation.call(MpegTsDriver, source, signal === undefined ? {} : { signal });
}

describe.each([188, 192, 204] as const)(
  'MPEG-TS sparse probe — %i-byte physical packets',
  (packetSize) => {
    it('accepts a self-contained monotonic source without carrying parser state across ranges', async () => {
      const bytes = withEdgeJunk(wrapPackets(monotonicCopies(realTs, 8), packetSize));
      const subject = rangedSource(bytes);

      const tracks = await probe(subject.source);

      expect(summarizeTracks(tracks)).toEqual(summarizeParsed(bytes));
      expect(subject.streamCalls()).toBe(0);
      expect(subject.calls.at(-1)).not.toMatchObject({ start: 0, end: bytes.byteLength });
      const framing = detectFraming(bytes);
      expect(framing).toBeDefined();
      const tails = subject.calls.filter((call) => call.start > 0);
      expect(tails.length).toBeGreaterThan(0);
      for (const tail of tails) {
        expect((tail.start - (framing?.start ?? 0)) % packetSize).toBe(0);
      }
    });

    it.skipIf(!HAS_FULL_TS)(
      'reads packet-aligned head/tail ranges and preserves PAT/PMT, codec config, and timing',
      async () => {
        if (fullTs === undefined) throw new Error('full MPEG-TS fixture was not loaded');
        const bytes = wrapPackets(fullTs, packetSize);
        const subject = rangedSource(bytes);

        const tracks = await probe(subject.source);

        expect(summarizeTracks(tracks)).toEqual(summarizeParsed(bytes));
        expect(tracks.map((track) => track.codec)).toEqual(['h264', 'aac']);
        expect(summarizeTracks(tracks)).toMatchObject([
          { width: 1280, height: 720, fps: 30 },
          { sampleRate: 48_000, channels: 2 },
        ]);
        expect(subject.streamCalls()).toBe(0);
        expect(subject.calls.length).toBeGreaterThanOrEqual(2);
        expect(
          subject.calls.reduce((total, call) => total + call.end - call.start, 0),
        ).toBeLessThan(bytes.byteLength / 2);
        const tail = subject.calls.find((call) => call.start > 0);
        expect(tail).toBeDefined();
        if (tail === undefined) throw new Error('expected a tail range');
        expect(tail.start % packetSize).toBe(0);
      },
    );
  },
);

describe('MPEG-TS probe fallback and cancellation', () => {
  it.skipIf(!HAS_SIZE_LADDER)(
    'accepts the dominant-CFR size ladder with exactly one independent head and tail read',
    async () => {
      expect(sizeLadder).toHaveLength(4);
      for (const { file, bytes } of sizeLadder) {
        const subject = rangedSource(bytes);

        expect(summarizeTracks(await probe(subject.source)), file).toEqual(summarizeParsed(bytes));
        expect(subject.calls, file).toHaveLength(2);
        expect(subject.calls[0], file).toMatchObject({ start: 0 });
        expect(subject.calls[1]?.start, file).toBeGreaterThan(0);
        expect(
          subject.calls.reduce((total, call) => total + call.end - call.start, 0),
          file,
        ).toBeLessThan(bytes.byteLength);
      }
    },
  );

  it('never lets a tail codec configuration repair a head with no first configuration', async () => {
    const bytes = monotonicCopies(realTs, 8, (copy, index) =>
      index < 4 ? withoutH264Sps(copy) : copy,
    );
    expect(summarizeParsed(bytes)[0]).toMatchObject({ width: 1280, height: 720 });
    const subject = rangedSource(bytes);

    expect(summarizeTracks(await probe(subject.source))).toEqual(summarizeParsed(bytes));
    expect(subject.calls.at(-1)).toMatchObject({ start: 0, end: bytes.byteLength });
  });

  it('preserves the full stream fallback for non-ranged sources', async () => {
    let streams = 0;
    const source: ByteSource = {
      stream: () => {
        streams += 1;
        return new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(realTs);
            controller.close();
          },
        });
      },
    };

    expect(summarizeTracks(await probe(source))).toEqual(summarizeParsed(realTs));
    expect(streams).toBe(1);
  });

  it('falls back and preserves the typed malformed-input error', async () => {
    const subject = rangedSource(new Uint8Array(300_000));

    await expect(probe(subject.source)).rejects.toBeInstanceOf(InputError);
    expect(subject.calls.at(-1)).toMatchObject({ start: 0, end: 300_000 });
    expect(subject.streamCalls()).toBe(0);
  });

  it('does not splice across a decode-timestamp reset', async () => {
    const bytes = repeatBytes(realTs, 8);
    const subject = rangedSource(bytes);

    expect(summarizeTracks(await probe(subject.source))).toEqual(summarizeParsed(bytes));
    expect(subject.calls.at(-1)).toMatchObject({ start: 0, end: bytes.byteLength });
    expect(subject.calls).toHaveLength(3);
  });

  it('falls back immediately when sampled packets declare a discontinuity', async () => {
    const bytes = withDiscontinuityIndicator(monotonicCopies(realTs, 8));
    const subject = rangedSource(bytes);

    expect(summarizeTracks(await probe(subject.source))).toEqual(summarizeParsed(bytes));
    expect(subject.calls).toEqual([
      { start: 0, end: 128 * 1024, signal: undefined },
      { start: 0, end: bytes.byteLength, signal: undefined },
    ]);
  });

  it('falls back immediately on an A→B PMT stream-set change inside the sampled tail', async () => {
    const rewritten = withTailPmtStreamAddition(monotonicCopies(realTs, 8));
    const subject = rangedSource(rewritten.bytes);

    expect(summarizeTracks(await probe(subject.source))).toEqual(summarizeParsed(rewritten.bytes));
    expect(subject.calls).toEqual([
      { start: 0, end: INITIAL_SPARSE_WINDOW_BYTES, signal: undefined },
      {
        start: rewritten.tailStart,
        end: rewritten.bytes.byteLength,
        signal: undefined,
      },
      { start: 0, end: rewritten.bytes.byteLength, signal: undefined },
    ]);
  });

  it('passes the live signal to a pending range and aborts promptly', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const rangeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const source: ByteSource = {
      size: 1_000_000,
      stream: () => {
        throw new Error('aborted ranged probe must not open the stream');
      },
      range: (_start, _end, signal) => {
        observedSignal = signal;
        started();
        return new Promise<Uint8Array>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new MediaError('aborted', 'operation aborted')),
            { once: true },
          );
        });
      },
    };

    const pending = probe(source, controller.signal);
    await rangeStarted;
    controller.abort('stop');

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(observedSignal).toBe(controller.signal);
  });

  it('aborts a range transport that ignores its signal without issuing later reads', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const rangeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const source: ByteSource = {
      size: 1_000_000,
      stream: () => {
        throw new Error('aborted ranged probe must not open the stream');
      },
      range: () => {
        calls += 1;
        started();
        return new Promise<Uint8Array>(() => undefined);
      },
    };

    const pending = probe(source, controller.signal);
    await rangeStarted;
    controller.abort('stop');

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(calls).toBe(1);
  });

  it('performs no I/O for a pre-aborted probe', async () => {
    const controller = new AbortController();
    controller.abort('already stopped');
    let calls = 0;
    const source: ByteSource = {
      size: 1_000_000,
      stream: () => {
        calls += 1;
        throw new Error('pre-aborted probe must not open the stream');
      },
      range: () => {
        calls += 1;
        return Promise.resolve(new Uint8Array());
      },
    };

    await expect(probe(source, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(calls).toBe(0);
  });
});
