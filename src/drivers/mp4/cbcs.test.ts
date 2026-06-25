/**
 * CENC `cbcs` (AES-CBC **pattern**) decrypt — end-to-end on REAL media, plus HLS `AES-128` full-segment
 * via the MP4 driver. The strict oracle is a byte-exact encrypt→decrypt round-trip (the inverse of the
 * driver's cbcs path): encrypt a real fixture's samples with cbcs, decrypt through the public op, and
 * assert the recovered sample bytes equal the originals — a can't-fake gate (cipher ≠ clear, wrong-key ≠
 * clear). Coverage spans the crypt:skip pattern (1:9 and full 1:0), subsample boundaries (real video
 * bytes), constant-IV / pattern `tenc` parsing, and a robustness reject (ADR-023, §6.2).
 */

import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { hexToBytes } from '../../crypto/aes.ts';
import { fromBytes } from '../../sources/source.ts';
import { encryptCbcs, encryptSampleCbcs } from '../../test-support/cbcs-encrypt.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import {
  type CencPattern,
  decryptSampleCbcs,
  decryptSamplesCbcs,
  parseSenc,
  parseTenc,
} from './cenc.ts';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';

const KEY = '000102030405060708090a0b0c0d0e0f';
const KID = '00112233445566778899aabbccddeeff';
const WRONG = 'ffeeddccbbaa99887766554433221100';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});
const encSource = (bytes: Uint8Array) => fromBytes(bytes, { mime: 'video/mp4' });

/** The chosen track type's per-sample byte arrays — the bit-exact regression oracle target. */
async function trackSamples(mp4: Uint8Array, type: 'audio' | 'video'): Promise<Uint8Array[]> {
  const movie = await readMovie(ra(mp4));
  const tracks = await muxTracksFromMovie(ra(mp4), movie);
  const idx = movie.tracks.findIndex((t) => t.mediaType === type);
  return (tracks[idx]?.samples ?? []).map((s) => s.data);
}

async function decryptBytes(mp4: Uint8Array, keyHex = KEY): Promise<Uint8Array> {
  const out = await createMedia().decrypt(encSource(mp4), {
    scheme: 'cbcs',
    keys: { [KID]: keyHex },
  });
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}

describe('media.decrypt — CENC cbcs (AES-CBC pattern) round-trips real media bit-exact', () => {
  for (const pattern of [
    { cryptByteBlock: 1, skipByteBlock: 9 }, // the canonical Apple/HLS cbcs 1:9 pattern
    { cryptByteBlock: 1, skipByteBlock: 0 }, // full CBC of every whole block (skip 0)
    { cryptByteBlock: 5, skipByteBlock: 5 }, // a different cycle, to exercise phase arithmetic
  ]) {
    it(`recovers movie_5.mp4 audio for pattern ${pattern.cryptByteBlock}:${pattern.skipByteBlock}`, async () => {
      const clear = await loadFixture('movie_5.mp4');
      const enc = await encryptCbcs(clear, { keyHex: KEY, kidHex: KID, ...pattern });
      const clearAudio = await trackSamples(clear, 'audio');
      expect(clearAudio.length).toBeGreaterThan(10); // diverse, multi-sample

      const cipherAudio = await trackSamples(enc, 'audio');
      // Real encryption, non-vacuously: the MAJORITY of samples (those with ≥1 full crypt block under the
      // pattern) actually differ from cleartext — guards against a no-op "encrypt" trivially passing.
      const changed = cipherAudio.filter((c, j) => {
        const o = clearAudio[j];
        return !o || c.byteLength !== o.byteLength || c.some((b, k) => b !== o[k]);
      }).length;
      expect(changed).toBeGreaterThan(clearAudio.length / 2);
      // The correct key recovers every sample byte-exact.
      expect(await trackSamples(await decryptBytes(enc), 'audio')).toEqual(clearAudio);
      // A wrong key does not.
      expect(await trackSamples(await decryptBytes(enc, WRONG), 'audio')).not.toEqual(clearAudio);
    });
  }
});

