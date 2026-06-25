/**
 * Common Encryption (CENC, ISO/IEC 23001-7) sample decryption for the `cenc` (AES-CTR) and `cbcs`
 * (AES-CBC **pattern**) schemes. The `tenc` box carries the default key id, per-sample IV size, and —
 * for `cbcs` — the crypt/skip block **pattern** and an optional `default_constant_IV`; the `senc` box
 * carries the per-sample IV (and, for video, a clear/protected subsample map). The key comes from the
 * caller's {@link KeyMap} keyed by the 16-byte KID (doc 09 §encryption). Real WebCrypto only (ADR-023).
 *
 * - **cenc (AES-CTR):** an 8-byte IV occupies the high 8 bytes of the 16-byte counter block (low 8 are
 *   the block counter, starting 0); a 16-byte IV is the counter block (block counter = low 64 bits,
 *   `length: 64`). For subsample encryption the CTR keystream advances over the **protected** bytes only
 *   — clear bytes are skipped — so protected ranges are gathered, decrypted as one stream, scattered back.
 * - **cbcs (AES-CBC pattern, 23001-7 §10.4):** AES-128-CBC over the protected bytes, but within each
 *   protected subsample only a repeating `crypt:skip` block **pattern** (e.g. 1:9) is encrypted — the
 *   skip blocks and any trailing bytes that don't fill a whole 16-byte block stay clear. The CBC chain
 *   runs continuously over the encrypted (crypt) blocks of a protected range, seeded with the sample (or
 *   constant) IV and **reset at each protected subsample**. So crypt blocks are gathered, CBC-decrypted as
 *   one stream, and scattered back into their positions.
 */

import { MediaError } from '../../contracts/errors.ts';
import { AES_BLOCK, aesCbcNoPadding, aesCtr } from '../../crypto/aes.ts';
import { toHex } from '../../util/digest.ts';

/** The CENC scheme of a protected track — selects the cipher (AES-CTR vs AES-CBC-pattern). */
export type CencScheme = 'cenc' | 'cbcs';

/** A crypt:skip block pattern (in 16-byte blocks) for `cbcs`; `cenc` carries no pattern. */
export interface CencPattern {
  cryptByteBlock: number;
  skipByteBlock: number;
}

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
  /** `cbcs` crypt:skip pattern (present iff the `tenc` is version ≥ 1 with a non-zero pattern). */
  pattern?: CencPattern;
  /** `cbcs` constant IV (present iff `perSampleIvSize === 0`); used for every sample of the track. */
  constantIv?: Uint8Array;
}

export const CENC_SCHEME = 'cenc';
export const CBCS_SCHEME = 'cbcs';

/** Minimum `tenc` full-box payload: version+flags (4) + reserved (1) + pattern (1) + isProtected/ivSize (2) + 16-byte KID. */
const TENC_MIN_LEN = 24;
/** Valid AES-CTR per-sample IV sizes for `cenc`: 8 or 16 bytes (0 ⇒ constant-IV, unsupported for `cenc`). */
const CTR_IV_SIZES: ReadonlySet<number> = new Set([8, 16]);
/** Valid per-sample IV sizes for `cbcs`: 16 (standard), 8 (zero-extended), or 0 (⇒ `default_constant_IV`). */
const CBCS_IV_SIZES: ReadonlySet<number> = new Set([0, 8, 16]);

/** Lowercase-hex key id, the {@link KeyMap} lookup key. */
export function kidHex(kid: Uint8Array): string {
  return toHex(kid);
}

/** The legal per-sample IV sizes a `senc` may declare for a scheme (excludes 0 for `cenc`). */
function sencIvSizes(scheme: CencScheme): ReadonlySet<number> {
  return scheme === CBCS_SCHEME ? CBCS_IV_SIZES : CTR_IV_SIZES;
}

/**
 * Parse a `tenc` (Track Encryption Box) payload (full-box bytes: version+flags then fields) for the given
 * `scheme`, rejecting structurally degenerate protection: a too-short box, an illegal per-sample IV size
 * (`cenc` AES-CTR requires 8 or 16; `cbcs` allows 16/8/0-with-constant-IV), an all-zero `default_KID`
 * while protection is claimed (a zeroed/erased `tenc`), or — for `cbcs` — a missing/short
 * `default_constant_IV` when the per-sample IV size is 0, or a degenerate all-skip pattern that encrypts
 * nothing. These cannot describe decryptable samples, so they are corrupt input — {@link MediaError}
 * `demux-error`, not a silent wrong result (ISO/IEC 23001-7 §8.2/§10.4, ADR-023).
 */
