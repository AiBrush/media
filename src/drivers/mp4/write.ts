/**
 * Write a valid MP4 (ISO-BMFF) from encoded samples — the mirror of {@link parseMovie}. Works in
 * container-native ticks so a demux→mux stream-copy (`remux`) is exact. Layout is faststart by default
 * (moov before mdat, streamable). Each track is one chunk of contiguous samples. Pure TS — round-trip
 * validated (`parse(write(x)) == x`) against the real corpus without a browser.
 */

import { MediaError } from '../../contracts/errors.ts';

const u8 = (n: number): number[] => [n & 0xff];
const u16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u24 = (n: number): number[] => [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const fourcc = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const zeros = (n: number): number[] => new Array<number>(n).fill(0);
const cat = (...parts: number[][]): number[] => parts.flat();

function box(type: string, payload: number[]): number[] {
  return cat(u32(8 + payload.length), fourcc(type), payload);
}
function full(type: string, version: number, flags: number, payload: number[]): number[] {
  return box(type, cat(u8(version), u24(flags), payload));
}

const IDENTITY_MATRIX = cat(
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
);

export interface MuxSampleInput {
  data: Uint8Array;
  durationTicks: number;
  cttsTicks: number;
  keyframe: boolean;
}

export interface MuxSampleLayoutInput {
  byteLength: number;
  durationTicks: number;
  cttsTicks: number;
  keyframe: boolean;
}

/** CENC protection for a track (ADR-023): emits `enca`/`encv` + `sinf`/`tenc` and optional `senc` IVs. */
export interface TrackEncryption {
  schemeType: string; // 'cenc' | 'cbcs'
  kid: Uint8Array; // 16-byte default_KID
  perSampleIvSize: number; // 8/16 per-sample IVs, or 0 for cbcs default_constant_IV
  /** One IV per sample when a `senc` box is emitted. Omitted only for valid cbcs constant-IV tracks. */
  ivs?: Uint8Array[];
  /** cbcs crypt:skip block pattern, serialized in tenc version 1. */
  pattern?: { cryptByteBlock: number; skipByteBlock: number };
  /** cbcs default_constant_IV, serialized only when `perSampleIvSize === 0`. */
  constantIv?: Uint8Array;
}

export interface MuxTrackInput {
  mediaType: 'video' | 'audio';
  sampleEntryType: string; // 'avc1' | 'mp4a'
  timescale: number;
  /** Raw codec-config box (avcC/esds) preserved verbatim for lossless stream-copy. */
  codecPrivate?: { boxType: string; data: Uint8Array };
  /** avcC record (video) or AudioSpecificConfig (audio) — used to synthesize the box on the encode path. */
  description?: Uint8Array;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  /** When set, the track is written as CENC-protected (the samples must already be ciphertext). */
  encryption?: TrackEncryption;
  samples: MuxSampleInput[];
}

export type MuxTrackLayoutInput = Omit<MuxTrackInput, 'samples'> & {
  samples: readonly (MuxSampleInput | MuxSampleLayoutInput)[];
};

export interface Mp4ByteStreamLayout {
  ftyp: Uint8Array;
  moov: Uint8Array;
  mdatHeader: Uint8Array;
  mdatBeforeMoov: boolean;
  mdatPayloadLen: number;
  totalLen: number;
}

/**
 * Output container flavor → the `ftyp` major + compatible brands. `mp4` writes generic ISO brands plus
 * the actual video sample-entry brand(s) present in the file; `mov` writes the Apple QuickTime brand
 * `qt  ` so a probe (ffprobe and ours) recognizes the file as QuickTime/MOV rather than MP4. Same box
 * layout either way — only `ftyp` differs (ADR: a mov target must not advertise an ISO major brand,
 * doc 09 mux).
 */
export type ContainerBrand = 'mp4' | 'mov';

export interface WriteOptions {
  faststart?: boolean;
  movieTimescale?: number;
  /** Container flavor for the `ftyp` brands (default `'mp4'`). */
  brand?: ContainerBrand;
}

interface RunLength {
  count: number;
  value: number;
}
function runLength(values: readonly number[]): RunLength[] {
  const out: RunLength[] = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last.value === v) last.count++;
    else out.push({ count: 1, value: v });
  }
  return out;
}

