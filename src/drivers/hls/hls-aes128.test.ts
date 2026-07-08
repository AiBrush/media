/**
 * HLS `AES-128` full-segment decryption — REAL-corpus conformance across every RFC 8216 §4.3.2.4
 * playlist shape (BUILD §2/§6.1; task: the fair-harness `hls_aes128` red). The subjects are the baked
 * fixtures under `fixtures/media-derived/hls-aes128/` (see `scripts/bake-hls-aes128-fixtures.ts`):
 * ffmpeg-authored (`-hls_key_info_file`) and openssl-encrypted playlists covering
 *
 *  - explicit `IV=0x…` (ffmpeg's writer shape) with a non-zero `EXT-X-MEDIA-SEQUENCE`,
 *  - IMPLICIT IVs (no IV attribute → the segment's media sequence number as a 128-bit BE integer),
 *    at media-sequence 47, 0 (six-segment IV progression), and 2^32 (past the 32-bit boundary),
 *  - mid-playlist key ROTATION (k1 implicit → k2 explicit, CRLF endings),
 *  - `METHOD=NONE` mid-playlist (encrypted head, clear tail, cross-directory URIs),
 *  - single-file `EXT-X-BYTERANGE` (explicit offsets AND the §4.3.2.2 continuation form),
 *  - a packed-audio (raw ADTS) rendition — the stitched cleartext is NOT MPEG-TS,
 *  - fMP4 with an ENCRYPTED `EXT-X-MAP` init section (§4.3.2.5, explicit IV required).
 *
 * Oracles are can-fail and independent (directive 6): (1) the stitched cleartext MD5 equals the baked
 * golden produced by the `openssl` CLI at bake time (and each playlist was ffprobe-verified — a second
 * RFC 8216 implementation agreed); (2) each committed ciphertext segment is decrypted IN-TEST by
 * `node:crypto` (OpenSSL) with the manifest key/IV and must match our stitched slice byte-for-byte;
 * (3) MPEG-TS structure: `len % 188 == 0` and a 0x47 sync byte at every packet; (4) the unmodified
 * engine probes the stitched source to ffprobe's duration. Synthetic RFC edges (continuation-offset
 * parsing, malformed/short IVs, implicit-IV map) are unit-proven at the bottom.
 */

