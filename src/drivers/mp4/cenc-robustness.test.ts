/**
 * CENC (`cenc` / AES-CTR) decrypt robustness — malformed/mutated protected input must REJECT cleanly with
 * a typed {@link MediaError} rather than emit (wrong) output (BUILD_INSTRUCTIONS §6.2 robustness; ADR-023).
 *
 * The acceptance harness (`../media-test/media-browser-test`) gates three malformed CENC-CTR fixtures with
 * the `graceful-failure` oracle, which FAILs an engine that returns an output blob for the mangled input
 * (a thrown/rejected typed error → PASS; an output → FAIL). These are the exact failing scenarios:
 *   - encryption/cenc_ctr_protection_zeroed_graceful  (cenc_ctr_protection_zeroed.mp4)
 *   - encryption/cenc_ctr_senc_bitflip_graceful       (cenc_ctr_senc_bitflip.mp4)
 *   - encryption/cenc_ctr_truncated_mdat_graceful     (cenc_ctr_truncated_mdat.mp4)
 *
 * The three baked fixtures are FRAGMENTED CMAF (tiny `moov`; per-sample `senc`/`saiz`/`saio` + sample
 * sizes in `moof/traf`) — NOT byte-mutations of the current non-fragmented `cenc_ctr.mp4` source, so they
 * cannot be reproduced by mutating that source in memory. The faithful test therefore loads the ACTUAL
 * baked fixtures (the literal bytes the harness feeds) and asserts decrypt rejects each; the clean
 * `cenc_ctr.mp4` must still decrypt (positive case). The root cause they exercise: a CENC-protected track
 * whose per-sample encryption data is not in `moov` was passed through as if clear, emitting a sample-less
 * blob; decrypt now rejects such an undecryptable protected track. (If the sibling harness corpus is not
 * present these load-from-harness cases skip; the in-memory structural cases below always run.)
 *
 * In-memory structural coverage (self-contained, on `encryptCenc(movie_5.mp4)` — the P1.13 inverse): the
 * non-fragmented analogues — zeroed `senc`, truncated mdat (ranges past EOF), and a structurally
 * bit-flipped `senc` — plus `parseTenc`/`parseSenc` unit tests covering both arms of every guard.
 *
 * A rejection here is a corrupt-INPUT rejection, so the typed error is {@link MediaError} (`demux-error`),
 * never a {@link CapabilityError} — every case asserts it throws a `MediaError` and is NOT a `CapabilityError`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { encryptCenc } from '../../test-support/cenc-encrypt.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { parseSenc, parseTenc } from './cenc.ts';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';

/** The sibling acceptance harness's verified CENC corpus (its prebaked, git-ignored fixtures). */
const HARNESS_MEDIA_DIR = new URL(
  '../../../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;
/** The golden key/KID for `cenc_ctr.mp4` (mirrors fixtures/golden/cenc_ctr.mp4.keys.json in the harness). */
const HARNESS_KEY = '00112233445566778899aabbccddeeff';
const HARNESS_KID = '11223344556677889900aabbccddeeff';

function harnessFixture(name: string): Uint8Array | undefined {
  const path = `${HARNESS_MEDIA_DIR}${name}`;
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
}

/** Run `decrypt` to completion; resolve with the output bytes, or reject (surfacing the thrown error). */
async function decryptHarness(bytes: Uint8Array): Promise<Uint8Array> {
  const out = await createMedia().decrypt(fromBytes(bytes, { mime: 'video/mp4' }), {
    scheme: 'cenc',
    keys: { [HARNESS_KID]: HARNESS_KEY },
  });
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}

const KEY = '000102030405060708090a0b0c0d0e0f';
const KID = '00112233445566778899aabbccddeeff';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});
const encSource = (bytes: Uint8Array) => fromBytes(bytes, { mime: 'video/mp4' });

/** The audio track's per-sample byte arrays — the bit-exact regression oracle target. */
async function audioSamples(mp4: Uint8Array): Promise<Uint8Array[]> {
  const movie = await readMovie(ra(mp4));
  const tracks = await muxTracksFromMovie(ra(mp4), movie);
  const idx = movie.tracks.findIndex((t) => t.mediaType === 'audio');
  return (tracks[idx]?.samples ?? []).map((s) => s.data);
}

async function decryptBytes(mp4: Uint8Array): Promise<Uint8Array> {
  const out = await createMedia().decrypt(encSource(mp4), { scheme: 'cenc', keys: { [KID]: KEY } });
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}

/** Locate a top-level/`stbl` four-cc box by signature scan; returns `[boxStart, payloadStart, boxEnd]`. */
function locateBox(
  bytes: Uint8Array,
  type: string,
): { start: number; payload: number; end: number } {
  const dec = new TextDecoder('latin1');
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if (dec.decode(bytes.subarray(i, i + 4)) !== type) continue;
    const start = i - 4;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = dv.getUint32(start);
    if (size >= 8 && start + size <= bytes.length) {
      return { start, payload: i + 4, end: start + size };
    }
  }
  throw new Error(`box '${type}' not found in fixture`);
}

