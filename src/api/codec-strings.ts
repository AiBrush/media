/**
 * Codec-string + level math (S13 layer 1, docs/architecture/codec-pipeline.md §3.2): the WebCodecs
 * codec-string grammar (RFC 6381 / WebCodecs Codec Registry), the VP9/AV1/H.264 level tables they are
 * sized against, the avcC/hvcC description parsers, and the bit-depth/profile parsers. Everything here
 * is *pure* and total — no WebCodecs objects, no frames, no runtime/browser detection — and is
 * Node-unit-tested against the published table boundaries with can-fail oracles (ADR-025).
 *
 * The single public target+source→string resolver is `resolveVideoEncoderCodecString` in
 * `encoder-config.ts`; the former `videoEncoderCodecString`/`h264CodecStringForSourceProfile` doors are
 * private helpers of the shared plan below (`resolvedVideoEncoderCodecString`).
 */

import { CapabilityError, InputError } from '../contracts/errors.ts';
import type { VideoCodec, VideoTarget } from './types.ts';

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
  hevc: 'hvc1.1.6.L93.B0',
  vp8: 'vp8',
  vp9: 'vp09.00.10.08',
  av1: 'av01.0.04M.08',
};

/** HEVC Main10, Main tier, Level 4.0 — the explicit WebCodecs target for requested 10-bit output. */
const HEVC_MAIN10_CODEC_STRING = 'hvc1.2.4.L120.B0';

/** Video encode bit depths this pipeline can author codec strings for. */
export type VideoBitDepth = 8 | 10 | 12;

type Vp9Level = readonly [
  level: number,
  maxPictureSamples: number,
  maxDimension: number,
  maxDisplaySampleRate: number,
  maxBitrate: number,
];

/** WebM VP9 4:2:0 levels, ordered by increasing capability. Bitrate values are bits/second. */
const VP9_LEVELS = [
  [10, 36_864, 512, 829_440, 200_000],
  [11, 73_728, 768, 2_764_800, 800_000],
  [20, 122_880, 960, 4_608_000, 1_800_000],
  [21, 245_760, 1_344, 9_216_000, 3_600_000],
  [30, 552_960, 2_048, 20_736_000, 7_200_000],
  [31, 983_040, 2_752, 36_864_000, 12_000_000],
  [40, 2_228_224, 4_160, 83_558_400, 18_000_000],
  [41, 2_228_224, 4_160, 160_432_128, 30_000_000],
  [50, 8_912_896, 8_384, 311_951_360, 60_000_000],
  [51, 8_912_896, 8_384, 588_251_136, 120_000_000],
  [52, 8_912_896, 8_384, 1_176_502_272, 180_000_000],
  [60, 35_651_584, 16_832, 1_176_502_272, 180_000_000],
  [61, 35_651_584, 16_832, 2_353_004_544, 240_000_000],
  [62, 35_651_584, 16_832, 4_706_009_088, 480_000_000],
] as const satisfies readonly Vp9Level[];

type Av1Level = readonly [
  sequenceLevelIndex: number,
  maxPictureSamples: number,
  maxWidth: number,
  maxHeight: number,
  maxDisplaySampleRate: number,
  mainTierBitrate: number,
];

/** AV1 Annex-A defined levels, ordered by increasing capability. Undefined 2.2/2.3 etc. are omitted. */
const AV1_LEVELS = [
  [0, 147_456, 2_048, 1_152, 4_423_680, 1_500_000],
  [1, 278_784, 2_816, 1_584, 8_363_520, 3_000_000],
  [4, 665_856, 4_352, 2_448, 19_975_680, 6_000_000],
  [5, 1_065_024, 5_504, 3_096, 31_950_720, 10_000_000],
  [8, 2_359_296, 6_144, 3_456, 70_778_880, 12_000_000],
  [9, 2_359_296, 6_144, 3_456, 141_557_760, 20_000_000],
  [12, 8_912_896, 8_192, 4_352, 267_386_880, 30_000_000],
  [13, 8_912_896, 8_192, 4_352, 534_773_760, 40_000_000],
  [14, 8_912_896, 8_192, 4_352, 1_069_547_520, 60_000_000],
  [15, 8_912_896, 8_192, 4_352, 1_069_547_520, 60_000_000],
  [16, 35_651_584, 16_384, 8_704, 1_069_547_520, 60_000_000],
  [17, 35_651_584, 16_384, 8_704, 2_139_095_040, 100_000_000],
  [18, 35_651_584, 16_384, 8_704, 4_278_190_080, 160_000_000],
  [19, 35_651_584, 16_384, 8_704, 4_278_190_080, 160_000_000],
] as const satisfies readonly Av1Level[];

