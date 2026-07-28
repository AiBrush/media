/**
 * Reserved-faststart preflight. Kept behind the convert/mux/remux lazy operation paths so ordinary
 * probe/decode/convert entry points do not carry the positioned-sink contract in the eager kernel.
 */

import { CapabilityError, InputError } from '../contracts/errors.ts';
import type { ConvertOptions, MuxSpec, RemuxOptions } from './types.ts';

/**
 * Validate the public reserved-faststart contract before a caller-owned source/packet stream is pulled.
 * Reserve is a positioned sparse-write algorithm, so it is intentionally unavailable to whole-buffer,
 * append-only, element, and raw-readable-stream sinks.
 */
export function validateReservedFaststart(
  operation: 'convert' | 'mux' | 'remux',
  target: string | undefined,
  opts: ConvertOptions | MuxSpec | RemuxOptions,
): void {
  const maximumPacketCount = opts.maximumPacketCount;
  if (opts.faststart !== 'reserve') {
    if (maximumPacketCount !== undefined) {
      throw new InputError(
        `${operation} maximumPacketCount is valid only with faststart:'reserve'`,
      );
    }
    return;
  }
  if (target !== 'mp4' && target !== 'mov') {
    throw new InputError(`${operation} faststart:'reserve' requires an explicit mp4 or mov target`);
  }
  if (!Number.isSafeInteger(maximumPacketCount) || (maximumPacketCount ?? 0) < 1) {
    throw new InputError(
      `${operation} faststart:'reserve' requires a positive integer maximumPacketCount`,
    );
  }
  if (opts.fragmented === true) {
    throw new InputError(
      `${operation} faststart:'reserve' cannot be combined with fragmented output`,
    );
  }
  if ('tags' in opts && opts.tags !== undefined) {
    throw new InputError(
      `${operation} faststart:'reserve' cannot be combined with a post-mux metadata rewrite`,
    );
  }

  const sink = opts.sink;
  if (
    sink === undefined ||
    (sink.kind !== 'stream-target' && sink.kind !== 'opfs' && sink.kind !== 'opfs-target')
  ) {
    throw new InputError(
      `${operation} faststart:'reserve' requires a position-aware stream-target or OPFS sink`,
    );
  }
  if (sink.kind !== 'stream-target') return;
  if (sink.options?.writeChunkBytes !== undefined) {
    throw new InputError(
      `${operation} faststart:'reserve' cannot be combined with exact writeChunkBytes shaping`,
    );
  }
  const destination = sink.destination;
  if (
    typeof destination !== 'function' &&
    (typeof destination !== 'object' ||
      destination === null ||
      typeof (destination as { readonly seek?: unknown }).seek !== 'function')
  ) {
    throw new CapabilityError(
      `${operation} faststart:'reserve' needs a position-aware callback or seekable writable destination`,
      {
        op: { kind: 'route', id: `${operation}-faststart-reserve` },
        tried: ['stream-target/callback', 'stream-target/seekable', 'opfs'],
      },
    );
  }
}
