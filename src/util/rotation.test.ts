import { describe, expect, it } from 'vitest';
import {
  composeClockwiseRotations,
  isIdentityRotation,
  normalizeClockwiseRotation,
  resolveMuxRotation,
} from './rotation.ts';

describe('rotation — physical vs logical never double-applied (REQUIREMENTS §5.4 1.3.4)', () => {
  it('normalize canonicalizes quarter-turns and treats tiny epsilon as identity', () => {
    expect(normalizeClockwiseRotation(0)).toBe(0);
    expect(normalizeClockwiseRotation(360)).toBe(0);
    expect(normalizeClockwiseRotation(90)).toBe(90);
    expect(normalizeClockwiseRotation(-90)).toBe(270);
    expect(normalizeClockwiseRotation(450)).toBe(90);
    expect(normalizeClockwiseRotation(1e-11)).toBe(0);
    expect(normalizeClockwiseRotation(undefined)).toBeUndefined();
    expect(normalizeClockwiseRotation(Number.NaN)).toBeUndefined();
    expect(normalizeClockwiseRotation(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('compose sums quarter-turns modulo 360, identity→undefined', () => {
    expect(composeClockwiseRotations(undefined, undefined)).toBeUndefined();
    expect(composeClockwiseRotations(0, 0)).toBeUndefined();
    expect(composeClockwiseRotations(90, 0)).toBe(90);
    expect(composeClockwiseRotations(90, 90)).toBe(180);
    expect(composeClockwiseRotations(90, 90, 90)).toBe(270);
    expect(composeClockwiseRotations(90, 270)).toBeUndefined(); // 360→0
    expect(composeClockwiseRotations(180, 180)).toBeUndefined();
    expect(composeClockwiseRotations(270, 180)).toBe(90); // 450→90
    expect(composeClockwiseRotations(90, undefined, 180)).toBe(270);
  });

  it('compose rejects non-quarter-turn', () => {
    expect(() => composeClockwiseRotations(45 as never)).toThrow(RangeError);
    expect(() => composeClockwiseRotations(30 as never)).toThrow(RangeError);
  });

  it('isIdentityRotation distinguishes 0/undefined/NaN vs real rotation', () => {
    expect(isIdentityRotation(undefined)).toBe(true);
    expect(isIdentityRotation(0)).toBe(true);
    expect(isIdentityRotation(360)).toBe(true);
    expect(isIdentityRotation(90)).toBe(false);
    expect(isIdentityRotation(180)).toBe(false);
    expect(isIdentityRotation(Number.NaN)).toBe(true);
  });

  it('resolveMuxRotation: decoded presentation-oriented frames must not preserve source metadata', () => {
    // Source 90 already baked into pixels; mux must not write 90 again
    expect(
      resolveMuxRotation({
        sourceRotation: 90,
        decodedFramesArePresentationOriented: true,
        targetRotation: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolveMuxRotation({
        sourceRotation: 90,
        decodedFramesArePresentationOriented: true,
        targetRotation: 0,
      }),
    ).toBeUndefined();
    // User explicitly wants 90 on top of already-baked 90 source: mux writes only 90, not 180, because 90 already in pixels
    expect(
      resolveMuxRotation({
        sourceRotation: 90,
        decodedFramesArePresentationOriented: true,
        targetRotation: 90,
      }),
    ).toBe(90);
    // No source, user wants 180
    expect(
      resolveMuxRotation({
        sourceRotation: undefined,
        decodedFramesArePresentationOriented: true,
        targetRotation: 180,
      }),
    ).toBe(180);
    // Source 0, no decode, no target → undefined
    expect(
      resolveMuxRotation({
        sourceRotation: 0,
        decodedFramesArePresentationOriented: true,
        targetRotation: undefined,
      }),
    ).toBeUndefined();
  });

  it('resolveMuxRotation: stream-copy preserves composed source+target logically', () => {
    expect(
      resolveMuxRotation({
        sourceRotation: 90,
        decodedFramesArePresentationOriented: false,
        targetRotation: undefined,
      }),
    ).toBe(90);
    expect(
      resolveMuxRotation({
        sourceRotation: 90,
        decodedFramesArePresentationOriented: false,
        targetRotation: 90,
      }),
    ).toBe(180);
    expect(
      resolveMuxRotation({
        sourceRotation: 90,
        decodedFramesArePresentationOriented: false,
        targetRotation: 270,
      }),
    ).toBeUndefined(); // 360
    expect(
      resolveMuxRotation({
        sourceRotation: undefined,
        decodedFramesArePresentationOriented: false,
        targetRotation: 270,
      }),
    ).toBe(270);
    expect(
      resolveMuxRotation({
        sourceRotation: undefined,
        decodedFramesArePresentationOriented: false,
        targetRotation: undefined,
      }),
    ).toBeUndefined();
  });

  it('20× randomized composition is associative and matches naive sum', () => {
    for (let seed = 0; seed < 20; seed++) {
      const a = [0, 90, 180, 270][seed % 4] as number;
      const b = [0, 90, 180, 270][(seed * 3) % 4] as number;
      const c = [0, 90, 180, 270][(seed * 7) % 4] as number;
      const composed = composeClockwiseRotations(a, b, c);
      const naive = normalizeClockwiseRotation((a + b + c) % 360);
      const expected = naive === 0 ? undefined : naive;
      expect(composed).toBe(expected);
      // physical vs logical invariant: if decodedFramesArePresentationOriented, source must not be preserved
      const mux = resolveMuxRotation({
        sourceRotation: a,
        decodedFramesArePresentationOriented: true,
        targetRotation: b,
      });
      expect(mux).toBe(b === 0 ? undefined : normalizeClockwiseRotation(b));
    }
  });

  it('boundary: 4×90 returns to identity, 1×360 also', () => {
    expect(composeClockwiseRotations(90, 90, 90, 90)).toBeUndefined();
    expect(composeClockwiseRotations(360)).toBeUndefined();
    expect(composeClockwiseRotations(720, 90)).toBe(90);
  });

  it('malformed: non-finite inputs are treated as undefined (no throw except non-quarter-turn)', () => {
    expect(composeClockwiseRotations(Number.NaN, 90)).toBe(90);
    expect(composeClockwiseRotations(Number.POSITIVE_INFINITY as unknown as number, 90)).toBe(90);
    expect(composeClockwiseRotations(undefined, 90)).toBe(90);
  });
});
