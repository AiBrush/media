/**
 * The Ogg container driver — hand-written TS. An Ogg file is a sequence of **pages** (little-endian);
 * each logical stream opens with a BOS page whose first packet is the codec identification header
 * (Vorbis, Opus, and FLAC now; Theora joins with its fixtures, §6.1). Probe reads the head (for the ID
 * header) and the tail (for the last page's `granule_position` → duration), mirroring the moov-at-tail
 * strategy (docs/architecture/09).
 */

import {
  type ByteSource,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type MediaType,
  type MuxOptions,
  type Muxer,
  type Packet,
  type PacketInfoMetadata,
  type PacketInfoTable,
  type PacketMetadata,
  type Registry,
  type StageOptions,
  type StreamCopyOptions,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import { matchesOgg } from '../audio-container-sniff.ts';
import { type ChunkStruct, OggMuxer, trackStateFrom, writeOgg } from './ogg-write.ts';

function asciiAt(dv: DataView, offset: number, length: number): string {
  if (offset + length > dv.byteLength) return '';
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(dv.getUint8(offset + i));
  return out;
}

function concatBytes(parts: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
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
  if (dataStart + dataLen > dv.byteLength) return undefined;
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
  if (d + 30 <= page.pageEnd && dv.getUint8(d) === 0x01 && asciiAt(dv, d + 1, 6) === 'vorbis') {
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
  if (d + 19 <= page.pageEnd && asciiAt(dv, d, 8) === 'OpusHead') {
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
  if (
    d + 51 <= page.pageEnd &&
    dv.getUint8(d) === 0x7f &&
    asciiAt(dv, d + 1, 4) === 'FLAC' &&
    asciiAt(dv, d + 9, 4) === 'fLaC'
  ) {
    const streamInfoHeader = d + 13;
    const body = streamInfoHeader + 4;
    const blockType = dv.getUint8(streamInfoHeader) & 0x7f;
    const blockLength =
      (dv.getUint8(streamInfoHeader + 1) << 16) |
      (dv.getUint8(streamInfoHeader + 2) << 8) |
      dv.getUint8(streamInfoHeader + 3);
    if (blockType !== 0 || blockLength < 34 || body + 34 > page.pageEnd) return undefined;
    const hi = dv.getUint32(body + 10);
    const sampleRate = hi >>> 12;
    if (sampleRate === 0) return undefined;
    return {
      codec: 'flac',
      mediaType: 'audio',
      channels: ((hi >>> 9) & 0x7) + 1,
      sampleRate,
      granuleRate: sampleRate,
      serial: page.serial,
    };
  }
  // Theora is added with its fixtures (the corpus only grows, §6.1).
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

/** The granule carried by the logical stream's terminal EOS page, if that page is complete and timed. */
function eosGranule(dv: DataView, serial: number): number | undefined {
  let terminal: number | undefined;
  let at = 0;
  while (at + 27 <= dv.byteLength) {
    const page = parsePage(dv, at);
    if (!page) {
      at++;
      continue;
    }
    if (page.serial === serial && (page.headerType & 0x04) !== 0 && page.granule >= 0) {
      terminal = page.granule;
    }
    at = page.pageEnd > at ? page.pageEnd : at + 1;
  }
  return terminal;
}

// ============ packet de-lacing + per-packet timing (pure, Node-validated) ============

const MICROS_PER_SECOND = 1_000_000;
const OPUS_GRANULE_RATE = 48_000;
const MAX_OPUS_PRE_SKIP_FRAMES = 0xffff;

/** One contiguous payload span inside an Ogg page body (never includes page headers or lacing bytes). */
export interface OggPacketSpan {
  readonly offset: number;
  readonly size: number;
}

/**
 * One de-laced Ogg **packet** of a logical stream. A packet that continues onto another page owns multiple
 * ordered payload spans because intervening page headers/lacing bytes are not part of its coded payload.
 * `complete` is false only for the final packet when the file is truncated mid-packet (last page's last
 * segment was 255 with no continuation) — those are dropped, not emitted.
 */
interface RawPacket {
  readonly spans: readonly OggPacketSpan[];
  readonly size: number;
  /** The page granule_position carried on the page where this packet *completed* (-1 ⇒ none). */
  pageGranule: number;
  /** Byte offset and flags identify the exact completion page even when adjacent granules are equal. */
  completionPageOffset: number;
  completionPageHeaderType: number;
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
  // A packet may span pages; retain only the actual page-body spans, never intervening page structures.
  let pendingSpans: OggPacketSpan[] = [];
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
    const headerType = dv.getUint8(at + 5);
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
    // A run carried in from the previous page (HT_CONTINUED) resumes from `pendingSpans`.
    let segOffset = body;
    let runSpans = pendingSpans;
    let runSize = pendingSize;
    pendingSpans = [];
    pendingSize = 0;
    for (let i = 0; i < segCount; i++) {
      const lace = dv.getUint8(at + 27 + i);
      if (lace > 0) appendPacketSpan(runSpans, segOffset, lace);
      runSize += lace;
      segOffset += lace;
      if (lace < 255) {
        packets.push({
          spans: runSpans,
          size: runSize,
          pageGranule: granule,
          completionPageOffset: at,
          completionPageHeaderType: headerType,
          complete: true,
        });
        runSpans = [];
        runSize = 0;
      }
    }
    // A run still open at page end (last lace was 255) continues into the next page (HT_CONTINUED).
    if (runSpans.length > 0) {
      pendingSpans = runSpans;
      pendingSize = runSize;
    }
    at = pageEnd > at ? pageEnd : at + 1;
  }
  // A still-open run at EOF is a truncated trailing packet — record it as incomplete so it is dropped.
  if (pendingSpans.length > 0) {
    packets.push({
      spans: pendingSpans,
      size: pendingSize,
      pageGranule: -1,
      completionPageOffset: -1,
      completionPageHeaderType: 0,
      complete: false,
    });
  }
  return packets;
}

/** Coalesce adjacent laces in one page body while preserving page-boundary discontinuities. */
function appendPacketSpan(spans: OggPacketSpan[], offset: number, size: number): void {
  const prior = spans[spans.length - 1];
  if (prior !== undefined && prior.offset + prior.size === offset) {
    spans[spans.length - 1] = { offset: prior.offset, size: prior.size + size };
    return;
  }
  spans.push({ offset, size });
}

/** Opus TOC frame-size table (config 0..31 → frame duration in 48 kHz samples), RFC 6716 §3.1. */
const OPUS_FRAME_SAMPLES: readonly number[] = [
  // SILK NB/MB/WB: 10,20,40,60 ms ; Hybrid SWB/FB: 10,20 ms ; CELT NB/WB/SWB/FB: 2.5,5,10,20 ms
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 480, 960, 120, 240,
  480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];

/** Read one payload byte by packet-relative index without assembling a continued packet. */
function packetByte(dv: DataView, packet: RawPacket, index: number): number | undefined {
  if (index < 0 || index >= packet.size) return undefined;
  let remaining = index;
  for (const span of packet.spans) {
    if (remaining < span.size) return dv.getUint8(span.offset + remaining);
    remaining -= span.size;
  }
  return undefined;
}

function packetAscii(dv: DataView, packet: RawPacket, offset: number, length: number): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    const byte = packetByte(dv, packet, offset + index);
    if (byte === undefined) return '';
    out += String.fromCharCode(byte);
  }
  return out;
}

/** Decode an Opus packet's output sample count (at 48 kHz) from its TOC byte (RFC 6716 §3.1). */
function opusPacketSamples(dv: DataView, packet: RawPacket): number {
  if (packet.size < 1) return 0;
  const toc = packetByte(dv, packet, 0) ?? 0;
  const frameSamples = OPUS_FRAME_SAMPLES[toc >> 3] ?? 960;
  const code = toc & 0x03; // frame-packing code: 0=1 frame, 1/2=2 frames, 3=arbitrary count (byte 1 &0x3f)
  let frames = 1;
  if (code === 1 || code === 2) frames = 2;
  else if (code === 3) frames = packet.size >= 2 ? (packetByte(dv, packet, 1) ?? 1) & 0x3f : 1;
  return frameSamples * (frames > 0 ? frames : 1);
}

/** Strict Opus packet duration for exact granule authoring (RFC 6716 §3.1). */
function exactOpusPacketSamples(data: Uint8Array): number | undefined {
  const toc = data[0];
  if (toc === undefined) return undefined;
  const frameSamples = OPUS_FRAME_SAMPLES[toc >> 3];
  if (frameSamples === undefined) return undefined;
  const code = toc & 0x03;
  const frames =
    code === 0 ? 1 : code === 1 || code === 2 ? 2 : data[1] === undefined ? 0 : data[1] & 0x3f;
  const samples = frameSamples * frames;
  return frames > 0 && samples <= 5_760 ? samples : undefined;
}

/**
 * Absolute Ogg granules may start above the coded packet clock (RFC 7845 §4.5). Recover that
 * offset from the first audio page so both packet PTS and the EOS trim use the same coded-sample
 * coordinate. A single-page EOS stream may instead end before its decoded packet boundary; that is
 * terminal trimming, not a negative origin.
 */
function opusInitialGranuleOffset(
  data: Uint8Array,
  audio: readonly RawPacket[],
): number | undefined {
  const first = audio[0];
  if (first === undefined || first.pageGranule < 0 || first.completionPageOffset < 0) {
    return undefined;
  }
  let samplesThroughFirstPage = 0;
  for (const packet of audio) {
    if (packet.completionPageOffset !== first.completionPageOffset) break;
    const samples = exactOpusPacketSamples(oggPacketBytes(data, packet));
    if (samples === undefined) return undefined;
    samplesThroughFirstPage += samples;
  }
  const offset = first.pageGranule - samplesThroughFirstPage;
  if (offset >= 0) return offset;
  // In a one-audio-page stream the first completion page is also EOS, whose granule may trim inside
  // its final packet. That is terminal padding, not a negative initial offset. Before EOS, G1 < S1 is
  // inconsistent and must not be silently normalized.
  return (first.completionPageHeaderType & 0x04) !== 0 ? 0 : undefined;
}

/** A framed audio packet ready for the browser block: payload spans + presentation/duration in µs. */
export interface OggPacket {
  /** Present only when the complete payload is one contiguous source range. */
  readonly offset?: number;
  readonly spans: readonly OggPacketSpan[];
  readonly size: number;
  readonly ptsUs: number;
  readonly durationUs: number;
}

/** Ogg's packet-info row retains payload spans privately needed by its live demux stream. */
export interface OggPacketInfoMetadata extends PacketInfoMetadata {
  readonly spans: readonly OggPacketSpan[];
}

export interface OggPacketInfoTable extends Omit<PacketInfoTable, 'packets'> {
  readonly packets: readonly OggPacketInfoMetadata[];
}

/**
 * The number of **codec header packets** that precede the audio for each Ogg-mapped codec — these carry
 * setup/metadata (not decodable audio) and must be skipped.
 */
function headerPacketCount(codec: string, dv: DataView, raw: readonly RawPacket[]): number {
  if (codec === 'vorbis') return 3;
  if (codec === 'flac') {
    const first = raw[0];
    if (
      first &&
      first.size >= 9 &&
      packetByte(dv, first, 0) === 0x7f &&
      packetAscii(dv, first, 1, 4) === 'FLAC'
    ) {
      return 1 + (((packetByte(dv, first, 7) ?? 0) << 8) | (packetByte(dv, first, 8) ?? 0));
    }
  }
  return 2; // opus, or a malformed FLAC stream that identifyStream should already have rejected.
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

function contiguousPacketOffset(packet: {
  readonly spans: readonly OggPacketSpan[];
  readonly size: number;
}): number | undefined {
  const span = packet.spans[0];
  return packet.spans.length === 1 && span?.size === packet.size ? span.offset : undefined;
}

/** Return one exact coded payload; continued packets are assembled without page headers/lacing bytes. */
export function oggPacketBytes(
  data: Uint8Array,
  packet: { readonly spans: readonly OggPacketSpan[]; readonly size: number },
): Uint8Array {
  const offset = contiguousPacketOffset(packet);
  if (offset !== undefined) {
    const end = offset + packet.size;
    if (offset < 0 || packet.size < 0 || end > data.byteLength) {
      throw new MediaError('demux-error', 'Ogg packet payload span is out of bounds');
    }
    return data.subarray(offset, end);
  }
  const out = new Uint8Array(packet.size);
  let written = 0;
  for (const span of packet.spans) {
    const end = span.offset + span.size;
    if (
      span.offset < 0 ||
      span.size < 0 ||
      end > data.byteLength ||
      written + span.size > out.byteLength
    ) {
      throw new MediaError('demux-error', 'Ogg packet payload span is out of bounds');
    }
    out.set(data.subarray(span.offset, end), written);
    written += span.size;
  }
  if (written !== packet.size) {
    throw new MediaError('demux-error', 'Ogg packet payload spans do not match its declared size');
  }
  return out;
}

function ownedPacketBytes(data: Uint8Array, packet: RawPacket): Uint8Array {
  return oggPacketBytes(data, packet).slice();
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
    return opusHead ? ownedPacketBytes(data, opusHead) : undefined;
  }
  if (stream.codec === 'vorbis') {
    const headers = raw.slice(0, 3).map((p) => ownedPacketBytes(data, p));
    return xiphLacedHeaders(headers);
  }
  if (stream.codec === 'flac') {
    const first = raw[0];
    if (!first) return undefined;
    const firstBytes = ownedPacketBytes(data, first);
    if (
      firstBytes.byteLength < 13 ||
      firstBytes[0] !== 0x7f ||
      String.fromCharCode(...firstBytes.slice(1, 5)) !== 'FLAC' ||
      String.fromCharCode(...firstBytes.slice(9, 13)) !== 'fLaC'
    ) {
      return undefined;
    }
    const headerPackets = ((firstBytes[7] ?? 0) << 8) | (firstBytes[8] ?? 0);
    const metadata: Uint8Array<ArrayBufferLike>[] = [firstBytes.slice(9)];
    for (const packet of raw.slice(1, 1 + headerPackets))
      metadata.push(ownedPacketBytes(data, packet));
    return concatBytes(metadata);
  }
  return undefined;
}

/**
 * Enumerate the **audio** packets of the first recognized Ogg stream as {@link OggPacket}s (ordered
 * payload spans/size + PTS/duration in µs). Pure — no WebCodecs — so it is the unit under test. Timing is anchored to the
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
  if (!stream) throw new InputError('no recognized Ogg codec stream found');

  const preSkip = stream.codec === 'opus' ? readOpusPreSkip(dv, stream.serial) : 0;
  const raw = delacePackets(dv, stream.serial);
  const skip = headerPacketCount(stream.codec, dv, raw);
  // Drop the codec header packets and any truncated trailing packet; keep audio packets in order.
  const audio = raw.slice(skip).filter((p) => p.complete);
  if (audio.length === 0) return [];

  const rate = stream.granuleRate;
  const out: OggPacket[] = [];
  if (stream.codec === 'opus') {
    // Opus: exact per-packet samples from the TOC. An allowed positive initial granule offset rebases
    // the coded packet clock (cropped/joined streams); pre-skip still selects the first valid sample.
    let startGranule = (opusInitialGranuleOffset(data, audio) ?? 0) - preSkip;
    for (const p of audio) {
      const samples = opusPacketSamples(dv, p);
      out.push({
        ...oggPacketLocation(p),
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
        ...oggPacketLocation(p),
        ptsUs: Math.round((startSamples / rate) * MICROS_PER_SECOND),
        durationUs: Math.round(((endSamples - startSamples) / rate) * MICROS_PER_SECOND),
      });
    }
    prevGranule = pageEndGranule;
    i = j;
  }
  return out;
}

function oggPacketLocation(packet: RawPacket): Pick<OggPacket, 'offset' | 'spans' | 'size'> {
  const offset = contiguousPacketOffset(packet);
  return {
    spans: packet.spans,
    size: packet.size,
    ...(offset === undefined ? {} : { offset }),
  };
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
    if (
      page.serial === serial &&
      page.dataStart + 12 <= page.pageEnd &&
      asciiAt(dv, page.dataStart, 8) === 'OpusHead'
    ) {
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

/**
 * Recover the exact Ogg Opus program window from OpusHead, packet TOCs, and the EOS granule (RFC 7845):
 * coded = sum(packet durations), leading = pre-skip, and presented end = final granule minus the allowed
 * initial granule offset. The tuple remains container-true; the decode pipeline separately measures whether
 * its selected decoder already consumed the OpusHead pre-skip before applying it again.
 */
export function oggOpusGapless(data: Uint8Array): NonNullable<TrackInfo['gapless']> | undefined {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stream = firstRecognizedStream(dv);
  if (stream?.codec !== 'opus') return undefined;
  const raw = delacePackets(dv, stream.serial);
  const audio = raw
    .slice(headerPacketCount(stream.codec, dv, raw))
    .filter((packet) => packet.complete);
  if (audio.length === 0) return undefined;

  let codedSamples = 0;
  for (const packet of audio) {
    const samples = exactOpusPacketSamples(oggPacketBytes(data, packet));
    if (samples === undefined || !Number.isSafeInteger(codedSamples + samples)) return undefined;
    codedSamples += samples;
  }
  const leadingSamples = readOpusPreSkip(dv, stream.serial);
  const finalGranule = eosGranule(dv, stream.serial);
  const initialGranuleOffset = opusInitialGranuleOffset(data, audio);
  if (
    finalGranule === undefined ||
    initialGranuleOffset === undefined ||
    !Number.isSafeInteger(finalGranule) ||
    !Number.isSafeInteger(finalGranule - initialGranuleOffset)
  ) {
    return undefined;
  }
  const presentedEndSamples = finalGranule - initialGranuleOffset;
  if (presentedEndSamples < leadingSamples || presentedEndSamples > codedSamples) return undefined;
  return {
    basis: 'ogg-opus-granule',
    leadingSamples,
    trailingSamples: codedSamples - presentedEndSamples,
    totalSamples: presentedEndSamples - leadingSamples,
  };
}

function trackFromInfo(
  info: OggInfo,
  description?: Uint8Array,
  gapless?: TrackInfo['gapless'],
): TrackInfo {
  const durationSec =
    gapless?.basis === 'ogg-opus-granule' &&
    gapless.totalSamples !== undefined &&
    Number.isSafeInteger(gapless.totalSamples) &&
    gapless.totalSamples >= 0
      ? gapless.totalSamples / OPUS_GRANULE_RATE
      : info.durationSec;
  return {
    id: 0,
    mediaType: info.mediaType,
    codec: info.codec,
    durationSec,
    config: {
      codec: info.codec,
      sampleRate: info.sampleRate,
      numberOfChannels: info.channels,
      ...(description !== undefined ? { description } : {}),
    },
    ...(gapless !== undefined ? { gapless } : {}),
  };
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
  if (!stream) throw new InputError('no recognized Ogg codec stream found');

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

export function oggPacketInfoTable(data: Uint8Array): OggPacketInfoTable {
  const info = parseOgg(data);
  const packets: OggPacketInfoMetadata[] = oggAudioPackets(data).map((packet) => {
    const { offset } = packet;
    return {
      trackIndex: 0,
      spans: packet.spans,
      ...(offset === undefined ? {} : { offset }),
      size: packet.size,
      ptsUs: packet.ptsUs,
      dtsUs: packet.ptsUs,
      durationUs: packet.durationUs,
      keyframe: true,
    };
  });
  return {
    tracks: [trackFromInfo(info, codecPrivateDescription(data), oggOpusGapless(data))],
    packets,
  };
}

export function oggPacketInfoFromBytes(bytes: Uint8Array): OggPacketInfoTable {
  return oggPacketInfoTable(bytes);
}

function oggPacketMetadata(table: PacketInfoTable): readonly PacketMetadata[] {
  return table.packets.map((packet) => {
    const track = table.tracks[packet.trackIndex];
    if (track === undefined) {
      throw new MediaError(
        'demux-error',
        `Ogg packet references missing track index ${packet.trackIndex}`,
      );
    }
    if (packet.durationUs === undefined) {
      throw new MediaError('demux-error', 'Ogg packet is missing duration metadata');
    }
    return {
      trackId: track.id,
      sizeBytes: packet.size,
      ptsUs: packet.ptsUs,
      dtsUs: packet.dtsUs,
      durationUs: packet.durationUs,
      keyframe: packet.keyframe,
    };
  });
}

function validateOggStreamCopyTarget(container: string | undefined): void {
  if (
    container === undefined ||
    container === 'ogg' ||
    container === 'webm' ||
    container === 'mkv'
  ) {
    return;
  }
  throw new CapabilityError(`Ogg stream-copy cannot write '${container}'`, {
    op: { kind: 'route', id: 'streamCopy', facts: { container } },
    tried: ['ogg'],
  });
}

interface OggTrimPacketSelection {
  readonly firstIndex: number;
  readonly lastIndex: number;
  readonly firstPtsUs: number;
  readonly endUs: number;
}

function selectOggTrimPackets(
  packets: readonly OggPacketInfoMetadata[],
  startUs: number,
  endUs: number,
  signal: AbortSignal | undefined,
): OggTrimPacketSelection {
  let firstIndex = -1;
  let lastIndex = -1;
  let firstPtsUs = 0;
  let selectedEndUs = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < packets.length; index++) {
    if (signal?.aborted) throw abortedOggRead();
    const packet = packets[index];
    if (packet === undefined) continue;
    const durationUs = packet.durationUs;
    if (durationUs === undefined) {
      throw new MediaError('demux-error', 'Ogg packet table is missing duration facts');
    }
    const packetStartUs = Math.round(packet.ptsUs);
    const packetDurationUs = Math.round(durationUs);
    const packetEndUs = packetStartUs + packetDurationUs;
    if (packetEndUs <= startUs || packetStartUs >= endUs) continue;
    if (firstIndex < 0) {
      firstIndex = index;
      firstPtsUs = packetStartUs;
    }
    lastIndex = index;
    selectedEndUs = Math.max(selectedEndUs, packetEndUs);
  }
  if (firstIndex < 0 || lastIndex < firstIndex || !Number.isFinite(selectedEndUs)) {
    throw new MediaError('mux-error', 'Ogg remux selected no audio packets');
  }
  return { firstIndex, lastIndex, firstPtsUs, endUs: selectedEndUs };
}

function opusHeadDescription(track: TrackInfo): Uint8Array | undefined {
  const config = track.config;
  if (track.codec !== 'opus' || config === undefined || !('sampleRate' in config)) return undefined;
  const source = config.description;
  if (source === undefined) return undefined;
  const description = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
    : new Uint8Array(source).slice();
  if (
    description.byteLength < 12 ||
    asciiAt(new DataView(description.buffer), 0, 8) !== 'OpusHead'
  ) {
    return undefined;
  }
  return description;
}

function opusTrackWithPreSkip(track: TrackInfo, preSkipFrames: number): TrackInfo | undefined {
  if (
    !Number.isSafeInteger(preSkipFrames) ||
    preSkipFrames < 0 ||
    preSkipFrames > MAX_OPUS_PRE_SKIP_FRAMES
  ) {
    return undefined;
  }
  const config = track.config;
  const description = opusHeadDescription(track);
  if (config === undefined || description === undefined) return undefined;
  new DataView(description.buffer).setUint16(10, preSkipFrames, true);
  const output: TrackInfo = { ...track, config: { ...config, description } };
  Reflect.deleteProperty(output, 'codecDelayNs');
  Reflect.deleteProperty(output, 'gapless');
  return output;
}

interface OggOpusWebmTrimSelection {
  readonly firstIndex: number;
  readonly lastIndex: number;
  readonly preSkipFrames: number;
  readonly totalSamples: number;
  readonly trailingSamples: number;
  readonly selectedPacketSamples: readonly number[];
  readonly outputTrack: TrackInfo;
}

/** Select an exact Ogg Opus program interval and translate it to Matroska P/Q/T coordinates. */
function selectOggOpusWebmTrim(
  bytes: Uint8Array,
  table: OggPacketInfoTable,
  track: TrackInfo,
  trim: NonNullable<StreamCopyOptions['trim']>,
  signal: AbortSignal | undefined,
): OggOpusWebmTrimSelection {
  const description = opusHeadDescription(track);
  if (description === undefined) {
    throw new MediaError('demux-error', 'Ogg Opus remux trim needs a complete OpusHead packet');
  }
  const sourcePreSkip = new DataView(
    description.buffer,
    description.byteOffset,
    description.byteLength,
  ).getUint16(10, true);
  const startFrame = Math.round(trim.startSec * OPUS_GRANULE_RATE);
  const endFrame = Math.round(trim.endSec * OPUS_GRANULE_RATE);
  const totalSamples = endFrame - startFrame;
  if (totalSamples <= 0) {
    throw oggOpusTrimCapability(
      'Ogg Opus cannot represent the requested trim as a positive 48 kHz sample interval',
    );
  }

  const packetSamples: number[] = [];
  const codedStarts: number[] = [];
  let codedFrames = 0;
  let firstIndex = -1;
  let lastIndex = -1;
  for (let index = 0; index < table.packets.length; index++) {
    if (signal?.aborted) throw abortedOggRead();
    const packet = table.packets[index];
    if (packet === undefined) continue;
    const samples = exactOpusPacketSamples(oggPacketBytes(bytes, packet));
    if (samples === undefined) {
      throw new MediaError('demux-error', 'Ogg Opus remux trim found an invalid packet duration');
    }
    codedStarts.push(codedFrames);
    packetSamples.push(samples);
    const presentationStart = codedFrames - sourcePreSkip;
    const presentationEnd = presentationStart + samples;
    if (presentationEnd > startFrame && presentationStart < endFrame) {
      if (firstIndex < 0) firstIndex = index;
      lastIndex = index;
    }
    codedFrames += samples;
  }
  if (firstIndex < 0 || lastIndex < firstIndex) {
    throw new MediaError('mux-error', 'Ogg Opus remux trim selected no audio packets');
  }

  const selectedCodedStart = codedStarts[firstIndex];
  if (selectedCodedStart === undefined) {
    throw new MediaError('demux-error', 'Ogg Opus remux trim lost its coded start coordinate');
  }
  const preSkipFrames = startFrame - (selectedCodedStart - sourcePreSkip);
  const selectedPacketSamples = packetSamples.slice(firstIndex, lastIndex + 1);
  const selectedCodedFrames = selectedPacketSamples.reduce((sum, samples) => sum + samples, 0);
  const trailingSamples = selectedCodedFrames - preSkipFrames - totalSamples;
  const finalPacketSamples = selectedPacketSamples.at(-1) ?? 0;
  if (
    !Number.isSafeInteger(preSkipFrames) ||
    preSkipFrames < 0 ||
    preSkipFrames > MAX_OPUS_PRE_SKIP_FRAMES ||
    !Number.isSafeInteger(trailingSamples) ||
    trailingSamples < 0 ||
    trailingSamples >= finalPacketSamples
  ) {
    throw oggOpusTrimCapability(
      'Ogg Opus cannot express the requested trim through Matroska CodecDelay/DiscardPadding',
    );
  }
  const rewritten = opusTrackWithPreSkip(track, preSkipFrames);
  if (rewritten === undefined) {
    throw new MediaError('demux-error', 'Ogg Opus remux trim could not rewrite OpusHead pre-skip');
  }
  return {
    firstIndex,
    lastIndex,
    preSkipFrames,
    totalSamples,
    trailingSamples,
    selectedPacketSamples,
    outputTrack: {
      ...rewritten,
      durationSec: totalSamples / OPUS_GRANULE_RATE,
      gapless: {
        basis: 'webm-opus-codec-delay',
        leadingSamples: preSkipFrames,
        trailingSamples,
        totalSamples,
      },
    },
  };
}

async function writeOggWebmPacketCopy(
  bytes: Uint8Array,
  container: 'webm' | 'mkv',
  trim: StreamCopyOptions['trim'],
  signal: AbortSignal | undefined,
): Promise<ReadableStream<Uint8Array>> {
  const table = oggPacketInfoTable(bytes);
  const track = table.tracks[0];
  if (track === undefined || track.mediaType !== 'audio') {
    throw new CapabilityError('Ogg remux needs one audio track', {
      op: { kind: 'route', id: 'remux' },
      tried: ['ogg', container],
    });
  }
  if (container === 'webm' && track.codec.toLowerCase().startsWith('flac')) {
    throw new CapabilityError('WebM does not support FLAC audio', {
      op: { kind: 'route', id: 'remux' },
      tried: ['ogg', 'webm'],
    });
  }
  if (trim !== undefined) validateOggTrimRange(track.durationSec, trim);
  const opusSelection =
    trim !== undefined && track.codec.toLowerCase() === 'opus'
      ? selectOggOpusWebmTrim(bytes, table, track, trim, signal)
      : undefined;
  const startUs = trim === undefined ? undefined : Math.round(trim.startSec * MICROS_PER_SECOND);
  const endUs = trim === undefined ? undefined : Math.round(trim.endSec * MICROS_PER_SECOND);
  const selection =
    opusSelection === undefined && startUs !== undefined && endUs !== undefined
      ? selectOggTrimPackets(table.packets, startUs, endUs, signal)
      : undefined;
  const { WebmMuxer } = await import('../webm/ebml-write.ts');
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
  const outputTrack =
    opusSelection?.outputTrack ??
    (selection === undefined
      ? track
      : {
          ...track,
          durationSec: (selection.endUs - selection.firstPtsUs) / MICROS_PER_SECOND,
        });
  const muxer = new WebmMuxer({ container }, container === 'mkv' ? 'matroska' : 'webm');
  const trackId = muxer.addTrack(outputTrack);
  let selected = 0;
  const firstIndex = opusSelection?.firstIndex ?? selection?.firstIndex ?? 0;
  const lastIndex = opusSelection?.lastIndex ?? selection?.lastIndex ?? table.packets.length - 1;
  let selectedCodedFrames = 0;
  for (let index = firstIndex; index <= lastIndex; index++) {
    if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    const packet = table.packets[index];
    if (packet === undefined) continue;
    const durationUs = packet.durationUs;
    if (durationUs === undefined) {
      throw new MediaError('demux-error', 'Ogg packet table is missing duration facts');
    }
    const packetStartUs = Math.round(packet.ptsUs);
    const packetDurationUs = Math.round(durationUs);
    const opusPacketSamples = opusSelection?.selectedPacketSamples[index - firstIndex];
    const timestampUs =
      opusSelection !== undefined
        ? Math.round(
            ((selectedCodedFrames - opusSelection.preSkipFrames) * MICROS_PER_SECOND) /
              OPUS_GRANULE_RATE,
          )
        : selection === undefined
          ? packetStartUs
          : Math.max(0, packetStartUs - selection.firstPtsUs);
    muxer.addChunkStruct(trackId, {
      timestampUs,
      durationUs:
        opusPacketSamples === undefined
          ? packetDurationUs
          : Math.round((opusPacketSamples * MICROS_PER_SECOND) / OPUS_GRANULE_RATE),
      key: packet.keyframe,
      data: oggPacketBytes(bytes, packet),
    });
    selectedCodedFrames += opusPacketSamples ?? 0;
    selected++;
  }
  if (selected === 0) throw new MediaError('mux-error', 'Ogg remux selected no audio packets');
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
  await muxer.finalize();
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
  return muxer.output;
}

function validateOggTrimRange(
  durationSec: number | undefined,
  trim: NonNullable<StreamCopyOptions['trim']>,
): void {
  if (!Number.isFinite(trim.startSec) || !Number.isFinite(trim.endSec)) {
    throw new InputError('bad trim');
  }
  if (durationSec === undefined || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new MediaError('demux-error', 'Ogg trim needs a finite source duration');
  }
  if (trim.startSec < 0) throw new InputError('trim start < 0');
  if (trim.endSec <= trim.startSec) {
    throw new InputError(trim.endSec === trim.startSec ? 'empty trim range' : 'bad trim range');
  }
  if (trim.startSec >= durationSec) {
    throw new InputError('trim start >= duration');
  }
  if (trim.endSec > durationSec) {
    throw new InputError('trim end > duration');
  }
}

interface ExactOggOpusPacket {
  readonly packet: OggPacketInfoMetadata;
  readonly data: Uint8Array;
  readonly samples: number;
  readonly codedStartFrame: number;
  readonly presentationStartFrame: number;
}

function oggOpusTrimCapability(message: string): CapabilityError {
  return new CapabilityError(message, {
    op: {
      kind: 'route',
      id: 'trim',
      facts: { container: 'ogg', codec: 'opus', mode: 'packet-copy' },
    },
    tried: ['ogg', 'opus-pre-skip'],
  });
}

/**
 * Author an exact decoded Opus presentation interval without changing coded packets.
 *
 * Ogg exposes two sample-accurate controls: OpusHead pre-skip trims the beginning and the EOS
 * granule trims the end. Retain the earliest packet history whose start remains representable by
 * the unsigned 16-bit pre-skip field, then express the requested half-open interval through those
 * two controls. This also gives the decoder substantially more state than selecting only the packet
 * that overlaps the requested start.
 */
function writeExactOggOpusPacketCopyTrim(
  bytes: Uint8Array,
  table: OggPacketInfoTable,
  track: TrackInfo,
  trim: NonNullable<StreamCopyOptions['trim']>,
): Uint8Array {
  const description = opusHeadDescription(track);
  if (description === undefined || description.byteLength < 19) {
    throw new MediaError('demux-error', 'Ogg Opus trim needs a complete OpusHead packet');
  }
  const sourcePreSkipFrames = new DataView(
    description.buffer,
    description.byteOffset,
    description.byteLength,
  ).getUint16(10, true);

  const packets: ExactOggOpusPacket[] = [];
  let codedFrames = 0;
  for (const packet of table.packets) {
    const data = oggPacketBytes(bytes, packet);
    const samples = exactOpusPacketSamples(data);
    if (samples === undefined) {
      throw new MediaError(
        'demux-error',
        'Ogg Opus trim encountered a packet with an invalid coded duration',
      );
    }
    packets.push({
      packet,
      data,
      samples,
      codedStartFrame: codedFrames,
      presentationStartFrame: codedFrames - sourcePreSkipFrames,
    });
    codedFrames += samples;
    if (!Number.isSafeInteger(codedFrames)) {
      throw new MediaError('demux-error', 'Ogg Opus coded duration exceeds safe integer range');
    }
  }
  if (packets.length === 0) {
    throw new MediaError('mux-error', 'Ogg Opus trim selected no audio packets');
  }

  const sourcePresentationFrames =
    track.gapless?.basis === 'ogg-opus-granule' ? track.gapless.totalSamples : undefined;
  if (
    sourcePresentationFrames === undefined ||
    !Number.isSafeInteger(sourcePresentationFrames) ||
    sourcePresentationFrames <= 0 ||
    sourcePreSkipFrames + sourcePresentationFrames > codedFrames
  ) {
    throw new MediaError(
      'demux-error',
      'Ogg Opus source presentation window is inconsistent with its packets',
    );
  }

  const requestedStartFrame = Math.round(trim.startSec * OPUS_GRANULE_RATE);
  const requestedEndFrame = Math.round(trim.endSec * OPUS_GRANULE_RATE);
  if (
    !Number.isSafeInteger(requestedStartFrame) ||
    !Number.isSafeInteger(requestedEndFrame) ||
    requestedEndFrame <= requestedStartFrame
  ) {
    throw oggOpusTrimCapability(
      'Ogg Opus cannot represent the requested trim as a positive 48 kHz sample interval',
    );
  }
  if (requestedEndFrame > sourcePresentationFrames) {
    throw oggOpusTrimCapability(
      'Ogg Opus cannot author a trim beyond the source presentation granule',
    );
  }

  let firstIndex = -1;
  let outputPreSkipFrames = -1;
  for (let index = 0; index < packets.length; index++) {
    const packet = packets[index];
    if (packet === undefined || packet.presentationStartFrame > requestedStartFrame) break;
    const candidatePreSkip = requestedStartFrame - packet.presentationStartFrame;
    if (candidatePreSkip <= MAX_OPUS_PRE_SKIP_FRAMES) {
      firstIndex = index;
      outputPreSkipFrames = candidatePreSkip;
      break;
    }
  }
  if (firstIndex < 0 || outputPreSkipFrames < 0) {
    throw oggOpusTrimCapability(
      'Ogg Opus cannot retain enough packet history within its 16-bit pre-skip field',
    );
  }

  let lastIndex = -1;
  for (let index = firstIndex; index < packets.length; index++) {
    const packet = packets[index];
    if (packet === undefined || packet.presentationStartFrame >= requestedEndFrame) break;
    lastIndex = index;
  }
  if (lastIndex < firstIndex) {
    throw oggOpusTrimCapability('Ogg Opus trim selected no packet spanning the requested interval');
  }

  const presentationFrames = requestedEndFrame - requestedStartFrame;
  let selectedCodedFrames = 0;
  for (let index = firstIndex; index <= lastIndex; index++) {
    selectedCodedFrames += packets[index]?.samples ?? 0;
  }
  const lastPacketFrames = packets[lastIndex]?.samples ?? 0;
  const finalGranule = outputPreSkipFrames + presentationFrames;
  if (
    !Number.isSafeInteger(finalGranule) ||
    finalGranule <= selectedCodedFrames - lastPacketFrames ||
    finalGranule > selectedCodedFrames
  ) {
    throw oggOpusTrimCapability(
      'Ogg Opus cannot express the requested end within the selected final packet',
    );
  }

  const outputTrack = opusTrackWithPreSkip(track, outputPreSkipFrames);
  if (outputTrack === undefined) {
    throw new MediaError('demux-error', 'Ogg Opus trim could not rewrite OpusHead pre-skip');
  }
  const state = trackStateFrom({
    ...outputTrack,
    // OggMuxer accepts a presentation duration and adds the rewritten OpusHead pre-skip when authoring
    // the EOS granule. Passing the raw granule here would count outputPreSkipFrames twice.
    durationSec: presentationFrames / OPUS_GRANULE_RATE,
  });
  let rebasedFrames = 0;
  for (let index = firstIndex; index <= lastIndex; index++) {
    const packet = packets[index];
    if (packet === undefined) continue;
    state.chunks.push({
      timestampUs: Math.round((rebasedFrames * MICROS_PER_SECOND) / OPUS_GRANULE_RATE),
      durationUs: Math.round((packet.samples * MICROS_PER_SECOND) / OPUS_GRANULE_RATE),
      key: packet.packet.keyframe,
      data: packet.data,
    });
    rebasedFrames += packet.samples;
  }
  return writeOgg(state);
}

function writeOggPacketCopyTrim(
  bytes: Uint8Array,
  trim: NonNullable<StreamCopyOptions['trim']>,
): Uint8Array {
  const table = oggPacketInfoTable(bytes);
  const track = table.tracks[0];
  if (track === undefined || track.mediaType !== 'audio') {
    throw new CapabilityError('Ogg trim needs one audio track', {
      op: { kind: 'route', id: 'trim' },
      tried: ['ogg'],
    });
  }
  validateOggTrimRange(track.durationSec, trim);
  if (track.codec.toLowerCase() === 'opus') {
    return writeExactOggOpusPacketCopyTrim(bytes, table, track, trim);
  }

  const startUs = Math.round(trim.startSec * MICROS_PER_SECOND);
  const endUs = Math.round(trim.endSec * MICROS_PER_SECOND);
  const chunks: ChunkStruct[] = [];
  let baseUs: number | undefined;
  for (const packet of table.packets) {
    const durationUs = packet.durationUs;
    if (durationUs === undefined) {
      throw new MediaError('demux-error', 'Ogg trim packet table is missing duration facts');
    }
    const packetStartUs = Math.round(packet.ptsUs);
    const packetDurationUs = Math.round(durationUs);
    const packetEndUs = packetStartUs + packetDurationUs;
    if (packetEndUs <= startUs || packetStartUs >= endUs) continue;
    baseUs ??= packetStartUs;
    chunks.push({
      timestampUs: Math.max(0, packetStartUs - baseUs),
      durationUs: packetDurationUs,
      key: packet.keyframe,
      data: oggPacketBytes(bytes, packet),
    });
  }
  if (chunks.length === 0) throw new MediaError('mux-error', 'Ogg trim selected no audio packets');

  const state = trackStateFrom({
    ...track,
    durationSec: Math.max(0, endUs - startUs) / MICROS_PER_SECOND,
  });
  state.chunks.push(...chunks);
  return writeOgg(state);
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const HEAD_BYTES = 1 << 16;
const SMALL_PROBE_BYTES = 256 * 1024;

async function readHead(src: ByteSource): Promise<Uint8Array> {
  if (src.range) {
    const end =
      src.size !== undefined && src.size > 0 && src.size <= SMALL_PROBE_BYTES
        ? src.size
        : Math.min(HEAD_BYTES, src.size ?? HEAD_BYTES);
    return src.range(0, end);
  }
  const reader = src.stream().getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => {});
  return value ?? new Uint8Array(0);
}

async function readTail(src: ByteSource, head: Uint8Array): Promise<Uint8Array | undefined> {
  if (src.size !== undefined && head.byteLength >= src.size) return undefined;
  if (src.range && src.size !== undefined && src.size > HEAD_BYTES) {
    return src.range(src.size - HEAD_BYTES, src.size);
  }
  return undefined;
}

function abortedOggRead(): MediaError {
  return new MediaError('aborted', 'operation aborted');
}

async function readOggChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
) {
  if (signal === undefined) return reader.read();
  if (signal.aborted) throw abortedOggRead();
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(abortedOggRead());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), abort]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/** Read the entire source into one buffer — packets() must de-lace the whole file, not just the head. */
async function readAll(src: ByteSource, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw abortedOggRead();
  if (src.range && src.size !== undefined) {
    const bytes = await src.range(0, src.size);
    if (signal?.aborted) throw abortedOggRead();
    return bytes;
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readOggChunk(reader, signal);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    if (signal?.aborted) throw abortedOggRead();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
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
function packetStreamFromInfo(
  data: Uint8Array,
  packets: readonly OggPacketInfoMetadata[],
  signal: AbortSignal | undefined,
): ReadableStream<Packet> {
  if (typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'Ogg packet demux requires the browser codec layer (WebCodecs EncodedAudioChunk)',
      { op: { kind: 'route', id: 'demux' }, tried: ['ogg'] },
    );
  }
  /* v8 ignore start -- requires WebCodecs EncodedAudioChunk; validated under browser-mode (codec phase) */
  let i = 0;
  return new ReadableStream<Packet>({
    pull(controller): void {
      if (signal?.aborted) {
        controller.error(new MediaError('aborted', 'operation aborted'));
        return;
      }
      const packet = packets[i];
      if (packet === undefined) {
        controller.close();
        return;
      }
      i++;
      const init: EncodedAudioChunkInit = {
        type: 'key', // every Ogg audio packet is independently a sync sample
        timestamp: packet.ptsUs,
        data: oggPacketBytes(data, packet),
      };
      if (packet.durationUs !== undefined) init.duration = packet.durationUs;
      const chunk = new EncodedAudioChunk(init);
      controller.enqueue({ chunk });
    },
  });
  /* v8 ignore stop */
}

export const OggDriver: ContainerDriver = {
  id: 'ogg',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['ogg'],
  streamCopyTargets: ['webm', 'mkv'],
  supports: matchesOgg,
  validatesStreamCopyTrim: true,
  async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
    // Exact Ogg duration lives in the terminal page granule. Head+tail range probing is valid only when
    // both a finite size and random access are available; an unknown-size/chunked stream must reach EOS.
    if (src.range === undefined || src.size === undefined) {
      return [trackFromInfo(parseOgg(await readAll(src, o?.signal)))];
    }
    const head = await readHead(src);
    return [trackFromInfo(parseOgg(head, await readTail(src, head)))];
  },
  async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
    const table = oggPacketInfoTable(await readAll(src, o?.signal));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    return table;
  },
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    const all = await readAll(src, o?.signal);
    const table = oggPacketInfoTable(all);
    const packetTable = oggPacketMetadata(table);
    const signal = o?.signal;
    if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    return {
      tracks: table.tracks,
      packetTable: () => packetTable,
      ...({ packetInfoTable: () => table.packets } as {
        packetInfoTable: () => readonly PacketInfoMetadata[];
      }),
      packets(trackId: number): ReadableStream<Packet> {
        const trackIndex = table.tracks.findIndex((track) => track.id === trackId);
        if (trackIndex < 0) throw new MediaError('demux-error', `no track ${trackId}`);
        return packetStreamFromInfo(
          all,
          table.packets.filter((packet) => packet.trackIndex === trackIndex),
          signal,
        );
      },
      close: () => Promise.resolve(),
    };
  },
  createMuxer(o?: MuxOptions): Muxer {
    // The EncodedChunk-seam adapter over the Ogg page writer ({@link OggMuxer}); the packet→page lacing
    // + granule timing is pure + Node-validated, only the per-chunk `copyTo` is browser-only (ogg-write.ts).
    return new OggMuxer(o);
  },
  async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
    validateOggStreamCopyTarget(o?.container);
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    const bytes = await readAll(src, o?.signal);
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    if (o?.container === 'webm' || o?.container === 'mkv') {
      return writeOggWebmPacketCopy(bytes, o.container, o.trim, o.signal);
    }
    const trim = o?.trim;
    if (trim === undefined) return byteStream(bytes);
    const out = writeOggPacketCopyTrim(bytes, trim);
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    return byteStream(out);
  },
};

export const OggModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(OggDriver);
  },
};

export default OggModule;
