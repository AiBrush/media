import type { ByteSource, DecryptParams } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { hexToBytes } from '../../crypto/aes.ts';
import { decryptHlsSampleAesTs } from '../../crypto/hls-aes.ts';

function abortedError(): MediaError {
  return new MediaError('aborted', 'operation aborted');
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

async function readAll(src: ByteSource, signal: AbortSignal | undefined): Promise<Uint8Array> {
  assertNotAborted(signal);
  if (src.range && src.size !== undefined) {
    const bytes = await src.range(0, src.size);
    assertNotAborted(signal);
    return bytes;
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    void reader.cancel(abortedError()).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      assertNotAborted(signal);
      const { done, value } = await reader.read();
      assertNotAborted(signal);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assertNotAborted(signal);
  return out;
}

function oneShot(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function decryptMpegTsSampleAes(
  src: ByteSource,
  o: DecryptParams,
): Promise<ReadableStream<Uint8Array>> {
  if (o.scheme !== 'hls-sample-aes') {
    throw new CapabilityError('capability-miss', `bad TS decrypt '${o.scheme}'`, {
      op: 'decrypt',
      tried: ['mpegts'],
    });
  }
  const { key, iv } = o.keys;
  if (key === undefined || iv === undefined) {
    throw new CapabilityError('capability-miss', 'need key/iv hex', {
      op: 'decrypt',
      tried: ['mpegts'],
    });
  }
  const clear = await decryptHlsSampleAesTs(
    await readAll(src, o.signal),
    hexToBytes(key),
    hexToBytes(iv),
  );
  assertNotAborted(o.signal);
  return oneShot(clear);
}
