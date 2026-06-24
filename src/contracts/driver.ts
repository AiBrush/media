/**
 * Driver contracts (v1) — the canonical kernel/backend boundary (docs/architecture/05 §2, ADR-016).
 *
 * Three driver kinds map to the two data-flow seams: `CodecDriver` (decode/encode one codec),
 * `ContainerDriver` (demux/mux one container family), `FilterDriver` (transform frames). Encoded units
 * and raw frames are WebCodecs-native types so any stage's substrate can change without touching its
 * neighbours. Drivers *declare* (`supports()`); the router *decides*.
 *
 * This file is the source of truth for the contract types. Changing any shape here is a
 * `DRIVER_API_VERSION` event (§5).
 */

// ============ versioning ============

/** The driver-contract major version. Bumped only on a breaking driver-contract change (§5). */
export const DRIVER_API_VERSION = 1 as const;

// ============ shared ============

/** A substrate's rank for a stage; the router tries best-first. */
export type Tier = 'hardware' | 'gpu' | 'native' | 'wasm';
export type MediaType = 'video' | 'audio';

/** How far the router may go in the tier ladder (ADR-007). */
export type Determinism = 'auto' | 'force-software';

/** Options threaded through every stage. */
export interface StageOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  /** `force-software` drops the hardware/gpu tiers for cross-machine reproducibility. */
  determinism?: Determinism;
}

/** Monotonic progress signal derived from timestamps against a known duration. */
export interface Progress {
  done: number;
  total?: number;
  stage: string;
}

// WebCodecs-native units flow across the seams:

/** The container ↔ codec seam: an encoded packet. */
export type EncodedChunk = EncodedVideoChunk | EncodedAudioChunk;
/** The codec ↔ filter seam: a decoded frame (ref-counted; must be `close()`d exactly once). */
export type RawFrame = VideoFrame | AudioData;

/** Common identity every driver declares. */
export interface DriverBase {
  /** Unique driver id, e.g. 'webcodecs-video', 'wasm-flac', 'mp4'. */
  readonly id: string;
  /** The {@link DRIVER_API_VERSION} this driver was built against (checked at registration). */
  readonly apiVersion: number;
}

// ============ 1) CodecDriver ============

export type DecoderConfig = VideoDecoderConfig | AudioDecoderConfig;
export type EncoderConfig = VideoEncoderConfig | AudioEncoderConfig;

export interface CodecQuery {
  mediaType: MediaType;
  direction: 'decode' | 'encode';
  config: DecoderConfig | EncoderConfig;
}

export interface CodecSupport {
  supported: boolean;
  hardwareAccelerated?: boolean;
  reason?: string;
}

/**
 * Decode or encode exactly one codec on one substrate. A coder is a `TransformStream`: it configures
 * its WebCodecs/WASM object on start, processes each chunk, and flushes on writable close. Cancellation
 * (`signal`) releases resources and `close()`s in-flight frames.
 */
export interface CodecDriver extends DriverBase {
  readonly kind: 'codec';
  readonly tier: Tier;
  /** Cheap, honest capability check (wraps `isConfigSupported`); returns `false`, never throws later. */
  supports(q: CodecQuery): Promise<CodecSupport>;
  createDecoder(c: DecoderConfig, o?: StageOptions): TransformStream<EncodedChunk, RawFrame>;
  createEncoder(c: EncoderConfig, o?: StageOptions): TransformStream<RawFrame, EncodedChunk>;
}

// ============ 2) ContainerDriver ============

/** A byte source with optional random access (enables header-only probe). */
export interface ByteSource {
  stream(): ReadableStream<Uint8Array>;
  size?: number;
  range?(start: number, end: number): Promise<Uint8Array>;
}

export interface ContainerQuery {
  direction: 'demux' | 'mux';
  mime?: string;
  extension?: string;
  /** Magic bytes from the source head (e.g. `ftyp`, EBML `1A45DFA3`, `RIFF…WAVE`, `fLaC`, `OggS`). */
  head?: Uint8Array;
}

export interface TrackInfo {
  id: number;
  mediaType: MediaType;
  codec: string;
  durationSec?: number;
  /** Video frame rate (frames ÷ duration) and display rotation in degrees, when known. */
  fps?: number;
  rotation?: number;
  /** WebCodecs config: video coded dims/rotation/fps; audio sampleRate/channels. */
  config?: DecoderConfig;
}

/** A live demux session: per-track lazy packet streams. */
export interface Demuxer {
  readonly tracks: readonly TrackInfo[];
  packets(trackId: number): ReadableStream<EncodedChunk>;
  close(): Promise<void>;
}

export interface MuxOptions {
  faststart?: boolean;
  fragmented?: boolean;
}

/** A live mux session: add tracks, write packets (preserving PTS/duration), finalize. */
export interface Muxer {
  readonly output: ReadableStream<Uint8Array>;
  addTrack(info: TrackInfo): number;
  write(trackId: number, chunk: EncodedChunk): Promise<void>;
  finalize(): Promise<void>;
}

