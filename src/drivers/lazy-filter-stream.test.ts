/**
 * `createLazyFilterStream` wiring discipline (the Session-10 transcode-timeout regression, ADR-186).
 *
 * The lazy filter proxy is the ONLY stream between the decoder and the encoder on every filtered
 * convert, so its queuing strategy is load-bearing: a `highWaterMark: 0` writable never reports room,
 * `pipeTo` waits for `writer.ready` forever, and the whole convert chain stalls before the first frame
 * — silently, with no error. These tests pump plain closable stubs through the real wrapper (the
 * transformer only ever calls `frame.close()`, never a VideoFrame API), so the wiring is Node-provable
 * and the regression is a hard red: with the broken strategy every test here times out.
 */

import { describe, expect, it } from 'vitest';
import { createLazyFilterStream } from './defaults.ts';

/** Minimal closable frame stub — structurally what the wrapper needs (close-once discipline counted). */
interface StubFrame {
  readonly id: number;
  closed: number;
  close(): void;
}

function frame(id: number): StubFrame {
  return {
    id,
    closed: 0,
    close(): void {
      this.closed++;
    },
  };
}

function sourceOf(frames: readonly StubFrame[]): ReadableStream<StubFrame> {
  let i = 0;
  return new ReadableStream<StubFrame>(
    {
      pull(controller): void {
        const next = frames[i];
        i++;
        if (next === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(next);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Reject if the pipeline stalls — the regression mode is an eternal, error-free hang. */
async function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`stalled: ${what} did not finish in ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

async function collect(stream: ReadableStream<StubFrame>): Promise<StubFrame[]> {
  const reader = stream.getReader();
  const out: StubFrame[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

/** A 1:1 identity-tagging stage like the GPU filters: consume input (close it), emit a fresh frame. */
function oneToOneStage(created: { count: number }): TransformStream<StubFrame, StubFrame> {
  created.count++;
  return new TransformStream<StubFrame, StubFrame>({
    transform(input, controller): void {
      try {
        controller.enqueue(frame(input.id * 10));
      } finally {
        input.close();
      }
    },
  });
}

describe('createLazyFilterStream', () => {
  it('flows frames through a lazily-created 1:1 stage (regression: a zero-HWM writable stalls the chain forever)', async () => {
    const created = { count: 0 };
    const lazy = createLazyFilterStream<StubFrame>(async () => oneToOneStage(created));
    expect(created.count).toBe(0); // laziness: nothing loads until a frame actually flows
    const inputs = [frame(1), frame(2), frame(3)];
    const out = await withinMs(
      collect(sourceOf(inputs).pipeThrough(lazy)),
      2_000,
      'lazy 1:1 filter chain',
    );
    expect(out.map((f) => f.id)).toEqual([10, 20, 30]);
    expect(created.count).toBe(1);
    for (const input of inputs) expect(input.closed).toBe(1); // consumed exactly once by the stage
  });

  it('delivers a buffering stage’s flush-tail output (N:M stages must not deadlock a lockstep wrapper)', async () => {
    const buffered: StubFrame[] = [];
    const stage = new TransformStream<StubFrame, StubFrame>({
      transform(input): void {
        buffered.push(input); // emit nothing per frame — everything comes out at flush
      },
      flush(controller): void {
        for (const held of buffered.splice(0)) {
          try {
            controller.enqueue(frame(held.id + 100));
          } finally {
            held.close();
          }
        }
      },
    });
    const lazy = createLazyFilterStream<StubFrame>(async () => stage);
    const out = await withinMs(
      collect(sourceOf([frame(1), frame(2), frame(3)]).pipeThrough(lazy)),
      2_000,
      'buffering filter flush tail',
    );
    expect(out.map((f) => f.id)).toEqual([101, 102, 103]);
  });

  it('keeps in-flight frames bounded under a slow consumer (backpressure reaches the source)', async () => {
    const TOTAL = 32;
    let pulled = 0;
    const source = new ReadableStream<StubFrame>(
      {
        pull(controller): void {
          pulled++;
          if (pulled > TOTAL) {
            controller.close();
            return;
          }
          controller.enqueue(frame(pulled));
        },
      },
      { highWaterMark: 0 },
    );
    const created = { count: 0 };
    const lazy = createLazyFilterStream<StubFrame>(async () => oneToOneStage(created));
    const reader = source.pipeThrough(lazy).getReader();
    let maxAhead = 0;
    let consumed = 0;
    for (;;) {
      const { done, value } = await withinMs(reader.read(), 2_000, 'slow-consumer read');
      if (done) break;
      consumed++;
      maxAhead = Math.max(maxAhead, pulled - consumed);
      value.close();
      await new Promise((resolve) => setTimeout(resolve, 1)); // slow consumer
    }
    expect(consumed).toBe(TOTAL);
    // The wrapper + inner stage may hold a few frames across their four small queues, but a slow
    // consumer must throttle the source — an unbounded pump would race `pulled` to TOTAL immediately.
    expect(maxAhead).toBeLessThanOrEqual(8);
  });

  it('propagates an inner-stage error to the outer readable (typed, no silent stall)', async () => {
    const lazy = createLazyFilterStream<StubFrame>(
      async () =>
        new TransformStream<StubFrame, StubFrame>({
          transform(input): void {
            input.close();
            throw new Error('stage exploded');
          },
        }),
    );
    await expect(
      withinMs(collect(sourceOf([frame(1)]).pipeThrough(lazy)), 2_000, 'error propagation'),
    ).rejects.toThrow('stage exploded');
  });

  it('closes the input frame when the lazy create() itself rejects', async () => {
    const input = frame(7);
    const lazy = createLazyFilterStream<StubFrame>(async () => {
      throw new Error('no renderer available');
    });
    await expect(
      withinMs(collect(sourceOf([input]).pipeThrough(lazy)), 2_000, 'create() rejection'),
    ).rejects.toThrow('no renderer available');
    expect(input.closed).toBe(1);
  });

  it('cancels promptly around a stuck in-flight stage and the late output is released, not thrown', async () => {
    let releaseLateOutput: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseLateOutput = resolve;
    });
    const late = frame(99);
    // Mirrors the real filter drivers: consume the input, and guard the enqueue so an output that
    // loses the race against cancellation is closed by the stage (gpu-video's handed-off pattern).
    const stage = new TransformStream<StubFrame, StubFrame>({
      async transform(input, controller): Promise<void> {
        input.close();
        await gate; // the stage is mid-frame when the consumer walks away
        let handedOff = false;
        try {
          controller.enqueue(late);
          handedOff = true;
        } catch {
          // cancelled inner readable: fall through to the close below
        } finally {
          if (!handedOff) late.close();
        }
      },
    });
    const lazy = createLazyFilterStream<StubFrame>(async () => stage);
    const reader = sourceOf([frame(1)])
      .pipeThrough(lazy)
      .getReader();
    const firstRead = reader.read().catch(() => undefined); // never produces; cancelled below
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Cancellation must settle promptly even though the inner stage is stuck mid-transform — an
    // awaiting teardown would deadlock here (abort/cancel settle only after in-flight writes finish).
    await withinMs(reader.cancel(new Error('consumer left')), 500, 'outer cancel');
    releaseLateOutput?.();
    await firstRead;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(late.closed).toBe(1); // the orphaned output was released, not thrown into a dead stream
  });
});
