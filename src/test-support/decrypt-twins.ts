/**
 * Shared definition of the `decrypt` cleartext-twin oracles produced by INDEPENDENT tools (doc 11 §1
 * decrypt-bitexact; task §3.F.19) — used by both `scripts/bake-goldens.ts` (writer) and
 * `src/conformance/decrypt-diversity.test.ts` (asserter) so they never drift.
 *
 * **Why openssl, not just ffmpeg.** The decrypt oracle must be a tool we did NOT write. `openssl` is the
 * canonical, conformant AES reference: its `aes-128-ctr` / `aes-128-cbc` are the exact primitives CENC
 * (ISO/IEC 23001-7) and HLS (RFC 8216) build on, and — crucially — they implement the **contiguous
 * keystream** that the standard and every browser CDM use. (ffmpeg's `cenc-aes-ctr` muxer realigns the
 * AES-CTR counter to a whole block at each *subsample* boundary, which round-trips with itself but is
 * non-conformant with CDMs; so we use openssl for the cipher-level twins and reserve ffmpeg for the
 * whole-sample-audio CENC twin, where there is no subsample boundary and the two agree. ADR-086.)
 *
 * The twins here are **cipher-level**: we encrypt a real media sample's bytes with openssl and assert our
 * decryptor recovers them byte-exact. This isolates the cipher correctness from container plumbing and
 * works for BOTH audio and video samples (CENC encrypts the same way regardless of media type for the
 * whole-sample case; video subsample maps add only *which* bytes are protected, which we cover separately
 * with our conformant in-house subsample round-trip in cenc-ops.test.ts).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AES_BLOCK, hexToBytes } from '../crypto/aes.ts';
import {
  type CencPattern,
  type SencSample,
  decryptSample,
  decryptSampleCbcs,
} from '../drivers/mp4/cenc.ts';
import { sha256Hex } from '../util/digest.ts';

/** A deterministic 16-byte AES key + CENC 8-byte IV used for every twin (test material, not secrets). */
export const TWIN_KEY_HEX = '000102030405060708090a0b0c0d0e0f';
export const TWIN_IV8_HEX = '34f40300bc7160fa';
export const TWIN_IV16_HEX = '000102030405060708090a0b0c0d0e0f';

/** Run openssl `enc` on `input` and return the output as an owned `Uint8Array<ArrayBuffer>` (WebCrypto-safe). */
function openssl(args: readonly string[], input: Uint8Array): Uint8Array<ArrayBuffer> {
  const dir = mkdtempSync(join(tmpdir(), 'aibrush-twin-'));
  try {
    const inPath = join(dir, 'in.bin');
    const outPath = join(dir, 'out.bin');
    writeFileSync(inPath, input);
    execFileSync('openssl', [...args, '-in', inPath, '-out', outPath]);
    const buf = readFileSync(outPath);
    const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
    out.set(buf);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** openssl AES-128-CTR (the CENC `cenc` whole-sample cipher). `iv16Hex` is the full 16-byte counter block. */
export function opensslCtr(
  clear: Uint8Array,
  keyHex = TWIN_KEY_HEX,
  iv16Hex = `${TWIN_IV8_HEX}0000000000000000`,
): Uint8Array<ArrayBuffer> {
  return openssl(['enc', '-aes-128-ctr', '-K', keyHex, '-iv', iv16Hex], clear);
}

/** openssl AES-128-CBC, no padding (the CENC `cbcs` crypt-block cipher). `clear.length` must be a block multiple. */
export function opensslCbcNoPad(
  clear: Uint8Array,
  keyHex = TWIN_KEY_HEX,
  ivHex = TWIN_IV16_HEX,
): Uint8Array<ArrayBuffer> {
  return openssl(['enc', '-aes-128-cbc', '-nopad', '-K', keyHex, '-iv', ivHex], clear);
}

/** openssl AES-128-CBC with PKCS#7 (the HLS AES-128 full-segment cipher). */
export function opensslCbcPkcs7(
  clear: Uint8Array,
  keyHex = TWIN_KEY_HEX,
  ivHex = TWIN_IV16_HEX,
): Uint8Array<ArrayBuffer> {
  return openssl(['enc', '-aes-128-cbc', '-K', keyHex, '-iv', ivHex], clear);
}

/** Build a CENC `cenc` whole-sample twin: openssl-encrypt `clear`, then prove our decryptSample recovers it. */
export async function cencCtrTwin(
  clear: Uint8Array,
): Promise<{ cipherSha: string; clearSha: string; recovered: boolean }> {
  const cipher = opensslCtr(clear);
  const sample: SencSample = { iv: hexToBytes(TWIN_IV8_HEX) };
  const recovered = await decryptSample(hexToBytes(TWIN_KEY_HEX), sample, cipher);
  return {
    cipherSha: await shaOf(cipher),
    clearSha: await shaOf(clear),
    recovered: bytesEqual(recovered, clear),
  };
}

/** Build a CENC `cbcs` (full-CBC pattern 1:0) twin over the whole-block prefix; the trailing partial stays clear. */
export async function cencCbcsTwin(
  clear: Uint8Array,
): Promise<{ cipherSha: string; clearSha: string; recovered: boolean }> {
  const whole = Math.floor(clear.byteLength / AES_BLOCK) * AES_BLOCK;
  const cipherBlocks = opensslCbcNoPad(clear.subarray(0, whole));
  const cbcsSample = new Uint8Array(new ArrayBuffer(clear.byteLength));
  cbcsSample.set(clear);
  cbcsSample.set(cipherBlocks, 0); // encrypted whole-block prefix + clear trailing partial = a cbcs sample
  const pattern: CencPattern = { cryptByteBlock: 1, skipByteBlock: 0 };
  const recovered = await decryptSampleCbcs(
    hexToBytes(TWIN_KEY_HEX),
    pattern,
    hexToBytes(TWIN_IV16_HEX),
    cbcsSample,
  );
  return {
    cipherSha: await shaOf(cbcsSample),
    clearSha: await shaOf(clear),
    recovered: bytesEqual(recovered, clear),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);
}

/** sha256 of any byte view via an owned `ArrayBuffer` copy (WebCrypto rejects `SharedArrayBuffer` views). */
function shaOf(view: Uint8Array): Promise<string> {
  const owned = new Uint8Array(new ArrayBuffer(view.byteLength));
  owned.set(view);
  return sha256Hex(owned);
}
