/**
 * Validation for the {@link StreamTarget} streaming sink — it writes a produced byte stream to the
 * caller's destination incrementally (never buffering the whole output) and surfaces typed errors.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import {
  type StreamTarget,
  type StreamTargetWriter,
  toStreamTarget,
  writeToStreamTarget,
} from './stream-target.ts';

function bytesStream(...arrays: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      for (const a of arrays) c.enqueue(new Uint8Array(a));
      c.close();
    },
  });
}

describe('toStreamTarget — descriptor', () => {
  it('builds a stream-target descriptor carrying the destination', () => {
    const writer: StreamTargetWriter = () => undefined;
    const t = toStreamTarget(writer);
    expect(t.kind).toBe('stream-target');
    expect(t.destination).toBe(writer);
  });
});

describe('writeToStreamTarget — WritableStream destination', () => {
  it('writes every chunk in order and returns undefined (wrote to the target)', async () => {
    const written: number[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk): void {
        written.push(...chunk);
      },
    });
    const out = await writeToStreamTarget(
      toStreamTarget(writable),
      bytesStream([1, 2], [3], [4, 5]),
    );
    expect(out).toBeUndefined();
    expect(written).toEqual([1, 2, 3, 4, 5]);
  });

  it('applies backpressure: a slow writable still receives the full, ordered output', async () => {
    const chunks: number[][] = [];
    const writable = new WritableStream<Uint8Array>({
      async write(chunk): Promise<void> {
        await new Promise((r) => setTimeout(r, 1));
        chunks.push([...chunk]);
      },
    });
    await writeToStreamTarget(toStreamTarget(writable), bytesStream([1], [2], [3]));
    expect(chunks).toEqual([[1], [2], [3]]);
  });

  it('maps a failing writable to a typed MediaError', async () => {
    const writable = new WritableStream<Uint8Array>({
      write(): void {
        throw new Error('disk full');
      },
    });
    await expect(
      writeToStreamTarget(toStreamTarget(writable), bytesStream([1, 2, 3])),
    ).rejects.toBeInstanceOf(MediaError);
  });
});

describe('writeToStreamTarget — callback destination', () => {
  it('rejects unsupported destination shapes as a typed capability miss', async () => {
    const target = {
      kind: 'stream-target',
      destination: { write: () => undefined },
    } as unknown as StreamTarget;
    const err = await writeToStreamTarget(target, bytesStream([1])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe('capability-miss');
  });

  it('hands each chunk to the callback with its running byte position', async () => {
    const calls: { data: number[]; position: number }[] = [];
    const writer: StreamTargetWriter = (chunk, position) => {
      calls.push({ data: [...chunk], position });
    };
    const out = await writeToStreamTarget(
      toStreamTarget(writer),
      bytesStream([1, 2], [3], [4, 5, 6]),
    );
    expect(out).toBeUndefined();
    expect(calls).toEqual([
      { data: [1, 2], position: 0 },
      { data: [3], position: 2 },
      { data: [4, 5, 6], position: 3 },
    ]);
  });

  it('awaits an async callback before pulling the next chunk (backpressure)', async () => {
    const order: string[] = [];
    const writer: StreamTargetWriter = async (chunk) => {
      order.push(`start:${chunk[0]}`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`end:${chunk[0]}`);
    };
    await writeToStreamTarget(toStreamTarget(writer), bytesStream([10], [20]));
    // Strict serialization: each write fully completes before the next begins.
    expect(order).toEqual(['start:10', 'end:10', 'start:20', 'end:20']);
  });

  it('maps a throwing callback to a typed MediaError (mux-error) and cancels upstream', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new Uint8Array([1]));
        // never closes on its own — relies on the consumer cancelling on the callback throw
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const writer: StreamTargetWriter = () => {
      throw new Error('writer blew up');
    };
    const err = await writeToStreamTarget(toStreamTarget(writer), stream).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('mux-error');
    expect(cancelled).toBe(true);
  });
});

describe('writeToStreamTarget — cancellation', () => {
  it('rejects with aborted when the signal is already aborted (WritableStream arm)', async () => {
    const writable = new WritableStream<Uint8Array>();
    const ac = new AbortController();
    ac.abort();
    const err = await writeToStreamTarget(toStreamTarget(writable), bytesStream([1]), {
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('aborted');
  });

  it('rejects with aborted when the signal is already aborted (callback arm)', async () => {
    const ac = new AbortController();
    ac.abort();
    const calls: number[] = [];
    const writer: StreamTargetWriter = (chunk) => {
      calls.push(chunk[0] ?? -1);
    };
    const err = await writeToStreamTarget(toStreamTarget(writer), bytesStream([1]), {
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('aborted');
    expect(calls).toEqual([]); // never pulled a chunk
  });

  it('aborts mid-stream: stops pulling and rejects (callback arm)', async () => {
    const ac = new AbortController();
    const seen: number[] = [];
    const writer: StreamTargetWriter = (chunk) => {
      seen.push(chunk[0] ?? -1);
      if (seen.length === 1) ac.abort(); // abort after the first chunk
    };
    const err = await writeToStreamTarget(toStreamTarget(writer), bytesStream([1], [2], [3]), {
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('aborted');
    expect(seen).toEqual([1]); // did not continue to chunks 2 and 3
  });

  it('aborts while waiting for the next source chunk (callback arm)', async () => {
    const ac = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull(): Promise<void> {
        return new Promise(() => undefined);
      },
    });
    const writer: StreamTargetWriter = () => undefined;
    const pending = writeToStreamTarget(toStreamTarget(writer), stream, { signal: ac.signal });
    setTimeout(() => ac.abort(), 1);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('aborted');
  });

  it('aborts while a callback write promise is pending', async () => {
    const ac = new AbortController();
    let writerCalled = false;
    const writer: StreamTargetWriter = () => {
      writerCalled = true;
      return new Promise(() => undefined);
    };
    const pending = writeToStreamTarget(toStreamTarget(writer), bytesStream([1]), {
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 1);
    const err = await pending.catch((e: unknown) => e);
    expect(writerCalled).toBe(true);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('aborted');
  });
});
