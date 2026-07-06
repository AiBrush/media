import { MediaError } from '../contracts/errors.ts';

export const RGBA_BYTES_PER_PIXEL = 4;

export type VpxAlphaPackedSourceFormat = 'RGBA' | 'BGRA';

export interface VpxAlphaI420Plane {
  readonly data: Uint8Array;
  readonly layout: readonly PlaneLayout[];
}

function assertVpxAlphaDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new MediaError('encode-error', `VPx alpha frame has invalid width ${width}`);
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new MediaError('encode-error', `VPx alpha frame has invalid height ${height}`);
  }
}

function vpxAlphaI420Layout(width: number, height: number): PlaneLayout[] {
  assertVpxAlphaDimensions(width, height);
  const ySize = width * height;
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const chromaSize = chromaWidth * chromaHeight;
  return [
    { offset: 0, stride: width },
    { offset: ySize, stride: chromaWidth },
    { offset: ySize + chromaSize, stride: chromaWidth },
  ];
}

function vpxAlphaI420ByteLength(width: number, height: number): number {
  assertVpxAlphaDimensions(width, height);
  const ySize = width * height;
  const chromaSize = Math.ceil(width / 2) * Math.ceil(height / 2);
  return ySize + chromaSize * 2;
}

function assertPlaneContainsRows(
  data: Uint8Array | Uint8ClampedArray,
  plane: PlaneLayout,
  width: number,
  height: number,
): void {
  if (!Number.isSafeInteger(plane.offset) || plane.offset < 0) {
    throw new MediaError('encode-error', `VPx alpha plane has invalid offset ${plane.offset}`);
  }
  if (!Number.isSafeInteger(plane.stride) || plane.stride < width) {
    throw new MediaError('encode-error', `VPx alpha plane has invalid stride ${plane.stride}`);
  }
  if (height === 0) return;
  const lastByte = plane.offset + plane.stride * (height - 1) + width;
  if (lastByte > data.length) {
    throw new MediaError(
      'encode-error',
      `VPx alpha plane is truncated: need ${lastByte} bytes, got ${data.length}`,
    );
  }
}

function fillNeutralI420Chroma(
  data: Uint8Array,
  layout: readonly PlaneLayout[],
  height: number,
): void {
  const chromaHeight = Math.ceil(height / 2);
  for (const plane of layout.slice(1)) {
    const byteLength = plane.stride * chromaHeight;
    data.fill(0x80, plane.offset, plane.offset + byteLength);
  }
}

export function vpxAlphaI420FromPlane(
  source: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  alphaPlane: PlaneLayout,
): VpxAlphaI420Plane {
  assertVpxAlphaDimensions(width, height);
  assertPlaneContainsRows(source, alphaPlane, width, height);
  const layout = vpxAlphaI420Layout(width, height);
  const data = new Uint8Array(vpxAlphaI420ByteLength(width, height));
  for (let y = 0; y < height; y++) {
    const sourceStart = alphaPlane.offset + y * alphaPlane.stride;
    data.set(source.subarray(sourceStart, sourceStart + width), y * width);
  }
  fillNeutralI420Chroma(data, layout, height);
  return { data, layout };
}

export function vpxAlphaI420FromPackedRgba(
  source: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  sourcePlane: PlaneLayout,
  format: VpxAlphaPackedSourceFormat,
): VpxAlphaI420Plane {
  assertVpxAlphaDimensions(width, height);
  assertPlaneContainsRows(source, sourcePlane, width * RGBA_BYTES_PER_PIXEL, height);
  const alphaByteOffset = format === 'RGBA' || format === 'BGRA' ? 3 : undefined;
  if (alphaByteOffset === undefined) {
    throw new MediaError('encode-error', `Unsupported VPx alpha packed source format ${format}`);
  }
  const layout = vpxAlphaI420Layout(width, height);
  const data = new Uint8Array(vpxAlphaI420ByteLength(width, height));
  for (let y = 0; y < height; y++) {
    const sourceRow = sourcePlane.offset + y * sourcePlane.stride;
    const targetRow = y * width;
    for (let x = 0; x < width; x++) {
      data[targetRow + x] = source[
        sourceRow + x * RGBA_BYTES_PER_PIXEL + alphaByteOffset
      ] as number;
    }
  }
  fillNeutralI420Chroma(data, layout, height);
  return { data, layout };
}