// Sample tables (stsz/stts/ctts/stss) hold one or two u32s per entry and can run to 100k+ entries on a
// long file. Build them by pushing bytes into a single array — NEVER `cat(u32(n), ...vals.map(u32))`,
// whose spread passes every entry as a separate function argument and overflows the call stack at the
// massive rung (the `Maximum call stack size exceeded` crash). Output bytes are identical either way.
function pushU32(out: number[], n: number): void {
  out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}
function u32Table(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of values) pushU32(out, v);
  return out;
}
function runLengthTable(runs: readonly RunLength[]): number[] {
  const out: number[] = [];
  for (const e of runs) {
    pushU32(out, e.count);
    pushU32(out, e.value);
  }
  return out;
}

function sampleByteLength(sample: MuxSampleInput | MuxSampleLayoutInput): number {
  return 'data' in sample ? sample.data.byteLength : sample.byteLength;
}

function trackDurationTicks(track: MuxTrackLayoutInput): number {
  return track.samples.reduce((a, s) => a + s.durationTicks, 0);
}

/** Build an `esds` box wrapping an AudioSpecificConfig (the reverse of `parseEsds`). */
function esdsBox(asc: Uint8Array): number[] {
  const dsi = cat([0x05, asc.byteLength], [...asc]);
  const dcdPayload = cat([0x40, 0x15], u24(0), u32(0), u32(0), dsi);
  const dcd = cat([0x04, dcdPayload.length], dcdPayload);
  const esPayload = cat(u16(0), u8(0), dcd);
  const es = cat([0x03, esPayload.length], esPayload);
  return full('esds', 0, 0, es);
}

/** The codec-config box: the preserved raw box (lossless remux) or a synthesized one (encode path). */
function codecConfigBox(track: MuxTrackLayoutInput): number[] {
  if (track.codecPrivate) return box(track.codecPrivate.boxType, [...track.codecPrivate.data]);
  if (track.mediaType === 'video' && track.description) return box('avcC', [...track.description]);
  if (track.mediaType === 'audio' && track.description) return esdsBox(track.description);
  return [];
}

/** The `sinf` protection box (`frma`/`schm`/`schi`→`tenc`) wrapping the original format, when protected. */
function sinfBox(track: MuxTrackLayoutInput): number[] {
  const enc = track.encryption;
  if (!enc) return [];
  if (enc.constantIv && enc.perSampleIvSize !== 0) {
    throw new MediaError('mux-error', 'cbcs default_constant_IV requires perSampleIvSize 0');
  }
  if (enc.perSampleIvSize === 0 && !enc.constantIv) {
    throw new MediaError('mux-error', 'perSampleIvSize 0 requires a cbcs default_constant_IV');
  }
  const patternByte = enc.pattern
    ? ((enc.pattern.cryptByteBlock & 0x0f) << 4) | (enc.pattern.skipByteBlock & 0x0f)
    : 0;
  const version = enc.pattern || enc.constantIv ? 1 : 0;
  const constantIv = enc.constantIv ? cat(u8(enc.constantIv.byteLength), [...enc.constantIv]) : [];
  const frma = box('frma', fourcc(track.sampleEntryType));
  const schm = full('schm', 0, 0, cat(fourcc(enc.schemeType), u32(0x00010000)));
  const tenc = full(
    'tenc',
    version,
    0,
    cat(u8(0), u8(patternByte), u8(1), u8(enc.perSampleIvSize), [...enc.kid], constantIv),
  );
  return box('sinf', cat(frma, schm, box('schi', tenc)));
}

/** The `senc` sample-encryption box: per-sample IVs (flags=0 → no subsamples for audio). */
function sencBox(track: MuxTrackLayoutInput): number[] {
  const enc = track.encryption;
  if (!enc) return [];
  if (!enc.ivs) {
    if (enc.perSampleIvSize === 0) return [];
    throw new MediaError('mux-error', 'per-sample CENC encryption requires one IV per sample');
  }
  if (enc.ivs.length !== track.samples.length) {
    throw new MediaError(
      'mux-error',
      `senc IV count ${enc.ivs.length} does not match sample count ${track.samples.length}`,
    );
  }
  for (const iv of enc.ivs) {
    if (iv.byteLength !== enc.perSampleIvSize) {
      throw new MediaError(
        'mux-error',
        `senc IV length ${iv.byteLength} does not match perSampleIvSize ${enc.perSampleIvSize}`,
      );
    }
  }
  return full(
    'senc',
    0,
    0,
    cat(
      u32(enc.ivs.length),
      enc.ivs.flatMap((iv) => [...iv]),
    ),
  );
}

