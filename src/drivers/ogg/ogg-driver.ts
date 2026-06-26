/**
 * The Ogg container driver — hand-written TS. An Ogg file is a sequence of **pages** (little-endian);
 * each logical stream opens with a BOS page whose first packet is the codec identification header
 * (Vorbis and Opus now; FLAC/Theora join with their fixtures, §6.1). Probe reads the head (for the ID
 * header) and the tail (for the last page's `granule_position` → duration), mirroring the moov-at-tail
 * strategy (docs/architecture/09).
 */

import {
  type ByteSource,
  type ContainerDriver,
  type ContainerQuery,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type MediaType,
  type MuxOptions,
  type Muxer,
  type Packet,
  type Registry,
  type StageOptions,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { OggMuxer } from './ogg-write.ts';

const OGG_MIMES = new Set(['audio/ogg', 'video/ogg', 'application/ogg', 'audio/opus']);
const OGG_EXTENSIONS = new Set(['ogg', 'oga', 'ogv', 'opus', 'spx']);

function asciiAt(dv: DataView, offset: number, length: number): string {
  if (offset + length > dv.byteLength) return '';
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(dv.getUint8(offset + i));
  return out;
}

interface PageHeader {
  headerType: number;
  granule: number; // -1 when no packet completes on the page
  serial: number;
  dataStart: number;
  pageEnd: number;
}

/** Read a 64-bit LE granule; the all-ones value means "no granule". */
function readGranule(dv: DataView, at: number): number {
  const lo = dv.getUint32(at, true);
  const hi = dv.getUint32(at + 4, true);
  if (lo === 0xffffffff && hi === 0xffffffff) return -1;
  return hi * 2 ** 32 + lo;
}

/** Parse the Ogg page header at `at` ('OggS' …), or undefined if it isn't a valid page. */
function parsePage(dv: DataView, at: number): PageHeader | undefined {
  if (asciiAt(dv, at, 4) !== 'OggS' || at + 27 > dv.byteLength) return undefined;
  if (dv.getUint8(at + 4) !== 0) return undefined; // stream structure version must be 0
  const segCount = dv.getUint8(at + 26);
  if (at + 27 + segCount > dv.byteLength) return undefined;
  let dataLen = 0;
  for (let i = 0; i < segCount; i++) dataLen += dv.getUint8(at + 27 + i);
  const dataStart = at + 27 + segCount;
  return {
    headerType: dv.getUint8(at + 5),
    granule: readGranule(dv, at + 6),
    serial: dv.getUint32(at + 14, true),
    dataStart,
    pageEnd: dataStart + dataLen,
  };
}

interface OggStream {
  codec: string;
  mediaType: MediaType;
  channels: number;
  sampleRate: number;
  /** Granule ticks per second (sampleRate for Vorbis/FLAC; 48000 for Opus). */
  granuleRate: number;
  serial: number;
}

/** Identify the first audio stream from its BOS page's identification packet. */
function identifyStream(dv: DataView, page: PageHeader): OggStream | undefined {
  const d = page.dataStart;
  if (dv.getUint8(d) === 0x01 && asciiAt(dv, d + 1, 6) === 'vorbis') {
    const channels = dv.getUint8(d + 11);
    const sampleRate = dv.getUint32(d + 12, true);
    return {
      codec: 'vorbis',
      mediaType: 'audio',
      channels,
      sampleRate,
      granuleRate: sampleRate,
      serial: page.serial,
    };
  }
  if (asciiAt(dv, d, 8) === 'OpusHead') {
    // OpusHead is a fixed, unambiguous layout: magic(8) + version(1) + channel_count(1) + … Opus
    // always decodes at 48 kHz, so the granule clock is 48 kHz regardless of the input rate field.
    return {
      codec: 'opus',
      mediaType: 'audio',
      channels: dv.getUint8(d + 9),
      sampleRate: 48000,
      granuleRate: 48000,
      serial: page.serial,
    };
  }
  // Ogg-FLAC and Theora are added with their fixtures (the corpus only grows, §6.1).
  return undefined;
}

/** Scan a buffer for pages of `serial`, returning the largest valid granule (total samples). */
function maxGranule(dv: DataView, serial: number): number {
  let best = 0;
  let at = 0;
  while (at + 27 <= dv.byteLength) {
    const page = parsePage(dv, at);
    if (!page) {
      at++;
      continue;
    }
    if (page.serial === serial && page.granule > best) best = page.granule;
    at = page.pageEnd > at ? page.pageEnd : at + 1;
  }
  return best;
}

// ============ packet de-lacing + per-packet timing (pure, Node-validated) ============

const MICROS_PER_SECOND = 1_000_000;

/**
 * One de-laced Ogg **packet** of a logical stream: its byte span in the source plus how many segments
 * completed it. `complete` is false only for the final packet when the file is truncated mid-packet
 * (last page's last segment was 255 with no continuation) — those are dropped, not emitted.
 */
interface RawPacket {
  offset: number;
  size: number;
  /** The page granule_position carried on the page where this packet *completed* (-1 ⇒ none). */
  pageGranule: number;
  complete: boolean;
}

/**
 * De-lace every page of `serial` into packets (segment table: a packet is the concat of segments until a
 * segment < 255 ends it; a 255 segment continues — across pages when it is a page's last segment). The
 * packets are returned in stream order; each carries the granule of the page on which it *completed* so
 * callers can anchor PTS to the container's timing. Non-`serial` pages are skipped (multiplexed streams).
 */
function delacePackets(dv: DataView, serial: number): RawPacket[] {
  const packets: RawPacket[] = [];
  // A packet may span pages; we accumulate its [start,end) byte span across continuation pages.
  let pendingStart = -1;
  let pendingSize = 0;
  let at = 0;
  while (at + 27 <= dv.byteLength) {
    const header = asciiAt(dv, at, 4);
    if (header !== 'OggS' || dv.getUint8(at + 4) !== 0) {
      at++;
      continue;
    }
    const segCount = dv.getUint8(at + 26);
    if (at + 27 + segCount > dv.byteLength) break; // truncated header → stop cleanly
    const granule = readGranule(dv, at + 6);
    const pageSerial = dv.getUint32(at + 14, true);
    const body = at + 27 + segCount; // first body byte (after header + segment table)
    let bodyLen = 0;
    for (let i = 0; i < segCount; i++) bodyLen += dv.getUint8(at + 27 + i);
    const pageEnd = body + bodyLen;
    if (pageEnd > dv.byteLength) break; // truncated body → stop cleanly (trailing packet is incomplete)
    if (pageSerial !== serial) {
      at = pageEnd > at ? pageEnd : at + 1; // different logical stream: skip its whole body
      continue;
    }
    // De-lace this page's segment table. A run of segments forms one packet that ends on the first <255.
    // A run carried in from the previous page (HT_CONTINUED) resumes from `pending*`.
    let segOffset = body;
    let runStart = pendingStart >= 0 ? pendingStart : body;
    let runSize = pendingSize;
    pendingStart = -1;
    pendingSize = 0;
    for (let i = 0; i < segCount; i++) {
      const lace = dv.getUint8(at + 27 + i);
      if (runStart < 0) runStart = segOffset;
      runSize += lace;
      segOffset += lace;
      if (lace < 255) {
        packets.push({ offset: runStart, size: runSize, pageGranule: granule, complete: true });
        runStart = -1;
        runSize = 0;
      }
    }
    // A run still open at page end (last lace was 255) continues into the next page (HT_CONTINUED).
    if (runStart >= 0) {
      pendingStart = runStart;
      pendingSize = runSize;
    }
    at = pageEnd > at ? pageEnd : at + 1;
  }
  // A still-open run at EOF is a truncated trailing packet — record it as incomplete so it is dropped.
  if (pendingStart >= 0) {
    packets.push({ offset: pendingStart, size: pendingSize, pageGranule: -1, complete: false });
  }
  return packets;
}

/** Opus TOC frame-size table (config 0..31 → frame duration in 48 kHz samples), RFC 6716 §3.1. */
const OPUS_FRAME_SAMPLES: readonly number[] = [
  // SILK NB/MB/WB: 10,20,40,60 ms ; Hybrid SWB/FB: 10,20 ms ; CELT NB/WB/SWB/FB: 2.5,5,10,20 ms
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 480, 960, 120, 240,
  480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];

/** Decode an Opus packet's output sample count (at 48 kHz) from its TOC byte (RFC 6716 §3.1). */
function opusPacketSamples(dv: DataView, offset: number, size: number): number {
  if (size < 1) return 0;
  const toc = dv.getUint8(offset);
  const frameSamples = OPUS_FRAME_SAMPLES[toc >> 3] ?? 960;
  const code = toc & 0x03; // frame-packing code: 0=1 frame, 1/2=2 frames, 3=arbitrary count (byte 1 &0x3f)
  let frames = 1;
  if (code === 1 || code === 2) frames = 2;
  else if (code === 3) frames = size >= 2 ? dv.getUint8(offset + 1) & 0x3f : 1;
  return frameSamples * (frames > 0 ? frames : 1);
}

/** A framed audio packet ready for the browser block: byte span + presentation/duration in µs. */
export interface OggPacket {
  offset: number;
  size: number;
  ptsUs: number;
  durationUs: number;
}

/**
 * The number of **codec header packets** that precede the audio for each Ogg-mapped codec — these carry
 * setup/metadata (not decodable audio) and must be skipped: Vorbis = 3 (id, comment, setup), Opus = 2
 * (OpusHead, OpusTags), FLAC-in-Ogg = 2 (the FLAC-mapping/STREAMINFO header + the metadata block packet).
 */
function headerPacketCount(codec: string): number {
  if (codec === 'vorbis') return 3;
  return 2; // opus / flac
}

/** The first recognized logical stream in an Ogg buffer, or `undefined` when none is complete. */
function firstRecognizedStream(dv: DataView): OggStream | undefined {
  let at = 0;
  while (at + 27 <= dv.byteLength) {
    const page = parsePage(dv, at);
    if (!page) {
      at++;
      continue;
    }
    if (page.headerType & 0x02) {
      const stream = identifyStream(dv, page);
      if (stream) return stream;
    }
    at = page.pageEnd > at ? page.pageEnd : at + 1;
  }
  return undefined;
}

function packetBytes(data: Uint8Array, packet: RawPacket): Uint8Array {
  return data.slice(packet.offset, packet.offset + packet.size);
}

function xiphLacedHeaders(headers: readonly Uint8Array[]): Uint8Array | undefined {
  if (headers.length !== 3) return undefined;
  const lacing: number[] = [headers.length - 1];
  for (const h of headers.slice(0, -1)) {
    let len = h.byteLength;
    while (len >= 255) {
      lacing.push(255);
      len -= 255;
    }
    lacing.push(len);
  }
  const total = lacing.length + headers.reduce((sum, h) => sum + h.byteLength, 0);
  const out = new Uint8Array(total);
  out.set(lacing, 0);
  let at = lacing.length;
  for (const h of headers) {
    out.set(h, at);
    at += h.byteLength;
  }
  return out;
}

/**
 * Codec-private headers for remuxing Ogg audio through the EncodedChunk seam:
 * Opus keeps its OpusHead (notably `pre_skip`); Vorbis uses Matroska/WebCodecs-style Xiph-laced
 * id/comment/setup packets, which the Ogg muxer can split back into native Ogg headers.
 */
function codecPrivateDescription(data: Uint8Array): Uint8Array | undefined {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stream = firstRecognizedStream(dv);
  if (!stream) return undefined;
  const raw = delacePackets(dv, stream.serial).filter((p) => p.complete);
  if (stream.codec === 'opus') {
    const opusHead = raw[0];
    return opusHead ? packetBytes(data, opusHead) : undefined;
  }
  if (stream.codec === 'vorbis') {
    const headers = raw.slice(0, 3).map((p) => packetBytes(data, p));
    return xiphLacedHeaders(headers);
  }
  return undefined;
}

/**
 * Enumerate the **audio** packets of the first recognized Ogg stream as {@link OggPacket}s (offset/size +
 * PTS/duration in µs). Pure — no WebCodecs — so it is the unit under test. Timing is anchored to the
 * container's page granules:
 *
 * - **Opus** (deterministic): per-packet sample counts come from the TOC byte; the running decode granule
 *   is offset by the stream's `pre_skip` (from OpusHead) so PTS matches the decoder's output clock — the
 *   first audio packet starts at `-pre_skip` (ffprobe reports the same negative t0).
 * - **Vorbis** (approximate, documented): exact per-packet sample counts need the setup-header blocksizes
 *   + per-packet mode flags (a partial Vorbis decode). We instead **even-split** each page's granule delta
 *   across the packets that completed on that page. Packet *count* and *byte size* are exact; per-packet
 *   PTS is an honest approximation whose **sum of durations equals the true total** (granule/rate). This
 *   is called out so no caller mistakes it for sample-exact Vorbis timing. We emit EVERY coded audio
 *   packet, including Vorbis's first ("priming") packet which by spec produces no PCM output but is
 *   required to seed the IMDCT overlap — so the decoder gets a complete stream. (ffprobe lists decoder
 *   *output* packets and therefore omits that priming packet; our container-true count is its + 1.)
 */
export function oggAudioPackets(data: Uint8Array): OggPacket[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stream = firstRecognizedStream(dv);
  if (!stream) throw new InputError('unsupported-input', 'no recognized Ogg codec stream found');

  const preSkip = stream.codec === 'opus' ? readOpusPreSkip(dv, stream.serial) : 0;
  const raw = delacePackets(dv, stream.serial);
  const skip = headerPacketCount(stream.codec);
  // Drop the codec header packets and any truncated trailing packet; keep audio packets in order.
  const audio = raw.slice(skip).filter((p) => p.complete);
  if (audio.length === 0) return [];

  const rate = stream.granuleRate;
  const out: OggPacket[] = [];
  if (stream.codec === 'opus') {
    // Opus: exact per-packet samples from the TOC; PTS = running start granule − pre_skip.
    let startGranule = -preSkip;
    for (const p of audio) {
      const samples = opusPacketSamples(dv, p.offset, p.size);
      out.push({
        offset: p.offset,
        size: p.size,
        ptsUs: Math.round((startGranule / rate) * MICROS_PER_SECOND),
        durationUs: Math.round((samples / rate) * MICROS_PER_SECOND),
      });
      startGranule += samples;
    }
    return out;
  }

  // Vorbis (and FLAC-in-Ogg): even-split each page's granule delta across the packets it completed.
  // `prevGranule` starts at 0 (decode begins at sample 0); each page advances to its granule.
  let prevGranule = 0;
  let i = 0;
  while (i < audio.length) {
    // Group the contiguous run of packets that complete on the same page (share a pageGranule).
    const granule = audio[i]?.pageGranule ?? -1;
    let j = i;
    while (j < audio.length && audio[j]?.pageGranule === granule) j++;
    const count = j - i;
    const pageEndGranule = granule >= 0 ? granule : prevGranule;
    const totalSamples = Math.max(0, pageEndGranule - prevGranule);
    // Even split: every packet on the page gets an equal share of the page's decoded samples.
    for (let k = 0; k < count; k++) {
      const startSamples = prevGranule + Math.round((k / count) * totalSamples);
      const endSamples = prevGranule + Math.round(((k + 1) / count) * totalSamples);
      const p = audio[i + k];
      if (!p) continue;
      out.push({
        offset: p.offset,
        size: p.size,
        ptsUs: Math.round((startSamples / rate) * MICROS_PER_SECOND),
        durationUs: Math.round(((endSamples - startSamples) / rate) * MICROS_PER_SECOND),
      });
    }
    prevGranule = pageEndGranule;
    i = j;
  }
  return out;
}

/** Read the Opus `pre_skip` (16-bit LE at OpusHead+10) from the BOS page of `serial`; 0 if absent. */
function readOpusPreSkip(dv: DataView, serial: number): number {
  let at = 0;
  while (at + 27 <= dv.byteLength) {
    const page = parsePage(dv, at);
    if (!page) {
      at++;
      continue;
    }
    if (page.serial === serial && asciiAt(dv, page.dataStart, 8) === 'OpusHead') {
      return dv.getUint16(page.dataStart + 10, true);
    }
    at = page.pageEnd > at ? page.pageEnd : at + 1;
  }
  return 0;
}

export interface OggInfo {
  codec: string;
  mediaType: MediaType;
  channels: number;
  sampleRate: number;
  durationSec: number;
}

/** Parse Ogg metadata: identify the first stream from `head`, derive duration from `head`+`tail`. */
export function parseOgg(head: Uint8Array, tail?: Uint8Array): OggInfo {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let stream: OggStream | undefined;
  let at = 0;
  while (at + 27 <= dv.byteLength && !stream) {
    const page = parsePage(dv, at);
    if (!page) {
      at++;
      continue;
    }
    if (page.headerType & 0x02) stream = identifyStream(dv, page); // BOS page
    at = page.pageEnd > at ? page.pageEnd : at + 1;
  }
  if (!stream) throw new InputError('unsupported-input', 'no recognized Ogg codec stream found');

  let granule = maxGranule(dv, stream.serial);
  if (tail) {
    const td = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    granule = Math.max(granule, maxGranule(td, stream.serial));
  }
  return {
    codec: stream.codec,
    mediaType: stream.mediaType,
    channels: stream.channels,
    sampleRate: stream.sampleRate,
    durationSec: stream.granuleRate > 0 ? granule / stream.granuleRate : 0,
  };
}

const HEAD_BYTES = 1 << 16;

async function readHead(src: ByteSource): Promise<Uint8Array> {
  if (src.range) return src.range(0, Math.min(HEAD_BYTES, src.size ?? HEAD_BYTES));
  const reader = src.stream().getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  return value ?? new Uint8Array(0);
}

async function readTail(src: ByteSource): Promise<Uint8Array | undefined> {
  if (src.range && src.size !== undefined && src.size > HEAD_BYTES) {
    return src.range(src.size - HEAD_BYTES, src.size);
  }
  return undefined;
}

/** Read the entire source into one buffer — packets() must de-lace the whole file, not just the head. */
async function readAll(src: ByteSource): Promise<Uint8Array> {
  if (src.range && src.size !== undefined) return src.range(0, src.size);
  const reader = src.stream().getReader();
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

/**
 * Map the pure {@link oggAudioPackets} enumeration onto WebCodecs `EncodedAudioChunk`s. Browser-only: the
 * `EncodedAudioChunk` constructor is unavailable in Node, so we raise a typed `CapabilityError` first
 * (mirroring the mpegts driver); the emission body is v8-ignored and validated under browser-mode. Every
 * Ogg audio frame is a sync sample, so `type:'key'`; audio has no reorder, so we emit `{ chunk }` (DTS ==
 * PTS, `dtsUs` omitted per ADR-045).
 */
function packetStream(data: Uint8Array, signal: AbortSignal | undefined): ReadableStream<Packet> {
  if (typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'capability-miss',
      'Ogg packet demux requires the browser codec layer (WebCodecs EncodedAudioChunk)',
      { op: 'demux', tried: ['ogg'] },
    );
  }
  /* v8 ignore start -- requires WebCodecs EncodedAudioChunk; validated under browser-mode (codec phase) */
  const frames = oggAudioPackets(data);
  let i = 0;
  return new ReadableStream<Packet>({
    pull(controller): void {
      if (signal?.aborted) {
        controller.error(new MediaError('aborted', 'operation aborted'));
        return;
      }
      const frame = frames[i];
      if (frame === undefined) {
        controller.close();
        return;
      }
      i++;
      const chunk = new EncodedAudioChunk({
        type: 'key', // every Ogg audio packet is independently a sync sample
        timestamp: frame.ptsUs,
        duration: frame.durationUs,
        data: data.subarray(frame.offset, frame.offset + frame.size),
      });
      controller.enqueue({ chunk });
    },
  });
  /* v8 ignore stop */
}

function matches(q: ContainerQuery): boolean {
  if (q.mime !== undefined && OGG_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && OGG_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  if (head === undefined || head.byteLength < 4) return false;
  return asciiAt(new DataView(head.buffer, head.byteOffset, head.byteLength), 0, 4) === 'OggS';
}

export const OggDriver: ContainerDriver = {
  id: 'ogg',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['ogg'],
  supports: matches,
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    // Probe `info` from head+tail (unchanged: cheap duration via the moov-at-tail granule strategy).
    // packets() de-laces the WHOLE file, so additionally read every byte once for the packet stream.
    const info = parseOgg(await readHead(src), await readTail(src));
    const all = await readAll(src);
    const signal = o?.signal;
    const description = codecPrivateDescription(all);
    const track: TrackInfo = {
      id: 0,
      mediaType: info.mediaType,
      codec: info.codec,
      durationSec: info.durationSec,
      config: {
        codec: info.codec,
        sampleRate: info.sampleRate,
        numberOfChannels: info.channels,
        ...(description !== undefined ? { description } : {}),
      },
    };
    return {
      tracks: [track],
      packets(trackId: number): ReadableStream<Packet> {
        if (trackId !== 0) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStream(all, signal);
      },
      close: () => Promise.resolve(),
    };
  },
  createMuxer(o?: MuxOptions): Muxer {
    // The EncodedChunk-seam adapter over the Ogg page writer ({@link OggMuxer}); the packet→page lacing
    // + granule timing is pure + Node-validated, only the per-chunk `copyTo` is browser-only (ogg-write.ts).
    return new OggMuxer(o);
  },
};

export const OggModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(OggDriver);
  },
};

export default OggModule;
