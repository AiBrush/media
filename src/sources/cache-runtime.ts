/**
 * Lazy implementation for the opt-in public range cache.
 *
 * `cacheSource()` itself stays synchronous and source-shaped in `cache.ts`, while the interval/LRU and
 * whole-object machinery below loads only when a caller actually asks the wrapper to cache a range.
 */

import { raceAbort, throwIfSourceAborted } from './abort.ts';
import type { ByteRange, CachingSource } from './cache.ts';
import { drainStream } from './read-all.ts';
import { type Source, type SourceKind, probeUrlSize } from './source.ts';

/** A transport the synchronous facade started before the lazy runtime module became available. */
export type StartedCacheRead =
  | {
      readonly kind: 'window';
      readonly start: number;
      readonly end: number;
      readonly load: Promise<Uint8Array>;
    }
  | { readonly kind: 'full-range'; readonly load: Promise<Uint8Array> }
  | { readonly kind: 'full-stream'; readonly stream: ReadableStream<Uint8Array> };

/** Internal extension used only by the synchronous facade for its first, already-started read. */
export interface RangeCacheRuntime extends CachingSource {
  rangeStarted(
    start: number,
    end: number,
    signal: AbortSignal,
    started: StartedCacheRead,
  ): Promise<Uint8Array>;
}

export function createRangeCache(
  src: Source,
  eager: boolean,
  maxBytes: number,
  href?: string,
): RangeCacheRuntime {
  return new RangeCache(src, eager, maxBytes, href);
}

/** A cached, coalesced interval and its bytes (`bytes.byteLength === end - start`). */
interface Interval {
  start: number;
  end: number;
  bytes: Uint8Array;
  lastUsed: number;
}

/** The cache implementation. One per wrapped source; owns the interval list + de-dup + memoized size. */
class RangeCache implements RangeCacheRuntime {
  readonly __media = 'source' as const;
  readonly kind: SourceKind;
  readonly mimeHint?: string;
  readonly filename?: string;
  /**
   * Memoized total length, present only once known (from the wrapped source, a size probe, or a full
   * load). A plain optional field — assigned only real numbers, never an explicit `undefined` — so it
   * satisfies {@link Source.size} (`?: number`) directly without a getter.
   */
  size?: number;

  readonly #src: Source;
  readonly #eager: boolean;
  readonly #maxBytes: number;
  /** The wrapped URL's href when the facade built the source — enables a body-free size probe. */
  readonly #href: string | undefined;
  /** Sorted, non-overlapping, non-adjacent cached intervals (coalesced on every insert). */
  readonly #intervals: Interval[] = [];
  #accessSequence = 0;
  /** Single-flight guards for uncancelled reads; signalled transports stay caller-scoped. */
  #sizePromise: Promise<number | undefined> | undefined;
  #fullLoad: Promise<Uint8Array> | undefined;
  readonly #inflight = new Map<string, Promise<Uint8Array>>();

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
    let n = 0;
    for (const iv of this.#intervals) n += iv.bytes.byteLength;
    return n;
  }

  async prime(ranges?: readonly ByteRange[], signal?: AbortSignal): Promise<void> {
    throwIfSourceAborted(signal);
    await this.#resolveSize(signal);
    if (this.#eager) await this.#loadFull(signal);
    if (ranges) {
      for (const r of ranges) await this.range(r.start, r.end, signal);
    }
  }

  range(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#range(start, end, signal);
  }

  rangeStarted(
    start: number,
    end: number,
    signal: AbortSignal,
    started: StartedCacheRead,
  ): Promise<Uint8Array> {
    return this.#range(start, end, signal, started);
  }

  async #range(
    start: number,
    end: number,
    signal?: AbortSignal,
    started?: StartedCacheRead,
  ): Promise<Uint8Array> {
    throwIfSourceAborted(signal);
    const lo = Math.max(0, Math.trunc(start));
    let hi = Math.max(lo, Math.trunc(end));
    if (this.size !== undefined) hi = Math.min(hi, this.size);
    if (hi <= lo) return new Uint8Array(0);

    const hit = this.#sliceFromCache(lo, hi);
    if (hit) return hit;

    if (this.#eager || this.#src.range === undefined) {
      const full = await this.#loadFull(signal, started);
      const cap = Math.min(hi, full.byteLength);
      return cap > lo ? full.subarray(lo, cap) : new Uint8Array(0);
    }

    const preloaded =
      started?.kind === 'window' && started.start === lo && started.end === hi
        ? started.load
        : undefined;
    const bytes = await this.#fetchWindow(lo, hi, signal, preloaded);
    this.#insert(lo, lo + bytes.byteLength, bytes);
    return bytes;
  }

  stream(): ReadableStream<Uint8Array> {
    // Replay a complete cache or its in-flight load instead of re-consuming the wrapped source.
    const available = this.#wholeIfCached() ?? this.#fullLoad;
    if (available !== undefined) {
      return new ReadableStream<Uint8Array>({
        async pull(controller): Promise<void> {
          controller.enqueue(await available);
          controller.close();
        },
      });
    }
    return this.#src.stream();
  }

  /** Learn the total length once, sharing one probe across concurrent callers. */
  #resolveSize(signal?: AbortSignal): Promise<number | undefined> {
    if (this.size !== undefined) return Promise.resolve(this.size);
    if (signal !== undefined) return raceAbort(this.#probeSize(signal), signal);
    this.#sizePromise ??= this.#probeSize();
    return this.#sizePromise;
  }

