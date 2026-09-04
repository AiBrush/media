/**
 * Frame-stream lifetime helpers for the public decode/encode surface (moved out of the `engine.ts`
 * god-file, R-S05.1). These own the close-exactly-once discipline for frames the engine *drops*:
 * `deferredStream` closes an in-flight frame on cancel or enqueue failure, `cancelStream`/`allOrCancel`
 * release the frames of streams an op will never consume. Backpressure is pull-driven
 * (`highWaterMark: 0`): a producer runs only when the consumer pulls.
 */

import { MediaError } from '../contracts/errors.ts';
import type { MediaStreams } from './types.ts';

/** Memoize an async loader so concurrent callers share exactly one in-flight promise. */
export { memoizeAsync } from '../util/memoize-async.ts';

/** Mirror an external `AbortSignal` onto an internal controller (pre-aborted or future abort). */
export function bridgeSignal(caller: AbortSignal | undefined, ctrl: AbortController): void {
  if (!caller) return;
  if (caller.aborted) ctrl.abort(caller.reason);
  else caller.addEventListener('abort', () => ctrl.abort(caller.reason), { once: true });
}

/**
 * Wrap an async producer of a `ReadableStream<T>` into an eager `ReadableStream<T>` whose underlying work
 * runs on first pull. Used by `decode` to honor its synchronous-return contract while the demux + codec
 * routing it needs are async. When the producer yields `undefined` (no such track) the stream is empty.
 * EOF/cancel releases the inner reader and producer closure immediately so source buffers can collect;
 * cancellation during async production also cancels the late stream before it can emit or leak a lock.
 */
export function deferredStream<T>(
  produce: () => Promise<ReadableStream<T> | undefined>,
): ReadableStream<T> {
  let producer: (() => Promise<ReadableStream<T> | undefined>) | undefined = produce;
  let reader: ReadableStreamDefaultReader<T> | undefined;
  let started = false;
  let cancelled = false;
  let cancelReason: unknown;
  const cancelAndRelease = async (
    active: ReadableStreamDefaultReader<T>,
    reason: unknown,
  ): Promise<void> => {
    if (reader === active) reader = undefined;
    try {
      await active.cancel(reason);
    } finally {
      active.releaseLock();
    }
  };
  return new ReadableStream<T>(
    {
      async pull(controller): Promise<void> {
        if (!started) {
          started = true;
          const start = producer;
          producer = undefined;
          const inner = await start?.();
          if (cancelled) {
            if (inner !== undefined) {
              await (await import('./deferred-stream-cleanup.ts')).default(
                inner,
                cancelReason,
                closeIfClosable,
              );
            }
            return;
          }
          if (inner === undefined) {
            controller.close();
            return;
          }
          reader = inner.getReader();
        }
        if (!reader) return;
        const active = reader;
        try {
          const { done, value } = await active.read();
          if (cancelled) {
            if (!done) closeIfClosable(value);
            return;
          }
          if (done) {
            if (reader === active) reader = undefined;
            active.releaseLock();
            controller.close();
            return;
          }
          try {
            controller.enqueue(value);
          } catch (error) {
            closeIfClosable(value);
            throw error;
          }
        } catch (error) {
          if (reader === active) await cancelAndRelease(active, error).catch(() => {});
          throw error;
        }
      },
      async cancel(reason): Promise<void> {
        cancelled = true;
        cancelReason = reason;
        producer = undefined;
        const active = reader;
        if (active !== undefined) await cancelAndRelease(active, reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

interface ClosableHandle {
  close(): void;
}

/** Close a dropped value when it exposes the WebCodecs `close()` contract (frame-lifetime discipline). */
export function closeIfClosable(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('close' in value)) return;
  const close = (value as { readonly close?: unknown }).close;
  if (typeof close === 'function') (close as ClosableHandle['close']).call(value);
}

/** Cancel a frame stream so its producer (a decoder/demuxer) releases any buffered frames. */
export async function cancelStream(stream: ReadableStream<unknown>): Promise<void> {
  await stream.cancel(new MediaError('aborted', 'stream not consumed')).catch(() => {});
}

/**
 * Await all encode tasks; if any rejects, cancel the *other* input frame streams so no in-flight frame
 * leaks, then surface the first error. Used by `encode` (caller-supplied `MediaStreams`).
 */
export async function allOrCancel(
  tasks: readonly Promise<void>[],
  frames: MediaStreams,
): Promise<void> {
  try {
    await Promise.all(tasks);
  } catch (e) {
    await Promise.all([
      frames.video ? cancelStream(frames.video) : Promise.resolve(),
      frames.audio ? cancelStream(frames.audio) : Promise.resolve(),
    ]);
    throw e;
  }
}
