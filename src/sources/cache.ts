/**
 * Caching / preload source layer (ADR-013, docs/architecture/07 §3 + §5 `preload`) — wrap any
 * {@link Source} in an in-memory **range cache** so repeated and overlapping reads never re-fetch.
 *
 * Why this exists: a probe seeks the header *and* the trailing `moov`/last-Ogg-page; a remux then re-reads
 * overlapping byte windows. Against a `fromURL` source each of those is a separate HTTP request. A
 * {@link CachingSource} remembers every window it has fetched (coalescing adjacent/overlapping intervals),
 * serves any later read that is already covered straight from memory, and de-duplicates concurrent
 * identical fetches — turning N reads of the same region into **one** network round-trip. It also memoizes
 * the resource's total {@link Source.size} (learning it from the wrapped source, or — for a URL — via a
 * `HEAD`/`Content-Range` probe in {@link CachingSource.prime}), which is what lets a tail-seeking probe
 * work on a remote file.
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

import { type Source, type SourceKind, fromURL, isSource, probeUrlSize } from './source.ts';

/** Options for {@link cacheSource}. */
export interface CacheOptions {
  /**
   * Eagerly materialize the **entire** resource into the cache on the first read (or in {@link prime}).
   * Default `false` — only the windows actually requested are cached. Useful when you know every byte will
   * be needed (a small file read in many scattered ranges) and want a single sequential download.
   */
  eager?: boolean;
}

/** A {@link Source} backed by an in-memory range cache, plus a {@link prime} warmup hook. */
export interface CachingSource extends Source {
  /** Always available: the cache supports random access (serving from memory or fetching the window). */
  range(start: number, end: number): Promise<Uint8Array>;
  /**
   * Warm the cache before the first real read (the `preload` hook for a source): learn {@link Source.size}
   * without consuming the body, and optionally pre-fetch byte windows. Fire-and-forget friendly — safe to
   * call repeatedly; overlapping primes coalesce and never double-fetch. With no `ranges` and
   * `eager:false` it only resolves `size`; with `eager:true` (or `ranges` covering the whole file) it
   * fills the cache.
   *
   * @param ranges Half-open `[start, end)` windows to pre-fetch. Omit to only resolve size (unless eager).
   */
  prime(ranges?: readonly ByteRange[]): Promise<void>;
  /** Bytes currently held in the cache (for diagnostics / tests). */
  readonly cachedBytes: number;
}

/** A half-open byte window `[start, end)`. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** A cached, coalesced interval and its bytes (`bytes.byteLength === end - start`). */
interface Interval {
  start: number;
  end: number;
  bytes: Uint8Array;
}

/**
 * Wrap `input` in a {@link CachingSource}. Accepts anything {@link Source}-shaped (or a URL/URL-string,
 * normalized via {@link fromURL}) and returns a source that caches every range it reads. Constructing is
 * cheap and synchronous (no I/O); call {@link CachingSource.prime} to warm it.
 */
export function cacheSource(input: Source | string | URL, opts: CacheOptions = {}): CachingSource {
  if (isSource(input)) return new RangeCache(input, opts.eager ?? false);
  // Constructed from a URL here, so we keep the href — it is what lets `prime()` resolve size via a
  // HEAD/Content-Range probe (an already-built opaque Source never surfaces its href, so for those we can
  // only learn size from `src.size` or by materializing the stream).
  const href = typeof input === 'string' ? input : input.href;
  return new RangeCache(fromURL(href), opts.eager ?? false, href);
}

/** The cache implementation. One per wrapped source; owns the interval list + de-dup + memoized size. */
class RangeCache implements CachingSource {
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
  /** The wrapped URL's href when we built the source ourselves — enables a body-free size probe. */
  readonly #href: string | undefined;
  /** Sorted, non-overlapping, non-adjacent cached intervals (coalesced on every insert). */
  readonly #intervals: Interval[] = [];
  /** Single-flight guards so concurrent callers share one network operation, never racing duplicates. */
  #sizePromise: Promise<number | undefined> | undefined;
  #fullLoad: Promise<Uint8Array> | undefined;
  readonly #inflight = new Map<string, Promise<Uint8Array>>();

