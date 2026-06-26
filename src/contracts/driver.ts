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

import type { BiquadSpec } from '../dsp/biquad.ts';
import type { DynamicsSpec, LimitMode } from '../dsp/dynamics.ts';
import type { FadeShape } from '../dsp/fade.ts';
import type { Endianness, PcmAudio, SampleFormat } from '../dsp/pcm.ts';

// ============ versioning ============

/** The driver-contract major version. Bumped only on a breaking driver-contract change (§5). */
export const DRIVER_API_VERSION = 1 as const;

// ============ shared ============

/** A substrate's rank for a stage; the router tries best-first. */
export type Tier = 'hardware' | 'gpu' | 'native' | 'wasm';
export type MediaType = 'video' | 'audio';

/** How far the router may go in the tier ladder (ADR-007). */
export type Determinism = 'auto' | 'force-software';

export type WasmRuntimeProfileKind = 'baseline' | 'isolated-simd-threads';

/** Runtime profile a WASM driver may use when it is actually built (ADR-006). */
export interface WasmRuntimeProfile {
  readonly kind: WasmRuntimeProfileKind;
  readonly simd: boolean;
  readonly threads: boolean;
  /** True only when `SharedArrayBuffer` is safe to use in a cross-origin-isolated page. */
  readonly sharedArrayBuffer: boolean;
  readonly reason?: string;
}

/** Options threaded through every stage. */
export interface StageOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  /** `force-software` drops the hardware/gpu tiers for cross-machine reproducibility. */
  determinism?: Determinism;
  /** WASM execution profile. Omitted means drivers resolve ADR-006 from the current runtime. */
  wasmRuntime?: WasmRuntimeProfile;
}

/** Monotonic progress signal derived from timestamps against a known duration. */
export interface Progress {
  done: number;
  total?: number;
  stage: string;
}

// WebCodecs-native units flow across the seams:

/** The container ↔ codec seam: a sealed WebCodecs encoded unit (its `timestamp` is the PTS). */
export type EncodedChunk = EncodedVideoChunk | EncodedAudioChunk;
/** The codec ↔ filter seam: a decoded frame (ref-counted; must be `close()`d exactly once). */
export type RawFrame = VideoFrame | AudioData;

/**
 * The container ↔ codec seam **packet** (ADR-045): a sealed {@link EncodedChunk} plus its optional
 * **decode** timestamp. `EncodedVideoChunk`/`EncodedAudioChunk` are immutable host objects exposing
 * only `timestamp` (the *presentation* time, PTS); a reordered stream (B-frames / open-GOP) additionally
 * needs DTS to (a) enumerate packets in decode order and (b) remux losslessly — MP4 stores DTS + a
 * per-sample composition offset, and a Matroska/WebM muxer must lay blocks down in decode order. `dtsUs`
 * carries it alongside the sealed chunk; **`undefined` ⇒ DTS equals the chunk's PTS** (no reordering).
 * `sizeBytes`, when present, is the container packet's byte size for oracles/diagnostics whose packet
 * unit is wider than the decoder access unit (e.g. ADTS: header+payload on disk, raw AAC AU in
 * WebCodecs). Demuxers attach these facts from container tables/headers; muxers honor DTS and copy the
 * bare {@link chunk} bytes; decoders ignore both side fields. A pure data view — no resources to release
 * (the chunk owns its bytes).
 */
export interface Packet {
  /** The sealed WebCodecs encoded unit: the coded bytes, the keyframe flag, and `timestamp` = PTS. */
  readonly chunk: EncodedChunk;
  /** Decode timestamp (µs); omitted ⇒ equals the chunk's presentation `timestamp` (no reorder). */
  readonly dtsUs?: number;
  /** Container packet byte length; omitted ⇒ equals `chunk.byteLength`. */
  readonly sizeBytes?: number;
}

/** Packet-table metadata for consumers that need container packet facts but not payload bytes. */
export interface PacketMetadata {
  /** Track id from {@link TrackInfo.id}. */
  readonly trackId: number;
  /** Container packet byte length. */
  readonly sizeBytes: number;
  /** Presentation timestamp in microseconds. */
  readonly ptsUs: number;
  /** Decode timestamp in microseconds. */
  readonly dtsUs: number;
  /** Packet duration in microseconds. */
  readonly durationUs: number;
  readonly keyframe: boolean;
}

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
  /** True when encoded samples are protected and must be decrypted before generic decode/seek. */
  encrypted?: boolean;
  /** WebCodecs config: video coded dims/rotation/fps; audio sampleRate/channels. */
  config?: DecoderConfig;
}

/** A live demux session: per-track lazy packet streams ({@link Packet} carries PTS + optional DTS). */
export interface Demuxer {
  readonly tracks: readonly TrackInfo[];
  /** Optional packet-table fast path: no encoded payload bytes are read or materialized. */
  packetTable?(): readonly PacketMetadata[];
  packets(trackId: number): ReadableStream<Packet>;
  close(): Promise<void>;
}

export interface MuxOptions {
  faststart?: boolean;
  fragmented?: boolean;
  /**
   * The target container token the caller requested (one of the driver's {@link ContainerDriver.formats}).
   * Lets a multi-format driver pick the right on-disk flavor — e.g. the MP4 driver writes a QuickTime
   * `ftyp` for `'mov'` vs an ISO `ftyp` for `'mp4'`. Omitted ⇒ the driver's primary format.
   */
  container?: string;
}

