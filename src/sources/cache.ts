/**
 * Caching / preload source layer (ADR-013, docs/architecture/07 §3 + §5 `preload`) — wrap any
 * {@link Source} in an in-memory **range cache** so repeated and overlapping reads never re-fetch.
 *
 * Why this exists: a probe seeks the header *and* the trailing `moov`/last-Ogg-page; a remux then re-reads
 * overlapping byte windows. Against a `fromURL` source each of those is a separate HTTP request. A
 * {@link CachingSource} remembers every window it has fetched (coalescing adjacent/overlapping intervals),
 * serves any later read that is already covered straight from memory, and de-duplicates concurrent
 * identical fetches within the same cancellation scope — turning N reads of the same region into **one**
 * network round-trip. It also memoizes the resource's total {@link Source.size} (learning it from the
 * wrapped source, or — for a URL — via a `HEAD`/`Content-Range` probe in {@link CachingSource.prime}),
 * which is what lets a tail-seeking probe work on a remote file.
 *
 * `prime()` is the engine's `preload` hook for a source: it warms `size` (and optionally pre-fetches byte
 * ranges) ahead of the first real read, hiding that latency. The layer is transport-agnostic — it caches
 * over the underlying `range()`/`stream()` primitives, so it works for URL, Blob, bytes, or a pure stream
 * (a stream with no `range()` is materialized once on first need, then served wholly from memory).
 *
 * Memory note: the cache holds exactly the bytes that have been read (or primed); it is **opt-in** (you
 * call {@link cacheSource}), never on the default path, so a streaming convert of a 10-min file is
 * unaffected unless you ask to cache it.
 */

import { MediaError } from '../contracts/errors.ts';
import { raceAbort, throwIfSourceAborted } from './abort.ts';
import type { RangeCacheRuntime, StartedCacheRead } from './cache-runtime.ts';
import { type Source, type SourceKind, fromURL, isSource } from './source.ts';

/** Options for {@link cacheSource}. */
export interface CacheOptions {
  /**
   * Eagerly materialize the **entire** resource into the cache on the first read (or in {@link prime}).
   * Default `false` — only the windows actually requested are cached. Useful when you know every byte will
   * be needed (a small file read in many scattered ranges) and want a single sequential download.
   */
  eager?: boolean;
  /**
   * Maximum bytes retained by the ranged-read cache. Omit for the historical unbounded opt-in cache.
   * A fetched window larger than this limit is returned to its caller but not retained. Once the limit
   * is reached, least-recently-used intervals are evicted before another window is kept.
   *
   * This bounds seekable sources only. A range-less source still has to be materialized in full to
   * provide random access, and `eager:true` deliberately requests that same full materialization.
   */
  maxBytes?: number;
}

/** A {@link Source} backed by an in-memory range cache, plus a {@link prime} warmup hook. */
export interface CachingSource extends Source {
  /**
   * Always available: the cache supports random access (serving from memory or fetching the window)
   * and forwards `signal` through every wrapped ranged read.
   */
  range(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  /**
   * Warm the cache before the first real read (the `preload` hook for a source): learn {@link Source.size}
   * without consuming the body, and optionally pre-fetch byte windows. Fire-and-forget friendly — safe to
   * call repeatedly; overlapping primes coalesce and never double-fetch. With no `ranges` and
   * `eager:false` it only resolves `size`; with `eager:true` (or `ranges` covering the whole file) it
   * fills the cache.
   *
   * @param ranges Half-open `[start, end)` windows to pre-fetch. Omit to only resolve size (unless eager).
   */
  prime(ranges?: readonly ByteRange[], signal?: AbortSignal): Promise<void>;
  /** Bytes currently held in the cache (for diagnostics / tests). */
  readonly cachedBytes: number;
}

/** A half-open byte window `[start, end)`. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Wrap `input` in a {@link CachingSource}. Accepts anything {@link Source}-shaped (or a URL/URL-string,
 * normalized via {@link fromURL}) and returns a source that caches every range it reads. Constructing is
 * cheap and synchronous (no I/O); the interval/LRU runtime loads only on the first cache operation.
 * Call {@link CachingSource.prime} to warm it.
 */
export function cacheSource(input: Source | string | URL, opts: CacheOptions = {}): CachingSource {
  const maxBytes = normalizeMaxBytes(opts.maxBytes);
  if (isSource(input)) return new DeferredRangeCache(input, opts.eager ?? false, maxBytes);
  // Constructed from a URL here, so we keep the href — it is what lets `prime()` resolve size via a
  // HEAD/Content-Range probe (an already-built opaque Source never surfaces its href, so for those we can
  // only learn size from `src.size` or by materializing the stream).
  const href = typeof input === 'string' ? input : input.href;
  return new DeferredRangeCache(fromURL(href), opts.eager ?? false, maxBytes, href);
}

/**
 * Synchronous, source-shaped facade over the lazy cache runtime. A signalled first transport is started
 * before the dynamic import so signal identity and prompt cancellation do not depend on chunk latency.
 */
class DeferredRangeCache implements CachingSource {
  readonly __media = 'source' as const;
  readonly kind: SourceKind;
  readonly mimeHint?: string;
  readonly filename?: string;
  size?: number;

