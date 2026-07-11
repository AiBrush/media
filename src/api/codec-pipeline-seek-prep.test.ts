import { describe, expect, it } from 'vitest';
import type { EncodedChunk, Packet } from '../contracts/driver.ts';
import { startAtSeekKeyframe, startAtSeekKeyframePackets } from './codec-pipeline.ts';

interface TestChunk {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
}

function chunk(type: TestChunk['type'], timestamp: number): EncodedChunk {
  return { type, timestamp } as unknown as EncodedChunk;
}

function chunks(
  values: readonly EncodedChunk[],
  onCancel?: (reason: unknown) => void,
): ReadableStream<EncodedChunk> {
  return new ReadableStream<EncodedChunk>({
    start(controller): void {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
    cancel(reason): void {
      onCancel?.(reason);
    },
  });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const out: T[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe('seek keyframe stream preparation', () => {
  it('starts at the final keyframe at/before the target and preserves the continuation', async () => {
    const values = [
      chunk('key', 0),
      chunk('delta', 10),
      chunk('key', 20),
      chunk('delta', 30),
      chunk('delta', 40),
    ];
    const prepared = await startAtSeekKeyframe(chunks(values), 25);
    expect((await collect(prepared)).map((value) => value.timestamp)).toEqual([20, 30, 40]);
  });

  it('retains packet side data and the final GOP when the target is beyond EOF', async () => {
    const values: Packet[] = [
      { chunk: chunk('key', 0), dtsUs: -10 },
      { chunk: chunk('delta', 10), dtsUs: 0 },
      { chunk: chunk('key', 20), dtsUs: 10, alpha: chunk('delta', 20) as EncodedVideoChunk },
      { chunk: chunk('delta', 30), dtsUs: 20 },
    ];
    const packetStream = new ReadableStream<Packet>({
      start(controller): void {
        for (const value of values) controller.enqueue(value);
        controller.close();
      },
    });
    const packets = await collect(await startAtSeekKeyframePackets(packetStream, 100));
    expect(packets).toEqual(values.slice(2));
  });

  it('propagates cancellation through the retained reader', async () => {
    let reason: unknown;
    const prepared = await startAtSeekKeyframe(
      chunks([chunk('key', 0), chunk('delta', 10), chunk('delta', 20)], (value) => {
        reason = value;
      }),
      5,
    );
    await prepared.cancel('stop-seek');
    expect(reason).toBe('stop-seek');
  });
});
