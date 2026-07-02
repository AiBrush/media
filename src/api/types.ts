/**
 * Public API types (docs/architecture/07) — the developer-facing option and result shapes. All backend
 * choice is invisible (ADR-003); options are flat typed objects (ADR-011).
 */

import type {
  Determinism,
  EncodedChunk,
  Packet,
  PacketMetadata,
  PcmBiquad,
  PcmDynamics,
  Progress,
  TrackInfo,
} from '../contracts/driver.ts';
import type { Output, Sink } from '../sinks/sink.ts';

export type { Output, Sink } from '../sinks/sink.ts';
// `MediaInput`/`Source`/`isSource` are surfaced by the barrel directly from `../sources/source.ts`;
// here we add only the source *option* types (for typed `from`/`fromURL`/`fromElement` calls) and the
// `SourceKind` union on {@link Source.kind}, so the default entry's source surface is fully nameable.
export type {
  FromElementOptions,
  FromOptions,
  FromUrlOptions,
  SourceKind,
} from '../sources/source.ts';

/**
 * Re-exports of the driver-contract types that appear in this module's public option/result shapes, so
 * every type on the default-entry surface is nameable by a consumer (`import type { Progress } from
 * '@aibrush/media'`) without reaching into `@aibrush/media/core`. These are the public-facing view of
 * the same declarations the driver-author surface exposes (ADR-009/016).
 */
export type {
  /** The tier-ladder reproducibility mode passed to {@link CreateMediaOptions.determinism}. */
  Determinism,
  /** A sealed encoded unit (PTS only) — the unit of {@link PacketStreams} and {@link Packet.chunk}. */
  EncodedChunk,
  /** A demuxed packet (sealed chunk + optional DTS/packet size) — the unit of {@link Demuxed.packets}. */
  Packet,
  /** Demux packet metadata without payload bytes — the unit of {@link Demuxed.packetTable}. */
  PacketMetadata,
  /** PCM-native biquad/EQ spec accepted by {@link AudioTarget.biquad}. */
  PcmBiquad,
  /** PCM-native dynamics spec accepted by {@link AudioTarget.dynamics}. */
  PcmDynamics,
  /** Monotonic progress delivered to {@link CallOptions.onProgress}. */
  Progress,
  /** A demuxed track descriptor — the element type of {@link Demuxed.tracks}. */
  TrackInfo,
} from '../contracts/driver.ts';

/** Diagnostic event delivered to the `onLog` hook. */
export interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  detail?: unknown;
}

/** Options for {@link createMedia}. */
export interface CreateMediaOptions {
  determinism?: Determinism; // default 'auto'                 (ADR-007)
  enableThreads?: boolean; // default = crossOriginIsolated    (ADR-006)
  worker?: boolean | { pool?: number }; // default true (heavy) (ADR-019)
  assetBaseUrl?: string; // default = import.meta.url-resolved  (ADR-005)
  onLog?: (e: LogEvent) => void;
}

/** Hidden power-user/test override (ADR-014); not part of the primary signatures. */
export interface StrategyOverride {
  determinism?: Determinism;
  /** Pin a specific driver id for the operation. */
  pinDriver?: string;
}

/** Per-call options accepted by every op. */
export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  strategy?: StrategyOverride;
}

/**
 * A container token — the canonical id (a driver's `formats[0]`) reported as {@link MediaInfo.container}
 * and accepted as an output target (`to`). Covers every first-party `ContainerDriver` that ships: the
 * ISO-BMFF/MP4 family, Matroska/WebM, Ogg, the RIFF containers (WAV, AVI), the elementary-stream
 * containers (MP3, ADTS/AAC, FLAC), AIFF/CAF, and MPEG-TS (`ts`, plus its `m2ts`/`mts`/`mpegts` aliases).
 * A token with no working muxer is still a legal probe result; routing it as an output `to` raises a
 * typed `CapabilityError` at the muxer, not a type error here.
 */
