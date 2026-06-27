import { describe, expect, it } from 'vitest';
import { aesCtr, hexToBytes } from '../../crypto/aes.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import {
  type SencSample,
  decryptSample,
  decryptSamples,
  kidHex,
  parseSenc,
  parseTenc,
} from './cenc.ts';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';

const KEY = hexToBytes('000102030405060708090a0b0c0d0e0f');
const WRONG = hexToBytes('ffeeddccbbaa99887766554433221100');
const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

/** Independent 16-byte counter from an 8-byte IV (high bytes) — written separately from the SUT. */
function counter(iv: Uint8Array, blockOffset = 0): Uint8Array<ArrayBuffer> {
  const c = new Uint8Array(16);
  c.set(iv, 0);
  let carry = blockOffset;
  for (let i = 15; i >= 8 && carry > 0; i--) {
    const add = carry % 256;
    const sum = (c[i] ?? 0) + add;
    c[i] = sum & 0xff;
    carry = Math.floor(carry / 256) + Math.floor(sum / 256);
  }
  return c;
}
function ivFor(i: number): Uint8Array {
  const iv = new Uint8Array(8);
  new DataView(iv.buffer).setUint32(4, i + 1);
  return iv;
}

describe('CENC AES-CTR sample decryption — real AAC (movie_5.mp4)', () => {
  it('round-trips every encrypted audio sample bit-exact, and the key matters', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const movie = await readMovie(ra(bytes));
    const tracks = await muxTracksFromMovie(ra(bytes), movie);
    const audio = tracks.find((t) => t.mediaType === 'audio');
    expect(audio).toBeDefined();
    if (!audio) return;
    expect(audio.samples.length).toBeGreaterThan(10); // diverse, multi-sample

    const clear = audio.samples.map((s) => s.data);
    const senc: SencSample[] = audio.samples.map((_, i) => ({ iv: ivFor(i) }));
    const cipher = await Promise.all(
      clear.map((d, i) => aesCtr(KEY, counter(ivFor(i)), d.slice(), 64)),
    );

    // Real encryption happened: ciphertext differs from cleartext.
    expect([...(cipher[0] ?? [])]).not.toEqual([...(clear[0] ?? [])]);
    // Correct key recovers the cleartext exactly.
    expect(await decryptSamples(KEY, cipher, senc)).toEqual(clear);
    // Wrong key does not.
    const wrong = await decryptSamples(WRONG, cipher, senc);
    expect([...(wrong[0] ?? [])]).not.toEqual([...(clear[0] ?? [])]);
  });
});

describe('CENC subsample decryption', () => {
  it('decrypts only the protected ranges, leaving clear bytes untouched', async () => {
    const iv = ivFor(7);
    const original = Uint8Array.from({ length: 30 }, (_, i) => i * 7);
    const enc = await aesCtr(KEY, counter(iv), original.subarray(10, 30).slice(), 64);
    const cipher = original.slice();
    cipher.set(enc, 10); // bytes [0,10) clear, [10,30) protected
    expect([...cipher.subarray(0, 10)]).toEqual([...original.subarray(0, 10)]);

    const recovered = await decryptSample(
      KEY,
      { iv, subsamples: [{ clear: 10, protected: 20 }] },
      cipher,
    );
    expect([...recovered]).toEqual([...original]);
  });

  it('starts each protected subsample range on the next CTR block boundary', async () => {
    const iv = ivFor(9);
    const original = Uint8Array.from({ length: 44 }, (_, i) => (i * 11) & 0xff);
    const subsamples = [
      { clear: 2, protected: 17 },
      { clear: 3, protected: 17 },
    ];
    const cipher = original.slice();
    let pos = 0;
    let blockOffset = 0;
    for (const ss of subsamples) {
      pos += ss.clear;
      const enc = await aesCtr(
        KEY,
        counter(iv, blockOffset),
        original.subarray(pos, pos + ss.protected).slice(),
        64,
      );
      cipher.set(enc, pos);
      blockOffset += Math.ceil(ss.protected / 16);
      pos += ss.protected;
    }

    const recovered = await decryptSample(KEY, { iv, subsamples }, cipher);
    expect([...recovered]).toEqual([...original]);
  });
});

describe('CENC box parsing', () => {
  it('parseTenc reads default KID + per-sample IV size', () => {
    const kid = hexToBytes('00112233445566778899aabbccddeeff');
    const payload = new Uint8Array([0, 0, 0, 0, 0, 0, 1, 8, ...kid]);
    const tenc = parseTenc(payload);
    expect(tenc.isProtected).toBe(true);
    expect(tenc.perSampleIvSize).toBe(8);
    expect(kidHex(tenc.kid)).toBe('00112233445566778899aabbccddeeff');
  });

  it('parseSenc reads per-sample IVs (no subsamples)', () => {
    const iv0 = hexToBytes('0000000000000001');
    const iv1 = hexToBytes('0000000000000002');
    const payload = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 2, ...iv0, ...iv1]);
    const senc = parseSenc(payload, 8);
    expect(senc).toHaveLength(2);
    expect([...(senc[0]?.iv ?? [])]).toEqual([...iv0]);
    expect(senc[1]?.subsamples).toBeUndefined();
  });

  it('parseSenc reads subsample maps (flags & 0x2)', () => {
    const iv = hexToBytes('0000000000000009');
    // flags=2, count=1, iv(8), subsampleCount=1, clear=3, protected=7
    const payload = new Uint8Array([0, 0, 0, 2, 0, 0, 0, 1, ...iv, 0, 1, 0, 3, 0, 0, 0, 7]);
    const senc = parseSenc(payload, 8);
    expect(senc[0]?.subsamples).toEqual([{ clear: 3, protected: 7 }]);
  });
});
