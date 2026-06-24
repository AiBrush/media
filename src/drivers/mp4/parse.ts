/**
 * Parse an ISO-BMFF `moov` into a {@link Movie}: per-track codec config, geometry, timing, and the
 * full sample tables (`stts`/`ctts`/`stsz`/`stsc`/`stco`/`stss`) that the demuxer turns into packets
 * with correct PTS/DTS and keyframe flags (docs/architecture/09 demux). Pure TS; no browser APIs.
 */

import type { MediaType } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { av1CodecString, avcCodecString, hevcCodecString, parseEsds } from './codec-strings.ts';
import { type BoxHeader, Reader, boxes, readFullBoxHeader } from './reader.ts';

export interface TimeToSample {
  count: number;
  delta: number;
}
export interface CompositionOffset {
  count: number;
  offset: number;
}
export interface SampleToChunk {
  firstChunk: number;
  samplesPerChunk: number;
  descIndex: number;
}

export interface SampleTable {
  timeToSample: TimeToSample[];
  compositionOffsets: CompositionOffset[];
  /** Per-sample sizes (length === sampleCount). */
  sampleSizes: number[];
  sampleToChunk: SampleToChunk[];
  chunkOffsets: number[];
  /** 1-based sample numbers that are sync (keyframes); empty means "every sample is sync". */
  syncSamples: number[];
}

/** The raw codec-configuration box (`avcC`/`esds`) preserved verbatim for lossless stream-copy. */
export interface CodecPrivate {
  boxType: string;
  data: Uint8Array;
}

/** CENC protection metadata for a track (ADR-023) — raw boxes; the decrypt path parses their fields. */
export interface TrackProtection {
  schemeType: string; // 'cenc' (from schm)
  /** Raw `tenc` full-box payload (default_KID + per-sample IV size). */
  tenc: Uint8Array;
  /** Raw `senc` full-box payload (version+flags+count+IVs). */
  senc?: Uint8Array;
}

export interface ParsedTrack {
  id: number;
  mediaType: MediaType;
  /** mdhd timescale (ticks per second). */
  timescale: number;
  durationSec: number;
  codec: string;
  sampleEntryType: string;
  config: VideoDecoderConfig | AudioDecoderConfig;
  /** Raw codec-config box for verbatim remux (separate from the WebCodecs decode `config`). */
  codecPrivate?: CodecPrivate;
  width?: number;
  height?: number;
  rotation?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  /** Present when the track is CENC-protected (sample entry was `enca`/`encv`). */
  encryption?: TrackProtection;
  samples: SampleTable;
}

export interface Movie {
  brand: string;
  timescale: number;
  durationSec: number;
  tracks: ParsedTrack[];
}

function fail(message: string): never {
  throw new MediaError('demux-error', message);
}

function child(r: Reader, parent: BoxHeader, type: string): BoxHeader | undefined {
  r.seek(parent.payloadStart);
  for (const b of boxes(r, parent.end)) {
    if (b.type === type) return b;
  }
  return undefined;
}

function children(r: Reader, parent: BoxHeader, type: string): BoxHeader[] {
  r.seek(parent.payloadStart);
  const out: BoxHeader[] = [];
  for (const b of boxes(r, parent.end)) {
    if (b.type === type) out.push(b);
  }
  return out;
}

/** Find a child box by type starting from the current cursor (for sample entries with fixed fields). */
function boxFrom(r: Reader, end: number, type: string): BoxHeader | undefined {
  for (const b of boxes(r, end)) {
    if (b.type === type) return b;
  }
  return undefined;
}

/** Parse a `moov` payload (with the file's `ftyp` major brand) into a {@link Movie}. */
export function parseMovie(brand: string, moov: Uint8Array): Movie {
  const r = new Reader(moov);
  const root: BoxHeader = {
    type: 'moov',
    size: moov.byteLength,
    headerSize: 0,
    start: 0,
    payloadStart: 0,
    end: moov.byteLength,
  };

  const mvhd = child(r, root, 'mvhd') ?? fail('moov has no mvhd');
  const movie = parseMvhd(r, mvhd);

  const tracks: ParsedTrack[] = [];
  for (const trak of children(r, root, 'trak')) {
    const parsed = parseTrak(r, trak);
    if (parsed) tracks.push(parsed);
  }
  if (tracks.length === 0) fail('moov has no decodable tracks');

  return { brand, timescale: movie.timescale, durationSec: movie.durationSec, tracks };
}

