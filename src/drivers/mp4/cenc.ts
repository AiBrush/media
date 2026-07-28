/**
 * Common Encryption (CENC, ISO/IEC 23001-7) sample decryption for the `cenc` (AES-CTR), `cens`
 * (AES-CTR **pattern**), and `cbcs` (AES-CBC **pattern**) schemes. The `tenc` box carries the default key
 * id, per-sample IV size, and — for pattern schemes — the crypt/skip block pattern; `cbcs` may also carry
 * a `default_constant_IV`. The `senc` box carries the per-sample IV (and, for video, a clear/protected
 * subsample map). The key comes from the caller's {@link KeyMap} keyed by the 16-byte KID (doc 09
 * §encryption). Real WebCrypto only (ADR-023/121).
 *
 * - **cenc (AES-CTR):** an 8-byte IV occupies the high 8 bytes of the 16-byte counter block (low 8 are
 *   the block counter, starting 0); a 16-byte IV is the counter block (block counter = low 64 bits,
 *   `length: 64`). For subsample encryption, clear bytes are skipped and each protected range starts on a
 *   CTR block boundary after the previous protected range's full/partial blocks (`ceil(protected/16)`);
 *   partial keystream tails are not carried across the clear gap.
 * - **cens (AES-CTR pattern):** the CTR counterpart to `cbcs`: only full 16-byte crypt blocks selected
 *   by the `tenc` crypt:skip pattern are transformed; skipped blocks and trailing partial blocks stay
 *   clear, and the CTR counter advances over encrypted crypt blocks only, continuously within a sample.
 *   A 0:0 (absent) pattern means *no* pattern — the whole range is one continuous CTR stream, partial tail
 *   included (i.e. `cenc`-style full-sample encryption, how `cens` audio is written).
 * - **cbcs (AES-CBC pattern, 23001-7 §10.4):** AES-128-CBC over the protected bytes, but within each
 *   protected subsample only a repeating `crypt:skip` block **pattern** (e.g. 1:9) is encrypted — the
 *   skip blocks and any trailing bytes that don't fill a whole 16-byte block stay clear. The CBC chain
 *   runs continuously over the encrypted (crypt) blocks of a protected range, seeded with the sample (or
 *   constant) IV and **reset at each protected subsample**. So crypt blocks are gathered, CBC-decrypted as
 *   one stream, and scattered back into their positions.
 */

import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import {
  AES_BLOCK,
  type PreparedAesKey,
  aesCbcNoPaddingWithPreparedKey,
  aesCtrWithPreparedKey,
  hexToBytes,
  prepareAesCbcKey,
  prepareAesCtrKey,
} from '../../crypto/aes.ts';
import { toHex } from '../../util/digest.ts';
import { type BoxHeader, Reader, boxes, readFullBoxHeader } from './reader.ts';

/** The CENC scheme of a protected track — selects the cipher/pattern mode. */
export type CencScheme = 'cenc' | 'cens' | 'cbcs';

/** A crypt:skip block pattern (in 16-byte blocks) for `cens`/`cbcs`; `cenc` carries no pattern. */
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
  /** `cens`/`cbcs` crypt:skip pattern (present iff the `tenc` is version ≥ 1 with a non-zero pattern). */
  pattern?: CencPattern;
  /** `cbcs` constant IV (present iff `perSampleIvSize === 0`); used for every sample of the track. */
  constantIv?: Uint8Array;
}

export const CENC_SCHEME = 'cenc';
export const CENS_SCHEME = 'cens';
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

/** The legal per-sample IV sizes a `senc` may declare for a scheme (excludes 0 for CTR modes). */
function sencIvSizes(scheme: CencScheme): ReadonlySet<number> {
  return scheme === CBCS_SCHEME ? CBCS_IV_SIZES : CTR_IV_SIZES;
}

/**
 * Parse a `tenc` (Track Encryption Box) payload (full-box bytes: version+flags then fields) for the given
 * `scheme`, rejecting structurally degenerate protection: a too-short box, an illegal per-sample IV size
 * (`cenc`/`cens` AES-CTR require 8 or 16; `cbcs` allows 16/8/0-with-constant-IV), an all-zero
 * `default_KID` while protection is claimed (a zeroed/erased `tenc`), or — for `cbcs` — a missing/short
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

  if (scheme === CENC_SCHEME) return { isProtected, perSampleIvSize, kid };

  // ── pattern-scheme fields: crypt:skip (version ≥ 1); cbcs alone may carry constant IV (ivSize 0). ──
  // A version-1 `tenc` may signal `crypt_byte_block == skip_byte_block == 0`, which per ISO/IEC 23001-7
  // §9.6/§10.4 means "no pattern is in use" — i.e. WHOLE-block (full-sample) encryption, NOT a malformed
  // box. Real-world cbcs AUDIO tracks (Apple/Bento4) are written exactly this way (v1 tenc, pattern 0:0,
  // constant IV). Rejecting 0:0 rejected every such track — the root cause of task #8. So 0:0 normalizes to
  // "no pattern" (undefined ⇒ downstream full-block CBC/CTR). A *declared* pattern that encrypts nothing —
  // `crypt == 0` while `skip > 0` — is still corrupt (it protects no bytes), so that alone is rejected.
  const rawCrypt = version >= 1 ? patternByte >> 4 : 0;
  const rawSkip = version >= 1 ? patternByte & 0x0f : 0;
  if (rawCrypt === 0 && rawSkip > 0) {
    throw new MediaError(
      'demux-error',
      `${scheme} tenc declares a crypt:skip pattern 0:${rawSkip} that encrypts nothing — malformed protection`,
    );
  }
  const pattern =
    version >= 1 && rawCrypt > 0 ? { cryptByteBlock: rawCrypt, skipByteBlock: rawSkip } : undefined;
  if (scheme === CENS_SCHEME) {
    return pattern
      ? { isProtected, perSampleIvSize, kid, pattern }
      : { isProtected, perSampleIvSize, kid };
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

/** Compare `candidate` with `base + increment` as a wrapping unsigned big-endian IV counter. */
function ivEqualsIncremented(base: Uint8Array, increment: 1 | 2, candidate: Uint8Array): boolean {
  if (base.byteLength === 0 || candidate.byteLength !== base.byteLength) return false;
  let carry: number = increment;
  for (let i = base.byteLength - 1; i >= 0; i--) {
    const sum = (base[i] ?? 0) + carry;
    if (candidate[i] !== (sum & 0xff)) return false;
    carry = Math.floor(sum / 256);
  }
  return true;
}

/**
 * Reject a single corrupted IV sandwiched between two intact consecutive-counter neighbours. This does
 * NOT require a `senc` to use sequential IVs: arbitrary/random series never enter the premise. When
 * IV[i+1] is exactly IV[i-1]+2, however, there is one unambiguous midpoint; a different IV[i] means the
 * auxiliary metadata was damaged. A random series triggers the premise with probability 2^-64 (8-byte
 * IV) or 2^-128 (16-byte IV), while a one-bit mutation inside a normal producer counter run is caught.
 */
function assertNoSandwichedIvCorruption(samples: readonly SencSample[]): void {
  for (let i = 1; i + 1 < samples.length; i++) {
    const previous = samples[i - 1]?.iv;
    const current = samples[i]?.iv;
    const next = samples[i + 1]?.iv;
    if (!previous || !current || !next) continue;
    if (ivEqualsIncremented(previous, 2, next) && !ivEqualsIncremented(previous, 1, current)) {
      throw new MediaError(
        'demux-error',
        `senc IV for sample ${i} is corrupt: its neighbours form a consecutive counter pair but it is not their midpoint`,
      );
    }
  }
}

