/**
 * H.264 SPS helpers used by the Matroska demuxer.
 *
 * Matroska stores block presentation timestamps but no separate decode timestamps. ISO/IEC 14496-10
 * defines `max_num_reorder_frames` in the SPS VUI bitstream restriction; that is the authoritative
 * decoder-picture-buffer delay needed to reconstruct the decode clock without inspecting test data or
 * guessing from a particular GOP shape.
 */

const EXTENDED_SAR = 255;
const HIGH_PROFILES = new Set([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 244]);

/** Return the first SPS's declared reorder depth from an AVCDecoderConfigurationRecord (`avcC`). */
export function h264MaxNumReorderFramesFromAvcC(avcC: Uint8Array): number | undefined {
  if (avcC.byteLength < 8 || avcC[0] !== 1) return undefined;
  const spsCount = (avcC[5] as number) & 0x1f;
  let offset = 6;
  for (let index = 0; index < spsCount; index++) {
    if (offset + 2 > avcC.byteLength) return undefined;
    const length = ((avcC[offset] as number) << 8) | (avcC[offset + 1] as number);
    offset += 2;
    if (length <= 0 || offset + length > avcC.byteLength) return undefined;
    const nal = avcC.subarray(offset, offset + length);
    offset += length;
    if (((nal[0] ?? 0) & 0x1f) !== 7) continue;
    return maxNumReorderFramesFromSps(nal);
  }
  return undefined;
}

/** Parse only far enough through an SPS to reach VUI `bitstream_restriction_flag`. */
function maxNumReorderFramesFromSps(nal: Uint8Array): number | undefined {
  const rbsp = stripEmulationPrevention(nal).subarray(1); // omit the one-byte NAL header
  const reader = new BitReader(rbsp);
  try {
    const profileIdc = reader.bits(8);
    reader.bits(8); // constraint_set flags + reserved_zero_2bits
    reader.bits(8); // level_idc
    reader.unsignedExpGolomb(); // seq_parameter_set_id

    if (HIGH_PROFILES.has(profileIdc)) {
      const chromaFormatIdc = reader.unsignedExpGolomb();
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
    if (reader.bit() === 0) return undefined; // vui_parameters_present_flag
    return parseVuiReorderDepth(reader);
  } catch {
    // Truncated/malformed codec private data is not fatal to container probe; it simply cannot supply DTS.
    return undefined;
  }
}

function parseVuiReorderDepth(reader: BitReader): number | undefined {
  if (reader.bit() === 1) {
    const aspectRatioIdc = reader.bits(8);
    if (aspectRatioIdc === EXTENDED_SAR) {
      reader.bits(16); // sar_width
      reader.bits(16); // sar_height
    }
  }
  if (reader.bit() === 1) reader.bit(); // overscan_info_present_flag / overscan_appropriate_flag
  if (reader.bit() === 1) {
    reader.bits(3); // video_format
    reader.bit(); // video_full_range_flag
    if (reader.bit() === 1) {
      reader.bits(8); // colour_primaries
      reader.bits(8); // transfer_characteristics
      reader.bits(8); // matrix_coefficients
    }
  }
  if (reader.bit() === 1) {
    reader.unsignedExpGolomb(); // chroma_sample_loc_type_top_field
    reader.unsignedExpGolomb(); // chroma_sample_loc_type_bottom_field
  }
  if (reader.bit() === 1) {
    reader.bits(32); // num_units_in_tick
    reader.bits(32); // time_scale
    reader.bit(); // fixed_frame_rate_flag
  }
  const nalHrd = reader.bit() === 1;
  if (nalHrd) skipHrdParameters(reader);
  const vclHrd = reader.bit() === 1;
  if (vclHrd) skipHrdParameters(reader);
  if (nalHrd || vclHrd) reader.bit(); // low_delay_hrd_flag
  reader.bit(); // pic_struct_present_flag
  if (reader.bit() === 0) return undefined; // bitstream_restriction_flag
  reader.bit(); // motion_vectors_over_pic_boundaries_flag
  reader.unsignedExpGolomb(); // max_bytes_per_pic_denom
  reader.unsignedExpGolomb(); // max_bits_per_mb_denom
  reader.unsignedExpGolomb(); // log2_max_mv_length_horizontal
  reader.unsignedExpGolomb(); // log2_max_mv_length_vertical
  const depth = reader.unsignedExpGolomb();
  reader.unsignedExpGolomb(); // max_dec_frame_buffering
  return depth;
}

function skipHrdParameters(reader: BitReader): void {
  const cpbCount = reader.unsignedExpGolomb() + 1;
  reader.bits(4); // bit_rate_scale
  reader.bits(4); // cpb_size_scale
  for (let index = 0; index < cpbCount; index++) {
    reader.unsignedExpGolomb(); // bit_rate_value_minus1
    reader.unsignedExpGolomb(); // cpb_size_value_minus1
    reader.bit(); // cbr_flag
  }
  reader.bits(5); // initial_cpb_removal_delay_length_minus1
  reader.bits(5); // cpb_removal_delay_length_minus1
  reader.bits(5); // dpb_output_delay_length_minus1
  reader.bits(5); // time_offset_length
}

function skipScalingList(reader: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let index = 0; index < size; index++) {
    if (nextScale !== 0) nextScale = (lastScale + reader.signedExpGolomb() + 256) % 256;
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

function stripEmulationPrevention(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.byteLength);
  let length = 0;
  let zeroRun = 0;
  for (const value of nal) {
    if (zeroRun >= 2 && value === 0x03) {
      zeroRun = 0;
      continue;
    }
    out[length++] = value;
    zeroRun = value === 0 ? zeroRun + 1 : 0;
  }
  return out.subarray(0, length);
}

class BitReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  bit(): number {
    if (this.#offset >= this.#bytes.byteLength * 8) throw new Error('truncated H.264 SPS');
    const byte = this.#bytes[this.#offset >> 3] as number;
    const value = (byte >> (7 - (this.#offset & 7))) & 1;
    this.#offset++;
    return value;
  }

  bits(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > 32) {
      throw new Error('invalid H.264 bit-field width');
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
    if (leadingZeros === 0) return 0;
    return 2 ** leadingZeros - 1 + this.bits(leadingZeros);
  }

  signedExpGolomb(): number {
    const code = this.unsignedExpGolomb();
    return code % 2 === 1 ? (code + 1) / 2 : -(code / 2);
  }
}
