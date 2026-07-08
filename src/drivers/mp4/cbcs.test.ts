/**
 * CENC `cbcs` (AES-CBC **pattern**) decrypt — end-to-end on REAL media, plus HLS `AES-128` full-segment
 * via the MP4 driver, plus the spec-general {@link decryptCencFile} engine on every real-world cbcs
 * layout declared by ISO/IEC 23001-7 (§8–§10):
 *
 *   (i)   constant-IV (`tenc` Per_Sample_IV_Size 0) with NO sample auxiliary data at all — full-sample
 *         encryption, the standard cbcs AUDIO layout (Apple/Bento4 write tenc v1 pattern 0:0 here);
 *   (ii)  per-sample-IV `senc` with subsample maps (the cbcs VIDEO layout), fragmented multi-`moof`;
 *   (iii) `sbgp`/`sgpd` 'seig' sample-group overrides — unprotected groups, per-group key rotation
 *         (different KID), per-group constant IVs, both traf-local (index ≥ 0x10001) and stbl-level
 *         (index ≤ 0xFFFF) group descriptions;
 *   (iv)  `saiz`/`saio`-located aux data (no `senc`), explicit absolute `tfhd` base-data-offset,
 *         64-bit `saio`, and legacy traf chaining (no base flags at all);
 *   (v)   mixed clear/encrypted tracks and mixed clear/protected sample descriptions (`stsd` > 1).
 *
 * Oracles are INDEPENDENT of the SUT: ciphertext for constructed assets is computed with node:crypto
 * (OpenSSL) AES-128-CBC and placed in hand-built boxes at positions known a priori; the plaintext is
 * real fixture media bytes, and every decrypted byte is compared against them. When Bento4 is installed
 * (`mp4fragment`/`mp4encrypt`), a fully third-party leg fragments + cbcs-encrypts a real fixture and the
 * engine's output mdat payloads must equal the clear original's byte-for-byte. ffmpeg cannot open this
 * layout at all (`error reading header`), so openssl/Bento4/spec are the oracle set (ADR-182).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { AES_BLOCK, hexToBytes } from '../../crypto/aes.ts';
import { fromBytes } from '../../sources/source.ts';
import { encryptCbcs, encryptSampleCbcs } from '../../test-support/cbcs-encrypt.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { toHex } from '../../util/digest.ts';
import {
  type CencPattern,
  decryptCencFile,
  decryptSampleCbcs,
  decryptSamplesCbcs,
  parseSenc,
  parseTenc,
} from './cenc.ts';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';

const KEY = '000102030405060708090a0b0c0d0e0f';
const KID = '00112233445566778899aabbccddeeff';
const KEY2 = '202122232425262728292a2b2c2d2e2f';
const KID2 = 'ffeeddccbbaa00998877665544332211';
const WRONG = 'ffeeddccbbaa99887766554433221100';
const CONST_IV_HEX = '101112131415161718191a1b1c1d1e1f';
const CONST_IV2_HEX = '303132333435363738393a3b3c3d3e3f';
const CONST_IV8_HEX = 'a0a1a2a3a4a5a6a7';

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Independent (node:crypto / OpenSSL) cbcs construction — the encryption twin for constructed assets.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Crypt-block byte offsets of a crypt:skip pattern within a protected range (spec §10.4; 0:0 ⇒ all). */
function patternOffsets(protectedLen: number, crypt: number, skip: number): number[] {
  const whole = Math.floor(protectedLen / AES_BLOCK);
  const cycle = crypt + skip;
  const out: number[] = [];
  for (let b = 0; b < whole; b++) {
    if (cycle === 0 || b % cycle < crypt) out.push(b * AES_BLOCK);
  }
  return out;
}

/**
 * cbcs-encrypt one sample with node:crypto (OpenSSL) AES-128-CBC, per ISO/IEC 23001-7 §10.4: per
 * protected range, gather the pattern's crypt blocks, CBC-encrypt them as one continuous chain seeded
 * with `iv` (chain reset per range), scatter back; skip blocks and partial tails stay clear.
 */
function osslEncryptCbcs(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
  crypt: number,
  skip: number,
  subsamples?: readonly { clear: number; protected: number }[],
): Uint8Array {
  const iv16 = new Uint8Array(AES_BLOCK);
  iv16.set(iv.subarray(0, Math.min(AES_BLOCK, iv.byteLength)));
  const out = data.slice();
  const ranges = subsamples?.length ? subsamples : [{ clear: 0, protected: data.byteLength }];
  let pos = 0;
  for (const ss of ranges) {
    pos += ss.clear;
    const offsets = patternOffsets(ss.protected, crypt, skip);
    if (offsets.length > 0) {
      const gathered = Buffer.concat(
        offsets.map((off) => Buffer.from(data.subarray(pos + off, pos + off + AES_BLOCK))),
      );
      const c = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv16));
      c.setAutoPadding(false);
      const cipher = Buffer.concat([c.update(gathered), c.final()]);
      offsets.forEach((off, i) =>
        out.set(cipher.subarray(i * AES_BLOCK, (i + 1) * AES_BLOCK), pos + off),
      );
    }
    pos += ss.protected;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Hand-built ISO-BMFF construction (independent of the SUT and of write.ts: plain byte arrays).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function u16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}
function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function u64(v: number): number[] {
  return [...u32(Math.floor(v / 2 ** 32)), ...u32(v >>> 0)];
}
function fcc(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}
type Bytes = number[] | Uint8Array;
function box(type: string, ...parts: Bytes[]): number[] {
  const body = parts.flatMap((p) => [...p]);
  return [...u32(8 + body.length), ...fcc(type), ...body];
}
function full(type: string, version: number, flags: number, ...parts: Bytes[]): number[] {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...parts);
}

interface TencSpec {
  version?: number;
  crypt?: number;
  skip?: number;
  isProtected?: number;
  ivSize: number;
  kid: Uint8Array;
  constantIv?: Uint8Array;
}
function tencBox(t: TencSpec): number[] {
  const version = t.version ?? 1;
  const patternByte = (((t.crypt ?? 0) & 0x0f) << 4) | ((t.skip ?? 0) & 0x0f);
  const constIv = t.constantIv ? [t.constantIv.byteLength, ...t.constantIv] : [];
  return full(
    'tenc',
    version,
    0,
    [0, version >= 1 ? patternByte : 0, t.isProtected ?? 1, t.ivSize],
    t.kid,
    constIv,
  );
}
function sinfBox(originalFormat: string, scheme: string, tenc: TencSpec): number[] {
  return box(
    'sinf',
    box('frma', fcc(originalFormat)),
    full('schm', 0, 0, fcc(scheme), u32(0x00010000)),
    box('schi', tencBox(tenc)),
  );
}

/** A minimal audio sample entry (28-byte body + children), protected (`enca`) or clear (`mp4a`). */
function audioEntry(type: string, ...children: Bytes[]): number[] {
  return box(
    type,
    [0, 0, 0, 0, 0, 0],
    u16(1), // data_reference_index
    u16(0),
    u16(0),
    u32(0),
    u16(1), // channels
    u16(16), // sample size
    u16(0),
    u16(0),
    u32(22050 << 16),
    ...children,
  );
}

/** `sgpd` grouping_type 'seig' (version 1, default_length 0 ⇒ per-entry description_length). */
interface SeigEntry {
  isProtected: number;
  ivSize: number;
  kid: Uint8Array;
  constantIv?: Uint8Array;
  crypt?: number;
  skip?: number;
}
function seigSgpd(entries: SeigEntry[]): number[] {
  const bodies = entries.map((e) => {
    const constIv =
      e.isProtected === 1 && e.ivSize === 0 && e.constantIv
        ? [e.constantIv.byteLength, ...e.constantIv]
        : [];
    return [
      0,
      (((e.crypt ?? 0) & 0x0f) << 4) | ((e.skip ?? 0) & 0x0f),
      e.isProtected,
      e.ivSize,
      ...e.kid,
      ...constIv,
    ];
  });
  return full(
    'sgpd',
    1,
    0,
    fcc('seig'),
    u32(0), // default_length 0 → per-entry description_length
    u32(entries.length),
    bodies.flatMap((b) => [...u32(b.length), ...b]),
  );
}
function sbgpBox(entries: { count: number; index: number }[]): number[] {
  return full(
    'sbgp',
    0,
    0,
    fcc('seig'),
    u32(entries.length),
    entries.flatMap((e) => [...u32(e.count), ...u32(e.index)]),
  );
}

