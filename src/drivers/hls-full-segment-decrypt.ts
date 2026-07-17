/** Shared, abort-aware HLS AES-128 full-segment decrypt for concrete byte-container drivers. */

import type { ByteSource, DecryptParams } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { hexToBytes } from '../crypto/aes.ts';
import { decryptHlsAes128 } from '../crypto/hls-aes.ts';

export interface HlsAes128ContainerValidation {
  readonly driverId: string;
  readonly containerLabel: string;
  readonly validate: (clear: Uint8Array) => void | Promise<void>;
}

/** Construct the one typed cancellation error used before, during, and after the WebCrypto operation. */
export function hlsSegmentAbortedError(): MediaError {
  return new MediaError('aborted', 'operation aborted');
}

/** Fail immediately when a direct segment operation has been cancelled. */
export function assertHlsSegmentNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw hlsSegmentAbortedError();
}

function sourceReadError(error: unknown): MediaError {
  if (error instanceof MediaError) return error;
  return new InputError('failed to read the encrypted HLS segment', error);
}

/**
 * Drain one finite HLS segment. A stream abort cancels the active reader and every exit releases its lock;
 * a seekable source uses its single exact range without opening a redundant stream.
 */
export async function readHlsSegment(
  source: ByteSource,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  assertHlsSegmentNotAborted(signal);
  if (source.range !== undefined && source.size !== undefined) {
    if (!Number.isSafeInteger(source.size) || source.size < 0) {
      throw new InputError(`invalid HLS segment size ${source.size}`);
    }
    try {
      const bytes = await source.range(0, source.size);
      assertHlsSegmentNotAborted(signal);
      return bytes;
    } catch (error) {
      if (signal?.aborted) throw hlsSegmentAbortedError();
      throw sourceReadError(error);
    }
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = source.stream().getReader();
  } catch (error) {
    throw sourceReadError(error);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    void reader.cancel(hlsSegmentAbortedError()).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      assertHlsSegmentNotAborted(signal);
      const next = await reader.read();
      assertHlsSegmentNotAborted(signal);
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
      if (!Number.isSafeInteger(total)) {
        throw new InputError('HLS segment is too large to materialize safely');
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    if (signal?.aborted) throw hlsSegmentAbortedError();
    throw sourceReadError(error);
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
  assertHlsSegmentNotAborted(signal);
  return out;
}

/** Expose a materialized segment only when the consumer requests it; cancel-before-pull releases bytes. */
export function demandDrivenSegmentStream(
  segment: Uint8Array,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        if (signal?.aborted) {
          segment.fill(0);
          controller.error(hlsSegmentAbortedError());
          return;
        }
        controller.enqueue(segment);
        controller.close();
      },
      cancel(): void {
        segment.fill(0);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Wipe recovered plaintext before raising cancellation when output ownership has not transferred. */
export function assertHlsSegmentClearNotAborted(
  clear: Uint8Array,
  signal: AbortSignal | undefined,
): void {
  if (!signal?.aborted) return;
  clear.fill(0);
  throw hlsSegmentAbortedError();
}

function requiredKeyField(
  keys: Record<string, string>,
  field: 'key' | 'iv',
  driverId: string,
): Uint8Array<ArrayBuffer> {
  const value = keys[field];
  if (value === undefined) {
    throw new CapabilityError(`HLS AES-128 needs '${field}' (hex) in keys; none provided`, {
      op: { kind: 'route', id: 'decrypt' },
      tried: [driverId],
    });
  }
  return hexToBytes(value);
}

/**
 * Decrypt one caller-hinted AES-128 segment and require the recovered bytes to be the selected container
 * before any output is exposed. AES-128 and SAMPLE-AES dispatch remain the responsibility of the driver.
 */
export async function decryptHlsAes128ContainerSegment(
  source: ByteSource,
  options: DecryptParams,
  validation: HlsAes128ContainerValidation,
): Promise<ReadableStream<Uint8Array>> {
  if (options.scheme !== 'hls-aes128') {
    throw new CapabilityError(
      `${validation.containerLabel} direct segment decrypt does not support '${options.scheme}'`,
      { op: { kind: 'route', id: 'decrypt' }, tried: [validation.driverId] },
    );
  }
  const key = requiredKeyField(options.keys, 'key', validation.driverId);
  let iv: Uint8Array<ArrayBuffer> | undefined;
  let clear: Uint8Array<ArrayBuffer>;
  try {
    iv = requiredKeyField(options.keys, 'iv', validation.driverId);
    const cipher = await readHlsSegment(source, options.signal);
    try {
      clear = await decryptHlsAes128(cipher, key, iv);
    } catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError(
        'demux-error',
        `HLS AES-128 segment did not decrypt as ${validation.containerLabel} (wrong key/IV or corrupt ciphertext)`,
        error,
      );
    }
  } finally {
    key.fill(0);
    iv?.fill(0);
  }
  assertHlsSegmentClearNotAborted(clear, options.signal);
  try {
    await validation.validate(clear);
  } catch (error) {
    clear.fill(0);
    if (options.signal?.aborted) throw hlsSegmentAbortedError();
    throw new MediaError(
      'demux-error',
      `HLS AES-128 plaintext is not a valid ${validation.containerLabel} segment`,
      error,
    );
  }
  assertHlsSegmentClearNotAborted(clear, options.signal);
  return demandDrivenSegmentStream(clear, options.signal);
}