/** Deterministic PRNG (mirrors fixtures/bake.mjs `mulberry32`) so flips/spans are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** (a) protection zeroed — erase the whole `senc` payload (mirrors bake "protection_zeroed" intent). */
function zeroProtection(enc: Uint8Array): Uint8Array {
  const out = enc.slice();
  const senc = locateBox(out, 'senc');
  out.fill(0, senc.payload, senc.end);
  return out;
}

/** (b) truncated mdat — keep the first 60% (verbatim bake `truncateTailFixture(0.6)`). */
function truncateMdat(enc: Uint8Array): Uint8Array {
  return enc.slice(0, Math.max(0, Math.floor(enc.length * 0.6)));
}

/**
 * (c) senc bit-flipped — mangle the `senc` box's protection metadata (mirrors bake "senc_bitflip").
 *
 * The bake flips 96 bits across the fragmented asset's moof, where `senc` IVs are densely interleaved
 * with `saiz`/`saio` sizes/offsets and box headers, so the flips reliably corrupt STRUCTURAL bytes (not
 * just IVs). This faithfully reproduces that on a non-fragmented `senc`: it flips the box's structural
 * fields — `version+flags` and the 4-byte `sample_count` — plus a spread of IV bytes. (A bit-flip
 * confined to IV bytes alone is structurally indistinguishable from a different valid IV and is correctly
 * NOT a structural reject — it is the "wrong key/IV → garbage" class, not "malformed metadata"; the
 * harness's reject signal is the corruption of the box structure, which is what is reproduced here.)
 */
function bitflipSenc(enc: Uint8Array, seed = 0x5e9c01): Uint8Array {
  const out = enc.slice();
  const senc = locateBox(out, 'senc');
  const rnd = mulberry32(seed);
  // Flip the high bit of sample_count (payload[4]) so the declared count balloons → IVs overrun the box.
  out[senc.payload + 4] = (out[senc.payload + 4] ?? 0) ^ 0x80;
  // version+flags byte, and a spread of payload bytes, for a faithful many-bit senc-box corruption.
  out[senc.payload] = (out[senc.payload] ?? 0) ^ 0x01;
  const span = senc.end - senc.payload;
  for (let i = 0; i < 32; i++) {
    const pos = senc.payload + Math.floor(rnd() * span);
    out[pos] = (out[pos] ?? 0) ^ (1 << Math.floor(rnd() * 8));
  }
  return out;
}

// ── PRIMARY: the exact prebaked harness fixtures (the literal bytes the failing scenarios feed) ──
const harnessAvailable = harnessFixture('cenc_ctr.mp4') !== undefined;
const describeHarness = harnessAvailable ? describe : describe.skip;
if (!harnessAvailable) {
  // eslint-disable-next-line no-console -- a skipped suite must announce why (corpus is git-ignored).
  console.warn(
    `[cenc-robustness] sibling harness corpus not found at ${HARNESS_MEDIA_DIR}; the load-from-harness reject cases are skipped (in-memory structural cases still run).`,
  );
}

describeHarness(
  'media.decrypt — CENC robustness on the ACTUAL harness fixtures (graceful-failure)',
  () => {
    it('the clean cenc_ctr.mp4 still decrypts and produces an MP4 (positive case, not regressed)', async () => {
      const clean = harnessFixture('cenc_ctr.mp4');
      expect(clean).toBeDefined();
      if (!clean) return;
      const out = await decryptHarness(clean);
      expect(out.byteLength).toBeGreaterThan(0);
      // The output re-parses as a real MP4 (sanity: we did real work, not throw).
      await expect(readMovie(ra(out))).resolves.toBeDefined();
    });

    for (const name of [
      'cenc_ctr_protection_zeroed.mp4',
      'cenc_ctr_senc_bitflip.mp4',
      'cenc_ctr_truncated_mdat.mp4',
    ]) {
      it(`rejects ${name} with a typed MediaError (not a CapabilityError) → graceful-failure passes`, async () => {
        const bytes = harnessFixture(name);
        expect(bytes).toBeDefined();
        if (!bytes) return;
        const err = await decryptHarness(bytes).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(MediaError);
        expect(err).not.toBeInstanceOf(CapabilityError);
      });
    }
  },
);

