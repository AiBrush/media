import { describe, expect, it } from 'vitest';
import { type AudioSampleFrameForTrim, trimAudioGaplessFrameStream } from './trim-streams.ts';

class FakeAudioFrame implements AudioSampleFrameForTrim {
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly duration: number | null,
    readonly numberOfFrames: number,
    readonly sampleRate: number,
    readonly label: string,
  ) {}

  close(): void {
    this.closeCount++;
  }
}

function fakeAudioStream(frames: readonly FakeAudioFrame[]): {
  readonly stream: ReadableStream<FakeAudioFrame>;
  readonly canceled: () => boolean;
} {
  let index = 0;
  let canceled = false;
  return {
    stream: new ReadableStream<FakeAudioFrame>({
      pull(controller): void {
        const frame = frames[index];
        index++;
        if (frame === undefined) controller.close();
        else controller.enqueue(frame);
      },
      cancel(): void {
        canceled = true;
      },
    }),
    canceled: () => canceled,
  };
}

async function collect(stream: ReadableStream<FakeAudioFrame>): Promise<FakeAudioFrame[]> {
  const reader = stream.getReader();
  const out: FakeAudioFrame[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

function restampFakeAudioRange(
  frame: FakeAudioFrame,
  startFrame: number,
  frameCount: number,
  timestamp: number,
): FakeAudioFrame {
  if (startFrame === 0 && frameCount === frame.numberOfFrames && timestamp === frame.timestamp) {
    return frame;
  }
  const duration = Math.round((frameCount / frame.sampleRate) * 1_000_000);
  return new FakeAudioFrame(
    timestamp,
    duration,
    frameCount,
    frame.sampleRate,
    `${frame.label}:${startFrame}+${frameCount}`,
  );
}

describe('Session 6 R2 AAC gapless sample-window trimming', () => {
  it('drops priming, trims trailing padding by samples, rebases timestamps, and closes replaced frames', async () => {
    const input = [
      new FakeAudioFrame(0, 21_333, 1024, 48_000, 'f0'),
      new FakeAudioFrame(21_333, 21_333, 1024, 48_000, 'f1'),
      new FakeAudioFrame(42_667, 21_333, 1024, 48_000, 'f2'),
      new FakeAudioFrame(64_000, 21_333, 1024, 48_000, 'padding'),
    ];
    const source = fakeAudioStream(input);

    const out = await collect(
      trimAudioGaplessFrameStream(
        source.stream,
        { leadingSamples: 512, totalSamples: 2048 },
        restampFakeAudioRange,
      ),
    );

    expect(out.map((frame) => [frame.label, frame.timestamp, frame.numberOfFrames])).toEqual([
      ['f0:512+512', 0, 512],
      ['f1:0+1024', 10_667, 1024],
      ['f2:0+512', 32_000, 512],
    ]);
    expect(input.map((frame) => frame.closeCount)).toEqual([1, 1, 1, 0]);
    expect(source.canceled()).toBe(true);

    for (const frame of out) frame.close();
    expect(out.map((frame) => frame.closeCount)).toEqual([1, 1, 1]);
  });

  it('closes whole priming frames before slicing the first program samples', async () => {
    const input = [
      new FakeAudioFrame(0, 21_333, 1024, 48_000, 'priming'),
      new FakeAudioFrame(21_333, 21_333, 1024, 48_000, 'program'),
      new FakeAudioFrame(42_667, 21_333, 1024, 48_000, 'unused'),
    ];
    const source = fakeAudioStream(input);

    const out = await collect(
      trimAudioGaplessFrameStream(
        source.stream,
        { leadingSamples: 1500, totalSamples: 500 },
        restampFakeAudioRange,
      ),
    );

    expect(out.map((frame) => [frame.label, frame.timestamp, frame.numberOfFrames])).toEqual([
      ['program:476+500', 0, 500],
    ]);
    expect(input.map((frame) => frame.closeCount)).toEqual([1, 1, 0]);
    expect(source.canceled()).toBe(true);

    out[0]?.close();
    expect(out[0]?.closeCount).toBe(1);
  });
});
