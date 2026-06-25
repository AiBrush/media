/**
 * `StreamTarget` — a streaming output sink (doc 07 §4 sinks, doc 09 streaming-output, ADR-013).
 *
 * The default `blob`/`file` sinks (`sink.ts`) collect the whole output into one buffer; that is fine for a
 * faststart MP4 but defeats a *streaming* producer (a fragmented/CMAF muxer, a long live recording) whose
 * point is bounded memory. A `StreamTarget` instead writes each produced chunk straight to a caller-owned
 * destination — a `WritableStream<Uint8Array>` (OPFS/`FileSystemWritableFileStream`, a `fetch` upload body,
 * a `TransformStream` tee) or a plain callback — as the chunk is produced, so peak memory stays at one
 * chunk regardless of the output's total size.
 *
 * This module is self-contained (it owns no shared sink state): it exports the descriptor, its
 * constructor, and the {@link writeToStreamTarget} materializer. The engine's `materialize` (`sink.ts`)
 * delegates a `stream-target` sink here; `to*` exposes {@link toStreamTarget}. Writing is built on the
 * executor's {@link runToSink} for the `WritableStream` case (cancellation + typed error mapping) and on a
 * cancellable pull loop for the callback case — both honour `signal` and surface a typed {@link MediaError}.
 */

import { MediaError } from '../contracts/errors.ts';
import type { ExecuteOptions } from '../kernel/executor.ts';
import { runToSink } from '../kernel/executor.ts';

/**
 * A position-aware chunk sink: each call receives the produced bytes and their byte offset from the start
 * of the output (chunks arrive in order, contiguous, starting at 0). The offset lets a random-access
 * destination (e.g. an OPFS `write({ type:'write', position, data })`) place bytes precisely even though a
 * pure streaming writer can ignore it. Returning a promise applies backpressure (the producer waits).
 */
export type StreamTargetWriter = (chunk: Uint8Array, position: number) => void | Promise<void>;

/**
 * The destination a {@link StreamTarget} writes to: either a standard `WritableStream<Uint8Array>` (piped
 * with native backpressure) or a {@link StreamTargetWriter} callback. A union, not an overloaded class, so
 * the descriptor stays a plain serializable value like every other {@link import('./sink.ts').Sink}.
 */
export type StreamDestination = WritableStream<Uint8Array> | StreamTargetWriter;

/** The streaming sink descriptor (the `stream-target` member of the engine's sink union). */
export interface StreamTarget {
  readonly kind: 'stream-target';
  readonly destination: StreamDestination;
}

/** Build a {@link StreamTarget} that writes each output chunk incrementally to `destination`. */
export function toStreamTarget(destination: StreamDestination): StreamTarget {
  return { kind: 'stream-target', destination };
}

/** Narrow a {@link StreamDestination} to the `WritableStream` arm (vs the callback arm). */
function isWritableStream(d: StreamDestination): d is WritableStream<Uint8Array> {
  // A callback is a function; a WritableStream is an object with a `getWriter` method. Feature-detect
  // rather than `instanceof` so a structurally-compatible writable (or a polyfill) is also accepted.
  return (
    typeof d !== 'function' && typeof (d as WritableStream<Uint8Array>).getWriter === 'function'
  );
}

/**
 * Drive a callback destination from the source readable: pull chunks in order and hand each to `write`
 * with its running byte position, awaiting the callback (backpressure). Cancels the reader on abort/throw
 * so the upstream pipeline tears down and releases resources; maps any failure to a typed error.
 */
async function writeToCallback(
  readable: ReadableStream<Uint8Array>,
  write: StreamTargetWriter,
  opts: ExecuteOptions,
): Promise<void> {
  const { signal } = opts;
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');

  const reader = readable.getReader();
  let position = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      const { done, value } = await reader.read();
      if (done) break;
      await write(value, position);
      position += value.byteLength;
    }
  } catch (err) {
    // Best-effort: release upstream; the original error is what we surface.
    await reader.cancel(err).catch(() => undefined);
    throw mapToMediaError(err, signal);
  }
  reader.releaseLock();
}

/**
 * Write a produced byte stream to a {@link StreamTarget}'s destination incrementally (never buffering the
 * whole output). Returns `undefined` — like the OPFS/element sinks — because the bytes went to the
 * caller-owned target rather than being handed back as a value.
 */
export async function writeToStreamTarget(
  target: StreamTarget,
  stream: ReadableStream<Uint8Array>,
  opts: ExecuteOptions = {},
): Promise<undefined> {
  const dest = target.destination;
  if (isWritableStream(dest)) {
    // Native pipe: backpressure + abort are handled by the streams runtime. Tag the stage with
    // `mux-error` so a destination-side write failure surfaces as a typed MediaError (runToSink passes
    // an abort through as `aborted` and an already-typed MediaError unchanged), matching the callback arm.
    await runToSink(stream, dest, { ...opts, errorCode: 'mux-error' });
    return undefined;
  }
  await writeToCallback(stream, dest, opts);
  return undefined;
}

/** Map a thrown value from the callback loop to the typed model (abort → `aborted`, else `mux-error`). */
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
