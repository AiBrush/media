/**
 * Codec-tier pipeline helpers (docs/architecture/09 decode/encode/convert/seek) — the pure routing +
 * config-normalization logic that turns public `ConvertOptions`/`EncodeOptions` into the concrete
 * WebCodecs `EncoderConfig`s, `FilterSpec` chains, container choices, and mux `TrackInfo`s the engine
 * feeds to the (frozen) WebCodecs/GPU drivers and the `Mp4Muxer`. Everything here is *pure* and
 * Node-unit-tested (real, can-fail, no WebCodecs); the live stream composition that *does* require
 * WebCodecs lives in {@link composeFramePipeline}/{@link drainEncoderToMuxer}/{@link seekFrame}, guarded
 * and validated in the browser harness (ADR-016, BUILD §6.1).
 *
 * Why a separate module: `engine.ts` wires the kernel; the codec/encoder/filter math is substantial and
 * independently testable, so it is factored out behind small pure functions rather than inlined.
 */

import type { EncodedChunk, Packet, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { closeFrame } from '../kernel/frames.ts';
import type { AudioCodec, AudioTarget, PcmCodec, VideoCodec, VideoTarget } from './types.ts';

export {
  chooseOutputContainer,
  containerHasChunkMuxer,
  hasTrackSelection,
  isPcmContainer,
  isPureStreamCopy,
  selectTrackInfos,
} from './codec-routing.ts';

// ============ codec-string mapping (public token → WebCodecs codec string) ============

/**
 * Default WebCodecs codec strings for each public {@link VideoCodec} token, carrying a broadly-supported
 * profile/level so `VideoEncoder.isConfigSupported` answers precisely (docs/architecture/10 §6): H.264
 * Constrained Baseline (`avc1.42E0??`) — the most universally encodable profile, whose LEVEL byte is
 * recomputed from the output resolution+fps (see {@link h264CodecStringForDimensions}); HEVC Main L3.1;
 * VP8/VP9/AV1 their standard strings. Used only when the caller did not pin an explicit codec via the
 * source (preserve) path. The H.264 entry's `1E` (L3.0) is only the fallback when dims are unknown.
 */
const VIDEO_CODEC_STRING: Record<VideoCodec, string> = {
  h264: 'avc1.42E01E',
  hevc: 'hev1.1.6.L93.B0',
  vp8: 'vp8',
  vp9: 'vp09.00.10.08',
  av1: 'av01.0.04M.08',
};

// ── H.264 level selection (Annex A, Table A-1) ───────────────────────────────────────────────────

/**
 * H.264/AVC level table (Rec. H.264 Annex A, Table A-1) — the subset we select from, ordered ascending.
 * `idc` is the `level_idc` byte (the `LL` in `avc1.PPCCLL`); `maxFs` is MaxFrameSizeInMbs (luma 16×16
 * macroblocks per frame); `maxMbps` is MaxMacroblockProcessingRate (macroblocks/second). A config is
 * legal at a level iff its frame macroblock count ≤ maxFs AND its macroblocks/second ≤ maxMbps; we pick
 * the MINIMUM level meeting both, so `VideoEncoder.isConfigSupported` accepts e.g. 1080p (which the old
 * hard-coded L3.0 `avc1.42E01E` rejected). 1b (idc 11 + constraint_set3) is omitted: it is profile-
 * constrained and 1.1 covers the same maxFs, so plain 1.1 is the cleaner low rung. (See unit tests.)
 */
const H264_LEVELS = [
  [0x0a, 99, 1485], //   1.0
  [0x0b, 396, 3000], //  1.1
  [0x0c, 396, 6000], //  1.2
  [0x0d, 396, 11880], // 1.3
  [0x14, 396, 11880], // 2.0
  [0x15, 792, 19800], // 2.1
  [0x16, 1620, 20250], // 2.2
  [0x1e, 1620, 40500], // 3.0
  [0x1f, 3600, 108000], // 3.1
  [0x20, 5120, 216000], // 3.2
  [0x28, 8192, 245760], // 4.0
  [0x29, 8192, 245760], // 4.1
  [0x2a, 8704, 522240], // 4.2
  [0x32, 22080, 589824], // 5.0
  [0x33, 36864, 983040], // 5.1
  [0x34, 36864, 2073600], // 5.2
  [0x3c, 139264, 4177920], // 6.0
  [0x3d, 139264, 8355840], // 6.1
  [0x3e, 139264, 16711680], // 6.2
] as const satisfies ReadonlyArray<readonly [idc: number, maxFs: number, maxMbps: number]>;

/** Default fps for the throughput (MaxMBPS) bound when the caller did not pin a framerate. */
const H264_DEFAULT_FPS = 30;

/** The top Annex-A level (6.2) — the fallback when a resolution exceeds every tabulated level. */
const H264_TOP_LEVEL_IDC = 0x3e;

/**
 * Browser-interoperability floor for H.264 *encode* codec strings. Ultra-low legal levels (L1.0–L1.3)
 * are enough for tiny 320×180/1×1 streams on paper, but Chromium 149 accepted such WebCodecs encodes
 * and then failed to seek-decode the resulting MP4 through `<video>`. L3.0 is the common SD floor used
 * by browser-oriented encoders; it is still a truthful upper-bound for smaller streams and avoids the
 * low-level platform seek failure without inflating larger outputs.
 */
const H264_BROWSER_PLAYBACK_MIN_LEVEL_IDC = 0x1e;

/**
 * The MINIMUM H.264 `level_idc` byte that can encode `width`×`height` at `fps` — the smallest Annex-A
 * level whose MaxFS covers the frame's macroblock count AND whose MaxMBPS covers macroblocks/second
 * (fps defaults to {@link H264_DEFAULT_FPS} when unknown). Falls back to the top level (6.2) for an
 * over-spec resolution rather than throwing, so the encoder probe — not this pure helper — owns the
 * final reject. Pure + total; unit-tested against the Table A-1 boundaries.
 */
export function h264LevelIdcForDimensions(
  width: number,
  height: number,
  fps: number | undefined,
): number {
  const mbW = Math.ceil(width / 16);
  const mbH = Math.ceil(height / 16);
  const frameMbs = mbW * mbH;
  const rate = fps !== undefined && fps > 0 ? fps : H264_DEFAULT_FPS;
  const mbps = frameMbs * rate;
  for (const [idc, maxFs, maxMbps] of H264_LEVELS) {
    if (frameMbs <= maxFs && mbps <= maxMbps) return idc;
  }
  return H264_TOP_LEVEL_IDC; // over-spec resolution; the encoder probe makes the final call
}

/**
 * The H.264 Constrained-Baseline WebCodecs codec string sized to `width`×`height`@`fps`:
 * `avc1.42E0<LL>` where `42` = Baseline profile_idc, `E0` = the constraint-set flags pinning Constrained
 * Baseline, and `<LL>` = the browser-facing encode level byte (two-hex, upper-case): the Annex-A minimum
 * from {@link h264LevelIdcForDimensions}, floored at L3.0 for Chromium platform seek compatibility on
 * tiny MP4 outputs. This replaces the old static `avc1.42E01E` for larger outputs so a 1080p/4K encode
 * still advertises a level the UA can actually accept.
 */
export function h264CodecStringForDimensions(
  width: number,
  height: number,
  fps: number | undefined,
): string {
  const idc = Math.max(
    H264_BROWSER_PLAYBACK_MIN_LEVEL_IDC,
    h264LevelIdcForDimensions(width, height, fps),
  );
  return `avc1.42E0${idc.toString(16).toUpperCase().padStart(2, '0')}`;
}

type EncodedAudioCodec = Exclude<AudioCodec, PcmCodec>;

/** Default WebCodecs codec strings for each encoded public audio token (AAC-LC, Opus, …). */
const AUDIO_CODEC_STRING: Record<EncodedAudioCodec, string> = {
  aac: 'mp4a.40.2',
  opus: 'opus',
  mp3: 'mp3',
  flac: 'flac',
  vorbis: 'vorbis',
};

function isPcmCodecToken(token: AudioCodec): token is PcmCodec {
  return token === 'pcm' || token.startsWith('pcm-');
}

// ── decoder codec-string normalization (demux token → valid WebCodecs string) ────────────────────

/**
 * Default WebCodecs DECODE codec strings for a bare codec token a container demux may emit (the WebM/
 * Matroska driver maps its CodecID to the canonical tokens `vp8`/`vp9`/`av1`/…). `VideoDecoder.
 * isConfigSupported` REQUIRES a fully-qualified string — bare `vp9`/`av1` are rejected — so we expand
 * them to a broadly-decodable default profile/level/depth. VP8 is already its own valid string. VP9
 * profile 0 @ L1.0 8-bit (`vp09.00.10.08`) and AV1 Main profile, level 3.0, 8-bit (`av01.0.04M.08`)
 * decode the common 8-bit streams; the decoder reads the ACTUAL profile/level from the bitstream, so a
 * conservative advertised string still decodes higher-rung content (these codecs are self-describing
 * in-band and need no `description`). H.264/HEVC are intentionally absent: they need the `description`
 * codec-private (avcC/hvcC) to form `avc1.PPCCLL`/`hev1…` — handled from the description below when set.
 */
const DECODE_CODEC_STRING: Readonly<Record<string, string>> = {
  vp8: 'vp8',
  vp9: 'vp09.00.10.08',
  av1: 'av01.0.04M.08',
};

/** True when `codec` is already a fully-qualified WebCodecs codec string (has a profile/dotted suffix). */
function isQualifiedCodecString(codec: string): boolean {
  const c = codec.toLowerCase();
  // vp8 is its own complete string; everything else qualified carries a dot (avc1.*, vp09.*, av01.*, …).
  return c === 'vp8' || c.includes('.');
}

/**
 * Two-hex (upper-case) for an avcC/hvcC byte — the `avc1.PPCCLL` building block. */
function hex2(n: number): string {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Derive an `avc1.PPCCLL` string from an H.264 `description` (AVCDecoderConfigurationRecord): byte[1]
 * AVCProfileIndication, byte[2] profile_compatibility, byte[3] AVCLevelIndication. Returns `undefined`
 * when the record is too short to read those three bytes. Pure; no WebCodecs.
 */
function avcCodecStringFromDescription(description: AllowSharedBufferSource): string | undefined {
  const bytes = bufferSourceBytes(description);
  const profile = bytes[1];
  const compat = bytes[2];
  const level = bytes[3];
  if (profile === undefined || compat === undefined || level === undefined) return undefined;
  return `avc1.${hex2(profile)}${hex2(compat)}${hex2(level)}`;
}

/** Reverse the 32 bits of `x` — HEVC stores profile compatibility flags in reverse bit order. */
function reverseBits32(x: number): number {
  let out = 0;
  for (let i = 0; i < 32; i++) out = (out << 1) | ((x >>> i) & 1);
  return out >>> 0;
}

/**
 * Derive a WebCodecs HEVC codec string from an HEVCDecoderConfigurationRecord (`hvcC`). Matroska/WebM
 * HEVC tracks surface the `hvcC` bytes as `description` but only a bare `hevc` token as `codec`; this
 * expands that pair into an exact RFC-6381 string. `prefix` is the sample-entry style to use when known;
 * bare Matroska defaults to `hev1`, the engine's HEVC encode token. Returns `undefined` for a truncated
 * record so the caller can preserve the typed capability miss instead of throwing a raw RangeError.
 */
function hevcCodecStringFromDescription(
  description: AllowSharedBufferSource,
  prefix: 'hev1' | 'hvc1' = 'hev1',
): string | undefined {
  const bytes = bufferSourceBytes(description);
  if (bytes.length < 13) return undefined;
  const profileByte = bytes[1];
  const compat0 = bytes[2];
  const compat1 = bytes[3];
  const compat2 = bytes[4];
  const compat3 = bytes[5];
  const constraint0 = bytes[6];
  const level = bytes[12];
  if (
    profileByte === undefined ||
    compat0 === undefined ||
    compat1 === undefined ||
    compat2 === undefined ||
    compat3 === undefined ||
    constraint0 === undefined ||
    level === undefined
  ) {
    return undefined;
  }
  const profileSpace = (profileByte >> 6) & 0x03;
  const profileIdc = profileByte & 0x1f;
  const tier = (profileByte & 0x20) !== 0 ? 'H' : 'L';
  const rawCompat = ((compat0 << 24) | (compat1 << 16) | (compat2 << 8) | compat3) >>> 0;
  const compat = reverseBits32(rawCompat).toString(16).toUpperCase();
  const space = profileSpace === 0 ? '' : String.fromCharCode(0x40 + profileSpace);
  let out = `${prefix}.${space}${profileIdc}.${compat}.${tier}${level}`;
  let lastConstraint = 5;
  while (lastConstraint >= 0 && bytes[6 + lastConstraint] === 0) lastConstraint--;
  for (let i = 0; i <= lastConstraint; i++) {
    const b = bytes[6 + i];
    if (b === undefined) return undefined;
    out += `.${hex2(b)}`;
  }
  return out;
}

/** A read-only byte view over an `ArrayBuffer`/typed-array `BufferSource` (no copy). */
function bufferSourceBytes(src: AllowSharedBufferSource): Uint8Array {
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  const view = src as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * Normalize a demuxed track's DECODE codec string to one `VideoDecoder`/`AudioDecoder` will accept.
 * A container demux (notably WebM/Matroska) emits the bare canonical token (`vp9`, `av1`, `h264`, …)
 * as `config.codec`, which `isConfigSupported` rejects; this maps it to a valid WebCodecs string:
 *   - already-qualified strings (`avc1.*`, `vp09.*`, `av01.*`, `vp8`, `opus`, `mp4a.*`, …) pass through;
 *   - bare `vp8`/`vp9`/`av1` → their default profile string ({@link DECODE_CODEC_STRING});
 *   - bare `h264`/`hevc` with a `description` (`avcC`/`hvcC`) → the profile-accurate RFC-6381 string;
 *   - anything else is returned unchanged (audio tokens like `opus`/`flac`/`vorbis` are already valid).
 * Pure + total; unit-tested. The wider H.264/HEVC-in-Matroska decode also needs the demuxer to surface
 * the CodecPrivate as `description` — without it the bare token cannot be expanded and decode stays a
 * miss (a demuxer-side gap, not this normalizer's).
 */
export function normalizeDecoderCodec(config: {
  codec: string;
  description?: AllowSharedBufferSource;
}): string {
  const codec = config.codec;
  if (isQualifiedCodecString(codec)) return codec;
  const lower = codec.toLowerCase();
  const mapped = DECODE_CODEC_STRING[lower];
  if (mapped !== undefined) return mapped;
  if ((lower === 'h264' || lower === 'avc') && config.description !== undefined) {
    return avcCodecStringFromDescription(config.description) ?? codec;
  }
  if ((lower === 'hevc' || lower === 'h265') && config.description !== undefined) {
    return hevcCodecStringFromDescription(config.description) ?? codec;
  }
  return codec;
}

/** The public video token a WebCodecs/MP4 codec string denotes (`avc1.*`→`h264`), for preserve-source. */
export function videoCodecToken(codecString: string): VideoCodec | undefined {
  const c = codecString.toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('avc3')) return 'h264';
  if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'hevc';
  if (c.startsWith('vp8')) return 'vp8';
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'vp9';
  if (c.startsWith('av01')) return 'av1';
  return undefined;
}

/** The public audio token a codec string denotes (`mp4a.*`→`aac`), for preserve-source. */
export function audioCodecToken(codecString: string): AudioCodec | undefined {
  const c = codecString.toLowerCase();
  if (c.startsWith('mp4a')) return 'aac';
  if (c.startsWith('opus')) return 'opus';
  if (c.startsWith('mp3') || c === 'mp4a.6b' || c === 'mp4a.69') return 'mp3';
  if (c.startsWith('flac')) return 'flac';
  if (c.startsWith('vorbis')) return 'vorbis';
  return undefined;
}

/**
 * Resolve the concrete WebCodecs video codec string to encode to: the caller's `codec` token mapped to
 * its default profile string, or — when the caller omitted a codec — the *source* codec string verbatim
 * (a same-codec transcode, e.g. re-encode after a resize). A source string that is not a recognized
 * WebCodecs video codec, with no explicit token, is a typed miss (we never guess a wrong codec).
 */
export function videoEncoderCodecString(
  token: VideoCodec | undefined,
  sourceCodecString: string | undefined,
): string {
  if (token !== undefined) return VIDEO_CODEC_STRING[token];
  if (sourceCodecString !== undefined && videoCodecToken(sourceCodecString) !== undefined) {
    assertSupportedVideoEncodeProfile(sourceCodecString);
    return sourceCodecString;
  }
  throw new CapabilityError('capability-miss', 'unknown video codec', {
    op: 'encode',
    tried: [],
  });
}

/** The parsed profile idc from a qualified HEVC codec string, or `undefined` for non-HEVC/malformed. */
function hevcProfileIdc(codecString: string): number | undefined {
  const match = /^(?:hev1|hvc1)\.([ABC]?)(\d+)\./i.exec(codecString);
  if (!match) return undefined;
  const idc = Number(match[2]);
  return Number.isInteger(idc) ? idc : undefined;
}

/** True for HEVC profiles this build cannot honestly encode without a software HEVC encoder tail. */
export function isUnsupportedHevcEncodeProfile(codecString: string): boolean {
  const profileIdc = hevcProfileIdc(codecString);
  return profileIdc !== undefined && profileIdc !== 1;
}

function assertSupportedVideoEncodeProfile(codecString: string): void {
  if (!isUnsupportedHevcEncodeProfile(codecString)) return;
  throw new CapabilityError('capability-miss', 'bad HEVC profile', {
    op: 'encode',
    tried: ['webcodecs-video'],
    suggestion: 'use HEVC Main8 or add Main10 encode',
  });
}

/** Resolve the WebCodecs audio codec string to encode to (caller token, else preserve the source). */
export function audioEncoderCodecString(
  token: AudioCodec | undefined,
  sourceCodecString: string | undefined,
): string {
  if (token !== undefined) {
    if (isPcmCodecToken(token)) {
      throw new CapabilityError('capability-miss', 'PCM uses DSP', {
        op: 'encode',
        tried: [],
      });
    }
    return AUDIO_CODEC_STRING[token];
  }
  if (sourceCodecString !== undefined && audioCodecToken(sourceCodecString) !== undefined) {
    return sourceCodecString;
  }
  throw new CapabilityError('capability-miss', 'unknown audio codec', {
    op: 'encode',
    tried: [],
  });
}

// ============ video filter chain (VideoTarget → ordered FilterSpec[]) ============

/**
 * Source geometry a video filter chain is planned against — the decoded frame's coded dimensions, read
 * from the demux `TrackInfo`'s WebCodecs config. Either may be `undefined` for a headerless source; the
 * resize/crop specs that need concrete dims then fall back to the explicit target dims.
 */
export interface SourceGeometry {
  width: number | undefined;
  height: number | undefined;
}

// `videoFilterSpecs` (the crop→resize→rotate→flip→colorspace→tonemap GPU spec builder) lives in
// `./video-stream-plan.ts`, reached ONLY via the engine's lazy `import()` on the convert-with-video-filter
// path. It was split out of this (statically-imported) module so the video-spec code stays OUT of the eager
// kernel closure (doc 08 §7). The geometry math an eager encode touches — {@link outputDimensions} +
// {@link SourceGeometry} — stays here (the video module imports the type only).

/**
 * The output frame dimensions after a filter chain, given the source coded dims — needed to size the
 * `VideoEncoderConfig`. Mirrors {@link videoFilterSpecs}: crop sets the size to the crop rect; resize to
 * the resize dims; a 90/270 rotate swaps width↔height; flip is dimension-preserving. Returns the source
 * dims unchanged when no geometry op applies. Pure (geometry only), so it is fully Node-tested.
 */
export function outputDimensions(
  target: VideoTarget,
  src: SourceGeometry,
): { width: number | undefined; height: number | undefined } {
  let width = src.width;
  let height = src.height;
  if (target.crop) {
    width = target.crop.width;
    height = target.crop.height;
  }
  if (target.width !== undefined || target.height !== undefined) {
    width = target.width ?? width;
    height = target.height ?? height;
  }
  if (target.rotate === 90 || target.rotate === 270) {
    const w = width;
    width = height;
    height = w;
  }
  return { width, height };
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InputError('unsupported-input', `${name} must be finite and positive`);
  }
}

// ============ audio filter chain (AudioTarget → ordered FilterSpec[]) ============

// `audioFilterSpecs` + its exclusive helpers (`fadeFramesAt`/`fadeCurve`/`resolveDynamics`) and the
// `SourceAudio` type live in `./audio-stream-plan.ts`, reached ONLY via the engine's lazy `import()` on the
// convert-with-lossy-audio-filter path. They were split out of this (statically-imported) module so the
// audio-spec code + its audio-dsp type imports stay OUT of the eager kernel closure (doc 08 §7 budget).

// ============ encoder configs (public target → WebCodecs *EncoderConfig) ============

interface EagerVideoRateTarget extends Pick<VideoTarget, 'bitrate' | 'crf'> {
  readonly bitrateMode?: VideoEncoderBitrateMode;
  readonly twoPass?: boolean;
}

function assertValidVideoBitrate(bitrate: number): void {
  if (!Number.isSafeInteger(bitrate) || bitrate <= 0) {
    throw new InputError('unsupported-input', 'invalid video bitrate');
  }
}

function eagerVideoRateConfig(target: EagerVideoRateTarget): {
  readonly bitrate?: number;
  readonly bitrateMode?: VideoEncoderBitrateMode;
} {
  if (target.bitrate !== undefined) assertValidVideoBitrate(target.bitrate);
  if (target.bitrate !== undefined && target.crf !== undefined) {
    throw new InputError('unsupported-input', 'bitrate/CRF conflict');
  }
  if (target.twoPass === true && target.bitrate === undefined) {
    throw new InputError('unsupported-input', 'two-pass needs bitrate');
  }
  if (target.crf !== undefined || target.twoPass === true) {
    throw new CapabilityError('capability-miss', 'CRF/two-pass unsupported', {
      op: 'encode',
      tried: ['webcodecs-video'],
      suggestion: 'route to encoder tail',
    });
  }
  return target.bitrate === undefined
    ? {}
    : { bitrate: target.bitrate, bitrateMode: target.bitrateMode ?? 'variable' };
}

/**
 * Build the {@link VideoEncoderConfig} for a target stream: the resolved codec string, the post-filter
 * output `width`/`height` (which must be known to configure an encoder), and the optional bitrate +
 * framerate. `latencyMode:'quality'` favours compression over realtime latency for an offline transcode.
 * Throws a typed {@link InputError} when output dims cannot be determined (no target dims, unknown source).
 */
export function buildVideoEncoderConfig(
  target: VideoTarget,
  src: SourceGeometry,
  sourceCodecString: string | undefined,
): VideoEncoderConfig {
  const { width, height } = outputDimensions(target, src);
  if (width === undefined || height === undefined) {
    throw new InputError('unsupported-input', 'video dims required');
  }
  // Resolve the codec string. For the `h264` TOKEN (the default Constrained-Baseline profile) we size
  // the level byte to the OUTPUT dims+fps so e.g. 1080p advertises ≥L4.0 and the UA accepts it (the old
  // static L3.0 made `isConfigSupported` reject ≥720p). A preserved SOURCE codec or any other token is
  // left exactly as-is — we never rewrite a profile/level the caller or source pinned.
  const codec =
    target.codec === 'h264'
      ? h264CodecStringForDimensions(width, height, target.fps)
      : videoEncoderCodecString(target.codec, sourceCodecString);
  assertSupportedVideoEncodeProfile(codec);
  if (target.fps !== undefined) assertPositiveFinite('fps', target.fps);
  const rateControl = eagerVideoRateConfig(target);
  return {
    codec,
    width,
    height,
    latencyMode: 'quality',
    ...rateControl,
    ...(target.fps !== undefined ? { framerate: target.fps } : {}),
  };
}

/**
 * Build the {@link AudioEncoderConfig} for a target stream: the resolved codec string plus sample rate,
 * channel count, and bitrate. Sample rate/channels fall back to the source track's, since an encoder
 * needs concrete values; absent both target and source they are a typed miss.
 */
export function buildAudioEncoderConfig(
  target: AudioTarget,
  src: { sampleRate: number | undefined; channels: number | undefined },
  sourceCodecString: string | undefined,
): AudioEncoderConfig {
  const codec = audioEncoderCodecString(target.codec, sourceCodecString);
  const sampleRate = target.sampleRate ?? src.sampleRate;
  const channels = target.channels ?? src.channels;
  if (sampleRate === undefined || channels === undefined) {
    throw new InputError('unsupported-input', 'audio layout required');
  }
  return {
    codec,
    sampleRate,
    numberOfChannels: channels,
    ...(target.bitrate !== undefined ? { bitrate: target.bitrate } : {}),
  };
}

// ============ mux TrackInfo from an encoder's decoder config ============

/**
 * Build the {@link TrackInfo} the `Muxer.addTrack` needs from the {@link VideoDecoderConfig} the video
 * encoder published (codec string + `description` + coded dims) plus the target framerate (which fixes
 * the mux timescale, mux.ts `videoTimescale`). The decoder config — not the public target — is the
 * source of truth so the muxer writes the exact codec box (avcC/hvcC/…) the encoder produced.
 */
export function videoTrackInfoFromDecoderConfig(
  config: VideoDecoderConfig,
  fps: number | undefined,
  durationSec?: number,
): TrackInfo {
  return {
    id: 0, // overwritten by the muxer's own id allocation; addTrack returns the real id
    mediaType: 'video',
    codec: config.codec,
    config,
    ...(fps !== undefined ? { fps } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
  };
}

/** Build the audio {@link TrackInfo} for `Muxer.addTrack` from the encoder's {@link AudioDecoderConfig}. */
export function audioTrackInfoFromDecoderConfig(
  config: AudioDecoderConfig,
  durationSec?: number,
): TrackInfo {
  return {
    id: 0,
    mediaType: 'audio',
    codec: config.codec,
    config,
    ...(durationSec !== undefined ? { durationSec } : {}),
  };
}

// ============ seek: drop-until-target predicate ============

/**
 * Frame-accurate seek bookkeeping: given a decoded frame's presentation `timestamp` (µs) and the seek
 * `target` (µs), should the frame be **kept** (it is the first frame at/after the target) or dropped
 * (it precedes the target and must be `close()`d)? Pure and total, exercised directly in Node. The live
 * loop ({@link seekFrame}) closes every dropped frame and returns the first kept one.
 */
export function frameSatisfiesSeek(timestampUs: number, targetUs: number): boolean {
  return timestampUs >= targetUs;
}

// ============ live composition (frame streams; pure control flow, fake-frame-testable) ============

// These compose real streams but touch only `.timestamp`/`.type` and `close()` on the items, so they run
// and are unit-tested in Node with fake frame/chunk objects (no WebCodecs construction); the live
// round-trips with real `VideoFrame`s are validated in the browser harness (BUILD §6.1).

/** The minimal `Muxer` surface {@link drainEncoderToMuxer} needs (addTrack + write a {@link Packet}). */
export interface MuxerSink {
  addTrack(info: TrackInfo): number;
  write(trackId: number, packet: Packet): Promise<void>;
}

/**
 * Normalize a seam item to a {@link Packet}: a bare {@link EncodedChunk} from an *encoder* (PTS only, the
 * muxer recovers DTS from arrival/durations) is wrapped `{ chunk }`; a {@link Packet} from a *demuxer*
 * (verbatim remux — already carries `dtsUs`) passes through. `'chunk' in v` cleanly discriminates: the
 * sealed `Encoded*Chunk` host objects have no `chunk` property. Pure + total.
 */
function toPacket(v: EncodedChunk | Packet): Packet {
  return v instanceof Object && 'chunk' in v ? v : { chunk: v };
}

/**
 * Drop the DTS side-channel: project a {@link Packet} stream back to the bare {@link EncodedChunk}s a
 * WebCodecs decoder consumes (the decoder only needs the coded bytes + PTS in `timestamp`; DTS is a
 * muxer concern). Used at every demux→decode seam in the engine. Pure stream plumbing — Node-testable
 * with fake packets; the live decode that follows is browser-gated.
 */
export function unwrapPackets(packets: ReadableStream<Packet>): ReadableStream<EncodedChunk> {
  return packets.pipeThrough(
    new TransformStream<Packet, EncodedChunk>({
      transform(p, controller): void {
        controller.enqueue(p.chunk);
      },
    }),
  );
}

/**
 * Drain a seam stream into a `Muxer`, allocating the track lazily on the first item — *after* the
 * encoder has published its `decoderConfig` (codec box), which the caller captures through the encoder
 * driver's `onDecoderConfig`/`onConfig` bridge. Serves BOTH seam producers: an *encoder*'s bare
 * {@link EncodedChunk}s (PTS only — the muxer recovers DTS from arrival order/durations) and a
 * *demuxer*'s {@link Packet}s (verbatim remux — carrying the source `dtsUs` so B-frame composition
 * survives losslessly); each item is normalized via {@link toPacket} before `write`. Returns when the
 * stream ends (all packets written). An empty stream allocates no track (an encoder that produced
 * nothing does not create a sample-less track).
 *
 * Frame lifetime: packets are not closable; the encoder already closed every input `VideoFrame`/
 * `AudioData` (its contract). On error the stream rejects and the caller cancels the siblings.
 */
export async function drainEncoderToMuxer(
  chunks: ReadableStream<EncodedChunk | Packet>,
  muxer: MuxerSink,
  getConfig: () => TrackInfo,
): Promise<void> {
  const reader = chunks.getReader();
  let trackId: number | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (trackId === undefined) trackId = muxer.addTrack(getConfig());
      await muxer.write(trackId, toPacket(value));
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run a seek: pull decoded `VideoFrame`s from `frames`, `close()` every frame whose timestamp precedes
 * `targetUs`, and resolve with the first frame at/after it (ownership transfers to the caller, who must
 * `close()` it). If the stream ends before reaching the target, the *last* decoded frame is returned (the
 * closest available, e.g. seeking past the final PTS); a stream with no frames at all rejects with a
 * typed {@link InputError}. The reader is cancelled once the target frame is found so the decoder tears
 * down and the remaining packets stop flowing. Every dropped frame is `close()`d exactly once (doc 06 §3).
 */
export async function seekFrame(
  frames: ReadableStream<VideoFrame>,
  targetUs: number,
): Promise<VideoFrame> {
  const reader = frames.getReader();
  let last: VideoFrame | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (frameSatisfiesSeek(value.timestamp, targetUs)) {
        // Found the target frame; close the previous candidate (if any) and hand this one to the caller.
        if (last !== undefined) closeFrame(last);
        last = undefined;
        void reader.cancel(); // stop the decoder; remaining frames are never produced
        return value;
      }
      // This frame precedes the target: it is a drop. Keep it only as the running "closest" fallback.
      if (last !== undefined) closeFrame(last);
      last = value;
    }
  } catch (e) {
    if (last !== undefined) closeFrame(last);
    await reader.cancel(e).catch(() => {});
    throw e;
  }
  if (last !== undefined) return last; // sought past the last PTS → closest available frame
  throw new InputError('unsupported-input', 'no seek frame');
}
