import { describe, expect, it } from 'vitest';
import {
  MP4_IDENTITY_DISPLAY_MATRIX,
  type Mp4DisplayMatrix,
  clockwiseRotationFromMp4Matrix,
  mp4MatrixFromClockwiseRotation,
} from './display-transform.ts';

const FIXED_ONE = 0x00010000;
const FIXED_NEGATIVE_ONE = 0xffff0000;

function matrix(a: number, b: number, c: number, d: number): Mp4DisplayMatrix {
  return [a, b, 0, c, d, 0, 0, 0, 0x40000000];
}

describe('ISO display-matrix clockwise convention', () => {
  it.each([
    { rotation: 0, value: MP4_IDENTITY_DISPLAY_MATRIX },
    { rotation: 90, value: matrix(0, FIXED_ONE, FIXED_NEGATIVE_ONE, 0) },
    { rotation: 180, value: matrix(FIXED_NEGATIVE_ONE, 0, 0, FIXED_NEGATIVE_ONE) },
    { rotation: 270, value: matrix(0, FIXED_NEGATIVE_ONE, FIXED_ONE, 0) },
  ])('reads the independent $rotation° cardinal matrix', ({ rotation, value }) => {
    expect(clockwiseRotationFromMp4Matrix(value)).toBe(rotation);
  });

  it.each([0, 17, 90, 180, 271, 359])(
    'round-trips an authored %d° clockwise scalar through the fixed-point matrix',
    (rotation) => {
      const authored = mp4MatrixFromClockwiseRotation(rotation, 1920, 1080);
      expect(clockwiseRotationFromMp4Matrix(authored) ?? 0).toBe(rotation);
    },
  );

  it('authors 90° and 270° with opposite matrix signs and positive-space translations', () => {
    expect(mp4MatrixFromClockwiseRotation(90, 1920, 1080)).toEqual([
      0,
      FIXED_ONE,
      0,
      FIXED_NEGATIVE_ONE,
      0,
      0,
      1080 * FIXED_ONE,
      0,
      0x40000000,
    ]);
    expect(mp4MatrixFromClockwiseRotation(270, 1920, 1080)).toEqual([
      0,
      FIXED_NEGATIVE_ONE,
      0,
      FIXED_ONE,
      0,
      0,
      0,
      1920 * FIXED_ONE,
      0x40000000,
    ]);
  });
});
