/**
 * Exact VP9/AV1 codec qualification for WebM/Matroska. These containers identify the family with
 * `V_VP9`/`V_AV1`; this module turns their CodecPrivate or first sequence-bearing access unit into the
 * fully qualified string WebCodecs probes. It never decodes or mutates packet bytes.
 */

import { CapabilityError, MediaError } from '../../contracts/errors.ts';

export type VideoBitDepth = 8 | 10 | 12;

export interface Vp9CodecFacts {
  readonly codec: string;
  readonly profile: 0 | 1 | 2 | 3;
  readonly level: number;
  readonly bitDepth: VideoBitDepth;
  readonly chromaSubsampling?: 0 | 1 | 2 | 3;
}

export interface Vp9HeaderFacts {
  readonly profile: 0 | 1 | 2 | 3;
  readonly bitDepth: VideoBitDepth;
  readonly chromaSubsampling: 0 | 1 | 2 | 3;
  readonly width: number;
  readonly height: number;
}

export interface Av1CodecFacts {
  readonly codec: string;
  readonly profile: 0 | 1 | 2;
  readonly level: number;
  readonly tier: 'M' | 'H';
  readonly bitDepth: VideoBitDepth;
  readonly monochrome: boolean;
  readonly subsamplingX: boolean;
  readonly subsamplingY: boolean;
  readonly width?: number;
  readonly height?: number;
}

export interface WebmVideoCodecRequest {
  readonly codec: 'vp9' | 'av1';
  readonly codecPrivate?: Uint8Array;
  readonly firstKeyframe?: Uint8Array;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  /** Whole-container bytes; this is a conservative upper bound for one video track's average bitrate. */
  readonly sourceSizeBytes?: number;
  readonly durationSec?: number;
}

export interface WebmVideoCodecQualification {
  readonly codec: string;
  readonly source: 'codec-private' | 'bitstream' | 'unknown';
  /** Only AV1 passes its AV1CodecConfigurationRecord through to VideoDecoderConfig.description. */
  readonly description?: Uint8Array;
}

type Vp9Level = readonly [
  level: number,
  maxPictureSamples: number,
  maxDimension: number,
  maxDisplaySampleRate: number,
  maxBitrate: number,
];

/** WebM Project 4:2:0 decoder levels, ordered by increasing capability. */
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

const VP9_LEVEL_VALUES = new Set(VP9_LEVELS.map(([level]) => level));
type Vp9LevelValue = (typeof VP9_LEVELS)[number][0];

function demuxError(message: string, detail?: unknown): MediaError {
  return new MediaError('demux-error', message, detail);
}

function codecField(value: number, width = 2): string {
  return value.toString(10).padStart(width, '0');
}

function qualificationError(stage: 'demux-error' | 'mux-error', message: string): MediaError {
  return new MediaError(stage, message);
}

function isVp9Level(value: number): value is Vp9LevelValue {
  return VP9_LEVEL_VALUES.has(value as Vp9LevelValue);
}

function asVp9Profile(
  value: number,
  stage: 'demux-error' | 'mux-error' = 'demux-error',
): 0 | 1 | 2 | 3 {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  throw qualificationError(stage, `VP9 profile ${value} is outside 0..3`);
}

function asAv1Profile(
  value: number,
  stage: 'demux-error' | 'mux-error' = 'demux-error',
): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) return value;
  throw qualificationError(stage, `AV1 profile ${value} is outside 0..2`);
}

function asBitDepth(
  value: number,
  codec: 'VP9' | 'AV1',
  stage: 'demux-error' | 'mux-error' = 'demux-error',
): VideoBitDepth {
  if (value === 8 || value === 10 || value === 12) return value;
  throw qualificationError(stage, `${codec} bit depth ${value} is not 8, 10, or 12`);
}

function asChromaSubsampling(
  value: number,
  stage: 'demux-error' | 'mux-error' = 'demux-error',
): 0 | 1 | 2 | 3 {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  throw qualificationError(stage, `VP9 chroma-subsampling value ${value} is outside 0..3`);
}

