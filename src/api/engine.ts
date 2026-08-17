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
  AudioEncoderOutputTiming,
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
  PacketInfoBatchStream,
  PacketInfoTable,
  StageOptions,
  TrackInfo,
  WasmRuntimeProfile,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
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
import type { ProbeContainerResultCache } from './blob-probe-handoff.ts';
import { createMediaChain } from './chain.ts';
import { decoderConfigWithRoutedAcceleration } from './codec-route.ts';
import { containerHasChunkMuxer, isPcmContainer } from './codec-routing.ts';
import { mimeOpts } from './container-mime.ts';
import type { DecryptRunnerContext } from './decrypt-runner.ts';
import { bridgeSignal, closeIfClosable, deferredStream, memoizeAsync } from './frame-streams.ts';
import type { MediaJob } from './job.ts';
import type { MuxRunnerContext } from './mux-runner.ts';
import {
  audioGeometryOf,
  forceSoftware,
  isFlacAuthorCodec,
  isPcmCodec,
  isPinnedDriverMiss,
  isRawPcmTrack,
  materializeOutput,
  muxOptionsFrom,
  normalizeByteInput,
  sourceGeometryOf,
} from './op-support.ts';
import type { PacketInfoBatchCallOptions, PacketInfoCallOptions } from './packet-info-runner.ts';
// Type-only: erased at build time, so this is NOT a static import edge — the FLAC + raw-PCM authoring
// routines are reached only through lazy `import()`s on an eligible `to:'flac'`/raw-PCM convert. The
// engine's `#authoringDeps()` returns the `PcmConvertDeps` superset, which also satisfies the FLAC route's
// (narrower) deps at its call site, so only this one type is referenced here.
import type { PcmConvertDeps } from './pcm-convert-plan.ts';
import type { ProbeRunnerContext } from './probe-runner.ts';
import type { RemuxRunnerContext } from './remux-runner.ts';
import {
  HINTED_HEAD_BYTES,
  type SourcePrefixHandoff,
  cacheProbeRanges,
  clearSourcePrefixHandoffs,
  extensionOf,
  readHead,
  routeHeadBytes,
  sourceMayBeHlsManifest,
  sourceMayHaveBlobProbeHandoff,
  throwIfAborted,
} from './source-io.ts';
import type { TrimRunnerContext } from './trim-runner.ts';
import type {
  AudioTarget,
  CallOptions,
  Cancellable,
  Container,
  ConvertOptions,
  CreateMediaOptions,
  DecodeOptions,
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

/** The developer-facing engine surface (ADR-009). */
export interface MediaEngine {
  probe(input: MediaInput, o?: CallOptions): Cancellable<MediaInfo>;
  demux(input: MediaInput, o?: CallOptions): Cancellable<Demuxed>;
  /** Materialized packet rows for compatibility and modest inputs. */
  packetInfo(input: MediaInput, o?: PacketInfoCallOptions): Cancellable<PacketInfoTable>;
  /** Pull-driven packet rows with bounded row-object memory and explicit lifecycle ownership. */
  packetInfoBatches(
    input: MediaInput,
    o?: PacketInfoBatchCallOptions,
  ): Cancellable<PacketInfoBatchStream>;
  convert(input: MediaInput, opts: ConvertOptions, o?: CallOptions): Cancellable<Output>;
  /**
   * Atomically author up to eight H.264 renditions as retained Blob outputs. The operation rejects
   * sources/output aggregates beyond the public ABR memory policy before publishing any rung.
   */
  h264AbrLadder(
    input: MediaInput,
    ladder: readonly H264AbrRung[],
    o?: CallOptions,
  ): Cancellable<readonly Output[]>;
  remux(input: MediaInput, opts: RemuxOptions, o?: CallOptions): Cancellable<Output>;
  trim(input: MediaInput, opts: TrimOptions, o?: CallOptions): Cancellable<Output>;
  decode(input: MediaInput, o?: DecodeOptions): MediaStreams;
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

type CodecPipelineModule = typeof import('./codec-pipeline.ts');
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
  #probeContainerResultCache: ProbeContainerResultCache | undefined;
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
    this.#invalidateProbeResults();
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
      this.#invalidateProbeResults();
      clearSourcePrefixHandoffs(this.#sourcePrefixHandoff);
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
      throw new MediaError('aborted', 'engine disposed', {
        reason: 'disposed',
      });
    }
  }

  #invalidateProbeResults(): void {
    this.#probeContainerResultCache?.clear();
    this.#probeContainerResultCache = undefined;
  }

  async #blobProbe(src: Source): Promise<readonly [Source, ProbeContainerResultCache]> {
    const cache = await loadProbeRangeCache();
    this.#assertNotDisposed();
    this.#probeContainerResultCache ??= new cache.ProbeContainerResultCache(
      this.#sourcePrefixHandoff,
    );
    return this.#probeContainerResultCache.wrap(src);
  }

  async #cacheFiniteBlobRanges(src: Source): Promise<Source> {
    if (!sourceMayHaveBlobProbeHandoff(src)) return src;
    const cache = await loadProbeRangeCache();
    this.#assertNotDisposed();
    return cache.cacheFiniteBlobProbeRanges(src, this.#sourcePrefixHandoff);
  }

  #probeRunnerContext(): ProbeRunnerContext {
    return {
      cacheOwner: this,
      sourcePrefixHandoff: this.#sourcePrefixHandoff,
      loadRangeCache: loadProbeRangeCache,
      resolveHls: this.#resolveHlsInput.bind(this),
      blobProbe: this.#blobProbe.bind(this),
      routeSource: (source, signal, pinDriver) =>
        this.#routeContainer(source, 'demux', signal, pinDriver),
      routeToken: (container, pinDriver) =>
        this.#routeContainerToken(container, 'demux', pinDriver),
      stage: this.#stageOptions.bind(this),
      imageOps: this.#imageOpsForSource.bind(this),
    };
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
    return (
      this.#probeContainerResultCache?.hit(input, o) ??
      this.#withCancel(o, async (signal) => {
        const normalized = normalizeInput(input);
        if (isLiveMediaSource(normalized)) {
          throwIfAborted(signal);
          const { probeLiveMediaStream } = await import('../sources/live-media.ts');
          throwIfAborted(signal);
          return probeLiveMediaStream(normalized);
        }
        const { runProbe } = await import('./probe-runner.ts');
        return runProbe(this.#probeRunnerContext(), input, normalized, o, signal);
      })
    );
  }

  probeContainer(
    input: MediaInput,
    container: Container,
    o: CallOptions = {},
  ): Cancellable<MediaInfo> {
    return (
      this.#probeContainerResultCache?.hit(input, o, container) ??
      this.#withCancel(o, async (signal) => {
        const normalized = normalizeByteInput(input, 'probeContainer');
        const { runProbeContainer } = await import('./probe-runner.ts');
        return runProbeContainer(
          this.#probeRunnerContext(),
          input,
          normalized,
          container,
          o,
          signal,
        );
      })
    );
  }

  demux(input: MediaInput, o: CallOptions = {}): Cancellable<Demuxed> {
    return this.#withCancel(o, async (signal) => {
      const normalized = normalizeByteInput(input, 'demux');
      throwIfAborted(signal);
      if (normalized.size === 0) {
        throw new InputError('cannot demux an empty input');
      }
      let src = await this.#resolveHlsInput(input, normalized, signal);
      try {
        src = await this.#cacheFiniteBlobRanges(src);
        const container = await this.#routeContainer(src, 'demux', signal, o.strategy?.pinDriver);
        return await container.demux(src, this.#stageOptions(signal, o));
      } catch (error) {
        await cancelSource(src, error);
        throw error;
      }
    });
  }

  packetInfo(input: MediaInput, o: PacketInfoCallOptions = {}): Cancellable<PacketInfoTable> {
    return this.#runPacketInfo(input, o, 'runPacketInfo') as Cancellable<PacketInfoTable>;
  }

  packetInfoBatches(
    input: MediaInput,
    o: PacketInfoBatchCallOptions = {},
  ): Cancellable<PacketInfoBatchStream> {
    return this.#runPacketInfo(
      input,
      o,
      'runPacketInfoBatches',
    ) as Cancellable<PacketInfoBatchStream>;
  }

  #runPacketInfo(
    input: MediaInput,
    o: PacketInfoCallOptions | PacketInfoBatchCallOptions,
    operation: 'runPacketInfo' | 'runPacketInfoBatches',
  ): Cancellable<PacketInfoTable | PacketInfoBatchStream> {
    return this.#withCancel(o, async (signal) => {
      const runners = await import('./packet-info-runner.ts');
      const run = runners[operation] as (
        context: Parameters<typeof runners.runPacketInfo>[0],
        source: MediaInput,
        options: PacketInfoCallOptions & PacketInfoBatchCallOptions,
        activeSignal: AbortSignal,
      ) => Promise<PacketInfoTable | PacketInfoBatchStream>;
      return run(
        {
          resolveHls: this.#resolveHlsInput.bind(this),
          cacheFiniteBlobRanges: this.#cacheFiniteBlobRanges.bind(this),
          routeSource: (source, activeSignal, pinDriver) =>
            this.#routeContainer(source, 'demux', activeSignal, pinDriver),
          routeToken: (container, pinDriver) =>
            this.#routeContainerToken(container, 'demux', pinDriver),
          stage: this.#stageOptions.bind(this),
        },
        input,
        o as PacketInfoCallOptions & PacketInfoBatchCallOptions,
        signal,
      );
    });
  }

  pcm(
    src: Source | Uint8Array,
    sourceContainer: string,
    opts: {
      readonly to: Container;
      readonly audio?: AudioTarget | false;
      readonly sink?: Sink;
    },
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
      return wavPcmPacketCopy(input);
    };
    const p = run() as Cancellable<Uint8Array>;
    p.cancel = (): void => {};
    return p;
  }

  convert(input: MediaInput, opts: ConvertOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      // Lazy: the key table is dead weight in the eager kernel, and every convert immediately loads far
      // heavier operation modules anyway. It still runs before a single input byte is read.
      (await import('./convert-options-shape.ts')).assertConvertOptionsShape(opts);
      if (opts.faststart === 'reserve' || opts.maximumPacketCount !== undefined) {
        const { validateReservedFaststart } = await import('./reserved-faststart.ts');
        validateReservedFaststart('convert', opts.to, opts);
      }
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
      // A quality-constrained request owns multiple finite replays. Validate its complete public tuple
      // and replay proof before HLS resolution, probing, routing, or any source byte read.
      const finiteVideoTarget = opts.video === false ? undefined : opts.video;
      if (
        finiteVideoTarget?.quality !== undefined ||
        finiteVideoTarget?.maxAverageBitrate !== undefined
      ) {
        (await import('./video-quality-constraint.ts')).assertH264QualityConstraintPreflight(
          finiteVideoTarget,
          normalized,
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

  h264AbrLadder(
    input: MediaInput,
    ladder: readonly H264AbrRung[],
    o: CallOptions = {},
  ): Cancellable<readonly Output[]> {
    return this.#withCancel(o, async (signal) => {
      const { runH264AbrLadder } = await import('./abr-ladder-runner.ts');
      return runH264AbrLadder(
        {
          workerMode: this.#workerMode,
          poolCache: this.#poolCache,
          poolSize: resolvePoolSize(this.#opts.worker),
          stage: this.#stageOptions(signal, o),
          convert: (bytes, opts, options) => this.convert(bytes, opts, options),
        },
        input,
        ladder,
        o,
        signal,
      );
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

  decode(input: MediaInput, o: DecodeOptions = {}): MediaStreams {
    this.#assertNotDisposed();
    const normalized = normalizeInput(input); // validate the input shape eagerly (throws InputError on bad input)
    const ctrl = new AbortController();
    bridgeSignal(o.signal, ctrl);
    const runner = memoizeAsync(async () => {
      const { createDecodeRunner } = await import('./decode-runner.ts');
      return createDecodeRunner(
        {
          cacheSource: (source) => cacheProbeRanges(source, this.#sourcePrefixHandoff, 'consume'),
          ensurePin: this.#ensurePinRegistered.bind(this),
          stage: this.#stageOptions.bind(this),
          resolveHls: this.#resolveHlsInput.bind(this),
          imageOps: this.#imageOpsForSource.bind(this),
          routeContainer: (source, signal, pinDriver) =>
            this.#routeContainer(source, 'demux', signal, pinDriver),
          probeCodec: this.#probeCodec.bind(this),
          routeFilter: this.#routeFilter.bind(this),
        },
        input,
        normalized,
        o,
        ctrl.signal,
      );
    });
    return {
      video: deferredStream(async () => (await runner()).video()),
      audio: deferredStream(async () => (await runner()).audio()),
    };
  }

  encode(frames: MediaStreams, opts: EncodeOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const { runEncode } = await import('./encode-runner.ts');
      return runEncode(
        {
          muxer: this.#routeMuxer.bind(this),
          encodeVideo: this.#encodeVideoStream.bind(this),
          encodeAudio: this.#encodeAudioStream.bind(this),
        },
        frames,
        opts,
        o,
        signal,
      );
    });
  }

  seek(input: MediaInput, timeUs: number, o: CallOptions = {}): Cancellable<VideoFrame> {
    return this.#withCancel(o, async (signal) => {
      const { runSeek } = await import('./seek-runner.ts');
      return runSeek(
        {
          routeContainer: (source, activeSignal, pinDriver) =>
            this.#routeContainer(source, 'demux', activeSignal, pinDriver),
          stage: this.#stageOptions.bind(this),
          probeCodec: this.#probeCodec.bind(this),
          decoderPool: this.#ensureVideoDecoderPool.bind(this),
        },
        input,
        timeUs,
        o,
        signal,
      );
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
        warmOperationChunks: async (op) => {
          if (op === 'probe') {
            await Promise.all([loadProbeRangeCache(), import('./probe-runner.ts')]);
          }
        },
        pickContainer: async (q) => {
          const driver = this.#router.pickContainer(q);
          await (driver as ContainerDriver & LazyChunkDriver).ensureLoaded?.();
        },
        pickCodec: async (q) => {
          // Warm through the verdict-carrying route (ADR-203): the cached CodecRoute the first real
          // decode/encode hits afterwards already carries the accepted acceleration rung — zero probes.
          await this.#probeCodec(q, {});
        },
        pickFilter: (filter) => {
          this.#router.pickFilter(filter, {
            determinism: this.#opts.determinism ?? 'auto',
          });
        },
        ...(this.#opts.onLog !== undefined ? { onLog: this.#opts.onLog } : {}),
      },
      specs,
    );
  }

  canConvert(opts: ConvertOptions): Promise<boolean> {
    this.#assertNotDisposed();
    return import('./convert-preflight.ts').then(({ canConvert }) =>
      canConvert(
        {
          muxer: (target) => this.#routeMuxer(target),
          probeCodec: async (query) => {
            await this.#probeCodec(query, {});
          },
        },
        opts,
      ),
    );
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
      return pickContainerWithDefaultFallback(
        this.#registry,
        this.#router,
        q,
        pinDriver,
        () => this.#ensureDefaultDrivers(),
        () => this.#invalidateProbeResults(),
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
        this.#invalidateProbeResults();
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

  async #decodeAudioTrackPackets(
    demuxer: Demuxer,
    track: TrackInfo,
    stage: StageOptions,
    o: CallOptions,
    sourceContainerId?: string,
  ): Promise<{
    readonly frames: ReadableStream<AudioData>;
    readonly leadingSamplesRemoved: number;
  }> {
    const {
      audioDecodeLeadingSamplesForRuntime,
      audioDecodeNativeGaplessSuppressionForRuntime,
      audioTrackAfterNativeGaplessSuppression,
      decodeQueryFor,
      decodedAudioStreamWithGapless,
      unwrapPackets,
    } = await loadCodecPipeline();
    const decodeQuery = await decodeQueryFor(track);
    const route = await this.#probeCodec(decodeQuery, o);
    const codec = route.driver;
    const config = decoderConfigWithRoutedAcceleration(decodeQuery.config, route.support);
    const decoded = unwrapPackets(demuxer.packets(track.id)).pipeThrough(
      codec.createDecoder(config, stage),
    ) as ReadableStream<AudioData>;
    const nativeGaplessSuppression = await audioDecodeNativeGaplessSuppressionForRuntime(
      sourceContainerId,
      track,
      codec.id,
    );
    const presentedTrack = audioTrackAfterNativeGaplessSuppression(track, nativeGaplessSuppression);
    const presented = await decodedAudioStreamWithGapless(decoded, presentedTrack, {
      packets: demuxer.packets(track.id),
      createDecoder: () => codec.createDecoder(config, stage),
      signal: stage.signal,
    });
    const leadingSamples = await audioDecodeLeadingSamplesForRuntime(
      sourceContainerId,
      track.codec,
      codec.id,
    );
    if (leadingSamples === 0) return { frames: presented, leadingSamplesRemoved: 0 };
    const { restampAudioDataRange, trimAudioGaplessFrameStream } = await import(
      './trim-streams.ts'
    );
    return {
      frames: trimAudioGaplessFrameStream(presented, { leadingSamples }, restampAudioDataRange),
      leadingSamplesRemoved: leadingSamples,
    };
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
      encodeVideo: (frames, target, source, muxer, signal, options, capabilityFallbackTarget) =>
        this.#encodeVideoStream(
          frames,
          target,
          source,
          muxer,
          signal,
          options,
          false,
          undefined,
          capabilityFallbackTarget,
        ),
      encodeAudio: this.#encodeAudioStream.bind(this),
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
      prepareVpxAlphaFramesForEncode,
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
    const encoderConfig: VideoEncoderConfig = {
      ...encodeConfig,
      alpha: 'discard',
    };
    const decodeStage: VideoDecoderStageOptions = {
      ...this.#stageOptions(signal, o),
      alpha: 'discard',
    };
    const planes = decodeVpxAlphaPacketStreams(packets, () =>
      decodeCodec.createDecoder(decodeConfig, decodeStage),
    );
    const colorFrames = await this.#applyVideoFilters(planes.color, target, sourceTrack, signal, o);
    const filteredAlphaFrames = await this.#applyVideoFilters(
      planes.alpha,
      target,
      sourceTrack,
      signal,
      o,
    );
    const alphaFrames = prepareVpxAlphaFramesForEncode(filteredAlphaFrames);
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
    const { applyVideoFrameFilters } = await import('./media-filter-runner.ts');
    return applyVideoFrameFilters(frames, target, track, signal, o, {
      routeFilter: this.#routeFilter.bind(this),
      stageOptions: this.#stageOptions.bind(this),
    });
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
    const { applyAudioFrameFilters } = await import('./media-filter-runner.ts');
    return applyAudioFrameFilters(frames, target, track, signal, o, {
      routeFilter: this.#routeFilter.bind(this),
      stageOptions: this.#stageOptions.bind(this),
    });
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
    const encoderConfig: VideoEncoderConfig = {
      ...encodeConfig,
      alpha: 'discard',
    };
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
    capabilityFallbackTarget?: VideoTarget,
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
      capabilityFallbackTarget,
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
      audioEncodeSoftwareDriverForRuntime,
      audioCodecToken,
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
    const softwareDriver = await audioEncodeSoftwareDriverForRuntime(config);
    let encodeOptions = o;
    if (softwareDriver !== undefined) {
      const softwareOptions = forceSoftware(o);
      encodeOptions =
        o.strategy?.pinDriver === undefined
          ? {
              ...softwareOptions,
              strategy: { ...softwareOptions.strategy, pinDriver: softwareDriver },
            }
          : softwareOptions;
    }
    const codec = await this.#routeCodec(encodeQueryFor(config), encodeOptions);
    // Past here is the live WebCodecs path — unreachable in Node (the route above throws first).
    /* v8 ignore start -- requires a real AudioEncoder; validated in the browser harness (BUILD §6.1). */
    let decoderConfig: AudioDecoderConfig | undefined;
    let encoderTiming: AudioEncoderOutputTiming | undefined;
    const stage: AudioEncoderStageOptions = {
      ...this.#stageOptions(signal, encodeOptions),
      onConfig: (c) => {
        decoderConfig = c;
      },
      onTiming: (timing) => {
        encoderTiming = timing;
      },
    };
    const chunks = frames.pipeThrough(codec.createEncoder(config, stage));
    let outputTrackId: number | undefined;
    await drainEncoderToMuxer(
      chunks,
      {
        addTrack: (info) => {
          const id = muxer.addTrack(info);
          outputTrackId = id;
          return id;
        },
        write: (trackId, packet) => muxer.write(trackId, packet),
      },
      () =>
        audioTrackInfoFromDecoderConfig(
          requireEncoderConfig(decoderConfig, 'audio'),
          sourceTrack?.durationSec,
        ),
      signal,
    );
    const publishedConfig = requireEncoderConfig(decoderConfig, 'audio') as AudioDecoderConfig;
    const outputCodec = audioCodecToken(publishedConfig.codec);
    if (
      outputTrackId !== undefined &&
      muxer.setTrackGapless !== undefined &&
      (outputCodec === 'aac' || outputCodec === 'opus')
    ) {
      const gapless = outputGaplessForAudioEncoder(publishedConfig, encoderTiming);
      if (gapless === undefined) {
        if (outputCodec === 'aac') {
          throw new CapabilityError(
            `sample-accurate AAC MP4 muxing requires destination encoder-delay timing that ${codec.id} did not prove on this runtime`,
            {
              op: {
                kind: 'route',
                id: 'mux',
                facts: { mediaType: 'audio', codec: publishedConfig.codec },
              },
              tried: [codec.id],
              suggestion:
                'use a runtime with a proven AAC encoder-delay fact or an encoder that publishes one',
            },
          );
        }
      } else {
        muxer.setTrackGapless(outputTrackId, gapless);
      }
    }
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

// Legacy helper re-exports (R-S05.1 transition): `deferredStream` and `assertTrimRange` live in their
// own modules now; these shims keep the remaining cross-shard test importers (`codec-ops.test.ts`,
// `trim-robustness.test.ts`) compiling until their owners migrate the imports — at which point these
// two lines are deleted and engine.ts exports exactly MediaEngine + MediaEngineImpl.
export { deferredStream } from './frame-streams.ts';
export { assertTrimRange } from './trim-range.ts';
