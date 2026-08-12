import { describe, expect, it } from 'vitest';
import { parseH264SpsDimensions } from '../drivers/mpegts/ts-parse.ts';
import {
  addH264AvcCVisibleRightCrop,
  h264AvcCColors,
  h264AvcCSampleAspectRatios,
  rewriteH264AvcCColor,
} from './h264-avcc-crop.ts';

/** Real libx264 High-profile avcC records, generated from 856×480 and 864×480 one-frame streams. */
const AVCC_856 = fromHex(
  '0164001fffe1001a6764001facd940d83de5f0110000030001000003003c0f18319601000668ebe3cb22c0fdf8f800',
);
const AVCC_864 = fromHex(
  '0164001fffe100196764001facd940d83db0110000030001000003003c0f18319601000668ebe3cb22c0fdf8f800',
);
/** Real High-profile avcC from a 600×448 MOV whose extended_SAR is 224:225 (DAR 4:3). */
const AVCC_SAR_224_225 = fromHex(
  '01640015ffe1001d67640015acb404c1cf2fff80700070880000030008000003018478b17501000568cf32c8b0',
);

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd test hex');
  return Uint8Array.from(
    Array.from({ length: hex.length / 2 }, (_, index) =>
      Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
    ),
  );
}

function firstSps(avcC: Uint8Array): Uint8Array {
  const length = ((avcC[6] as number) << 8) | (avcC[7] as number);
  return avcC.subarray(8, 8 + length);
}

function unsignedGolombBits(value: number): number[] {
  const binary = (value + 1).toString(2);
  return [...new Array<number>(binary.length - 1).fill(0), ...Array.from(binary, Number)];
}

function signedGolombBits(value: number): number[] {
  return unsignedGolombBits(value <= 0 ? -2 * value : 2 * value - 1);
}

function fixedBits(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >> (width - index - 1)) & 1);
}

function escapedRbsp(bits: number[]): Uint8Array {
  bits.push(1);
  while (bits.length % 8 !== 0) bits.push(0);
  const rbsp = Uint8Array.from({ length: bits.length / 8 }, (_, byteIndex) =>
    bits.slice(byteIndex * 8, byteIndex * 8 + 8).reduce((byte, bit) => byte * 2 + bit, 0),
  );
  const escaped: number[] = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      escaped.push(3);
      zeros = 0;
    }
    escaped.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(escaped);
}

function syntheticAvcC(
  options: {
    profile?: number;
    chromaFormat?: number;
    scalingMatrix?: boolean;
    picOrderCountType?: number;
    fieldCoded?: boolean;
    vui?: 'none' | 'no-signal' | 'no-colour' | 'standard-sar' | 'extended-sar';
  } = {},
): Uint8Array {
  const profile = options.profile ?? 66;
  const bits = [
    ...fixedBits(profile, 8),
    ...fixedBits(0, 8),
    ...fixedBits(31, 8),
    ...unsignedGolombBits(0),
  ];
  if (profile === 100) {
    const chromaFormat = options.chromaFormat ?? 1;
    bits.push(...unsignedGolombBits(chromaFormat));
    if (chromaFormat === 3) bits.push(0);
    bits.push(...unsignedGolombBits(0), ...unsignedGolombBits(0), 0);
    bits.push(options.scalingMatrix ? 1 : 0);
    if (options.scalingMatrix) {
      bits.push(...new Array<number>(chromaFormat === 3 ? 12 : 8).fill(0));
    }
  }
  bits.push(...unsignedGolombBits(0));
  const picOrderCountType = options.picOrderCountType ?? 0;
  bits.push(...unsignedGolombBits(picOrderCountType));
  if (picOrderCountType === 0) {
    bits.push(...unsignedGolombBits(0));
  } else if (picOrderCountType === 1) {
    bits.push(0, ...signedGolombBits(-1), ...signedGolombBits(1), ...unsignedGolombBits(2));
    bits.push(...signedGolombBits(-2), ...signedGolombBits(2));
  }
  bits.push(...unsignedGolombBits(1), 0, ...unsignedGolombBits(53), ...unsignedGolombBits(29));
  bits.push(options.fieldCoded ? 0 : 1);
  if (options.fieldCoded) bits.push(1);
  bits.push(1, 0);

  const vui = options.vui ?? 'none';
  bits.push(vui === 'none' ? 0 : 1);
  if (vui !== 'none') {
    const extendedSar = vui === 'extended-sar';
    const standardSar = vui === 'standard-sar';
    bits.push(extendedSar || standardSar ? 1 : 0);
    if (standardSar) bits.push(...fixedBits(14, 8));
    if (extendedSar) bits.push(...fixedBits(255, 8), ...fixedBits(4, 16), ...fixedBits(3, 16));
    bits.push(extendedSar ? 1 : 0);
    if (extendedSar) bits.push(1);
    const videoSignal = vui !== 'no-signal';
    bits.push(videoSignal ? 1 : 0);
    if (videoSignal) {
      bits.push(...fixedBits(5, 3), 1);
      const hasColour = vui === 'extended-sar';
      bits.push(hasColour ? 1 : 0);
      if (hasColour) bits.push(...fixedBits(1, 8), ...fixedBits(1, 8), ...fixedBits(1, 8));
    }
    bits.push(0, 0, 0, 0, 0, 0);
  }

  const rbsp = escapedRbsp(bits);
  const sps = Uint8Array.of(0x67, ...rbsp);
  return Uint8Array.of(
    1,
    profile,
    0,
    31,
    0xff,
    0xe1,
    (sps.byteLength >>> 8) & 0xff,
    sps.byteLength & 0xff,
    ...sps,
    0,
  );
}

