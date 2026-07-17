/**
 * The capability router (docs/architecture/capability-router.md) — selects exactly one driver per stage
 * by walking the tier ladder best-first, probing each driver's cheap `supports()`, and caching verdicts
 * in bounded per-kind LRU maps. A miss is a typed {@link CapabilityError} naming what was probed
 * (ADR-017), never a silent wrong result.
 *
 * Module loading: the router imports no driver code. The shipped engine owns miss-only lazy loading by
 * registering driver bundles on a typed miss and retrying the pick; the optional {@link EnsureLoaded}
 * hook exists for embedders who construct their own `Router` and want per-candidate lazy loading inside
 * the walk — it is awaited once per probed candidate, in ladder order, before that candidate's
 * `supports()`, so a WASM tail is loaded only after every higher rung declined.
 *
 * Execution-time misses: `isConfigSupported` can lie (ADR-284) — a driver that probes `true` may still
 * throw a typed `CapabilityError` on the first coded packets. {@link Router.evictCodec} records that
 * runtime verdict for the exact selection context so subsequent walks skip the failed driver. Evictions
 * survive {@link Router.clearCache}: registration changes what is *available*, never what already
 * *failed* on real packets — otherwise the engine's register-defaults-and-retry path would re-select the
 * liar while the one-shot replay prefix is already committed.
 *
 * `determinism: 'force-software'` admits a WebCodecs-ranked driver only after an explicit non-hardware
 * capability verdict and drops GPU/canvas substrates, so output is reproducible across machines (ADR-007).
 */

import type {
  CodecDriver,
  CodecQuery,
  CodecSupport,
  ContainerDriver,
  ContainerQuery,
  Determinism,
  DriverBase,
  FilterDriver,
  FilterSpec,
  FilterSubstrate,
  Tier,
} from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import type { RegistryView } from './registry.ts';
import {
  type RouteCost,
  TINY_AUDIO_FRAMES,
  TINY_INPUT_BYTES,
  TINY_MEDIA_SECONDS,
  TINY_VIDEO_PIXELS,
  TINY_VIDEO_PIXEL_WORK,
} from './tier-thresholds.ts';

/** Per-selection options. Cost is an internal ADR-020 re-ranking input, never a public backend knob. */
export interface StageSelectOptions {
  determinism?: Determinism;
  cost?: RouteCost;
  /** Exact hidden ADR-014 driver pin, scoped to the registered kind carrying this id. */
  pinDriver?: string;
}

/**
 * Optional embedder hook awaited before each candidate probe, to lazily import that driver's module.
 * The shipped engine supplies none (its drivers are materialized before registration and it owns
 * miss-only loading via registration + retry); the default is a no-op.
 */
export type EnsureLoaded = (driver: DriverBase) => void | Promise<void>;

export interface RouterDeps {
  registry: RegistryView;
  ensureLoaded?: EnsureLoaded;
}

/** A codec selection: the driver plus the exact accepted capability verdict (ADR-203). */
export interface CodecRoute {
  readonly driver: CodecDriver;
  /**
   * Frozen snapshot of the verdict the accepted probe returned. Callers configure the exact accepted
   * `hardwareAcceleration` rung from `support.hardwareAccelerated` with **no second probe** — discarding
   * it and re-deriving the rung caused the ADR-203 ~4× decode regression.
   */
  readonly support: Readonly<CodecSupport>;
}

/**
 * Read-only diagnostic view of the router's bounded caches: opaque verdict keys per kind, in
 * least-recently-used → most-recently-used order. For observability and tests only — the key format is
 * unstable and must never be parsed for routing decisions.
 */
export interface RouterCacheSnapshot {
  readonly codec: readonly string[];
  readonly container: readonly string[];
  readonly filter: readonly string[];
  /** Exact selection contexts holding at least one execution-time miss record (ADR-284). */
  readonly runtimeMisses: readonly string[];
}

/** One bound for every per-kind verdict map, so a long-lived engine holds O(1) routing state. */
const MAX_CACHE_ENTRIES_PER_KIND = 64;
const MAX_CODEC_CONFIG_KEY_UNITS = 4096;

