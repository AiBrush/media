/**
 * Bounded exact-source byte-interval reuse for repeated metadata probes (ADR-246;
 * docs/architecture/sources.md §3.2). The wrapper is a forwarding `Proxy` that overrides **only**
 * `range` — every other own key, symbol, getter, and later-learned fact (redirected URL, memoized
 * size, `rangesHonored`) stays live on the wrapped source and is observed through the wrapper
 * without hand-listed fields. Cache state is owned by the probing engine itself (installed as a
 * non-enumerable instance field), so this module holds **no** mutable state: two engines probing
 * the same `Source` never share bytes, and disposing an engine drops its cache with it.
 */

import { throwIfSourceAborted } from './abort.ts';
import type { Source } from './source.ts';

// The result/prefix handoff shares the same finite-probe lifecycle and is loaded through this one
// probe-cache boundary. Keeping one browser chunk avoids charging every cold Blob probe a second
// dynamic-module request while preserving the default entry's eager budget.
export { ProbeContainerResultCache } from '../api/blob-probe-handoff.ts';

interface ProbeRangeEntry {
  readonly start: number;
  readonly end: number;
  readonly bytes: Uint8Array;
}

/** Mutable state weakly owned by one exact normalized source snapshot. */
export interface ProbeRangeCacheState {
  entries: ProbeRangeEntry[];
  totalBytes: number;
  expiresAtMs: number;
  size?: number;
}

export interface ProbeRangeCacheOptions {
  readonly maxBytes: number;
  readonly maxIntervals: number;
  readonly ttlMs: number;
}

/** The frozen default reuse policy (ADR-246): ≤ 1 MiB, ≤ 8 intervals, 60 s TTL. */
export const DEFAULT_PROBE_RANGE_CACHE_OPTIONS: ProbeRangeCacheOptions = Object.freeze({
  maxBytes: 1024 * 1024,
  maxIntervals: 8,
  ttlMs: 60_000,
});

/** True only for a syntactically concrete encoded audio/video MIME hint. */
export function hasConcreteAudioVideoMime(mimeHint: string | undefined): boolean {
  return /^(?:audio|video)\/[!#$%&'*+\-.^_`|~\w]+(?:\s*;|$)/i.test(mimeHint?.trim() ?? '');
}

function freshState(src: Source, expiresAtMs: number): ProbeRangeCacheState {
  return {
    entries: [],
    totalBytes: 0,
    expiresAtMs,
    ...(src.size !== undefined ? { size: src.size } : {}),
  };
}

function cachedCopy(
  state: ProbeRangeCacheState,
  start: number,
  end: number,
  sourceSize: number | undefined,
): Uint8Array | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return undefined;
  }
  const effectiveEnd = sourceSize === undefined ? end : Math.min(end, sourceSize);
  for (let index = 0; index < state.entries.length; index++) {
    const entry = state.entries[index];
    if (entry === undefined) continue;
    if (start < entry.start || effectiveEnd > entry.end) continue;
    state.entries.splice(index, 1);
    state.entries.push(entry);
    return entry.bytes.slice(start - entry.start, effectiveEnd - entry.start);
  }
  return undefined;
}

function cachedLeadingInterval(
  state: ProbeRangeCacheState,
  start: number,
  end: number,
  sourceSize: number | undefined,
): ProbeRangeEntry | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    return undefined;
  }
  const effectiveEnd = sourceSize === undefined ? end : Math.min(end, sourceSize);
  let best: ProbeRangeEntry | undefined;
  for (const entry of state.entries) {
    if (start < entry.start || start >= entry.end || entry.end >= effectiveEnd) continue;
    if (best === undefined || entry.end > best.end) best = entry;
  }
  return best;
}

function joinLeadingInterval(
  entry: ProbeRangeEntry,
  start: number,
  suffix: Uint8Array,
): Uint8Array {
  const prefix = entry.bytes.subarray(start - entry.start);
  const joined = new Uint8Array(prefix.byteLength + suffix.byteLength);
  joined.set(prefix);
  joined.set(suffix, prefix.byteLength);
  return joined;
}

