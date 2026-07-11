/**
 * MPEG-TS (ISO/IEC 13818-1) parsing core — pure TS, no browser dependency, so it parses + validates in
 * any environment (ADR-002: containers are ours). A transport stream is a flat run of fixed-size packets
 * (188 B; 192 B for m2ts/mts with a 4-byte timestamp prefix; 204 B with RS parity) with **no front index
 * or duration** — so probe reads the whole (bounded, MB-scale) segment and derives timing from the PES
 * PTS span. PSI (PAT→PMT) maps programs → elementary PIDs → `stream_type`; each PID's PES packets carry
 * the access units with 33-bit / 90 kHz PTS/DTS. All multi-byte fields are big-endian.
 *
 * This module turns bytes into a {@link TsParse}: the track table (codec + WebCodecs config + duration)
 * and, per track PID, the reassembled access units (decode order, with PTS/DTS) — everything the
 * {@link import('./mpegts-driver.ts')} driver needs to answer `probe` and to feed the `EncodedChunk`
 * seam, with zero WebCodecs types so it stays unit-testable on the real corpus.
 */

import type { MediaType } from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';
import { detectFraming } from './ts-framing.ts';

export { detectFraming } from './ts-framing.ts';
export type { PacketSize } from './ts-framing.ts';

// `VideoDecoderConfig`/`AudioDecoderConfig` are the global WebCodecs DOM types (as in `contracts/driver.ts`).

const SYNC_BYTE = 0x47;
/** The TS clock is 90 kHz; PTS/DTS are 33-bit values on it. */
export const TS_CLOCK_HZ = 90_000;
/** 2^33 — the PTS/DTS modulus, for unwrapping a single wraparound. */
const TS_PTS_MODULUS = 2 ** 33;

/** Well-known PIDs (ISO/IEC 13818-1 Table 2-3). */
const PID_PAT = 0x0000;
const PID_NULL = 0x1fff;

/** ADTS-framed AAC audio (ISO/IEC 13818-7) — the one `stream_type` the AAC de-framer engages for. */
const STREAM_TYPE_ADTS_AAC = 0x0f;

/** PMT `stream_type` → our codec id. Values from ISO/IEC 13818-1 Table 2-34 + registered amendments. */
const STREAM_TYPE_CODEC: Record<number, string> = {
  1: 'mpeg1video',
  2: 'mpeg2video',
  3: 'mp3', // ISO/IEC 11172-3 audio (MPEG-1 layer II/III)
  4: 'mp3', // ISO/IEC 13818-3 audio
  15: 'aac', // ADTS AAC
  17: 'aac', // LATM AAC
  27: 'h264', // AVC video
  36: 'hevc', // HEVC video
  129: 'ac-3', // ATSC A/52 AC-3
  135: 'ec-3', // Enhanced AC-3
};

/** A `stream_type` whose payload is video (so we tag the {@link MediaType}). */
function streamTypeMedia(streamType: number): MediaType | undefined {
  switch (streamType) {
    case 0x01:
    case 0x02:
    case 0x1b:
    case 0x24:
      return 'video';
    case 0x03:
    case 0x04:
    case 0x0f:
    case 0x11:
    case 0x81:
    case 0x87:
      return 'audio';
    default:
      return undefined;
  }
}

/** One elementary stream declared by the PMT. */
export interface TsStream {
  /** The packet PID carrying this stream's PES. */
  pid: number;
  streamType: number;
  mediaType: MediaType;
  codec: string;
}

/** A reassembled access unit with its WebCodecs-microsecond timestamps. */
export interface TsAccessUnit {
  /**
   * The access-unit bytes: Annex-B for H.264/HEVC (the whole PES payload), and for ADTS AAC exactly one
   * **raw** AAC access unit — the ADTS header (and CRC, when present) is stripped by the stateful
   * de-framer, matching the raw-sample + AudioSpecificConfig shape WebCodecs and the MP4 muxer expect.
   */
  data: Uint8Array;
  /** Presentation timestamp in microseconds (PTS), always present (we drop AUs without one). */
  ptsUs: number;
  /** Decode timestamp in microseconds; equals `ptsUs` when the PES carried no separate DTS. */
  dtsUs: number;
  /** Internal provenance used by the H.264 PES→access-unit de-framer; omitted from public packets. */
  pesHadExplicitDts?: boolean;
  keyframe: boolean;
  /**
   * The container packet's on-disk byte size — what a packet-size oracle (`ffprobe -show_packets` size,
   * surfaced on {@link import('../../contracts/driver.ts').Packet.sizeBytes}) compares against. For ADTS
   * AAC this is the WHOLE ADTS frame length: the 7/9-byte header the de-framer strips from {@link data} is
   * still counted here, so the reported size equals the transport-stream packet even though `data` is the
   * bare raw access unit. Absent when `data` already IS the on-disk packet (H.264/HEVC Annex-B, whose
   * `data.byteLength` is the size), so the driver falls back to `data.byteLength`.
   */
  sizeBytes?: number;
}

/** Per-track parse result: the stream descriptor, its access units (decode order), and its PTS span. */
export interface TsTrack {
  stream: TsStream;
  units: TsAccessUnit[];
  /** The container presentation duration (seconds) — spans all tracks, matches `format=duration`. */
  durationSec: number;
  /** Video frame rate from this track's own median PTS gap (90 kHz ÷ gap); absent for audio/untimed. */
  fps?: number;
  /** A WebCodecs decoder config carrying the dims (video) or sampleRate/channels (audio) for probe. */
  config: VideoDecoderConfig | AudioDecoderConfig;
}

/** The full parse: the ordered track list (one per elementary PID with timed PES). */
export interface TsParse {
  tracks: TsTrack[];
}

/** A parsed transport packet header + the slice of its payload (after any adaptation field). */
interface TsPacket {
  pid: number;
  payloadUnitStart: boolean;
  scrambled: boolean;
  /** The PCR base (90 kHz ticks) when the adaptation field carried one, else undefined. */
  pcr?: number;
  /** The payload bytes (may be empty when AF-only), or undefined when there is no payload. */
  payload?: Uint8Array;
}

/**
 * Parse one 188-byte transport packet at `[off, off+188)`. `off` points at the sync byte. Returns
 * `undefined` for a packet whose sync byte is wrong (corrupt/zeroed) so the caller can resync, and for
 * the null/padding PID which carries no data.
 */
