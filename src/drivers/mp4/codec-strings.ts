/**
 * Map MP4 sample-entry codec config (`avcC`, `esds`) to WebCodecs codec strings + the `description`
 * bytes a decoder needs. The codec string must carry profile/level (e.g. `avc1.42E01E`,
 * `mp4a.40.2`) so `isConfigSupported` answers precisely (docs/architecture/10 §6). Also maps the
 * container colour tags (`colr` nclc/nclx H.273 code points → `VideoColorSpaceInit`) and the QuickTime
 * PCM sound-description fourccs → engine PCM tokens (ADR-185, docs/notes/qtff-mov-parsing.md).
 */

import { Reader, readFullBoxHeader } from './reader.ts';

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** `avc1.PPCCLL` from the first bytes of an AVCDecoderConfigurationRecord (`avcC`). */
export function avcCodecString(avcC: Uint8Array): string {
  const profile = avcC[1] ?? 0;
  const compat = avcC[2] ?? 0;
  const level = avcC[3] ?? 0;
  return `avc1.${(hex2(profile) + hex2(compat) + hex2(level)).toUpperCase()}`;
}

/** Reverse the 32 bits of `x` — HEVC encodes the compatibility flags in reverse bit order (RFC 6381). */
function reverseBits32(x: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) r = (r << 1) | ((x >>> i) & 1);
  return r >>> 0;
}

/**
 * `hvc1.PPP.CC.TLL.BB…` from an HEVCDecoderConfigurationRecord (`hvcC`), per RFC 6381: profile-space
 * (A/B/C or none) + profile-idc, the 32-bit compatibility flags as bit-reversed hex, tier (L/H) +
 * level-idc, then the general_constraint_indicator bytes as hex with trailing zero bytes omitted.
 */
export function hevcCodecString(prefix: string, hvcC: Uint8Array): string {
  const dv = new DataView(hvcC.buffer, hvcC.byteOffset, hvcC.byteLength);
  const b1 = dv.getUint8(1);
  const profileSpace = (b1 >> 6) & 0x3;
  const profileIdc = b1 & 0x1f;
  const tierFlag = (b1 >> 5) & 0x1;
  const compat = reverseBits32(dv.getUint32(2));
  const levelIdc = dv.getUint8(12);
  const space = profileSpace === 0 ? '' : String.fromCharCode(0x40 + profileSpace); // 1→A 2→B 3→C
  let out = `${prefix}.${space}${profileIdc}.${compat.toString(16).toUpperCase()}.${tierFlag ? 'H' : 'L'}${levelIdc}`;
  let last = 5;
  while (last >= 0 && dv.getUint8(6 + last) === 0) last--;
  for (let i = 0; i <= last; i++) out += `.${hex2(dv.getUint8(6 + i)).toUpperCase()}`;
  return out;
}

/** `av01.P.LLT.DD` from an AV1CodecConfigurationRecord (`av1C`), per the AV1-ISOBMFF binding. */
export function av1CodecString(av1C: Uint8Array): string {
  const dv = new DataView(av1C.buffer, av1C.byteOffset, av1C.byteLength);
  const b1 = dv.getUint8(1);
  const b2 = dv.getUint8(2);
  const seqProfile = (b1 >> 5) & 0x7;
  const seqLevelIdx = b1 & 0x1f;
  const seqTier = (b2 >> 7) & 0x1;
  const highBitdepth = (b2 >> 6) & 0x1;
  const twelveBit = (b2 >> 5) & 0x1;
  const bitDepth =
    seqProfile === 2 && highBitdepth === 1 ? (twelveBit ? 12 : 10) : highBitdepth ? 10 : 8;
  const level = seqLevelIdx.toString().padStart(2, '0');
  return `av01.${seqProfile}.${level}${seqTier ? 'H' : 'M'}.${bitDepth.toString().padStart(2, '0')}`;
}

export interface EsdsInfo {
  codec: string;
  objectTypeIndication: number;
  audioObjectType?: number;
  /** Effective decoded/output sample rate from AudioSpecificConfig (includes SBR upsampling). */
  sampleRate?: number;
  /** Channel count represented by AudioSpecificConfig's channelConfiguration, when not PCE-defined. */
  channels?: number;
  /** SBR is present; presentation channel geometry remains the outer sample entry's responsibility. */
  sbrPresent?: true;
  /** AudioSpecificConfig — the `description` for an AAC `AudioDecoderConfig`. */
  asc?: Uint8Array;
}

const TAG_ES = 0x03;
const TAG_DECODER_CONFIG = 0x04;
const TAG_DECODER_SPECIFIC = 0x05;

const AAC_SAMPLE_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
  7_350,
] as const;
const AAC_CHANNELS_BY_CONFIGURATION: Readonly<Record<number, number>> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 8,
  11: 7,
  12: 8,
  13: 24,
  14: 8,
};

