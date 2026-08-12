/**
 * H.264 AVCDecoderConfigurationRecord (`avcC`) SPS rewriting.
 *
 * WebCodecs publishes H.264 parameter sets out-of-band in `decoderConfig.description`. That makes the
 * SPS the authoritative place to describe a padded coded surface with a narrower visible picture. This
 * module can change `frame_crop_right_offset` or author a complete VUI colour declaration; each operation
 * preserves all unrelated SPS bits, regenerates valid RBSP trailing bits, and re-applies Annex-B emulation
 * prevention. It is deliberately pure and asset-agnostic.
 */

const H264_NAL_TYPE_SPS = 7;
const AVC_CONFIGURATION_VERSION = 1;
const HIGH_PROFILES = new Set([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 244]);

/** Complete H.264 VUI video-signal colour declaration. Numeric fields use H.273 code points. */
export interface H264VuiColor {
  readonly primaries: number;
  readonly transferCharacteristics: number;
  readonly matrixCoefficients: number;
  readonly fullRange: boolean;
}

/** H.264 VUI sample aspect ratio (`sar_width:sar_height` or a standard aspect_ratio_idc mapping). */
export interface H264SampleAspectRatio {
  readonly width: number;
  readonly height: number;
}

// ITU-T H.264 Table E-1. Values 17..254 are reserved; 255 carries an explicit u16 pair.
const H264_SAMPLE_ASPECT_RATIOS: Readonly<Record<number, readonly [number, number]>> = {
  1: [1, 1],
  2: [12, 11],
  3: [10, 11],
  4: [16, 11],
  5: [40, 33],
  6: [24, 11],
  7: [20, 11],
  8: [32, 11],
  9: [80, 33],
  10: [18, 11],
  11: [15, 11],
  12: [64, 33],
  13: [160, 99],
  14: [4, 3],
  15: [3, 2],
  16: [2, 1],
};

interface ParsedSpsPrefix {
  readonly rbsp: Uint8Array;
  readonly semanticEnd: number;
  readonly reader: BitReader;
}

function assertColorCode(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`H.264 ${label} must be an 8-bit H.273 code point, got ${value}`);
  }
}

function assertH264VuiColor(color: H264VuiColor): void {
  assertColorCode('colour primaries', color.primaries);
  assertColorCode('transfer characteristics', color.transferCharacteristics);
  assertColorCode('matrix coefficients', color.matrixCoefficients);
}

function avcCDescription(avcC: Uint8Array): {
  readonly prefix: Uint8Array;
  readonly sps: readonly Uint8Array[];
  readonly suffixOffset: number;
} {
  if (avcC.byteLength < 7 || avcC[0] !== AVC_CONFIGURATION_VERSION) {
    throw new Error('invalid AVCDecoderConfigurationRecord');
  }
  const spsCount = (avcC[5] as number) & 0x1f;
  if (spsCount === 0) throw new Error('AVCDecoderConfigurationRecord has no SPS');
  const sps: Uint8Array[] = [];
  let offset = 6;
  for (let index = 0; index < spsCount; index++) {
    if (offset + 2 > avcC.byteLength) throw new Error('truncated avcC SPS length');
    const length = ((avcC[offset] as number) << 8) | (avcC[offset + 1] as number);
    offset += 2;
    if (length <= 0 || offset + length > avcC.byteLength) {
      throw new Error('truncated avcC SPS payload');
    }
    sps.push(avcC.subarray(offset, offset + length));
    offset += length;
  }
  return { prefix: avcC.subarray(0, 6), sps, suffixOffset: offset };
}

/** Read the complete colour declaration from every SPS in an AVCDecoderConfigurationRecord. */
export function h264AvcCColors(avcC: Uint8Array): readonly (H264VuiColor | undefined)[] {
  return avcCDescription(avcC).sps.map(readSpsColor);
}

/** Read each SPS's VUI sample aspect ratio from an AVCDecoderConfigurationRecord. */
export function h264AvcCSampleAspectRatios(
  avcC: Uint8Array,
): readonly (H264SampleAspectRatio | undefined)[] {
  return avcCDescription(avcC).sps.map(readSpsSampleAspectRatio);
}