function parsePacket(bytes: Uint8Array, off: number): TsPacket | undefined {
  if (bytes[off] !== SYNC_BYTE) return undefined;
  const b1 = bytes[off + 1] as number;
  const b2 = bytes[off + 2] as number;
  const b3 = bytes[off + 3] as number;
  const transportError = (b1 & 0x80) !== 0;
  if (transportError) return undefined; // TEI set: the demodulator flagged this packet as corrupt
  const payloadUnitStart = (b1 & 0x40) !== 0;
  const pid = ((b1 & 0x1f) << 8) | b2;
  if (pid === PID_NULL) return undefined; // stuffing
  const scrambled = (b3 & 0xc0) !== 0;
  const adaptationFieldControl = (b3 >> 4) & 0x3;
  const hasAdaptation = (adaptationFieldControl & 0x2) !== 0;
  const hasPayload = (adaptationFieldControl & 0x1) !== 0;
  if (adaptationFieldControl === 0) return undefined; // reserved: discard

  let cursor = off + 4;
  let pcr: number | undefined;
  if (hasAdaptation) {
    const afLen = bytes[cursor] as number;
    if (afLen > 0) {
      const flags = bytes[cursor + 1] as number;
      if ((flags & 0x10) !== 0 && afLen >= 7) {
        // PCR present: 33-bit base in bytes [cursor+2 .. +6] high bits, then a 9-bit extension.
        const a = bytes[cursor + 2] as number;
        const c = bytes[cursor + 3] as number;
        const d = bytes[cursor + 4] as number;
        const e = bytes[cursor + 5] as number;
        const f = bytes[cursor + 6] as number;
        // base = top 33 bits: a(8)<<25 | c(8)<<17 | d(8)<<9 | e(8)<<1 | f>>7. Use * for the >32-bit part.
        pcr = a * 2 ** 25 + c * 2 ** 17 + d * 2 ** 9 + e * 2 + (f >> 7);
      }
    }
    cursor += 1 + afLen;
  }

  const packetEnd = off + 188;
  if (!hasPayload || cursor >= packetEnd) {
    return { pid, payloadUnitStart, scrambled, ...(pcr !== undefined ? { pcr } : {}) };
  }
  return {
    pid,
    payloadUnitStart,
    scrambled,
    ...(pcr !== undefined ? { pcr } : {}),
    payload: bytes.subarray(cursor, packetEnd),
  };
}

// ── PSI (PAT / PMT) ─────────────────────────────────────────────────────────────────────────────

/** Read a PSI section out of a PUSI packet payload (skip the `pointer_field` prefix). */
function sectionFromPayload(payload: Uint8Array): Uint8Array | undefined {
  const pointer = payload[0];
  if (pointer === undefined) return undefined;
  const start = 1 + pointer;
  return start <= payload.byteLength ? payload.subarray(start) : undefined;
}

/** Parse a PAT section → the first program's PMT PID (programs repeat; the first is enough). */
function parsePat(section: Uint8Array): { programPmtPids: Map<number, number> } | undefined {
  if (section[0] !== 0x00) return undefined; // table_id 0x00 = PAT
  const sectionLength = (((section[1] as number) & 0x0f) << 8) | (section[2] as number);
  const end = Math.min(3 + sectionLength - 4, section.byteLength); // drop the 4-byte CRC
  const map = new Map<number, number>();
  // Program loop starts after the 8-byte section header (table_id..last_section_number).
  for (let i = 8; i + 4 <= end; i += 4) {
    const programNumber = ((section[i] as number) << 8) | (section[i + 1] as number);
    const pid = (((section[i + 2] as number) & 0x1f) << 8) | (section[i + 3] as number);
    if (programNumber !== 0) map.set(programNumber, pid); // program 0 = network PID, not a PMT
  }
  return map.size > 0 ? { programPmtPids: map } : undefined;
}

/** A registration/identifier descriptor can disambiguate PES-private (`stream_type 0x06`) payloads. */
function codecFromDescriptors(descriptors: Uint8Array): string | undefined {
  let i = 0;
  while (i + 2 <= descriptors.byteLength) {
    const tag = descriptors[i] as number;
    const len = descriptors[i + 1] as number;
    const body = descriptors.subarray(i + 2, i + 2 + len);
    if (tag === 0x05 && body.byteLength >= 4) {
      // registration_descriptor: a 4-char format_identifier (e.g. 'AC-3', 'Opus', 'EAC3').
      const id = String.fromCharCode(
        body[0] as number,
        body[1] as number,
        body[2] as number,
        body[3] as number,
      );
      if (id === 'AC-3') return 'ac-3';
      if (id === 'EAC3') return 'ec-3';
      if (id === 'Opus') return 'opus';
    } else if (tag === 0x6a || tag === 0x7a) {
      return tag === 0x6a ? 'ac-3' : 'ec-3'; // AC-3 / enhanced-AC-3 descriptor tags
    } else if (tag === 0x56 || tag === 0x59) {
      // teletext / subtitling — not a media track we decode; signal "skip" via a sentinel codec.
      return 'data';
    }
    i += 2 + len;
  }
  return undefined;
}

/** Map a PMT entry to a codec id; PES-private (0x06) is resolved from its descriptors when possible. */
function codecForStream(streamType: number, descriptors: Uint8Array): string | undefined {
  const known = STREAM_TYPE_CODEC[streamType];
  if (known !== undefined) return known;
  if (streamType === 0x06) return codecFromDescriptors(descriptors); // PES-carrying private data
  return undefined;
}

/** Parse a PMT section → the elementary streams (PID + codec). */
function parsePmt(section: Uint8Array): TsStream[] | undefined {
  if (section[0] !== 0x02) return undefined; // table_id 0x02 = PMT
  const sectionLength = (((section[1] as number) & 0x0f) << 8) | (section[2] as number);
  const end = Math.min(3 + sectionLength - 4, section.byteLength);
  const programInfoLength = (((section[10] as number) & 0x0f) << 8) | (section[11] as number);
  const streams: TsStream[] = [];
  let i = 12 + programInfoLength; // skip the program-level descriptor loop
  while (i + 5 <= end) {
    const streamType = section[i] as number;
    const pid = (((section[i + 1] as number) & 0x1f) << 8) | (section[i + 2] as number);
    const esInfoLength = (((section[i + 3] as number) & 0x0f) << 8) | (section[i + 4] as number);
    const descriptors = section.subarray(i + 5, i + 5 + esInfoLength);
    const codec = codecForStream(streamType, descriptors);
    const mediaType =
      streamTypeMedia(streamType) ??
      (codec === 'ac-3' || codec === 'ec-3' || codec === 'opus' ? 'audio' : undefined);
    if (codec !== undefined && codec !== 'data' && mediaType !== undefined) {
      streams.push({ pid, streamType, mediaType, codec });
    }
    i += 5 + esInfoLength;
  }
  return streams.length > 0 ? streams : undefined;
}