function videoSampleEntry(track: MuxTrackLayoutInput): number[] {
  return box(
    track.encryption ? 'encv' : track.sampleEntryType,
    cat(
      zeros(6),
      u16(1), // reserved + data_reference_index
      zeros(16), // pre_defined + reserved + pre_defined[3]
      u16(track.width ?? 0),
      u16(track.height ?? 0),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1), // resolutions + reserved + frame_count
      zeros(32),
      u16(0x0018),
      u16(0xffff), // compressorname + depth + pre_defined
      codecConfigBox(track),
      sinfBox(track),
    ),
  );
}

function audioSampleEntry(track: MuxTrackLayoutInput): number[] {
  return box(
    track.encryption ? 'enca' : track.sampleEntryType,
    cat(
      zeros(6),
      u16(1), // reserved + data_reference_index
      zeros(8), // reserved
      u16(track.channels ?? 2),
      u16(16),
      zeros(4), // samplesize + pre_defined + reserved
      u32((track.sampleRate ?? 48000) * 65536), // 16.16 fixed
      codecConfigBox(track),
      sinfBox(track),
    ),
  );
}

function sampleTable(track: MuxTrackLayoutInput, chunkOffset: number): number[] {
  const entry = track.mediaType === 'video' ? videoSampleEntry(track) : audioSampleEntry(track);
  const sizes = track.samples.map(sampleByteLength);
  const stts = runLength(track.samples.map((s) => s.durationTicks));
  const cttsVals = track.samples.map((s) => s.cttsTicks);
  const hasCtts = cttsVals.some((v) => v !== 0);
  const ctts = runLength(cttsVals);
  const cttsVersion = cttsVals.some((v) => v < 0) ? 1 : 0;
  const sync = track.samples.flatMap((s, i) => (s.keyframe ? [i + 1] : []));
  const allSync = sync.length === track.samples.length;

  const children = cat(
    full('stsd', 0, 0, cat(u32(1), entry)),
    full('stts', 0, 0, cat(u32(stts.length), runLengthTable(stts))),
    hasCtts ? full('ctts', cttsVersion, 0, cat(u32(ctts.length), runLengthTable(ctts))) : [],
    full('stsz', 0, 0, cat(u32(0), u32(sizes.length), u32Table(sizes))),
    full('stsc', 0, 0, cat(u32(1), u32(1), u32(track.samples.length), u32(1))),
    full('stco', 0, 0, cat(u32(1), u32(chunkOffset))),
    allSync ? [] : full('stss', 0, 0, cat(u32(sync.length), u32Table(sync))),
    sencBox(track),
  );
  return box('stbl', children);
}

function trak(
  track: MuxTrackLayoutInput,
  trackId: number,
  movieTimescale: number,
  chunkOffset: number,
): number[] {
  const durTicks = trackDurationTicks(track);
  const movieDur = Math.round((durTicks * movieTimescale) / track.timescale);
  const isVideo = track.mediaType === 'video';

  const tkhd = full(
    'tkhd',
    0,
    0x000007,
    cat(
      zeros(8),
      u32(trackId),
      zeros(4),
      u32(movieDur),
      zeros(8),
      u16(0),
      u16(0),
      u16(isVideo ? 0 : 0x0100),
      u16(0), // layer + altgroup + volume + reserved
      IDENTITY_MATRIX,
      u32((track.width ?? 0) * 65536),
      u32((track.height ?? 0) * 65536),
    ),
  );

  const mdhd = full(
    'mdhd',
    0,
    0,
    cat(zeros(8), u32(track.timescale), u32(durTicks), u16(0x55c4), u16(0)),
  );
  const hdlr = full(
    'hdlr',
    0,
    0,
    cat(zeros(4), fourcc(isVideo ? 'vide' : 'soun'), zeros(12), u8(0)),
  );
  const mediaHeader = isVideo
    ? full('vmhd', 0, 1, cat(u16(0), zeros(6)))
    : full('smhd', 0, 0, cat(u16(0), u16(0)));
  const dref = full('dref', 0, 0, cat(u32(1), full('url ', 0, 1, [])));
  const minf = box('minf', cat(mediaHeader, box('dinf', dref), sampleTable(track, chunkOffset)));
  const mdia = box('mdia', cat(mdhd, hdlr, minf));
  return box('trak', cat(tkhd, mdia));
}