describe('media.decrypt — CENC robustness: malformed protection rejects cleanly (ADR-023, §6.2)', () => {
  it('happy path: the UNmutated encrypted file still decrypts the audio bit-exact (regression)', async () => {
    const clear = await loadFixture('movie_5.mp4');
    const enc = await encryptCenc(clear, { keyHex: KEY, kidHex: KID });
    const clearAudio = await audioSamples(clear);
    expect(clearAudio.length).toBeGreaterThan(10);
    expect(await audioSamples(enc)).not.toEqual(clearAudio); // real ciphertext
    expect(await audioSamples(await decryptBytes(enc))).toEqual(clearAudio);
  });

  it('rejects zeroed protection metadata with a typed MediaError (not a CapabilityError)', async () => {
    const enc = await encryptCenc(await loadFixture('movie_5.mp4'), { keyHex: KEY, kidHex: KID });
    const mutated = zeroProtection(enc);
    expect(mutated).not.toEqual(enc); // the mutation actually changed bytes
    const err = await decryptBytes(mutated).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('rejects a truncated mdat (sample ranges exceed the file) with a typed MediaError', async () => {
    const enc = await encryptCenc(await loadFixture('movie_5.mp4'), { keyHex: KEY, kidHex: KID });
    const mutated = truncateMdat(enc);
    expect(mutated.length).toBeLessThan(enc.length);
    const err = await decryptBytes(mutated).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('rejects a bit-flipped senc box with a typed MediaError (not a CapabilityError)', async () => {
    const enc = await encryptCenc(await loadFixture('movie_5.mp4'), { keyHex: KEY, kidHex: KID });
    const mutated = bitflipSenc(enc);
    expect(mutated).not.toEqual(enc);
    const err = await decryptBytes(mutated).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });
});

describe('parseTenc — structural validation (both arms of every guard)', () => {
  /** A valid `tenc` payload: version+flags, reserved, pattern, isProtected, ivSize, 16-byte KID. */
  function tencPayload(opts: {
    protected: boolean;
    ivSize: number;
    kidZero?: boolean;
  }): Uint8Array {
    const p = new Uint8Array(24);
    p[6] = opts.protected ? 1 : 0;
    p[7] = opts.ivSize;
    if (!opts.kidZero) for (let i = 8; i < 24; i++) p[i] = i; // non-zero KID
    return p;
  }

  it('accepts a well-formed protected tenc (ivSize 8 or 16, non-zero KID)', () => {
    expect(parseTenc(tencPayload({ protected: true, ivSize: 8 })).perSampleIvSize).toBe(8);
    expect(parseTenc(tencPayload({ protected: true, ivSize: 16 })).perSampleIvSize).toBe(16);
  });

  it('accepts an unprotected tenc regardless of ivSize/KID (no protection claimed)', () => {
    expect(parseTenc(tencPayload({ protected: false, ivSize: 0, kidZero: true })).isProtected).toBe(
      false,
    );
  });

  it('rejects a too-short tenc box', () => {
    expect(() => parseTenc(new Uint8Array(10))).toThrow(MediaError);
  });

  it('rejects a protected tenc with an illegal per-sample IV size (0 / 7 / 17)', () => {
    for (const ivSize of [0, 7, 17]) {
      expect(() => parseTenc(tencPayload({ protected: true, ivSize }))).toThrow(MediaError);
    }
  });

  it('rejects a protected tenc whose default KID is all zero (zeroed protection)', () => {
    expect(() => parseTenc(tencPayload({ protected: true, ivSize: 8, kidZero: true }))).toThrow(
      MediaError,
    );
  });
});

describe('parseSenc — structural validation (both arms of every guard)', () => {
  /** A valid `senc` payload: version+flags(=`flags`), sample_count, then `count` IVs of `ivSize` bytes. */
  function sencPayload(count: number, ivSize: number, flags = 0): Uint8Array {
    const p = new Uint8Array(8 + count * ivSize);
    const dv = new DataView(p.buffer);
    dv.setUint8(1, (flags >> 16) & 0xff);
    dv.setUint8(2, (flags >> 8) & 0xff);
    dv.setUint8(3, flags & 0xff);
    dv.setUint32(4, count);
    for (let i = 0; i < count * ivSize; i++) p[8 + i] = (i % 251) + 1; // non-zero IV bytes
    return p;
  }

  it('accepts a well-formed senc (count*ivSize fits exactly)', () => {
    const samples = parseSenc(sencPayload(3, 8), 8);
    expect(samples).toHaveLength(3);
    expect(samples[0]?.iv.length).toBe(8);
  });

  it('rejects an unsupported per-sample IV size (0)', () => {
    expect(() => parseSenc(sencPayload(1, 16), 0)).toThrow(MediaError);
  });

  it('rejects a too-short senc box (< 8-byte header)', () => {
    expect(() => parseSenc(new Uint8Array(4), 8)).toThrow(MediaError);
  });

  it('rejects a sample_count whose IVs overrun the payload (truncated/bit-flipped count)', () => {
    const p = sencPayload(3, 8); // payload sized for 3 IVs
    new DataView(p.buffer).setUint32(4, 9999); // claim far more → IVs overrun
    expect(() => parseSenc(p, 8)).toThrow(MediaError);
  });

  it('rejects a senc whose subsample data overruns the payload', () => {
    // flags bit 0x02 ⇒ subsamples; one sample, one IV, then a subsample count that overruns.
    const p = new Uint8Array(8 + 8 + 2);
    const dv = new DataView(p.buffer);
    dv.setUint8(3, 0x02); // useSubsamples
    dv.setUint32(4, 1); // one sample
    for (let i = 0; i < 8; i++) p[8 + i] = i + 1; // IV
    dv.setUint16(16, 5); // 5 subsamples declared, but 0 bytes follow → overrun
    expect(() => parseSenc(p, 8)).toThrow(MediaError);
  });
});
