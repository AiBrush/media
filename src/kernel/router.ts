/**
 * The capability router (docs/architecture/04) — selects exactly one driver per stage by walking the
 * ladder best-first, probing each driver's cheap `supports()`, caching the verdict, and lazily loading
 * the chosen driver's module. A miss is a typed {@link CapabilityError} naming what was tried
 * (ADR-017), never a silent wrong result.
 *
 * `determinism: 'force-software'` drops the hardware/gpu tiers before ranking so output is reproducible
 * across machines (ADR-007).
 */

import type {
  CodecDriver,
  CodecQuery,
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
}

/** Hook the router calls before probing a driver, to lazily import its module (no-op by default). */
export type EnsureLoaded = (driver: DriverBase) => void | Promise<void>;

export interface RouterDeps {
  registry: RegistryView;
  ensureLoaded?: EnsureLoaded;
}

const MAX_CODEC_CACHE_ENTRIES = 64;
const MAX_CODEC_CONFIG_KEY_UNITS = 4096;

export class Router {
  readonly #registry: RegistryView;
  readonly #ensureLoaded: EnsureLoaded;
  readonly #codecCache = new Map<string, CodecDriver>();
  readonly #containerCache = new Map<string, ContainerDriver>();
  readonly #filterCache = new Map<string, FilterDriver>();

  constructor(deps: RouterDeps) {
    this.#registry = deps.registry;
    this.#ensureLoaded = deps.ensureLoaded ?? noop;
  }

  /** Select a codec driver (async: `supports()` wraps `isConfigSupported`). */
  async pickCodec(q: CodecQuery, opts: StageSelectOptions = {}): Promise<CodecDriver> {
    const determinism: Determinism = opts.determinism ?? 'auto';
    const tiny = opts.cost !== undefined && isTinyCost(opts.cost);
    const key = codecCacheKey(q, determinism, tiny);
    const cached = key === undefined ? undefined : this.#codecCache.get(key);
    if (cached !== undefined && key !== undefined) {
      // Map insertion order is the LRU order; refreshing a hit keeps hot exact configs resident.
      this.#codecCache.delete(key);
      this.#codecCache.set(key, cached);
      return cached;
    }

    const candidates = this.#registry
      .codecs()
      .filter((d) => (determinism === 'force-software' ? isSoftwareTier(d.tier) : true))
      .slice()
      .sort((a, b) => codecTierRank(a.tier, tiny) - codecTierRank(b.tier, tiny));

    for (const d of candidates) {
      await this.#ensureLoaded(d);
      const s = await d.supports(q);
      if (s.supported) {
        // `supports()` is asynchronous. Cache only if the caller-owned dictionary stayed byte-for-byte
        // stable across the probe, and only for the top rung: a cached fallback would prevent recovery
        // when a temporarily unavailable higher tier becomes available later in the session.
        if (
          d === candidates[0] &&
          key !== undefined &&
          codecCacheKey(q, determinism, tiny) === key
        ) {
          this.#rememberCodec(key, d);
        }
        return d;
      }
    }
    throw new CapabilityError(
      'capability-miss',
      `no codec driver for ${q.direction} ${q.mediaType}/${q.config.codec}`,
      { op: q, tried: candidates.map((d) => d.id) },
    );
  }

  /** Select a container driver (sync: magic/mime/extension). Registration order is the ladder. */
  pickContainer(q: ContainerQuery): ContainerDriver {
    const key = containerKey(q);
    if (key !== undefined) {
      const cached = this.#containerCache.get(key);
      if (cached) return cached;
    }

    const candidates = this.#registry.containers();
    for (const d of candidates) {
      if (d.supports(q)) {
        if (key !== undefined) this.#containerCache.set(key, d);
        return d;
      }
    }
    throw new CapabilityError(
      'capability-miss',
      `no container driver for ${q.direction} ${q.mime ?? q.extension ?? 'unknown'}`,
      { op: q, tried: candidates.map((d) => d.id) },
    );
  }

  /** Select a filter driver (sync). `force-software` drops the GPU substrates. */
  pickFilter(spec: FilterSpec, opts: StageSelectOptions = {}): FilterDriver {
    const determinism: Determinism = opts.determinism ?? 'auto';
    const tiny =
      opts.cost === undefined ? isTinyFilterSpec(spec) : isTinyFilterCost(spec, opts.cost);
    const key = `filter|${spec.mediaType}|${spec.type}|${determinism}|${tiny ? 1 : 0}`;
    const cached = this.#filterCache.get(key);
    if (cached?.supports(spec)) return cached;
    if (cached) this.#filterCache.delete(key);

    const candidates = this.#registry
      .filters()
      .filter((d) => (determinism === 'force-software' ? isSoftwareSubstrate(d.substrate) : true))
      .slice()
      .sort((a, b) => filterRank(a.substrate, tiny) - filterRank(b.substrate, tiny));

    for (const d of candidates) {
      if (d === cached) continue; // this exact spec already rejected the cached driver above
      if (d.supports(spec)) {
        // Revalidate a coarse hit and cache only the top rung. A target-dependent lower fallback must not
        // hide a faster driver that supports a later spec sharing the same media/type/cost bucket.
        if (d === candidates[0]) this.#filterCache.set(key, d);
        return d;
      }
    }
    throw new CapabilityError(
      'capability-miss',
      `no filter driver for ${spec.mediaType} ${spec.type}`,
      {
        op: spec,
        tried: candidates.map((d) => d.id),
      },
    );
  }

  /** Drop all cached verdicts (e.g. after registering new drivers in a long-lived session). */
  clearCache(): void {
    this.#codecCache.clear();
    this.#containerCache.clear();
    this.#filterCache.clear();
  }

  #rememberCodec(key: string, driver: CodecDriver): void {
    this.#codecCache.delete(key);
    this.#codecCache.set(key, driver);
    if (this.#codecCache.size <= MAX_CODEC_CACHE_ENTRIES) return;
    const oldest = this.#codecCache.keys().next().value;
    if (oldest !== undefined) this.#codecCache.delete(oldest);
  }
}

function isSoftwareTier(tier: Tier): boolean {
  return tier !== 'hardware' && tier !== 'gpu';
}

function isSoftwareSubstrate(substrate: FilterSubstrate): boolean {
  return substrate !== 'webgpu' && substrate !== 'webgl';
}

function isTinyFilterSpec(spec: FilterSpec): boolean {
  switch (spec.type) {
    case 'resize':
    case 'crop':
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

function codecCacheKey(q: CodecQuery, determinism: Determinism, tiny: boolean): string | undefined {
  const config = exactRecordIdentity(q.config);
  if (config === undefined) return undefined;
  return `codec|${q.mediaType}|${q.direction}|${determinism}|${tiny ? 1 : 0}|${config}`;
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
function containerKey(q: ContainerQuery): string | undefined {
  if (q.mime === undefined && q.extension === undefined) return undefined;
  return `container|${q.direction}|${q.mime ?? ''}|${q.extension ?? ''}`;
}

function noop(): void {
  // default ensureLoaded — drivers are already materialized in the registry.
}