// ── PES reassembly ──────────────────────────────────────────────────────────────────────────────

/** Decode a 33-bit PTS/DTS from the 5 marker-interleaved bytes at `b[off..off+5)`. */
function readPtsDts(b: Uint8Array, off: number): number {
  const a = b[off] as number;
  const c = b[off + 1] as number;
  const d = b[off + 2] as number;
  const e = b[off + 3] as number;
  const f = b[off + 4] as number;
  // bits: aaa(3) cccccccc(8) ddddddd(7) eeeeeeee(8) fffffff(7) interleaved with marker bits.
  return (
    ((a >> 1) & 0x7) * 2 ** 30 +
    c * 2 ** 22 +
    ((d >> 1) & 0x7f) * 2 ** 15 +
    e * 2 ** 7 +
    ((f >> 1) & 0x7f)
  );
}

/** A PES being assembled from one or more transport packets for a single PID. */
interface PesBuilder {
  chunks: Uint8Array[];
  length: number;
}

/** Concatenate a builder's packet payloads into one contiguous PES buffer. */
function flattenPes(builder: PesBuilder): Uint8Array {
  if (builder.chunks.length === 1) return builder.chunks[0] as Uint8Array;
  const out = new Uint8Array(builder.length);
  let off = 0;
  for (const c of builder.chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Convert a 90 kHz tick value to integer microseconds (WebCodecs timestamps are µs). */
function ticksToUs(ticks: number): number {
  return Math.round((ticks * 1_000_000) / TS_CLOCK_HZ);
}

/** A PES split into its PTS/DTS and the elementary payload (the access unit). */
interface PesUnit {
  pts?: number;
  dts?: number;
  payload: Uint8Array;
}

/**
 * Split a complete PES packet into timestamps + elementary payload. Returns `undefined` for a PES whose
 * `stream_id` carries no PTS (padding/private-2/ECM/EMM map streams), so only real media AUs flow on.
 */
function splitPes(pes: Uint8Array): PesUnit | undefined {
  if (pes.byteLength < 9) return undefined;
  if (pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) return undefined; // PES start_code prefix
  const streamId = pes[3] as number;
  // Stream ids that have no PES header extension (and so no PTS): padding, private_2, and the various
  // map/info streams (ISO/IEC 13818-1 §2.4.3.7). Audio (0xC0..0xDF) and video (0xE0..0xEF) do.
  const isVideo = streamId >= 0xe0 && streamId <= 0xef;
  const isAudio = streamId >= 0xc0 && streamId <= 0xdf;
  if (!isVideo && !isAudio) return undefined;
  const ptsDtsFlags = ((pes[7] as number) >> 6) & 0x3;
  const headerDataLength = pes[8] as number;
  const payloadStart = 9 + headerDataLength;
  if (payloadStart > pes.byteLength) return undefined;
  let pts: number | undefined;
  let dts: number | undefined;
  if ((ptsDtsFlags & 0x2) !== 0) {
    if (pes.byteLength < 14) return undefined;
    pts = readPtsDts(pes, 9);
  }
  if (ptsDtsFlags === 0x3) {
    if (pes.byteLength < 19) return undefined;
    dts = readPtsDts(pes, 14);
  }
  return {
    ...(pts !== undefined ? { pts } : {}),
    ...(dts !== undefined ? { dts } : {}),
    payload: pes.subarray(payloadStart),
  };
}

/** True when an H.264 Annex-B access unit contains an IDR (NAL type 5) — a clean keyframe. */
function h264HasIdr(au: Uint8Array): boolean {
  // Scan for 00 00 01 / 00 00 00 01 start codes and inspect the NAL unit type (low 5 bits of the byte).
  for (let i = 0; i + 3 < au.byteLength; i++) {
    if (au[i] === 0x00 && au[i + 1] === 0x00 && au[i + 2] === 0x01) {
      const nalType = (au[i + 3] as number) & 0x1f;
      if (nalType === 5) return true; // IDR slice
      i += 2;
    }
  }
  return false;
}

interface AnnexBNalStart {
  readonly offset: number;
  readonly type: number;
}

/** Find exact 3/4-byte Annex-B start-code offsets and H.264 NAL types in source order. */
function h264AnnexBNalStarts(bytes: Uint8Array): AnnexBNalStart[] {
  const starts: AnnexBNalStart[] = [];
  for (let offset = 0; offset + 3 < bytes.byteLength; offset++) {
    let prefixLength = 0;
    if (
      bytes[offset] === 0 &&
      bytes[offset + 1] === 0 &&
      bytes[offset + 2] === 0 &&
      bytes[offset + 3] === 1
    ) {
      prefixLength = 4;
    } else if (bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 1) {
      prefixLength = 3;
    }
    if (prefixLength === 0) continue;
    const header = bytes[offset + prefixLength];
    if (header !== undefined) starts.push({ offset, type: header & 0x1f });
    offset += prefixLength - 1;
  }
  return starts;
}

/**
 * Reassemble H.264 access units across PES boundaries. ISO/IEC 13818-1 permits a PES to begin in the
 * middle of an access unit; a PTS/DTS then names the first AU that *commences* in that PES. FFmpeg TS
 * muxers emit AUD NALs, so a new AUD after VCL data is an exact boundary. Consecutive AUDs before VCL
 * remain in one AU (field-coded streams may carry them); a stream with no usable AUD delimiter retains
 * the original PES units rather than guessing slice boundaries.
 */
export function deframeH264PesUnits(units: readonly TsAccessUnit[]): TsAccessUnit[] {
  if (units.length === 0) return [];
  const totalBytes = units.reduce((sum, unit) => sum + unit.data.byteLength, 0);
  const joined = new Uint8Array(totalBytes);
  const anchors: { readonly offset: number; readonly unit: TsAccessUnit }[] = [];
  let writeOffset = 0;
  for (const unit of units) {
    anchors.push({ offset: writeOffset, unit });
    joined.set(unit.data, writeOffset);
    writeOffset += unit.data.byteLength;
  }

  const nalStarts = h264AnnexBNalStarts(joined);
  const firstNal = nalStarts[0];
  if (firstNal === undefined) return [...units];
  const ranges: { readonly start: number; readonly end: number }[] = [];
  let accessUnitStart = firstNal.offset;
  let sawAud = false;
  let sawVcl = false;
  for (const nal of nalStarts) {
    if (nal.type === 9) {
      sawAud = true;
      if (sawVcl) {
        ranges.push({ start: accessUnitStart, end: nal.offset });
        accessUnitStart = nal.offset;
        sawVcl = false;
      }
    }
    if (nal.type === 1 || nal.type === 5) sawVcl = true;
  }
  if (sawVcl) ranges.push({ start: accessUnitStart, end: joined.byteLength });
  if (!sawAud || ranges.length === 0) return [...units];

  const hasIndependentDts = units.some(
    (unit) => unit.pesHadExplicitDts === true && unit.dtsUs !== unit.ptsUs,
  );
  const out: TsAccessUnit[] = [];
  let anchorIndex = 0;
  let dtsCursor: number | undefined;
  for (const range of ranges) {
    while (
      anchorIndex + 1 < anchors.length &&
      (anchors[anchorIndex + 1]?.offset ?? 0) <= range.start
    ) {
      anchorIndex++;
    }
    const anchor = anchors[anchorIndex]?.unit;
    if (anchor === undefined) continue;
    let dtsUs: number;
    // A DTS equal to PTS carries no independent decode-order information. Treat it like an omitted DTS
    // and continue the nominal decode cadence; this is how ffmpeg bridges the two PTS-only AUs around
    // an IDR while preserving the B-frame DTS sequence on either side.
    if (anchor.pesHadExplicitDts === true && anchor.dtsUs !== anchor.ptsUs) {
      dtsUs = anchor.dtsUs;
      dtsCursor = dtsUs;
    } else if (!hasIndependentDts) {
      dtsUs = anchor.ptsUs;
    } else {
      dtsUs = dtsCursor ?? anchor.dtsUs;
      // In a reordered stream, ffmpeg bridges a PTS-only PES by assigning the prior decode cursor to
      // this AU, then using this AU's exact PTS as the cursor for the next one. Referencing the exact PTS
      // avoids 1 µs drift on 30000/1001 cadences that alternate rounded 33333/33334 µs intervals.
      dtsCursor = anchor.ptsUs;
    }
    const data = joined.subarray(range.start, range.end);
    out.push({
      data,
      ptsUs: anchor.ptsUs,
      dtsUs,
      keyframe: h264HasIdr(data),
    });
  }
  return out;
}

/** True when an HEVC Annex-B access unit contains an IRAP NAL (types 16–23: BLA/IDR/CRA). */
function hevcHasIrap(au: Uint8Array): boolean {
  for (let i = 0; i + 4 < au.byteLength; i++) {
    if (au[i] === 0x00 && au[i + 1] === 0x00 && au[i + 2] === 0x01) {
      const nalType = ((au[i + 3] as number) >> 1) & 0x3f;
      if (nalType >= 16 && nalType <= 23) return true;
      i += 2;
    }
  }
  return false;
}

/** Decide whether an access unit is a keyframe for the given codec (audio AUs are all independent). */
function isKeyframe(codec: string, mediaType: MediaType, au: Uint8Array): boolean {
  if (mediaType === 'audio') return true;
  if (codec === 'h264') return h264HasIdr(au);
  if (codec === 'hevc') return hevcHasIrap(au);
  return true; // unknown video codec: cannot prove a delta frame, so treat as independent (honest)
}

// ── access-unit timing (duration + WebCodecs µs) ──────────────────────────────────────────────────

/** Unwrap a single 2^33 PTS wraparound across an ordered timestamp list (TS PTS is 33-bit, ≈ 26.5 h). */
function unwrap(ticks: readonly number[]): number[] {
  const out: number[] = [];
  let offset = 0;
  let prev: number | undefined;
  for (const t of ticks) {
    if (prev !== undefined && prev - t > TS_PTS_MODULUS / 2) offset += TS_PTS_MODULUS; // forward wrap
    out.push(t + offset);
    prev = t;
  }
  return out;
}

/** A track's unwrapped presentation span (90 kHz ticks): earliest/latest PTS and the median frame gap. */
interface PtsSpan {
  first: number;
  last: number;
  /** Median inter-frame gap (ticks) — the track's nominal frame/sample-group duration. */
  medianGap: number;
}

/** Reduce a track's raw PTS list to its unwrapped span + median frame gap (`undefined` if < 2 timed AUs). */
function ptsSpan(ptsTicks: readonly number[]): PtsSpan | undefined {
  if (ptsTicks.length < 2) return undefined;
  const unwrapped = unwrap([...ptsTicks].sort((x, y) => x - y));
  const first = unwrapped[0] as number;
  const last = unwrapped[unwrapped.length - 1] as number;
  if (last - first <= 0) return undefined;
  const gaps: number[] = [];
  for (let i = 1; i < unwrapped.length; i++)
    gaps.push((unwrapped[i] as number) - (unwrapped[i - 1] as number));
  gaps.sort((x, y) => x - y);
  return { first, last, medianGap: gaps[gaps.length >> 1] as number };
}

/**
 * Container presentation duration (seconds) — the standard ISO/IEC 13818-1 measure that ffprobe reports:
 * the span from the **earliest start to the latest end across all tracks**, plus one display interval of
 * the finest-cadence track (the span ends at the last frame's *presentation start*, so it must be
 * extended by that frame's duration). Returns 0 when no track is timed.
 */
function containerDuration(spans: readonly PtsSpan[]): number {
  if (spans.length === 0) return 0;
  const start = Math.min(...spans.map((s) => s.first));
  const end = Math.max(...spans.map((s) => s.last));
  const finestGap = Math.min(...spans.map((s) => s.medianGap).filter((g) => g > 0));
  const tail = Number.isFinite(finestGap) ? finestGap : 0;
  return (end - start + tail) / TS_CLOCK_HZ;
}

// ── top-level parse ─────────────────────────────────────────────────────────────────────────────

/**
 * Iterate the whole stream once, demultiplexing every elementary PID into its access units. The PAT/PMT
 * are read from their first occurrence; thereafter PES packets are reassembled per PID (a PUSI flushes
 * the previous PES). A PES with a separate DTS keeps PTS≠DTS (B-frames survive); a PES without a PTS is
 * dropped (it cannot be timed). Corrupt/zeroed packets are skipped by resyncing to the next sync byte.
 */
export function parseTs(bytes: Uint8Array): TsParse {
  const framing = detectFraming(bytes);
  if (!framing) {
    throw new InputError(
      'unsupported-input',
      'not an MPEG-TS stream (no transport sync run found — encrypted, scrambled, or not a transport stream)',
    );
  }
  const { packetSize, start, tsOffset } = framing;

  let pmtPid: number | undefined;
  const streamsByPid = new Map<number, TsStream>();
  const builders = new Map<number, PesBuilder>();
  // Per-PID access units (decode order, as reassembled) plus the raw PTS list for duration. ADTS AAC
  // PIDs are handled by a stateful de-framer instead (frames span PES packets), which owns their lists.
  const unitsByPid = new Map<number, TsAccessUnit[]>();
  const ptsByPid = new Map<number, number[]>();
  const deframers = new Map<number, AdtsDeframer>();
  let sawScrambled = false;
  let sawSync = false;

  const flush = (pid: number): void => {
    const builder = builders.get(pid);
    builders.delete(pid);
    const stream = streamsByPid.get(pid);
    if (!builder || !stream) return;
    const split = splitPes(flattenPes(builder));
    if (!split) return;
    if (stream.streamType === STREAM_TYPE_ADTS_AAC) {
      // ADTS AAC: one PES carries several frames and frames cross PES boundaries, so the payload feeds
      // the PID's de-framer (one raw access unit per ADTS frame). A PTS-less PES continues the chain.
      let deframer = deframers.get(pid);
      if (deframer === undefined) {
        deframer = new AdtsDeframer();
        deframers.set(pid, deframer);
      }
      deframer.push(split.payload, split.pts);
      return;
    }
    if (split.pts === undefined) return; // no PTS → cannot place on the timeline; drop
    // Everything else (H.264/HEVC video, LATM/AC-3/… audio): the whole PES payload is ONE access unit
    // with the PES's own PTS/DTS (a separate DTS keeps B-frame decode order intact).
    const list = unitsByPid.get(pid) ?? [];
    list.push({
      data: split.payload,
      ptsUs: ticksToUs(split.pts),
      dtsUs: ticksToUs(split.dts ?? split.pts),
      ...(split.dts !== undefined ? { pesHadExplicitDts: true } : {}),
      keyframe: isKeyframe(stream.codec, stream.mediaType, split.payload),
    });
    unitsByPid.set(pid, list);
    const ptsList = ptsByPid.get(pid) ?? [];
    ptsList.push(split.pts);
    ptsByPid.set(pid, ptsList);
  };

  // `off` is the packet start (including any m2ts/204 prefix); the sync byte sits at `off + tsOffset`,
  // and `parsePacket` reads the 188 transport bytes from there. One iteration advances exactly one packet.
  for (let off = start; off + tsOffset + 188 <= bytes.byteLength; ) {
    const syncAt = off + tsOffset;
    if (bytes[syncAt] !== SYNC_BYTE) {
      // Lost alignment (corrupt/zeroed packet): hunt one byte at a time for the next sync byte.
      off += 1;
      continue;
    }
    sawSync = true;
    const packet = parsePacket(bytes, syncAt);
    off += packetSize; // next packet start (prefix + 188 + any parity)
    if (!packet) continue;
    if (packet.scrambled) {
      sawScrambled = true;
      continue; // cannot reassemble ciphertext payloads
    }
    const { pid, payloadUnitStart, payload } = packet;

    if (pid === PID_PAT) {
      if (pmtPid === undefined && payloadUnitStart && payload) {
        const section = sectionFromPayload(payload);
        const pat = section && parsePat(section);
        if (pat) pmtPid = [...pat.programPmtPids.values()][0];
      }
      continue;
    }
    if (pid === pmtPid) {
      if (streamsByPid.size === 0 && payloadUnitStart && payload) {
        const section = sectionFromPayload(payload);
        const streams = section && parsePmt(section);
        if (streams) for (const s of streams) streamsByPid.set(s.pid, s);
      }
      continue;
    }
    const stream = streamsByPid.get(pid);
    if (!stream || !payload) continue;

    if (payloadUnitStart) {
      flush(pid); // a new PES begins: finalize the previous one for this PID
      builders.set(pid, { chunks: [payload], length: payload.byteLength });
    } else {
      const builder = builders.get(pid);
      if (builder) {
        builder.chunks.push(payload);
        builder.length += payload.byteLength;
      }
      // else: a continuation with no started PES (we joined mid-stream) — discard until the next PUSI.
    }
  }
  for (const pid of [...builders.keys()]) flush(pid); // EOF flush of the last (unbounded video) PES
  for (const deframer of deframers.values()) deframer.finish(); // a trailing partial frame is dropped
  for (const stream of streamsByPid.values()) {
    if (stream.codec !== 'h264') continue;
    const pesUnits = unitsByPid.get(stream.pid);
    if (pesUnits !== undefined) unitsByPid.set(stream.pid, deframeH264PesUnits(pesUnits));
  }

  if (!sawSync) {
    throw new InputError('unsupported-input', 'no readable transport packets (corrupt MPEG-TS)');
  }
  if (streamsByPid.size === 0) {
    if (sawScrambled) {
      throw new InputError(
        'unsupported-input',
        'MPEG-TS payloads are scrambled/encrypted (no cleartext PSI) — decrypt before demux',
      );
    }
    throw new MediaError(
      'demux-error',
      'MPEG-TS has no PAT/PMT with a decodable elementary stream',
    );
  }

  // Container presentation duration spans all tracks (earliest start → latest end + one frame): the
  // ISO/IEC 13818-1 measure ffprobe reports. Every track carries it (matching `format=duration`), so the
  // engine's max-over-tracks reduction in `toMediaInfo` yields the same value regardless of track order.
  const spanByPid = new Map<number, PtsSpan>();
  for (const stream of streamsByPid.values()) {
    const ptsTicks = deframers.get(stream.pid)?.ptsTicksList ?? ptsByPid.get(stream.pid) ?? [];
    const span = ptsSpan(ptsTicks);
    if (span) spanByPid.set(stream.pid, span);
  }
  const durationSec = containerDuration([...spanByPid.values()]);

  const tracks: TsTrack[] = [];
  for (const stream of streamsByPid.values()) {
    const deframer = deframers.get(stream.pid);
    const units = deframer?.units ?? unitsByPid.get(stream.pid) ?? [];
    // fps from this video track's own cadence (its median PTS gap), not the container span.
    const span = spanByPid.get(stream.pid);
    const fps =
      stream.mediaType === 'video' && span && span.medianGap > 0
        ? TS_CLOCK_HZ / span.medianGap
        : undefined;
    tracks.push({
      stream,
      units,
      durationSec,
      ...(fps !== undefined ? { fps } : {}),
      config: configForStream(stream, units, deframer?.params),
    });
  }
  // Stable order: video first then audio, each by PID — deterministic across runs (matches probe goldens).
  tracks.sort(
    (a, b) =>
      mediaRank(a.stream.mediaType) - mediaRank(b.stream.mediaType) || a.stream.pid - b.stream.pid,
  );
  return { tracks };
}

function mediaRank(t: MediaType): number {
  return t === 'video' ? 0 : 1;
}

// ── codec config (dims / sample params) for probe ─────────────────────────────────────────────────

/** Parse H.264 SPS coded dimensions from the first SPS NAL in an access unit (Annex-B). */
function h264Dimensions(au: Uint8Array): { width: number; height: number } | undefined {
  const sps = findNal(au, (nal) => (nal[0] as number) & 0x1f, 7);
  return sps ? parseH264SpsDimensions(sps) : undefined;
}

/** Find the first Annex-B NAL whose `typeOf(nalBody)` equals `want`; returns the NAL body (sans header byte offset 0). */
function findNal(
  au: Uint8Array,
  typeOf: (nalAtStart: Uint8Array) => number,
  want: number,
): Uint8Array | undefined {
  for (let i = 0; i + 3 < au.byteLength; i++) {
    if (au[i] === 0x00 && au[i + 1] === 0x00 && au[i + 2] === 0x01) {
      const body = au.subarray(i + 3);
      if (typeOf(body) === want) return body;
      i += 2;
    }
  }
  return undefined;
}

/** A minimal Exp-Golomb + SPS reader: enough for coded width/height (profile-agnostic baseline path). */
export function parseH264SpsDimensions(
  nal: Uint8Array,
): { width: number; height: number } | undefined {
  // Strip emulation-prevention 0x03 bytes, then read past the 1-byte NAL header.
  const rbsp = stripEmulation(nal).subarray(1);
  const r = new BitReader(rbsp);
  try {
    r.u(8); // profile_idc
    r.u(8); // constraint flags + reserved
    r.u(8); // level_idc
    r.ue(); // seq_parameter_set_id
    const profileIdc = rbsp[0] as number;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      const chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) r.u(1); // separate_colour_plane_flag
      r.ue(); // bit_depth_luma_minus8
      r.ue(); // bit_depth_chroma_minus8
      r.u(1); // qpprime_y_zero_transform_bypass_flag
      if (r.u(1)) for (let i = 0; i < 8; i++) if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
      r.u(1);
      r.se();
      r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.u(1); // gaps_in_frame_num_value_allowed_flag
    const widthMbs = r.ue() + 1;
    const heightMapUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1); // mb_adaptive_frame_field_flag
    r.u(1); // direct_8x8_inference_flag
    let cropL = 0;
    let cropR = 0;
    let cropT = 0;
    let cropB = 0;
    if (r.u(1)) {
      cropL = r.ue();
      cropR = r.ue();
      cropT = r.ue();
      cropB = r.ue();
    }
    const width = widthMbs * 16 - (cropL + cropR) * 2;
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (cropT + cropB) * 2;
    return width > 0 && height > 0 ? { width, height } : undefined;
  } catch {
    return undefined; // a malformed SPS yields no dims rather than throwing — probe stays robust
  }
}

