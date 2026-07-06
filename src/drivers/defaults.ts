/**
 * First-party driver bundle — registered into an engine on demand so `media.probe(file)` works
 * zero-config (doc 07) while the eager kernel stays tiny (ADR-004). The engine `import()`s this module
 * only on a capability miss, so it (and the container parsers it pulls in) is a lazy code-split chunk,
 * never part of the eager bundle.
 */

import type {
  DecodeImageOptions,
  ImageFormat,
  ImageInfo,
  ImageOps,
} from '../codecs/image/index.ts';
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
  Packet,
  PacketInfoTable,
  PcmTransform,
  RawFrame,
  Registry,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import type { PcmAudio } from '../dsp/index.ts';
import { AdtsModule } from './adts/adts-driver.ts';
import { AiffModule } from './aiff/aiff-driver.ts';
import { CafModule } from './caf/caf-driver.ts';
import {
  type FastFlacFrameSpan,
  fastFlacFrames,
  flacMetadataLayout,
  flacOffset,
  flacPacketInfoRows,
  flacTrackInfo,
  matchesFlac,
  parseFlacStreamInfo,
} from './flac/flac-sniff.ts';
import { Mp3Module } from './mp3/mp3-driver.ts';
import { Mp4Module } from './mp4/mp4-driver.ts';
import { OggModule } from './ogg/ogg-driver.ts';
import { WavModule } from './wav/wav-driver.ts';
import { WebmModule } from './webm/webm-driver.ts';

/**
 * Register all first-party drivers (idempotent by id): the TS containers, the WebCodecs codec tier
 * (video + audio, `tier:'hardware'`), and the GPU video filter substrates (WebGPU + Canvas2D). The
 * WebCodecs/GPU drivers `supports()` honestly report `false` where those APIs are absent (e.g. Node), so
 * registering them everywhere is safe — the router simply skips them and falls through to a typed miss.
 */
export function registerDefaultDrivers(reg: Registry): void {
  const modules: DriverModule[] = [
    Mp4Module,
    WavModule,
    Mp3Module,
    OggModule,
    WebmModule,
    AdtsModule,
    AiffModule,
    CafModule,
    WebcodecsVideoModule,
    WebCodecsAudioModule,
    // All software codec tails now co-vendor their wasm via scripts/vendor-wasm.ts (rust both-files pairs:
    // Vorbis/AAC/MP3 + dav1d AV1; self-contained inlined tails: Opus/VPx) for the lazy import.meta.url load
    // on a WebCodecs miss (ADR-042/086/090/093/094). supports()→false in Node (no VideoFrame/WebCodecs seam).
  ];
  for (const mod of modules) mod.register(reg);
  for (const driver of lazyFilterDrivers()) reg.addFilter(driver);
  (reg as Registry & { addImageOps?: (ops: ImageOps) => void }).addImageOps?.(lazyImageOps());
  reg.addContainer(lazyMpegTsContainerDriver());
  reg.addContainer(lazyFlacContainerDriver());
  reg.addContainer(lazyAviContainerDriver());
  for (const driver of lazyCodecDrivers()) reg.addCodec(driver);
}

const IMAGE_FORMATS: readonly ImageFormat[] = ['gif', 'png', 'jpeg', 'webp', 'avif'];

let imageOpsPromise: Promise<ImageOps> | undefined;

function loadImageOps(): Promise<ImageOps> {
  imageOpsPromise ??= import('../codecs/image/image-driver.ts').then((m) => m.imageOps);
  return imageOpsPromise;
}

function lazyImageOps(): ImageOps {
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

function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (bytes.byteLength >= 6 && (tag(bytes, 0, 'GIF87a') || tag(bytes, 0, 'GIF89a'))) {
    return 'gif';
  }
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.byteLength >= 12 && tag(bytes, 0, 'RIFF') && tag(bytes, 8, 'WEBP')) {
    return 'webp';
  }
  if (bytes.byteLength >= 12 && tag(bytes, 4, 'ftyp') && hasAvifBrand(bytes)) {
    return 'avif';
  }
  return undefined;
}

