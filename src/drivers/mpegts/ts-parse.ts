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

// `VideoDecoderConfig`/`AudioDecoderConfig` are the global WebCodecs DOM types (as in `contracts/driver.ts`).

/** A transport packet is 188 bytes; m2ts/mts prepend a 4-byte timestamp (192), 204 adds RS parity. */
export type PacketSize = 188 | 192 | 204;
const PACKET_SIZES: readonly PacketSize[] = [188, 192, 204];
const SYNC_BYTE = 0x47;
/** The TS clock is 90 kHz; PTS/DTS are 33-bit values on it. */
export const TS_CLOCK_HZ = 90_000;
/** 2^33 — the PTS/DTS modulus, for unwrapping a single wraparound. */
const TS_PTS_MODULUS = 2 ** 33;

/** Well-known PIDs (ISO/IEC 13818-1 Table 2-3). */
const PID_PAT = 0x0000;
const PID_NULL = 0x1fff;

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

/** A reassembled PES payload (one access unit) with its WebCodecs-microsecond timestamps. */
export interface TsAccessUnit {
  /** The access-unit bytes (the PES payload — Annex-B for H.264, an ADTS frame for AAC). */
  data: Uint8Array;
  /** Presentation timestamp in microseconds (PTS), always present (we drop AUs without one). */
  ptsUs: number;
  /** Decode timestamp in microseconds; equals `ptsUs` when the PES carried no separate DTS. */
  dtsUs: number;
  keyframe: boolean;
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

// ── packet framing ──────────────────────────────────────────────────────────────────────────────

/**
 * Detect the packet size and the offset of the first whole packet. A TS has no header, so we look for a
 * column of sync bytes `0x47` spaced by one of 188/192/204: try each stride from each of the first few
 * candidate offsets and accept the first that holds for a run of packets. Returns `undefined` when no
 * stride yields a sync run — i.e. the bytes are not a transport stream (scrambled, encrypted, or garbage).
 */
export function detectFraming(
  bytes: Uint8Array,
): { packetSize: PacketSize; start: number; tsOffset: number } | undefined {
  // m2ts/mts put the 4-byte timestamp *before* the sync byte, so the sync sits at offset 4 within a
  // 192-byte packet; 188/204 sync at offset 0. `tsOffset` is where 0x47 lands inside one packet.
  const RUN = 8; // require this many consecutive in-stride sync bytes to lock on (rejects coincidences)
  for (const size of PACKET_SIZES) {
    const tsOffset = size === 192 ? 4 : 0;
    const scanLimit = Math.min(bytes.byteLength, size * 4);
    for (let base = 0; base + tsOffset < scanLimit; base++) {
      const first = base + tsOffset;
      if (bytes[first] !== SYNC_BYTE) continue;
      let ok = true;
      for (let k = 0; k < RUN; k++) {
        const at = first + k * size;
        if (at >= bytes.byteLength) {
          // Not enough bytes for a full run; accept only if we matched at least 2 packets (tiny inputs).
          ok = k >= 2;
          break;
        }
        if (bytes[at] !== SYNC_BYTE) {
          ok = false;
          break;
        }
      }
      if (ok) return { packetSize: size, start: base, tsOffset };
    }
  }
  return undefined;
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
  const b1 = bytes[off + 1] ?? 0;
  const b2 = bytes[off + 2] ?? 0;
  const b3 = bytes[off + 3] ?? 0;
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
    const afLen = bytes[cursor] ?? 0;
    if (afLen > 0) {
      const flags = bytes[cursor + 1] ?? 0;
      if ((flags & 0x10) !== 0 && afLen >= 7) {
        // PCR present: 33-bit base in bytes [cursor+2 .. +6] high bits, then a 9-bit extension.
        const a = bytes[cursor + 2] ?? 0;
        const c = bytes[cursor + 3] ?? 0;
        const d = bytes[cursor + 4] ?? 0;
        const e = bytes[cursor + 5] ?? 0;
        const f = bytes[cursor + 6] ?? 0;
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
  const sectionLength = (((section[1] ?? 0) & 0x0f) << 8) | (section[2] ?? 0);
  const end = Math.min(3 + sectionLength - 4, section.byteLength); // drop the 4-byte CRC
  const map = new Map<number, number>();
  // Program loop starts after the 8-byte section header (table_id..last_section_number).
  for (let i = 8; i + 4 <= end; i += 4) {
    const programNumber = ((section[i] ?? 0) << 8) | (section[i + 1] ?? 0);
    const pid = (((section[i + 2] ?? 0) & 0x1f) << 8) | (section[i + 3] ?? 0);
    if (programNumber !== 0) map.set(programNumber, pid); // program 0 = network PID, not a PMT
  }
  return map.size > 0 ? { programPmtPids: map } : undefined;
}

/** A registration/identifier descriptor can disambiguate PES-private (`stream_type 0x06`) payloads. */
function codecFromDescriptors(descriptors: Uint8Array): string | undefined {
  let i = 0;
  while (i + 2 <= descriptors.byteLength) {
    const tag = descriptors[i] ?? 0;
    const len = descriptors[i + 1] ?? 0;
    const body = descriptors.subarray(i + 2, i + 2 + len);
    if (tag === 0x05 && body.byteLength >= 4) {
      // registration_descriptor: a 4-char format_identifier (e.g. 'AC-3', 'Opus', 'EAC3').
      const id = String.fromCharCode(body[0] ?? 0, body[1] ?? 0, body[2] ?? 0, body[3] ?? 0);
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
  const sectionLength = (((section[1] ?? 0) & 0x0f) << 8) | (section[2] ?? 0);
  const end = Math.min(3 + sectionLength - 4, section.byteLength);
  const programInfoLength = (((section[10] ?? 0) & 0x0f) << 8) | (section[11] ?? 0);
  const streams: TsStream[] = [];
  let i = 12 + programInfoLength; // skip the program-level descriptor loop
  while (i + 5 <= end) {
    const streamType = section[i] ?? 0;
    const pid = (((section[i + 1] ?? 0) & 0x1f) << 8) | (section[i + 2] ?? 0);
    const esInfoLength = (((section[i + 3] ?? 0) & 0x0f) << 8) | (section[i + 4] ?? 0);
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
  const a = b[off] ?? 0;
  const c = b[off + 1] ?? 0;
  const d = b[off + 2] ?? 0;
  const e = b[off + 3] ?? 0;
  const f = b[off + 4] ?? 0;
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
  if (builder.chunks.length === 1) return builder.chunks[0] ?? new Uint8Array(0);
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
  if (pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) return undefined; // PES start_code prefix
  const streamId = pes[3] ?? 0;
  // Stream ids that have no PES header extension (and so no PTS): padding, private_2, and the various
  // map/info streams (ISO/IEC 13818-1 §2.4.3.7). Audio (0xC0..0xDF) and video (0xE0..0xEF) do.
  const isVideo = streamId >= 0xe0 && streamId <= 0xef;
  const isAudio = streamId >= 0xc0 && streamId <= 0xdf;
  if (!isVideo && !isAudio) return undefined;
  const ptsDtsFlags = ((pes[7] ?? 0) >> 6) & 0x3;
  const headerDataLength = pes[8] ?? 0;
  const payloadStart = 9 + headerDataLength;
  let pts: number | undefined;
  let dts: number | undefined;
  if ((ptsDtsFlags & 0x2) !== 0) pts = readPtsDts(pes, 9);
  if (ptsDtsFlags === 0x3) dts = readPtsDts(pes, 14);
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
      const nalType = (au[i + 3] ?? 0) & 0x1f;
      if (nalType === 5) return true; // IDR slice
      i += 2;
    }
  }
  return false;
}

/** True when an HEVC Annex-B access unit contains an IRAP NAL (types 16–23: BLA/IDR/CRA). */
function hevcHasIrap(au: Uint8Array): boolean {
  for (let i = 0; i + 4 < au.byteLength; i++) {
    if (au[i] === 0x00 && au[i + 1] === 0x00 && au[i + 2] === 0x01) {
      const nalType = ((au[i + 3] ?? 0) >> 1) & 0x3f;
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
  const first = unwrapped[0] ?? 0;
  const last = unwrapped[unwrapped.length - 1] ?? first;
  if (last - first <= 0) return undefined;
  const gaps: number[] = [];
  for (let i = 1; i < unwrapped.length; i++)
    gaps.push((unwrapped[i] ?? 0) - (unwrapped[i - 1] ?? 0));
  gaps.sort((x, y) => x - y);
  return { first, last, medianGap: gaps[gaps.length >> 1] ?? 0 };
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
  // Per-PID access units (decode order, as reassembled) plus the raw PTS list for duration.
  const unitsByPid = new Map<number, TsAccessUnit[]>();
  const ptsByPid = new Map<number, number[]>();
  let sawScrambled = false;
  let sawSync = false;

  const flush = (pid: number): void => {
    const builder = builders.get(pid);
    builders.delete(pid);
    const stream = streamsByPid.get(pid);
    if (!builder || !stream) return;
    const split = splitPes(flattenPes(builder));
    if (!split || split.pts === undefined) return; // no PTS → cannot place on the timeline; drop
    // One PES → one or many access units: a single AU for video, but one per ADTS frame for AAC audio
    // (an audio PES packs several frames), so the codec seam gets one EncodedChunk per real access unit.
    const { units, ptsTicksList } = accessUnitsFromPes(stream, split.payload, split.pts, split.dts);
    const list = unitsByPid.get(pid) ?? [];
    for (const u of units) list.push(u);
    unitsByPid.set(pid, list);
    const ptsList = ptsByPid.get(pid) ?? [];
    for (const p of ptsTicksList) ptsList.push(p);
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
    const span = ptsSpan(ptsByPid.get(stream.pid) ?? []);
    if (span) spanByPid.set(stream.pid, span);
  }
  const durationSec = containerDuration([...spanByPid.values()]);

  const tracks: TsTrack[] = [];
  for (const stream of streamsByPid.values()) {
    const units = unitsByPid.get(stream.pid) ?? [];
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
      config: configForStream(stream, units),
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
  const sps = findNal(au, (nal) => (nal[0] ?? 0) & 0x1f, 7);
  return sps ? parseH264Sps(sps) : undefined;
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
function parseH264Sps(nal: Uint8Array): { width: number; height: number } | undefined {
  // Strip emulation-prevention 0x03 bytes, then read past the 1-byte NAL header.
  const rbsp = stripEmulation(nal).subarray(1);
  const r = new BitReader(rbsp);
  try {
    r.u(8); // profile_idc
    r.u(8); // constraint flags + reserved
    r.u(8); // level_idc
    r.ue(); // seq_parameter_set_id
    const profileIdc = rbsp[0] ?? 0;
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
    out.push(nal[i] ?? 0);
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

/** Read AAC sampleRate/channels from an ADTS frame header (the AU on a 0x0f/0x11 PID). */
function aacParams(au: Uint8Array): { sampleRate: number; channels: number } | undefined {
  if ((au[0] ?? 0) !== 0xff || ((au[1] ?? 0) & 0xf0) !== 0xf0) return undefined; // ADTS syncword
  const sampleIndex = ((au[2] ?? 0) >> 2) & 0x0f;
  const sampleRate = AAC_SAMPLE_RATES[sampleIndex];
  const channels = (((au[2] ?? 0) & 0x01) << 2) | (((au[3] ?? 0) >> 6) & 0x03);
  if (sampleRate === undefined || channels === 0) return undefined;
  return { sampleRate, channels };
}

/** One ADTS frame carved from a PES payload: its bytes + its sample count + sample rate, for timing. */
interface AdtsFrame {
  data: Uint8Array;
  /** Decoded sample count for this frame (1024 × number_of_raw_data_blocks, AAC-LC = 1024). */
  samples: number;
  sampleRate: number;
}

/**
 * Split an AAC PES payload into its constituent ADTS frames. An audio PES carries **several** ADTS frames
 * (each its own access unit on the codec seam), so the demuxer must emit one `EncodedChunk` per frame —
 * not one per PES — to match the golden packet count + per-frame PTS. Each frame's length is the 13-bit
 * `aac_frame_length`; its duration is `samplesPerFrame / sampleRate`. A run that loses ADTS sync (a non-
 * `0xFFFx` byte where a frame should start) stops, returning the frames parsed so far (robust to garbage).
 */
function splitAdtsFrames(payload: Uint8Array): AdtsFrame[] {
  const frames: AdtsFrame[] = [];
  let i = 0;
  while (i + 7 <= payload.byteLength) {
    if ((payload[i] ?? 0) !== 0xff || ((payload[i + 1] ?? 0) & 0xf0) !== 0xf0) break; // ADTS syncword
    const frameLength =
      (((payload[i + 3] ?? 0) & 0x03) << 11) |
      ((payload[i + 4] ?? 0) << 3) |
      (((payload[i + 5] ?? 0) >> 5) & 0x07);
    if (frameLength < 7 || i + frameLength > payload.byteLength) break; // truncated / malformed frame
    const sampleIndex = ((payload[i + 2] ?? 0) >> 2) & 0x0f;
    const sampleRate = AAC_SAMPLE_RATES[sampleIndex] ?? 0;
    // number_of_raw_data_blocks_in_frame (byte 6, bits 0-1) + 1 blocks, each 1024 samples (AAC-LC).
    const blocks = ((payload[i + 6] ?? 0) & 0x03) + 1;
    frames.push({ data: payload.subarray(i, i + frameLength), samples: 1024 * blocks, sampleRate });
    i += frameLength;
  }
  return frames;
}

/**
 * Turn one reassembled PES into its access units with per-unit PTS/DTS (µs). For ADTS-framed audio (AAC)
 * the PES holds many frames, so we split and stamp each frame: PTS advances by the running sample count ÷
 * sample rate from the PES PTS, and audio has no reorder so DTS == PTS. For everything else (H.264/HEVC
 * video, and any audio we cannot frame-split) the whole PES payload is a single access unit with the
 * PES's own PTS/DTS (B-frame DTS preserved). Returns the raw PTS list too, so duration sees every unit.
 */
function accessUnitsFromPes(
  stream: TsStream,
  payload: Uint8Array,
  ptsTicks: number,
  dtsTicks: number | undefined,
): { units: TsAccessUnit[]; ptsTicksList: number[] } {
  if (stream.codec === 'aac') {
    const frames = splitAdtsFrames(payload);
    if (frames.length > 1) {
      const units: TsAccessUnit[] = [];
      const ptsTicksList: number[] = [];
      let sampleOffset = 0;
      for (const frame of frames) {
        // Frame PTS = PES PTS + (samples emitted so far / sampleRate), in 90 kHz ticks then µs.
        const offsetTicks =
          frame.sampleRate > 0 ? (sampleOffset * TS_CLOCK_HZ) / frame.sampleRate : 0;
        const framePts = ptsTicks + offsetTicks;
        units.push({
          data: frame.data,
          ptsUs: ticksToUs(framePts),
          dtsUs: ticksToUs(framePts),
          keyframe: true,
        });
        ptsTicksList.push(framePts);
        sampleOffset += frame.samples;
      }
      return { units, ptsTicksList };
    }
    // A single-frame (or unparseable) AAC PES falls through to the whole-payload path below.
  }
  return {
    units: [
      {
        data: payload,
        ptsUs: ticksToUs(ptsTicks),
        dtsUs: ticksToUs(dtsTicks ?? ptsTicks),
        keyframe: isKeyframe(stream.codec, stream.mediaType, payload),
      },
    ],
    ptsTicksList: [ptsTicks],
  };
}

/** Build the probe-facing WebCodecs config (dims for video; sampleRate/channels for audio). */
function configForStream(
  stream: TsStream,
  units: readonly TsAccessUnit[],
): VideoDecoderConfig | AudioDecoderConfig {
  const first = units[0]?.data;
  if (stream.mediaType === 'video') {
    const dims = first && stream.codec === 'h264' ? h264Dimensions(first) : undefined;
    return { codec: stream.codec, codedWidth: dims?.width ?? 0, codedHeight: dims?.height ?? 0 };
  }
  const params = first && (stream.codec === 'aac' ? aacParams(first) : undefined);
  return {
    codec: stream.codec,
    sampleRate: params?.sampleRate ?? 0,
    numberOfChannels: params?.channels ?? 0,
  };
}