describe('cbcs subsample decryption — only protected ranges, only crypt blocks (real video bytes)', () => {
  it('decrypts a video sample with a clear prefix + patterned protected range, partial block stays clear', async () => {
    const video = await trackSamples(await loadFixture('h264.mp4'), 'video');
    const sample = video.find((s) => s.byteLength >= 16 * 8); // a sample with several full blocks
    expect(sample).toBeDefined();
    if (!sample) return;

    const key = hexToBytes(KEY);
    const iv = hexToBytes('0f0e0d0c0b0a09080706050403020100');
    const pattern: CencPattern = { cryptByteBlock: 1, skipByteBlock: 2 };
    // A 5-byte clear prefix (e.g. a NAL header) then the rest protected — exactly the cbcs video shape.
    const clearPrefix = 5;
    const subsamples = [{ clear: clearPrefix, protected: sample.byteLength - clearPrefix }];

    const cipher = await encryptSampleCbcs(
      key,
      iv,
      sample,
      pattern.cryptByteBlock,
      pattern.skipByteBlock,
      subsamples,
    );
    // The clear prefix is never touched by encryption.
    expect([...cipher.subarray(0, clearPrefix)]).toEqual([...sample.subarray(0, clearPrefix)]);
    // The trailing bytes of the last partial (<16) block are left clear (cbcs never encrypts partials).
    const tail = (sample.byteLength - clearPrefix) % 16;
    if (tail > 0) {
      expect([...cipher.subarray(cipher.byteLength - tail)]).toEqual([
        ...sample.subarray(sample.byteLength - tail),
      ]);
    }
    // Something in the protected range actually changed (real encryption happened).
    expect([...cipher]).not.toEqual([...sample]);

    const recovered = await decryptSampleCbcs(key, pattern, iv, cipher, subsamples);
    expect([...recovered]).toEqual([...sample]); // byte-exact recovery
  });

  it('a skip-0 pattern over a multi-subsample sample round-trips (continuous chaining per range)', async () => {
    const key = hexToBytes(KEY);
    const iv = hexToBytes('00000000000000000000000000000099');
    const data = Uint8Array.from({ length: 200 }, (_, i) => (i * 17 + 3) & 0xff);
    const pattern: CencPattern = { cryptByteBlock: 1, skipByteBlock: 0 };
    const subsamples = [
      { clear: 4, protected: 80 }, // 5 whole blocks
      { clear: 6, protected: 96 }, // 6 whole blocks
    ];
    const cipher = await encryptSampleCbcs(key, iv, data, 1, 0, subsamples);
    expect([...cipher]).not.toEqual([...data]);
    expect([...(await decryptSampleCbcs(key, pattern, iv, cipher, subsamples))]).toEqual([...data]);
  });
});

describe('cbcs constant-IV + version-0 tenc (no per-sample IV / no pattern)', () => {
  const KEYB = hexToBytes(KEY);
  const PATTERN: CencPattern = { cryptByteBlock: 1, skipByteBlock: 0 }; // full CBC of every whole block
  const CONST_IV = hexToBytes('101112131415161718191a1b1c1d1e1f');

  it('decryptSamplesCbcs uses the track constantIv when a sample carries no per-sample IV', async () => {
    // Two whole-sample packets (no subsample map), encrypted with the SAME constant IV.
    const a = Uint8Array.from({ length: 48 }, (_, i) => (i * 5 + 1) & 0xff);
    const b = Uint8Array.from({ length: 32 }, (_, i) => (i * 9 + 2) & 0xff);
    const encA = await encryptSampleCbcs(KEYB, CONST_IV, a, 1, 0);
    const encB = await encryptSampleCbcs(KEYB, CONST_IV, b, 1, 0);
    // senc with empty per-sample IVs (per-sample IV size 0 ⇒ the constant IV is applied).
    const senc = [{ iv: new Uint8Array(0) }, { iv: new Uint8Array(0) }];
    const clear = await decryptSamplesCbcs(KEYB, [encA, encB], senc, PATTERN, CONST_IV);
    expect([...(clear[0] ?? [])]).toEqual([...a]);
    expect([...(clear[1] ?? [])]).toEqual([...b]);
  });

  it('decryptSamplesCbcs rejects a sample with neither a per-sample IV nor a constant IV', async () => {
    const enc = await encryptSampleCbcs(KEYB, CONST_IV, new Uint8Array(16).fill(7), 1, 0);
    await expect(
      decryptSamplesCbcs(KEYB, [enc], [{ iv: new Uint8Array(0) }], PATTERN, undefined),
    ).rejects.toThrow(MediaError);
  });

  it('parseTenc(cbcs) on a version-0 box yields no pattern (full-CBC default applies downstream)', () => {
    const kid = hexToBytes(KID);
    // version 0, flags 0, reserved, pattern-byte ignored at v0, isProtected, ivSize 16, KID.
    const payload = new Uint8Array([0, 0, 0, 0, 0, 0x19, 1, 16, ...kid]);
    const tenc = parseTenc(payload, 'cbcs');
    expect(tenc.pattern).toBeUndefined(); // pattern is a v≥1 field; v0 carries none
    expect(tenc.perSampleIvSize).toBe(16);
  });

  it('parseSenc(cbcs) with subsamples + IV size 0 reads the maps but no IV bytes', () => {
    // flags=0x02 (subsamples), count=1, no IV (size 0), subsampleCount=1, clear=4, protected=16.
    const payload = new Uint8Array([0, 0, 0, 0x02, 0, 0, 0, 1, 0, 1, 0, 4, 0, 0, 0, 16]);
    const senc = parseSenc(payload, 0, 'cbcs');
    expect(senc[0]?.iv.byteLength).toBe(0);
    expect(senc[0]?.subsamples).toEqual([{ clear: 4, protected: 16 }]);
  });
});

