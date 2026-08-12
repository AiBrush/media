import { InputError, MediaError } from '../contracts/errors.ts';
import { type ExecuteOptions, runToSink } from '../kernel/executor.ts';
import { toOpfsTarget, writeToOpfsTarget } from './opfs-target.ts';
import type { Output, Sink } from './sink.ts';
import { writeToStreamTarget } from './stream-target.ts';

export interface MaterializeOptions extends ExecuteOptions {
  mime?: string;
}

/** Write a produced byte stream to the sink's target and return the {@link Output}. */
export async function materialize(
  sink: Sink,
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions = {},
): Promise<Output> {
  const type = opts.mime ?? '';
  switch (sink.kind) {
    case 'stream':
      // Lazy: hand the stream back untouched (the caller drives it).
      return stream;
    case 'blob': {
      const parts = await collectOwnedParts(stream, opts);
      return new Blob(parts, type ? { type } : {});
    }
    case 'file': {
      const parts = await collectOwnedParts(stream, opts);
      return new File(parts, sink.name, type ? { type } : {});
    }
    case 'opfs':
      // One OPFS drain (doc 09 §5 items 1 + 6): the basic path is the rich opfs-target writer with
      // default options, so replace-the-file semantics, abort-on-failure, and the typed
      // CapabilityError capability-miss when OPFS is absent are identical on both spellings.
      return writeToOpfsTarget(toOpfsTarget(sink.path), stream, opts);
    case 'opfs-target':
      // The rich OPFS streaming sink: keepExistingData/position patch writes (doc 09 §5 item 1).
      return writeToOpfsTarget(sink, stream, opts);
    case 'element': {
      try {
        const { writeElement } = await import('./element-materialize.ts');
        await writeElement(sink, stream, opts);
        return undefined;
      } catch (error) {
        if (!stream.locked) await stream.cancel(error).catch(() => undefined);
        if (error instanceof MediaError) throw error;
        throw new MediaError('mux-error', 'element materializer failed', error);
      }
    }
    case 'stream-target':
      // Incremental write to the caller's destination (never buffers the whole output); returns undefined.
      return writeToStreamTarget(sink, stream, opts);
    default:
      return assertNever(sink);
  }
}

/**
 * Retain independently owned stream chunks for Blob/File construction without first joining them into
 * one total-sized `Uint8Array`. A producer may recycle or mutate a chunk's backing store after the write
 * completes, so every delivered part is copied before backpressure is released.
 */
async function collectOwnedParts(
  readable: ReadableStream<Uint8Array>,
  opts: ExecuteOptions,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  await runToSink(
    readable,
    new WritableStream<Uint8Array>({
      write(chunk): void {
        const part = new Uint8Array(chunk.byteLength);
        part.set(chunk);
        parts.push(part);
        total += part.byteLength;
        opts.onProgress?.({ done: total, stage: 'collect' });
      },
      abort(): void {
        parts.length = 0;
      },
    }),
    opts,
  );
  return parts;
}

function assertNever(value: never): never {
  throw new InputError(`unknown sink ${JSON.stringify(value)}`);
}
