/**
 * Public API types (docs/architecture/07) — the developer-facing option and result shapes. All backend
 * choice is invisible (ADR-003); options are flat typed objects (ADR-011).
 */

import type {
  Determinism,
  EncodedChunk,
  FaststartMode,
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
  ByteMediaInput,
  FromElementOptions,
  FromOptions,
  FromUrlOptions,
  NormalizedSource,
  SourceKind,
} from '../sources/source.ts';

/**
 * Re-exports of the driver-contract types that appear in this module's public option/result shapes, so
 * every type on the default-entry surface is nameable by a consumer (`import type { Progress } from
 * '@aibrush/media'`) without reaching into `@aibrush/media/core`. These are the public-facing view of
 * the same declarations the driver-author surface exposes (ADR-009/016).
 */
export type {
  /** Exact non-packet container metadata preserved by demux-to-mux packet copies. */
  ContainerSideData,
  /** Marker for a probe track that projects container metadata instead of timed packets. */
  ContainerProjection,
  /** The tier-ladder reproducibility mode passed to {@link CreateMediaOptions.determinism}. */
  Determinism,
  /** A sealed encoded unit (PTS only) — the unit of {@link PacketStreams} and {@link Packet.chunk}. */
  EncodedChunk,
  /** MP4 fast-start layout: false, in-memory moov-first, or positioned reserved-moov streaming. */
  FaststartMode,
  /** A demuxed packet (sealed chunk + optional DTS/packet size) — the unit of {@link Demuxed.packets}. */
  Packet,
  /** Demux packet metadata without payload bytes — the unit of {@link Demuxed.packetTable}. */
  PacketMetadata,
  /** One lightweight packet-timeline row. */
  PacketInfoMetadata,
  /** Materialized packet-timeline rows plus their tracks. */
  PacketInfoTable,
  /** Single-use pull-driven packet batches plus their tracks. */
  PacketInfoBatchStream,
  /** PCM-native biquad/EQ spec accepted by {@link AudioTarget.biquad}. */
  PcmBiquad,
  /** PCM-native dynamics spec accepted by {@link AudioTarget.dynamics}. */
  PcmDynamics,
  /** Monotonic progress delivered to {@link CallOptions.onProgress}. */
  Progress,
  /** A demuxed track descriptor — the element type of {@link Demuxed.tracks}. */
  TrackInfo,
  /** Exact ordered Matroska `AttachedFile` payloads carried as container side data. */
  MatroskaAttachmentsSideData,
  /** Marker linking an attached-picture/attachment projection to its exact Matroska side-data item. */
  MatroskaAttachmentProjection,
  /** Raw H.273/Matroska video-colour facts preserved across container remux. */
  VideoColorMetadata,
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
  /** Opt into worker offload; omitted/false runs inline, true uses one worker, and a pool enables fanout. */
  worker?: boolean | { pool?: number };
  /** Optional same-origin asset directory; normalized once, default keeps literal import.meta URLs. */
  assetBaseUrl?: string; // default = import.meta.url-resolved  (ADR-005/237)
  onLog?: (e: LogEvent) => void;
}

/** Hidden power-user/test override (ADR-014); not part of the primary signatures. */
export interface StrategyOverride {
  determinism?: Determinism;
  /** Pin one exact driver id within the registered kind carrying that id (ADR-237). */
  pinDriver?: string;
}

/** Per-call options accepted by every op. */
export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  strategy?: StrategyOverride;
}