function skipScalingList(r: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) nextScale = (lastScale + r.se() + 256) % 256;
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

/** Remove H.264/HEVC emulation-prevention bytes (00 00 03 → 00 00) from a NAL. */
function stripEmulation(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.byteLength; i++) {
    if (
      i >= 2 &&
      nal[i] === 0x03 &&
      nal[i - 1] === 0x00 &&
      nal[i - 2] === 0x00 &&
      (nal[i + 1] ?? 1) <= 0x03
    ) {
      continue;
    }
    out.push(nal[i] as number);
  }
  return new Uint8Array(out);
}

/** A big-endian bit reader for Exp-Golomb-coded NAL payloads. */
class BitReader {
  readonly #bytes: Uint8Array;
  #bit = 0;
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.#bytes[this.#bit >> 3] ?? 0;
      const bit = (byte >> (7 - (this.#bit & 7))) & 1;
      v = (v << 1) | bit;
      this.#bit++;
    }
    return v >>> 0;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros++;
      if (zeros > 31) throw new Error('exp-golomb overflow');
    }
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.u(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  }
}

/** AAC sampling-frequency table (ADTS `sampling_frequency_index` → Hz), ISO/IEC 14496-3. */
const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
] as const;

/** Fixed ADTS header length (ISO/IEC 13818-7 §6.2.1); `protection_absent == 0` appends a 2-byte CRC. */
const ADTS_FIXED_HEADER_LENGTH = 7;
/** Samples per AAC raw data block (AAC-LC frame). */
const AAC_SAMPLES_PER_BLOCK = 1024;
/**
 * How far (90 kHz ticks) a later PES PTS anchor may sit from the running 1024-sample cadence before it is
 * treated as a genuine timestamp discontinuity (splice / loop / reset) that rebases the chain — rather
 * than the ±frame priming/rounding wobble that broadcast muxers (and ffmpeg's own AAC parser) exhibit,
 * which must NOT perturb the monotonic cadence. Half a second is orders of magnitude above any AAC-LC
 * cadence rounding or single-frame encoder-delay offset, yet far below a real reset (seconds / a 2^33
 * wrap), so it cleanly separates the two without reproducing the wobble (e.g. bear's frame-12 anchor sits
 * exactly one frame behind cadence — smoothed, not rebased).
 */
