/**
 * Lazy finite-blob probe handoff. Keeping this bounded cross-Source policy out of the default entry's
 * eager closure preserves the kernel budget; `engine.ts` imports it only for a `blob:` Source candidate.
 */

import type { Determinism } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { raceAbort, throwIfSourceAborted } from '../sources/abort.ts';
import {
  type MediaInput,
  SOURCE_CACHE_KEY,
  SOURCE_URL_KEY,
  type Source,
  isSource,
} from '../sources/source.ts';
import { type SourcePrefixHandoff, sourceMayBeHlsManifest } from './source-io.ts';
import type { CallOptions, Cancellable, Container, MediaInfo } from './types.ts';

const TTL_MS = 250;
const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 8;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * Full immutable-snapshot gate. A finite blob URL plus explicit size is a caller assertion; mutable
 * `MediaSource` callers must omit that identity or mint a new URL/Source when their bytes change.
 */
export function isFiniteBlobUrlSource(src: Source): boolean {
  const key = src[SOURCE_CACHE_KEY];
  return (
    src.kind === 'url' &&
    typeof key === 'string' &&
    key.toLowerCase().startsWith('blob:') &&
    typeof src.size === 'number' &&
    Number.isSafeInteger(src.size) &&
    src.size >= 0
  );
}

interface ProbeContainerResultEntry {
  readonly info: MediaInfo;
  readonly expiry: ReturnType<typeof setTimeout>;
  readonly expiresAtMs: number;
}

interface ProbeContainerResultCacheState {
  readonly entries: Map<string, ProbeContainerResultEntry>;
  active: boolean;
}

/**
 * Engine-owned, success-only probe facts. The optional container token separates generic `probe` from
 * targeted `probeContainer`; the complete key prevents strategy/source aliases, while owned snapshots
 * and defensive hit clones keep mutable public results outside cache ownership.
 */
export class ProbeContainerResultCache {
  readonly #handoff: Map<string, SourcePrefixHandoff>;
  readonly #state: ProbeContainerResultCacheState;
  /** Frozen for this wrapped operation; a size learned by that operation cannot admit its result. */
  readonly #storeAdmitted: boolean;

  constructor(
    handoff: Map<string, SourcePrefixHandoff>,
    state: ProbeContainerResultCacheState = {
      entries: new Map<string, ProbeContainerResultEntry>(),
      active: true,
    },
    storeAdmitted = false,
  ) {
    this.#handoff = handoff;
    this.#state = state;
    this.#storeAdmitted = storeAdmitted;
  }