function videoDisplaySampleRate(width: number, height: number, fps: number): number {
  return width * height * fps;
}

function noVideoLevel(
  codec: 'VP9' | 'AV1',
  width: number,
  height: number,
  fps: number | 'unknown',
): never {
  throw new CapabilityError(
    `${codec} output ${width}x${height}@${fps} exceeds the defined level envelope`,
    {
      op: { kind: 'route', id: 'encode' },
      tried: ['webcodecs-video'],
      suggestion: 'reduce output dimensions, frame rate, or explicit bitrate',
    },
  );
}

/** Author an exact VP9 profile/level/depth codec string for a 4:2:0 encoder request. */
export function vp9CodecStringForConfig(
  width: number,
  height: number,
  fps: number | undefined,
  bitDepth: VideoBitDepth,
  explicitBitrate: number | undefined,
): string {
  const pictureSamples = width * height;
  const profile = bitDepth === 8 ? '00' : '02';
  if (fps === undefined) {
    const top = VP9_LEVELS.at(-1);
    if (
      top !== undefined &&
      pictureSamples <= top[1] &&
      width <= top[2] &&
      height <= top[2] &&
      (explicitBitrate === undefined || explicitBitrate <= top[4])
    ) {
      return `vp09.${profile}.${top[0]}.${bitDepth.toString().padStart(2, '0')}`;
    }
    return noVideoLevel('VP9', width, height, 'unknown');
  }
  const displaySampleRate = videoDisplaySampleRate(width, height, fps);
  for (const [level, maxPicture, maxDimension, maxRate, maxBitrate] of VP9_LEVELS) {
    if (
      pictureSamples <= maxPicture &&
      width <= maxDimension &&
      height <= maxDimension &&
      displaySampleRate <= maxRate &&
      (explicitBitrate === undefined || explicitBitrate <= maxBitrate)
    ) {
      return `vp09.${profile}.${level}.${bitDepth.toString().padStart(2, '0')}`;
    }
  }
  return noVideoLevel('VP9', width, height, fps);
}

/** Author an exact AV1 Main-tier profile/level/depth codec string for a 4:2:0 encoder request. */
export function av1CodecStringForConfig(
  width: number,
  height: number,
  fps: number | undefined,
  bitDepth: VideoBitDepth,
  explicitBitrate: number | undefined,
): string {
  const pictureSamples = width * height;
  const profile = bitDepth === 12 ? 2 : 0;
  const bitrateFactor = profile === 2 ? 3 : 1;
  if (fps === undefined) {
    const top = AV1_LEVELS.at(-1);
    if (
      top !== undefined &&
      pictureSamples <= top[1] &&
      width <= top[2] &&
      height <= top[3] &&
      (explicitBitrate === undefined || explicitBitrate <= top[5] * bitrateFactor)
    ) {
      return `av01.${profile}.${top[0].toString().padStart(2, '0')}M.${bitDepth.toString().padStart(2, '0')}`;
    }
    return noVideoLevel('AV1', width, height, 'unknown');
  }
  const displaySampleRate = videoDisplaySampleRate(width, height, fps);
  for (const [level, maxPicture, maxWidth, maxHeight, maxRate, mainBitrate] of AV1_LEVELS) {
    if (
      pictureSamples <= maxPicture &&
      width <= maxWidth &&
      height <= maxHeight &&
      displaySampleRate <= maxRate &&
      (explicitBitrate === undefined || explicitBitrate <= mainBitrate * bitrateFactor)
    ) {
      return `av01.${profile}.${level.toString().padStart(2, '0')}M.${bitDepth.toString().padStart(2, '0')}`;
    }
  }
  return noVideoLevel('AV1', width, height, fps);
}

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