function validateVp9Layout(
  profile: 0 | 1 | 2 | 3,
  bitDepth: VideoBitDepth,
  chromaSubsampling?: 0 | 1 | 2 | 3,
  stage: 'demux-error' | 'mux-error' = 'demux-error',
): void {
  if ((profile <= 1 && bitDepth !== 8) || (profile >= 2 && bitDepth === 8)) {
    throw qualificationError(stage, `VP9 profile ${profile} contradicts ${bitDepth}-bit depth`);
  }
  if (
    chromaSubsampling !== undefined &&
    ((profile % 2 === 0 && chromaSubsampling >= 2) || (profile % 2 === 1 && chromaSubsampling <= 1))
  ) {
    throw qualificationError(
      stage,
      `VP9 profile ${profile} contradicts chroma-subsampling value ${chromaSubsampling}`,
    );
  }
}

/** Parse WebM's VP9 `[feature-id, length, payload]` CodecPrivate list. */
export function parseVp9CodecPrivate(bytes: Uint8Array): Vp9CodecFacts {
  let offset = 0;
  const values = new Map<number, number>();
  while (offset < bytes.byteLength) {
    const idByte = bytes[offset];
    const length = bytes[offset + 1];
    if (idByte === undefined || length === undefined) {
      throw demuxError('VP9 CodecPrivate ends inside a feature header');
    }
    if ((idByte & 0x80) !== 0) {
      throw demuxError('VP9 CodecPrivate feature expansion bit must be zero');
    }
    const id = idByte & 0x7f;
    const dataStart = offset + 2;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.byteLength) {
      throw demuxError(`VP9 CodecPrivate feature ${id} is truncated`);
    }
    if (values.has(id)) throw demuxError(`VP9 CodecPrivate repeats feature ${id}`);
    if (id >= 1 && id <= 4) {
      if (length !== 1) throw demuxError(`VP9 CodecPrivate feature ${id} must be one byte`);
      const value = bytes[dataStart];
      if (value === undefined) throw demuxError(`VP9 CodecPrivate feature ${id} has no value`);
      values.set(id, value);
    }
    offset = dataEnd;
  }

  const profileValue = values.get(1);
  const level = values.get(2);
  const depthValue = values.get(3);
  if (profileValue === undefined || level === undefined || depthValue === undefined) {
    throw demuxError('VP9 CodecPrivate must declare profile, level, and bit depth');
  }
  const profile = asVp9Profile(profileValue);
  if (!isVp9Level(level)) throw demuxError(`VP9 CodecPrivate level ${level} is undefined`);
  const bitDepth = asBitDepth(depthValue, 'VP9');
  const chromaValue = values.get(4);
  const chromaSubsampling =
    chromaValue === undefined ? undefined : asChromaSubsampling(chromaValue);
  validateVp9Layout(profile, bitDepth, chromaSubsampling);
  return {
    codec: `vp09.${codecField(profile)}.${codecField(level)}.${codecField(bitDepth)}`,
    profile,
    level,
    bitDepth,
    ...(chromaSubsampling !== undefined ? { chromaSubsampling } : {}),
  };
}

function decimalField(field: string | undefined, name: string): number {
  if (field === undefined || !/^\d+$/.test(field)) {
    throw new MediaError('mux-error', `codec-string ${name} field '${field}' is not decimal`);
  }
  return Number.parseInt(field, 10);
}

/** Serialize a qualified `vp09` string as WebM's codec-feature list (never an ISO `vpcC`). */
export function vp9CodecPrivateFromCodecString(codec: string): Uint8Array {
  const lower = codec.trim().toLowerCase();
  if (!lower.startsWith('vp09.')) {
    throw new MediaError(
      'mux-error',
      `WebM VP9 needs a qualified vp09 codec string, got '${codec}'`,
    );
  }
  const fields = lower.slice(5).split('.');
  const profile = asVp9Profile(decimalField(fields[0], 'profile'), 'mux-error');
  const level = decimalField(fields[1], 'level');
  if (!isVp9Level(level)) throw new MediaError('mux-error', `VP9 level ${level} is undefined`);
  const bitDepth = asBitDepth(decimalField(fields[2], 'bitDepth'), 'VP9', 'mux-error');
  const chromaSubsampling =
    fields[3] === undefined
      ? ((profile % 2 === 0 ? 1 : 3) as 1 | 3)
      : asChromaSubsampling(decimalField(fields[3], 'chroma'), 'mux-error');
  validateVp9Layout(profile, bitDepth, chromaSubsampling, 'mux-error');
  return Uint8Array.of(1, 1, profile, 2, 1, level, 3, 1, bitDepth, 4, 1, chromaSubsampling);
}

