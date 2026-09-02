import { MediaError } from '../contracts/errors.ts';

const EIGHT_BIT_PLANAR_FORMATS = new Set<string>(['I420', 'I420A', 'I422', 'I444', 'NV12']);

/**
 * Copy Matroska VPx alpha from a decoder's native 8-bit luma plane. Returning `undefined` means the
 * runtime exposed only a packed RGB frame, so the caller may use its compatibility fallback. A planar
 * frame that cannot supply a valid plane is an error: silently rasterizing it would apply YUV range
 * conversion and change opacity bytes.
 */
export async function decodedVpxAlphaLuma(
  frame: VideoFrame,
  width: number,
  height: number,
): Promise<Uint8Array | undefined> {
  if (frame.format === null || !EIGHT_BIT_PLANAR_FORMATS.has(frame.format)) return undefined;

  const storage = new Uint8Array(frame.allocationSize());
  const layout = await frame.copyTo(storage);
  const luma = layout[0];
  if (
    luma === undefined ||
    !Number.isSafeInteger(luma.offset) ||
    luma.offset < 0 ||
    !Number.isSafeInteger(luma.stride) ||
    luma.stride < width
  ) {
    throw new MediaError('decode-error', 'decoded VPx alpha frame has no valid luma plane');
  }

  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount < 0) {
    throw new MediaError('decode-error', `VPx alpha frame has invalid dimensions ${width}x${height}`);
  }
  if (luma.offset + luma.stride * (height - 1) + width > storage.byteLength) {
    throw new MediaError('decode-error', 'decoded VPx alpha luma plane is truncated');
  }
  if (luma.stride === width) {
    return storage.slice(luma.offset, luma.offset + pixelCount);
  }
  const alpha = new Uint8Array(pixelCount);
  for (let row = 0; row < height; row++) {
    const start = luma.offset + row * luma.stride;
    alpha.set(storage.subarray(start, start + width), row * width);
  }
  return alpha;
}
