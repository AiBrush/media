/**
 * Common Encryption (CENC, ISO/IEC 23001-7) sample decryption for the `cenc` scheme — AES-CTR over
 * sample bytes. The `tenc` box carries the default key id + per-sample IV size; the `senc` box carries
 * the per-sample IV (and, for video, a clear/protected subsample map). The key comes from the caller's
 * {@link KeyMap} keyed by the 16-byte KID (doc 09 §encryption). Real WebCrypto only (ADR-018).
 *
 * Counter construction: an 8-byte IV occupies the high 8 bytes of the 16-byte counter block (low 8 are
 * the block counter, starting 0); a 16-byte IV is the counter block. The block counter is the low 64
 * bits (`length: 64`). For subsample encryption the CTR keystream advances over the **protected** bytes
 * only — clear bytes are skipped — so protected ranges are gathered, decrypted as one stream, and
 * scattered back.
 */

import { MediaError } from '../../contracts/errors.ts';
import { aesCtr } from '../../crypto/aes.ts';
import { toHex } from '../../util/digest.ts';

export interface Subsample {
  clear: number;
  protected: number;
}
export interface SencSample {
  iv: Uint8Array;
  subsamples?: Subsample[];
}
export interface TencInfo {
  isProtected: boolean;
  perSampleIvSize: number;
  kid: Uint8Array;
}

export const CENC_SCHEME = 'cenc';

/** Minimum `tenc` full-box payload: version+flags (4) + reserved/pattern (2) + isProtected/ivSize (2) + 16-byte KID. */
const TENC_MIN_LEN = 24;
/** Valid AES-CTR per-sample IV sizes for `cenc`: 8 or 16 bytes (0 ⇒ constant-IV, unsupported in this build). */
const CTR_IV_SIZES: ReadonlySet<number> = new Set([8, 16]);

/** Lowercase-hex key id, the {@link KeyMap} lookup key. */
export function kidHex(kid: Uint8Array): string {
  return toHex(kid);
}

/**
 * Parse a `tenc` (Track Encryption Box) payload (full-box bytes: version+flags then fields) and reject
 * structurally degenerate protection: a too-short box, an illegal per-sample IV size (CENC `cenc` AES-CTR
 * requires 8 or 16; 0 is the constant-IV variant this build does not carry), or an all-zero `default_KID`
 * while protection is claimed (a zeroed/erased `tenc`). These cannot describe decryptable samples, so they
 * are corrupt input — {@link MediaError} `demux-error`, not a silent wrong result (ISO/IEC 23001-7, ADR-023).
 */
export function parseTenc(payload: Uint8Array): TencInfo {
  if (payload.byteLength < TENC_MIN_LEN) {
    throw new MediaError(
      'demux-error',
      `tenc box too short: ${payload.byteLength} bytes < ${TENC_MIN_LEN} (CENC protection metadata is malformed)`,
    );
  }
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  // [0]=version [1..3]=flags [4]=reserved [5]=reserved/pattern [6]=isProtected [7]=ivSize [8..23]=KID
  const isProtected = dv.getUint8(6) === 1;
  const perSampleIvSize = dv.getUint8(7);
  const kid = payload.slice(8, 24);
  if (isProtected) {
    if (!CTR_IV_SIZES.has(perSampleIvSize)) {
      throw new MediaError(
        'demux-error',
        `tenc declares an unsupported per-sample IV size ${perSampleIvSize} (CENC 'cenc' AES-CTR requires 8 or 16)`,
      );
    }
    if (kid.every((b) => b === 0)) {
      throw new MediaError(
        'demux-error',
        'tenc claims protection but the default KID is all zero (zeroed/erased protection metadata)',
      );
    }
  }
  return { isProtected, perSampleIvSize, kid };
}

/** `senc` full-box prefix: version+flags (4) + sample_count (4). */
const SENC_HEADER_LEN = 8;
/** Bytes per subsample entry: BytesOfClearData (u16) + BytesOfProtectedData (u32). */
const SUBSAMPLE_ENTRY_LEN = 6;

/**
 * Parse a `senc` (Sample Encryption Box) payload into per-sample IVs (+ optional subsample maps),
 * validating that the declared sample count and its IV / subsample data actually fit the payload. A
 * truncated, overrun, or corrupted `senc` (e.g. a bit-flipped `sample_count`, or zeroed entries that no
 * longer match the box length) cannot be trusted to drive AES-CTR over the right ranges, so it is
 * rejected as corrupt input — {@link MediaError} `demux-error` — rather than read out of bounds. The IV
 * size must be a real CTR IV (8 or 16); 0 (constant-IV) carries no per-sample IV here and is degenerate.
 */