/** The Annex-A minimum level byte as two-hex, upper-case (spec-correct, no browser floor). */
function h264EncodeLevelHex(width: number, height: number, fps: number | undefined): string {
  const idc = h264LevelIdcForDimensions(width, height, fps);
  return idc.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * The H.264 Constrained-Baseline WebCodecs codec string sized to `width`×`height`@`fps`:
 * `avc1.42E0<LL>` where `42` = Baseline profile_idc, `E0` = the constraint-set flags pinning Constrained
 * Baseline, and `<LL>` = the browser-facing encode level byte: the Annex-A minimum from
 * {@link h264LevelIdcForDimensions}, floored at L3.0 for Chromium platform seek compatibility on tiny
 * MP4 outputs. This replaces the old static `avc1.42E01E` for larger outputs so a 1080p/4K encode
 * still advertises a level the UA can actually accept.
 */
export function h264CodecStringForDimensions(
  width: number,
  height: number,
  fps: number | undefined,
): string {
  return `avc1.42E0${h264EncodeLevelHex(width, height, fps)}`;
}

/**
 * Size an H.264 token encode while retaining a source Main/High profile when one is explicitly known.
 * Those profiles enable the inter-frame/CABAC tools needed for efficient constrained-rate offline output;
 * an unknown/Baseline source keeps the broadly compatible Constrained-Baseline default. Private helper of
 * {@link resolvedVideoEncoderCodecString} (docs/architecture/codec-pipeline.md §5 item 4).
 */
function h264CodecStringForSourceProfile(
  width: number,
  height: number,
  fps: number | undefined,
  sourceCodecString: string | undefined,
): string {
  const profile = /^(?:avc1|avc3)\.([0-9a-f]{2})/i
    .exec(sourceCodecString ?? '')?.[1]
    ?.toUpperCase();
  // High10 (0x6E) down-converted to 8-bit preserves High tools (CABAC, 8×8) → High, not Baseline.
  const profileAndCompatibility =
    profile === '64' || profile === '6E' ? '6400' : profile === '4D' ? '4D00' : '42E0';
  return `avc1.${profileAndCompatibility}${h264EncodeLevelHex(width, height, fps)}`;
}

/** Two-hex (upper-case) for an avcC/hvcC byte — the `avc1.PPCCLL` building block. */
function hex2(n: number): string {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Derive an `avc1.PPCCLL` string from an H.264 `description` (AVCDecoderConfigurationRecord): byte[1]
 * AVCProfileIndication, byte[2] profile_compatibility, byte[3] AVCLevelIndication. Returns `undefined`
 * when the record is too short to read those three bytes. Pure; no WebCodecs.
 */
export function avcCodecStringFromDescription(
  description: AllowSharedBufferSource,
): string | undefined {
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
 * expands that pair into an exact RFC-6381 string. A present `hvcC` `description` **is** the signal that
 * the parameter sets (VPS/SPS/PPS) live out-of-band in the config record, not inline in the samples — the
 * `hvc1` sample-entry semantic — so bare Matroska defaults to `hvc1`, mirroring how the H.264 sibling
 * ({@link avcCodecStringFromDescription}) yields `avc1` from an out-of-band `avcC`. Advertising `hev1`
 * (which signals parameter sets **may** appear inline and array_completeness=0) to a decoder fed an
 * hvc1-style bitstream with no in-band VPS/SPS/PPS makes some WebCodecs decoders wait for parameter sets
 * that never arrive and emit zero frames (a 0×0 `decode(mux(x))`); `hvc1` is also the most broadly
 * decodable HEVC form across browsers. Returns `undefined` for a truncated record so the caller can
 * preserve the typed capability miss instead of throwing a raw RangeError.
 */
export function hevcCodecStringFromDescription(
  description: AllowSharedBufferSource,
  prefix: 'hev1' | 'hvc1' = 'hvc1',
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

/** The public video token a WebCodecs/MP4 codec string denotes (`avc1.*`→`h264`), for preserve-source. */
export function videoCodecToken(codecString: string): VideoCodec | undefined {
  const c = codecString.toLowerCase();
  if (c === 'h264' || c === 'hevc' || c === 'vp8' || c === 'vp9' || c === 'av1') return c;
  if (c.startsWith('avc1') || c.startsWith('avc3')) return 'h264';
  if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'hevc';
  if (c.startsWith('vp8')) return 'vp8';
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'vp9';
  if (c.startsWith('av01')) return 'av1';
  return undefined;
}

/** True when a codec string's family can carry a Matroska/WebM alpha side stream (VP8/VP9 only). */
export function videoCodecCanCarryAlpha(codecString: string): boolean {
  const c = codecString.toLowerCase();
  return c === 'vp8' || c.startsWith('vp8.') || c === 'vp9' || c.startsWith('vp09.');
}

/**
 * Resolve the concrete WebCodecs video codec string to encode to: the caller's `codec` token mapped to
 * its default profile string, or — when the caller omitted a codec — the *source* codec string verbatim
 * (a same-codec transcode, e.g. re-encode after a resize). A source string that is not a recognized
 * WebCodecs video codec, with no explicit token, is a typed miss (we never guess a wrong codec).
 * Private helper of {@link resolvedVideoEncoderCodecString}.
 */
function videoEncoderCodecString(
  token: VideoCodec | undefined,
  sourceCodecString: string | undefined,
): string {
  if (token !== undefined) return VIDEO_CODEC_STRING[token];
  if (sourceCodecString !== undefined && videoCodecToken(sourceCodecString) !== undefined) {
    assertSupportedVideoEncodeProfile(sourceCodecString);
    return sourceCodecString;
  }
  throw new CapabilityError('unknown video codec', {
    op: { kind: 'route', id: 'encode' },
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

/** True for HEVC profiles outside the WebCodecs Main/Main10 output surface used by this build. */
export function isUnsupportedHevcEncodeProfile(codecString: string): boolean {
  const profileIdc = hevcProfileIdc(codecString);
  return profileIdc !== undefined && profileIdc !== 1 && profileIdc !== 2;
}

export function assertSupportedVideoEncodeProfile(codecString: string): void {
  if (!isUnsupportedHevcEncodeProfile(codecString)) return;
  throw new CapabilityError('bad HEVC profile', {
    op: { kind: 'route', id: 'encode' },
    tried: ['webcodecs-video'],
    suggestion: 'use HEVC Main or Main10, or add a proven encoder tail for the requested profile',
  });
}

// ── bit-depth parsing (codec string → sample depth) ──────────────────────────────────────────────

export function normalizeVideoBitDepth(depth: number | undefined): VideoBitDepth | undefined {
  if (depth === undefined) return undefined;
  if (depth === 8 || depth === 10 || depth === 12) return depth;
  throw new InputError(`unsupported video bit depth ${depth}`);
}

function bitDepthFromAvc(codec: string): VideoBitDepth | undefined {
  const match = /^avc[13]\.([0-9a-f]{2})/i.exec(codec);
  const profileHex = match?.[1];
  if (profileHex === undefined) return undefined;
  const profile = Number.parseInt(profileHex, 16);
  return profile === 110 ? 10 : 8;
}

function bitDepthFromHevc(codec: string): VideoBitDepth | undefined {
  const profile = hevcProfileIdc(codec);
  if (profile === undefined) return undefined;
  if (profile === 1) return 8;
  if (profile === 2) return 10;
  return undefined;
}

function bitDepthFromDelimitedCodec(
  codec: string,
  prefix: 'vp09' | 'av01',
): VideoBitDepth | undefined {
  const fields = codec.split('.');
  if (fields[0]?.toLowerCase() !== prefix) return undefined;
  const rawDepth = fields[3];
  if (rawDepth === undefined) return undefined;
  return normalizeVideoBitDepth(Number(rawDepth));
}

export function bitDepthFromCodec(codec: string): VideoBitDepth | undefined {
  const lower = codec.toLowerCase();
  return (
    bitDepthFromAvc(lower) ??
    bitDepthFromHevc(lower) ??
    bitDepthFromDelimitedCodec(lower, 'vp09') ??
    bitDepthFromDelimitedCodec(lower, 'av01') ??
    (lower === 'vp8' ? 8 : undefined)
  );
}

function unsupportedVideoBitDepth(codec: VideoCodec, bitDepth: VideoBitDepth): never {
  throw new CapabilityError(`video ${bitDepth}-bit output is not available for ${codec}`, {
    op: { kind: 'route', id: 'encode' },
    tried: ['webcodecs-video'],
    suggestion:
      codec === 'h264'
        ? 'use 8-bit H.264 until a High10 encode+mux path is browser-proven'
        : codec === 'hevc'
          ? 'use HEVC Main or Main10'
          : 'target VP9 or AV1 for a probed high-bit-depth encode',
  });
}

/**
 * The shared codec-string projection of the video encode plan: explicit token → sized default profile;
 * omitted token → preserve/re-level the source family. This is the ONLY door into the private
 * `videoEncoderCodecString`/`h264CodecStringForSourceProfile` helpers; the public resolver
 * (`resolveVideoEncoderCodecString`, encoder-config.ts) and `buildVideoEncoderConfig` both project it
 * from the same plan so string and config can never drift.
 */
export function resolvedVideoEncoderCodecString(
  target: Pick<VideoTarget, 'codec' | 'bitDepth'>,
  width: number,
  height: number,
  fps: number | undefined,
  sourceCodecString: string | undefined,
  effectiveBitrate: number | undefined,
  preserveSourceQualification: boolean,
): string {
  const requestedDepth = normalizeVideoBitDepth(target.bitDepth);
  const sourceToken =
    sourceCodecString === undefined ? undefined : videoCodecToken(sourceCodecString);
  const sourceDepth =
    sourceCodecString === undefined ? undefined : bitDepthFromCodec(sourceCodecString);

  if (preserveSourceQualification) {
    return videoEncoderCodecString(undefined, sourceCodecString);
  }

  const codec = target.codec ?? sourceToken;
  if (codec === undefined) return videoEncoderCodecString(undefined, sourceCodecString);
  if (target.codec === undefined && codec === 'hevc' && sourceDepth === undefined) {
    return videoEncoderCodecString(undefined, sourceCodecString);
  }
  const bitDepth = requestedDepth ?? (target.codec === undefined ? sourceDepth : undefined) ?? 8;
  switch (codec) {
    case 'h264':
      if (bitDepth !== 8) return unsupportedVideoBitDepth(codec, bitDepth);
      return h264CodecStringForSourceProfile(width, height, fps, sourceCodecString);
    case 'hevc':
      // Encoders surface the parameter sets in `description`; advertise the matching hvc1 sample-entry
      // promise. It is the interoperable MP4 form for this out-of-band stream; labeling it hev1 can
      // make an otherwise valid output undecodable by strict players.
      if (bitDepth === 8) return VIDEO_CODEC_STRING.hevc;
      if (bitDepth === 10) return HEVC_MAIN10_CODEC_STRING;
      return unsupportedVideoBitDepth(codec, bitDepth);
    case 'vp8':
      if (bitDepth !== 8) return unsupportedVideoBitDepth(codec, bitDepth);
      return VIDEO_CODEC_STRING.vp8;
    case 'vp9':
      return vp9CodecStringForConfig(width, height, fps, bitDepth, effectiveBitrate);
    case 'av1':
      return av1CodecStringForConfig(width, height, fps, bitDepth, effectiveBitrate);
  }
}

/** The top defined level's bitrate ceiling for an implicit VP9/AV1 encode (undefined = no table cap). */
export function maximumLevelBitrate(
  codec: VideoCodec | 'unknown',
  bitDepth: VideoBitDepth,
): number | undefined {
  if (codec === 'vp9') return VP9_LEVELS.at(-1)?.[4];
  if (codec === 'av1') {
    const main = AV1_LEVELS.at(-1)?.[5];
    return main === undefined ? undefined : main * (bitDepth === 12 ? 3 : 1);
  }
  return undefined;
}

/** The declared level's bitrate ceiling parsed from a qualified VP9/AV1 codec string. */
export function declaredLevelBitrate(codecString: string): number | undefined {
  const vp9 = /^vp09\.\d{2}\.(\d{2})\./i.exec(codecString);
  if (vp9?.[1] !== undefined) {
    const level = Number(vp9[1]);
    return VP9_LEVELS.find(([candidate]) => candidate === level)?.[4];
  }
  const av1 = /^av01\.(\d)\.(\d{2})([MH])\./i.exec(codecString);
  if (av1?.[1] !== undefined && av1[2] !== undefined && av1[3]?.toUpperCase() === 'M') {
    const profile = Number(av1[1]);
    const level = Number(av1[2]);
    const main = AV1_LEVELS.find(([candidate]) => candidate === level)?.[5];
    return main === undefined ? undefined : main * (profile === 2 ? 3 : 1);
  }
  return undefined;
}
