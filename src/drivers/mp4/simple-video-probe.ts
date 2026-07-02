import type { TrackInfo } from '../../contracts/driver.ts';
import { avcCodecString, parseEsds } from './codec-strings.ts';
import { type BoxHeader, Reader, boxes, readFullBoxHeader } from './reader.ts';

const SIMPLE_VIDEO_FASTSTART_PROBE_PREFETCH_BYTES = 8 * 1024;
const TINY_AUDIO_FASTSTART_PROBE_MAX_BYTES = 16 * 1024;

interface SimpleRandomAccess {
  readonly size?: number;
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
    size = r.u64();
    headerSize = 16;
  } else if (size === 0) {
    return undefined;
  }
  if (size < headerSize || size <= 0) return undefined;
  return { size, type, headerSize };
}

export async function readSimpleVideoFaststartProbe(
  ra: SimpleRandomAccess,
): Promise<SimpleVideoFaststartProbe | undefined> {
  if (ra.size === undefined) return undefined;
  const head = await ra.read(0, Math.min(ra.size, SIMPLE_VIDEO_FASTSTART_PROBE_PREFETCH_BYTES));
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
        const tracks = parseSimpleVideoFaststartProbeTracks(moov);
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
    size = r.u64();
    headerSize = 16;
  } else if (size === 0) {
    size = r.length - start;
  }
  if (size < headerSize || start + size > r.length) return undefined;
  return { type, size, headerSize, start, payloadStart: start + headerSize, end: start + size };
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

function probeTrackId(r: Reader, tkhd: BoxHeader): number {
  r.seek(tkhd.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8);
  return r.u32();
}

function probeTrackHeader(r: Reader, tkhd: BoxHeader): ProbeTrackHeader {
  r.seek(tkhd.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8);
  const id = r.u32();
  r.skip(4);
  r.skip(version === 1 ? 8 : 4);
  r.skip(8 + 2 + 2 + 2 + 2);
  const a = r.fixed16();
  const b = r.fixed16();
  const rotation = probeMatrixRotation(a, b);
  return rotation === undefined ? { id } : { id, rotation };
}

function probeMatrixRotation(a: number, b: number): number | undefined {
  if (a === 1 && b === 0) return 0;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  const norm = ((deg % 360) + 360) % 360;
  return norm === 0 ? undefined : norm;
}

function probeMdhd(r: Reader, mdhd: BoxHeader): { timescale: number; durationSec: number } {
  r.seek(mdhd.payloadStart);
  const { version } = readFullBoxHeader(r);
  r.skip(version === 1 ? 16 : 8);
  const timescale = r.u32();
  const duration = version === 1 ? r.u64() : r.u32();
  return { timescale, durationSec: timescale > 0 ? duration / timescale : 0 };
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

  r.seek(elst.payloadStart);
  const { version } = readFullBoxHeader(r);
  const entryCount = r.u32();
  let active: ProbeEdit | undefined;
  for (let i = 0; i < entryCount; i++) {
    const segmentDuration = version === 1 ? r.u64() : r.u32();
    const mediaTime = version === 1 ? readSigned64(r) : r.i32();
    const mediaRateInteger = r.i16();
    const mediaRateFraction = r.i16();
    if (mediaTime < 0) continue;
    if (mediaRateInteger !== 1 || mediaRateFraction !== 0 || active !== undefined) return undefined;
    active = {
      mediaTimeTicks: mediaTime,
      durationSec: movieTimescale > 0 ? segmentDuration / movieTimescale : 0,
    };
  }
  return active;
}

function readSigned64(r: Reader): number {
  const hi = r.i32();
  const lo = r.u32();
  return hi * 2 ** 32 + lo;
}

function probeAudioEntry(r: Reader, stsd: BoxHeader): ProbeAudioEntry | undefined {
  r.seek(stsd.payloadStart);
  readFullBoxHeader(r);
  if (r.u32() !== 1) return undefined;
  const entry = probeBoxAt(r);
  if (entry === undefined || entry.type !== 'mp4a') return undefined;
  const { channels, sampleRate, childStart } = probeAudioGeometry(r, entry);
  const esds = probeAudioConfigBox(r, childStart, entry.end, 'esds');
  if (esds === undefined) return undefined;
  const info = parseEsds(r.bytesAt(esds.payloadStart, esds.end));
  const config: AudioDecoderConfig = {
    codec: info.codec,
    sampleRate,
    numberOfChannels: channels,
    ...(info.asc ? { description: info.asc } : {}),
  };
  return { type: entry.type, codec: info.codec, sampleRate, channels, config };
}

function probeVideoEntry(r: Reader, stsd: BoxHeader): ProbeVideoEntry | undefined {
  r.seek(stsd.payloadStart);
  readFullBoxHeader(r);
  if (r.u32() !== 1) return undefined;
  const entry = probeBoxAt(r);
  if (entry === undefined || (entry.type !== 'avc1' && entry.type !== 'avc3')) return undefined;
  r.seek(entry.payloadStart);
  r.skip(6 + 2 + 2 + 2 + 12);
  const width = r.u16();
  const height = r.u16();
  r.skip(4 + 4 + 4 + 2 + 32 + 2 + 2);
  const avcC = probeBoxFrom(r, r.pos, entry.end, 'avcC');
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
  const leadingSamples = Math.max(0, Math.round(edit.mediaTimeTicks * scale));
  const totalSamples = Math.max(0, Math.round(edit.durationSec * sampleRate));
  const trailingSamples = Math.max(0, codedSamples - leadingSamples - totalSamples);
  return { leadingSamples, trailingSamples, totalSamples };
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

function parseTinyAudioFaststartProbeTracks(moov: Uint8Array): readonly TrackInfo[] | undefined {
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
    const id = probeTrackId(r, tkhd);
    const timing = probeMdhd(r, mdhd);
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
      id,
      mediaType: 'audio',
      codec: entry.codec,
      durationSec: timing.durationSec,
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
      return parseTinyAudioFaststartProbeTracks(
        head.subarray(offset + header.headerSize, offset + header.size),
      );
    }
    offset += header.size;
    if (offset + 8 > head.byteLength) return undefined;
  }
}

function parseSimpleVideoFaststartProbeTracks(moov: Uint8Array): readonly TrackInfo[] | undefined {
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
  const tracks: TrackInfo[] = [];
  let sawVideo = false;
  for (const trak of probeChildren(r, root, 'trak')) {
    const parsed = probeSimpleTrack(r, trak, movieTimescale);
    if (parsed === undefined) return undefined;
    if (parsed.kind === 'skip') continue;
    sawVideo ||= parsed.track.mediaType === 'video';
    tracks.push(parsed.track);
  }
  return sawVideo && tracks.length > 0 ? tracks : undefined;
}

function probeSimpleTrack(
  r: Reader,
  trak: BoxHeader,
  movieTimescale: number,
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
  const timing = probeMdhd(r, mdhd);
  const sampleTiming = probeSampleTiming(r, stbl);
  if (sampleTiming.sampleCount === 0) return undefined;
  const edit = probeTrackEdit(r, trak, movieTimescale);
  if (handler === 'vide') {
    const entry = probeVideoEntry(r, stsd);
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
        durationSec: timing.durationSec,
        ...(fps !== undefined ? { fps } : {}),
        ...(header.rotation !== undefined ? { rotation: header.rotation } : {}),
        config: entry.config,
      },
    };
  }

  const entry = probeAudioEntry(r, stsd);
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
      durationSec: timing.durationSec,
      ...(gapless !== undefined ? { gapless } : {}),
      config: entry.config,
    },
  };
}
