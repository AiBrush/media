/**
 * The executor (docs/architecture/06) — runs a planned stage graph as composed `TransformStream`s with
 * automatic backpressure, cooperative cancellation, progress, and typed error mapping. The web-streams
 * runtime keeps memory bounded (a slow encoder throttles the demuxer); cancellation propagates `cancel`
 * down the pipe so driver stages release their codec/substrate resources and `close()` in-flight
 * frames (§3). This layer names no tier and no implementation — stages are opaque transforms.
 */

import type { Progress } from '../contracts/driver.ts';
import { InputError, MediaError, type MediaErrorCode } from '../contracts/errors.ts';
import { closeFrames } from './frames.ts';

export interface ExecuteOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  /** Error code applied to an unexpected non-typed stage failure (the op supplies its own). */
  errorCode?: MediaErrorCode;
}

/**
 * Compose a source readable through an ordered list of **same-type** stage transforms (e.g. a variable
 * filter chain, `VideoFrame → VideoFrame`). Cross-type links (bytes → packets → frames → packets →
 * bytes) are fixed-arity and chained directly by the op with their concrete seam types.
 */
export function composeChain<T>(
  source: ReadableStream<T>,
  stages: readonly TransformStream<T, T>[],
): ReadableStream<T> {
  let out = source;
  for (const stage of stages) {
    out = out.pipeThrough(stage);
  }
  return out;
}

export interface LazyPipeThroughOptions<U> {
  /** Called if a downstream enqueue loses a cancellation/error race and the produced value owns resources. */
  closeValue?: (value: U) => void;
}

/**
 * Defer a `source.pipeThrough(createStage())` link until a downstream reader actually pulls. Native
 * `pipeThrough()` starts piping immediately; that is ideal for steady-state chains, but a live media graph
 * may need to finish composing downstream filters/encoders before an upstream decoder stage starts
 * draining packets. This wrapper preserves backpressure by reading at most one output item per downstream
 * pull.
 */
