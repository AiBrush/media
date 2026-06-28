/**
 * Output sinks (ADR-013, docs/architecture/07 §4) — where an op's produced bytes go. A sink is a small
 * descriptor; the op produces a `ReadableStream<Uint8Array>` and {@link materialize} writes it to the
 * target. Stream sinks are lazy (pull-based); large outputs never fully buffer when streamed.
 */

import type { StreamTarget } from './stream-target.ts';

export type Sink =
  | { readonly kind: 'blob' }
  | { readonly kind: 'file'; readonly name: string }
  | { readonly kind: 'stream' }
  | { readonly kind: 'opfs'; readonly path: string }
  | {
      readonly kind: 'element';
      readonly el: HTMLMediaElement;
      readonly via: 'blob' | 'mse' | 'stream';
    }
  // A streaming destination (doc 09 streaming-output, ADR-034): each produced chunk is written straight
  // to a caller-owned `WritableStream`/callback as it is produced, so peak memory stays at one chunk —
  // the point of a fragmented/CMAF or long-recording output. Its materializer lives in stream-target.ts.
  | StreamTarget;

/** What an op returns, depending on the sink (`undefined` = wrote to a target, no value). */
export type Output = Blob | File | ReadableStream<Uint8Array> | undefined;

type SinkOf<K extends Sink['kind']> = Extract<Sink, { kind: K }>;

/** Collect the whole output into a `Blob` (the default sink). */
export function toBlob(): SinkOf<'blob'> {
  return { kind: 'blob' };
}
/** Collect into a named `File`. */
export function toFile(name: string): SinkOf<'file'> {
  return { kind: 'file', name };
}
/** Return a lazy `ReadableStream` the caller pulls from. */
export function toStream(): SinkOf<'stream'> {
  return { kind: 'stream' };
}
/** Stream into an OPFS file at `path`. */
export function toOPFS(path: string): SinkOf<'opfs'> {
  return { kind: 'opfs', path };
}
/** Attach the output to a media element (Blob URL whole-file, or MSE/stream for streaming targets). */
export function toElement(
  el: HTMLMediaElement,
  opts: { via?: 'blob' | 'mse' | 'stream' } = {},
): SinkOf<'element'> {
  return { kind: 'element', el, via: opts.via ?? 'blob' };
}

export { materialize } from './materialize.ts';
export type { MaterializeOptions } from './materialize.ts';
