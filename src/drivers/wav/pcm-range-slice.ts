import type { ByteSource, PcmTransform } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { planByteSlice, slice, writePlannedSlice } from './pcm-slice.ts';

const WAV_PROBE_HEAD_BYTES = 4096;
const WAV_RANGE_TIME_SLICE_MIN_SOURCE_BYTES = 1024 * 1024;
const OPERATION_ABORTED = 'operation aborted';

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MediaError('aborted', OPERATION_ABORTED);
}

async function readAll(src: ByteSource, signal: AbortSignal | undefined): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (src.range && src.size !== undefined) {
    const bytes = await src.range(0, src.size, signal);
    throwIfAborted(signal);
    return bytes;
  }
  if (src.readAll !== undefined) {
    const bytes = await src.readAll(signal);
    throwIfAborted(signal);
    return bytes;
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  const abortReader = (): void => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abortReader, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        completed = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) {
      out.set(chunk, off);
      off += chunk.byteLength;
    }
    throwIfAborted(signal);
    return out;
  } catch (error) {
    if (!completed && signal?.aborted !== true) await reader.cancel(error).catch(() => {});
    throwIfAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortReader);
    reader.releaseLock();
  }
}

async function tryRangeTimeSlice(
  src: ByteSource,
  opts: PcmTransform,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const { range, size } = src;
  const { timeBounds } = opts;
  if (timeBounds === undefined || range === undefined || size === undefined) return undefined;
  if (size <= WAV_RANGE_TIME_SLICE_MIN_SOURCE_BYTES) return undefined;
  throwIfAborted(opts.signal);
  const prefix = await range(0, Math.min(size, WAV_PROBE_HEAD_BYTES), opts.signal);
  throwIfAborted(opts.signal);
  const plan = planByteSlice(
    prefix,
    timeBounds,
    opts.sampleFormat,
    opts.endian,
    opts.channels,
    opts.sampleRate,
    size,
  );
  if (plan === undefined) return undefined;
  const data =
    plan.dataStart >= 0 && plan.dataEnd <= prefix.byteLength
      ? prefix.subarray(plan.dataStart, plan.dataEnd)
      : await range(plan.dataStart, plan.dataEnd, opts.signal);
  throwIfAborted(opts.signal);
  return byteStream(writePlannedSlice(data, plan));
}

export async function tryTimeSlice(
  src: ByteSource,
  opts: PcmTransform,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const { timeBounds } = opts;
  if (timeBounds === undefined) return undefined;
  throwIfAborted(opts.signal);
  const ranged = await tryRangeTimeSlice(src, opts);
  if (ranged !== undefined) return ranged;
  const bytes = await readAll(src, opts.signal);
  throwIfAborted(opts.signal);
  const out = slice(
    bytes,
    timeBounds,
    opts.sampleFormat,
    opts.endian,
    opts.channels,
    opts.sampleRate,
  );
  throwIfAborted(opts.signal);
  return out === undefined ? undefined : byteStream(out);
}