function parseMvhd(r: Reader, box: BoxHeader): { timescale: number; durationSec: number } {
  r.seek(box.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8); // creation + modification time
  const timescale = r.u32();
  const duration = version === 1 ? r.u64() : r.u32();
  return { timescale, durationSec: timescale > 0 ? duration / timescale : 0 };
}

function parseTrak(r: Reader, trak: BoxHeader): ParsedTrack | undefined {
  const tkhd = child(r, trak, 'tkhd') ?? fail('trak has no tkhd');
  const { trackId, rotation } = parseTkhd(r, tkhd);

  const mdia = child(r, trak, 'mdia') ?? fail('trak has no mdia');
  const mdhd = child(r, mdia, 'mdhd') ?? fail('mdia has no mdhd');
  const { timescale, durationSec } = parseMdhd(r, mdhd);

  const hdlr = child(r, mdia, 'hdlr') ?? fail('mdia has no hdlr');
  const handler = parseHandler(r, hdlr);
  const mediaType: MediaType | undefined =
    handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : undefined;
  if (mediaType === undefined) return undefined; // skip subtitle/data tracks

  const minf = child(r, mdia, 'minf') ?? fail('mdia has no minf');
  const stbl = child(r, minf, 'stbl') ?? fail('minf has no stbl');
  const stsd = child(r, stbl, 'stsd') ?? fail('stbl has no stsd');

  const samples = parseSampleTable(r, stbl);
  const sampleCount = samples.sampleSizes.length;
  const fps = mediaType === 'video' && durationSec > 0 ? sampleCount / durationSec : undefined;

  const entry = parseStsd(r, stsd, mediaType);
  const encryption = entry.encryption ? readSenc(r, stbl, entry.encryption) : undefined;

  const base = {
    id: trackId,
    mediaType,
    timescale,
    durationSec,
    codec: entry.codec,
    sampleEntryType: entry.type,
    config: entry.config,
    samples,
    ...(entry.codecPrivate ? { codecPrivate: entry.codecPrivate } : {}),
    ...(encryption ? { encryption } : {}),
  };
  if (mediaType === 'video') {
    return {
      ...base,
      ...(entry.width !== undefined ? { width: entry.width } : {}),
      ...(entry.height !== undefined ? { height: entry.height } : {}),
      ...(rotation !== undefined ? { rotation } : {}),
      ...(fps !== undefined ? { fps } : {}),
    };
  }
  return {
    ...base,
    ...(entry.sampleRate !== undefined ? { sampleRate: entry.sampleRate } : {}),
    ...(entry.channels !== undefined ? { channels: entry.channels } : {}),
  };
}

function parseTkhd(r: Reader, box: BoxHeader): { trackId: number; rotation?: number } {
  r.seek(box.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8); // creation + modification
  const trackId = r.u32();
  r.skip(4); // reserved
  r.skip(version === 1 ? 8 : 4); // duration
  r.skip(8 + 2 + 2 + 2 + 2); // reserved + layer + altgroup + volume + reserved
  const a = r.fixed16();
  const b = r.fixed16();
  r.skip(4); // u
  const c = r.fixed16();
  const d = r.fixed16();
  // remaining matrix (v, x, y, w) + width + height are unused for rotation
  const rotation = matrixRotation(a, b, c, d);
  return rotation === undefined ? { trackId } : { trackId, rotation };
}

function matrixRotation(a: number, b: number, _c: number, _d: number): number | undefined {
  if (a === 1 && b === 0) return 0;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  const norm = ((deg % 360) + 360) % 360;
  return norm === 0 ? undefined : norm;
}