export function parseTenc(payload: Uint8Array, scheme: CencScheme = CENC_SCHEME): TencInfo {
  if (payload.byteLength < TENC_MIN_LEN) {
    throw new MediaError(
      'demux-error',
      `tenc box too short: ${payload.byteLength} bytes < ${TENC_MIN_LEN} (CENC protection metadata is malformed)`,
    );
  }
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = dv.getUint8(0);
  // [0]=version [1..3]=flags [4]=reserved [5]=reserved(v0)|crypt<<4|skip(v1) [6]=isProtected [7]=ivSize [8..23]=KID
  const patternByte = dv.getUint8(5);
  const isProtected = dv.getUint8(6) === 1;
  const perSampleIvSize = dv.getUint8(7);
  const kid = payload.slice(8, 24);

  if (!isProtected) return { isProtected, perSampleIvSize, kid };

  const allowed = scheme === CBCS_SCHEME ? CBCS_IV_SIZES : CTR_IV_SIZES;
  if (!allowed.has(perSampleIvSize)) {
    throw new MediaError(
      'demux-error',
      `tenc declares an unsupported per-sample IV size ${perSampleIvSize} (${scheme} requires ${[...allowed].join('/')})`,
    );
  }
  if (kid.every((b) => b === 0)) {
    throw new MediaError(
      'demux-error',
      'tenc claims protection but the default KID is all zero (zeroed/erased protection metadata)',
    );
  }

  if (scheme !== CBCS_SCHEME) return { isProtected, perSampleIvSize, kid };

  // ── cbcs-only fields: the crypt:skip pattern (version ≥ 1) and the constant IV (ivSize 0) ──
  const pattern =
    version >= 1
      ? { cryptByteBlock: patternByte >> 4, skipByteBlock: patternByte & 0x0f }
      : undefined;
  if (pattern && pattern.cryptByteBlock === 0 && pattern.skipByteBlock === 0) {
    throw new MediaError(
      'demux-error',
      'cbcs tenc declares an all-zero crypt:skip pattern (encrypts nothing) — malformed protection',
    );
  }
  if (perSampleIvSize !== 0) {
    return pattern
      ? { isProtected, perSampleIvSize, kid, pattern }
      : { isProtected, perSampleIvSize, kid };
  }
  // perSampleIvSize === 0 ⇒ default_constant_IV: a length byte at [24] then that many bytes.
  if (payload.byteLength < TENC_MIN_LEN + 1) {
    throw new MediaError(
      'demux-error',
      'cbcs tenc declares per-sample IV size 0 but carries no default_constant_IV length',
    );
  }
  const constantIvSize = dv.getUint8(24);
  if (
    (constantIvSize !== 8 && constantIvSize !== AES_BLOCK) ||
    payload.byteLength < TENC_MIN_LEN + 1 + constantIvSize
  ) {
    throw new MediaError(
      'demux-error',
      `cbcs tenc default_constant_IV size ${constantIvSize} is invalid or overruns the box`,
    );
  }
  const constantIv = payload.slice(25, 25 + constantIvSize);
  return pattern
    ? { isProtected, perSampleIvSize, kid, pattern, constantIv }
    : { isProtected, perSampleIvSize, kid, constantIv };
}

/** `senc` full-box prefix: version+flags (4) + sample_count (4). */
const SENC_HEADER_LEN = 8;
/** Bytes per subsample entry: BytesOfClearData (u16) + BytesOfProtectedData (u32). */
const SUBSAMPLE_ENTRY_LEN = 6;

/**
 * Parse a `senc` (Sample Encryption Box) payload into per-sample IVs (+ optional subsample maps) for the
 * given `scheme`, validating that the declared sample count and its IV / subsample data actually fit the
 * payload. A truncated, overrun, or corrupted `senc` (e.g. a bit-flipped `sample_count`, or zeroed
 * entries that no longer match the box length) cannot be trusted to drive the cipher over the right
 * ranges, so it is rejected as corrupt input — {@link MediaError} `demux-error` — rather than read out of
 * bounds. The IV size must be legal for the scheme: `cenc` needs 8/16; `cbcs` allows 16/8, or **0** when
 * the IV is the `tenc` `default_constant_IV` (then `senc` carries no per-sample IV, only subsample maps).
 */