class BitReader {
  #offset = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly label: string,
  ) {}

  get remaining(): number {
    return this.bytes.byteLength * 8 - this.#offset;
  }

  read(width: number, field: string): number {
    if (!Number.isInteger(width) || width < 0 || width > 32 || this.remaining < width) {
      throw demuxError(`${this.label} is truncated at ${field}`);
    }
    let value = 0;
    for (let index = 0; index < width; index++) {
      const bitOffset = this.#offset++;
      value = value * 2 + (((this.bytes[bitOffset >> 3] ?? 0) >> (7 - (bitOffset & 7))) & 1);
    }
    return value;
  }

  readUvlc(field: string): number {
    let leadingZeroes = 0;
    while (this.read(1, field) === 0) {
      leadingZeroes++;
      if (leadingZeroes > 30) throw demuxError(`${this.label} ${field} exceeds 31 bits`);
    }
    if (leadingZeroes === 0) return 0;
    return 2 ** leadingZeroes - 1 + this.read(leadingZeroes, field);
  }
}

/** Parse the profile/depth/geometry prefix of one VP9 key-frame uncompressed header. */
export function parseVp9UncompressedHeader(bytes: Uint8Array): Vp9HeaderFacts {
  const bits = new BitReader(bytes, 'VP9 uncompressed header');
  if (bits.read(2, 'frame_marker') !== 2) throw demuxError('VP9 frame_marker must equal 2');
  const profile = asVp9Profile(
    bits.read(1, 'profile_low_bit') + bits.read(1, 'profile_high_bit') * 2,
  );
  if (profile === 3 && bits.read(1, 'reserved_zero') !== 0) {
    throw demuxError('VP9 profile-3 reserved_zero bit is set');
  }
  if (bits.read(1, 'show_existing_frame') !== 0) {
    throw new CapabilityError(
      'VP9 show-existing access unit carries no sequence profile/depth header',
      { op: { kind: 'route', id: 'demux' }, tried: ['webm-vp9-uncompressed-header'] },
    );
  }
  if (bits.read(1, 'frame_type') !== 0) {
    throw new CapabilityError('VP9 inter frame cannot qualify a decoder configuration', {
      op: { kind: 'route', id: 'demux' },
      tried: ['webm-vp9-keyframe-header'],
    });
  }
  bits.read(1, 'show_frame');
  bits.read(1, 'error_resilient_mode');
  if (
    bits.read(8, 'sync_code') !== 0x49 ||
    bits.read(8, 'sync_code') !== 0x83 ||
    bits.read(8, 'sync_code') !== 0x42
  ) {
    throw demuxError('VP9 key-frame sync code is invalid');
  }
  const bitDepth: VideoBitDepth =
    profile >= 2 ? (bits.read(1, 'ten_or_twelve_bit') === 1 ? 12 : 10) : 8;
  const colorSpace = bits.read(3, 'color_space');
  let chromaSubsampling: 0 | 1 | 2 | 3;
  if (colorSpace === 7) {
    if (profile === 0 || profile === 2) {
      throw demuxError(`VP9 profile ${profile} cannot carry the sRGB colorspace`);
    }
    chromaSubsampling = 3;
    if (bits.read(1, 'reserved_zero') !== 0) throw demuxError('VP9 RGB reserved_zero bit is set');
  } else {
    bits.read(1, 'color_range');
    if (profile === 1 || profile === 3) {
      const subsamplingX = bits.read(1, 'subsampling_x');
      const subsamplingY = bits.read(1, 'subsampling_y');
      if (bits.read(1, 'reserved_zero') !== 0) {
        throw demuxError('VP9 chroma reserved_zero bit is set');
      }
      chromaSubsampling = subsamplingX === 1 ? (subsamplingY === 1 ? 1 : 2) : (3 as const);
    } else {
      chromaSubsampling = 1;
    }
  }
  const width = bits.read(16, 'frame_width_minus_1') + 1;
  const height = bits.read(16, 'frame_height_minus_1') + 1;
  validateVp9Layout(profile, bitDepth, chromaSubsampling);
  return { profile, bitDepth, chromaSubsampling, width, height };
}

