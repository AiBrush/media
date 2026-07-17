/**
 * Shared byte-stream draining for drivers/sources that have proved they need a whole buffer. One
 * owned contiguous `Uint8Array` comes back; single-chunk streams return that chunk without copying.
 */

/** Drain a byte stream into one owned buffer, cancelling the reader on failure. */
export async function readByteStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  try {
    const first = await reader.read();
    if (first.done) return new Uint8Array(0);
    const second = await reader.read();
    if (second.done) return first.value;

    const chunks = [first.value, second.value];
    let total = first.value.byteLength + second.value.byteLength;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
