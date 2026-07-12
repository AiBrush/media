/** Bounded exact-source byte-interval reuse for repeated metadata probes (ADR-246). */

import { SOURCE_URL_KEY, type Source } from './source.ts';

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

const DEFAULT_OPTIONS: ProbeRangeCacheOptions = {
  maxBytes: 1024 * 1024,
  maxIntervals: 8,
  ttlMs: 60_000,
};
const cachesByOwner = new WeakMap<object, WeakMap<Source, ProbeRangeCacheState>>();

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

function preserveLiveSourceFacts(
  wrapped: Source,
  src: Source,
  state: ProbeRangeCacheState,
): Source {
  Object.defineProperties(wrapped, {
    size: {
      configurable: true,
      enumerable: true,
      get: () => src.size ?? state.size,
    },
    [SOURCE_URL_KEY]: {
      configurable: true,
      enumerable: true,
      get: () => src[SOURCE_URL_KEY],
    },
  });
  return wrapped;
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

  const wrapped: Source = {
    ...src,
    range: (start, end) => {
      const sourceSize = src.size ?? state.size;
      const hit = cachedCopy(state, start, end, sourceSize);
      if (hit !== undefined) return Promise.resolve(hit);

      const leading = cachedLeadingInterval(state, start, end, sourceSize);
      if (leading !== undefined) {
        const effectiveEnd = sourceSize === undefined ? end : Math.min(end, sourceSize);
        return range.call(src, leading.end, effectiveEnd).then((suffix) => {
          const bytes = joinLeadingInterval(leading, start, suffix);
          const learnedSize =
            src.size ??
            state.size ??
            (start === 0 && bytes.byteLength < Math.max(0, Math.trunc(end))
              ? bytes.byteLength
              : undefined);
          if (learnedSize !== undefined) state.size = learnedSize;
          retainRange(state, start, end, bytes, options);
          return bytes;
        });
      }

      return range.call(src, start, end).then((bytes) => {
        const learnedSize =
          src.size ??
          state.size ??
          (start === 0 && bytes.byteLength < Math.max(0, Math.trunc(end))
            ? bytes.byteLength
            : undefined);
        if (learnedSize !== undefined) state.size = learnedSize;
        retainRange(state, start, end, bytes, options);
        return bytes;
      });
    },
  };
  return preserveLiveSourceFacts(wrapped, src, state);
}

/** Reuse ranges within one engine without retaining either the engine or its immutable source snapshots. */
export function cacheRepeatedProbeRangesFor(owner: object, src: Source): Source {
  let cache = cachesByOwner.get(owner);
  if (cache === undefined) {
    cache = new WeakMap();
    cachesByOwner.set(owner, cache);
  }
  return cacheRepeatedProbeRanges(src, cache, DEFAULT_OPTIONS);
}
