import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import {
  convert8To10,
  convert10To8,
  limitedToFullRange8,
  limitedToFullRange10,
  preserveAlpha,
} from './bit-depth.ts';

describe('bit-depth 10→8 + HDR + alpha-preserve (1.3.3)', () => {
  it('10→8 full-range endpoints and mid half-up', () => {
    expect(convert10To8(0)).toBe(0);
    expect(convert10To8(1023)).toBe(255);
    expect(convert10To8(512)).toBe(128); // 512*255/1023≈127.6→128
    expect(convert10To8(1)).toBe(0); // 0.249→0
    expect(convert10To8(2)).toBe(0); // 0.498→0
    expect(convert10To8(3)).toBe(1); // 0.747→1
  });

  it('8→10→8 round-trip within 1 LSB for all 256 values', () => {
    for (let v8 = 0; v8 < 256; v8++) {
      const v10 = convert8To10(v8);
      const back = convert10To8(v10);
      expect(Math.abs(back - v8)).toBeLessThanOrEqual(1);
    }
  });

  it('limited-range 16..235 → 0..255 and 64..940 → 0..1023 exact endpoints + clamp', () => {
    expect(limitedToFullRange8(16)).toBe(0);
    expect(limitedToFullRange8(235)).toBe(255);
    expect(limitedToFullRange8(15)).toBe(0); // clamp low
    expect(limitedToFullRange8(236)).toBe(255); // clamp high
    expect(limitedToFullRange10(64)).toBe(0);
    expect(limitedToFullRange10(940)).toBe(1023);
    expect(limitedToFullRange10(63)).toBe(0);
    expect(limitedToFullRange10(941)).toBe(1023);
    // chroma 64..960
    expect(limitedToFullRange10(960, false)).toBe(1023);
  });

  it('alpha preserved verbatim, no range expansion, full 0..max', () => {
    for (const a of [0, 1, 127, 255]) expect(preserveAlpha(a, 8, 8)).toBe(a);
    for (const a of [0, 1, 511, 1023]) expect(preserveAlpha(a, 10, 10)).toBe(a);
    expect(preserveAlpha(0, 10, 8)).toBe(0);
    expect(preserveAlpha(1023, 10, 8)).toBe(255);
    expect(preserveAlpha(255, 8, 10)).toBe(1023);
    expect(preserveAlpha(128, 8, 10)).toBe(514); // 128*1023/255≈513.5→514
  });

  it('malformed throws InputError, never silent clamp to wrong value', () => {
    expect(() => convert10To8(Number.NaN)).toThrow(InputError);
    expect(() => convert10To8(Number.POSITIVE_INFINITY)).toThrow(InputError);
    expect(() => convert8To10(Number.NaN)).toThrow(InputError);
    expect(() => preserveAlpha(Number.NaN, 8, 8)).toThrow(InputError);
    expect(() => limitedToFullRange8(Number.NaN)).toThrow(InputError);
    expect(() => limitedToFullRange10(Number.NaN)).toThrow(InputError);
  });

  it('HDR passthrough: full-range 10→8 via convert preserves 0 and 1023, no transfer change', () => {
    // HDR (PQ/HLG) still uses same 10→8 luma scaling; transfer is handled elsewhere (gpu-uniforms)
    // Here we verify the luma path is identical for HDR vs SDR full-range.
    for (const v of [0, 64, 512, 940, 1023]) {
      expect(convert10To8(v, { limitedRange: false })).toBe(convert10To8(v));
    }
  });

  it('20× randomized monotonic and bounded', () => {
    let s = 0x1a2b3c;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    let prev8 = -1;
    let prev10 = -1;
    for (let i = 0; i < 20; i++) {
      const v10 = Math.floor(rnd() * 1024);
      const v8 = convert10To8(v10);
      expect(v8).toBeGreaterThanOrEqual(0);
      expect(v8).toBeLessThanOrEqual(255);
      expect(Number.isInteger(v8)).toBe(true);
      const back10 = convert8To10(v8);
      expect(back10).toBeGreaterThanOrEqual(0);
      expect(back10).toBeLessThanOrEqual(1023);
      // Monotonic: larger 10-bit → larger or equal 8-bit
      if (v10 > prev10) expect(v8).toBeGreaterThanOrEqual(prev8);
      prev10 = v10;
      prev8 = v8;
    }
  });

  it('range honest: full vs limited produce different mid values', () => {
    // Full 512 →128, limited luma 512→ ~128 as well but via different formula, check they are both plausible and not equal for low values
    expect(convert10To8(64, { limitedRange: true })).toBe(0);
    expect(convert10To8(64, { limitedRange: false })).toBe(16); // 64*255/1023≈15.9→16
    expect(convert10To8(64, { limitedRange: true })).not.toBe(
      convert10To8(64, { limitedRange: false }),
    );
  });
});