/**
 * Parse a `senc` (Sample Encryption Box) payload into per-sample IVs (+ optional subsample maps) for the
 * given `scheme`, validating that the declared sample count and its IV / subsample data actually fit the
 * payload. A truncated, overrun, or corrupted `senc` (e.g. a bit-flipped `sample_count`, or zeroed
 * entries that no longer match the box length) cannot be trusted to drive the cipher over the right
 * ranges, so it is rejected as corrupt input — {@link MediaError} `demux-error` — rather than read out of
 * bounds. The IV size must be legal for the scheme: `cenc`/`cens` need 8/16; `cbcs` allows 16/8, or **0**
 * when the IV is the `tenc` `default_constant_IV` (then `senc` carries no per-sample IV, only subsample
 * maps).
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
  assertNoSandwichedIvCorruption(out);
  return out;
}

/** Build the 16-byte AES-CTR counter block from an 8- or 16-byte IV. */
function counterBlock(iv: Uint8Array): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(16);
  block.set(iv.subarray(0, Math.min(16, iv.byteLength)), 0);
  return block;
}

function counterBlockAt(iv: Uint8Array, blockOffset: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(blockOffset) || blockOffset < 0) {
    throw new MediaError('demux-error', `invalid CENC CTR block offset ${blockOffset}`);
  }
  const block = counterBlock(iv);
  let carry = blockOffset;
  for (let i = AES_BLOCK - 1; i >= 8 && carry > 0; i--) {
    const add = carry % 256;
    const sum = (block[i] ?? 0) + add;
    block[i] = sum & 0xff;
    carry = Math.floor(carry / 256) + Math.floor(sum / 256);
  }
  if (carry > 0) throw new MediaError('demux-error', 'CENC CTR block counter overflow');
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

/** Maximum independent sample transforms submitted to WebCrypto at once (ADR-201). */
export const CENC_DECRYPT_MAX_IN_FLIGHT = 16;

/**
 * Run address-independent sample work through a bounded window. On failure, stop admitting new work,
 * await every already-started operation, then rethrow the lowest-index observed failure. Callers cannot
 * receive a partially written file and no native crypto promise survives the rejected operation.
 */
async function forEachSampleBounded<T>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<void>,
): Promise<void> {
  for (const [index, value] of values.entries()) {
    if (value === undefined) {
      throw new MediaError('demux-error', `sample batch is sparse: index ${index} has no value`);
    }
  }
  let stopped = false;
  let firstFailure: { index: number; error: unknown } | undefined;
  const entries = values.entries();
  const workerCount = Math.min(values.length, CENC_DECRYPT_MAX_IN_FLIGHT);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!stopped) {
      const entry = entries.next();
      if (entry.done) return;
      const [index, value] = entry.value;
      try {
        await operation(value, index);
      } catch (error: unknown) {
        stopped = true;
        if (!firstFailure || index < firstFailure.index) firstFailure = { index, error };
      }
    }
  });
  await Promise.all(workers);
  if (firstFailure) throw firstFailure.error;
}

/**
 * Reject *erased* CENC protection. Genuine AES-CTR/CBC ciphertext of coded media is uniform random, so a
 * run of a whole AES block (16 bytes) of consecutive `0x00` is impossible (probability 2⁻¹²⁸) — it signals
 * the sample's encrypted payload was overwritten with zeros (tampered/erased protection), not decryptable
 * content. Note the erasure need not span the *whole* protected range (a real attack zeroes a chunk of a
 * larger encrypted subsample), so this scans for any block-long zero run, not an all-zero range.
 * "Decrypting" such input silently emits keystream garbage as if it were a valid frame; per ISO/IEC
 * 23001-7 the metadata no longer describes decryptable content, so it is rejected with a typed error (the
 * graceful-failure contract). One linear pass; real ciphertext never accumulates a 16-byte zero run.
 */
function assertNotErasedProtection(protectedBytes: Uint8Array): void {
  let zeroRun = 0;
  for (const byte of protectedBytes) {
    zeroRun = byte === 0 ? zeroRun + 1 : 0;
    if (zeroRun >= AES_BLOCK) {
      throw new MediaError(
        'demux-error',
        `CENC protected data contains a ${AES_BLOCK}-byte all-zero run — erased/tampered ciphertext, not decryptable content`,
      );
    }
  }
}

/** AES-CTR-decrypt one sample with an operation-scoped key (whole sample or protected subsamples). */
async function decryptSamplePrepared(
  key: PreparedAesKey,
  sample: SencSample,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!sample.subsamples || sample.subsamples.length === 0) {
    assertNotErasedProtection(data);
    return aesCtrWithPreparedKey(key, counterBlock(sample.iv), data, 64);
  }
  const out = asArrayBufferBytes(data);
  let pos = 0;
  let blockOffset = 0;
  for (const ss of sample.subsamples) {
    pos += ss.clear;
    if (ss.protected > 0) {
      assertNotErasedProtection(data.subarray(pos, pos + ss.protected));
      const decrypted = await aesCtrWithPreparedKey(
        key,
        counterBlockAt(sample.iv, blockOffset),
        data.subarray(pos, pos + ss.protected),
        64,
      );
      out.set(decrypted, pos);
      blockOffset += Math.ceil(ss.protected / AES_BLOCK);
    }
    pos += ss.protected;
  }
  return out;
}

/** AES-CTR-decrypt one sample (whole-sample, or only the protected subsample ranges). */
export async function decryptSample(
  key: Uint8Array<ArrayBuffer>,
  sample: SencSample,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return decryptSamplePrepared(await prepareAesCtrKey(key), sample, data);
}

/**
 * AES-CTR-**pattern**-decrypt one `cens` sample. With a real crypt:skip pattern (`skipByteBlock > 0`) only
 * the full 16-byte crypt blocks selected by the pattern are transformed; skipped full blocks and trailing
 * partial blocks stay clear, and the CTR counter advances over crypt blocks only. When `skipByteBlock === 0`
 * there is **no** pattern (ISO/IEC 23001-7 §9.6): the whole protected range is one continuous AES-CTR stream
 * — including any trailing partial block, since CTR is a stream cipher — exactly like `cenc`. mp4encrypt /
 * Bento4 write `cens` **audio** this way (`tenc` pattern 0:0, whole-sample, non-block-aligned), so treating
 * that as a "1:0 whole-blocks-only" pattern would wrongly leave each sample's partial tail encrypted.
 * Whole-sample protected data (no subsample map) is treated as one protected range. Output length === input
 * length.
 */
async function decryptSampleCensPrepared(
  key: PreparedAesKey,
  pattern: CencPattern,
  sample: SencSample,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = asArrayBufferBytes(data);
  const ranges =
    sample.subsamples && sample.subsamples.length > 0
      ? sample.subsamples
      : [{ clear: 0, protected: data.byteLength }];
  const fullSample = pattern.skipByteBlock === 0; // no skip ⇒ continuous full-range CTR (incl. partial tail)
  let pos = 0;
  let encryptedBlockOffset = 0;
  for (const ss of ranges) {
    pos += ss.clear;
    const base = pos;
    if (fullSample) {
      if (ss.protected > 0) {
        const decrypted = await aesCtrWithPreparedKey(
          key,
          counterBlockAt(sample.iv, encryptedBlockOffset),
          data.subarray(base, base + ss.protected),
          64,
        );
        out.set(decrypted, base);
        encryptedBlockOffset += Math.ceil(ss.protected / AES_BLOCK);
      }
      pos += ss.protected;
      continue;
    }
    const offsets = cryptBlockOffsets(ss.protected, pattern);
    if (offsets.length > 0) {
      const gathered = new Uint8Array(offsets.length * AES_BLOCK);
      offsets.forEach((off, i) =>
        gathered.set(data.subarray(base + off, base + off + AES_BLOCK), i * AES_BLOCK),
      );
      const decrypted = await aesCtrWithPreparedKey(
        key,
        counterBlockAt(sample.iv, encryptedBlockOffset),
        gathered,
        64,
      );
      offsets.forEach((off, i) =>
        out.set(decrypted.subarray(i * AES_BLOCK, i * AES_BLOCK + AES_BLOCK), base + off),
      );
      encryptedBlockOffset += offsets.length;
    }
    pos += ss.protected;
  }
  return out;
}