function moov(
  tracks: readonly MuxTrackLayoutInput[],
  movieTimescale: number,
  chunkOffsets: number[],
): number[] {
  const movieDur = tracks.reduce(
    (max, t) => Math.max(max, Math.round((trackDurationTicks(t) * movieTimescale) / t.timescale)),
    0,
  );
  const mvhd = full(
    'mvhd',
    0,
    0,
    cat(
      zeros(8),
      u32(movieTimescale),
      u32(movieDur),
      u32(0x00010000),
      u16(0x0100),
      zeros(10), // rate + volume + reserved
      IDENTITY_MATRIX,
      zeros(24), // pre_defined
      u32(tracks.length + 1), // next_track_id
    ),
  );
  const traks = tracks.flatMap((t, i) => trak(t, i + 1, movieTimescale, chunkOffsets[i] ?? 0));
  return box('moov', cat(mvhd, traks));
}

function addUniqueBrand(out: string[], brand: string): void {
  if (!out.includes(brand)) out.push(brand);
}

function compatibleBrandsFor(tracks: readonly MuxTrackLayoutInput[]): string[] {
  const brands = ['isom', 'iso2'];
  for (const track of tracks) {
    if (track.mediaType !== 'video') continue;
    const entry = track.sampleEntryType;
    if (entry === 'avc1' || entry === 'avc3') addUniqueBrand(brands, 'avc1');
    else if (entry === 'hvc1' || entry === 'hev1') addUniqueBrand(brands, entry);
    else if (entry === 'av01') addUniqueBrand(brands, 'av01');
  }
  addUniqueBrand(brands, 'mp41');
  return brands;
}

function ftypBox(brand: ContainerBrand, tracks: readonly MuxTrackLayoutInput[]): number[] {
  if (brand === 'mov') {
    // QuickTime: major_brand 'qt  ' (0x71 74 20 20), minor 0x200, compatible ['qt  '] — what ffprobe
    // (and our parse) keys on to report container 'mov' instead of 'mp4'.
    return box('ftyp', cat(fourcc('qt  '), u32(0x200), fourcc('qt  ')));
  }
  return box(
    'ftyp',
    cat(
      fourcc('isom'),
      u32(0x200),
      ...compatibleBrandsFor(tracks).map((codecBrand) => fourcc(codecBrand)),
    ),
  );
}

// A single Uint8Array (and the ISO 32-bit box `size`) tops out near 4.29 GB. Beyond that a buffer
// target genuinely can't materialize the output in one allocation — the caller must use a stream
// target. Named so the guard is testable without allocating multi-GB buffers.
const MAX_SINGLE_BUFFER = 0xffffffff;

/** Guard that an in-memory (buffer-target) output fits one Uint8Array; else a typed mux miss. */
export function assertSingleBufferSize(totalLen: number): void {
  if (totalLen > MAX_SINGLE_BUFFER) {
    throw new MediaError(
      'mux-error',
      `output is ${totalLen} bytes, over the ${MAX_SINGLE_BUFFER}-byte single-buffer limit; use a stream target`,
    );
  }
}

/** Copy each track's samples (track-major order) into `out` at `pos`; returns the advanced position. */
function writeSamples(out: Uint8Array, pos: number, tracks: MuxTrackInput[]): number {
  let p = pos;
  for (const t of tracks)
    for (const s of t.samples) {
      out.set(s.data, p);
      p += s.data.byteLength;
    }
  return p;
}

