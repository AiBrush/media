import { describe, expect, it } from 'vitest';
import type { EncodedChunk, RawFrame } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import {
  decodeVideoWithRuntimeFallback,
  planRuntimeVideoFallback,
} from './replayable-video-decoder.ts';

interface TestChunk {
  readonly byteLength: number;
  readonly timestamp: number;
}

class TestFrame {
  closeCount = 0;

  constructor(readonly timestamp: number) {}

  close(): void {
    this.closeCount++;
    if (this.closeCount > 1) throw new Error('frame closed twice');
  }
}

function chunks(timestamps: readonly number[]): ReadableStream<EncodedChunk> {
  return new ReadableStream<EncodedChunk>({
    start(controller): void {
      for (const timestamp of timestamps) {
        controller.enqueue({ byteLength: 4, timestamp } as unknown as EncodedChunk);
      }
      controller.close();
    },
  });
}

function decoder(
  consume: number[],
  transform: (chunk: TestChunk, controller: TransformStreamDefaultController<RawFrame>) => void,
): TransformStream<EncodedChunk, VideoFrame> {
  return new TransformStream<EncodedChunk, RawFrame>({
    transform(chunk, controller): void {
      const testChunk = chunk as unknown as TestChunk;
      consume.push(testChunk.timestamp);
      transform(testChunk, controller);
    },
  }) as TransformStream<EncodedChunk, VideoFrame>;
}

async function drain(stream: ReadableStream<VideoFrame>): Promise<TestFrame[]> {
  const reader = stream.getReader();
  const frames: TestFrame[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return frames;
      frames.push(result.value as unknown as TestFrame);
    }
  } finally {
    reader.releaseLock();
  }
}

describe('planRuntimeVideoFallback', () => {
  it('keeps VPx on its proved WASM tail unless the selected native driver was pinned', () => {
    expect(planRuntimeVideoFallback('webcodecs-video', 'vp09.00.31.08')).toBe('wasm-vpx');
    expect(planRuntimeVideoFallback('webcodecs-video', 'VP8', { determinism: 'auto' })).toBe(
      'wasm-vpx',
    );
    expect(
      planRuntimeVideoFallback('webcodecs-video', 'vp09.00.31.08', {
        pinDriver: 'webcodecs-video',
      }),
    ).toBe('webcodecs-software');
    expect(planRuntimeVideoFallback('wasm-vpx', 'vp09.00.31.08')).toBeUndefined();
  });

  it('retries other native formats in software only from automatic determinism', () => {
    for (const codec of ['avc1.640028', 'hvc1.1.6.L93.B0', 'av01.0.08M.08']) {
      expect(planRuntimeVideoFallback('webcodecs-video', codec)).toBe('webcodecs-software');
      expect(
        planRuntimeVideoFallback('webcodecs-video', codec, {
          determinism: 'force-software',
        }),
      ).toBeUndefined();
    }
    expect(planRuntimeVideoFallback('wasm-av1', 'av01.0.08M.08')).toBeUndefined();
  });
});