/** Options for a driver-native stream-copy (remux / keyframe-trim), ADR-021. */
export interface StreamCopyOptions extends StageOptions {
  /** Keyframe-aligned time-range copy (trim), in seconds. Omit for a full remux. */
  trim?: { startSec: number; endSec: number };
  faststart?: boolean;
  fragmented?: boolean;
}

/**
 * A PCM-domain audio transform for containers that carry raw PCM (ADR-022). PCM is not a WebCodecs
 * codec, so these run in the TS audio-dsp path — channel up/down-mix, gain, and (where the tail is
 * available) resample — without the decode/encode + `AudioData` filter seam. Omitted fields pass
 * through; `sampleRate` differing from the source needs the resample tail (else a `CapabilityError`).
 */
export interface PcmTransform extends StageOptions {
  channels?: number;
  sampleRate?: number;
  gainDb?: number;
}

/** Options for a driver-native decrypt (CENC / HLS sample decryption), ADR-023. */
export interface DecryptParams extends StageOptions {
  scheme: 'cenc' | 'cbcs' | 'hls-aes128';
  /** keyId(hex) → key(hex). For CENC, keyed by the track's `tenc` default_KID. */
  keys: Record<string, string>;
}

/** Demux/mux one container family (e.g. ['mp4','mov']). `supports()` is synchronous (magic/mime). */
export interface ContainerDriver extends DriverBase {
  readonly kind: 'container';
  readonly formats: readonly string[];
  supports(q: ContainerQuery): boolean;
  demux(src: ByteSource, o?: StageOptions): Promise<Demuxer>;
  createMuxer(o?: MuxOptions): Muxer;
  /**
   * Optional lossless same-container stream-copy — a full remux, or a keyframe-aligned trim when
   * `trim` is given — bypassing the PTS-only codec seam so DTS/B-frames/codec-private survive
   * (ADR-021). The router uses it when in/out are the same container; absent ⇒ fall back to the seam.
   */
  streamCopy?(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>>;
  /**
   * Optional PCM-native audio transform (ADR-022) for raw-PCM containers (e.g. WAV) — applies
   * {@link PcmTransform} in the TS audio-dsp path and re-serializes the same container. Source
   * sample-format is preserved (lossless); absent ⇒ the engine falls back to the codec seam.
   */
  transformPcm?(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>>;
  /**
   * Optional driver-native sample decryption (ADR-023): parse the container's protection boxes,
   * decrypt with the caller's keys (WebCrypto), and re-serialize cleartext. Absent ⇒ typed miss.
   */
  decrypt?(src: ByteSource, o: DecryptParams): Promise<ReadableStream<Uint8Array>>;
  /**
   * Optional decode of a compressed-audio container to a raw-PCM (WAV) byte stream (ADR-024) — e.g.
   * FLAC → WAV, in pure TS — applying the {@link PcmTransform}. Absent ⇒ the WebCodecs/WASM codec seam.
   */
  decodePcm?(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>>;
}

// ============ 3) FilterDriver ============

/** A declarative pixel/audio transform. The driver matches the spec's `mediaType`. */
export type FilterSpec =
  | {
      mediaType: 'video';
      type: 'resize';
      width: number;
      height: number;
      fit?: 'contain' | 'cover' | 'fill';
    }
  | { mediaType: 'video'; type: 'crop'; x: number; y: number; width: number; height: number }
  | { mediaType: 'video'; type: 'rotate'; degrees: 0 | 90 | 180 | 270 }
  | { mediaType: 'video'; type: 'flip'; axis: 'h' | 'v' }
  | { mediaType: 'video'; type: 'colorspace'; to: string }
  | { mediaType: 'video'; type: 'tonemap'; to: 'sdr' }
  | { mediaType: 'audio'; type: 'resample'; sampleRate: number }
  | { mediaType: 'audio'; type: 'remix'; channels: number }
  | { mediaType: 'audio'; type: 'gain'; db: number };

/** The substrate a filter runs on; the router ranks WebGPU → WebGL → Canvas2D → WASM. */
export type FilterSubstrate = 'webgpu' | 'webgl' | 'canvas2d' | 'wasm';

export interface FilterDriver extends DriverBase {
  readonly kind: 'filter';
  readonly substrate: FilterSubstrate;
  supports(f: FilterSpec): boolean;
  /** Returns a stream matching the spec's `mediaType`. */
  createFilter(
    f: FilterSpec,
    o?: StageOptions,
  ): TransformStream<VideoFrame, VideoFrame> | TransformStream<AudioData, AudioData>;
}

// ============ registration ============

/** Drivers register themselves here, by kind. */
export interface Registry {
  addCodec(d: CodecDriver): void;
  addContainer(d: ContainerDriver): void;
  addFilter(d: FilterDriver): void;
}

/** A lazily-imported driver chunk default-exports a {@link DriverModule}. */
export interface DriverModule {
  /** Checked against {@link DRIVER_API_VERSION} at registration. */
  readonly apiVersion: number;
  register(reg: Registry): void;
}

/** Any of the three concrete driver kinds. */
export type AnyDriver = CodecDriver | ContainerDriver | FilterDriver;