export class Router {
  readonly #registry: RegistryView;
  readonly #ensureLoaded: EnsureLoaded;
  readonly #codecCache = new Map<string, CodecRoute>();
  readonly #containerCache = new Map<string, ContainerDriver>();
  readonly #filterCache = new Map<string, FilterDriver>();
  /** Execution-time misses per exact selection context: key → driver ids that failed on real packets. */
  readonly #codecRuntimeMisses = new Map<string, Set<string>>();

  constructor(deps: RouterDeps) {
    this.#registry = deps.registry;
    this.#ensureLoaded = deps.ensureLoaded ?? noop;
  }

  /** Select a codec driver (async: `supports()` wraps `isConfigSupported`). */
  async pickCodec(q: CodecQuery, opts: StageSelectOptions = {}): Promise<CodecDriver> {
    return (await this.probeCodec(q, opts)).driver;
  }

  /**
   * Select a codec driver and surface the accepted capability verdict alongside it. The verdict is
   * cached with the driver, so a hit costs zero probes and still carries the exact accepted
   * `hardwareAccelerated` rung (ADR-203).
   */
  async probeCodec(q: CodecQuery, opts: StageSelectOptions = {}): Promise<CodecRoute> {
    const determinism: Determinism = opts.determinism ?? 'auto';
    const tiny = opts.cost !== undefined && isTinyCost(opts.cost);
    const registered = this.#registry.codecs();
    const pinned = this.#pinApplies('codec', opts.pinDriver);
    const pin = pinned ? opts.pinDriver : undefined;
    const key = codecCacheKey(q, determinism, tiny, pin);
    let evicted: ReadonlySet<string> | undefined;
    if (key !== undefined) {
      const cached = this.#codecCache.get(key);
      if (cached !== undefined) {
        // Map insertion order is the LRU order; refreshing a hit keeps hot exact configs resident.
        refreshRecency(this.#codecCache, key, cached);
        return cached;
      }
      const misses = this.#codecRuntimeMisses.get(key);
      if (misses !== undefined) {
        // A context still being routed is exactly one whose runtime-miss record must not age out.
        refreshRecency(this.#codecRuntimeMisses, key, misses);
        evicted = misses;
      }
    }

    const ladder = registered
      .filter((d) => (!pinned ? true : d.id === opts.pinDriver))
      .filter((d) => (determinism === 'force-software' ? d.tier !== 'gpu' : true))
      .slice()
      .sort((a, b) => codecTierRank(a.tier, tiny) - codecTierRank(b.tier, tiny));

    const probed: string[] = [];
    for (const d of ladder) {
      if (evicted?.has(d.id)) continue; // failed on real packets for this exact context (ADR-284)
      await this.#ensureLoaded(d);
      probed.push(d.id);
      const s = await d.supports(q, { determinism });
      if (supportsDeterminism(d, s, determinism)) {
        const route: CodecRoute = Object.freeze({ driver: d, support: snapshotSupport(s) });
        // `supports()` is asynchronous. Cache only if the caller-owned dictionary stayed byte-for-byte
        // stable across the probe, and only for the ladder head: a cached fallback would prevent
        // recovery when a temporarily unavailable higher tier becomes available later in the session
        // (ADR-207). An evicted ladder head therefore disables caching for its context entirely.
        if (
          d === ladder[0] &&
          key !== undefined &&
          codecCacheKey(q, determinism, tiny, pin) === key
        ) {
          rememberBounded(this.#codecCache, key, route);
        }
        return route;
      }
    }
    const evictedIds = evicted === undefined ? [] : [...evicted];
    throw new CapabilityError(
      pinned
        ? `pinned codec driver '${opts.pinDriver}' cannot ${q.direction} ${q.mediaType}/${q.config.codec}`
        : `no codec driver for ${q.direction} ${q.mediaType}/${q.config.codec}`,
      {
        op: { kind: 'codec', query: q },
        tried: probed,
        ...(evictedIds.length > 0
          ? {
              suggestion: `evicted after runtime capability misses for this exact config: ${evictedIds
                .map((id) => `'${id}'`)
                .join(', ')}`,
            }
          : {}),
      },
    );
  }

  /**
   * Record an execution-time capability miss (ADR-284): the driver's probe accepted this exact config
   * but its coder threw a typed `CapabilityError` on real packets. Drops the cached positive verdict
   * when it names the failed driver and pins a runtime-miss record so subsequent walks for the same
   * exact selection context (config bytes, determinism, tiny regime, pin) skip the driver — the caller
   * then simply re-picks to reach the next rung. Only this one verdict is touched; unrelated hot
   * verdicts stay cached. The record survives {@link clearCache} (see the module doc) and is bounded.
   *
   * Returns `false` when the config has no exact byte identity (hostile/cyclic shapes are never cached
   * or evicted); the caller owns exclusion for that op.
   */
  evictCodec(q: CodecQuery, failedDriverId: string, opts: StageSelectOptions = {}): boolean {
    const determinism: Determinism = opts.determinism ?? 'auto';
    const tiny = opts.cost !== undefined && isTinyCost(opts.cost);
    const pinned = this.#pinApplies('codec', opts.pinDriver);
    const key = codecCacheKey(q, determinism, tiny, pinned ? opts.pinDriver : undefined);
    if (key === undefined) return false;
    const cached = this.#codecCache.get(key);
    if (cached !== undefined && cached.driver.id === failedDriverId) this.#codecCache.delete(key);
    const misses = this.#codecRuntimeMisses.get(key) ?? new Set<string>();
    misses.add(failedDriverId);
    rememberBounded(this.#codecRuntimeMisses, key, misses);
    return true;
  }

  /**
   * Select a container driver (sync: magic/mime/extension). Containers have no tier: registration order
   * *is* the ladder, and the first driver whose `supports()` matches wins and is cached unconditionally.
   * That first-match caching is safe **only because** every registration path in the engine (`use()`,
   * default-bundle loads) calls {@link clearCache}, so a superseding registration can never be shadowed
   * by a stale verdict.
   */
  pickContainer(q: ContainerQuery, opts: StageSelectOptions = {}): ContainerDriver {
    const pinned = this.#pinApplies('container', opts.pinDriver);
    const key = containerKey(q, pinned ? opts.pinDriver : undefined);
    if (key !== undefined) {
      const cached = this.#containerCache.get(key);
      if (cached) {
        refreshRecency(this.#containerCache, key, cached);
        return cached;
      }
    }

    const candidates = this.#registry
      .containers()
      .filter((d) => (!pinned ? true : d.id === opts.pinDriver));
    for (const d of candidates) {
      if (d.supports(q)) {
        if (key !== undefined) rememberBounded(this.#containerCache, key, d);
        return d;
      }
    }
    throw new CapabilityError(
      pinned
        ? `pinned container driver '${opts.pinDriver}' cannot ${q.direction} ${q.mime ?? q.extension ?? 'unknown'}`
        : `no container driver for ${q.direction} ${q.mime ?? q.extension ?? 'unknown'}`,
      {
        op: { kind: 'container', query: q },
        tried: pinned ? [opts.pinDriver as string] : candidates.map((d) => d.id),
      },
    );
  }

  /** Select a filter driver (sync). `force-software` drops the GPU substrates. */
  pickFilter(spec: FilterSpec, opts: StageSelectOptions = {}): FilterDriver {
    const determinism: Determinism = opts.determinism ?? 'auto';
    const tiny =
      opts.cost === undefined ? isTinyFilterSpec(spec) : isTinyFilterCost(spec, opts.cost);
    const pinned = this.#pinApplies('filter', opts.pinDriver);
    const key = `filter|${spec.mediaType}|${spec.type}|${determinism}|${tiny ? 1 : 0}|${pinned ? opts.pinDriver : ''}`;
    const cached = this.#filterCache.get(key);
    if (cached?.supports(spec)) {
      refreshRecency(this.#filterCache, key, cached);
      return cached;
    }
    if (cached) this.#filterCache.delete(key);

    const candidates = this.#registry
      .filters()
      .filter((d) => (!pinned ? true : d.id === opts.pinDriver))
      .filter((d) => (determinism === 'force-software' ? isSoftwareSubstrate(d.substrate) : true))
      .slice()
      .sort((a, b) => filterRank(a.substrate, tiny) - filterRank(b.substrate, tiny));

    for (const d of candidates) {
      if (d === cached) continue; // this exact spec already rejected the cached driver above
      if (d.supports(spec)) {
        // Revalidate a coarse hit and cache only the top rung. A target-dependent lower fallback must not
        // hide a faster driver that supports a later spec sharing the same media/type/cost bucket.
        if (d === candidates[0]) rememberBounded(this.#filterCache, key, d);
        return d;
      }
    }
    throw new CapabilityError(
      pinned
        ? `pinned filter driver '${opts.pinDriver}' cannot run ${spec.mediaType} ${spec.type}`
        : `no filter driver for ${spec.mediaType} ${spec.type}`,
      {
        op: { kind: 'filter', spec },
        tried: pinned ? [opts.pinDriver as string] : candidates.map((d) => d.id),
      },
    );
  }

  /**
   * Drop every cached *probe* verdict (e.g. after registering new drivers in a long-lived session).
   * Runtime-miss records deliberately survive: a registration widens what is available but cannot make
   * a driver that already failed on real packets succeed on them (ADR-284).
   */
  clearCache(): void {
    this.#codecCache.clear();
    this.#containerCache.clear();
    this.#filterCache.clear();
  }

  /** Diagnostic snapshot of the bounded verdict caches. See {@link RouterCacheSnapshot}. */
  cacheSnapshot(): RouterCacheSnapshot {
    return {
      codec: [...this.#codecCache.keys()],
      container: [...this.#containerCache.keys()],
      filter: [...this.#filterCache.keys()],
      runtimeMisses: [...this.#codecRuntimeMisses.keys()],
    };
  }

  /**
   * A pin constrains only the registered driver kind carrying that id. This keeps compound graphs usable:
   * pinning a codec does not make their container/filter stages look for an impossible same-id driver.
   * An id absent from every kind is treated as a pin for the stage currently being routed, producing the
   * exact typed miss that lets the engine load defaults once and retry without consuming media.
   */
  #pinApplies(kind: 'codec' | 'container' | 'filter', pin: string | undefined): boolean {
    if (pin === undefined) return false;
    const codecs = this.#registry.codecs();
    const containers = this.#registry.containers();
    const filters = this.#registry.filters();
    const currentHasPin =
      kind === 'codec'
        ? codecs.some((driver) => driver.id === pin)
        : kind === 'container'
          ? containers.some((driver) => driver.id === pin)
          : filters.some((driver) => driver.id === pin);
    if (currentHasPin) return true;
    return (
      !codecs.some((driver) => driver.id === pin) &&
      !containers.some((driver) => driver.id === pin) &&
      !filters.some((driver) => driver.id === pin)
    );
  }
}

/**
 * Copy exactly the contract fields of a capability verdict into a frozen snapshot, so neither a driver
 * mutating the object it returned nor a caller can rewrite a cached verdict.
 */
function snapshotSupport(support: CodecSupport): Readonly<CodecSupport> {
  return Object.freeze({
    supported: support.supported,
    ...(support.hardwareAccelerated !== undefined
      ? { hardwareAccelerated: support.hardwareAccelerated }
      : {}),
    ...(support.reason !== undefined ? { reason: support.reason } : {}),
  });
}

/** LRU insert/update with eviction of the least-recently-used entry beyond the shared bound. */
function rememberBounded<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size <= MAX_CACHE_ENTRIES_PER_KIND) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

/** Move a hit to most-recently-used position (Map insertion order is the LRU order). */
function refreshRecency<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
}

function supportsDeterminism(
  driver: CodecDriver,
  support: CodecSupport,
  determinism: Determinism,
): boolean {
  if (!support.supported) return false;
  if (determinism !== 'force-software') return true;
  if (support.hardwareAccelerated === true) return false;
  return driver.tier !== 'hardware' || support.hardwareAccelerated === false;
}

function isSoftwareSubstrate(substrate: FilterSubstrate): boolean {
  return substrate !== 'webgpu' && substrate !== 'webgl' && substrate !== 'canvas2d';
}

function isTinyFilterSpec(spec: FilterSpec): boolean {
  switch (spec.type) {
    case 'resize':
    case 'crop':
    case 'pad':
      return within(spec.width * spec.height, TINY_VIDEO_PIXELS);
    case 'rotate':
    case 'flip':
    case 'colorspace':
    case 'tonemap':
    case 'resample':
    case 'remix':
    case 'gain':
    case 'fade':
    case 'biquad':
    case 'dynamics':
      // Audio specs carry no pixel cost; the audio-dsp native driver is the only candidate, so the
      // tiny/GPU re-ranking is moot — never "tiny" in the video-pixel sense.
      return false;
    default:
      return false;
  }
}

function isTinyCost(cost: RouteCost): boolean {
  return (
    within(cost.inputBytes, TINY_INPUT_BYTES) ||
    within(cost.outputPixels, TINY_VIDEO_PIXELS) ||
    within(cost.mediaSeconds, TINY_MEDIA_SECONDS) ||
    within(cost.audioFrames, TINY_AUDIO_FRAMES)
  );
}

/**
 * Video filters are proportional to pixels touched across frames, not to any single cost dimension.
 * In particular, a short duration must never move a high-resolution frame loop onto the CPU. Audio
 * filters retain the established multi-metric policy because their work is not pixel-shaped.
 */
function isTinyFilterCost(spec: FilterSpec, cost: RouteCost): boolean {
  if (spec.mediaType === 'video') {
    return within(cost.videoPixelWork, TINY_VIDEO_PIXEL_WORK);
  }
  return isTinyCost(cost);
}

function codecTierRank(tier: Tier, tiny: boolean): number {
  if (tier === 'hardware') return 0;
  if (tier === 'wasm') return 3;
  return tier === (tiny ? 'native' : 'gpu') ? 1 : 2;
}

function filterRank(substrate: FilterSubstrate, tiny: boolean): number {
  if (substrate === 'wasm') return 4;
  if (tiny) {
    if (substrate === 'native') return 0;
    if (substrate === 'canvas2d') return 1;
    return substrate === 'webgpu' ? 2 : 3;
  }
  if (substrate === 'webgpu') return 0;
  if (substrate === 'webgl') return 1;
  return substrate === 'canvas2d' ? 2 : 3;
}

function within(value: number | undefined, threshold: number): boolean {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= threshold;
}

function codecCacheKey(
  q: CodecQuery,
  determinism: Determinism,
  tiny: boolean,
  pinDriver?: string,
): string | undefined {
  const config = exactRecordIdentity(q.config);
  if (config === undefined) return undefined;
  return `codec|${q.mediaType}|${q.direction}|${determinism}|${tiny ? 1 : 0}|${pinDriver ?? ''}|${config}`;
}

/**
 * Snapshot every submitted record fact without invoking `toJSON` or an accessor. Ordinary BufferSource
 * windows participate byte-exactly; cyclic/shared/cross-realm/hostile shapes return no key and re-probe.
 */
function exactRecordIdentity(record: object): string | undefined {
  try {
    const key = exactValueIdentity(record, new Set<object>());
    return key.length <= MAX_CODEC_CONFIG_KEY_UNITS ? key : undefined;
  } catch {
    // Detached buffers and hostile proxy traps are valid reasons to skip an optimization, not routing.
    return undefined;
  }
}

function exactValueIdentity(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value !== 'object') {
    const type = typeof value;
    if (type === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
      if (!Number.isFinite(value)) throw new TypeError();
      return 'number:-0';
    }
    if (type === 'bigint' || type === 'function' || type === 'symbol') throw new TypeError();
    return `${type}:${JSON.stringify(value)}`;
  }
  if (ArrayBuffer.isView(value)) {
    if (!(value.buffer instanceof ArrayBuffer)) throw new TypeError();
    return exactBytesKey(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (value instanceof ArrayBuffer) return exactBytesKey(new Uint8Array(value));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  if (ancestors.has(value)) throw new TypeError();
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let key = 'o{';
    for (const name of Object.keys(descriptors)) {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !('value' in descriptor)) throw new TypeError();
      key += `${JSON.stringify(name)}:${exactValueIdentity(descriptor.value, ancestors)};`;
    }
    return `${key}}`;
  } finally {
    ancestors.delete(value);
  }
}

function exactBytesKey(bytes: Uint8Array): string {
  if (bytes.byteLength * 2 > MAX_CODEC_CONFIG_KEY_UNITS) throw new TypeError();
  let hex = 'b';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Cache key for a container query — only when a stable mime/extension is present. Head-only (magic)
 * probes are cheap and re-run each time rather than risk caching one driver for every headless probe.
 */
function containerKey(q: ContainerQuery, pinDriver?: string): string | undefined {
  if (q.mime === undefined && q.extension === undefined) return undefined;
  return `container|${q.direction}|${q.mime ?? ''}|${q.extension ?? ''}|${pinDriver ?? ''}`;
}

function noop(): void {
  // default ensureLoaded — drivers are already materialized in the registry.
}
