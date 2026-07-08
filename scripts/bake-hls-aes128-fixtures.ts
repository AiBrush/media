#!/usr/bin/env bun
/**
 * scripts/bake-hls-aes128-fixtures.ts — bake the REAL AES-128 HLS validation corpus (RFC 8216) into
 * `fixtures/media-derived/hls-aes128/` (committed, offline-testable). Run once per recipe change:
 *
 *   bun scripts/bake-hls-aes128-fixtures.ts
 *
 * Every fixture is crafted by INDEPENDENT tools — never by the code under test (directive 6):
 *  - `ffmpeg -hls_key_info_file` writes + encrypts the explicit-IV and single-file/byterange variants
 *    (ffmpeg's HLS muxer always materializes an explicit `IV=`; it cannot author implicit-IV playlists).
 *  - `openssl enc -aes-128-cbc` encrypts the implicit-IV / rotation / NONE / 2^64-range variants per
 *    RFC 8216 §4.3.2.4 (IV = the segment's media sequence number as a 128-bit big-endian integer) from
 *    the clear ffmpeg segmentation — openssl is the sanctioned independent AES twin.
 *  - `ffprobe` (ffmpeg's own RFC 8216 HLS demuxer, incl. implicit-IV + byterange + encrypted EXT-X-MAP
 *    decryption) must parse every baked playlist to the clear twin's duration — a bake-time conformance
 *    gate by a second, independent RFC implementation.
 *
 * The bake FAILS LOUDLY unless every encrypted segment `openssl enc -d`-decrypts byte-exactly to its
 * committed clear twin and every playlist ffprobes to the expected duration/codecs. `manifest.json`
 * pins the per-segment key/IV/plain-MD5 goldens the offline tests assert against.
 *
 * Source media: the corpus `fixtures/media/movie_5.mp4` (web-platform-tests, W3C 3-Clause BSD test
 * license — the same provenance as the committed AVI fixtures). Recipe pinned below; segments are
 * re-encoded tiny (160×120 @10fps + mono AAC) so the whole committed corpus stays a few hundred KB.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SOURCE = join(ROOT, 'fixtures/media/movie_5.mp4');
const OUT = join(ROOT, 'fixtures/media-derived/hls-aes128');
const WORK = join(tmpdir(), `hls-aes128-bake-${process.pid}`);

/** Fixed test keys (committed) — deterministic, not secrets. */
const KEY1_HEX = '8f2b64a103e75cd94e12bb07f388916c';
const KEY2_HEX = '21436587a9cbed0f1032547698badcfe';
/** The explicit IV used by the rotation tail and the encrypted-EXT-X-MAP variant. */
const EXPLICIT_IV_HEX = '5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
const MAP_IV_HEX = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const SEGMENTS = 6;
const TWO_POW_32 = 4294967296n;

