/**
 * H.264 AVCDecoderConfigurationRecord (`avcC`) visible-width crop rewriting.
 *
 * WebCodecs publishes H.264 parameter sets out-of-band in `decoderConfig.description`. That makes the
 * SPS the authoritative place to describe a padded coded surface with a narrower visible picture. This
 * module changes only `frame_crop_right_offset`, preserves every other SPS bit, regenerates valid RBSP
 * trailing bits, and re-applies Annex-B emulation prevention. It is deliberately pure and asset-agnostic.
 */

const H264_NAL_TYPE_SPS = 7;
const AVC_CONFIGURATION_VERSION = 1;
const HIGH_PROFILES = new Set([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 244]);

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