function hasAvifBrand(bytes: Uint8Array): boolean {
  if (brand(bytes, 8)) return true;
  const size = u32be(bytes, 0);
  const end = Math.min(size > 0 ? size : bytes.byteLength, bytes.byteLength);
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (brand(bytes, offset)) return true;
  }
  return false;
}

function brand(bytes: Uint8Array, offset: number): boolean {
  return tag(bytes, offset, 'avif') || tag(bytes, offset, 'avis');
}

function tag(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.byteLength) return false;
  for (let i = 0; i < value.length; i++) {
    if (bytes[offset + i] !== value.charCodeAt(i)) return false;
  }
  return true;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

type LazyCodecLoader = () => Promise<CodecDriver>;

interface LazyCodecSpec {
  readonly id: string;
  readonly tier: CodecDriver['tier'];
  readonly matches: (q: CodecQuery) => boolean;
  readonly load: LazyCodecLoader;
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

type LazyContainerLoader = () => Promise<ContainerDriver>;
type LazyFilterLoader = () => Promise<FilterDriver>;

const TS_MIMES = new Set([
  'video/mp2t',
  'video/MP2T',
  'video/mpeg',
  'application/x-mpegts',
  'audio/mp2t',
]);
const TS_EXTENSIONS = new Set(['ts', 'm2ts', 'mts', 'm2t']);
const FLAC_PROBE_HEAD_BYTES = 4096;

function lazyMpegTsContainerDriver(): ContainerDriver {
  let driver: ContainerDriver | undefined;
  let loadPromise: Promise<ContainerDriver> | undefined;
  const load: LazyContainerLoader = async (): Promise<ContainerDriver> => {
    if (driver !== undefined) return driver;
    loadPromise ??= import('./mpegts/mpegts-driver.ts').then((m) => m.MpegTsDriver);
    driver = await loadPromise;
    return driver;
  };
  return {
    id: 'mpegts',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['ts', 'm2ts', 'mts'],
    supports: matchesMpegTs,
    async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
      return (driver ?? (await load())).demux(src, o);
    },
    async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
      const loaded = driver ?? (await load());
      if (loaded.streamCopy === undefined) throw missingLazyMethod('mpegts', 'streamCopy');
      return loaded.streamCopy(src, o);
    },
    async decrypt(src: ByteSource, o: DecryptParams): Promise<ReadableStream<Uint8Array>> {
      const loaded = driver ?? (await load());
      if (loaded.decrypt === undefined) throw missingLazyMethod('mpegts', 'decrypt');
      return loaded.decrypt(src, o);
    },
    createMuxer(o?: MuxOptions): Muxer {
      return new LazyContainerMuxer(load, o);
    },
  };
}

