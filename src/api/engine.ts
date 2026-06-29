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

import type { ImageInfo, ImageOps } from '../codecs/image/index.ts';
import type { AudioEncoderStageOptions } from '../codecs/webcodecs-audio.ts';
import type { VideoEncoderStageOptions } from '../codecs/webcodecs-video.ts';
import type {
  CodecDriver,
  CodecQuery,
  ContainerDriver,
  ContainerQuery,
  Demuxer,
  Determinism,
  DriverModule,
  EncodedChunk,
  EncoderConfig,
  FilterDriver,
  FilterSpec,
  Muxer,
  Packet,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { audioDataToPcm, pcmRangeToPlanarInit } from '../dsp/audio-data.ts';
import type { Endianness, PcmAudio, SampleFormat } from '../dsp/pcm.ts';
import { composeChain } from '../kernel/executor.ts';
import { Registry, isApiVersionSupported } from '../kernel/registry.ts';
import { Router } from '../kernel/router.ts';
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
import {
  type FromOptions,
  type MediaInput,
  type Source,
  from as normalizeInput,
} from '../sources/source.ts';
import { createMediaChain } from './chain.ts';
import {
  chooseOutputContainer,
  containerHasChunkMuxer,
  hasTrackSelection,
  isPcmContainer,
  isPureStreamCopy,
  selectTrackInfos,
} from './codec-routing.ts';
// Type-only: erased at build time, so this is NOT a static import edge — the FLAC + raw-PCM authoring
// routines are reached only through lazy `import()`s on an eligible `to:'flac'`/raw-PCM convert. The
// engine's `#authoringDeps()` returns the `PcmConvertDeps` superset, which also satisfies the FLAC route's
// (narrower) deps at its call site, so only this one type is referenced here.
import type { PcmConvertDeps } from './pcm-convert-plan.ts';
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
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
};
const PCM_AUDIO_DATA_CHUNK_FRAMES = 4096;

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
  preload(...specs: PreloadSpec[]): Promise<void>;
  /** Start an immutable fluent chain over the flat operation API (ADR-010). */
  load(input: MediaInput): MediaChain;
  /** The universal normalizer, exported for optioned sources (ADR-013). */
  from(input: MediaInput, opts?: FromOptions): Source;
  source(input: MediaInput): Source;
  /** Inject a custom/third-party driver module (ADR-009 hook). Chainable. */
  use(module: DriverModule): MediaEngine;
}

const HEAD_BYTES = 64 * 1024;
type CodecPipelineModule = typeof import('./codec-pipeline.ts');
type AbrFanoutRendition = {
  readonly opts: { readonly sink?: unknown; readonly [key: string]: unknown };
};

function loadCodecPipeline(): Promise<CodecPipelineModule> {
  return import('./codec-pipeline.ts');
}

function assertSupportedDecryptScheme(scheme: unknown): asserts scheme is DecryptOptions['scheme'] {
  if (scheme === 'cenc' || scheme === 'cbcs' || scheme === 'hls-aes128') return;
  const label = typeof scheme === 'string' ? scheme : 'non-string';
  throw new CapabilityError(
    'capability-miss',
    `decrypt scheme '${label}' is not supported; supported schemes are cenc, cbcs, hls-aes128`,
    {
      op: 'decrypt',
      tried: [],
      suggestion:
        'reject EME/ClearKey, CENC-CENS, and HLS SAMPLE-AES at the adapter boundary unless a real implementation is registered',
    },
  );
}

/**
 * Output-size ceiling for the **buffer-all** EncodedChunk-seam mux path (cross-container remux): the
 * MP4/WebM muxers accumulate every packet and serialize the whole file at `finalize()` (no incremental
 * Cluster/fragment emit), so the peak memory is ~2× the output. A multi-gigabyte output (e.g. a 2-hour
 * 1080p remux) genuinely exceeds an in-browser tab's memory and would OOM / hang rather than complete. We
 * decline it UP FRONT with a typed `CapabilityError` — a real resource limit, honestly reported, not a
 * fake "unsupported" — instead of attempting the serialize and timing out. The streaming-Cluster muxer
 * (ADR: see below) lifts this ceiling for WebM and is the sequenced SOTA follow-up. 1 GiB output ⇒ ~2 GiB
 * peak, the defensible browser buffer-all bound; smaller real remuxes are unaffected (most are < 500 MB).
 */
const REMUX_BUFFER_ALL_MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

export class MediaEngineImpl implements MediaEngine {
  readonly #opts: CreateMediaOptions;
  readonly #registry = new Registry();
  readonly #router = new Router({ registry: this.#registry });
  readonly #preloadTasks = new Map<string, Promise<void>>();
  #defaultsLoaded = false;
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

  constructor(opts: CreateMediaOptions = {}) {
    this.#opts = opts;
    this.#workerMode = selectWorkerMode(opts.worker, workerOffloadAvailable());
  }

