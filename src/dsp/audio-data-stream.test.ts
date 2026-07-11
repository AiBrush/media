import { describe, expect, it } from 'vitest';
import { CapabilityError } from '../contracts/errors.ts';
import { pcmAudioToAudioDataStream } from './audio-data.ts';
import type { PcmAudio } from './pcm.ts';

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
});