interface Mp4LayoutParts {
  ftyp: number[];
  moov: number[];
  mdatHeader: number[];
  mdatBeforeMoov: boolean;
  mdatPayloadLen: number;
  totalLen: number;
}

function mp4LayoutParts(
  tracks: readonly MuxTrackLayoutInput[],
  opts: WriteOptions = {},
): Mp4LayoutParts {
  const movieTimescale = opts.movieTimescale ?? 1000;
  const faststart = opts.faststart ?? true;
  const ftyp = ftypBox(opts.brand ?? 'mp4', tracks);

  // Per-track contiguous byte regions within mdat (one chunk per track).
  const lens = tracks.map((t) => t.samples.reduce((a, s) => a + sampleByteLength(s), 0));
  const mdatPayloadLen = lens.reduce((a, l) => a + l, 0);
  const intra: number[] = [];
  let acc = 0;
  for (const len of lens) {
    intra.push(acc);
    acc += len;
  }
  const offsetsFor = (mdatStart: number): number[] => intra.map((o) => mdatStart + 8 + o);
  const mdatHeader = cat(u32(8 + mdatPayloadLen), fourcc('mdat')); // 8-byte box header (size ≤ 4.29 GB)

  // moov carries absolute sample offsets, which depend on whether mdat follows it (faststart) or
  // precedes it. Offsets are fixed-width u32, so a zero-offset pass yields moov's exact length, letting
  // us place mdat right after it.
  let moovBytes: number[];
  let mdatBeforeMoov: boolean;
  if (faststart) {
    const sized = moov(
      tracks,
      movieTimescale,
      tracks.map(() => 0),
    ); // fixed-width → stable length
    const mdatStart = ftyp.length + sized.length;
    moovBytes = moov(tracks, movieTimescale, offsetsFor(mdatStart));
    mdatBeforeMoov = false;
  } else {
    moovBytes = moov(tracks, movieTimescale, offsetsFor(ftyp.length));
    mdatBeforeMoov = true;
  }

  const totalLen = ftyp.length + moovBytes.length + mdatHeader.length + mdatPayloadLen;
  assertSingleBufferSize(totalLen);
  return {
    ftyp,
    moov: moovBytes,
    mdatHeader,
    mdatBeforeMoov,
    mdatPayloadLen,
    totalLen,
  };
}

export function planMp4ByteStreamLayout(
  tracks: readonly MuxTrackLayoutInput[],
  opts: WriteOptions = {},
): Mp4ByteStreamLayout {
  const parts = mp4LayoutParts(tracks, opts);
  return {
    ftyp: Uint8Array.from(parts.ftyp),
    moov: Uint8Array.from(parts.moov),
    mdatHeader: Uint8Array.from(parts.mdatHeader),
    mdatBeforeMoov: parts.mdatBeforeMoov,
    mdatPayloadLen: parts.mdatPayloadLen,
    totalLen: parts.totalLen,
  };
}

/**
 * Serialize tracks + samples into an MP4 byte stream. The structural boxes (`ftyp`/`moov`) are built
 * as small `number[]`s, but the `mdat` payload is copied straight from each sample's `Uint8Array` into
 * one output buffer via `.set` — never a giant `number[]` (which exceeds the JS array length cap /
 * exhausts the heap on multi-hundred-MB remuxes; that was the `huge`/`massive` rung crash). Byte layout
 * is identical to a naive concat, so `parse(write(x)) == x` still holds.
 */
export function writeMp4(tracks: MuxTrackInput[], opts: WriteOptions = {}): Uint8Array {
  const layout = mp4LayoutParts(tracks, opts);
  const out = new Uint8Array(layout.totalLen);
  let p = 0;
  out.set(layout.ftyp, p);
  p += layout.ftyp.length;
  if (layout.mdatBeforeMoov) {
    out.set(layout.mdatHeader, p);
    p += layout.mdatHeader.length;
    p = writeSamples(out, p, tracks);
    out.set(layout.moov, p);
  } else {
    out.set(layout.moov, p);
    p += layout.moov.length;
    out.set(layout.mdatHeader, p);
    p += layout.mdatHeader.length;
    writeSamples(out, p, tracks);
  }
  return out;
}
