/**
 * `StreamTarget` drain — the lazily-loaded byte-writer seam (doc 07 §4 sinks, doc 09 streaming-output,
 * ADR-013). The public module (`stream-target.ts`) owns the descriptor + pure plan; this seam owns only
 * the drain paths, all sharing one **positioned pump** so every arm honors producer-intended offsets
 * ({@link chunkWritePosition}, doc 09 §5 item 2) and the opt-in run coalescer (doc 09 §5 item 7):
 *
 *  - **callback** — pull chunks in order, hand each to the writer with its intended position, `await`
 *    the returned promise (backpressure). The first invocation happens at the first produced chunk —
 *    the TTFB signal (doc 09 §5 item 5).
 *  - **random-access `WritableStream`** — a destination exposing OPFS-style `seek` (e.g.
 *    `FileSystemWritableFileStream`) is driven through a writer: contiguous chunks use plain
 *    cursor writes, a discontinuity uses an explicit `{ type: 'write', position, data }` per the WHATWG
 *    File System spec, so re-write-a-region producers (faststart patches) land bytes exactly.
 *  - **append-only `WritableStream`** — the native `pipeTo` path (streams-runtime backpressure +
 *    cancellation) through a position guard that raises a typed `CapabilityError` if a producer asks
 *    for a non-contiguous write the destination cannot honor — never a silent wrong offset. With
 *    write shaping on, the manual pump replaces `pipeTo` so runs can coalesce/split before each write.
 *
 * Every arm honours `signal` (each await is abort-raced so a stalled producer/writer cannot pin the op),
 * cancels the source reader on failure, aborts a held destination writer, and surfaces typed errors.
 * The one OPFS seam (`opfs-target-materialize.ts`) reuses {@link drainToRandomAccessWritable} with the
 * plan's `startPosition` as the base offset, so there is exactly one positioned byte pump.
 */

import { CapabilityError, MediaError } from '../contracts/errors.ts';
import type { ExecuteOptions } from '../kernel/executor.ts';
import { runToSink } from '../kernel/executor.ts';
import type {
  StreamDestination,
  StreamTarget,
  StreamTargetWritePlan,
  StreamTargetWriter,
} from './stream-target.ts';
import { chunkWritePosition, planStreamTargetWrite } from './stream-target.ts';

/** Narrow a {@link StreamDestination} to the `WritableStream` arm (vs the callback arm). */
function isWritableStream(d: unknown): d is WritableStream<Uint8Array> {
  // A callback is a function; a WritableStream is an object with a `getWriter` method. Feature-detect
  // rather than `instanceof` so a structurally-compatible writable (or a polyfill) is also accepted.
  return (
    typeof d === 'object' &&
    d !== null &&
    typeof (d as { getWriter?: unknown }).getWriter === 'function'
  );
}

function isStreamTargetWriter(d: unknown): d is StreamTargetWriter {
  return typeof d === 'function';
}

/**
 * True when the destination is random-access: it exposes the WHATWG File System `seek(position)`
 * surface (`FileSystemWritableFileStream`), so positioned writes can be honored.
 */
function isRandomAccessWritable(d: WritableStream<Uint8Array>): boolean {
  return typeof (d as { seek?: unknown }).seek === 'function';
}

/** An explicit positioned write per the WHATWG File System `WriteParams` dictionary. */
interface PositionedWriteParams {
  readonly type: 'write';
  readonly position: number;
  readonly data: Uint8Array;
}

/**
 * The no-coalescing plan for drains that take a {@link StreamTargetWritePlan} but have no `chunked`
 * knob (the OPFS seam — a local file write has no per-write overhead worth buffering for). The
 * `chunkSize` is inert while `chunked` is false.
 */
export const UNCHUNKED_WRITE_PLAN: StreamTargetWritePlan = { chunked: false, chunkSize: 1 };

/** The writer view of a random-access destination: plain bytes or explicit positioned writes. */
type RandomAccessWriter = WritableStreamDefaultWriter<Uint8Array | PositionedWriteParams>;

