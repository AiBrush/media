import { describe, expect, it } from 'vitest';
import { h264MaxNumReorderFramesFromAvcC } from './h264-sps.ts';

class H264BitWriter {
  readonly #bits: number[] = [];

  bit(value: number): void {
    this.#bits.push(value & 1);
  }

  bits(value: number, width: number): void {
    for (let shift = width - 1; shift >= 0; shift--) this.bit(value >> shift);
  }

  ue(value: number): void {
    const codeNum = value + 1;
    const width = Math.floor(Math.log2(codeNum)) + 1;
    for (let index = 1; index < width; index++) this.bit(0);
    this.bits(codeNum, width);
  }

  se(value: number): void {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  bytes(): Uint8Array {
    const output = new Uint8Array(Math.ceil(this.#bits.length / 8));
    for (let index = 0; index < this.#bits.length; index++) {
      const byteIndex = index >> 3;
      output[byteIndex] =
        (output[byteIndex] ?? 0) | ((this.#bits[index] ?? 0) << (7 - (index & 7)));
    }
    return output;
  }
}

interface SpsOptions {
  readonly highProfile?: boolean;
  readonly scalingMatrix?: boolean;
  readonly picOrderCountType?: 0 | 1 | 2;
  readonly interlaced?: boolean;
  readonly cropped?: boolean;
  readonly vui?: 'none' | 'minimal' | 'maximal';
  readonly reorderDepth?: number;
  readonly restriction?: boolean;
}

function writeHrd(bits: H264BitWriter): void {
  bits.ue(1); // cpb_cnt_minus1 => two schedule entries
  bits.bits(3, 4);
  bits.bits(4, 4);
  for (let index = 0; index < 2; index++) {
    bits.ue(index);
    bits.ue(index + 1);
    bits.bit(index);
  }
  bits.bits(23, 5);
  bits.bits(22, 5);
  bits.bits(21, 5);
  bits.bits(20, 5);
}

function spsNal(options: SpsOptions = {}): Uint8Array {
  const bits = new H264BitWriter();
  const highProfile = options.highProfile ?? false;
  bits.bits(highProfile ? 100 : 66, 8);
  bits.bits(0, 8);
  bits.bits(40, 8);
  bits.ue(0);
  if (highProfile) {
    bits.ue(options.scalingMatrix ? 3 : 1);
    if (options.scalingMatrix) bits.bit(0); // separate_colour_plane_flag
    bits.ue(0);
    bits.ue(0);
    bits.bit(0);
    bits.bit(options.scalingMatrix ? 1 : 0);
    if (options.scalingMatrix) {
      for (let list = 0; list < 12; list++) {
        const present = list === 0 || list === 6;
        bits.bit(present ? 1 : 0);
        if (present) {
          // A first delta of -8 makes nextScale zero; the remaining list entries carry no syntax bits.
          bits.se(-8);
        }
      }
    }
  }
  bits.ue(0);
  const picOrderCountType = options.picOrderCountType ?? 0;
  bits.ue(picOrderCountType);
  if (picOrderCountType === 0) {
    bits.ue(2);
  } else if (picOrderCountType === 1) {
    bits.bit(0);
    bits.se(-1);
    bits.se(2);
    bits.ue(2);
    bits.se(-2);
    bits.se(3);
  }
  bits.ue(4);
  bits.bit(0);
  bits.ue(79);
  bits.ue(44);
  bits.bit(options.interlaced ? 0 : 1);
  if (options.interlaced) bits.bit(1);
  bits.bit(1);
  bits.bit(options.cropped ? 1 : 0);
  if (options.cropped) {
    bits.ue(1);
    bits.ue(2);
    bits.ue(3);
    bits.ue(4);
  }
  const vui = options.vui ?? 'minimal';
  bits.bit(vui === 'none' ? 0 : 1);
  if (vui !== 'none') {
    const maximal = vui === 'maximal';
    bits.bit(maximal ? 1 : 0); // aspect_ratio_info_present_flag
    if (maximal) {
      bits.bits(255, 8);
      bits.bits(4, 16);
      bits.bits(3, 16);
    }
    bits.bit(maximal ? 1 : 0); // overscan_info_present_flag
    if (maximal) bits.bit(1);
    bits.bit(maximal ? 1 : 0); // video_signal_type_present_flag
    if (maximal) {
      bits.bits(5, 3);
      bits.bit(1);
      bits.bit(1);
      bits.bits(1, 8);
      bits.bits(13, 8);
      bits.bits(0, 8);
    }
    bits.bit(maximal ? 1 : 0); // chroma_loc_info_present_flag
    if (maximal) {
      bits.ue(2);
      bits.ue(3);
    }
    bits.bit(maximal ? 1 : 0); // timing_info_present_flag
    if (maximal) {
      bits.bits(1001, 32);
      bits.bits(60_000, 32);
      bits.bit(1);
    }
    bits.bit(maximal ? 1 : 0); // nal_hrd_parameters_present_flag
    if (maximal) writeHrd(bits);
    bits.bit(maximal ? 1 : 0); // vcl_hrd_parameters_present_flag
    if (maximal) writeHrd(bits);
    if (maximal) bits.bit(0); // low_delay_hrd_flag
    bits.bit(maximal ? 1 : 0); // pic_struct_present_flag
    bits.bit(options.restriction === false ? 0 : 1);
    if (options.restriction !== false) {
      bits.bit(1);
      bits.ue(2);
      bits.ue(1);
      bits.ue(16);
      bits.ue(16);
      bits.ue(options.reorderDepth ?? 2);
      bits.ue(4);
    }
  }
  bits.bit(1); // rbsp_stop_one_bit
  return Uint8Array.of(0x67, ...bits.bytes(), 0, 0, 3, 1);
}

function avcC(...nals: readonly Uint8Array[]): Uint8Array {
  const size = 6 + nals.reduce((total, nal) => total + 2 + nal.byteLength, 0);
  const output = new Uint8Array(size);
  output.set([1, 100, 0, 40, 0xff, 0xe0 | nals.length]);
  let offset = 6;
  for (const nal of nals) {
    output[offset] = nal.byteLength >> 8;
    output[offset + 1] = nal.byteLength;
    output.set(nal, offset + 2);
    offset += 2 + nal.byteLength;
  }
  return output;
}

describe('Matroska H.264 SPS reorder-depth qualification', () => {
  it('returns undefined for non-avcC, absent, truncated, empty, and non-SPS declarations', () => {
    expect(h264MaxNumReorderFramesFromAvcC(new Uint8Array())).toBeUndefined();
    expect(h264MaxNumReorderFramesFromAvcC(Uint8Array.of(2, 0, 0, 0, 0, 0, 0, 0))).toBeUndefined();
    expect(h264MaxNumReorderFramesFromAvcC(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0))).toBeUndefined();
    expect(h264MaxNumReorderFramesFromAvcC(Uint8Array.of(1, 0, 0, 0, 0, 0xe1))).toBeUndefined();
    expect(
      h264MaxNumReorderFramesFromAvcC(Uint8Array.of(1, 0, 0, 0, 0, 0xe1, 0, 0)),
    ).toBeUndefined();
    expect(
      h264MaxNumReorderFramesFromAvcC(Uint8Array.of(1, 0, 0, 0, 0, 0xe1, 0, 4, 0x67)),
    ).toBeUndefined();
    expect(h264MaxNumReorderFramesFromAvcC(avcC(Uint8Array.of(0x68, 0)))).toBeUndefined();
  });

  it('parses baseline and High-profile VUI syntax without changing declared B-frame depth', () => {
    expect(h264MaxNumReorderFramesFromAvcC(avcC(spsNal({ reorderDepth: 3 })))).toBe(3);
    expect(
      h264MaxNumReorderFramesFromAvcC(
        avcC(
          Uint8Array.of(0x68, 0),
          spsNal({
            highProfile: true,
            scalingMatrix: true,
            picOrderCountType: 1,
            interlaced: true,
            cropped: true,
            vui: 'maximal',
            reorderDepth: 6,
          }),
        ),
      ),
    ).toBe(6);
  });

  it('honestly declines SPS declarations without usable VUI restriction data', () => {
    expect(h264MaxNumReorderFramesFromAvcC(avcC(spsNal({ vui: 'none' })))).toBeUndefined();
    expect(h264MaxNumReorderFramesFromAvcC(avcC(spsNal({ restriction: false })))).toBeUndefined();
    expect(h264MaxNumReorderFramesFromAvcC(avcC(Uint8Array.of(0x67, 100)))).toBeUndefined();
    expect(
      h264MaxNumReorderFramesFromAvcC(avcC(Uint8Array.of(0x67, 66, 0, 40, 0, 0, 0, 0, 0))),
    ).toBeUndefined();
  });
});