  async #probeSize(signal?: AbortSignal): Promise<number | undefined> {
    if (this.#href !== undefined) {
      const total = await probeUrlSize(this.#href, signal);
      throwIfSourceAborted(signal);
      if (total !== undefined) this.size = total;
      return total;
    }
    return undefined;
  }

  /**
   * Materialize the whole resource. Unsignalled reads and range-less one-shot streams single-flight;
   * signalled seekable reads stay caller-scoped so one abort cannot cancel another caller's transport.
   */
  #loadFull(signal?: AbortSignal, started?: StartedCacheRead): Promise<Uint8Array> {
    const shared = signal === undefined;
    if (shared) this.#fullLoad ??= this.#readAll();
    const load = shared ? (this.#fullLoad as Promise<Uint8Array>) : this.#readAll(signal, started);
    return raceAbort(load, signal).then((bytes) => {
      throwIfSourceAborted(signal);
      this.size = bytes.byteLength;
      this.#insert(0, bytes.byteLength, bytes);
      return bytes;
    });
  }

  async #readAll(signal?: AbortSignal, started?: StartedCacheRead): Promise<Uint8Array> {
    if (started?.kind === 'full-range') return started.load;
    if (started?.kind === 'full-stream') return drainStream(started.stream, signal);
    if (this.#src.range && this.size !== undefined) {
      return this.#src.range(0, this.size, signal);
    }
    return drainStream(this.#src.stream(), signal);
  }

  /** Fetch a window from the underlying source, de-duplicating identical concurrent requests. */
  #fetchWindow(
    lo: number,
    hi: number,
    signal?: AbortSignal,
    preloaded?: Promise<Uint8Array>,
  ): Promise<Uint8Array> {
    if (preloaded !== undefined) return raceAbort(preloaded, signal);
    const key = `${lo}:${hi}`;
    const range = this.#src.range as NonNullable<Source['range']>;
    if (signal !== undefined) return raceAbort(range.call(this.#src, lo, hi, signal), signal);
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const load = range.call(this.#src, lo, hi).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, load);
    return load;
  }

  /** Return `[lo, hi)` from a single covering cached interval, or `undefined` if not fully covered. */
  #sliceFromCache(lo: number, hi: number): Uint8Array | undefined {
    for (const iv of this.#intervals) {
      if (iv.start <= lo && iv.end >= hi) {
        iv.lastUsed = ++this.#accessSequence;
        return iv.bytes.subarray(lo - iv.start, hi - iv.start);
      }
      if (iv.start > lo) break;
    }
    return undefined;
  }

  /** The full `[0, size)` buffer if it is entirely cached in one interval, else `undefined`. */
  #wholeIfCached(): Uint8Array | undefined {
    const size = this.size;
    if (size === undefined) return undefined;
    const first = this.#intervals[0];
    if (first && first.start === 0 && first.end >= size) {
      return first.bytes.subarray(0, size);
    }
    return undefined;
  }

  /**
   * Insert `[start, end)` (bytes) into the interval list, coalescing every overlapping/adjacent interval
   * into one contiguous run so the cache stays compact and a covering lookup is a single comparison.
   */
  #insert(start: number, end: number, bytes: Uint8Array): void {
    if (end <= start || this.#maxBytes === 0 || bytes.byteLength > this.#maxBytes) return;
    const incoming: Interval = {
      start,
      end,
      bytes,
      lastUsed: ++this.#accessSequence,
    };
    const merged: Interval[] = [];
    let current = incoming;
    for (const interval of this.#intervals) {
      if (interval.end < current.start || interval.start > current.end) {
        merged.push(interval);
      } else {
        const unionStart = Math.min(current.start, interval.start);
        const unionEnd = Math.max(current.end, interval.end);
        if (unionEnd - unionStart <= this.#maxBytes) {
          current = coalesce(current, interval);
        } else if (interval.end === current.start || interval.start === current.end) {
          merged.push(interval);
        }
      }
    }
    merged.push(current);
    merged.sort((a, b) => a.start - b.start);
    this.#intervals.length = 0;
    this.#intervals.push(...merged);
    this.#evictOverCapacity();
  }

  #evictOverCapacity(): void {
    while (this.cachedBytes > this.#maxBytes) {
      let oldestIndex = -1;
      let oldestSequence = Number.POSITIVE_INFINITY;
      for (let index = 0; index < this.#intervals.length; index++) {
        const lastUsed = this.#intervals[index]?.lastUsed ?? Number.POSITIVE_INFINITY;
        if (lastUsed < oldestSequence) {
          oldestSequence = lastUsed;
          oldestIndex = index;
        }
      }
      if (oldestIndex < 0) return;
      this.#intervals.splice(oldestIndex, 1);
    }
  }
}

/** Merge two overlapping/adjacent intervals into one contiguous interval with a fresh buffer. */
function coalesce(a: Interval, b: Interval): Interval {
  const start = Math.min(a.start, b.start);
  const end = Math.max(a.end, b.end);
  if (start === a.start && end === a.end) {
    a.lastUsed = Math.max(a.lastUsed, b.lastUsed);
    return a;
  }
  const bytes = new Uint8Array(end - start);
  bytes.set(a.bytes, a.start - start);
  bytes.set(b.bytes, b.start - start);
  return { start, end, bytes, lastUsed: Math.max(a.lastUsed, b.lastUsed) };
}