/** AES-CTR-pattern-decrypt one `cens` sample with a raw key (API-compatible convenience wrapper). */
export async function decryptSampleCens(
  key: Uint8Array<ArrayBuffer>,
  pattern: CencPattern,
  sample: SencSample,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return decryptSampleCensPrepared(await prepareAesCtrKey(key), pattern, sample, data);
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
async function decryptSampleCbcsPrepared(
  key: PreparedAesKey,
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
      const decrypted = await aesCbcNoPaddingWithPreparedKey(key, blockIv, gathered, 'decrypt');
      offsets.forEach((off, i) =>
        out.set(decrypted.subarray(i * AES_BLOCK, i * AES_BLOCK + AES_BLOCK), base + off),
      );
    }
    pos += ss.protected;
  }
  return out;
}

/** AES-CBC-pattern-decrypt one `cbcs` sample with a raw key (API-compatible convenience wrapper). */
export async function decryptSampleCbcs(
  key: Uint8Array<ArrayBuffer>,
  pattern: CencPattern,
  iv: Uint8Array,
  data: Uint8Array,
  subsamples?: readonly Subsample[],
): Promise<Uint8Array<ArrayBuffer>> {
  return decryptSampleCbcsPrepared(
    await prepareAesCbcKey(key, 'no-padding-decrypt'),
    pattern,
    iv,
    data,
    subsamples,
  );
}

/**
 * A per-sample completion hook: invoked with sample `index`'s clear bytes the instant its transform
 * finishes (out of order, within the bounded window). It lets a caller pipeline downstream work — e.g.
 * feeding each recovered AVC access unit to a validation decoder — instead of waiting for the whole track.
 * The hook must be side-effect-pure and non-throwing; the returned array stays the ordered source of truth.
 */
export type SampleDecryptedCallback = (index: number, clear: Uint8Array) => void;

/** Decrypt a `cenc` track's samples in order (sample `i` uses `senc[i]`). */
export async function decryptSamples(
  key: Uint8Array<ArrayBuffer>,
  data: readonly Uint8Array[],
  senc: readonly SencSample[],
  onDecrypted?: SampleDecryptedCallback,
): Promise<Uint8Array[]> {
  if (data.length === 0) return [];
  const prepared = await prepareAesCtrKey(key);
  const out = new Array<Uint8Array>(data.length);
  await forEachSampleBounded(data, async (bytes, i) => {
    const sample = senc[i];
    const clear = sample
      ? await decryptSamplePrepared(prepared, sample, bytes)
      : asArrayBufferBytes(bytes);
    out[i] = clear;
    onDecrypted?.(i, clear);
  });
  return out;
}