function validateAv1RecordFacts(
  profile: 0 | 1 | 2,
  level: number,
  tier: 'M' | 'H',
  bitDepth: VideoBitDepth,
  monochrome: boolean,
  subsamplingX: boolean,
  subsamplingY: boolean,
  stage: 'demux-error' | 'mux-error' = 'demux-error',
): void {
  if (level > 23) throw qualificationError(stage, `AV1 sequence level index ${level} is reserved`);
  if (level <= 7 && tier === 'H')
    throw qualificationError(stage, `AV1 level ${level} cannot use High tier`);
  if (bitDepth === 12 && profile !== 2) {
    throw qualificationError(stage, `AV1 ${bitDepth}-bit depth requires Professional profile 2`);
  }
  if (profile === 0 && (!subsamplingX || !subsamplingY)) {
    throw qualificationError(stage, 'AV1 Main profile 0 must use 4:2:0 chroma subsampling');
  }
  if (profile === 1 && (monochrome || subsamplingX || subsamplingY)) {
    throw qualificationError(stage, 'AV1 High profile 1 must be non-monochrome 4:4:4');
  }
}

function av1Codec(
  profile: 0 | 1 | 2,
  level: number,
  tier: 'M' | 'H',
  bitDepth: VideoBitDepth,
): string {
  return `av01.${profile}.${codecField(level)}${tier}.${codecField(bitDepth)}`;
}

/** Parse the Matroska AV1CodecConfigurationRecord (`CodecPrivate`, same record as ISOBMFF `av1C`). */
export function parseAv1CodecPrivate(bytes: Uint8Array): Av1CodecFacts {
  if (bytes.byteLength < 4) throw demuxError('AV1 CodecPrivate is shorter than four bytes');
  const markerVersion = bytes[0];
  const profileLevel = bytes[1];
  const depthLayout = bytes[2];
  const delay = bytes[3];
  if (markerVersion !== 0x81) throw demuxError('AV1 CodecPrivate marker/version must equal 0x81');
  if (profileLevel === undefined || depthLayout === undefined || delay === undefined) {
    throw demuxError('AV1 CodecPrivate is truncated');
  }
  if ((delay & 0xe0) !== 0 || ((delay & 0x10) === 0 && (delay & 0x0f) !== 0)) {
    throw demuxError('AV1 CodecPrivate reserved presentation-delay bits are non-zero');
  }
  const profile = asAv1Profile(profileLevel >> 5);
  const level = profileLevel & 0x1f;
  const tier: 'M' | 'H' = (depthLayout & 0x80) === 0 ? 'M' : 'H';
  const highBitdepth = (depthLayout & 0x40) !== 0;
  const twelveBit = (depthLayout & 0x20) !== 0;
  if (twelveBit && (!highBitdepth || profile !== 2)) {
    throw demuxError('AV1 CodecPrivate twelve_bit contradicts profile/high_bitdepth');
  }
  const bitDepth: VideoBitDepth = twelveBit ? 12 : highBitdepth ? 10 : 8;
  const monochrome = (depthLayout & 0x10) !== 0;
  const subsamplingX = (depthLayout & 0x08) !== 0;
  const subsamplingY = (depthLayout & 0x04) !== 0;
  validateAv1RecordFacts(profile, level, tier, bitDepth, monochrome, subsamplingX, subsamplingY);
  return {
    codec: av1Codec(profile, level, tier, bitDepth),
    profile,
    level,
    tier,
    bitDepth,
    monochrome,
    subsamplingX,
    subsamplingY,
  };
}

