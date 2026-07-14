/**
 * The engine (docs/architecture/07) — the developer-facing instance behind `createMedia`. It wires the
 * kernel (Registry → Router → Normalizer → Executor → Worker-bridge) and exposes intent-only ops; the
 * substrate is never named (ADR-003).
 *
 * Phase 0 implements `probe`/`demux` end-to-end (container-routed) plus `from`/`source`/`use`/`preload`.
 * The codec/filter/crypto-dependent ops are declared and, per Prime Directive 6, raise a typed
 * {@link CapabilityError} until their Phase-1 pipelines (WebCodecs/GPU/WASM drivers) land — never a
 * silent or fake result.
 */

import type { ImageOps } from '../codecs/image/index.ts';
import type { AudioEncoderStageOptions } from '../codecs/webcodecs-audio.ts';
import type {
  VideoDecoderStageOptions,
  VideoEncoderStageOptions,
} from '../codecs/webcodecs-video.ts';
import type {
  CodecDriver,
  CodecQuery,
  ContainerDriver,
  ContainerQuery,
  Demuxer,
  Determinism,
  DriverModule,
  EncodedChunk,
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
import type { Endianness, SampleFormat } from '../dsp/pcm.ts';
import { composeChain, lazyPipeThrough } from '../kernel/executor.ts';
import { Registry, isApiVersionSupported } from '../kernel/registry.ts';
import { Router, type StageSelectOptions } from '../kernel/router.ts';
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
import type { MaterializeOptions, Sink } from '../sinks/sink.ts';
import { type LiveMediaSource, isLiveMediaSource } from '../sources/live-source.ts';
import {
  type ByteMediaInput,
  type FromOptions,
  type MediaInput,
  type NormalizedSource,
  SOURCE_CACHE_KEY,
  SOURCE_URL_KEY,
  type Source,
  cancelSource,
  from as normalizeInput,
  peekSourceHead,
} from '../sources/source.ts';
import type { ChainStep } from './chain.ts';
import { chooseOutputContainer, containerHasChunkMuxer, isPcmContainer } from './codec-routing.ts';
import type { DecryptRunnerContext } from './decrypt-runner.ts';
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
  MediaInfoTrack,
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

const CONTAINER_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  adts: 'audio/aac',
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mpegts: 'video/mp2t',
};
const SOURCE_PREFIX_HANDOFF_TTL_MS = 250;

interface SourcePrefixHandoff {
  readonly bytes: Uint8Array;
  /** Total learned by the range response that produced `bytes`, when the source exposed it. */
  readonly size?: number;
  readonly token: object;
}

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
  preload(...specs: PreloadSpec[]): Promise<void>;
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

const HEAD_BYTES = 64 * 1024;
const HINTED_HEAD_BYTES = 4 * 1024;
let probeRangeCacheModule: typeof import('../sources/probe-range-cache.ts') | undefined;
type PacketInfoCallOptions = CallOptions & { readonly container?: Container };
type CodecPipelineModule = typeof import('./codec-pipeline.ts');
type AbrFanoutRendition = {
  readonly opts: { readonly sink?: unknown; readonly [key: string]: unknown };
};

function loadCodecPipeline(): Promise<CodecPipelineModule> {
  return import('./codec-pipeline.ts');
}

function normalizeByteInput(input: MediaInput, op: string): Source {
  const normalized = normalizeInput(input);
  if (!isLiveMediaSource(normalized)) return normalized;
  throw new CapabilityError(
    'capability-miss',
    `${op} requires finite encoded/container bytes and is unavailable for a raw live MediaStream`,
    { op, tried: ['media-stream/raw-frames'] },
  );
}