/** Decrypt a `cens` track's samples in order (patterned AES-CTR; sample `i` uses `senc[i]`). */
export async function decryptSamplesCens(
  key: Uint8Array<ArrayBuffer>,
  data: readonly Uint8Array[],
  senc: readonly SencSample[],
  pattern: CencPattern,
  onDecrypted?: SampleDecryptedCallback,
): Promise<Uint8Array[]> {
  if (data.length === 0) return [];
  const prepared = await prepareAesCtrKey(key);
  const out = new Array<Uint8Array>(data.length);
  await forEachSampleBounded(data, async (bytes, i) => {
    const sample = senc[i];
    const clear = sample
      ? await decryptSampleCensPrepared(prepared, pattern, sample, bytes)
      : asArrayBufferBytes(bytes);
    out[i] = clear;
    onDecrypted?.(i, clear);
  });
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
  onDecrypted?: SampleDecryptedCallback,
): Promise<Uint8Array[]> {
  if (data.length === 0) return [];
  const prepared = await prepareAesCbcKey(key, 'no-padding-decrypt');
  const out = new Array<Uint8Array>(data.length);
  await forEachSampleBounded(data, async (bytes, i) => {
    const sample = senc[i];
    if (!sample) {
      const clear = asArrayBufferBytes(bytes);
      out[i] = clear;
      onDecrypted?.(i, clear);
      return;
    }
    const iv = sample.iv.byteLength > 0 ? sample.iv : constantIv;
    if (!iv || iv.byteLength === 0) {
      throw new MediaError(
        'demux-error',
        `cbcs sample ${i} has neither a per-sample IV nor a default_constant_IV (malformed protection)`,
      );
    }
    const clear = await decryptSampleCbcsPrepared(prepared, pattern, iv, bytes, sample.subsamples);
    out[i] = clear;
    onDecrypted?.(i, clear);
  });
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Whole-file CENC engine (`decryptCencFile`)
//
// A single self-contained pass over a complete ISO-BMFF byte buffer that decrypts every CENC-protected
// sample **in place** (output byte length === input) and neutralizes the protection signalling so the
// result probes as a clear file. Unlike the `moov`-only driver path, this handles the full spread of
// real-world layouts declared by ISO/IEC 23001-7 §§7–10:
//   (i)   `cbcs` constant-IV (`tenc` `default_constant_IV`, Per_Sample_IV_Size 0) with NO `senc`/aux —
//         the constant IV is the sample crypto metadata and applies to every protected sample;
//   (ii)  per-sample-IV `senc` + subsample maps (video), across multiple `moof` fragments;
//   (iii) `sbgp`/`sgpd` 'seig' sample-group overrides (unprotected groups, per-group KID/IV/pattern),
//         both traf-local (index ≥ 0x10001) and movie-level (index ≤ 0xFFFF) group descriptions;
//   (iv)  `saiz`/`saio`-located auxiliary data (no `senc`), explicit-absolute / moof-relative / legacy
//         `tfhd` bases, and 64-bit `saio`;
//   (v)   mixed clear/encrypted tracks and mixed clear/protected sample descriptions (`stsd` > 1).
// Malformed or contradictory protection rejects with a typed {@link MediaError}; a genuinely unsupported
// capability (unknown scheme or multi-entry `saio`) rejects with a {@link CapabilityError}. An incomplete
// caller key map is a typed {@link InputError}, because adding the missing KID is not a driver capability.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/** Options for {@link decryptCencFile}: the container's own scheme and the KID→key(hex) map. */
export interface DecryptFileOptions {
  scheme: CencScheme;
  keys: Record<string, string>;
}

/** cbcs/cens fall back to "encrypt every whole block" (crypt:skip 1:0) when no pattern is declared. */
const DEFAULT_FULL_PATTERN: CencPattern = { cryptByteBlock: 1, skipByteBlock: 0 };
/** Sample-entry fixed-field sizes before the child boxes begin (audio 28, visual 78; mirrors parse.ts). */
const AUDIO_ENTRY_HEADER = 28;
const VISUAL_ENTRY_HEADER = 78;
/** `tfhd` `tf_flags` bits (ISO/IEC 14496-12 §8.8.7). */
const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESC_INDEX = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
/** `trun` flags (ISO/IEC 14496-12 §8.8.8). */
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTO = 0x000800;
/** `saiz`/`saio` carry an aux-info-type prefix iff flag bit 0 is set (ISO/IEC 14496-12 §8.7.8/§8.7.9). */
const AUX_INFO_TYPE_PRESENT = 0x000001;
/** Fragment-local sample-group indices start above this value (ISO/IEC 14496-12 §8.9.4). */
const FRAGMENT_GROUP_BASE = 0x10000;

/** A resolved 'seig' sample-group entry (per-group protection override, ISO/IEC 23001-7 §6). */
interface SeigGroup {
  isProtected: number;
  perSampleIvSize: number;
  kid: Uint8Array;
  pattern: CencPattern | undefined;
  constantIv: Uint8Array | undefined;
}

/** A protected `stsd` entry before its `tenc` is parsed (scheme still unvalidated). */
interface RawProtection {
  origFormat: string;
  schemeType: string;
  rawTenc: Uint8Array;
  /**
   * Length-prefix width from `avcC`/`hvcC`, when the protected entry carries an AVC/HEVC decoder
   * configuration. Retained so flat CBCS can recognize a broken producer that added protection
   * signalling to an already-clear video payload.
   */
  nalLengthSize: number | undefined;
  /** Absolute offset of the sample-entry fourcc (rewritten to `origFormat` on neutralization). */
  renameOffset: number;
  /** Absolute offset of the `sinf` box (neutralized to `free`). */
  sinfOffset: number;
}

/** One track's decrypt-relevant shape, gathered from `moov/trak`. */
interface TrackDef {
  trackId: number;
  handler: string;
  rawProtected: Map<number, RawProtection>;
  protectedByDesc: Map<number, TencInfo>;
  isProtectedTrack: boolean;
  stbl: BoxHeader | undefined;
  stblSeig: SeigGroup[];
  defaultDescIndex: number;
  defaultSampleSize: number;
}

/** An absolute sample byte range plus the `stsd` description index that governs its protection. */
interface SampleLoc {
  start: number;
  size: number;
  descIndex: number;
}

/** A pending byte rewrite: overwrite four ASCII bytes at `offset` with `fourcc`. */
interface Rename {
  offset: number;
  fourcc: string;
}

/** Per-sample decrypt inputs shared across a flat table or one `traf`. */
interface RunContext {
  bytes: Uint8Array;
  out: Uint8Array<ArrayBuffer>;
  scheme: CencScheme;
  protectedByDesc: Map<number, TencInfo>;
  resolveKey: (kid: Uint8Array) => Promise<PreparedAesKey>;
  senc: SencSample[] | undefined;
  aux: SencSample[] | undefined;
  sbgp: { count: number; index: number }[] | undefined;
  trafSeig: SeigGroup[];
  stblSeig: SeigGroup[];
}

/** Build a {@link SencSample}, omitting `subsamples` when absent (exact-optional-safe). */
function sencSample(iv: Uint8Array, subsamples: Subsample[] | undefined): SencSample {
  return subsamples ? { iv, subsamples } : { iv };
}

/** The first child box of `type` in `[start, end)`, or undefined (fresh cursor, no aliasing). */
function findChild(
  bytes: Uint8Array,
  start: number,
  end: number,
  type: string,
): BoxHeader | undefined {
  const r = new Reader(bytes, start);
  for (const h of boxes(r, end)) if (h.type === type) return h;
  return undefined;
}

/** Every child box of `type` in `[start, end)` (fresh cursor). */
function findChildren(bytes: Uint8Array, start: number, end: number, type: string): BoxHeader[] {
  const r = new Reader(bytes, start);
  const out: BoxHeader[] = [];
  for (const h of boxes(r, end)) if (h.type === type) out.push(h);
  return out;
}

/** `trex` defaults (sample-description index + default sample size) keyed by track id. */
function parseTrex(bytes: Uint8Array, moov: BoxHeader): Map<number, TrexDefaults> {
  const map = new Map<number, TrexDefaults>();
  const mvex = findChild(bytes, moov.payloadStart, moov.end, 'mvex');
  if (!mvex) return map;
  for (const trex of findChildren(bytes, mvex.payloadStart, mvex.end, 'trex')) {
    const r = new Reader(bytes, trex.payloadStart);
    readFullBoxHeader(r);
    const trackId = r.u32();
    const descIndex = r.u32();
    r.u32(); // default_sample_duration
    const sampleSize = r.u32();
    map.set(trackId, { descIndex, sampleSize });
  }
  return map;
}
interface TrexDefaults {
  descIndex: number;
  sampleSize: number;
}

/** `tkhd` track id (skips the v0/v1 creation/modification time fields). */
function parseTrackId(bytes: Uint8Array, tkhd: BoxHeader): number {
  const r = new Reader(bytes, tkhd.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8);
  return r.u32();
}

/** `hdlr` handler type (e.g. `soun`/`vide`). */
function parseHandlerType(bytes: Uint8Array, hdlr: BoxHeader): string {
  const r = new Reader(bytes, hdlr.payloadStart);
  readFullBoxHeader(r);
  r.skip(4); // pre_defined
  return r.fourcc();
}

/** The `stsd` sample entries in order (index i ⇒ 1-based sample_description_index i+1). */
function stsdEntries(bytes: Uint8Array, stsd: BoxHeader): BoxHeader[] {
  const r = new Reader(bytes, stsd.payloadStart);
  readFullBoxHeader(r);
  const count = r.u32();
  const out: BoxHeader[] = [];
  for (const h of boxes(r, stsd.end)) {
    out.push(h);
    if (out.length >= count) break;
  }
  return out;
}

/** Parse the `sinf` protection of one `enca`/`encv` entry (original format, scheme, raw `tenc`). */
function parseEntryProtection(
  bytes: Uint8Array,
  entry: BoxHeader,
  handler: string,
): Omit<RawProtection, 'renameOffset'> | undefined {
  const childStart =
    entry.payloadStart + (handler === 'soun' ? AUDIO_ENTRY_HEADER : VISUAL_ENTRY_HEADER);
  const sinf = findChild(bytes, childStart, entry.end, 'sinf');
  if (!sinf) return undefined;
  const frma = findChild(bytes, sinf.payloadStart, sinf.end, 'frma');
  const schm = findChild(bytes, sinf.payloadStart, sinf.end, 'schm');
  const schi = findChild(bytes, sinf.payloadStart, sinf.end, 'schi');
  if (!frma || !schi) return undefined;
  const origFormat = new Reader(bytes, frma.payloadStart).fourcc();
  let schemeType = CENC_SCHEME;
  if (schm) {
    const rs = new Reader(bytes, schm.payloadStart);
    readFullBoxHeader(rs);
    schemeType = rs.fourcc();
  }
  const tenc = findChild(bytes, schi.payloadStart, schi.end, 'tenc');
  if (!tenc) return undefined;
  let nalLengthSize: number | undefined;
  if (
    origFormat === 'avc1' ||
    origFormat === 'avc2' ||
    origFormat === 'avc3' ||
    origFormat === 'avc4'
  ) {
    const avcC = findChild(bytes, childStart, entry.end, 'avcC');
    if (avcC && avcC.end - avcC.payloadStart >= 5)
      nalLengthSize = (bytes[avcC.payloadStart + 4] ?? 0) & 0x03;
  } else if (origFormat === 'hvc1' || origFormat === 'hev1') {
    const hvcC = findChild(bytes, childStart, entry.end, 'hvcC');
    if (hvcC && hvcC.end - hvcC.payloadStart >= 22)
      nalLengthSize = (bytes[hvcC.payloadStart + 21] ?? 0) & 0x03;
  }
  return {
    origFormat,
    schemeType,
    rawTenc: bytes.subarray(tenc.payloadStart, tenc.end).slice(),
    nalLengthSize: nalLengthSize === undefined ? undefined : nalLengthSize + 1,
    sinfOffset: sinf.start,
  };
}

/** All 'seig' sample-group descriptions inside `[start, end)` (movie-level or traf-local). */
function collectSeigGroups(bytes: Uint8Array, start: number, end: number): SeigGroup[] {
  const groups: SeigGroup[] = [];
  for (const sgpd of findChildren(bytes, start, end, 'sgpd'))
    groups.push(...parseSeigGroups(bytes, sgpd));
  return groups;
}

/** Parse one `sgpd` box's 'seig' entries into resolved {@link SeigGroup}s (non-'seig' groups ignored). */
function parseSeigGroups(bytes: Uint8Array, sgpd: BoxHeader): SeigGroup[] {
  const r = new Reader(bytes, sgpd.payloadStart);
  const { version } = readFullBoxHeader(r);
  if (r.fourcc() !== 'seig') return [];
  let defaultLength = 0;
  if (version === 1) defaultLength = r.u32();
  else if (version >= 2) r.u32(); // default_sample_description_index
  const count = r.u32();
  const groups: SeigGroup[] = [];
  for (let i = 0; i < count; i++) {
    if (version >= 1 && defaultLength === 0) r.u32(); // per-entry description_length (self-delimiting fields)
    r.u8(); // reserved
    const patternByte = r.u8();
    const isProtected = r.u8();
    const perSampleIvSize = r.u8();
    const kid = r.bytes(16).slice();
    let constantIv: Uint8Array | undefined;
    if (isProtected === 1 && perSampleIvSize === 0) constantIv = r.bytes(r.u8()).slice();
    const crypt = patternByte >> 4;
    const pattern =
      crypt > 0 ? { cryptByteBlock: crypt, skipByteBlock: patternByte & 0x0f } : undefined;
    groups.push({ isProtected, perSampleIvSize, kid, pattern, constantIv });
  }
  return groups;
}

/** Parse an `sbgp` box's 'seig' sample→group runs (non-'seig' groupings ignored). */
function parseSbgp(bytes: Uint8Array, sbgp: BoxHeader): { count: number; index: number }[] {
  const r = new Reader(bytes, sbgp.payloadStart);
  const { version } = readFullBoxHeader(r);
  if (r.fourcc() !== 'seig') return [];
  if (version === 1) r.u32(); // grouping_type_parameter
  const count = r.u32();
  const entries: { count: number; index: number }[] = [];
  for (let i = 0; i < count; i++) entries.push({ count: r.u32(), index: r.u32() });
  return entries;
}

/** The group_description_index that covers `sampleIndex` (0 ⇒ no group / defaults). */
function groupIndexAt(entries: { count: number; index: number }[], sampleIndex: number): number {
  let acc = 0;
  for (const e of entries) {
    if (sampleIndex < acc + e.count) return e.index;
    acc += e.count;
  }
  return 0;
}

/** Resolve a sample-group index against the traf-local then movie-level 'seig' descriptions. */
function resolveSeigGroup(index: number, trafSeig: SeigGroup[], stblSeig: SeigGroup[]): SeigGroup {
  const group = index > 0xffff ? trafSeig[index - FRAGMENT_GROUP_BASE - 1] : stblSeig[index - 1];
  if (!group) {
    throw new MediaError(
      'demux-error',
      `sbgp references sample-group description index ${index} with no matching sgpd entry`,
    );
  }
  return group;
}

/** Per-sample auxiliary-info sizes from a `saiz` box (default size, or an explicit per-sample array). */
function parseSaizSizes(bytes: Uint8Array, saiz: BoxHeader): number[] {
  const r = new Reader(bytes, saiz.payloadStart);
  const { flags } = readFullBoxHeader(r);
  if (flags & AUX_INFO_TYPE_PRESENT) {
    r.u32();
    r.u32();
  }
  const defaultSize = r.u8();
  const count = r.u32();
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) sizes.push(defaultSize === 0 ? r.u8() : defaultSize);
  return sizes;
}