  constructor(src: Source, eager: boolean, href?: string) {
    this.#src = src;
    this.#eager = eager;
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

  // ── prime (preload) ─────────────────────────────────────────────────────────────────────────────

  async prime(ranges?: readonly ByteRange[]): Promise<void> {
    await this.#resolveSize();
    if (this.#eager || (ranges === undefined && this.size === undefined)) {
      // Eager, or a range-less source we can only serve by materializing once: load the whole thing.
      if (this.#eager) await this.#loadFull();
      // (size-only prime on an unknown-length stream stays lazy — materialized on first real read.)
    }
    if (ranges) {
      for (const r of ranges) await this.range(r.start, r.end);
    }
  }

  // ── range (the cached read) ─────────────────────────────────────────────────────────────────────

  async range(start: number, end: number): Promise<Uint8Array> {
    const lo = Math.max(0, Math.trunc(start));
    let hi = Math.max(lo, Math.trunc(end));
    if (this.size !== undefined) hi = Math.min(hi, this.size);
    if (hi <= lo) return new Uint8Array(0);

    const hit = this.#sliceFromCache(lo, hi);
    if (hit) return hit; // fully cached — zero network.

    // Eager mode (or a source with no random access) is served by one full materialization.
    if (this.#eager || this.#src.range === undefined) {
      const full = await this.#loadFull();
      const cap = Math.min(hi, full.byteLength);
      return cap > lo ? full.subarray(lo, cap) : new Uint8Array(0);
    }

    const bytes = await this.#fetchWindow(lo, hi);
    this.#insert(lo, lo + bytes.byteLength, bytes);
    return bytes;
  }

  // ── stream ──────────────────────────────────────────────────────────────────────────────────────

  stream(): ReadableStream<Uint8Array> {
    // If the whole resource is already cached, replay it from memory (re-readable, no network). This also
    // covers a consumed pure-stream source after a full load — the only way it stays re-readable.
    const whole = this.#wholeIfCached();
    if (whole) return bytesStream(whole);
    if (this.#fullLoad !== undefined) {
      // A full load is in flight (or done): replay once it resolves rather than re-consuming the source.
      const pending = this.#fullLoad;
      return new ReadableStream<Uint8Array>({
        async pull(controller): Promise<void> {
          controller.enqueue(await pending);
          controller.close();
        },
      });
    }
    return this.#src.stream();
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────

  /** Learn the total length once, sharing one probe across concurrent callers. */
  #resolveSize(): Promise<number | undefined> {
    if (this.size !== undefined) return Promise.resolve(this.size);
    this.#sizePromise ??= this.#probeSize();
    return this.#sizePromise;
  }

  async #probeSize(): Promise<number | undefined> {
    if (this.#src.size !== undefined) {
      this.size = this.#src.size;
      return this.size;
    }
    // A URL we built ourselves can learn its length via HEAD/Content-Range without consuming the body.
    if (this.#href !== undefined) {
      const total = await probeUrlSize(this.#href);
      if (total !== undefined) this.size = total;
      return total;
    }
    return undefined; // unknown-length stream / opaque source — discovered when materialized.
  }

  /** Materialize the whole resource once; all callers share the single in-flight load. */
  #loadFull(): Promise<Uint8Array> {
    this.#fullLoad ??= this.#readAll().then((bytes) => {
      this.size = bytes.byteLength;
      this.#insert(0, bytes.byteLength, bytes);
      return bytes;
    });
    return this.#fullLoad;
  }

  async #readAll(): Promise<Uint8Array> {
    // Prefer a single full ranged read when size is known and random access exists; else drain the stream.
    if (this.#src.range && this.size !== undefined) {
      return this.#src.range(0, this.size);
    }
    return drain(this.#src.stream());
  }

  /** Fetch a window from the underlying source, de-duplicating identical concurrent requests. */
  #fetchWindow(lo: number, hi: number): Promise<Uint8Array> {
    const key = `${lo}:${hi}`;
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const range = this.#src.range;
    if (range === undefined) return this.#loadFull(); // unreachable (guarded by caller), but type-safe.
    const p = range(lo, hi).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }

  /** Return `[lo, hi)` from a single covering cached interval, or `undefined` if not fully covered. */
  #sliceFromCache(lo: number, hi: number): Uint8Array | undefined {
    for (const iv of this.#intervals) {
      if (iv.start <= lo && iv.end >= hi) return iv.bytes.subarray(lo - iv.start, hi - iv.start);
      if (iv.start > lo) break; // intervals are sorted by start; no later one can cover a smaller `lo`.
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
    if (end <= start) return;
    const incoming: Interval = { start, end, bytes };
    const merged: Interval[] = [];
    let cur = incoming;
    for (const iv of this.#intervals) {
      if (iv.end < cur.start || iv.start > cur.end) {
        // Disjoint and not touching — keep as-is (order is restored by the final sort-by-start below).
        merged.push(iv);
      } else {
        cur = coalesce(cur, iv);
      }
    }
    merged.push(cur);
    merged.sort((a, b) => a.start - b.start);
    this.#intervals.length = 0;
    this.#intervals.push(...merged);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

/** Merge two overlapping/adjacent intervals into one contiguous interval with a fresh contiguous buffer. */
function coalesce(a: Interval, b: Interval): Interval {
  const start = Math.min(a.start, b.start);
  const end = Math.max(a.end, b.end);
  if (start === a.start && end === a.end) return a; // `a` already contains `b`.
  if (start === b.start && end === b.end) return b; // `b` already contains `a`.
  const bytes = new Uint8Array(end - start);
  // Lay `a` then `b`; the overlap is identical bytes from the same source, so write order is immaterial.
  bytes.set(a.bytes, a.start - start);
  bytes.set(b.bytes, b.start - start);
  return { start, end, bytes };
}

/** A fresh single-chunk readable over `bytes` (re-readable: a new stream each call). */
function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}

/** Drain a readable fully into one contiguous `Uint8Array`. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
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
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
