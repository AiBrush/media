import { describe, expect, it } from 'vitest';
import { parseH264SpsDimensions } from '../drivers/mpegts/ts-parse.ts';
import { addH264AvcCVisibleRightCrop } from './h264-avcc-crop.ts';

/** Real libx264 High-profile avcC records, generated from 856×480 and 864×480 one-frame streams. */
const AVCC_856 = fromHex(
  '0164001fffe1001a6764001facd940d83de5f0110000030001000003003c0f18319601000668ebe3cb22c0fdf8f800',
);
const AVCC_864 = fromHex(
  '0164001fffe100196764001facd940d83db0110000030001000003003c0f18319601000668ebe3cb22c0fdf8f800',
);

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd test hex');
  return Uint8Array.from(
    Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)),
  );
}

function firstSps(avcC: Uint8Array): Uint8Array {
  const length = ((avcC[6] as number) << 8) | (avcC[7] as number);
  return avcC.subarray(8, 8 + length);
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
  });
});