/** Auxiliary-info offsets from a `saio` box (v0 32-bit / v1 64-bit). */
function parseSaioOffsets(bytes: Uint8Array, saio: BoxHeader): number[] {
  const r = new Reader(bytes, saio.payloadStart);
  const { version, flags } = readFullBoxHeader(r);
  if (flags & AUX_INFO_TYPE_PRESENT) {
    r.u32();
    r.u32();
  }
  const count = r.u32();
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(version === 1 ? r.u64() : r.u32());
  return offsets;
}

/**
 * Parse contiguous CENC sample-auxiliary blobs (`InitializationVector` + optional subsample map) located
 * by `saiz`/`saio` into {@link SencSample}s. A blob larger than the per-sample IV carries a subsample map
 * (`subsample_count` u16, then `{ clear u16, protected u32 }` entries), per ISO/IEC 23001-7 §7.
 */
function parseAuxSamples(
  bytes: Uint8Array,
  auxStart: number,
  sizes: number[],
  ivSize: number,
): SencSample[] {
  const out: SencSample[] = [];
  let pos = auxStart;
  for (const size of sizes) {
    if (pos < 0 || pos + size > bytes.byteLength) {
      throw new MediaError(
        'demux-error',
        `saio/saiz auxiliary data at [${pos}, ${pos + size}) overruns the file (${bytes.byteLength})`,
      );
    }
    const r = new Reader(bytes, pos);
    const iv = ivSize > 0 ? r.bytes(ivSize).slice() : new Uint8Array(0);
    let subsamples: Subsample[] | undefined;
    if (size > ivSize) {
      const n = r.u16();
      subsamples = [];
      for (let j = 0; j < n; j++) subsamples.push({ clear: r.u16(), protected: r.u32() });
    }
    out.push(sencSample(iv, subsamples));
    pos += size;
  }
  return out;
}

/** Expand a flat `stbl` (stsc/stsz/stco/co64) into absolute per-sample ranges with description indices. */
function buildFlatSamples(bytes: Uint8Array, stbl: BoxHeader): SampleLoc[] {
  const stsc = findChild(bytes, stbl.payloadStart, stbl.end, 'stsc');
  const stsz = findChild(bytes, stbl.payloadStart, stbl.end, 'stsz');
  const stco = findChild(bytes, stbl.payloadStart, stbl.end, 'stco');
  const co64 = findChild(bytes, stbl.payloadStart, stbl.end, 'co64');
  if (!stsc || !stsz || (!stco && !co64)) return [];

  const rz = new Reader(bytes, stsz.payloadStart);
  readFullBoxHeader(rz);
  const uniformSize = rz.u32();
  const sampleCount = rz.u32();
  const sizes: number[] = [];
  for (let i = 0; i < sampleCount; i++) sizes.push(uniformSize === 0 ? rz.u32() : uniformSize);

  const chunkOffsets: number[] = [];
  if (stco) {
    const rc = new Reader(bytes, stco.payloadStart);
    readFullBoxHeader(rc);
    const n = rc.u32();
    for (let i = 0; i < n; i++) chunkOffsets.push(rc.u32());
  } else if (co64) {
    const rc = new Reader(bytes, co64.payloadStart);
    readFullBoxHeader(rc);
    const n = rc.u32();
    for (let i = 0; i < n; i++) chunkOffsets.push(rc.u64());
  }

  const rs = new Reader(bytes, stsc.payloadStart);
  readFullBoxHeader(rs);
  const entryCount = rs.u32();
  const stscEntries: { firstChunk: number; perChunk: number; desc: number }[] = [];
  for (let i = 0; i < entryCount; i++) {
    stscEntries.push({ firstChunk: rs.u32(), perChunk: rs.u32(), desc: rs.u32() });
  }

  const samples: SampleLoc[] = [];
  let sampleIndex = 0;
  for (let ci = 0; ci < chunkOffsets.length && sampleIndex < sizes.length; ci++) {
    const chunkNo = ci + 1;
    let entry = stscEntries[0];
    for (const e of stscEntries) {
      if (e.firstChunk <= chunkNo) entry = e;
      else break;
    }
    if (!entry) break;
    let offset = chunkOffsets[ci] ?? 0;
    for (let s = 0; s < entry.perChunk && sampleIndex < sizes.length; s++) {
      const size = sizes[sampleIndex] ?? 0;
      samples.push({ start: offset, size, descIndex: entry.desc });
      offset += size;
      sampleIndex++;
    }
  }
  return samples;
}

/** Parse a `tfhd` box (track id, flags, optional base-data-offset / sample-description / default size). */
function parseTfhd(
  bytes: Uint8Array,
  tfhd: BoxHeader,
): {
  trackId: number;
  flags: number;
  baseDataOffset: number | undefined;
  sampleDescIndex: number | undefined;
  defaultSampleSize: number | undefined;
} {
  const r = new Reader(bytes, tfhd.payloadStart);
  const { flags } = readFullBoxHeader(r);
  const trackId = r.u32();
  const baseDataOffset = flags & TFHD_BASE_DATA_OFFSET ? r.u64() : undefined;
  const sampleDescIndex = flags & TFHD_SAMPLE_DESC_INDEX ? r.u32() : undefined;
  if (flags & TFHD_DEFAULT_SAMPLE_DURATION) r.u32();
  const defaultSampleSize = flags & TFHD_DEFAULT_SAMPLE_SIZE ? r.u32() : undefined;
  return { trackId, flags, baseDataOffset, sampleDescIndex, defaultSampleSize };
}