const REBASE_DISCONTINUITY_TICKS = TS_CLOCK_HZ / 2;

/** Track-level AAC geometry read from the first valid ADTS header (drives the WebCodecs config). */
export interface AdtsTrackParams {
  /** MPEG-4 audio object type (`profile + 1`; 2 = AAC-LC). */
  objectType: number;
  /** 4-bit `sampling_frequency_index` (0–12; the ASC carries it verbatim). */
  samplingFrequencyIndex: number;
  sampleRate: number;
  /** 3-bit `channel_configuration` (0 = PCE in-band, no derivable channel count). */
  channelConfiguration: number;
}

/** One validated ADTS header: total header size to strip, whole-frame length, and decoded samples. */
interface AdtsHeaderInfo {
  /** Bytes to strip from the frame start: 7, or 9 when a CRC follows (`protection_absent == 0`). */
  headerLength: number;
  /** The 13-bit `aac_frame_length` (header + CRC + payload). */
  frameLength: number;
  /** `1024 × (number_of_raw_data_blocks_in_frame + 1)` — this frame's decoded sample count. */
  samples: number;
  params: AdtsTrackParams;
}

/**
 * Parse + validate the ADTS fixed header at `off` (the caller guarantees 7 readable bytes). Returns
 * `undefined` for anything that cannot be a real frame start — wrong syncword, non-zero `layer`, a
 * reserved `sampling_frequency_index`, or a `frame_length` that cannot hold its own header — so the
 * de-framer's resync hunt skips false `0xFFF` matches inside compressed payload bytes.
 */