/** Runtime-validate the descriptor before pulling from the produced byte stream. */
function streamDestinationOf(target: StreamTarget): StreamDestination {
  const destination = (target as { readonly destination?: unknown }).destination;
  if (isStreamTargetWriter(destination) || isWritableStream(destination)) return destination;
  throw new CapabilityError(
    'stream-target destination must be a WritableStream<Uint8Array> or a callback writer',
    { op: { kind: 'route', id: 'stream-target' }, tried: [] },
  );
}

function abortedError(): MediaError {
  return new MediaError('aborted', 'operation aborted');
}

/** The typed miss for a positioned write an append-only destination cannot land (doc 09 §5 item 2). */
function appendOnlyPositionMiss(position: number, appendPosition: number): CapabilityError {
  return new CapabilityError(
    `append-only stream-target destination cannot honor a positioned write at byte ${position} (append cursor is at ${appendPosition}); use a seekable destination (OPFS) or a callback writer`,
    {
      op: { kind: 'route', id: 'stream-target', facts: { position, appendPosition } },
      tried: [],
    },
  );
}

/** Race one async step against cancellation so a stalled producer/writer cannot pin the op forever. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * One positioned write reaching the destination. `appendPosition` is the destination's current cursor
 * (the offset a plain append would land at); `position === appendPosition` is the contiguous common
 * case, letting writer arms keep plain cursor writes and name the real cursor in a typed miss.
 */
type EmitWrite = (
  data: Uint8Array,
  position: number,
  appendPosition: number,
) => void | Promise<void>;

type DeliverWrite = (data: Uint8Array, position: number) => void | Promise<void>;

const EXACT_WRITE_YIELD_CHECK_INTERVAL = 64;
const EXACT_WRITE_TASK_BUDGET_MS = 8;

