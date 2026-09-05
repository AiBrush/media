/**
 * Query-selective first-party container registration.
 *
 * A concrete audio hint or definite MP4/WebM mux target can load its one immediately-needed driver
 * without importing the register-all defaults bundle (whose unrelated container/codec/filter proxies
 * otherwise become permanent first-op baseline). Ambiguous queries return `false`; the engine then
 * retains the complete established fallback.
 */

import type { ContainerQuery, DriverModule, Registry } from '../contracts/driver.ts';
import { MAGIC_CONTAINERS } from './container-magic-registration.ts';
import type { ContainerDriver } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import type { Router } from '../kernel/router.ts';
import {
  matchesAdts,
  matchesAiff,
  matchesCaf,
  matchesMp3,
  matchesOgg,
  matchesWav,
} from './audio-container-sniff.ts';

interface SelectiveContainerSpec {
  /** The exact id of the driver this spec's `load()` registers — pins resolve against it. */
  readonly id: string;
  readonly matches: (query: ContainerQuery) => boolean;
  readonly load: () => Promise<DriverModule>;
  /** Output-only modules must not be selected by id for a query their predicate rejects. */
  readonly pinnedRequiresMatch?: true;
}

/** Every query-selective first-party container, keyed by the real registered driver id. */
export const SELECTIVE_CONTAINERS: readonly SelectiveContainerSpec[] = [
  ...MAGIC_CONTAINERS.map((spec) => ({ ...spec, pinnedRequiresMatch: true as const })),
  {
    id: 'wav',
    matches: matchesWav,
    load: () => import('./wav/wav-lazy-driver.ts').then((module) => module.default),
  },
  {
    id: 'mp3',
    matches: matchesMp3,
    load: () => import('./mp3/mp3-driver.ts').then((module) => module.default),
  },
  {
    id: 'ogg',
    matches: matchesOgg,
    load: () => import('./ogg/ogg-driver.ts').then((module) => module.default),
  },
  {
    id: 'adts',
    matches: matchesAdts,
    load: () => import('./adts/adts-driver.ts').then((module) => module.default),
  },
  {
    id: 'aiff',
    matches: matchesAiff,
    load: () => import('./aiff/aiff-driver.ts').then((module) => module.default),
  },
  {
    id: 'caf',
    matches: matchesCaf,
    load: () => import('./caf/caf-driver.ts').then((module) => module.default),
  },
  {
    id: 'mp4-mux',
    matches: (query) => matchesMuxExtension(query, ['mp4', 'mov']),
    load: () => import('./mp4/mp4-mux-driver.ts').then((module) => module.default),
    pinnedRequiresMatch: true,
  },
  {
    id: 'webm-mux',
    matches: (query) => matchesMuxExtension(query, ['webm', 'mkv', 'mka']),
    load: () => import('./webm/webm-mux-driver.ts').then((module) => module.default),
    pinnedRequiresMatch: true,
  },
];

function matchesMuxExtension(query: ContainerQuery, extensions: readonly string[]): boolean {
  return (
    query.direction === 'mux' &&
    query.extension !== undefined &&
    extensions.includes(query.extension.toLowerCase())
  );
}

/** Register exactly one definite first-party container. `false` means use the full fallback. */
export async function registerDefaultContainerForQuery(
  registry: Registry,
  query: ContainerQuery,
  pinDriver?: string,
  beforeRegister?: () => void,
): Promise<boolean> {
  const spec =
    pinDriver === undefined
      ? SELECTIVE_CONTAINERS.find((candidate) => candidate.matches(query))
      : SELECTIVE_CONTAINERS.find(
          (candidate) =>
            candidate.id === pinDriver &&
            (candidate.pinnedRequiresMatch !== true || candidate.matches(query)),
        );
  if (spec === undefined) return false;
  const module = await spec.load();
  beforeRegister?.();
  module.register(registry);
  return true;
}

/** Complete lazy miss path: one-family retry, then the caller-owned register-all fallback. */
export async function pickContainerWithDefaultFallback(
  registry: Registry,
  router: Router,
  query: ContainerQuery,
  pinDriver: string | undefined,
  registerAll: () => Promise<void>,
  beforeSelectiveRegister?: () => void,
): Promise<ContainerDriver> {
  const select = pinDriver === undefined ? {} : { pinDriver };
  if (await registerDefaultContainerForQuery(registry, query, pinDriver, beforeSelectiveRegister)) {
    router.clearCache();
    try {
      return router.pickContainer(query, select);
    } catch (error) {
      if (!(error instanceof CapabilityError)) throw error;
    }
  }
  await registerAll();
  return router.pickContainer(query, select);
}
