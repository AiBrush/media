/**
 * Lazy finite-source probe orchestration. The default entry keeps construction, cache hits, input
 * normalization, live-source dispatch, and cancellation ownership eager; byte/container probing loads
 * this runner only when an operation actually needs it.
 */

import type { ImageOps } from '../codecs/image/index.ts';
import type { ContainerDriver, ContainerQuery, StageOptions } from '../contracts/driver.ts';
import {
  matchesIsoBmffMagic,
  matchesMatroskaMagic,
} from '../drivers/container-magic-registration.ts';
import { MediaError } from '../contracts/errors.ts';
import { type MediaInput, type Source, cancelSource } from '../sources/source.ts';
import { memoizeAsync } from '../util/memoize-async.ts';
import type { ProbeContainerResultCache } from './blob-probe-handoff.ts';
import { toMediaInfo } from './probe-media-info.ts';
import {
  type SourcePrefixHandoff,
  cacheProbeRanges,
  readAllSource,
  sourceMayHaveBlobProbeHandoff,
  throwIfAborted,
} from './source-io.ts';
import type { CallOptions, Container, MediaInfo } from './types.ts';

/** Memoized lazy chunks: one dynamic import per module, not per call. */
const loadProbeModule = memoizeAsync(() => import('../codecs/image/probe.ts'));

export interface ProbeRunnerContext {
  readonly cacheOwner: object;
  readonly sourcePrefixHandoff: Map<string, SourcePrefixHandoff>;
  readonly loadRangeCache: () => Promise<typeof import('../sources/probe-range-cache.ts')>;
  readonly resolveHls: (input: MediaInput, source: Source, signal: AbortSignal) => Promise<Source>;
  readonly blobProbe: (source: Source) => Promise<readonly [Source, ProbeContainerResultCache]>;
  readonly routeSource: (
    source: Source,
    signal: AbortSignal,
    pinDriver?: string,
  ) => Promise<ContainerDriver>;
  readonly routeToken: (container: Container, pinDriver?: string) => Promise<ContainerDriver>;
  readonly stage: (signal: AbortSignal, options: CallOptions) => StageOptions;
  readonly imageOps: (source: Source, signal?: AbortSignal) => Promise<ImageOps | undefined>;
}

async function probeContainerInfo(
  context: ProbeRunnerContext,
  source: Source,
  signal: AbortSignal,
  options: CallOptions,
): Promise<MediaInfo> {
  const container = await context.routeSource(source, signal, options.strategy?.pinDriver);
  const stage = context.stage(signal, options);
  if (container.probe !== undefined) {
    return toMediaInfo(container, await container.probe(source, stage), source);
  }
  const demuxer = await container.demux(source, stage);
  try {
    return toMediaInfo(container, demuxer.tracks, source);
  } finally {
    await demuxer.close();
  }
}

async function probeImageInfo(
  context: ProbeRunnerContext,
  source: Source,
  signal: AbortSignal,
): Promise<MediaInfo | undefined> {
  const ops = await context.imageOps(source, signal);
  if (ops === undefined) return undefined;
  const bytes = await readAllSource(source, signal);
  const { imageInfoToMediaMetadata } = await loadProbeModule();
  return imageInfoToMediaMetadata(await ops.probe(bytes), source.size);
}

/**
 * Whether the source's leading bytes carry a first-party container's magic. Only definite signatures
 * count, and none of them can also be an image signature, so a `true` here means the image route
 * cannot be the answer and the container route is worth trying first.
 */
async function headIsDefiniteContainerMagic(source: Source): Promise<boolean> {
  // Only an in-memory source can answer this for free. Issuing a read here would add a range request
  // to every unlabeled remote probe, which is the opposite of the point.
  const head = source.peekHead?.(CONTAINER_MAGIC_HEAD_BYTES);
  if (head === undefined || head.byteLength < 4) return false;
  const query: ContainerQuery = { direction: 'demux', head };
  if (matchesIsoBmffMagic(query) || matchesMatroskaMagic(query)) return true;
  const { matchesAdts, matchesAiff, matchesCaf, matchesMp3, matchesOgg, matchesWav } =
    await loadAudioContainerSniffModule();
  return (
    matchesWav(query) ||
    matchesOgg(query) ||
    matchesAiff(query) ||
    matchesCaf(query) ||
    matchesMp3(query) ||
    matchesAdts(query)
  );
}

const CONTAINER_MAGIC_HEAD_BYTES = 16;
const loadAudioContainerSniffModule = memoizeAsync(
  () => import('../drivers/audio-container-sniff.ts'),
);