export function parseSenc(
  payload: Uint8Array,
  perSampleIvSize: number,
  scheme: CencScheme = CENC_SCHEME,
): SencSample[] {
  const allowed = sencIvSizes(scheme);
  if (!allowed.has(perSampleIvSize)) {
    throw new MediaError(
      'demux-error',
      `senc cannot be parsed with per-sample IV size ${perSampleIvSize} (${scheme} requires ${[...allowed].join('/')})`,
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
    // perSampleIvSize 0 (cbcs constant-IV): no per-sample IV bytes — the constant IV is applied later.
    const iv =
      perSampleIvSize === 0 ? new Uint8Array(0) : payload.slice(pos, pos + perSampleIvSize);
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

/** Expand a `cbcs` IV to a full 16-byte CBC IV (a constant/per-sample IV is normally already 16). */
function cbcIv(iv: Uint8Array): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(AES_BLOCK);
  block.set(iv.subarray(0, Math.min(AES_BLOCK, iv.byteLength)), 0);
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

/**
 * Within one protected byte range, return the byte offsets of the **crypt** blocks of a `cbcs`
 * crypt:skip pattern. Full 16-byte blocks are walked from the range start; the first `crypt` are
 * encrypted, the next `skip` are clear, repeating; a `skip` of 0 means every full block is encrypted.
 * Any trailing bytes that don't fill a whole block are left clear (cbcs does not encrypt partial blocks).
 */
function cryptBlockOffsets(protectedLen: number, pattern: CencPattern): number[] {
  const wholeBlocks = Math.floor(protectedLen / AES_BLOCK);
  const cycle = pattern.cryptByteBlock + pattern.skipByteBlock;
  const offsets: number[] = [];
  for (let b = 0; b < wholeBlocks; b++) {
    const phase = cycle === 0 ? 0 : b % cycle;
    if (cycle === 0 || phase < pattern.cryptByteBlock) offsets.push(b * AES_BLOCK);
  }
  return offsets;
}

/**
 * AES-CBC-**pattern**-decrypt one `cbcs` sample. `iv` is the per-sample (or constant) IV. For each
 * protected subsample range the crypt blocks are gathered, CBC-decrypted as one stream (continuous
 * chaining over the encrypted blocks, seeded with `iv`, reset per protected subsample), and scattered
 * back; skip blocks and trailing partial bytes pass through clear. Whole-sample protected data (no
 * subsample map) is treated as a single protected range. Output length === input length.
 */
export async function decryptSampleCbcs(
  key: Uint8Array<ArrayBuffer>,
  pattern: CencPattern,
  iv: Uint8Array,
  data: Uint8Array,
  subsamples?: readonly Subsample[],
): Promise<Uint8Array<ArrayBuffer>> {
  const out = asArrayBufferBytes(data);
  const ranges =
    subsamples && subsamples.length > 0 ? subsamples : [{ clear: 0, protected: data.byteLength }];
  const blockIv = cbcIv(iv);
  let pos = 0;
  for (const ss of ranges) {
    pos += ss.clear;
    const base = pos;
    const offsets = cryptBlockOffsets(ss.protected, pattern);
    if (offsets.length > 0) {
      const gathered = new Uint8Array(offsets.length * AES_BLOCK);
      offsets.forEach((off, i) =>
        gathered.set(data.subarray(base + off, base + off + AES_BLOCK), i * AES_BLOCK),
      );
      const decrypted = await aesCbcNoPadding(key, blockIv, gathered, 'decrypt');
      offsets.forEach((off, i) =>
        out.set(decrypted.subarray(i * AES_BLOCK, i * AES_BLOCK + AES_BLOCK), base + off),
      );
    }
    pos += ss.protected;
  }
  return out;
}

/** Decrypt a `cenc` track's samples in order (sample `i` uses `senc[i]`). */
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

/**
 * Decrypt a `cbcs` track's samples in order. Each sample uses its `senc[i]` subsample map and IV; when
 * the per-sample IV is empty (per-sample IV size 0) the track's `constantIv` is used for every sample.
 */
export async function decryptSamplesCbcs(
  key: Uint8Array<ArrayBuffer>,
  data: readonly Uint8Array[],
  senc: readonly SencSample[],
  pattern: CencPattern,
  constantIv?: Uint8Array,
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const [i, bytes] of data.entries()) {
    const sample = senc[i];
    if (!sample) {
      out.push(asArrayBufferBytes(bytes));
      continue;
    }
    const iv = sample.iv.byteLength > 0 ? sample.iv : constantIv;
    if (!iv || iv.byteLength === 0) {
      throw new MediaError(
        'demux-error',
        `cbcs sample ${i} has neither a per-sample IV nor a default_constant_IV (malformed protection)`,
      );
    }
    out.push(await decryptSampleCbcs(key, pattern, iv, bytes, sample.subsamples));
  }
  return out;
}
