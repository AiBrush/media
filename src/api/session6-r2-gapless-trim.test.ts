import { describe, expect, it } from 'vitest';
import { MediaError } from '../contracts/errors.ts';
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
  it('returns the original frame stream when no gapless windowing is needed', async () => {
    const input = [new FakeAudioFrame(0, 21_333, 1024, 48_000, 'program')];
    const source = fakeAudioStream(input);

    const outStream = trimAudioGaplessFrameStream(
      source.stream,
      { leadingSamples: 0 },
      restampFakeAudioRange,
    );
    const out = await collect(outStream);

    expect(out).toEqual(input);
    expect(source.canceled()).toBe(false);
    expect(input.map((frame) => frame.closeCount)).toEqual([0]);
  });

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

  it('does not prefetch an AudioData handle before downstream demand', async () => {
    let pulls = 0;
    const input = [new FakeAudioFrame(0, 21_333, 1024, 48_000, 'program')];
    const source = new ReadableStream<FakeAudioFrame>(
      {
        pull(controller): void {
          pulls++;
          const frame = input.shift();
          if (frame === undefined) controller.close();
          else controller.enqueue(frame);
        },
      },
      { highWaterMark: 0 },
    );

    const trimmed = trimAudioGaplessFrameStream(
      source,
      { leadingSamples: 0, totalSamples: 1024 },
      restampFakeAudioRange,
    );
    await Promise.resolve();

    expect(pulls).toBe(0);

    const reader = trimmed.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(pulls).toBe(1);
    first.value?.close();
    await reader.cancel();
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

  it('closes and cancels immediately when the gapless content window is empty', async () => {
    const input = [new FakeAudioFrame(0, 21_333, 1024, 48_000, 'padding')];
    const source = fakeAudioStream(input);

    const out = await collect(
      trimAudioGaplessFrameStream(
        source.stream,
        { leadingSamples: 0, totalSamples: 0 },
        restampFakeAudioRange,
      ),
    );

    expect(out).toEqual([]);
    expect(input[0]?.closeCount).toBe(1);
    expect(source.canceled()).toBe(false);
  });

  it('supports open-ended gapless content and closes naturally at source EOF', async () => {
    const input = [
      new FakeAudioFrame(0, 21_333, 1024, 48_000, 'priming'),
      new FakeAudioFrame(21_333, 21_333, 1024, 48_000, 'program'),
    ];
    const source = fakeAudioStream(input);

    const out = await collect(
      trimAudioGaplessFrameStream(source.stream, { leadingSamples: 1024 }, restampFakeAudioRange),
    );

    expect(out.map((frame) => [frame.label, frame.timestamp, frame.numberOfFrames])).toEqual([
      ['program:0+1024', 0, 1024],
    ]);
    expect(input.map((frame) => frame.closeCount)).toEqual([1, 1]);
    expect(source.canceled()).toBe(false);

    out[0]?.close();
    expect(out[0]?.closeCount).toBe(1);
  });

  it('keeps zero-rate audio timestamps deterministic while sample-windowing', async () => {
    const input = [new FakeAudioFrame(0, null, 4, 0, 'a'), new FakeAudioFrame(0, null, 4, 0, 'b')];
    const source = fakeAudioStream(input);

    const out = await collect(
      trimAudioGaplessFrameStream(
        source.stream,
        { leadingSamples: 2, totalSamples: 4 },
        restampFakeAudioRange,
      ),
    );

    expect(out.map((frame) => [frame.label, frame.timestamp, frame.numberOfFrames])).toEqual([
      ['a:2+2', 0, 2],
      ['b:0+2', 0, 2],
    ]);
  });

  it('closes the source frame and cancels upstream if gapless restamping fails', async () => {
    const input = [
      new FakeAudioFrame(0, 21_333, 1024, 48_000, 'program'),
      new FakeAudioFrame(21_333, 21_333, 1024, 48_000, 'unused'),
    ];
    const source = fakeAudioStream(input);
    const boom = new Error('audio restamp failed');
    const trimmed = trimAudioGaplessFrameStream(source.stream, { totalSamples: 1024 }, () => {
      throw boom;
    });

    await expect(trimmed.getReader().read()).rejects.toThrow('audio restamp failed');
    expect(input[0]?.closeCount).toBe(1);
    expect(input[1]?.closeCount).toBe(0);
    expect(source.canceled()).toBe(true);
  });

  it('rejects non-finite and negative gapless sample counts with typed errors', () => {
    const source = fakeAudioStream([new FakeAudioFrame(0, 21_333, 1024, 48_000, 'program')]);

    expect(() =>
      trimAudioGaplessFrameStream(
        source.stream,
        { leadingSamples: -1, totalSamples: 1024 },
        restampFakeAudioRange,
      ),
    ).toThrow(MediaError);
    expect(() =>
      trimAudioGaplessFrameStream(
        fakeAudioStream([new FakeAudioFrame(0, 21_333, 1024, 48_000, 'program')]).stream,
        { leadingSamples: 0, totalSamples: Number.POSITIVE_INFINITY },
        restampFakeAudioRange,
      ),
    ).toThrow(/gapless totalSamples/);
  });
});