import { createDecipheriv, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { InputError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import {
  type HlsResourceFetcher,
  isHlsPlaylist,
  resolveHlsSource,
  resolveHlsSourceFromSource,
} from './hls-source.ts';
import { parseM3u8 } from './m3u8-parse.ts';

const FIXTURE_ROOT = new URL('../../../fixtures/media-derived/hls-aes128/', import.meta.url)
  .pathname;

interface BakedByteRange {
  length: number;
  offset: number;
}
interface BakedSegment {
  file: string;
  keyHex: string | null;
  ivHex: string | null;
  plainMd5: string;
  byteRange?: BakedByteRange;
}
interface BakedVariant {
  id: string;
  playlist: string;
  mime: string;
  ffprobe: { durationSec: number; codecs: string[] };
  stitchedPlainMd5: string;
  segments: BakedSegment[];
}
interface Manifest {
  version: 1;
  variants: BakedVariant[];
}

async function loadManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(join(FIXTURE_ROOT, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    throw new Error(
      'hls-aes128 fixtures are not baked — run `bun scripts/bake-hls-aes128-fixtures.ts` first',
    );
  }
}
async function variant(id: string): Promise<BakedVariant> {
  const found = (await loadManifest()).variants.find((v) => v.id === id);
  if (found === undefined) throw new Error(`no baked hls-aes128 variant '${id}'`);
  return found;
}

/** Resolve a baked variant through the real code path (file:// base URL + local-file fetcher). */
async function resolveVariant(v: BakedVariant): Promise<{ bytes: Uint8Array; mimeHint?: string }> {
  const playlistPath = join(FIXTURE_ROOT, v.playlist);
  const fetchResource: HlsResourceFetcher = async (uri) =>
    new Uint8Array(await readFile(new URL(uri).pathname));
  const src = await resolveHlsSource(await readFile(playlistPath, 'utf8'), {
    baseUrl: `file://${playlistPath}`,
    fetchResource,
  });
  return { bytes: await drain(src.stream()), ...(src.mimeHint ? { mimeHint: src.mimeHint } : {}) };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

/** The in-test independent AES twin: node:crypto (OpenSSL) AES-128-CBC decrypt + PKCS#7 strip. */
function opensslTwinDecrypt(keyHex: string, ivHex: string, cipher: Uint8Array): Uint8Array {
  const d = createDecipheriv('aes-128-cbc', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  return new Uint8Array(Buffer.concat([d.update(cipher), d.final()]));
}

/** Read a manifest segment's ciphertext window (whole file, or its BYTERANGE sub-range). */
async function cipherWindow(v: BakedVariant, seg: BakedSegment): Promise<Uint8Array> {
  const dir = join(FIXTURE_ROOT, v.playlist, '..');
  const bytes = new Uint8Array(await readFile(join(dir, seg.file)));
  return seg.byteRange
    ? bytes.subarray(seg.byteRange.offset, seg.byteRange.offset + seg.byteRange.length)
    : bytes;
}

function assertTsSync(bytes: Uint8Array): void {
  expect(bytes.byteLength % 188).toBe(0);
  for (let i = 0; i < bytes.byteLength; i += 188) {
    if (bytes[i] !== 0x47) {
      throw new Error(`missing 0x47 TS sync at packet ${i / 188} of ${bytes.byteLength / 188}`);
    }
  }
}

/** Per-segment oracle: our stitched output slices == the node:crypto twin over the same ciphertext. */
async function assertSegmentsMatchTwin(
  v: BakedVariant,
  stitched: Uint8Array,
  startOffset = 0,
): Promise<void> {
  let off = startOffset;
  for (const seg of v.segments.filter((s) => !s.file.startsWith('init.'))) {
    const cipher = await cipherWindow(v, seg);
    const plain =
      seg.keyHex === null || seg.ivHex === null
        ? cipher
        : opensslTwinDecrypt(seg.keyHex, seg.ivHex, cipher);
    expect(md5(plain)).toBe(seg.plainMd5); // the committed ciphertext still matches its baked golden
    expect(stitched.subarray(off, off + plain.byteLength)).toEqual(plain);
    off += plain.byteLength;
  }
  expect(off).toBe(stitched.byteLength);
}

const TS_VARIANTS = [
  'ffmpeg-explicit-seq47',
  'implicit-seq47',
  'implicit-seq0',
  'rotation',
  'none-mid',
  'byterange',
  'byterange-continuation',
  'seq-2pow32',
] as const;

describe('resolveHlsSource — AES-128 across real RFC 8216 playlist shapes (baked corpus)', () => {
  for (const id of TS_VARIANTS) {
    it(`${id}: decrypts + stitches byte-exactly (openssl golden + node:crypto twin), TS-sync-valid`, async () => {
      const v = await variant(id);
      const { bytes, mimeHint } = await resolveVariant(v);
      expect(mimeHint).toBe('video/mp2t');
      assertTsSync(bytes);
      expect(md5(bytes)).toBe(v.stitchedPlainMd5);
      await assertSegmentsMatchTwin(v, bytes);
    });
  }

  it('implicit-seq47: the engine probes the stitched TS to ffprobe duration with video+audio tracks', async () => {
    const v = await variant('implicit-seq47');
    const playlistPath = join(FIXTURE_ROOT, v.playlist);
    const src = await resolveHlsSource(await readFile(playlistPath, 'utf8'), {
      baseUrl: `file://${playlistPath}`,
      fetchResource: async (uri) => new Uint8Array(await readFile(new URL(uri).pathname)),
    });
    const info = await createMedia().probe(src);
    expect(info.container).toBe('ts');
    expect(Math.abs(info.durationSec - v.ffprobe.durationSec)).toBeLessThan(0.6);
    expect(info.tracks.some((t) => t.type === 'video')).toBe(true);
    expect(info.tracks.some((t) => t.type === 'audio')).toBe(true);
  });

  it('audio-adts: a packed-audio rendition decrypts byte-exactly and routes as ADTS, not MPEG-TS', async () => {
    const v = await variant('audio-adts');
    const { bytes, mimeHint } = await resolveVariant(v);
    expect(md5(bytes)).toBe(v.stitchedPlainMd5); // decrypt itself is bit-exact (ADTS, 0xFF 0xFx lead)
    await assertSegmentsMatchTwin(v, bytes);
    expect(mimeHint).toBe('audio/aac'); // NOT video/mp2t — that misroute was the harness red
    const playlistPath = join(FIXTURE_ROOT, v.playlist);
    const src = await resolveHlsSource(await readFile(playlistPath, 'utf8'), {
      baseUrl: `file://${playlistPath}`,
      fetchResource: async (uri) => new Uint8Array(await readFile(new URL(uri).pathname)),
    });
    const info = await createMedia().probe(src);
    expect(info.container).toBe('adts');
    expect(Math.abs(info.durationSec - v.ffprobe.durationSec)).toBeLessThan(0.6);
  });

  it('fmp4-encmap: an encrypted EXT-X-MAP init section is decrypted per §4.3.2.5 and probes as MP4', async () => {
    const v = await variant('fmp4-encmap');
    const { bytes, mimeHint } = await resolveVariant(v);
    expect(mimeHint).toBe('video/mp4');
    expect(md5(bytes)).toBe(v.stitchedPlainMd5); // init.mp4 cleartext leads, then the six fragments
    const init = v.segments.find((s) => s.file.startsWith('init.'));
    if (init === undefined || init.keyHex === null || init.ivHex === null) {
      throw new Error('baked fmp4-encmap manifest is missing its encrypted init entry');
    }
    const initPlain = opensslTwinDecrypt(init.keyHex, init.ivHex, await cipherWindow(v, init));
    expect(md5(initPlain)).toBe(init.plainMd5);
    expect(bytes.subarray(0, initPlain.byteLength)).toEqual(initPlain);
    await assertSegmentsMatchTwin(v, bytes, initPlain.byteLength);
    const playlistPath = join(FIXTURE_ROOT, v.playlist);
    const src = await resolveHlsSource(await readFile(playlistPath, 'utf8'), {
      baseUrl: `file://${playlistPath}`,
      fetchResource: async (uri) => new Uint8Array(await readFile(new URL(uri).pathname)),
    });
    const info = await createMedia().probe(src);
    expect(info.container).toBe('mp4');
    expect(Math.abs(info.durationSec - v.ffprobe.durationSec)).toBeLessThan(0.6);
  });
});

// ── synthetic RFC 8216 edges (no corpus needed) ─────────────────────────────────────────────────────

function mapFetcher(files: Record<string, string | Uint8Array>): HlsResourceFetcher {
  return async (uri) => {
    const name = uri.split('/').pop() ?? uri;
    const v = files[name];
    if (v === undefined) throw new Error(`synthetic 404: ${name}`);
    return typeof v === 'string' ? new TextEncoder().encode(v) : v;
  };
}

function cbcEncrypt(key: Buffer, iv: Buffer, plain: Buffer): Uint8Array {
  const { createCipheriv } = require('node:crypto') as typeof import('node:crypto');
  const c = createCipheriv('aes-128-cbc', key, iv);
  return new Uint8Array(Buffer.concat([c.update(plain), c.final()]));
}

describe('parseM3u8 — EXT-X-BYTERANGE offset materialization (RFC 8216 §4.3.2.2)', () => {
  it('a range without @offset continues at the previous end of the same resource', () => {
    const p = parseM3u8(
      [
        '#EXTM3U',
        '#EXTINF:1,',
        '#EXT-X-BYTERANGE:100@0',
        'all.ts',
        '#EXTINF:1,',
        '#EXT-X-BYTERANGE:50',
        'all.ts',
        '#EXTINF:1,',
        '#EXT-X-BYTERANGE:25',
        'all.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    if (p.type !== 'media') throw new Error('expected media playlist');
    expect(p.segments.map((s) => s.byteRange)).toEqual([
      { length: 100, offset: 0 },
      { length: 50, offset: 100 },
      { length: 25, offset: 150 },
    ]);
  });

  it('rejects a first range with no @offset (no previous sub-range to continue)', () => {
    expect(() =>
      parseM3u8(
        ['#EXTM3U', '#EXTINF:1,', '#EXT-X-BYTERANGE:100', 'all.ts', '#EXT-X-ENDLIST'].join('\n'),
      ),
    ).toThrowError(InputError);
  });

  it('rejects a continuation range whose previous segment is a different resource', () => {
    expect(() =>
      parseM3u8(
        [
          '#EXTM3U',
          '#EXTINF:1,',
          '#EXT-X-BYTERANGE:100@0',
          'a.ts',
          '#EXTINF:1,',
          '#EXT-X-BYTERANGE:50',
          'b.ts',
          '#EXT-X-ENDLIST',
        ].join('\n'),
      ),
    ).toThrowError(InputError);
  });
});

describe('resolveHlsSource — IV attribute edge semantics (RFC 8216 §4.3.2.4)', () => {
  const KEY = Buffer.alloc(16, 7);

  it('a malformed IV attribute is a typed error, never a silent sequence-IV fallback', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0xnothex',
      '#EXTINF:1,',
      's0.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    // Ciphertext valid under the SEQUENCE IV: if the malformed IV silently fell back, this would
    // "succeed" with wrong semantics — the resolve must reject instead.
    const ct = cbcEncrypt(KEY, Buffer.alloc(16, 0), Buffer.from([1, 2, 3]));
    await expect(
      resolveHlsSource(playlist, {
        baseUrl: 'http://h/',
        fetchResource: mapFetcher({ 'k.key': new Uint8Array(KEY), 's0.ts': ct }),
      }),
    ).rejects.toMatchObject({ name: 'InputError' });
  });

  it('a short hex IV is a 128-bit big-endian integer (left-padded), upper- or lowercase 0x', async () => {
    // IV=0X7F ≡ 00…7f. Encrypt with the padded IV; the playlist carries the short form.
    const iv = Buffer.alloc(16, 0);
    iv[15] = 0x7f;
    const ct = cbcEncrypt(KEY, iv, Buffer.from([9, 8, 7, 6]));
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0X7F',
      '#EXTINF:1,',
      's0.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const src = await resolveHlsSource(playlist, {
      baseUrl: 'http://h/',
      fetchResource: mapFetcher({ 'k.key': new Uint8Array(KEY), 's0.ts': ct }),
    });
    expect([...(await drain(src.stream()))]).toEqual([9, 8, 7, 6]);
  });

  it('an implicit-IV key applying to an EXT-X-MAP is a typed error (§4.3.2.5: IV REQUIRED)', async () => {
    const iv = Buffer.alloc(16, 0);
    const encInit = cbcEncrypt(KEY, iv, Buffer.from([0xaa, 0xbb]));
    const encSeg = cbcEncrypt(KEY, iv, Buffer.from([1]));
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="k.key"', // no IV → cannot apply to a media-init section
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:1,',
      's0.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n');
    await expect(
      resolveHlsSource(playlist, {
        baseUrl: 'http://h/',
        fetchResource: mapFetcher({
          'k.key': new Uint8Array(KEY),
          'init.mp4': encInit,
          's0.m4s': encSeg,
        }),
      }),
    ).rejects.toMatchObject({ name: 'InputError' });
  });

  it('a clear EXT-X-MAP declared before any key stays clear while segments decrypt', async () => {
    const iv = Buffer.alloc(16, 0); // sequence 0
    const encSeg = cbcEncrypt(KEY, iv, Buffer.from([1, 2]));
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"', // declared BEFORE the key → not encrypted
      '#EXT-X-KEY:METHOD=AES-128,URI="k.key"',
      '#EXTINF:1,',
      's0.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const src = await resolveHlsSource(playlist, {
      baseUrl: 'http://h/',
      fetchResource: mapFetcher({
        'k.key': new Uint8Array(KEY),
        'init.mp4': new Uint8Array([0xf0, 0x0d]),
        's0.m4s': encSeg,
      }),
    });
    expect(src.mimeHint).toBe('video/mp4');
    expect([...(await drain(src.stream()))]).toEqual([0xf0, 0x0d, 1, 2]);
  });
});