/** A minimal fragmented-movie `moov` (empty stbl) for the given protected/clear audio tracks. */
interface TrakSpec {
  id: number;
  entries: number[][]; // stsd entries (already serialized)
  stblExtra?: number[];
}
function fragMoov(traks: TrakSpec[]): number[] {
  const mvhd = full(
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
    [
      ...u32(0x00010000),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...u32(0x00010000),
      ...u32(0),
      ...u32(0),
      ...u32(0),
      ...u32(0x40000000),
    ],
    new Array(24).fill(0),
    u32(0xffffffff),
  );
  const trakBoxes = traks.map((t) =>
    box(
      'trak',
      full(
        'tkhd',
        0,
        7,
        u32(0),
        u32(0),
        u32(t.id),
        u32(0),
        u32(0),
        u64(0),
        u16(0),
        u16(0),
        u16(0x0100),
        u16(0),
        [
          ...u32(0x00010000),
          ...u32(0),
          ...u32(0),
          ...u32(0),
          ...u32(0x00010000),
          ...u32(0),
          ...u32(0),
          ...u32(0),
          ...u32(0x40000000),
        ],
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
            full('stsd', 0, 0, u32(t.entries.length), ...t.entries),
            full('stts', 0, 0, u32(0)),
            full('stsc', 0, 0, u32(0)),
            full('stsz', 0, 0, u32(0), u32(0)),
            full('stco', 0, 0, u32(0)),
            ...(t.stblExtra ? [t.stblExtra] : []),
          ),
        ),
      ),
    ),
  );
  const mvex = box(
    'mvex',
    ...traks.map((t) => full('trex', 0, 0, u32(t.id), u32(1), u32(1024), u32(0), u32(0))),
  );
  return box('moov', mvhd, ...trakBoxes, mvex);
}

/** One traf's shape inside a constructed fragment. */
interface TrafSpec {
  trackId: number;
  /** Sample payloads (already ciphertext where protected). */
  samples: Uint8Array[];
  /** `senc` entries (one per sample) or undefined for no senc box. */
  senc?: { iv?: Uint8Array; subsamples?: { clear: number; protected: number }[] }[];
  /** Per-sample aux blobs placed at the START of the mdat payload, located via saiz/saio (no senc). */
  auxInMdat?: Uint8Array[];
  saioV1?: boolean;
  saioAuxType?: string;
  saioEntryCount?: number;
  /** tfhd base mode: moof-relative (default-base-is-moof), explicit absolute, or legacy implicit. */
  base?: 'moof' | 'absolute' | 'implicit';
  /** Omit the trun data-offset field (legacy chaining: samples start at the traf base). */
  omitTrunDataOffset?: boolean;
  sbgp?: { count: number; index: number }[];
  sgpd?: SeigEntry[];
  /** Corrupt the senc sample_count (declare more samples than present) for robustness tests. */
  sencCountOverride?: number;
}

interface BuiltFile {
  bytes: Uint8Array;
  /** Absolute [start, start+size) of every sample, in traf order per fragment. */
  ranges: { trackId: number; start: number; size: number }[];
}

/** Build `ftyp + moov + (moof mdat)*` with spec-exact offsets (two-pass: sizes are value-independent). */
function buildFragmentedFile(moov: number[], frags: TrafSpec[][]): BuiltFile {
  const ftyp = box('ftyp', fcc('iso5'), u32(0), fcc('iso5'));

  const buildTraf = (
    t: TrafSpec,
    values: { trunDataOffset: number; saioOffset: number; baseDataOffset: number },
  ): number[] => {
    const base = t.base ?? 'moof';
    const tfhdFlags =
      (base === 'absolute' ? 0x000001 : 0) | 0x000002 | (base === 'moof' ? 0x020000 : 0);
    const tfhd = full(
      'tfhd',
      0,
      tfhdFlags,
      u32(t.trackId),
      base === 'absolute' ? u64(values.baseDataOffset) : [],
      u32(1),
    );
    const tfdt = full('tfdt', 1, 0, u64(0));
    const trunFlags = (t.omitTrunDataOffset ? 0 : 0x000001) | 0x000200;
    const trun = full(
      'trun',
      0,
      trunFlags,
      u32(t.samples.length),
      t.omitTrunDataOffset ? [] : u32(values.trunDataOffset),
      t.samples.flatMap((s) => u32(s.byteLength)),
    );
    const children: number[][] = [tfhd, tfdt, trun];
    if (t.senc) {
      const useSub = t.senc.some((e) => e.subsamples !== undefined);
      const body = t.senc.flatMap((e) => [
        ...(e.iv ?? []),
        ...(useSub
          ? [
              ...u16(e.subsamples?.length ?? 0),
              ...(e.subsamples ?? []).flatMap((ss) => [...u16(ss.clear), ...u32(ss.protected)]),
            ]
          : []),
      ]);
      children.push(
        full('senc', 0, useSub ? 2 : 0, u32(t.sencCountOverride ?? t.senc.length), body),
      );
    }
    const auxSizes = t.senc
      ? undefined
      : t.auxInMdat
        ? t.auxInMdat.map((a) => a.byteLength)
        : undefined;
    if (auxSizes) {
      children.push(full('saiz', 0, 0, [0], u32(auxSizes.length), auxSizes));
    }
    if (t.senc || t.auxInMdat) {
      const auxType = t.saioAuxType ? [...fcc(t.saioAuxType), ...u32(0)] : [];
      const n = t.saioEntryCount ?? 1;
      const offsets = Array.from({ length: n }, () =>
        t.saioV1 ? u64(values.saioOffset) : u32(values.saioOffset),
      ).flat();
      children.push(
        full('saio', t.saioV1 ? 1 : 0, t.saioAuxType ? 1 : 0, auxType, u32(n), offsets),
      );
    }
    if (t.sgpd) children.push(seigSgpd(t.sgpd));
    if (t.sbgp) children.push(sbgpBox(t.sbgp));
    return box('traf', ...children);
  };

  const buildAll = (
    valueRows: { trunDataOffset: number; saioOffset: number; baseDataOffset: number }[][],
  ): { file: number[]; moofStarts: number[]; moofs: number[][] } => {
    const file: number[] = [...ftyp, ...moov];
    const moofStarts: number[] = [];
    const moofs: number[][] = [];
    frags.forEach((trafs, f) => {
      const moof = box(
        'moof',
        full('mfhd', 0, 0, u32(f + 1)),
        ...trafs.map((t, i) =>
          buildTraf(
            t,
            valueRows[f]?.[i] ?? { trunDataOffset: 0, saioOffset: 0, baseDataOffset: 0 },
          ),
        ),
      );
      moofStarts.push(file.length);
      moofs.push(moof);
      const mdatPayload = trafs.flatMap((t) => [
        ...(t.auxInMdat ?? []).flatMap((a) => [...a]),
        ...t.samples.flatMap((s) => [...s]),
      ]);
      file.push(...moof, ...box('mdat', mdatPayload));
    });
    return { file, moofStarts, moofs };
  };

  // Pass 1: placeholder values → learn every size/position (sizes don't depend on the values).
  const zeroRows = frags.map((trafs) =>
    trafs.map(() => ({ trunDataOffset: 0, saioOffset: 0, baseDataOffset: 0 })),
  );
  const pass1 = buildAll(zeroRows);

  // Pass 2: real offsets. Within each moof: mdat payload starts at moofStart + moofSize + 8; each
  // traf's data run follows the previous traf's (aux blobs first, then samples).
  const ranges: BuiltFile['ranges'] = [];
  const rows = frags.map((trafs, f) => {
    const moofStart = pass1.moofStarts[f] ?? 0;
    const moofSize = pass1.moofs[f]?.length ?? 0;
    let cursor = moofStart + moofSize + 8; // absolute position inside the mdat payload
    return trafs.map((t) => {
      const auxLen = (t.auxInMdat ?? []).reduce((n, a) => n + a.byteLength, 0);
      const auxStart = cursor;
      const dataStart = cursor + auxLen;
      // The explicit absolute base points at the traf's data region (aux blobs first); the moof and
      // legacy-implicit (first-traf) modes both resolve to the moof start here.
      const base = (t.base ?? 'moof') === 'absolute' ? auxStart : moofStart;
      // For senc-located aux, saio instead points at the senc sample data — patched in the pass below.
      const saioOffset = t.auxInMdat ? auxStart - base : 0;
      let dataCursor = dataStart;
      for (const s of t.samples) {
        ranges.push({ trackId: t.trackId, start: dataCursor, size: s.byteLength });
        dataCursor += s.byteLength;
      }
      cursor = dataCursor;
      return {
        trunDataOffset: dataStart - base,
        saioOffset,
        baseDataOffset: base,
      };
    });
  });

  // senc-backed saio offsets need the senc data position; compute it from the pass-2 moof layout.
  const pass2a = buildAll(rows);
  frags.forEach((trafs, f) => {
    const moofStart = pass2a.moofStarts[f] ?? 0;
    const moofBytes = pass2a.moofs[f] ?? [];
    let p = 8 + 16; // moof header + mfhd
    trafs.forEach((t, i) => {
      const trafSize = readBoxSize(moofBytes, p);
      if (t.senc) {
        const sencOff = findChildOffset(moofBytes, p, trafSize, 'senc');
        const base =
          (t.base ?? 'moof') === 'absolute' ? (rows[f]?.[i]?.baseDataOffset ?? 0) : moofStart;
        const row = rows[f]?.[i];
        if (row) row.saioOffset = moofStart + sencOff + 16 - base; // box hdr 8 + vf 4 + count 4
      }
      p += trafSize;
    });
  });

  const finalBuild = buildAll(rows);
  return { bytes: Uint8Array.from(finalBuild.file), ranges };
}