function retainRange(
  state: ProbeRangeCacheState,
  start: number,
  requestedEnd: number,
  bytes: Uint8Array,
  options: ProbeRangeCacheOptions,
): void {
  const requestedLength = requestedEnd - start;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedLength <= 0 ||
    bytes.byteLength <= 0 ||
    bytes.byteLength > requestedLength ||
    bytes.byteLength > options.maxBytes
  ) {
    return;
  }

  const end = start + bytes.byteLength;
  if (!Number.isSafeInteger(end)) return;
  if (options.maxIntervals <= 0) return;
  for (const entry of state.entries) {
    if (start >= entry.start && end <= entry.end) return;
  }

  const retained = state.entries.filter((entry) => entry.start < start || entry.end > end);
  let retainedBytes = retained.reduce((total, entry) => total + entry.bytes.byteLength, 0);
  while (
    retained.length > 0 &&
    (retained.length >= options.maxIntervals || retainedBytes + bytes.byteLength > options.maxBytes)
  ) {
    const evicted = retained.shift();
    if (evicted !== undefined) retainedBytes -= evicted.bytes.byteLength;
  }
  if (retainedBytes + bytes.byteLength > options.maxBytes) return;

  const owned = bytes.slice();
  state.entries = [...retained, { start, end, bytes: owned }];
  state.totalBytes = retainedBytes + owned.byteLength;
  state.expiresAtMs = Date.now() + options.ttlMs;
}

/**
 * Learn EOF only from a short **prefix** read (`start === 0`): a `Source.range` never short-reads
 * before EOF (source.ts contract), so a short prefix pins the total, while a short *mid-file* read
 * can only mean a violating transport and must never be trusted as EOF.
 */
function learnEndOfFile(
  state: ProbeRangeCacheState,
  src: Source,
  start: number,
  requestedEnd: number,
  bytes: Uint8Array,
): void {
  const learned =
    src.size ??
    state.size ??
    (start === 0 && bytes.byteLength < Math.max(0, Math.trunc(requestedEnd))
      ? bytes.byteLength
      : undefined);
  if (learned !== undefined) state.size = learned;
}

/**
 * Wrap a seekable source with bounded byte-only reuse across repeated probes of that exact object.
 * Range-less one-shot streams bypass this path, and distinct source snapshots never share state.
 */
export function cacheRepeatedProbeRanges(
  src: Source,
  cache: WeakMap<Source, ProbeRangeCacheState>,
  options: ProbeRangeCacheOptions,
): Source {
  const range = src.range;
  if (range === undefined) return src;

  const nowMs = Date.now();
  const prior = cache.get(src);
  const state =
    prior !== undefined && prior.expiresAtMs > nowMs
      ? prior
      : freshState(src, nowMs + options.ttlMs);
  if (state !== prior) cache.set(src, state);

  const cachedRange = async (
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    throwIfSourceAborted(signal); // deterministic: even a cache hit rejects once aborted
    const sourceSize = src.size ?? state.size;
    const hit = cachedCopy(state, start, end, sourceSize);
    if (hit !== undefined) return hit;

    const leading = cachedLeadingInterval(state, start, end, sourceSize);
    if (leading !== undefined) {
      const effectiveEnd = sourceSize === undefined ? end : Math.min(end, sourceSize);
      const suffix = await range.call(src, leading.end, effectiveEnd, signal);
      const bytes = joinLeadingInterval(leading, start, suffix);
      learnEndOfFile(state, src, start, end, bytes);
      retainRange(state, start, end, bytes, options);
      return bytes;
    }

    const bytes = await range.call(src, start, end, signal);
    learnEndOfFile(state, src, start, end, bytes);
    retainRange(state, start, end, bytes, options);
    return bytes;
  };

  // A forwarding wrapper, not a clone: every own key/symbol/getter (and every fact learned onto the
  // source *after* wrapping — redirected URL, size, rangesHonored) is read live off the original.
  return new Proxy(src, {
    get(target, property, receiver): unknown {
      if (property === 'range') return cachedRange;
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
      if (property === 'range') {
        return { value: cachedRange, writable: true, enumerable: true, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
}

/**
 * The engine-owned cache field: installed once on the owner itself (non-enumerable, symbol-keyed)
 * so cache lifetime is exactly the engine's lifetime and no module-level registry exists.
 */
const OWNER_PROBE_CACHES: unique symbol = Symbol('probe-range-caches');

interface ProbeCacheOwner {
  readonly [OWNER_PROBE_CACHES]?: WeakMap<Source, ProbeRangeCacheState>;
}

/** Reuse ranges within one engine without retaining either the engine or its immutable source snapshots. */
export function cacheRepeatedProbeRangesFor(owner: object, src: Source): Source {
  let cache = (owner as ProbeCacheOwner)[OWNER_PROBE_CACHES];
  if (cache === undefined) {
    cache = new WeakMap();
    Object.defineProperty(owner, OWNER_PROBE_CACHES, { value: cache });
  }
  return cacheRepeatedProbeRanges(src, cache, DEFAULT_PROBE_RANGE_CACHE_OPTIONS);
}
