import type { TrackInfo } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { avcCodecString, parseEsds } from './codec-strings.ts';
import { clockwiseRotationFromMp4MatrixFirstRow } from './display-transform.ts';
import { gaplessFromMp4Edit } from './gapless.ts';
import { decodeMdhdLanguage } from './mdhd-language.ts';
import { type BoxHeader, Reader, boxes, readFullBoxHeader } from './reader.ts';

const SIMPLE_VIDEO_FASTSTART_PROBE_PREFETCH_BYTES = 8 * 1024;
const SIMPLE_VIDEO_FASTSTART_PROBE_MAX_PREFETCH_BYTES = 128 * 1024;
const TINY_AUDIO_FASTSTART_PROBE_MAX_BYTES = 16 * 1024;

interface SimpleRandomAccess {
  readonly size?: number | undefined;
  read(offset: number, length: number): Promise<Uint8Array>;
}

interface TopBoxHeader {
  size: number;
  type: string;
  headerSize: number;
}

interface ProbeEdit {
  readonly mediaTimeTicks: number;
  readonly durationSec: number;
}

interface ProbeAudioEntry {
  readonly type: string;
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly config: AudioDecoderConfig;
}

interface ProbeVideoEntry {
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly config: VideoDecoderConfig;
}

interface ProbeTrackHeader {
  readonly id: number;
  readonly defaultDisposition: boolean;
  readonly canonicalRotationMatrix: boolean;
  readonly rotation?: number;
}

interface ProbeSampleTiming {
  readonly sampleCount: number;
  readonly durationTicks: number;
}

type SimpleProbeTrack =
  | { readonly kind: 'track'; readonly track: TrackInfo }
  | { readonly kind: 'skip' };

export interface SimpleVideoFaststartProbe {
  readonly tracks: readonly TrackInfo[];
  readonly brand: string;
  readonly moov: Uint8Array;
}

function topBoxHeader(bytes: Uint8Array, offset: number): TopBoxHeader | undefined {
  if (offset + 8 > bytes.byteLength) return undefined;
  const r = new Reader(bytes.subarray(offset, Math.min(bytes.byteLength, offset + 16)));
  let size = r.u32();
  const type = r.fourcc();
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > bytes.byteLength) return undefined;
    const big = r.u64BigInt();
    if (big < 16n || big > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    size = Number(big);
    headerSize = 16;
  } else if (size === 0) {
    return undefined;
  }
  if (size < headerSize || size <= 0) return undefined;
  return { size, type, headerSize };
}

export async function readSimpleVideoFaststartProbe(
  ra: SimpleRandomAccess,
  prefetchBytes = SIMPLE_VIDEO_FASTSTART_PROBE_PREFETCH_BYTES,
  requireEveryTrack = false,
): Promise<SimpleVideoFaststartProbe | undefined> {
  if (ra.size === undefined) return undefined;
  const boundedPrefetchBytes =
    Number.isSafeInteger(prefetchBytes) && prefetchBytes > 0
      ? Math.min(prefetchBytes, SIMPLE_VIDEO_FASTSTART_PROBE_MAX_PREFETCH_BYTES)
      : SIMPLE_VIDEO_FASTSTART_PROBE_PREFETCH_BYTES;
  const head = await ra.read(0, Math.min(ra.size, boundedPrefetchBytes));
  let offset = 0;
  let brand = 'mp42';
  for (;;) {
    const header = topBoxHeader(head, offset);
    if (header === undefined) return undefined;
    if (header.type === 'ftyp' && offset + 12 <= head.byteLength) {
      brand = new Reader(head.subarray(offset + 8, offset + 12)).fourcc();
    }
    if (header.type === 'moov') {
      if (offset + header.size > head.byteLength) return undefined;
      try {
        const moov = head.subarray(offset + header.headerSize, offset + header.size);
        const tracks = parseSimpleVideoFaststartProbeTracks(moov, requireEveryTrack);
        return tracks === undefined ? undefined : { tracks, brand, moov };
      } catch {
        return undefined;
      }
    }
    offset += header.size;
    if (offset + 8 > head.byteLength) return undefined;
  }
}

