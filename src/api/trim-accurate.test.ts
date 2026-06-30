import { describe, expect, it } from 'vitest';
import {
  type TimedFrameForTrim,
  trimTimedFrameStream,
  trimVideoEncodeTarget,
} from './trim-streams.ts';

class FakeFrame implements TimedFrameForTrim {
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly duration: number | null,
    readonly label: string = String(timestamp),
  ) {}

  close(): void {
    this.closeCount++;
  }
}

interface FakeStream {
  readonly stream: ReadableStream<FakeFrame>;
  readonly canceled: () => boolean;
}

function fakeFrameStream(frames: readonly FakeFrame[]): FakeStream {
  let index = 0;
  let canceled = false;
  return {
    stream: new ReadableStream<FakeFrame>({
      pull(controller): void {
        const frame = frames[index];
        index++;
        if (frame === undefined) {
          controller.close();
        } else {
          controller.enqueue(frame);
        }
      },
      cancel(): void {
        canceled = true;
      },
    }),
    canceled: () => canceled,
  };
}

async function collect(stream: ReadableStream<FakeFrame>): Promise<FakeFrame[]> {
  const reader = stream.getReader();
  const out: FakeFrame[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

function restampFake(frame: FakeFrame, timestamp: number, duration: number | null): FakeFrame {
  if (frame.timestamp === timestamp && frame.duration === duration) return frame;
  return new FakeFrame(timestamp, duration, `rebased:${frame.label}`);
}

function baseLabel(frame: FakeFrame): string {
  let label = frame.label;
  while (label.startsWith('rebased:')) label = label.slice('rebased:'.length);
  return label;
}

function restampPreservingLabel(
  frame: FakeFrame,
  timestamp: number,
  duration: number | null,
): FakeFrame {
  if (frame.timestamp === timestamp && frame.duration === duration) return frame;
  return new FakeFrame(timestamp, duration, baseLabel(frame));
}

async function trimLabelsAndTimings(
  frames: readonly FakeFrame[],
  startUs: number,
  endUs: number,
): Promise<readonly [label: string, timestamp: number, duration: number | null][]> {
  const out = await collect(
    trimTimedFrameStream(
      fakeFrameStream(frames).stream,
      { startUs, endUs },
      restampPreservingLabel,
    ),
  );
  const summary = out.map((frame): [string, number, number | null] => [
    baseLabel(frame),
    frame.timestamp,
    frame.duration,
  ]);
  for (const frame of out) frame.close();
  return summary;
}

describe('trimTimedFrameStream — accurate trim frame-window core', () => {
  it('chooses a high-quality VBR target for accurate video trim composition', () => {
    expect(
      trimVideoEncodeTarget({
        id: 1,
        mediaType: 'video',
        codec: 'avc1.640028',
        fps: 30,
        config: { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 },
      }),
    ).toEqual({ bitrate: 27_993_600, bitrateMode: 'variable' });
  });

  it('closes preroll/end-boundary source frames, stops at end, and rebases kept frames', async () => {
    const input = [0, 33_333, 66_666, 100_000, 133_333, 166_666].map(
      (timestamp) => new FakeFrame(timestamp, 33_333),
    );
    const source = fakeFrameStream(input);

    const out = await collect(
      trimTimedFrameStream(source.stream, { startUs: 50_000, endUs: 120_000 }, restampFake),
    );

    expect(out.map((frame) => frame.timestamp)).toEqual([0, 33_334]);
    expect(out.map((frame) => frame.duration)).toEqual([33_333, 33_333]);
    expect(input.map((frame) => frame.closeCount)).toEqual([1, 1, 1, 1, 1, 0]);
    expect(out.map((frame) => frame.closeCount)).toEqual([0, 0]);

    for (const frame of out) frame.close();
    expect(out.map((frame) => frame.closeCount)).toEqual([1, 1]);
  });

  it('does not prefetch a native frame before a downstream reader asks', async () => {
    let pulls = 0;
    const input = [new FakeFrame(0, 40), new FakeFrame(40, 40)];
    const source = new ReadableStream<FakeFrame>(
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

    const trimmed = trimTimedFrameStream(source, { startUs: 0, endUs: 100 }, restampFake);
    await Promise.resolve();

    expect(pulls).toBe(0);

    const reader = trimmed.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(pulls).toBe(1);
    first.value?.close();
    await reader.cancel();
  });

  it('keeps a frame exactly at start and excludes a frame exactly at end', async () => {
    const input = [100, 200, 300, 400].map((timestamp) => new FakeFrame(timestamp, 50));
    const source = fakeFrameStream(input);

    const out = await collect(
      trimTimedFrameStream(source.stream, { startUs: 200, endUs: 300 }, restampFake),
    );

    expect(out.map((frame) => frame.timestamp)).toEqual([0]);
    expect(input.map((frame) => frame.closeCount)).toEqual([1, 1, 1, 0]);
  });

  it('is additive across adjacent windows without duplicating the boundary frame', async () => {
    const direct = await collect(
      trimTimedFrameStream(
        fakeFrameStream([100, 200, 300, 400].map((timestamp) => new FakeFrame(timestamp, 50)))
          .stream,
        { startUs: 100, endUs: 500 },
        restampFake,
      ),
    );
    const left = await collect(
      trimTimedFrameStream(
        fakeFrameStream([100, 200, 300, 400].map((timestamp) => new FakeFrame(timestamp, 50)))
          .stream,
        { startUs: 100, endUs: 300 },
        restampFake,
      ),
    );
    const right = await collect(
      trimTimedFrameStream(
        fakeFrameStream([100, 200, 300, 400].map((timestamp) => new FakeFrame(timestamp, 50)))
          .stream,
        { startUs: 300, endUs: 500 },
        restampFake,
      ),
    );

    expect(left.map((frame) => frame.label)).toEqual(['rebased:100', 'rebased:200']);
    expect(right.map((frame) => frame.label)).toEqual(['rebased:300', 'rebased:400']);
    expect([...left, ...right].map((frame) => frame.label)).toEqual(
      direct.map((frame) => frame.label),
    );
  });

  it('satisfies trim composition identity over a VFR-like frame timeline', async () => {
    const source = [
      new FakeFrame(1_000, 1_000, 'a'),
      new FakeFrame(2_000, 1_500, 'b'),
      new FakeFrame(3_500, 1_500, 'c'),
      new FakeFrame(5_000, 1_000, 'd'),
    ];

    const direct = await trimLabelsAndTimings(
      source.map((frame) => new FakeFrame(frame.timestamp, frame.duration, frame.label)),
      2_000,
      5_000,
    );
    const outer = await collect(
      trimTimedFrameStream(
        fakeFrameStream(
          source.map((frame) => new FakeFrame(frame.timestamp, frame.duration, frame.label)),
        ).stream,
        { startUs: 1_000, endUs: 5_000 },
        restampPreservingLabel,
      ),
    );
    const composed = await trimLabelsAndTimings(outer, 1_000, 4_000);

    expect(composed).toEqual(direct);
  });

  it('satisfies adjacent trim concatenation when the right window is offset by the left span', async () => {
    const makeSource = (): FakeFrame[] => [
      new FakeFrame(0, 1_000, 'a'),
      new FakeFrame(1_000, 1_000, 'b'),
      new FakeFrame(2_000, 1_500, 'c'),
      new FakeFrame(3_500, 1_500, 'd'),
      new FakeFrame(5_000, 1_000, 'e'),
    ];

    const leftStart = 1_000;
    const split = 3_500;
    const rightEnd = 5_000;
    const leftSpan = split - leftStart;
    const direct = await trimLabelsAndTimings(makeSource(), leftStart, rightEnd);
    const left = await trimLabelsAndTimings(makeSource(), leftStart, split);
    const right = await trimLabelsAndTimings(makeSource(), split, rightEnd);
    const concatenated = [
      ...left,
      ...right.map(([label, timestamp, duration]): [string, number, number | null] => [
        label,
        timestamp + leftSpan,
        duration,
      ]),
    ];

    expect(concatenated).toEqual(direct);
  });

  it('leaves unchanged kept frames open for the downstream encoder to close', async () => {
    const input = [new FakeFrame(0, 40), new FakeFrame(40, 40)];
    const source = fakeFrameStream(input);

    const out = await collect(
      trimTimedFrameStream(source.stream, { startUs: 0, endUs: 100 }, restampFake),
    );

    expect(out).toEqual(input);
    expect(input.map((frame) => frame.closeCount)).toEqual([0, 0]);
    expect(source.canceled()).toBe(false);

    for (const frame of out) frame.close();
    expect(input.map((frame) => frame.closeCount)).toEqual([1, 1]);
  });

  it('closes the source frame and cancels upstream if restamping fails', async () => {
    const input = [new FakeFrame(10, 5), new FakeFrame(20, 5)];
    const source = fakeFrameStream(input);
    const boom = new Error('rebasing failed');
    const trimmed = trimTimedFrameStream(source.stream, { startUs: 0, endUs: 30 }, () => {
      throw boom;
    });

    await expect(trimmed.getReader().read()).rejects.toThrow('rebasing failed');
    expect(input[0]?.closeCount).toBe(1);
    expect(input[1]?.closeCount).toBe(0);
    expect(source.canceled()).toBe(true);
  });
});