  readonly #src: Source;
  readonly #eager: boolean;
  readonly #maxBytes: number;
  readonly #href: string | undefined;
  #runtime: RangeCacheRuntime | undefined;
  #runtimePromise: Promise<RangeCacheRuntime> | undefined;
  #streamBarrier: Promise<RangeCacheRuntime> | undefined;

  constructor(src: Source, eager: boolean, maxBytes: number, href?: string) {
    this.#src = src;
    this.#eager = eager;
    this.#maxBytes = maxBytes;
    this.#href = href;
    this.kind = src.kind;
    if (src.size !== undefined) this.size = src.size;
    if (src.mimeHint !== undefined) this.mimeHint = src.mimeHint;
    if (src.filename !== undefined) this.filename = src.filename;
  }

  get cachedBytes(): number {
    return this.#runtime?.cachedBytes ?? 0;
  }

  async prime(ranges?: readonly ByteRange[], signal?: AbortSignal): Promise<void> {
    throwIfSourceAborted(signal);
    const operation = this.#prime(ranges, signal);
    if (this.#eager) this.#setStreamBarrier(operation);
    return operation;
  }

  async range(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfSourceAborted(signal);
    const runtime = this.#runtime;
    if (runtime !== undefined) {
      const bytes = await runtime.range(start, end, signal);
      this.#syncSize(runtime);
      return bytes;
    }

    const lo = Math.max(0, Math.trunc(start));
    let hi = Math.max(lo, Math.trunc(end));
    const knownSize = this.#src.size;
    if (knownSize !== undefined) hi = Math.min(hi, knownSize);
    if (hi <= lo) return new Uint8Array(0);

    const started = signal === undefined ? undefined : this.#startRead(lo, hi, signal);
    if (started?.kind !== 'full-stream') started?.load.catch(() => {});
    const operation = this.#finishRange(start, end, signal, started);
    if (this.#eager || this.#src.range === undefined) this.#setStreamBarrier(operation);
    return operation;
  }

  stream(): ReadableStream<Uint8Array> {
    if (this.#streamBarrier !== undefined) return forwardRuntimeStream(this.#streamBarrier);
    if (this.#runtime !== undefined) return this.#runtime.stream();
    if (this.#runtimePromise !== undefined) return forwardRuntimeStream(this.#runtimePromise);
    return this.#src.stream();
  }

  async #prime(ranges: readonly ByteRange[] | undefined, signal?: AbortSignal): Promise<void> {
    const runtime = await raceAbort(this.#loadRuntime(), signal);
    await runtime.prime(ranges, signal);
    this.#syncSize(runtime);
  }

  async #finishRange(
    start: number,
    end: number,
    signal: AbortSignal | undefined,
    started: StartedCacheRead | undefined,
  ): Promise<Uint8Array> {
    try {
      const loaded = await raceAbort(this.#loadRuntime(), signal);
      const bytes = await (started === undefined
        ? loaded.range(start, end, signal)
        : loaded.rangeStarted(start, end, signal as AbortSignal, started));
      this.#syncSize(loaded);
      return bytes;
    } catch (error) {
      if (started?.kind === 'full-stream') {
        await started.stream.cancel(error).catch(() => {});
      }
      throw error;
    }
  }

  #loadRuntime(): Promise<RangeCacheRuntime> {
    this.#runtimePromise ??= import('./cache-runtime.ts').then(({ createRangeCache }) => {
      const runtime = createRangeCache(this.#src, this.#eager, this.#maxBytes, this.#href);
      this.#runtime = runtime;
      return runtime;
    });
    return this.#runtimePromise;
  }

  #startRead(lo: number, hi: number, signal: AbortSignal): StartedCacheRead {
    if (!this.#eager && this.#src.range !== undefined) {
      return {
        kind: 'window',
        start: lo,
        end: hi,
        load: this.#src.range(lo, hi, signal),
      };
    }
    if (this.#src.range !== undefined && this.#src.size !== undefined) {
      return {
        kind: 'full-range',
        load: this.#src.range(0, this.#src.size, signal),
      };
    }
    return { kind: 'full-stream', stream: this.#src.stream() };
  }

  #syncSize(runtime: RangeCacheRuntime): void {
    if (runtime.size !== undefined) this.size = runtime.size;
  }

  #setStreamBarrier(operation: Promise<unknown>): void {
    const barrier = operation.then(() => this.#runtime as RangeCacheRuntime);
    this.#streamBarrier = barrier;
    void barrier.then(
      () => {
        if (this.#streamBarrier === barrier) this.#streamBarrier = undefined;
      },
      () => {
        if (this.#streamBarrier === barrier) this.#streamBarrier = undefined;
      },
    );
  }
}

function normalizeMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new MediaError('unsupported-input', 'cache maxBytes must be a non-negative safe integer');
  }
  return maxBytes;
}

/** Forward a stream request made while the cache runtime chunk is still loading, including cancellation. */
function forwardRuntimeStream(runtime: Promise<RangeCacheRuntime>): ReadableStream<Uint8Array> {
  let readerPromise: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined;
  const reader = (): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
    readerPromise ??= runtime.then((loaded) => loaded.stream().getReader());
    return readerPromise;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const active = await reader();
      const result = await active.read();
      if (result.done) {
        active.releaseLock();
        controller.close();
      } else {
        controller.enqueue(result.value);
      }
    },
    async cancel(reason): Promise<void> {
      await (await reader()).cancel(reason);
    },
  });
}