function parseAdtsHeaderAt(bytes: Uint8Array, off: number): AdtsHeaderInfo | undefined {
  const b1 = bytes[off + 1] as number;
  if (bytes[off] !== 0xff || (b1 & 0xf0) !== 0xf0) return undefined; // 12-bit syncword
  if ((b1 & 0x06) !== 0) return undefined; // layer must be '00' for ADTS
  const b2 = bytes[off + 2] as number;
  const b3 = bytes[off + 3] as number;
  const samplingFrequencyIndex = (b2 >> 2) & 0x0f;
  const sampleRate = AAC_SAMPLE_RATES[samplingFrequencyIndex];
  if (sampleRate === undefined) return undefined; // reserved/escape index: not a real header
  const headerLength = (b1 & 0x01) === 1 ? ADTS_FIXED_HEADER_LENGTH : ADTS_FIXED_HEADER_LENGTH + 2;
  const frameLength =
    ((b3 & 0x03) << 11) |
    ((bytes[off + 4] as number) << 3) |
    (((bytes[off + 5] as number) >> 5) & 0x07);
  if (frameLength <= headerLength) return undefined; // cannot hold a payload: malformed
  const blocks = ((bytes[off + 6] as number) & 0x03) + 1;
  return {
    headerLength,
    frameLength,
    samples: AAC_SAMPLES_PER_BLOCK * blocks,
    params: {
      objectType: ((b2 >> 6) & 0x03) + 1,
      samplingFrequencyIndex,
      sampleRate,
      channelConfiguration: ((b2 & 0x01) << 2) | ((b3 >> 6) & 0x03),
    },
  };
}

