/** Lazy one-shot source prefix replay and cancellation (ADR-231). */

import { InputError, MediaError } from '../contracts/errors.ts';
import {
  SOURCE_STREAM_STATE,
  type Source,
  type StreamCursor,
  type StreamSourceState,
} from './source.ts';

interface StreamStateSource extends Source {
  readonly [SOURCE_STREAM_STATE]: StreamSourceState;
}

/** Peek an unseekable source while preserving the sole stream reader for the eventual consumer. */
export async function peekUnseekableSourceHead(
  src: Source,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (SOURCE_STREAM_STATE in src) {
    const state = (src as StreamStateSource)[SOURCE_STREAM_STATE];
    if (state.cursor === undefined) state.cursor = createStreamCursor(state);
    return state.cursor.peek(limit, signal);
  }
  if (src.kind === 'stream') {
    throw new InputError('unsupported-input', 'stream source must be normalized with fromStream()');
  }
  return peekRereadableSource(src, limit, signal);
}

/** Cancel a `fromStream` source that owns a routing reader. */
export async function cancelOneShotSource(src: Source, reason?: unknown): Promise<void> {
  if (!(SOURCE_STREAM_STATE in src)) return;
  const state = (src as StreamStateSource)[SOURCE_STREAM_STATE];
  if (state.cursor !== undefined) await state.cursor.cancel(reason);
  else if (!state.consumed) {
    state.consumed = true;
    await state.readable.cancel(reason).catch(() => {});
  }
}

function createStreamCursor(state: StreamSourceState): StreamCursor {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const retained: Uint8Array[] = [];
  let retainedBytes = 0;
  let opened = false;
  let upstreamDone = false;
  let cancelled = false;
  let lockReleased = false;
  let pendingPeeks = 0;
  let peekTail: Promise<void> = Promise.resolve();

  const acquire = (): ReadableStreamDefaultReader<Uint8Array> => {
    if (reader !== undefined) return reader;
    if (state.consumed) throw new InputError('unsupported-input', 'used');
    state.consumed = true;
    reader = acquireReader(state.readable);
    return reader;
  };
  const release = (): void => {
    if (reader === undefined || lockReleased) return;
    lockReleased = true;
    reader.releaseLock();
  };
  const cancel = async (reason?: unknown): Promise<void> => {
    if (cancelled) return;
    cancelled = true;
    opened = true;
    try {
      if (reader !== undefined && !lockReleased) await reader.cancel(reason).catch(() => {});
      else if (!state.consumed) {
        state.consumed = true;
        await state.readable.cancel(reason).catch(() => {});
      }
    } finally {
      release();
    }
  };

  const peek = (limit: number, signal?: AbortSignal): Promise<Uint8Array> => {
    pendingPeeks++;
    const task = peekTail.then(async (): Promise<Uint8Array> => {
      if (opened || cancelled) throw new InputError('unsupported-input', 'used');
      const bounded = Math.max(0, Math.trunc(limit));
      try {
        throwIfAborted(signal);
        while (!upstreamDone && retainedBytes < bounded) {
          const result = await readWithAbort(acquire(), signal);
          if (result.done) {
            upstreamDone = true;
            release();
            break;
          }
          retained.push(result.value);
          retainedBytes += result.value.byteLength;
        }
        throwIfAborted(signal);
        return copyPrefix(retained, Math.min(retainedBytes, bounded));
      } catch (error) {
        await cancel(error);
        throw error;
      }
    });
    peekTail = task.then(
      () => {},
      () => {},
    );
    void task
      .finally(() => {
        pendingPeeks--;
      })
      .catch(() => {});
    return task;
  };

  const open = (): ReadableStream<Uint8Array> => {
    if (opened || cancelled || pendingPeeks > 0) {
      throw new InputError('unsupported-input', pendingPeeks > 0 ? 'routing read pending' : 'used');
    }
    opened = true;
    let retainedIndex = 0;
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller): Promise<void> {
          const chunk = retained[retainedIndex++];
          if (chunk !== undefined) {
            controller.enqueue(chunk);
            return;
          }
          if (upstreamDone) {
            controller.close();
            return;
          }
          try {
            const result = await acquire().read();
            if (result.done) {
              upstreamDone = true;
              release();
              controller.close();
            } else {
              controller.enqueue(result.value);
            }
          } catch (error) {
            await cancel(error);
            controller.error(toMediaError(error));
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
  };

  return { peek, open, cancel };
}

async function peekRereadableSource(
  src: Source,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const reader = acquireReader(src.stream());
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelReason: unknown;
  try {
    while (total < limit) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    throwIfAborted(signal);
    return copyPrefix(chunks, Math.min(total, limit));
  } catch (error) {
    cancelReason = error;
    throw error;
  } finally {
    await reader.cancel(cancelReason).catch(() => {});
    reader.releaseLock();
  }
}

function acquireReader(
  readable: ReadableStream<Uint8Array>,
): ReadableStreamDefaultReader<Uint8Array> {
  try {
    return readable.getReader();
  } catch (error) {
    throw new InputError('unsupported-input', 'stream is already locked', error);
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  throwIfAborted(signal);
  if (signal === undefined) return reader.read();
  let rejectAbort: ((reason: MediaError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(abortError(signal));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function copyPrefix(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const take = Math.min(chunk.byteLength, length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

function abortError(signal: AbortSignal): MediaError {
  return signal.reason instanceof MediaError && signal.reason.code === 'aborted'
    ? signal.reason
    : new MediaError('aborted', 'source read aborted', signal.reason);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}

function toMediaError(error: unknown): MediaError {
  return error instanceof MediaError
    ? error
    : new InputError('unsupported-input', 'stream read failed', error);
}
