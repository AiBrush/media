import { describe, expect, it } from 'vitest';
import { MediaError } from '../contracts/errors.ts';
import { decodedVpxAlphaLuma } from './vpx-alpha-frame-pixels.ts';

function frame(
  format: VideoPixelFormat,
  bytes: readonly number[],
  layout: readonly PlaneLayout[],
): VideoFrame {
  return {
    format,
    allocationSize: () => bytes.length,
    copyTo(destination: AllowSharedBufferSource): Promise<readonly PlaneLayout[]> {
      const target = ArrayBuffer.isView(destination)
        ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
        : new Uint8Array(destination);
      target.set(bytes);
      return Promise.resolve(layout);
    },
  } as unknown as VideoFrame;
}

describe('decodedVpxAlphaLuma', () => {
  it('tightens a padded native I420 luma plane without changing full-swing bytes', async () => {
    const decoded = await decodedVpxAlphaLuma(
      frame(
        'I420',
        [99, 0, 15, 88, 99, 16, 254, 88, 128, 128],
        [
          { offset: 1, stride: 4 },
          { offset: 8, stride: 1 },
          { offset: 9, stride: 1 },
        ],
      ),
      2,
      2,
    );

    expect(decoded).toEqual(Uint8Array.from([0, 15, 16, 254]));
  });

  it('leaves packed RGB frames to the compatibility path', async () => {
    await expect(
      decodedVpxAlphaLuma(frame('BGRX', [1, 2, 3, 4], [{ offset: 0, stride: 4 }]), 1, 1),
    ).resolves.toBeUndefined();
  });

  it('rejects malformed planar output instead of range-converting it through RGB', async () => {
    await expect(
      decodedVpxAlphaLuma(frame('NV12', [1, 2, 3], [{ offset: 0, stride: 1 }]), 2, 2),
    ).rejects.toBeInstanceOf(MediaError);
  });
});
