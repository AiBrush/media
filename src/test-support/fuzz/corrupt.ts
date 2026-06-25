/**
 * Shared corrupt-input generator + bounded watchdog for the parser fuzz/robustness battery
 * (BUILD_INSTRUCTIONS §6.2 "Robustness/fuzz: garbled/truncated/zeroed/bitflipped/empty inputs reject
 * cleanly — no crash, no wrong output", and the typed-error model of `contracts/errors.ts`).
 *
 * The battery's **oracle** is not "every corrupt input must throw" (that would be an oracle that cannot
 * fail — forbidden by the integrity rule). It is the parser's *typed-error contract*: feeding any input,
 * a parser MUST either (a) return a result, or (b) throw a {@link MediaError} (its `InputError`/
 * `CapabilityError`/`demux-error` family). It must NEVER (c) let a non-typed error escape (a `RangeError`
 * from a DataView read past EOF, a `TypeError`, a bare `Error`, a `DOMException`), (d) hang (infinite
 * loop / unbounded watchdog timeout), or (e) consume unbounded memory. (c)/(d)/(e) are the crash/hang
 * classes this harness detects on REAL fixture-derived inputs.
 *
 * Test-only; not shipped (excluded from the build + the library tsconfig). Pure, deterministic (a seeded
 * PRNG), and browser-free so it runs in the Node/Vitest pipeline alongside the parser unit tests.
 */

import { access, readFile } from 'node:fs/promises';
import { MediaError } from '../../contracts/errors.ts';

// ── fixture bytes (real media; never the network) ─────────────────────────────────────────────────

const ROOT = new URL('../../../', import.meta.url).pathname;

/**
 * Read a real fixture's bytes for fuzzing. Resolves an id against `fixtures/media/` first, then
 * `fixtures/media-derived/`, so both the downloaded corpus and the committed derived assets (AIFF/CAF/
 * AVI) are reachable. Throws loudly (with the fetch command) if the file was never cached — tests never
 * touch the network at run time (BUILD_INSTRUCTIONS §6.1).
 */
export async function fuzzFixture(id: string): Promise<Uint8Array<ArrayBuffer>> {
  for (const dir of ['fixtures/media', 'fixtures/media-derived']) {
    const path = `${ROOT}${dir}/${id}`;
    try {
      await access(path);
      return new Uint8Array(await readFile(path));
    } catch {
      // try the next root
    }
  }
  throw new Error(
    `fuzz fixture '${id}' is not cached under fixtures/media or fixtures/media-derived — run \`bun run fetch-fixtures\` (or check media-derived)`,
  );
}

/** A bounded **head window** of a real fixture — the fuzz seed. Caps work + memory for the matrix. */
export function head(bytes: Uint8Array, maxBytes: number): Uint8Array<ArrayBuffer> {
  return bytes.slice(0, Math.min(bytes.byteLength, maxBytes));
}

// ── deterministic PRNG (reproducible, never flaky) ────────────────────────────────────────────────

/** A tiny deterministic PRNG (mulberry32) so random cases are reproducible across runs/machines. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── one corrupt input ─────────────────────────────────────────────────────────────────────────────

/** A single labeled corrupt input. `cls` groups it into a robustness-matrix column. */
export interface CorruptCase {
  /** A precise, reproducible label (e.g. `truncate@188`, `oversize-field@4`, `dup-atom:fmt `). */
  readonly label: string;
  /** The corrupt-case class (the matrix column). */
  readonly cls: CorruptClass;
  readonly bytes: Uint8Array;
}

/** The corrupt-case classes (the columns of the robustness matrix). */
export type CorruptClass =
  | 'empty'
  | 'truncate'
  | 'bitflip-magic'
  | 'wrong-magic'
  | 'oversize-field'
  | 'zero-field'
  | 'dup-atom'
  | 'missing-atom'
  | 'nested-bomb'
  | 'random-with-magic'
  | 'bitflip-sweep';

// ── structural boundary / size-field discovery (generic, best-effort) ─────────────────────────────

/**
 * The container "family" — selects the generic boundary/size-field scanner and the magic length. The
 * scanners are intentionally *approximate*: a wrong offset still yields a valid corrupt input (the point
 * is breadth, not a second parser). They only need to *find plausible* box/chunk/page starts so that
 * truncations land at real structural boundaries and size mutations hit real length fields.
 */