/**
 * Author the same complete VUI colour tuple in every SPS of an AVCDecoderConfigurationRecord.
 * Existing VUI timing/HRD/restriction syntax, PPS entries, and avcC extension bytes are preserved.
 */
export function rewriteH264AvcCColor(avcC: Uint8Array, color: H264VuiColor): Uint8Array {
  assertH264VuiColor(color);
  const parsed = avcCDescription(avcC);
  const output: number[] = [...parsed.prefix];
  for (const sps of parsed.sps) {
    const rewritten = rewriteSpsColor(sps, color);
    if (rewritten.byteLength > 0xffff) {
      throw new Error('rewritten H.264 SPS exceeds avcC u16 length');
    }
    output.push((rewritten.byteLength >>> 8) & 0xff, rewritten.byteLength & 0xff, ...rewritten);
  }
  output.push(...avcC.subarray(parsed.suffixOffset));
  const rewritten = Uint8Array.from(output);
  const declarations = h264AvcCColors(rewritten);
  if (declarations.some((candidate) => !h264VuiColorsEqual(candidate, color))) {
    throw new Error('rewritten H.264 SPS did not retain the requested VUI colour declaration');
  }
  return rewritten;
}

function h264VuiColorsEqual(actual: H264VuiColor | undefined, expected: H264VuiColor): boolean {
  return (
    actual?.primaries === expected.primaries &&
    actual.transferCharacteristics === expected.transferCharacteristics &&
    actual.matrixCoefficients === expected.matrixCoefficients &&
    actual.fullRange === expected.fullRange
  );
}

/** Add `cropPixels` to the visible right crop of every SPS in an `avcC` record. */
export function addH264AvcCVisibleRightCrop(avcC: Uint8Array, cropPixels: number): Uint8Array {
  if (!Number.isSafeInteger(cropPixels) || cropPixels <= 0) {
    throw new RangeError(`H.264 right crop must be a positive integer, got ${cropPixels}`);
  }
  if (avcC.byteLength < 7 || avcC[0] !== AVC_CONFIGURATION_VERSION) {
    throw new Error('invalid AVCDecoderConfigurationRecord');
  }

  const spsCount = (avcC[5] as number) & 0x1f;
  if (spsCount === 0) throw new Error('AVCDecoderConfigurationRecord has no SPS');
  const output: number[] = [...avcC.subarray(0, 6)];
  let offset = 6;
  for (let index = 0; index < spsCount; index++) {
    if (offset + 2 > avcC.byteLength) throw new Error('truncated avcC SPS length');
    const length = ((avcC[offset] as number) << 8) | (avcC[offset + 1] as number);
    offset += 2;
    if (length <= 0 || offset + length > avcC.byteLength) {
      throw new Error('truncated avcC SPS payload');
    }
    const rewritten = addSpsVisibleRightCrop(avcC.subarray(offset, offset + length), cropPixels);
    if (rewritten.byteLength > 0xffff)
      throw new Error('rewritten H.264 SPS exceeds avcC u16 length');
    output.push((rewritten.byteLength >>> 8) & 0xff, rewritten.byteLength & 0xff, ...rewritten);
    offset += length;
  }
  output.push(...avcC.subarray(offset));
  return Uint8Array.from(output);
}