function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function yieldToHostTask(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Coalesce contiguous writes into ≥`chunkSize` runs (doc 09 §5 item 7, mediabunny `chunked` parity).
 * A positioned discontinuity flushes the pending run (a run never spans a seek); a chunk at least one
 * whole run long bypasses the copy and ships directly. Peak buffering: one `chunkSize` buffer + the
 * produced chunk in flight. The emitted view is a fresh buffer per run — never reused after delivery.
 */
class RunCoalescer {
  readonly #chunkSize: number;
  readonly #deliver: DeliverWrite;
  #buffer: Uint8Array | undefined;
  #filled = 0;
  #runStart = 0;

  constructor(chunkSize: number, deliver: DeliverWrite) {
    this.#chunkSize = chunkSize;
    this.#deliver = deliver;
  }

  /** The offset an untagged chunk lands at: the end of the pending run, else the delivered cursor. */
  nextPosition(cursor: number): number {
    return this.#buffer === undefined ? cursor : this.#runStart + this.#filled;
  }

  async push(data: Uint8Array, intended: number): Promise<void> {
    if (this.#buffer !== undefined && intended !== this.#runStart + this.#filled) {
      await this.flush(); // a coalesced run never spans a positioned jump
    }
    let offset = 0;
    let position = intended;
    while (offset < data.byteLength) {
      if (this.#buffer === undefined) {
        const remaining = data.byteLength - offset;
        if (remaining >= this.#chunkSize) {
          // Nothing pending and at least one whole run in hand: ship it without re-buffering.
          const pending = this.#deliver(offset === 0 ? data : data.subarray(offset), position);
          if (pending !== undefined) await pending;
          return;
        }
        this.#buffer = new Uint8Array(this.#chunkSize);
        this.#filled = 0;
        this.#runStart = position;
      }
      const take = Math.min(this.#chunkSize - this.#filled, data.byteLength - offset);
      this.#buffer.set(data.subarray(offset, offset + take), this.#filled);
      this.#filled += take;
      offset += take;
      position += take;
      if (this.#filled === this.#chunkSize) await this.flush();
    }
  }

  async flush(): Promise<void> {
    const buffer = this.#buffer;
    if (buffer === undefined) return;
    // Invariant: a run buffer is only allocated immediately before ≥1 byte is copied in, so a pending
    // run is never empty — flushing always delivers.
    const run = buffer.subarray(0, this.#filled);
    const start = this.#runStart;
    this.#buffer = undefined; // downstream owns the emitted view; a new run allocates fresh
    this.#filled = 0;
    const pending = this.#deliver(run, start);
    if (pending !== undefined) await pending;
  }

  finish(): Promise<void> {
    return this.flush();
  }
}

/** A destination-write shaper shared by the coalescing and exact-size modes. */
interface WriteShaper {
  nextPosition(cursor: number): number;
  push(data: Uint8Array, intended: number): Promise<void>;
  finish(): Promise<void>;
}

/**
 * Split/coalesce one contiguous producer run into exact `writeBytes` destination writes. Unlike
 * `RunCoalescer`, an oversized input never bypasses the shaper: aligned subviews are delivered one at
 * a time and the tail is retained. A short run cannot satisfy an exact-write contract, so finalization
 * (or a positioned discontinuity) rejects rather than emitting a knowingly non-conforming write.
 */
class ExactWriteShaper implements WriteShaper {
  readonly #writeBytes: number;
  readonly #deliver: DeliverWrite;
  #buffer: Uint8Array | undefined;
  #filled = 0;
  #runStart = 0;
  #writesSinceYieldCheck = 0;
  #taskStartedAt = monotonicNow();

  constructor(writeBytes: number, deliver: DeliverWrite) {
    this.#writeBytes = writeBytes;
    this.#deliver = deliver;
  }

  nextPosition(cursor: number): number {
    return this.#buffer === undefined ? cursor : this.#runStart + this.#filled;
  }

  async push(data: Uint8Array, intended: number): Promise<void> {
    if (this.#buffer !== undefined && intended !== this.#runStart + this.#filled) {
      throw this.#partialRunError('before a positioned discontinuity');
    }

    let offset = 0;
    let position = intended;
    while (offset < data.byteLength) {
      if (this.#buffer === undefined) {
        const remaining = data.byteLength - offset;
        if (remaining >= this.#writeBytes) {
          const exact = data.subarray(offset, offset + this.#writeBytes);
          // A synchronous callback is genuine immediate acceptance, not missing backpressure. Avoid
          // manufacturing one promise/microtask per exact write: a 30 MiB transport stream contains
          // roughly 170,000 188-byte packets, which can otherwise starve Firefox for minutes. Async
          // callbacks still stop the pump at every returned promise.
          const pending = this.#deliver(exact, position);
          if (pending !== undefined) await pending;
          const taskYield = this.#yieldIfTaskBudgetSpent();
          if (taskYield !== undefined) await taskYield;
          offset += this.#writeBytes;
          position += this.#writeBytes;
          continue;
        }
        this.#buffer = new Uint8Array(this.#writeBytes);
        this.#filled = 0;
        this.#runStart = position;
      }

      const take = Math.min(this.#writeBytes - this.#filled, data.byteLength - offset);
      this.#buffer.set(data.subarray(offset, offset + take), this.#filled);
      this.#filled += take;
      offset += take;
      position += take;
      if (this.#filled === this.#writeBytes) {
        const pending = this.#flushExact();
        if (pending !== undefined) await pending;
      }
    }
  }

  async finish(): Promise<void> {
    if (this.#buffer !== undefined) throw this.#partialRunError('at end of output');
  }

  #flushExact(): void | Promise<void> {
    const buffer = this.#buffer;
    if (buffer === undefined || this.#filled !== this.#writeBytes) return;
    const start = this.#runStart;
    this.#buffer = undefined;
    this.#filled = 0;
    return this.#deliver(buffer, start);
  }

  #partialRunError(where: string): CapabilityError {
    return new CapabilityError(
      `stream-target writeChunkBytes=${this.#writeBytes} cannot emit the ${this.#filled}-byte partial write ${where}; output runs must be exact multiples of ${this.#writeBytes} bytes`,
      {
        op: {
          kind: 'route',
          id: 'stream-target-exact-writes',
          facts: { writeChunkBytes: this.#writeBytes, partialBytes: this.#filled },
        },
        tried: [],
      },
    );
  }

  #yieldIfTaskBudgetSpent(): void | Promise<void> {
    this.#writesSinceYieldCheck++;
    if (this.#writesSinceYieldCheck < EXACT_WRITE_YIELD_CHECK_INTERVAL) return;
    this.#writesSinceYieldCheck = 0;
    if (monotonicNow() - this.#taskStartedAt < EXACT_WRITE_TASK_BUDGET_MS) return;
    return yieldToHostTask().then(() => {
      this.#taskStartedAt = monotonicNow();
    });
  }
}

/**
 * The one positioned byte pump every arm shares: pull chunks in order, resolve each chunk's intended
 * offset (tag ⇒ `basePosition + tag`; untagged ⇒ end of the previous write), optionally coalesce, and
 * emit. Cancels the reader on abort/throw so the upstream pipeline tears down; maps failures to typed
 * errors. Backpressure is one chunk in flight — each `emit` is awaited before the next pull.
 */
async function drainPositioned(
  readable: ReadableStream<Uint8Array>,
  emit: EmitWrite,
  opts: ExecuteOptions,
  plan: StreamTargetWritePlan,
  basePosition: number,
): Promise<void> {
  const { signal } = opts;
  if (signal?.aborted) throw abortedError();

  const reader = readable.getReader();
  let cursor = basePosition;
  const deliver: DeliverWrite = (data, position) => {
    const pending = emit(data, position, cursor);
    if (pending === undefined) {
      cursor = position + data.byteLength;
      return;
    }
    return pending.then(() => {
      cursor = position + data.byteLength;
    });
  };
  const shaper: WriteShaper | undefined =
    plan.writeChunkBytes !== undefined
      ? new ExactWriteShaper(plan.writeChunkBytes, deliver)
      : plan.chunked
        ? new RunCoalescer(plan.chunkSize, deliver)
        : undefined;
  try {
    for (;;) {
      if (signal?.aborted) throw abortedError();
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      if (value.byteLength === 0) continue;
      const tag = chunkWritePosition(value);
      const intended =
        tag !== undefined
          ? basePosition + tag
          : shaper !== undefined
            ? shaper.nextPosition(cursor)
            : cursor;
      if (shaper !== undefined) await shaper.push(value, intended);
      else await deliver(value, intended);
    }
    await shaper?.finish();
  } catch (err) {
    // Await upstream cleanup, but preserve the primary typed failure if cancellation itself rejects.
    await reader.cancel(err).catch(() => undefined);
    throw mapToMediaError(err, signal);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read can still be unwinding after an abort-race; cancellation above owns cleanup.
    }
  }
}

/** The callback arm's emitter: hand the chunk + intended position to the writer and await it. */
function emitToCallback(write: StreamTargetWriter, signal: AbortSignal | undefined): EmitWrite {
  return (data, position) => {
    const pending = write(data, position);
    if (pending === undefined) {
      if (signal?.aborted) throw abortedError();
      return;
    }
    return raceAbort(Promise.resolve(pending), signal);
  };
}

/**
 * Drive a destination `WritableStream` through a held writer with the positioned pump: on success the
 * destination is closed (committing e.g. an OPFS file), on any failure it is aborted so a half-written
 * output is discarded rather than left looking complete.
 */
async function drainThroughWriter(
  readable: ReadableStream<Uint8Array>,
  writer: RandomAccessWriter,
  emit: EmitWrite,
  opts: ExecuteOptions,
  plan: StreamTargetWritePlan,
  basePosition: number,
): Promise<void> {
  try {
    await drainPositioned(readable, emit, opts, plan, basePosition);
    await raceAbort(writer.close(), opts.signal);
  } catch (err) {
    await writer.abort(err).catch(() => undefined);
    throw mapToMediaError(err, opts.signal);
  } finally {
    writer.releaseLock();
  }
}

/**
 * Drain into a random-access writable (OPFS-style `seek` present): contiguous chunks stay plain cursor
 * writes; a discontinuity becomes an explicit positioned `WriteParams` write. Exported for the OPFS
 * seam (`opfs-target-materialize.ts`), which passes its plan's `startPosition` as the base offset.
 */
export async function drainToRandomAccessWritable(
  readable: ReadableStream<Uint8Array>,
  destination: WritableStream<Uint8Array>,
  opts: ExecuteOptions,
  plan: StreamTargetWritePlan,
  basePosition = 0,
): Promise<void> {
  const writer = (
    destination as unknown as WritableStream<Uint8Array | PositionedWriteParams>
  ).getWriter();
  const emit: EmitWrite = async (data, position, appendPosition) => {
    await raceAbort(
      position === appendPosition
        ? writer.write(data)
        : writer.write({ type: 'write', position, data }),
      opts.signal,
    );
  };
  await drainThroughWriter(readable, writer, emit, opts, plan, basePosition);
}

/** Drain into an append-only writable with coalescing: plain writes, discontinuities are a typed miss. */
async function drainToAppendOnlyWritable(
  readable: ReadableStream<Uint8Array>,
  destination: WritableStream<Uint8Array>,
  opts: ExecuteOptions,
  plan: StreamTargetWritePlan,
): Promise<void> {
  const writer = destination.getWriter() as RandomAccessWriter;
  const emit: EmitWrite = async (data, position, appendPosition) => {
    if (position !== appendPosition) throw appendOnlyPositionMiss(position, appendPosition);
    await raceAbort(writer.write(data), opts.signal);
  };
  await drainThroughWriter(readable, writer, emit, opts, plan, 0);
}

/**
 * The append-only `pipeTo` guard: an identity transform that verifies every tagged chunk is contiguous
 * with the append cursor, erroring the pipe (and cancelling the source) with a typed `CapabilityError`
 * on a positioned write the destination cannot honor — bytes never silently land at the wrong offset.
 */
function appendPositionGuard(): TransformStream<Uint8Array, Uint8Array> {
  let cursor = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller): void {
      const tag = chunkWritePosition(chunk);
      if (tag !== undefined && tag !== cursor) throw appendOnlyPositionMiss(tag, cursor);
      cursor += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

/**
 * Write a produced byte stream to a {@link StreamTarget}'s destination incrementally (never buffering
 * the whole output). Returns `undefined` — like the OPFS/element sinks — because the bytes went to the
 * caller-owned target rather than being handed back as a value.
 */
export async function writeToStreamTarget(
  target: StreamTarget,
  stream: ReadableStream<Uint8Array>,
  opts: ExecuteOptions = {},
): Promise<undefined> {
  const dest = streamDestinationOf(target);
  const plan = planStreamTargetWrite(target); // pure validation before any pull (InputError on bad options)
  if (isWritableStream(dest)) {
    if (isRandomAccessWritable(dest)) {
      await drainToRandomAccessWritable(stream, dest, opts, plan);
      return undefined;
    }
    if (plan.chunked || plan.writeChunkBytes !== undefined) {
      await drainToAppendOnlyWritable(stream, dest, opts, plan);
      return undefined;
    }
    // Native pipe for the plain append case: backpressure + abort are handled by the streams runtime.
    // Tag the stage with `mux-error` so a destination-side write failure surfaces as a typed MediaError
    // (runToSink passes an abort through as `aborted` and an already-typed MediaError unchanged).
    await runToSink(stream.pipeThrough(appendPositionGuard()), dest, {
      ...opts,
      errorCode: 'mux-error',
    });
    return undefined;
  }
  await drainPositioned(stream, emitToCallback(dest, opts.signal), opts, plan, 0);
  return undefined;
}

/** Map a thrown value from a drain arm to the typed model (abort → `aborted`, else `mux-error`). */
function mapToMediaError(err: unknown, signal: AbortSignal | undefined): MediaError {
  if (signal?.aborted) return new MediaError('aborted', 'operation aborted');
  if (err instanceof MediaError) return err;
  const isAbort =
    (typeof DOMException !== 'undefined' &&
      err instanceof DOMException &&
      err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError');
  if (isAbort) return new MediaError('aborted', 'operation aborted');
  return new MediaError('mux-error', err instanceof Error ? err.message : String(err), err);
}