/** Parse a `trun` box's per-sample sizes (default-filled when the size flag is absent). */
function parseTrun(
  bytes: Uint8Array,
  trun: BoxHeader,
  defaultSampleSize: number,
): {
  hasDataOffset: boolean;
  dataOffset: number;
  sizes: number[];
} {
  const r = new Reader(bytes, trun.payloadStart);
  const { flags } = readFullBoxHeader(r);
  const sampleCount = r.u32();
  const hasDataOffset = (flags & TRUN_DATA_OFFSET) !== 0;
  const dataOffset = hasDataOffset ? r.i32() : 0;
  if (flags & TRUN_FIRST_SAMPLE_FLAGS) r.u32();
  const sizes: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    if (flags & TRUN_SAMPLE_DURATION) r.u32();
    sizes.push(flags & TRUN_SAMPLE_SIZE ? r.u32() : defaultSampleSize);
    if (flags & TRUN_SAMPLE_FLAGS) r.u32();
    if (flags & TRUN_SAMPLE_CTO) r.u32();
  }
  return { hasDataOffset, dataOffset, sizes };
}

/** Parse one `moov/trak` into a {@link TrackDef} (id, handler, protected entries, flat tables, groups). */
function parseTrak(
  bytes: Uint8Array,
  trak: BoxHeader,
  trex: Map<number, TrexDefaults>,
): TrackDef | undefined {
  const tkhd = findChild(bytes, trak.payloadStart, trak.end, 'tkhd');
  const mdia = findChild(bytes, trak.payloadStart, trak.end, 'mdia');
  if (!tkhd || !mdia) return undefined;
  const trackId = parseTrackId(bytes, tkhd);
  const hdlr = findChild(bytes, mdia.payloadStart, mdia.end, 'hdlr');
  const handler = hdlr ? parseHandlerType(bytes, hdlr) : '';
  const minf = findChild(bytes, mdia.payloadStart, mdia.end, 'minf');
  const stbl = minf ? findChild(bytes, minf.payloadStart, minf.end, 'stbl') : undefined;

  const rawProtected = new Map<number, RawProtection>();
  const stblSeig: SeigGroup[] = [];
  if (stbl) {
    const stsd = findChild(bytes, stbl.payloadStart, stbl.end, 'stsd');
    if (stsd) {
      let descIndex = 0;
      for (const entry of stsdEntries(bytes, stsd)) {
        descIndex += 1;
        if (
          entry.type === 'enca' ||
          entry.type === 'encv' ||
          entry.type === 'encs' ||
          entry.type === 'enct'
        ) {
          const prot = parseEntryProtection(bytes, entry, handler);
          if (prot) rawProtected.set(descIndex, { ...prot, renameOffset: entry.start + 4 });
        }
      }
    }
    stblSeig.push(...collectSeigGroups(bytes, stbl.payloadStart, stbl.end));
  }
  const defaults = trex.get(trackId);
  return {
    trackId,
    handler,
    rawProtected,
    protectedByDesc: new Map(),
    isProtectedTrack: rawProtected.size > 0,
    stbl,
    stblSeig,
    defaultDescIndex: defaults?.descIndex ?? 1,
    defaultSampleSize: defaults?.sampleSize ?? 0,
  };
}

/** A representative per-sample IV size for parsing a track's `senc`/aux (the first protected entry's). */
function representativeIvSize(def: TrackDef): number {
  for (const tenc of def.protectedByDesc.values()) return tenc.perSampleIvSize;
  return 0;
}

/** Neutralize a 'seig' `sgpd`/`sbgp` box: rename it to `free` and zero its grouping_type in `out`. */
function neutralizeSeigBox(
  bytes: Uint8Array,
  box: BoxHeader,
  renames: Rename[],
  zeros: number[],
): void {
  const r = new Reader(bytes, box.payloadStart);
  readFullBoxHeader(r);
  if (r.fourcc() !== 'seig') return;
  renames.push({ offset: box.start + 4, fourcc: 'free' });
  zeros.push(box.payloadStart + 4); // grouping_type field (4 bytes)
}

/**
 * Prove the absolute sample writes in one run are in-bounds and disjoint before admitting parallel
 * crypto. Canonical MP4 tables are already offset-ordered, so the common path is allocation-free; only a
 * legal but physically non-monotonic table needs an index sort. Overlap is corrupt because completion
 * order would otherwise decide which recovered ciphertext wins the shared bytes.
 */
function assertIndependentSampleRanges(samples: readonly SampleLoc[], fileSize: number): void {
  let ascending = true;
  let previousStart = Number.NEGATIVE_INFINITY;
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < samples.length; i++) {
    const loc = samples[i];
    if (!loc) continue;
    if (loc.start < 0 || loc.size < 0 || loc.start + loc.size > fileSize) {
      throw new MediaError(
        'demux-error',
        `protected sample ${i} range [${loc.start}, ${loc.start + loc.size}) exceeds file size ${fileSize} (truncated/corrupt mdat)`,
      );
    }
    if (loc.size === 0) continue;
    if (loc.start < previousStart) ascending = false;
    if (ascending && loc.start < previousEnd) {
      throw new MediaError(
        'demux-error',
        `protected sample ${i} overlaps the previous sample range (corrupt sample table)`,
      );
    }
    previousStart = loc.start;
    previousEnd = loc.start + loc.size;
  }
  if (ascending) return;

  const ordered = samples
    .map((loc, index) => ({ loc, index }))
    .filter(({ loc }) => loc.size > 0)
    .sort((a, b) => a.loc.start - b.loc.start);
  previousEnd = Number.NEGATIVE_INFINITY;
  for (const { loc, index } of ordered) {
    if (loc.start < previousEnd) {
      throw new MediaError(
        'demux-error',
        `protected sample ${index} overlaps another sample range (corrupt sample table)`,
      );
    }
    previousEnd = loc.start + loc.size;
  }
}

/** Read a 1–4-byte unsigned big-endian integer without creating a `DataView` per NAL unit. */
function readUnsignedBe(bytes: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) value = value * 256 + (bytes[offset + i] ?? 0);
  return value;
}

/**
 * Whether one flat AVC/HEVC sample is structurally valid clear length-prefixed video. This is stronger
 * than checking its first four bytes: every NAL must exactly consume the sample, have a legal header,
 * and the access unit must contain VCL data.
 */
function isClearLengthPrefixedVideoSample(
  bytes: Uint8Array,
  loc: SampleLoc,
  raw: RawProtection,
): boolean {
  const width = raw.nalLengthSize;
  if (width === undefined) return false;
  const isAvc =
    raw.origFormat === 'avc1' ||
    raw.origFormat === 'avc2' ||
    raw.origFormat === 'avc3' ||
    raw.origFormat === 'avc4';
  const isHevc = raw.origFormat === 'hvc1' || raw.origFormat === 'hev1';
  if (!isAvc && !isHevc) return false;

  let cursor = loc.start;
  const end = loc.start + loc.size;
  let nalCount = 0;
  let sawVcl = false;
  while (cursor + width <= end) {
    const size = readUnsignedBe(bytes, cursor, width);
    cursor += width;
    if (size <= 0 || cursor + size > end) return false;

    const header = bytes[cursor] ?? 0xff;
    if ((header & 0x80) !== 0) return false; // forbidden_zero_bit
    if (isAvc) {
      const type = header & 0x1f;
      if (type === 0 || type > 23) return false;
      if (type <= 5) sawVcl = true;
    } else {
      if (size < 2 || ((bytes[cursor + 1] ?? 0) & 0x07) === 0) return false;
      if (((header >> 1) & 0x3f) <= 31) sawVcl = true;
    }
    cursor += size;
    nalCount += 1;
  }
  return cursor === end && nalCount > 0 && sawVcl;
}

/**
 * Find flat CBCS video descriptions whose payload is demonstrably already clear.
 *
 * Some packagers accept a non-fragmented input for a fragmented-only CBCS operation, emit `encv` /
 * `sinf` / `tenc`, but leave every media byte untouched. With no `senc`, `saiz`, `saio`, or sample
 * groups, genuine CBCS encrypts the first block of each sample; consequently all samples still forming
 * exact AVC/HEVC length-prefixed access units is contradictory proof that only the signalling was
 * applied. Restricting this recovery to constant-IV flat video keeps legitimate constant-IV audio and
 * auxiliary-described video on the normal crypto path.
 */