/** Build the mandatory four-byte AV1CodecConfigurationRecord prefix from a qualified codec string. */
export function av1CodecPrivateFromCodecString(codec: string): Uint8Array {
  const lower = codec.trim();
  if (!lower.toLowerCase().startsWith('av01.')) {
    throw new MediaError(
      'mux-error',
      `WebM AV1 needs a qualified av01 codec string, got '${codec}'`,
    );
  }
  const fields = lower.slice(5).split('.');
  const profile = asAv1Profile(decimalField(fields[0], 'profile'), 'mux-error');
  const levelTier = fields[1];
  if (levelTier === undefined || !/^\d{2}[mMhH]$/.test(levelTier)) {
    throw new MediaError('mux-error', `AV1 level/tier field '${levelTier}' is malformed`);
  }
  const level = Number.parseInt(levelTier.slice(0, 2), 10);
  const tier: 'M' | 'H' = /h$/i.test(levelTier) ? 'H' : 'M';
  const bitDepth = asBitDepth(decimalField(fields[2], 'bitDepth'), 'AV1', 'mux-error');
  const monochrome = fields[3] === '1';
  if (fields[3] !== undefined && fields[3] !== '0' && fields[3] !== '1') {
    throw new MediaError('mux-error', `AV1 monochrome field '${fields[3]}' is invalid`);
  }
  const chroma = fields[4];
  let subsamplingX = profile === 0;
  let subsamplingY = profile === 0;
  let chromaSamplePosition = 0;
  if (chroma !== undefined) {
    if (!/^[01][01][0-3]$/.test(chroma)) {
      throw new MediaError('mux-error', `AV1 chroma field '${chroma}' is malformed`);
    }
    subsamplingX = chroma[0] === '1';
    subsamplingY = chroma[1] === '1';
    chromaSamplePosition = Number.parseInt(chroma[2] ?? '0', 10);
  }
  validateAv1RecordFacts(
    profile,
    level,
    tier,
    bitDepth,
    monochrome,
    subsamplingX,
    subsamplingY,
    'mux-error',
  );
  return Uint8Array.of(
    0x81,
    (profile << 5) | level,
    (tier === 'H' ? 0x80 : 0) |
      (bitDepth > 8 ? 0x40 : 0) |
      (bitDepth === 12 ? 0x20 : 0) |
      (monochrome ? 0x10 : 0) |
      (subsamplingX ? 0x08 : 0) |
      (subsamplingY ? 0x04 : 0) |
      chromaSamplePosition,
    0,
  );
}

interface Leb128Result {
  readonly value: number;
  readonly length: number;
}

function readLeb128(bytes: Uint8Array, offset: number): Leb128Result {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 8; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) throw demuxError('AV1 OBU LEB128 size is truncated');
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) throw demuxError('AV1 OBU LEB128 size exceeds safe integer');
    if ((byte & 0x80) === 0) return { value, length: index + 1 };
    multiplier *= 128;
  }
  throw demuxError('AV1 OBU LEB128 size exceeds eight bytes');
}

function sequenceHeaderPayload(obus: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < obus.byteLength) {
    const header = obus[offset];
    if (header === undefined) break;
    if ((header & 0x80) !== 0 || (header & 1) !== 0) {
      throw demuxError('AV1 OBU header has a forbidden or reserved bit set');
    }
    const type = (header >> 3) & 0x0f;
    const extension = (header & 0x04) !== 0;
    const hasSize = (header & 0x02) !== 0;
    let payloadStart = offset + 1;
    if (extension) {
      const extensionByte = obus[payloadStart];
      if (extensionByte === undefined) throw demuxError('AV1 OBU extension is truncated');
      if ((extensionByte & 0x07) !== 0) throw demuxError('AV1 OBU extension reserved bits are set');
      payloadStart++;
    }
    let payloadEnd = obus.byteLength;
    if (hasSize) {
      const size = readLeb128(obus, payloadStart);
      payloadStart += size.length;
      payloadEnd = payloadStart + size.value;
      if (payloadEnd > obus.byteLength) throw demuxError('AV1 OBU payload is truncated');
    }
    if (type === 1) return obus.subarray(payloadStart, payloadEnd);
    if (!hasSize) break;
    offset = payloadEnd;
  }
  throw new CapabilityError('AV1 access unit contains no sequence-header OBU', {
    op: { kind: 'route', id: 'demux' },
    tried: ['webm-av1-sequence-header'],
  });
}