export type Container =
  | 'mp4'
  | 'mov'
  | 'webm'
  | 'mkv'
  | 'ogg'
  | 'wav'
  | 'mp3'
  | 'aac'
  | 'adts'
  | 'flac'
  | 'aiff'
  | 'caf'
  | 'avi'
  | 'ts'
  | 'm2ts'
  | 'mts'
  | 'mpegts';
export type VideoCodec = 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1';
export type PcmCodec =
  | 'pcm'
  | 'pcm-u8'
  | 'pcm-u8be'
  | 'pcm-s8'
  | 'pcm-s8be'
  | 'pcm-s16'
  | 'pcm-s16be'
  | 'pcm-s24'
  | 'pcm-s24be'
  | 'pcm-s32'
  | 'pcm-s32be'
  | 'pcm-f32'
  | 'pcm-f32be'
  | 'pcm-f64'
  | 'pcm-f64be';
export type AudioCodec = 'aac' | 'opus' | 'mp3' | 'flac' | 'vorbis' | PcmCodec;

export interface VideoTarget {
  codec?: VideoCodec;
  width?: number;
  height?: number;
  fit?: 'contain' | 'cover' | 'fill';
  fps?: number;
  bitrate?: number;
  bitrateMode?: VideoEncoderBitrateMode;
  crf?: number;
  twoPass?: boolean;
  bitDepth?: 8 | 10 | 12;
  /** Preserve or discard alpha when the selected codec can carry it (VP8/VP9). Defaults to keep for VPx. */
  alpha?: 'keep' | 'discard';
  rotate?: 0 | 90 | 180 | 270;
  flip?: 'h' | 'v';
  crop?: { x: number; y: number; width: number; height: number };
  colorspace?: { to: string };
  tonemap?: { to: 'sdr' };
}

export interface AudioTarget {
  codec?: AudioCodec;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
  gainDb?: number;
  fade?: { inSec?: number; outSec?: number; curve?: 'linear' | 'equal-power' };
  dynamics?: PcmDynamics;
  biquad?: PcmBiquad | readonly PcmBiquad[];
}

export interface H264AbrRung {
  readonly name?: string;
  readonly width: number;
  readonly height: number;
  readonly bitrate: number;
  readonly fps?: number;
}

export interface ConvertOptions {
  to?: Container;
  video?: false | VideoTarget;
  audio?: false | AudioTarget;
  faststart?: boolean;
  fragmented?: boolean;
  sink?: Sink;
}

export interface RemuxOptions {
  to: Container;
  faststart?: boolean;
  fragmented?: boolean;
  /** Same-container metadata tag rewrite. Unsupported containers raise a typed capability miss. */
  tags?: Record<string, string>;
  /** Optional single-source track selectors such as `video:0` or `audio:0`. */
  trackSelect?: readonly string[];
  sink?: Sink;
}

export interface TrimOptions {
  start: number;
  end: number;
  mode?: 'keyframe' | 'accurate';
  sink?: Sink;
}

export type EncryptionScheme = 'cenc' | 'cens' | 'cbcs' | 'hls-aes128' | 'hls-sample-aes';
export type KeyMap = Record<string, string>;

export interface DecryptOptions {
  scheme: EncryptionScheme;
  keys: KeyMap;
  sink?: Sink;
}

export interface EncodeOptions {
  to?: Container;
  video?: VideoTarget;
  audio?: AudioTarget;
  sink?: Sink;
}

export interface MuxSpec {
  container: Container;
  faststart?: boolean;
  fragmented?: boolean;
  sink?: Sink;
}

export type ChainTrimOptions = Omit<TrimOptions, 'sink'>;
export type ChainConvertOptions = Omit<ConvertOptions, 'sink'>;
export type ChainRemuxOptions = Omit<RemuxOptions, 'sink'>;
export type ChainDecryptOptions = Omit<DecryptOptions, 'sink'>;