function alreadyClearCbcsDescriptions(
  bytes: Uint8Array,
  def: TrackDef,
  samples: readonly SampleLoc[],
): Set<number> {
  const clear = new Set<number>();
  if (def.handler !== 'vide') return clear;

  for (const [descIndex, raw] of def.rawProtected) {
    const tenc = def.protectedByDesc.get(descIndex);
    if (
      raw.schemeType !== CBCS_SCHEME ||
      raw.nalLengthSize === undefined ||
      !tenc?.isProtected ||
      tenc.perSampleIvSize !== 0 ||
      !tenc.constantIv
    ) {
      continue;
    }
    let count = 0;
    let valid = true;
    for (const loc of samples) {
      if (loc.descIndex !== descIndex) continue;
      count += 1;
      if (!isClearLengthPrefixedVideoSample(bytes, loc, raw)) {
        valid = false;
        break;
      }
    }
    if (count > 0 && valid) clear.add(descIndex);
  }
  return clear;
}

/**
 * Decrypt one run of samples (a flat `stbl` chunk sequence or one `traf`) into `ctx.out`. Each sample's
 * protection is the `tenc` default of its sample description, optionally overridden by an `sbgp`/`sgpd`
 * 'seig' group (which may mark it clear or rotate the key/IV/pattern). The per-sample IV + subsample map
 * come from `senc`, then `saiz`/`saio` aux, then the `default_constant_IV`. Clear samples pass through.
 */
async function decryptSampleRun(ctx: RunContext, samples: SampleLoc[]): Promise<void> {
  assertIndependentSampleRanges(samples, ctx.bytes.byteLength);
  await forEachSampleBounded(samples, async (loc, si) => {
    const tenc = ctx.protectedByDesc.get(loc.descIndex);
    if (!tenc) return; // this sample uses a clear sample description → leave untouched

    let kid = tenc.kid;
    let pattern = tenc.pattern;
    let constantIv = tenc.constantIv;
    if (ctx.sbgp) {
      const groupIndex = groupIndexAt(ctx.sbgp, si);
      if (groupIndex !== 0) {
        const group = resolveSeigGroup(groupIndex, ctx.trafSeig, ctx.stblSeig);
        if (group.isProtected === 0) return; // group is unprotected → sample stays clear
        if (group.isProtected !== 1) {
          throw new MediaError(
            'demux-error',
            `seig sample group declares reserved isProtected value ${group.isProtected}`,
          );
        }
        kid = group.kid;
        pattern = group.pattern;
        constantIv = group.constantIv;
      }
    }

    const key = await ctx.resolveKey(kid);

    let iv: Uint8Array | undefined;
    let subsamples: Subsample[] | undefined;
    const perSample = ctx.senc?.[si] ?? ctx.aux?.[si];
    if (ctx.senc || ctx.aux) {
      if (!perSample) {
        throw new MediaError('demux-error', `protected sample ${si} has no senc/aux entry`);
      }
      subsamples = perSample.subsamples;
      iv = perSample.iv.byteLength > 0 ? perSample.iv : constantIv;
    } else {
      // With Per_Sample_IV_Size 0, `tenc.default_constant_IV` is the IV for every protected sample; no
      // per-sample auxiliary entry is required. Clear sample descriptions and `seig isProtected = 0`
      // groups returned above, so reaching this branch means the sample must be decrypted.
      iv = constantIv;
    }
    if (!iv || iv.byteLength === 0) {
      throw new MediaError(
        'demux-error',
        `protected sample ${si} has no IV (no senc/saio aux data and no default_constant_IV)`,
      );
    }

    const data = ctx.bytes.subarray(loc.start, loc.start + loc.size);
    const clear =
      ctx.scheme === CBCS_SCHEME
        ? await decryptSampleCbcsPrepared(
            key,
            pattern ?? DEFAULT_FULL_PATTERN,
            iv,
            data,
            subsamples,
          )
        : ctx.scheme === CENS_SCHEME
          ? await decryptSampleCensPrepared(
              key,
              pattern ?? DEFAULT_FULL_PATTERN,
              sencSample(iv, subsamples),
              data,
            )
          : await decryptSamplePrepared(key, sencSample(iv, subsamples), data);
    ctx.out.set(clear, loc.start);
  });
}

/**
 * Decrypt every CENC-protected sample of a complete MP4/CMAF byte buffer under `scheme`, returning a new
 * buffer of identical length with the ciphertext samples replaced by cleartext and the protection
 * signalling neutralized (so the output probes as a clear file). Flat (`stbl`) and fragmented (`moof`)
 * layouts, constant-IV / per-sample-IV / `saiz`-located IVs, 'seig' sample-group overrides, patterned and
 * full-sample encryption, and mixed clear/encrypted content are all handled. Corrupt or contradictory
 * protection rejects with a typed {@link MediaError}; an unsupported capability with a
 * {@link CapabilityError}; and an incomplete caller key map with an {@link InputError}.
 */
