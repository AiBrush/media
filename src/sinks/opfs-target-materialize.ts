/**
 * `OpfsTarget` drain — the lazily-loaded File System seam (doc 09 streaming-output §3, ADR-013),
 * mirroring `stream-target-materialize.ts` in the two-file descriptor+seam convention (doc 09 §5
 * item 9). The public module (`opfs-target.ts`) has already validated the path/options into an
 * {@link OpfsWritePlan} and proved the capability; this seam only performs the I/O:
 *
 *  1. walk/create the parent directories and open the file handle;
 *  2. `createWritable({ keepExistingData })` and `seek(startPosition)` for a positioned patch write;
 *  3. drive the shared positioned pump ({@link drainToRandomAccessWritable}) with the plan's
 *     `startPosition` as the base offset, so producer-positioned re-writes
 *     ({@link import('./stream-target.ts').positionedChunk}) land at `startPosition + tag` and plain
 *     chunks append with one-chunk-in-flight backpressure;
 *  4. on success the writable is closed (OPFS commits on close); on abort or any failure it is aborted,
 *     so a half-written file is discarded rather than left looking complete, and the rejection is a
 *     typed {@link MediaError}.
 *
 * Every setup step is abort-raced so a stalled directory walk cannot pin a cancelled op. The seam is
 * exercised in Node against recording doubles of the WHATWG File System shapes; the real-browser OPFS
 * run is the parent-session browser gate (ADR-025).
 */

import { MediaError } from '../contracts/errors.ts';
import type { ExecuteOptions } from '../kernel/executor.ts';
import type { OpfsWritePlan } from './opfs-target.ts';
import { UNCHUNKED_WRITE_PLAN, drainToRandomAccessWritable } from './stream-target-materialize.ts';

function abortedError(): MediaError {
  return new MediaError('aborted', 'operation aborted');
}

/** Race one setup step against cancellation so a stalled handle walk cannot pin the op forever. */
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
 * Execute an {@link OpfsWritePlan}: open the target file under `storage` and stream `stream` into it
 * via the shared positioned pump. Returns `undefined` — the bytes went to the file.
 */
export async function writeToOpfsFile(
  storage: StorageManager,
  plan: OpfsWritePlan,
  stream: ReadableStream<Uint8Array>,
  opts: ExecuteOptions,
): Promise<undefined> {
  const { signal } = opts;
  let writable: FileSystemWritableFileStream | undefined;
  try {
    let dir = await raceAbort(storage.getDirectory(), signal);
    for (const segment of plan.dirs) {
      dir = await raceAbort(dir.getDirectoryHandle(segment, { create: true }), signal);
    }
    const handle = await raceAbort(dir.getFileHandle(plan.name, { create: true }), signal);
    writable = await raceAbort(
      handle.createWritable({ keepExistingData: plan.keepExistingData }),
      signal,
    );
    if (plan.startPosition > 0) await raceAbort(writable.seek(plan.startPosition), signal);

    // The shared positioned pump: producer tags are relative to the output, so the plan's start
    // position is the base; the pump closes the writable on success and aborts its writer on failure.
    await drainToRandomAccessWritable(
      stream,
      writable,
      opts,
      UNCHUNKED_WRITE_PLAN,
      plan.startPosition,
    );
    return undefined;
  } catch (err) {
    // Abort the writable so a half-written file is discarded rather than left looking complete. After
    // the pump has aborted its held writer this is a spec-level no-op (aborting an errored stream
    // resolves), so the file can never be double-committed.
    if (writable !== undefined && !writable.locked) await writable.abort().catch(() => undefined);
    throw mapOpfsError(err, signal);
  }
}

/** Map a thrown value from the OPFS seam to the typed model (abort → `aborted`, else `mux-error`). */
function mapOpfsError(err: unknown, signal: AbortSignal | undefined): MediaError {
  if (signal?.aborted) return new MediaError('aborted', 'operation aborted');
  if (err instanceof MediaError) return err;
  const isAbort =
    (typeof DOMException !== 'undefined' &&
      err instanceof DOMException &&
      (err.name === 'AbortError' || err.name === 'NotAllowedError')) ||
    (err instanceof Error && err.name === 'AbortError');
  if (isAbort) return new MediaError('aborted', 'operation aborted');
  return new MediaError('mux-error', err instanceof Error ? err.message : String(err), err);
}