function parseMdhd(r: Reader, box: BoxHeader): { timescale: number; durationSec: number } {
  r.seek(box.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8);
  const timescale = r.u32();
  const duration = version === 1 ? r.u64() : r.u32();
  return { timescale, durationSec: timescale > 0 ? duration / timescale : 0 };
}

function parseHandler(r: Reader, box: BoxHeader): string {
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  r.skip(4); // pre_defined
  return r.fourcc();
}

interface SampleEntry {
  type: string;
  codec: string;
  config: VideoDecoderConfig | AudioDecoderConfig;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  codecPrivate?: CodecPrivate;
  encryption?: Omit<TrackProtection, 'senc'>;
}

function parseStsd(r: Reader, stsd: BoxHeader, mediaType: MediaType): SampleEntry {
  r.seek(stsd.payloadStart);
  readFullBoxHeader(r);
  r.u32(); // entry_count
  const entry = { ...readBoxHeaderAt(r) };
  const protection =
    entry.type === 'enca' || entry.type === 'encv'
      ? parseProtection(r, entry, mediaType)
      : undefined;
  // Parse the inner sample entry as the original format (`frma`), so codec config + dims are read.
  const effective = protection ? { ...entry, type: protection.originalType } : entry;
  const parsed =
    mediaType === 'video' ? parseVisualEntry(r, effective) : parseAudioEntry(r, effective);
  if (!protection) return parsed;
  return {
    ...parsed,
    type: protection.originalType,
    encryption: { schemeType: protection.schemeType, tenc: protection.tenc },
  };
}

/** Parse the `sinf` protection boxes inside an `enca`/`encv` entry: `frma`, `schm`, `schi`→`tenc`. */
function parseProtection(
  r: Reader,
  entry: BoxHeader,
  mediaType: MediaType,
): { originalType: string; schemeType: string; tenc: Uint8Array } | undefined {
  r.seek(entry.payloadStart + (mediaType === 'audio' ? 28 : 78)); // skip fixed sample-entry fields
  const sinf = boxFrom(r, entry.end, 'sinf');
  if (!sinf) return undefined;
  r.seek(sinf.payloadStart);
  const frma = boxFrom(r, sinf.end, 'frma');
  r.seek(sinf.payloadStart);
  const schm = boxFrom(r, sinf.end, 'schm');
  r.seek(sinf.payloadStart);
  const schi = boxFrom(r, sinf.end, 'schi');
  if (!frma || !schi) return undefined;
  r.seek(frma.payloadStart);
  const originalType = r.fourcc();
  let schemeType = 'cenc';
  if (schm) {
    r.seek(schm.payloadStart);
    readFullBoxHeader(r);
    schemeType = r.fourcc();
  }
  r.seek(schi.payloadStart);
  const tenc = boxFrom(r, schi.end, 'tenc');
  if (!tenc) return undefined;
  return { originalType, schemeType, tenc: r.bytesAt(tenc.payloadStart, tenc.end).slice() };
}

function readBoxHeaderAt(r: Reader): BoxHeader {
  const start = r.pos;
  const size = r.u32();
  const type = r.fourcc();
  return { type, size, headerSize: 8, start, payloadStart: start + 8, end: start + size };
}

// Video sample-entry → (config box type, codec-string fn). avc1/avc3→avcC, hvc1/hev1→hvcC, av01→av1C.
const VIDEO_CONFIG: Record<
  string,
  { box: string; codec: (type: string, rec: Uint8Array) => string }
> = {
  avc1: { box: 'avcC', codec: (_t, rec) => avcCodecString(rec) },
  avc3: { box: 'avcC', codec: (_t, rec) => avcCodecString(rec) },
  hvc1: { box: 'hvcC', codec: (t, rec) => hevcCodecString(t, rec) },
  hev1: { box: 'hvcC', codec: (t, rec) => hevcCodecString(t, rec) },
  av01: { box: 'av1C', codec: (_t, rec) => av1CodecString(rec) },
};