/** A live mux session: add tracks, write packets (preserving PTS/DTS/duration), finalize. */
export interface Muxer {
  readonly output: ReadableStream<Uint8Array>;
  addTrack(info: TrackInfo): number;
  write(trackId: number, packet: Packet): Promise<void>;
  finalize(): Promise<void>;
}

/** Options for a driver-native stream-copy (remux / keyframe-trim), ADR-021. */
export interface StreamCopyOptions extends StageOptions {
  /** Keyframe-aligned time-range copy (trim), in seconds. Omit for a full remux. */
  trim?: { startSec: number; endSec: number };
  faststart?: boolean;
  fragmented?: boolean;
  /**
   * The target container token (one of the driver's {@link ContainerDriver.formats}); lets a
   * multi-format driver pick the right flavor (e.g. MP4 vs QuickTime `ftyp`). Omitted ⇒ primary format.
   */
  container?: string;
}

/**
 * A PCM-domain audio transform for containers that carry raw PCM (ADR-022). PCM is not a WebCodecs
 * codec, so these run in the TS audio-dsp path — sample-format conversion, channel up/down-mix, gain,
 * fade, resample, dynamics, and biquad/EQ — without the decode/encode + `AudioData` filter seam.
 * Omitted fields pass through. `container` names the raw-PCM wrapper to serialize after the source driver
 * has parsed its own bytes; this is how WAV/AIFF/CAF cross-container PCM conversion stays outside the
 * EncodedChunk muxer seam.
 */
export type PcmContainer = 'wav' | 'aiff' | 'caf';

export interface PcmFade {
  inSec?: number;
  outSec?: number;
  curve?: 'linear' | 'equal-power';
}

export interface PcmDynamicsNormalize {
  mode: 'peak' | 'rms';
  targetDbfs: number;
}

export interface PcmDynamicsLimit {
  ceilingDbfs?: number;
  mode?: LimitMode;
  knee?: number;
}

export interface PcmDynamics {
  normalize?: PcmDynamicsNormalize;
  limit?: PcmDynamicsLimit;
}

export type PcmBiquad = BiquadSpec;

export interface PcmTransform extends StageOptions {
  container?: PcmContainer;
  sampleFormat?: SampleFormat;
  endian?: Endianness;
  channels?: number;
  sampleRate?: number;
  gainDb?: number;
  fade?: PcmFade;
  dynamics?: PcmDynamics;
  biquad?: PcmBiquad | readonly PcmBiquad[];
  /**
   * Sample-accurate time-range cut applied **first**, in the source's own sample rate, before any
   * gain/fade/remix/resample (ADR-021 trim via the PCM-native path). `[startSec, endSec)` is clamped to the
   * buffer; PCM has no inter-frame dependency, so a raw-PCM container (WAV/AIFF/CAF) trims losslessly by
   * slicing samples — no codec seam, frame-exact, and Node-validatable. Absent ⇒ no cut (a full transform).
   */
  timeBounds?: { readonly startSec: number; readonly endSec: number };
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
   * sample-format/endianness are preserved unless the transform asks for a target format; absent ⇒ the
   * engine falls back to the codec seam.
   */
  transformPcm?(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>>;
  /**
   * Optional driver-native sample decryption (ADR-023): parse the container's protection boxes,
   * decrypt with the caller's keys (WebCrypto), and re-serialize cleartext. Absent ⇒ typed miss.
   */
  decrypt?(src: ByteSource, o: DecryptParams): Promise<ReadableStream<Uint8Array>>;
  /**
   * Optional decode of a compressed-audio container to a raw-PCM (WAV) byte stream (ADR-024/050) — e.g.
   * FLAC → WAV in pure TS, or ADTS AAC → WAV through native WebCodecs / the wasm tail — applying the
   * {@link PcmTransform}. Absent ⇒ the WebCodecs/WASM codec seam.
   */
  decodePcm?(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>>;
  /**
   * Optional decode of a raw-PCM container to canonical planar PCM for the public `decode()` frame stream.
   * The engine wraps the returned samples as browser `AudioData` chunks; Node/unsupported browsers raise
   * a typed capability miss before constructing frames. Absent ⇒ the WebCodecs/WASM codec seam.
   */
  decodePcmAudio?(src: ByteSource, o?: StageOptions): Promise<PcmAudio>;
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
  | { mediaType: 'audio'; type: 'gain'; db: number }
  // ── stream-stateful audio variants (codec seam; ADR — lossy-seam audio filter) ──────────────────
  // These three carry state across `AudioData` chunk boundaries (fade tail look-ahead, persisted biquad
  // registers, a whole-signal normalize buffer), so fade/dynamics/biquad work BEFORE a lossy encode and
  // not only on the PCM-native `transformPcm` path. Each carries the **resolved** kernel inputs (frame
  // counts / coefficients / dBFS targets) so the spec is self-describing and pure to plan & validate.
  /** Sample-accurate fade-in/out at resolved source-rate frame counts; a duration-aware streaming stage. */
  | { mediaType: 'audio'; type: 'fade'; curve: FadeShape; inFrames: number; outFrames: number }
  /** One RBJ biquad (DF2T) whose state persists across chunks (chunked == single-call, bit-exact). */
  | { mediaType: 'audio'; type: 'biquad'; spec: BiquadSpec }
  /** Normalize (global peak/RMS) and/or limit; normalize buffers the decoded audio (inherently non-causal). */
  | { mediaType: 'audio'; type: 'dynamics'; dynamics: DynamicsSpec };

/** The substrate a filter runs on; the router ranks WebGPU → WebGL → Canvas2D → native → WASM. */
export type FilterSubstrate = 'webgpu' | 'webgl' | 'canvas2d' | 'native' | 'wasm';

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
