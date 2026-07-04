import type { ByteSource, PcmTransform } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { planByteSlice, slice, writePlannedSlice } from './pcm-slice.ts';

const WAV_PROBE_HEAD_BYTES = 4096;
const WAV_RANGE_TIME_SLICE_MIN_SOURCE_BYTES = 1024 * 1024;

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function readAll(src: ByteSource): Promise<Uint8Array> {
  if (src.range && src.size !== undefined) return src.range(0, src.size);
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

async function tryRangeTimeSlice(
  src: ByteSource,
  opts: PcmTransform,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const { range, size } = src;
  const { timeBounds } = opts;
  if (timeBounds === undefined || range === undefined || size === undefined) return undefined;
  if (size <= WAV_RANGE_TIME_SLICE_MIN_SOURCE_BYTES) return undefined;
  const prefix = await range(0, Math.min(size, WAV_PROBE_HEAD_BYTES));
  if (opts.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
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
      : await range(plan.dataStart, plan.dataEnd);
  if (opts.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
  return byteStream(writePlannedSlice(data, plan));
}

export async function tryTimeSlice(
  src: ByteSource,
  opts: PcmTransform,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const ranged = await tryRangeTimeSlice(src, opts);
  if (ranged !== undefined) return ranged;
  const { timeBounds } = opts;
  if (timeBounds === undefined) return undefined;
  const bytes = await readAll(src);
  if (opts.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
  const out = slice(
    bytes,
    timeBounds,
    opts.sampleFormat,
    opts.endian,
    opts.channels,
    opts.sampleRate,
  );
  return out === undefined ? undefined : byteStream(out);
}
