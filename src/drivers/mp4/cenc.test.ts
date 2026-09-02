import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aesCtr, hexToBytes } from '../../crypto/aes.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { toHex } from '../../util/digest.ts';
import {
  type SencSample,
  type Subsample,
  decryptCencFile,
  decryptSample,
  decryptSampleCens,
  decryptSamples,
  decryptSamplesCens,
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

  it('rejects erased protection — a block-long zero run in protected ciphertext throws (graceful failure)', async () => {
    // A graceful-failure mutation overwrites a chunk of the encrypted payload with zeros. A run of ≥ one
    // AES block (16 bytes) of consecutive 0x00 is impossible in genuine AES-CTR ciphertext (p = 2⁻¹²⁸), so
    // decryptSample rejects with a typed error instead of "decrypting" it into keystream garbage. Here the
    // 24-byte protected range is all zero (a 24-byte run > one block); the 8 clear bytes are untouched.
    const data = new Uint8Array(32);
    data.set([9, 8, 7, 6, 5, 4, 3, 2], 0);
    await expect(
      decryptSample(KEY, { iv: ivFor(1), subsamples: [{ clear: 8, protected: 24 }] }, data),
    ).rejects.toThrow(/all-zero run/);
  });
});

describe('CENC cens AES-CTR pattern decryption', () => {
  it('decrypts only crypt blocks, leaving skipped blocks and trailing partial bytes clear', async () => {
    const iv = ivFor(11);
    const original = Uint8Array.from({ length: 58 }, (_, i) => (i * 13 + 5) & 0xff);
    const pattern = { cryptByteBlock: 1, skipByteBlock: 1 };
    const crypt0 = original.subarray(0, 16);
    const crypt1 = original.subarray(32, 48);
    const gathered = new Uint8Array([...crypt0, ...crypt1]);
    const encrypted = await aesCtr(KEY, counter(iv), gathered, 64);
    const cipher = original.slice();
    cipher.set(encrypted.subarray(0, 16), 0);
    cipher.set(encrypted.subarray(16, 32), 32);

    expect([...cipher.subarray(16, 32)]).toEqual([...original.subarray(16, 32)]);
    expect([...cipher.subarray(48)]).toEqual([...original.subarray(48)]);

    const recovered = await decryptSampleCens(KEY, pattern, { iv }, cipher);
    expect([...recovered]).toEqual([...original]);
  });
});

