import { describe, expect, it } from 'vitest';
import { digestsEqual, sha256Hex, toHex } from './digest.ts';

describe('digest helpers', () => {
  it('computes the SHA-256 of a known vector ("abc")', async () => {
    const hex = await sha256Hex(new TextEncoder().encode('abc'));
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('computes the SHA-256 of the empty input', async () => {
    const hex = await sha256Hex(new Uint8Array(0));
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('toHex zero-pads each byte', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });

  it('digestsEqual is case-insensitive and length-aware', () => {
    expect(digestsEqual('ab', 'AB')).toBe(true);
    expect(digestsEqual('ab', 'abc')).toBe(false);
    expect(digestsEqual('ab', 'cd')).toBe(false);
  });
});