function probeBoxAt(r: Reader): BoxHeader | undefined {
  if (r.pos + 8 > r.length) return undefined;
  const start = r.pos;
  let size = r.u32();
  const type = r.fourcc();
  let headerSize = 8;
  if (size === 1) {
    if (r.pos + 8 > r.length) return undefined;
    const big = r.u64BigInt();
    if (big < 16n || big > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    size = Number(big);
    headerSize = 16;
  } else if (size === 0) {
    size = r.length - start;
  }
  if (size < headerSize || start + size > r.length) return undefined;
  return { type, size, headerSize, start, payloadStart: start + headerSize, end: start + size };
}

function declaredBoxSize(r: Reader, start: number): number | undefined {
  if (start < 0 || start + 4 > r.length) return undefined;
  const bytes = r.bytesAt(start, start + 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
}

function probeChild(r: Reader, parent: BoxHeader, type: string): BoxHeader | undefined {
  r.seek(parent.payloadStart);
  for (const box of boxes(r, parent.end)) {
    if (box.type === type) return box;
  }
  return undefined;
}

function probeChildren(r: Reader, parent: BoxHeader, type: string): BoxHeader[] {
  r.seek(parent.payloadStart);
  const out: BoxHeader[] = [];
  for (const box of boxes(r, parent.end)) {
    if (box.type === type) out.push(box);
  }
  return out;
}

function probeBoxFrom(r: Reader, start: number, end: number, type: string): BoxHeader | undefined {
  r.seek(start);
  for (const box of boxes(r, end)) {
    if (box.type === type) return box;
  }
  return undefined;
}

function probeMovieTimescale(r: Reader, mvhd: BoxHeader): number {
  r.seek(mvhd.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8);
  return r.u32();
}

function probeTrackHeader(r: Reader, tkhd: BoxHeader): ProbeTrackHeader {
  r.seek(tkhd.payloadStart);
  const { version, flags } = readFullBoxHeader(r);
  const defaultDisposition = (flags & 0x000001) !== 0;
  r.skip(version === 1 ? 16 : 8);
  const id = r.u32();
  r.skip(4);
  r.skip(version === 1 ? 8 : 4);
  r.skip(8 + 2 + 2 + 2 + 2);
  const matrix = Array.from({ length: 9 }, () => r.u32());
  const a = ((matrix[0] ?? 0) | 0) / 65536;
  const b = ((matrix[1] ?? 0) | 0) / 65536;
  const rotation = probeMatrixRotation(a, b);
  const canonicalRotationMatrix = isCanonicalRotationMatrix(matrix);
  return rotation === undefined
    ? { id, defaultDisposition, canonicalRotationMatrix }
    : { id, defaultDisposition, canonicalRotationMatrix, rotation };
}

function isCanonicalRotationMatrix(matrix: readonly number[]): boolean {
  const a = matrix[0] ?? 0;
  const b = matrix[1] ?? 0;
  const perspectiveX = matrix[2] ?? 0;
  const c = matrix[3] ?? 0;
  const d = matrix[4] ?? 0;
  const perspectiveY = matrix[5] ?? 0;
  const perspectiveScale = matrix[8] ?? 0;
  return (
    perspectiveX === 0 &&
    perspectiveY === 0 &&
    perspectiveScale === 0x40000000 &&
    ((a === 0x00010000 && b === 0 && c === 0 && d === 0x00010000) ||
      (a === 0 && b === 0x00010000 && c === 0xffff0000 && d === 0) ||
      (a === 0xffff0000 && b === 0 && c === 0 && d === 0xffff0000) ||
      (a === 0 && b === 0xffff0000 && c === 0x00010000 && d === 0))
  );
}

function probeMatrixRotation(a: number, b: number): number | undefined {
  if (a === 1 && b === 0) return 0;
  const rotation = clockwiseRotationFromMp4MatrixFirstRow(a, b);
  // Match the canonical complete-matrix projection: a scaled or near-identity matrix whose rounded
  // angle is zero is not the exact identity and therefore has no public scalar rotation.
  return rotation === 0 ? undefined : rotation;
}

function probeMdhd(
  r: Reader,
  mdhd: BoxHeader,
): { timescale: number; durationSec: number; language?: string } | undefined {
  r.seek(mdhd.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8);
  const timescale = r.u32();
  let duration: number;
  if (version === 1) {
    const big = r.u64BigInt();
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    duration = Number(big);
  } else {
    duration = r.u32();
  }
  const language = r.pos + 2 <= mdhd.end ? decodeMdhdLanguage(r.u16()) : undefined;
  return {
    timescale,
    durationSec: timescale > 0 ? duration / timescale : 0,
    ...(language !== undefined ? { language } : {}),
  };
}

function probeHandler(r: Reader, hdlr: BoxHeader): string {
  r.seek(hdlr.payloadStart);
  readFullBoxHeader(r);
  r.skip(4);
  return r.fourcc();
}

function probeTrackEdit(r: Reader, trak: BoxHeader, movieTimescale: number): ProbeEdit | undefined {
  const edts = probeChild(r, trak, 'edts');
  const elst = edts === undefined ? undefined : probeChild(r, edts, 'elst');
  if (elst === undefined) return undefined;

  try {
    r.seek(elst.payloadStart);
    const { version } = readFullBoxHeader(r);
    const entryCount = r.u32();
    let active: ProbeEdit | undefined;
    for (let i = 0; i < entryCount; i++) {
      let segmentDuration: number;
      if (version === 1) {
        const big = r.u64BigInt();
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
        segmentDuration = Number(big);
      } else {
        segmentDuration = r.u32();
      }
      const mediaTime = version === 1 ? readSigned64(r) : r.i32();
      const mediaRateInteger = r.i16();
      const mediaRateFraction = r.i16();
      if (mediaTime < 0) continue;
      if (mediaRateInteger !== 1 || mediaRateFraction !== 0 || active !== undefined)
        return undefined;
      active = {
        mediaTimeTicks: mediaTime,
        durationSec: movieTimescale > 0 ? segmentDuration / movieTimescale : 0,
      };
    }
    return active;
  } catch {
    return undefined;
  }
}

function readSigned64(r: Reader): number {
  const big = r.i64BigInt();
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MediaError('demux-error', `signed 64-bit field ${big} exceeds safe integer range`);
  }
  return Number(big);
}

function probeAudioEntry(
  r: Reader,
  stsd: BoxHeader,
  requireCanonicalSubset = false,
): ProbeAudioEntry | undefined {
  r.seek(stsd.payloadStart);
  readFullBoxHeader(r);
  if (r.u32() !== 1) return undefined;
  const entryStart = r.pos;
  const entry = probeBoxAt(r);
  if (entry === undefined || entry.type !== 'mp4a') return undefined;
  if (requireCanonicalSubset && (entry.headerSize !== 8 || declaredBoxSize(r, entryStart) === 0)) {
    return undefined;
  }
  const { channels, sampleRate, childStart } = probeAudioGeometry(r, entry);
  const esds = probeAudioConfigBox(r, childStart, entry.end, 'esds');
  if (esds === undefined) return undefined;
  const info = parseEsds(r.bytesAt(esds.payloadStart, esds.end));
  const aacSampleRate = info.sampleRate ?? sampleRate;
  const aacChannels = info.sbrPresent === true ? channels : (info.channels ?? channels);
  const config: AudioDecoderConfig = {
    codec: info.codec,
    sampleRate: aacSampleRate,
    numberOfChannels: aacChannels,
    ...(info.asc ? { description: info.asc } : {}),
  };
  return {
    type: entry.type,
    codec: info.codec,
    sampleRate: aacSampleRate,
    channels: aacChannels,
    config,
  };
}

function probeVideoEntry(
  r: Reader,
  stsd: BoxHeader,
  requireCanonicalSubset = false,
): ProbeVideoEntry | undefined {
  r.seek(stsd.payloadStart);
  readFullBoxHeader(r);
  if (r.u32() !== 1) return undefined;
  const entryStart = r.pos;
  const entry = probeBoxAt(r);
  if (entry === undefined || (entry.type !== 'avc1' && entry.type !== 'avc3')) return undefined;
  if (requireCanonicalSubset && (entry.headerSize !== 8 || declaredBoxSize(r, entryStart) === 0)) {
    return undefined;
  }
  r.seek(entry.payloadStart);
  r.skip(6 + 2 + 2 + 2 + 12);
  const width = r.u16();
  const height = r.u16();
  r.skip(4 + 4 + 4 + 2 + 32 + 2 + 2);
  const childStart = r.pos;
  if (
    requireCanonicalSubset &&
    ['colr', 'pasp', 'clap'].some(
      (type) => probeBoxFrom(r, childStart, entry.end, type) !== undefined,
    )
  ) {
    return undefined;
  }
  const avcC = probeBoxFrom(r, childStart, entry.end, 'avcC');
  if (avcC === undefined) return undefined;
  const description = r.bytesAt(avcC.payloadStart, avcC.end).slice();
  const codec = avcCodecString(description);
  return {
    codec,
    width,
    height,
    config: { codec, codedWidth: width, codedHeight: height, description },
  };
}

function probeAudioGeometry(
  r: Reader,
  entry: BoxHeader,
): { channels: number; sampleRate: number; childStart: number } {
  const base = entry.payloadStart;
  r.seek(base + 6 + 2);
  const version = r.u16();
  r.skip(2 + 4);
  const v0Channels = r.u16();
  r.skip(2 + 2 + 2);
  const v0SampleRate = r.u32() >>> 16;
  if (version === 2) {
    const f64 = r.bytesAt(base + 32, base + 40);
    const sampleRate = Math.round(
      new DataView(f64.buffer, f64.byteOffset, f64.byteLength).getFloat64(0),
    );
    r.seek(base + 40);
    return { channels: r.u32(), sampleRate, childStart: base + 64 };
  }
  return {
    channels: v0Channels,
    sampleRate: v0SampleRate,
    childStart: base + 28 + (version === 1 ? 16 : 0),
  };
}

function probeAudioConfigBox(
  r: Reader,
  childStart: number,
  end: number,
  type: string,
): BoxHeader | undefined {
  const direct = probeBoxFrom(r, childStart, end, type);
  if (direct !== undefined) return direct;
  const wave = probeBoxFrom(r, childStart, end, 'wave');
  return wave === undefined ? undefined : probeBoxFrom(r, wave.payloadStart, wave.end, type);
}

function probeSampleTiming(r: Reader, stbl: BoxHeader): ProbeSampleTiming {
  const stts = probeChild(r, stbl, 'stts');
  let sttsSampleCount = 0;
  let durationTicks = 0;
  if (stts !== undefined) {
    r.seek(stts.payloadStart);
    readFullBoxHeader(r);
    const entryCount = r.u32();
    for (let i = 0; i < entryCount; i++) {
      const count = r.u32();
      const delta = r.u32();
      sttsSampleCount += count;
      durationTicks += count * delta;
    }
  }

  const stsz = probeChild(r, stbl, 'stsz');
  if (stsz === undefined) return { sampleCount: sttsSampleCount, durationTicks };
  r.seek(stsz.payloadStart);
  readFullBoxHeader(r);
  r.skip(4);
  return { sampleCount: r.u32(), durationTicks };
}

function probeGapless(
  edit: ProbeEdit | undefined,
  sampleRate: number,
  timescale: number,
  durationTicks: number | undefined,
): TrackInfo['gapless'] | undefined {
  if (edit === undefined || durationTicks === undefined || sampleRate <= 0 || timescale <= 0) {
    return undefined;
  }
  const scale = sampleRate / timescale;
  const codedSamples = Math.max(0, Math.round(durationTicks * scale));
  return gaplessFromMp4Edit(
    edit.mediaTimeTicks,
    edit.durationSec,
    sampleRate,
    timescale,
    codedSamples,
  );
}

function probeSttsDurationTicks(r: Reader, stbl: BoxHeader): number | undefined {
  const stts = probeChild(r, stbl, 'stts');
  if (stts === undefined) return undefined;
  r.seek(stts.payloadStart);
  readFullBoxHeader(r);
  const entryCount = r.u32();
  let durationTicks = 0;
  for (let i = 0; i < entryCount; i++) {
    durationTicks += r.u32() * r.u32();
  }
  return durationTicks;
}

export function parseAudioFaststartProbeTracks(moov: Uint8Array): readonly TrackInfo[] | undefined {
  const r = new Reader(moov);
  const root: BoxHeader = {
    type: 'moov',
    size: moov.byteLength,
    headerSize: 0,
    start: 0,
    payloadStart: 0,
    end: moov.byteLength,
  };
  const mvhd = probeChild(r, root, 'mvhd');
  if (mvhd === undefined) return undefined;
  const movieTimescale = probeMovieTimescale(r, mvhd);
  const traks = probeChildren(r, root, 'trak');
  if (traks.length === 0) return undefined;
  const tracks: TrackInfo[] = [];
  for (const trak of traks) {
    const tkhd = probeChild(r, trak, 'tkhd');
    const mdia = probeChild(r, trak, 'mdia');
    if (tkhd === undefined || mdia === undefined) return undefined;
    const mdhd = probeChild(r, mdia, 'mdhd');
    const hdlr = probeChild(r, mdia, 'hdlr');
    if (mdhd === undefined || hdlr === undefined) return undefined;
    if (probeHandler(r, hdlr) !== 'soun') return undefined;
    const minf = probeChild(r, mdia, 'minf');
    const stbl = minf === undefined ? undefined : probeChild(r, minf, 'stbl');
    const stsd = stbl === undefined ? undefined : probeChild(r, stbl, 'stsd');
    if (stbl === undefined || stsd === undefined) return undefined;
    const header = probeTrackHeader(r, tkhd);
    const timing = probeMdhd(r, mdhd);
    if (timing === undefined) return undefined;
    const entry = probeAudioEntry(r, stsd);
    if (entry === undefined || entry.type !== 'mp4a') return undefined;
    const edit = probeTrackEdit(r, trak, movieTimescale);
    const gapless = probeGapless(
      edit,
      entry.sampleRate,
      timing.timescale,
      probeSttsDurationTicks(r, stbl),
    );
    tracks.push({
      id: header.id,
      mediaType: 'audio',
      codec: entry.codec,
      defaultDisposition: header.defaultDisposition,
      durationSec: timing.durationSec,
      ...(timing.language !== undefined ? { language: timing.language } : {}),
      ...(gapless !== undefined ? { gapless } : {}),
      config: entry.config,
    });
  }
  return tracks;
}

export async function readTinyAudioFaststartProbe(
  ra: SimpleRandomAccess,
): Promise<readonly TrackInfo[] | undefined> {
  const head = await ra.read(0, Math.min(ra.size ?? 0, TINY_AUDIO_FASTSTART_PROBE_MAX_BYTES));
  let offset = 0;
  for (;;) {
    const header = topBoxHeader(head, offset);
    if (header === undefined) return undefined;
    if (header.type === 'moov') {
      if (offset + header.size > head.byteLength) return undefined;
      return parseAudioFaststartProbeTracks(
        head.subarray(offset + header.headerSize, offset + header.size),
      );
    }
    offset += header.size;
    if (offset + 8 > head.byteLength) return undefined;
  }
}

function parseSimpleVideoFaststartProbeTracks(
  moov: Uint8Array,
  requireEveryTrack: boolean,
): readonly TrackInfo[] | undefined {
  const r = new Reader(moov);
  const root: BoxHeader = {
    type: 'moov',
    size: moov.byteLength,
    headerSize: 0,
    start: 0,
    payloadStart: 0,
    end: moov.byteLength,
  };
  const mvhd = probeChild(r, root, 'mvhd');
  if (mvhd === undefined) return undefined;
  // Fragment timing can extend or replace the initial stbl duration/fps. The lightweight route does
  // not scan moof/traf runs, so a strict public probe must delegate every mvex movie to canonical.
  if (requireEveryTrack && probeChild(r, root, 'mvex') !== undefined) return undefined;
  const movieTimescale = probeMovieTimescale(r, mvhd);
  const tracks: TrackInfo[] = [];
  let sawVideo = false;
  for (const trak of probeChildren(r, root, 'trak')) {
    // The compact fast path intentionally does not publish every edit-derived TrackInfo fact. In
    // strict mode, decline using the parsed box hierarchy (including extended-size headers) rather
    // than accepting a result that can differ from the canonical metadata parser.
    if (requireEveryTrack && probeChild(r, trak, 'edts') !== undefined) return undefined;
    const parsed = probeSimpleTrack(r, trak, movieTimescale, requireEveryTrack);
    if (parsed === undefined) return undefined;
    if (parsed.kind === 'skip') {
      if (requireEveryTrack) return undefined;
      continue;
    }
    sawVideo ||= parsed.track.mediaType === 'video';
    tracks.push(parsed.track);
  }
  return sawVideo && tracks.length > 0 ? tracks : undefined;
}

function probeSimpleTrack(
  r: Reader,
  trak: BoxHeader,
  movieTimescale: number,
  requireCanonicalSubset = false,
): SimpleProbeTrack | undefined {
  const tkhd = probeChild(r, trak, 'tkhd');
  const mdia = probeChild(r, trak, 'mdia');
  if (tkhd === undefined || mdia === undefined) return undefined;
  const mdhd = probeChild(r, mdia, 'mdhd');
  const hdlr = probeChild(r, mdia, 'hdlr');
  if (mdhd === undefined || hdlr === undefined) return undefined;
  const handler = probeHandler(r, hdlr);
  if (handler !== 'vide' && handler !== 'soun') return { kind: 'skip' };
  const minf = probeChild(r, mdia, 'minf');
  const stbl = minf === undefined ? undefined : probeChild(r, minf, 'stbl');
  const stsd = stbl === undefined ? undefined : probeChild(r, stbl, 'stsd');
  if (stbl === undefined || stsd === undefined) return undefined;

  const header = probeTrackHeader(r, tkhd);
  if (requireCanonicalSubset && !header.canonicalRotationMatrix) return undefined;
  const timing = probeMdhd(r, mdhd);
  if (timing === undefined) return undefined;
  const sampleTiming = probeSampleTiming(r, stbl);
  if (sampleTiming.sampleCount === 0) return undefined;
  const edit = probeTrackEdit(r, trak, movieTimescale);
  if (handler === 'vide') {
    const entry = probeVideoEntry(r, stsd, requireCanonicalSubset);
    if (entry === undefined) return undefined;
    const fps =
      timing.durationSec > 0 && sampleTiming.sampleCount > 0
        ? sampleTiming.sampleCount / timing.durationSec
        : undefined;
    return {
      kind: 'track',
      track: {
        id: header.id,
        mediaType: 'video',
        codec: entry.codec,
        defaultDisposition: header.defaultDisposition,
        durationSec: timing.durationSec,
        ...(timing.language !== undefined ? { language: timing.language } : {}),
        ...(fps !== undefined ? { fps } : {}),
        ...(header.rotation !== undefined ? { rotation: header.rotation } : {}),
        config: entry.config,
      },
    };
  }

  const entry = probeAudioEntry(r, stsd, requireCanonicalSubset);
  if (entry === undefined) return undefined;
  const gapless = probeGapless(
    edit,
    entry.sampleRate,
    timing.timescale,
    sampleTiming.durationTicks > 0 ? sampleTiming.durationTicks : undefined,
  );
  return {
    kind: 'track',
    track: {
      id: header.id,
      mediaType: 'audio',
      codec: entry.codec,
      defaultDisposition: header.defaultDisposition,
      durationSec: timing.durationSec,
      ...(timing.language !== undefined ? { language: timing.language } : {}),
      ...(gapless !== undefined ? { gapless } : {}),
      config: entry.config,
    },
  };
}
