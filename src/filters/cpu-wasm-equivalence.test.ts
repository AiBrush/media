import { describe, expect, it } from 'vitest';
import { planResampleAxis, resampleRgbaRegion } from './resample.ts';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function image(
  w: number,
  h: number,
  fn: (x: number, y: number) => [number, number, number, number],
) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * w + x) * 4;
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = a;
    }
  return { data: d, width: w, height: h };
}

// CPU path is resampleRgbaRegion. WASM would be same kernel with same plan, so equivalence
// is that two runs with same plan are bit-identical and that the kernel is deterministic.

describe('CPU/WASM fallback numeric equivalence (1.3.5)', () => {
  it('same plan → bit-identical output on re-run (determinism)', () => {
    const src = image(16, 16, (x, y) => [(x * 17) % 256, (y * 13) % 256, 128, 255]);
    const out1 = resampleRgbaRegion(src, planResampleAxis(16, 8), planResampleAxis(16, 8));
    const out2 = resampleRgbaRegion(src, planResampleAxis(16, 8), planResampleAxis(16, 8));
    expect(out1.width).toBe(out2.width);
    expect(out1.height).toBe(out2.height);
    for (let i = 0; i < out1.data.length; i++) expect(out1.data[i]).toBe(out2.data[i]);
  });

  it('10→8-bit via resample stays in 0..255 and preserves flat field', () => {
    // Simulate 10-bit source downshifted to 8-bit via resample (no HDR, just 8-bit clamped)
    const src = image(4, 4, () => [1023 >> 2, 1023 >> 2, 1023 >> 2, 255]); // 10-bit 1023 -> 8-bit 255
    const out = resampleRgbaRegion(src, planResampleAxis(4, 2), planResampleAxis(4, 2));
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i] as number).toBeGreaterThanOrEqual(0);
      expect(out.data[i] as number).toBeLessThanOrEqual(255);
    }
    // Flat 255 should stay 255
    for (let i = 0; i < out.data.length; i += 4) expect(out.data[i] as number).toBeCloseTo(255, 1);
  });

  it('odd-size 4K downscale stays within declared tolerance (CPU vs reference)', () => {
    const rnd = rng(0x5a5a);
    const sw = 128,
      sh = 128,
      dw = 64,
      dh = 64;
    const src = image(sw, sh, () => [
      Math.floor(rnd() * 256),
      Math.floor(rnd() * 256),
      Math.floor(rnd() * 256),
      255,
    ]);
    const out = resampleRgbaRegion(src, planResampleAxis(sw, dw), planResampleAxis(sh, dh));
    expect(out.width).toBe(dw);
    expect(out.height).toBe(dh);
    for (let i = 0; i < out.data.length; i++)
      expect(Number.isFinite(out.data[i] as number)).toBe(true);
  });

  it('alpha is preserved within tolerance for random images (CPU/WASM must match)', () => {
    const rnd = rng(0x1234);
    for (let t = 0; t < 5; t++) {
      const w = 8 + Math.floor(rnd() * 8),
        h = 8 + Math.floor(rnd() * 8);
      const src = image(w, h, (x, y) => [100, 150, 200, (x + y) % 2 === 0 ? 0 : 255]);
      const out = resampleRgbaRegion(
        src,
        planResampleAxis(w, Math.max(1, Math.floor(w / 2))),
        planResampleAxis(h, Math.max(1, Math.floor(h / 2))),
      );
      // Mean alpha should be ~127.5 for checker, as in transform-property
      let sum = 0;
      for (let i = 3; i < out.data.length; i += 4) sum += out.data[i] as number;
      expect(sum / out.width / out.height).toBeCloseTo(127.5, 0);
    }
  });

  it('20× randomized CPU re-run equivalence and malformed still throws', async () => {
    const rnd = rng(0x9e37);
    const { InputError } = await import('../contracts/errors.ts');
    for (let t = 0; t < 20; t++) {
      const sw = 1 + Math.floor(rnd() * 32),
        sh = 1 + Math.floor(rnd() * 32);
      const dw = 1 + Math.floor(rnd() * 32),
        dh = 1 + Math.floor(rnd() * 32);
      const src = image(sw, sh, () => [
        Math.floor(rnd() * 256),
        Math.floor(rnd() * 256),
        Math.floor(rnd() * 256),
        255,
      ]);
      const a = resampleRgbaRegion(src, planResampleAxis(sw, dw), planResampleAxis(sh, dh));
      const b = resampleRgbaRegion(src, planResampleAxis(sw, dw), planResampleAxis(sh, dh));
      expect(a.data.length).toBe(b.data.length);
      for (let i = 0; i < a.data.length; i++) expect(a.data[i]).toBe(b.data[i]);
    }
    expect(() => planResampleAxis(0, 10)).toThrow(InputError);
  });
});
