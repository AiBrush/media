/**
 * Node-side validation for the shared band-limited resampler. The substrates' live renders happen in the
 * browser harness, so here we test the **pure kernel and weight plan** — the part every substrate shares.
 *
 * The load-bearing properties are structural rather than golden-pixel:
 *   • partition of unity (weights sum to 1) — otherwise flat fields shift and borders darken;
 *   • the support actually widens with the reduction factor — that is the whole point of the change;
 *   • band-limiting is measurable — a Nyquist grating must collapse, and a swept sinusoid's stopband
 *     must be attenuated while its passband survives;
 *   • 1:1 is an exact passthrough and magnification stays on the tent kernel (no ringing introduced);
 *   • malformed geometry is rejected with `InputError`, never with wrong pixels or an unbounded loop.
 */

import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { catmullRom, planResampleAxis, resampleRgbaRegion } from './resample.ts';

// ---- helpers ----

/** A deterministic LCG so the randomized properties reproduce exactly on failure. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Build a greyscale RGBA image from a per-pixel luma function. */
function image(
  width: number,
  height: number,
  luma: (x: number, y: number) => number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = luma(x, y);
      const o = (y * width + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Peak-to-peak spread of the red channel — 0 means the reducer flattened the pattern. */
function spread(out: { data: Float32Array }): number {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < out.data.length; i += 4) {
    const v = out.data[i] ?? 0;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return max - min;
}

/** Reduce `src` to `w`×`h` through the real plan+resample path. */
function reduce(
  src: { data: Uint8ClampedArray; width: number; height: number },
  w: number,
  h: number,
): { data: Float32Array; width: number; height: number } {
  return resampleRgbaRegion(src, planResampleAxis(src.width, w), planResampleAxis(src.height, h));
}

// ---- kernel ----

describe('catmullRom', () => {
  it('is interpolating: 1 at the origin, 0 at every other integer node', () => {
    expect(catmullRom(0)).toBeCloseTo(1, 12);
    for (const t of [1, 2, 3, -1, -2, -3]) expect(catmullRom(t)).toBeCloseTo(0, 12);
  });

  it('is symmetric and compactly supported on [-2, 2]', () => {
    for (const t of [0.1, 0.5, 0.9, 1.3, 1.7, 1.99]) {
      expect(catmullRom(t)).toBeCloseTo(catmullRom(-t), 12);
    }
    for (const t of [2, 2.5, 7, -2, -9]) expect(catmullRom(t)).toBe(0);
  });

  it('has the negative lobes that hold the passband up (the reason it beats a box)', () => {
    expect(catmullRom(1.5)).toBeLessThan(0);
    expect(catmullRom(0.5)).toBeGreaterThan(0);
  });

  it('reproduces a linear ramp exactly (a 1st-order-accurate kernel)', () => {
    // Sum over integer taps of k(t - i) * (a + b*i) must equal a + b*t.
    for (const t of [0, 0.25, 0.5, 0.75]) {
      let sum = 0;
      for (let i = -3; i <= 4; i++) sum += catmullRom(t - i) * (10 + 3 * i);
      expect(sum).toBeCloseTo(10 + 3 * t, 10);
    }
  });
});

// ---- weight plan ----

describe('planResampleAxis', () => {
  it('produces a partition of unity for every destination pixel, at any ratio', () => {
    for (const [srcLen, dstLen] of [
      [960, 320],
      [1920, 180],
      [100, 100],
      [64, 256],
      [7, 3],
      [3, 7],
      [1, 1],
      [1, 32],
      [4096, 1],
    ] as const) {
      const plan = planResampleAxis(srcLen, dstLen);
      expect(plan.weights).toHaveLength(dstLen);
      for (const taps of plan.weights) {
        const sum = taps.reduce((acc, t) => acc + t.weight, 0);
        expect(sum).toBeCloseTo(1, 9);
        for (const tap of taps) {
          expect(Number.isSafeInteger(tap.index)).toBe(true);
          expect(tap.index).toBeGreaterThanOrEqual(0);
          expect(tap.index).toBeLessThan(srcLen);
          expect(Number.isFinite(tap.weight)).toBe(true);
        }
      }
    }
  });

  it('widens the support with the reduction factor — the core of the fix', () => {
    const supports = [1, 2, 3, 4, 8].map((n) => planResampleAxis(960, 960 / n).support);
    expect(supports).toEqual([1, 4, 6, 8, 16]);
    // Strictly increasing: more reduction always integrates a wider footprint.
    const sorted = [...supports].sort((a, b) => a - b);
    expect(supports).toEqual(sorted);
    expect(new Set(supports).size).toBe(supports.length);
  });

  it('keeps magnification and 1:1 on the tent kernel (no widening, no ringing)', () => {
    for (const dstLen of [100, 200, 1000]) {
      const plan = planResampleAxis(100, dstLen);
      expect(plan.support).toBe(1);
      for (const taps of plan.weights) {
        expect(taps.length).toBeLessThanOrEqual(2);
        for (const tap of taps) expect(tap.weight).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is an exact passthrough at 1:1', () => {
    const plan = planResampleAxis(16, 16);
    plan.weights.forEach((taps, d) => {
      expect(taps).toHaveLength(1);
      expect(taps[0]?.index).toBe(d);
      expect(taps[0]?.weight ?? 0).toBeCloseTo(1, 12);
    });
  });

  it('honours a source sub-rect (crop-and-scale in one pass)', () => {
    const plan = planResampleAxis(100, 10, 40, 20);
    expect(plan.scale).toBeCloseTo(2, 12);
    // Every tap must fall inside (or clamp to) the selected [40, 60) window, widened by the support.
    for (const taps of plan.weights) {
      for (const tap of taps) {
        expect(tap.index).toBeGreaterThanOrEqual(36);
        expect(tap.index).toBeLessThanOrEqual(64);
      }
    }
  });

  it('bounds the tap count even at absurd reduction ratios', () => {
    const plan = planResampleAxis(1_000_000, 1);
    expect(plan.maxTaps).toBeLessThanOrEqual(256);
    expect((plan.weights[0] ?? []).reduce((a, t) => a + t.weight, 0)).toBeCloseTo(1, 9);
  });

  it('rejects malformed geometry with InputError rather than looping or emitting junk', () => {
    expect(() => planResampleAxis(0, 10)).toThrow(InputError);
    expect(() => planResampleAxis(-4, 10)).toThrow(InputError);
    expect(() => planResampleAxis(10.5, 10)).toThrow(InputError);
    expect(() => planResampleAxis(10, 0)).toThrow(InputError);
    expect(() => planResampleAxis(10, -1)).toThrow(InputError);
    expect(() => planResampleAxis(10, 2.5)).toThrow(InputError);
    expect(() => planResampleAxis(10, 5, 0, 0)).toThrow(InputError);
    expect(() => planResampleAxis(10, 5, 0, -3)).toThrow(InputError);
    expect(() => planResampleAxis(10, 5, Number.NaN)).toThrow(InputError);
    expect(() => planResampleAxis(10, 5, 0, Number.POSITIVE_INFINITY)).toThrow(InputError);
  });

  it('never emits an out-of-range index for randomized geometry', () => {
    const next = rng(0x5eed);
    for (let trial = 0; trial < 120; trial++) {
      const srcLen = 1 + Math.floor(next() * 512);
      const dstLen = 1 + Math.floor(next() * 512);
      const plan = planResampleAxis(srcLen, dstLen);
      expect(plan.weights).toHaveLength(dstLen);
      for (const taps of plan.weights) {
        expect(taps.length).toBeGreaterThan(0);
        expect(taps.reduce((a, t) => a + t.weight, 0)).toBeCloseTo(1, 9);
        for (const tap of taps) {
          expect(tap.index).toBeGreaterThanOrEqual(0);
          expect(tap.index).toBeLessThan(srcLen);
        }
      }
    }
  });
});

// ---- resample: the properties that make it a correct reducer ----

describe('resampleRgbaRegion', () => {
  it('preserves a constant field exactly (partition of unity, end to end)', () => {
    const src = image(97, 61, () => 137);
    const out = reduce(src, 31, 17);
    for (let i = 0; i < out.data.length; i += 4) expect(out.data[i]).toBeCloseTo(137, 4);
  });

  it('band-limits: a 1px Nyquist grating collapses to flat when reduced', () => {
    const src = image(240, 240, (x, y) => ((x + y) % 2 === 0 ? 228 : 28));
    expect(spread(reduce(src, 240, 240))).toBeGreaterThan(150); // 1:1 keeps it
    for (const n of [3, 4, 6, 8]) {
      // Any real reduction must leave essentially nothing of a signal at the source Nyquist.
      expect(spread(reduce(src, 240 / n, 240 / n))).toBeLessThan(12);
    }
  });

  it('attenuates the stopband while keeping the passband — swept-sinusoid response', () => {
    // Reduce 4:1, so the destination Nyquist sits at f = 0.125 cycles/source-pixel.
    const reduction = 4;
    const amplitudeAt = (f: number): number => {
      const src = image(512, 8, (x) => 128 + 100 * Math.sin(2 * Math.PI * f * x));
      const out = reduce(src, 512 / reduction, 8);
      const row = 4;
      let sum = 0;
      for (let x = 0; x < out.width; x++) sum += out.data[(row * out.width + x) * 4] ?? 0;
      const mean = sum / out.width;
      let acc = 0;
      for (let x = 0; x < out.width; x++) {
        const d = (out.data[(row * out.width + x) * 4] ?? 0) - mean;
        acc += d * d;
      }
      return Math.sqrt(acc / out.width) * Math.SQRT2;
    };
    // Well inside the passband: the signal must survive largely intact.
    expect(amplitudeAt(0.02)).toBeGreaterThan(80);
    // Well inside the stopband: this is the energy that would otherwise alias.
    for (const f of [0.25, 0.33, 0.42]) expect(amplitudeAt(f)).toBeLessThan(20);
  });

  it('leaves a 1:1 region bit-identical', () => {
    const next = rng(99);
    const src = image(40, 24, () => Math.floor(next() * 256));
    const out = reduce(src, 40, 24);
    for (let i = 0; i < src.data.length; i += 4) {
      expect(out.data[i]).toBeCloseTo(src.data[i] ?? 0, 4);
    }
  });

  it('reproduces a linear ramp under reduction (no shift, no bias)', () => {
    // A linear ramp is in the kernel's reproduction class, so the reduced ramp must stay linear and
    // centred — this catches half-pixel offset errors that a visual check would miss.
    const src = image(256, 4, (x) => 20 + (x * 200) / 255);
    const out = reduce(src, 64, 4);
    for (let x = 1; x < out.width - 1; x++) {
      const expected = 20 + ((x + 0.5) * 4 - 0.5) * (200 / 255);
      expect(out.data[x * 4]).toBeCloseTo(expected, 0);
    }
  });

  it('stays within the input range for randomized content (overshoot is bounded and clamped later)', () => {
    const next = rng(0xc0ffee);
    for (let trial = 0; trial < 16; trial++) {
      const w = 8 + Math.floor(next() * 120);
      const h = 8 + Math.floor(next() * 120);
      const src = image(w, h, () => Math.floor(next() * 256));
      const dw = 1 + Math.floor(next() * w);
      const dh = 1 + Math.floor(next() * h);
      const out = reduce(src, dw, dh);
      expect(out.width).toBe(dw);
      expect(out.height).toBe(dh);
      for (let i = 0; i < out.data.length; i++) {
        const v = out.data[i] ?? Number.NaN;
        expect(Number.isFinite(v)).toBe(true);
        // Catmull-Rom can overshoot; a sane bound proves it is ringing, not diverging.
        expect(v).toBeGreaterThan(-64);
        expect(v).toBeLessThan(320);
      }
    }
  });

  it('filters each channel independently', () => {
    const width = 64;
    const data = new Uint8ClampedArray(width * 4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        data[o] = 200;
        data[o + 1] = 100;
        data[o + 2] = x % 2 === 0 ? 255 : 0; // only blue carries the grating
        data[o + 3] = 255;
      }
    }
    const out = reduce({ data, width, height: 4 }, 16, 4);
    let blueMin = Number.POSITIVE_INFINITY;
    let blueMax = Number.NEGATIVE_INFINITY;
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const o = (y * out.width + x) * 4;
        // The flat channels are untouched by blue's grating — that is the independence claim.
        expect(out.data[o]).toBeCloseTo(200, 3);
        expect(out.data[o + 1]).toBeCloseTo(100, 3);
        expect(out.data[o + 3]).toBeCloseTo(255, 3);
        // Interior only: at the borders clamp-to-edge repeats a texel, which legitimately shifts the
        // local average away from the interior's value.
        if (x >= 2 && x < out.width - 2) {
          blueMin = Math.min(blueMin, out.data[o + 2] ?? 0);
          blueMax = Math.max(blueMax, out.data[o + 2] ?? 0);
        }
      }
    }
    // Across the interior the grating is gone as *structure* — every output pixel identical. A fixed
    // residual offset from the 127.5 mean remains: this reduction is exactly 4:1, so every destination
    // pixel samples the same kernel phase and the kernel's residual stopband response appears as a DC
    // bias rather than as ripple. Catmull-Rom leaves ≲10% of the 255 amplitude here, against the ~88%
    // that the single bilinear tap this replaced passed straight through.
    expect(blueMax - blueMin).toBeCloseTo(0, 3);
    expect(Math.abs(blueMax - 127.5)).toBeLessThan(0.1 * 255);
  });
});
