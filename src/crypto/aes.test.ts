import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { aesCtr, hexToBytes } from './aes.ts';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('hexToBytes', () => {
  it('parses lowercase hex into bytes', () => {
    expect([...hexToBytes('00ff10')]).toEqual([0, 255, 16]);
    expect(hexToBytes('').length).toBe(0);
  });
  it('rejects odd-length and non-hex input', () => {
    expect(() => hexToBytes('abc')).toThrow(InputError);
    expect(() => hexToBytes('zz')).toThrow(InputError);
  });
});

describe('aesCtr — NIST SP 800-38A CTR-AES128 (F.5.1)', () => {
  const KEY = hexToBytes('2b7e151628aed2a6abf7158809cf4f3c');
  const COUNTER = hexToBytes('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff');
  const PLAIN = hexToBytes(
    '6bc1bee22e409f96e93d7e117393172a' +
      'ae2d8a571e03ac9c9eb76fac45af8e51' +
      '30c81c46a35ce411e5fbc1191a0a52ef' +
      'f69f2445df4f9b17ad2b417be66c3710',
  );
  const CIPHER = hexToBytes(
    '874d6191b620e3261bef6864990db6ce' +
      '9806f66b7970fdff8617187bb9fffdff' +
      '5ae4df3edbd5d35e5b4f09020db03eab' +
      '1e031dda2fbe03d1792170a0f3009cee',
  );

  it('encrypts the published plaintext to the published ciphertext (full 128-bit counter)', async () => {
    expect(hex(await aesCtr(KEY, COUNTER, PLAIN, 128))).toBe(hex(CIPHER));
  });

  it('is symmetric — the same transform decrypts the ciphertext back to plaintext', async () => {
    expect(hex(await aesCtr(KEY, COUNTER, CIPHER, 128))).toBe(hex(PLAIN));
  });

  it('does real work — output differs from input and depends on the key', async () => {
    const ct = await aesCtr(KEY, COUNTER, PLAIN, 128);
    expect(hex(ct)).not.toBe(hex(PLAIN));
    const wrongKey = hexToBytes('00000000000000000000000000000000');
    expect(hex(await aesCtr(wrongKey, COUNTER, PLAIN, 128))).not.toBe(hex(ct));
  });
});