/** Rewrite one SPS NAL while preserving its NAL header and every non-crop syntax element. */
function addSpsVisibleRightCrop(nal: Uint8Array, cropPixels: number): Uint8Array {
  if (nal.byteLength < 4 || ((nal[0] as number) & 0x1f) !== H264_NAL_TYPE_SPS) {
    throw new Error('avcC SPS entry is not an H.264 SPS NAL');
  }
  const rbsp = removeEmulationPrevention(nal.subarray(1));
  const semanticEnd = rbspStopBitOffset(rbsp);
  const reader = new BitReader(rbsp, semanticEnd);

  const profileIdc = reader.bits(8);
  reader.bits(8); // constraint_set flags + reserved_zero_2bits
  reader.bits(8); // level_idc
  reader.unsignedExpGolomb(); // seq_parameter_set_id

  let chromaFormatIdc = 1;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = reader.unsignedExpGolomb();
    if (chromaFormatIdc > 3) throw new Error(`invalid H.264 chroma_format_idc ${chromaFormatIdc}`);
    if (chromaFormatIdc === 3) reader.bit(); // separate_colour_plane_flag
    reader.unsignedExpGolomb(); // bit_depth_luma_minus8
    reader.unsignedExpGolomb(); // bit_depth_chroma_minus8
    reader.bit(); // qpprime_y_zero_transform_bypass_flag
    if (reader.bit() === 1) {
      const scalingListCount = chromaFormatIdc === 3 ? 12 : 8;
      for (let index = 0; index < scalingListCount; index++) {
        if (reader.bit() === 1) skipScalingList(reader, index < 6 ? 16 : 64);
      }
    }
  }

  reader.unsignedExpGolomb(); // log2_max_frame_num_minus4
  const picOrderCountType = reader.unsignedExpGolomb();
  if (picOrderCountType === 0) {
    reader.unsignedExpGolomb(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCountType === 1) {
    reader.bit(); // delta_pic_order_always_zero_flag
    reader.signedExpGolomb(); // offset_for_non_ref_pic
    reader.signedExpGolomb(); // offset_for_top_to_bottom_field
    const cycleLength = reader.unsignedExpGolomb();
    for (let index = 0; index < cycleLength; index++) reader.signedExpGolomb();
  }
  reader.unsignedExpGolomb(); // max_num_ref_frames
  reader.bit(); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = reader.unsignedExpGolomb() + 1;
  reader.unsignedExpGolomb(); // pic_height_in_map_units_minus1
  const frameMbsOnly = reader.bit();
  if (frameMbsOnly === 0) reader.bit(); // mb_adaptive_frame_field_flag
  reader.bit(); // direct_8x8_inference_flag

  const cropFlagOffset = reader.offset;
  const hasCrop = reader.bit() === 1;
  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (hasCrop) {
    cropLeft = reader.unsignedExpGolomb();
    cropRight = reader.unsignedExpGolomb();
    cropTop = reader.unsignedExpGolomb();
    cropBottom = reader.unsignedExpGolomb();
  }
  const afterCropOffset = reader.offset;

  const cropUnitX = chromaFormatIdc === 0 || chromaFormatIdc === 3 ? 1 : 2;
  if (cropPixels % cropUnitX !== 0) {
    throw new Error(
      `H.264 ${cropPixels}px right crop is not divisible by chroma crop unit ${cropUnitX}`,
    );
  }
  const cropDelta = cropPixels / cropUnitX;
  const nextCropRight = cropRight + cropDelta;
  const visibleWidth = widthMbs * 16 - (cropLeft + nextCropRight) * cropUnitX;
  if (visibleWidth <= 0) throw new Error('H.264 right crop removes the entire coded picture');

  const sourceBits = bitsFromBytes(rbsp);
  const outputBits = sourceBits.slice(0, cropFlagOffset);
  outputBits.push(1);
  outputBits.push(...unsignedExpGolombBits(cropLeft));
  outputBits.push(...unsignedExpGolombBits(nextCropRight));
  outputBits.push(...unsignedExpGolombBits(cropTop));
  outputBits.push(...unsignedExpGolombBits(cropBottom));
  outputBits.push(...sourceBits.slice(afterCropOffset, semanticEnd));
  outputBits.push(1); // rbsp_stop_one_bit
  while (outputBits.length % 8 !== 0) outputBits.push(0);

  const escaped = addEmulationPrevention(bytesFromBits(outputBits));
  return Uint8Array.of(nal[0] as number, ...escaped);
}

