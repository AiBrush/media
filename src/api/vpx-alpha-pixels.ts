import { MediaError } from '../contracts/errors.ts';

export const RGBA_BYTES_PER_PIXEL = 4;

export type VpxAlphaPackedSourceFormat = 'RGBA' | 'BGRA';

const HOST_IS_LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

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
  return vpxAlphaI420FromPackedChannel(source, width, height, sourcePlane, format, 3);
}

/**
 * Pack the red channel of a grayscale RGBA/BGRA raster as direct full-swing VPx alpha luma. Geometry
 * filters materialize their result as display RGB; feeding that RGB frame straight to VideoEncoder
 * makes the browser apply studio-swing RGB→YUV conversion (0 becomes 16), which is wrong for an alpha
 * payload whose samples are the channel values themselves.
 */
export function vpxAlphaI420FromPackedGrayscale(
  source: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  sourcePlane: PlaneLayout,
  format: VpxAlphaPackedSourceFormat,
): VpxAlphaI420Plane {
  const redByteOffset = format === 'RGBA' ? 0 : format === 'BGRA' ? 2 : undefined;
  if (redByteOffset === undefined) {
    throw new MediaError('encode-error', `Unsupported VPx alpha packed source format ${format}`);
  }
  return vpxAlphaI420FromPackedChannel(source, width, height, sourcePlane, format, redByteOffset);
}

function vpxAlphaI420FromPackedChannel(
  source: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  sourcePlane: PlaneLayout,
  format: VpxAlphaPackedSourceFormat,
  channelByteOffset: number,
): VpxAlphaI420Plane {
  assertVpxAlphaDimensions(width, height);
  assertPlaneContainsRows(source, sourcePlane, width * RGBA_BYTES_PER_PIXEL, height);
  if (format !== 'RGBA' && format !== 'BGRA') {
    throw new MediaError('encode-error', `Unsupported VPx alpha packed source format ${format}`);
  }
  const layout = vpxAlphaI420Layout(width, height);
  const data = new Uint8Array(vpxAlphaI420ByteLength(width, height));
  for (let y = 0; y < height; y++) {
    const sourceRow = sourcePlane.offset + y * sourcePlane.stride;
    const targetRow = y * width;
    for (let x = 0; x < width; x++) {
      data[targetRow + x] = source[
        sourceRow + x * RGBA_BYTES_PER_PIXEL + channelByteOffset
      ] as number;
    }
  }
  fillNeutralI420Chroma(data, layout, height);
  return { data, layout };
}

/**
 * Replace packed RGBA alpha with the red channel of a grayscale RGBA plane. The 32-bit path performs
 * one load/store per pixel on little-endian browser targets; the byte path preserves portability.
 */
export function mergeVpxAlphaRgba(color: Uint8ClampedArray, alpha: Uint8ClampedArray): void {
  const byteLength = Math.min(color.byteLength, alpha.byteLength);
  const packedLength = byteLength - (byteLength % RGBA_BYTES_PER_PIXEL);
  if (
    HOST_IS_LITTLE_ENDIAN &&
    color.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0 &&
    alpha.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0
  ) {
    const colorWords = new Uint32Array(
      color.buffer,
      color.byteOffset,
      packedLength / RGBA_BYTES_PER_PIXEL,
    );
    const alphaWords = new Uint32Array(
      alpha.buffer,
      alpha.byteOffset,
      packedLength / RGBA_BYTES_PER_PIXEL,
    );
    for (let index = 0; index < colorWords.length; index++) {
      colorWords[index] =
        ((colorWords[index] as number) & 0x00ff_ffff) |
        (((alphaWords[index] as number) & 0xff) << 24);
    }
    return;
  }
  for (let index = 0; index < packedLength; index += RGBA_BYTES_PER_PIXEL) {
    color[index + 3] = alpha[index] as number;
  }
}

/** Replace packed RGBA alpha with one tightly-packed, full-swing VPx luma sample per pixel. */
export function mergeVpxAlphaLuma(color: Uint8ClampedArray, alpha: Uint8Array): void {
  const pixelCount = color.byteLength / RGBA_BYTES_PER_PIXEL;
  if (!Number.isInteger(pixelCount) || alpha.byteLength < pixelCount) {
    throw new MediaError(
      'decode-error',
      `VPx alpha luma has ${alpha.byteLength} bytes for ${color.byteLength} RGBA bytes`,
    );
  }
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    color[pixel * RGBA_BYTES_PER_PIXEL + 3] = alpha[pixel] as number;
  }
}