function matchesMpegTs(q: ContainerQuery): boolean {
  if (q.mime !== undefined && TS_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && TS_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  if (head !== undefined && head.byteLength >= 189) {
    return head[0] === 0x47 && head[188] === 0x47;
  }
  return false;
}

function lazyFlacContainerDriver(): ContainerDriver {
  let driver: ContainerDriver | undefined;
  let loadPromise: Promise<ContainerDriver> | undefined;
  const load: LazyContainerLoader = async (): Promise<ContainerDriver> => {
    if (driver !== undefined) return driver;
    loadPromise ??= import('./flac/flac-driver.ts').then((m) => m.FlacDriver);
    driver = await loadPromise;
    return driver;
  };
  return {
    id: 'flac',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['flac'],
    supports(q: ContainerQuery): boolean {
      return matchesFlac(q);
    },
    async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
      if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      const info = parseFlacStreamInfo(await readFlacProbeBytes(src));
      if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      return [flacTrackInfo(info)];
    },
    async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
      const bytes = await readFlacBytes(src);
      if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      const layout = flacMetadataLayout(bytes);
      const frames = fastFlacFrames(bytes, layout);
      if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      return {
        tracks: [flacTrackInfo(layout.info, bytes.slice(layout.start, layout.audioStart))],
        packets: flacPacketInfoRows(frames),
      };
    },
    async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
      const bytes = await readFlacBytes(src);
      const layout = flacMetadataLayout(bytes);
      const frames = fastFlacFrames(bytes, layout);
      const track = flacTrackInfo(layout.info, bytes.slice(layout.start, layout.audioStart));
      return {
        tracks: [track],
        packets(trackId: number): ReadableStream<Packet> {
          if (trackId !== 0) throw new MediaError('demux-error', `no track ${trackId}`);
          return flacPacketStream(bytes, frames, o?.signal);
        },
        close: () => Promise.resolve(),
      };
    },
    createMuxer(o?: MuxOptions): Muxer {
      return new LazyFlacMuxer(load, o);
    },
    async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
      const streamCopy = (await load()).streamCopy;
      if (streamCopy === undefined) throw missingLazyMethod('flac', 'streamCopy');
      return streamCopy(src, o);
    },
    async decodePcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
      const decodePcm = (await load()).decodePcm;
      if (decodePcm === undefined) throw missingLazyMethod('flac', 'decodePcm');
      return decodePcm(src, o);
    },
    async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
      const decodePcmAudio = (await load()).decodePcmAudio;
      if (decodePcmAudio === undefined) throw missingLazyMethod('flac', 'decodePcmAudio');
      return decodePcmAudio(src, o);
    },
    async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
      const transformPcm = (await load()).transformPcm;
      if (transformPcm === undefined) throw missingLazyMethod('flac', 'transformPcm');
      return transformPcm(src, o);
    },
  };
}

async function readFlacProbeBytes(src: ByteSource): Promise<Uint8Array> {
  if (src.range !== undefined) {
    const head = await src.range(0, FLAC_PROBE_HEAD_BYTES);
    const need = flacOffset(head) + 42;
    if (head.byteLength >= need) return head;
    return src.range(0, need);
  }
  return readByteStream(src.stream());
}

async function readFlacBytes(src: ByteSource): Promise<Uint8Array> {
  if (src.range !== undefined && src.size !== undefined) return src.range(0, src.size);
  return readByteStream(src.stream());
}

function flacPacketStream(
  bytes: Uint8Array,
  frames: readonly FastFlacFrameSpan[],
  signal: AbortSignal | undefined,
): ReadableStream<Packet> {
  if (typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'capability-miss',
      'FLAC packet demux requires the browser codec layer (WebCodecs EncodedAudioChunk)',
      { op: 'demux', tried: ['flac'] },
    );
  }
  let i = 0;
  return new ReadableStream<Packet>({
    pull(controller): void {
      if (signal?.aborted) {
        controller.error(new MediaError('aborted', 'operation aborted'));
        return;
      }
      const frame = frames[i];
      if (frame === undefined) {
        controller.close();
        return;
      }
      i++;
      const data = bytes.slice(frame.offset, frame.offset + frame.size);
      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: frame.ptsUs,
        duration: frame.durationUs,
        data,
      });
      controller.enqueue({ chunk, data, sizeBytes: frame.size });
    },
  });
}

async function readByteStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const AVI_MIMES = new Set(['video/avi', 'video/x-msvideo', 'video/msvideo', 'video/vnd.avi']);

function lazyAviContainerDriver(): ContainerDriver {
  let driver: ContainerDriver | undefined;
  let loadPromise: Promise<ContainerDriver> | undefined;
  const load: LazyContainerLoader = async (): Promise<ContainerDriver> => {
    if (driver !== undefined) return driver;
    loadPromise ??= import('./avi/avi-driver.ts').then((m) => m.AviDriver);
    driver = await loadPromise;
    return driver;
  };
  return {
    id: 'avi',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['avi'],
    supports: matchesAvi,
    async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
      return (await load()).demux(src, o);
    },
    createMuxer(o?: MuxOptions): Muxer {
      return new LazyContainerMuxer(load, o);
    },
  };
}

