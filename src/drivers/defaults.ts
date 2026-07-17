/**
 * First-party driver bundle — registered into an engine on demand so `media.probe(file)` works
 * zero-config (doc 07) while the eager kernel stays tiny (ADR-004). The engine `import()`s this module
 * only on a capability miss, so it (and the container parsers it pulls in) is a lazy code-split chunk,
 * never part of the eager bundle. This file holds only registration wiring plus the lazy proxy
 * factories; real parsing lives in the per-family driver modules (`./flac/flac-lazy-driver.ts` for
 * the FLAC fast paths), byte IO in `../util/byte-stream.ts`, image sniffing in the image codec module,
 * and runtime capability detection in `../kernel/runtime-capabilities.ts`.
 */

import type {
  DecodeImageOptions,
  ImageFormat,
  ImageInfo,
  ImageOps,
} from '../codecs/image/index.ts';
import { sniffImageFormat } from '../codecs/image/probe.ts';
import { WebCodecsAudioModule } from '../codecs/webcodecs-audio.ts';
import { WebcodecsVideoModule } from '../codecs/webcodecs-video.ts';
import type {
  ByteSource,
  CodecDriver,
  CodecQuery,
  CodecSupport,
  ContainerDriver,
  ContainerQuery,
  DecoderConfig,
  DecryptParams,
  Demuxer,
  DriverModule,
  EncodedChunk,
  EncoderConfig,
  FilterDriver,
  FilterSpec,
  FilterSubstrate,
  MuxOptions,
  Muxer,
  PacketInfoTable,
  PcmTransform,
  RawFrame,
  Registry,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import type { InterleavedPcmF32, PcmAudio } from '../dsp/index.ts';
import {
  canvas2dAvailable,
  chromiumCanvasTonemapAvailable,
  webgpuAvailable,
} from '../kernel/runtime-capabilities.ts';
import {
  type LazyAudioMuxKind,
  adtsMuxTrackConfig,
  assertAudioMuxOptions,
  rejectRawPcmChunkMux,
  validateMp3MuxTrack,
  validateOggMuxTrack,
  wavMuxTrackConfig,
} from './audio-container-mux-validation.ts';
import {
  matchesAdts,
  matchesAiff,
  matchesCaf,
  matchesMp3,
  matchesOgg,
  matchesWav,
} from './audio-container-sniff.ts';
import { matchesAvi } from './avi/avi-sniff.ts';
import { lazyFlacContainerDriver } from './flac/flac-lazy-driver.ts';
import { createLazyFilterStream } from './lazy-filter-stream.ts';
import { type LazyContainerLoader, LazyMuxer, missingLazyMethod } from './lazy-muxer.ts';
import { matchesMp4 } from './mp4/mp4-sniff.ts';
import { MPEG_TS_FORMATS, matchesMpegTs } from './mpegts/mpegts-sniff.ts';
import { matchesWebm } from './webm/webm-sniff.ts';

/**
 * Register all first-party drivers (idempotent by id): the TS containers, the WebCodecs codec tier
 * (video + audio, `tier:'hardware'`), and the GPU video filter substrates (WebGPU + Canvas2D). The
 * WebCodecs/GPU drivers `supports()` honestly report `false` where those APIs are absent (e.g. Node), so
 * registering them everywhere is safe — the router simply skips them and falls through to a typed miss.
 */
export function registerDefaultDrivers(reg: Registry): void {
  const modules: DriverModule[] = [
    WebcodecsVideoModule,
    WebCodecsAudioModule,
    // All software codec tails now co-vendor their wasm via scripts/vendor-wasm.ts (rust both-files pairs:
    // Vorbis/AAC/MP3 + dav1d AV1; self-contained inlined tails: Opus/VPx) for the lazy import.meta.url load
    // on a WebCodecs miss (ADR-042/086/090/093/094). supports()→false in Node (no VideoFrame/WebCodecs seam).
  ];
  for (const mod of modules) mod.register(reg);
  for (const spec of DEFAULT_LAZY_CONTAINER_SPECS) reg.addContainer(lazyContainer(spec));
  reg.addContainer(lazyFlacContainerDriver());
  for (const driver of lazyFilterDrivers()) reg.addFilter(driver);
  reg.addImageOps?.(lazyImageOps());
  for (const driver of lazyCodecDrivers()) reg.addCodec(driver);
}

type LazyCodecLoader = () => Promise<CodecDriver>;
type LazyFilterLoader = () => Promise<FilterDriver>;

interface LazyCodecSpec {
  readonly id: string;
  readonly tier: CodecDriver['tier'];
  readonly matches: (q: CodecQuery) => boolean;
  readonly load: LazyCodecLoader;
}

/**
 * A lazy container proxy description. The boolean flags mirror the loaded module's optional method
 * surface **exactly** — `lazy-container-conformance.test.ts` loads every spec and fails on any drift
 * in either direction, so an advertised method can never miss at call time and a real method can
 * never be silently hidden from the router.
 */
export interface LazyContainerSpec {
  readonly id: string;
  readonly formats: readonly string[];
  readonly streamCopyTargets?: readonly string[];
  readonly supports: (q: ContainerQuery) => boolean;
  readonly load: LazyContainerLoader;
  readonly probe?: true;
  readonly packetInfo?: true;
  readonly streamCopy?: true;
  readonly decrypt?: true;
  readonly transformPcm?: true;
  readonly decodePcm?: true;
  readonly decodePcmAudio?: true;
  readonly decodePcmAudioStream?: true;
  readonly decodePcmInterleavedStream?: true;
  readonly validatesStreamCopyTrim?: true;
  readonly validatesPcmTrim?: true;
  readonly muxKind?: LazyAudioMuxKind;
  readonly rejectChunkMux?: 'aiff' | 'caf';
  readonly validateTrack?: (track: TrackInfo, trackCount: number) => void;
}

/** Every spec-registered first-party container, in registration (routing ladder) order. */
export const DEFAULT_LAZY_CONTAINER_SPECS: readonly LazyContainerSpec[] = [
  {
    id: 'mp4',
    formats: ['mp4', 'mov'],
    supports: matchesMp4,
    load: () => import('./mp4/mp4-driver.ts').then((module) => module.Mp4Driver),
    probe: true,
    packetInfo: true,
    streamCopy: true,
    decrypt: true,
    validatesStreamCopyTrim: true,
  },
  {
    id: 'webm',
    formats: ['webm', 'mkv'],
    supports: matchesWebm,
    load: () => import('./webm/webm-driver.ts').then((module) => module.WebmDriver),
    probe: true,
    streamCopy: true,
  },
  {
    id: 'wav',
    formats: ['wav'],
    supports: matchesWav,
    load: () => import('./wav/wav-driver.ts').then((module) => module.WavDriver),
    probe: true,
    packetInfo: true,
    transformPcm: true,
    decodePcmAudio: true,
    decodePcmAudioStream: true,
    decodePcmInterleavedStream: true,
    validatesPcmTrim: true,
    muxKind: 'wav',
    validateTrack: (track, trackCount) => {
      wavMuxTrackConfig(track, trackCount);
    },
  },
  {
    id: 'mp3',
    formats: ['mp3'],
    supports: matchesMp3,
    load: () => import('./mp3/mp3-driver.ts').then((module) => module.Mp3Driver),
    probe: true,
    packetInfo: true,
    muxKind: 'mp3',
    validateTrack: validateMp3MuxTrack,
  },
  {
    id: 'ogg',
    formats: ['ogg'],
    streamCopyTargets: ['webm', 'mkv'],
    supports: matchesOgg,
    load: () => import('./ogg/ogg-driver.ts').then((module) => module.OggDriver),
    probe: true,
    packetInfo: true,
    streamCopy: true,
    validatesStreamCopyTrim: true,
    muxKind: 'ogg',
    validateTrack: validateOggMuxTrack,
  },
  {
    id: 'adts',
    formats: ['adts', 'aac'],
    supports: matchesAdts,
    load: () => import('./adts/adts-driver.ts').then((module) => module.AdtsDriver),
    probe: true,
    packetInfo: true,
    streamCopy: true,
    decrypt: true,
    decodePcm: true,
    validatesStreamCopyTrim: true,
    muxKind: 'adts',
    validateTrack: (track, trackCount) => {
      adtsMuxTrackConfig(track, trackCount);
    },
  },
  {
    id: 'aiff',
    formats: ['aiff'],
    supports: matchesAiff,
    load: () => import('./aiff/aiff-driver.ts').then((module) => module.AiffDriver),
    probe: true,
    packetInfo: true,
    transformPcm: true,
    decodePcmAudio: true,
    rejectChunkMux: 'aiff',
  },
  {
    id: 'caf',
    formats: ['caf'],
    supports: matchesCaf,
    load: () => import('./caf/caf-driver.ts').then((module) => module.CafDriver),
    transformPcm: true,
    decodePcmAudio: true,
    rejectChunkMux: 'caf',
  },
  {
    id: 'mpegts',
    formats: MPEG_TS_FORMATS,
    supports: matchesMpegTs,
    load: () => import('./mpegts/mpegts-driver.ts').then((m) => m.MpegTsDriver),
    streamCopy: true,
    decrypt: true,
  },
  {
    id: 'avi',
    formats: ['avi'],
    supports: matchesAvi,
    load: () => import('./avi/avi-driver.ts').then((m) => m.AviDriver),
  },
];

/** Build the lazy proxy for one container spec: cheap pre-load gates, load-on-first-flow methods. */
export function lazyContainer(spec: LazyContainerSpec): ContainerDriver {
  let driver: ContainerDriver | undefined;
  let loadPromise: Promise<ContainerDriver> | undefined;
  const load = async (): Promise<ContainerDriver> => {
    if (driver !== undefined) return driver;
    loadPromise ??= spec.load();
    driver = await loadPromise;
    return driver;
  };
  return {
    id: spec.id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: spec.formats,
    ...(spec.streamCopyTargets === undefined ? {} : { streamCopyTargets: spec.streamCopyTargets }),
    supports: spec.supports,
    ...(spec.probe === true
      ? {
          async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
            const loaded = await load();
            const probe = loaded.probe;
            if (probe === undefined) throw missingLazyMethod(spec.id, 'probe');
            return probe.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.packetInfo === true
      ? {
          async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
            const loaded = await load();
            const packetInfo = loaded.packetInfo;
            if (packetInfo === undefined) throw missingLazyMethod(spec.id, 'packetInfo');
            return packetInfo.call(loaded, src, o);
          },
        }
      : {}),
    async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
      const loaded = await load();
      return loaded.demux(src, o);
    },
    createMuxer(o?: MuxOptions): Muxer {
      if (spec.rejectChunkMux !== undefined) return rejectRawPcmChunkMux(spec.rejectChunkMux);
      if (spec.muxKind !== undefined) assertAudioMuxOptions(spec.muxKind, o);
      return new LazyMuxer({
        driverId: spec.id,
        load,
        muxOptions: o,
        validateTrack: spec.validateTrack,
        pcmSeam: true,
      });
    },
    ...(spec.streamCopy === true
      ? {
          async streamCopy(
            src: ByteSource,
            o?: StreamCopyOptions,
          ): Promise<ReadableStream<Uint8Array>> {
            const loaded = await load();
            const streamCopy = loaded.streamCopy;
            if (streamCopy === undefined) throw missingLazyMethod(spec.id, 'streamCopy');
            return streamCopy.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.decrypt === true
      ? {
          async decrypt(src: ByteSource, o: DecryptParams): Promise<ReadableStream<Uint8Array>> {
            const loaded = await load();
            const decrypt = loaded.decrypt;
            if (decrypt === undefined) throw missingLazyMethod(spec.id, 'decrypt');
            return decrypt.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.transformPcm === true
      ? {
          async transformPcm(
            src: ByteSource,
            o?: PcmTransform,
          ): Promise<ReadableStream<Uint8Array>> {
            const loaded = await load();
            const transformPcm = loaded.transformPcm;
            if (transformPcm === undefined) throw missingLazyMethod(spec.id, 'transformPcm');
            return transformPcm.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.decodePcm === true
      ? {
          async decodePcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
            const loaded = await load();
            const decodePcm = loaded.decodePcm;
            if (decodePcm === undefined) throw missingLazyMethod(spec.id, 'decodePcm');
            return decodePcm.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.decodePcmAudio === true
      ? {
          async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
            const loaded = await load();
            const decodePcmAudio = loaded.decodePcmAudio;
            if (decodePcmAudio === undefined) throw missingLazyMethod(spec.id, 'decodePcmAudio');
            return decodePcmAudio.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.decodePcmAudioStream === true
      ? {
          async decodePcmAudioStream(
            src: ByteSource,
            o?: StageOptions,
          ): Promise<ReadableStream<PcmAudio>> {
            const loaded = await load();
            const decodePcmAudioStream = loaded.decodePcmAudioStream;
            if (decodePcmAudioStream === undefined) {
              throw missingLazyMethod(spec.id, 'decodePcmAudioStream');
            }
            return decodePcmAudioStream.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.decodePcmInterleavedStream === true
      ? {
          async decodePcmInterleavedStream(
            src: ByteSource,
            o?: StageOptions,
          ): Promise<ReadableStream<InterleavedPcmF32>> {
            const loaded = await load();
            const decodePcmInterleavedStream = loaded.decodePcmInterleavedStream;
            if (decodePcmInterleavedStream === undefined) {
              throw missingLazyMethod(spec.id, 'decodePcmInterleavedStream');
            }
            return decodePcmInterleavedStream.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.validatesStreamCopyTrim === true ? { validatesStreamCopyTrim: true } : {}),
    ...(spec.validatesPcmTrim === true ? { validatesPcmTrim: true } : {}),
  };
}

const IMAGE_FORMATS: readonly ImageFormat[] = ['gif', 'png', 'jpeg', 'webp', 'avif'];

/**
 * The lazily-loaded image capability surface. The load promise lives in this closure — one per
 * registration, so engines in the same process never share resolution state through a module global.
 */
function lazyImageOps(): ImageOps {
  let imageOpsPromise: Promise<ImageOps> | undefined;
  const loadImageOps = (): Promise<ImageOps> => {
    imageOpsPromise ??= import('../codecs/image/image-driver.ts').then((m) => m.imageOps);
    return imageOpsPromise;
  };
  return {
    formats: IMAGE_FORMATS,
    sniff: sniffImageFormat,
    probe(bytes: Uint8Array): Promise<ImageInfo> {
      return loadImageOps().then((ops) => ops.probe(bytes));
    },
    canDecode(): boolean {
      return typeof ImageDecoder !== 'undefined';
    },
    decode(bytes: Uint8Array, options?: DecodeImageOptions): ReadableStream<VideoFrame> {
      let reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
      return new ReadableStream<VideoFrame>(
        {
          async pull(controller): Promise<void> {
            try {
              reader ??= (await loadImageOps()).decode(bytes, options).getReader();
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              try {
                controller.enqueue(value);
              } catch (e) {
                value.close();
                throw e;
              }
            } catch (e) {
              controller.error(e);
            }
          },
          async cancel(reason): Promise<void> {
            await reader?.cancel(reason).catch(() => {});
          },
        },
        { highWaterMark: 0 },
      );
    },
    async *decodeFrames(
      bytes: Uint8Array,
      options?: DecodeImageOptions,
    ): AsyncGenerator<VideoFrame, void, undefined> {
      yield* (await loadImageOps()).decodeFrames(bytes, options);
    },
  };
}

function lazyFilterDrivers(): readonly FilterDriver[] {
  return [
    lazyFilter({
      id: 'webgpu-video-filter',
      substrate: 'webgpu',
      supports: webgpuFilterSupports,
      load: () => import('../filters/gpu-video.ts').then((m) => m.webgpuVideoFilterDriver),
    }),
    lazyFilter({
      id: 'canvas2d-video-filter',
      substrate: 'canvas2d',
      supports: canvas2dFilterSupports,
      load: () => import('../filters/gpu-video.ts').then((m) => m.canvas2dVideoFilterDriver),
    }),
    lazyFilter({
      id: 'audio-dsp-filter',
      substrate: 'native',
      supports: (spec) => spec.mediaType === 'audio' && typeof AudioData !== 'undefined',
      load: () => import('../filters/audio-dsp.ts').then((m) => m.audioDspFilterDriver),
    }),
    lazyFilter({
      id: 'cpu-video-filter',
      substrate: 'native',
      supports: cpuVideoFilterSupports,
      load: () => import('../filters/cpu-video.ts').then((m) => m.cpuVideoFilterDriver),
    }),
  ];
}

function lazyFilter(options: {
  readonly id: string;
  readonly substrate: FilterSubstrate;
  readonly supports: (spec: FilterSpec) => boolean;
  readonly load: LazyFilterLoader;
}): FilterDriver {
  let driver: FilterDriver | undefined;
  let loadPromise: Promise<FilterDriver> | undefined;
  const load = async (): Promise<FilterDriver> => {
    if (driver !== undefined) return driver;
    loadPromise ??= options.load();
    driver = await loadPromise;
    return driver;
  };
  return {
    id: options.id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'filter',
    substrate: options.substrate,
    supports: options.supports,
    createFilter(
      spec: FilterSpec,
      stage?: StageOptions,
    ): TransformStream<VideoFrame, VideoFrame> | TransformStream<AudioData, AudioData> {
      if (!options.supports(spec)) {
        throw new CapabilityError(`${options.id} does not support ${spec.type}`, {
          op: { kind: 'filter', spec },
          tried: [options.id],
        });
      }
      return createLazyFilterStream(
        async () => (await load()).createFilter(spec, stage) as TransformStream<RawFrame, RawFrame>,
      ) as TransformStream<VideoFrame, VideoFrame> | TransformStream<AudioData, AudioData>;
    },
  };
}

function webgpuFilterSupports(spec: FilterSpec): boolean {
  return spec.mediaType === 'video' && spec.type !== 'tonemap' && webgpuAvailable();
}

function canvas2dFilterSupports(spec: FilterSpec): boolean {
  if (!canvas2dAvailable()) return false;
  if (isGeometricVideoFilterSpec(spec)) return true;
  if (spec.mediaType === 'video' && spec.type === 'tonemap')
    return chromiumCanvasTonemapAvailable();
  return spec.mediaType === 'video' && spec.type === 'colorspace' && isDisplayColorToken(spec.to);
}

function cpuVideoFilterSupports(spec: FilterSpec): boolean {
  if (spec.mediaType !== 'video' || typeof VideoFrame === 'undefined') return false;
  const chromiumCanvasTonemap =
    typeof OffscreenCanvas !== 'undefined' && chromiumCanvasTonemapAvailable();
  return !(spec.type === 'tonemap' && chromiumCanvasTonemap);
}

function isGeometricVideoFilterSpec(spec: FilterSpec): boolean {
  return (
    spec.mediaType === 'video' &&
    (spec.type === 'resize' ||
      spec.type === 'crop' ||
      spec.type === 'rotate' ||
      spec.type === 'flip')
  );
}

function isDisplayColorToken(token: string): boolean {
  const key = token.toLowerCase().replace(/[\s._-]/g, '');
  return (
    key === 'srgb' || key === 'iec6196621' || key === 'bt709' || key === 'rec709' || key === '709'
  );
}

function codec(q: CodecQuery): string {
  return q.config.codec.toLowerCase();
}

function audioDecode(q: CodecQuery): boolean {
  return q.mediaType === 'audio' && q.direction === 'decode';
}

function videoDecode(q: CodecQuery): boolean {
  return q.mediaType === 'video' && q.direction === 'decode';
}

function lazyCodecDrivers(): readonly CodecDriver[] {
  return [
    lazyCodec({
      id: 'flac-encode',
      tier: 'native',
      matches: (q) =>
        q.mediaType === 'audio' &&
        q.direction === 'encode' &&
        (codec(q) === 'flac' || codec(q).startsWith('flac.')),
      load: () => import('./flac/flac-codec.ts').then((m) => m.FlacCodecDriver),
    }),
    lazyCodec({
      id: 'wasm-vorbis-enc',
      tier: 'wasm',
      matches: (q) => q.mediaType === 'audio' && q.direction === 'encode' && codec(q) === 'vorbis',
      load: () =>
        import('../codecs/wasm-vorbis-enc/wasm-vorbis-enc-driver.ts').then(
          (m) => m.WasmVorbisEncoderDriver,
        ),
    }),
    lazyCodec({
      id: 'wasm-vorbis',
      tier: 'wasm',
      matches: (q) => audioDecode(q) && codec(q).startsWith('vorbis'),
      load: () =>
        import('../codecs/wasm-vorbis/wasm-vorbis-driver.ts').then((m) => m.WasmVorbisDriver),
    }),
    lazyCodec({
      id: 'wasm-aac',
      tier: 'wasm',
      matches: (q) => audioDecode(q) && (codec(q) === 'aac' || codec(q).startsWith('mp4a')),
      load: () => import('../codecs/wasm-aac/wasm-aac-driver.ts').then((m) => m.WasmAacDriver),
    }),
    lazyCodec({
      id: 'wasm-mp3',
      tier: 'wasm',
      matches: (q) =>
        audioDecode(q) &&
        (codec(q).startsWith('mp3') || codec(q) === 'mp4a.6b' || codec(q) === 'mp4a.69'),
      load: () => import('../codecs/wasm-mp3/wasm-mp3-driver.ts').then((m) => m.WasmMp3Driver),
    }),
    lazyCodec({
      id: 'wasm-opus',
      tier: 'wasm',
      matches: (q) => q.mediaType === 'audio' && codec(q).startsWith('opus'),
      load: () => import('../codecs/wasm-opus/wasm-opus-driver.ts').then((m) => m.WasmOpusDriver),
    }),
    lazyCodec({
      id: 'wasm-av1',
      tier: 'wasm',
      matches: (q) => videoDecode(q) && (codec(q) === 'av1' || codec(q).startsWith('av01')),
      load: () => import('../codecs/wasm-av1/wasm-av1-driver.ts').then((m) => m.WasmAv1Driver),
    }),
    lazyCodec({
      id: 'wasm-vpx',
      tier: 'wasm',
      matches: (q) =>
        videoDecode(q) &&
        (codec(q).startsWith('vp8') || codec(q).startsWith('vp9') || codec(q).startsWith('vp09')),
      load: () => import('../codecs/wasm-vpx/wasm-vpx-driver.ts').then((m) => m.WasmVpxDriver),
    }),
  ];
}

function lazyCodec(spec: LazyCodecSpec): CodecDriver {
  let driver: CodecDriver | undefined;
  let loadPromise: Promise<CodecDriver> | undefined;
  const load = async (): Promise<CodecDriver> => {
    if (driver !== undefined) return driver;
    loadPromise ??= spec.load();
    driver = await loadPromise;
    return driver;
  };
  const unavailable = (): CapabilityError =>
    new CapabilityError(`${spec.id} was not loaded`, {
      op: { kind: 'route', id: 'codec' },
      tried: [spec.id],
    });
  return {
    id: spec.id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: spec.tier,
    async supports(q: CodecQuery): Promise<CodecSupport> {
      if (!spec.matches(q)) return { supported: false, reason: `${spec.id} does not match` };
      try {
        return await (await load()).supports(q);
      } catch (error) {
        return {
          supported: false,
          reason: error instanceof Error ? error.message : `${spec.id} unavailable`,
        };
      }
    },
    createDecoder(c: DecoderConfig, o?: StageOptions): TransformStream<EncodedChunk, RawFrame> {
      const loaded = driver;
      if (loaded === undefined) throw unavailable();
      return loaded.createDecoder(c, o);
    },
    createEncoder(c: EncoderConfig, o?: StageOptions): TransformStream<RawFrame, EncodedChunk> {
      const loaded = driver;
      if (loaded === undefined) throw unavailable();
      return loaded.createEncoder(c, o);
    },
  };
}