/** Parse SPS syntax through `vui_parameters_present_flag`, leaving the reader immediately before it. */
function parseSpsPrefixToVui(nal: Uint8Array): ParsedSpsPrefix {
  if (nal.byteLength < 4 || ((nal[0] as number) & 0x1f) !== H264_NAL_TYPE_SPS) {
    throw new Error('avcC SPS entry is not an H.264 SPS NAL');
  }
  const rbsp = removeEmulationPrevention(nal.subarray(1));
  const semanticEnd = rbspStopBitOffset(rbsp);
  const reader = new BitReader(rbsp, semanticEnd);

  const profileIdc = reader.bits(8);
  reader.bits(8); // constraint_set flags + reserved_zero_2bits
  reader.bits(8); // level_idc
  reader.unsignedExpGolomb(); // seq_parameter_set_id

  let chromaFormatIdc = 1;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = reader.unsignedExpGolomb();
    if (chromaFormatIdc > 3) throw new Error(`invalid H.264 chroma_format_idc ${chromaFormatIdc}`);
    if (chromaFormatIdc === 3) reader.bit(); // separate_colour_plane_flag
    reader.unsignedExpGolomb(); // bit_depth_luma_minus8
    reader.unsignedExpGolomb(); // bit_depth_chroma_minus8
    reader.bit(); // qpprime_y_zero_transform_bypass_flag
    if (reader.bit() === 1) {
      const scalingListCount = chromaFormatIdc === 3 ? 12 : 8;
      for (let index = 0; index < scalingListCount; index++) {
        if (reader.bit() === 1) skipScalingList(reader, index < 6 ? 16 : 64);
      }
    }
  }

  reader.unsignedExpGolomb(); // log2_max_frame_num_minus4
  const picOrderCountType = reader.unsignedExpGolomb();
  if (picOrderCountType === 0) {
    reader.unsignedExpGolomb(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCountType === 1) {
    reader.bit(); // delta_pic_order_always_zero_flag
    reader.signedExpGolomb(); // offset_for_non_ref_pic
    reader.signedExpGolomb(); // offset_for_top_to_bottom_field
    const cycleLength = reader.unsignedExpGolomb();
    for (let index = 0; index < cycleLength; index++) reader.signedExpGolomb();
  } else if (picOrderCountType !== 2) {
    throw new Error(`invalid H.264 pic_order_cnt_type ${picOrderCountType}`);
  }
  reader.unsignedExpGolomb(); // max_num_ref_frames
  reader.bit(); // gaps_in_frame_num_value_allowed_flag
  reader.unsignedExpGolomb(); // pic_width_in_mbs_minus1
  reader.unsignedExpGolomb(); // pic_height_in_map_units_minus1
  const frameMbsOnly = reader.bit();
  if (frameMbsOnly === 0) reader.bit(); // mb_adaptive_frame_field_flag
  reader.bit(); // direct_8x8_inference_flag
  if (reader.bit() === 1) {
    reader.unsignedExpGolomb(); // frame_crop_left_offset
    reader.unsignedExpGolomb(); // frame_crop_right_offset
    reader.unsignedExpGolomb(); // frame_crop_top_offset
    reader.unsignedExpGolomb(); // frame_crop_bottom_offset
  }
  return { rbsp, semanticEnd, reader };
}

