/**
 * WebCrypto AES primitives for sample/segment decryption (doc 09 §encryption). Real crypto only —
 * `crypto.subtle`, never a hand-rolled cipher (ADR-018: no fake work).
 *
 * - **AES-CTR** (a stream cipher) is used by CENC's `cenc` scheme: a single transform both encrypts and
 *   decrypts, with a 16-byte counter block (per-sample IV in the high bytes, a 64-bit block counter in
 *   the low bytes for CENC; full 128-bit for NIST CTR).
 * - **AES-CBC, no padding** is used by CENC's `cbcs` pattern scheme: a block cipher over exact multiples
 *   of 16 bytes with no PKCS#7. SubtleCrypto offers no raw/no-padding CBC mode, so {@link aesCbcNoPadding}
 *   frames the real `AES-CBC` primitive so it neither adds (encrypt) nor strips (decrypt) any plaintext —
 *   see that function for the construction. This is the canonical "AES-CBC-NoPadding over WebCrypto".
 * - **AES-128-CBC, PKCS#7** ({@link aesCbcPkcs7}) is used by HLS `AES-128` full-segment encryption: the
 *   native SubtleCrypto padding mode (encrypt pads, decrypt strips + validates).
 */

import { CapabilityError, InputError } from '../contracts/errors.ts';

/** Parse an even-length hex string into bytes (throws a typed error on malformed input). */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new InputError('hex string has odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new InputError(`invalid hex byte at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

/** Validate a hex-decoded AES-128 key is exactly 16 bytes (typed InputError on mismatch). */
export function assertAes128HexKey(hex: string, label = 'AES-128 key'): Uint8Array<ArrayBuffer> {
  const bytes = hexToBytes(hex);
  if (bytes.byteLength !== AES_BLOCK) {
    throw new InputError(
      `${label} must be ${AES_BLOCK} bytes (${AES_BLOCK * 2} hex chars), got ${bytes.byteLength}`,
    );
  }
  return bytes;
}

/** The AES block size in bytes (128-bit). */
export const AES_BLOCK = 16;

/**
 * The WebCrypto `SubtleCrypto`, or a typed capability miss when the host lacks it. Browsers and Node
 * (`globalThis.crypto.subtle`) both provide it; only an exotic/locked-down runtime is missing it, which
 * is a genuine capability gap, not a wrong result — so callers get a {@link CapabilityError}, never a
 * silent failure (ADR-017/018).
 */
function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new CapabilityError('WebCrypto crypto.subtle is unavailable', {
      op: { kind: 'route', id: 'decrypt' },
      tried: [],
    });
  }
  return s;
}

/** A fresh copy guarantees a non-shared `ArrayBuffer` backing for WebCrypto (it rejects `SharedArrayBuffer`). */
function ownedCopy(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return data.slice();
}

/**
 * An operation-scoped, non-extractable AES key plus the exact WebCrypto realm that imported it. Keeping
 * the realm avoids a global lookup per sample and makes a prepared key safe when a host replaces its
 * `globalThis.crypto` object between asynchronous stages.
 */
export interface PreparedAesKey {
  readonly algorithm: 'AES-CTR' | 'AES-CBC';
  readonly subtle: SubtleCrypto;
  readonly key: CryptoKey;
}

/** Return an ArrayBuffer-backed view without copying unless the source is shared-memory backed. */
function webCryptoView(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return data.buffer instanceof ArrayBuffer
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : data.slice();
}

function assertAes128Key(key: Uint8Array): void {
  if (key.byteLength !== AES_BLOCK) {
    throw new InputError(`AES-128 key must be ${AES_BLOCK} bytes, got ${key.byteLength}`);
  }
}

/** Import one non-extractable AES-CTR key for reuse across an operation's independent samples. */
export async function prepareAesCtrKey(key: Uint8Array<ArrayBuffer>): Promise<PreparedAesKey> {
  assertAes128Key(key);
  const s = subtle();
  const copy = ownedCopy(key);
  const cryptoKey = await s.importKey('raw', copy, 'AES-CTR', false, ['encrypt']);
  copy.fill(0);
  return {
    algorithm: 'AES-CTR',
    subtle: s,
    key: cryptoKey,
  };
}