  wrap(source: Source): readonly [Source, ProbeContainerResultCache] {
    const admitted = isFiniteBlobUrlSource(source);
    return [
      cacheFiniteBlobProbeRanges(source, this.#handoff),
      new ProbeContainerResultCache(this.#handoff, this.#state, admitted),
    ];
  }

  hit(
    input: MediaInput,
    options: CallOptions,
    container?: Container,
  ): Cancellable<MediaInfo> | undefined {
    if (!this.#state.active || !isSource(input)) return undefined;
    const source = input;
    const key = probeResultKey(source, container, options, options.strategy?.determinism);
    if (key === undefined) return undefined;
    const entry = this.#state.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= Date.now()) {
      this.#state.entries.delete(key);
      clearTimeout(entry.expiry);
      return undefined;
    }
    this.#state.entries.delete(key);
    this.#state.entries.set(key, entry);
    return cachedCancellable(cloneMediaInfo(entry.info), options.signal);
  }

  store(source: Source, options: CallOptions, info: MediaInfo, container?: Container): void {
    if (!this.#state.active || !this.#storeAdmitted) return;
    const key = probeResultKey(source, container, options, options.strategy?.determinism);
    if (key === undefined) return;
    const previous = this.#state.entries.get(key);
    if (previous !== undefined) clearTimeout(previous.expiry);
    this.#state.entries.delete(key);

    const expiry = setTimeout(() => {
      if (this.#state.entries.get(key)?.expiry === expiry) this.#state.entries.delete(key);
    }, TTL_MS);
    this.#state.entries.set(key, {
      info: cloneMediaInfo(info),
      expiry,
      expiresAtMs: Date.now() + TTL_MS,
    });
    while (this.#state.entries.size > MAX_ENTRIES) {
      const oldest = this.#state.entries.entries().next().value;
      if (oldest === undefined) break;
      const [oldestKey, oldestEntry] = oldest;
      this.#state.entries.delete(oldestKey);
      clearTimeout(oldestEntry.expiry);
    }
  }

  clear(): void {
    if (!this.#state.active) return;
    this.#state.active = false;
    for (const entry of this.#state.entries.values()) clearTimeout(entry.expiry);
    this.#state.entries.clear();
  }
}

function probeResultKey(
  source: Source,
  container: Container | undefined,
  options: CallOptions,
  determinism: Determinism | undefined,
): string | undefined {
  if (
    !isFiniteBlobUrlSource(source) ||
    sourceMayBeHlsManifest(source) ||
    options.onProgress !== undefined ||
    Object.keys(options).some((key) => !SAFE_CALL_OPTION_KEYS.has(key))
  ) {
    return undefined;
  }
  const strategy = options.strategy;
  if (
    strategy !== undefined &&
    Object.keys(strategy).some((key) => !SAFE_STRATEGY_OPTION_KEYS.has(key))
  ) {
    return undefined;
  }
  const cacheKey = source[SOURCE_CACHE_KEY];
  if (typeof cacheKey !== 'string' || source.size === undefined) return undefined;
  return JSON.stringify([
    cacheKey,
    source[SOURCE_URL_KEY] ?? cacheKey,
    source.size,
    source.mimeHint ?? null,
    source.filename ?? null,
    container ?? null,
    determinism,
    strategy?.pinDriver ?? null,
  ]);
}

const SAFE_CALL_OPTION_KEYS = new Set(['signal', 'strategy']);
const SAFE_STRATEGY_OPTION_KEYS = new Set(['determinism', 'pinDriver']);

function cloneMediaInfo(info: MediaInfo): MediaInfo {
  return {
    container: info.container,
    durationSec: info.durationSec,
    ...(info.sizeBytes !== undefined ? { sizeBytes: info.sizeBytes } : {}),
    tracks: info.tracks.map((track) => ({ ...track })),
    ...(info.tags !== undefined ? { tags: { ...info.tags } } : {}),
  };
}

function cachedCancellable<T>(value: T, signal: AbortSignal | undefined): Cancellable<T> {
  let cancelled = false;
  const promise = Promise.resolve().then((): T => {
    if (signal?.aborted) throw new MediaError('aborted', 'aborted');
    if (cancelled) throw new MediaError('aborted', 'operation cancelled');
    return value;
  }) as Cancellable<T>;
  promise.cancel = (): void => {
    cancelled = true;
  };
  return promise;
}

/** Reuse one owned start-at-zero prefix across fresh finite Sources with the same blob URL and size. */
export function cacheFiniteBlobProbeRanges(
  src: Source,
  handoff: Map<string, SourcePrefixHandoff>,
  options: { readonly maxBytes?: number; readonly ttlMs?: number } = {},
): Source {
  const range = src.range;
  const key = src[SOURCE_CACHE_KEY];
  if (range === undefined || !isFiniteBlobUrlSource(src) || typeof key !== 'string') return src;

  const prior = live(handoff, key);
  const matching = prior?.reusable === true && prior.size === src.size ? prior : undefined;
  if (prior !== undefined && matching === undefined) drop(handoff, key, prior.token);
  let cached = matching?.bytes;
  let touched = false;
  return {
    ...src,
    range: async (start, end, signal) => {
      throwIfSourceAborted(signal);
      const sourceSize = src.size;
      const covered =
        cached !== undefined &&
        (end <= cached.byteLength ||
          (sourceSize !== undefined && cached.byteLength >= sourceSize && end >= sourceSize));
      if (cached !== undefined && start >= 0 && covered) {
        if (!touched) {
          const current = live(handoff, key);
          if (current?.reusable === true && current.size === sourceSize)
            touch(handoff, key, current);
          touched = true;
        }
        throwIfSourceAborted(signal);
        // The retained prefix is engine-owned. Never expose its backing buffer to a driver: a mutable
        // view could poison every later fresh Source carrying the same immutable Blob identity.
        return cached.slice(start, end);
      }

      const bytes = await raceAbort(range.call(src, start, end, signal), signal);
      throwIfSourceAborted(signal);
      const cacheable = options.maxBytes === undefined || bytes.byteLength <= options.maxBytes;
      if (
        start === 0 &&
        cacheable &&
        bytes.byteLength <= MAX_BYTES &&
        (cached === undefined || bytes.byteLength > cached.byteLength)
      ) {
        cached = bytes;
        retain(handoff, key, bytes, sourceSize, options.ttlMs);
      }
      throwIfSourceAborted(signal);
      return bytes;
    },
  };
}

function retain(
  handoff: Map<string, SourcePrefixHandoff>,
  key: string,
  bytes: Uint8Array,
  size: number | undefined,
  ttlMs: number = TTL_MS,
): void {
  const current = live(handoff, key);
  if (current?.reusable === true && current.size === size) {
    handoff.delete(key);
    handoff.set(key, {
      ...current,
      bytes: current.bytes.byteLength >= bytes.byteLength ? current.bytes : bytes.slice(),
    });
    evict(handoff);
    return;
  }

  drop(handoff, key);
  const finiteTtl = Number.isFinite(ttlMs) ? Math.trunc(ttlMs) : 0;
  const delay = Math.max(0, Math.min(TTL_MS, finiteTtl));
  const token = setTimeout(() => drop(handoff, key, token), delay);
  handoff.set(key, {
    bytes: bytes.slice(),
    ...(size !== undefined ? { size } : {}),
    reusable: true,
    expiresAtMs: Date.now() + delay,
    token,
  });
  evict(handoff);
}

function live(
  handoff: Map<string, SourcePrefixHandoff>,
  key: string,
): SourcePrefixHandoff | undefined {
  const entry = handoff.get(key);
  if (entry?.expiresAtMs !== undefined && entry.expiresAtMs <= Date.now()) {
    drop(handoff, key, entry.token);
    return undefined;
  }
  return entry;
}

function touch(
  handoff: Map<string, SourcePrefixHandoff>,
  key: string,
  expected: SourcePrefixHandoff,
): void {
  if (handoff.get(key)?.token !== expected.token) return;
  handoff.delete(key);
  handoff.set(key, expected);
}

function drop(
  handoff: Map<string, SourcePrefixHandoff>,
  key: string,
  expectedToken?: ReturnType<typeof setTimeout>,
): void {
  const entry = handoff.get(key);
  if (entry === undefined || (expectedToken !== undefined && entry.token !== expectedToken)) {
    return;
  }
  handoff.delete(key);
  clearTimeout(entry.token);
}

function evict(handoff: Map<string, SourcePrefixHandoff>): void {
  let total = 0;
  for (const entry of handoff.values()) total += entry.bytes.byteLength;
  while (handoff.size > MAX_ENTRIES || total > MAX_TOTAL_BYTES) {
    const oldest = handoff.entries().next().value;
    if (oldest === undefined) break;
    const [key, entry] = oldest;
    total -= entry.bytes.byteLength;
    drop(handoff, key, entry.token);
  }
}
