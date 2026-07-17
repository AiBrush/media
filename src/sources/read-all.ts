/**
 * The canonical whole-object read for the sources layer (docs/architecture/sources.md §5 item 5;
 * measured-evidence: one plain full read beats multi-pull concatenation). Every consumer that has
 * already proved it needs the complete finite object goes through {@link readAllBytes} instead of
 * hand-rolling a drain loop: it prefers the source's owned one-buffer `readAll`, then a single
 * full-window `range(0, size)`, and only then the generic abort-aware stream drain.
 */

import { readWithAbort, throwIfSourceAborted } from './abort.ts';

/**
 * The structural whole-read capability — the subset of a `Source` (and of the driver-facing byte
 * source) this helper needs. Deliberately transport-only: no brands, kinds, or backend names.
 */
export interface WholeReadable {
  readonly size?: number;
  stream(): ReadableStream<Uint8Array>;
  range?(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  readAll?(signal?: AbortSignal): Promise<Uint8Array>;
}

/** Read the complete object as one buffer via the cheapest capability the source offers. */
export async function readAllBytes(src: WholeReadable, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfSourceAborted(signal);
  if (src.readAll !== undefined) return src.readAll(signal);
  if (src.range !== undefined && src.size !== undefined) return src.range(0, src.size, signal);
  return drainStream(src.stream(), signal);
}

/** Drain a readable fully into one contiguous `Uint8Array`, cancelling the reader on abort/failure. */
export async function drainStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
