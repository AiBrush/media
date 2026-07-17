import { describe, expect, it, vi } from 'vitest';
import type { Progress } from '../contracts/driver.ts';
import { InputError, MediaError } from '../contracts/errors.ts';
import {
  type CancellableTask,
  batchPackets,
  collect,
  composeChain,
  lazyPipeThrough,
  runCancellable,
  runToSink,
} from './executor.ts';

function bytesStream(...arrays: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      for (const a of arrays) c.enqueue(new Uint8Array(a));
      c.close();
    },
  });
}

function inc(): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c): void {
      c.enqueue(chunk.map((b) => b + 1));
    },
  });
}

function throwingTransform(err: unknown): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(): void {
      throw err;
    },
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('composeChain + collect', () => {
  it('pipes a source through a same-type stage chain', async () => {
    const out = await collect(composeChain(bytesStream([1, 2], [3]), [inc(), inc()]));
    expect([...out]).toEqual([3, 4, 5]);
  });

  it('collects bytes and reports monotonic progress', async () => {
    const seen: Progress[] = [];
    const out = await collect(bytesStream([1, 2], [3, 4, 5]), { onProgress: (p) => seen.push(p) });
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
    expect(seen.map((p) => p.done)).toEqual([2, 5]);
    expect(seen.every((p) => p.stage === 'collect')).toBe(true);
  });

  it('adopts one exact-owned ArrayBuffer chunk without copying it', async () => {
    const chunk = new Uint8Array([1, 2, 3, 4]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(chunk);
        controller.close();
      },
    });

    const out = await collect(stream);

    expect(out).toEqual(chunk);
    expect(out.buffer).toBe(chunk.buffer);
  });

  it('copies a sole subview instead of retaining unrelated backing bytes', async () => {
    const storage = new Uint8Array([90, 91, 1, 2, 3, 4, 92, 93]);
    const chunk = storage.subarray(2, 6);
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(chunk);
        controller.close();
      },
    });

    const out = await collect(stream);

    expect([...out]).toEqual([1, 2, 3, 4]);
    expect(out.buffer).not.toBe(storage.buffer);
    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(4);
  });

  it('copies a sole SharedArrayBuffer view into exact-owned ArrayBuffer storage', async () => {
    const storage = new SharedArrayBuffer(4);
    const chunk = new Uint8Array(storage);
    chunk.set([1, 2, 3, 4]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(chunk);
        controller.close();
      },
    });

    const out = await collect(stream);

    expect([...out]).toEqual([1, 2, 3, 4]);
    expect(out.buffer).toBeInstanceOf(ArrayBuffer);
    expect(out.buffer).not.toBe(storage);
  });
});

describe('lazyPipeThrough', () => {
  it('does not create or start the stage until a downstream reader pulls', async () => {
    let created = 0;
    let transformed = 0;
    const stream = lazyPipeThrough(bytesStream([1]), () => {
      created++;
      return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, c): void {
          transformed++;
          c.enqueue(chunk.map((b) => b + 1));
        },
      });
    });

    await delay(0);
    expect(created).toBe(0);
    expect(transformed).toBe(0);

    const reader = stream.getReader();
    try {
      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: new Uint8Array([2]),
      });
      expect(created).toBe(1);
      expect(transformed).toBe(1);
    } finally {
      reader.releaseLock();
    }
  });

  it('propagates cancellation to the lazily-created pipe once started', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(c): void {
        c.enqueue(new Uint8Array([1]));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const reader = lazyPipeThrough(source, inc).getReader();
    try {
      await expect(reader.read()).resolves.toMatchObject({ done: false });
      await reader.cancel('stop');
      expect(cancelled).toBe(true);
    } finally {
      reader.releaseLock();
    }
  });
});