function readBoxSize(bytes: number[], at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}
/** Offset (within `bytes`) of the first `type` child inside the box starting at `at`. */
function findChildOffset(bytes: number[], at: number, size: number, type: string): number {
  const want = fcc(type);
  let p = at + 8;
  while (p + 8 <= at + size) {
    const s = readBoxSize(bytes, p);
    if (
      bytes[p + 4] === want[0] &&
      bytes[p + 5] === want[1] &&
      bytes[p + 6] === want[2] &&
      bytes[p + 7] === want[3]
    ) {
      return p;
    }
    if (s < 8) break;
    p += s;
  }
  throw new Error(`child '${type}' not found`);
}

/** Assert `out` equals `expected` on every sample range and matches `src` byte-for-byte elsewhere. */
function expectSampleBytes(
  out: Uint8Array,
  ranges: BuiltFile['ranges'],
  expected: Uint8Array[],
): void {
  expect(out.byteLength).toBeGreaterThan(0);
  ranges.forEach((r, i) => {
    const got = out.subarray(r.start, r.start + r.size);
    const want = expected[i];
    if (!want) throw new Error(`missing expected sample ${i}`);
    expect(got.byteLength, `sample ${i} length`).toBe(want.byteLength);
    expect(toHex(got), `sample ${i} bytes`).toBe(toHex(want));
  });
}

/** Real media bytes as opaque sample payloads (slices of a real fixture's mdat). */
async function realPayloads(sizes: number[], seed = 0): Promise<Uint8Array[]> {
  const media = await loadFixture('movie_5.mp4');
  let off = 5000 + seed * 977;
  return sizes.map((n) => {
    const s = media.slice(off, off + n);
    if (s.byteLength !== n) throw new Error('fixture too small for payload slice');
    off += n + 137;
    return s;
  });
}

const KEYB = hexToBytes(KEY);
const KEY2B = hexToBytes(KEY2);
const KIDB = hexToBytes(KID);
const KID2B = hexToBytes(KID2);
const CONST_IV = hexToBytes(CONST_IV_HEX);
const CONST_IV2 = hexToBytes(CONST_IV2_HEX);
const CONST_IV8 = hexToBytes(CONST_IV8_HEX);

function ivFor(i: number): Uint8Array {
  const iv = new Uint8Array(16);
  iv[0] = 0x9a;
  new DataView(iv.buffer).setUint32(12, i + 1);
  return iv;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// decryptCencFile — the spec-general engine on constructed real-world layouts (openssl-verified)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('decryptCencFile — cbcs layout (i): constant IV, NO aux data at all (full-sample audio)', () => {
  const entry = audioEntry(
    'enca',
    sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV, crypt: 0, skip: 0 }),
  );

  it('decrypts every sample (whole 16-byte blocks, tail clear) with the tenc constant IV', async () => {
    const plain = await realPayloads([48, 33, 160, 15]); // incl. a partial tail and a sub-block sample
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    expect(toHex(cipher[0] ?? new Uint8Array())).not.toBe(toHex(plain[0] ?? new Uint8Array()));
    // A sample smaller than one block stays clear under CBC full-sample rules (§10.1.2).
    expect(toHex(cipher[3] ?? new Uint8Array())).toBe(toHex(plain[3] ?? new Uint8Array()));
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [{ trackId: 1, samples: cipher }],
    ]);
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expect(out.byteLength).toBe(file.bytes.byteLength);
    expectSampleBytes(out, file.ranges, plain);
  });

  it('a wrong key does not recover the plaintext; a missing key is a typed CapabilityError', async () => {
    const plain = await realPayloads([64, 64]);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [{ trackId: 1, samples: cipher }],
    ]);
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: WRONG } });
    expect(
      toHex(out.subarray(file.ranges[0]?.start ?? 0, (file.ranges[0]?.start ?? 0) + 64)),
    ).not.toBe(toHex(plain[0] ?? new Uint8Array()));
    await expect(decryptCencFile(file.bytes, { scheme: 'cbcs', keys: {} })).rejects.toBeInstanceOf(
      CapabilityError,
    );
  });

  it('neutralizes protection signaling: enca → mp4a, sinf → free (offsets preserved)', async () => {
    const plain = await realPayloads([48]);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [{ trackId: 1, samples: cipher }],
    ]);
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    // Scan only the structural prefix (everything before the first sample byte) so arbitrary media
    // payload bytes can never fake or mask a fourcc.
    const structuralEnd = file.ranges[0]?.start ?? file.bytes.byteLength;
    const asText = (b: Uint8Array) => Array.from(b, (x) => String.fromCharCode(x)).join('');
    const inputText = asText(file.bytes.subarray(0, structuralEnd));
    const outputText = asText(out.subarray(0, structuralEnd));
    expect(inputText).toContain('enca');
    expect(inputText).toContain('sinf');
    expect(outputText).not.toContain('enca');
    expect(outputText).not.toContain('sinf');
    expect(outputText).toContain('mp4a');
    // The engine's own probe of its output sees a clear file (no encryption metadata).
    const movie = await readMovie(ra(out));
    expect(movie.tracks[0]?.encryption).toBeUndefined();
  });

  it('an 8-byte constant IV is zero-extended to the full CBC IV (declared spec case)', async () => {
    const plain = await realPayloads([96]);
    const iv16 = new Uint8Array(16);
    iv16.set(CONST_IV8, 0);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, iv16, p, 0, 0));
    const entry8 = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV8, crypt: 0, skip: 0 }),
    );
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry8] }]), [
      [{ trackId: 1, samples: cipher }],
    ]);
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
  });
});

