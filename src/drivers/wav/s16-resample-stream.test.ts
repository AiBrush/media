import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { writeWavHeader } from './pcm.ts';
import { tryResampleWavS16ToS16Wav, tryStreamResampleWavS16ToS16Wav } from './s16-resample.ts';
import { WavDriver } from './wav-driver.ts';

const HEADER_BYTES = 44;
const STREAM_ROUTE_MIN_BYTES = 8 * 1024 * 1024;
const OUTPUT_WINDOW_BYTES = 2 * 1024 * 1024;

function patternedS16Wav(frames: number, channels: number, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + frames * channels * 2);
  writeWavHeader(bytes, bytes.byteLength - HEADER_BYTES, channels, sampleRate, 's16');
  const samples = new Int16Array(bytes.buffer, HEADER_BYTES, frames * channels);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = ((index * 7919 + Math.floor(index / channels) * 1237) & 0xffff) - 32768;
  }
  return bytes;
}

function withLeadingJunk(bytes: Uint8Array, junkBytes: number): Uint8Array {
  if ((junkBytes & 1) !== 0) throw new Error('JUNK test payload must preserve RIFF word alignment');
  const output = new Uint8Array(bytes.byteLength + 8 + junkBytes);
  output.set(bytes.subarray(0, 12), 0);
  output.set(Uint8Array.of(0x4a, 0x55, 0x4e, 0x4b), 12);
  new DataView(output.buffer).setUint32(16, junkBytes, true);
  output.set(bytes.subarray(12), 20 + junkBytes);
  new DataView(output.buffer).setUint32(4, output.byteLength - 8, true);
  return output;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      byteLength += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function rangedSource(
  bytes: Uint8Array,
  onRange?: (start: number, end: number, signal: AbortSignal | undefined) => void,
): ByteSource {
  return {
    size: bytes.byteLength,
    stream: () => {
      throw new Error('seekable resample must not open the whole source stream');
    },
    range: (start, end, signal) => {
      onRange?.(start, end, signal);
      return Promise.resolve(bytes.slice(start, end));
    },
  };
}

describe('bounded WAV s16 range resample', () => {
  it.each([
    { channels: 1, sourceRate: 44_100, targetRate: 16_000, frames: 650_001 },
    { channels: 2, sourceRate: 44_100, targetRate: 48_000, frames: 270_001 },
    { channels: 3, sourceRate: 48_000, targetRate: 44_100, frames: 100_001 },
    { channels: 1, sourceRate: 48_000, targetRate: 16_000, frames: 1 },
    { channels: 2, sourceRate: 48_000, targetRate: 44_100, frames: 17 },
  ])(
    'is byte-exact across windows for $channels ch $sourceRate→$targetRate at $frames frames',
    async ({ channels, sourceRate, targetRate, frames }) => {
      const input = patternedS16Wav(frames, channels, sourceRate);
      const expected = tryResampleWavS16ToS16Wav(input, { sampleRate: targetRate });
      const stream = await tryStreamResampleWavS16ToS16Wav(rangedSource(input), {
        sampleRate: targetRate,
      });
      expect(expected).toBeDefined();
      expect(stream).toBeDefined();
      if (expected === undefined || stream === undefined) throw new Error('expected direct paths');
      expect(await drain(stream)).toEqual(expected);
    },
  );

  it('pulls one bounded source window at a time without read-ahead', async () => {
    const input = patternedS16Wav(2_000_000, 2, 44_100);
    const ranges: Array<readonly [number, number]> = [];
    let active = 0;
    let maximumActive = 0;
    const source: ByteSource = {
      size: input.byteLength,
      stream: () => {
        throw new Error('bounded range path must not stream the whole input');
      },
      range: async (start, end) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        ranges.push([start, end]);
        await Promise.resolve();
        const value = input.slice(start, end);
        active--;
        return value;
      },
    };
    const stream = await tryStreamResampleWavS16ToS16Wav(source, { sampleRate: 16_000 });
    if (stream === undefined) throw new Error('expected range resample stream');
    expect(ranges).toHaveLength(1);

    const reader = stream.getReader();
    expect((await reader.read()).value?.byteLength).toBe(HEADER_BYTES);
    expect(ranges).toHaveLength(1);
    expect((await reader.read()).value?.byteLength).toBe(OUTPUT_WINDOW_BYTES);
    expect(ranges).toHaveLength(2);
    expect((await reader.read()).value?.byteLength).toBeLessThan(1024 * 1024);
    expect(ranges).toHaveLength(3);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();

    expect(maximumActive).toBe(1);
    expect(Math.max(...ranges.map(([start, end]) => end - start))).toBeLessThan(6 * 1024 * 1024);
    expect(ranges).toHaveLength(3);
  });

  it('cancels before the first PCM pull without issuing a data range', async () => {
    const input = patternedS16Wav(1_000_000, 2, 44_100);
    const ranges: Array<readonly [number, number]> = [];
    const stream = await tryStreamResampleWavS16ToS16Wav(
      rangedSource(input, (start, end) => ranges.push([start, end])),
      { sampleRate: 16_000 },
    );
    if (stream === undefined) throw new Error('expected range resample stream');
    const reader = stream.getReader();
    expect((await reader.read()).value?.byteLength).toBe(HEADER_BYTES);
    await reader.cancel('consumer stopped after metadata');
    reader.releaseLock();
    expect(ranges).toHaveLength(1);
  });

  it('cancels a pending PCM range through its source signal', async () => {
    const input = patternedS16Wav(600_000, 2, 44_100);
    let rangeCalls = 0;
    let pendingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pendingStarted = resolve;
    });
    let observedRangeCancel = false;
    const source: ByteSource = {
      size: input.byteLength,
      stream: () => {
        throw new Error('range-backed stream must not open the source stream');
      },
      range: (start, end, signal) => {
        rangeCalls++;
        if (rangeCalls === 1) return Promise.resolve(input.slice(start, end));
        pendingStarted();
        return new Promise<Uint8Array>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              observedRangeCancel = true;
              reject(new MediaError('aborted', 'source range cancelled'));
            },
            { once: true },
          );
        });
      },
    };
    const stream = await tryStreamResampleWavS16ToS16Wav(source, { sampleRate: 16_000 });
    if (stream === undefined) throw new Error('expected range resample stream');
    const reader = stream.getReader();
    await reader.read();
    const pending = reader.read();
    await started;
    const cancelled = reader.cancel('consumer stopped during source I/O');
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await cancelled;
    expect(observedRangeCancel).toBe(true);
    reader.releaseLock();
  });

  it('forwards live abort to a pending range and reports a typed aborted error', async () => {
    const input = patternedS16Wav(600_000, 2, 44_100);
    const abort = new AbortController();
    let rangeCalls = 0;
    let pendingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pendingStarted = resolve;
    });
    let observedRangeAbort = false;
    const source: ByteSource = {
      size: input.byteLength,
      stream: () => {
        throw new Error('range-backed stream must not open the source stream');
      },
      range: (start, end, signal) => {
        rangeCalls++;
        if (rangeCalls === 1) return Promise.resolve(input.slice(start, end));
        pendingStarted();
        return new Promise<Uint8Array>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              observedRangeAbort = true;
              reject(new MediaError('aborted', 'source range aborted'));
            },
            { once: true },
          );
        });
      },
    };
    const stream = await tryStreamResampleWavS16ToS16Wav(source, {
      sampleRate: 16_000,
      signal: abort.signal,
    });
    if (stream === undefined) throw new Error('expected range resample stream');
    const reader = stream.getReader();
    await reader.read();
    const pending = reader.read();
    await started;
    abort.abort('stop pending source I/O');
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(observedRangeAbort).toBe(true);
    reader.releaseLock();
  });

  it('accepts an unaligned range view without changing bytes', async () => {
    const input = patternedS16Wav(300_001, 2, 48_000);
    const expected = tryResampleWavS16ToS16Wav(input, { sampleRate: 44_100 });
    const source: ByteSource = {
      size: input.byteLength,
      stream: () => {
        throw new Error('unaligned range source must remain seekable');
      },
      range: (start, end) => {
        const backing = new Uint8Array(end - start + 1);
        backing.set(input.subarray(start, end), 1);
        return Promise.resolve(backing.subarray(1));
      },
    };
    const stream = await tryStreamResampleWavS16ToS16Wav(source, { sampleRate: 44_100 });
    expect(expected).toBeDefined();
    expect(stream).toBeDefined();
    if (expected === undefined || stream === undefined) throw new Error('expected direct paths');
    expect(await drain(stream)).toEqual(expected);
  });

  it('errors on a contract-violating short PCM range and declines an invalid prefix', async () => {
    const input = patternedS16Wav(300_001, 2, 48_000);
    let calls = 0;
    const shortSource: ByteSource = {
      size: input.byteLength,
      stream: () => {
        throw new Error('short range test must remain on the range path');
      },
      range: (start, end) => {
        calls++;
        return Promise.resolve(input.slice(start, calls === 1 ? end : end - 2));
      },
    };
    const stream = await tryStreamResampleWavS16ToS16Wav(shortSource, { sampleRate: 44_100 });
    if (stream === undefined) throw new Error('expected range resample stream');
    const reader = stream.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toMatchObject({ code: 'demux-error' });
    reader.releaseLock();

    const invalid = Uint8Array.from({ length: 128 }, (_, index) => index);
    await expect(
      tryStreamResampleWavS16ToS16Wav(rangedSource(invalid), { sampleRate: 16_000 }),
    ).resolves.toBeUndefined();
  });

  it('keeps small transforms on the contiguous fast path', async () => {
    const input = patternedS16Wav(100_001, 2, 44_100);
    const ranges: Array<readonly [number, number]> = [];
    const transform = WavDriver.transformPcm;
    if (transform === undefined) throw new Error('WAV transform must exist');
    const output = await transform.call(
      WavDriver,
      rangedSource(input, (start, end) => ranges.push([start, end])),
      { sampleRate: 16_000 },
    );
    const expected = tryResampleWavS16ToS16Wav(input, { sampleRate: 16_000 });
    expect(expected).toBeDefined();
    expect(await drain(output)).toEqual(expected);
    expect(ranges).toEqual([[0, input.byteLength]]);
  });

  it('routes a large seekable transform before any whole-file read', async () => {
    const frames = Math.ceil((STREAM_ROUTE_MIN_BYTES - HEADER_BYTES) / 2) + 1;
    const input = patternedS16Wav(frames, 1, 44_100);
    const ranges: Array<readonly [number, number]> = [];
    const transform = WavDriver.transformPcm;
    if (transform === undefined) throw new Error('WAV transform must exist');
    const output = await transform.call(
      WavDriver,
      rangedSource(input, (start, end) => ranges.push([start, end])),
      { sampleRate: 16_000 },
    );
    expect(ranges).toEqual([[0, 64 * 1024]]);
    const reader = output.getReader();
    expect((await reader.read()).value?.byteLength).toBe(HEADER_BYTES);
    expect(ranges).toHaveLength(1);
    expect((await reader.read()).value?.byteLength).toBe(OUTPUT_WINDOW_BYTES);
    expect(ranges).toHaveLength(2);
    const dataRange = ranges[1];
    if (dataRange === undefined) throw new Error('large route did not issue a PCM range');
    expect(dataRange[1] - dataRange[0]).toBeLessThan(6 * 1024 * 1024);
    await reader.cancel();
    reader.releaseLock();
  });

  it('fully drains the large driver route byte-for-byte against the contiguous oracle', async () => {
    const frames = Math.ceil((STREAM_ROUTE_MIN_BYTES - HEADER_BYTES) / 2) + 137;
    const input = patternedS16Wav(frames, 1, 44_100);
    const expected = tryResampleWavS16ToS16Wav(input, { sampleRate: 16_000 });
    const transform = WavDriver.transformPcm;
    if (expected === undefined || transform === undefined)
      throw new Error('expected WAV fast paths');
    const output = await transform.call(WavDriver, rangedSource(input), { sampleRate: 16_000 });
    expect(await drain(output)).toEqual(expected);
  });

  it('falls back byte-exactly when a valid data header lies beyond the speculative prefix', async () => {
    const frames = Math.ceil((STREAM_ROUTE_MIN_BYTES - HEADER_BYTES) / 2) + 137;
    const input = withLeadingJunk(patternedS16Wav(frames, 1, 44_100), 70 * 1024);
    const expected = tryResampleWavS16ToS16Wav(input, { sampleRate: 16_000 });
    const ranges: Array<readonly [number, number]> = [];
    const transform = WavDriver.transformPcm;
    if (expected === undefined || transform === undefined)
      throw new Error('expected WAV fast paths');
    const output = await transform.call(
      WavDriver,
      rangedSource(input, (start, end) => ranges.push([start, end])),
      { sampleRate: 16_000 },
    );
    expect(await drain(output)).toEqual(expected);
    expect(ranges).toEqual([
      [0, 64 * 1024],
      [0, input.byteLength],
    ]);
  });
});
