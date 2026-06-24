/**
 * The executor (docs/architecture/06) — runs a planned stage graph as composed `TransformStream`s with
 * automatic backpressure, cooperative cancellation, progress, and typed error mapping. The web-streams
 * runtime keeps memory bounded (a slow encoder throttles the demuxer); cancellation propagates `cancel`
 * down the pipe so drivers release WebCodecs/WASM resources and `close()` in-flight frames (§3).
 */

import type { Progress } from '../contracts/driver.ts';
import { MediaError, type MediaErrorCode } from '../contracts/errors.ts';

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

/** Collect a byte stream into one `Uint8Array` (the Blob/File sink path), honoring abort + progress. */
export async function collect(
  readable: ReadableStream<Uint8Array>,
  opts: ExecuteOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const { signal } = opts;
  if (signal?.aborted) throw abortedError();

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
  if (signal?.aborted) throw abortedError();
  try {
    await readable.pipeTo(sink, signal ? { signal } : {});
  } catch (e) {
    throw mapError(e, signal, opts.errorCode);
  }
}

// ── Internals ───────────────────────────────────────────────────────────────────────────────────

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
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