describe('decryptCencFile — cbcs layout (ii): per-sample-IV senc + subsamples, multi-moof', () => {
  const entry = audioEntry(
    'enca',
    sinfBox('mp4a', 'cbcs', { ivSize: 16, kid: KIDB, crypt: 1, skip: 9 }),
  );

  it('decrypts two fragments (moof-relative bases recomputed per fragment) byte-exact', async () => {
    const plain = await realPayloads([700, 450, 650, 520, 610], 1);
    const subs = plain.map((p) => [{ clear: 7, protected: p.byteLength - 7 }]);
    const cipher = plain.map((p, i) => osslEncryptCbcs(KEYB, ivFor(i), p, 1, 9, subs[i]));
    const frag = (lo: number, hi: number): TrafSpec => ({
      trackId: 1,
      samples: cipher.slice(lo, hi),
      senc: cipher.slice(lo, hi).map((_, j) => {
        const s = subs[lo + j];
        return s === undefined ? { iv: ivFor(lo + j) } : { iv: ivFor(lo + j), subsamples: s };
      }),
    });
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [frag(0, 3)],
      [frag(3, 5)],
    ]);
    // The ciphertext really differs from the plaintext on every sample (non-vacuous encryption).
    file.ranges.forEach((r, i) => {
      expect(toHex(file.bytes.subarray(r.start, r.start + r.size))).not.toBe(
        toHex(plain[i] ?? new Uint8Array()),
      );
    });
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
    // senc boxes are neutralized to 'free' in the output (structural prefix of fragment 1 only,
    // so media payload bytes cannot fake a fourcc).
    const structuralEnd = file.ranges[0]?.start ?? 0;
    const outText = Array.from(out.subarray(0, structuralEnd), (x) => String.fromCharCode(x)).join(
      '',
    );
    expect(outText).not.toContain('senc');
  });

  it('per-sample senc IVs take precedence over a tenc constant IV when both exist', async () => {
    const plain = await realPayloads([320], 2);
    const cipher = [osslEncryptCbcs(KEYB, ivFor(9), plain[0] ?? new Uint8Array(), 1, 0)];
    const entryBoth = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 16, kid: KIDB, constantIv: CONST_IV, crypt: 1, skip: 0 }),
    );
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entryBoth] }]), [
      [{ trackId: 1, samples: cipher, senc: [{ iv: ivFor(9) }] }],
    ]);
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
  });
});

describe('decryptCencFile — cbcs layout (iii): sbgp/sgpd seig overrides (clear groups, key rotation)', () => {
  it('honors per-group isProtected/KID/constant-IV overrides from a traf-local sgpd', async () => {
    const plain = await realPayloads([80, 90, 100, 110, 120], 3);
    const cipher = [
      plain[0] ?? new Uint8Array(), // group 0x10001: unprotected → bytes stay clear
      plain[1] ?? new Uint8Array(),
      osslEncryptCbcs(KEY2B, CONST_IV2, plain[2] ?? new Uint8Array(), 0, 0), // group 0x10002: KID2+IV2
      osslEncryptCbcs(KEY2B, CONST_IV2, plain[3] ?? new Uint8Array(), 0, 0),
      osslEncryptCbcs(KEYB, CONST_IV, plain[4] ?? new Uint8Array(), 0, 0), // index 0: tenc defaults
    ];
    const entry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV, crypt: 0, skip: 0 }),
    );
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [
        {
          trackId: 1,
          samples: cipher,
          sgpd: [
            { isProtected: 0, ivSize: 0, kid: new Uint8Array(16) },
            { isProtected: 1, ivSize: 0, kid: KID2B, constantIv: CONST_IV2, crypt: 0, skip: 0 },
          ],
          sbgp: [
            { count: 2, index: 0x10001 },
            { count: 2, index: 0x10002 },
            { count: 1, index: 0 },
          ],
        },
      ],
    ]);
    const out = await decryptCencFile(file.bytes, {
      scheme: 'cbcs',
      keys: { [KID]: KEY, [KID2]: KEY2 },
    });
    expectSampleBytes(out, file.ranges, plain);
    // The seig sample-group boxes are neutralized in the output (structural prefix scan only).
    const structuralEnd = file.ranges[0]?.start ?? 0;
    const outText = Array.from(out.subarray(0, structuralEnd), (x) => String.fromCharCode(x)).join(
      '',
    );
    expect(outText).not.toContain('seig');
  });

  it('resolves group indices ≤ 0xFFFF against the stbl-level sgpd (static groups)', async () => {
    const plain = await realPayloads([64, 96], 4);
    const cipher = [
      plain[0] ?? new Uint8Array(), // stbl sgpd entry 1: unprotected
      osslEncryptCbcs(KEYB, CONST_IV, plain[1] ?? new Uint8Array(), 0, 0), // index 0 → tenc default
    ];
    const entry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV, crypt: 0, skip: 0 }),
    );
    const stblSgpd = seigSgpd([{ isProtected: 0, ivSize: 0, kid: new Uint8Array(16) }]);
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry], stblExtra: stblSgpd }]), [
      [
        {
          trackId: 1,
          samples: cipher,
          sbgp: [
            { count: 1, index: 1 },
            { count: 1, index: 0 },
          ],
        },
      ],
    ]);
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
  });

  it('a used seig KID without a key is a typed CapabilityError; an unused KID needs no key', async () => {
    const plain = await realPayloads([64, 64], 5);
    const cipher = [
      osslEncryptCbcs(KEY2B, CONST_IV2, plain[0] ?? new Uint8Array(), 0, 0),
      osslEncryptCbcs(KEY2B, CONST_IV2, plain[1] ?? new Uint8Array(), 0, 0),
    ];
    const entry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV, crypt: 0, skip: 0 }),
    );
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [
        {
          trackId: 1,
          samples: cipher,
          sgpd: [
            { isProtected: 1, ivSize: 0, kid: KID2B, constantIv: CONST_IV2, crypt: 0, skip: 0 },
          ],
          sbgp: [{ count: 2, index: 0x10001 }],
        },
      ],
    ]);
    // Every sample uses KID2; the tenc default KID is never used, so its key may be absent.
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID2]: KEY2 } });
    expectSampleBytes(out, file.ranges, plain);
    await expect(
      decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe('decryptCencFile — cbcs layout (iv): saiz/saio aux (no senc), absolute base, 64-bit saio', () => {
  it('reads per-sample IV + subsample aux blobs from the mdat via saiz/saio (v1, typed, abs base)', async () => {
    const plain = await realPayloads([300, 250, 410], 6);
    const subs = plain.map((p) => [{ clear: 11, protected: p.byteLength - 11 }]);
    const cipher = plain.map((p, i) => osslEncryptCbcs(KEYB, ivFor(40 + i), p, 1, 9, subs[i]));
    const aux = plain.map((p, i) =>
      Uint8Array.from([...ivFor(40 + i), ...u16(1), ...u16(11), ...u32(p.byteLength - 11)]),
    );
    const entry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 16, kid: KIDB, crypt: 1, skip: 9 }),
    );
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [
        {
          trackId: 1,
          samples: cipher,
          auxInMdat: aux,
          base: 'absolute',
          saioV1: true,
          saioAuxType: 'cbcs',
        },
      ],
    ]);
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
  });

  it('reads saiz/saio aux with a moof-relative base and a v0 saio (no aux_info_type)', async () => {
    const plain = await realPayloads([128, 160], 6);
    const subs = plain.map((p) => [{ clear: 8, protected: p.byteLength - 8 }]);
    const cipher = plain.map((p, i) => osslEncryptCbcs(KEYB, ivFor(120 + i), p, 1, 9, subs[i]));
    const aux = plain.map((p, i) =>
      Uint8Array.from([...ivFor(120 + i), ...u16(1), ...u16(8), ...u32(p.byteLength - 8)]),
    );
    const entry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 16, kid: KIDB, crypt: 1, skip: 9 }),
    );
    // Default `base: 'moof'`, `saioV1: false` (32-bit), no `saioAuxType` → the moof-relative v0 saio path.
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [{ trackId: 1, samples: cipher, auxInMdat: aux }],
    ]);
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
  });

  it('declines a multi-entry saio with a typed CapabilityError (declared, unsupported layout)', async () => {
    const plain = await realPayloads([64], 7);
    const cipher = [osslEncryptCbcs(KEYB, ivFor(50), plain[0] ?? new Uint8Array(), 1, 0)];
    const aux = [Uint8Array.from(ivFor(50))];
    const entry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 16, kid: KIDB, crypt: 1, skip: 0 }),
    );
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [{ trackId: 1, samples: cipher, auxInMdat: aux, saioEntryCount: 2 }],
    ]);
    await expect(
      decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

describe('decryptCencFile — mixed clear/encrypted tracks + legacy traf chaining (layout v)', () => {
  it('decrypts the protected traf and leaves the clear track byte-identical (two trafs, one moof)', async () => {
    const plain = await realPayloads([128, 144], 8);
    const clearTrack = await realPayloads([200, 90], 9);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const protectedEntry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV, crypt: 0, skip: 0 }),
    );
    const clearEntry = audioEntry('mp4a');
    const file = buildFragmentedFile(
      fragMoov([
        { id: 1, entries: [protectedEntry] },
        { id: 2, entries: [clearEntry] },
      ]),
      [
        [
          { trackId: 1, samples: cipher },
          { trackId: 2, samples: clearTrack },
        ],
      ],
    );
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    const expected = [...plain, ...clearTrack];
    expectSampleBytes(out, file.ranges, expected);
  });

  it('resolves the legacy implicit base (no base flags): first traf at moof start, next chained', async () => {
    const plain = await realPayloads([96, 80], 10);
    const chained = await realPayloads([112], 11);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const cipher2 = chained.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const entry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV, crypt: 0, skip: 0 }),
    );
    const entry2 = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV, crypt: 0, skip: 0 }),
    );
    const file = buildFragmentedFile(
      fragMoov([
        { id: 1, entries: [entry] },
        { id: 2, entries: [entry2] },
      ]),
      [
        [
          { trackId: 1, samples: cipher, base: 'implicit' },
          // No base flags and no trun data offset: samples start at the end of traf 1's data.
          { trackId: 2, samples: cipher2, base: 'implicit', omitTrunDataOffset: true },
        ],
      ],
    );
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, [...plain, ...chained]);
  });
});