export function parseSenc(payload: Uint8Array, perSampleIvSize: number): SencSample[] {
  if (!CTR_IV_SIZES.has(perSampleIvSize)) {
    throw new MediaError(
      'demux-error',
      `senc cannot be parsed with per-sample IV size ${perSampleIvSize} (CENC 'cenc' AES-CTR requires 8 or 16)`,
    );
  }
  if (payload.byteLength < SENC_HEADER_LEN) {
    throw new MediaError(
      'demux-error',
      `senc box too short: ${payload.byteLength} bytes < ${SENC_HEADER_LEN} (sample-encryption metadata is malformed)`,
    );
  }
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const flags = (dv.getUint8(1) << 16) | (dv.getUint8(2) << 8) | dv.getUint8(3);
  const useSubsamples = (flags & 0x000002) !== 0;
  const limit = payload.byteLength;
  let pos = 4;
  const count = dv.getUint32(pos);
  pos += 4;
  const out: SencSample[] = [];
  for (let i = 0; i < count; i++) {
    if (pos + perSampleIvSize > limit) {
      throw new MediaError(
        'demux-error',
        `senc IV for sample ${i} overruns the box (need ${perSampleIvSize} bytes at ${pos}, have ${limit}); declared sample_count ${count} does not fit`,
      );
    }
    const iv = payload.slice(pos, pos + perSampleIvSize);
    pos += perSampleIvSize;
    if (!useSubsamples) {
      out.push({ iv });
      continue;
    }
    if (pos + 2 > limit) {
      throw new MediaError(
        'demux-error',
        `senc subsample count for sample ${i} overruns the box (at ${pos}, have ${limit})`,
      );
    }
    const n = dv.getUint16(pos);
    pos += 2;
    if (pos + n * SUBSAMPLE_ENTRY_LEN > limit) {
      throw new MediaError(
        'demux-error',
        `senc ${n} subsample entries for sample ${i} overrun the box (need ${n * SUBSAMPLE_ENTRY_LEN} bytes at ${pos}, have ${limit})`,
      );
    }
    const subsamples: Subsample[] = [];
    for (let j = 0; j < n; j++) {
      subsamples.push({ clear: dv.getUint16(pos), protected: dv.getUint32(pos + 2) });
      pos += SUBSAMPLE_ENTRY_LEN;
    }
    out.push({ iv, subsamples });
  }
  return out;
}

/** Build the 16-byte AES-CTR counter block from an 8- or 16-byte IV. */
function counterBlock(iv: Uint8Array): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(16);
  block.set(iv.subarray(0, Math.min(16, iv.byteLength)), 0);
  return block;
}

function asArrayBufferBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  // A fresh copy guarantees an ArrayBuffer (not Shared) backing for WebCrypto.
  return data.slice();
}

/** AES-CTR-decrypt one sample (whole-sample, or only the protected subsample ranges). */
export async function decryptSample(
  key: Uint8Array<ArrayBuffer>,
  sample: SencSample,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const counter = counterBlock(sample.iv);
  if (!sample.subsamples || sample.subsamples.length === 0) {
    return aesCtr(key, counter, asArrayBufferBytes(data), 64);
  }
  const out = asArrayBufferBytes(data);
  let pos = 0;
  let protectedLen = 0;
  for (const ss of sample.subsamples) protectedLen += ss.protected;
  const gathered = new Uint8Array(protectedLen);
  let g = 0;
  for (const ss of sample.subsamples) {
    pos += ss.clear;
    gathered.set(data.subarray(pos, pos + ss.protected), g);
    g += ss.protected;
    pos += ss.protected;
  }
  const decrypted = await aesCtr(key, counter, gathered, 64);
  let d = 0;
  let o = 0;
  for (const ss of sample.subsamples) {
    o += ss.clear;
    out.set(decrypted.subarray(d, d + ss.protected), o);
    d += ss.protected;
    o += ss.protected;
  }
  return out;
}

/** Decrypt a track's samples in order (sample `i` uses `senc[i]`). */
export async function decryptSamples(
  key: Uint8Array<ArrayBuffer>,
  data: readonly Uint8Array[],
  senc: readonly SencSample[],
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const [i, bytes] of data.entries()) {
    const sample = senc[i];
    out.push(sample ? await decryptSample(key, sample, bytes) : asArrayBufferBytes(bytes));
  }
  return out;
}
