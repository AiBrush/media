/**
 * HLS `AES-128` (AES-128-CBC + PKCS#7) segment decryption — byte-exact recovery of a REAL media payload.
 * The ciphertext is produced by an INDEPENDENT `node:crypto` AES-128-CBC encryption (not by our own
 * code), so {@link decryptHlsAes128} recovering the original bytes is a true external oracle, not a self
 * round-trip. The `.ts`/`.adts` corpus byte stream stands in for an encrypted HLS media segment.
 */

import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { hexToBytes } from './aes.ts';
import { decryptHlsAes128 } from './hls-aes.ts';

const KEY = hexToBytes('000102030405060708090a0b0c0d0e0f');
const IV = hexToBytes('00112233445566778899aabbccddeeff');

/** AES-128-CBC + PKCS#7 encrypt with the Node stdlib — the external truth the decryptor must invert. */
function nodeEncryptAes128Cbc(data: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-128-cbc', Buffer.from(KEY), Buffer.from(IV)); // PKCS#7 padding by default
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
}

describe('decryptHlsAes128 — full-segment AES-128 on real media (node:crypto oracle)', () => {
  it('recovers the exact original segment bytes for a real .adts payload', async () => {
    const segment = await loadFixture('sfx.adts');
    expect(segment.byteLength).toBeGreaterThan(64);
    const cipher = nodeEncryptAes128Cbc(segment);
    expect(cipher.byteLength % 16).toBe(0);
    expect([...cipher.subarray(0, 16)]).not.toEqual([...segment.subarray(0, 16)]); // real encryption

    const clear = await decryptHlsAes128(cipher, KEY, IV);
    expect([...clear]).toEqual([...segment]); // byte-exact
  });

  it('a wrong key does NOT recover the cleartext (invalid PKCS#7 → throws, or wrong bytes)', async () => {
    const segment = await loadFixture('sfx.adts');
    const cipher = nodeEncryptAes128Cbc(segment);
    const wrong = hexToBytes('ffffffffffffffffffffffffffffffff');
    const got = await decryptHlsAes128(cipher, wrong, IV).then(
      (b) => b,
      () => undefined, // a wrong key usually trips PKCS#7 validation (SubtleCrypto OperationError)
    );
    if (got) expect([...got]).not.toEqual([...segment]);
  });

  it('rejects a non-block-aligned payload, a short key, and a short IV with InputError', async () => {
    const ok = nodeEncryptAes128Cbc(await loadFixture('sfx.adts'));
    await expect(decryptHlsAes128(ok.subarray(0, ok.byteLength - 1), KEY, IV)).rejects.toThrow(
      InputError,
    );
    await expect(decryptHlsAes128(ok, hexToBytes('0011'), IV)).rejects.toThrow(InputError);
    await expect(decryptHlsAes128(ok, KEY, hexToBytes('0011'))).rejects.toThrow(InputError);
    await expect(decryptHlsAes128(new Uint8Array(0), KEY, IV)).rejects.toThrow(InputError);
  });
});
