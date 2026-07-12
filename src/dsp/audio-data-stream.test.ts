import { describe, expect, it } from 'vitest';
import { CapabilityError } from '../contracts/errors.ts';
import {
  interleavedPcmChunksToAudioDataStream,
  pcmAudioChunksToAudioDataStream,
  pcmAudioToAudioDataStream,
  pcmRangeToInterleavedInit,
  pcmRangeToPlanarInit,
  pcmToInterleavedInit,
} from './audio-data.ts';
import type { InterleavedPcmF32, PcmAudio } from './pcm.ts';

class TestAudioData {
  static readonly instances: TestAudioData[] = [];

  readonly init: AudioDataInit;
  closeCount = 0;

  constructor(init: AudioDataInit) {
    this.init = init;
    TestAudioData.instances.push(this);
  }

  close(): void {
    this.closeCount++;
  }
}

function pcm(frames: number): PcmAudio {
  return {
    sampleRate: 48_000,
    channels: 2,
    frames,
    planar: [new Float64Array(frames).fill(0.25), new Float64Array(frames).fill(-0.25)],
  };
}

async function withAudioData<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioData');
  TestAudioData.instances.length = 0;
  Object.defineProperty(globalThis, 'AudioData', {
    configurable: true,
    value: TestAudioData as unknown as typeof AudioData,
  });
  try {
    return await fn();
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'AudioData');
    else Object.defineProperty(globalThis, 'AudioData', original);
  }
}

describe('pcmAudioToAudioDataStream', () => {
  it('can emit interleaved f32 for sample consumers without changing canonical PCM', async () => {
    await withAudioData(async () => {
      const reader = pcmAudioToAudioDataStream(pcm(2), {}, 'pcm-s24', 'f32').getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      const frame = first.value as unknown as TestAudioData;
      expect(frame.init).toMatchObject({ format: 'f32', numberOfFrames: 2 });
      expect(Array.from(new Float32Array(frame.init.data as ArrayBuffer))).toEqual([
        0.25, -0.25, 0.25, -0.25,
      ]);
      frame.close();
      await reader.cancel('format coverage');
    });
  });

  it('emits bounded, timestamped planar frames and leaves successful outputs consumer-owned', async () => {
    await withAudioData(async () => {
      const reader = pcmAudioToAudioDataStream(pcm(4100), {}, 'pcm-s16').getReader();
      const first = await reader.read();
      const second = await reader.read();
      const end = await reader.read();

      expect(first.done).toBe(false);
      expect(second.done).toBe(false);
      expect(end.done).toBe(true);
      const firstFrame = first.value as unknown as TestAudioData;
      const secondFrame = second.value as unknown as TestAudioData;
      expect(firstFrame.init).toMatchObject({
        format: 'f32-planar',
        numberOfChannels: 2,
        numberOfFrames: 4096,
        sampleRate: 48_000,
        timestamp: 0,
      });
      expect(secondFrame.init).toMatchObject({ numberOfFrames: 4, timestamp: 85_333 });
      expect(firstFrame.closeCount).toBe(0);
      expect(secondFrame.closeCount).toBe(0);
      firstFrame.close();
      secondFrame.close();
      expect(TestAudioData.instances.map((frame) => frame.closeCount)).toEqual([1, 1]);
    });
  });

  it('constructs no frame after cancellation or a pre-aborted signal', async () => {
    await withAudioData(async () => {
      const cancelled = pcmAudioToAudioDataStream(pcm(8), {}, 'pcm-s16');
      await cancelled.cancel('unused');
      expect(TestAudioData.instances).toHaveLength(0);

      const controller = new AbortController();
      controller.abort('stop');
      const reader = pcmAudioToAudioDataStream(
        pcm(8),
        { signal: controller.signal },
        'pcm-s16',
      ).getReader();
      await expect(reader.read()).rejects.toMatchObject({ code: 'aborted' });
      expect(TestAudioData.instances).toHaveLength(0);
    });
  });

  it('rejects a missing browser capability before creating a stream', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioData');
    Reflect.deleteProperty(globalThis, 'AudioData');
    try {
      expect(() => pcmAudioToAudioDataStream(pcm(8), {}, 'pcm-s24')).toThrowError(CapabilityError);
      expect(() => pcmAudioToAudioDataStream(pcm(8), {}, 'pcm-s24')).toThrow(
        /AudioData missing for PCM decode/,
      );
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'AudioData', original);
    }
  });

  it('wraps native construction failures in a typed decode error', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioData');
    Object.defineProperty(globalThis, 'AudioData', {
      configurable: true,
      value: class ThrowingAudioData {
        constructor() {
          throw new TypeError('native constructor rejected data');
        }
      } as unknown as typeof AudioData,
    });
    try {
      const reader = pcmAudioToAudioDataStream(pcm(8), {}, 'pcm-s16').getReader();
      await expect(reader.read()).rejects.toMatchObject({
        code: 'decode-error',
        message: expect.stringContaining('native constructor rejected data'),
      });
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'AudioData');
      else Object.defineProperty(globalThis, 'AudioData', original);
    }
  });

  it('wraps lazy PCM chunks with continuous timestamps and cancels the upstream reader', async () => {
    await withAudioData(async () => {
      let cancelled = false;
      const chunks = new ReadableStream<PcmAudio>({
        start(controller): void {
          controller.enqueue(pcm(2));
          controller.enqueue(pcm(1));
          controller.close();
        },
        cancel(): void {
          cancelled = true;
        },
      });
      const reader = pcmAudioChunksToAudioDataStream(chunks, {}, 'pcm-s24').getReader();
      const first = await reader.read();
      const second = await reader.read();
      const end = await reader.read();

      expect(first.done).toBe(false);
      expect(second.done).toBe(false);
      expect(end.done).toBe(true);
      const firstFrame = first.value as unknown as TestAudioData;
      const secondFrame = second.value as unknown as TestAudioData;
      expect(firstFrame.init).toMatchObject({ numberOfFrames: 2, timestamp: 0 });
      expect(secondFrame.init).toMatchObject({ numberOfFrames: 1, timestamp: 42 });
      firstFrame.close();
      secondFrame.close();
      expect(TestAudioData.instances.map((frame) => frame.closeCount)).toEqual([1, 1]);
      await reader.cancel('done');
      expect(cancelled).toBe(false);
    });
  });

  it('propagates consumer cancellation to an open PCM chunk stream', async () => {
    await withAudioData(async () => {
      let cancelled = false;
      const chunks = new ReadableStream<PcmAudio>({
        pull(controller): void {
          controller.enqueue(pcm(2));
        },
        cancel(): void {
          cancelled = true;
        },
      });
      const reader = pcmAudioChunksToAudioDataStream(chunks, {}, 'pcm-s24').getReader();
      const first = await reader.read();
      const frame = first.value as unknown as TestAudioData;
      await reader.cancel('consumer stopped');
      frame.close();
      expect(cancelled).toBe(true);
      expect(frame.closeCount).toBe(1);
    });
  });
});

