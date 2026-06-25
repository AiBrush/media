/**
 * HLS `AES-128` segment decryption (RFC 8216 §4.3.2.4 / `#EXT-X-KEY:METHOD=AES-128`) — a whole media
 * segment encrypted with **AES-128-CBC and PKCS#7 padding**, the key and 16-byte IV taken from the
 * playlist (`URI` + `IV`, or the segment's media-sequence number when `IV` is absent). This module is
 * self-contained and container-agnostic: it decrypts the raw segment **payload bytes** (an MPEG-TS or
 * fMP4 segment) back to cleartext; demuxing the recovered segment is a separate concern (ADR-023).
 *
 * Real WebCrypto only ({@link aesCbcPkcs7}); the cleartext is byte-exact (validated against an
 * independent `node:crypto` AES-128-CBC encryption + a round-trip on real media).
 */

import { InputError } from '../contracts/errors.ts';
import { AES_BLOCK, aesCbcPkcs7 } from './aes.ts';

/** AES-128 key length in bytes. */
const AES128_KEY_LEN = 16;

/**
 * Decrypt an HLS `AES-128` (AES-128-CBC + PKCS#7) segment payload. `key` must be 16 bytes, `iv` 16
 * bytes, and the ciphertext a positive multiple of 16 (a CBC invariant) — otherwise the input is not a
 * valid AES-128 segment and a typed {@link InputError} is raised rather than producing garbage. Returns
 * the cleartext segment bytes (PKCS#7 padding removed). An invalid pad surfaces as a SubtleCrypto
 * `OperationError` from the underlying decrypt (wrong key/IV), never a silent wrong result.
 */
export async function decryptHlsAes128(
  payload: Uint8Array,
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (key.byteLength !== AES128_KEY_LEN) {
    throw new InputError(
      'unsupported-input',
      `HLS AES-128 key must be ${AES128_KEY_LEN} bytes, got ${key.byteLength}`,
    );
  }
  if (iv.byteLength !== AES_BLOCK) {
    throw new InputError(
      'unsupported-input',
      `HLS AES-128 IV must be ${AES_BLOCK} bytes, got ${iv.byteLength}`,
    );
  }
  if (payload.byteLength === 0 || payload.byteLength % AES_BLOCK !== 0) {
    throw new InputError(
      'unsupported-input',
      `HLS AES-128 segment must be a positive multiple of ${AES_BLOCK} bytes (CBC), got ${payload.byteLength}`,
    );
  }
  return aesCbcPkcs7(key, iv, payload, 'decrypt');
}