describe('decryptCencFile — flat (non-fragmented) generality: stbl tables, saiz/saio, multi-stsd', () => {
  /** A flat one-track file: real stbl tables (stsc/stco/stsz), optional stbl senc/saiz/saio. */
  function buildFlatFile(o: {
    entries: number[][];
    chunks: { sampleDescriptionIndex: number; samples: Uint8Array[] }[];
    senc?: { iv?: Uint8Array; subsamples?: { clear: number; protected: number }[] }[];
    auxBeforeSamples?: Uint8Array[];
    /** Emit a 64-bit `co64` chunk-offset table instead of the 32-bit `stco`. */
    co64?: boolean;
    /** Emit a `stsz` with a single uniform sample size instead of a per-sample size array. */
    uniformSampleSize?: number;
    /** Declare this many `saio` offset entries (default 1); >1 exercises the unsupported-layout decline. */
    saioEntryCount?: number;
  }): BuiltFile {
    const allSamples = o.chunks.flatMap((c) => c.samples);
    const auxLen = (o.auxBeforeSamples ?? []).reduce((n, a) => n + a.byteLength, 0);
    const build = (chunkOffsets: number[], saioOffset: number): number[] => {
      const stsc = full(
        'stsc',
        0,
        0,
        u32(o.chunks.length),
        o.chunks.flatMap((c, i) => [
          ...u32(i + 1),
          ...u32(c.samples.length),
          ...u32(c.sampleDescriptionIndex),
        ]),
      );
      const stsz =
        o.uniformSampleSize !== undefined
          ? full('stsz', 0, 0, u32(o.uniformSampleSize), u32(allSamples.length))
          : full(
              'stsz',
              0,
              0,
              u32(0),
              u32(allSamples.length),
              allSamples.flatMap((s) => u32(s.byteLength)),
            );
      const stco = o.co64
        ? full(
            'co64',
            0,
            0,
            u32(chunkOffsets.length),
            chunkOffsets.flatMap((c) => u64(c)),
          )
        : full(
            'stco',
            0,
            0,
            u32(chunkOffsets.length),
            chunkOffsets.flatMap((c) => u32(c)),
          );
      const extras: number[][] = [];
      if (o.senc) {
        const useSub = o.senc.some((e) => e.subsamples !== undefined);
        extras.push(
          full(
            'senc',
            0,
            useSub ? 2 : 0,
            u32(o.senc.length),
            o.senc.flatMap((e) => [
              ...(e.iv ?? []),
              ...(useSub
                ? [
                    ...u16(e.subsamples?.length ?? 0),
                    ...(e.subsamples ?? []).flatMap((ss) => [
                      ...u16(ss.clear),
                      ...u32(ss.protected),
                    ]),
                  ]
                : []),
            ]),
          ),
        );
      }
      if (o.auxBeforeSamples) {
        extras.push(
          full(
            'saiz',
            0,
            0,
            [0],
            u32(o.auxBeforeSamples.length),
            o.auxBeforeSamples.map((a) => a.byteLength),
          ),
        );
        const saioN = o.saioEntryCount ?? 1;
        extras.push(
          full(
            'saio',
            0,
            0,
            u32(saioN),
            Array.from({ length: saioN }, () => u32(saioOffset)).flat(),
          ),
        );
      }
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
          [
            ...u32(0x00010000),
            ...u32(0),
            ...u32(0),
            ...u32(0),
            ...u32(0x00010000),
            ...u32(0),
            ...u32(0),
            ...u32(0),
            ...u32(0x40000000),
          ],
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
            [
              ...u32(0x00010000),
              ...u32(0),
              ...u32(0),
              ...u32(0),
              ...u32(0x00010000),
              ...u32(0),
              ...u32(0),
              ...u32(0),
              ...u32(0x40000000),
            ],
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
                full('stsd', 0, 0, u32(o.entries.length), ...o.entries),
                full('stts', 0, 0, u32(1), u32(allSamples.length), u32(1024)),
                stsc,
                stsz,
                stco,
                ...extras,
              ),
            ),
          ),
        ),
      );
      const mdatPayload = [
        ...(o.auxBeforeSamples ?? []).flatMap((a) => [...a]),
        ...allSamples.flatMap((s) => [...s]),
      ];
      return [
        ...box('ftyp', fcc('isom'), u32(0), fcc('isom')),
        ...moov,
        ...box('mdat', mdatPayload),
      ];
    };
    const pass1 = build(
      o.chunks.map(() => 0),
      0,
    );
    const mdatPayloadStart =
      pass1.length - allSamples.reduce((n, s) => n + s.byteLength, 0) - auxLen;
    const chunkOffsets: number[] = [];
    let cursor = mdatPayloadStart + auxLen;
    const ranges: BuiltFile['ranges'] = [];
    for (const c of o.chunks) {
      chunkOffsets.push(cursor);
      for (const s of c.samples) {
        ranges.push({ trackId: 1, start: cursor, size: s.byteLength });
        cursor += s.byteLength;
      }
    }
    return { bytes: Uint8Array.from(build(chunkOffsets, mdatPayloadStart)), ranges };
  }

  it('flat + stbl saiz/saio (absolute offsets), per-sample IVs, no senc', async () => {
    const plain = await realPayloads([120, 60, 200, 90], 12);
    const cipher = plain.map((p, i) => osslEncryptCbcs(KEYB, ivFor(60 + i), p, 1, 0));
    const aux = plain.map((_, i) => Uint8Array.from(ivFor(60 + i)));
    const entry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 16, kid: KIDB, crypt: 1, skip: 0 }),
    );
    const file = buildFlatFile({
      entries: [entry],
      chunks: [
        { sampleDescriptionIndex: 1, samples: cipher.slice(0, 2) },
        { sampleDescriptionIndex: 1, samples: cipher.slice(2) },
      ],
      auxBeforeSamples: aux,
    });
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
  });

  it('multi-stsd: chunks referencing a clear sample description stay untouched', async () => {
    const plain = await realPayloads([96, 96], 13);
    const clearChunk = await realPayloads([150], 14);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const protectedEntry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV, crypt: 0, skip: 0 }),
    );
    const clearEntry = audioEntry('mp4a');
    const file = buildFlatFile({
      entries: [protectedEntry, clearEntry],
      chunks: [
        { sampleDescriptionIndex: 1, samples: cipher },
        { sampleDescriptionIndex: 2, samples: clearChunk },
      ],
    });
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, [...plain, ...clearChunk]);
  });

  it('flat + stbl senc (per-sample 16-byte IVs + subsamples), no saiz/saio', async () => {
    const plain = await realPayloads([160, 240, 320], 20);
    const subs = plain.map((p) => [{ clear: 6, protected: p.byteLength - 6 }]);
    const cipher = plain.map((p, i) => osslEncryptCbcs(KEYB, ivFor(80 + i), p, 1, 9, subs[i]));
    const entry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 16, kid: KIDB, crypt: 1, skip: 9 }),
    );
    const file = buildFlatFile({
      entries: [entry],
      chunks: [{ sampleDescriptionIndex: 1, samples: cipher }],
      senc: cipher.map((_, i) => {
        const s = subs[i];
        return s === undefined ? { iv: ivFor(80 + i) } : { iv: ivFor(80 + i), subsamples: s };
      }),
    });
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
    // The stbl senc box is neutralized (structural prefix scan of the moov, before any sample).
    const structuralEnd = file.ranges[0]?.start ?? 0;
    const outText = Array.from(out.subarray(0, structuralEnd), (x) => String.fromCharCode(x)).join(
      '',
    );
    expect(outText).not.toContain('senc');
  });

  it('flat with a 64-bit co64 chunk-offset table + a uniform-size stsz', async () => {
    const size = 96;
    const plain = await realPayloads([size, size, size], 23);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const entry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV, crypt: 0, skip: 0 }),
    );
    const file = buildFlatFile({
      entries: [entry],
      chunks: [{ sampleDescriptionIndex: 1, samples: cipher }],
      co64: true,
      uniformSampleSize: size,
    });
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
  });

  it('declines a flat multi-entry saio with a typed CapabilityError (declared, unsupported layout)', async () => {
    const plain = await realPayloads([48], 12);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, ivFor(200), p, 1, 0));
    const aux = plain.map(() => Uint8Array.from(ivFor(200)));
    const entry = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 16, kid: KIDB, crypt: 1, skip: 0 }),
    );
    const file = buildFlatFile({
      entries: [entry],
      chunks: [{ sampleDescriptionIndex: 1, samples: cipher }],
      auxBeforeSamples: aux,
      saioEntryCount: 2,
    });
    await expect(
      decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Parser branch coverage: real trun/tfhd optional fields the higher-level builders don't emit.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('decryptCencFile — trun/tfhd optional fields (default sizes, per-sample duration/flags/cto)', () => {
  const constEntry = audioEntry(
    'enca',
    sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV, crypt: 0, skip: 0 }),
  );

  /** A one-moof/one-traf constant-IV cbcs file with caller-chosen tfhd/trun flag fields (no senc). */
  function richFragFile(o: {
    samples: Uint8Array[];
    tfhdExtraFlags: number;
    tfhdExtras: number[];
    trunFlags: number;
    perSample: (size: number) => number[];
    /** Drop the sample_description_index field (0x000002) so it defaults from `trex`. */
    omitSampleDescIndex?: boolean;
  }): BuiltFile {
    const ftyp = box('ftyp', fcc('iso5'), u32(0), fcc('iso5'));
    const moov = fragMoov([{ id: 1, entries: [constEntry] }]);
    const descIndexFlag = o.omitSampleDescIndex ? 0 : 0x000002;
    const descIndexField = o.omitSampleDescIndex ? [] : u32(1);
    const buildMoof = (dataOffset: number): number[] =>
      box(
        'moof',
        full('mfhd', 0, 0, u32(1)),
        box(
          'traf',
          full(
            'tfhd',
            0,
            0x020000 | descIndexFlag | o.tfhdExtraFlags,
            u32(1),
            descIndexField,
            o.tfhdExtras,
          ),
          full('tfdt', 1, 0, u64(0)),
          full(
            'trun',
            0,
            o.trunFlags,
            u32(o.samples.length),
            u32(dataOffset),
            o.samples.flatMap((s) => o.perSample(s.byteLength)),
          ),
        ),
      );
    const moofSize = buildMoof(0).length;
    const moof = buildMoof(moofSize + 8);
    const dataStart = ftyp.length + moov.length + moof.length + 8;
    const ranges: BuiltFile['ranges'] = [];
    let cursor = dataStart;
    for (const s of o.samples) {
      ranges.push({ trackId: 1, start: cursor, size: s.byteLength });
      cursor += s.byteLength;
    }
    const bytes = [
      ...ftyp,
      ...moov,
      ...moof,
      ...box(
        'mdat',
        o.samples.flatMap((s) => [...s]),
      ),
    ];
    return { bytes: Uint8Array.from(bytes), ranges };
  }

  it('a trun carrying per-sample duration + size + flags + cto, tfhd with a default duration', async () => {
    const plain = await realPayloads([80, 112], 24);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const file = richFragFile({
      samples: cipher,
      tfhdExtraFlags: 0x000008, // default-sample-duration present
      tfhdExtras: u32(1024),
      trunFlags: 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800, // data-offset + dur+size+flags+cto
      perSample: (size) => [...u32(1024), ...u32(size), ...u32(0), ...u32(0)],
    });
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
  });

  it('a trun with no sample-size flag draws sizes from the tfhd default_sample_size', async () => {
    const size = 64;
    const plain = await realPayloads([size, size], 25);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const file = richFragFile({
      samples: cipher,
      tfhdExtraFlags: 0x000010, // default-sample-size present
      tfhdExtras: u32(size),
      trunFlags: 0x000001, // data-offset only → per-sample sizes come from the tfhd default
      perSample: () => [],
    });
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
  });

  it('a tfhd without a sample_description_index falls back to the trex default index', async () => {
    const plain = await realPayloads([96, 128], 26);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const file = richFragFile({
      samples: cipher,
      tfhdExtraFlags: 0,
      tfhdExtras: [],
      trunFlags: 0x000001 | 0x000200, // data-offset + sample-size
      perSample: (size) => u32(size),
      omitSampleDescIndex: true, // → sample_description_index comes from trex (1)
    });
    const out = await decryptCencFile(file.bytes, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expectSampleBytes(out, file.ranges, plain);
  });
});