describe('interleavedPcmChunksToAudioDataStream', () => {
  function interleaved(frames = 2): InterleavedPcmF32 {
    return {
      sampleRate: 48_000,
      channels: 2,
      frames,
      data: new Float32Array(new ArrayBuffer(frames * 2 * 4)).fill(0.125),
    };
  }

  it('declares exact buffer transfer and leaves successful frames consumer-owned', async () => {
    await withAudioData(async () => {
      const chunk = interleaved();
      const chunks = new ReadableStream<InterleavedPcmF32>({
        start(controller): void {
          controller.enqueue(chunk);
          controller.close();
        },
      });
      const reader = interleavedPcmChunksToAudioDataStream(chunks, {}, 'pcm-s24').getReader();
      const next = await reader.read();
      expect(next.done).toBe(false);
      const frame = next.value as unknown as TestAudioData;
      expect(frame.init).toMatchObject({
        format: 'f32',
        numberOfChannels: 2,
        numberOfFrames: 2,
        sampleRate: 48_000,
        timestamp: 0,
        data: chunk.data.buffer,
        transfer: [chunk.data.buffer],
      });
      expect(frame.closeCount).toBe(0);
      frame.close();
      expect(frame.closeCount).toBe(1);
      expect((await reader.read()).done).toBe(true);
      expect(chunks.locked).toBe(false);
    });
  });

  it('cancels and unlocks upstream when native construction fails', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioData');
    let cancelled = false;
    const chunks = new ReadableStream<InterleavedPcmF32>({
      pull(controller): void {
        controller.enqueue(interleaved());
      },
      cancel(): void {
        cancelled = true;
      },
    });
    Object.defineProperty(globalThis, 'AudioData', {
      configurable: true,
      value: class ThrowingAudioData {
        constructor() {
          throw new TypeError('native transfer rejected data');
        }
      } as unknown as typeof AudioData,
    });
    try {
      const reader = interleavedPcmChunksToAudioDataStream(chunks, {}, 'pcm-s24').getReader();
      await expect(reader.read()).rejects.toMatchObject({
        code: 'decode-error',
        message: expect.stringContaining('native transfer rejected data'),
      });
      expect(cancelled).toBe(true);
      expect(chunks.locked).toBe(false);
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'AudioData');
      else Object.defineProperty(globalThis, 'AudioData', original);
    }
  });

  it('closes a constructed frame exactly once when downstream closes during construction', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioData');
    let outputReader: ReadableStreamDefaultReader<AudioData> | undefined;
    let upstreamCancelled = 0;
    const instances: Array<{ closeCount: number }> = [];
    class ReentrantCancelAudioData {
      closeCount = 0;

      constructor(_init: AudioDataInit) {
        instances.push(this);
        void outputReader?.cancel('closed during native construction');
      }

      close(): void {
        this.closeCount++;
      }
    }
    const chunks = new ReadableStream<InterleavedPcmF32>({
      start(controller): void {
        controller.enqueue(interleaved());
      },
      cancel(): void {
        upstreamCancelled++;
      },
    });
    Object.defineProperty(globalThis, 'AudioData', {
      configurable: true,
      value: ReentrantCancelAudioData as unknown as typeof AudioData,
    });
    try {
      outputReader = interleavedPcmChunksToAudioDataStream(chunks, {}, 'pcm-s24').getReader();
      await expect(outputReader.read()).resolves.toMatchObject({ done: true });
      expect(instances).toHaveLength(1);
      expect(instances[0]?.closeCount).toBe(1);
      expect(upstreamCancelled).toBe(1);
      expect(chunks.locked).toBe(false);
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'AudioData');
      else Object.defineProperty(globalThis, 'AudioData', original);
    }
  });

  it('propagates consumer cancellation and rejects non-owned chunk views', async () => {
    await withAudioData(async () => {
      let cancelled = 0;
      const openChunks = new ReadableStream<InterleavedPcmF32>({
        pull(controller): void {
          controller.enqueue(interleaved());
        },
        cancel(): void {
          cancelled++;
        },
      });
      const reader = interleavedPcmChunksToAudioDataStream(openChunks, {}, 'pcm-s24').getReader();
      const first = await reader.read();
      const frame = first.value as unknown as TestAudioData;
      await reader.cancel('consumer stopped');
      frame.close();
      expect(cancelled).toBe(1);
      expect(openChunks.locked).toBe(false);

      const backing = new Float32Array(8);
      const invalid: InterleavedPcmF32 = {
        sampleRate: 48_000,
        channels: 2,
        frames: 2,
        data: backing.subarray(2, 6) as Float32Array<ArrayBuffer>,
      };
      const malformedChunks = new ReadableStream<InterleavedPcmF32>({
        start(controller): void {
          controller.enqueue(invalid);
        },
      });
      const malformed = interleavedPcmChunksToAudioDataStream(
        malformedChunks,
        {},
        'pcm-s24',
      ).getReader();
      await expect(malformed.read()).rejects.toMatchObject({ code: 'decode-error' });
      expect(malformedChunks.locked).toBe(false);
    });
  });

  it('keeps abort typed when an upstream cancellation hook also fails', async () => {
    await withAudioData(async () => {
      const chunks = new ReadableStream<InterleavedPcmF32>({
        pull(controller): void {
          controller.enqueue(interleaved());
        },
        cancel(): void {
          throw new Error('upstream cancellation failed');
        },
      });
      const abort = new AbortController();
      abort.abort('stop');
      const reader = interleavedPcmChunksToAudioDataStream(
        chunks,
        { signal: abort.signal },
        'pcm-s24',
      ).getReader();
      await expect(reader.read()).rejects.toMatchObject({ code: 'aborted' });
      expect(chunks.locked).toBe(false);
      expect(TestAudioData.instances).toHaveLength(0);
    });
  });
});

