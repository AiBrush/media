import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InputError, MediaError } from '../../contracts/errors.ts';
import { fixturesByContainer, loadFixture } from '../../test-support/corpus.ts';
import { at, chan, decodeFlac, decorrelate, interleavedPcmBytes } from './decode.ts';

const md5 = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const flacs = await fixturesByContainer('flac');

describe('FLAC decode — bit-exact on the real corpus (STREAMINFO MD5, the flac --test oracle)', () => {
  it('validates against ≥5 diverse real FLAC files (§6.1)', () => {
    expect(flacs.length).toBeGreaterThanOrEqual(5);
  });

  // Each file's STREAMINFO carries the MD5 of its original PCM; a correct decode reproduces it. This is
  // the codec's own integrity gate — content-agnostic and impossible to fake. The set spans mono/stereo,
  // 8/12/16-bit, wasted bits, escaped Rice partitions, LPC, all FIXED orders, and VERBATIM subframes.
  for (const entry of flacs) {
    it(`${entry.id}: decoded PCM MD5 matches the embedded STREAMINFO digest`, async () => {
      const decoded = decodeFlac(await loadFixture(entry.id));
      expect(decoded.totalSamples).toBeGreaterThan(0);
      expect(hex(decoded.md5)).not.toBe('0'.repeat(32)); // a real digest, not an unset placeholder
      expect(md5(interleavedPcmBytes(decoded))).toBe(hex(decoded.md5));
    });
  }

  it('rejects a non-FLAC stream with a typed error', () => {
    expect(() => decodeFlac(new Uint8Array(64))).toThrow(InputError);
  });

  it('decodes a FLAC carrying an ID3v2 prefix (skips the tag)', async () => {
    const flac = await loadFixture('sfx.flac');
    const id3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0]); // ID3 + 5-byte tag
    const decoded = decodeFlac(new Uint8Array([...id3, ...flac]));
    expect(md5(interleavedPcmBytes(decoded))).toBe(hex(decoded.md5));
  });

  it('throws on lost frame sync (STREAMINFO claims samples, but no valid frames follow)', () => {
    const si = new Uint8Array(34);
    const dv = new DataView(si.buffer);
    dv.setUint32(10, ((48000 << 12) | ((16 - 1) << 4)) >>> 0); // 48 kHz, mono, 16-bit
    dv.setUint32(14, 64); // 64 samples claimed
    const flac = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, ...si]); // fLaC + last STREAMINFO
    expect(() => decodeFlac(flac)).toThrow(MediaError);
  });
});

describe('bounds-checked reads (at / chan)', () => {
  it('guard both arms', () => {
    const a = Int32Array.from([5, 9]);
    expect(at(a, 0)).toBe(5);
    expect(at(a, 7)).toBe(0); // out of range → 0
    expect(at([1, 2, 3], 1)).toBe(2);
    expect(chan([a], 0)).toBe(a);
    expect(chan([a], 4).length).toBe(0); // out of range → empty
  });
});

describe('decorrelate — stereo reconstruction (L/S, R/S, M/S)', () => {
  it('left/side (8): right = left - side', () => {
    const ch = [Int32Array.from([10, 20]), Int32Array.from([3, 5])]; // left, side
    decorrelate(ch, 8, 2);
    expect([...(ch[0] ?? [])]).toEqual([10, 20]); // left unchanged
    expect([...(ch[1] ?? [])]).toEqual([7, 15]); // right = left - side
  });
  it('right/side (9): left = right + side', () => {
    const ch = [Int32Array.from([3, 5]), Int32Array.from([10, 20])]; // side, right
    decorrelate(ch, 9, 2);
    expect([...(ch[0] ?? [])]).toEqual([13, 25]); // left = right + side
    expect([...(ch[1] ?? [])]).toEqual([10, 20]); // right unchanged
  });
  it('mid/side (10): reconstructs left/right from mid + side', () => {
    // left=12, right=8 → side=4, mid=(12+8)>>1=10. Decode should recover 12/8.
    decorrelateAndExpect([10], [4], [12], [8]);
  });
  it('handles an odd mid/side LSB correctly', () => {
    // left=13, right=8 → side=5, mid=(13+8)>>1=10 (LSB lost), restored via (mid<<1)|(side&1).
    decorrelateAndExpect([10], [5], [13], [8]);
  });
});

function decorrelateAndExpect(
  mid: number[],
  side: number[],
  left: number[],
  right: number[],
): void {
  const ch = [Int32Array.from(mid), Int32Array.from(side)];
  decorrelate(ch, 10, mid.length);
  expect([...(ch[0] ?? [])]).toEqual(left);
  expect([...(ch[1] ?? [])]).toEqual(right);
}