describe('parseTenc / parseSenc — cbcs pattern + constant-IV fields', () => {
  /** A cbcs `tenc` payload (version 1): version, flags, reserved, pattern, isProtected, ivSize, KID[, constIV]. */
  function cbcsTenc(opts: {
    crypt: number;
    skip: number;
    ivSize: number;
    constantIv?: Uint8Array;
  }): Uint8Array {
    const kid = hexToBytes(KID);
    const head = [
      1,
      0,
      0,
      0,
      0,
      ((opts.crypt & 0x0f) << 4) | (opts.skip & 0x0f),
      1,
      opts.ivSize,
      ...kid,
    ];
    if (opts.ivSize === 0 && opts.constantIv) {
      return new Uint8Array([...head, opts.constantIv.byteLength, ...opts.constantIv]);
    }
    return new Uint8Array(head);
  }

  it('reads the crypt:skip pattern from a version-1 cbcs tenc (per-sample IV)', () => {
    const t = parseTenc(cbcsTenc({ crypt: 1, skip: 9, ivSize: 16 }), 'cbcs');
    expect(t.pattern).toEqual({ cryptByteBlock: 1, skipByteBlock: 9 });
    expect(t.perSampleIvSize).toBe(16);
    expect(t.constantIv).toBeUndefined();
  });

  it('reads the default_constant_IV when per-sample IV size is 0', () => {
    const constIv = hexToBytes('aabbccddeeff00112233445566778899');
    const t = parseTenc(cbcsTenc({ crypt: 1, skip: 9, ivSize: 0, constantIv: constIv }), 'cbcs');
    expect(t.perSampleIvSize).toBe(0);
    expect([...(t.constantIv ?? [])]).toEqual([...constIv]);
  });

  it('rejects an all-zero crypt:skip pattern (encrypts nothing)', () => {
    expect(() => parseTenc(cbcsTenc({ crypt: 0, skip: 0, ivSize: 16 }), 'cbcs')).toThrow(
      MediaError,
    );
  });

  it('rejects per-sample IV size 0 with no/short default_constant_IV', () => {
    expect(() => parseTenc(cbcsTenc({ crypt: 1, skip: 9, ivSize: 0 }), 'cbcs')).toThrow(MediaError);
  });

  it('parseSenc(cbcs) with IV size 0 reads no per-sample IV bytes (constant-IV track)', () => {
    // flags=0, sample_count=2, no IV bytes (constant IV lives in tenc).
    const payload = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 2]);
    const senc = parseSenc(payload, 0, 'cbcs');
    expect(senc).toHaveLength(2);
    expect(senc[0]?.iv.byteLength).toBe(0);
  });

  it('cenc still rejects IV size 0 (constant IV is a cbcs-only feature)', () => {
    const payload = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(() => parseSenc(payload, 0, 'cenc')).toThrow(MediaError);
  });
});