export function lazyPipeThrough<T, U>(
  source: ReadableStream<T>,
  createStage: () => TransformStream<T, U>,
  opts: LazyPipeThroughOptions<U> = {},
): ReadableStream<U> {
  let reader: ReadableStreamDefaultReader<U> | undefined;

  const ensureReader = (): ReadableStreamDefaultReader<U> => {
    if (reader !== undefined) return reader;
    reader = source.pipeThrough(createStage()).getReader();
    return reader;
  };

  return new ReadableStream<U>(
    {
      async pull(controller): Promise<void> {
        const active = ensureReader();
        const { done, value } = await active.read();
        if (done) {
          controller.close();
          return;
        }
        try {
          controller.enqueue(value);
        } catch (e) {
          opts.closeValue?.(value);
          throw e;
        }
      },
      async cancel(reason): Promise<void> {
        await reader?.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

// ── Batched packet drain (ADR-278) ──────────────────────────────────────────────────────────────

export interface PacketBatchOptions<T> {
  /** Maximum packets per delivered batch. Default 256 (ADR-278; larger breaks post-delivery abort). */
  readonly maxItems?: number;
  /** Maximum approximate payload bytes per delivered batch. Default 256 KiB (ADR-278). */
  readonly maxBytes?: number;
  /** Payload size of one item, counted against `maxBytes`; omit to bound by item count alone. */
  readonly byteLength?: (item: T) => number;
  readonly signal?: AbortSignal;
}

/**
 * Amortize a huge packet drain into zero-high-water-mark batches: each downstream `read()` pulls **one**
 * batch of at most `maxItems` / `maxBytes` (a single oversized item still ships alone — items are never
 * split). Because the output queue never buffers ahead (`highWaterMark: 0`), an abort or cancel after a
 * delivered batch stops **before** the next batch is assembled: the upstream is cancelled and nothing
 * further is delivered. If teardown strikes while a batch is in flight (mid-assembly abort or a lost
 * enqueue race), every buffered item is released via {@link closeFrames} so resource-owning packets or
 * frames are closed exactly once by their last owner.
 */
export function batchPackets<T>(
  source: ReadableStream<T> | Iterable<T>,
  opts: PacketBatchOptions<T> = {},
): ReadableStream<readonly T[]> {
  const maxItems = opts.maxItems ?? 256;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || !(maxBytes >= 1)) {
    throw new InputError('packet batch bounds must be positive');
  }
  const { byteLength, signal } = opts;
  const reader = source instanceof ReadableStream ? source.getReader() : undefined;
  const iterator = reader === undefined ? (source as Iterable<T>)[Symbol.iterator]() : undefined;
  // A function call (unlike a property read) is never control-flow-narrowed, so each check observes
  // the live abort state even after awaits.
  const aborted = (): boolean => signal?.aborted === true;
  let exhausted = false;

  const teardown = async (batch: T[], reason: unknown): Promise<void> => {
    closeFrames(batch.splice(0));
    if (reader !== undefined) await reader.cancel(reason).catch(() => undefined);
    else iterator?.return?.();
  };

  return new ReadableStream<readonly T[]>(
    {
      async pull(controller): Promise<void> {
        if (aborted()) {
          const error = abortedError();
          await teardown([], error);
          throw error;
        }
        const batch: T[] = [];
        let bytes = 0;
        try {
          while (batch.length < maxItems && bytes < maxBytes) {
            if (aborted()) throw abortedError();
            const next =
              reader !== undefined
                ? await raceAbort(reader.read(), signal)
                : (iterator as Iterator<T>).next();
            if (next.done === true) {
              exhausted = true;
              break;
            }
            batch.push(next.value);
            bytes += byteLength?.(next.value) ?? 0;
          }
        } catch (error) {
          await teardown(batch, error);
          throw mapError(error, signal);
        }
        if (batch.length > 0) {
          try {
            controller.enqueue(batch);
          } catch (error) {
            await teardown(batch, error);
            throw error;
          }
        }
        if (exhausted) controller.close();
      },
      async cancel(reason): Promise<void> {
        if (reader !== undefined) await reader.cancel(reason).catch(() => undefined);
        else iterator?.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}

// ── Cancellable op plumbing (shared by the chain/job orchestrators) ─────────────────────────────

/** A promise that also exposes cooperative `.cancel()` — the runtime's op-handle shape (ADR-012). */
export type CancellableTask<T> = Promise<T> & { cancel(): void };

export interface CancellableScope {
  /** The one linked signal every inner operation must receive. */
  readonly signal: AbortSignal;
  /**
   * Run one inner cancellable op: it is tracked so a linked abort re-cancels it (at most once per
   * dispatch), and the synchronous cancel-during-dispatch race — a hook aborting while the handle is
   * still being returned, before the abort listener can observe it — is closed explicitly.
   */
  dispatch<U>(op: CancellableTask<U>): Promise<U>;
}

/**
 * The one implementation of "a promise with `.cancel()` linked to parent signals plus an internal
 * `AbortController`, tracking the active inner op" (docs/architecture/execution-runtime §5 item 8).
 * Parent aborts mirror into the internal controller with their reason; `.cancel()` aborts it directly.
 * Every listener is removed once the run settles; `.cancel()` after settlement still re-cancels the last
 * tracked handle so a lazily-started inner runner is reached even post-resolution.
 */
export function runCancellable<T>(
  parents: readonly (AbortSignal | undefined)[],
  run: (scope: CancellableScope) => Promise<T>,
): CancellableTask<T> {
  const controller = new AbortController();
  const links: { readonly signal: AbortSignal; readonly onAbort: () => void }[] = [];
  let active: { cancel(): void } | undefined;
  let cancelled: { cancel(): void } | undefined;
  const cancelActive = (): void => {
    const current = active;
    if (current === undefined || current === cancelled) return;
    cancelled = current;
    try {
      current.cancel();
    } catch {
      // The linked abort remains the primary cancellation fact; a throwing cancel hook cannot mask it.
    }
  };
  const abortWith = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const parent of parents) {
    if (parent === undefined) continue;
    if (parent.aborted) {
      abortWith(parent.reason);
      break;
    }
    const onAbort = (): void => abortWith(parent.reason);
    parent.addEventListener('abort', onAbort, { once: true });
    links.push({ signal: parent, onAbort });
  }
  controller.signal.addEventListener('abort', cancelActive);
  const scope: CancellableScope = {
    signal: controller.signal,
    dispatch<U>(op: CancellableTask<U>): Promise<U> {
      cancelled = undefined;
      active = op;
      if (controller.signal.aborted) cancelActive();
      return Promise.resolve(op);
    },
  };
  const promise = (async (): Promise<T> => {
    try {
      return await run(scope);
    } finally {
      controller.signal.removeEventListener('abort', cancelActive);
      for (const link of links) link.signal.removeEventListener('abort', link.onAbort);
    }
  })() as CancellableTask<T>;
  promise.cancel = (): void => {
    abortWith(undefined);
    cancelActive();
  };
  return promise;
}

/** Collect a byte stream into one `Uint8Array` (the Blob/File sink path), honoring abort + progress. */
export async function collect(
  readable: ReadableStream<Uint8Array>,
  opts: ExecuteOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const { signal } = opts;
  if (signal?.aborted) {
    const error = abortedError();
    await readable.cancel(error).catch(() => undefined);
    throw error;
  }

  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      opts.onProgress?.({ done: total, stage: 'collect' });
    }
  } catch (e) {
    await safeCancel(reader, e);
    throw mapError(e, signal, opts.errorCode);
  }
  reader.releaseLock();
  return concat(chunks, total);
}

/** Pipe a readable into a writable sink with cancellation + typed error mapping. */
export async function runToSink(
  readable: ReadableStream<Uint8Array>,
  sink: WritableStream<Uint8Array>,
  opts: ExecuteOptions = {},
): Promise<void> {
  const { signal } = opts;
  if (signal?.aborted) {
    const error = abortedError();
    await Promise.all([
      readable.cancel(error).catch(() => undefined),
      sink.abort(error).catch(() => undefined),
    ]);
    throw error;
  }
  try {
    await readable.pipeTo(sink, signal ? { signal } : {});
  } catch (e) {
    throw mapError(e, signal, opts.errorCode);
  }
}

// ── Internals ───────────────────────────────────────────────────────────────────────────────────

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const only = chunks.length === 1 ? chunks[0] : undefined;
  if (only?.buffer instanceof ArrayBuffer && only.byteLength === only.buffer.byteLength) {
    return only as Uint8Array<ArrayBuffer>;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Reject as soon as `signal` aborts, otherwise settle with the wrapped promise. */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

async function safeCancel(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // Upstream already torn down — nothing further to release here.
  }
}

function abortedError(): MediaError {
  return new MediaError('aborted', 'operation aborted');
}

function isAbort(e: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError') ||
    (e instanceof Error && e.name === 'AbortError')
  );
}

/**
 * Map a thrown value to the typed model: abort → `aborted`; an existing {@link MediaError} passes
 * through; an unexpected value is wrapped with the op's `errorCode` when supplied, else rethrown
 * faithfully (never masked behind a wrong code).
 */
function mapError(
  e: unknown,
  signal: AbortSignal | undefined,
  errorCode?: MediaErrorCode,
): unknown {
  if (signal?.aborted || isAbort(e)) return abortedError();
  if (e instanceof MediaError) return e;
  if (errorCode !== undefined) {
    return new MediaError(errorCode, e instanceof Error ? e.message : String(e), e);
  }
  return e;
}