/** Parse AV1 sequence-header syntax through `color_config()` from low-overhead OBUs. */
export function parseAv1SequenceHeader(obus: Uint8Array): Av1CodecFacts {
  const bits = new BitReader(sequenceHeaderPayload(obus), 'AV1 sequence header');
  const profile = asAv1Profile(bits.read(3, 'seq_profile'));
  const stillPicture = bits.read(1, 'still_picture') === 1;
  const reduced = bits.read(1, 'reduced_still_picture_header') === 1;
  if (reduced && !stillPicture) {
    throw demuxError('AV1 reduced_still_picture_header requires still_picture');
  }

  let level = 0;
  let tier: 'M' | 'H' = 'M';
  let decoderModelInfoPresent = false;
  let bufferDelayLength = 0;
  let initialDisplayDelayPresent = false;
  if (reduced) {
    level = bits.read(5, 'seq_level_idx_0');
  } else {
    const timingInfoPresent = bits.read(1, 'timing_info_present_flag') === 1;
    if (timingInfoPresent) {
      bits.read(32, 'num_units_in_display_tick');
      bits.read(32, 'time_scale');
      if (bits.read(1, 'equal_picture_interval') === 1) {
        bits.readUvlc('num_ticks_per_picture_minus_1');
      }
      decoderModelInfoPresent = bits.read(1, 'decoder_model_info_present_flag') === 1;
      if (decoderModelInfoPresent) {
        bufferDelayLength = bits.read(5, 'buffer_delay_length_minus_1') + 1;
        bits.read(32, 'num_units_in_decoding_tick');
        bits.read(5, 'buffer_removal_time_length_minus_1');
        bits.read(5, 'frame_presentation_time_length_minus_1');
      }
    }
    initialDisplayDelayPresent = bits.read(1, 'initial_display_delay_present_flag') === 1;
    const operatingPoints = bits.read(5, 'operating_points_cnt_minus_1') + 1;
    for (let index = 0; index < operatingPoints; index++) {
      bits.read(12, `operating_point_idc[${index}]`);
      const candidateLevel = bits.read(5, `seq_level_idx[${index}]`);
      const candidateTier: 'M' | 'H' =
        candidateLevel > 7 && bits.read(1, `seq_tier[${index}]`) === 1 ? 'H' : 'M';
      if (index === 0) {
        level = candidateLevel;
        tier = candidateTier;
      }
      if (decoderModelInfoPresent) {
        const present = bits.read(1, `decoder_model_present_for_this_op[${index}]`) === 1;
        if (present) {
          bits.read(bufferDelayLength, `decoder_buffer_delay[${index}]`);
          bits.read(bufferDelayLength, `encoder_buffer_delay[${index}]`);
          bits.read(1, `low_delay_mode_flag[${index}]`);
        }
      }
      if (initialDisplayDelayPresent) {
        const present = bits.read(1, `initial_display_delay_present_for_this_op[${index}]`) === 1;
        if (present) bits.read(4, `initial_display_delay_minus_1[${index}]`);
      }
    }
  }

  const widthBits = bits.read(4, 'frame_width_bits_minus_1') + 1;
  const heightBits = bits.read(4, 'frame_height_bits_minus_1') + 1;
  const width = bits.read(widthBits, 'max_frame_width_minus_1') + 1;
  const height = bits.read(heightBits, 'max_frame_height_minus_1') + 1;
  if (!reduced && bits.read(1, 'frame_id_numbers_present_flag') === 1) {
    bits.read(4, 'delta_frame_id_length_minus_2');
    bits.read(3, 'additional_frame_id_length_minus_1');
  }
  bits.read(1, 'use_128x128_superblock');
  bits.read(1, 'enable_filter_intra');
  bits.read(1, 'enable_intra_edge_filter');
  if (!reduced) {
    bits.read(1, 'enable_interintra_compound');
    bits.read(1, 'enable_masked_compound');
    bits.read(1, 'enable_warped_motion');
    bits.read(1, 'enable_dual_filter');
    const enableOrderHint = bits.read(1, 'enable_order_hint') === 1;
    if (enableOrderHint) {
      bits.read(1, 'enable_jnt_comp');
      bits.read(1, 'enable_ref_frame_mvs');
    }
    const chooseScreenContentTools = bits.read(1, 'seq_choose_screen_content_tools') === 1;
    const forceScreenContentTools = chooseScreenContentTools
      ? 2
      : bits.read(1, 'seq_force_screen_content_tools');
    if (forceScreenContentTools > 0) {
      const chooseIntegerMv = bits.read(1, 'seq_choose_integer_mv') === 1;
      if (!chooseIntegerMv) bits.read(1, 'seq_force_integer_mv');
    }
    if (enableOrderHint) bits.read(3, 'order_hint_bits_minus_1');
  }
  bits.read(1, 'enable_superres');
  bits.read(1, 'enable_cdef');
  bits.read(1, 'enable_restoration');

  const highBitdepth = bits.read(1, 'high_bitdepth') === 1;
  const twelveBit = profile === 2 && highBitdepth && bits.read(1, 'twelve_bit') === 1;
  const bitDepth: VideoBitDepth = twelveBit ? 12 : highBitdepth ? 10 : 8;
  const monochrome = profile === 1 ? false : bits.read(1, 'mono_chrome') === 1;
  let colorPrimaries = 2;
  let transferCharacteristics = 2;
  let matrixCoefficients = 2;
  if (bits.read(1, 'color_description_present_flag') === 1) {
    colorPrimaries = bits.read(8, 'color_primaries');
    transferCharacteristics = bits.read(8, 'transfer_characteristics');
    matrixCoefficients = bits.read(8, 'matrix_coefficients');
  }
  let subsamplingX = true;
  let subsamplingY = true;
  if (monochrome) {
    bits.read(1, 'color_range');
  } else if (colorPrimaries === 1 && transferCharacteristics === 13 && matrixCoefficients === 0) {
    subsamplingX = false;
    subsamplingY = false;
    bits.read(1, 'separate_uv_delta_q');
  } else {
    bits.read(1, 'color_range');
    if (profile === 0) {
      subsamplingX = true;
      subsamplingY = true;
    } else if (profile === 1) {
      subsamplingX = false;
      subsamplingY = false;
    } else if (bitDepth === 12) {
      subsamplingX = bits.read(1, 'subsampling_x') === 1;
      subsamplingY = subsamplingX && bits.read(1, 'subsampling_y') === 1;
    } else {
      subsamplingX = true;
      subsamplingY = false;
    }
    if (subsamplingX && subsamplingY) bits.read(2, 'chroma_sample_position');
    bits.read(1, 'separate_uv_delta_q');
  }
  bits.read(1, 'film_grain_params_present');
  validateAv1RecordFacts(profile, level, tier, bitDepth, monochrome, subsamplingX, subsamplingY);
  return {
    codec: av1Codec(profile, level, tier, bitDepth),
    profile,
    level,
    tier,
    bitDepth,
    monochrome,
    subsamplingX,
    subsamplingY,
    width,
    height,
  };
}

