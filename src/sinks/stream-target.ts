import { MediaError } from '../contracts/errors.ts';
import type { ExecuteOptions } from '../kernel/executor.ts';

/** A position-aware chunk sink. Returning a promise applies producer backpressure. */
export type StreamTargetWriter = (chunk: Uint8Array, position: number) => void | Promise<void>;

/** A standard writable byte stream or a position-aware callback destination. */
export type StreamDestination = WritableStream<Uint8Array> | StreamTargetWriter;

/** The streaming sink descriptor carried by the public {@link import('./sink.ts').Sink} union. */
export interface StreamTarget {
  readonly kind: 'stream-target';
  readonly destination: StreamDestination;
}

/** Build a sink that writes each produced output chunk incrementally to `destination`. */
export function toStreamTarget(destination: StreamDestination): StreamTarget {
  return { kind: 'stream-target', destination };
}

/** Lazily load the incremental writer so descriptor-only apps keep it out of the eager kernel. */
export async function writeToStreamTarget(
  target: StreamTarget,
  stream: ReadableStream<Uint8Array>,
  opts: ExecuteOptions = {},
): Promise<undefined> {
  try {
    const writer = await import('./stream-target-materialize.ts');
    return await writer.writeToStreamTarget(target, stream, opts);
  } catch (error) {
    if (!stream.locked) await stream.cancel(error).catch(() => undefined);
    if (error instanceof MediaError) throw error;
    throw new MediaError('mux-error', 'stream-target materializer failed', error);
  }
}