function readVuiSampleAspectRatio(reader: BitReader): H264SampleAspectRatio | undefined {
  if (reader.bit() === 0) return undefined; // aspect_ratio_info_present_flag
  const aspectRatioIdc = reader.bits(8);
  if (aspectRatioIdc === 255) {
    const width = reader.bits(16);
    const height = reader.bits(16);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  const ratio = H264_SAMPLE_ASPECT_RATIOS[aspectRatioIdc];
  return ratio === undefined ? undefined : { width: ratio[0], height: ratio[1] };
}

function skipVuiPrefixToVideoSignal(reader: BitReader): void {
  readVuiSampleAspectRatio(reader);
  if (reader.bit() === 1) reader.bit(); // overscan_info_present_flag / overscan_appropriate_flag
}

function readSpsSampleAspectRatio(nal: Uint8Array): H264SampleAspectRatio | undefined {
  const { reader } = parseSpsPrefixToVui(nal);
  if (reader.bit() === 0) return undefined; // vui_parameters_present_flag
  return readVuiSampleAspectRatio(reader);
}

function readSpsColor(nal: Uint8Array): H264VuiColor | undefined {
  const { reader } = parseSpsPrefixToVui(nal);
  if (reader.bit() === 0) return undefined; // vui_parameters_present_flag
  skipVuiPrefixToVideoSignal(reader);
  if (reader.bit() === 0) return undefined; // video_signal_type_present_flag
  reader.bits(3); // video_format
  const fullRange = reader.bit() === 1;
  if (reader.bit() === 0) return undefined; // colour_description_present_flag
  return {
    primaries: reader.bits(8),
    transferCharacteristics: reader.bits(8),
    matrixCoefficients: reader.bits(8),
    fullRange,
  };
}

function videoSignalBits(color: H264VuiColor): number[] {
  return [
    ...fixedWidthBits(5, 3), // video_format = unspecified
    color.fullRange ? 1 : 0,
    1, // colour_description_present_flag
    ...fixedWidthBits(color.primaries, 8),
    ...fixedWidthBits(color.transferCharacteristics, 8),
    ...fixedWidthBits(color.matrixCoefficients, 8),
  ];
}

function minimalVuiBits(color: H264VuiColor): number[] {
  return [
    0, // aspect_ratio_info_present_flag
    0, // overscan_info_present_flag
    1, // video_signal_type_present_flag
    ...videoSignalBits(color),
    0, // chroma_loc_info_present_flag
    0, // timing_info_present_flag
    0, // nal_hrd_parameters_present_flag
    0, // vcl_hrd_parameters_present_flag (no low_delay_hrd_flag follows)
    0, // pic_struct_present_flag
    0, // bitstream_restriction_flag
  ];
}

/** Rewrite one SPS NAL while preserving every syntax element outside its VUI colour declaration. */
function rewriteSpsColor(nal: Uint8Array, color: H264VuiColor): Uint8Array {
  const { rbsp, semanticEnd, reader } = parseSpsPrefixToVui(nal);
  const sourceBits = bitsFromBytes(rbsp);
  const vuiFlagOffset = reader.offset;
  const hasVui = reader.bit() === 1;
  let outputBits: number[];

  if (!hasVui) {
    if (reader.offset !== semanticEnd) {
      throw new Error('H.264 SPS has syntax after an absent VUI flag');
    }
    outputBits = sourceBits.slice(0, vuiFlagOffset);
    outputBits.push(1, ...minimalVuiBits(color));
  } else {
    skipVuiPrefixToVideoSignal(reader);
    const videoSignalFlagOffset = reader.offset;
    const hasVideoSignal = reader.bit() === 1;
    if (!hasVideoSignal) {
      outputBits = sourceBits.slice(0, videoSignalFlagOffset);
      outputBits.push(1, ...videoSignalBits(color));
      outputBits.push(...sourceBits.slice(reader.offset, semanticEnd));
    } else {
      reader.bits(3); // preserve video_format
      const fullRangeOffset = reader.offset;
      reader.bit();
      const colorDescriptionFlagOffset = reader.offset;
      const hasColorDescription = reader.bit() === 1;
      if (hasColorDescription) reader.bits(24);
      outputBits = sourceBits.slice(0, fullRangeOffset);
      outputBits.push(color.fullRange ? 1 : 0);
      outputBits.push(...sourceBits.slice(fullRangeOffset + 1, colorDescriptionFlagOffset));
      outputBits.push(1);
      outputBits.push(...fixedWidthBits(color.primaries, 8));
      outputBits.push(...fixedWidthBits(color.transferCharacteristics, 8));
      outputBits.push(...fixedWidthBits(color.matrixCoefficients, 8));
      outputBits.push(...sourceBits.slice(reader.offset, semanticEnd));
    }
  }

  outputBits.push(1); // rbsp_stop_one_bit
  while (outputBits.length % 8 !== 0) outputBits.push(0);
  return Uint8Array.of(nal[0] as number, ...addEmulationPrevention(bytesFromBits(outputBits)));
}

function skipScalingList(reader: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let index = 0; index < size; index++) {
    if (nextScale !== 0) nextScale = (lastScale + reader.signedExpGolomb() + 256) % 256;
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

function removeEmulationPrevention(ebsp: Uint8Array): Uint8Array {
  const output = new Uint8Array(ebsp.byteLength);
  let length = 0;
  let zeroRun = 0;
  for (const value of ebsp) {
    if (zeroRun >= 2 && value === 0x03) {
      zeroRun = 0;
      continue;
    }
    output[length++] = value;
    zeroRun = value === 0 ? zeroRun + 1 : 0;
  }
  return output.subarray(0, length);
}

function addEmulationPrevention(rbsp: Uint8Array): Uint8Array {
  const output: number[] = [];
  let zeroRun = 0;
  for (const value of rbsp) {
    if (zeroRun >= 2 && value <= 0x03) {
      output.push(0x03);
      zeroRun = 0;
    }
    output.push(value);
    zeroRun = value === 0 ? zeroRun + 1 : 0;
  }
  return Uint8Array.from(output);
}

/** The SPS syntax payload ends immediately before the final RBSP stop bit (the last one bit). */
function rbspStopBitOffset(rbsp: Uint8Array): number {
  for (let offset = rbsp.byteLength * 8 - 1; offset >= 0; offset--) {
    const value = (rbsp[offset >> 3] as number) >> (7 - (offset & 7));
    if ((value & 1) === 1) return offset;
  }
  throw new Error('H.264 SPS has no rbsp_stop_one_bit');
}

function bitsFromBytes(bytes: Uint8Array): number[] {
  const output = new Array<number>(bytes.byteLength * 8);
  for (let offset = 0; offset < output.length; offset++) {
    output[offset] = ((bytes[offset >> 3] as number) >> (7 - (offset & 7))) & 1;
  }
  return output;
}

function bytesFromBits(bits: readonly number[]): Uint8Array {
  if (bits.length % 8 !== 0) throw new Error('H.264 RBSP bit length is not byte-aligned');
  const output = new Uint8Array(bits.length / 8);
  for (let offset = 0; offset < bits.length; offset++) {
    const byteIndex = offset >> 3;
    output[byteIndex] = (output[byteIndex] ?? 0) | ((bits[offset] as number) << (7 - (offset & 7)));
  }
  return output;
}

function fixedWidthBits(value: number, width: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** width) {
    throw new Error(`value ${value} does not fit in ${width} H.264 bits`);
  }
  return Array.from({ length: width }, (_, index) => (value >> (width - index - 1)) & 1);
}

function unsignedExpGolombBits(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`invalid Exp-Golomb value ${value}`);
  const binary = (value + 1).toString(2);
  const output = new Array<number>(binary.length - 1).fill(0);
  for (const bit of binary) output.push(bit === '1' ? 1 : 0);
  return output;
}