/** Fluent façade over the flat task API (ADR-010). */
export interface MediaChain {
  trim(opts: ChainTrimOptions): MediaChain;
  resize(width: number, height: number, fit?: VideoTarget['fit']): MediaChain;
  crop(crop: NonNullable<VideoTarget['crop']>): MediaChain;
  rotate(degrees: NonNullable<VideoTarget['rotate']>): MediaChain;
  flip(axis: NonNullable<VideoTarget['flip']>): MediaChain;
  colorspace(to: string): MediaChain;
  tonemap(to?: 'sdr'): MediaChain;
  video(target: false | VideoTarget): MediaChain;
  audio(target: false | AudioTarget): MediaChain;
  to(container: Container): MediaChain;
  convert(opts?: ChainConvertOptions): MediaChain;
  remux(opts: ChainRemuxOptions): MediaChain;
  decrypt(opts: ChainDecryptOptions): MediaChain;
  run(o?: CallOptions): Cancellable<Output>;
  blob(o?: CallOptions): Cancellable<Blob>;
  file(name: string, o?: CallOptions): Cancellable<File>;
  stream(o?: CallOptions): Cancellable<ReadableStream<Uint8Array>>;
}

/** A probe result (ADR-013). */
export interface MediaInfoTrack {
  id: number;
  type: 'video' | 'audio';
  codec: string;
  durationSec?: number;
  width?: number;
  height?: number;
  rotation?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  language?: string;
}

export interface MediaInfo {
  container: string;
  durationSec: number;
  sizeBytes?: number;
  tracks: MediaInfoTrack[];
  tags?: Record<string, string>;
}

/** A live demux result (public-facing); {@link Packet} carries each chunk's PTS plus optional side data. */
export interface Demuxed {
  readonly tracks: readonly TrackInfo[];
  packetTable?(): readonly PacketMetadata[];
  packets(trackId: number): ReadableStream<Packet>;
  close(): Promise<void>;
}

/** Decoded frame streams (the result of `decode`). */
export interface MediaStreams {
  video?: ReadableStream<VideoFrame>;
  audio?: ReadableStream<AudioData>;
}

/**
 * One caller-owned encoded packet stream passed to `mux`.
 *
 * `track` is mandatory because a muxer cannot safely infer codec-private boxes/headers, dimensions,
 * sample-rate, channel layout, duration, or DTS/B-frame policy from chunks alone. `packets`/`packetsArray`
 * accept both demuxed {@link Packet}s (verbatim remux, preserving `dtsUs`) and encoder-produced bare
 * {@link EncodedChunk}s (PTS-only, as in the encoder seam).
 */
export interface PacketStream {
  readonly track: TrackInfo;
  readonly packets?: ReadableStream<EncodedChunk | Packet>;
  /**
   * Optional materialized packet list for callers that already hold a small prepared packet set. Stream
   * inputs remain the general contract; specialized fast muxers may consume this directly to avoid a
   * redundant one-shot `ReadableStream` wrapper.
   */
  readonly packetsArray?: readonly (EncodedChunk | Packet)[];
}

/**
 * Encoded packet streams (the input to `mux`). The `video`/`audio` slots cover the common single-video +
 * single-audio assembly; `tracks` carries an arbitrary, ordered list — the **multi-source / multi-track**
 * assembly seam (≥2 video, ≥2 audio, or tracks demuxed from several sources packed into one container).
 * Each {@link PacketStream} owns its own {@link TrackInfo} (codec + config), so the target muxer's
 * `addTrack` is the single arbiter of what it can write. All present streams are muxed; `tracks` entries
 * are appended after `video`/`audio` in list order, each becoming its own output track.
 */
export interface PacketStreams {
  video?: PacketStream;
  audio?: PacketStream;
  tracks?: readonly PacketStream[];
}

/** Warmup spec for `preload`. */
export type PreloadSpec =
  | string
  | {
      op: string;
      video?: string;
      audio?: string;
      container?: string;
      level?: 'chunks' | 'compile' | 'ready';
    };

/** A cancellable op result: a `Promise` that also exposes `.cancel()`. */
export type Cancellable<T> = Promise<T> & { cancel(): void };