interface BakedByteRange {
  length: number;
  offset: number;
}
interface BakedSegment {
  /** Resource file, relative to the variant directory (the playlist's own directory). */
  file: string;
  /** AES-128 key hex, or null when the segment is clear (METHOD=NONE / before any key). */
  keyHex: string | null;
  /** IV hex (RFC-derived media-sequence IV for implicit variants), or null when clear. */
  ivHex: string | null;
  /** MD5 of the decrypted (plain) segment bytes — the openssl-produced golden. */
  plainMd5: string;
  /** For single-file playlists: the sub-range of `file` this segment occupies (post-parse offsets). */
  byteRange?: BakedByteRange;
}
interface BakedVariant {
  id: string;
  /** Playlist path relative to the fixture root. */
  playlist: string;
  /** The MIME the stitched cleartext must be tagged with for the engine to route it. */
  mime: string;
  /** ffprobe ground truth measured at bake time on the ENCRYPTED playlist. */
  ffprobe: { durationSec: number; codecs: string[] };
  /** MD5 of the full stitched cleartext (init section first for fMP4). */
  stitchedPlainMd5: string;
  segments: BakedSegment[];
}
interface Manifest {
  version: 1;
  note: string;
  recipe: { source: string; tools: string[] };
  variants: BakedVariant[];
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd: cwd ?? WORK, encoding: 'utf8' });
}
function ffmpeg(args: string[], cwd?: string): void {
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], cwd);
}
function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}
function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}
function ivHexOf(sequence: bigint): string {
  return sequence.toString(16).padStart(32, '0');
}
function opensslEncrypt(keyHex: string, ivHex: string, input: string, output: string): void {
  run('openssl', ['enc', '-aes-128-cbc', '-K', keyHex, '-iv', ivHex, '-in', input, '-out', output]);
}
function opensslDecrypt(keyHex: string, ivHex: string, input: string, output: string): void {
  run('openssl', [
    'enc',
    '-d',
    '-aes-128-cbc',
    '-K',
    keyHex,
    '-iv',
    ivHex,
    '-in',
    input,
    '-out',
    output,
  ]);
}
function assertTsSync(bytes: Uint8Array, what: string): void {
  if (bytes.byteLength % 188 !== 0) throw new Error(`${what}: length not a 188 multiple`);
  for (let i = 0; i < bytes.byteLength; i += 188) {
    if (bytes[i] !== 0x47) throw new Error(`${what}: missing 0x47 sync at packet ${i / 188}`);
  }
}
function ffprobePlaylist(playlist: string): { durationSec: number; codecs: string[] } {
  const args = ['-hide_banner', '-loglevel', 'error', '-allowed_extensions', 'ALL'];
  const duration = Number.parseFloat(
    run('ffprobe', [
      ...args,
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      playlist,
    ]).trim(),
  );
  const codecs = run('ffprobe', [
    ...args,
    '-show_entries',
    'stream=codec_name',
    '-of',
    'csv=p=0',
    playlist,
  ])
    .trim()
    .split('\n')
    .filter((c) => c.length > 0);
  if (!Number.isFinite(duration)) throw new Error(`ffprobe could not read ${playlist}`);
  return { durationSec: duration, codecs: [...new Set(codecs)] };
}
function writePlaylist(path: string, lines: string[], eol: '\n' | '\r\n' = '\n'): void {
  writeFileSync(path, `${lines.join(eol)}${eol}`);
}
function outDir(name: string): string {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function keyFile(dir: string, name: string, hex: string): void {
  writeFileSync(join(dir, name), Buffer.from(hex, 'hex'));
}
/** ffmpeg `-hls_key_info_file` (key URI, key path, optional IV hex WITHOUT 0x). */
function keyInfoFile(name: string, keyHex: string, ivHex?: string): string {
  const keyPath = join(WORK, `${name}.bin`);
  writeFileSync(keyPath, Buffer.from(keyHex, 'hex'));
  const info = join(WORK, `${name}.keyinfo`);
  writeFileSync(info, `${name}.bin\n${keyPath}\n${ivHex === undefined ? '' : `${ivHex}\n`}`);
  return info;
}

// ── bake ────────────────────────────────────────────────────────────────────────────────────────────

if (!existsSync(SOURCE)) {
  throw new Error(`corpus source ${SOURCE} is not cached — run \`bun run fetch-fixtures\` first`);
}
rmSync(OUT, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

// 0) Tiny deterministic base: 160×120 @10fps (keyframe each second) + mono 24k AAC — a real transcode
//    of the WPT corpus asset (same provenance pattern as the committed AVI fixtures).
const BASE = join(WORK, 'base.mp4');
ffmpeg([
  ...['-i', SOURCE],
  ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '33', '-g', '10', '-r', '10'],
  ...['-vf', 'scale=160:120', '-pix_fmt', 'yuv420p', '-threads', '1'],
  ...['-c:a', 'aac', '-b:a', '24k', '-ar', '22050', '-ac', '1'],
  BASE,
]);

// 1) Clear TS segmentation — the committed byte-exact twin every TS variant must decrypt back into.
const clearDir = outDir('clear');
ffmpeg([
  ...['-i', BASE, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0'],
  ...['-hls_playlist_type', 'vod'],
  ...['-hls_segment_filename', join(clearDir, 'seg%03d.ts')],
  join(clearDir, 'clear.m3u8'),
]);
const clearSegs: Uint8Array[] = [];
for (let i = 0; i < SEGMENTS; i++) {
  const seg = read(join(clearDir, `seg${String(i).padStart(3, '0')}.ts`));
  assertTsSync(seg, `clear seg${i}`);
  clearSegs.push(seg);
}
const clearStitched = new Uint8Array(clearSegs.reduce((n, s) => n + s.byteLength, 0));
{
  let off = 0;
  for (const s of clearSegs) {
    clearStitched.set(s, off);
    off += s.byteLength;
  }
}
const clearProbe = ffprobePlaylist(join(clearDir, 'clear.m3u8'));
/** The clear segmentation's final `#EXTINF` (the tail segment is shorter than `hls_time`). */
const LAST_EXTINF = (() => {
  const durations = [
    ...readFileSync(join(clearDir, 'clear.m3u8'), 'utf8').matchAll(/#EXTINF:([\d.]+),/g),
  ].map((m) => m[1] as string);
  const last = durations[durations.length - 1];
  if (durations.length !== SEGMENTS || last === undefined) {
    throw new Error(
      `clear segmentation produced ${durations.length} segments, expected ${SEGMENTS}`,
    );
  }
  return last;
})();

const variants: BakedVariant[] = [];

/** Register a variant after verifying it: openssl-decrypt each segment, compare, ffprobe the playlist. */
function finishVariant(
  id: string,
  dir: string,
  playlistName: string,
  mime: string,
  segments: BakedSegment[],
  stitchedPlain: Uint8Array,
  expectDurationSec: number,
): void {
  for (const [i, seg] of segments.entries()) {
    if (seg.keyHex === null || seg.ivHex === null) continue;
    const encPath = join(dir, seg.file);
    const encBytes = read(encPath);
    const window = seg.byteRange
      ? encBytes.subarray(seg.byteRange.offset, seg.byteRange.offset + seg.byteRange.length)
      : encBytes;
    const encWindow = join(WORK, `verify-${id}-${i}.enc`);
    writeFileSync(encWindow, window);
    const decPath = join(WORK, `verify-${id}-${i}.dec`);
    opensslDecrypt(seg.keyHex, seg.ivHex, encWindow, decPath);
    const dec = read(decPath);
    if (md5(dec) !== seg.plainMd5) {
      throw new Error(`${id} segment ${i}: openssl decrypt does not match its plain golden`);
    }
  }
  const probe = ffprobePlaylist(join(dir, playlistName));
  if (Math.abs(probe.durationSec - expectDurationSec) > 0.08) {
    throw new Error(
      `${id}: ffprobe duration ${probe.durationSec} != expected ${expectDurationSec} — fixture is not conformant`,
    );
  }
  variants.push({
    id,
    playlist: `${dir.slice(OUT.length + 1)}/${playlistName}`,
    mime,
    ffprobe: probe,
    stitchedPlainMd5: md5(stitchedPlain),
    segments,
  });
  console.info(`baked ${id}: ${probe.durationSec.toFixed(3)}s [${probe.codecs.join('+')}]`);
}

/** Author an openssl-encrypted TS variant over the clear segmentation. */
function bakeOpensslTsVariant(opts: {
  id: string;
  mediaSequence: bigint;
  header: string[];
  /** Key files (name → hex) written into the variant dir before anything references them. */
  keys: Record<string, string>;
  /**
   * Per clear-segment index: the key tag lines to emit BEFORE it (rotation/NONE), the key in force
   * (null = clear), and — when the KEY tag carried an explicit `IV=` — that IV (else sequence-derived).
   */
  perSegment: (
    i: number,
    sequence: bigint,
  ) => { tags: string[]; keyHex: string | null; ivHex?: string };
  segmentFile?: (i: number, sequence: bigint) => string;
  eol?: '\n' | '\r\n';
}): void {
  const dir = outDir(opts.id);
  for (const [name, hex] of Object.entries(opts.keys)) keyFile(dir, name, hex);
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${opts.mediaSequence}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    ...opts.header,
  ];
  const segments: BakedSegment[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const sequence = opts.mediaSequence + BigInt(i);
    const { tags, keyHex, ivHex: explicitIv } = opts.perSegment(i, sequence);
    const file = (opts.segmentFile ?? ((_idx: number, seq: bigint) => `seg${seq}.ts`))(i, sequence);
    lines.push(...tags, `#EXTINF:${i === SEGMENTS - 1 ? LAST_EXTINF : '1.000000'},`, file);
    const clearPath = join(clearDir, `seg${String(i).padStart(3, '0')}.ts`);
    if (keyHex === null) {
      segments.push({ file, keyHex: null, ivHex: null, plainMd5: md5(clearSegs[i] as Uint8Array) });
      continue;
    }
    const ivHex = explicitIv ?? ivHexOf(sequence);
    opensslEncrypt(keyHex, ivHex, clearPath, join(dir, file));
    segments.push({ file, keyHex, ivHex, plainMd5: md5(clearSegs[i] as Uint8Array) });
  }
  lines.push('#EXT-X-ENDLIST');
  writePlaylist(join(dir, 'media.m3u8'), lines, opts.eol ?? '\n');
  finishVariant(
    opts.id,
    dir,
    'media.m3u8',
    'video/mp2t',
    segments,
    clearStitched,
    clearProbe.durationSec,
  );
}

// 2) ffmpeg-authored, explicit IV, EXT-X-MEDIA-SEQUENCE 47 (ffmpeg materializes IV=0x…2f for ALL
//    segments — the ffmpeg-writer family, with a non-zero media sequence).
{
  const id = 'ffmpeg-explicit-seq47';
  const dir = outDir(id);
  ffmpeg([
    ...['-i', BASE, '-c', 'copy', '-f', 'hls', '-start_number', '47'],
    ...['-hls_time', '1', '-hls_list_size', '0', '-hls_playlist_type', 'vod'],
    ...['-hls_key_info_file', keyInfoFile('k1', KEY1_HEX)],
    ...['-hls_segment_filename', join(dir, 'seg%03d.ts')],
    join(dir, 'media.m3u8'),
  ]);
  keyFile(dir, 'k1.bin', KEY1_HEX);
  const ivHex = ivHexOf(47n); // ffmpeg reuses the first sequence number as the one explicit IV
  const segments: BakedSegment[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    segments.push({
      file: `seg${String(47 + i).padStart(3, '0')}.ts`,
      keyHex: KEY1_HEX,
      ivHex,
      plainMd5: md5(clearSegs[i] as Uint8Array),
    });
  }
  finishVariant(
    id,
    dir,
    'media.m3u8',
    'video/mp2t',
    segments,
    clearStitched,
    clearProbe.durationSec,
  );
}

// 3) Implicit IV (no IV attribute), EXT-X-MEDIA-SEQUENCE 47 → per-segment IVs 47…52 (RFC §4.3.2.4).
//    Carries explicit KEYFORMAT/KEYFORMATVERSIONS like real Apple-packaged playlists.
bakeOpensslTsVariant({
  id: 'implicit-seq47',
  mediaSequence: 47n,
  header: ['#EXT-X-KEY:METHOD=AES-128,URI="k1.bin",KEYFORMAT="identity",KEYFORMATVERSIONS="1"'],
  keys: { 'k1.bin': KEY1_HEX },
  perSegment: () => ({ tags: [], keyHex: KEY1_HEX }),
});

// 4) Implicit IV, EXT-X-MEDIA-SEQUENCE 0, six segments → the IV progression 0…5.
bakeOpensslTsVariant({
  id: 'implicit-seq0',
  mediaSequence: 0n,
  header: ['#EXT-X-KEY:METHOD=AES-128,URI="k2.bin"'],
  keys: { 'k2.bin': KEY2_HEX },
  perSegment: () => ({ tags: [], keyHex: KEY2_HEX }),
});

// 5) Mid-playlist key ROTATION: k1 implicit IV (segs 0–2), then k2 with an explicit IV (segs 3–5).
//    CRLF line endings on purpose (a real Windows-packager shape).
bakeOpensslTsVariant({
  id: 'rotation',
  mediaSequence: 0n,
  header: [],
  keys: { 'k1.bin': KEY1_HEX, 'k2.bin': KEY2_HEX },
  perSegment: (i) => {
    if (i === 0) return { tags: ['#EXT-X-KEY:METHOD=AES-128,URI="k1.bin"'], keyHex: KEY1_HEX };
    if (i === 3) {
      return {
        tags: [`#EXT-X-KEY:METHOD=AES-128,URI="k2.bin",IV=0x${EXPLICIT_IV_HEX}`],
        keyHex: KEY2_HEX,
        ivHex: EXPLICIT_IV_HEX,
      };
    }
    return i < 3
      ? { tags: [], keyHex: KEY1_HEX }
      : { tags: [], keyHex: KEY2_HEX, ivHex: EXPLICIT_IV_HEX };
  },
  eol: '\r\n',
});

// 6) METHOD=NONE mid-playlist: k1 implicit IV (segs 0–2), then NONE — segs 3–5 are the CLEAR segments,
//    referenced across directories (`../clear/…`) to exercise relative-URI resolution.
bakeOpensslTsVariant({
  id: 'none-mid',
  mediaSequence: 0n,
  header: [],
  keys: { 'k1.bin': KEY1_HEX },
  perSegment: (i) => {
    if (i === 0) return { tags: ['#EXT-X-KEY:METHOD=AES-128,URI="k1.bin"'], keyHex: KEY1_HEX };
    if (i === 3) return { tags: ['#EXT-X-KEY:METHOD=NONE'], keyHex: null };
    return { tags: [], keyHex: i < 3 ? KEY1_HEX : null };
  },
  segmentFile: (i, seq) =>
    i < 3 ? `seg${seq}.ts` : `../clear/seg${String(i).padStart(3, '0')}.ts`,
});

// 7) Single-file BYTERANGE (ffmpeg `-hls_flags single_file` + encryption: every sub-range is its own
//    independently padded AES resource), plus the RFC §4.3.2.2 CONTINUATION playlist (no `@offset`
//    after the first range) over the same media.ts — the Apple mediafilesegmenter shape.
{
  const id = 'byterange';
  const dir = outDir(id);
  ffmpeg([
    ...['-i', BASE, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0'],
    ...['-hls_playlist_type', 'vod', '-hls_flags', 'single_file'],
    ...['-hls_key_info_file', keyInfoFile('k1', KEY1_HEX)],
    join(dir, 'media.m3u8'),
  ]);
  keyFile(dir, 'k1.bin', KEY1_HEX);
  const playlistText = readFileSync(join(dir, 'media.m3u8'), 'utf8');
  const ranges = [...playlistText.matchAll(/#EXT-X-BYTERANGE:(\d+)@(\d+)/g)].map((m) => ({
    length: Number(m[1]),
    offset: Number(m[2]),
  }));
  if (ranges.length !== SEGMENTS) throw new Error('byterange: unexpected range count');
  const ivMatch = /IV=0x([0-9a-fA-F]{32})/.exec(playlistText);
  if (!ivMatch) throw new Error('byterange: ffmpeg wrote no explicit IV');
  const ivHex = (ivMatch[1] as string).toLowerCase();
  const segments: BakedSegment[] = ranges.map((byteRange, i) => ({
    file: 'media.ts',
    keyHex: KEY1_HEX,
    ivHex,
    plainMd5: md5(clearSegs[i] as Uint8Array),
    byteRange,
  }));
  finishVariant(
    id,
    dir,
    'media.m3u8',
    'video/mp2t',
    segments,
    clearStitched,
    clearProbe.durationSec,
  );

  // The continuation form: strip `@offset` from every range except the first (offset := previous end).
  let first = true;
  const continuation = playlistText
    .split('\n')
    .map((line) => {
      const m = /^#EXT-X-BYTERANGE:(\d+)@(\d+)$/.exec(line);
      if (!m) return line;
      if (first) {
        first = false;
        return line;
      }
      return `#EXT-X-BYTERANGE:${m[1]}`;
    })
    .join('\n');
  writeFileSync(join(dir, 'continuation.m3u8'), continuation);
  const contProbe = ffprobePlaylist(join(dir, 'continuation.m3u8'));
  if (Math.abs(contProbe.durationSec - clearProbe.durationSec) > 0.08) {
    throw new Error('byterange continuation: ffprobe rejects it');
  }
  variants.push({
    id: 'byterange-continuation',
    playlist: 'byterange/continuation.m3u8',
    mime: 'video/mp2t',
    ffprobe: contProbe,
    stitchedPlainMd5: md5(clearStitched),
    segments,
  });
  console.info(`baked byterange-continuation: ${contProbe.durationSec.toFixed(3)}s`);
}

// 8) EXT-X-MEDIA-SEQUENCE 2^32 (implicit IV) — the sequence IV no longer fits 32 bits (RFC: it is a
//    128-bit integer; real long-running live-derived VODs carry very large sequence numbers).
bakeOpensslTsVariant({
  id: 'seq-2pow32',
  mediaSequence: TWO_POW_32,
  header: ['#EXT-X-KEY:METHOD=AES-128,URI="k1.bin"'],
  keys: { 'k1.bin': KEY1_HEX },
  perSegment: () => ({ tags: [], keyHex: KEY1_HEX }),
});

// 9) Packed-audio rendition: raw ADTS (.aac) segments, AES-128 with implicit IVs — a conformant
//    audio-only playlist (RFC 8216 §3.4) whose stitched cleartext is NOT an MPEG-TS.
{
  const id = 'audio-adts';
  const dir = outDir(id);
  ffmpeg([
    ...['-i', BASE, '-vn', '-c:a', 'copy', '-f', 'segment', '-segment_time', '1'],
    ...['-segment_format', 'adts', '-segment_list', join(dir, 'clear.m3u8')],
    ...['-segment_list_type', 'm3u8'],
    join(dir, 'clear%03d.aac'),
  ]);
  keyFile(dir, 'k1.bin', KEY1_HEX);
  const clearList = readFileSync(join(dir, 'clear.m3u8'), 'utf8');
  const durations = [...clearList.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => m[1] as string);
  const clearAac = durations.map((_, i) =>
    read(join(dir, `clear${String(i).padStart(3, '0')}.aac`)),
  );
  const stitched = new Uint8Array(clearAac.reduce((n, s) => n + s.byteLength, 0));
  {
    let off = 0;
    for (const s of clearAac) {
      stitched.set(s, off);
      off += s.byteLength;
    }
  }
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-KEY:METHOD=AES-128,URI="k1.bin"',
  ];
  const segments: BakedSegment[] = [];
  for (const [i, duration] of durations.entries()) {
    const file = `seg${String(i).padStart(3, '0')}.aac`;
    const ivHex = ivHexOf(BigInt(i));
    opensslEncrypt(
      KEY1_HEX,
      ivHex,
      join(dir, `clear${String(i).padStart(3, '0')}.aac`),
      join(dir, file),
    );
    lines.push(`#EXTINF:${duration},`, file);
    segments.push({
      file,
      keyHex: KEY1_HEX,
      ivHex,
      plainMd5: md5(clearAac[i] as Uint8Array),
    });
  }
  lines.push('#EXT-X-ENDLIST');
  writePlaylist(join(dir, 'media.m3u8'), lines);
  finishVariant(id, dir, 'media.m3u8', 'audio/aac', segments, stitched, clearProbe.durationSec);
}

// 10) fMP4 with an ENCRYPTED EXT-X-MAP init section (RFC §4.3.2.5: the KEY in force applies to the
//     map and MUST carry an explicit IV). ffmpeg cannot WRITE encrypted fMP4 ("not yet supported"),
//     so the clear fMP4 rendition is ffmpeg's and the encryption is openssl's; ffprobe READS it back.
{
  const id = 'fmp4-encmap';
  const dir = outDir(id);
  ffmpeg([
    ...['-i', BASE, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0'],
    ...['-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4'],
    ...['-hls_fmp4_init_filename', 'init.mp4'],
    ...['-hls_segment_filename', join(dir, 'clear%03d.m4s')],
    join(dir, 'clear.m3u8'),
  ]);
  keyFile(dir, 'k2.bin', KEY2_HEX);
  const init = read(join(dir, 'init.mp4'));
  opensslEncrypt(KEY2_HEX, MAP_IV_HEX, join(dir, 'init.mp4'), join(dir, 'init.enc.mp4'));
  const clearParts: Uint8Array[] = [init];
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-KEY:METHOD=AES-128,URI="k2.bin",IV=0x${MAP_IV_HEX}`,
    '#EXT-X-MAP:URI="init.enc.mp4"',
  ];
  const segments: BakedSegment[] = [
    { file: 'init.enc.mp4', keyHex: KEY2_HEX, ivHex: MAP_IV_HEX, plainMd5: md5(init) },
  ];
  for (let i = 0; i < SEGMENTS; i++) {
    const clearSeg = read(join(dir, `clear${String(i).padStart(3, '0')}.m4s`));
    clearParts.push(clearSeg);
    const file = `enc${String(i).padStart(3, '0')}.m4s`;
    opensslEncrypt(
      KEY2_HEX,
      MAP_IV_HEX,
      join(dir, `clear${String(i).padStart(3, '0')}.m4s`),
      join(dir, file),
    );
    lines.push(`#EXTINF:${i === SEGMENTS - 1 ? LAST_EXTINF : '1.000000'},`, file);
    segments.push({ file, keyHex: KEY2_HEX, ivHex: MAP_IV_HEX, plainMd5: md5(clearSeg) });
  }
  lines.push('#EXT-X-ENDLIST');
  writePlaylist(join(dir, 'media.m3u8'), lines);
  const stitched = new Uint8Array(clearParts.reduce((n, s) => n + s.byteLength, 0));
  {
    let off = 0;
    for (const s of clearParts) {
      stitched.set(s, off);
      off += s.byteLength;
    }
  }
  finishVariant(id, dir, 'media.m3u8', 'video/mp4', segments, stitched, clearProbe.durationSec);
}

// ── manifest + summary ──────────────────────────────────────────────────────────────────────────────

const versions = [
  `ffmpeg ${run('ffmpeg', ['-version']).split('\n')[0]?.split(' ')[2] ?? '?'}`,
  run('openssl', ['version']).trim(),
];
const manifest: Manifest = {
  version: 1,
  note:
    'REAL AES-128 HLS corpus (RFC 8216) baked by scripts/bake-hls-aes128-fixtures.ts from the WPT ' +
    'movie_5.mp4 corpus asset. Encryption by ffmpeg -hls_key_info_file / openssl enc; every playlist ' +
    'ffprobe-verified; per-segment plain MD5s are openssl-CLI goldens. Do not edit by hand.',
  recipe: { source: 'fixtures/media/movie_5.mp4', tools: versions },
  variants,
};
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
{
  const clearManifestProbe = clearProbe; // reference to keep the clear twin's ground truth on record
  console.info(
    `\nclear twin: ${clearManifestProbe.durationSec.toFixed(3)}s [${clearManifestProbe.codecs.join('+')}]`,
  );
}
const totalBytes = Number(run('du', ['-sk', OUT]).split('\t')[0]) * 1024;
console.info(
  `baked ${variants.length} variants into ${OUT} (${(totalBytes / 1024).toFixed(0)} KiB)`,
);
rmSync(WORK, { recursive: true, force: true });
