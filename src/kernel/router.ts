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
    const key = `codec|${q.mediaType}|${q.direction}|${q.config.codec}|${determinism}|${tiny ? 1 : 0}`;
    const cached = this.#codecCache.get(key);
    if (cached) return cached;

    const candidates = this.#registry
      .codecs()
      .filter((d) => (determinism === 'force-software' ? isSoftwareTier(d.tier) : true))
      .slice()
      .sort((a, b) => codecTierRank(a.tier, tiny) - codecTierRank(b.tier, tiny));

    for (const d of candidates) {
      await this.#ensureLoaded(d);
      const s = await d.supports(q);
      if (s.supported) {
        this.#codecCache.set(key, d);
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
    const tiny = opts.cost === undefined ? isTinyFilterSpec(spec) : isTinyCost(opts.cost);
    const key = `filter|${spec.mediaType}|${spec.type}|${determinism}|${tiny ? 1 : 0}`;
    const cached = this.#filterCache.get(key);
    if (cached) return cached;

    const candidates = this.#registry
      .filters()
      .filter((d) => (determinism === 'force-software' ? isSoftwareSubstrate(d.substrate) : true))
      .slice()
      .sort((a, b) => filterRank(a.substrate, tiny) - filterRank(b.substrate, tiny));

    for (const d of candidates) {
      if (d.supports(spec)) {
        this.#filterCache.set(key, d);
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
      return false;
    default:
      return spec;
  }
}

function isTinyCost(cost: RouteCost | undefined): boolean {
  if (cost === undefined) return false;
  return (
    within(cost.inputBytes, TINY_INPUT_BYTES) ||
    within(cost.outputPixels, TINY_VIDEO_PIXELS) ||
    within(cost.mediaSeconds, TINY_MEDIA_SECONDS) ||
    within(cost.audioFrames, TINY_AUDIO_FRAMES)
  );
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