// ── ADR-183: the fair-harness `probe/hls_aes128` shape + the manifest-detection / Source seam ─────────
//
// The harness red was NEVER a decrypt bug: `resolveHlsSource` already recovers the exact corpus segments
// byte-for-byte (proven above + in hls-source.test.ts). The red is a ROUTING gap — the `.m3u8` manifest was
// handed to the MPEG-TS driver undecrypted (tagged `video/mp2t`), which correctly found no `0x47` sync run
// in the manifest/segment bytes (ts-parse.ts). These tests pin (1) the EXACT harness playlist shape
// decrypting 0x47-sync-valid + openssl-byte-equal, (2) the real corpus `probe/hls_aes128` file end to end,
// and (3) the `isHlsPlaylist` + `resolveHlsSourceFromSource` seam the engine uses to auto-resolve a manifest
// input BEFORE container routing (the one-line glue is core-owned — ADR-183 addendum).

/** The probe-scenario playlist's declared key (16 raw bytes) + explicit IV — mirrored for the hermetic case. */
const HARNESS_IV_HEX = '953e5e232e1585e615d9164ece153cf2';
const HARNESS_KEY = Buffer.from('366a63833fcc99941516c6239b0d3f11', 'hex');
const HARNESS_PROBE_DIR = new URL(
  '../../../../media-test/media-browser-test/fixtures/media/scenarios/probe/hls_aes128/',
  import.meta.url,
).pathname;