function vp9LevelForFacts(request: WebmVideoCodecRequest, width: number, height: number): number {
  const top = VP9_LEVELS.at(-1);
  if (top === undefined) throw demuxError('VP9 level table is empty');
  const pictureSamples = width * height;
  const validGeometry =
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    pictureSamples <= top[1] &&
    width <= top[2] &&
    height <= top[2];
  if (!validGeometry) {
    throw new CapabilityError(
      `VP9 input geometry ${width}x${height} exceeds the defined level envelope`,
      { op: { kind: 'route', id: 'demux' }, tried: ['webm-vp9-levels'] },
    );
  }
  const fps = request.fps;
  const bitrate =
    request.sourceSizeBytes !== undefined &&
    Number.isFinite(request.sourceSizeBytes) &&
    request.sourceSizeBytes > 0 &&
    request.durationSec !== undefined &&
    Number.isFinite(request.durationSec) &&
    request.durationSec > 0
      ? (request.sourceSizeBytes * 8) / request.durationSec
      : undefined;
  if (fps === undefined || !Number.isFinite(fps) || fps <= 0 || bitrate === undefined)
    return top[0];
  const displayRate = pictureSamples * fps;
  for (const [level, maxPicture, maxDimension, maxRate, maxBitrate] of VP9_LEVELS) {
    if (
      pictureSamples <= maxPicture &&
      width <= maxDimension &&
      height <= maxDimension &&
      displayRate <= maxRate &&
      bitrate <= maxBitrate
    ) {
      return level;
    }
  }
  throw new CapabilityError(
    `VP9 input ${width}x${height}@${fps} exceeds the defined level envelope`,
    { op: { kind: 'route', id: 'demux' }, tried: ['webm-vp9-levels'] },
  );
}

function assertMatchingDimensions(
  codec: 'VP9' | 'AV1',
  containerWidth: number | undefined,
  containerHeight: number | undefined,
  codedWidth: number | undefined,
  codedHeight: number | undefined,
): void {
  if (
    containerWidth !== undefined &&
    containerHeight !== undefined &&
    codedWidth !== undefined &&
    codedHeight !== undefined &&
    (containerWidth !== codedWidth || containerHeight !== codedHeight)
  ) {
    throw demuxError(
      `${codec} coded dimensions ${codedWidth}x${codedHeight} contradict WebM ${containerWidth}x${containerHeight}`,
    );
  }
}