describe('cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    let pulls = 0;
    let cancels = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(): void {
          pulls++;
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(collect(source, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'MediaError',
      code: 'aborted',
    });
    expect(pulls).toBe(0);
    expect(cancels).toBe(1);
  });

  it('aborts an in-flight collect and cancels the source', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new Uint8Array([1]));
      },
      pull(): Promise<void> {
        return new Promise<void>(() => {}); // hang on the second read
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const ctrl = new AbortController();
    const p = collect(stream, { signal: ctrl.signal });
    await delay(5);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(cancelled).toBe(true);
  });

  it('rejects runToSink when pre-aborted', async () => {
    let pulls = 0;
    let cancels = 0;
    let aborts = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(): void {
          pulls++;
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const sink = new WritableStream<Uint8Array>({
      abort(): void {
        aborts++;
      },
    });
    await expect(runToSink(source, sink, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(pulls).toBe(0);
    expect(cancels).toBe(1);
    expect(aborts).toBe(1);
  });
});

describe('error mapping', () => {
  it('passes a typed MediaError through unchanged', async () => {
    const src = composeChain(bytesStream([1]), [
      throwingTransform(new MediaError('demux-error', 'bad')),
    ]);
    await expect(collect(src)).rejects.toMatchObject({ name: 'MediaError', code: 'demux-error' });
  });

  it('wraps an unexpected error with the op-supplied errorCode', async () => {
    const src = composeChain(bytesStream([1]), [throwingTransform(new Error('kaboom'))]);
    await expect(collect(src, { errorCode: 'decode-error' })).rejects.toMatchObject({
      name: 'MediaError',
      code: 'decode-error',
      message: 'kaboom',
    });
  });

  it('rethrows an unexpected error faithfully when no errorCode is given', async () => {
    const boom = new Error('raw');
    const src = composeChain(bytesStream([1]), [throwingTransform(boom)]);
    await expect(collect(src)).rejects.toBe(boom);
  });
});

describe('runToSink', () => {
  it('pipes bytes into a writable sink', async () => {
    const written: number[] = [];
    const sink = new WritableStream<Uint8Array>({
      write(chunk): void {
        written.push(...chunk);
      },
    });
    await runToSink(bytesStream([1, 2], [3]), sink);
    expect(written).toEqual([1, 2, 3]);
  });
});

describe('batchPackets (zero-high-water-mark batched drain, ADR-278)', () => {
  it('drains a 553,501-packet table in exactly ceil(N/256) value reads, order-exact', async () => {
    const packetCount = 553_501;
    const table = Array.from({ length: packetCount }, (_, index) => index);
    const reader = batchPackets<number>(table).getReader();

    let valueReads = 0;
    let expected = 0;
    let lastBatchLength = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      valueReads++;
      expect(value.length).toBeLessThanOrEqual(256);
      for (const item of value) {
        if (item !== expected) throw new Error(`packet ${expected} lost or reordered (${item})`);
        expected++;
      }
      lastBatchLength = value.length;
    }

    expect(valueReads).toBe(Math.ceil(packetCount / 256)); // 2,163 — not 553,501
    expect(expected).toBe(packetCount);
    expect(lastBatchLength).toBe(packetCount - (valueReads - 1) * 256);
  });

  it('caps a batch by payload bytes and ships an oversized item alone', async () => {
    const items = [
      { size: 200_000 },
      { size: 200_000 },
      { size: 300_000 },
      { size: 1 },
      { size: 1 },
    ];
    const batches: number[][] = [];
    const reader = batchPackets(items, { byteLength: (item) => item.size }).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      batches.push(value.map((item) => item.size));
    }
    // 200,000 < 256 KiB → keep filling; 400,000 ≥ 256 KiB → flush. The 300,000 item exceeds the cap by
    // itself and still ships (whole — items are never split).
    expect(batches).toEqual([[200_000, 200_000], [300_000], [1, 1]]);
  });

  it('delivers zero packets after a post-batch abort and cancels the upstream', async () => {
    let pulls = 0;
    let cancels = 0;
    const upstream = new ReadableStream<number>(
      {
        pull(controller): void {
          pulls++;
          controller.enqueue(pulls);
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const reader = batchPackets(upstream, { signal: controller.signal }).getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toHaveLength(256);
    expect(pulls).toBe(256);

    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'MediaError', code: 'aborted' });
    expect(pulls).toBe(256); // the upstream was never pulled again after the abort
    expect(cancels).toBe(1);
  });

  it('closes every in-flight frame exactly once when aborted mid-batch', async () => {
    const closes: number[] = [0, 0, 0];
    let cancelled = false;
    let delivered = 0;
    const frames = [0, 1, 2].map((index) => ({
      close: (): void => {
        closes[index] = (closes[index] ?? 0) + 1;
      },
    }));
    const hanging = new ReadableStream<{ close(): void }>(
      {
        pull(controller): Promise<void> {
          if (delivered < frames.length) {
            const frame = frames[delivered];
            if (frame !== undefined) controller.enqueue(frame);
            delivered++;
            return Promise.resolve();
          }
          return new Promise<void>(() => {}); // hang: the batch stays in flight
        },
        cancel(): void {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    const controller = new AbortController();
    const reader = batchPackets(hanging, { signal: controller.signal }).getReader();
    const pending = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'MediaError', code: 'aborted' });
    expect(closes).toEqual([1, 1, 1]); // every buffered in-flight frame closed exactly once
    expect(cancelled).toBe(true);
  });

  it('propagates consumer cancel to the upstream source', async () => {
    let cancelReason: unknown;
    const upstream = new ReadableStream<number>(
      {
        pull(controller): void {
          controller.enqueue(1);
        },
        cancel(reason): void {
          cancelReason = reason;
        },
      },
      { highWaterMark: 0 },
    );
    const reader = batchPackets(upstream).getReader();
    await reader.read();
    await reader.cancel('enough');
    expect(cancelReason).toBe('enough');
  });

  it('rejects non-positive batch bounds with a typed InputError', () => {
    expect(() => batchPackets([1], { maxItems: 0 })).toThrow(InputError);
    expect(() => batchPackets([1], { maxBytes: 0 })).toThrow(InputError);
  });
});

describe('runCancellable', () => {
  function cancellable<T>(promise: Promise<T>, cancel: () => void): CancellableTask<T> {
    const task = promise as CancellableTask<T>;
    task.cancel = cancel;
    return task;
  }

  it('forwards the parent abort reason into the linked scope signal', async () => {
    const parent = new AbortController();
    const task = runCancellable([parent.signal], async (scope) => {
      await new Promise<void>((resolve) => {
        scope.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return scope.signal.reason as unknown;
    });
    parent.abort('storm');
    await expect(task).resolves.toBe('storm');
  });

  it('removes parent listeners once the run settles', async () => {
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, 'addEventListener');
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    await runCancellable([parent.signal], async () => 'done');
    const registered = add.mock.calls.find(([type]) => type === 'abort');
    expect(registered).toBeDefined();
    expect(remove).toHaveBeenCalledWith('abort', registered?.[1]);
  });

  it('cancel() after settlement still reaches the last tracked handle, exactly once', async () => {
    const cancel = vi.fn();
    const task = runCancellable([], (scope) =>
      scope.dispatch(cancellable(Promise.resolve('ok'), cancel)),
    );
    await expect(task).resolves.toBe('ok');
    task.cancel();
    task.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the in-flight tracked handle on parent abort, exactly once', async () => {
    const parent = new AbortController();
    let reject: (reason: unknown) => void = () => undefined;
    const cancel = vi.fn(() => reject(new MediaError('aborted', 'inner cancelled')));
    const task = runCancellable([parent.signal], (scope) =>
      scope.dispatch(
        cancellable(
          new Promise<never>((_resolve, rejectPromise) => {
            reject = rejectPromise;
          }),
          cancel,
        ),
      ),
    );
    parent.abort();
    await expect(task).rejects.toMatchObject({ code: 'aborted' });
    task.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
