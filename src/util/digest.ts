/**
 * Cryptographic digest helpers (WebCrypto). Used by the fixture pipeline (verify downloaded media)
 * and the validation oracles (frame/packet/cleartext goldens, docs/architecture/11 §1).
 */

/** Lowercase hex SHA-256 of the given bytes. */
export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

/** Lowercase hex encoding of a byte buffer. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/** Constant-time-ish equality of two lowercase hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}
