import { normalizeClockwiseRotation } from '../../util/rotation.ts';

/** The nine serialized 32-bit fixed-point words in an ISO-BMFF `tkhd` display matrix. */
export type Mp4DisplayMatrix = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Opaque `tkhd` display metadata. Words remain unsigned so parse -> write is bit-exact. */
export interface Mp4DisplayTransform {
  readonly matrix: Mp4DisplayMatrix;
  /** Raw unsigned 16.16 `tkhd.width` word, distinct from the coded sample-entry width. */
  readonly width16_16: number;
  /** Raw unsigned 16.16 `tkhd.height` word, distinct from the coded sample-entry height. */
  readonly height16_16: number;
}

export const MP4_IDENTITY_DISPLAY_MATRIX: Mp4DisplayMatrix = [
  0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000,
];

function signedFixed16(word: number): number {
  return (word | 0) / 65536;
}

/**
 * Derive the public clockwise scalar from the first row of a raw `tkhd` matrix.
 *
 * FFmpeg exposes the inverse angle as a counter-clockwise display rotation; the stored first row
 * itself maps `[0,1;-1,0]` to the public 90-degree clockwise presentation. Keep this small form
 * shared with the bounded fast probe so the two MP4 metadata paths cannot disagree about the sign.
 */
export function clockwiseRotationFromMp4MatrixFirstRow(a: number, b: number): number {
  if (a === 1 && b === 0) return 0;
  const degrees = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return normalizeClockwiseRotation(degrees) ?? 0;
}

/** Derive the public clockwise scalar from a complete raw `tkhd` matrix. */
export function clockwiseRotationFromMp4Matrix(matrix: Mp4DisplayMatrix): number | undefined {
  const a = signedFixed16(matrix[0]);
  const b = signedFixed16(matrix[1]);
  if (a === 1 && b === 0) return 0;
  const normalized = clockwiseRotationFromMp4MatrixFirstRow(a, b);
  return normalized === 0 ? undefined : normalized;
}

function fixed16Word(value: number): number {
  return Math.round(value * 65536) >>> 0;
}

/** Canonical ISO matrix synthesized only when no raw source matrix is available. */
export function mp4MatrixFromClockwiseRotation(
  rotation: number | undefined,
  width = 0,
  height = 0,
): Mp4DisplayMatrix {
  const clockwise = normalizeClockwiseRotation(rotation) ?? 0;
  if (clockwise === 0) return MP4_IDENTITY_DISPLAY_MATRIX;
  const radians = (clockwise * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  // `tkhd` transforms about the top-left origin. Translate the transformed coded rectangle back into
  // positive display space (90°: +height on X; 180°: +width/+height; 270°: +width on Y).
  const transformedX = [0, cosine * width, -sine * height, cosine * width - sine * height];
  const transformedY = [0, sine * width, cosine * height, sine * width + cosine * height];
  const translateX = -Math.min(...transformedX);
  const translateY = -Math.min(...transformedY);
  return [
    fixed16Word(cosine),
    fixed16Word(sine),
    0,
    fixed16Word(-sine),
    fixed16Word(cosine),
    0,
    fixed16Word(translateX),
    fixed16Word(translateY),
    0x40000000,
  ];
}

/** Encode a display dimension as an unsigned 16.16 word (the historical writer behavior). */
export function mp4DisplayDimensionWord(value: number | undefined): number {
  return Math.round((value ?? 0) * 65536) >>> 0;
}