function matchesAvi(q: ContainerQuery): boolean {
  if (q.mime !== undefined && AVI_MIMES.has(q.mime)) return true;
  if (q.extension?.toLowerCase() === 'avi') return true;
  const head = q.head;
  return (
    head !== undefined &&
    head.byteLength >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x41 &&
    head[9] === 0x56 &&
    head[10] === 0x49 &&
    head[11] === 0x20
  );
}

function missingLazyMethod(id: string, method: string): CapabilityError {
  return new CapabilityError('capability-miss', `lazy ${id} driver lacks ${method}`, {
    op: id,
    tried: [id],
  });
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
      supports: (spec) => spec.mediaType === 'video' && typeof VideoFrame !== 'undefined',
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
        throw new CapabilityError(
          'capability-miss',
          `${options.id} does not support ${spec.type}`,
          {
            op: 'filter',
            tried: [options.id],
          },
        );
      }
      return createLazyFilterStream(async () => (await load()).createFilter(spec, stage));
    },
  };
}

function createLazyFilterStream(
  create: () => Promise<
    TransformStream<VideoFrame, VideoFrame> | TransformStream<AudioData, AudioData>
  >,
): TransformStream<VideoFrame, VideoFrame> | TransformStream<AudioData, AudioData> {
  let writer: WritableStreamDefaultWriter<RawFrame> | undefined;
  let reader: ReadableStreamDefaultReader<RawFrame> | undefined;
  let pump: Promise<void> | undefined;

  const ensure = async (
    controller: TransformStreamDefaultController<RawFrame>,
  ): Promise<WritableStreamDefaultWriter<RawFrame>> => {
    if (writer !== undefined) return writer;
    const stream = (await create()) as TransformStream<RawFrame, RawFrame>;
    writer = stream.writable.getWriter();
    reader = stream.readable.getReader();
    pump = (async (): Promise<void> => {
      const activeReader = reader;
      if (activeReader === undefined) return;
      try {
        for (;;) {
          const { done, value } = await activeReader.read();
          if (done) return;
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      } finally {
        activeReader.releaseLock();
      }
    })();
    return writer;
  };

  return new TransformStream<RawFrame, RawFrame>(
    {
      async transform(frame, controller): Promise<void> {
        let activeWriter: WritableStreamDefaultWriter<RawFrame>;
        try {
          activeWriter = await ensure(controller);
        } catch (error) {
          frame.close();
          throw error;
        }
        await activeWriter.write(frame);
      },
      async flush(): Promise<void> {
        if (writer === undefined) return;
        await writer.close();
        await pump;
      },
    },
    { highWaterMark: 0 },
    { highWaterMark: 1 },
  ) as TransformStream<VideoFrame, VideoFrame> | TransformStream<AudioData, AudioData>;
}

function webgpuFilterSupports(spec: FilterSpec): boolean {
  return spec.mediaType === 'video' && spec.type !== 'tonemap' && webgpuAvailable();
}

function canvas2dFilterSupports(spec: FilterSpec): boolean {
  if (!canvas2dAvailable()) return false;
  if (isGeometricVideoFilterSpec(spec)) return true;
  if (spec.mediaType === 'video' && spec.type === 'tonemap') return chromiumCanvasTonemapAvailable();
  return spec.mediaType === 'video' && spec.type === 'colorspace' && isDisplayColorToken(spec.to);
}

function webgpuAvailable(): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/\bFirefox\//.test(ua)) return false;
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { gpu?: unknown }).gpu !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof VideoFrame !== 'undefined'
  );
}

function canvas2dAvailable(): boolean {
  return typeof OffscreenCanvas !== 'undefined' && typeof VideoFrame !== 'undefined';
}

function chromiumCanvasTonemapAvailable(): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /\b(?:Chrome|Chromium|CriOS|Edg)\//.test(ua) && !/\bFirefox\//.test(ua);
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

class LazyFlacMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;
  readonly #load: LazyContainerLoader;
  readonly #options: MuxOptions | undefined;
  readonly #ready: Promise<void>;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #resolveReady: (() => void) | undefined;
  #muxer: Muxer | undefined;
  #track: TrackInfo | undefined;
  #targetTrackId: number | undefined;

  constructor(load: LazyContainerLoader, options?: MuxOptions) {
    this.#load = load;
    this.#options = options;
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        this.#resolveReady?.();
      },
    });
  }

  addTrack(info: TrackInfo): number {
    if (this.#track !== undefined) {
      throw new CapabilityError('capability-miss', 'the FLAC muxer writes a single audio stream', {
        op: { op: 'mux' },
        tried: ['flac'],
      });
    }
    if (info.mediaType !== 'audio' || info.codec !== 'flac') {
      throw new CapabilityError(
        'capability-miss',
        `FLAC container carries a single FLAC audio track, not ${info.mediaType}/${info.codec}`,
        { op: { op: 'mux' }, tried: ['flac'] },
      );
    }
    this.#track = info;
    return 0;
  }

  async write(trackId: number, packet: Packet): Promise<void> {
    const muxer = await this.#ensureMuxer();
    await muxer.write(this.#targetTrackId ?? trackId, packet);
  }

  async finalize(): Promise<void> {
    const muxer = await this.#ensureMuxer();
    await muxer.finalize();
  }

  async #ensureMuxer(): Promise<Muxer> {
    if (this.#muxer !== undefined) return this.#muxer;
    try {
      const driver = await this.#load();
      const muxer = driver.createMuxer(this.#options);
      this.#muxer = muxer;
      this.#pumpOutput(muxer.output);
      if (this.#track !== undefined) this.#targetTrackId = muxer.addTrack(this.#track);
      return muxer;
    } catch (error) {
      await this.#errorOutput(error);
      throw error;
    }
  }

  #pumpOutput(output: ReadableStream<Uint8Array>): void {
    void (async (): Promise<void> => {
      await this.#ready;
      const controller = this.#controller;
      if (controller === undefined) return;
      const reader = output.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    })();
  }

  async #errorOutput(error: unknown): Promise<void> {
    await this.#ready;
    this.#controller?.error(error);
  }
}

class LazyContainerMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;
  readonly #load: LazyContainerLoader;
  readonly #options: MuxOptions | undefined;
  readonly #ready: Promise<void>;
  readonly #tracks: TrackInfo[] = [];
  readonly #targetTrackIds: number[] = [];
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #resolveReady: (() => void) | undefined;
  #muxer: Muxer | undefined;

  constructor(load: LazyContainerLoader, options?: MuxOptions) {
    this.#load = load;
    this.#options = options;
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        this.#resolveReady?.();
      },
    });
  }

  addTrack(info: TrackInfo): number {
    const id = this.#tracks.length;
    this.#tracks.push(info);
    if (this.#muxer !== undefined) {
      this.#targetTrackIds[id] = this.#muxer.addTrack(info);
    }
    return id;
  }

  async write(trackId: number, packet: Packet): Promise<void> {
    const muxer = await this.#ensureMuxer();
    const targetTrackId = this.#targetTrackIds[trackId];
    if (targetTrackId === undefined)
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    await muxer.write(targetTrackId, packet);
  }

  async finalize(): Promise<void> {
    const muxer = await this.#ensureMuxer();
    await muxer.finalize();
  }

  async #ensureMuxer(): Promise<Muxer> {
    if (this.#muxer !== undefined) return this.#muxer;
    try {
      const driver = await this.#load();
      const muxer = driver.createMuxer(this.#options);
      this.#muxer = muxer;
      this.#pumpOutput(muxer.output);
      for (const track of this.#tracks) this.#targetTrackIds.push(muxer.addTrack(track));
      return muxer;
    } catch (error) {
      await this.#errorOutput(error);
      throw error;
    }
  }

  #pumpOutput(output: ReadableStream<Uint8Array>): void {
    void (async (): Promise<void> => {
      await this.#ready;
      const controller = this.#controller;
      if (controller === undefined) return;
      const reader = output.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    })();
  }

  async #errorOutput(error: unknown): Promise<void> {
    await this.#ready;
    this.#controller?.error(error);
  }
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
    new CapabilityError('capability-miss', `${spec.id} was not loaded`, {
      op: 'codec',
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
