/**
 * `StreamTarget` — the streaming output sink descriptor + pure core (doc 09 streaming-output §3,
 * ADR-013). The lazily-loaded byte drain lives in `stream-target-materialize.ts`; this module owns the
 * immutable descriptor, its constructor, the pure write-plan resolution, and the position-tagging seam
 * a streaming *producer* uses to address bytes — mirroring the two-file descriptor+seam convention the
 * OPFS sink follows (`opfs-target.ts` / `opfs-target-materialize.ts`, doc 09 §5 item 9).
 *
 * **Position semantics (doc 09 §5 item 2, mediabunny `StreamTargetChunk` parity).** The `position`
 * handed to a {@link StreamTargetWriter} is the *producer's intended byte offset*, not a materializer
 * counter. A muxer that must re-write an earlier byte region (patching a header after the fact) tags
 * the chunk with {@link positionedChunk}; an untagged chunk lands at the end of the previous write
 * (file-cursor semantics), so an append-only producer still observes `position == Σ previous lengths`.
 * Destinations honor a non-contiguous position as follows: a callback receives it verbatim; a
 * random-access `WritableStream` (one exposing OPFS-style `seek`, e.g. `FileSystemWritableFileStream`)
 * receives an explicit positioned write; an append-only `WritableStream` **cannot** honor it and the
 * drain raises a typed `CapabilityError` rather than silently landing bytes at the wrong offset.
 *
 * **TTFB guarantee (doc 09 §5 item 5).** The destination receives its first write when the *first*
 * produced chunk arrives — never deferred to finalize — so the first callback invocation (or first
 * `WritableStream` write) IS the time-to-first-byte signal the `streaming-output` harness reads.
 *
 * **Write coalescing (doc 09 §5 item 7, mediabunny `StreamTargetOptions` parity).** `chunked` trades a
 * bounded buffer (≤ `chunkSize` + one produced chunk) for sharply fewer target writes — off by default
 * because raw per-chunk writes minimize TTFB, which is this family's headline metric.
 */

import { InputError, MediaError } from '../contracts/errors.ts';
import type { ExecuteOptions } from '../kernel/executor.ts';

/** Write-coalescing options, mirroring mediabunny's `StreamTargetOptions` (doc 09 §2 exemplar). */
export interface StreamTargetOptions {
  /**
   * Coalesce contiguous writes into runs of at least {@link StreamTargetOptions.chunkSize} bytes before
   * they reach the destination. Default `false`: every produced chunk is written immediately (lowest TTFB,
   * most writes). Turn on for destinations where write frequency dominates (network upload bodies,
   * MPEG-TS packet-sized producers).
   */
  readonly chunked?: boolean;
  /**
   * Coalesced run size in bytes when {@link StreamTargetOptions.chunked} is on (ignored otherwise).
   * Default 16 MiB. A produced chunk larger than this bypasses the copy and ships whole, so peak
   * buffering stays ≤ `chunkSize` + one produced chunk.
   */
  readonly chunkSize?: number;
}

/**
 * A position-aware chunk sink. `position` is the producer's intended byte offset (see the module doc);
 * returning a promise applies producer backpressure — the next chunk is not pulled until it settles.
 * The first invocation happens at the first produced chunk (the TTFB signal), never at finalize.
 */
export type StreamTargetWriter = (chunk: Uint8Array, position: number) => void | Promise<void>;

/** A standard writable byte stream or a position-aware callback destination. */
export type StreamDestination = WritableStream<Uint8Array> | StreamTargetWriter;

/** The streaming sink descriptor carried by the public {@link import('./sink.ts').Sink} union. */
export interface StreamTarget {
  readonly kind: 'stream-target';
  readonly destination: StreamDestination;
  /** Optional write-coalescing knobs; omitted ⇒ unchunked (validated lazily by the drain). */
  readonly options?: StreamTargetOptions;
}

/** Build a sink that writes each produced output chunk incrementally to `destination`. */
export function toStreamTarget(
  destination: StreamDestination,
  options: StreamTargetOptions = {},
): StreamTarget {
  return { kind: 'stream-target', destination, options };
}

/** The resolved drain instructions — pure data the materializer executes (parallel to `OpfsWritePlan`). */
export interface StreamTargetWritePlan {
  readonly chunked: boolean;
  readonly chunkSize: number;
}

/** mediabunny's default `chunkSize` (16 MiB) — the exemplar value this option mirrors. */
const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;

/**
 * Resolve a {@link StreamTarget}'s options into a {@link StreamTargetWritePlan}. Pure — Node tests
 * assert the option handling without a destination. A non-positive/non-integer `chunkSize` is bad
 * input (a zero-byte coalescing buffer cannot hold a write).
 */
export function planStreamTargetWrite(target: StreamTarget): StreamTargetWritePlan {
  const options = target.options ?? {};
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new InputError(
      `stream-target chunkSize must be a positive integer, got ${String(options.chunkSize)}`,
    );
  }
  return { chunked: options.chunked ?? false, chunkSize };
}

/**
 * Producer-intended write positions, keyed weakly by the chunk object so tagging never mutates or
 * copies payload bytes and tags never outlive their chunks. Same-realm only (a structured clone drops
 * the association) and one tag per chunk *object* — producers emit fresh (sub)views per write, which
 * streams already require since ownership transfers downstream.
 */
const intendedWritePositions = new WeakMap<Uint8Array, number>();

/**
 * Tag `data` with the producer's intended byte offset in the output and return it. Untagged chunks
 * land at the end of the previous write, so only re-writes/jumps need tagging (doc 09 §5 item 2).
 */
export function positionedChunk(data: Uint8Array, position: number): Uint8Array {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new InputError(
      `stream-target chunk position must be a non-negative integer, got ${String(position)}`,
    );
  }
  intendedWritePositions.set(data, position);
  return data;
}

/** The producer-intended offset tagged on `data`, or `undefined` for an ordinary append chunk. */
export function chunkWritePosition(data: Uint8Array): number | undefined {
  return intendedWritePositions.get(data);
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
