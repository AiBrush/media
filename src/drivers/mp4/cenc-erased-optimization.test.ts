import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { assertNotErasedProtection } from './cenc.ts';

/** Naive reference implementation (per-byte loop) for property comparison. */
function naiveAssert(data: Uint8Array): void {
  let zeroRun = 0;
  for (const b of data) {
    zeroRun = b === 0 ? zeroRun + 1 : 0;
    if (zeroRun >= 16) throw new MediaError('demux-error', 'zero run');
  }
}

describe('cenc assertNotErasedProtection — fast indexOf optimization', () => {
  // 1. unit: exact 16-zero run throws, regardless of position
  it('unit: detects 16 consecutive zeros at start/middle/end', () => {
    const a = new Uint8Array(32);
    a.fill(1);
    a.fill(0, 0, 16);
    expect(() => assertNotErasedProtection(a)).toThrow(MediaError);
    const b = new Uint8Array(32);
    b.fill(1);
    b.fill(0, 8, 24);
    expect(() => assertNotErasedProtection(b)).toThrow(MediaError);
    const c = new Uint8Array(32);
    c.fill(1);
    c.fill(0, 16, 32);
    expect(() => assertNotErasedProtection(c)).toThrow(MediaError);
    const d = new Uint8Array(32);
    d.fill(1);
    expect(() => assertNotErasedProtection(d)).not.toThrow();
  });

  // 2. property: equivalence to naive reference for arbitrary byte sequences
  it('property: fast path agrees with naive per-byte loop', () => {
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array(15).fill(0),
      new Uint8Array(16).fill(0),
      new Uint8Array([1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
      Uint8Array.from({ length: 100 }, (_, i) => (i * 7) & 0xff),
      Uint8Array.from({ length: 256 }, (_, i) => i & 0xff),
    ];
    for (const data of cases) {
      let naiveThrows = false;
      try {
        naiveAssert(data);
      } catch {
        naiveThrows = true;
      }
      let fastThrows = false;
      try {
        assertNotErasedProtection(data);
      } catch {
        fastThrows = true;
      }
      expect(fastThrows, `mismatch for len ${data.length}`).toBe(naiveThrows);
    }
  });

  // 3. boundary: 15 zeros pass, 16 fail; short buffers never fail
  it('boundary: 15 vs 16 zeros and short-buffer limits', () => {
    const fifteen = new Uint8Array(15).fill(0);
    expect(() => assertNotErasedProtection(fifteen)).not.toThrow();
    const sixteen = new Uint8Array(16).fill(0);
    expect(() => assertNotErasedProtection(sixteen)).toThrow(MediaError);
    const fifteenPadded = new Uint8Array(32);
    fifteenPadded.fill(1);
    fifteenPadded.fill(0, 10, 25); // 15 zeros
    expect(() => assertNotErasedProtection(fifteenPadded)).not.toThrow();
    const sixteenPadded = new Uint8Array(32);
    sixteenPadded.fill(1);
    sixteenPadded.fill(0, 10, 26); // 16 zeros
    expect(() => assertNotErasedProtection(sixteenPadded)).toThrow(MediaError);
    expect(() => assertNotErasedProtection(new Uint8Array(0))).not.toThrow();
    expect(() => assertNotErasedProtection(new Uint8Array(1).fill(0))).not.toThrow();
  });

  // 4. malformed: fragmented zero runs that would fool overlapping-window skipping
  it('malformed: correctly handles sparse and overlapping zero patterns', () => {
    // Pattern: 2 zeros, 1 non-zero, repeated - should never be 16 consecutive
    const sparse = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sparse[i] = i % 3 < 2 ? 0 : 1;
    expect(() => assertNotErasedProtection(sparse)).not.toThrow();
    // Pattern with 15 zeros, 1 one, 15 zeros -> no 16 run
    const gap15 = new Uint8Array(31);
    gap15.fill(0, 0, 15);
    gap15[15] = 1;
    gap15.fill(0, 16, 31);
    expect(() => assertNotErasedProtection(gap15)).not.toThrow();
    // But 16 zeros after gap does fail
    const gap16 = new Uint8Array(32);
    gap16.fill(0, 0, 16);
    gap16[16] = 1;
    gap16.fill(0, 17, 32); // first 16 still at start -> should throw regardless of later
    expect(() => assertNotErasedProtection(gap16)).toThrow(MediaError);
    // Two separate zero runs of length 8 each, with 8 non-zero gap -> no throw
    const twoEights = new Uint8Array(24);
    twoEights.fill(1);
    twoEights.fill(0, 0, 8);
    twoEights.fill(0, 16, 24);
    expect(() => assertNotErasedProtection(twoEights)).not.toThrow();
  });

  // 5. randomized: 200 random buffers, fast vs naive equivalence
  it('randomized: 200 random buffers equivalence and no fixture data', () => {
    for (let trial = 0; trial < 200; trial++) {
      const len = Math.floor(Math.random() * 256);
      const data = new Uint8Array(len);
      for (let i = 0; i < len; i++) data[i] = Math.floor(Math.random() * 256);
      // Occasionally inject a forced 16-zero run to test positive case
      if (trial % 20 === 0 && len >= 32) {
        const at = Math.floor(Math.random() * (len - 16));
        data.fill(0, at, at + 16);
      }
      let naiveThrows = false;
      try {
        naiveAssert(data);
      } catch {
        naiveThrows = true;
      }
      let fastThrows = false;
      try {
        assertNotErasedProtection(data);
      } catch {
        fastThrows = true;
      }
      expect(fastThrows).toBe(naiveThrows);
    }
  });
});