describe('addH264AvcCVisibleRightCrop — standards-valid aligned coded surface', () => {
  it('increments an existing SPS crop so 856 coded-display pixels expose exactly 854', () => {
    expect(parseH264SpsDimensions(firstSps(AVCC_856))).toEqual({ width: 856, height: 480 });
    const rewritten = addH264AvcCVisibleRightCrop(AVCC_856, 2);
    expect(parseH264SpsDimensions(firstSps(rewritten))).toEqual({ width: 854, height: 480 });
    expect(AVCC_856).toEqual(
      fromHex(
        '0164001fffe1001a6764001facd940d83de5f0110000030001000003003c0f18319601000668ebe3cb22c0fdf8f800',
      ),
    );
  });

  it('adds frame cropping when the aligned SPS had no crop flag (864 → 862)', () => {
    expect(parseH264SpsDimensions(firstSps(AVCC_864))).toEqual({ width: 864, height: 480 });
    const rewritten = addH264AvcCVisibleRightCrop(AVCC_864, 2);
    expect(parseH264SpsDimensions(firstSps(rewritten))).toEqual({ width: 862, height: 480 });
  });

  it('preserves PPS and avcC extension bytes byte-for-byte', () => {
    const rewritten = addH264AvcCVisibleRightCrop(AVCC_856, 2);
    const inputSpsEnd = 8 + (((AVCC_856[6] as number) << 8) | (AVCC_856[7] as number));
    const outputSpsEnd = 8 + (((rewritten[6] as number) << 8) | (rewritten[7] as number));
    expect(rewritten.subarray(outputSpsEnd)).toEqual(AVCC_856.subarray(inputSpsEnd));
  });

  it('rejects invalid crop sizes and malformed/truncated avcC records', () => {
    expect(() => addH264AvcCVisibleRightCrop(AVCC_856, 0)).toThrow(RangeError);
    expect(() => addH264AvcCVisibleRightCrop(AVCC_856, 1)).toThrow(/chroma crop unit/);
    expect(() => addH264AvcCVisibleRightCrop(Uint8Array.of(1, 2, 3), 2)).toThrow(
      /invalid AVCDecoderConfigurationRecord/,
    );
    expect(() => addH264AvcCVisibleRightCrop(AVCC_856.subarray(0, 12), 2)).toThrow(
      /truncated avcC SPS payload/,
    );
    expect(() => addH264AvcCVisibleRightCrop(Uint8Array.of(1, 0, 0, 0, 0, 0, 0), 2)).toThrow(
      /no SPS/,
    );
    expect(() => addH264AvcCVisibleRightCrop(Uint8Array.of(1, 0, 0, 0, 0, 1, 0), 2)).toThrow(
      /truncated avcC SPS length/,
    );
    expect(() => addH264AvcCVisibleRightCrop(Uint8Array.of(1, 0, 0, 0, 0, 1, 0, 0), 2)).toThrow(
      /truncated avcC SPS payload/,
    );

    const nonSps = AVCC_856.slice();
    nonSps[8] = 0x68;
    expect(() => addH264AvcCVisibleRightCrop(nonSps, 2)).toThrow(/not an H.264 SPS NAL/);
    expect(() => addH264AvcCVisibleRightCrop(AVCC_856, 2_000)).toThrow(/entire coded picture/);
  });
});

