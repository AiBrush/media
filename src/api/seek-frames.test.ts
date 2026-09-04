import { describe, expect, it } from 'vitest';
import { peekSeekHead, seekNearestFrame } from './seek-frames.ts';

interface FakeFrame {
  readonly timestamp: number;
  closed: boolean;
  close(): void;
}

function frame(timestamp: number): FakeFrame {
  const f: FakeFrame = {
    timestamp,
    closed: false,
    close(): void {
      f.closed = true;
    },
  };
  return f;
}

function streamOf<T>(items: readonly T[]): ReadableStream<T> {
  let index = 0;
  return new ReadableStream<T>({
    pull(controller): void {
      if (index >= items.length) {
        controller.close();
        return;
      }
      controller.enqueue(items[index++] as T);
    },
  });
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

describe('peekSeekHead', () => {
  it('returns the first item and a stream that still yields every item in order', async () => {
    const { first, stream } = await peekSeekHead(streamOf([1, 2, 3]));
    expect(first).toBe(1);
    expect(await drain(stream)).toEqual([1, 2, 3]);
  });

  it('reports an empty stream without inventing an item', async () => {
    const { first, stream } = await peekSeekHead(streamOf<number>([]));
    expect(first).toBeUndefined();
    expect(await drain(stream)).toEqual([]);
  });

  it('propagates cancellation to the underlying reader', async () => {
    let cancelled: unknown;
    const source = new ReadableStream<number>({
      pull(controller): void {
        controller.enqueue(1);
      },
      cancel(reason): void {
        cancelled = reason;
      },
    });
    const { stream } = await peekSeekHead(source);
    await stream.cancel('stop');
    expect(cancelled).toBe('stop');
  });
});

describe('seekNearestFrame', () => {
  const frames = (): FakeFrame[] => [frame(0), frame(40_000), frame(80_000), frame(120_000)];

  it('lands on the closest frame after the target when it is nearer than the one before', async () => {
    const all = frames();
    const chosen = await seekNearestFrame(
      streamOf(all) as unknown as ReadableStream<VideoFrame>,
      70_000,
    );
    expect(chosen.timestamp).toBe(80_000);
    expect(all.map((f) => f.closed)).toEqual([true, true, false, false]);
  });

  it('lands on the frame before the target when it is nearer, and closes the later one', async () => {
    const all = frames();
    const chosen = await seekNearestFrame(
      streamOf(all) as unknown as ReadableStream<VideoFrame>,
      50_000,
    );
    expect(chosen.timestamp).toBe(40_000);
    expect(all.map((f) => f.closed)).toEqual([true, false, true, false]);
  });

  it('prefers the earlier frame on an exact tie and the last frame past the end', async () => {
    const tie = frames();
    expect(
      (await seekNearestFrame(streamOf(tie) as unknown as ReadableStream<VideoFrame>, 60_000))
        .timestamp,
    ).toBe(40_000);
    const past = frames();
    expect(
      (await seekNearestFrame(streamOf(past) as unknown as ReadableStream<VideoFrame>, 999_000))
        .timestamp,
    ).toBe(120_000);
    expect(past.map((f) => f.closed)).toEqual([true, true, true, false]);
  });

  it('rejects an empty stream with a typed input error', async () => {
    await expect(
      seekNearestFrame(streamOf<FakeFrame>([]) as unknown as ReadableStream<VideoFrame>, 0),
    ).rejects.toMatchObject({ name: 'InputError' });
  });
});