class BitReader {
  readonly #bytes: Uint8Array;
  readonly #end: number;
  #offset = 0;

  constructor(bytes: Uint8Array, end: number) {
    this.#bytes = bytes;
    this.#end = end;
  }

  get offset(): number {
    return this.#offset;
  }

  bit(): number {
    if (this.#offset >= this.#end) throw new Error('truncated H.264 SPS');
    const value = ((this.#bytes[this.#offset >> 3] as number) >> (7 - (this.#offset & 7))) & 1;
    this.#offset++;
    return value;
  }

  bits(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > 32) {
      throw new Error(`invalid H.264 bit-field width ${count}`);
    }
    let value = 0;
    for (let index = 0; index < count; index++) value = value * 2 + this.bit();
    return value;
  }

  unsignedExpGolomb(): number {
    let leadingZeros = 0;
    while (this.bit() === 0) {
      leadingZeros++;
      if (leadingZeros > 31) throw new Error('H.264 Exp-Golomb overflow');
    }
    return leadingZeros === 0 ? 0 : 2 ** leadingZeros - 1 + this.bits(leadingZeros);
  }

  signedExpGolomb(): number {
    const code = this.unsignedExpGolomb();
    return code % 2 === 1 ? (code + 1) / 2 : -(code / 2);
  }
}