class AacBitReader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.byteLength * 8 - this.#offset;
  }

  read(width: number): number | undefined {
    if (!Number.isInteger(width) || width < 0 || width > 32 || this.remaining < width)
      return undefined;
    let value = 0;
    for (let index = 0; index < width; index++) {
      const bit = this.#offset + index;
      value = value * 2 + (((this.bytes[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
    }
    this.#offset += width;
    return value;
  }
}

function readAacAudioObjectType(bits: AacBitReader): number | undefined {
  const base = bits.read(5);
  if (base === undefined) return undefined;
  if (base !== 31) return base;
  const extension = bits.read(6);
  return extension === undefined ? undefined : 32 + extension;
}

function readAacSampleRate(bits: AacBitReader): number | undefined {
  const index = bits.read(4);
  if (index === undefined) return undefined;
  if (index === 15) return bits.read(24);
  return AAC_SAMPLE_RATES[index];
}

function skipGaSpecificConfig(
  bits: AacBitReader,
  audioObjectType: number,
  channelConfiguration: number,
): void {
  if (bits.read(1) === undefined) return; // frameLengthFlag
  const dependsOnCoreCoder = bits.read(1);
  if (dependsOnCoreCoder === undefined) return;
  if (dependsOnCoreCoder === 1 && bits.read(14) === undefined) return;
  const extensionFlag = bits.read(1);
  if (extensionFlag !== 1) return;
  if (audioObjectType === 22) {
    if (bits.read(16) === undefined) return;
  }
  if (
    (audioObjectType === 17 ||
      audioObjectType === 19 ||
      audioObjectType === 20 ||
      audioObjectType === 23) &&
    bits.read(3) === undefined
  ) {
    return;
  }
  // extensionFlag3 is present for ER object types; reading it is safe only when the syntax reaches it.
  if (
    audioObjectType === 17 ||
    audioObjectType === 19 ||
    audioObjectType === 20 ||
    audioObjectType === 23
  ) {
    bits.read(1);
  }
  // channelConfiguration=0 carries a ProgramConfigElement between the fixed GA fields and sync
  // extension. We intentionally do not guess its variable length; the outer sample entry remains the
  // fallback for that uncommon form.
  void channelConfiguration;
}

interface AacAscGeometry {
  readonly audioObjectType?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly sbrPresent?: true;
}

/** Parse the AudioSpecificConfig fields that override an MP4 AudioSampleEntry's stale geometry. */
function parseAacAscGeometry(asc: Uint8Array): AacAscGeometry {
  const bits = new AacBitReader(asc);
  const signaledAudioObjectType = readAacAudioObjectType(bits);
  const baseSampleRate = readAacSampleRate(bits);
  const channelConfiguration = bits.read(4);
  if (
    signaledAudioObjectType === undefined ||
    baseSampleRate === undefined ||
    channelConfiguration === undefined
  ) {
    return {};
  }

  let coreAudioObjectType = signaledAudioObjectType;
  let sampleRate = baseSampleRate;
  let channels = AAC_CHANNELS_BY_CONFIGURATION[channelConfiguration];
  let sbrPresent = signaledAudioObjectType === 5 || signaledAudioObjectType === 29;
  if (signaledAudioObjectType === 5 || signaledAudioObjectType === 29) {
    const extensionRate = readAacSampleRate(bits);
    const extensionCoreType = readAacAudioObjectType(bits);
    if (extensionRate !== undefined) sampleRate = extensionRate;
    if (extensionCoreType !== undefined) coreAudioObjectType = extensionCoreType;
    if (extensionCoreType === 22) {
      const extensionChannels = bits.read(4);
      if (extensionChannels !== undefined) {
        channels = AAC_CHANNELS_BY_CONFIGURATION[extensionChannels];
      }
    }
  } else if (channelConfiguration !== 0) {
    skipGaSpecificConfig(bits, coreAudioObjectType, channelConfiguration);
    if (bits.remaining >= 16 && bits.read(11) === 0x2b7 && readAacAudioObjectType(bits) === 5) {
      const sbrFlag = bits.read(1);
      if (sbrFlag === 1) {
        // The sync extension describes a doubled-rate SBR presentation around the AAC-LC core.
        // Channel configuration still describes the core; the MP4 sample entry carries presentation
        // geometry (notably implicit Parametric Stereo material that retains a mono core config).
        sbrPresent = true;
        const extensionRate = readAacSampleRate(bits);
        if (extensionRate !== undefined) sampleRate = extensionRate;
      }
    }
  }

  return {
    audioObjectType: signaledAudioObjectType,
    sampleRate,
    ...(channels !== undefined ? { channels } : {}),
    ...(sbrPresent ? { sbrPresent: true } : {}),
  };
}

/** Variable-length descriptor size (each byte: 7 bits + continuation flag). */
function readDescriptorLen(r: Reader): number {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const b = r.u8();
    len = (len << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return len;
}

/** Parse an `esds` box payload into the AAC codec string + AudioSpecificConfig. */
export function parseEsds(esds: Uint8Array): EsdsInfo {
  const r = new Reader(esds);
  readFullBoxHeader(r); // version + flags

  if (r.u8() !== TAG_ES) return { codec: 'mp4a', objectTypeIndication: 0 };
  readDescriptorLen(r);
  r.u16(); // ES_ID
  const esFlags = r.u8();
  if (esFlags & 0x80) r.u16(); // streamDependence
  if (esFlags & 0x40) r.skip(r.u8()); // URL
  if (esFlags & 0x20) r.u16(); // OCR stream

  if (r.u8() !== TAG_DECODER_CONFIG) return { codec: 'mp4a', objectTypeIndication: 0 };
  readDescriptorLen(r);
  const oti = r.u8(); // 0x40 = MPEG-4 Audio
  r.skip(1 + 3 + 4 + 4); // streamType/upstream/reserved + bufferSizeDB + max/avg bitrate

  let asc: Uint8Array | undefined;
  let audioObjectType: number | undefined;
  let ascGeometry: AacAscGeometry = {};
  if (r.remaining > 1 && r.u8() === TAG_DECODER_SPECIFIC) {
    const len = readDescriptorLen(r);
    asc = r.bytes(len).slice();
    ascGeometry = parseAacAscGeometry(asc);
    audioObjectType = ascGeometry.audioObjectType;
  }

  const codec =
    oti === 0x40 && audioObjectType !== undefined
      ? `mp4a.40.${audioObjectType}`
      : `mp4a.${hex2(oti)}`;
  return {
    codec,
    objectTypeIndication: oti,
    ...(audioObjectType !== undefined ? { audioObjectType } : {}),
    ...(ascGeometry.sampleRate !== undefined ? { sampleRate: ascGeometry.sampleRate } : {}),
    ...(ascGeometry.channels !== undefined ? { channels: ascGeometry.channels } : {}),
    ...(ascGeometry.sbrPresent ? { sbrPresent: true } : {}),
    ...(asc ? { asc } : {}),
  };
}

/**
 * The nclc/nclx fields of a `colr` box (ISO/IEC 14496-12 §12.1.5 / QTFF "Color Parameter Atoms"):
 * raw H.273 code points plus the nclx `full_range_flag`. QuickTime `nclc` carries no range field, so
 * `fullRange` stays undefined there — the parser must not invent one.
 */
export interface ColrInfo {
  colourType: 'nclc' | 'nclx';
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange?: boolean;
}

// The bundled lib.dom colour enums predate several H.273 code points that WebCodecs accepts at runtime
// (BT.2020, SMPTE-432, PQ/HLG, BT.2020-NCL). Assert those spec-valid tokens to their WebCodecs type at
// the one boundary that produces them — never `any`; tokens already in lib.dom stay literal-checked so a
// typo is still caught. (Same idiom used for the colour-space enums elsewhere in the engine.)
const asColorPrimaries = (token: string): VideoColorPrimaries => token as VideoColorPrimaries;
const asTransferCharacteristics = (token: string): VideoTransferCharacteristics =>
  token as VideoTransferCharacteristics;
const asMatrixCoefficients = (token: string): VideoMatrixCoefficients =>
  token as VideoMatrixCoefficients;

/**
 * H.273 (ISO/IEC 23091-2) `ColourPrimaries` → WebCodecs {@link VideoColorPrimaries}. Code 7
 * (SMPTE-240M) shares BT.601-NTSC/SMPTE-C chromaticities with code 6, so it maps to `smpte170m`;
 * unspecified (2) and code points WebCodecs cannot name yield undefined — an honest omission the
 * decoder resolves with its own default, never a guess.
 */
export function h273Primaries(code: number): VideoColorPrimaries | undefined {
  switch (code) {
    case 1:
      return 'bt709';
    case 5:
      return 'bt470bg';
    case 6:
    case 7:
      return 'smpte170m';
    case 9:
      return asColorPrimaries('bt2020');
    case 12:
      return asColorPrimaries('smpte432');
    default:
      return undefined;
  }
}

/**
 * H.273 `TransferCharacteristics` → WebCodecs {@link VideoTransferCharacteristics}. Codes 1/14/15
 * (BT.709 / BT.2020-10 / BT.2020-12) are the identical function per H.273, so all map to `bt709`.
 * SMPTE-240M (7) uses different constants and has no WebCodecs name → undefined.
 */
export function h273Transfer(code: number): VideoTransferCharacteristics | undefined {
  switch (code) {
    case 1:
    case 14:
    case 15:
      return 'bt709';
    case 6:
      return 'smpte170m';
    case 8:
      return asTransferCharacteristics('linear');
    case 13:
      return 'iec61966-2-1';
    case 16:
      return asTransferCharacteristics('pq');
    case 18:
      return asTransferCharacteristics('hlg');
    default:
      return undefined;
  }
}

/**
 * H.273 `MatrixCoefficients` → WebCodecs {@link VideoMatrixCoefficients}. SMPTE-240M (7) and
 * BT.2020-CL (10) have no WebCodecs name → undefined (the browser default is a lesser evil than a
 * wrong matrix, and the raw code point stays available on {@link ColrInfo}).
 */
export function h273Matrix(code: number): VideoMatrixCoefficients | undefined {
  switch (code) {
    case 0:
      return 'rgb';
    case 1:
      return 'bt709';
    case 5:
      return 'bt470bg';
    case 6:
      return 'smpte170m';
    case 9:
      return asMatrixCoefficients('bt2020-ncl');
    default:
      return undefined;
  }
}

/**
 * Build the `VideoDecoderConfig.colorSpace` init from a parsed `colr`. Per-field: an unmappable code
 * point is omitted (the decoder's own default applies field-wise). Returns undefined when *nothing*
 * maps, so untagged/fully-unspecified tracks carry no empty `colorSpace` object.
 */
export function videoColorSpaceFromColr(colr: ColrInfo): VideoColorSpaceInit | undefined {
  const primaries = h273Primaries(colr.primaries);
  const transfer = h273Transfer(colr.transfer);
  const matrix = h273Matrix(colr.matrix);
  if (
    primaries === undefined &&
    transfer === undefined &&
    matrix === undefined &&
    colr.fullRange === undefined
  ) {
    return undefined;
  }
  return {
    ...(primaries !== undefined ? { primaries } : {}),
    ...(transfer !== undefined ? { transfer } : {}),
    ...(matrix !== undefined ? { matrix } : {}),
    ...(colr.fullRange !== undefined ? { fullRange: colr.fullRange } : {}),
  };
}

/** `lpcm` (v2) token from CoreAudio formatSpecificFlags: 0x1 float, 0x2 big-endian, 0x4 signed. */
function lpcmToken(bits: number, flags: number): string | undefined {
  const float = (flags & 0x1) !== 0;
  const be = (flags & 0x2) !== 0;
  const signed = (flags & 0x4) !== 0;
  if (float) {
    if (bits === 32) return be ? 'pcm-f32be' : 'pcm-f32';
    if (bits === 64) return be ? 'pcm-f64be' : 'pcm-f64';
    return undefined;
  }
  if (signed) {
    if (bits === 8) return 'pcm-s8';
    if (bits === 16) return be ? 'pcm-s16be' : 'pcm-s16';
    if (bits === 24) return be ? 'pcm-s24be' : 'pcm-s24';
    if (bits === 32) return be ? 'pcm-s32be' : 'pcm-s32';
    return undefined;
  }
  return bits === 8 ? 'pcm-u8' : undefined;
}

/**
 * QuickTime PCM sound-description fourcc → engine PCM token (`pcm-s16`, `pcm-f32be`, … — the same
 * tokens the WAV/AIFF/CAF drivers use), or undefined when the entry is not uncompressed PCM or the
 * combination has no representable token (honest fourcc fallback, never a wrong guess).
 *
 * Endianness per the QTFF format table: `sowt` is 16-bit little-endian and `twos`/`raw ` are fixed
 * big-endian/unsigned by definition; the wide integer/float formats (`in24`/`in32`/`fl32`/`fl64`)
 * default to big-endian unless a sibling `enda` atom (value 1) flips them — pass its value as
 * `littleEndian`. `lpcm` (v2 entries) encodes everything in `formatSpecificFlags` + bits instead.
 */
export function qtPcmCodec(
  entryType: string,
  bitsPerSample: number,
  littleEndian: boolean | undefined,
  lpcmFlags?: number,
): string | undefined {
  switch (entryType) {
    case 'sowt':
      return bitsPerSample === 16 ? 'pcm-s16' : undefined;
    case 'twos':
      return bitsPerSample === 16 ? 'pcm-s16be' : bitsPerSample === 8 ? 'pcm-s8' : undefined;
    case 'raw ':
      return bitsPerSample === 8 ? 'pcm-u8' : undefined;
    case 'in24':
      return littleEndian === true ? 'pcm-s24' : 'pcm-s24be';
    case 'in32':
      return littleEndian === true ? 'pcm-s32' : 'pcm-s32be';
    case 'fl32':
      return littleEndian === true ? 'pcm-f32' : 'pcm-f32be';
    case 'fl64':
      return littleEndian === true ? 'pcm-f64' : 'pcm-f64be';
    case 'lpcm':
      return lpcmToken(bitsPerSample, lpcmFlags ?? 0);
    default:
      return undefined;
  }
}