export type Family = 'isobmff' | 'riff' | 'iff' | 'caf' | 'ebml' | 'ogg' | 'ts' | 'framed';

/** A discovered structural element: where it starts and where its size/length field lives (if any). */
interface Boundary {
  /** Absolute offset of the element start (a truncation point). */
  start: number;
  /** Absolute offset of the element's size/length field (a mutation point), or -1 when none. */
  sizeOffset: number;
  /** Width of the size field in bytes (4 / 8 for byte sizes; 0 for vint/none). */
  sizeWidth: 0 | 4 | 8;
}

const be32 = (b: Uint8Array, o: number): number =>
  ((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0);
const le32 = (b: Uint8Array, o: number): number =>
  (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24);

/** ISO-BMFF / MP4: top-level boxes `size(be32) type(4cc) …`; size==1 ⇒ 64-bit largesize follows. */
function isobmffBoundaries(b: Uint8Array): Boundary[] {
  const out: Boundary[] = [];
  let off = 0;
  for (let guard = 0; guard < 4096 && off + 8 <= b.byteLength; guard++) {
    let size = be32(b, off) >>> 0;
    let width: 4 | 8 = 4;
    if (size === 1) {
      width = 8;
      size = (be32(b, off + 8) >>> 0) * 2 ** 32 + (be32(b, off + 12) >>> 0);
    } else if (size === 0) {
      size = b.byteLength - off;
    }
    out.push({ start: off, sizeOffset: off, sizeWidth: width });
    if (size < 8) break;
    off += size;
  }
  return out;
}

/** RIFF (WAV/AVI): `RIFF`/`LIST` group + `id(4) size(le32) body` chunks, word-aligned. */
function riffBoundaries(b: Uint8Array): Boundary[] {
  const out: Boundary[] = [];
  const walk = (start: number, end: number, depth: number): void => {
    let off = start;
    for (let guard = 0; guard < 4096 && off + 8 <= end; guard++) {
      const id = ascii4(b, off);
      const size = le32(b, off + 4) >>> 0;
      out.push({ start: off, sizeOffset: off + 4, sizeWidth: 4 });
      const body = off + 8;
      if ((id === 'RIFF' || id === 'LIST') && depth < 4)
        walk(body + 4, Math.min(body + size, end), depth + 1);
      const next = body + size + (size & 1);
      if (next <= off) break;
      off = next;
    }
  };
  // Skip the outer RIFF header (12 bytes: 'RIFF' size 'WAVE'/'AVI ') for the inner chunk walk, but also
  // record the outer size field at +4.
  out.push({ start: 0, sizeOffset: 4, sizeWidth: 4 });
  walk(12, b.byteLength, 0);
  return out;
}

/** AIFF/AIFF-C IFF: `FORM` group + `id(4) size(be32) body` chunks, even-padded, big-endian. */
function iffBoundaries(b: Uint8Array): Boundary[] {
  const out: Boundary[] = [{ start: 0, sizeOffset: 4, sizeWidth: 4 }];
  let off = 12; // FORM(4) size(4) formType(4)
  for (let guard = 0; guard < 4096 && off + 8 <= b.byteLength; guard++) {
    const size = be32(b, off + 4) >>> 0;
    out.push({ start: off, sizeOffset: off + 4, sizeWidth: 4 });
    const next = off + 8 + size + (size & 1);
    if (next <= off) break;
    off = next;
  }
  return out;
}

/** CAF: `caff` header + `type(4) size(s64-be) body` chunks (a final -1 size runs to EOF). */
function cafBoundaries(b: Uint8Array): Boundary[] {
  const out: Boundary[] = [];
  let off = 8; // 'caff'(4) version(2) flags(2)
  for (let guard = 0; guard < 4096 && off + 12 <= b.byteLength; guard++) {
    out.push({ start: off, sizeOffset: off + 4, sizeWidth: 8 });
    const hi = be32(b, off + 4) >>> 0;
    const lo = be32(b, off + 8) >>> 0;
    const size = hi * 2 ** 32 + lo;
    if (hi & 0x80000000) break; // negative (incl. -1) → last chunk
    const next = off + 12 + size;
    if (next <= off) break;
    off = next;
  }
  return out;
}

/** EBML (WebM/MKV): elements `ID(vint) size(vint) data`; vints are marker-prefixed big-endian. */
function ebmlBoundaries(b: Uint8Array): Boundary[] {
  const out: Boundary[] = [];
  const vlen = (o: number): number => {
    const first = b[o] ?? 0;
    if (first === 0) return 0;
    let len = 1;
    let mask = 0x80;
    while ((first & mask) === 0 && len < 8) {
      len++;
      mask >>= 1;
    }
    return len;
  };
  const vval = (o: number, len: number, keepMarker: boolean): number => {
    const first = b[o] ?? 0;
    let mask = 0x80;
    for (let i = 1; i < len; i++) mask >>= 1;
    let value = keepMarker ? first : first & (mask - 1);
    for (let i = 1; i < len; i++) value = value * 256 + (b[o + i] ?? 0);
    return value;
  };
  const walk = (start: number, end: number, depth: number): void => {
    let off = start;
    for (let guard = 0; guard < 4096 && off < end; guard++) {
      const idLen = vlen(off);
      if (idLen === 0 || off + idLen >= end) break;
      const sizeLen = vlen(off + idLen);
      if (sizeLen === 0) break;
      out.push({ start: off, sizeOffset: off + idLen, sizeWidth: 0 });
      const dataStart = off + idLen + sizeLen;
      const size = vval(off + idLen, sizeLen, false);
      const dataEnd = Math.min(dataStart + size, end);
      // Recurse into master elements (EBML header 0x1a45dfa3, Segment 0x18538067) for nested boundaries.
      const id = vval(off, idLen, true);
      if ((id === 0x1a45dfa3 || id === 0x18538067) && depth < 3)
        walk(dataStart, dataEnd, depth + 1);
      if (dataEnd <= off) break;
      off = dataEnd;
    }
  };
  walk(0, b.byteLength, 0);
  return out;
}

/** Ogg: pages begin at every `OggS` capture pattern; the page header is 27 bytes + a segment table. */
function oggBoundaries(b: Uint8Array): Boundary[] {
  const out: Boundary[] = [];
  for (let off = 0; off + 27 <= b.byteLength; ) {
    if (ascii4(b, off) !== 'OggS') {
      off++;
      continue;
    }
    out.push({ start: off, sizeOffset: -1, sizeWidth: 0 });
    const segCount = b[off + 26] ?? 0;
    let dataLen = 0;
    for (let i = 0; i < segCount; i++) dataLen += b[off + 27 + i] ?? 0;
    const next = off + 27 + segCount + dataLen;
    if (next <= off) break;
    off = next;
  }
  return out;
}

/** MPEG-TS: fixed 188-byte packets (sync 0x47). Boundaries are every packet start. */
function tsBoundaries(b: Uint8Array): Boundary[] {
  const out: Boundary[] = [];
  // Find the first sync, then stride by 188 (the common case; m2ts/204 still produce valid corruptions).
  let base = 0;
  while (base < Math.min(b.byteLength, 1024) && (b[base] ?? 0) !== 0x47) base++;
  for (let off = base; off < b.byteLength; off += 188)
    out.push({ start: off, sizeOffset: -1, sizeWidth: 0 });
  return out;
}

/** A framed audio stream (MP3/ADTS/FLAC): coarse boundaries every 64 bytes (no nested length tree). */
function framedBoundaries(b: Uint8Array): Boundary[] {
  const out: Boundary[] = [];
  for (let off = 0; off < b.byteLength; off += 64)
    out.push({ start: off, sizeOffset: -1, sizeWidth: 0 });
  return out;
}

function boundariesFor(family: Family, b: Uint8Array): Boundary[] {
  switch (family) {
    case 'isobmff':
      return isobmffBoundaries(b);
    case 'riff':
      return riffBoundaries(b);
    case 'iff':
      return iffBoundaries(b);
    case 'caf':
      return cafBoundaries(b);
    case 'ebml':
      return ebmlBoundaries(b);
    case 'ogg':
      return oggBoundaries(b);
    case 'ts':
      return tsBoundaries(b);
    case 'framed':
      return framedBoundaries(b);
    default: {
      const never: never = family;
      throw new Error(`unhandled family ${String(never)}`);
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

function ascii4(b: Uint8Array, off: number): string {
  return String.fromCharCode(b[off] ?? 0, b[off + 1] ?? 0, b[off + 2] ?? 0, b[off + 3] ?? 0);
}

/** A copy of `b` with `[off, off+patch.length)` overwritten by `patch` (out-of-range bytes ignored). */
function patched(b: Uint8Array, off: number, patch: readonly number[]): Uint8Array<ArrayBuffer> {
  const out = b.slice();
  for (let i = 0; i < patch.length; i++) {
    if (off + i < out.byteLength) out[off + i] = (patch[i] ?? 0) & 0xff;
  }
  return out;
}

/** A copy of `b` with the single bit `bit` (0..7) of byte `off` flipped. */
function flipBit(b: Uint8Array, off: number, bit: number): Uint8Array<ArrayBuffer> {
  const out = b.slice();
  if (off < out.byteLength) out[off] = (out[off] ?? 0) ^ (1 << bit);
  return out;
}

/** The cross-container magics used by `wrong-magic` (route a corrupt input to a *different* parser). */
const CROSS_MAGICS: ReadonlyArray<readonly number[]> = [
  [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], // ....ftyp (MP4)
  [0x52, 0x49, 0x46, 0x46], // RIFF (WAV/AVI)
  [0x1a, 0x45, 0xdf, 0xa3], // EBML (WebM)
  [0x4f, 0x67, 0x67, 0x53], // OggS
  [0x66, 0x4c, 0x61, 0x43], // fLaC
  [0x49, 0x44, 0x33], // ID3
  [0xff, 0xfb], // MP3 frame sync
  [0xff, 0xf1], // ADTS frame sync
  [0x46, 0x4f, 0x52, 0x4d], // FORM (AIFF)
  [0x63, 0x61, 0x66, 0x66], // caff (CAF)
  [0x47], // TS sync
  [0xde, 0xad, 0xbe, 0xef], // pure junk
];

// ── the matrix generator ──────────────────────────────────────────────────────────────────────────

/** Tuning for {@link corruptMatrix}; defaults keep the matrix bounded + fast on a head window. */
export interface MatrixOptions {
  family: Family;
  /** Cap for the head window the matrix mutates (default 64 KiB) — bounds memory + watchdog work. */
  readonly seedCap?: number;
  /** Bytes a generic 4cc/atom scan treats as the magic region for bitflips (default 16). */
  readonly magicBytes?: number;
  /** Stride for the dense truncation sweep (default 17 — a prime, so it desynchronizes from any field). */
  readonly truncateStride?: number;
  /** Number of seeded `random-with-magic` buffers (default 24). */
  readonly randomCount?: number;
  /** Number of seeded sparse `bitflip-sweep` positions (default 96). */
  readonly bitflipCount?: number;
  /** PRNG seed (default derived from the seed bytes) — fixes reproducibility. */
  readonly prngSeed?: number;
}

/**
 * Build the full corrupt-input matrix from a **real** fixture head `seed`. Every case is derived from the
 * real bytes (except the synthesized `nested-bomb`, which is seeded with the seed's magic so it routes to
 * the right parser, and the seeded random buffers, which are prefixed with the real magic for the same
 * reason). Deterministic: same seed ⇒ same matrix.
 */
export function corruptMatrix(seedFull: Uint8Array, opts: MatrixOptions): CorruptCase[] {
  const seedCap = opts.seedCap ?? 64 * 1024;
  const seed = head(seedFull, seedCap);
  const magicBytes = Math.min(opts.magicBytes ?? 16, seed.byteLength);
  const truncateStride = opts.truncateStride ?? 17;
  const randomCount = opts.randomCount ?? 24;
  const bitflipCount = opts.bitflipCount ?? 96;
  const prngSeed = opts.prngSeed ?? (be32(seed, 0) ^ seed.byteLength ^ 0x9e3779b9) >>> 0;
  const rng = mulberry32(prngSeed);
  const cases: CorruptCase[] = [];
  const add = (cls: CorruptClass, label: string, bytes: Uint8Array): void => {
    cases.push({ cls, label, bytes });
  };

  // 1) empty + degenerate tiny.
  add('empty', 'empty', new Uint8Array(0));
  add('empty', 'one-byte', seed.slice(0, 1));
  add('empty', 'magic-only', seed.slice(0, Math.min(4, seed.byteLength)));

  const boundaries = boundariesFor(opts.family, seed);
  const boundaryStarts = new Set<number>(boundaries.map((bd) => bd.start));

  // 2) truncation at every structural boundary + the off-by-few around each header.
  for (const start of [...boundaryStarts].sort((x, y) => x - y)) {
    if (start > 0 && start <= seed.byteLength)
      add('truncate', `truncate@boundary:${start}`, seed.slice(0, start));
    for (const d of [-1, 1, 4, 8, 16]) {
      const n = start + d;
      if (n > 0 && n < seed.byteLength)
        add('truncate', `truncate@${start}${d >= 0 ? '+' : ''}${d}`, seed.slice(0, n));
    }
  }
  // 2b) dense truncation sweep (catches fields the boundary scan can't see, e.g. counts mid-box).
  for (let n = 1; n < seed.byteLength; n += truncateStride)
    add('truncate', `truncate@sweep:${n}`, seed.slice(0, n));
  // 2c) the exact first bytes (where every parser's magic + first header live) get a 1-byte sweep.
  for (let n = 1; n <= Math.min(48, seed.byteLength); n++)
    add('truncate', `truncate@head:${n}`, seed.slice(0, n));

  // 3) magic / header bit flips (wrong magic + corrupt header).
  for (let off = 0; off < magicBytes; off++) {
    add('bitflip-magic', `bitflip-magic@${off}.bit0`, flipBit(seed, off, 0));
    add('bitflip-magic', `bitflip-magic@${off}.bit7`, flipBit(seed, off, 7));
  }

  // 4) wrong / cross-container magic (overwrite the first bytes with another container's magic / junk).
  for (const [i, magic] of CROSS_MAGICS.entries()) {
    add('wrong-magic', `wrong-magic:${i}`, patched(seed, 0, magic));
  }

  // 5) absurd / overflowing size & length fields (the classic OOM / read-past-EOF vector).
  const HUGE_BE = [0xff, 0xff, 0xff, 0xff];
  const HUGE_S64 = [0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const NEG_S64 = [0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01];
  for (const bd of boundaries) {
    if (bd.sizeOffset < 0 || bd.sizeWidth === 0) continue;
    if (bd.sizeWidth === 4) {
      add(
        'oversize-field',
        `oversize-field@${bd.sizeOffset}`,
        patched(seed, bd.sizeOffset, HUGE_BE),
      );
      add('zero-field', `zero-field@${bd.sizeOffset}`, patched(seed, bd.sizeOffset, [0, 0, 0, 0]));
      add(
        'oversize-field',
        `small-field@${bd.sizeOffset}`,
        patched(seed, bd.sizeOffset, [0, 0, 0, 1]),
      );
    } else {
      add(
        'oversize-field',
        `oversize-s64@${bd.sizeOffset}`,
        patched(seed, bd.sizeOffset, HUGE_S64),
      );
      add('oversize-field', `neg-s64@${bd.sizeOffset}`, patched(seed, bd.sizeOffset, NEG_S64));
      add(
        'zero-field',
        `zero-s64@${bd.sizeOffset}`,
        patched(seed, bd.sizeOffset, [0, 0, 0, 0, 0, 0, 0, 0]),
      );
    }
  }
  // 5b) EBML/Ogg/TS have no fixed byte-size field at a known offset; mutate the vint/segment bytes by
  // overwriting the byte just after each element start with all-ones (an "unknown/huge size" vint).
  if (opts.family === 'ebml' || opts.family === 'ogg' || opts.family === 'ts') {
    for (const bd of boundaries) {
      add(
        'oversize-field',
        `vint-allones@${bd.start}`,
        patched(seed, bd.start + 4, [0xff, 0xff, 0xff, 0xff]),
      );
    }
  }

  // 6) duplicated / missing required atoms (find each 4cc; duplicate its whole box, or zero its tag).
  for (const fourcc of atomsFor(opts.family)) {
    const at = find4cc(seed, fourcc);
    if (at < 0) continue;
    add('missing-atom', `missing-atom:${fourcc}`, zap4cc(seed, at));
    add('dup-atom', `dup-atom:${fourcc}`, duplicateBox(seed, at, opts.family));
  }

  // 7) deeply nested / recursive box tree (stack/recursion bound) — synthesized, magic-prefixed.
  add('nested-bomb', 'nested-bomb', nestedBomb(opts.family, seed));

  // 8) seeded random buffers prefixed with the real magic (engages the real parse, not an early bail).
  const realMagic = seed.slice(0, Math.min(16, seed.byteLength));
  for (let i = 0; i < randomCount; i++) {
    const len = 16 + Math.floor(rng() * 4096);
    const buf = new Uint8Array(len);
    for (let j = 0; j < len; j++) buf[j] = Math.floor(rng() * 256);
    buf.set(realMagic.subarray(0, Math.min(realMagic.byteLength, len)), 0);
    add('random-with-magic', `random-with-magic:${i}`, buf);
  }

  // 9) seeded sparse single-bit flips across the whole seed (header fields the structural sweep misses).
  for (let i = 0; i < bitflipCount && seed.byteLength > 0; i++) {
    const off = Math.floor(rng() * seed.byteLength);
    const bit = Math.floor(rng() * 8);
    add('bitflip-sweep', `bitflip-sweep@${off}.${bit}`, flipBit(seed, off, bit));
  }

  return cases;
}

/** Required/structural 4ccs per family that `dup-atom`/`missing-atom` target. */
function atomsFor(family: Family): readonly string[] {
  switch (family) {
    case 'isobmff':
      return [
        'ftyp',
        'moov',
        'mvhd',
        'trak',
        'mdia',
        'minf',
        'stbl',
        'stsd',
        'stsz',
        'stco',
        'mdat',
      ];
    case 'riff':
      return ['fmt ', 'data', 'hdrl', 'strl', 'strh', 'strf', 'movi', 'avih', 'LIST'];
    case 'iff':
      return ['COMM', 'SSND', 'FVER'];
    case 'caf':
      return ['desc', 'data'];
    default:
      return []; // EBML/Ogg/TS/framed have no fixed 4cc atoms at byte boundaries
  }
}

/** First absolute offset of a 4cc in `b`, or -1. */
function find4cc(b: Uint8Array, fourcc: string): number {
  const c0 = fourcc.charCodeAt(0);
  for (let i = 0; i + 4 <= b.byteLength; i++) {
    if (b[i] === c0 && ascii4(b, i) === fourcc) return i;
  }
  return -1;
}

/** Overwrite the 4cc at `at` with `\0\0\0\0` (the atom "vanishes" to the parser). */
function zap4cc(b: Uint8Array, at: number): Uint8Array<ArrayBuffer> {
  return patched(b, at, [0, 0, 0, 0]);
}

/**
 * Duplicate the box/chunk whose 4cc is at `at` by splicing a second copy of its header+body in front of
 * it. The size is read from the size field (which precedes the 4cc for ISO-BMFF, follows it for RIFF/IFF/
 * CAF). A best-effort splice: if the size is implausible we duplicate a small fixed window — still a valid
 * "two atoms where one is required" corruption.
 */
function duplicateBox(b: Uint8Array, at: number, family: Family): Uint8Array<ArrayBuffer> {
  let boxStart = at;
  let size = 0;
  if (family === 'isobmff') {
    boxStart = at - 4; // size(4) precedes the 4cc
    size = boxStart >= 0 ? be32(b, boxStart) >>> 0 : 0;
  } else if (family === 'riff' || family === 'iff') {
    boxStart = at; // id(4) then size(4)
    const raw = family === 'riff' ? le32(b, at + 4) : be32(b, at + 4);
    size = (raw >>> 0) + 8 + (family === 'iff' ? raw & 1 : raw & 1);
  } else if (family === 'caf') {
    boxStart = at;
    size = (be32(b, at + 4) >>> 0) * 2 ** 32 + (be32(b, at + 8) >>> 0) + 12;
  }
  if (boxStart < 0 || size < 8 || boxStart + size > b.byteLength) {
    size = Math.min(32, b.byteLength - Math.max(0, boxStart)); // fallback window
    boxStart = Math.max(0, boxStart);
  }
  const slice = b.slice(boxStart, boxStart + size);
  const out = new Uint8Array(b.byteLength + slice.byteLength);
  out.set(b.subarray(0, boxStart), 0);
  out.set(slice, boxStart);
  out.set(b.subarray(boxStart), boxStart + slice.byteLength);
  return out;
}

/**
 * A synthesized deeply/recursively nested container, magic-prefixed so it routes to the target parser. It
 * declares a self-similar nesting far deeper than any real file (the recursion/stack bound test): e.g. a
 * `moov` containing a `moov` containing … for ISO-BMFF, a `Segment`-in-`Segment` for EBML, a `LIST`-in-
 * `LIST` for RIFF. Bounded total size (a few KiB) so it can never OOM — the bound is the point.
 */
function nestedBomb(family: Family, seed: Uint8Array): Uint8Array<ArrayBuffer> {
  const DEPTH = 800;
  if (family === 'isobmff') {
    // ftyp + DEPTH nested moov boxes (each size = 8 + inner). Build inside-out.
    const ftyp = [0, 0, 0, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0];
    let inner: number[] = [0, 0, 0, 0x08, 0x6d, 0x6f, 0x6f, 0x76]; // empty moov
    for (let d = 0; d < DEPTH; d++) {
      const size = 8 + inner.length;
      inner = [
        (size >>> 24) & 255,
        (size >>> 16) & 255,
        (size >>> 8) & 255,
        size & 255,
        0x6d,
        0x6f,
        0x6f,
        0x76,
        ...inner,
      ];
      if (inner.length > 16 * 1024) break;
    }
    return new Uint8Array([...ftyp, ...inner]);
  }
  if (family === 'riff') {
    // RIFF('WAVE') with DEPTH nested LIST('wave') — exercise the recursive chunk walk.
    let inner: number[] = [0x66, 0x6d, 0x74, 0x20, 0, 0, 0, 0]; // 'fmt ' size 0
    for (let d = 0; d < DEPTH; d++) {
      const body = 4 + inner.length; // 'wave' + inner
      inner = [
        0x4c,
        0x49,
        0x53,
        0x54,
        body & 255,
        (body >>> 8) & 255,
        (body >>> 16) & 255,
        (body >>> 24) & 255,
        0x77,
        0x61,
        0x76,
        0x65,
        ...inner,
      ];
      if (inner.length > 16 * 1024) break;
    }
    const total = 4 + inner.length;
    return new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      total & 255,
      (total >>> 8) & 255,
      (total >>> 16) & 255,
      (total >>> 24) & 255,
      0x57,
      0x41,
      0x56,
      0x45,
      ...inner,
    ]);
  }
  if (family === 'iff') {
    let inner: number[] = [0x43, 0x4f, 0x4d, 0x4d, 0, 0, 0, 0]; // 'COMM' size 0
    for (let d = 0; d < DEPTH; d++) {
      const body = 4 + inner.length;
      inner = [
        0x46,
        0x4f,
        0x52,
        0x4d,
        (body >>> 24) & 255,
        (body >>> 16) & 255,
        (body >>> 8) & 255,
        body & 255,
        0x41,
        0x49,
        0x46,
        0x46,
        ...inner,
      ];
      if (inner.length > 16 * 1024) break;
    }
    const total = 4 + inner.length;
    return new Uint8Array([
      0x46,
      0x4f,
      0x52,
      0x4d,
      (total >>> 24) & 255,
      (total >>> 16) & 255,
      (total >>> 8) & 255,
      total & 255,
      0x41,
      0x49,
      0x46,
      0x46,
      ...inner,
    ]);
  }
  if (family === 'ebml') {
    // EBML header + DEPTH nested Segment (0x18538067) elements with unknown size (0x01FFFFFFFFFFFFFF).
    const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    const ebmlHdr = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x00, 0x00, 0x00, 0x00];
    const out: number[] = [...ebmlHdr];
    for (let d = 0; d < DEPTH && out.length < 16 * 1024; d++)
      out.push(0x18, 0x53, 0x80, 0x67, ...UNKNOWN);
    return new Uint8Array(out);
  }
  // Ogg/TS/framed: no nested length tree — fall back to a magic-prefixed garbage run (still routes there).
  const magic = seed.slice(0, Math.min(8, seed.byteLength));
  const out = new Uint8Array(4096);
  out.set(magic, 0);
  return out;
}

// ── the oracle + bounded watchdog ───────────────────────────────────────────────────────────────────

/** The outcome of feeding one corrupt input to a parser. */
export type Outcome = 'typed' | 'ok' | 'crash' | 'hang';

/** A classified parse result for one corrupt case (what the matrix records). */
export interface CaseResult {
  readonly label: string;
  readonly cls: CorruptClass;
  readonly outcome: Outcome;
  /** The error class name when `crash` (e.g. `RangeError`) or `typed` (`MediaError`). */
  readonly errorName?: string;
  readonly message?: string;
  /** Wall time (ms) the parser took on this case — surfaces accidental-quadratic blowups. */
  readonly ms: number;
}

/**
 * The per-case **time budget** (ms): a single corrupt case must finish well within this on a head-window
 * input. Exceeding it on a bounded input means an accidental-quadratic/near-hang loop — reported as a
 * `hang` outcome. A *true* infinite loop (independent of input) cannot be interrupted in-process; the
 * test's `testTimeout` is the final backstop (it fails the test rather than passing it). Because the
 * matrix mutates a capped head window, every input-bounded loop terminates inside this budget.
 */
export const CASE_TIME_BUDGET_MS = 1500;

const isMediaError = (e: unknown): e is MediaError => e instanceof MediaError;

/**
 * Run one parser invocation under the watchdog and classify it. `parse` is the parser's real entrypoint
 * applied to the corrupt bytes; it may be sync (pure `parseX`) or async (`driver.demux`). A thrown/rejected
 * {@link MediaError} ⇒ `typed`; a thrown/rejected non-`MediaError` ⇒ `crash`; over-budget ⇒ `hang`; a
 * normal return/resolve ⇒ `ok`.
 */
export async function runCase(
  label: string,
  cls: CorruptClass,
  parse: (bytes: Uint8Array) => unknown,
  bytes: Uint8Array,
): Promise<CaseResult> {
  const t0 = performance.now();
  try {
    await parse(bytes);
    const ms = performance.now() - t0;
    return ms > CASE_TIME_BUDGET_MS
      ? { label, cls, outcome: 'hang', ms }
      : { label, cls, outcome: 'ok', ms };
  } catch (e) {
    const ms = performance.now() - t0;
    if (ms > CASE_TIME_BUDGET_MS) return { label, cls, outcome: 'hang', ms };
    if (isMediaError(e))
      return { label, cls, outcome: 'typed', errorName: e.name, message: e.message, ms };
    const err = e as { constructor?: { name?: string }; message?: string } | null;
    return {
      label,
      cls,
      outcome: 'crash',
      errorName: err?.constructor?.name ?? typeof e,
      message: err?.message ?? String(e),
      ms,
    };
  }
}

/** Run the whole matrix for one parser, returning a {@link CaseResult} per case (decode order preserved). */
export async function runMatrix(
  cases: readonly CorruptCase[],
  parse: (bytes: Uint8Array) => unknown,
): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of cases) out.push(await runCase(c.label, c.cls, parse, c.bytes));
  return out;
}

/** A short hex preview of the minimal repro bytes for a crash/hang (first N bytes). */
export function hexPreview(bytes: Uint8Array, max = 48): string {
  const n = Math.min(bytes.byteLength, max);
  let s = '';
  for (let i = 0; i < n; i++) s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return `${s}${bytes.byteLength > n ? '…' : ''} (${bytes.byteLength}B)`;
}

/** The crash/hang cases in a matrix run — the escapes the typed-error contract must not produce. */
export function escapes(results: readonly CaseResult[]): CaseResult[] {
  return results.filter((r) => r.outcome === 'crash' || r.outcome === 'hang');
}

/** A compact per-class tally `{ class → {typed,ok,crash,hang} }` for the robustness-matrix report. */
export function tally(results: readonly CaseResult[]): Record<string, Record<Outcome, number>> {
  const out: Record<string, Record<Outcome, number>> = {};
  for (const r of results) {
    const row = out[r.cls] ?? { typed: 0, ok: 0, crash: 0, hang: 0 };
    out[r.cls] = row;
    row[r.outcome] += 1;
  }
  return out;
}