/** Concatenate a pending tail with the next PES payload into one scan buffer. */
function concatPending(pending: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(pending.byteLength + payload.byteLength);
  out.set(pending, 0);
  out.set(payload, pending.byteLength);
  return out;
}

/**
 * Stateful ADTS de-framer for one `stream_type 0x0f` PID (ADR-184). Real transport streams pack
 * **several** ADTS frames into one audio PES *and* split frames **across** PES packets (broadcast muxers
 * flush on byte budgets, not frame boundaries), so per-PES splitting emits inconsistently framed — and
 * boundary-corrupted — samples. This class scans the reassembled PES payload byte stream exactly once:
 *
 *  - buffers a partial frame (or partial header) across PES boundaries and resumes on the next payload;
 *  - resyncs by hunting for the next plausible `0xFFF` header after garbage (validated, not just the
 *    syncword, so payload bytes that contain `0xFFF` do not fake a frame);
 *  - emits exactly ONE **raw** AAC access unit per frame — the 7-byte header (9 with CRC) is stripped;
 *  - times each frame per ISO/IEC 13818-1 §2.4.3.7: a PES PTS names the first access unit that
 *    *commences* in that PES payload (the first frame starting at/after the payload's first byte). The
 *    very first such anchor starts the cadence chain; successive frames advance `samples / sampleRate`
 *    on the exact 90 kHz rational (no per-frame rounding accumulation), and a PES without a PTS simply
 *    continues the chain. A *later* PES PTS only rebases the chain on a genuine discontinuity — a jump no
 *    cadence drift can explain ({@link REBASE_DISCONTINUITY_TICKS}); otherwise the monotonic cadence is
 *    kept, so a muxer's ±frame priming wobble does not derail the timeline (see {@link AdtsDeframer.#rebase});
 *  - drops frames that precede the first PTS anchor (they cannot be placed on the timeline — the same
 *    contract as PES-level demux) and drops a trailing partial frame at EOF (ffmpeg does the same, so
 *    packet counts match `ffprobe nb_read_packets`).
 *
 * Exported for direct, byte-level conformance testing of the resync / CRC / boundary-crossing / rebase
 * branches with synthetic ADTS the real corpus cannot deterministically exercise (ADR-184).
 */
export class AdtsDeframer {
  readonly units: TsAccessUnit[] = [];
  readonly ptsTicksList: number[] = [];
  #pending: Uint8Array | undefined;
  /**
   * Armed PES PTS anchors, ascending by `minOffset` (the scan-buffer offset a commencing frame must
   * reach to claim one). A queue — not a single slot — because a frame that crosses several small PES
   * packets leaves earlier anchors unconsumed while later PES packets arm new ones; each anchor must
   * survive until the frame commencing in *its* payload region appears. Bounded by the pending frame
   * size (≤ the 13-bit ADTS frame length), since anchors only accumulate while no frame completes.
   */
  #anchors: { minOffset: number; ticks: number }[] = [];
  /** The cadence chain: PTS ticks of the chain's base anchor + samples emitted since it. */
  #chainBaseTicks: number | undefined;
  #chainSamples = 0;
  #params: AdtsTrackParams | undefined;

  /** Geometry from the first valid ADTS header (undefined when no frame was ever found). */
  get params(): AdtsTrackParams | undefined {
    return this.#params;
  }