export async function decryptCencFile(
  input: Uint8Array,
  opts: DecryptFileOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = input;
  const out = input.slice();

  const moov = findChild(bytes, 0, bytes.byteLength, 'moov');
  if (!moov) throw new MediaError('demux-error', 'no moov box (not an MP4/CMAF file)');

  const trex = parseTrex(bytes, moov);
  const tracks = new Map<number, TrackDef>();
  for (const trak of findChildren(bytes, moov.payloadStart, moov.end, 'trak')) {
    const def = parseTrak(bytes, trak, trex);
    if (def) tracks.set(def.trackId, def);
  }

  const renames: Rename[] = [];
  const zeros: number[] = [];

  // Validate each protected sample entry's scheme, parse its tenc, and queue protection-box neutralization.
  let anyProtected = false;
  for (const def of tracks.values()) {
    for (const [descIndex, raw] of def.rawProtected) {
      anyProtected = true;
      if (
        raw.schemeType !== CENC_SCHEME &&
        raw.schemeType !== CENS_SCHEME &&
        raw.schemeType !== CBCS_SCHEME
      ) {
        throw new CapabilityError(`unsupported MP4 protection scheme '${raw.schemeType}'`, {
          op: { kind: 'route', id: 'decrypt' },
          tried: ['mp4'],
        });
      }
      if (raw.schemeType !== opts.scheme) {
        throw new MediaError(
          'demux-error',
          `track ${def.trackId} is ${raw.schemeType}, not the requested ${opts.scheme}`,
        );
      }
      def.protectedByDesc.set(descIndex, parseTenc(raw.rawTenc, opts.scheme));
      renames.push({ offset: raw.renameOffset, fourcc: raw.origFormat });
      renames.push({ offset: raw.sinfOffset + 4, fourcc: 'free' });
    }
    if (def.isProtectedTrack && def.stbl) {
      for (const box of findChildren(bytes, def.stbl.payloadStart, def.stbl.end, 'sgpd'))
        neutralizeSeigBox(bytes, box, renames, zeros);
      for (const box of findChildren(bytes, def.stbl.payloadStart, def.stbl.end, 'sbgp'))
        neutralizeSeigBox(bytes, box, renames, zeros);
    }
  }
  if (!anyProtected) return out; // genuinely clear file → an identical copy is the correct result

  const keyCache = new Map<string, Promise<PreparedAesKey>>();
  const resolveKey = (kid: Uint8Array): Promise<PreparedAesKey> => {
    const id = kidHex(kid);
    const cached = keyCache.get(id);
    if (cached) return cached;
    const hex = opts.keys[id];
    if (hex === undefined) {
      throw new InputError(`no key provided for KID ${id}`, { kid: id });
    }
    const raw = hexToBytes(hex);
    const prepared =
      opts.scheme === CBCS_SCHEME
        ? prepareAesCbcKey(raw, 'no-padding-decrypt')
        : prepareAesCtrKey(raw);
    // Store the in-flight import promise before returning so concurrent samples with one KID share it.
    keyCache.set(id, prepared);
    return prepared;
  };

  const seen = new Map<number, number>();
  const addSeen = (trackId: number, n: number): void => {
    seen.set(trackId, (seen.get(trackId) ?? 0) + n);
  };

  // ── Flat (non-fragmented) tracks: samples indexed by stbl tables. ──
  for (const def of tracks.values()) {
    if (!def.isProtectedTrack || !def.stbl) continue;
    const samples = buildFlatSamples(bytes, def.stbl);
    if (samples.length === 0) continue; // empty stbl ⇒ fragmented; handled by the moof pass
    const ivSize = representativeIvSize(def);
    const sencBox = findChild(bytes, def.stbl.payloadStart, def.stbl.end, 'senc');
    const saiz = findChild(bytes, def.stbl.payloadStart, def.stbl.end, 'saiz');
    const saio = findChild(bytes, def.stbl.payloadStart, def.stbl.end, 'saio');
    // After decrypt the samples are clear, so the sample-auxiliary-info boxes must be neutralized too:
    // a leftover `saiz`/`saio` still advertises per-sample crypto aux, which a CENC-aware demuxer can read
    // as "this track is still encrypted" and mis-drive decode. Rename them to `free` (size-preserving),
    // exactly like `senc`/`sinf` (mp4decrypt removes them outright).
    if (saiz) renames.push({ offset: saiz.start + 4, fourcc: 'free' });
    if (saio) renames.push({ offset: saio.start + 4, fourcc: 'free' });
    let senc: SencSample[] | undefined;
    let aux: SencSample[] | undefined;
    if (sencBox) {
      senc = parseSenc(bytes.subarray(sencBox.payloadStart, sencBox.end), ivSize, opts.scheme);
      renames.push({ offset: sencBox.start + 4, fourcc: 'free' });
    } else if (saiz && saio) {
      const offsets = parseSaioOffsets(bytes, saio);
      if (offsets.length !== 1) {
        throw new CapabilityError('multi-entry saio is not supported', {
          op: { kind: 'route', id: 'decrypt' },
          tried: ['mp4'],
        });
      }
      aux = parseAuxSamples(bytes, offsets[0] ?? 0, parseSaizSizes(bytes, saiz), ivSize);
    }
    const hasSampleGroups =
      findChild(bytes, def.stbl.payloadStart, def.stbl.end, 'sgpd') !== undefined ||
      findChild(bytes, def.stbl.payloadStart, def.stbl.end, 'sbgp') !== undefined;
    const alreadyClear =
      opts.scheme === CBCS_SCHEME && !sencBox && !saiz && !saio && !hasSampleGroups
        ? alreadyClearCbcsDescriptions(bytes, def, samples)
        : new Set<number>();
    const protectedByDesc =
      alreadyClear.size === 0
        ? def.protectedByDesc
        : new Map([...def.protectedByDesc].filter(([descIndex]) => !alreadyClear.has(descIndex)));
    await decryptSampleRun(
      {
        bytes,
        out,
        scheme: opts.scheme,
        protectedByDesc,
        resolveKey,
        senc,
        aux,
        sbgp: undefined,
        trafSeig: [],
        stblSeig: def.stblSeig,
      },
      samples,
    );
    addSeen(def.trackId, samples.length);
  }

  // ── Fragmented tracks: samples located per traf via tfhd/trun, aux via senc or saiz/saio. ──
  for (const moof of findChildren(bytes, 0, bytes.byteLength, 'moof')) {
    let lastDataEnd = 0;
    const trafs = findChildren(bytes, moof.payloadStart, moof.end, 'traf');
    for (let ti = 0; ti < trafs.length; ti++) {
      const traf = trafs[ti];
      if (!traf) continue;
      const tfhd = findChild(bytes, traf.payloadStart, traf.end, 'tfhd');
      const trun = findChild(bytes, traf.payloadStart, traf.end, 'trun');
      if (!tfhd || !trun) continue;
      const tf = parseTfhd(bytes, tfhd);
      const def = tracks.get(tf.trackId);

      let base: number;
      if (tf.baseDataOffset !== undefined) base = tf.baseDataOffset;
      else if (tf.flags & TFHD_DEFAULT_BASE_IS_MOOF) base = moof.start;
      else base = ti === 0 ? moof.start : lastDataEnd;

      const defaultSampleSize = tf.defaultSampleSize ?? def?.defaultSampleSize ?? 0;
      const run = parseTrun(bytes, trun, defaultSampleSize);
      const dataStart = base + (run.hasDataOffset ? run.dataOffset : 0);
      const descIndex = tf.sampleDescIndex ?? def?.defaultDescIndex ?? 1;
      const samples: SampleLoc[] = [];
      let cursor = dataStart;
      for (const size of run.sizes) {
        samples.push({ start: cursor, size, descIndex });
        cursor += size;
      }
      lastDataEnd = cursor;
      if (!def || !def.isProtectedTrack) continue; // clear track → samples untouched

      const protEntry = def.protectedByDesc.get(descIndex);
      let senc: SencSample[] | undefined;
      let aux: SencSample[] | undefined;
      const sgpd = findChild(bytes, traf.payloadStart, traf.end, 'sgpd');
      const sbgpBox = findChild(bytes, traf.payloadStart, traf.end, 'sbgp');
      if (protEntry) {
        const ivSize = protEntry.perSampleIvSize;
        const sencBox = findChild(bytes, traf.payloadStart, traf.end, 'senc');
        const saiz = findChild(bytes, traf.payloadStart, traf.end, 'saiz');
        const saio = findChild(bytes, traf.payloadStart, traf.end, 'saio');
        // Neutralize the per-fragment sample-auxiliary-info boxes too (see the flat path): a leftover
        // `saiz`/`saio` advertises crypto aux a CENC-aware demuxer can act on after the samples are clear.
        if (saiz) renames.push({ offset: saiz.start + 4, fourcc: 'free' });
        if (saio) renames.push({ offset: saio.start + 4, fourcc: 'free' });
        if (sencBox) {
          senc = parseSenc(bytes.subarray(sencBox.payloadStart, sencBox.end), ivSize, opts.scheme);
          renames.push({ offset: sencBox.start + 4, fourcc: 'free' });
        } else if (saiz && saio) {
          const offsets = parseSaioOffsets(bytes, saio);
          if (offsets.length !== 1) {
            throw new CapabilityError('multi-entry saio is not supported', {
              op: { kind: 'route', id: 'decrypt' },
              tried: ['mp4'],
            });
          }
          aux = parseAuxSamples(
            bytes,
            base + (offsets[0] ?? 0),
            parseSaizSizes(bytes, saiz),
            ivSize,
          );
        }
      }
      if (sgpd) neutralizeSeigBox(bytes, sgpd, renames, zeros);
      if (sbgpBox) neutralizeSeigBox(bytes, sbgpBox, renames, zeros);

      await decryptSampleRun(
        {
          bytes,
          out,
          scheme: opts.scheme,
          protectedByDesc: def.protectedByDesc,
          resolveKey,
          senc,
          aux,
          sbgp: sbgpBox ? parseSbgp(bytes, sbgpBox) : undefined,
          trafSeig: sgpd ? parseSeigGroups(bytes, sgpd) : [],
          stblSeig: def.stblSeig,
        },
        samples,
      );
      addSeen(tf.trackId, samples.length);
    }
  }

  for (const def of tracks.values()) {
    if (def.isProtectedTrack && (seen.get(def.trackId) ?? 0) === 0) {
      throw new MediaError(
        'demux-error',
        `${opts.scheme} track ${def.trackId} has no decryptable samples`,
      );
    }
  }

  for (const { offset, fourcc } of renames) {
    for (let i = 0; i < 4; i++) out[offset + i] = fourcc.charCodeAt(i) & 0xff;
  }
  for (const offset of zeros) out.fill(0, offset, offset + 4);
  return out;
}
