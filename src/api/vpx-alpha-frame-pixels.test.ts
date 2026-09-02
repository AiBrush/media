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

  it('unit: tight stride fast path returns slice without per-row loops', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const luma = await decodedVpxAlphaLuma(frame('I420', [...bytes], [{ offset: 2, stride: 3 }]), 3, 2);
    expect(luma).toEqual(Uint8Array.from([2, 3, 4, 5, 6, 7]));
  });

  it('property: random packed vs padded strides produce identical tight output', async () => {
    let seed = 0xdead_beef;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 24) & 0xff;
    };
    for (let trial = 0; trial < 20; trial++) {
      const width = 1 + (rnd() % 8);
      const height = 1 + (rnd() % 8);
      const stride = width + (rnd() % 4);
      const storage = new Uint8Array(stride * height + 4);
      for (let i = 0; i < storage.length; i++) storage[i] = rnd();
      const expected = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        expected.set(storage.subarray(y * stride, y * stride + width), y * width);
      }
      const frameBytes = [...storage];
      const decoded = await decodedVpxAlphaLuma(
        frame('I420', frameBytes, [{ offset: 0, stride }]),
        width,
        height,
      );
      expect(decoded).toEqual(expected);
    }
  });

  it('boundary: 1x1, 0x0-invalid, and large tight planes', async () => {
    const one = await decodedVpxAlphaLuma(frame('I420', [0, 99, 0], [{ offset: 1, stride: 1 }]), 1, 1);
    expect(one).toEqual(Uint8Array.from([99]));
    await expect(
      decodedVpxAlphaLuma(frame('I420', [0, 0], [{ offset: 0, stride: 0 }]), 1, 1),
    ).rejects.toBeInstanceOf(MediaError);
    const largeW = 64;
    const largeH = 48;
    const largeBytes = new Uint8Array(largeW * largeH);
    for (let i = 0; i < largeBytes.length; i++) largeBytes[i] = i & 0xff;
    const large = await decodedVpxAlphaLuma(
      frame('I420', [...largeBytes], [{ offset: 0, stride: largeW }]),
      largeW,
      largeH,
    );
    expect(large).toEqual(largeBytes);
  });

  it('malformed: rejects missing luma, short storage, and negative offset', async () => {
    await expect(
      decodedVpxAlphaLuma(frame('I420', [1, 2, 3], []), 1, 1),
    ).rejects.toBeInstanceOf(MediaError);
    await expect(
      decodedVpxAlphaLuma(frame('I420', [1, 2], [{ offset: 0, stride: 1 }]), 2, 2),
    ).rejects.toBeInstanceOf(MediaError);
    await expect(
      decodedVpxAlphaLuma(frame('I420', [1, 2, 3], [{ offset: -1, stride: 1 }]), 1, 1),
    ).rejects.toBeInstanceOf(MediaError);
  });

  it('randomized: 20 fuzzed I420 layouts remain byte-exact vs reference row copy', async () => {
    let state = 0xabcd_1234;
    const next = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state & 0xff;
    };
    for (let t = 0; t < 20; t++) {
      const w = 2 + (next() % 16);
      const h = 2 + (next() % 16);
      const pad = next() % 5;
      const stride = w + pad;
      const storage = new Uint8Array(stride * h + 7);
      for (let i = 0; i < storage.length; i++) storage[i] = next();
      const offset = next() % 3;
      const padded = new Uint8Array(offset + storage.length + 2);
      padded.set(storage, offset);
      const expected = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        expected.set(padded.subarray(offset + y * stride, offset + y * stride + w), y * w);
      }
      const decoded = await decodedVpxAlphaLuma(
        frame('I420', [...padded], [{ offset, stride }]),
        w,
        h,
      );
      expect(decoded).toEqual(expected);
    }
  });
});