/** Resolve one WebM video family to an exact string, or an explicit non-defaulting miss token. */
export function qualifyWebmVideoCodec(request: WebmVideoCodecRequest): WebmVideoCodecQualification {
  if (request.codec === 'vp9') {
    if (request.codecPrivate !== undefined) {
      return { codec: parseVp9CodecPrivate(request.codecPrivate).codec, source: 'codec-private' };
    }
    if (request.firstKeyframe === undefined) return { codec: 'vp09', source: 'unknown' };
    const header = parseVp9UncompressedHeader(request.firstKeyframe);
    assertMatchingDimensions('VP9', request.width, request.height, header.width, header.height);
    const level = vp9LevelForFacts(request, header.width, header.height);
    return {
      codec: `vp09.${codecField(header.profile)}.${codecField(level)}.${codecField(header.bitDepth)}`,
      source: 'bitstream',
    };
  }

  if (request.codecPrivate !== undefined) {
    const facts = parseAv1CodecPrivate(request.codecPrivate);
    return {
      codec: facts.codec,
      source: 'codec-private',
      description: request.codecPrivate.slice(),
    };
  }
  if (request.firstKeyframe === undefined) return { codec: 'av01', source: 'unknown' };
  const facts = parseAv1SequenceHeader(request.firstKeyframe);
  assertMatchingDimensions('AV1', request.width, request.height, facts.width, facts.height);
  return { codec: facts.codec, source: 'bitstream' };
}

function isIsoVpcc(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 8 && bytes[0] === 1 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0
  );
}

function mandatoryCodecFields(codec: string): string {
  const fields = codec.split('.');
  return fields.slice(0, 4).join('.').toLowerCase();
}

/**
 * Convert a video decoder config into the exact private-data dialect WebM writes. VP9 ISO `vpcC`
 * descriptions are translated to WebM feature TLVs; AV1 preserves/synthesizes its shared `av1C` record.
 */
export function webmVideoCodecPrivate(
  codecId: 'V_VP9' | 'V_AV1',
  codec: string,
  sourcePrivate: Uint8Array | undefined,
): Uint8Array | undefined {
  if (codecId === 'V_VP9') {
    if (!codec.toLowerCase().startsWith('vp09.')) {
      if (sourcePrivate === undefined) return undefined;
      try {
        return parseVp9CodecPrivate(sourcePrivate).codec.length > 0
          ? sourcePrivate.slice()
          : undefined;
      } catch (error) {
        throw new MediaError('mux-error', 'invalid VP9 WebM CodecPrivate', error);
      }
    }
    const expected = vp9CodecPrivateFromCodecString(codec);
    if (sourcePrivate === undefined) return expected;
    if (isIsoVpcc(sourcePrivate)) {
      const profile = sourcePrivate[4];
      const level = sourcePrivate[5];
      const packed = sourcePrivate[6];
      if (profile === undefined || level === undefined || packed === undefined) {
        throw new MediaError('mux-error', 'VP9 vpcC description is truncated');
      }
      const described = `vp09.${codecField(profile)}.${codecField(level)}.${codecField(packed >> 4)}`;
      if (mandatoryCodecFields(described) !== mandatoryCodecFields(codec)) {
        throw new MediaError('mux-error', `VP9 vpcC '${described}' contradicts '${codec}'`);
      }
      return expected;
    }
    try {
      const declared = parseVp9CodecPrivate(sourcePrivate);
      if (mandatoryCodecFields(declared.codec) !== mandatoryCodecFields(codec)) {
        throw new MediaError(
          'mux-error',
          `VP9 CodecPrivate '${declared.codec}' contradicts '${codec}'`,
        );
      }
      return sourcePrivate.slice();
    } catch (error) {
      if (error instanceof MediaError && error.code === 'mux-error') throw error;
      throw new MediaError('mux-error', 'invalid VP9 WebM CodecPrivate', error);
    }
  }

  if (sourcePrivate !== undefined) {
    try {
      const declared = parseAv1CodecPrivate(sourcePrivate);
      if (
        codec.toLowerCase().startsWith('av01.') &&
        mandatoryCodecFields(declared.codec) !== mandatoryCodecFields(codec)
      ) {
        throw new MediaError(
          'mux-error',
          `AV1 CodecPrivate '${declared.codec}' contradicts '${codec}'`,
        );
      }
      return sourcePrivate.slice();
    } catch (error) {
      if (error instanceof MediaError && error.code === 'mux-error') throw error;
      throw new MediaError('mux-error', 'invalid AV1 CodecPrivate', error);
    }
  }
  if (!codec.toLowerCase().startsWith('av01.')) {
    throw new CapabilityError(`WebM AV1 mux needs an exact av01 codec string, got '${codec}'`, {
      op: { kind: 'route', id: 'mux' },
      tried: ['webm-av1-codec-private'],
    });
  }
  return av1CodecPrivateFromCodecString(codec);
}