describe('decryptCencFile — robustness: malformed/contradictory protection rejects with typed errors', () => {
  const entry = audioEntry(
    'enca',
    sinfBox('mp4a', 'cbcs', { ivSize: 0, kid: KIDB, constantIv: CONST_IV, crypt: 0, skip: 0 }),
  );

  async function reject(bytes: Uint8Array, keys: Record<string, string> = { [KID]: KEY }) {
    return decryptCencFile(bytes, { scheme: 'cbcs', keys }).then(
      () => undefined,
      (e: unknown) => e,
    );
  }

  it('rejects a senc whose declared sample count overruns the traf box (bit-flipped count)', async () => {
    const plain = await realPayloads([64], 15);
    const cipher = [osslEncryptCbcs(KEYB, ivFor(70), plain[0] ?? new Uint8Array(), 1, 0)];
    const entry16 = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 16, kid: KIDB, crypt: 1, skip: 0 }),
    );
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry16] }]), [
      [{ trackId: 1, samples: cipher, senc: [{ iv: ivFor(70) }], sencCountOverride: 5000 }],
    ]);
    const err = await reject(file.bytes);
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('rejects sample ranges beyond EOF (truncated mdat) with a MediaError', async () => {
    const plain = await realPayloads([256], 16);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [{ trackId: 1, samples: cipher }],
    ]);
    const truncated = file.bytes.slice(0, file.bytes.byteLength - 100);
    const err = await reject(truncated);
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('rejects an sbgp group index with no sgpd entry, and a reserved isProtected value', async () => {
    const plain = await realPayloads([64], 17);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const danglingIndex = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [{ trackId: 1, samples: cipher, sbgp: [{ count: 1, index: 0x10007 }] }],
    ]);
    expect(await reject(danglingIndex.bytes)).toBeInstanceOf(MediaError);
    const reservedProtected = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [
        {
          trackId: 1,
          samples: cipher,
          sgpd: [{ isProtected: 2, ivSize: 0, kid: KID2B, constantIv: CONST_IV2 }],
          sbgp: [{ count: 1, index: 0x10001 }],
        },
      ],
    ]);
    expect(await reject(reservedProtected.bytes)).toBeInstanceOf(MediaError);
  });

  it('declines an unsupported protection scheme (cbc1) with a CapabilityError', async () => {
    const plain = await realPayloads([64], 18);
    const entryCbc1 = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbc1', { version: 0, ivSize: 16, kid: KIDB }),
    );
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entryCbc1] }]), [
      [{ trackId: 1, samples: plain, senc: [{ iv: ivFor(0) }] }],
    ]);
    const err = await reject(file.bytes);
    expect(err).toBeInstanceOf(CapabilityError);
  });

  it('rejects a scheme mismatch (cbcs file requested as cenc) with a MediaError', async () => {
    const plain = await realPayloads([64], 19);
    const cipher = plain.map((p) => osslEncryptCbcs(KEYB, CONST_IV, p, 0, 0));
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), [
      [{ trackId: 1, samples: cipher }],
    ]);
    const err = await decryptCencFile(file.bytes, { scheme: 'cenc', keys: { [KID]: KEY } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('rejects a protected fragmented file with zero samples anywhere (nothing decryptable)', async () => {
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry] }]), []);
    const err = await reject(file.bytes);
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).message).toContain('no decryptable samples');
  });

  it('rejects a per-sample-IV cbcs track that carries no senc/saio aux and no constant IV', async () => {
    // tenc declares Per_Sample_IV_Size 16 (so no default_constant_IV) but the traf has no senc/saiz —
    // there is no recoverable IV for the protected sample: a typed MediaError, not a wrong result.
    const plain = await realPayloads([64], 21);
    const entry16 = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 16, kid: KIDB, crypt: 1, skip: 9 }),
    );
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry16] }]), [
      [{ trackId: 1, samples: plain }],
    ]);
    const err = await reject(file.bytes);
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('rejects a senc that covers fewer samples than the trun declares (a sample with no aux)', async () => {
    const plain = await realPayloads([64, 64], 22);
    const cipher = plain.map((p, i) => osslEncryptCbcs(KEYB, ivFor(90 + i), p, 1, 0));
    const entry16 = audioEntry(
      'enca',
      sinfBox('mp4a', 'cbcs', { ivSize: 16, kid: KIDB, crypt: 1, skip: 0 }),
    );
    const file = buildFragmentedFile(fragMoov([{ id: 1, entries: [entry16] }]), [
      [{ trackId: 1, samples: cipher, senc: [{ iv: ivFor(90) }] }], // one senc entry, two samples
    ]);
    const err = await reject(file.bytes);
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('rejects a buffer with no moov box (not an MP4/CMAF file) with a MediaError', async () => {
    const bytes = Uint8Array.from(box('ftyp', fcc('iso5'), u32(0), fcc('iso5')));
    const err = await reject(bytes);
    expect(err).toBeInstanceOf(MediaError);
    expect(err).not.toBeInstanceOf(CapabilityError);
  });

  it('passes a fully-clear file through byte-identically (decrypting nothing is the correct result)', async () => {
    const clear = await loadFixture('movie_5.mp4');
    const out = await decryptCencFile(clear, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expect(out.byteLength).toBe(clear.byteLength);
    expect(toHex(out.subarray(0, 512))).toBe(toHex(clear.subarray(0, 512)));
    expect(toHex(out.subarray(clear.byteLength - 512))).toBe(
      toHex(clear.subarray(clear.byteLength - 512)),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Third-party leg: Bento4 (mp4fragment + mp4encrypt) constructs a REAL fragmented cbcs asset.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const bento4 = spawnSync('mp4encrypt', [], { encoding: 'utf8' }).error === undefined;
const describeBento4 = bento4 ? describe : describe.skip;

describeBento4(
  'decryptCencFile — Bento4-encrypted REAL fragmented cbcs (independent construction)',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbcs-bento4-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    /** Top-level mdat payloads of an MP4, in file order (raw box scan — no SUT involvement). */
    function mdatPayloads(bytes: Uint8Array): Uint8Array[] {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const out: Uint8Array[] = [];
      let p = 0;
      while (p + 8 <= bytes.byteLength) {
        let size = dv.getUint32(p);
        const type = String.fromCharCode(
          bytes[p + 4] ?? 0,
          bytes[p + 5] ?? 0,
          bytes[p + 6] ?? 0,
          bytes[p + 7] ?? 0,
        );
        let header = 8;
        if (size === 1) {
          size = Number(dv.getBigUint64(p + 8));
          header = 16;
        } else if (size === 0) {
          size = bytes.byteLength - p;
        }
        if (size < header || p + size > bytes.byteLength) break;
        if (type === 'mdat') out.push(bytes.subarray(p + header, p + size));
        p += size;
      }
      return out;
    }

    async function bento4Assets(): Promise<{ clear: Uint8Array; enc: Uint8Array }> {
      const src = join(dir, 'src.mp4');
      const frag = join(dir, 'frag.mp4');
      const enc = join(dir, 'cbcs.mp4');
      writeFileSync(src, await loadFixture('movie_5.mp4'));
      execFileSync('mp4fragment', ['--fragment-duration', '500', src, frag]);
      execFileSync('mp4encrypt', [
        '--method',
        'MPEG-CBCS',
        '--key',
        `1:${KEY}:${CONST_IV_HEX}`,
        '--property',
        `1:KID:${KID}`,
        '--key',
        `2:${KEY}:${CONST_IV_HEX}`,
        '--property',
        `2:KID:${KID}`,
        frag,
        enc,
      ]);
      return { clear: new Uint8Array(readFileSync(frag)), enc: new Uint8Array(readFileSync(enc)) };
    }

    it('recovers every mdat payload byte-exact vs the clear original (video 1:9 + audio 0:0 full-sample)', async () => {
      const { clear, enc } = await bento4Assets();
      const clearMdats = mdatPayloads(clear);
      const encMdats = mdatPayloads(enc);
      expect(clearMdats.length).toBeGreaterThan(1); // multi-moof, multi-track
      expect(encMdats.length).toBe(clearMdats.length);
      // Bento4 really encrypted: the payloads differ before decryption.
      expect(encMdats.some((m, i) => toHex(m) !== toHex(clearMdats[i] ?? new Uint8Array()))).toBe(
        true,
      );

      const out = await decryptCencFile(enc, { scheme: 'cbcs', keys: { [KID]: KEY } });
      expect(out.byteLength).toBe(enc.byteLength);
      const outMdats = mdatPayloads(out);
      expect(outMdats.length).toBe(clearMdats.length);
      outMdats.forEach((m, i) => {
        expect(toHex(m), `mdat #${i}`).toBe(toHex(clearMdats[i] ?? new Uint8Array()));
      });
      // The output probes as a CLEAR movie (avc1/mp4a, no encryption metadata).
      const movie = await readMovie(ra(out));
      expect(movie.tracks.every((t) => t.encryption === undefined)).toBe(true);
      expect(movie.tracks.map((t) => t.sampleEntryType).sort()).toEqual(['avc1', 'mp4a']);
    });

    it('a wrong key does NOT recover the payloads (the oracle can fail)', async () => {
      const { clear, enc } = await bento4Assets();
      const out = await decryptCencFile(enc, { scheme: 'cbcs', keys: { [KID]: WRONG } });
      const clearMdats = mdatPayloads(clear);
      const outMdats = mdatPayloads(out);
      expect(outMdats.some((m, i) => toHex(m) !== toHex(clearMdats[i] ?? new Uint8Array()))).toBe(
        true,
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Driver end-to-end (flat, stbl-senc layout) — the pre-existing real-media coverage, unchanged.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

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

  it('decrypts a REAL-ENCRYPTED constant-IV no-senc flat file via decryptCencFile (spec §9.4.1)', async () => {
    // Per ISO/IEC 23001-7 §9.4.1, a protected cbcs track with a tenc default_constant_IV and NO sample
    // auxiliary data is FULLY ENCRYPTED (that is the point of the constant IV) — it must be decrypted,
    // not passed through. The old "Bento4 leaves bytes unchanged" passthrough assumption was wrong:
    // Bento4's own mp4decrypt decrypts this layout (verified against mp4decrypt + openssl, ADR-182).
    const clear = await loadFixture('movie_5.mp4');
    const enc = await encryptCbcs(clear, {
      keyHex: KEY,
      kidHex: KID,
      cryptByteBlock: 0,
      skipByteBlock: 0, // 0:0 = full-sample signaling (whole blocks encrypted, tail clear)
      mediaType: 'audio',
      constantIvHex: CONST_IV_HEX,
    });
    const encryptedMovie = await readMovie(ra(enc));
    const encryptedAudio = encryptedMovie.tracks.find((t) => t.mediaType === 'audio');
    expect(encryptedAudio?.encryption?.senc).toBeUndefined(); // truly no aux data
    expect(encryptedAudio?.encryption?.schemeType).toBe('cbcs');

    const clearAudio = await trackSamples(clear, 'audio');
    expect(await trackSamples(enc, 'audio')).not.toEqual(clearAudio); // really encrypted

    // Independent-encryptor cross-check: the helper's ciphertext equals node:crypto's on sample 0.
    const cipherAudio = await trackSamples(enc, 'audio');
    const first = clearAudio[0];
    if (first && first.byteLength >= AES_BLOCK) {
      expect(toHex(cipherAudio[0] ?? new Uint8Array())).toBe(
        toHex(osslEncryptCbcs(KEYB, CONST_IV, first, 0, 0)),
      );
    }

    const out = await decryptCencFile(enc, { scheme: 'cbcs', keys: { [KID]: KEY } });
    expect(await trackSamples(out, 'audio')).toEqual(clearAudio);
  });
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
  const KEYB2 = hexToBytes(KEY);
  const PATTERN: CencPattern = { cryptByteBlock: 1, skipByteBlock: 0 }; // full CBC of every whole block
  const CONST_IV_L = hexToBytes('101112131415161718191a1b1c1d1e1f');

  it('decryptSamplesCbcs uses the track constantIv when a sample carries no per-sample IV', async () => {
    // Two whole-sample packets (no subsample map), encrypted with the SAME constant IV.
    const a = Uint8Array.from({ length: 48 }, (_, i) => (i * 5 + 1) & 0xff);
    const b = Uint8Array.from({ length: 32 }, (_, i) => (i * 9 + 2) & 0xff);
    const encA = await encryptSampleCbcs(KEYB2, CONST_IV_L, a, 1, 0);
    const encB = await encryptSampleCbcs(KEYB2, CONST_IV_L, b, 1, 0);
    // senc with empty per-sample IVs (per-sample IV size 0 ⇒ the constant IV is applied).
    const senc = [{ iv: new Uint8Array(0) }, { iv: new Uint8Array(0) }];
    const clear = await decryptSamplesCbcs(KEYB2, [encA, encB], senc, PATTERN, CONST_IV_L);
    expect([...(clear[0] ?? [])]).toEqual([...a]);
    expect([...(clear[1] ?? [])]).toEqual([...b]);
  });

  it('decryptSamplesCbcs passes through a sample that has no matching senc entry', async () => {
    const a = await encryptSampleCbcs(KEYB2, CONST_IV_L, new Uint8Array(16).fill(3), 1, 0);
    const b = Uint8Array.from({ length: 8 }, (_, i) => i + 1);
    // Only one senc entry for two samples: the second is emitted unchanged.
    const clear = await decryptSamplesCbcs(
      KEYB2,
      [a, b],
      [{ iv: new Uint8Array(0) }],
      PATTERN,
      CONST_IV_L,
    );
    expect([...(clear[1] ?? [])]).toEqual([...b]);
  });

  it('decryptSamplesCbcs rejects a sample with neither a per-sample IV nor a constant IV', async () => {
    const enc = await encryptSampleCbcs(KEYB2, CONST_IV_L, new Uint8Array(16).fill(7), 1, 0);
    await expect(
      decryptSamplesCbcs(KEYB2, [enc], [{ iv: new Uint8Array(0) }], PATTERN, undefined),
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

  it('accepts the 0:0 pattern as "no pattern in use" (full-sample signaling, §10.4.2) — the real-world audio tenc', () => {
    // Bento4/Apple write tenc v1 with crypt:skip 0:0 + constant IV for cbcs AUDIO tracks: whole-sample
    // encryption, no pattern. Rejecting it (the old behavior) rejected every real-world cbcs audio track.
    const t = parseTenc(
      cbcsTenc({ crypt: 0, skip: 0, ivSize: 0, constantIv: hexToBytes(CONST_IV_HEX) }),
      'cbcs',
    );
    expect(t.isProtected).toBe(true);
    expect(t.pattern).toBeUndefined(); // 0:0 normalizes to "no pattern" → whole-block encryption downstream
    expect([...(t.constantIv ?? [])]).toEqual([...hexToBytes(CONST_IV_HEX)]);
    // Also legal with per-sample IVs (full-sample per-sample-IV cbcs).
    expect(parseTenc(cbcsTenc({ crypt: 0, skip: 0, ivSize: 16 }), 'cbcs').pattern).toBeUndefined();
  });

  it('rejects a crypt 0 / skip > 0 pattern (a declared pattern that encrypts nothing)', () => {
    expect(() => parseTenc(cbcsTenc({ crypt: 0, skip: 9, ivSize: 16 }), 'cbcs')).toThrow(
      MediaError,
    );
  });

  it('rejects per-sample IV size 0 with no/short default_constant_IV', () => {
    expect(() => parseTenc(cbcsTenc({ crypt: 1, skip: 9, ivSize: 0 }), 'cbcs')).toThrow(MediaError);
  });

  it('rejects a default_constant_IV of an illegal size (neither 8 nor 16 bytes)', () => {
    const badIv = hexToBytes('01020304050607'); // 7 bytes
    expect(() =>
      parseTenc(cbcsTenc({ crypt: 1, skip: 9, ivSize: 0, constantIv: badIv }), 'cbcs'),
    ).toThrow(MediaError);
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