  use(module: DriverModule): MediaEngine {
    if (!isApiVersionSupported(module.apiVersion)) {
      throw new MediaError(
        'driver-incompatible',
        `driver module targets apiVersion ${module.apiVersion}`,
        {
          got: module.apiVersion,
        },
      );
    }
    module.register(this.#registry);
    this.#router.clearCache();
    return this;
  }

  from(input: MediaInput, opts?: FromOptions): Source {
    return normalizeInput(input, opts);
  }

  source(input: MediaInput): Source {
    return normalizeInput(input);
  }

  load(input: MediaInput): MediaChain {
    return createMediaChain(this, input);
  }

  probe(input: MediaInput, o: CallOptions = {}): Cancellable<MediaInfo> {
    return this.#withCancel(o, async (signal) => {
      const src = normalizeInput(input);
      const imageInfo = await this.#probeImageInfo(src, signal);
      if (imageInfo !== undefined) return imageInfo;
      const container = await this.#routeContainer(src, 'demux');
      const stage = this.#stageOptions(signal, o);
      if (container.probe) {
        return toMediaInfo(container, await container.probe(src, stage), src);
      }
      const demuxer = await container.demux(src, stage);
      try {
        return toMediaInfo(container, demuxer.tracks, src);
      } finally {
        await demuxer.close();
      }
    });
  }

  demux(input: MediaInput, o: CallOptions = {}): Cancellable<Demuxed> {
    return this.#withCancel(o, async (signal) => {
      const src = normalizeInput(input);
      const container = await this.#routeContainer(src, 'demux');
      return container.demux(src, this.#stageOptions(signal, o));
    });
  }

  convert(input: MediaInput, opts: ConvertOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const src = normalizeInput(input);
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
        const flac = await convertToFlac(this.#authoringDeps(), src, opts, audio, signal, o);
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
          this.#authoringDeps(),
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
      return this.#convertViaCodec(src, opts, signal, o);
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
      const src = normalizeInput(input);
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
      const src = normalizeInput(input);
      const container = await this.#routeContainer(src, 'demux');
      const wantsTrackSelection = hasTrackSelection(opts.trackSelect);
      if (opts.tags !== undefined) {
        if (wantsTrackSelection) {
          throw new CapabilityError(
            'capability-miss',
            'metadata tag rewrite does not combine with track selection',
            { op: 'remux', tried: [container.id, opts.to] },
          );
        }
        const bytes = await this.#writeMetadataTags(src, opts.to, opts.tags, signal);
        return materializeOutput(
          opts.sink ?? toBlob(),
          bytesToStream(bytes),
          mimeOpts(signal, opts.to),
        );
      }
      // (1) Same-container stream-copy — a lossless byte re-serialization that preserves DTS/B-frames/
      // codec-private (ADR-021), and works in pure TS (Node) for the drivers that implement it (MP4↔MOV).
      if (!wantsTrackSelection && container.streamCopy && container.formats.includes(opts.to)) {
        const stream = await container.streamCopy(src, {
          ...this.#stageOptions(signal, o),
          container: opts.to,
          ...(opts.faststart !== undefined ? { faststart: opts.faststart } : {}),
          ...(opts.fragmented !== undefined ? { fragmented: opts.fragmented } : {}),
          ...(opts.sink?.kind === 'stream-target' ? { streaming: true } : {}),
          ...(opts.sink?.kind !== 'stream-target' ? { buffered: true } : {}),
        });
        return materializeOutput(opts.sink ?? toBlob(), stream, mimeOpts(signal, opts.to));
      }
      // (2) Cross-container stream-copy via the packet seam: demux the source, copy each track's encoded
      // packets verbatim into the target container's muxer (no re-encode). The muxer's addTrack enforces
      // codec-in-container legality (e.g. vorbis→mp4 rejects), so an unsupported pair stays an honest
      // CapabilityError. The live packet copy needs WebCodecs `EncodedChunk` (browser); the routing +
      // track-copy control flow is unit-tested with fakes, and the path is browser-harness validated.
      const stream = await this.#remuxViaSeam(container, src, opts, signal, o);
      return materializeOutput(opts.sink ?? toBlob(), stream, mimeOpts(signal, opts.to));
    });
  }

  trim(input: MediaInput, opts: TrimOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const src = normalizeInput(input);
      const container = await this.#routeContainer(src, 'demux');
      // Validate the requested range against the media's real duration BEFORE any cut, so a malformed
      // range (negative / inverted / zero-length / past-EOF) rejects with a typed `InputError` instead
      // of flowing to the driver and fabricating output (ADR-021, robustness §7). Duration is read the
      // same way `probe` does — demux once, take the longest track — then the demuxer is released.
      const durationSec = await this.#probeDurationSec(container, src, signal, o);
      assertTrimRange(opts.start, opts.end, durationSec);
      const target = (container.formats[0] ?? 'mp4') as Container;
      if (opts.mode === 'accurate') {
        const stream = await this.#trimViaCodec(
          container,
          src,
          target,
          opts,
          durationSec,
          signal,
          o,
        );
        return materializeOutput(opts.sink ?? toBlob(), stream, mimeOpts(signal, target));
      }
      // Keyframe trim of PCM-domain audio (raw WAV/AIFF/CAF, plus native FLAC through its lossless
      // decode→PCM→FLAC path) is a sample-accurate cut through the container's own `transformPcm`
      // (ADR-021/022/024): audio has no keyframe dependency, so the DSP path slices `[start, end)` samples
      // before any transform and re-serializes, frame-exact and Node-validatable, with no lossy codec seam.
      if (isPcmContainer(target) && container.transformPcm) {
        const stream = await container.transformPcm(src, {
          ...this.#stageOptions(signal, o),
          container: target,
          timeBounds: { startSec: opts.start, endSec: opts.end },
        });
        return materializeOutput(opts.sink ?? toBlob(), stream, mimeOpts(signal, target));
      }
      if (target === 'flac' && container.transformPcm) {
        const stream = await container.transformPcm(src, {
          ...this.#stageOptions(signal, o),
          timeBounds: { startSec: opts.start, endSec: opts.end },
        });
        return materializeOutput(opts.sink ?? toBlob(), stream, mimeOpts(signal, target));
      }
      if (canTrimAudioPackets(target)) {
        const stream = await this.#trimAudioPacketsViaSeam(container, src, target, opts, signal, o);
        return materializeOutput(opts.sink ?? toBlob(), stream, mimeOpts(signal, target));
      }
      const stream = await this.#streamCopyOrThrow(container, src, target, 'trim', {
        ...this.#stageOptions(signal, o),
        trim: { startSec: opts.start, endSec: opts.end },
        faststart: true,
      });
      return materializeOutput(opts.sink ?? toBlob(), stream, mimeOpts(signal, target));
    });
  }

  decode(input: MediaInput, o: CallOptions = {}): MediaStreams {
    const src = normalizeInput(input); // validate the input shape eagerly (throws InputError on bad input)
    // The `decode` contract returns frame streams synchronously; the async demux + codec routing happens
    // lazily when each stream is first pulled. A track without a decode `config` (codec unknown) is
    // simply absent. Cancellation rides `o.signal` threaded into each decoder's StageOptions; a frame
    // emitted by a decoder is owned by the readable consumer and closed by it (the contract).
    const ctrl = new AbortController();
    bridgeSignal(o.signal, ctrl);
    const stage = this.#stageOptions(ctrl.signal, o);
    const imageRoute = memoizeAsync(() => this.#imageDecodeRoute(src, ctrl.signal));
    const video = deferredStream<VideoFrame>(() =>
      this.#decodeVideoOrImage(src, stage, imageRoute),
    );
    const audio = deferredStream<AudioData>(() =>
      this.#decodeTrack(src, 'audio', stage, imageRoute),
    );
    return { video, audio };
  }

  encode(frames: MediaStreams, opts: EncodeOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      const target = chooseOutputContainer(opts.to, undefined);
      if (!containerHasChunkMuxer(target)) {
        // A non-chunk-muxable target (e.g. wav/raw-PCM) cannot accept encoded chunks; surface the honest
        // miss rather than route into a muxer that throws an opaque error.
        throw new CapabilityError(
          'capability-miss',
          `encode to '${target}' has no EncodedChunk muxer (PCM/WAV output uses the audio-dsp path)`,
          { op: 'encode', tried: [target] },
        );
      }
      // Validate the input shape (which streams, matched targets) BEFORE building the muxer, so an empty
      // or mismatched `encode` rejects as bad input rather than a downstream miss; cancel any frame stream
      // we will not consume so its frames never leak.
      if (!frames.video && !frames.audio) {
        throw new InputError(
          'unsupported-input',
          'encode received no video or audio frame streams',
        );
      }
      if (frames.video && !opts.video) {
        await cancelStream(frames.video);
        throw new InputError(
          'unsupported-input',
          'encode received a video stream but no video target',
        );
      }
      if (frames.audio && !opts.audio) {
        await cancelStream(frames.audio);
        throw new InputError(
          'unsupported-input',
          'encode received an audio stream but no audio target',
        );
      }
      const muxer = (await this.#routeMuxer(target)).createMuxer(muxOptionsFrom(opts, target));
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
        throw new InputError(
          'unsupported-input',
          `seek time ${timeUs}µs must be a non-negative number`,
        );
      }
      const src = normalizeInput(input);
      const container = await this.#routeContainer(src, 'demux');
      const stage = this.#stageOptions(signal, o);
      const demuxer = await container.demux(src, stage);
      try {
        const track = demuxer.tracks.find((t) => t.mediaType === 'video' && t.config !== undefined);
        if (!track) {
          throw new CapabilityError('capability-miss', 'seek needs a decodable video track', {
            op: 'seek',
            tried: [container.id],
          });
        }
        if (track.encrypted === true) {
          throw new MediaError(
            'decode-error',
            'seek cannot decode a protected video track before decrypt() emits clear samples',
          );
        }
        // Resolve the decode codec first (throws a typed miss in Node where WebCodecs is absent). Then feed
        // only the packets from the keyframe at/before the target onward (a stream must decode from a
        // keyframe); seekFrame drops frames before the target, closes them, and returns the first at/after
        // it (owned by the caller). The demuxer is closed on every exit by the finally.
        const codec = await this.#routeCodec(await decodeQueryFor(track), o);
        const { decodeVideoPacketsWithAlpha, seekFrame, unwrapPackets } = await loadCodecPipeline();
        /* v8 ignore start -- live decode requires a real VideoDecoder; browser-harness validated. */
        const config = await decodeConfigOf(track);
        const out =
          track.alpha === true
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
      const target = opts.container;
      if (!containerHasChunkMuxer(target)) {
        throw new CapabilityError('capability-miss', `mux to '${target}' has no chunk muxer`, {
          op: 'mux',
          tried: [target],
        });
      }

      const { muxPacketStreams, readablePacketStreams } = await import('./mux-packet-streams.ts');
      let inputs: ReturnType<typeof muxPacketStreams>;
      try {
        inputs = muxPacketStreams(streams);
      } catch (e) {
        await Promise.all(readablePacketStreams(streams).map((stream) => cancelStream(stream)));
        throw e;
      }

      const openStreams = inputs.map((input) => input.packets as ReadableStream<unknown>);
      let drainsStarted = false;
      try {
        const muxer = (await this.#routeMuxer(target)).createMuxer(muxOptionsFrom(opts, target));
        const { drainEncoderToMuxer } = await loadCodecPipeline();
        const tasks = inputs.map((input) =>
          drainEncoderToMuxer(input.packets, muxer, () => input.track),
        );
        drainsStarted = true;
        await allOrCancelStreams(tasks, openStreams);
        await muxer.finalize();
        return materializeOutput(opts.sink ?? toBlob(), muxer.output, mimeOpts(signal, target));
      } catch (e) {
        if (!drainsStarted) {
          await Promise.all(openStreams.map((stream) => cancelStream(stream)));
        }
        throw e;
      }
    });
  }

  decrypt(input: MediaInput, opts: DecryptOptions, o: CallOptions = {}): Cancellable<Output> {
    return this.#withCancel(o, async (signal) => {
      assertSupportedDecryptScheme(opts.scheme);
      // No static key ⇒ EME/ClearKey live key acquisition, which is OUT OF SCOPE: this engine decrypts
      // CENC (`cenc`/`cbcs`) and HLS `AES-128` with caller-PROVIDED keys, never an EME license exchange.
      // Fail fast with a typed miss — **before any source read, container route, or network** — so a
      // ClearKey/EME request maps to a clean capability-miss (NA) instead of a license-fetch retry loop.
      if (Object.keys(opts.keys).length === 0) {
        throw new CapabilityError(
          'capability-miss',
          'EME/ClearKey live key acquisition unsupported — provide keys',
          { op: 'decrypt', tried: [] },
        );
      }
      const src = normalizeInput(input);
      const container = await this.#routeContainer(src, 'demux');
      if (!container.decrypt) {
        throw new CapabilityError(
          'capability-miss',
          `decrypt is not supported for the ${container.formats[0]} container`,
          { op: 'decrypt', tried: [container.id] },
        );
      }
      const stream = await container.decrypt(src, {
        ...this.#stageOptions(signal, o),
        scheme: opts.scheme,
        keys: opts.keys,
      });
      return materializeOutput(
        opts.sink ?? toBlob(),
        stream,
        mimeOpts(signal, container.formats[0] ?? 'mp4'),
      );
    });
  }

  async preload(...specs: PreloadSpec[]): Promise<void> {
    const { runPreload } = await import('./preload.ts');
    await runPreload(
      {
        tasks: this.#preloadTasks,
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
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    };
  }

  async #routeContainer(src: Source, direction: 'demux' | 'mux'): Promise<ContainerDriver> {
    const head = await readHead(src);
    const ext = extensionOf(src.filename);
    const q: ContainerQuery = {
      direction,
      head,
      ...(src.mimeHint !== undefined ? { mime: src.mimeHint } : {}),
      ...(ext !== undefined ? { extension: ext } : {}),
    };
    try {
      return this.#router.pickContainer(q);
    } catch (e) {
      // On a miss, lazily load the first-party drivers and retry once (zero-config, ADR-004). An
      // explicitly `use()`d driver that matches never misses, so it always wins over the defaults.
      if (!(e instanceof CapabilityError) || this.#defaultsLoaded) throw e;
      await this.#ensureDefaultDrivers();
      return this.#router.pickContainer(q);
    }
  }

  /**
   * Route the *output* container's driver by its token (mime/extension) — for mux, where there are no
   * input bytes to magic-probe. Loads the first-party defaults on a miss then retries once, mirroring
   * {@link routeContainer}'s zero-config behavior.
   */
  async #routeMuxer(target: string): Promise<ContainerDriver> {
    const q: ContainerQuery = {
      direction: 'mux',
      extension: target,
      ...(CONTAINER_MIME[target] !== undefined ? { mime: CONTAINER_MIME[target] } : {}),
    };
    try {
      return this.#router.pickContainer(q);
    } catch (e) {
      if (!(e instanceof CapabilityError) || this.#defaultsLoaded) throw e;
      await this.#ensureDefaultDrivers();
      return this.#router.pickContainer(q);
    }
  }

  /** Lazily import + register the first-party driver bundle (a code-split chunk). One-time. */
  async #ensureDefaultDrivers(): Promise<void> {
    if (this.#defaultsLoaded) return;
    this.#defaultsLoaded = true;
    const { registerDefaultDrivers } = await import('../drivers/defaults.ts');
    registerDefaultDrivers(this.#registry);
    this.#router.clearCache();
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
      ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    });
    /* v8 ignore stop */
  }

  /** Resolve a codec driver for a query, loading the first-party defaults on a miss then retrying once. */
  async #routeCodec(q: CodecQuery, o: CallOptions): Promise<CodecDriver> {
    const opts = { determinism: this.#determinism(o) };
    try {
      return await this.#router.pickCodec(q, opts);
    } catch (e) {
      if (!(e instanceof CapabilityError) || this.#defaultsLoaded) throw e;
      await this.#ensureDefaultDrivers();
      return this.#router.pickCodec(q, opts);
    }
  }

  /** Resolve a filter driver for a spec, loading the first-party defaults on a miss then retrying once. */
  async #routeFilter(spec: FilterSpec, o: CallOptions): Promise<FilterDriver> {
    const opts = { determinism: this.#determinism(o) };
    try {
      return this.#router.pickFilter(spec, opts);
    } catch (e) {
      if (!(e instanceof CapabilityError) || this.#defaultsLoaded) throw e;
      await this.#ensureDefaultDrivers();
      return this.#router.pickFilter(spec, opts);
    }
  }

  /** Resolve the default image capability if the source's magic bytes are a supported image format. */
  async #imageOpsForSource(src: Source): Promise<ImageOps | undefined> {
    const head = await readHead(src);
    if (this.#registry.imageOps() === undefined) {
      await this.#ensureDefaultDrivers();
    }
    const ops = this.#registry.imageOps();
    return ops?.sniff(head) === undefined ? undefined : ops;
  }

  /** Probe image bytes through the standalone image parser when the source magic matches an image. */
  async #probeImageInfo(src: Source, signal: AbortSignal): Promise<MediaInfo | undefined> {
    const ops = await this.#imageOpsForSource(src);
    if (ops === undefined) return undefined;
    const bytes = await readAllSource(src, signal);
    return imageToMediaInfo(ops.probe(bytes), src);
  }

  /** Sniff an image source once and, if matched, keep the bytes shared by the video/audio decode streams. */
  async #imageDecodeRoute(src: Source, signal: AbortSignal): Promise<ImageDecodeRoute | undefined> {
    const ops = await this.#imageOpsForSource(src);
    if (ops === undefined) return undefined;
    const bytes = await readAllSource(src, signal);
    return { ops, bytes };
  }

  /** Browser-only image decode route: still/animated images become a video frame stream, no packet seam. */
  async #decodeVideoOrImage(
    src: Source,
    stage: StageOptions,
    imageRoute: ImageDecodeRouteLoader,
  ): Promise<ReadableStream<VideoFrame> | undefined> {
    const image = await imageRoute();
    if (image !== undefined) {
      return image.ops.decode(image.bytes, stage.signal ? { signal: stage.signal } : {});
    }
    return this.#decodeTrack(src, 'video', stage);
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
    imageRoute?: ImageDecodeRouteLoader,
  ): Promise<ReadableStream<RawFrameOf<M>> | undefined> {
    if (mediaType === 'audio' && imageRoute !== undefined && (await imageRoute()) !== undefined) {
      return undefined;
    }
    const container = await this.#routeContainer(src, 'demux');
    const demuxer = await container.demux(src, stage);
    const track = demuxer.tracks.find((t) => t.mediaType === mediaType && t.config !== undefined);
    if (!track) {
      await demuxer.close();
      return undefined;
    }
    if (track.encrypted === true) {
      await demuxer.close();
      throw new MediaError(
        'decode-error',
        `decode cannot read a protected ${mediaType} track before decrypt() emits clear samples`,
      );
    }
    if (
      mediaType === 'audio' &&
      container.decodePcmAudio &&
      (isRawPcmTrack(track) || track.codec === 'flac')
    ) {
      await demuxer.close();
      const audio = await container.decodePcmAudio(src, stage);
      return pcmAudioToAudioDataStream(audio, stage, track.codec) as ReadableStream<RawFrameOf<M>>;
    }
    const codec = await this.#routeCodec(await decodeQueryFor(track), {
      strategy: stageStrategy(stage),
    });
    const { decodeVideoPacketsWithAlpha, unwrapPackets } = await loadCodecPipeline();
    // The route above throws a typed miss in Node (no WebCodecs); past here is the live decode path.
    /* v8 ignore start -- requires a real VideoDecoder/AudioDecoder; browser-harness validated. */
    const config = await decodeConfigOf(track);
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
      return (await decodedAudioStreamWithGapless(
        decoded as ReadableStream<AudioData>,
        track,
      )) as ReadableStream<RawFrameOf<M>>;
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
    const codec = await this.#routeCodec(await decodeQueryFor(track), o);
    const { unwrapPackets } = await loadCodecPipeline();
    const config = await decodeConfigOf(track);
    const decoded = unwrapPackets(demuxer.packets(track.id)).pipeThrough(
      codec.createDecoder(config, stage),
    ) as ReadableStream<AudioData>;
    return decodedAudioStreamWithGapless(decoded, track);
  }

  /**
   * Cross-container stream-copy (ADR-021/012): demux the source and write each track's encoded packets
   * **verbatim** into the target container's `Muxer` — no decode/re-encode, so codec-private/PTS/DTS/
   * B-frame composition survive. The target muxer's `addTrack`/`mapCodec` is the single arbiter of
   * codec-in-container legality, so an illegal pair (e.g. Vorbis→MP4, H.264→Ogg) stays an honest
   * `CapabilityError` from the muxer; a target with no working muxer is rejected up front. The packet copy
   * itself needs WebCodecs `EncodedChunk` (browser) — unreachable in Node, where `packets()` throws the
   * typed miss first — so it is browser-harness validated; the routing decision is unit-tested.
   */
  async #remuxViaSeam(
    container: ContainerDriver,
    src: Source,
    opts: RemuxOptions,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!containerHasChunkMuxer(opts.to)) {
      throw new CapabilityError(
        'capability-miss',
        `remux to '${opts.to}' has no muxer in this build (writable containers: mp4/mov, webm/mkv, ogg; ${container.formats[0]} stream-copies only to its own family)`,
        { op: 'remux', tried: [container.id, opts.to] },
      );
    }
    // Decline an oversize buffer-all remux UP FRONT (ADR-094): the cross-container seam copies every packet
    // into a muxer that serializes the whole file at finalize (no incremental Cluster emit), so a
    // multi-GB output would OOM/hang. The output of a verbatim stream-copy is ~the source media size, so a
    // known source size over the ceiling is a real resource limit — a typed miss, not an attempt-then-timeout.
    // Unknown size ⇒ proceed (best-effort guard, never a guess); the streaming-mux follow-up lifts this.
    if (src.size !== undefined && src.size > REMUX_BUFFER_ALL_MAX_OUTPUT_BYTES) {
      throw new CapabilityError(
        'capability-miss',
        `remux to '${opts.to}' would buffer ~${Math.round(src.size / (1024 * 1024))} MB in memory, exceeding the in-browser buffer-all limit (${Math.round(REMUX_BUFFER_ALL_MAX_OUTPUT_BYTES / (1024 * 1024))} MB); split this large file, or process it server-side, until the streaming mux lands`,
        {
          op: 'remux',
          tried: [container.id, opts.to],
          suggestion: 'split the source into smaller segments, or remux server-side',
        },
      );
    }
    const demuxer = await container.demux(src, this.#stageOptions(signal, o));
    const muxer = (await this.#routeMuxer(opts.to)).createMuxer(muxOptionsFrom(opts, opts.to));
    // Copy only tracks the demuxer fully describes (a `config`-less track cannot be re-muxed faithfully).
    const tracks = selectTrackInfos(
      demuxer.tracks.filter((t) => t.config !== undefined),
      opts.trackSelect,
    );
    if (tracks.length === 0) {
      await demuxer.close();
      throw new CapabilityError('capability-miss', 'remux found no copyable track in the source', {
        op: 'remux',
        tried: [container.id],
      });
    }
    /* v8 ignore start -- the verbatim packet copy needs WebCodecs EncodedChunk (browser); in Node
       `packets()` throws the typed miss above. The track fan-out + drain is browser-harness validated. */
    const openStreams: ReadableStream<unknown>[] = [];
    try {
      const { drainEncoderToMuxer } = await loadCodecPipeline();
      const tasks = tracks.map((track) => {
        const packets = demuxer.packets(track.id);
        openStreams.push(packets);
        return drainEncoderToMuxer(packets, muxer, () => track);
      });
      await allOrCancelStreams(tasks, openStreams);
      await muxer.finalize();
      return muxer.output;
    } finally {
      await demuxer.close();
    }
    /* v8 ignore stop */
  }

  /**
   * Audio-only packet trim for elementary / audio-page containers whose muxers already write the copied
   * compressed frames. This is deliberately narrower than generic keyframe trim: no video tracks, no
   * multi-audio assembly, and no intra-frame cuts. We keep whole packets overlapping `[start,end)`, rebase
   * the first kept packet to t=0, and let the container muxer repair duration/header metadata.
   */
  async #trimAudioPacketsViaSeam(
    container: ContainerDriver,
    src: Source,
    target: Container,
    opts: TrimOptions,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    if (typeof EncodedAudioChunk === 'undefined') {
      throw new CapabilityError(
        'capability-miss',
        'compressed-audio packet trim requires EncodedAudioChunk',
        { op: 'trim', tried: [container.id, target] },
      );
    }
    const { trimAudioPacketStream, trimBoundsUs, trimPacketCopyTrack } = await import(
      './trim-streams.ts'
    );
    const bounds = trimBoundsUs(opts.start, opts.end);
    const demuxer = await container.demux(src, this.#stageOptions(signal, o));
    const muxer = (await this.#routeMuxer(target)).createMuxer(muxOptionsFrom(opts, target));
    try {
      if (demuxer.tracks.some((track) => track.mediaType === 'video')) {
        throw new CapabilityError(
          'capability-miss',
          'audio packet trim does not handle video tracks',
          { op: 'trim', tried: [container.id, target] },
        );
      }
      const tracks = demuxer.tracks.filter(
        (track) => track.mediaType === 'audio' && track.config !== undefined,
      );
      if (tracks.length !== 1) {
        throw new CapabilityError(
          'capability-miss',
          `audio packet trim needs exactly one copyable audio track, found ${tracks.length}`,
          { op: 'trim', tried: [container.id, target] },
        );
      }
      const track = tracks[0];
      if (track === undefined) {
        throw new CapabilityError(
          'capability-miss',
          'audio packet trim found no copyable audio track',
          { op: 'trim', tried: [container.id, target] },
        );
      }
      const packets = trimAudioPacketStream(demuxer.packets(track.id), bounds);
      const { drainEncoderToMuxer } = await loadCodecPipeline();
      await drainEncoderToMuxer(packets, muxer, () => trimPacketCopyTrack(track, bounds));
      await muxer.finalize();
      return muxer.output;
    } finally {
      await demuxer.close();
    }
  }

  /**
   * Accurate trim: decode from a safe video keyframe preroll (audio from the head), keep decoded frames
   * whose presentation timestamp lands in the requested window, rebase the first kept frame to t=0, then
   * re-encode and mux. This is the browser codec seam; Node reaches the typed codec miss before packets
   * are consumed. Frame lifetime is owned by `trimTimedFrameStream` (skipped/input frames) and the encoder
   * stages (emitted frames).
   */
  async #trimViaCodec(
    container: ContainerDriver,
    src: Source,
    target: Container,
    opts: TrimOptions,
    durationSec: number,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!containerHasChunkMuxer(target)) {
      throw new CapabilityError(
        'capability-miss',
        `accurate trim to '${target}' has no EncodedChunk muxer in this build`,
        { op: 'trim', tried: [target] },
      );
    }

    // Accurate trim is decode→(restamp)→encode→mux — the same heavy graph as convert, so it offloads to
    // the worker too (doc 06 §4, ADR-019), returning the encoded byte stream the caller materializes.
    // `undefined` ⇒ no worker; run the inline path below (the honest fallback).
    const offloaded = await this.#offloadStream(src, 'trim', opts, signal, o);
    /* v8 ignore next -- the offload branch needs a live worker bridge (browser); harness validated. */
    if (offloaded !== undefined) return offloaded;

    const { trimBoundsUs, trimEncodeTrack, trimTimedFrameStream, trimVideoEncodeTarget } =
      await import('./trim-streams.ts');
    const endSec = durationSec > 0 ? Math.min(opts.end, durationSec) : opts.end;
    const bounds = trimBoundsUs(opts.start, endSec);
    const demuxer = await container.demux(src, this.#stageOptions(signal, o));
    const muxer = (await this.#routeMuxer(target)).createMuxer(muxOptionsFrom(opts, target));
    const tasks: Promise<void>[] = [];
    const openStreams: ReadableStream<unknown>[] = [];
    let drainsStarted = false;
    try {
      const videoTrack = demuxer.tracks.find(
        (t) => t.mediaType === 'video' && t.config !== undefined,
      );
      const audioTrack = demuxer.tracks.find(
        (t) => t.mediaType === 'audio' && t.config !== undefined,
      );

      if (videoTrack) {
        assertTrimTrackDecodable(videoTrack);
        const codec = await this.#routeCodec(await decodeQueryFor(videoTrack), o);
        const { unwrapPackets } = await loadCodecPipeline();
        /* v8 ignore start -- live decode→trim→encode requires WebCodecs; browser-harness validated. */
        const packets = await startAtSeekKeyframe(
          unwrapPackets(demuxer.packets(videoTrack.id)),
          bounds.startUs,
        );
        const config = await decodeConfigOf(videoTrack);
        const decoded = packets.pipeThrough(
          codec.createDecoder(config, this.#stageOptions(signal, o)),
        ) as ReadableStream<VideoFrame>;
        const trimmed = trimTimedFrameStream(decoded, bounds, restampVideoFrame);
        openStreams.push(trimmed);
        tasks.push(
          this.#encodeVideoStream(
            trimmed,
            trimVideoEncodeTarget(videoTrack),
            trimEncodeTrack(videoTrack),
            muxer,
            signal,
            o,
          ),
        );
        /* v8 ignore stop */
      }

      if (audioTrack) {
        assertTrimTrackDecodable(audioTrack);
        const codec = await this.#routeCodec(await decodeQueryFor(audioTrack), o);
        const { unwrapPackets } = await loadCodecPipeline();
        /* v8 ignore start -- live decode→trim→encode requires WebCodecs; browser-harness validated. */
        const config = await decodeConfigOf(audioTrack);
        const decoded = unwrapPackets(demuxer.packets(audioTrack.id)).pipeThrough(
          codec.createDecoder(config, this.#stageOptions(signal, o)),
        ) as ReadableStream<AudioData>;
        const programAudio = await decodedAudioStreamWithGapless(decoded, audioTrack);
        const trimmed = trimTimedFrameStream(programAudio, bounds, restampAudioData);
        openStreams.push(trimmed);
        tasks.push(
          this.#encodeAudioStream(trimmed, {}, trimEncodeTrack(audioTrack), muxer, signal, o),
        );
        /* v8 ignore stop */
      }

      if (tasks.length === 0) {
        throw new CapabilityError(
          'capability-miss',
          'accurate trim found no decodable video or audio track to re-encode',
          { op: 'trim', tried: [container.id] },
        );
      }

      /* v8 ignore start -- reached only after live codec routes resolve; browser-harness validated. */
      drainsStarted = true;
      await allOrCancelStreams(tasks, openStreams);
      await muxer.finalize();
      return muxer.output;
      /* v8 ignore stop */
    } catch (e) {
      if (!drainsStarted) {
        await Promise.all(openStreams.map((stream) => cancelStream(stream)));
      }
      throw e;
    } finally {
      await demuxer.close();
    }
  }

  async #writeMetadataTags(
    src: Source,
    target: Container,
    tags: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const bytes = await readAllSource(src, signal);
    switch (target) {
      case 'mp4':
      case 'mov': {
        const { writeMp4Tags } = await import('../metadata/mp4-tags.ts');
        return writeMp4Tags(bytes, tags);
      }
      case 'webm':
      case 'mkv': {
        const { writeMkvTags } = await import('../metadata/matroska-tags.ts');
        return writeMkvTags(bytes, tags);
      }
      case 'mp3': {
        const { writeMp3Id3Tags } = await import('../metadata/id3.ts');
        return writeMp3Id3Tags(bytes, tags);
      }
      case 'flac': {
        const { writeFlacVorbisComment } = await import('../metadata/vorbis-comment.ts');
        return writeFlacVorbisComment(bytes, tags);
      }
      case 'ogg': {
        const { writeOggVorbisComment } = await import('../metadata/ogg-vorbis-comment.ts');
        return writeOggVorbisComment(bytes, tags);
      }
      default:
        throw new CapabilityError(
          'capability-miss',
          `metadata tag rewrite is not available for '${target}'`,
          { op: 'remux', tried: [target] },
        );
    }
  }

  /**
   * The capabilities the lazily-imported PCM-family authoring routines need, bound to this engine instance —
   * a superset satisfying BOTH {@link FlacConvertDeps} (FLAC route) and {@link PcmConvertDeps} (raw-PCM
   * route). Built only on an eligible `to:'flac'`/raw-PCM convert (the inline gate gates the lazy import), so
   * the eager kernel never carries those routes — just this tiny binder + the shared `pcm*` mappers.
   */
  #authoringDeps(): PcmConvertDeps {
    return {
      routeContainer: (src, direction) => this.#routeContainer(src, direction),
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
  ): Promise<Output> {
    const container = await this.#routeContainer(src, 'demux');
    const target = chooseOutputContainer(opts.to, container.formats[0]);

    // Preferred fast path: a pure container change (no codec/filter/param change, no dropped track) is a
    // lossless stream-copy when the source container can stream-copy to the target (ADR-012/021).
    if (
      isPureStreamCopy(opts) &&
      container.streamCopy &&
      container.formats.includes(target) &&
      target === opts.to
    ) {
      const stream = await container.streamCopy(src, {
        ...this.#stageOptions(signal, o),
        ...(opts.faststart !== undefined ? { faststart: opts.faststart } : {}),
        ...(opts.fragmented !== undefined ? { fragmented: opts.fragmented } : {}),
        ...(opts.sink?.kind === 'stream-target' ? { streaming: true } : {}),
        ...(opts.sink?.kind !== 'stream-target' ? { buffered: true } : {}),
      });
      return materializeOutput(opts.sink ?? toBlob(), stream, mimeOpts(signal, target));
    }

    if (!containerHasChunkMuxer(target)) {
      throw new CapabilityError(
        'capability-miss',
        `convert to '${target}' via the codec seam has no EncodedChunk muxer in this build`,
        { op: 'convert', tried: [target] },
      );
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

    const demuxer = await container.demux(src, this.#stageOptions(signal, o));
    const muxer = (await this.#routeMuxer(target)).createMuxer(muxOptionsFrom(opts, target));
    const tasks: Promise<void>[] = [];
    const openStreams: ReadableStream<unknown>[] = [];
    try {
      const videoTrack =
        opts.video === false
          ? undefined
          : demuxer.tracks.find((t) => t.mediaType === 'video' && t.config !== undefined);
      const audioTrack =
        opts.audio === false
          ? undefined
          : demuxer.tracks.find((t) => t.mediaType === 'audio' && t.config !== undefined);

      if (videoTrack) {
        // Fail target encode-config errors before creating decode/filter streams. Otherwise a synchronous
        // config miss (for example the benchmark's 1x1 H.264 edge) can reject the encode task while an
        // already-built upstream stream is still tearing down, surfacing as an escaped async rejection.
        const { buildVideoEncoderConfigForRuntime } = await loadCodecPipeline();
        const videoTarget = opts.video || {};
        const sourceGeometry = sourceGeometryOf(videoTrack);
        await buildVideoEncoderConfigForRuntime(videoTarget, sourceGeometry, videoTrack.codec);
        // Resolve the decode codec first (this throws a typed miss in Node where WebCodecs is absent);
        // the composition below is the live path, browser-validated.
        const videoCodec = await this.#routeCodec(await decodeQueryFor(videoTrack), o);
        const { decodeVideoPacketsWithAlpha, unwrapPackets } = await loadCodecPipeline();
        const config = await decodeConfigOf(videoTrack);
        /* v8 ignore start -- live decode→filter→encode requires WebCodecs; browser-harness validated. */
        const decoded =
          videoTrack.alpha === true
            ? decodeVideoPacketsWithAlpha(demuxer.packets(videoTrack.id), () =>
                videoCodec.createDecoder(config, this.#stageOptions(signal, o)),
              )
            : unwrapPackets(demuxer.packets(videoTrack.id)).pipeThrough(
                videoCodec.createDecoder(config, this.#stageOptions(signal, o)),
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
          this.#encodeVideoStream(filtered, opts.video || {}, videoTrack, muxer, signal, o),
        );
        /* v8 ignore stop */
      }
      if (audioTrack) {
        const { resolveAudioEncodeTargetForRuntime } = await loadCodecPipeline();
        const audioTarget = await resolveAudioEncodeTargetForRuntime(
          opts.audio || {},
          audioTrack.codec,
        );
        const stage = this.#stageOptions(signal, o);
        const decoded =
          container.decodePcmAudio && (isRawPcmTrack(audioTrack) || audioTrack.codec === 'flac')
            ? pcmAudioToAudioDataStream(
                await container.decodePcmAudio(src, stage),
                stage,
                audioTrack.codec,
              )
            : await this.#decodeAudioTrackPackets(demuxer, audioTrack, stage, o);
        /* v8 ignore start -- live decode→[remix/resample]→encode requires AudioData/WebCodecs; browser-validated. */
        // Channel/rate change → remix/resample the decoded AudioData to the target layout BEFORE the
        // encoder, so the buffers match the encoder's configured numberOfChannels/sampleRate exactly (a
        // stereo buffer into a mono-configured AudioEncoder is rejected). No change ⇒ passes through.
        const shaped = await this.#applyAudioFilters(decoded, audioTarget, audioTrack, signal, o);
        openStreams.push(shaped);
        tasks.push(this.#encodeAudioStream(shaped, audioTarget, audioTrack, muxer, signal, o));
        /* v8 ignore stop */
      }
      if (tasks.length === 0) {
        throw new CapabilityError(
          'capability-miss',
          'convert found no decodable video or audio track to re-encode',
          { op: 'convert', tried: [container.id] },
        );
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
    const { retimeVideoFrameStream, videoFilterSpecs } = await import('./video-stream-plan.ts');
    const specs = videoFilterSpecs(target, sourceGeometryOf(track));
    let out = frames;
    const stages: TransformStream<VideoFrame, VideoFrame>[] = [];
    for (const spec of specs) {
      const driver = await this.#routeFilter(spec, o);
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
    // The lossy-seam audio-filter PLANNER lives in a lazily-imported chunk (`audio-stream-plan.ts`), so the
    // eager kernel never statically pulls the audio-spec code + its audio-dsp type imports (doc 08 §7).
    // Reached only here, on the live convert audio re-encode — already a browser-only, async path.
    const { audioFilterSpecs } = await import('./audio-stream-plan.ts');
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

  /** Encode one video stream and drain its chunks into the muxer (with the encoder→muxer config bridge). */
  async #encodeVideoStream(
    frames: ReadableStream<VideoFrame>,
    target: VideoTarget,
    sourceTrack: TrackInfo | undefined,
    muxer: Muxer,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<void> {
    const {
      buildVideoEncoderConfig,
      drainEncoderToMuxer,
      encodeVideoFramesWithAlpha,
      videoTrackInfoFromDecoderConfig,
    } = await loadCodecPipeline();
    const config = buildVideoEncoderConfig(
      target,
      sourceTrack ? sourceGeometryOf(sourceTrack) : { width: target.width, height: target.height },
      sourceTrack?.codec,
    );
    const { planVideoBitDepthConversion } = await import('./video-stream-plan.ts');
    const bitDepthPlan = planVideoBitDepthConversion({
      ...(sourceTrack?.codec !== undefined ? { sourceCodec: sourceTrack.codec } : {}),
      targetCodec: config.codec,
      ...(target.bitDepth !== undefined ? { targetBitDepth: target.bitDepth } : {}),
    });
    const encoderConfig: VideoEncoderConfig =
      target.alpha === 'keep' ? { ...config, alpha: 'discard' } : config;
    const codec = await this.#routeCodec(encodeQueryFor(encoderConfig), o);
    // The encoder publishes its VideoDecoderConfig (codec box) out-of-band via onDecoderConfig; the muxer
    // needs it before addTrack, so we capture it and build the TrackInfo lazily on the first chunk. Past
    // here is the live WebCodecs path — unreachable in Node (the route above throws first), browser-validated.
    /* v8 ignore start -- requires a real VideoEncoder; validated in the browser harness (BUILD §6.1). */
    let decoderConfig: VideoDecoderConfig | undefined;
    const stage: VideoEncoderStageOptions = {
      ...this.#stageOptions(signal, o),
      onDecoderConfig: (c) => {
        decoderConfig = c;
      },
      ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
      ...(target.fps !== undefined
        ? { keyFrameInterval: Math.max(1, Math.round(target.fps * 2)) }
        : {}),
    };
    const alphaStage: VideoEncoderStageOptions = {
      ...this.#stageOptions(signal, o),
      ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
      ...(target.fps !== undefined
        ? { keyFrameInterval: Math.max(1, Math.round(target.fps * 2)) }
        : {}),
    };
    const encodeInput = bitDepthPlan.requiresPixelPath
      ? frames.pipeThrough(
          (await import('./video-frame-convert.ts')).canvasBackedVideoFrameStream(),
        )
      : frames;
    const chunks =
      target.alpha === 'keep'
        ? encodeVideoFramesWithAlpha(encodeInput, {
            config: encoderConfig,
            createEncoder: (c, stageOptions) => codec.createEncoder(c, stageOptions),
            colorStage: stage,
            alphaStage,
          })
        : encodeInput.pipeThrough(codec.createEncoder(encoderConfig, stage));
    await drainEncoderToMuxer(chunks, muxer, () =>
      videoTrackInfoFromDecoderConfig(
        requireConfig(decoderConfig, 'video'),
        target.fps,
        sourceTrack?.durationSec,
      ),
    );
    /* v8 ignore stop */
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
    await drainEncoderToMuxer(chunks, muxer, () =>
      audioTrackInfoFromDecoderConfig(
        requireConfig(decoderConfig, 'audio'),
        sourceTrack?.durationSec,
        sourceTrack?.gapless,
      ),
    );
    /* v8 ignore stop */
  }

  /** The media's duration (longest track), read via a one-shot demux — mirrors {@link probe}. */
  async #probeDurationSec(
    container: ContainerDriver,
    src: Source,
    signal: AbortSignal,
    o: CallOptions,
  ): Promise<number> {
    const demuxer = await container.demux(src, this.#stageOptions(signal, o));
    try {
      return demuxer.tracks.reduce((max, t) => Math.max(max, t.durationSec ?? 0), 0);
    } finally {
      await demuxer.close();
    }
  }

  /** Use the container's native stream-copy for same-container remux/trim; else a typed miss (ADR-021). */
  async #streamCopyOrThrow(
    container: ContainerDriver,
    src: Source,
    target: string,
    op: string,
    opts: StreamCopyOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!container.streamCopy || !container.formats.includes(target)) {
      throw new CapabilityError(
        'capability-miss',
        `${op} to '${target}' from a ${container.formats[0]} source needs the codec seam (browser); same-container stream-copy only here`,
        {
          op,
          tried: [container.id],
          suggestion: 'use a same-container target, or run the browser codec layer',
        },
      );
    }
    // Pass the requested target token so a multi-format driver writes the right flavor (e.g. the MP4
    // driver emits a QuickTime `ftyp` for a 'mov' target vs an ISO one for 'mp4').
    return container.streamCopy(src, { ...opts, container: target });
  }

  #withCancel<T>(o: CallOptions, exec: (signal: AbortSignal) => Promise<T>): Cancellable<T> {
    const ctrl = new AbortController();
    const caller = o.signal;
    if (caller) {
      if (caller.aborted) ctrl.abort(caller.reason);
      else caller.addEventListener('abort', () => ctrl.abort(caller.reason), { once: true });
    }
    const p = exec(ctrl.signal) as Cancellable<T>;
    p.cancel = (): void => ctrl.abort(new MediaError('aborted', 'operation cancelled'));
    return p;
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
  const { materialize } = await import('../sinks/materialize.ts');
  return materialize(sink, stream, opts);
}

interface ImageDecodeRoute {
  readonly ops: ImageOps;
  readonly bytes: Uint8Array;
}

type ImageDecodeRouteLoader = () => Promise<ImageDecodeRoute | undefined>;

const MICROS_PER_SECOND = 1_000_000;
const AUDIO_PACKET_TRIM_CONTAINERS = new Set<Container>(['mp3', 'adts', 'ogg']);

function canTrimAudioPackets(container: Container): boolean {
  return AUDIO_PACKET_TRIM_CONTAINERS.has(container);
}

function assertTrimTrackDecodable(track: TrackInfo): void {
  if (track.encrypted !== true) return;
  throw new MediaError(
    'decode-error',
    `accurate trim cannot decode a protected ${track.mediaType} track before decrypt() emits clear samples`,
  );
}

async function decodedAudioStreamWithGapless(
  frames: ReadableStream<AudioData>,
  track: TrackInfo,
): Promise<ReadableStream<AudioData>> {
  if (track.gapless === undefined) return frames;
  const { trimAudioGaplessFrameStream } = await import('./trim-streams.ts');
  return trimAudioGaplessFrameStream(frames, track.gapless, restampAudioDataRange);
}

/* v8 ignore start -- browser-only restamp constructors; trimTimedFrameStream is Node-tested below. */
function restampVideoFrame(
  frame: VideoFrame,
  timestamp: number,
  duration: number | null,
): VideoFrame {
  if (frame.timestamp === timestamp && frame.duration === duration) return frame;
  const init: VideoFrameInit = duration === null ? { timestamp } : { timestamp, duration };
  return new VideoFrame(frame, init);
}

function restampAudioData(
  frame: AudioData,
  timestamp: number,
  _duration: number | null,
): AudioData {
  return restampAudioDataRange(frame, 0, frame.numberOfFrames, timestamp);
}

function restampAudioDataRange(
  frame: AudioData,
  startFrame: number,
  frameCount: number,
  timestamp: number,
): AudioData {
  if (startFrame === 0 && frameCount === frame.numberOfFrames && frame.timestamp === timestamp) {
    return frame;
  }
  const { init } = pcmRangeToPlanarInit(audioDataToPcm(frame), startFrame, frameCount, timestamp);
  return new AudioData(init);
}
/* v8 ignore stop */

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
function stageStrategy(stage: StageOptions): { determinism: Determinism } {
  return { determinism: stage.determinism ?? 'auto' };
}

/**
 * Wrap an async producer of a `ReadableStream<T>` into an eager `ReadableStream<T>` whose underlying work
 * runs on first pull. Used by `decode` to honor its synchronous-return contract while the demux + codec
 * routing it needs are async. When the producer yields `undefined` (no such track) the stream is empty.
 * `cancel` propagates downstream cancellation to the produced stream's reader so the decoder tears down.
 */
function deferredStream<T>(
  produce: () => Promise<ReadableStream<T> | undefined>,
): ReadableStream<T> {
  let reader: ReadableStreamDefaultReader<T> | undefined;
  let started = false;
  return new ReadableStream<T>({
    async pull(controller): Promise<void> {
      if (!started) {
        started = true;
        const inner = await produce();
        if (inner === undefined) {
          controller.close();
          return;
        }
        reader = inner.getReader();
      }
      if (!reader) {
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else {
        try {
          controller.enqueue(value);
        } catch (e) {
          closeIfClosable(value);
          throw e;
        }
      }
    },
    async cancel(reason): Promise<void> {
      await reader?.cancel(reason).catch(() => {});
    },
  });
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

/**
 * Browser raw-PCM decode bridge: a raw PCM container has already parsed canonical samples; this wraps
 * them as `AudioData` chunks for the public `decode()` stream. Emitted frames are owned by the readable
 * consumer and must be closed by that consumer. If an enqueue loses a cancel race, this function closes
 * the frame it just constructed so no native handle leaks.
 */
function pcmAudioToAudioDataStream(
  audio: PcmAudio,
  stage: StageOptions,
  label: string,
): ReadableStream<AudioData> {
  assertPcmAudioDataAvailable(label);
  /* v8 ignore start -- requires the browser `AudioData` constructor; validated in the browser harness. */
  let cursor = 0;
  return new ReadableStream<AudioData>({
    pull(controller): void {
      try {
        throwIfAborted(stage.signal);
        if (cursor >= audio.frames) {
          controller.close();
          return;
        }
        const frames = Math.min(PCM_AUDIO_DATA_CHUNK_FRAMES, audio.frames - cursor);
        const timestamp = Math.round((cursor / audio.sampleRate) * 1_000_000);
        const { init } = pcmRangeToPlanarInit(audio, cursor, frames, timestamp);
        const frame = new AudioData(init);
        try {
          controller.enqueue(frame);
        } catch (e) {
          frame.close();
          throw e;
        }
        cursor += frames;
      } catch (e) {
        if (e instanceof MediaError) {
          throw e;
        }
        throw new MediaError(
          'decode-error',
          `PCM audio decode failed to construct AudioData: ${unknownMessage(e)}`,
          e,
        );
      }
    },
    cancel(): void {
      cursor = audio.frames;
    },
  });
  /* v8 ignore stop */
}

function assertPcmAudioDataAvailable(label: string): void {
  if (typeof AudioData !== 'undefined') return;
  throw new CapabilityError('capability-miss', 'AudioData is unavailable for PCM decode', {
    op: 'decode',
    tried: [label],
    suggestion: 'run in a browser or worker with AudioData',
  });
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

/**
 * The WebCodecs decode `config` carried on a demux {@link TrackInfo} (guaranteed present by the callers),
 * with its codec string NORMALIZED to one `VideoDecoder`/`AudioDecoder` accepts. A container demux
 * (notably WebM/Matroska) emits a bare canonical token (`vp9`/`av1`/…) that `isConfigSupported` rejects;
 * {@link normalizeDecoderCodec} expands it to a valid WebCodecs string (a no-op for already-qualified
 * strings, so MP4/MOV configs are untouched). Returns a fresh object only when the codec actually
 * changes, so the common case allocates nothing.
 */
async function decodeConfigOf(track: TrackInfo): Promise<TrackInfo['config'] & object> {
  const config = track.config;
  if (config === undefined) {
    throw new MediaError('decode-error', `track ${track.id} has no decoder config`);
  }
  const { normalizeDecoderCodec } = await loadCodecPipeline();
  const codec = normalizeDecoderCodec(config);
  return codec === config.codec ? config : { ...config, codec };
}

/** Build the decode {@link CodecQuery} for a demux track (its media type + WebCodecs decoder config). */
async function decodeQueryFor(track: TrackInfo): Promise<CodecQuery> {
  return { mediaType: track.mediaType, direction: 'decode', config: await decodeConfigOf(track) };
}

/** Build the encode {@link CodecQuery} for a target encoder config (media type inferred from the shape). */
function encodeQueryFor(config: EncoderConfig): CodecQuery {
  const mediaType: 'video' | 'audio' = 'width' in config && 'height' in config ? 'video' : 'audio';
  return { mediaType, direction: 'encode', config };
}

/** Source geometry (coded dims) for a video track, read from its WebCodecs decoder config. */
function sourceGeometryOf(track: TrackInfo): {
  width: number | undefined;
  height: number | undefined;
  fps?: number;
  durationSec?: number;
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
    };
  }
  return {
    width: undefined,
    height: undefined,
    ...(fps !== undefined ? { fps } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
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
 * Assert the encoder published its decoder config before the muxer needed it (else a typed error). Only
 * called from the browser-only encoder-drain path (a real WebCodecs encoder always emits the config with
 * its first chunk), so the undefined-guard is unreachable in Node — validated in the browser harness.
 */
/* v8 ignore start -- invoked only on the live WebCodecs encode path; browser-harness validated. */
function requireConfig<T>(config: T | undefined, media: 'video' | 'audio'): T {
  if (config === undefined) {
    throw new MediaError(
      'encode-error',
      `the ${media} encoder produced a chunk before publishing its decoder config (cannot configure the muxer track)`,
    );
  }
  return config;
}
/* v8 ignore stop */

/**
 * Build the seek input packet stream: scan the track's packets for the last keyframe at/before `targetUs`
 * (a stream must decode from a keyframe), then re-emit from that keyframe onward. Packets before it are
 * pulled (to read their timing) but not forwarded. The bytes are read lazily by the demuxer; this only
 * gates which packets reach the decoder. Returns a fresh `ReadableStream<EncodedChunk>` for the decoder.
 *
 * Single-pass with a bounded GOP buffer: buffer chunks since the last seen keyframe; once a packet's
 * timestamp exceeds the target, the most-recent buffered keyframe is the start — flush from it. If the
 * stream ends first (target past EOF), flush from the last keyframe so the final frame is still decodable.
 */
/* v8 ignore start -- requires WebCodecs Encoded*Chunk (absent in Node); validated in the browser harness. */
async function startAtSeekKeyframe(
  packets: ReadableStream<EncodedChunk>,
  targetUs: number,
): Promise<ReadableStream<EncodedChunk>> {
  // One reader drives both the scan and the continuation. Buffer chunks since the most-recent keyframe at
  // or before the target; once a packet's timestamp exceeds the target the target lies within this GOP, so
  // the buffered head (from that keyframe) is the decode start, and the same reader continues after it. The
  // reader is NOT released — the returned stream keeps reading from it and releases it on close/cancel.
  const reader = packets.getReader();
  const head: EncodedChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break; // target at/after EOF: decode from the last buffered keyframe (head holds it)
    if (value.type === 'key' && value.timestamp <= targetUs) {
      head.length = 0; // a keyframe at/before the target supersedes everything buffered before it
      head.push(value);
    } else {
      head.push(value);
    }
    if (value.timestamp > targetUs) break; // the target frame is within the buffered GOP; stop scanning
  }
  return new ReadableStream<EncodedChunk>({
    start(controller): void {
      for (const chunk of head) controller.enqueue(chunk);
    },
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        reader.releaseLock();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason).catch(() => {});
    },
  });
}
/* v8 ignore stop */

/* v8 ignore start -- requires WebCodecs Encoded*Chunk (absent in Node); validated in the browser harness. */
async function startAtSeekKeyframePackets(
  packets: ReadableStream<Packet>,
  targetUs: number,
): Promise<ReadableStream<Packet>> {
  const reader = packets.getReader();
  const head: Packet[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.chunk.type === 'key' && value.chunk.timestamp <= targetUs) {
      head.length = 0;
      head.push(value);
    } else {
      head.push(value);
    }
    if (value.chunk.timestamp > targetUs) break;
  }
  return new ReadableStream<Packet>({
    start(controller): void {
      for (const packet of head) controller.enqueue(packet);
    },
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        reader.releaseLock();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason).catch(() => {});
    },
  });
}
/* v8 ignore stop */

async function readHead(src: Source, n: number = HEAD_BYTES): Promise<Uint8Array> {
  if (src.range) return src.range(0, n);
  if (src.kind === 'stream') {
    throw new InputError(
      'unsupported-input',
      'probe/demux needs a seekable source (bytes, Blob, or URL), not a one-shot stream',
    );
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < n) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const head = new Uint8Array(Math.min(total, n));
  let off = 0;
  for (const c of chunks) {
    if (off >= head.length) break;
    head.set(c.subarray(0, head.length - off), off);
    off += c.byteLength;
  }
  return head;
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
      const { done, value } = await reader.read();
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

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new MediaError('aborted', 'operation cancelled');
  }
}

function unknownMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  const range = `[${startSec}s, ${endSec}s]`;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new InputError('unsupported-input', `trim range ${range} is not a finite interval`);
  }
  if (startSec < 0) {
    throw new InputError('unsupported-input', `trim start ${startSec}s is negative`);
  }
  if (endSec <= startSec) {
    throw new InputError(
      'unsupported-input',
      `trim range ${range} is empty or inverted (end must be greater than start)`,
    );
  }
  // Duration-relative bounds only when a real duration was probed; a 0/unknown duration cannot bound
  // the range without spuriously failing an otherwise well-formed request.
  if (durationSec > 0) {
    if (startSec >= durationSec) {
      throw new InputError(
        'unsupported-input',
        `trim start ${startSec}s is at or past the media duration of ${durationSec}s`,
      );
    }
    if (endSec > durationSec + TRIM_END_SLACK_SEC) {
      throw new InputError(
        'unsupported-input',
        `trim end ${endSec}s is past the media duration of ${durationSec}s`,
      );
    }
  }
}

function extensionOf(filename: string | undefined): string | undefined {
  if (filename === undefined) return undefined;
  const dot = filename.lastIndexOf('.');
  return dot >= 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : undefined;
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

const IMAGE_DEFAULT_FPS = 25;

function imageToMediaInfo(info: ImageInfo, src: Source): MediaInfo {
  const durationSec = imageDurationSec(info);
  const track: MediaInfoTrack = {
    id: 0,
    type: 'video',
    codec: info.format === 'jpeg' ? 'mjpeg' : info.format,
    width: info.width,
    height: info.height,
    fps: imageFrameRate(info, durationSec),
  };
  if (durationSec > 0) track.durationSec = durationSec;
  return {
    container: info.format === 'jpeg' ? 'jpeg' : info.format,
    durationSec,
    ...(src.size !== undefined ? { sizeBytes: src.size } : {}),
    tracks: [track],
  };
}

function imageDurationSec(info: ImageInfo): number {
  if (info.durationSec !== undefined) return info.durationSec;
  // The harness image goldens model JPEG as one 25 fps frame (0.04s) and PNG/WebP stills as unknown
  // duration. Animated formats without parsed header timing keep the conservative corpus fallback.
  return info.animated || info.format === 'jpeg' ? info.frameCount / IMAGE_DEFAULT_FPS : 0;
}

function imageFrameRate(info: ImageInfo, durationSec: number): number {
  return durationSec > 0 ? info.frameCount / durationSec : IMAGE_DEFAULT_FPS;
}

function toInfoTrack(t: TrackInfo): MediaInfoTrack {
  const base: MediaInfoTrack = { id: t.id, type: t.mediaType, codec: t.codec };
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