describe('pcmToInterleavedInit', () => {
  it('preserves channel-major samples in interleaved f32 order', () => {
    const out = pcmToInterleavedInit(pcm(2), 123);
    expect(out.init).toMatchObject({ format: 'f32', timestamp: 123 });
    expect(Array.from(out.data)).toEqual([0.25, -0.25, 0.25, -0.25]);
  });

  it('clamps non-finite and past-end range starts without reading outside channel storage', () => {
    const audio = pcm(3);
    const fromStart = pcmRangeToPlanarInit(audio, Number.NaN, 2, 10);
    expect(fromStart.init).toMatchObject({ numberOfFrames: 2, timestamp: 10 });
    expect(Array.from(fromStart.data)).toEqual([0.25, 0.25, -0.25, -0.25]);

    const atEnd = pcmRangeToInterleavedInit(audio, audio.frames, 4, 20);
    const pastEnd = pcmRangeToPlanarInit(audio, audio.frames + 100, 4, 30);
    expect(atEnd.init).toMatchObject({ numberOfFrames: 0, timestamp: 20 });
    expect(pastEnd.init).toMatchObject({ numberOfFrames: 0, timestamp: 30 });
    expect(atEnd.data).toHaveLength(0);
    expect(pastEnd.data).toHaveLength(0);
  });
});
