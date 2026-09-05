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

import type { ImageOps } from '../codecs/image/image-driver.ts';
import type { BiquadSpec } from '../dsp/biquad.ts';
import type { DynamicsSpec, LimitMode } from '../dsp/dynamics.ts';
import type { FadeShape } from '../dsp/fade.ts';
import type { Endianness, InterleavedPcmF32, PcmAudio, SampleFormat } from '../dsp/pcm.ts';

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
  /** `force-software` requires a proved non-hardware codec/filter path for reproducibility. */
  determinism?: Determinism;
  /** WASM execution profile. Omitted means drivers resolve ADR-006 from the current runtime. */
  wasmRuntime?: WasmRuntimeProfile;
  /** Normalized absolute same-origin directory used only when resolving a selected WASM asset. */
  wasmAssetBaseUrl?: string;
  /** Exact ADR-014 route pin, retained so nested stage routes inherit the caller's strategy. */
  pinDriver?: string;
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
 * `data`, when present, is an owned immutable byte view of the same payload exposed by `chunk.copyTo()`;
 * packet-copy muxers may read it directly instead of copying out of the WebCodecs host object again.
 * `sizeBytes`, when present, is the container packet's byte size for oracles/diagnostics whose packet
 * unit is wider than the decoder access unit (e.g. ADTS: header+payload on disk, raw AAC AU in
 * WebCodecs). `alpha`, when present, is the VPx alpha side-data chunk carried by WebM/Matroska
 * BlockAdditions (BlockAddID=1). Demuxers attach these facts from container tables/headers; muxers honor
 * DTS/alpha and copy the bare {@link chunk} bytes; ordinary decoders ignore side fields unless they
 * explicitly implement alpha-plane merging. A pure data view — no resources to release (chunks own their
 * bytes).
 */