/**
 * AES-CTR with an already imported key. WebCrypto snapshots BufferSource inputs when the operation is
 * invoked, so ordinary ArrayBuffer-backed views need no second payload copy; SharedArrayBuffer views are
 * copied because WebCrypto rejects them.
 */
export async function aesCtrWithPreparedKey(
  prepared: PreparedAesKey,
  counter: Uint8Array,
  data: Uint8Array,
  counterBits = 64,
): Promise<Uint8Array<ArrayBuffer>> {
  if (prepared.algorithm !== 'AES-CTR') {
    throw new InputError('prepared AES key is not an AES-CTR key');
  }
  if (counter.byteLength !== AES_BLOCK) {
    throw new InputError(`AES-CTR counter must be ${AES_BLOCK} bytes, got ${counter.byteLength}`);
  }
  if (counterBits !== 64 && counterBits !== 128) {
    throw new InputError(`AES-CTR counterBits must be 64 or 128, got ${counterBits}`);
  }
  const result = await prepared.subtle.encrypt(
    { name: 'AES-CTR', counter: webCryptoView(counter), length: counterBits },
    prepared.key,
    webCryptoView(data),
  );
  return new Uint8Array(result);
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
  return aesCtrWithPreparedKey(await prepareAesCtrKey(key), counter, data, counterBits);
}

/** XOR `a` and `b` into a fresh block (both must be {@link AES_BLOCK} bytes). */
function xorBlock(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(AES_BLOCK);
  for (let i = 0; i < AES_BLOCK; i++) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  return out;
}

/** Import a raw AES key for the given CBC usage (encrypt/decrypt). */
async function importCbcKey(
  s: SubtleCrypto,
  key: Uint8Array<ArrayBuffer>,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const copy = ownedCopy(key);
  const cryptoKey = await s.importKey('raw', copy, 'AES-CBC', false, [usage]);
  copy.fill(0);
  return cryptoKey;
}

/**
 * Import one non-extractable AES-CBC key for an operation. No-padding decryption needs both usages:
 * `decrypt` for the ciphertext and `encrypt` for the synthetic terminal padding block. Encryption-only
 * callers retain the narrower usage set.
 */
export async function prepareAesCbcKey(
  key: Uint8Array<ArrayBuffer>,
  usage: 'encrypt' | 'no-padding-decrypt',
): Promise<PreparedAesKey> {
  assertAes128Key(key);
  const s = subtle();
  const usages: KeyUsage[] = usage === 'encrypt' ? ['encrypt'] : ['encrypt', 'decrypt'];
  const copy = ownedCopy(key);
  const cryptoKey = await s.importKey('raw', copy, 'AES-CBC', false, usages);
  copy.fill(0);
  return {
    algorithm: 'AES-CBC',
    subtle: s,
    key: cryptoKey,
  };
}

/** Encrypt exactly one 16-byte block with raw AES (ECB), realized via single-block CBC with a zero IV. */
async function aesEncryptBlock(
  s: SubtleCrypto,
  cbcKey: CryptoKey,
  block: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  // CBC-encrypt(iv=0, oneBlock) = AES_enc(oneBlock ^ 0) || AES_enc(PKCS#7 pad). The first 16 bytes are
  // exactly the raw AES encryption of `block` (the second block is the appended full-pad block).
  const zeroIv = new Uint8Array(AES_BLOCK);
  const out = new Uint8Array(
    await s.encrypt({ name: 'AES-CBC', iv: zeroIv }, cbcKey, webCryptoView(block)),
  );
  return out.slice(0, AES_BLOCK);
}

