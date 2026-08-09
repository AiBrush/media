/**
 * Offload input acquisition (doc 06 §4, punch-list 4/5; split out of `worker-host.ts`) — read a
 * {@link Source} to one exact-length byte run and turn it into the job's transferable input buffer with
 * **zero redundant copies**. Ownership provenance decides adopt-vs-copy: a buffer this module *allocated*
 * (the stream-concat run) is adopted directly as the transferable; a buffer *borrowed* from the source
 * (a `range()` result may alias the source's own backing store — `fromBytes().range()` returns a
 * subarray view of the caller's buffer) is always copied, because transferring it would **detach the
 * caller's source** and corrupt every later read. Shape alone (`byteOffset === 0 && exact length`) is not
 * sufficient — a whole-buffer borrowed view is shape-exact and still must not be adopted.
 */

import { InputError, MediaError } from '../contracts/errors.ts';
import type { Source } from '../sources/source.ts';

/** One exact-length read of a whole source, tagged with whether this module owns the backing buffer. */
export interface OwnedSourceBytes {
  readonly bytes: Uint8Array;
  /** True only when the backing buffer was freshly allocated here (safe to adopt for a transfer). */
  readonly owned: boolean;
}

/**
 * Read a whole source to a single byte run (honors abort; mirrors the engine's reader semantics: prefer
 * `range(0,size)` on a seekable source, else drain `stream()` into one exact-length buffer). The
 * `range` result is tagged **borrowed** (it may alias source-owned memory); the stream-concat result is
 * **owned** (allocated here). Deleting `worker-host.ts`'s duplicated `readAllSource` in favor of this
 * single reader is punch-list 5; folding it into the engine-wide S06 reader is that shard's seam.
 */
export async function readSourceOwned(
  src: Source,
  signal: AbortSignal | undefined,
  maximumBytes?: number,
): Promise<OwnedSourceBytes> {
  throwIfAborted(signal);
  assertMaximumReadBytes(maximumBytes);
  if (maximumBytes !== undefined && src.size !== undefined && src.size > maximumBytes) {
    throw sourceTooLarge(src.size, maximumBytes);
  }
  if (src.range && src.size !== undefined) {
    const bytes = await src.range(0, src.size, signal);
    throwIfAborted(signal);
    if (maximumBytes !== undefined && bytes.byteLength > maximumBytes) {
      throw sourceTooLarge(bytes.byteLength, maximumBytes);
    }
    return { bytes, owned: false };
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (maximumBytes !== undefined && value.byteLength > maximumBytes - total) {
        throw sourceTooLarge(total + value.byteLength, maximumBytes);
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (e) {
    await reader.cancel(e).catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  throwIfAborted(signal);
  return { bytes: out, owned: true };
}

function assertMaximumReadBytes(maximumBytes: number | undefined): void {
  if (maximumBytes !== undefined && (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)) {
    throw new InputError('maximum source byte limit must be a positive safe integer');
  }
}

function sourceTooLarge(observedBytes: number, maximumBytes: number): InputError {
  return new InputError(`source exceeds the ${maximumBytes}-byte operation limit`, {
    observedBytes,
    maximumBytes,
  });
}

/**
 * The job's transferable input for a read source: **adopt** the backing buffer when it is owned and
 * shape-exact (zero-copy — the 8 MiB streamed path allocates 8 MiB total, not 16, punch-list 4), else
 * an exact-length copy (a borrowed or offset view must never be transferred: transfer detaches). A
 * `SharedArrayBuffer` backing is copied into a plain `ArrayBuffer` — an SAB is not transferable at all.
 */
export function transferableInput({ bytes, owned }: OwnedSourceBytes): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (!(buffer instanceof ArrayBuffer)) {
    const copy = new ArrayBuffer(byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
  }
  if (owned && byteOffset === 0 && byteLength === buffer.byteLength) {
    return buffer; // zero-copy adopt: this module allocated it, nothing else aliases it
  }
  return buffer.slice(byteOffset, byteOffset + byteLength);
}

/** @throws a typed `aborted` {@link MediaError} when the signal has fired (never a bare DOMException). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation cancelled');
}