  /** Feed one reassembled PES payload (PTS in 90 kHz ticks; `undefined` continues the chain). */
  push(payload: Uint8Array, ptsTicks: number | undefined): void {
    const pendingLength = this.#pending?.byteLength ?? 0;
    if (ptsTicks !== undefined) {
      // The PTS names the first AU commencing in THIS payload (ISO/IEC 13818-1 §2.4.3.7), i.e. at or
      // after the pending tail. Offsets are ascending across pushes, so the queue stays sorted.
      this.#anchors.push({ minOffset: pendingLength, ticks: ptsTicks });
    }
    this.#scan(this.#pending === undefined ? payload : concatPending(this.#pending, payload));
  }

  /** End of stream: a still-incomplete trailing frame is unplayable and dropped. */
  finish(): void {
    this.#pending = undefined;
    this.#anchors = [];
  }

  /**
   * Apply a PES PTS anchor (90 kHz ticks) to the cadence chain at a frame that commences now. The very
   * first anchor starts the chain — the PES PTS names that first access unit. A later anchor rebases the
   * chain *only* on a genuine discontinuity: one whose PTS is further from the cadence-predicted value
   * than {@link REBASE_DISCONTINUITY_TICKS} (a splice / loop / reset). Otherwise the anchor is honoured by
   * keeping the running monotonic 1024-sample cadence — a broadcast muxer's or ffmpeg parser's ±frame
   * priming wobble does not reset the timeline. `sampleRate` is the commencing frame's own rate.
   */
  #rebase(anchorTicks: number, sampleRate: number): void {
    const base = this.#chainBaseTicks;
    if (base === undefined) {
      this.#chainBaseTicks = anchorTicks;
      this.#chainSamples = 0;
      return;
    }
    const predicted = base + (this.#chainSamples * TS_CLOCK_HZ) / sampleRate;
    if (Math.abs(anchorTicks - predicted) > REBASE_DISCONTINUITY_TICKS) {
      this.#chainBaseTicks = anchorTicks;
      this.#chainSamples = 0;
    }
  }

  /** Claim the newest anchor whose payload region covers a frame commencing at `off` (if any). */
  #consumeAnchor(off: number): number | undefined {
    let claimed: number | undefined;
    let taken = 0;
    for (const anchor of this.#anchors) {
      if (anchor.minOffset > off) break;
      claimed = anchor.ticks; // later anchors supersede earlier unconsumed ones
      taken++;
    }
    if (taken > 0) this.#anchors.splice(0, taken);
    return claimed;
  }

  #scan(work: Uint8Array): void {
    const n = work.byteLength;
    let i = 0;
    for (;;) {
      // Resync hunt: the next byte pair that could open a real header (0xFFF sync + layer '00').
      while (i < n) {
        if (work[i] === 0xff) {
          const b1 = work[i + 1];
          if (b1 === undefined || ((b1 & 0xf0) === 0xf0 && (b1 & 0x06) === 0)) break;
        }
        i++;
      }
      if (n - i < ADTS_FIXED_HEADER_LENGTH) break; // partial header candidate (or nothing) → pending
      const header = parseAdtsHeaderAt(work, i);
      if (header === undefined) {
        i++; // a false sync inside payload bytes: keep hunting
        continue;
      }
      // A validated frame COMMENCES here: rebase the cadence chain if a PES PTS claims this position
      // (even when the frame's tail is still in flight — the claim belongs to this frame).
      const anchorTicks = this.#consumeAnchor(i);
      if (anchorTicks !== undefined) this.#rebase(anchorTicks, header.params.sampleRate);
      if (i + header.frameLength > n) break; // frame continues in the next PES payload → pending
      this.#params ??= header.params;
      const base = this.#chainBaseTicks;
      if (base !== undefined) {
        const ticks = base + (this.#chainSamples * TS_CLOCK_HZ) / header.params.sampleRate;
        this.units.push({
          data: work.subarray(i + header.headerLength, i + header.frameLength),
          ptsUs: ticksToUs(ticks),
          dtsUs: ticksToUs(ticks), // audio has no reorder
          keyframe: true,
          // The on-disk packet is the WHOLE ADTS frame (header + optional CRC + payload); `data` above is
          // the bare AU, so carry the framed length for packet-size oracles (== ffprobe -show_packets size).
          sizeBytes: header.frameLength,
        });
        this.ptsTicksList.push(ticks);
        this.#chainSamples += header.samples;
      }
      i += header.frameLength;
    }
    this.#pending = i < n ? work.subarray(i) : undefined;
    if (i > 0) {
      for (const anchor of this.#anchors) anchor.minOffset = Math.max(0, anchor.minOffset - i);
    }
  }
}

/** Build the 2-byte AudioSpecificConfig (ISO/IEC 14496-3 §1.6.2.1) that `esds`/WebCodecs carry. */
function audioSpecificConfig(params: AdtsTrackParams): Uint8Array {
  return Uint8Array.of(
    ((params.objectType & 0x1f) << 3) | (params.samplingFrequencyIndex >> 1),
    ((params.samplingFrequencyIndex & 0x01) << 7) | ((params.channelConfiguration & 0x0f) << 3),
  );
}

/** Build the probe-facing WebCodecs config (dims for video; sampleRate/channels + ASC for audio). */
function configForStream(
  stream: TsStream,
  units: readonly TsAccessUnit[],
  adtsParams: AdtsTrackParams | undefined,
): VideoDecoderConfig | AudioDecoderConfig {
  if (stream.mediaType === 'video') {
    let dims: { width: number; height: number } | undefined;
    if (stream.codec === 'h264') {
      // A TS range can begin mid-GOP. The first complete AU then legitimately has no SPS; keep scanning
      // decode order until the next parameter-set repetition instead of publishing a false 0×0 config.
      for (const unit of units) {
        dims = h264Dimensions(unit.data);
        if (dims !== undefined) break;
      }
    }
    return { codec: stream.codec, codedWidth: dims?.width ?? 0, codedHeight: dims?.height ?? 0 };
  }
  if (adtsParams !== undefined) {
    // A `channel_configuration` of 0 means the layout rides in an in-band PCE: there is no honest
    // channel count or AudioSpecificConfig to declare, so downstream seams see the typed capability gap.
    const hasChannels =
      adtsParams.channelConfiguration >= 1 && adtsParams.channelConfiguration <= 7;
    return {
      codec: stream.codec,
      sampleRate: adtsParams.sampleRate,
      numberOfChannels: hasChannels ? adtsParams.channelConfiguration : 0,
      ...(hasChannels ? { description: audioSpecificConfig(adtsParams) } : {}),
    };
  }
  return {
    codec: stream.codec,
    sampleRate: 0,
    numberOfChannels: 0,
  };
}
