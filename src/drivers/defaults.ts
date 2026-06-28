/**
 * First-party driver bundle — registered into an engine on demand so `media.probe(file)` works
 * zero-config (doc 07) while the eager kernel stays tiny (ADR-004). The engine `import()`s this module
 * only on a capability miss, so it (and the container parsers it pulls in) is a lazy code-split chunk,
 * never part of the eager bundle.
 */

import { ImageModule } from '../codecs/image/image-driver.ts';
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
  Demuxer,
  DriverModule,
  EncodedChunk,
  EncoderConfig,
  MuxOptions,
  Muxer,
  Packet,
  PcmTransform,
  RawFrame,
  Registry,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import type { PcmAudio } from '../dsp/index.ts';
import { AudioDspFilterModule } from '../filters/audio-dsp.ts';
import { CpuVideoFilterModule } from '../filters/cpu-video.ts';
import { GpuVideoFilterModule } from '../filters/gpu-video.ts';
import { AdtsModule } from './adts/adts-driver.ts';
import { AiffModule } from './aiff/aiff-driver.ts';
import { AviModule } from './avi/avi-driver.ts';
import { CafModule } from './caf/caf-driver.ts';
import { matchesFlac } from './flac/flac-sniff.ts';
import { Mp3Module } from './mp3/mp3-driver.ts';
import { Mp4Module } from './mp4/mp4-driver.ts';
import { MpegTsModule } from './mpegts/mpegts-driver.ts';
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
    MpegTsModule,
    AiffModule,
    AviModule,
    CafModule,
    WebcodecsVideoModule,
    WebCodecsAudioModule,
    GpuVideoFilterModule,
    AudioDspFilterModule, // audio filters (resample/remix/gain) over AudioData (ADR-033)
    CpuVideoFilterModule, // CPU video filter fallback (no-WebGPU browsers): colorspace/tonemap/geometry (ADR-038)
    ImageModule, // still/animated image probe + browser ImageDecoder decode capability (ADR-049)
    // All software codec tails now co-vendor their wasm via scripts/vendor-wasm.ts (rust both-files pairs:
    // Vorbis/AAC/MP3 + dav1d AV1; self-contained inlined tails: Opus/VPx) for the lazy import.meta.url load
    // on a WebCodecs miss (ADR-042/086/090/093/094). supports()→false in Node (no VideoFrame/WebCodecs seam).
  ];
  for (const mod of modules) mod.register(reg);
  reg.addContainer(lazyFlacContainerDriver());
  for (const driver of lazyCodecDrivers()) reg.addCodec(driver);
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

type FlacContainerLoader = () => Promise<ContainerDriver>;

function lazyFlacContainerDriver(): ContainerDriver {
  let driver: ContainerDriver | undefined;
  let loadPromise: Promise<ContainerDriver> | undefined;
  const load: FlacContainerLoader = async (): Promise<ContainerDriver> => {
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
    async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
      return (await load()).demux(src, o);
    },
    createMuxer(o?: MuxOptions): Muxer {
      return new LazyFlacMuxer(load, o);
    },
    async decodePcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
      const decodePcm = (await load()).decodePcm;
      if (decodePcm === undefined) throw missingFlacMethod('decodePcm');
      return decodePcm(src, o);
    },
    async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
      const decodePcmAudio = (await load()).decodePcmAudio;
      if (decodePcmAudio === undefined) throw missingFlacMethod('decodePcmAudio');
      return decodePcmAudio(src, o);
    },
    async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
      const transformPcm = (await load()).transformPcm;
      if (transformPcm === undefined) throw missingFlacMethod('transformPcm');
      return transformPcm(src, o);
    },
  };
}

function missingFlacMethod(method: string): CapabilityError {
  return new CapabilityError('capability-miss', `lazy FLAC driver did not expose ${method}`, {
    op: 'flac',
    tried: ['flac'],
  });
}

class LazyFlacMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;
  readonly #load: FlacContainerLoader;
  readonly #options: MuxOptions | undefined;
  readonly #ready: Promise<void>;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #resolveReady: (() => void) | undefined;
  #muxer: Muxer | undefined;
  #track: TrackInfo | undefined;
  #targetTrackId: number | undefined;

  constructor(load: FlacContainerLoader, options?: MuxOptions) {
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