describe('decodeVideoWithRuntimeFallback', () => {
  it('keeps a successful native path byte-for-byte ordered without loading the fallback', async () => {
    const nativePackets: number[] = [];
    let fallbackCreates = 0;
    const frames = await drain(
      decodeVideoWithRuntimeFallback(
        chunks([9, 41, 89]),
        () =>
          decoder(nativePackets, (chunk, controller) => {
            controller.enqueue(new TestFrame(chunk.timestamp) as unknown as RawFrame);
          }),
        async () => {
          fallbackCreates++;
          return decoder([], () => {});
        },
      ),
    );

    expect(nativePackets).toEqual([9, 41, 89]);
    expect(frames.map((frame) => frame.timestamp)).toEqual([9, 41, 89]);
    expect(fallbackCreates).toBe(0);
    for (const frame of frames) frame.close();
    expect(frames.map((frame) => frame.closeCount)).toEqual([1, 1, 1]);
  });

  it('replays every exact packet once through the fallback after a pre-output runtime miss', async () => {
    const primaryPackets: number[] = [];
    const fallbackPackets: number[] = [];
    let fallbackCreates = 0;

    const frames = await drain(
      decodeVideoWithRuntimeFallback(
        chunks([0, 33_333, 70_001]),
        () =>
          decoder(primaryPackets, () => {
            throw new CapabilityError('native VP9 runtime miss', {
              op: { kind: 'route', id: 'decode' },
              tried: ['webcodecs-video'],
            });
          }),
        async () => {
          fallbackCreates++;
          return decoder(fallbackPackets, (chunk, controller) => {
            controller.enqueue(new TestFrame(chunk.timestamp) as unknown as RawFrame);
          });
        },
      ),
    );

    expect(primaryPackets).toEqual([0]);
    expect(fallbackPackets).toEqual([0, 33_333, 70_001]);
    expect(fallbackCreates).toBe(1);
    expect(frames.map((frame) => frame.timestamp)).toEqual([0, 33_333, 70_001]);
    expect(frames.map((frame) => frame.closeCount)).toEqual([0, 0, 0]);
    for (const frame of frames) frame.close();
    expect(frames.map((frame) => frame.closeCount)).toEqual([1, 1, 1]);
  });

  it('replays the same immutable chunk references without a payload copy', async () => {
    const exactChunks = [
      { byteLength: 3, timestamp: 7 },
      { byteLength: 5, timestamp: 19 },
    ] as const;
    const seen: EncodedChunk[] = [];
    const source = new ReadableStream<EncodedChunk>({
      start(controller): void {
        for (const chunk of exactChunks) controller.enqueue(chunk as unknown as EncodedChunk);
        controller.close();
      },
    });

    const frames = await drain(
      decodeVideoWithRuntimeFallback(
        source,
        () =>
          decoder([], () => {
            throw new CapabilityError('native miss', {
              op: { kind: 'route', id: 'decode' },
              tried: ['native'],
            });
          }),
        async () =>
          new TransformStream<EncodedChunk, VideoFrame>({
            transform(chunk, controller): void {
              seen.push(chunk);
              controller.enqueue(
                new TestFrame((chunk as unknown as TestChunk).timestamp) as unknown as VideoFrame,
              );
            },
          }),
      ),
    );

    expect(seen[0]).toBe(exactChunks[0]);
    expect(seen[1]).toBe(exactChunks[1]);
    expect(frames.map((frame) => frame.timestamp)).toEqual([7, 19]);
    for (const frame of frames) frame.close();
  });

  it('preserves a typed capability miss across a realm or split-module class boundary', async () => {
    class ForeignCapabilityError extends Error {
      readonly code = 'capability-miss';

      constructor() {
        super('foreign typed runtime miss');
        this.name = 'CapabilityError';
      }
    }
    let fallbackCreates = 0;

    const frames = await drain(
      decodeVideoWithRuntimeFallback(
        chunks([123]),
        () =>
          decoder([], () => {
            throw new ForeignCapabilityError();
          }),
        async () => {
          fallbackCreates++;
          return decoder([], (chunk, controller) => {
            controller.enqueue(new TestFrame(chunk.timestamp) as unknown as RawFrame);
          });
        },
      ),
    );

    expect(fallbackCreates).toBe(1);
    expect(frames.map((frame) => frame.timestamp)).toEqual([123]);
    for (const frame of frames) frame.close();
  });

  it('commits on the first native frame and never duplicates earlier output after a later miss', async () => {
    let fallbackCreates = 0;
    const reader = decodeVideoWithRuntimeFallback(
      chunks([10, 20]),
      () =>
        decoder([], (chunk, controller) => {
          if (chunk.timestamp === 20) {
            throw new CapabilityError('late native failure', {
              op: { kind: 'route', id: 'decode' },
              tried: ['webcodecs-video'],
            });
          }
          controller.enqueue(new TestFrame(chunk.timestamp) as unknown as RawFrame);
        }),
      async () => {
        fallbackCreates++;
        return decoder([], () => {});
      },
    ).getReader();

    const first = await reader.read();
    if (first.done) throw new Error('expected first native frame');
    expect((first.value as unknown as TestFrame).timestamp).toBe(10);
    first.value.close();
    await expect(reader.read()).rejects.toMatchObject({ code: 'capability-miss' });
    expect(fallbackCreates).toBe(0);
  });

  it('propagates the typed fallback miss when the WASM tail is absent', async () => {
    const fallbackMiss = new CapabilityError('WASM VP9 unavailable', {
      op: { kind: 'route', id: 'decode' },
      tried: ['wasm-vpx'],
    });
    const reader = decodeVideoWithRuntimeFallback(
      chunks([0]),
      () =>
        decoder([], () => {
          throw new CapabilityError('native miss', {
            op: { kind: 'route', id: 'decode' },
            tried: ['native'],
          });
        }),
      () => Promise.reject(fallbackMiss),
    ).getReader();

    await expect(reader.read()).rejects.toBe(fallbackMiss);
  });

  it('does not reinterpret decode errors as capability misses', async () => {
    let fallbackCreates = 0;
    const reader = decodeVideoWithRuntimeFallback(
      chunks([0]),
      () =>
        decoder([], () => {
          throw new Error('corrupt packet');
        }),
      async () => {
        fallbackCreates++;
        return decoder([], () => {});
      },
    ).getReader();

    await expect(reader.read()).rejects.toThrow('corrupt packet');
    expect(fallbackCreates).toBe(0);
  });

  it('rejects a plain object that spoofs capability error fields', async () => {
    let fallbackCreates = 0;
    const spoof = { name: 'CapabilityError', code: 'capability-miss' };
    const reader = decodeVideoWithRuntimeFallback(
      chunks([0]),
      () =>
        decoder([], () => {
          throw spoof;
        }),
      async () => {
        fallbackCreates++;
        return decoder([], () => {});
      },
    ).getReader();

    await expect(reader.read()).rejects.toBe(spoof);
    expect(fallbackCreates).toBe(0);
  });

  it('bounds replay retention and keeps a later native miss terminal', async () => {
    let fallbackCreates = 0;
    const timestamps = Array.from({ length: 258 }, (_, index) => index);
    const reader = decodeVideoWithRuntimeFallback(
      chunks(timestamps),
      () =>
        decoder([], (chunk) => {
          if (chunk.timestamp === 257) {
            throw new CapabilityError('native failed after replay bound', {
              op: { kind: 'route', id: 'decode' },
              tried: ['native'],
            });
          }
        }),
      async () => {
        fallbackCreates++;
        return decoder([], () => {});
      },
    ).getReader();

    await expect(reader.read()).rejects.toMatchObject({ code: 'capability-miss' });
    expect(fallbackCreates).toBe(0);
  });

  it('commits native when retained payload exceeds 16 MiB', async () => {
    let fallbackCreates = 0;
    const oversized = [
      { byteLength: 16 * 1024 * 1024, timestamp: 0 },
      { byteLength: 1, timestamp: 1 },
      { byteLength: 1, timestamp: 2 },
    ];
    const source = new ReadableStream<EncodedChunk>({
      start(controller): void {
        for (const chunk of oversized) controller.enqueue(chunk as unknown as EncodedChunk);
        controller.close();
      },
    });
    const reader = decodeVideoWithRuntimeFallback(
      source,
      () =>
        decoder([], (chunk) => {
          if (chunk.timestamp === 2) {
            throw new CapabilityError('native failed after byte bound', {
              op: { kind: 'route', id: 'decode' },
              tried: ['native'],
            });
          }
        }),
      async () => {
        fallbackCreates++;
        return decoder([], () => {});
      },
    ).getReader();

    await expect(reader.read()).rejects.toMatchObject({ code: 'capability-miss' });
    expect(fallbackCreates).toBe(0);
  });

  it('aborts both the decoder and its sole live source reader', async () => {
    const abort = new AbortController();
    let sourceCancelled = 0;
    let sent = false;
    const source = new ReadableStream<EncodedChunk>(
      {
        pull(controller): void {
          if (sent) return;
          sent = true;
          controller.enqueue({ byteLength: 4, timestamp: 0 } as unknown as EncodedChunk);
        },
        cancel(): void {
          sourceCancelled++;
        },
      },
      { highWaterMark: 0 },
    );
    const reader = decodeVideoWithRuntimeFallback(
      source,
      () => decoder([], () => {}),
      async () => decoder([], () => {}),
      { signal: abort.signal },
    ).getReader();
    const pending = reader.read();

    await Promise.resolve();
    abort.abort('test abort');

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    await Promise.resolve();
    expect(sourceCancelled).toBe(1);
  });
});