/** Per-call options for {@link MediaEngine.decode}. */
export interface DecodeOptions extends CallOptions {
  /**
   * Optional single-source track selectors such as `video:1` or `audio:0`. The ordinal is zero-based
   * among tracks of that media type. Because {@link MediaStreams} exposes one stream per media type,
   * selecting more than one distinct video or audio track raises a typed `InputError`.
   */
  trackSelect?: readonly string[];
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

export interface VideoQualityConstraint {
  /** Versioned objective-quality metric evaluated over presentation-aligned decoded frames. */
  metric: 'ssim-luma-v1';
  /** Required mean metric score, inclusive, in the range [0, 1]. */
  minimumMean: number;
  /** Number of deterministic, uniformly distributed presentation-time samples to evaluate. */
  samples?: number;
}

export interface VideoTarget {
  codec?: VideoCodec;
  width?: number;
  height?: number;
  fit?: 'contain' | 'cover' | 'fill';
  fps?: number;
  /** Preferred whole-program elementary-stream average bitrate in bits per second. */
  bitrate?: number;
  /** Hard whole-program elementary-stream average bitrate ceiling; requires `bitrate` and `quality`. */
  maxAverageBitrate?: number;
  /** Hard objective-quality constraint; requires `bitrate` and `maxAverageBitrate`. */
  quality?: VideoQualityConstraint;
  bitrateMode?: VideoEncoderBitrateMode;
  crf?: number;
  twoPass?: boolean;
  bitDepth?: 8 | 10 | 12;
  /** Preserve or discard alpha when the selected codec can carry it (VP8/VP9). Defaults to keep for VPx. */
  alpha?: 'keep' | 'discard';
  rotate?: 0 | 90 | 180 | 270;
  flip?: 'h' | 'v';
  crop?: { x: number; y: number; width: number; height: number };
  /** Place the current image 1:1 on a larger transparent canvas; omitted offsets center it. */
  pad?: { width: number; height: number; x?: number; y?: number };
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
  /**
   * Optional explicit output-channel × input-channel remix matrix for PCM-native
   * WAV/AIFF/CAF/FLAC targets.
   * Each output row must contain one finite coefficient per input channel. When present,
   * `channels` must equal the row count; otherwise the source/target channel-count defaults apply.
   */
  mixMatrix?: readonly (readonly number[])[];
  dynamics?: PcmDynamics;
  biquad?: PcmBiquad | readonly PcmBiquad[];
}

export interface H264AbrRung {
  readonly name?: string;
  readonly width: number;
  readonly height: number;
  /** Preferred whole-program elementary-stream average bitrate in bits per second. */
  readonly bitrate: number;
  /** Hard average bitrate ceiling; requires `quality` and is never inferred from `bitrate`. */
  readonly maxAverageBitrate?: number;
  /** Hard objective-quality constraint; requires `maxAverageBitrate`. */
  readonly quality?: VideoQualityConstraint;
  readonly fps?: number;
}

/** Maximum public H.264 ABR fanout width; bounds retained outputs and per-rung orchestration state. */
export const H264_ABR_MAX_RUNGS = 8;

/** Maximum source bytes accepted by the Blob-returning H.264 ABR convenience operation. */
export const H264_ABR_MAX_SOURCE_BYTES = 128 * 1024 * 1024;

/** Maximum cumulative encoded bytes retained across one atomically published H.264 ABR ladder. */
export const H264_ABR_MAX_RETAINED_OUTPUT_BYTES = 512 * 1024 * 1024;

/** Maximum simultaneous bitrate-only ABR worker jobs/source copies; quality ladders always use one. */
export const H264_ABR_MAX_CONCURRENT_BITRATE_RUNGS = 4;

export interface ConvertOptions {
  to?: Container;
  video?: false | VideoTarget;
  audio?: false | AudioTarget;
  faststart?: FaststartMode;
  /** Required per-track packet ceiling when `faststart:'reserve'` is selected. */
  maximumPacketCount?: number;
  fragmented?: boolean;
  sink?: Sink;
}

export interface RemuxOptions {
  to: Container;
  faststart?: FaststartMode;
  /** Required per-track packet ceiling when `faststart:'reserve'` is selected. */
  maximumPacketCount?: number;
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
  /** Preserve/author fragmented MP4 (CMAF-style init segment plus media fragments) output. */
  fragmented?: boolean;
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
  faststart?: FaststartMode;
  /** Required per-track packet ceiling when `faststart:'reserve'` is selected. */
  maximumPacketCount?: number;
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
  /**
   * `'other'` is a declared but non-media track (e.g. a QuickTime `tmcd` timecode trak): enumerated so
   * the probe track count/order matches ffprobe's `nb_streams`, but not decodable — its `codec` is empty.
   */
  type: 'video' | 'audio' | 'other';
  codec: string;
  durationSec?: number;
  width?: number;
  height?: number;
  rotation?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  /** ISO-639-2/T language declared by the container, including the explicit `und` code. */
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

/**
 * Decoded frame streams (the result of `decode`). Video pixels have the container track's display
 * rotation applied; callers therefore receive presentation-oriented frames rather than coded orientation.
 */
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
