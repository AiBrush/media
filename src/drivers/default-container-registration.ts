/**
 * Query-selective first-party container registration.
 *
 * A concrete audio hint or definite MP4/WebM mux target can load its one immediately-needed driver
 * without importing the register-all defaults bundle (whose unrelated container/codec/filter proxies
 * otherwise become permanent first-op baseline). Ambiguous queries return `false`; the engine then
 * retains the complete established fallback.
 */

import type { ContainerQuery, DriverModule, Registry } from '../contracts/driver.ts';
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
  readonly id: string;
  readonly matches: (query: ContainerQuery) => boolean;
  readonly load: () => Promise<DriverModule>;
  /** Output-only modules must not be selected by id for a query their predicate rejects. */
  readonly pinnedRequiresMatch?: true;
}

const SELECTIVE_CONTAINERS: readonly SelectiveContainerSpec[] = [
  {
    id: 'mp4',
    matches: (query) => matchesDemuxFamily(query, ['mp4', 'mov', 'm4a', 'm4v', 'qt'], MP4_MIMES),
    load: () => import('./mp4/mp4-driver.ts').then((module) => module.Mp4Module),
    pinnedRequiresMatch: true,
  },
  {
    id: 'webm',
    matches: (query) =>
      matchesDemuxFamily(
        query,
        ['webm', 'mkv', 'mka'],
        ['video/webm', 'audio/webm', 'video/x-matroska', 'audio/x-matroska'],
      ),
    load: () => import('./webm/webm-driver.ts').then((module) => module.WebmModule),
    pinnedRequiresMatch: true,
  },
  {
    id: 'wav',
    matches: matchesWav,
    load: () => import('./wav/wav-driver.ts').then((module) => module.default),
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
    id: 'mp4',
    matches: (query) => matchesMuxExtension(query, ['mp4', 'mov']),
    load: () => import('./mp4/mp4-mux-driver.ts').then((module) => module.default),
    pinnedRequiresMatch: true,
  },
  {
    id: 'webm',
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

const MP4_MIMES = ['video/mp4', 'video/quicktime', 'audio/mp4', 'audio/x-m4a'] as const;

function matchesDemuxFamily(
  query: ContainerQuery,
  extensions: readonly string[],
  mimes: readonly string[],
): boolean {
  if (query.direction !== 'demux') return false;
  const extension = query.extension?.toLowerCase();
  if (extension !== undefined && extensions.includes(extension)) return true;
  const mime = query.mime?.toLowerCase().split(';', 1)[0]?.trim();
  return mime !== undefined && mimes.includes(mime);
}

/** Register exactly one definite first-party container. `false` means use the full fallback. */
export async function registerDefaultContainerForQuery(
  registry: Registry,
  query: ContainerQuery,
  pinDriver?: string,
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
  (await spec.load()).register(registry);
  return true;
}

/** Complete lazy miss path: one-family retry, then the caller-owned register-all fallback. */
export async function pickContainerWithDefaultFallback(
  registry: Registry,
  router: Router,
  query: ContainerQuery,
  pinDriver: string | undefined,
  registerAll: () => Promise<void>,
): Promise<ContainerDriver> {
  const select = pinDriver === undefined ? {} : { pinDriver };
  if (await registerDefaultContainerForQuery(registry, query, pinDriver)) {
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
