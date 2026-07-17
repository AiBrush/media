/**
 * The engine (docs/architecture/public-api.md) — the developer-facing instance behind `createMedia`. It
 * wires the kernel (Registry → Router → Normalizer → Executor → Worker-bridge) and exposes intent-only
 * ops; the substrate is never named (ADR-003).
 *
 * Every core op is implemented and live: `probe`/`demux`/`decode`/`seek`, `convert`/`remux`/`trim`,
 * `encode`/`mux`/`decrypt`, the declarative `run`, the fluent `load` chain, `preload` warmups, and the
 * `canConvert` capability pre-flight. Each op is `normalize → route → run → materialize`; heavy
 * pipelines are reached only through per-op lazy `import()`s so the eager kernel stays tiny, and a true
 * routing miss surfaces as a typed {@link CapabilityError} naming what was tried (Prime Directive 6) —
 * never a silent or fake result.
 */

import type { ImageOps } from '../codecs/image/index.ts';
import type { AudioEncoderStageOptions } from '../codecs/webcodecs-audio.ts';
import type {
  VideoDecoderStageOptions,
  VideoEncoderStageOptions,
  WarmVideoDecoderPool,
} from '../codecs/webcodecs-video.ts';
import type {
  CodecDriver,
  CodecQuery,
  ContainerDriver,
  ContainerQuery,
  Demuxer,
  Determinism,
  DriverBase,
  DriverModule,
  FilterDriver,
  FilterSpec,
  Muxer,
  Packet,
  PacketInfoMetadata,
  PacketInfoTable,
  StageOptions,
  TrackInfo,
  WasmRuntimeProfile,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { composeChain } from '../kernel/executor.ts';
import { Registry, isApiVersionSupported } from '../kernel/registry.ts';
import { type CodecRoute, Router, type StageSelectOptions } from '../kernel/router.ts';
import type { RouteCost } from '../kernel/tier-thresholds.ts';
import { normalizeWasmAssetBaseUrl, resolveWasmRuntimeProfile } from '../kernel/wasm-runtime.ts';
// Only the tiny, DEPENDENCY-FREE worker-mode selectors are statically imported here, from the dedicated
// `worker-mode.ts` (NOT `worker-bridge.ts`) so the eager kernel never pulls the heavy worker pump/pool or
// the offload protocol into its closure (doc 08 §7 budget). The actual worker spawn + ensure-pool + offload
// runner + payload assembly ALL live behind a lazy `import('../kernel/worker-host.ts')` ({@link tryOffload},
// ADR-019); `OffloadPoolCache` is consumed here only as an erased `import type` (the engine holds the cache
// by reference, worker-host owns the spawn LOGIC).
import type { OffloadPoolCache } from '../kernel/worker-host.ts';
import {
  type WorkerSelection,
  resolvePoolSize,
  selectWorkerMode,
  workerOffloadAvailable,
} from '../kernel/worker-mode.ts';
import { toBlob } from '../sinks/sink.ts';
import type { Sink } from '../sinks/sink.ts';
import { type LiveMediaSource, isLiveMediaSource } from '../sources/live-source.ts';
import {
  type ByteMediaInput,
  type FromOptions,
  type MediaInput,
  type NormalizedSource,
  type Source,
  cancelSource,
  from as normalizeInput,
} from '../sources/source.ts';
import { createMediaChain } from './chain.ts';
import { chooseOutputContainer, containerHasChunkMuxer, isPcmContainer } from './codec-routing.ts';
import { decoderConfigWithRoutedAcceleration, supportsWarmDecoderReuse } from './codec-route.ts';
import { mimeOpts } from './container-mime.ts';
import type { DecryptRunnerContext } from './decrypt-runner.ts';
import {
  allOrCancel,
  bridgeSignal,
  cancelStream,
  closeIfClosable,
  deferredStream,
  memoizeAsync,
} from './frame-streams.ts';
import {
  MICROS_PER_SECOND,
  audioGeometryOf,
  forceSoftware,
  isFlacAuthorCodec,
  isPcmCodec,
  isPinnedDriverMiss,
  isRawPcmTrack,
  materializeOutput,
  muxOptionsFrom,
  normalizeByteInput,
  openRenditionOptions,
  pcmEndian,
  pcmSampleFormat,
  sourceGeometryOf,
  stageStrategy,
  toMediaInfo,
} from './op-support.ts';
import {
  HINTED_HEAD_BYTES,
  type SourcePrefixHandoff,
  cacheProbeRanges,
  extensionOf,
  readAllSource,
  readHead,
  routeHeadBytes,
  sourceMayBeHlsManifest,
  throwIfAborted,
} from './source-io.ts';
import { assertTrimRange } from './trim-range.ts';
import type { MediaJob } from './job.ts';
import type { MuxRunnerContext } from './mux-runner.ts';
// Type-only: erased at build time, so this is NOT a static import edge — the FLAC + raw-PCM authoring
// routines are reached only through lazy `import()`s on an eligible `to:'flac'`/raw-PCM convert. The
// engine's `#authoringDeps()` returns the `PcmConvertDeps` superset, which also satisfies the FLAC route's
// (narrower) deps at its call site, so only this one type is referenced here.
import type { PcmConvertDeps } from './pcm-convert-plan.ts';
import type { RemuxRunnerContext } from './remux-runner.ts';
import type { TrimRunnerContext } from './trim-runner.ts';
import type {
  AudioTarget,
  CallOptions,
  Cancellable,
  Container,
  ConvertOptions,
  CreateMediaOptions,
  DecryptOptions,
  Demuxed,
  EncodeOptions,
  H264AbrRung,
  MediaChain,
  MediaInfo,
  MediaStreams,
  MuxSpec,
  Output,
  PacketStreams,
  PreloadSpec,
  RemuxOptions,
  TrimOptions,
  VideoTarget,
} from './types.ts';
import type { H264TwoPassRunnerContext } from './video-two-pass-runner.ts';
import type { H264TwoPassPlan } from './video-two-pass.ts';

interface DemuxerWithPacketInfoTable extends Demuxer {
  packetInfoTable?: () => readonly PacketInfoMetadata[];
}

/** The developer-facing engine surface (ADR-009). */
export interface MediaEngine {
  probe(input: MediaInput, o?: CallOptions): Cancellable<MediaInfo>;
  demux(input: MediaInput, o?: CallOptions): Cancellable<Demuxed>;
  convert(input: MediaInput, opts: ConvertOptions, o?: CallOptions): Cancellable<Output>;
  h264AbrLadder(
    input: MediaInput,
    ladder: readonly H264AbrRung[],
    o?: CallOptions,
  ): Cancellable<readonly Output[]>;
  remux(input: MediaInput, opts: RemuxOptions, o?: CallOptions): Cancellable<Output>;
  trim(input: MediaInput, opts: TrimOptions, o?: CallOptions): Cancellable<Output>;
  decode(input: MediaInput, o?: CallOptions): MediaStreams;
  encode(frames: MediaStreams, opts: EncodeOptions, o?: CallOptions): Cancellable<Output>;
  mux(streams: PacketStreams, opts: MuxSpec, o?: CallOptions): Cancellable<Output>;
  /** Decode and return the single frame at/just-after `timeUs` (frame-accurate seek, doc 09). */
  seek(input: MediaInput, timeUs: number, o?: CallOptions): Cancellable<VideoFrame>;
  decrypt(input: MediaInput, opts: DecryptOptions, o?: CallOptions): Cancellable<Output>;
  /** Execute one fully validated declarative job through the canonical flat operations (ADR-010). */
  run(job: MediaJob, o?: CallOptions): Cancellable<Blob>;
  /**
   * Intent-level capability pre-flight (mediabunny `canEncode` parity, R-S05.7): resolves `true` when
   * this engine could produce the requested target — the same Router walk `convert` uses — and `false`
   * on a typed capability/input miss. It never consumes input bytes, never downloads a WASM binary on a
   * negative answer, and never throws for a miss.
   */
  canConvert(opts: ConvertOptions): Promise<boolean>;
  preload(...specs: PreloadSpec[]): Promise<void>;
  /**
   * Tear down every instance-owned pool/cache (worker-pool references, the warm `VideoDecoder` pool,
   * preload/prefix caches). Idempotent. Subsequent ops throw a typed `MediaError` (ADR-321); the
   * page-shared worker pool itself is deliberately left running for other engines.
   */
  dispose(): Promise<void>;
  /** `await using engine = createMedia()` support — delegates to {@link dispose}. */
  [Symbol.asyncDispose](): Promise<void>;
  /** Start an immutable fluent chain over the flat operation API (ADR-010). */
  load(input: MediaInput): MediaChain;
  /** The universal normalizer, exported for optioned sources (ADR-013). */
  from(input: MediaStream | LiveMediaSource, opts?: FromOptions): LiveMediaSource;
  from(input: HTMLMediaElement, opts: FromOptions & { readonly mode: 'capture' }): LiveMediaSource;
  from(input: HTMLMediaElement): Source;
  from(input: HTMLMediaElement, opts: FromOptions & { readonly mode?: 'bytes' }): Source;
  from(input: ByteMediaInput, opts?: FromOptions): Source;
  from(input: HTMLMediaElement, opts: FromOptions): NormalizedSource;
  from(input: MediaInput, opts?: FromOptions): NormalizedSource;
  source(input: MediaStream | LiveMediaSource): LiveMediaSource;
  source(input: ByteMediaInput | HTMLMediaElement): Source;
  source(input: MediaInput): NormalizedSource;
  /** Inject a custom/third-party driver module (ADR-009 hook). Chainable. */
  use(module: DriverModule): MediaEngine;
}

type PacketInfoCallOptions = CallOptions & { readonly container?: Container };
type CodecPipelineModule = typeof import('./codec-pipeline.ts');
type AbrFanoutRendition = {
  readonly opts: { readonly sink?: unknown; readonly [key: string]: unknown };
};

function loadCodecPipeline(): Promise<CodecPipelineModule> {
  return import('./codec-pipeline.ts');
}

/** Shared one-shot loader for the probe range-cache chunk (no bare mutable module state, R-S05.11). */
const loadProbeRangeCache = memoizeAsync(() => import('../sources/probe-range-cache.ts'));

/**
 * A registered driver stub that owns its heavy implementation chunk and imports it on demand — the
 * additive, duck-typed member the router's {@link Router} `ensureLoaded` seam awaits per candidate
 * (R-S01.4 Option A, ADR-320). Absent on fully materialized drivers, whose loading is a no-op.
 */
interface LazyChunkDriver {
  readonly ensureLoaded?: () => void | Promise<void>;
}

export class MediaEngineImpl implements MediaEngine {
  readonly #opts: CreateMediaOptions;
  readonly #wasmRuntime: WasmRuntimeProfile;
  readonly #wasmAssetBaseUrl: string | undefined;
  readonly #registry = new Registry();
  /**
   * The router owns per-candidate miss-only loading (R-S01.4 Option A, ADR-320): before probing a
   * candidate, it awaits the engine-supplied `ensureLoaded`, which forwards to the candidate's own
   * optional lazy-chunk hook. A registered stub therefore imports its heavy implementation chunk only
   * when the walk actually reaches it — after every higher rung declined — and a fully materialized
   * driver costs nothing (no hook, no-op).
   */
  readonly #router = new Router({
    registry: this.#registry,
    ensureLoaded: (driver) => (driver as DriverBase & LazyChunkDriver).ensureLoaded?.(),
  });
  readonly #preloadTasks = new Map<string, Promise<void>>();
  #defaultsLoaded = false;
  #defaultDriversPromise: Promise<void> | undefined;
  /** Set once by {@link dispose}; every subsequent op throws a typed `MediaError` (ADR-321). */
  #disposed = false;
  /**
   * Worker offload mode for the heavy decode→encode graph (doc 06 §4, ADR-019), resolved once from
   * `worker` + `Worker` availability. `'inline'` everywhere a `Worker` is absent (e.g. Node) — the honest
   * fallback. The deeper "WebCodecs inside the worker" gate is the spawned worker's `ready` handshake.
   */
  readonly #workerMode: WorkerSelection;
  /**
   * Mutable cache for the worker **pool** that runs the heavy decode→encode graph off the main thread (doc
   * 06 §4, ADR-019): spawned + handshaked **at most once** the first time a heavy op actually offloads (so a
   * probe-only app never starts a worker), then reused. The spawn/ensure/offload LOGIC lives in the lazily-
   * imported `worker-host.ts` ({@link tryOffload}); the engine holds only this tiny by-reference cache, so the
   * eager kernel never carries the worker/WebCodecs spawn code (doc 08 §7 budget). A pool (vs a lone bridge)
   * is what lets concurrent `convert`/`trim` calls and ABR ladders fan across N workers.
   */
  readonly #poolCache: OffloadPoolCache = {};
  readonly #sourcePrefixHandoff = new Map<string, SourcePrefixHandoff>();
  /**
   * Per-instance warm `VideoDecoder` pool for the sequential single-frame/seek path (doc 09): created
   * lazily the first time a WebCodecs-video seek runs (a probe-only app never builds it), then reused so
   * repeated same-config seeks decode through ONE warm decoder instead of constructing + configuring a
   * fresh one each call. The pool object lives in the (lazily-imported) `webcodecs-video` chunk, so the
   * eager kernel never carries it; the engine holds only this by-reference handle (browser-only path).
   */
  #videoDecoderPool: WarmVideoDecoderPool | undefined;

  constructor(
    opts: CreateMediaOptions = {},
    resolvedRuntime: {
      readonly wasmRuntime?: WasmRuntimeProfile;
      readonly wasmAssetBaseUrl?: string;
    } = {},
  ) {
    this.#opts = opts;
    this.#wasmRuntime =
      resolvedRuntime.wasmRuntime ??
      resolveWasmRuntimeProfile(
        opts.enableThreads === undefined ? {} : { enableThreads: opts.enableThreads },
      );
    this.#wasmAssetBaseUrl =
      resolvedRuntime.wasmAssetBaseUrl ??
      (opts.assetBaseUrl === undefined ? undefined : normalizeWasmAssetBaseUrl(opts.assetBaseUrl));
    this.#workerMode = selectWorkerMode(opts.worker, workerOffloadAvailable());
  }

  use(module: DriverModule): MediaEngine {
    this.#assertNotDisposed();
    if (!isApiVersionSupported(module.apiVersion)) {
      throw new MediaError('driver-incompatible', `driver module apiVersion ${module.apiVersion}`, {
        got: module.apiVersion,
      });
    }
    module.register(this.#registry);
    this.#router.clearCache();
    return this;
  }

  /**
   * Release every instance-owned resource (R-S05.4, ADR-321): the warm `VideoDecoder` pool (freeing its
   * hardware session), the engine's worker-pool references, the preload task map, and the probe-prefix
   * handoff. Idempotent. The page-shared worker pool itself is deliberately NOT terminated — worker-host
   * owns it process-wide (one pool per size for the page; other engines may hold it), so disposing one
   * engine must never kill a sibling's in-flight offload. Post-dispose ops throw `MediaError('aborted',
   * 'engine disposed')` rather than re-initializing: silent resurrection would undo the teardown a server
   * or test suite just requested.
   */
  dispose(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#preloadTasks.clear();
      this.#sourcePrefixHandoff.clear();
      const decoderPool = this.#videoDecoderPool;
      this.#videoDecoderPool = undefined;
      decoderPool?.dispose();
      delete this.#poolCache.pool;
      delete this.#poolCache.promise;
    }
    return Promise.resolve();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw new MediaError('aborted', 'engine disposed', { reason: 'disposed' });
    }
  }

  from(input: MediaStream | LiveMediaSource, opts?: FromOptions): LiveMediaSource;
  from(input: HTMLMediaElement, opts: FromOptions & { readonly mode: 'capture' }): LiveMediaSource;
  from(input: HTMLMediaElement): Source;
  from(input: HTMLMediaElement, opts: FromOptions & { readonly mode?: 'bytes' }): Source;
  from(input: ByteMediaInput, opts?: FromOptions): Source;
  from(input: HTMLMediaElement, opts: FromOptions): NormalizedSource;
  from(input: MediaInput, opts?: FromOptions): NormalizedSource;
  from(input: MediaInput, opts?: FromOptions): NormalizedSource {
    return normalizeInput(input, opts);
  }

  source(input: MediaStream | LiveMediaSource): LiveMediaSource;
  source(input: ByteMediaInput | HTMLMediaElement): Source;
  source(input: MediaInput): NormalizedSource;
  source(input: MediaInput): NormalizedSource {
    return normalizeInput(input);
  }

  load(input: MediaInput): MediaChain {
    // One chain builder for the whole engine (R-S02.3): `createMediaChain` accumulates immutable steps
    // synchronously and lazily imports the chain RUNNER only at a terminal, so the op implementations
    // still stay out of the eager kernel (doc 08 §7 budget split) while the duplicated inline proxy is
    // gone. Cancellation rides the runner's tracked dispatch (`runCancellable`).
    this.#assertNotDisposed();
    return createMediaChain(this, input);
  }

  run(job: MediaJob, o: CallOptions = {}): Cancellable<Blob> {
    return this.#withCancel(o, async (signal) => {
      const { runMediaJob } = await import('./job-runner.ts');
      return runMediaJob(this, job, { ...o, signal });
    });
  }

  probe(input: MediaInput, o: CallOptions = {}): Cancellable<MediaInfo> {
    return this.#withCancel(o, async (signal) => {
      const normalized = normalizeInput(input);
      if (isLiveMediaSource(normalized)) {
        throwIfAborted(signal);
        const { probeLiveMediaStream } = await import('../sources/live-media.ts');
        throwIfAborted(signal);
        return probeLiveMediaStream(normalized);
      }
      // Resolve an HLS `.m3u8` to its (decrypted, concatenated) media source BEFORE the probe-prefix cache
      // wrappers — exactly as demux/decode do (they pass a fresh `normalizeInput(input)` to the resolver).
      // Wrapping first put the eager range-cache in front of an *unresolved* manifest, so the HLS content
      // sniff saw cached/segment bytes, declined to resolve, and probe then mis-read the raw encrypted TS
      // segment as "not an MPEG-TS stream". For non-HLS inputs the resolver is a cheap no-op (same source).
      const resolved = await this.#resolveHlsInput(input, normalized, signal);
      let src = resolved;
      let probeRangeCache: Awaited<ReturnType<typeof loadProbeRangeCache>> | undefined;
      try {
        if (resolved.range !== undefined) {
          probeRangeCache = await loadProbeRangeCache();
          src = probeRangeCache.cacheRepeatedProbeRangesFor(this, resolved);
        }
        src = cacheProbeRanges(src, this.#sourcePrefixHandoff, 'store');
        // A concrete audio/video MIME already identifies the container family cheaply. On a seekable
        // source, try that container before spending a separate range read on image magic. This is safe
        // even before the URL size is known: range reads are replayable, the first 206 learns the size, and
        // the exact-source prefix cache preserves bytes for the typed-rejection image fallback. MIME remains
        // only a hint, so a JPEG mislabeled `video/mp4` still resolves as JPEG. One-shot streams stay
        // image-first because a rejected container probe may consume bytes irreversibly.
        if (
          src.range !== undefined &&
          probeRangeCache?.hasConcreteAudioVideoMime(src.mimeHint)
        ) {
          try {
            return await this.#probeContainerInfo(src, signal, o);
          } catch (error) {
            throwIfAborted(signal);
            if (!(error instanceof MediaError) || error.code === 'aborted') throw error;
            const imageInfo = await this.#probeImageInfo(src, signal);
            if (imageInfo !== undefined) return imageInfo;
            throw error;
          }
        }
        const imageInfo = await this.#probeImageInfo(src, signal);
        if (imageInfo !== undefined) return imageInfo;
        return await this.#probeContainerInfo(src, signal, o);
      } finally {
        await cancelSource(src, signal.reason);
      }
    });
  }

  async #probeContainerInfo(src: Source, signal: AbortSignal, o: CallOptions): Promise<MediaInfo> {
    const container = await this.#routeContainer(src, 'demux', signal, o.strategy?.pinDriver);
    const stage = this.#stageOptions(signal, o);
    if (container.probe !== undefined) {
      return toMediaInfo(container, await container.probe(src, stage), src);
    }
    const demuxer = await container.demux(src, stage);
    try {
      return toMediaInfo(container, demuxer.tracks, src);
    } finally {
      await demuxer.close();
    }
  }

  probeContainer(
    input: MediaInput,
    container: Container,
    o: CallOptions = {},
  ): Cancellable<MediaInfo> {
    return this.#withCancel(o, async (signal) => {
      // Resolve an HLS `.m3u8` to its decrypted media source first (as `demux`/`probe` do) — a container-
      // targeted probe of an HLS manifest (e.g. an AES-128 `mpeg-ts` playlist) must sniff the resolved TS,
      // not the raw encrypted segment (which reads as "not an MPEG-TS stream"). No-op for non-HLS inputs.
      const resolved = await this.#resolveHlsInput(
        input,
        normalizeByteInput(input, 'probeContainer'),
        signal,
      );
      let src = resolved;
      try {
        if (resolved.range !== undefined) {
          src = (await loadProbeRangeCache()).cacheRepeatedProbeRangesFor(this, resolved);
        }
        const driver = await this.#routeContainerToken(container, 'demux', o.strategy?.pinDriver);
        const stage = this.#stageOptions(signal, o);
        if (driver.probe) {
          return toMediaInfo(driver, await driver.probe(src, stage), src);
        }
        const demuxer = await driver.demux(src, stage);
        try {
          return toMediaInfo(driver, demuxer.tracks, src);
        } finally {
          await demuxer.close();
        }
      } finally {
        await cancelSource(src, signal.reason);
      }
    });
  }

  demux(input: MediaInput, o: CallOptions = {}): Cancellable<Demuxed> {
    return this.#withCancel(o, async (signal) => {
      const src = await this.#resolveHlsInput(input, normalizeByteInput(input, 'demux'), signal);
      const container = await this.#routeContainer(src, 'demux', signal, o.strategy?.pinDriver);
      try {
        return await container.demux(src, this.#stageOptions(signal, o));
      } catch (error) {
        await cancelSource(src, error);
        throw error;
      }
    });
  }

  packetInfo(input: MediaInput, o: PacketInfoCallOptions = {}): Cancellable<PacketInfoTable> {
    return this.#withCancel(o, async (signal) => {
      const src = await this.#resolveHlsInput(
        input,
        normalizeByteInput(input, 'packetInfo'),
        signal,
      );
      try {
        const container =
          o.container === undefined
            ? await this.#routeContainer(src, 'demux', signal, o.strategy?.pinDriver)
            : await this.#routeContainerToken(o.container, 'demux', o.strategy?.pinDriver);
        const packetInfo = container.packetInfo;
        if (packetInfo === undefined) {
          throw new CapabilityError('no packet-info', {
            op: { kind: 'route', id: 'demux' },
            tried: [container.id],
          });
        }
        return await packetInfo.call(container, src, this.#stageOptions(signal, o));
      } finally {
        await cancelSource(src, signal.reason);
      }
    });
  }

  pcm(
    src: Source | Uint8Array,
    sourceContainer: string,
    opts: { readonly to: Container; readonly audio?: AudioTarget | false; readonly sink?: Sink },
    o: CallOptions = {},
  ): Cancellable<Output | Uint8Array> {
    this.#assertNotDisposed();
    const run = async (signal?: AbortSignal): Promise<Output | Uint8Array> => {
      const { pcm } = await import('./pcm-convert-plan.ts');
      return pcm(
        this.#authoringDeps(o),
        (container, direction) =>
          this.#routeContainerToken(container, direction, o.strategy?.pinDriver),
        src,
        sourceContainer,
        opts,
        signal,
        o,
      );
    };
    if (src instanceof Uint8Array && o.signal === undefined) {
      const p = (
        o.strategy?.pinDriver === undefined
          ? run()
          : (async (): Promise<Output | Uint8Array> => {
              await this.#ensurePinRegistered(o);
              return run();
            })()
      ) as Cancellable<Output | Uint8Array>;
      p.cancel = (): void => {};
      return p;
    }
    return this.#withCancel(o, run);
  }

  wavPcmPacketCopy(input: {
    readonly payload: Uint8Array;
    readonly sourceBytes?: Uint8Array;
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
  }): Cancellable<Uint8Array> {
    this.#assertNotDisposed();
    const run = async (): Promise<Uint8Array> => {
      const { wavPcmPacketCopy } = await import('./pcm-convert-plan.ts');
      return wavPcmPacketCopy(this.#authoringDeps(), input);
    };
    const p = run() as Cancellable<Uint8Array>;
    p.cancel = (): void => {};
    return p;
  }

  convert(input: MediaInput, opts: ConvertOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const normalized = normalizeInput(input);
      if (isLiveMediaSource(normalized)) {
        const live = await import('./live-convert.ts');
        return live.convertLiveMediaStream(
          normalized,
          opts,
          {
            run: (frames, liveOptions, liveSignal) =>
              live.runLiveFramePipeline(normalized.mediaStream, frames, liveOptions, liveSignal, {
                supportsContainer: containerHasChunkMuxer,
                createMuxer: async (target, options) =>
                  (await this.#routeMuxer(target, o.strategy?.pinDriver)).createMuxer(
                    muxOptionsFrom(options, target),
                  ),
                applyVideoFilters: (stream, target, source, activeSignal) =>
                  this.#applyVideoFilters(stream, target, source, activeSignal, o),
                applyAudioFilters: (stream, target, source, activeSignal) =>
                  this.#applyAudioFilters(stream, target, source, activeSignal, o),
                resolveAudioTarget: async (target, sourceCodec) =>
                  (await loadCodecPipeline()).resolveAudioEncodeTargetForRuntime(
                    target,
                    sourceCodec,
                  ),
                encodeVideo: (stream, target, source, muxer, activeSignal, fragmented) =>
                  this.#encodeVideoStream(
                    stream,
                    target,
                    source,
                    muxer,
                    activeSignal,
                    o,
                    fragmented,
                  ),
                encodeAudio: (stream, target, source, muxer, activeSignal) =>
                  this.#encodeAudioStream(stream, target, source, muxer, activeSignal, o),
                materialize: (muxer, target, options, activeSignal) =>
                  materializeOutput(
                    options.sink ?? toBlob(),
                    muxer.output,
                    mimeOpts(activeSignal, target),
                  ),
              }),
          },
          signal,
        );
      }
      const src = await this.#resolveHlsInput(input, normalized, signal);
      const audio = opts.audio;
      // FLAC authoring (ADR-024): a native-FLAC target authored losslessly in pure TS from canonical PCM —
      // a FLAC source re-encodes through its own `transformPcm`; a raw-PCM source (WAV/AIFF/CAF) is decoded
      // to PCM and FLAC-encoded. FLAC is compressed (not a PcmContainer), but its authoring shares the PCM
      // audio-dsp path, never the WebCodecs chunk seam. A non-lossless audio codec request is left to the
      // codec seam (an honest miss). Returns `undefined` ⇒ no PCM-native FLAC route ⇒ fall through.
      if (opts.to === 'flac' && audio !== false && isFlacAuthorCodec(audio?.codec)) {
        // The FLAC-authoring ROUTINE lives in a lazily-imported chunk (`flac-convert-plan.ts`), reached only
        // for an eligible `to:'flac'` convert, so the eager kernel never carries it (doc 08 §7). The thin
        // gate above stays inline-eager so a non-FLAC convert never loads the chunk.
        const { convertToFlac } = await import('./flac-convert-plan.ts');
        const flac = await convertToFlac(this.#authoringDeps(o), src, opts, audio, signal, o);
        if (flac !== undefined) return flac;
      }
      // PCM-native audio path (ADR-022): a raw-PCM target (WAV/AIFF/CAF) whose source container transforms
      // PCM directly — channel up/down-mix / format / sample-rate in the TS audio-dsp path, no codec seam.
      // Lossy re-encode, video, or cross-codec conversions fall through to the browser codec layer. The
      // ROUTINE lives in a lazily-imported chunk (`pcm-convert-plan.ts`), reached only for an eligible target,
      // so the eager kernel never carries it (doc 08 §7); the thin gate below stays inline-eager.
      if (
        opts.to !== undefined &&
        isPcmContainer(opts.to) &&
        audio !== false &&
        isPcmCodec(audio?.codec)
      ) {
        const { convertPcmNative } = await import('./pcm-convert-plan.ts');
        const pcm = await convertPcmNative(
          this.#authoringDeps(o),
          src,
          opts,
          audio,
          opts.to,
          signal,
          o,
        );
        if (pcm !== undefined) return pcm;
      }
      // Codec seam (the full convert pipeline). A pure container change with no re-encode is preferred
      // as a lossless stream-copy (ADR-021/012) when the source container supports it; otherwise demux →
      // decode → (GPU filter) → encode → mux through the WebCodecs/GPU tier.
      return this.#convertViaCodec(src, opts, signal, o, input);
    });
  }

  async #offloadAbrLadder(
    src: Source,
    ladder: readonly { readonly opts: ConvertOptions }[],
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<ReadableStream<Uint8Array>[] | undefined> {
    if (this.#workerMode !== 'offload') return undefined;
    /* v8 ignore start -- same worker capability gate as #offloadStream; browser-harness validated. */
    const { ensureOffloadPool, offloadAbrLadder } = await import('../kernel/worker-host.ts');
    const pool = await ensureOffloadPool(this.#poolCache, resolvePoolSize(this.#opts.worker));
    if (pool === null) return undefined;
    const renditions: AbrFanoutRendition[] = ladder.map((rung) => ({
      opts: openRenditionOptions(rung.opts),
    }));
    return offloadAbrLadder(pool, src, renditions, {
      signal,
      determinism: this.#determinism(o),
      ...(o.strategy?.pinDriver !== undefined ? { pinDriver: o.strategy.pinDriver } : {}),
      wasmRuntime: this.#wasmRuntime,
      ...(this.#wasmAssetBaseUrl !== undefined ? { wasmAssetBaseUrl: this.#wasmAssetBaseUrl } : {}),
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    });
    /* v8 ignore stop */
  }

  h264AbrLadder(
    input: MediaInput,
    ladder: readonly H264AbrRung[],
    o: CallOptions = {},
  ): Cancellable<readonly Output[]> {
    return this.#withCancel(o, async (signal) => {
      const src = normalizeByteInput(input, 'h264AbrLadder');
      const { planH264AbrLadder } = await import('./video-stream-plan.ts');
      const planned = planH264AbrLadder(ladder, { width: undefined, height: undefined });
      const offloaded = await this.#offloadAbrLadder(
        src,
        planned.map((rung) => ({ opts: rung.options })),
        signal,
        o,
      );
      if (offloaded !== undefined) {
        return Promise.all(
          offloaded.map((stream) => materializeOutput(toBlob(), stream, mimeOpts(signal, 'mp4'))),
        );
      }

      const bytes = await readAllSource(src, signal);
      const outputs: Output[] = [];
      for (const rung of planned) {
        throwIfAborted(signal);
        outputs.push(await this.convert(bytes.slice(), rung.options, { ...o, signal }));
      }
      return outputs;
    });
  }

  remux(input: MediaInput, opts: RemuxOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const { runRemux } = await import('./remux-runner.ts');
      return runRemux(this.#operationRunnerContext(), input, opts, o, signal);
    });
  }

  trim(input: MediaInput, opts: TrimOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const { runTrim } = await import('./trim-runner.ts');
      return runTrim(this.#operationRunnerContext(), input, opts, o, signal);
    });
  }

  decode(input: MediaInput, o: CallOptions = {}): MediaStreams {
    this.#assertNotDisposed();
    const normalized = normalizeInput(input); // validate the input shape eagerly (throws InputError on bad input)
    // The `decode` contract returns frame streams synchronously; the async demux + codec routing happens
    // lazily when each stream is first pulled. A track without a decode `config` (codec unknown) is
    // simply absent. Cancellation rides `o.signal` threaded into each decoder's StageOptions; a frame
    // emitted by a decoder is owned by the readable consumer and closed by it (the contract).
    const ctrl = new AbortController();
    bridgeSignal(o.signal, ctrl);
    if (isLiveMediaSource(normalized)) {
      // Keep the processor implementation out of the eager kernel: each public result stream resolves
      // the same live decode exactly once on its first pull, then forwards only its selected track.
      const liveStreams = memoizeAsync(async () => {
        if (o.strategy?.pinDriver !== undefined) await this.#ensurePinRegistered(o);
        const { decodeLiveMediaStream } = await import('../sources/live-media.ts');
        return decodeLiveMediaStream(normalized, { signal: ctrl.signal });
      });
      return {
        video: deferredStream(async () => (await liveStreams()).video),
        audio: deferredStream(async () => (await liveStreams()).audio),
      };
    }
    const src = cacheProbeRanges(normalized, this.#sourcePrefixHandoff, 'consume');
    const stage = this.#stageOptions(ctrl.signal, o);
    // An HLS `.m3u8` manifest is resolved+stitched to its segment source lazily on first pull (decode's
    // contract is synchronous), memoized so both frame streams share one resolution. Non-HLS is a no-op.
    const resolvedInputSrc = memoizeAsync(async () => {
      if (o.strategy?.pinDriver !== undefined) await this.#ensurePinRegistered(o);
      return this.#resolveHlsInput(input, src, ctrl.signal);
    });
    const replayableSrc = memoizeAsync(async (): Promise<Source> => {
      const resolved = await resolvedInputSrc();
      if (resolved.kind !== 'stream') return resolved;
      const bytes = await readAllSource(resolved, ctrl.signal);
      return normalizeInput(
        bytes,
        resolved.mimeHint === undefined ? {} : { mime: resolved.mimeHint },
      );
    });
    const mime = src.mimeHint?.toLowerCase();
    const imageRoute = (
      mime === undefined
        ? sourceMayBeHlsManifest(src)
        : !/^(?:audio|video)\//.test(mime)
    )
      ? memoizeAsync(async () =>
          this.#imageDecodeRoute(
            await resolvedInputSrc(),
            ctrl.signal,
            stage.determinism ?? 'auto',
          ),
        )
      : noImageDecodeRoute;
    const video = deferredStream<VideoFrame>(async () =>
      this.#decodeVideoOrImage(replayableSrc, stage, imageRoute),
    );
    const audio = deferredStream<AudioData>(async () => {
      if ((await imageRoute()) !== undefined) return undefined;
      return this.#decodeTrack(await replayableSrc(), 'audio', stage);
    });
    return { video, audio };
  }

  encode(frames: MediaStreams, opts: EncodeOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const target = chooseOutputContainer(opts.to, undefined);
      if (target === 'wav') {
        const { encodeWavFrames } = await import('./wav-frame-encode.ts');
        const stream = await encodeWavFrames(
          {
            createMuxer: async () =>
              (await this.#routeMuxer(target, o.strategy?.pinDriver)).createMuxer(
                muxOptionsFrom(opts, target),
              ),
          },
          frames,
          opts,
          signal,
          o,
        );
        return materializeOutput(opts.sink ?? toBlob(), stream, mimeOpts(signal, target));
      }
      if (!containerHasChunkMuxer(target)) {
        // A target without a frame-encode packet muxer cannot accept encoded chunks; surface the honest
        // miss before constructing streams or routing a muxer.
        throw new CapabilityError(`no muxer '${target}'`, {
          op: { kind: 'route', id: 'encode' },
          tried: [target],
        });
      }
      // Validate the input shape (which streams, matched targets) BEFORE building the muxer, so an empty
      // or mismatched `encode` rejects as bad input rather than a downstream miss; cancel any frame stream
      // we will not consume so its frames never leak.
      if (!frames.video && !frames.audio) {
        throw new InputError('encode needs streams');
      }
      if (frames.video && !opts.video) {
        await cancelStream(frames.video);
        throw new InputError('video target missing');
      }
      if (frames.audio && !opts.audio) {
        await cancelStream(frames.audio);
        throw new InputError('audio target missing');
      }
      const muxer = (await this.#routeMuxer(target, o.strategy?.pinDriver)).createMuxer(
        muxOptionsFrom(opts, target),
      );
      const tasks: Promise<void>[] = [];
      if (frames.video && opts.video) {
        tasks.push(this.#encodeVideoStream(frames.video, opts.video, undefined, muxer, signal, o));
      }
      if (frames.audio && opts.audio) {
        tasks.push(this.#encodeAudioStream(frames.audio, opts.audio, undefined, muxer, signal, o));
      }
      await allOrCancel(tasks, frames);
      await muxer.finalize();
      return materializeOutput(opts.sink ?? toBlob(), muxer.output, mimeOpts(signal, target));
    });
  }

  seek(input: MediaInput, timeUs: number, o: CallOptions = {}): Cancellable<VideoFrame> {
    return this.#withCancel(o, async (signal) => {
      if (!Number.isFinite(timeUs) || timeUs < 0) {
        throw new InputError(`bad seek ${timeUs}`);
      }
      const src = normalizeByteInput(input, 'seek');
      const container = await this.#routeContainer(src, 'demux', signal, o.strategy?.pinDriver);
      const stage = this.#stageOptions(signal, o);
      const demuxer = await container.demux(src, stage);
      try {
        const track = demuxer.tracks.find((t) => t.mediaType === 'video' && t.config !== undefined);
        if (!track) {
          throw new CapabilityError('no seek video', {
            op: { kind: 'route', id: 'seek' },
            tried: [container.id],
          });
        }
        if (track.encrypted === true) {
          throw new MediaError('decode-error', 'encrypted seek');
        }
        // Resolve the decode codec first (throws a typed miss in Node where WebCodecs is absent). Then feed
        // only the packets from the keyframe at/before the target onward (a stream must decode from a
        // keyframe); seekFrame drops frames before the target, closes them, and returns the first at/after
        // it (owned by the caller). The demuxer is closed on every exit by the finally.
        const {
          decodeQueryFor,
          decodeVideoPacketsWithAlpha,
          seekFrame,
          startAtSeekKeyframe,
          startAtSeekKeyframePackets,
          unwrapPackets,
        } = await loadCodecPipeline();
        const decodeQuery = await decodeQueryFor(track);
        const route = await this.#probeCodec(decodeQuery, o);
        const codec = route.driver;
        // Configure the exact acceleration rung the accepted probe reported — never a second
        // `supports()`/`isConfigSupported` probe (ADR-203).
        const config = decoderConfigWithRoutedAcceleration(decodeQuery.config, route.support);
        // Reuse a warm VideoDecoder across successive same-config seeks on this engine instance: the
        // harness seeks the same input many times, so a pooled decoder skips the per-call construct +
        // configure + hardware-init the fresh path pays each call. Pool strictly by the driver's
        // advertised warm-reuse *capability* (R-S05.2) — the engine never matches a driver id; drivers
        // without the capability (or a busy/unpoolable config) fall back to a fresh `createDecoder`.
        // The pool is single-borrow, so this sequential seek decode is safe; the alpha branch (two
        // concurrent decoders) always stays fresh.
        const decoderPool = supportsWarmDecoderReuse(codec)
          ? await this.#ensureVideoDecoderPool()
          : undefined;
        /* v8 ignore start -- live decode requires a real VideoDecoder; browser-harness validated. */
        const makeSeekDecoder = (): ReturnType<CodecDriver['createDecoder']> =>
          decoderPool?.borrow(config, stage) ?? codec.createDecoder(config, stage);
        const packetInfoRows = (demuxer as DemuxerWithPacketInfoTable).packetInfoTable?.();
        const trackIndex = demuxer.tracks.findIndex((candidate) => candidate.id === track.id);
        let packetInfoSeekStream: ReadableStream<EncodedVideoChunk> | undefined;
        if (
          track.alpha !== true &&
          src.range !== undefined &&
          packetInfoRows !== undefined &&
          trackIndex >= 0
        ) {
          const { planSeekVideoPacketInfoRows, trimVideoPacketInfoChunkStream } = await import(
            './trim-streams.ts'
          );
          const packetInfoSeekRows = planSeekVideoPacketInfoRows(
            packetInfoRows,
            trackIndex,
            timeUs,
          );
          if (packetInfoSeekRows !== undefined) {
            packetInfoSeekStream = trimVideoPacketInfoChunkStream(src, packetInfoSeekRows, signal);
          }
        }
        const out =
          packetInfoSeekStream !== undefined
            ? (packetInfoSeekStream.pipeThrough(makeSeekDecoder()) as ReadableStream<VideoFrame>)
            : track.alpha === true
              ? decodeVideoPacketsWithAlpha(
                  await startAtSeekKeyframePackets(demuxer.packets(track.id), timeUs),
                  () => codec.createDecoder(config, stage),
                )
              : ((
                  await startAtSeekKeyframe(unwrapPackets(demuxer.packets(track.id)), timeUs)
                ).pipeThrough(makeSeekDecoder()) as ReadableStream<VideoFrame>);
        return await seekFrame(out, timeUs);
        /* v8 ignore stop */
      } finally {
        await demuxer.close();
      }
    });
  }

  mux(streams: PacketStreams, opts: MuxSpec, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const { runMux } = await import('./mux-runner.ts');
      return runMux(this.#operationRunnerContext(), streams, opts, o, signal);
    });
  }

  decrypt(input: MediaInput, opts: DecryptOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const { runDecrypt } = await import('./decrypt-runner.ts');
      return runDecrypt(this.#operationRunnerContext(), input, opts, o, signal);
    });
  }

  async preload(...specs: PreloadSpec[]): Promise<void> {
    this.#assertNotDisposed();
    const { runPreload } = await import('./preload.ts');
    await runPreload(
      {
        tasks: this.#preloadTasks,
        wasmRuntime: this.#wasmRuntime,
        ...(this.#wasmAssetBaseUrl !== undefined
          ? { wasmAssetBaseUrl: this.#wasmAssetBaseUrl }
          : {}),
        ensureDefaultDrivers: () => this.#ensureDefaultDrivers(),
        pickContainer: (q) => {
          this.#router.pickContainer(q);
        },
        pickCodec: async (q) => {
          // Warm through the verdict-carrying route (ADR-203): the cached CodecRoute the first real
          // decode/encode hits afterwards already carries the accepted acceleration rung — zero probes.
          await this.#probeCodec(q, {});
        },
        pickFilter: (filter) => {
          this.#router.pickFilter(filter, { determinism: this.#opts.determinism ?? 'auto' });
        },
        ...(this.#opts.onLog !== undefined ? { onLog: this.#opts.onLog } : {}),
      },
      specs,
    );
  }

  canConvert(opts: ConvertOptions): Promise<boolean> {
    this.#assertNotDisposed();
    return this.#preflightConvert(opts).then(
      () => true,
      (e) => {
        // A typed media error IS the negative answer (capability or input miss). Anything else is a
        // genuine defect and must surface — masking it would fake a verdict (Prime Directive 6).
        if (e instanceof MediaError) return false;
        throw e;
      },
    );
  }

  /**
   * Target-side pre-flight mirror of {@link convert}'s routing gates (R-S05.7): the pure-TS lossless
   * audio authoring paths (FLAC ADR-024, raw-PCM ADR-022) answer without any codec driver; everything
   * else routes the output container muxer by token and probes an encode codec per *named* codec intent
   * through the same Router walk `convert` uses. Probes call each driver's cheap `supports()` only —
   * no input bytes are read and no WASM binary is downloaded on this path (miss-only loading pulls JS
   * driver chunks at most). An unnamed codec defers to the source and is not pre-flightable.
   */
  async #preflightConvert(opts: ConvertOptions): Promise<void> {
    const audio = opts.audio;
    const video = opts.video;
    const wantsVideo = video !== undefined && video !== false;
    const pcmFamilyTarget =
      opts.to !== undefined &&
      audio !== false &&
      ((opts.to === 'flac' && isFlacAuthorCodec(audio?.codec)) ||
        (isPcmContainer(opts.to) && isPcmCodec(audio?.codec)));
    if (pcmFamilyTarget) {
      if (!wantsVideo) return; // authored losslessly in pure TS — no codec seam, no download
      throw new CapabilityError(`no video track fits '${opts.to}'`, {
        op: { kind: 'route', id: 'convert' },
        tried: [opts.to as string],
      });
    }
    if (opts.to !== undefined) {
      await this.#routeMuxer(opts.to);
    }
    if (wantsVideo && video.codec !== undefined) {
      const { preflightVideoEncodeQuery } = await import('./preload.ts');
      await this.#probeCodec(preflightVideoEncodeQuery(video.codec), {});
    }
    if (audio !== undefined && audio !== false && audio.codec !== undefined) {
      const { preflightAudioEncodeQuery } = await import('./preload.ts');
      await this.#probeCodec(preflightAudioEncodeQuery(audio.codec), {});
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────────

  #determinism(o: CallOptions): Determinism {
    return o.strategy?.determinism ?? this.#opts.determinism ?? 'auto';
  }

  #stageOptions(signal: AbortSignal, o: CallOptions): StageOptions {
    return {
      signal,
      determinism: this.#determinism(o),
      wasmRuntime: this.#wasmRuntime,
      ...(this.#wasmAssetBaseUrl !== undefined ? { wasmAssetBaseUrl: this.#wasmAssetBaseUrl } : {}),
      ...(o.strategy?.pinDriver !== undefined ? { pinDriver: o.strategy.pinDriver } : {}),
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    };
  }

  async #pickContainer(q: ContainerQuery, pinDriver?: string): Promise<ContainerDriver> {
    const select = pinDriver === undefined ? {} : { pinDriver };
    try {
      return this.#router.pickContainer(q, select);
    } catch (e) {
      // On a miss, a definite audio-container query first registers only that immediately-needed native
      // driver. Ambiguous/unsupported queries and failed pinned retries retain the complete established
      // defaults fallback. An explicitly `use()`d matching driver never reaches either path.
      if (!(e instanceof CapabilityError) || this.#defaultsLoaded) throw e;
      const { pickContainerWithDefaultFallback } = await import(
        '../drivers/default-container-registration.ts'
      );
      return pickContainerWithDefaultFallback(this.#registry, this.#router, q, pinDriver, () =>
        this.#ensureDefaultDrivers(),
      );
    }
  }

  /**
   * Auto-resolve an HLS `.m3u8` manifest input into its single demuxable, decrypted segment source
   * (ADR-023): HLS is a **source-level** transform, not a byte container, so probe/demux/decode must stitch
   * (+ AES-128 decrypt) the segments before the container router ever sees them — otherwise the raw manifest
   * reaches the MPEG-TS driver and fails "not an MPEG-TS stream". A non-manifest input passes through
   * unchanged after one cheap head sniff. The hls module is dynamically imported so it stays out of the
   * eager kernel.
   */
  async #resolveHlsInput(input: MediaInput, src: Source, signal: AbortSignal): Promise<Source> {
    // Eager gate only: skip inputs whose MIME/extension can't be a manifest (an `.m3u8`, an
    // `application/vnd.apple.mpegurl`, or — as the harness tags them — a `video/mp2t`) so a definite
    // non-HLS container (mp4/wav/flac/…) costs nothing. The content sniff + stitch live behind the
    // dynamic import, keeping the whole HLS path out of the eager kernel.
    if (!sourceMayBeHlsManifest(src)) return src;
    const hls = await import('../drivers/hls/hls-source.ts');
    return hls.resolveHlsInputIfManifest(input, src, signal);
  }

  async #routeContainer(
    src: Source,
    direction: 'demux' | 'mux',
    signal?: AbortSignal,
    pinDriver?: string,
  ): Promise<ContainerDriver> {
    try {
      const ext = extensionOf(src.filename);
      if (src.mimeHint !== undefined || ext !== undefined) {
        try {
          return await this.#pickContainer(
            {
              direction,
              ...(src.mimeHint !== undefined ? { mime: src.mimeHint } : {}),
              ...(ext !== undefined ? { extension: ext } : {}),
            },
            pinDriver,
          );
        } catch (error) {
          if (!(error instanceof CapabilityError)) throw error;
          // A pin miss is final for this route. Do not consume a one-shot source merely to repeat the same
          // exact-id failure with magic bytes after the one allowed default-driver retry.
          if (isPinnedDriverMiss(error, pinDriver)) throw error;
        }
      }
      const head = await readHead(src, routeHeadBytes(src), signal);
      return await this.#pickContainer(
        {
          direction,
          head,
          ...(src.mimeHint !== undefined ? { mime: src.mimeHint } : {}),
          ...(ext !== undefined ? { extension: ext } : {}),
        },
        pinDriver,
      );
    } catch (error) {
      await cancelSource(src, error);
      throw error;
    }
  }

  async #routeContainerToken(
    target: string,
    direction: 'demux' | 'mux',
    pinDriver?: string,
  ): Promise<ContainerDriver> {
    return this.#pickContainer(
      {
        direction,
        extension: target,
      },
      pinDriver,
    );
  }

  /**
   * Route the *output* container's driver by its token (mime/extension) — for mux, where there are no
   * input bytes to magic-probe. Loads the first-party defaults on a miss then retries once, mirroring
   * {@link routeContainer}'s zero-config behavior.
   */
  async #routeMuxer(target: string, pinDriver?: string): Promise<ContainerDriver> {
    return this.#routeContainerToken(target, 'mux', pinDriver);
  }

  /** Lazily import + register the first-party driver bundle (a code-split chunk). One-time. */
  async #ensureDefaultDrivers(): Promise<void> {
    if (this.#defaultsLoaded) return;
    const pending =
      this.#defaultDriversPromise ??
      (async (): Promise<void> => {
        const { registerDefaultDrivers } = await import('../drivers/defaults.ts');
        registerDefaultDrivers(this.#registry);
        this.#router.clearCache();
        this.#defaultsLoaded = true;
      })();
    this.#defaultDriversPromise = pending;
    try {
      await pending;
    } catch (error) {
      if (this.#defaultDriversPromise === pending) this.#defaultDriversPromise = undefined;
      throw error;
    }
  }

  /**
   * Run a heavy `convert`/`trim` off the main thread, returning the produced encoded **byte stream** — or
   * `undefined` to signal "no offload; run the inline path" (offload not selected, or no worker pool spawned
   * — the honest fallback). The `worker === false`/no-`Worker` opt-out is gated EAGERLY here (`#workerMode`),
   * so a non-offload engine (e.g. anything in Node) returns at once and NEVER even imports the heavy
   * `worker-host` chunk. When offload IS selected, the lazily-imported {@link tryOffload} owns the
   * ensure-pool + payload assembly + byte round-trip (so the eager kernel stays slim, doc 08 §7); the engine
   * passes its by-reference pool cache + resolved pool size. The caller materializes the returned stream into
   * the sink on THIS (main) thread — the sink may hold a DOM element, so it never crosses to the worker
   * (only encoded bytes do; no `VideoFrame`/`AudioData` crosses).
   */
  async #offloadStream(
    src: Source,
    kind: 'convert' | 'trim',
    publicOpts: ConvertOptions | TrimOptions,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<ReadableStream<Uint8Array> | undefined> {
    if (this.#workerMode !== 'offload') return undefined;
    /* v8 ignore start -- offload mode needs a real `Worker` (browser); in Node `#workerMode` is 'inline', so
       this lazy import + spawn is never reached. The ensure-pool/offload LOGIC in `worker-host` is unit-tested
       via `createWorkerPool`/`offloadHeavyOp` with an injected transport; browser-harness validated end to end. */
    const { tryOffload } = await import('../kernel/worker-host.ts');
    return tryOffload(this.#poolCache, resolvePoolSize(this.#opts.worker), src, kind, publicOpts, {
      signal,
      determinism: this.#determinism(o),
      ...(o.strategy?.pinDriver !== undefined ? { pinDriver: o.strategy.pinDriver } : {}),
      wasmRuntime: this.#wasmRuntime,
      ...(this.#wasmAssetBaseUrl !== undefined ? { wasmAssetBaseUrl: this.#wasmAssetBaseUrl } : {}),
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    });
    /* v8 ignore stop */
  }

  /**
   * Resolve a codec route — the driver PLUS the exact accepted capability verdict (`CodecRoute`,
   * ADR-203) — loading the first-party defaults on a typed miss then retrying once. Decode paths
   * configure the accepted `hardwareAcceleration` rung straight from `route.support`; re-deriving it
   * with a second `supports()`/`isConfigSupported` probe is exactly the ~4× regression ADR-203 records.
   * The miss fallback mirrors the query-selective default registration (a definite eligible audio query
   * registers only the immediately-needed native driver; anything else loads the complete bundle) while
   * preserving the verdict the retry probe accepted.
   */
  async #probeCodec(q: CodecQuery, o: CallOptions): Promise<CodecRoute> {
    const opts: StageSelectOptions = {
      determinism: this.#determinism(o),
      ...(o.strategy?.pinDriver !== undefined ? { pinDriver: o.strategy.pinDriver } : {}),
    };
    try {
      return await this.#router.probeCodec(q, opts);
    } catch (e) {
      if (!(e instanceof CapabilityError) || this.#defaultsLoaded) throw e;
      const { registerDefaultCodecForQuery } = await import(
        '../drivers/default-codec-registration.ts'
      );
      if (await registerDefaultCodecForQuery(this.#registry, q, opts)) {
        this.#router.clearCache();
        try {
          return await this.#router.probeCodec(q, opts);
        } catch (error) {
          if (!(error instanceof CapabilityError)) throw error;
        }
      }
      await this.#ensureDefaultDrivers();
      return this.#router.probeCodec(q, opts);
    }
  }

  /** Resolve a codec driver only (encode paths / runner contexts); decode paths use {@link #probeCodec}. */
  async #routeCodec(q: CodecQuery, o: CallOptions): Promise<CodecDriver> {
    return (await this.#probeCodec(q, o)).driver;
  }

  /**
   * Lazily create (once) the per-instance warm `VideoDecoder` pool used by the sequential seek path. Loaded
   * from the already-resident `webcodecs-video` chunk (the seek's routed codec is that driver), so this adds
   * no eager-kernel weight. Reached only on the browser-only live-decode seek path.
   */
  /* v8 ignore start -- requires a real VideoDecoder (browser); the pool logic is Node-tested directly. */
  async #ensureVideoDecoderPool(): Promise<WarmVideoDecoderPool> {
    if (this.#videoDecoderPool === undefined) {
      const { createWarmVideoDecoderPool } = await import('../codecs/webcodecs-video.ts');
      this.#videoDecoderPool ??= createWarmVideoDecoderPool();
    }
    return this.#videoDecoderPool;
  }
  /* v8 ignore stop */

  /** Resolve a filter driver for a spec, loading the first-party defaults on a miss then retrying once. */
  async #routeFilter(spec: FilterSpec, o: CallOptions, cost?: RouteCost): Promise<FilterDriver> {
    const opts: StageSelectOptions = {
      determinism: this.#determinism(o),
      ...(o.strategy?.pinDriver !== undefined ? { pinDriver: o.strategy.pinDriver } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };
    try {
      return this.#router.pickFilter(spec, opts);
    } catch (e) {
      if (!(e instanceof CapabilityError) || this.#defaultsLoaded) throw e;
      await this.#ensureDefaultDrivers();
      return this.#router.pickFilter(spec, opts);
    }
  }

  /** Resolve the default image capability if the source's magic bytes are a supported image format. */
  async #imageOpsForSource(src: Source, signal?: AbortSignal): Promise<ImageOps | undefined> {
    const head = await readHead(src, HINTED_HEAD_BYTES, signal);
    if (this.#registry.imageOps() === undefined) {
      await this.#ensureDefaultDrivers();
    }
    const ops = this.#registry.imageOps();
    return ops?.sniff(head) === undefined ? undefined : ops;
  }

  /** Probe image bytes through the standalone image parser when the source magic matches an image. */
  async #probeImageInfo(src: Source, signal: AbortSignal): Promise<MediaInfo | undefined> {
    const ops = await this.#imageOpsForSource(src, signal);
    if (ops === undefined) return undefined;
    const bytes = await readAllSource(src, signal);
    const { imageInfoToMediaMetadata } = await import('../codecs/image/probe.ts');
    return imageInfoToMediaMetadata(await ops.probe(bytes), src.size);
  }

  /** Sniff an image source once and, if matched, keep the bytes shared by the video/audio decode streams. */
  async #imageDecodeRoute(
    src: Source,
    signal: AbortSignal,
    determinism: Determinism,
  ): Promise<ImageDecodeRoute | undefined> {
    const ops = await this.#imageOpsForSource(src, signal);
    if (ops === undefined) return undefined;
    if (determinism === 'force-software') {
      const error = new CapabilityError(
        'force-software image decode has no proved software substrate',
        {
          op: { kind: 'route', id: 'decode', facts: { mediaType: 'video', source: 'image' } },
          tried: ['image-decoder'],
        },
      );
      await cancelSource(src, error);
      throw error;
    }
    const bytes = await readAllSource(src, signal);
    return { ops, bytes };
  }

  /** Browser-only image decode route: still/animated images become a video frame stream, no packet seam. */
  async #decodeVideoOrImage(
    source: () => Promise<Source>,
    stage: StageOptions,
    imageRoute: ImageDecodeRouteLoader,
  ): Promise<ReadableStream<VideoFrame> | undefined> {
    const image = await imageRoute();
    if (image !== undefined) {
      return image.ops.decode(image.bytes, stage.signal ? { signal: stage.signal } : {});
    }
    return this.#decodeTrack(await source(), 'video', stage);
  }

  /**
   * Build one decoded-frame stream for a track of `mediaType` (or `undefined` if the source has no such
   * decodable track). Demux → route a codec for the track's config → pipe its packets through the
   * decoder. The decoder owns close-once for the frames it emits; cancellation rides `stage.signal`.
   */
  async #decodeTrack<M extends 'video' | 'audio'>(
    src: Source,
    mediaType: M,
    stage: StageOptions,
  ): Promise<ReadableStream<RawFrameOf<M>> | undefined> {
    const container = await this.#routeContainer(src, 'demux', stage.signal, stage.pinDriver);
    // A raw-PCM stream driver owns the complete audio-container parse and exposes canonical chunks
    // directly. Avoid a duplicate demux/track-discovery pass before the first frame; the contract is
    // intentionally limited to raw-PCM containers, so a declared stream is itself the audio track.
    if (
      mediaType === 'audio' &&
      (container.decodePcmInterleavedStream !== undefined ||
        container.decodePcmAudioStream !== undefined)
    ) {
      const { interleavedPcmChunksToAudioDataStream, pcmAudioChunksToAudioDataStream } =
        await import('../dsp/audio-data.ts');
      if (container.decodePcmInterleavedStream !== undefined) {
        const chunks = await container.decodePcmInterleavedStream(src, stage);
        return interleavedPcmChunksToAudioDataStream(chunks, stage, container.id) as ReadableStream<
          RawFrameOf<M>
        >;
      }
      if (container.decodePcmAudioStream !== undefined) {
        const chunks = await container.decodePcmAudioStream(src, stage);
        return pcmAudioChunksToAudioDataStream(
          chunks,
          stage,
          container.id,
          'f32',
        ) as ReadableStream<RawFrameOf<M>>;
      }
    }
    const demuxer = await container.demux(src, stage);
    const track = demuxer.tracks.find((t) => t.mediaType === mediaType && t.config !== undefined);
    if (!track) {
      await demuxer.close();
      return undefined;
    }
    if (track.encrypted === true) {
      await demuxer.close();
      throw new MediaError('decode-error', `protected ${mediaType} needs decrypt()`);
    }
    if (
      mediaType === 'audio' &&
      container.decodePcmAudio &&
      (isRawPcmTrack(track) || track.codec === 'flac')
    ) {
      await demuxer.close();
      const {
        interleavedPcmChunksToAudioDataStream,
        pcmAudioChunksToAudioDataStream,
        pcmAudioToAudioDataStream,
      } = await import('../dsp/audio-data.ts');
      if (container.decodePcmInterleavedStream !== undefined) {
        const chunks = await container.decodePcmInterleavedStream(src, stage);
        return interleavedPcmChunksToAudioDataStream(chunks, stage, track.codec) as ReadableStream<
          RawFrameOf<M>
        >;
      }
      if (container.decodePcmAudioStream !== undefined) {
        const chunks = await container.decodePcmAudioStream(src, stage);
        return pcmAudioChunksToAudioDataStream(chunks, stage, track.codec, 'f32') as ReadableStream<
          RawFrameOf<M>
        >;
      }
      const audio = await container.decodePcmAudio(src, stage);
      return pcmAudioToAudioDataStream(audio, stage, track.codec, 'f32') as ReadableStream<
        RawFrameOf<M>
      >;
    }
    const {
      decodeQueryFor,
      decodeVideoPacketsWithAlpha,
      decodedAudioStreamWithGapless,
      unwrapPackets,
    } = await loadCodecPipeline();
    const decodeQuery = await decodeQueryFor(track);
    const route = await this.#probeCodec(decodeQuery, {
      strategy: stageStrategy(stage),
    });
    const codec = route.driver;
    // The route above throws a typed miss in Node (no WebCodecs); past here is the live decode path.
    // The decoder config pins the exact accepted acceleration rung from the verdict (ADR-203).
    const config = decoderConfigWithRoutedAcceleration(decodeQuery.config, route.support);
    /* v8 ignore start -- requires a real VideoDecoder/AudioDecoder; browser-harness validated. */
    if (mediaType === 'video' && track.alpha === true) {
      return decodeVideoPacketsWithAlpha(demuxer.packets(track.id), () =>
        codec.createDecoder(config, stage),
      ) as ReadableStream<RawFrameOf<M>>;
    }
    const decoder = codec.createDecoder(config, stage);
    // The demuxer stays open for the life of the packet stream; closing it is a no-op for the mp4 driver
    // (range-backed), so the frame stream owns no teardown beyond the decoder's own abort listener. The
    // track's mediaType matches `M`, so the decoder's RawFrame output is the corresponding frame type.
    const decoded = unwrapPackets(demuxer.packets(track.id)).pipeThrough(decoder) as ReadableStream<
      RawFrameOf<M>
    >;
    if (mediaType === 'audio') {
      return (await decodedAudioStreamWithGapless(decoded as ReadableStream<AudioData>, track, {
        packets: demuxer.packets(track.id),
        createDecoder: () => codec.createDecoder(config, stage),
        signal: stage.signal,
      })) as ReadableStream<RawFrameOf<M>>;
    }
    return decoded;
    /* v8 ignore stop */
  }

  async #decodeAudioTrackPackets(
    demuxer: Demuxer,
    track: TrackInfo,
    stage: StageOptions,
    o: CallOptions,
  ): Promise<ReadableStream<AudioData>> {
    const { decodeQueryFor, decodedAudioStreamWithGapless, unwrapPackets } =
      await loadCodecPipeline();
    const decodeQuery = await decodeQueryFor(track);
    const route = await this.#probeCodec(decodeQuery, o);
    const codec = route.driver;
    const config = decoderConfigWithRoutedAcceleration(decodeQuery.config, route.support);
    const decoded = unwrapPackets(demuxer.packets(track.id)).pipeThrough(
      codec.createDecoder(config, stage),
    ) as ReadableStream<AudioData>;
    return decodedAudioStreamWithGapless(decoded, track, {
      packets: demuxer.packets(track.id),
      createDecoder: () => codec.createDecoder(config, stage),
      signal: stage.signal,
    });
  }

  /** Bind only engine-private routing/codec seams; complete remux/trim orchestration stays lazy. */
  #operationRunnerContext(): DecryptRunnerContext &
    MuxRunnerContext &
    RemuxRunnerContext &
    TrimRunnerContext {
    return {
      resolveHls: this.#resolveHlsInput.bind(this),
      container: this.#routeContainer.bind(this),
      muxer: this.#routeMuxer.bind(this),
      stage: this.#stageOptions.bind(this),
      offload: this.#offloadStream.bind(this),
      codec: this.#routeCodec.bind(this),
      decodeAudio: this.#decodeAudioTrackPackets.bind(this),
      encodeVideo: this.#encodeVideoStream.bind(this),
      encodeAudio: this.#encodeAudioStream.bind(this),
      assertRange: assertTrimRange,
    };
  }

  /**
   * The capabilities the lazily-imported PCM-family authoring routines need, bound to this engine instance —
   * a superset satisfying both the FLAC and raw-PCM authoring routes. The implementation stays lazy.
   */
  #authoringDeps(o: CallOptions = {}): PcmConvertDeps {
    return {
      routeContainer: (src, direction) =>
        this.#routeContainer(src, direction, undefined, o.strategy?.pinDriver),
      stageOptions: (signal, o) => this.#stageOptions(signal, o),
      mimeOpts: (signal, container) => mimeOpts(signal, container),
      pcmSampleFormat: (codec) => pcmSampleFormat(codec),
      pcmEndian: (codec) => pcmEndian(codec),
    };
  }

  /**
   * The full codec-seam convert pipeline: demux → per track decode → optional GPU filter chain (video) →
   * encode → mux. A pure container change with no re-encode is preferred as a lossless stream-copy
   * (ADR-021) when the source supports it. Output goes to the chosen container's `Muxer`.
   */
  async #convertViaCodec(
    src: Source,
    opts: ConvertOptions,
    signal: AbortSignal,
    o: CallOptions,
    input: MediaInput,
  ): Promise<Output> {
    const { runCodecConvert } = await import('./codec-convert-runner.ts');
    return runCodecConvert(src, opts, signal, o, input, {
      routeContainer: this.#routeContainer.bind(this),
      stageOptions: this.#stageOptions.bind(this),
      offloadStream: this.#offloadStream.bind(this),
      videoRunnerContext: () => this.#videoRunnerContext(),
      routeMuxer: this.#routeMuxer.bind(this),
      muxOptions: muxOptionsFrom,
      materializeOutput,
      mimeOptions: mimeOpts,
      sourceGeometry: sourceGeometryOf,
      transcodeVpxAlphaGeometry: this.#transcodeVpxAlphaGeometryPacketStream.bind(this),
      transcodeVpxAlpha: this.#transcodeVpxAlphaPacketStream.bind(this),
      routeCodec: this.#routeCodec.bind(this),
      closeIfClosable,
      applyVideoFilters: this.#applyVideoFilters.bind(this),
      encodeVideoStream: this.#encodeVideoStream.bind(this),
      isRawPcmTrack,
      decodeAudioTrackPackets: this.#decodeAudioTrackPackets.bind(this),
      applyAudioFilters: this.#applyAudioFilters.bind(this),
      encodeAudioStream: this.#encodeAudioStream.bind(this),
    });
  }

  /** Bind the engine-owned router/filter capabilities shared by both lazy video-runner entry points. */
  #videoRunnerContext(): H264TwoPassRunnerContext {
    return {
      routeCodec: this.#routeCodec.bind(this),
      applyVideoFilters: this.#applyVideoFilters.bind(this),
      stageOptions: this.#stageOptions.bind(this),
    };
  }

  /** Resize VPx colour and alpha planes independently, avoiding an intermediate merged RGBA frame. */
  async #transcodeVpxAlphaGeometryPacketStream(
    packets: ReadableStream<Packet>,
    target: VideoTarget,
    sourceTrack: TrackInfo,
    muxer: Muxer,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<void> {
    const {
      buildVideoEncoderConfig,
      decodeQueryFor,
      decodeVpxAlphaPacketStreams,
      drainEncoderToMuxer,
      encodeVpxAlphaFrameStreams,
      encodeQueryFor,
      requireEncoderConfig,
      videoTrackInfoFromDecoderConfig,
    } = await loadCodecPipeline();
    const decodeQuery = await decodeQueryFor(sourceTrack);
    const decodeRoute = await this.#probeCodec(decodeQuery, o);
    const decodeCodec = decodeRoute.driver;
    const decodeConfig = decoderConfigWithRoutedAcceleration(
      decodeQuery.config,
      decodeRoute.support,
    );
    const encodeConfig = buildVideoEncoderConfig(
      target,
      sourceGeometryOf(sourceTrack),
      sourceTrack.codec,
    );
    const encoderConfig: VideoEncoderConfig = { ...encodeConfig, alpha: 'discard' };
    const decodeStage: VideoDecoderStageOptions = {
      ...this.#stageOptions(signal, o),
      alpha: 'discard',
    };
    const planes = decodeVpxAlphaPacketStreams(packets, () =>
      decodeCodec.createDecoder(decodeConfig, decodeStage),
    );
    const colorFrames = await this.#applyVideoFilters(planes.color, target, sourceTrack, signal, o);
    const alphaFrames = await this.#applyVideoFilters(planes.alpha, target, sourceTrack, signal, o);
    /* v8 ignore start -- requires live WebCodecs decode/filter/encode; browser-harness validated. */
    let decoderConfig: VideoDecoderConfig | undefined;
    const colorStage: VideoEncoderStageOptions = {
      ...this.#stageOptions(signal, o),
      onDecoderConfig: (config) => {
        decoderConfig = config;
      },
      ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
    };
    const alphaStage: VideoEncoderStageOptions = {
      ...this.#stageOptions(signal, o),
      ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
    };
    const encodeCodec = await this.#routeCodec(encodeQueryFor(encoderConfig), o);
    const chunks = encodeVpxAlphaFrameStreams(colorFrames, alphaFrames, {
      encodeConfig: encoderConfig,
      createEncoder: (config, stageOptions) => encodeCodec.createEncoder(config, stageOptions),
      colorStage,
      alphaStage,
    });
    await drainEncoderToMuxer(
      chunks,
      muxer,
      () =>
        videoTrackInfoFromDecoderConfig(
          requireEncoderConfig(decoderConfig, 'video'),
          target.fps,
          sourceTrack.durationSec,
          sourceTrack.rotation,
        ),
      signal,
    );
    /* v8 ignore stop */
  }

  /**
   * Compose the video transform chain for a decoded stream. Geometry/colour ops are router-resolved
   * same-type `VideoFrame→VideoFrame` stages; a requested output `fps` then restamps/duplicates/drops
   * presentation frames onto a CFR grid before encode. No ops ⇒ the decoded stream passes through
   * untouched (no extra copy).
   */
  /* v8 ignore start -- only reached after a live decode (WebCodecs); the filter-spec planning it calls is
     unit-tested directly (videoFilterSpecs), and the GPU composition is validated in the browser harness. */
  async #applyVideoFilters(
    frames: ReadableStream<VideoFrame>,
    target: VideoTarget,
    track: TrackInfo,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<ReadableStream<VideoFrame>> {
    // The video filter-spec PLANNER lives in a lazily-imported chunk (`video-stream-plan.ts`), so the eager
    // kernel never statically pulls the video-spec code (doc 08 §7). Reached only here, on the live convert
    // video re-encode — already a browser-only, async path.
    const { retimeVideoFrameStream, videoFilterRouteCost, videoFilterSpecs } = await import(
      './video-stream-plan.ts'
    );
    const sourceGeometry = sourceGeometryOf(track);
    const specs = videoFilterSpecs(target, sourceGeometry);
    const routeCost = videoFilterRouteCost(target, sourceGeometry);
    let out = frames;
    const stages: TransformStream<VideoFrame, VideoFrame>[] = [];
    for (const spec of specs) {
      const driver = await this.#routeFilter(spec, o, routeCost);
      stages.push(
        driver.createFilter(spec, this.#stageOptions(signal, o)) as TransformStream<
          VideoFrame,
          VideoFrame
        >,
      );
    }
    if (stages.length > 0) out = composeChain(out, stages);
    if (target.fps !== undefined) {
      const durationUs =
        track.durationSec !== undefined &&
        Number.isFinite(track.durationSec) &&
        track.durationSec > 0
          ? Math.round(track.durationSec * MICROS_PER_SECOND)
          : undefined;
      out = retimeVideoFrameStream(
        out,
        durationUs === undefined ? { fps: target.fps } : { fps: target.fps, durationUs },
      );
    }
    return out;
  }
  /* v8 ignore stop */

  /**
   * Compose the audio remix/resample chain for a decoded `AudioData` stream from the target's
   * channel/rate (each a router-resolved `AudioData→AudioData` audio-dsp stage). This shapes the buffers
   * to the encoder's configured layout BEFORE encoding — a downmix/resample the `AudioEncoder` itself does
   * not perform — so a stereo→mono (or rate-changing) transcode feeds the encoder matching buffers. No
   * channel/rate change ⇒ the decoded stream passes through untouched.
   */
  /* v8 ignore start -- only reached after a live decode (WebCodecs); the spec planning it calls is
     unit-tested directly (audioFilterSpecs), and the AudioData composition is browser-harness validated. */
  async #applyAudioFilters(
    frames: ReadableStream<AudioData>,
    target: AudioTarget,
    track: TrackInfo,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<ReadableStream<AudioData>> {
    const { audioFilterSpecs, audioTargetCanBypassFilterPlanner } = await import(
      './audio-stream-plan.ts'
    );
    if (audioTargetCanBypassFilterPlanner(target)) return frames;
    // The lossy-seam audio-filter PLANNER lives in a lazily-imported chunk (`audio-stream-plan.ts`), so the
    // eager kernel never statically pulls the audio-spec code + its audio-dsp type imports (doc 08 §7).
    // Reached only here, on the live convert audio re-encode — already a browser-only, async path.
    const specs = audioFilterSpecs(target, audioGeometryOf(track));
    if (specs.length === 0) return frames;
    const stages: TransformStream<AudioData, AudioData>[] = [];
    for (const spec of specs) {
      const driver = await this.#routeFilter(spec, o);
      stages.push(
        driver.createFilter(spec, this.#stageOptions(signal, o)) as TransformStream<
          AudioData,
          AudioData
        >,
      );
    }
    return composeChain(frames, stages);
  }
  /* v8 ignore stop */

  /** Transcode an unfiltered VPx-alpha packet stream without merging/splitting RGBA frames. */
  async #transcodeVpxAlphaPacketStream(
    packets: ReadableStream<Packet>,
    target: VideoTarget,
    sourceTrack: TrackInfo,
    muxer: Muxer,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<void> {
    const {
      buildVideoEncoderConfig,
      canCopyVpxAlphaSideData,
      decodeQueryFor,
      drainEncoderToMuxer,
      encodeQueryFor,
      requireEncoderConfig,
      transcodeVpxAlphaPackets,
      videoTrackInfoFromDecoderConfig,
    } = await loadCodecPipeline();
    const decodeQuery = await decodeQueryFor(sourceTrack);
    // Packet-plane VPx alpha decodes colour and alpha elementary streams independently. Route the exact
    // `alpha:'discard'` config those decoders receive; probing implicit `keep` here made a discard-capable
    // browser miss before construction (and a coarse Router cache made the result operation-order dependent).
    const decodeConfig: VideoDecoderConfig & { readonly alpha: AlphaOption } = {
      ...(decodeQuery.config as VideoDecoderConfig),
      alpha: 'discard',
    };
    const decodeRoute = await this.#probeCodec({ ...decodeQuery, config: decodeConfig }, o);
    const decodeCodec = decodeRoute.driver;
    const routedDecodeConfig = decoderConfigWithRoutedAcceleration(
      decodeConfig,
      decodeRoute.support,
    );
    const encodeConfig = buildVideoEncoderConfig(
      target,
      sourceGeometryOf(sourceTrack),
      sourceTrack.codec,
    );
    const encoderConfig: VideoEncoderConfig = { ...encodeConfig, alpha: 'discard' };
    const encodeCodec = await this.#routeCodec(encodeQueryFor(encoderConfig), o);
    /* v8 ignore start -- requires live WebCodecs decoders/encoders; browser-harness validated. */
    let decoderConfig: VideoDecoderConfig | undefined;
    const colorStage: VideoEncoderStageOptions = {
      ...this.#stageOptions(signal, o),
      onDecoderConfig: (c) => {
        decoderConfig = c;
      },
      ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
    };
    const alphaStage: VideoEncoderStageOptions = {
      ...this.#stageOptions(signal, o),
      ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
    };
    const decodeStage: VideoDecoderStageOptions = {
      ...this.#stageOptions(signal, o),
      alpha: 'discard',
    };
    const chunks = transcodeVpxAlphaPackets(packets, {
      decodeConfig: routedDecodeConfig,
      encodeConfig: encoderConfig,
      createDecoder: (c, stageOptions) => decodeCodec.createDecoder(c, stageOptions),
      createEncoder: (c, stageOptions) => encodeCodec.createEncoder(c, stageOptions),
      decodeStage,
      colorStage,
      alphaStage,
      copyAlpha: canCopyVpxAlphaSideData(target, decodeConfig.codec, encoderConfig.codec),
    });
    await drainEncoderToMuxer(
      chunks,
      muxer,
      () =>
        videoTrackInfoFromDecoderConfig(
          requireEncoderConfig(decoderConfig, 'video'),
          target.fps,
          sourceTrack.durationSec,
          sourceTrack.rotation,
        ),
      signal,
    );
    /* v8 ignore stop */
  }

  /** Encode one video stream and drain its chunks into the muxer (with the encoder→muxer config bridge). */
  async #encodeVideoStream(
    frames: ReadableStream<VideoFrame>,
    target: VideoTarget,
    sourceTrack: TrackInfo | undefined,
    muxer: Muxer,
    signal: AbortSignal,
    o: CallOptions,
    fragmented = false,
    twoPassPlan?: H264TwoPassPlan,
  ): Promise<void> {
    const { encodeVideoStream } = await import('./video-two-pass-runner.ts');
    await encodeVideoStream(
      frames,
      target,
      sourceTrack,
      muxer,
      signal,
      o,
      fragmented,
      twoPassPlan,
      this.#videoRunnerContext(),
    );
  }

  /** Encode one audio stream and drain its chunks into the muxer (with the encoder→muxer config bridge). */
  async #encodeAudioStream(
    frames: ReadableStream<AudioData>,
    target: AudioTarget,
    sourceTrack: TrackInfo | undefined,
    muxer: Muxer,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<void> {
    const {
      audioEncodeNeedsSoftwareRuntime,
      audioTrackInfoFromDecoderConfig,
      buildAudioEncoderConfig,
      drainEncoderToMuxer,
      encodeQueryFor,
      outputGaplessForAudioEncoder,
      requireEncoderConfig,
    } = await loadCodecPipeline();
    const config = buildAudioEncoderConfig(
      target,
      audioGeometryOf(sourceTrack),
      sourceTrack?.codec,
    );
    const encodeOptions = (await audioEncodeNeedsSoftwareRuntime(config)) ? forceSoftware(o) : o;
    const codec = await this.#routeCodec(encodeQueryFor(config), encodeOptions);
    // Past here is the live WebCodecs path — unreachable in Node (the route above throws first).
    /* v8 ignore start -- requires a real AudioEncoder; validated in the browser harness (BUILD §6.1). */
    let decoderConfig: AudioDecoderConfig | undefined;
    const stage: AudioEncoderStageOptions = {
      ...this.#stageOptions(signal, encodeOptions),
      onConfig: (c) => {
        decoderConfig = c;
      },
    };
    const chunks = frames.pipeThrough(codec.createEncoder(config, stage));
    await drainEncoderToMuxer(
      chunks,
      muxer,
      () =>
        audioTrackInfoFromDecoderConfig(
          requireEncoderConfig(decoderConfig, 'audio'),
          sourceTrack?.durationSec,
          outputGaplessForAudioEncoder(requireEncoderConfig(decoderConfig, 'audio'), sourceTrack),
        ),
      signal,
    );
    /* v8 ignore stop */
  }

  #withCancel<T>(o: CallOptions, exec: (signal: AbortSignal) => Promise<T>): Cancellable<T> {
    this.#assertNotDisposed();
    const ctrl = new AbortController();
    const caller = o.signal;
    const onCallerAbort = (): void => ctrl.abort(caller?.reason);
    let callerListenerAttached = false;
    if (caller) {
      if (caller.aborted) ctrl.abort(caller.reason);
      else {
        caller.addEventListener('abort', onCallerAbort, { once: true });
        callerListenerAttached = true;
      }
    }
    const releaseCallerListener = (): void => {
      if (!callerListenerAttached || caller === undefined) return;
      callerListenerAttached = false;
      caller.removeEventListener('abort', onCallerAbort);
    };
    // Preserve the original zero-pin execution ordering: no pre-execution promise wrapper or registry
    // scan. A caller-signal task adds only one settlement observer to release its owned listener.
    let p: Cancellable<T>;
    try {
      p = (
        o.strategy?.pinDriver === undefined || ctrl.signal.aborted
          ? exec(ctrl.signal)
          : (async (): Promise<T> => {
              await this.#ensurePinRegistered(o);
              return exec(ctrl.signal);
            })()
      ) as Cancellable<T>;
    } catch (error) {
      releaseCallerListener();
      throw error;
    }
    if (callerListenerAttached) void p.then(releaseCallerListener, releaseCallerListener);
    p.cancel = (): void => ctrl.abort(new MediaError('aborted', 'operation cancelled'));
    return p;
  }

  /** Resolve an exact pin before any source/frame ownership begins; defaults may define the id lazily. */
  async #ensurePinRegistered(o: CallOptions): Promise<void> {
    const pin = o.strategy?.pinDriver;
    if (pin === undefined || this.#hasDriverId(pin)) return;
    const { registerDefaultNativeCodecPin } = await import(
      '../drivers/default-codec-registration.ts'
    );
    if (await registerDefaultNativeCodecPin(this.#registry, pin)) {
      this.#router.clearCache();
      return;
    }
    await this.#ensureDefaultDrivers();
    if (this.#hasDriverId(pin)) return;
    throw new CapabilityError(`pinned driver '${pin}' is not registered`, {
      op: { kind: 'route', id: pin },
      tried: [pin],
    });
  }

  #hasDriverId(id: string): boolean {
    return (
      this.#registry.codecs().some((driver) => driver.id === id) ||
      this.#registry.containers().some((driver) => driver.id === id) ||
      this.#registry.filters().some((driver) => driver.id === id)
    );
  }
}

// ── Module helpers ──────────────────────────────────────────────────────────────────────────────

/** The raw-frame type for a media type: `VideoFrame` for video, `AudioData` for audio. */
type RawFrameOf<M extends 'video' | 'audio'> = M extends 'video' ? VideoFrame : AudioData;

interface ImageDecodeRoute {
  readonly ops: ImageOps;
  readonly bytes: Uint8Array;
}

type ImageDecodeRouteLoader = () => Promise<ImageDecodeRoute | undefined>;
const noImageDecodeRoute: ImageDecodeRouteLoader = () => Promise.resolve(undefined);

// Legacy helper re-exports (R-S05.1 transition): `deferredStream` and `assertTrimRange` live in their
// own modules now; these shims keep the remaining cross-shard test importers (`codec-ops.test.ts`,
// `trim-robustness.test.ts`) compiling until their owners migrate the imports — at which point these
// two lines are deleted and engine.ts exports exactly MediaEngine + MediaEngineImpl.
export { deferredStream } from './frame-streams.ts';
export { assertTrimRange } from './trim-range.ts';
