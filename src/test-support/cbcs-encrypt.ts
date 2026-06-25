/**
 * Test-only CENC `cbcs` (AES-CBC **pattern**) encryptor — produces a real cbcs-protected MP4 from a
 * clear one so the decrypt op can be validated end-to-end on real media (the inverse of the driver's
 * cbcs path). Not shipped (test-support only). It encrypts one media type's samples with a per-sample
 * 16-byte IV and the crypt:skip pattern, re-muxes via {@link writeMp4} as a protected track, then patches
 * the written `tenc` to version 1 + the pattern byte (a same-length byte edit — `writeMp4` emits a
 * version-0 `tenc` with a zero pattern, which it does not let us set otherwise).
 *
 * The crypt-block gather/scatter here re-derives the exact offsets the SUT uses (`decryptSampleCbcs`); if
 * they disagreed, the byte-exact round-trip in the tests would fail — so this is a genuine oracle, not a
 * self-fulfilling mirror.
 */

import { AES_BLOCK, aesCbcNoPadding, hexToBytes } from '../crypto/aes.ts';
import { muxTracksFromMovie, readMovie } from '../drivers/mp4/mp4-driver.ts';
import { type MuxTrackInput, writeMp4 } from '../drivers/mp4/write.ts';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

/** A distinct, non-zero 16-byte IV per sample index (cbcs uses a full 16-byte IV). */
export function cbcsIvFor(i: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(AES_BLOCK);
  new DataView(iv.buffer).setUint32(12, i + 1);
  return iv;
}

/** Byte offsets of the crypt blocks of a crypt:skip pattern within a protected range (mirrors the SUT). */
function cryptBlockOffsets(protectedLen: number, crypt: number, skip: number): number[] {
  const wholeBlocks = Math.floor(protectedLen / AES_BLOCK);
  const cycle = crypt + skip;
  const offsets: number[] = [];
  for (let b = 0; b < wholeBlocks; b++) {
    if (cycle === 0 || b % cycle < crypt) offsets.push(b * AES_BLOCK);
  }
  return offsets;
}

/**
 * AES-CBC-pattern-**encrypt** one sample (the inverse of the driver's `decryptSampleCbcs`): gather the
 * crypt blocks of each protected range, CBC-encrypt them as one stream seeded with `iv` (reset per
 * protected subsample), and scatter back. Whole-sample protected data (no subsample map) is one range.
 */
export async function encryptSampleCbcs(
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
  data: Uint8Array,
  crypt: number,
  skip: number,
  subsamples?: ReadonlyArray<{ clear: number; protected: number }>,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = data.slice();
  const ranges =
    subsamples && subsamples.length > 0 ? subsamples : [{ clear: 0, protected: data.byteLength }];
  let pos = 0;
  for (const ss of ranges) {
    pos += ss.clear;
    const base = pos;
    const offsets = cryptBlockOffsets(ss.protected, crypt, skip);
    if (offsets.length > 0) {
      const gathered = new Uint8Array(offsets.length * AES_BLOCK);
      offsets.forEach((off, i) =>
        gathered.set(data.subarray(base + off, base + off + AES_BLOCK), i * AES_BLOCK),
      );
      const cipher = await aesCbcNoPadding(key, iv, gathered, 'encrypt');
      offsets.forEach((off, i) =>
        out.set(cipher.subarray(i * AES_BLOCK, i * AES_BLOCK + AES_BLOCK), base + off),
      );
    }
    pos += ss.protected;
  }
  return out;
}

/** Locate a four-cc box by signature scan; returns the box start (its 4-byte size field). */
function findBox(bytes: Uint8Array, type: string): number {
  const dec = new TextDecoder('latin1');
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if (dec.decode(bytes.subarray(i, i + 4)) !== type) continue;
    const start = i - 4;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = dv.getUint32(start);
    if (size >= 8 && start + size <= bytes.length) return start;
  }
  throw new Error(`box '${type}' not found in written MP4`);
}

/** Patch a version-0 `tenc` (as `writeMp4` emits) to version 1 with the crypt:skip pattern byte. */
function patchTencPattern(mp4: Uint8Array, crypt: number, skip: number): Uint8Array {
  const out = mp4.slice();
  const tencStart = findBox(out, 'tenc');
  const payload = tencStart + 8; // after the 8-byte box header → version+flags+fields
  out[payload] = 1; // version 0 → 1 (so the pattern byte is read)
  out[payload + 5] = ((crypt & 0x0f) << 4) | (skip & 0x0f); // default_crypt_byte_block / default_skip_byte_block
  return out;
}

export interface EncryptCbcsOptions {
  keyHex: string;
  kidHex: string;
  /** crypt:skip block pattern (e.g. 1:9). `skip === 0` ⇒ full CBC of every whole block. */
  cryptByteBlock: number;
  skipByteBlock: number;
  mediaType?: 'audio' | 'video';
}

/** Encrypt the chosen track type of a clear MP4 with CENC `cbcs` (AES-CBC pattern), returning MP4 bytes. */
export async function encryptCbcs(
  clearMp4: Uint8Array,
  opts: EncryptCbcsOptions,
): Promise<Uint8Array> {
  const movie = await readMovie(ra(clearMp4));
  const tracks = await muxTracksFromMovie(ra(clearMp4), movie);
  const key = hexToBytes(opts.keyHex);
  const kid = hexToBytes(opts.kidHex);
  const target = opts.mediaType ?? 'audio';

  const out: MuxTrackInput[] = [];
  for (const [i, parsed] of movie.tracks.entries()) {
    const track = tracks[i];
    if (!track) continue;
    if (parsed.mediaType !== target) {
      out.push(track);
      continue;
    }
    const ivs = track.samples.map((_, j) => cbcsIvFor(j));
    const cipher = await Promise.all(
      track.samples.map((s, j) =>
        encryptSampleCbcs(
          key,
          ivs[j] ?? cbcsIvFor(j),
          s.data,
          opts.cryptByteBlock,
          opts.skipByteBlock,
        ),
      ),
    );
    out.push({
      ...track,
      encryption: { schemeType: 'cbcs', kid, perSampleIvSize: AES_BLOCK, ivs },
      samples: track.samples.map((s, j) => ({ ...s, data: cipher[j] ?? s.data })),
    });
  }
  return patchTencPattern(
    writeMp4(out, { faststart: true }),
    opts.cryptByteBlock,
    opts.skipByteBlock,
  );
}
