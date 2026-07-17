/**
 * Shared abort plumbing for every source read path (docs/architecture/sources.md §3.4 "Cancel";
 * WHATWG DOM `AbortSignal`). One definition of "fail as a typed `MediaError('aborted')`" so
 * `range()`, `readAll()`, stream drains, and the one-shot cursor all reject identically, reuse a
 * caller-supplied `MediaError` abort reason instead of double-wrapping it, and stay safe against
 * transports that ignore their `AbortSignal`.
 */

import { MediaError } from '../contracts/errors.ts';

/** The typed abort error for `signal`, reusing a caller-provided `MediaError('aborted')` reason. */
export function sourceAbortError(signal: AbortSignal): MediaError {
  return signal.reason instanceof MediaError && signal.reason.code === 'aborted'
    ? signal.reason
    : new MediaError('aborted', 'source read aborted', signal.reason);
}

/** Throw the typed abort error when `signal` is already aborted. */
export function throwIfSourceAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw sourceAbortError(signal);
}

/**
 * Await `promise`, rejecting with a typed `MediaError('aborted')` the moment `signal` aborts —
 * even when the underlying transport ignores its abort signal — and normalizing a transport's own
 * abort rejection (e.g. a `DOMException` from `fetch`) to the same typed error. The losing promise
 * is muted so a late transport rejection never surfaces as an unhandled rejection.
 */
export async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise;
  throwIfSourceAborted(signal);
  let removeListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      promise.catch(() => {}); // mute the losing transport promise
      reject(sourceAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    removeListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } catch (error) {
    // Abort wins deterministically: a transport's own (untyped) abort rejection may settle first.
    throw !(error instanceof MediaError) && signal.aborted ? sourceAbortError(signal) : error;
  } finally {
    removeListener?.();
  }
}

/** One reader `read()` raced against `signal` (the reader itself is not cancelled here). */
export function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  if (signal === undefined) return reader.read();
  return raceAbort(reader.read(), signal);
}