function parseVisualEntry(r: Reader, entry: BoxHeader): SampleEntry {
  r.seek(entry.payloadStart);
  r.skip(6 + 2); // reserved + data_reference_index
  r.skip(2 + 2 + 12); // pre_defined + reserved + pre_defined[3]
  const width = r.u16();
  const height = r.u16();
  r.skip(4 + 4 + 4 + 2 + 32 + 2 + 2); // resolutions + reserved + frame_count + compressorname + depth + pre_defined
  const childStart = r.pos;

  const spec = VIDEO_CONFIG[entry.type];
  if (spec) {
    r.seek(childStart);
    const cfg = boxFrom(r, entry.end, spec.box);
    if (cfg) {
      const record = r.bytesAt(cfg.payloadStart, cfg.end).slice();
      const codec = spec.codec(entry.type, record);
      return {
        type: entry.type,
        codec,
        config: { codec, codedWidth: width, codedHeight: height, description: record },
        width,
        height,
        codecPrivate: { boxType: spec.box, data: record },
      };
    }
  }
  const codec = entry.type;
  return {
    type: entry.type,
    codec,
    config: { codec, codedWidth: width, codedHeight: height },
    width,
    height,
  };
}

/**
 * The version-dependent geometry of an `AudioSampleEntry` / QuickTime sound sample description: the
 * channel count, sample rate (Hz), and the absolute offset where the codec sub-boxes (e.g. `esds`)
 * begin. After the 8-byte preamble (6 reserved + 2 `data_reference_index`) the entry carries a
 * `version` (u16) + `revision` (u16) + `vendor` (u32); the layout then differs by version
 * (ISO/IEC 14496-12 §12.2.3.2 + Apple QTFF "Sound Sample Descriptions", v0/v1/v2).
 */
interface AudioGeometry {
  channels: number;
  sampleRate: number;
  /** Absolute offset (from the start of the file buffer) of the first codec sub-box. */
  childStart: number;
}

function parseAudioGeometry(r: Reader, entry: BoxHeader): AudioGeometry {
  const base = entry.payloadStart;
  r.seek(base + 6 + 2); // skip 6 reserved + data_reference_index
  const version = r.u16();
  r.skip(2 + 4); // revision + vendor

  // v0 slots: channelcount(u16), samplesize(u16), pre_defined(u16), reserved(u16), sampleRate(16.16).
  // v1 keeps these valid and appends 16 bytes; v2 overwrites them with constants and stores the real
  // values in a wider struct, so it is read separately below.
  const v0Channels = r.u16();
  r.skip(2 + 2 + 2); // samplesize + pre_defined + reserved
  const v0SampleRate = r.u32() >>> 16; // 16.16 fixed-point → integer Hz

  if (version === 2) {
    // QTFF v2 struct (after the 8-byte version/revision/vendor preamble at base+8): always3(u16),
    // always16(u16), alwaysMinus2(s16), always0(u16), always65536(u32), sizeOfStructOnly(u32),
    // audioSampleRate(f64), numAudioChannels(u32), then five trailing u32s — 56 bytes total, so the
    // codec sub-boxes start at base+64. The real rate/channels live in the f64 + numAudioChannels.
    const f64 = r.bytesAt(base + 32, base + 40);
    const sampleRate = Math.round(
      new DataView(f64.buffer, f64.byteOffset, f64.byteLength).getFloat64(0),
    );
    r.seek(base + 40);
    const channels = r.u32();
    return { channels, sampleRate, childStart: base + 64 };
  }

  // v1 appends samplesPerPacket/bytesPerPacket/bytesPerFrame/bytesPerSample (4×u32 = 16 bytes) before
  // the sub-boxes; v0 (and any unknown version, treated as v0) has the sub-boxes immediately after.
  const childStart = base + 28 + (version === 1 ? 16 : 0);
  return { channels: v0Channels, sampleRate: v0SampleRate, childStart };
}

/**
 * Locate the codec-configuration box for an audio sample entry. In ISO MP4 the box (`esds`) is a
 * direct child of the entry; in QuickTime it is commonly nested inside a `wave` box (the sound
 * extension) alongside `frma`/`<codec>`. Search both so v0/v1/v2 QuickTime entries resolve.
 */
