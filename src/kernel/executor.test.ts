import { describe, expect, it } from 'vitest';
import type { Progress } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { collect, composeChain, runToSink } from './executor.ts';

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
});

describe('cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    await expect(collect(bytesStream([1]), { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'MediaError',
      code: 'aborted',
    });
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
    const sink = new WritableStream<Uint8Array>();
    await expect(
      runToSink(bytesStream([1]), sink, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'aborted' });
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