export class MediaEngineImpl implements MediaEngine {
  readonly #opts: CreateMediaOptions;
  readonly #wasmRuntime: WasmRuntimeProfile;
  readonly #wasmAssetBaseUrl: string | undefined;
  readonly #registry = new Registry();
  readonly #router = new Router({ registry: this.#registry });
  readonly #preloadTasks = new Map<string, Promise<void>>();
  #defaultsLoaded = false;
  #defaultDriversPromise: Promise<void> | undefined;
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
    if (!isApiVersionSupported(module.apiVersion)) {
      throw new MediaError('driver-incompatible', `driver module apiVersion ${module.apiVersion}`, {
        got: module.apiVersion,
      });
    }
    module.register(this.#registry);
    this.#router.clearCache();
    return this;
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
    // Inline the fluent-chain proxy so the eager kernel does not statically import `chain.ts`/its runner
    // (doc 08 §7 budget split): intermediate steps just accumulate synchronously; the terminal lazily
    // imports the chain runner (which pulls the op implementations only when a chain is actually executed).
    const engine = this;
    const build = (steps: readonly ChainStep[]): MediaChain =>
      new Proxy({} as MediaChain, {
        get(_t, prop): unknown {
          if (typeof prop !== 'string') return undefined;
          return (...args: readonly unknown[]): unknown => {
            if (prop !== 'run' && prop !== 'blob' && prop !== 'file' && prop !== 'stream') {
              return build([...steps, { method: prop, args }]);
            }
            const terminal = prop;
            const abort = new AbortController();
            let active: Cancellable<Output> | undefined;
            const promise = (async (): Promise<Output> => {
              const { runMediaChain } = await import('./chain-runner.ts');
              active = runMediaChain(
                engine,
                input,
                steps,
                terminal,
                args,
                abort.signal,
              ) as Cancellable<Output>;
              return active;
            })() as Cancellable<Output>;
            promise.cancel = (): void => {
              abort.abort();
              active?.cancel();
            };
            return promise;
          };
        },
      });
    return build([]);
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
      try {
        if (resolved.range !== undefined) {
          probeRangeCacheModule ??= await import('../sources/probe-range-cache.ts');
          src = probeRangeCacheModule.cacheRepeatedProbeRangesFor(this, resolved);
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
          probeRangeCacheModule?.hasConcreteAudioVideoMime(src.mimeHint)
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
          probeRangeCacheModule ??= await import('../sources/probe-range-cache.ts');
          src = probeRangeCacheModule.cacheRepeatedProbeRangesFor(this, resolved);
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
          throw new CapabilityError('capability-miss', 'no packet-info', {
            op: 'demux',
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
        throw new CapabilityError('capability-miss', `no muxer '${target}'`, {
          op: 'encode',
          tried: [target],
        });
      }
      // Validate the input shape (which streams, matched targets) BEFORE building the muxer, so an empty
      // or mismatched `encode` rejects as bad input rather than a downstream miss; cancel any frame stream
      // we will not consume so its frames never leak.
      if (!frames.video && !frames.audio) {
        throw new InputError('unsupported-input', 'encode needs streams');
      }
      if (frames.video && !opts.video) {
        await cancelStream(frames.video);
        throw new InputError('unsupported-input', 'video target missing');
      }
      if (frames.audio && !opts.audio) {
        await cancelStream(frames.audio);
        throw new InputError('unsupported-input', 'audio target missing');
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
        throw new InputError('unsupported-input', `bad seek ${timeUs}`);
      }
      const src = normalizeByteInput(input, 'seek');
      const container = await this.#routeContainer(src, 'demux', signal, o.strategy?.pinDriver);
      const stage = this.#stageOptions(signal, o);
      const demuxer = await container.demux(src, stage);
      try {
        const track = demuxer.tracks.find((t) => t.mediaType === 'video' && t.config !== undefined);
        if (!track) {
          throw new CapabilityError('capability-miss', 'no seek video', {
            op: 'seek',
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
        const codec = await this.#routeCodec(decodeQuery, o);
        /* v8 ignore start -- live decode requires a real VideoDecoder; browser-harness validated. */
        const config = decodeQuery.config;
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
            ? (packetInfoSeekStream.pipeThrough(
                codec.createDecoder(config, stage),
              ) as ReadableStream<VideoFrame>)
            : track.alpha === true
              ? decodeVideoPacketsWithAlpha(
                  await startAtSeekKeyframePackets(demuxer.packets(track.id), timeUs),
                  () => codec.createDecoder(config, stage),
                )
              : ((
                  await startAtSeekKeyframe(unwrapPackets(demuxer.packets(track.id)), timeUs)
                ).pipeThrough(codec.createDecoder(config, stage)) as ReadableStream<VideoFrame>);
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
          await this.#router.pickCodec(q, { determinism: this.#opts.determinism ?? 'auto' });
        },
        pickFilter: (filter) => {
          this.#router.pickFilter(filter, { determinism: this.#opts.determinism ?? 'auto' });
        },
        ...(this.#opts.onLog !== undefined ? { onLog: this.#opts.onLog } : {}),
      },
      specs,
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

  /** Resolve a codec driver for a query, loading the first-party defaults on a miss then retrying once. */
  async #routeCodec(q: CodecQuery, o: CallOptions): Promise<CodecDriver> {
    const opts: StageSelectOptions = {
      determinism: this.#determinism(o),
      ...(o.strategy?.pinDriver !== undefined ? { pinDriver: o.strategy.pinDriver } : {}),
    };
    try {
      return await this.#router.pickCodec(q, opts);
    } catch (e) {
      if (!(e instanceof CapabilityError) || this.#defaultsLoaded) throw e;
      const { pickCodecWithDefaultFallback } = await import(
        '../drivers/default-codec-registration.ts'
      );
      return pickCodecWithDefaultFallback(this.#registry, this.#router, q, opts, () =>
        this.#ensureDefaultDrivers(),
      );
    }
  }

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
        'capability-miss',
        'force-software image decode has no proved software substrate',
        { op: { op: 'decode', mediaType: 'video', source: 'image' }, tried: ['image-decoder'] },
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
    const codec = await this.#routeCodec(decodeQuery, {
      strategy: stageStrategy(stage),
    });
    // The route above throws a typed miss in Node (no WebCodecs); past here is the live decode path.
    /* v8 ignore start -- requires a real VideoDecoder/AudioDecoder; browser-harness validated. */
    const config = decodeQuery.config;
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
    const codec = await this.#routeCodec(decodeQuery, o);
    const config = decodeQuery.config;
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
    const container = await this.#routeContainer(src, 'demux', signal, o.strategy?.pinDriver);
    const target = chooseOutputContainer(opts.to, container.formats[0]);

    // Preferred fast path: exact container-only requests and source-proved semantic no-ops remain behind
    // an operation-lazy planner so the default entry does not carry optional copy strategies.
    const copied = await (await import('./convert-stream-copy.ts')).tryConvertStreamCopy(
      container,
      target,
      src,
      opts,
      this.#stageOptions(signal, o),
      input,
    );
    if (copied !== undefined) {
      if ('output' in copied) return copied.output;
      return materializeOutput(opts.sink ?? toBlob(), copied.stream, mimeOpts(signal, target));
    }

    if (!containerHasChunkMuxer(target)) {
      throw new CapabilityError('capability-miss', `convert to '${target}' has no muxer`, {
        op: 'convert',
        tried: [target],
      });
    }

    // Heavy decode→filter→encode→mux: run it OFF the main thread when worker offload is selected + a
    // WebCodecs-capable worker handshook (doc 06 §4, ADR-019). The worker reconstructs THIS same graph
    // (worker-main.ts) and streams encoded bytes back; the sink is materialized here (it may hold a DOM
    // element). `undefined` means "no worker — run inline" (the honest fallback below).
    const offloaded = await this.#offloadStream(src, 'convert', opts, signal, o);
    /* v8 ignore next -- the offload branch needs a live worker bridge (browser); harness validated. */
    if (offloaded !== undefined) {
      return materializeOutput(opts.sink ?? toBlob(), offloaded, mimeOpts(signal, target));
    }

    const twoPassPlan =
      opts.video !== false && opts.video?.twoPass === true
        ? await (await import('./video-two-pass-runner.ts')).analyzeH264TwoPass(
            src,
            container,
            opts.video,
            signal,
            o,
            opts.fragmented === true,
            this.#videoRunnerContext(),
          )
        : undefined;
    const demuxer = await container.demux(src, this.#stageOptions(signal, o));
    const muxer = (await this.#routeMuxer(target, o.strategy?.pinDriver)).createMuxer(
      muxOptionsFrom(opts, target),
    );
    const tasks: Promise<void>[] = [];
    const openStreams: ReadableStream<unknown>[] = [];
    try {
      const selectedVideoTrack =
        opts.video === false
          ? undefined
          : demuxer.tracks.find((t) => t.mediaType === 'video' && t.config !== undefined);
      const audioTrack =
        opts.audio === false
          ? undefined
          : demuxer.tracks.find((t) => t.mediaType === 'audio' && t.config !== undefined);
      const copyAudioPackets =
        audioTrack !== undefined &&
        opts.audio === undefined &&
        (await import('./codec-pipeline.ts')).canCopyAudioTrackToContainer(target, audioTrack);

      if (selectedVideoTrack) {
        // Fail target encode-config errors before creating decode/filter streams. Otherwise a synchronous
        // config miss (for example the benchmark's 1x1 H.264 edge) can reject the encode task while an
        // already-built upstream stream is still tearing down, surfacing as an escaped async rejection.
        const {
          buildVideoEncoderConfigForRuntime,
          canUseVpxAlphaGeometryPacketTranscode,
          canUseVpxAlphaPacketTranscode,
          decodeQueryFor,
          decodeVideoPacketsWithAlpha,
          qualifiedVideoSourceCodec,
          sourceVideoBitrateFromPacketTable,
          unwrapPackets,
        } = await loadCodecPipeline();
        const measuredBitrate = sourceVideoBitrateFromPacketTable(
          demuxer.packetTable?.(),
          selectedVideoTrack.id,
        );
        const videoTrack: TrackInfo =
          measuredBitrate === undefined
            ? selectedVideoTrack
            : { ...selectedVideoTrack, bitrate: measuredBitrate };
        const videoTarget = opts.video || {};
        const sourceGeometry = sourceGeometryOf(videoTrack);
        const videoEncoderConfig = await buildVideoEncoderConfigForRuntime(
          videoTarget,
          sourceGeometry,
          videoTrack.codec,
        );
        const sourceVideoCodec = qualifiedVideoSourceCodec(videoTrack);
        if (
          canUseVpxAlphaGeometryPacketTranscode(
            videoTarget,
            videoTrack.alpha === true,
            sourceVideoCodec,
            videoEncoderConfig.codec,
          )
        ) {
          const packets = demuxer.packets(videoTrack.id);
          openStreams.push(packets);
          tasks.push(
            this.#transcodeVpxAlphaGeometryPacketStream(
              packets,
              videoTarget,
              videoTrack,
              muxer,
              signal,
              o,
            ),
          );
        } else if (
          canUseVpxAlphaPacketTranscode(
            videoTarget,
            videoTrack.alpha === true,
            sourceVideoCodec,
            videoEncoderConfig.codec,
          )
        ) {
          const packets = demuxer.packets(videoTrack.id);
          openStreams.push(packets);
          tasks.push(
            this.#transcodeVpxAlphaPacketStream(packets, videoTarget, videoTrack, muxer, signal, o),
          );
        } else {
          // Resolve the decode codec first (this throws a typed miss in Node where WebCodecs is absent);
          // the composition below is the live path, browser-validated.
          const decodeQuery = await decodeQueryFor(videoTrack);
          const videoCodec = await this.#routeCodec(decodeQuery, o);
          const config = decodeQuery.config;
          const decodeStage = this.#stageOptions(signal, o);
          /* v8 ignore start -- live decode→filter→encode requires WebCodecs; browser-harness validated. */
          const decoded =
            videoTrack.alpha === true
              ? decodeVideoPacketsWithAlpha(demuxer.packets(videoTrack.id), () =>
                  videoCodec.createDecoder(config, decodeStage),
                )
              : o.strategy?.pinDriver !== videoCodec.id &&
                  videoCodec.id !== 'wasm-vpx' &&
                  /^vp(?:8|9|09)/.test(config.codec)
                ? (await import('./replayable-video-decoder.ts')).decodeVideoWithRuntimeFallback(
                    unwrapPackets(demuxer.packets(videoTrack.id)),
                    () =>
                      videoCodec.createDecoder(config, decodeStage) as TransformStream<
                        EncodedChunk,
                        VideoFrame
                      >,
                    async () => {
                      const fallback = await this.#routeCodec(decodeQuery, {
                        ...o,
                        strategy: { ...o.strategy, pinDriver: 'wasm-vpx' },
                      });
                      return fallback.createDecoder(config, decodeStage) as TransformStream<
                        EncodedChunk,
                        VideoFrame
                      >;
                    },
                    { signal },
                  )
                : lazyPipeThrough<EncodedChunk, VideoFrame>(
                    unwrapPackets(demuxer.packets(videoTrack.id)),
                    () =>
                      videoCodec.createDecoder(config, decodeStage) as TransformStream<
                        EncodedChunk,
                        VideoFrame
                      >,
                    { closeValue: closeIfClosable },
                  );
          const filtered = await this.#applyVideoFilters(
            decoded as ReadableStream<VideoFrame>,
            opts.video || {},
            videoTrack,
            signal,
            o,
          );
          openStreams.push(filtered);
          tasks.push(
            this.#encodeVideoStream(
              filtered,
              opts.video || {},
              videoTrack,
              muxer,
              signal,
              o,
              opts.fragmented === true,
              twoPassPlan,
            ),
          );
          /* v8 ignore stop */
        }
      }
      if (audioTrack) {
        if (copyAudioPackets) {
          const { drainEncoderToMuxer } = await loadCodecPipeline();
          const packets = demuxer.packets(audioTrack.id);
          openStreams.push(packets);
          tasks.push(drainEncoderToMuxer(packets, muxer, audioTrack, signal));
        } else {
          const { resolveAudioEncodeTargetForRuntime } = await loadCodecPipeline();
          const audioTarget = await resolveAudioEncodeTargetForRuntime(
            opts.audio || {},
            audioTrack.codec,
          );
          const stage = this.#stageOptions(signal, o);
          let decoded: ReadableStream<AudioData>;
          if (
            (isRawPcmTrack(audioTrack) || audioTrack.codec === 'flac') &&
            container.decodePcmInterleavedStream !== undefined
          ) {
            const chunks = await container.decodePcmInterleavedStream(src, stage);
            decoded = (await import('../dsp/audio-data.ts')).interleavedPcmChunksToAudioDataStream(
              chunks,
              stage,
              audioTrack.codec,
            );
          } else if (
            (isRawPcmTrack(audioTrack) || audioTrack.codec === 'flac') &&
            container.decodePcmAudioStream !== undefined
          ) {
            const chunks = await container.decodePcmAudioStream(src, stage);
            decoded = (await import('../dsp/audio-data.ts')).pcmAudioChunksToAudioDataStream(
              chunks,
              stage,
              audioTrack.codec,
              'f32',
            );
          } else if (
            container.decodePcmAudio !== undefined &&
            (isRawPcmTrack(audioTrack) || audioTrack.codec === 'flac')
          ) {
            decoded = (await import('../dsp/audio-data.ts')).pcmAudioToAudioDataStream(
              await container.decodePcmAudio(src, stage),
              stage,
              audioTrack.codec,
              'f32',
            );
          } else {
            decoded = await this.#decodeAudioTrackPackets(demuxer, audioTrack, stage, o);
          }
          /* v8 ignore start -- live decode→[remix/resample]→encode requires AudioData/WebCodecs; browser-validated. */
          // Channel/rate change → remix/resample the decoded AudioData to the target layout BEFORE the
          // encoder, so the buffers match the encoder's configured numberOfChannels/sampleRate exactly (a
          // stereo buffer into a mono-configured AudioEncoder is rejected). No change ⇒ passes through.
          const shaped = await this.#applyAudioFilters(decoded, audioTarget, audioTrack, signal, o);
          openStreams.push(shaped);
          tasks.push(this.#encodeAudioStream(shaped, audioTarget, audioTrack, muxer, signal, o));
          /* v8 ignore stop */
        }
      }
      if (tasks.length === 0) {
        throw new CapabilityError('capability-miss', 'convert found no decodable track', {
          op: 'convert',
          tried: [container.id],
        });
      }
      /* v8 ignore start -- reached only when a live codec was resolved (browser); harness-validated. */
      await allOrCancelStreams(tasks, openStreams);
      await muxer.finalize();
      return await materializeOutput(opts.sink ?? toBlob(), muxer.output, mimeOpts(signal, target));
      /* v8 ignore stop */
    } finally {
      await demuxer.close();
    }
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
    const decodeCodec = await this.#routeCodec(decodeQuery, o);
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
      decodeCodec.createDecoder(decodeQuery.config, decodeStage),
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
    const decodeCodec = await this.#routeCodec({ ...decodeQuery, config: decodeConfig }, o);
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
      decodeConfig,
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
    throw new CapabilityError('capability-miss', `pinned driver '${pin}' is not registered`, {
      op: 'route',
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

async function materializeOutput(
  sink: Sink,
  stream: ReadableStream<Uint8Array>,
  opts: MaterializeOptions,
): Promise<Output> {
  if (sink.kind === 'stream') return stream;
  const { materialize } = await import('../sinks/materialize.ts');
  return materialize(sink, stream, opts);
}

interface ImageDecodeRoute {
  readonly ops: ImageOps;
  readonly bytes: Uint8Array;
}

type ImageDecodeRouteLoader = () => Promise<ImageDecodeRoute | undefined>;
const noImageDecodeRoute: ImageDecodeRouteLoader = () => Promise.resolve(undefined);

const MICROS_PER_SECOND = 1_000_000;

function memoizeAsync<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => {
    promise ??= load();
    return promise;
  };
}

/** Mirror an external `AbortSignal` onto an internal controller (pre-aborted or future abort). */
function bridgeSignal(caller: AbortSignal | undefined, ctrl: AbortController): void {
  if (!caller) return;
  if (caller.aborted) ctrl.abort(caller.reason);
  else caller.addEventListener('abort', () => ctrl.abort(caller.reason), { once: true });
}

function forceSoftware(o: CallOptions): CallOptions {
  return {
    ...o,
    strategy: {
      ...o.strategy,
      determinism: 'force-software',
    },
  };
}

/** Re-expose a {@link StageOptions} as a {@link CallOptions.strategy} so a sub-route inherits determinism. */
function stageStrategy(stage: StageOptions): { determinism: Determinism; pinDriver?: string } {
  return {
    determinism: stage.determinism ?? 'auto',
    ...(stage.pinDriver !== undefined ? { pinDriver: stage.pinDriver } : {}),
  };
}

function isPinnedDriverMiss(error: CapabilityError, pinDriver: string | undefined): boolean {
  if (pinDriver === undefined || !error.message.startsWith('pinned ')) return false;
  const detail = error.detail;
  if (typeof detail !== 'object' || detail === null || !('tried' in detail)) return false;
  const tried = (detail as { readonly tried?: unknown }).tried;
  return Array.isArray(tried) && tried.length === 1 && tried[0] === pinDriver;
}

/**
 * Wrap an async producer of a `ReadableStream<T>` into an eager `ReadableStream<T>` whose underlying work
 * runs on first pull. Used by `decode` to honor its synchronous-return contract while the demux + codec
 * routing it needs are async. When the producer yields `undefined` (no such track) the stream is empty.
 * EOF/cancel releases the inner reader and producer closure immediately so source buffers can collect;
 * cancellation during async production also cancels the late stream before it can emit or leak a lock.
 */
export function deferredStream<T>(
  produce: () => Promise<ReadableStream<T> | undefined>,
): ReadableStream<T> {
  let producer: (() => Promise<ReadableStream<T> | undefined>) | undefined = produce;
  let reader: ReadableStreamDefaultReader<T> | undefined;
  let started = false;
  let cancelled = false;
  let cancelReason: unknown;
  const cancelAndRelease = async (
    active: ReadableStreamDefaultReader<T>,
    reason: unknown,
  ): Promise<void> => {
    if (reader === active) reader = undefined;
    try {
      await active.cancel(reason);
    } finally {
      active.releaseLock();
    }
  };
  return new ReadableStream<T>(
    {
      async pull(controller): Promise<void> {
        if (!started) {
          started = true;
          const start = producer;
          producer = undefined;
          const inner = await start?.();
          if (cancelled) {
            if (inner !== undefined) {
              await (await import('./deferred-stream-cleanup.ts')).default(
                inner,
                cancelReason,
                closeIfClosable,
              );
            }
            return;
          }
          if (inner === undefined) {
            controller.close();
            return;
          }
          reader = inner.getReader();
        }
        if (!reader) return;
        const active = reader;
        try {
          const { done, value } = await active.read();
          if (cancelled) {
            if (!done) closeIfClosable(value);
            return;
          }
          if (done) {
            if (reader === active) reader = undefined;
            active.releaseLock();
            controller.close();
            return;
          }
          try {
            controller.enqueue(value);
          } catch (error) {
            closeIfClosable(value);
            throw error;
          }
        } catch (error) {
          if (reader === active) await cancelAndRelease(active, error).catch(() => {});
          throw error;
        }
      },
      async cancel(reason): Promise<void> {
        cancelled = true;
        cancelReason = reason;
        producer = undefined;
        const active = reader;
        if (active !== undefined) await cancelAndRelease(active, reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

interface ClosableHandle {
  close(): void;
}

function closeIfClosable(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('close' in value)) return;
  const close = (value as { readonly close?: unknown }).close;
  if (typeof close === 'function') (close as ClosableHandle['close']).call(value);
}

/** True for raw PCM codec tokens (`pcm`, `pcm-s16`, `pcm-s16be`, `pcm-f32`, …). */
function isRawPcmTrack(track: TrackInfo): boolean {
  return track.codec === 'pcm' || track.codec.startsWith('pcm-');
}

/** Cancel a frame stream so its producer (a decoder/demuxer) releases any buffered frames. */
async function cancelStream(stream: ReadableStream<unknown>): Promise<void> {
  await stream.cancel(new MediaError('aborted', 'stream not consumed')).catch(() => {});
}

/**
 * Await all encode tasks; if any rejects, cancel the *other* input frame streams so no in-flight frame
 * leaks, then surface the first error. Used by `encode` (caller-supplied `MediaStreams`).
 */
async function allOrCancel(tasks: readonly Promise<void>[], frames: MediaStreams): Promise<void> {
  try {
    await Promise.all(tasks);
  } catch (e) {
    await Promise.all([
      frames.video ? cancelStream(frames.video) : Promise.resolve(),
      frames.audio ? cancelStream(frames.audio) : Promise.resolve(),
    ]);
    throw e;
  }
}

/** Like {@link allOrCancel} but for the internally-composed convert streams (decode/filter outputs). */
async function allOrCancelStreams(
  tasks: readonly Promise<void>[],
  streams: readonly ReadableStream<unknown>[],
): Promise<void> {
  try {
    await Promise.all(tasks);
  } catch (e) {
    await Promise.all(streams.map((s) => cancelStream(s)));
    throw e;
  }
}

/**
 * Project the optional public mux flags (`faststart`/`fragmented`) — present on `ConvertOptions`/
 * `MuxSpec`, absent on `EncodeOptions` — onto {@link MuxOptions}, copying only the ones actually set
 * (exactOptionalPropertyTypes). The parameter accepts each concrete option object so every caller fits
 * (a bare `{faststart?,fragmented?}` would be a weak type and reject `EncodeOptions`, which has neither).
 */
function muxOptionsFrom(
  opts: ConvertOptions | MuxSpec | EncodeOptions | RemuxOptions,
  container?: string,
): {
  faststart?: boolean;
  fragmented?: boolean;
  container?: string;
} {
  const faststart = 'faststart' in opts ? opts.faststart : undefined;
  const fragmented = 'fragmented' in opts ? opts.fragmented : undefined;
  return {
    ...(faststart !== undefined ? { faststart } : {}),
    ...(fragmented !== undefined ? { fragmented } : {}),
    ...(container !== undefined ? { container } : {}),
  };
}

function openRenditionOptions(opts: ConvertOptions): AbrFanoutRendition['opts'] {
  const { sink, ...rest } = opts;
  return sink === undefined ? { ...rest } : { ...rest, sink };
}

/** Source geometry (coded dims) for a video track, read from its WebCodecs decoder config. */
function sourceGeometryOf(track: TrackInfo): {
  width: number | undefined;
  height: number | undefined;
  fps?: number;
  durationSec?: number;
  bitrate?: number;
} {
  const config = track.config;
  const fps = track.fps;
  const durationSec =
    track.durationSec !== undefined && Number.isFinite(track.durationSec) && track.durationSec > 0
      ? track.durationSec
      : undefined;
  if (config && 'codedWidth' in config) {
    return {
      width: config.codedWidth,
      height: config.codedHeight,
      ...(fps !== undefined ? { fps } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(track.bitrate !== undefined ? { bitrate: track.bitrate } : {}),
    };
  }
  return {
    width: undefined,
    height: undefined,
    ...(fps !== undefined ? { fps } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(track.bitrate !== undefined ? { bitrate: track.bitrate } : {}),
  };
}

/**
 * Source audio params (sample rate / channels) for an audio track, read from its decoder config. A
 * populated source track only reaches here on the live `convert` audio re-encode (browser); the
 * `undefined`-track path is exercised by the `encode` audio route (Node).
 */
function audioGeometryOf(track: TrackInfo | undefined): {
  sampleRate: number | undefined;
  channels: number | undefined;
} {
  const config = track?.config;
  /* v8 ignore next 3 -- populated only via live convert (browser); Node encode passes no source track. */
  if (config && 'sampleRate' in config) {
    return { sampleRate: config.sampleRate, channels: config.numberOfChannels };
  }
  return { sampleRate: undefined, channels: undefined };
}

/**
 * Object spread snapshots an optional Source property. URL-backed `size` and redirect provenance are
 * learned later, so install forwarding accessors without widening the public optional-property types.
 */
function preserveLiveSourceFacts(
  wrapped: Source,
  src: Source,
  handedOffSize: () => number | undefined,
): Source {
  Object.defineProperties(wrapped, {
    size: {
      configurable: true,
      enumerable: true,
      get: () => src.size ?? handedOffSize(),
    },
    [SOURCE_URL_KEY]: {
      configurable: true,
      enumerable: true,
      get: () => src[SOURCE_URL_KEY],
    },
  });
  return wrapped;
}

function cacheProbeRanges(
  src: Source,
  handoff?: Map<string, SourcePrefixHandoff>,
  mode: 'local' | 'store' | 'consume' = 'local',
  options: { readonly maxBytes?: number; readonly ttlMs?: number } = {},
): Source {
  const range = src.range;
  if (range === undefined) return src;
  const cacheKey = src[SOURCE_CACHE_KEY];
  const consumed =
    mode === 'consume' && cacheKey !== undefined && handoff !== undefined
      ? handoff.get(cacheKey)
      : undefined;
  let cached = consumed?.bytes;
  let cachedSize = consumed?.size;
  if (mode === 'consume' && cacheKey !== undefined) {
    handoff?.delete(cacheKey);
  }
  const wrapped: Source = {
    ...src,
    // `fromURL()` learns size and its final redirect URL during a range response. Object spread would
    // snapshot/omit those late facts, so every Source wrapper must keep them live. A fresh Source that
    // consumes a probe prefix also needs the total learned by the probe: otherwise parsing wholly from
    // the cached prefix leaves the new URL unread and MP4 cannot validate its terminal boxes/mdat.
    range: async (start, end) => {
      const sourceSize = src.size ?? cachedSize;
      const cachedCoversEnd =
        cached !== undefined &&
        (end <= cached.byteLength ||
          (sourceSize !== undefined && cached.byteLength >= sourceSize && end >= sourceSize));
      if (cached !== undefined && start >= 0 && cachedCoversEnd) {
        return cached.subarray(start, end);
      }
      const bytes = await range.call(src, start, end);
      cachedSize =
        src.size ??
        cachedSize ??
        (start === 0 && bytes.byteLength < Math.max(0, Math.trunc(end))
          ? bytes.byteLength
          : undefined);
      const cacheable = options.maxBytes === undefined || bytes.byteLength <= options.maxBytes;
      if (
        start === 0 &&
        cacheable &&
        (cached === undefined || bytes.byteLength > cached.byteLength)
      ) {
        cached = bytes;
        if (mode === 'store' && cacheKey !== undefined && handoff !== undefined) {
          storeSourcePrefixHandoff(handoff, cacheKey, bytes, cachedSize, options.ttlMs);
        }
      }
      return bytes;
    },
  };
  return preserveLiveSourceFacts(wrapped, src, () => cachedSize);
}

function storeSourcePrefixHandoff(
  handoff: Map<string, SourcePrefixHandoff>,
  cacheKey: string,
  bytes: Uint8Array,
  size: number | undefined,
  ttlMs: number = SOURCE_PREFIX_HANDOFF_TTL_MS,
): void {
  const token = {};
  handoff.set(cacheKey, { bytes, ...(size !== undefined ? { size } : {}), token });
  setTimeout(() => {
    if (handoff.get(cacheKey)?.token === token) {
      handoff.delete(cacheKey);
    }
  }, ttlMs);
}

function routeHeadBytes(src: Source): number {
  return src.mimeHint !== undefined || src.filename !== undefined ? HINTED_HEAD_BYTES : HEAD_BYTES;
}

async function readHead(
  src: Source,
  n: number = HEAD_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return peekSourceHead(src, n, signal);
}

async function readAllSource(src: Source, signal: AbortSignal | undefined): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (src.range && src.size !== undefined) {
    const bytes = await src.range(0, src.size);
    throwIfAborted(signal);
    return bytes;
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await readSourceChunk(reader, signal);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (e) {
    await reader.cancel(e).catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  throwIfAborted(signal);
  return out;
}

async function readSourceChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  throwIfAborted(signal);
  if (signal === undefined) return reader.read();
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new MediaError('aborted', 'aborted'));
  });
  const onAbort = (): void => rejectAbort?.();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new MediaError('aborted', 'aborted');
  }
}

/**
 * PCM-family audio target — the codecs the WAV/`transformPcm` path produces (ADR-022). Accepts the
 * generic public `pcm` token AND the canonical sample-format variants a caller may pass
 * (`pcm-s16`/`pcm-s24`/`pcm-f32`/`pcm-s16be`/…), so a `convert(..., {to:'wav', audio:{codec:'pcm-s16'}})`
 * still routes through the audio-dsp PCM path instead of falling through to the (wav-less) codec seam.
 * `undefined` (no explicit audio codec) also means "keep PCM" for a wav target.
 */
function isPcmCodec(codec: string | undefined): boolean {
  return codec === undefined || codec === 'pcm' || codec.startsWith('pcm-');
}

/**
 * Audio codec tokens that select the lossless FLAC authoring path (ADR-024) for a `to:'flac'` convert:
 * no codec / the bare `flac` token (author FLAC at the source's native depth), or a `pcm-*` token (author
 * at that requested integer depth). A lossy token (e.g. `aac`/`opus`) is NOT FLAC and is left to the codec
 * seam (an honest miss in this build), so this gate never hijacks a real cross-codec request.
 */
function isFlacAuthorCodec(codec: string | undefined): boolean {
  return codec === undefined || codec === 'flac' || codec === 'pcm' || codec.startsWith('pcm-');
}

function pcmSampleFormat(codec: string | undefined): SampleFormat | undefined {
  if (codec === undefined || codec === 'pcm') return undefined;
  const normalized = codec.endsWith('be') ? codec.slice(0, -2) : codec;
  switch (normalized) {
    case 'pcm-u8':
      return 'u8';
    case 'pcm-s8':
      return 's8';
    case 'pcm-s16':
      return 's16';
    case 'pcm-s24':
      return 's24';
    case 'pcm-s32':
      return 's32';
    case 'pcm-f32':
      return 'f32';
    case 'pcm-f64':
      return 'f64';
    default:
      return undefined;
  }
}

function pcmEndian(codec: string | undefined): Endianness | undefined {
  if (codec === undefined || codec === 'pcm') return undefined;
  return codec.endsWith('be') ? 'be' : 'le';
}

/**
 * Slack (seconds) allowed past the probed duration on a trim's `end`, so a legitimate "to EOF" request
 * that rounds up to a whole second past a sub-second-short probed duration still validates. It is far
 * below any genuinely-out-of-range request (e.g. seconds-to-hours past EOF) yet above probe rounding
 * and integer-second clamp slack — the same ~1-GOP order the keyframe-trim oracle tolerates.
 */
const TRIM_END_SLACK_SEC = 1;

/**
 * Reject a malformed trim range with a typed {@link InputError} before any cut is attempted. Valid
 * ranges satisfy `0 ≤ start < end` and, when the media's duration is known (`durationSec > 0`),
 * `start < durationSec` and `end ≤ durationSec + {@link TRIM_END_SLACK_SEC}`. Wording is deliberately
 * plain (no "capability"/"codec"/"browser" vocabulary) so callers and adapters read it as bad input,
 * not a capability gap. Exported for direct unit coverage of every guard branch (incl. the
 * unknown-duration path that real, always-timed corpus media cannot reach through the public op).
 */
export function assertTrimRange(startSec: number, endSec: number, durationSec: number): void {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new InputError('unsupported-input', 'bad trim');
  }
  if (startSec < 0) {
    throw new InputError('unsupported-input', 'start<0');
  }
  if (endSec <= startSec) {
    throw new InputError('unsupported-input', 'empty trim');
  }
  // Duration-relative bounds only when a real duration was probed; a 0/unknown duration cannot bound
  // the range without spuriously failing an otherwise well-formed request.
  if (durationSec > 0) {
    if (startSec >= durationSec) {
      throw new InputError('unsupported-input', 'start>=duration');
    }
    if (endSec > durationSec + TRIM_END_SLACK_SEC) {
      throw new InputError('unsupported-input', 'end>duration');
    }
  }
}

function extensionOf(filename: string | undefined): string | undefined {
  if (filename === undefined) return undefined;
  const dot = filename.lastIndexOf('.');
  return dot >= 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : undefined;
}

/**
 * Whether a source's declared MIME/extension is HLS-plausible enough to warrant a content sniff.
 * A manifest arrives either self-described (`.m3u8`, `application/vnd.apple.mpegurl`) or — as the
 * harness labels them — mislabeled as an MPEG-TS stream (`video/mp2t`). Every definite non-HLS
 * container (mp4/wav/flac/webm/…) returns `false` so the HLS path costs it no extra head read.
 */
function sourceMayBeHlsManifest(src: Source): boolean {
  const ext = extensionOf(src.filename);
  if (ext === 'm3u8' || ext === 'm3u') return true;
  const mime = src.mimeHint?.toLowerCase().split(';', 1)[0]?.trim();
  if (mime !== undefined && /(?:mpegurl|m3u8)|^(?:video|audio)\/mp2t$/.test(mime)) return true;
  // Known media extensions and concrete audio/video/image MIME families cannot be a text playlist, so
  // they skip the extra read. Generic or text MIME, unknown extensions, and no hints remain ambiguous:
  // confirm their actual `#EXTM3U` bytes, preserving replay for every non-match.
  if (
    (ext !== undefined && CONTAINER_MIME[ext] !== undefined) ||
    /^(?:audio|video|image)\//.test(mime ?? '')
  ) {
    return false;
  }
  return true;
}

/** Materialize options carrying the container's MIME type when known. */
function mimeOpts(signal: AbortSignal, container: string): { signal: AbortSignal; mime?: string } {
  const mime = CONTAINER_MIME[container];
  return mime ? { signal, mime } : { signal };
}

function toMediaInfo(
  container: ContainerDriver,
  tracks: readonly TrackInfo[],
  src: Source,
): MediaInfo {
  const infoTracks = tracks.map(toInfoTrack);
  const durationSec = infoTracks.reduce((max, t) => Math.max(max, t.durationSec ?? 0), 0);
  return {
    container: container.formats[0] ?? 'unknown',
    durationSec,
    ...(src.size !== undefined ? { sizeBytes: src.size } : {}),
    tracks: infoTracks,
  };
}

function toInfoTrack(t: TrackInfo): MediaInfoTrack {
  const base: MediaInfoTrack = {
    id: t.id,
    type: t.nonMedia ? 'other' : t.mediaType,
    codec: t.codec,
  };
  if (t.durationSec !== undefined) base.durationSec = t.durationSec;
  if (t.fps !== undefined) base.fps = t.fps;
  if (t.rotation !== undefined) base.rotation = t.rotation;
  const config = t.config;
  if (config && 'codedWidth' in config) {
    if (config.codedWidth !== undefined) base.width = config.codedWidth;
    if (config.codedHeight !== undefined) base.height = config.codedHeight;
  }
  if (config && 'sampleRate' in config) {
    base.sampleRate = config.sampleRate;
    base.channels = config.numberOfChannels;
  }
  return base;
}