function findAudioConfigBox(
  r: Reader,
  childStart: number,
  end: number,
  type: string,
): BoxHeader | undefined {
  r.seek(childStart);
  const direct = boxFrom(r, end, type);
  if (direct) return direct;
  r.seek(childStart);
  const wave = boxFrom(r, end, 'wave');
  if (!wave) return undefined;
  r.seek(wave.payloadStart);
  return boxFrom(r, wave.end, type);
}

function parseAudioEntry(r: Reader, entry: BoxHeader): SampleEntry {
  const { channels, sampleRate, childStart } = parseAudioGeometry(r, entry);

  const esds = findAudioConfigBox(r, childStart, entry.end, 'esds');
  if (esds && entry.type === 'mp4a') {
    const esdsPayload = r.bytesAt(esds.payloadStart, esds.end);
    const info = parseEsds(esdsPayload);
    const config: AudioDecoderConfig = {
      codec: info.codec,
      sampleRate,
      numberOfChannels: channels,
      ...(info.asc ? { description: info.asc } : {}),
    };
    return {
      type: entry.type,
      codec: info.codec,
      config,
      sampleRate,
      channels,
      codecPrivate: { boxType: 'esds', data: esdsPayload },
    };
  }
  const codec = entry.type;
  return {
    type: entry.type,
    codec,
    config: { codec, sampleRate, numberOfChannels: channels },
    sampleRate,
    channels,
  };
}

/** Attach the raw `senc` IV box (from `stbl`) to the track's protection metadata, if present. */
function readSenc(r: Reader, stbl: BoxHeader, enc: Omit<TrackProtection, 'senc'>): TrackProtection {
  const senc = child(r, stbl, 'senc');
  if (!senc) return enc;
  return { ...enc, senc: r.bytesAt(senc.payloadStart, senc.end).slice() };
}

function parseSampleTable(r: Reader, stbl: BoxHeader): SampleTable {
  return {
    timeToSample: parseStts(r, child(r, stbl, 'stts')),
    compositionOffsets: parseCtts(r, child(r, stbl, 'ctts')),
    sampleSizes: parseStsz(r, child(r, stbl, 'stsz')),
    sampleToChunk: parseStsc(r, child(r, stbl, 'stsc')),
    chunkOffsets: parseChunkOffsets(r, child(r, stbl, 'stco'), child(r, stbl, 'co64')),
    syncSamples: parseStss(r, child(r, stbl, 'stss')),
  };
}

function parseStts(r: Reader, box: BoxHeader | undefined): TimeToSample[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const n = r.u32();
  const out: TimeToSample[] = [];
  for (let i = 0; i < n; i++) out.push({ count: r.u32(), delta: r.u32() });
  return out;
}

function parseCtts(r: Reader, box: BoxHeader | undefined): CompositionOffset[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  const { version } = readFullBoxHeader(r);
  const n = r.u32();
  const out: CompositionOffset[] = [];
  for (let i = 0; i < n; i++)
    out.push({ count: r.u32(), offset: version === 1 ? r.i32() : r.u32() });
  return out;
}

function parseStsz(r: Reader, box: BoxHeader | undefined): number[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const sampleSize = r.u32();
  const count = r.u32();
  if (sampleSize !== 0) return new Array<number>(count).fill(sampleSize);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(r.u32());
  return out;
}

function parseStsc(r: Reader, box: BoxHeader | undefined): SampleToChunk[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const n = r.u32();
  const out: SampleToChunk[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ firstChunk: r.u32(), samplesPerChunk: r.u32(), descIndex: r.u32() });
  }
  return out;
}

function parseChunkOffsets(
  r: Reader,
  stco: BoxHeader | undefined,
  co64: BoxHeader | undefined,
): number[] {
  const box = stco ?? co64;
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const n = r.u32();
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(co64 ? r.u64() : r.u32());
  return out;
}

function parseStss(r: Reader, box: BoxHeader | undefined): number[] {
  if (!box) return [];
  r.seek(box.payloadStart);
  readFullBoxHeader(r);
  const n = r.u32();
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(r.u32());
  return out;
}
