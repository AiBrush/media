/**
 * Validation for the {@link StreamTarget} streaming sink — it writes a produced byte stream to the
 * caller's destination incrementally (never buffering the whole output) and surfaces typed errors.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
import {
  type StreamTarget,
  type StreamTargetWriter,
  chunkWritePosition,
  planStreamTargetWrite,
  positionedChunk,
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

function chunkStream(...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
}

/** Apply position-addressed writes to a sparse output image — the strict byte oracle for re-writes. */
function applyWrites(writes: ReadonlyArray<{ data: Uint8Array; position: number }>): Uint8Array {
  const size = writes.reduce((max, w) => Math.max(max, w.position + w.data.byteLength), 0);
  const image = new Uint8Array(size);
  for (const w of writes) image.set(w.data, w.position);
  return image;
}

/** A record-only random-access destination: a real WritableStream carrying an OPFS-like `seek`. */
interface PositionedWriteParamsLike {
  readonly type: 'write';
  readonly position: number;
  readonly data: Uint8Array;
}
function seekableRecorder(): {
  destination: WritableStream<Uint8Array>;
  writes: { data: Uint8Array; position: number; explicit: boolean }[];
  closed: () => boolean;
  aborted: () => unknown;
} {
  const writes: { data: Uint8Array; position: number; explicit: boolean }[] = [];
  let cursor = 0;
  let closed = false;
  let aborted: unknown;
  const destination = Object.assign(
    new WritableStream<Uint8Array | PositionedWriteParamsLike>({
      write(chunk): void {
        if (chunk instanceof Uint8Array) {
          writes.push({ data: chunk.slice(), position: cursor, explicit: false });
          cursor += chunk.byteLength;
          return;
        }
        writes.push({ data: chunk.data.slice(), position: chunk.position, explicit: true });
        cursor = chunk.position + chunk.data.byteLength;
      },
      close(): void {
        closed = true;
      },
      abort(reason): void {
        aborted = reason;
      },
    }),
    {
      seek(position: number): Promise<void> {
        cursor = position;
        return Promise.resolve();
      },
    },
  ) as unknown as WritableStream<Uint8Array>;
  return { destination, writes, closed: () => closed, aborted: () => aborted };
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
    let pulls = 0;
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>(
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
    const target = {
      kind: 'stream-target',
      destination: { write: () => undefined },
    } as unknown as StreamTarget;
    const err = await writeToStreamTarget(target, stream).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe('capability-miss');
    expect(pulls).toBe(0);
    expect(cancels).toBe(1);
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

  it('awaits asynchronous upstream cancellation before rejecting a callback failure', async () => {
    let releaseCancel: (() => void) | undefined;
    let markCancelStarted: (() => void) | undefined;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(Uint8Array.of(1));
      },
      async cancel(): Promise<void> {
        markCancelStarted?.();
        await cancelGate;
      },
    });
    const pending = writeToStreamTarget(
      toStreamTarget(() => Promise.reject(new Error('stop'))),
      stream,
    );
    const observed = pending.then(
      () => 'settled' as const,
      () => 'settled' as const,
    );
    await cancelStarted;
    const beforeRelease = await Promise.race([
      observed,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ]);
    expect(beforeRelease).toBe('pending');

    releaseCancel?.();
    await expect(pending).rejects.toMatchObject({ code: 'mux-error' });
    await expect(observed).resolves.toBe('settled');
  });

  it('preserves typed callback failures without remapping their code', async () => {
    const writer: StreamTargetWriter = () => {
      throw new MediaError('encode-error', 'typed callback failure');
    };
    const err = await writeToStreamTarget(toStreamTarget(writer), bytesStream([1])).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('encode-error');
  });

  it('maps abort-shaped and non-Error callback throws into typed errors', async () => {
    const abortLike =
      typeof DOMException !== 'undefined'
        ? new DOMException('callback aborted', 'AbortError')
        : Object.assign(new Error('callback aborted'), { name: 'AbortError' });
    const abortingWriter: StreamTargetWriter = () => {
      throw abortLike;
    };
    const abortErr = await writeToStreamTarget(
      toStreamTarget(abortingWriter),
      bytesStream([1]),
    ).catch((e: unknown) => e);
    expect(abortErr).toBeInstanceOf(MediaError);
    expect((abortErr as MediaError).code).toBe('aborted');

    const stringWriter: StreamTargetWriter = () => {
      throw 'plain callback failure';
    };
    const stringErr = await writeToStreamTarget(
      toStreamTarget(stringWriter),
      bytesStream([1]),
    ).catch((e: unknown) => e);
    expect(stringErr).toBeInstanceOf(MediaError);
    expect((stringErr as MediaError).code).toBe('mux-error');
    expect((stringErr as MediaError).message).toContain('plain callback failure');
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
    let pulls = 0;
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>(
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
    const writer: StreamTargetWriter = (chunk) => {
      calls.push(chunk[0] ?? -1);
    };
    const err = await writeToStreamTarget(toStreamTarget(writer), stream, {
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('aborted');
    expect(calls).toEqual([]); // never pulled a chunk
    expect(pulls).toBe(0);
    expect(cancels).toBe(1);
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

describe('positionedChunk — producer-intended byte offsets (doc 09 §5 item 2)', () => {
  it('tags a chunk with its intended offset and reads it back; untagged chunks carry none', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(chunkWritePosition(data)).toBeUndefined();
    expect(positionedChunk(data, 128)).toBe(data);
    expect(chunkWritePosition(data)).toBe(128);
    expect(chunkWritePosition(new Uint8Array([9]))).toBeUndefined();
  });

  it('rejects a negative / non-integer position as bad input', () => {
    expect(() => positionedChunk(new Uint8Array(1), -1)).toThrowError(InputError);
    expect(() => positionedChunk(new Uint8Array(1), 1.5)).toThrowError(InputError);
    expect(() => positionedChunk(new Uint8Array(1), Number.NaN)).toThrowError(InputError);
  });

  it('callback arm: delivers non-monotonic positions in producer order with correct offsets', async () => {
    // Write region B (header placeholder + body), then RE-WRITE region A (patch the header) — the
    // mediabunny `StreamTargetChunk` semantics. The old running counter would land the patch at 10.
    const header = new Uint8Array([0, 0, 0, 0]);
    const body = new Uint8Array([5, 6, 7, 8, 9, 10]);
    const patch = positionedChunk(new Uint8Array([1, 2, 3, 4]), 0);
    const writes: { data: Uint8Array; position: number }[] = [];
    await writeToStreamTarget(
      toStreamTarget((chunk, position) => {
        writes.push({ data: chunk.slice(), position });
      }),
      chunkStream(header, body, patch),
    );
    expect(writes.map((w) => w.position)).toEqual([0, 4, 0]); // producer order, producer offsets
    expect([...applyWrites(writes)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('callback arm: an untagged chunk continues from the end of the previous write', async () => {
    const positions: number[] = [];
    await writeToStreamTarget(
      toStreamTarget((_chunk, position) => {
        positions.push(position);
      }),
      chunkStream(
        new Uint8Array([1, 2, 3]), // implicit 0
        positionedChunk(new Uint8Array([4, 5]), 10), // explicit jump to 10
        new Uint8Array([6]), // continues at 12 (10 + 2), the file-cursor semantics
      ),
    );
    expect(positions).toEqual([0, 10, 12]);
  });

  it('random-access WritableStream arm: honors re-writes via explicit positioned writes', async () => {
    const recorder = seekableRecorder();
    const header = new Uint8Array([0, 0, 0]);
    const body = new Uint8Array([4, 5, 6, 7]);
    const patch = positionedChunk(new Uint8Array([1, 2, 3]), 0);
    await writeToStreamTarget(
      toStreamTarget(recorder.destination),
      chunkStream(header, body, patch),
    );
    expect(recorder.writes.map((w) => w.position)).toEqual([0, 3, 0]);
    // Contiguous writes stay plain (cursor semantics); only the jump needs an explicit position.
    expect(recorder.writes.map((w) => w.explicit)).toEqual([false, false, true]);
    expect([...applyWrites(recorder.writes)]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(recorder.closed()).toBe(true);
  });

  it('random-access WritableStream arm: aborts the destination on a failing source', async () => {
    const recorder = seekableRecorder();
    const failure = new MediaError('demux-error', 'synthetic source failure');
    const stream = new ReadableStream<Uint8Array>({
      pull(c): void {
        c.error(failure);
      },
    });
    const err = await writeToStreamTarget(toStreamTarget(recorder.destination), stream).catch(
      (e: unknown) => e,
    );
    expect(err).toBe(failure);
    expect(recorder.closed()).toBe(false);
    expect(recorder.aborted()).toBe(failure);
  });

  it('append-only WritableStream arm: refuses a non-contiguous positioned write with a typed miss', async () => {
    let cancelled: unknown;
    const source = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new Uint8Array([1, 2]));
        c.enqueue(positionedChunk(new Uint8Array([9]), 0)); // re-write — impossible on append-only
      },
      cancel(reason): void {
        cancelled = reason;
      },
    });
    const written: number[] = [];
    const destination = new WritableStream<Uint8Array>({
      write(chunk): void {
        written.push(...chunk);
      },
    });
    const err = await writeToStreamTarget(toStreamTarget(destination), source).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe('capability-miss');
    expect(cancelled).toBe(err); // upstream torn down — the byte at A never lands at the wrong offset
    expect(written).not.toContain(9);
  });

  it('append-only WritableStream arm: a tag equal to the append cursor passes through unchanged', async () => {
    const written: number[] = [];
    const destination = new WritableStream<Uint8Array>({
      write(chunk): void {
        written.push(...chunk);
      },
    });
    await writeToStreamTarget(
      toStreamTarget(destination),
      chunkStream(new Uint8Array([1, 2]), positionedChunk(new Uint8Array([3]), 2)),
    );
    expect(written).toEqual([1, 2, 3]);
  });
});

describe('first-write timing — the TTFB signal (doc 09 §5 item 5)', () => {
  it('fires the writer at the first produced chunk, before the source stream completes', async () => {
    let sourceCompleted = false;
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c): void {
          if (produced < 3) {
            produced++;
            c.enqueue(new Uint8Array([produced]));
            return;
          }
          sourceCompleted = true;
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const sourceStateAtWrite: boolean[] = [];
    await writeToStreamTarget(
      toStreamTarget(() => {
        sourceStateAtWrite.push(sourceCompleted);
      }),
      stream,
    );
    expect(sourceStateAtWrite).toHaveLength(3);
    expect(sourceStateAtWrite[0]).toBe(false); // first byte left the engine before finalize
  });
});

describe('planStreamTargetWrite — write-shaping options', () => {
  it('defaults to unchunked; chunked defaults chunkSize to 16 MiB', () => {
    expect(planStreamTargetWrite(toStreamTarget(() => undefined))).toEqual({
      chunked: false,
      chunkSize: 16 * 1024 * 1024,
    });
    expect(planStreamTargetWrite(toStreamTarget(() => undefined, { chunked: true }))).toEqual({
      chunked: true,
      chunkSize: 16 * 1024 * 1024,
    });
    expect(
      planStreamTargetWrite(toStreamTarget(() => undefined, { chunked: true, chunkSize: 2 ** 20 })),
    ).toEqual({ chunked: true, chunkSize: 2 ** 20 });
  });

  it('rejects a non-positive / non-integer chunkSize as bad input', () => {
    for (const chunkSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        planStreamTargetWrite(toStreamTarget(() => undefined, { chunked: true, chunkSize })),
      ).toThrowError(InputError);
    }
  });

  it('resolves and validates strict exact-write sizing independently from coalescing', () => {
    expect(
      planStreamTargetWrite(toStreamTarget(() => undefined, { writeChunkBytes: 188 })),
    ).toEqual({
      chunked: false,
      chunkSize: 16 * 1024 * 1024,
      writeChunkBytes: 188,
    });
    for (const writeChunkBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        planStreamTargetWrite(toStreamTarget(() => undefined, { writeChunkBytes })),
      ).toThrowError(InputError);
    }
    expect(() =>
      planStreamTargetWrite(
        toStreamTarget(() => undefined, {
          chunked: true,
          chunkSize: 1024,
          writeChunkBytes: 188,
        }),
      ),
    ).toThrowError(InputError);
  });
});

describe('writeChunkBytes StreamTarget — exact destination writes', () => {
  it('does not synthesize per-write microtask backpressure for a synchronous callback', async () => {
    const writeChunkBytes = 188;
    const writeCount = 4_096;
    let writes = 0;
    let writesSeenByFirstMicrotask = 0;

    await writeToStreamTarget(
      toStreamTarget(
        () => {
          writes++;
          if (writes === 1) {
            queueMicrotask(() => {
              writesSeenByFirstMicrotask = writes;
            });
          }
        },
        { writeChunkBytes },
      ),
      chunkStream(new Uint8Array(writeChunkBytes * writeCount)),
    );

    expect(writes).toBe(writeCount);
    expect(writesSeenByFirstMicrotask).toBeGreaterThanOrEqual(64);
  });

  it('cooperatively yields exact synchronous writes before one host task grows unbounded', async () => {
    const writeChunkBytes = 188;
    const writeCount = 512;
    let hostTimerFired = false;
    let observedTimerDuringWrite = false;
    const timer = setTimeout(() => {
      hostTimerFired = true;
    }, 0);

    await writeToStreamTarget(
      toStreamTarget(
        () => {
          const started = performance.now();
          while (performance.now() - started < 0.15) {
            // Model non-trivial caller telemetry without making the test itself slow.
          }
          observedTimerDuringWrite ||= hostTimerFired;
        },
        { writeChunkBytes },
      ),
      chunkStream(new Uint8Array(writeChunkBytes * writeCount)),
    );
    clearTimeout(timer);

    expect(observedTimerDuringWrite).toBe(true);
  });

  it('splits and coalesces arbitrary producer chunks into exact 188-byte awaited writes', async () => {
    const writeChunkBytes = 188;
    const truth = new Uint8Array(writeChunkBytes * 7);
    for (let i = 0; i < truth.byteLength; i++) truth[i] = i % 251;
    const producerChunks = [
      truth.subarray(0, 17),
      truth.subarray(17, 17 + 900),
      truth.subarray(917, 1001),
      truth.subarray(1001),
    ];
    const writes: { data: Uint8Array; position: number }[] = [];
    let outstanding = 0;
    let maximumOutstanding = 0;
    await writeToStreamTarget(
      toStreamTarget(
        async (chunk, position) => {
          outstanding++;
          maximumOutstanding = Math.max(maximumOutstanding, outstanding);
          await Promise.resolve();
          writes.push({ data: chunk.slice(), position });
          outstanding--;
        },
        { writeChunkBytes },
      ),
      chunkStream(...producerChunks),
    );

    expect(writes).toHaveLength(truth.byteLength / writeChunkBytes);
    expect(writes.every((write) => write.data.byteLength === writeChunkBytes)).toBe(true);
    expect(writes.map((write) => write.position)).toEqual(
      writes.map((_, index) => index * writeChunkBytes),
    );
    expect(maximumOutstanding).toBe(1);
    expect(Buffer.from(applyWrites(writes)).equals(Buffer.from(truth))).toBe(true);
  });

  it('uses the shaped manual pump for an append-only WritableStream', async () => {
    const writes: Uint8Array[] = [];
    const destination = new WritableStream<Uint8Array>({
      write(chunk): void {
        writes.push(chunk.slice());
      },
    });
    await writeToStreamTarget(
      toStreamTarget(destination, { writeChunkBytes: 4 }),
      bytesStream([1], [2, 3, 4, 5, 6, 7], [8]),
    );
    expect(writes.map((write) => [...write])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
  });

  it('rejects instead of emitting a short final or pre-seek write', async () => {
    const finalWrites: number[] = [];
    const finalError = await writeToStreamTarget(
      toStreamTarget(
        (chunk) => {
          finalWrites.push(chunk.byteLength);
        },
        { writeChunkBytes: 4 },
      ),
      bytesStream([1, 2, 3, 4, 5]),
    ).catch((error: unknown) => error);
    expect(finalWrites).toEqual([4]);
    expect(finalError).toBeInstanceOf(CapabilityError);
    expect((finalError as CapabilityError).message).toContain('1-byte partial write at end');

    const seekWrites: number[] = [];
    const seekError = await writeToStreamTarget(
      toStreamTarget(
        (chunk) => {
          seekWrites.push(chunk.byteLength);
        },
        { writeChunkBytes: 4 },
      ),
      chunkStream(new Uint8Array([1, 2]), positionedChunk(new Uint8Array([3, 4, 5, 6]), 12)),
    ).catch((error: unknown) => error);
    expect(seekWrites).toEqual([]);
    expect(seekError).toBeInstanceOf(CapabilityError);
    expect((seekError as CapabilityError).message).toContain(
      '2-byte partial write before a positioned discontinuity',
    );
  });
});

describe('chunked StreamTarget — write coalescing (doc 09 §5 item 7)', () => {
  it('coalesces tiny contiguous writes into chunkSize runs: same bytes, far fewer writes', async () => {
    const chunkSize = 256;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 64; i++) {
      const part = new Uint8Array(25);
      for (let j = 0; j < part.length; j++) part[j] = (i * part.length + j) % 251;
      parts.push(part);
    }
    const truth = applyWrites(parts.map((data, i) => ({ data, position: i * 25 })));

    const writes: { data: Uint8Array; position: number }[] = [];
    await writeToStreamTarget(
      toStreamTarget(
        (chunk, position) => {
          writes.push({ data: chunk.slice(), position });
        },
        { chunked: true, chunkSize },
      ),
      chunkStream(...parts),
    );

    // 64 × 25 B = 1600 B → ceil(1600/256) = 7 writes instead of 64 (sharply fewer).
    expect(writes.length).toBe(Math.ceil(truth.byteLength / chunkSize));
    for (const w of writes.slice(0, -1)) expect(w.data.byteLength).toBe(chunkSize);
    // Positions stay the producer's: contiguous runs starting at 0.
    expect(writes.map((w) => w.position)).toEqual(writes.map((_, i) => i * chunkSize));
    // Byte-exact oracle: reassembled output identical to the source bytes.
    expect([...applyWrites(writes)]).toEqual([...truth]);
  });

  it('bounds buffering to chunkSize: no emitted run exceeds it and a flush frees the buffer', async () => {
    const chunkSize = 128;
    const maxWrite: number[] = [];
    await writeToStreamTarget(
      toStreamTarget(
        (chunk) => {
          maxWrite.push(chunk.byteLength);
        },
        { chunked: true, chunkSize },
      ),
      chunkStream(new Uint8Array(100), new Uint8Array(100), new Uint8Array(50)),
    );
    expect(Math.max(...maxWrite)).toBeLessThanOrEqual(chunkSize);
    expect(maxWrite.reduce((a, b) => a + b, 0)).toBe(250);
  });

  it('passes an over-sized chunk straight through without re-buffering it', async () => {
    const chunkSize = 64;
    const big = new Uint8Array(3 * chunkSize + 7).fill(3);
    const writes: { data: Uint8Array; position: number }[] = [];
    await writeToStreamTarget(
      toStreamTarget(
        (chunk, position) => {
          writes.push({ data: chunk.slice(), position });
        },
        { chunked: true, chunkSize },
      ),
      chunkStream(new Uint8Array([1]).fill(1), big),
    );
    // The pending 1-byte run flushes on capacity, then the big chunk ships as one write.
    expect(writes.map((w) => w.data.byteLength)).toEqual([
      chunkSize,
      1 + big.byteLength - chunkSize,
    ]);
    expect([...applyWrites(writes)]).toEqual([1, ...big]);
  });

  it('ships a whole over-sized first chunk as one write (nothing pending, zero copies)', async () => {
    const chunkSize = 64;
    const big = new Uint8Array(2 * chunkSize).fill(7);
    const writes: { data: Uint8Array; position: number }[] = [];
    await writeToStreamTarget(
      toStreamTarget(
        (chunk, position) => {
          writes.push({ data: chunk.slice(), position });
        },
        { chunked: true, chunkSize },
      ),
      chunkStream(big),
    );
    expect(writes.map((w) => w.data.byteLength)).toEqual([big.byteLength]);
    expect(writes[0]?.position).toBe(0);
    expect([...applyWrites(writes)]).toEqual([...big]);
  });

  it('random-access WritableStream arm: a failing destination close surfaces a typed mux-error', async () => {
    const destination = Object.assign(
      new WritableStream<Uint8Array>({
        close(): void {
          throw new Error('close exploded');
        },
      }),
      { seek: (): Promise<void> => Promise.resolve() },
    ) as unknown as WritableStream<Uint8Array>;
    const err = await writeToStreamTarget(toStreamTarget(destination), bytesStream([1])).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).code).toBe('mux-error');
    expect((err as MediaError).message).toContain('close exploded');
  });

  it('a positioned discontinuity flushes the pending run and starts a new one at the target offset', async () => {
    const chunkSize = 1024;
    const writes: { data: Uint8Array; position: number }[] = [];
    await writeToStreamTarget(
      toStreamTarget(
        (chunk, position) => {
          writes.push({ data: chunk.slice(), position });
        },
        { chunked: true, chunkSize },
      ),
      chunkStream(
        new Uint8Array([9, 9, 9, 9]), // header placeholder at 0
        new Uint8Array([5, 6]), // body at 4
        positionedChunk(new Uint8Array([1, 2, 3, 4]), 0), // patch the header
      ),
    );
    expect(writes.map((w) => w.position)).toEqual([0, 0]); // run [0..6), then patch at 0
    expect(writes.map((w) => w.data.byteLength)).toEqual([6, 4]);
    expect([...applyWrites(writes)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('chunked append-only WritableStream: coalesced byte-exact output on a real corpus file', async () => {
    // The MPEG-TS shape: a real ~762 KiB TS segment produced as 188-byte packet writes — the exact
    // tiny-write pattern `chunked` exists for (streaming-output family, ts-live cases).
    const truth = await loadFixture('bear-1280x720.ts');
    const chunkSize = 2 ** 18;
    let unchunkedWrites = 0;
    const sourceAt = (granularity: number): ReadableStream<Uint8Array> => {
      let offset = 0;
      return new ReadableStream<Uint8Array>(
        {
          pull(c): void {
            if (offset >= truth.byteLength) {
              c.close();
              return;
            }
            const end = Math.min(offset + granularity, truth.byteLength);
            unchunkedWrites++;
            c.enqueue(truth.subarray(offset, end));
            offset = end;
          },
        },
        { highWaterMark: 0 },
      );
    };

    const collected: Uint8Array[] = [];
    let chunkedWrites = 0;
    const destination = new WritableStream<Uint8Array>({
      write(chunk): void {
        chunkedWrites++;
        collected.push(chunk.slice());
      },
    });
    await writeToStreamTarget(
      toStreamTarget(destination, { chunked: true, chunkSize }),
      sourceAt(188),
    );

    const out = applyWrites(
      collected.reduce<{ data: Uint8Array; position: number }[]>((acc, data) => {
        const position =
          acc.length === 0
            ? 0
            : (() => {
                const prev = acc[acc.length - 1] as { data: Uint8Array; position: number };
                return prev.position + prev.data.byteLength;
              })();
        acc.push({ data, position });
        return acc;
      }, []),
    );
    expect(out.byteLength).toBe(truth.byteLength);
    expect(Buffer.from(out).equals(Buffer.from(truth))).toBe(true); // bit-exact oracle
    expect(chunkedWrites).toBe(Math.ceil(truth.byteLength / chunkSize));
    expect(chunkedWrites * 8).toBeLessThan(unchunkedWrites); // sharply fewer targetWrites
  });
});