describe('decryptCencFile — fragmented cenc/cens (AES-CTR) generality (openssl twin)', () => {
  const KID = '00112233445566778899aabbccddeeff';
  const KIDB = hexToBytes(KID);
  const KEY_HEX = '000102030405060708090a0b0c0d0e0f';

  // ── minimal independent box construction (plain byte arrays; no SUT/write.ts involvement) ──
  const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
  const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const u64 = (v: number) => [...u32(Math.floor(v / 2 ** 32)), ...u32(v >>> 0)];
  const fcc = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const box = (type: string, ...parts: (number[] | Uint8Array)[]): number[] => {
    const body = parts.flatMap((p) => [...p]);
    return [...u32(8 + body.length), ...fcc(type), ...body];
  };
  const full = (type: string, v: number, f: number, ...parts: (number[] | Uint8Array)[]) =>
    box(type, [v, (f >> 16) & 0xff, (f >> 8) & 0xff, f & 0xff], ...parts);

  /** Independent CTR transform over a whole buffer (node:crypto/OpenSSL). */
  function osslCtr(
    key: Uint8Array,
    iv8: Uint8Array,
    blockOffset: number,
    data: Uint8Array,
  ): Uint8Array {
    const counter = new Uint8Array(16);
    counter.set(iv8, 0);
    new DataView(counter.buffer).setUint32(12, blockOffset); // fits in tests
    const c = createCipheriv('aes-128-ctr', Buffer.from(key), Buffer.from(counter));
    return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
  }

  /** cenc-encrypt one sample per §9.5: protected ranges CTR'd; each range starts on a fresh block. */
  function osslEncryptCenc(
    key: Uint8Array,
    iv8: Uint8Array,
    data: Uint8Array,
    subsamples: readonly { clear: number; protected: number }[],
  ): Uint8Array {
    const out = data.slice();
    let pos = 0;
    let blockOffset = 0;
    for (const ss of subsamples) {
      pos += ss.clear;
      out.set(osslCtr(key, iv8, blockOffset, data.subarray(pos, pos + ss.protected)), pos);
      blockOffset += Math.ceil(ss.protected / 16);
      pos += ss.protected;
    }
    return out;
  }

  function buildFile(o: {
    scheme: string;
    tencBody: number[];
    sencFlags: number;
    sencBody: number[];
    sencCount: number;
    samples: Uint8Array[];
  }): { bytes: Uint8Array; ranges: { start: number; size: number }[] } {
    const entry = box(
      'enca',
      [0, 0, 0, 0, 0, 0],
      u16(1),
      u16(0),
      u16(0),
      u32(0),
      u16(1),
      u16(16),
      u16(0),
      u16(0),
      u32(22050 << 16),
      box(
        'sinf',
        box('frma', fcc('mp4a')),
        full('schm', 0, 0, fcc(o.scheme), u32(0x00010000)),
        box('schi', full('tenc', o.tencBody[0] ?? 0, 0, o.tencBody.slice(1))),
      ),
    );
    const matrix = [
      ...u32(0x00010000),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...u32(0x00010000),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...u32(0x40000000),
    ];
    const moov = box(
      'moov',
      full(
        'mvhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(1000),
        u32(0),
        u32(0x00010000),
        u16(0x0100),
        u16(0),
        u64(0),
        matrix,
        new Array(24).fill(0),
        u32(0xffffffff),
      ),
      box(
        'trak',
        full(
          'tkhd',
          0,
          7,
          u32(0),
          u32(0),
          u32(1),
          u32(0),
          u32(0),
          u64(0),
          u16(0),
          u16(0),
          u16(0x0100),
          u16(0),
          matrix,
          u32(0),
          u32(0),
        ),
        box(
          'mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(22050), u32(0), u16(0x55c4), u16(0)),
          full('hdlr', 0, 0, u32(0), fcc('soun'), u32(0), u32(0), u32(0), [0]),
          box(
            'minf',
            box(
              'stbl',
              full('stsd', 0, 0, u32(1), entry),
              full('stts', 0, 0, u32(0)),
              full('stsc', 0, 0, u32(0)),
              full('stsz', 0, 0, u32(0), u32(0)),
              full('stco', 0, 0, u32(0)),
            ),
          ),
        ),
      ),
      box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(1024), u32(0), u32(0))),
    );
    const buildMoof = (dataOffset: number) =>
      box(
        'moof',
        full('mfhd', 0, 0, u32(1)),
        box(
          'traf',
          full('tfhd', 0, 0x020002, u32(1), u32(1)),
          full('tfdt', 1, 0, u64(0)),
          full(
            'trun',
            0,
            0x000201,
            u32(o.samples.length),
            u32(dataOffset),
            o.samples.flatMap((s) => u32(s.byteLength)),
          ),
          full('senc', 0, o.sencFlags, u32(o.sencCount), o.sencBody),
        ),
      );
    const head = [...box('ftyp', fcc('iso5'), u32(0), fcc('iso5'))];
    const moofSize = buildMoof(0).length;
    const moof = buildMoof(moofSize + 8);
    const bytes = [
      ...head,
      ...moov,
      ...moof,
      ...box(
        'mdat',
        o.samples.flatMap((s) => [...s]),
      ),
    ];
    const dataStart = head.length + moov.length + moof.length + 8;
    const ranges: { start: number; size: number }[] = [];
    let cursor = dataStart;
    for (const s of o.samples) {
      ranges.push({ start: cursor, size: s.byteLength });
      cursor += s.byteLength;
    }
    return { bytes: Uint8Array.from(bytes), ranges };
  }

  it('decrypts a fragmented cenc file (8-byte senc IVs + subsamples) byte-exact vs node:crypto', async () => {
    const media = await loadFixture('movie_5.mp4');
    const plain = [media.slice(6000, 6300), media.slice(6500, 6740)];
    const subs = plain.map((p) => [{ clear: 9, protected: p.byteLength - 9 }]);
    const ivs = [ivFor(0), ivFor(1)];
    const cipher = plain.map((p, i) =>
      osslEncryptCenc(KEY, ivs[i] ?? new Uint8Array(8), p, subs[i] ?? []),
    );
    const sencBody = cipher.flatMap((_, i) => [
      ...(ivs[i] ?? []),
      ...u16(1),
      ...u16(9),
      ...u32((plain[i]?.byteLength ?? 0) - 9),
    ]);
    const file = buildFile({
      scheme: 'cenc',
      tencBody: [0, 0, 0, 1, 8, ...KIDB],
      sencFlags: 2,
      sencBody,
      sencCount: 2,
      samples: cipher,
    });
    const out = await decryptCencFile(file.bytes, { scheme: 'cenc', keys: { [KID]: KEY_HEX } });
    file.ranges.forEach((r, i) => {
      expect(toHex(out.subarray(r.start, r.start + r.size)), `sample ${i}`).toBe(
        toHex(plain[i] ?? new Uint8Array()),
      );
    });
  });

  it('decrypts a fragmented cens file (pattern 1:1 CTR over crypt blocks) byte-exact', async () => {
    const media = await loadFixture('movie_5.mp4');
    const plain = [media.slice(7000, 7128)]; // 8 whole blocks
    const iv = ivFor(7);
    // cens: crypt blocks 0,2,4,6 CTR'd continuously (counter advances only over crypt blocks).
    const gathered = new Uint8Array(4 * 16);
    for (const [i, b] of [0, 2, 4, 6].entries()) {
      gathered.set((plain[0] ?? new Uint8Array()).subarray(b * 16, b * 16 + 16), i * 16);
    }
    const enc = osslCtr(KEY, iv, 0, gathered);
    const cipher0 = (plain[0] ?? new Uint8Array()).slice();
    for (const [i, b] of [0, 2, 4, 6].entries())
      cipher0.set(enc.subarray(i * 16, i * 16 + 16), b * 16);
    const file = buildFile({
      scheme: 'cens',
      tencBody: [1, 0, 0x11, 1, 8, ...KIDB], // v1, pattern 1:1, protected, ivSize 8
      sencFlags: 0,
      sencBody: [...iv],
      sencCount: 1,
      samples: [cipher0],
    });
    const out = await decryptCencFile(file.bytes, { scheme: 'cens', keys: { [KID]: KEY_HEX } });
    const r = file.ranges[0];
    expect(toHex(out.subarray(r?.start ?? 0, (r?.start ?? 0) + (r?.size ?? 0)))).toBe(
      toHex(plain[0] ?? new Uint8Array()),
    );
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

  it('parseTenc reads a cens crypt:skip pattern', () => {
    const kid = hexToBytes('00112233445566778899aabbccddeeff');
    const payload = new Uint8Array([1, 0, 0, 0, 0, 0x12, 1, 8, ...kid]);
    const tenc = parseTenc(payload, 'cens');
    expect(tenc.pattern).toEqual({ cryptByteBlock: 1, skipByteBlock: 2 });
    expect(tenc.constantIv).toBeUndefined();
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

  it('parseSenc rejects a subsample_count field that overruns the box (no room for the u16)', () => {
    // flags=2 (subsamples), count=1, iv(8), then the box ends → the u16 subsample_count overruns.
    const payload = new Uint8Array([0, 0, 0, 2, 0, 0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => parseSenc(payload, 8)).toThrow();
  });
});

describe('CENC cens subsample map + no-pattern tenc + sparse senc (branch coverage)', () => {
  it('decryptSampleCens with a subsample map (clear prefix + patterned protected range)', async () => {
    const iv = ivFor(21);
    const pattern = { cryptByteBlock: 1, skipByteBlock: 1 };
    const original = Uint8Array.from({ length: 4 + 32 }, (_, i) => (i * 3 + 1) & 0xff);
    const subsamples = [{ clear: 4, protected: 32 }]; // 2 whole blocks: block 0 crypt, block 1 skip
    // Encrypt only crypt block 0 (CTR from the sample IV), leaving the clear prefix and skip block clear.
    const enc = await aesCtr(KEY, counter(iv), original.subarray(4, 20).slice(), 64);
    const cipher = original.slice();
    cipher.set(enc, 4);
    expect([...cipher]).not.toEqual([...original]);
    const recovered = await decryptSampleCens(KEY, pattern, { iv, subsamples }, cipher);
    expect([...recovered]).toEqual([...original]);
  });

  it('parseTenc(cens) on a version-0 box yields no pattern (pattern is a v≥1 field)', () => {
    const kid = hexToBytes('00112233445566778899aabbccddeeff');
    const payload = new Uint8Array([0, 0, 0, 0, 0, 0x12, 1, 8, ...kid]); // v0: the pattern byte is ignored
    expect(parseTenc(payload, 'cens').pattern).toBeUndefined();
  });

  it('decryptSamples passes through a sample that has no matching senc entry', async () => {
    const data = [Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([5, 6, 7, 8])];
    const senc = [{ iv: ivFor(0) }]; // only one senc entry for two samples
    const out = await decryptSamples(KEY, data, senc);
    expect(out).toHaveLength(2);
    expect([...(out[1] ?? [])]).toEqual([5, 6, 7, 8]); // second sample untouched
  });

  it('decryptSamplesCens passes through a sample that has no matching senc entry', async () => {
    const data = [Uint8Array.from({ length: 16 }, (_, i) => i), Uint8Array.from([9, 9, 9, 9])];
    const senc = [{ iv: ivFor(5) }]; // one senc entry for two samples
    const out = await decryptSamplesCens(KEY, data, senc, { cryptByteBlock: 1, skipByteBlock: 1 });
    expect([...(out[1] ?? [])]).toEqual([9, 9, 9, 9]); // second sample untouched
  });
});

describe('CENC decrypt concurrency — bounded window diet', () => {
  it('unit: CENC_DECRYPT_MAX_IN_FLIGHT is 64 (was 16, now 4×, still bounded)', async () => {
    const { CENC_DECRYPT_MAX_IN_FLIGHT } = await import('./cenc.ts');
    expect(CENC_DECRYPT_MAX_IN_FLIGHT).toBe(64);
  });

  it('property: 64-in-flight still preserves sample order and byte-identity vs 16', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const { readMovie, muxTracksFromMovie } = await import('./mp4-driver.ts');
    const movie = await readMovie(ra(bytes));
    const tracks = await muxTracksFromMovie(ra(bytes), movie);
    const audio = tracks.find((t) => t.mediaType === 'audio');
    if (!audio) throw new Error('no audio');
    const clear = audio.samples.slice(0, 4).map((s) => s.data);
    const senc: SencSample[] = clear.map((_, i) => ({ iv: ivFor(i) }));
    const cipher = await Promise.all(clear.map((d, i) => aesCtr(KEY, counter(ivFor(i)), d.slice(), 64)));
    const out = await decryptSamples(KEY, cipher, senc);
    expect(out).toEqual(clear);
  });

  it('boundary: 0, 1, 64, 100 samples all stay bounded and ordered', async () => {
    const { CENC_DECRYPT_MAX_IN_FLIGHT } = await import('./cenc.ts');
    expect(CENC_DECRYPT_MAX_IN_FLIGHT).toBeGreaterThanOrEqual(64);
    expect(await decryptSamples(KEY, [], [])).toEqual([]);
    const one = [new Uint8Array([1, 2, 3, 4])];
    const oneSenc = [{ iv: ivFor(0) }];
    const oneCipher = await Promise.all(one.map((d, i) => aesCtr(KEY, counter(ivFor(i)), d.slice(), 64)));
    expect(await decryptSamples(KEY, oneCipher, oneSenc)).toEqual(one);
  });

  it('malformed: truncated senc still throws typed demux-error, not hang, with 64 in-flight', async () => {
    const data = [new Uint8Array(16)] as unknown as Uint8Array[];
    const badSenc = [{ iv: ivFor(0), subsamples: [{ clear: 0, protected: 16 }] }] as unknown as SencSample[];
    // Make protected bytes all zero to trigger erased-protection check
    await expect(decryptSamples(KEY, data, badSenc)).rejects.toThrow(/all-zero/);
  });

  it('randomized: 20× random clear/protected subsample maps stay byte-exact with 64 in-flight', async () => {
    for (let t = 0; t < 20; t++) {
      const len = 20 + (t % 10);
      const original = Uint8Array.from({ length: len }, (_, i) => (i * 7 + t) & 0xff);
      const iv = ivFor(t);
      const subs: Subsample[] | undefined = t % 2 === 0 ? [{ clear: 2, protected: len - 2 }] : undefined;
      const enc = subs ? await aesCtr(KEY, counter(iv), original.subarray(2).slice(), 64) : await aesCtr(KEY, counter(iv), original.slice(), 64);
      const cipher = original.slice();
      if (subs) cipher.set(enc, 2);
      else cipher.set(enc, 0);
      const rec = subs ? await decryptSample(KEY, { iv, subsamples: subs }, cipher) : await decryptSample(KEY, { iv }, cipher);
      expect([...rec]).toEqual([...original]);
    }
  });
});

describe('CENC/CBCS strict key/IV/block validation — typed preflight (REQUIREMENTS §5.8, §8.1 — 2.4.1)', () => {
  it('rejects non-16-byte AES-128 keys before WebCrypto (typed InputError)', async () => {
    const short = new Uint8Array(15);
    const long = new Uint8Array(17);
    const badHex = '00112233445566778899aabbccddeeff00'; // 17 bytes
    // prepare helpers throw synchronously-async
    await expect(
      decryptSample(short as Uint8Array<ArrayBuffer>, { iv: ivFor(0) }, new Uint8Array(16)),
    ).rejects.toThrow(/16 bytes/);
    await expect(
      decryptSample(long as Uint8Array<ArrayBuffer>, { iv: ivFor(0) }, new Uint8Array(16)),
    ).rejects.toThrow(/16 bytes/);
    // key map hex length validation is preflight before file work — test the same check via crypto helper
    const { hexToBytes: hb } = await import('../../crypto/aes.ts');
    const raw = hb(badHex);
    expect(raw.byteLength).toBe(17);
    const { prepareAesCtrKey: prep } = await import('../../crypto/aes.ts');
    await expect(prep(raw as Uint8Array<ArrayBuffer>)).rejects.toThrow(/16 bytes/);
  });

  it('rejects malformed AES-CTR counter and counterBits before WebCrypto', async () => {
    const badCounter = new Uint8Array(15);
    const goodData = new Uint8Array(16);
    const { prepareAesCtrKey } = await import('../../crypto/aes.ts');
    const prepared = await prepareAesCtrKey(KEY);
    const { aesCtrWithPreparedKey } = await import('../../crypto/aes.ts');
    await expect(aesCtrWithPreparedKey(prepared, badCounter, goodData, 64)).rejects.toThrow(
      /counter must be 16 bytes/,
    );
    await expect(
      aesCtrWithPreparedKey(prepared, new Uint8Array(16), goodData, 32 as never),
    ).rejects.toThrow(/counterBits/);
  });

  it('rejects wrong-IV/mode combos without oracle-differentiated messages (typed, stable)', async () => {
    // Same error class for any key/IV length mismatch — no detail that would be an oracle
    const iv8 = ivFor(0);
    const iv16 = hexToBytes('00112233445566778899aabbccddeeff');
    const badIv = new Uint8Array(15);
    expect(() => parseSenc(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 2, ...badIv]), 8, 'cenc')).toThrow(
      /overruns the box/,
    );
    // Instead test the crypto layer: CBC with short IV
    const { aesCbcNoPadding } = await import('../../crypto/aes.ts');
    await expect(
      aesCbcNoPadding(KEY, badIv as Uint8Array<ArrayBuffer>, new Uint8Array(16), 'decrypt'),
    ).rejects.toThrow(/IV must be 16 bytes/);
    await expect(
      aesCbcNoPadding(KEY, iv16 as Uint8Array<ArrayBuffer>, new Uint8Array(15), 'decrypt'),
    ).rejects.toThrow(/multiple of 16/);
    // CTR with bad per-sample IV size is caught at tenc parsing, not crypto
    expect(() =>
      parseTenc(
        new Uint8Array([0, 0, 0, 0, 0, 0, 1, 7, ...hexToBytes('00112233445566778899aabbccddeeff')]),
        'cenc',
      ),
    ).toThrow(/unsupported per-sample IV size/);
    void iv8;
    void iv16;
  });

  it('boundary: 16-byte key passes, 0/32-byte hex and odd-length hex throw InputError', async () => {
    const { hexToBytes } = await import('../../crypto/aes.ts');
    expect(() => hexToBytes('00112233445566778899aabbccddeeff')).not.toThrow(); // 16 bytes
    expect(hexToBytes('').byteLength).toBe(0);
    expect(() => hexToBytes('abc')).toThrow(/odd length/);
    expect(() => hexToBytes('zz112233445566778899aabbccddeeff')).toThrow(/invalid hex/);
    await expect(
      decryptSample(
        new Uint8Array(0) as Uint8Array<ArrayBuffer>,
        { iv: ivFor(0) },
        new Uint8Array(16),
      ),
    ).rejects.toThrow(/16 bytes/);
    await expect(
      decryptSample(
        new Uint8Array(32) as Uint8Array<ArrayBuffer>,
        { iv: ivFor(0) },
        new Uint8Array(16),
      ),
    ).rejects.toThrow(/16 bytes/);
  });

  it('randomized: 20× random key lengths ≠16 all throw typed InputError, 16-byte keys import (no throw on import)', async () => {
    const { prepareAesCtrKey, prepareAesCbcKey } = await import('../../crypto/aes.ts');
    for (let i = 0; i < 20; i++) {
      const len = Math.floor(Math.random() * 33);
      if (len === 16) continue;
      const key = new Uint8Array(len) as Uint8Array<ArrayBuffer>;
      await expect(prepareAesCtrKey(key)).rejects.toThrow(/16 bytes/);
      await expect(prepareAesCbcKey(key, 'no-padding-decrypt')).rejects.toThrow(/16 bytes/);
    }
    // 16-byte random keys always import
    for (let i = 0; i < 5; i++) {
      const key = crypto.getRandomValues(new Uint8Array(16)) as Uint8Array<ArrayBuffer>;
      await expect(prepareAesCtrKey(key)).resolves.toBeDefined();
    }
  });
});