export interface Packet {
  /** The sealed WebCodecs encoded unit: the coded bytes, the keyframe flag, and `timestamp` = PTS. */
  readonly chunk: EncodedChunk;
  /** Optional owned byte payload for packet-copy muxers; equal in content to `chunk.copyTo()`. */
  readonly data?: Uint8Array;
  /** VPx alpha side-data chunk for WebM/Matroska BlockAdditions (BlockAddID=1), when present. */
  readonly alpha?: EncodedVideoChunk;
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

/** Lightweight packet table shape for consumers that only need timeline facts, not track ids/durations. */
export interface PacketInfoMetadata {
  readonly trackIndex: number;
  /** Source byte offset for this packet when the container can expose it without payload materialization. */
  readonly offset?: number;
  readonly size: number;
  readonly ptsUs: number;
  readonly dtsUs: number;
  /** Packet duration in microseconds when known without payload materialization. */
  readonly durationUs?: number;
  readonly keyframe: boolean;
  /** Optional SHA-256 of the exact coded packet payload, produced only when explicitly requested. */
  readonly payloadDigest?: string;
}

/** Tracks plus a lightweight packet table, without constructing payload streams. */
export interface PacketInfoTable {
  /**
   * The canonical container token the engine routed to. Drivers omit it; the engine stamps the
   * selected driver's first {@link ContainerDriver.formats} entry before returning the table, so a
   * caller reads the resolved format instead of re-deriving it from a name or MIME hint.
   */
  readonly container?: string;
  readonly tracks: readonly TrackInfo[];
  readonly packets: readonly PacketInfoMetadata[];
}

/** Options for a pull-driven packet-info enumeration. */
export interface PacketInfoBatchOptions extends StageOptions {
  /**
   * Maximum packet rows returned by one pull. Drivers must not retain prior batches after yielding
   * them; callers therefore control row-object memory through consumption/backpressure.
   */
  readonly batchSize?: number;
  /**
   * Hash each exact coded payload while its bounded source range is owned. This adds a full payload
   * scan but retains only one digest per row; it is intended for integrity/oracle workflows.
   */
  readonly includePayloadDigests?: boolean;
}

/**
 * A single-use, pull-driven packet-info table. Each iterator pull produces at most `batchSize` rows;
 * breaking iteration or calling {@link cancel} releases in-flight driver work.
 */
export interface PacketInfoBatchStream extends AsyncIterable<readonly PacketInfoMetadata[]> {
  /** The canonical container token the engine routed to; see {@link PacketInfoTable.container}. */
  readonly container?: string;
  readonly tracks: readonly TrackInfo[];
  cancel(reason?: unknown): Promise<void>;
}

/** Common identity every driver declares. */
export interface DriverBase {
  /** Unique driver id, e.g. 'webcodecs-video', 'wasm-flac', 'mp4'. */
  readonly id: string;
  /** The {@link DRIVER_API_VERSION} this driver was built against (checked at registration). */
  readonly apiVersion: number;
  /**
   * Optional-capability handshake: the additive optional contract members this driver implements
   * (e.g. `'streamCopy'`, `'probe'`, `'validatesPcmTrim'`). Registration refuses a driver that
   * advertises a member its surface does not actually expose (typed `driver-incompatible`), so
   * consumers can trust the advertisement instead of duck-typing methods at call time. Omitted ⇒
   * consumers fall back to method-presence checks.
   */
  readonly capabilities?: readonly string[];
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

/** Selection facts a codec capability probe must honor before a coder is constructed. */
export interface CodecSupportOptions {
  /** Require an explicitly non-hardware capability verdict when set to `force-software`. */
  readonly determinism?: Determinism;
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
  supports(q: CodecQuery, o?: CodecSupportOptions): Promise<CodecSupport>;
  createDecoder(c: DecoderConfig, o?: StageOptions): TransformStream<EncodedChunk, RawFrame>;
  createEncoder(c: EncoderConfig, o?: StageOptions): TransformStream<RawFrame, EncodedChunk>;
}

// ============ 2) ContainerDriver ============

/** A byte source with optional random access (enables header-only probe). */
export interface ByteSource {
  stream(): ReadableStream<Uint8Array>;
  size?: number;
  /** Half-open random-access read. Implementations must reject promptly when `signal` aborts. */
  range?(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  /**
   * Optional ownership handshake for ephemeral range buffers. A consumer calls this only after it is
   * permanently done with an exact view returned by {@link range}; the source may then detach or
   * recycle that backing store. Sources that return borrowed/cache-backed views omit this hook.
   */
  releaseRange?(bytes: Uint8Array): void;
  /** Optional owned one-buffer materialization for consumers that have already proved they need all bytes. */
  readAll?(signal?: AbortSignal): Promise<Uint8Array>;
}

export interface ContainerQuery {
  direction: 'demux' | 'mux';
  mime?: string;
  extension?: string;
  /** Magic bytes from the source head (e.g. `ftyp`, EBML `1A45DFA3`, `RIFF…WAVE`, `fLaC`, `OggS`). */
  head?: Uint8Array;
}

/**
 * Exact container metadata that must travel with an encoded track even though it is not a timed packet.
 * A Matroska bundle owns the complete payload of every ordered `AttachedFile` element (the bytes inside
 * `AttachedFile`, including filename/MIME/UID plus duplicate, unknown, and future children). The whole
 * bundle is repeated by reference on each track from one demux result so ordinary track selection retains
 * it; target muxers exact-deduplicate repeated bundles before authoring Segment-level metadata.
 */
export interface MatroskaAttachmentsSideData {
  readonly kind: 'matroska-attachments';
  readonly attachedFilePayloads: readonly Uint8Array[];
}

/** Additive container metadata carried by {@link TrackInfo}; never decoded or emitted as a packet. */
export type ContainerSideData = MatroskaAttachmentsSideData;

/**
 * Marks a probe-compatible track descriptor as a projection of container metadata rather than a timed
 * media track. For example, Matroska cover JPEGs are enumerated as attached-picture MJPEG streams, while
 * their bytes remain an `AttachedFile` and must never become a Block during packet-copy muxing.
 */
export interface MatroskaAttachmentProjection {
  readonly kind: 'matroska-attachment';
  /** Index into this track's {@link TrackInfo.containerSideData}. */
  readonly sideDataIndex: number;
  /** Index into the referenced bundle's ordered `attachedFilePayloads`. */
  readonly attachmentIndex: number;
}

/** A container-metadata projection carried by a public track descriptor. */
export type ContainerProjection = MatroskaAttachmentProjection;

export interface TrackInfo {
  id: number;
  mediaType: MediaType;
  codec: string;
  /**
   * Whether the container marks this track enabled by default. For ISO BMFF this is the `tkhd`
   * Track_enabled flag; it is distinct from application-level track selection.
   */
  defaultDisposition?: boolean;
  /** Measured compressed elementary-stream bitrate in bits/second when a packet table proves it. */
  bitrate?: number;
  /**
   * Marks a declared non-media trak (e.g. a QuickTime `tmcd` timecode trak). It is enumerated by
   * `probe()` for stream count/order parity with ffprobe/mediainfo but carries no decodable `config`,
   * so it never appears in `demux()`/decode/mux output; `mediaType` is a nominal placeholder for such an
   * entry (consumers key off this flag) and `probe` surfaces it as `MediaInfoTrack.type: 'other'`.
   */
  nonMedia?: true;
  durationSec?: number;
  /** ISO-639-2/T language declared by the container, including the explicit `und` code. */
  language?: string;
  /** Video frame rate (frames ÷ duration) and display rotation in degrees, when known. */
  fps?: number;
  rotation?: number;
  /** True when encoded samples are protected and must be decrypted before generic decode/seek. */
  encrypted?: boolean;
  /** The container's declared protection scheme for those samples (ISO BMFF `schm`: `cenc`, `cbcs`, ...). */
  encryptionScheme?: string;
  /** True when a container declaration or complete demux proves a separate coded alpha side channel. */
  alpha?: boolean;
  /** Exact non-packet container metadata that follows this descriptor through track selection/muxing. */
  containerSideData?: readonly ContainerSideData[];
  /** Marks this descriptor as an enumeration projection of one {@link containerSideData} item. */
  containerProjection?: ContainerProjection;
  /** Container codec delay subtracted from stored packet timestamps (Matroska nanoseconds). */
  codecDelayNs?: number;
  /** Decoder convergence preroll carried by the container (Matroska nanoseconds). */
  seekPreRollNs?: number;
  /** WebCodecs config: video coded dims/rotation/fps; audio sampleRate/channels. */
  config?: DecoderConfig;
  /**
   * Raw container video-colour facts. Numeric primaries/transfer/matrix values use the H.273 code
   * points; the remaining fields preserve Matroska `Colour` unsigned values losslessly so a remux can
   * retain information (including future/unknown-safe code points) that WebCodecs cannot name.
   */
  color?: VideoColorMetadata;
  /** Optional exact compressed-audio gapless facts, in decoded samples at the track sample rate. */
  gapless?: {
    /**
     * Provenance for gapless facts whose native decoder treatment is substrate-dependent. MP4 edit
     * lists rebase encoded packet timestamps before decode; Ogg Opus carries pre-skip in OpusHead and
     * the exact presented tail in its EOS granule; Matroska Opus uses CodecDelay plus terminal
     * DiscardPadding; Xing/LAME stores MP3 delay/padding that must be translated across Layer III's
     * synthesis delay. Some container-aware decoders consume leading trim natively, while raw-frame
     * decoders expose it for the engine to trim. An absent basis keeps the historical count-only contract.
     */
    basis?: 'mp4-edit-list' | 'ogg-opus-granule' | 'webm-opus-codec-delay' | 'mp3-xing-lame';
    /** Raw reversible Xing/LAME fields retained when `basis` is `mp3-xing-lame`. */
    mp3Lame?: {
      readonly encoderDelaySamples: number;
      readonly encoderPaddingSamples: number;
    };
    /** Leading decoder/encoder-delay samples to discard before exposing program audio. */
    leadingSamples?: number;
    /** Trailing encoder-padding samples to discard after program audio. */
    trailingSamples?: number;
    /** Exact program-audio sample count after leading/trailing removal. */
    totalSamples?: number;
  };
}

/**
 * Constant-sized timing/size evidence for one demuxed track. Unlike {@link PacketMetadata}, this
 * summary must be computed without allocating one object per packet.
 */
export interface PacketMetadataStats {
  readonly packetCount: number;
  readonly totalSizeBytes: number;
  /** Exact decode span when derivable with bounded memory; publish both decode fields or neither. */
  readonly decodeStartUs?: number;
  readonly decodeEndUs?: number;
  readonly presentationStartUs: number;
  readonly presentationEndUs: number;
}

/**
 * Exact presentation-timing facts published by an audio encoder after its input and output have
 * drained. Counts are per-channel PCM samples at {@link sampleRate}; they describe the newly encoded
 * destination stream, never the source track's codec delay or padding.
 */
export interface AudioEncoderOutputTiming {
  /** Destination PCM clock used by the encoded access units. */
  readonly sampleRate: number;
  /** Exact program samples submitted to the encoder after decode/filter/resample/downmix. */
  readonly submittedSamples: number;
  /** Total PCM capacity of the emitted access units, when the codec framing proves it. */
  readonly codedSamples?: number;
  /** Destination encoder priming before the first submitted program sample, when implementation-proven. */
  readonly leadingSamples?: number;
}

export interface VideoColorMetadata {
  matrixCoefficients?: number;
  bitsPerChannel?: number;
  chromaSubsamplingHorz?: number;
  chromaSubsamplingVert?: number;
  cbSubsamplingHorz?: number;
  cbSubsamplingVert?: number;
  chromaSitingHorz?: number;
  chromaSitingVert?: number;
  /** Matroska Range: 0 unspecified, 1 broadcast/limited, 2 full, 3 defined by matrix/transfer. */
  range?: number;
  transferCharacteristics?: number;
  primaries?: number;
  maxCll?: number;
  maxFall?: number;
}

/** A live demux session: per-track lazy packet streams ({@link Packet} carries PTS + optional DTS). */
export interface Demuxer {
  /**
   * The concrete container flavor this demux actually parsed, for a driver that serves several
   * (`mov` vs `mp4`, `mkv` vs `webm`). Omitted ⇒ the engine reports the driver's primary format.
   */
  readonly container?: string;
  readonly tracks: readonly TrackInfo[];
  /** Optional packet-table fast path: no encoded payload bytes are read or materialized. */
  packetTable?(): readonly PacketMetadata[];
  /** Optional constant-sized per-track evidence; implementations must not materialize packet rows. */
  packetStats?(trackId: number): PacketMetadataStats | undefined;
  packets(trackId: number): ReadableStream<Packet>;
  close(): Promise<void>;
}

export type FaststartMode = boolean | 'reserve';

export interface MuxOptions {
  faststart?: FaststartMode;
  /** Per-track packet ceiling used to bound an MP4 `faststart:'reserve'` moov reservation. */
  maximumPacketCount?: number;
  fragmented?: boolean;
  /**
   * The target container token the caller requested (one of the driver's {@link ContainerDriver.formats}).
   * Lets a multi-format driver pick the right on-disk flavor — e.g. the MP4 driver writes a QuickTime
   * `ftyp` for `'mov'` vs an ISO `ftyp` for `'mp4'`. Omitted ⇒ the driver's primary format.
   */
  container?: string;
}

/** Exact prepared-sample accounting from the selected mux route, before any candidate is published. */
export interface MuxedTrackAudit {
  /** Sum of elementary sample payload bytes after the muxer's framing normalization. */
  readonly elementaryPayloadBytes: number;
  /** Prepared payload byte lengths in packet arrival order, for rate-model recalibration. */
  readonly preparedSampleByteLengths: readonly number[];
  /** `max(PTS + duration) - min(PTS)` in the same rounded units a neutral demuxer will expose. */
  readonly presentationSpanUs: number;
  readonly sampleCount: number;
}

/** A live mux session: add tracks, write packets (preserving PTS/DTS/duration), finalize. */
export interface Muxer {
  readonly output: ReadableStream<Uint8Array>;
  addTrack(info: TrackInfo): number;
  write(trackId: number, packet: Packet): Promise<void>;
  /**
   * Optional buffered-muxer seam for destination encoder timing learned only after its stream drains.
   * Must be called before {@link finalize}; the tuple is in decoded samples at the output track rate.
   */
  setTrackGapless?(trackId: number, gapless: NonNullable<TrackInfo['gapless']>): void;
  /** Optional raw-PCM frame seam; bytes must match the added track's declared PCM wire layout. */
  writePcm?(trackId: number, data: Uint8Array): Promise<void>;
  finalize(): Promise<void>;
}

/** Options for a driver-native stream-copy (remux / keyframe-trim), ADR-021. */
/**
 * Sample-exact accounting for the window a trim actually authored (REQUIREMENTS §5.7: "The engine MUST
 * expose any unavoidable alignment adjustment"). Coordinates are source presentation sample frames on the
 * source's own gapless timeline, so `authored − requested` at each edge is the whole adjustment: both
 * zero means the output presents exactly the requested interval.
 *
 * A compressed format that can signal delay/padding (MP4 edit lists, Ogg Opus pre-skip/granule, MP3
 * Xing/LAME) reports zeroes. A format with no discard signalling — raw ADTS AAC carries only whole
 * access units — reports the rounding it could not avoid, with `reason` naming the constraint.
 */
export interface TrimAlignment {
  readonly sampleRate: number;
  readonly requestedStartSampleFrame: number;
  readonly requestedEndSampleFrame: number;
  readonly authoredStartSampleFrame: number;
  readonly authoredEndSampleFrame: number;
  /** `authored − requested`; negative means earlier than requested, positive later. */
  readonly startAdjustmentSampleFrames: number;
  readonly endAdjustmentSampleFrames: number;
  /** The format constraint that forced a non-zero adjustment; omitted when the trim is exact. */
  readonly reason?: string;
}

export interface StreamCopyOptions extends StageOptions {
  /** Keyframe-aligned time-range copy (trim), in seconds. Omit for a full remux. */
  trim?: { startSec: number; endSec: number };
  /**
   * Called once with the window the copy actually authored when `trim` is given. Drivers that can express
   * the requested interval exactly still report it (with zero adjustments) so callers never have to infer
   * exactness from silence.
   */
  onTrimAlignment?: (alignment: TrimAlignment) => void;
  /**
   * Permit a same-container full-range trim to return the exact source bytes. Callers use this only
   * when their operation contract is semantic identity; ordinary remux callers retain the driver's
   * requested layout/faststart rewrite.
   */
  identitySourceIfFullRange?: boolean;
  /**
   * Decode-check selected AVC access units before exposing a copy-trim. Defaults to true. Callers that
   * already authenticated clean source bytes may disable this redundant codec pass.
   */
  validateDecode?: boolean;
  faststart?: FaststartMode;
  /** Per-track packet ceiling required by MP4 `faststart:'reserve'`. */
  maximumPacketCount?: number;
  fragmented?: boolean;
  /** True when the caller will materialize the copy into a streaming sink rather than a whole buffer. */
  streaming?: boolean;
  /** True when the caller needs a whole output buffer; drivers may avoid retaining source payload chunks. */
  buffered?: boolean;
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
  /** Explicit output-channel × input-channel coefficients; raw-PCM transforms only. */
  mixMatrix?: readonly (readonly number[])[];
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
  scheme: 'cenc' | 'cens' | 'cbcs' | 'hls-aes128' | 'hls-sample-aes';
  /** keyId(hex) → key(hex). For CENC, keyed by the track's `tenc` default_KID. */
  keys: Record<string, string>;
}

/**
 * The track facts a metadata-only probe returns, optionally carrying the file-level container metadata
 * the same parse already observed — the ISO-BMFF `ftyp` major brand, Matroska `Tags`, ID3 frames, and
 * Vorbis comments all sit in the window a probe must read anyway, so reporting them costs no extra read.
 * A driver with nothing to report returns a plain array; `tags` surfaces as {@link MediaInfo.tags}.
 */
export type ProbeTracks = readonly TrackInfo[] & {
  readonly tags?: Readonly<Record<string, string>>;
};

/** Demux/mux one container family (e.g. ['mp4','mov']). `supports()` is synchronous (magic/mime). */
export interface ContainerDriver extends DriverBase {
  readonly kind: 'container';
  readonly formats: readonly string[];
  supports(q: ContainerQuery): boolean;
  /**
   * Optional metadata-only probe: return track facts without constructing a live demux session or packet
   * streams. Drivers that omit it keep the v1 fallback: `MediaEngine.probe()` calls `demux()` and maps
   * `demuxer.tracks`. Return the bare track array when the container carries no file-level metadata, or
   * {@link ProbeTracks} carrying `tags` to also report the file metadata the same parse observed.
   */
  probe?(src: ByteSource, o?: StageOptions): Promise<ProbeTracks>;
  /**
   * Optional packet-info probe: return track facts plus timeline packet rows without constructing live
   * payload streams. Drivers that omit it keep the normal `demux()` path.
   */
  packetInfo?(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable>;
  /**
   * Optional bounded-memory packet-info probe. Rows are derived only as the caller pulls batches;
   * cancellation/early iterator return must stop outstanding reads. Existing `packetInfo()` remains the
   * compatibility array surface and may collect this path.
   */
  packetInfoBatches?(src: ByteSource, o?: PacketInfoBatchOptions): Promise<PacketInfoBatchStream>;
  demux(src: ByteSource, o?: StageOptions): Promise<Demuxer>;
  /**
   * Optional index-driven random access for seek: the packets of one track (by `probe()` track id)
   * starting at the container index's last random-access point at or before `timeUs`, read through
   * bounded ranges instead of a whole-file demux. `undefined` means the source or index cannot support
   * it (no index, unknown-size clusters, one-shot source); the caller then falls back to `demux()`.
   * The stream may begin earlier than the requested point; callers still apply their keyframe logic.
   */
  seekPackets?(
    src: ByteSource,
    trackId: number,
    timeUs: number,
    o?: StageOptions,
  ): Promise<ReadableStream<Packet> | undefined>;
  /**
   * Optional synchronous legality check for one track this container would receive from
   * {@link createMuxer}: codec family, track count, PCM shape. Lazy drivers expose it eagerly so an
   * illegal codec→container request is rejected (typed `CapabilityError`) before any muxer chunk
   * loads. `trackIndex` counts tracks already accepted for the same output.
   */
  validateMuxTrack?(track: TrackInfo, trackIndex: number): void;
  createMuxer(o?: MuxOptions): Muxer;
  /**
   * Optional exact pre-publication accounting for one encoded track. The iterable is single-use and may
   * copy one packet payload at a time; implementations must apply the same framing/timescale rules as the
   * eventual {@link createMuxer} call with the same options. Implementations must observe `signal` while
   * consuming bounded packet evidence. Absence means the route cannot prove a hard elementary-rate
   * constraint before publication.
   */
  auditMuxedTrack?(
    track: TrackInfo,
    packets: Iterable<Packet>,
    o?: MuxOptions,
    signal?: AbortSignal,
  ): Promise<MuxedTrackAudit>;
  /**
   * Optional lossless driver-native stream-copy targets outside {@link formats}. A driver lists only
   * target containers it can author itself while preserving coded packets and the target's strict layout
   * rules (for example native FLAC frames into Ogg-FLAC). Unlisted cross-container targets use the generic
   * demux→mux packet seam.
   */
  streamCopyTargets?: readonly string[];
  /**
   * Optional lossless stream-copy — a full remux, or a keyframe-aligned trim when `trim` is given —
   * bypassing the PTS-only codec seam so DTS/B-frames/codec-private survive (ADR-021). The router uses it
   * when in/out are the same container or when {@link streamCopyTargets} declares the requested target;
   * absent ⇒ fall back to the seam.
   */
  streamCopy?(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>>;
  /**
   * True when `streamCopy(..., { trim })` performs the same typed range validation as the public trim
   * router before emitting bytes. The engine may then skip its generic pre-trim duration demux and let the
   * native driver validate against the movie metadata it already parsed for the copy.
   */
  validatesStreamCopyTrim?: boolean;
  /**
   * Optional PCM-native audio transform (ADR-022) for raw-PCM containers (e.g. WAV) — applies
   * {@link PcmTransform} in the TS audio-dsp path and re-serializes the same container. Source
   * sample-format/endianness are preserved unless the transform asks for a target format; absent ⇒ the
   * engine falls back to the codec seam.
   */
  transformPcm?(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>>;
  /**
   * True when `transformPcm(..., { timeBounds })` performs the same typed time-range validation as the
   * public trim router before emitting bytes. The engine may then skip its generic duration probe for a
   * PCM-native keyframe trim and let the driver validate against the container metadata it already parses.
   */
  validatesPcmTrim?: boolean;
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
  /**
   * Optional bounded raw-PCM decode stream. Each emitted {@link PcmAudio} is a canonical planar chunk;
   * the engine owns the browser `AudioData` framing and closes consumer-owned frames exactly once.
   * Drivers should use source ranges when available and preserve pull-driven sequential delivery for
   * range-less sources rather than materializing the complete input.
   */
  decodePcmAudioStream?(src: ByteSource, o?: StageOptions): Promise<ReadableStream<PcmAudio>>;
  /**
   * Optional bounded raw-PCM stream already narrowed to exact-owned interleaved Float32. The engine may
   * transfer each chunk directly into `AudioData`; drivers retain {@link decodePcmAudioStream} for
   * canonical planar consumers and formats that cannot provide this representation efficiently.
   */
  decodePcmInterleavedStream?(
    src: ByteSource,
    o?: StageOptions,
  ): Promise<ReadableStream<InterleavedPcmF32>>;
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
  | { mediaType: 'video'; type: 'pad'; x: number; y: number; width: number; height: number }
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

/**
 * The additive optional {@link ContainerDriver} members, in contract order — the capability surface a
 * container may advertise beyond mandatory `supports`/`demux`/`createMuxer`. This is the single list the
 * registry compares on an id collision (a strictly wider surface supersedes) and conformance checks
 * assert lazy proxies against, so the advertised and real surfaces cannot drift apart silently.
 */
export const OPTIONAL_CONTAINER_CAPABILITIES = [
  'probe',
  'packetInfo',
  'packetInfoBatches',
  'auditMuxedTrack',
  'streamCopy',
  'validatesStreamCopyTrim',
  'transformPcm',
  'validatesPcmTrim',
  'decrypt',
  'decodePcm',
  'decodePcmAudio',
  'decodePcmAudioStream',
  'decodePcmInterleavedStream',
] as const satisfies readonly (keyof ContainerDriver)[];

/** Drivers register themselves here, by kind. */
export interface Registry {
  addCodec(d: CodecDriver): void;
  addContainer(d: ContainerDriver): void;
  addFilter(d: FilterDriver): void;
  /**
   * Attach the still/animated-image capability surface (idempotent: the first ops win). Image support
   * is an {@link ImageOps} object rather than a packet-seam driver, so hosts without an image slot may
   * omit this method; registration modules call it optionally.
   */
  addImageOps?(ops: ImageOps): void;
}

/** The read side the router consumes (snapshots in insertion order). */
export interface RegistryView {
  codecs(): readonly CodecDriver[];
  containers(): readonly ContainerDriver[];
  filters(): readonly FilterDriver[];
  imageOps(): ImageOps | undefined;
}

/** A lazily-imported driver chunk default-exports a {@link DriverModule}. */
export interface DriverModule {
  /** Checked against {@link DRIVER_API_VERSION} at registration. */
  readonly apiVersion: number;
  register(reg: Registry): void;
}

/** Any of the three concrete driver kinds. */
export type AnyDriver = CodecDriver | ContainerDriver | FilterDriver;