/** The byte-exact fair-harness `hls_aes128.m3u8` shape: v3 VOD, explicit `IV=0x…`, 5× `2.000000` TS, LF. */
function harnessShapedPlaylist(): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-KEY:METHOD=AES-128,URI="hls_aes128.key",IV=0x${HARNESS_IV_HEX}`,
    '#EXTINF:2.000000,',
    'hls_aes128_000.ts',
    '#EXTINF:2.000000,',
    'hls_aes128_001.ts',
    '#EXTINF:2.000000,',
    'hls_aes128_002.ts',
    '#EXTINF:2.000000,',
    'hls_aes128_003.ts',
    '#EXTINF:2.000000,',
    'hls_aes128_004.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

/** A structurally valid MPEG-TS payload: `packets` 188-byte packets, each 0x47-synced (varied body bytes). */
function syntheticTs(packets: number, seed: number): Uint8Array {
  const out = new Uint8Array(packets * 188);
  for (let p = 0; p < packets; p++) {
    const base = p * 188;
    out[base] = 0x47;
    for (let i = 1; i < 188; i++) out[base + i] = (seed + p * 31 + i * 7) & 0xff;
  }
  return out;
}

describe('resolveHlsSource — the fair-harness hls_aes128 shape (ADR-183)', () => {
  it('hermetic harness shape: 5 explicit-IV TS segments decrypt 0x47-sync-valid + openssl byte-equal', async () => {
    const iv = Buffer.from(HARNESS_IV_HEX, 'hex');
    const segments = [3, 5, 4, 6, 2].map((n, i) => {
      const clear = syntheticTs(n, i * 40 + 1);
      return {
        name: `hls_aes128_00${i}.ts`,
        clear,
        cipher: cbcEncrypt(HARNESS_KEY, iv, Buffer.from(clear)),
      };
    });
    const files: Record<string, Uint8Array> = { 'hls_aes128.key': new Uint8Array(HARNESS_KEY) };
    for (const s of segments) files[s.name] = s.cipher;

    const src = await resolveHlsSource(harnessShapedPlaylist(), {
      fetchResource: mapFetcher(files),
    });
    expect(src.mimeHint).toBe('video/mp2t');
    const stitched = await drain(src.stream());
    assertTsSync(stitched); // len % 188 == 0 AND a 0x47 sync at every packet — the exact `probe` oracle

    let off = 0;
    for (const s of segments) {
      // Independent AES twin (node:crypto === the openssl CLI): the ciphertext really decrypts to the clear
      // TS, and our stitched slice equals it byte-for-byte — a falsifiable oracle, not a fabricated cleartext.
      const twin = opensslTwinDecrypt(HARNESS_KEY.toString('hex'), HARNESS_IV_HEX, s.cipher);
      expect(twin).toEqual(s.clear);
      expect(stitched.subarray(off, off + twin.byteLength)).toEqual(twin);
      off += twin.byteLength;
    }
    expect(off).toBe(stitched.byteLength);
  });

  it('the ACTUAL corpus probe/hls_aes128 file decrypts 0x47-sync-valid, node:crypto byte-equal, probes as TS', async () => {
    const playlistText = await readFile(join(HARNESS_PROBE_DIR, 'hls_aes128.m3u8'), 'utf8');
    const fetchLocal: HlsResourceFetcher = async (uri) =>
      new Uint8Array(await readFile(join(HARNESS_PROBE_DIR, uri.split('/').pop() ?? uri)));

    const src = await resolveHlsSource(playlistText, { fetchResource: fetchLocal });
    expect(src.mimeHint).toBe('video/mp2t');
    const stitched = await drain(src.stream());
    assertTsSync(stitched);

    const keyHex = Buffer.from(await readFile(join(HARNESS_PROBE_DIR, 'hls_aes128.key'))).toString(
      'hex',
    );
    const ivMatch = /IV=0x([0-9a-fA-F]{32})/.exec(playlistText);
    if (ivMatch === null || ivMatch[1] === undefined) {
      throw new Error('corpus probe/hls_aes128 playlist unexpectedly lacks an explicit 128-bit IV');
    }
    const ivHex = ivMatch[1];
    let off = 0;
    for (const name of [
      'hls_aes128_000.ts',
      'hls_aes128_001.ts',
      'hls_aes128_002.ts',
      'hls_aes128_003.ts',
      'hls_aes128_004.ts',
    ]) {
      const cipher = new Uint8Array(await readFile(join(HARNESS_PROBE_DIR, name)));
      const twin = opensslTwinDecrypt(keyHex, ivHex, cipher);
      expect(stitched.subarray(off, off + twin.byteLength)).toEqual(twin);
      off += twin.byteLength;
    }
    expect(off).toBe(stitched.byteLength);

    // The unmodified engine now probes the RESOLVED source as MPEG-TS with real video + audio tracks —
    // exactly what the harness `probe/hls_aes128` scenario asks for (the decrypt was never the blocker).
    const info = await createMedia().probe(src);
    expect(info.container).toBe('ts');
    expect(info.tracks.some((t) => t.type === 'video')).toBe(true);
    expect(info.tracks.some((t) => t.type === 'audio')).toBe(true);
  }, 30_000); // real 4.5 MB AES-128 decrypt + full probe — generous under v8-coverage instrumentation
});

describe('isHlsPlaylist — structural #EXTM3U detection (RFC 8216 §4.3.1.1)', () => {
  const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('accepts a manifest head: LF, CRLF, the bare tag at EOF, and a leading UTF-8 BOM', () => {
    expect(isHlsPlaylist(utf8('#EXTM3U\n#EXT-X-VERSION:3\n'))).toBe(true);
    expect(isHlsPlaylist(utf8('#EXTM3U\r\n'))).toBe(true);
    expect(isHlsPlaylist(utf8('#EXTM3U'))).toBe(true);
    expect(isHlsPlaylist(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('#EXTM3U\n')]))).toBe(true);
  });

  it('rejects a TS segment, an MP4 ftyp, a longer token, and short/empty heads', () => {
    expect(isHlsPlaylist(Uint8Array.from([0x47, 0x40, 0x00, 0x10, 0x00]))).toBe(false);
    expect(isHlsPlaylist(utf8('   ftypisom'))).toBe(false);
    expect(isHlsPlaylist(utf8('#EXTM3Ualbum'))).toBe(false);
    expect(isHlsPlaylist(utf8('#EXTM'))).toBe(false);
    expect(isHlsPlaylist(new Uint8Array(0))).toBe(false);
  });
});

describe('resolveHlsSourceFromSource — manifest Source → resolved segment Source (the engine seam)', () => {
  it('detects HLS on the head, then resolves a bytes manifest Source to a 0x47-sync TS Source', async () => {
    const iv = Buffer.from(HARNESS_IV_HEX, 'hex');
    const clear = syntheticTs(4, 9);
    const cipher = cbcEncrypt(HARNESS_KEY, iv, Buffer.from(clear));
    const playlist = [
      '#EXTM3U',
      `#EXT-X-KEY:METHOD=AES-128,URI="hls_aes128.key",IV=0x${HARNESS_IV_HEX}`,
      '#EXTINF:2.000000,',
      'hls_aes128_000.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');

    // The manifest as the engine sees it after `normalizeInput`: a re-readable bytes Source.
    const manifestSrc = fromBytes(new TextEncoder().encode(playlist), {
      mime: 'application/vnd.apple.mpegurl',
    });
    const head = manifestSrc.range ? await manifestSrc.range(0, 16) : new Uint8Array();
    expect(isHlsPlaylist(head)).toBe(true); // the engine's pre-route detection step

    const resolved = await resolveHlsSourceFromSource(manifestSrc, {
      fetchResource: mapFetcher({
        'hls_aes128.key': new Uint8Array(HARNESS_KEY),
        'hls_aes128_000.ts': cipher,
      }),
    });
    expect(resolved.mimeHint).toBe('video/mp2t'); // now routable to the MPEG-TS driver, 0x47-sync-valid
    const out = await drain(resolved.stream());
    assertTsSync(out);
    expect(out).toEqual(clear);
  });
});