describe('h264AvcCSampleAspectRatios — SPS VUI presentation geometry', () => {
  it('reads the extended_SAR pair from a real non-square-pixel MOV avcC', () => {
    expect(h264AvcCSampleAspectRatios(AVCC_SAR_224_225)).toEqual([{ width: 224, height: 225 }]);
  });

  it('reads a synthetic extended_SAR independently of the colour declaration', () => {
    expect(h264AvcCSampleAspectRatios(syntheticAvcC({ vui: 'extended-sar' }))).toEqual([
      { width: 4, height: 3 },
    ]);
    expect(h264AvcCSampleAspectRatios(syntheticAvcC({ vui: 'no-colour' }))).toEqual([undefined]);
  });

  it('maps a standard aspect_ratio_idc through the H.264 Table E-1 ratio', () => {
    expect(h264AvcCSampleAspectRatios(syntheticAvcC({ vui: 'standard-sar' }))).toEqual([
      { width: 4, height: 3 },
    ]);
  });

  it('rejects malformed avcC rather than manufacturing a ratio', () => {
    expect(() => h264AvcCSampleAspectRatios(Uint8Array.of(1, 2, 3))).toThrow(
      /invalid AVCDecoderConfigurationRecord/,
    );
  });
});

describe('rewriteH264AvcCColor — elementary/container colour agreement', () => {
  const bt2020 = {
    primaries: 9,
    transferCharacteristics: 14,
    matrixCoefficients: 9,
    fullRange: false,
  } as const;
  const bt709 = {
    primaries: 1,
    transferCharacteristics: 1,
    matrixCoefficients: 1,
    fullRange: false,
  } as const;

  it('adds a complete colour declaration to a real SPS whose VUI omitted it', () => {
    expect(h264AvcCColors(AVCC_856)).toEqual([undefined]);
    const rewritten = rewriteH264AvcCColor(AVCC_856, bt2020);
    expect(h264AvcCColors(rewritten)).toEqual([bt2020]);
    expect(AVCC_856).toEqual(
      fromHex(
        '0164001fffe1001a6764001facd940d83de5f0110000030001000003003c0f18319601000668ebe3cb22c0fdf8f800',
      ),
    );
  });

  it('replaces a conflicting declaration and remains composable with the visible-crop rewrite', () => {
    const conflicting = rewriteH264AvcCColor(AVCC_856, bt709);
    expect(h264AvcCColors(conflicting)).toEqual([bt709]);
    const rewritten = rewriteH264AvcCColor(conflicting, bt2020);
    expect(h264AvcCColors(rewritten)).toEqual([bt2020]);

    const croppedAfterColor = addH264AvcCVisibleRightCrop(rewritten, 2);
    expect(h264AvcCColors(croppedAfterColor)).toEqual([bt2020]);
    expect(parseH264SpsDimensions(firstSps(croppedAfterColor))).toEqual({
      width: 854,
      height: 480,
    });

    const colorAfterCrop = rewriteH264AvcCColor(addH264AvcCVisibleRightCrop(AVCC_856, 2), bt2020);
    expect(h264AvcCColors(colorAfterCrop)).toEqual([bt2020]);
    expect(parseH264SpsDimensions(firstSps(colorAfterCrop))).toEqual({ width: 854, height: 480 });
  });

  it('rewrites every declared SPS and preserves the PPS/extension suffix', () => {
    const sps = firstSps(AVCC_856);
    const suffixOffset = 8 + sps.byteLength;
    const suffix = AVCC_856.subarray(suffixOffset);
    const twoSps = Uint8Array.of(
      ...(AVCC_856.subarray(0, 5) as Uint8Array),
      ((AVCC_856[5] as number) & 0xe0) | 2,
      (sps.byteLength >>> 8) & 0xff,
      sps.byteLength & 0xff,
      ...sps,
      (sps.byteLength >>> 8) & 0xff,
      sps.byteLength & 0xff,
      ...sps,
      ...suffix,
    );
    const rewritten = rewriteH264AvcCColor(twoSps, bt2020);
    expect(h264AvcCColors(rewritten)).toEqual([bt2020, bt2020]);
    const rewrittenFirstLength = ((rewritten[6] as number) << 8) | (rewritten[7] as number);
    const rewrittenSecondLengthOffset = 8 + rewrittenFirstLength;
    const rewrittenSecondLength =
      ((rewritten[rewrittenSecondLengthOffset] as number) << 8) |
      (rewritten[rewrittenSecondLengthOffset + 1] as number);
    const rewrittenSuffixOffset = rewrittenSecondLengthOffset + 2 + rewrittenSecondLength;
    expect(rewritten.subarray(rewrittenSuffixOffset)).toEqual(suffix);
  });

  it('preserves uncommon but valid SPS prefix and VUI syntax while authoring colour', () => {
    for (const input of [
      syntheticAvcC({ picOrderCountType: 1, fieldCoded: true, vui: 'no-signal' }),
      syntheticAvcC({ profile: 100, chromaFormat: 3, scalingMatrix: true, vui: 'no-colour' }),
      syntheticAvcC({ vui: 'extended-sar' }),
    ]) {
      const rewritten = rewriteH264AvcCColor(input, bt2020);
      expect(h264AvcCColors(rewritten)).toEqual([bt2020]);
      expect(addH264AvcCVisibleRightCrop(rewritten, 2)).toBeInstanceOf(Uint8Array);
    }
  });

  it('rejects invalid SPS enum syntax and an RBSP without a stop bit', () => {
    expect(() =>
      rewriteH264AvcCColor(syntheticAvcC({ profile: 100, chromaFormat: 4 }), bt2020),
    ).toThrow(/chroma_format_idc/);
    expect(() => rewriteH264AvcCColor(syntheticAvcC({ picOrderCountType: 3 }), bt2020)).toThrow(
      /pic_order_cnt_type/,
    );
    const noStop = Uint8Array.of(1, 66, 0, 31, 0xff, 0xe1, 0, 4, 0x67, 0, 0, 0, 0);
    expect(() => h264AvcCColors(noStop)).toThrow(/rbsp_stop_one_bit/);
  });

  it('rejects malformed avcC and invalid H.273 code points rather than emitting partial VUI', () => {
    expect(() => rewriteH264AvcCColor(Uint8Array.of(1, 2, 3), bt2020)).toThrow(
      /invalid AVCDecoderConfigurationRecord/,
    );
    expect(() => rewriteH264AvcCColor(AVCC_856.subarray(0, 12), bt2020)).toThrow(
      /truncated avcC SPS payload/,
    );
    expect(() =>
      rewriteH264AvcCColor(AVCC_856, { ...bt2020, transferCharacteristics: 256 }),
    ).toThrow(RangeError);
    expect(() => rewriteH264AvcCColor(AVCC_856, { ...bt2020, primaries: -1 })).toThrow(RangeError);
    expect(() =>
      rewriteH264AvcCColor(AVCC_856, { ...bt2020, matrixCoefficients: Number.NaN }),
    ).toThrow(RangeError);
    expect(() => rewriteH264AvcCColor(Uint8Array.of(1, 0, 0, 0, 0, 0, 0), bt2020)).toThrow(
      /no SPS/,
    );
    expect(() => rewriteH264AvcCColor(Uint8Array.of(1, 0, 0, 0, 0, 1, 0), bt2020)).toThrow(
      /truncated avcC SPS length/,
    );
    expect(() => rewriteH264AvcCColor(Uint8Array.of(1, 0, 0, 0, 0, 1, 0, 0), bt2020)).toThrow(
      /truncated avcC SPS payload/,
    );

    const nonSps = AVCC_856.slice();
    nonSps[8] = 0x68;
    expect(() => rewriteH264AvcCColor(nonSps, bt2020)).toThrow(/not an H.264 SPS NAL/);
    expect(() => h264AvcCColors(Uint8Array.of(2, 0, 0, 0, 0, 1, 0))).toThrow(
      /invalid AVCDecoderConfigurationRecord/,
    );
  });
});
