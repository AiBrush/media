/**
 * AES-CBC core validation. The no-padding helper {@link aesCbcNoPadding} is gated on the published NIST
 * SP 800-38A CBC-AES128 vectors (F.2.1 Encrypt / F.2.2 Decrypt) — an EXTERNAL oracle, not a self
 * round-trip — proving the WebCrypto "no-padding via append/strip" framing is real AES, exact, and an
 * exact inverse. {@link aesCbcPkcs7} is checked for PKCS#7 round-trip + that it actually pads. Input
 * guards (block alignment, IV length) reject with a typed {@link InputError}.
 */

import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { aesCbcNoPadding, aesCbcPkcs7, hexToBytes } from './aes.ts';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// NIST SP 800-38A §F.2 — CBC-AES128 (key, IV, 4-block plaintext, F.2.1 ciphertext).
const KEY = hexToBytes('2b7e151628aed2a6abf7158809cf4f3c');
const IV = hexToBytes('000102030405060708090a0b0c0d0e0f');
const PLAIN = hexToBytes(
  '6bc1bee22e409f96e93d7e117393172a' +
    'ae2d8a571e03ac9c9eb76fac45af8e51' +
    '30c81c46a35ce411e5fbc1191a0a52ef' +
    'f69f2445df4f9b17ad2b417be66c3710',
);
const CIPHER = hexToBytes(
  '7649abac8119b246cee98e9b12e9197d' +
    '5086cb9b507219ee95db113a917678b2' +
    '73bed6b8e3c1743b7116e69e22229516' +
    '3ff1caa1681fac09120eca307586e1a7',
);

describe('aesCbcNoPadding — NIST SP 800-38A CBC-AES128 (F.2.1 / F.2.2)', () => {
  it('encrypts the published plaintext to the published ciphertext (no padding added)', async () => {
    const ct = await aesCbcNoPadding(KEY, IV, PLAIN, 'encrypt');
    expect(ct.byteLength).toBe(PLAIN.byteLength); // no PKCS#7 block appended
    expect(hex(ct)).toBe(hex(CIPHER));
  });

  it('decrypts the published ciphertext back to the published plaintext (no padding stripped)', async () => {
    const pt = await aesCbcNoPadding(KEY, IV, CIPHER, 'decrypt');
    expect(pt.byteLength).toBe(CIPHER.byteLength);
    expect(hex(pt)).toBe(hex(PLAIN));
  });

  it('is an exact inverse across many block counts, and the key matters', async () => {
    for (const blocks of [1, 2, 3, 5, 16]) {
      const data = Uint8Array.from({ length: blocks * 16 }, (_, i) => (i * 37 + 11) & 0xff);
      const ct = await aesCbcNoPadding(KEY, IV, data, 'encrypt');
      expect([...ct]).not.toEqual([...data]); // real encryption
      expect([...(await aesCbcNoPadding(KEY, IV, ct, 'decrypt'))]).toEqual([...data]);
    }
    const wrong = hexToBytes('00000000000000000000000000000000');
    const ct = await aesCbcNoPadding(KEY, IV, PLAIN, 'encrypt');
    expect([...(await aesCbcNoPadding(wrong, IV, ct, 'decrypt'))]).not.toEqual([...PLAIN]);
  });

  it('matches an independent node:crypto AES-128-CBC (no padding) encryption', async () => {
    const c = createCipheriv('aes-128-cbc', Buffer.from(KEY), Buffer.from(IV));
    c.setAutoPadding(false);
    const ref = Buffer.concat([c.update(Buffer.from(PLAIN)), c.final()]);
    expect(hex(await aesCbcNoPadding(KEY, IV, PLAIN, 'encrypt'))).toBe(ref.toString('hex'));
  });

  it('rejects non-block-aligned data and a wrong-length IV', async () => {
    await expect(aesCbcNoPadding(KEY, IV, new Uint8Array(17), 'decrypt')).rejects.toThrow(
      InputError,
    );
    await expect(aesCbcNoPadding(KEY, new Uint8Array(8), PLAIN, 'encrypt')).rejects.toThrow(
      InputError,
    );
  });

  it('treats empty input as empty output', async () => {
    expect((await aesCbcNoPadding(KEY, IV, new Uint8Array(0), 'decrypt')).byteLength).toBe(0);
  });
});

describe('aesCbcPkcs7 — native PKCS#7 CBC', () => {
  it('round-trips arbitrary-length data and actually pads to the next block', async () => {
    for (const len of [0, 1, 15, 16, 17, 100]) {
      const data = Uint8Array.from({ length: len }, (_, i) => (i * 13 + 7) & 0xff);
      const ct = await aesCbcPkcs7(KEY, IV, data, 'encrypt');
      expect(ct.byteLength % 16).toBe(0);
      expect(ct.byteLength).toBe(len + (16 - (len % 16))); // PKCS#7 always adds 1..16 bytes
      expect([...(await aesCbcPkcs7(KEY, IV, ct, 'decrypt'))]).toEqual([...data]);
    }
  });

  it('matches an independent node:crypto AES-128-CBC (PKCS#7) encryption', async () => {
    const data = Uint8Array.from({ length: 50 }, (_, i) => i & 0xff);
    const c = createCipheriv('aes-128-cbc', Buffer.from(KEY), Buffer.from(IV)); // PKCS#7 on by default
    const ref = Buffer.concat([c.update(Buffer.from(data)), c.final()]);
    expect(hex(await aesCbcPkcs7(KEY, IV, data, 'encrypt'))).toBe(ref.toString('hex'));
  });

  it('rejects a wrong-length IV with a typed InputError', async () => {
    await expect(
      aesCbcPkcs7(KEY, hexToBytes('0011'), new Uint8Array(16), 'encrypt'),
    ).rejects.toThrow(InputError);
  });
});

describe('subtle() guard — WebCrypto absence is a typed capability miss (not a silent failure)', () => {
  it('throws CapabilityError when globalThis.crypto.subtle is unavailable', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    // Simulate an exotic/locked-down runtime with no WebCrypto, then restore it.
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      await expect(aesCbcPkcs7(KEY, IV, new Uint8Array(16), 'encrypt')).rejects.toBeInstanceOf(
        CapabilityError,
      );
    } finally {
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    }
    // Restored: real crypto works again (a 16-byte input PKCS#7-pads to 32 bytes — one full pad block).
    expect((await aesCbcPkcs7(KEY, IV, new Uint8Array(16), 'encrypt')).byteLength).toBe(32);
  });
});
