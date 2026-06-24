/**
 * WebCrypto AES primitives for sample decryption (doc 09 §encryption). AES-CTR is a stream cipher, so a
 * single transform both encrypts and decrypts — CENC's `cenc` scheme uses it with a 16-byte counter
 * block (per-sample IV in the high bytes, a 64-bit block counter in the low bytes). Real crypto only —
 * `crypto.subtle`, never a hand-rolled cipher (ADR-018: no fake work).
 */

import { InputError } from '../contracts/errors.ts';

/** Parse an even-length hex string into bytes (throws a typed error on malformed input). */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new InputError('unsupported-input', 'hex string has odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte))
      throw new InputError('unsupported-input', `invalid hex byte at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

/**
 * AES-CTR keystream transform (decrypt === encrypt). `counter` is the 16-byte initial counter block;
 * `counterBits` is the width of the incrementing counter portion — CENC uses 64, full-block NIST CTR
 * uses 128. Returns a fresh buffer the same length as `data`.
 */
export async function aesCtr(
  key: Uint8Array<ArrayBuffer>,
  counter: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
  counterBits = 64,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CTR', false, ['encrypt']);
  const result = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter, length: counterBits },
    cryptoKey,
    data,
  );
  return new Uint8Array(result);
}