/** Run the generic byte/image probe after the eager layer has normalized and classified its input. */
export async function runProbe(
  context: ProbeRunnerContext,
  input: MediaInput,
  normalized: Source,
  options: CallOptions,
  signal: AbortSignal,
): Promise<MediaInfo> {
  // Resolve an HLS manifest before installing byte-range wrappers. Non-HLS sources pass through.
  const resolved = await context.resolveHls(input, normalized, signal);
  let source = resolved;
  let probeRangeCache: Awaited<ReturnType<ProbeRunnerContext['loadRangeCache']>> | undefined;
  let operationResultCache: ProbeContainerResultCache | undefined;
  let info: MediaInfo;
  try {
    // In-memory bytes answer every range as a subarray: caching copies of those reads or recording a
    // prefix for a later demux handoff would only add allocations to the hottest probe path.
    const inMemory = resolved.kind === 'bytes';
    if (resolved.range !== undefined) {
      probeRangeCache = await context.loadRangeCache();
      if (!inMemory) {
        source = probeRangeCache.cacheRepeatedProbeRangesFor(context.cacheOwner, resolved);
      }
    }
    if (sourceMayHaveBlobProbeHandoff(resolved)) {
      [source, operationResultCache] = await context.blobProbe(source);
    } else if (!inMemory) {
      source = cacheProbeRanges(source, context.sourcePrefixHandoff, 'store');
    }

    // A concrete seekable audio/video MIME, or a head whose magic is a definite non-image container,
    // gets the cheap container route first. MIME remains only a hint: a typed container rejection
    // still falls back to image magic, while one-shot sources stay image-first because a rejected
    // container probe may consume their bytes irreversibly. The magic test is what keeps unlabeled
    // media bytes — the common `probe(bytes)` case — from loading the image orchestration first,
    // without letting a MIME-only driver claim bytes whose magic says they are an image.
    const definiteContainerMagic = await headIsDefiniteContainerMagic(source);
    if (
      source.range !== undefined &&
      (probeRangeCache?.hasConcreteAudioVideoMime(source.mimeHint) === true ||
        definiteContainerMagic)
    ) {
      try {
        info = await probeContainerInfo(context, source, signal, options);
      } catch (error) {
        throwIfAborted(signal);
        if (!(error instanceof MediaError) || error.code === 'aborted') throw error;
        // The same magic that put the container route first also rules the image route out, so a
        // rejection here is the answer — loading the image orchestration could only repeat it.
        if (definiteContainerMagic) throw error;
        const imageInfo = await probeImageInfo(context, source, signal);
        if (imageInfo !== undefined) info = imageInfo;
        else throw error;
      }
    } else {
      const imageInfo = await probeImageInfo(context, source, signal);
      info = imageInfo ?? (await probeContainerInfo(context, source, signal, options));
    }
  } finally {
    await cancelSource(source, signal.reason);
  }

  // A driver or one-shot cleanup may settle after cancellation. A stale success must neither resolve
  // the public operation nor become an engine-owned cache fact.
  throwIfAborted(signal);
  operationResultCache?.store(normalized, options, info);
  return info;
}

/** Run a known-container probe without loading generic image/container-sniff orchestration eagerly. */
export async function runProbeContainer(
  context: ProbeRunnerContext,
  input: MediaInput,
  normalized: Source,
  container: Container,
  options: CallOptions,
  signal: AbortSignal,
): Promise<MediaInfo> {
  const resolved = await context.resolveHls(input, normalized, signal);
  let source = resolved;
  let operationResultCache: ProbeContainerResultCache | undefined;
  let info: MediaInfo;
  try {
    if (resolved.range !== undefined && resolved.kind !== 'bytes') {
      const probeRangeCache = await context.loadRangeCache();
      source = probeRangeCache.cacheRepeatedProbeRangesFor(context.cacheOwner, resolved);
    }
    if (sourceMayHaveBlobProbeHandoff(resolved)) {
      [source, operationResultCache] = await context.blobProbe(source);
    }
    const driver = await context.routeToken(container, options.strategy?.pinDriver);
    const stage = context.stage(signal, options);
    if (driver.probe !== undefined) {
      info = toMediaInfo(driver, await driver.probe(source, stage), source);
    } else {
      const demuxer = await driver.demux(source, stage);
      try {
        info = toMediaInfo(driver, demuxer.tracks, source);
      } finally {
        await demuxer.close();
      }
    }
  } finally {
    await cancelSource(source, signal.reason);
  }

  // Keep the cancellation check adjacent to the store: cleanup-delayed cancellation always wins.
  throwIfAborted(signal);
  operationResultCache?.store(normalized, options, info, container);
  return info;
}