/** AES-CBC no-padding with a prepared operation-scoped key; see {@link aesCbcNoPadding}. */
export async function aesCbcNoPaddingWithPreparedKey(
  prepared: PreparedAesKey,
  iv: Uint8Array,
  data: Uint8Array,
  direction: 'encrypt' | 'decrypt',
): Promise<Uint8Array<ArrayBuffer>> {
  if (data.byteLength === 0) return new Uint8Array(0);
  if (data.byteLength % AES_BLOCK !== 0) {
    throw new InputError(
      `AES-CBC no-padding needs a multiple of ${AES_BLOCK} bytes, got ${data.byteLength}`,
    );
  }
  if (iv.byteLength !== AES_BLOCK) {
    throw new InputError(`AES-CBC IV must be ${AES_BLOCK} bytes, got ${iv.byteLength}`);
  }
  if (prepared.algorithm !== 'AES-CBC') {
    throw new InputError('prepared AES key is not an AES-CBC key');
  }
  const { subtle: s, key: cbcKey } = prepared;

  if (direction === 'encrypt') {
    const padded = new Uint8Array(
      await s.encrypt({ name: 'AES-CBC', iv: webCryptoView(iv) }, cbcKey, webCryptoView(data)),
    );
    return padded.slice(0, data.byteLength);
  }

  const lastCipher = data.subarray(data.byteLength - AES_BLOCK);
  const fullPad = new Uint8Array(AES_BLOCK).fill(AES_BLOCK);
  const synthetic = await aesEncryptBlock(s, cbcKey, xorBlock(fullPad, lastCipher));
  const framed = new Uint8Array(data.byteLength + AES_BLOCK);
  framed.set(data, 0);
  framed.set(synthetic, data.byteLength);
  const plain = new Uint8Array(
    await s.decrypt({ name: 'AES-CBC', iv: webCryptoView(iv) }, cbcKey, framed),
  );
  return plain.byteLength === data.byteLength ? plain : plain.slice(0, data.byteLength);
}

/**
 * AES-CBC over `data` with **no padding** — `data.byteLength` must be a positive multiple of 16, and the
 * result is the same length (no bytes added or removed). Used by CENC `cbcs` pattern decryption, where
 * the protected (crypt) blocks are an exact block multiple and carry no PKCS#7.
 *
 * SubtleCrypto has no no-padding CBC mode (encrypt always appends a PKCS#7 block; decrypt always strips
 * one), so this frames the real primitive:
 *  - **decrypt:** append one synthetic ciphertext block `X = AES_enc((0x10)^16 ^ C_last)` so that
 *    `AES-CBC.decrypt(iv, C || X)` yields `plaintext || (0x10)^16`; SubtleCrypto then strips that full
 *    16-byte PKCS#7 block, returning exactly the `n*16` plaintext bytes.
 *  - **encrypt:** `AES-CBC.encrypt(iv, P)` returns `ciphertext || AES_enc(pad ^ C_last)` (one appended
 *    pad block); we drop that trailing block to get exactly the `n*16` ciphertext bytes.
 * Both are real AES (`crypto.subtle`), exact inverses, and validated against the NIST SP 800-38A CBC
 * vectors plus an encrypt→decrypt round-trip on real media.
 */
export async function aesCbcNoPadding(
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
  data: Uint8Array,
  direction: 'encrypt' | 'decrypt',
): Promise<Uint8Array<ArrayBuffer>> {
  if (data.byteLength === 0) return new Uint8Array(0);
  const usage = direction === 'encrypt' ? 'encrypt' : 'no-padding-decrypt';
  return aesCbcNoPaddingWithPreparedKey(await prepareAesCbcKey(key, usage), iv, data, direction);
}

/**
 * AES-CBC with PKCS#7 padding (SubtleCrypto's native CBC mode) — for HLS `AES-128` full-segment
 * encryption (RFC 8216). `encrypt` pads to the next block; `decrypt` validates + strips the padding and
 * throws (via SubtleCrypto `OperationError`) on an invalid pad. `iv` is 16 bytes; for AES-128, `key` is
 * 16 bytes (enforced by the caller).
 */
export async function aesCbcPkcs7(
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
  data: Uint8Array,
  direction: 'encrypt' | 'decrypt',
): Promise<Uint8Array<ArrayBuffer>> {
  if (iv.byteLength !== AES_BLOCK) {
    throw new InputError(`AES-CBC IV must be ${AES_BLOCK} bytes, got ${iv.byteLength}`);
  }
  const s = subtle();
  const cbcKey = await importCbcKey(s, key, direction);
  const result =
    direction === 'encrypt'
      ? await s.encrypt({ name: 'AES-CBC', iv: ownedCopy(iv) }, cbcKey, ownedCopy(data))
      : await s.decrypt({ name: 'AES-CBC', iv: ownedCopy(iv) }, cbcKey, ownedCopy(data));
  return new Uint8Array(result);
}