describe('media.decrypt — cbcs robustness: malformed/contradictory protection rejects cleanly', () => {
  /** Locate a box payload start/end by signature scan (for in-memory mutation). */
  function locate(bytes: Uint8Array, type: string): { payload: number; end: number } {
    const dec = new TextDecoder('latin1');
    for (let i = 4; i + 4 <= bytes.length; i++) {
      if (dec.decode(bytes.subarray(i, i + 4)) !== type) continue;
      const start = i - 4;
      const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(start);
      if (size >= 8 && start + size <= bytes.length) return { payload: i + 4, end: start + size };
    }
    throw new Error(`box '${type}' not found`);
  }

  it('happy path: the unmutated cbcs file decrypts the audio bit-exact (regression)', async () => {
    const clear = await loadFixture('movie_5.mp4');
    const enc = await encryptCbcs(clear, {
      keyHex: KEY,
      kidHex: KID,
      cryptByteBlock: 1,
      skipByteBlock: 9,
    });
    expect(await trackSamples(await decryptBytes(enc), 'audio')).toEqual(
      await trackSamples(clear, 'audio'),
    );
  });

  it('rejects zeroed senc protection metadata with a typed MediaError (not a CapabilityError)', async () => {
    const enc = await encryptCbcs(await loadFixture('movie_5.mp4'), {
      keyHex: KEY,
      kidHex: KID,
      cryptByteBlock: 1,
      skipByteBlock: 9,
    });
    const mutated = enc.slice();
    const senc = locate(mutated, 'senc');
    mutated.fill(0, senc.payload, senc.end);
    expect([...mutated]).not.toEqual([...enc]);
    const err = await decryptBytes(mutated).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('rejects a truncated mdat (sample ranges exceed the file) with a typed MediaError', async () => {
    const enc = await encryptCbcs(await loadFixture('movie_5.mp4'), {
      keyHex: KEY,
      kidHex: KID,
      cryptByteBlock: 1,
      skipByteBlock: 9,
    });
    const mutated = enc.slice(0, Math.floor(enc.length * 0.6));
    const err = await decryptBytes(mutated).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('rejects a scheme mismatch: a cbcs file asked to decrypt as cenc → MediaError', async () => {
    const enc = await encryptCbcs(await loadFixture('movie_5.mp4'), {
      keyHex: KEY,
      kidHex: KID,
      cryptByteBlock: 1,
      skipByteBlock: 9,
    });
    const err = await createMedia()
      .decrypt(encSource(enc), { scheme: 'cenc', keys: { [KID]: KEY } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });
});

describe('media.decrypt — HLS AES-128 full-segment (MP4) via the driver', () => {
  const HLS_KEY = '000102030405060708090a0b0c0d0e0f';
  const HLS_IV = '0a0b0c0d0e0f00010203040506070809';

  it('decrypts a whole AES-128-CBC-encrypted MP4 segment back to the exact original bytes', async () => {
    const clear = await loadFixture('movie_5.mp4');
    const c = createCipheriv(
      'aes-128-cbc',
      Buffer.from(hexToBytes(HLS_KEY)),
      Buffer.from(hexToBytes(HLS_IV)),
    );
    const cipher = new Uint8Array(Buffer.concat([c.update(Buffer.from(clear)), c.final()]));
    expect([...cipher.subarray(0, 16)]).not.toEqual([...clear.subarray(0, 16)]);

    const out = await createMedia().decrypt(fromBytes(cipher, { mime: 'video/mp4' }), {
      scheme: 'hls-aes128',
      keys: { key: HLS_KEY, iv: HLS_IV },
    });
    if (!(out instanceof Blob)) throw new Error('expected a Blob output');
    expect([...new Uint8Array(await out.arrayBuffer())]).toEqual([...clear]); // byte-exact original MP4
  });

  it('rejects a wrong key/IV (decrypted bytes are not a valid MP4) with a typed MediaError', async () => {
    const clear = await loadFixture('movie_5.mp4');
    const c = createCipheriv(
      'aes-128-cbc',
      Buffer.from(hexToBytes(HLS_KEY)),
      Buffer.from(hexToBytes(HLS_IV)),
    );
    const cipher = new Uint8Array(Buffer.concat([c.update(Buffer.from(clear)), c.final()]));
    const err = await createMedia()
      .decrypt(fromBytes(cipher, { mime: 'video/mp4' }), {
        scheme: 'hls-aes128',
        keys: { key: WRONG, iv: HLS_IV },
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(MediaError);
  });
});
