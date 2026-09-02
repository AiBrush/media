/**
 * The MP4 `Muxer` seam (docs/architecture/05 §2, 09 mux) over the validated byte-muxer ({@link writeMp4}).
 *
 * The contract is the WebCodecs `EncodedChunk` boundary: `addTrack` declares a track, `write` buffers
 * one encoded packet (in decode = arrival order), `finalize` serializes the whole MP4 and emits it on
 * `output`. This adapter is on the *encode* path — it has each track's WebCodecs `DecoderConfig`
 * (codec string + `description` + geometry), not a preserved raw codec box — so it synthesizes the
 * sample entry the way {@link writeMp4} does (`avcC`/`esds` from `description`), or carries the raw
 * config box verbatim for codecs whose box this writer does not synthesize.
 *
 * The packet→sample timing (the only non-trivial logic) is a pure, Node-testable helper
 * ({@link buildMuxSamples}); only the `write()` extraction of a *real* `EncodedChunk` (`copyTo`) is
 * browser-only and guarded. Build logic stays pure so the timing + round-trip are validated without
 * WebCodecs (see mux.test.ts).
 */

import { MPEG4_SAMPLE_RATES, parseAsc } from '../../codecs/aac-config.ts';
import { parseAv1Codec } from '../../codecs/av1-codec-string.ts';
import { parseVpxCodec } from '../../codecs/vpx-codec-string.ts';
import type {
  MuxOptions,
  MuxedTrackAudit,
  Muxer,
  Packet,
  TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { BUFFER_ALL_MAX_RETAINED_BYTES } from '../../internal/buffer-policy.ts';
import { positionedChunk } from '../../sinks/stream-target.ts';
import { throwIfSourceAborted } from '../../sources/abort.ts';
import { parseEsds } from './codec-strings.ts';
import { fragmentMp4 } from './fragment.ts';
import type { MuxSampleInput, MuxTrackInput } from './write.ts';
import { type ContainerBrand, planReservedMp4ByteStreamLayout, writeMp4 } from './write.ts';

/** The MPEG 90 kHz media clock — the default video timescale (divides 24/25/30/50/60 fps exactly). */
const DEFAULT_VIDEO_TIMESCALE = 90_000;
const MICROS_PER_SECOND = 1_000_000;

/** Every current MP4/MOV mux layout retains encoded payloads until `finalize()`. */
export const MP4_BUFFER_ALL_MAX_PAYLOAD_BYTES = BUFFER_ALL_MAX_RETAINED_BYTES;

/**
 * A decoded view of one `EncodedChunk` in container-neutral terms — the pure input to the timing model.
 * `durationUs` is optional because WebCodecs `Encoded*Chunk.duration` is nullable; a missing duration is
 * recovered from the presentation-timeline gaps (see {@link buildMuxSamples}).
 */
export interface ChunkStruct {
  /** Presentation timestamp (µs), from `chunk.timestamp`. */
  timestampUs: number;
  /** Sample duration (µs), from `chunk.duration`; `undefined` when the encoder omitted it. */
  durationUs: number | undefined;
  /** Sync sample? `chunk.type === 'key'`. */
  key: boolean;
  /** The packet bytes (owned copy). */
  data: Uint8Array;
  /**
   * Decode timestamp (µs), from the demuxer's {@link Packet.dtsUs} on a verbatim remux. When **every**
   * chunk carries it, {@link buildMuxSamples} lays the DTS timeline + composition offsets down from it
   * exactly (lossless B-frame preservation); `undefined` ⇒ recover DTS from arrival order/durations.
   */
  dtsUs?: number;
}

export interface Mp4PacketTrackInput {
  readonly track: TrackInfo;
  readonly chunks: readonly ChunkStruct[];
}

/** How a track's codec config is carried into {@link MuxTrackInput} once the sample entry is known. */
type ConfigKind =
  | { kind: 'avcC-from-description' } // video AVC: writeMp4 synthesizes `avcC` from `description`
  | { kind: 'esds-from-description' } // audio AAC: writeMp4 synthesizes `esds` from `description`
  | { kind: 'raw-box'; boxType: string }; // carry the description verbatim as this codec box

/**
 * Map a WebCodecs codec string to its ISO-BMFF sample-entry fourcc and how its config box is emitted.
 * AVC/AAC use {@link writeMp4}'s synthesis from `description`; other codecs carry the `description` as
 * their raw config box (`hvcC`/`av1C`/`vpcC`/`dOps`/`dfLa`) so the output box is correct rather than a
 * wrong `avcC`. An unknown codec is a typed capability miss, never a silently-malformed file.
 */
function mapCodec(
  mediaType: 'video' | 'audio',
  codec: string,
): { sampleEntryType: string; config: ConfigKind } {
  const c = codec.toLowerCase();
  if (mediaType === 'video') {
    if (c === 'h264' || c === 'avc' || c.startsWith('avc1') || c.startsWith('avc3')) {
      return { sampleEntryType: 'avc1', config: { kind: 'avcC-from-description' } };
    }
    if (c.startsWith('hev1') || c.startsWith('hvc1')) {
      return {
        sampleEntryType: c.startsWith('hev1') ? 'hev1' : 'hvc1',
        config: { kind: 'raw-box', boxType: 'hvcC' },
      };
    }
    if (c === 'av1' || c.startsWith('av01')) {
      return { sampleEntryType: 'av01', config: { kind: 'raw-box', boxType: 'av1C' } };
    }
    if (c.startsWith('vp09') || c.startsWith('vp9')) {
      return { sampleEntryType: 'vp09', config: { kind: 'raw-box', boxType: 'vpcC' } };
    }
  } else {
    if (c === 'mp3' || c === 'mp4a.40.34' || c === 'mp4a.6b' || c === 'mp4a.69') {
      return { sampleEntryType: 'mp4a', config: { kind: 'raw-box', boxType: 'esds' } };
    }
    if (c === 'aac' || c.startsWith('mp4a')) {
      return { sampleEntryType: 'mp4a', config: { kind: 'esds-from-description' } };
    }
    if (c.startsWith('opus')) {
      return { sampleEntryType: 'Opus', config: { kind: 'raw-box', boxType: 'dOps' } };
    }
    if (c.startsWith('flac')) {
      return { sampleEntryType: 'fLaC', config: { kind: 'raw-box', boxType: 'dfLa' } };
    }
  }
  throw new CapabilityError(`the mp4 muxer cannot write ${mediaType} codec '${codec}'`, {
    op: { kind: 'route', id: 'mux', facts: { mediaType, codec } },
    tried: ['mp4'],
  });
}

/** Video timescale: derive a clean clock from the frame rate when known, else the 90 kHz default. */
function videoTimescale(fps: number | undefined): number {
  if (fps !== undefined && Number.isFinite(fps) && fps > 0) {
    // A round fps (24/25/30/…) → an exact integer clock; durations still come from each chunk.
    return Math.round(fps) * 1000;
  }
  return DEFAULT_VIDEO_TIMESCALE;
}

/** Convert a WebCodecs `description` (an `ArrayBuffer`/`SharedArrayBuffer`/view) to an owned `Uint8Array`. */
function toBytes(src: AllowSharedBufferSource): Uint8Array {
  // A view (TypedArray / DataView) → copy its exact window; a raw buffer → copy the whole thing.
  if (ArrayBuffer.isView(src)) {
    return new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice();
  }
  return new Uint8Array(src).slice();
}

const AVC_NAL_LENGTH_SIZE = 4;
const H264_NAL_TYPE_SPS = 7;
const H264_NAL_TYPE_PPS = 8;
const AVC_MAX_SPS_COUNT = 31;
const AVC_MAX_PPS_COUNT = 255;
/** Operational ceiling for per-access-unit framing evidence; independent of candidate byte length. */
export const MP4_H264_MAX_NAL_UNITS_PER_ACCESS_UNIT = 65_536;
/** Total SPS/PPS bytes inspected while synthesizing one avcC record. */
export const MP4_H264_MAX_PARAMETER_SET_EVIDENCE_BYTES = 1024 * 1024;
const H264_ABORT_SCAN_INTERVAL_BYTES = 64 * 1024;

interface AvcPreparedSamples {
  readonly chunks: ChunkStruct[];
  readonly description: Uint8Array;
}

interface AacPreparedSamples {
  readonly chunks: ChunkStruct[];
  readonly description: Uint8Array;
}

interface H264ParameterSets {
  readonly sps: Uint8Array[];
  readonly pps: Uint8Array[];
  readonly spsByFingerprint: Map<string, Uint8Array[]>;
  readonly ppsByFingerprint: Map<string, Uint8Array[]>;
  evidenceBytes: number;
}

interface AacAdtsAccessUnit {
  readonly payload: Uint8Array;
  readonly objectType: number;
  readonly sampleRateIndex: number;
  readonly sampleRate: number;
  readonly channelConfig: number;
}

function startCodeLengthAt(data: Uint8Array, offset: number): 3 | 4 | undefined {
  if (offset + 3 > data.byteLength) return undefined;
  if (data[offset] !== 0 || data[offset + 1] !== 0) return undefined;
  if (data[offset + 2] === 1) return 3;
  if (offset + 4 <= data.byteLength && data[offset + 2] === 0 && data[offset + 3] === 1) return 4;
  return undefined;
}

function findStartCode(
  data: Uint8Array,
  from: number,
  signal?: AbortSignal,
): { offset: number; length: 3 | 4 } | undefined {
  const start = Math.max(0, from);
  let nextAbortCheck = start;
  for (let i = start; i + 3 <= data.byteLength; i++) {
    if (i >= nextAbortCheck) {
      throwIfSourceAborted(signal);
      nextAbortCheck = i + H264_ABORT_SCAN_INTERVAL_BYTES;
    }
    const length = startCodeLengthAt(data, i);
    if (length !== undefined) return { offset: i, length };
  }
  return undefined;
}

function assertH264NalUnitEvidenceCapacity(count: number): void {
  if (count <= MP4_H264_MAX_NAL_UNITS_PER_ACCESS_UNIT) return;
  throw new CapabilityError('H.264 access unit exceeds the in-memory NAL-evidence limit', {
    op: {
      kind: 'route',
      id: 'mp4-h264-access-unit-evidence',
      facts: {
        nalUnitCount: count,
        maximumNalUnitsPerAccessUnit: MP4_H264_MAX_NAL_UNITS_PER_ACCESS_UNIT,
      },
    },
    tried: ['mp4', 'mov'],
    suggestion: 'use conventionally framed H.264 access units with fewer NAL units',
  });
}

/** Split one Annex-B access unit into NAL unit payloads (start codes removed). */
function annexBNalUnits(data: Uint8Array, signal?: AbortSignal): Uint8Array[] | undefined {
  const first = findStartCode(data, 0, signal);
  if (first === undefined) return undefined;
  const out: Uint8Array[] = [];
  let startCodeCount = 1;
  assertH264NalUnitEvidenceCapacity(startCodeCount);
  let payloadOffset = first.offset + first.length;
  for (;;) {
    throwIfSourceAborted(signal);
    const next = findStartCode(data, payloadOffset, signal);
    let payloadEnd = next?.offset ?? data.byteLength;
    // Annex-B permits zero_byte/trailing_zero_8bits before the next start code; those are not NAL payload.
    let nextAbortCheck = payloadEnd;
    while (payloadEnd > payloadOffset && data[payloadEnd - 1] === 0) {
      if (payloadEnd <= nextAbortCheck) {
        throwIfSourceAborted(signal);
        nextAbortCheck = payloadEnd - H264_ABORT_SCAN_INTERVAL_BYTES;
      }
      payloadEnd--;
    }
    if (payloadEnd > payloadOffset) out.push(data.subarray(payloadOffset, payloadEnd));
    if (next === undefined) break;
    startCodeCount++;
    assertH264NalUnitEvidenceCapacity(startCodeCount);
    payloadOffset = next.offset + next.length;
  }
  return out.length > 0 ? out : undefined;
}

function h264NalType(nal: Uint8Array): number | undefined {
  if (nal.byteLength === 0) return undefined;
  return (nal[0] as number) & 0x1f;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function parameterSetFingerprint(nal: Uint8Array): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const byte of nal) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0;
  }
  return `${nal.byteLength}:${first}:${second}`;
}

function pushUniqueParameterSet(
  out: Uint8Array[],
  byFingerprint: Map<string, Uint8Array[]>,
  nal: Uint8Array,
  kind: 'SPS' | 'PPS',
  maximumCount: number,
  sets: H264ParameterSets,
): void {
  assertParameterSetLength(kind, nal);
  const fingerprint = parameterSetFingerprint(nal);
  const matches = byFingerprint.get(fingerprint);
  if (matches?.some((item) => equalBytes(item, nal)) === true) return;
  if (out.length >= maximumCount) {
    throw new MediaError(
      'mux-error',
      `too many H.264 ${kind} parameter sets for avcC (maximum ${maximumCount})`,
    );
  }
  const evidenceBytes = sets.evidenceBytes + nal.byteLength;
  if (
    !Number.isSafeInteger(evidenceBytes) ||
    evidenceBytes > MP4_H264_MAX_PARAMETER_SET_EVIDENCE_BYTES
  ) {
    throw new CapabilityError('H.264 parameter sets exceed the in-memory avcC-evidence limit', {
      op: {
        kind: 'route',
        id: 'mp4-h264-access-unit-evidence',
        facts: {
          parameterSetEvidenceBytes: evidenceBytes,
          maximumParameterSetEvidenceBytes: MP4_H264_MAX_PARAMETER_SET_EVIDENCE_BYTES,
        },
      },
      tried: ['mp4', 'mov'],
      suggestion: 'provide an avcC description or smaller H.264 parameter-set evidence',
    });
  }
  const copy = nal.slice();
  sets.evidenceBytes = evidenceBytes;
  out.push(copy);
  if (matches === undefined) byFingerprint.set(fingerprint, [copy]);
  else matches.push(copy);
}

function collectParameterSets(nalus: readonly Uint8Array[], sets: H264ParameterSets): void {
  for (const nal of nalus) {
    const type = h264NalType(nal);
    if (type !== H264_NAL_TYPE_SPS && type !== H264_NAL_TYPE_PPS) continue;
    if (type === H264_NAL_TYPE_SPS) {
      pushUniqueParameterSet(sets.sps, sets.spsByFingerprint, nal, 'SPS', AVC_MAX_SPS_COUNT, sets);
    } else {
      pushUniqueParameterSet(sets.pps, sets.ppsByFingerprint, nal, 'PPS', AVC_MAX_PPS_COUNT, sets);
    }
  }
}

function emptyH264ParameterSets(): H264ParameterSets {
  return {
    sps: [],
    pps: [],
    spsByFingerprint: new Map(),
    ppsByFingerprint: new Map(),
    evidenceBytes: 0,
  };
}

function writeU16(out: number[], value: number): void {
  out.push((value >>> 8) & 0xff, value & 0xff);
}

function assertParameterSetLength(kind: 'SPS' | 'PPS', nal: Uint8Array): void {
  if (nal.byteLength === 0 || nal.byteLength > 0xffff) {
    throw new MediaError('mux-error', `invalid H.264 ${kind} length ${nal.byteLength} for avcC`);
  }
}

function avcCFromParameterSets(sets: H264ParameterSets): Uint8Array {
  if (sets.sps.length === 0 || sets.pps.length === 0) {
    throw new CapabilityError(
      'H.264 MP4 muxing requires avcC description or Annex-B SPS/PPS parameter sets',
      {
        op: { kind: 'route', id: 'mux', facts: { mediaType: 'video', codec: 'h264' } },
        tried: ['mp4'],
      },
    );
  }
  if (sets.sps.length > AVC_MAX_SPS_COUNT || sets.pps.length > AVC_MAX_PPS_COUNT) {
    throw new MediaError(
      'mux-error',
      `too many H.264 parameter sets for avcC (${sets.sps.length} SPS, ${sets.pps.length} PPS)`,
    );
  }
  const firstSps = sets.sps[0];
  if (firstSps === undefined || firstSps.byteLength < 4) {
    throw new MediaError('mux-error', 'H.264 SPS is too short to synthesize avcC');
  }
  const out: number[] = [
    1,
    firstSps[1] as number,
    firstSps[2] as number,
    firstSps[3] as number,
    0xfc | (AVC_NAL_LENGTH_SIZE - 1),
    0xe0 | sets.sps.length,
  ];
  for (const sps of sets.sps) {
    assertParameterSetLength('SPS', sps);
    writeU16(out, sps.byteLength);
    out.push(...sps);
  }
  out.push(sets.pps.length);
  for (const pps of sets.pps) {
    assertParameterSetLength('PPS', pps);
    writeU16(out, pps.byteLength);
    out.push(...pps);
  }
  return new Uint8Array(out);
}

function lengthPrefixedAvcAccessUnit(nalus: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const nal of nalus) {
    if (nal.byteLength === 0)
      throw new MediaError('mux-error', 'empty H.264 NAL in Annex-B access unit');
    total += AVC_NAL_LENGTH_SIZE + nal.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const nal of nalus) {
    out[offset] = (nal.byteLength >>> 24) & 0xff;
    out[offset + 1] = (nal.byteLength >>> 16) & 0xff;
    out[offset + 2] = (nal.byteLength >>> 8) & 0xff;
    out[offset + 3] = nal.byteLength & 0xff;
    offset += AVC_NAL_LENGTH_SIZE;
    out.set(nal, offset);
    offset += nal.byteLength;
  }
  return out;
}

function copyChunkWithData(chunk: ChunkStruct, data: Uint8Array): ChunkStruct {
  return {
    timestampUs: chunk.timestampUs,
    durationUs: chunk.durationUs,
    key: chunk.key,
    data,
    ...(chunk.dtsUs !== undefined ? { dtsUs: chunk.dtsUs } : {}),
  };
}

function u16be(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function u24be(n: number): number[] {
  return [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function descriptor(tag: number, payload: readonly number[]): number[] {
  if (payload.length > 0x7f) {
    throw new MediaError('mux-error', `MP4 descriptor payload too large: ${payload.length}`);
  }
  return [tag, payload.length, ...payload];
}

function esdsPayloadForObjectType(objectTypeIndication: number): Uint8Array {
  const decoderConfig = descriptor(0x04, [
    objectTypeIndication,
    0x15, // AudioStream + upstream=false + reserved bit.
    ...u24be(0),
    ...u32be(0),
    ...u32be(0),
  ]);
  const es = descriptor(0x03, [0x00, 0x01, 0x00, ...decoderConfig]);
  return Uint8Array.from([0, 0, 0, 0, ...es]);
}

function av1CFromCodecString(codec: string): Uint8Array {
  const info = parseAv1Codec(codec);
  const highBitdepth = info.bitDepth > 8 ? 1 : 0;
  const twelveBit = info.bitDepth === 12 ? 1 : 0;
  const subsamplingX = info.chromaSubsampling === '420' || info.chromaSubsampling === '422' ? 1 : 0;
  const subsamplingY = info.chromaSubsampling === '420' ? 1 : 0;
  return Uint8Array.of(
    0x81,
    ((info.profile & 0x7) << 5) | (info.level & 0x1f),
    ((info.tier === 'high' ? 1 : 0) << 7) |
      (highBitdepth << 6) |
      (twelveBit << 5) |
      ((info.monochrome ? 1 : 0) << 4) |
      (subsamplingX << 3) |
      (subsamplingY << 2),
    0,
  );
}

function vp9LevelFromCodecString(codec: string): number {
  const normalized = codec.trim().toLowerCase();
  if (!normalized.startsWith('vp09.')) return 10;
  const fields = normalized.slice('vp09.'.length).split('.');
  const level = Number.parseInt(fields[1] ?? '', 10);
  return Number.isFinite(level) ? Math.max(0, Math.min(255, level)) : 10;
}

function vpcCFromCodecString(codec: string): Uint8Array {
  const info = parseVpxCodec(codec);
  if (info.codec !== 'vp9') {
    throw new MediaError('mux-error', `VP9 MP4 muxing received non-VP9 codec '${codec}'`);
  }
  return Uint8Array.of(
    1,
    0,
    0,
    0,
    info.profile & 0xff,
    vp9LevelFromCodecString(codec),
    ((info.bitDepth & 0x0f) << 4) | ((info.subsampling & 0x07) << 1),
    2,
    2,
    2,
    0,
    0,
  );
}

function isOpusHead(description: Uint8Array | undefined): description is Uint8Array {
  return (
    description !== undefined &&
    description.byteLength >= 19 &&
    String.fromCharCode(
      description[0] ?? 0,
      description[1] ?? 0,
      description[2] ?? 0,
      description[3] ?? 0,
      description[4] ?? 0,
      description[5] ?? 0,
      description[6] ?? 0,
      description[7] ?? 0,
    ) === 'OpusHead'
  );
}

function dOpsFromOpusHeadOrTrack(
  description: Uint8Array | undefined,
  channels: number | undefined,
  sampleRate: number | undefined,
): Uint8Array {
  const fallbackChannels = channels ?? 2;
  const fallbackRate = sampleRate ?? 48_000;
  if (fallbackChannels < 1 || fallbackChannels > 2) {
    throw new CapabilityError(
      `Opus MP4 muxing requires a family-0 mono/stereo channel layout, got ${fallbackChannels}`,
      {
        op: { kind: 'route', id: 'mux', facts: { mediaType: 'audio', codec: 'opus' } },
        tried: ['mp4'],
      },
    );
  }
  if (isOpusHead(description)) {
    const dv = new DataView(description.buffer, description.byteOffset, description.byteLength);
    const ch = dv.getUint8(9);
    const preSkip = dv.getUint16(10, true);
    const rate = dv.getUint32(12, true);
    const gain = dv.getInt16(16, true);
    const mapping = dv.getUint8(18);
    if (mapping !== 0 || ch < 1 || ch > 2) {
      throw new CapabilityError(
        'Opus MP4 muxing currently supports OpusHead mapping-family 0 mono/stereo tracks',
        {
          op: { kind: 'route', id: 'mux', facts: { mediaType: 'audio', codec: 'opus' } },
          tried: ['mp4'],
        },
      );
    }
    return Uint8Array.from([
      0,
      ch,
      ...u16be(preSkip),
      ...u32be(rate),
      ...u16be(gain & 0xffff),
      mapping,
    ]);
  }
  return Uint8Array.from([
    0,
    fallbackChannels,
    ...u16be(0),
    ...u32be(fallbackRate),
    ...u16be(0),
    0,
  ]);
}

function synthesizeRawBoxDescription(t: TrackState): Uint8Array | undefined {
  if (t.description !== undefined) return t.description;
  if (t.config.kind !== 'raw-box') return undefined;
  switch (t.config.boxType) {
    case 'av1C':
      return av1CFromCodecString(t.codec);
    case 'vpcC':
      return vpcCFromCodecString(t.codec);
    case 'dOps':
      return dOpsFromOpusHeadOrTrack(t.description, t.channels, t.sampleRate);
    case 'esds':
      return esdsPayloadForObjectType(0x6b);
    default:
      return undefined;
  }
}

/**
 * True iff `data` is a well-formed AVC-format (`avcC`) access unit: a sequence of `lengthSize`-byte
 * big-endian NAL lengths each followed by exactly that many payload bytes, consuming the buffer exactly.
 *
 * This is the disambiguator that fixes the avc-format-vs-Annex-B detection bug: an `avcC` access unit whose
 * 4-byte length prefix is ≤ 0x0000FFFF (e.g. a 501-byte NAL → `00 00 01 F5`) *contains* the byte pattern
 * `00 00 01`, so a naive Annex-B start-code scan ({@link annexBNalUnits}) would misparse it as Annex-B and
 * mangle the sample (the encoder/decoder then fails on the first such frame). When the caller already holds
 * the `avcC` `description`, the chunks are by definition length-prefixed; we verify that structurally here
 * and pass them through verbatim, only treating a chunk as Annex-B if it does NOT parse as length-prefixed.
 */
function isLengthPrefixedAvc(data: Uint8Array, lengthSize: number, signal?: AbortSignal): boolean {
  let pos = 0;
  let sawNal = false;
  let nalUnitCount = 0;
  while (pos + lengthSize <= data.byteLength) {
    throwIfSourceAborted(signal);
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = len * 256 + (data[pos + i] as number);
    if (len === 0) return false; // a zero-length NAL never occurs in a valid avcC AU
    nalUnitCount++;
    assertH264NalUnitEvidenceCapacity(nalUnitCount);
    pos += lengthSize + len;
    sawNal = true;
    if (pos > data.byteLength) return false; // a length overran the buffer ⇒ not length-prefixed
  }
  return sawNal && pos === data.byteLength; // consumed the buffer exactly ⇒ well-formed avcC AU
}

type AvcAccessUnitClassification =
  | { readonly kind: 'passthrough' }
  | { readonly kind: 'annex-b'; readonly nalus: readonly Uint8Array[] };

/** One source of truth for the AVC framing decision used by both final muxing and pre-publication audit. */
function classifyAvcAccessUnit(
  data: Uint8Array,
  description: Uint8Array | undefined,
  lengthSize: number,
  signal?: AbortSignal,
): AvcAccessUnitClassification {
  if (description !== undefined && isLengthPrefixedAvc(data, lengthSize, signal)) {
    return { kind: 'passthrough' };
  }
  const nalus = annexBNalUnits(data, signal);
  return nalus === undefined ? { kind: 'passthrough' } : { kind: 'annex-b', nalus };
}

function lengthPrefixedAvcAccessUnitByteLength(nalus: readonly Uint8Array[]): number {
  let byteLength = 0;
  for (const nal of nalus) {
    if (nal.byteLength === 0) {
      throw new MediaError('mux-error', 'empty H.264 NAL in Annex-B access unit');
    }
    byteLength += AVC_NAL_LENGTH_SIZE + nal.byteLength;
    if (!Number.isSafeInteger(byteLength)) {
      throw new MediaError('mux-error', 'H.264 access-unit size exceeds safe integer accounting');
    }
  }
  return byteLength;
}

function resolvedAvcDescription(
  description: Uint8Array | undefined,
  sawAnnexB: boolean,
  sets: H264ParameterSets,
): Uint8Array {
  if (description !== undefined) return description;
  if (!sawAnnexB) {
    throw new CapabilityError(
      'H.264 MP4 muxing requires avcC description or Annex-B access units with SPS/PPS',
      {
        op: { kind: 'route', id: 'mux', facts: { mediaType: 'video', codec: 'h264' } },
        tried: ['mp4'],
      },
    );
  }
  return avcCFromParameterSets(sets);
}

function prepareAvcSamples(
  chunks: readonly ChunkStruct[],
  description: Uint8Array | undefined,
): AvcPreparedSamples {
  const sets = emptyH264ParameterSets();
  let sawAnnexB = false;
  // With an `avcC` description, NAL length size = (lengthSizeMinusOne & 3) + 1 (byte 4 of avcC); default 4.
  const lengthSize =
    description !== undefined && description.byteLength > 4
      ? ((description[4] as number) & 0x03) + 1
      : AVC_NAL_LENGTH_SIZE;
  const normalized = chunks.map((chunk): ChunkStruct => {
    const classification = classifyAvcAccessUnit(chunk.data, description, lengthSize);
    if (classification.kind === 'passthrough') return chunk;
    sawAnnexB = true;
    if (description === undefined) collectParameterSets(classification.nalus, sets);
    return copyChunkWithData(chunk, lengthPrefixedAvcAccessUnit(classification.nalus));
  });
  return { chunks: normalized, description: resolvedAvcDescription(description, sawAnnexB, sets) };
}

function parseAdtsAccessUnit(data: Uint8Array): AacAdtsAccessUnit | undefined {
  if (data.byteLength < 7) return undefined;
  const b1 = data[1] as number;
  if (data[0] !== 0xff || (b1 & 0xf0) !== 0xf0) {
    return undefined;
  }
  if ((b1 & 0x06) !== 0) return undefined;
  const b2 = data[2] as number;
  const b3 = data[3] as number;
  const profile = (b2 >> 6) & 0x03;
  const sampleRateIndex = (b2 >> 2) & 0x0f;
  const channelConfig = ((b2 & 0x01) << 2) | (b3 >> 6);
  const sampleRate = MPEG4_SAMPLE_RATES[sampleRateIndex];
  if (sampleRate === undefined) return undefined;
  if (channelConfig < 1 || channelConfig > 7) return undefined;
  const frameLength =
    ((b3 & 0x03) << 11) | ((data[4] as number) << 3) | (((data[5] as number) >> 5) & 0x07);
  if (frameLength !== data.byteLength) return undefined;
  const headerBytes = (b1 & 0x01) === 1 ? 7 : 9;
  if (frameLength < headerBytes) return undefined;
  return {
    payload: data.subarray(headerBytes, frameLength),
    objectType: profile + 1,
    sampleRateIndex,
    sampleRate,
    channelConfig,
  };
}

function audioSpecificConfig(
  objectType: number,
  sampleRateIndex: number,
  channelConfig: number,
): Uint8Array {
  if (!Number.isInteger(objectType) || objectType < 1 || objectType > 31) {
    throw new CapabilityError('AAC MP4 muxing requires a representable MPEG-4 audio object type', {
      op: { kind: 'route', id: 'mux', facts: { mediaType: 'audio', codec: 'aac', objectType } },
      tried: ['mp4'],
    });
  }
  if (MPEG4_SAMPLE_RATES[sampleRateIndex] === undefined) {
    throw new CapabilityError(
      'AAC MP4 muxing requires a representable MPEG-4 sampling-frequency index',
      {
        op: {
          kind: 'route',
          id: 'mux',
          facts: { mediaType: 'audio', codec: 'aac', sampleRateIndex },
        },
        tried: ['mp4'],
      },
    );
  }
  if (!Number.isInteger(channelConfig) || channelConfig < 1 || channelConfig > 7) {
    throw new CapabilityError('AAC MP4 muxing requires a representable channel configuration', {
      op: { kind: 'route', id: 'mux', facts: { mediaType: 'audio', codec: 'aac', channelConfig } },
      tried: ['mp4'],
    });
  }
  return new Uint8Array([
    (objectType << 3) | (sampleRateIndex >> 1),
    ((sampleRateIndex & 0x01) << 7) | (channelConfig << 3),
  ]);
}

function assertSameAdtsConfig(first: AacAdtsAccessUnit, next: AacAdtsAccessUnit): void {
  if (
    first.objectType !== next.objectType ||
    first.sampleRateIndex !== next.sampleRateIndex ||
    first.channelConfig !== next.channelConfig
  ) {
    throw new MediaError(
      'mux-error',
      'AAC ADTS samples changed object type, sample rate, or channel layout within one MP4 track',
    );
  }
}

function assertAdtsMatchesDescription(adts: AacAdtsAccessUnit, description: Uint8Array): void {
  const asc = parseAsc(description);
  if (
    asc.objectType !== adts.objectType ||
    asc.sampleRate !== adts.sampleRate ||
    asc.channels !== adts.channelConfig
  ) {
    throw new MediaError(
      'mux-error',
      'AAC ADTS sample geometry does not match the track AudioSpecificConfig',
    );
  }
}

function isValidAsc(description: Uint8Array): boolean {
  try {
    const asc = parseAsc(description);
    return asc.objectType > 0 && asc.channels > 0 && asc.sampleRate > 0;
  } catch {
    return false;
  }
}

function ascFromEsdsPayload(payload: Uint8Array): Uint8Array | undefined {
  const info = parseEsds(payload);
  return info.asc !== undefined && isValidAsc(info.asc) ? info.asc : undefined;
}

function ascFromEsDescriptor(description: Uint8Array): Uint8Array | undefined {
  const payload = new Uint8Array(description.byteLength + 4);
  payload.set(description, 4);
  return ascFromEsdsPayload(payload);
}

function asciiAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] as number,
    bytes[offset + 1] as number,
    bytes[offset + 2] as number,
    bytes[offset + 3] as number,
  );
}

function normalizeAacDescription(description: Uint8Array): Uint8Array {
  if (isValidAsc(description)) return description;
  if (description[0] === 0x03) {
    const asc = ascFromEsDescriptor(description);
    if (asc !== undefined) return asc;
  }
  if (
    description.byteLength >= 5 &&
    description[0] === 0 &&
    description[1] === 0 &&
    description[2] === 0
  ) {
    const asc = ascFromEsdsPayload(description);
    if (asc !== undefined) return asc;
  }
  if (description.byteLength >= 12 && asciiAt(description, 4) === 'esds') {
    const size =
      (description[0] as number) * 0x1000000 +
      (description[1] as number) * 0x10000 +
      (description[2] as number) * 0x100 +
      (description[3] as number);
    if (size >= 12 && size <= description.byteLength) {
      const asc = ascFromEsdsPayload(description.subarray(8, size));
      if (asc !== undefined) return asc;
    }
  }
  throw new MediaError(
    'mux-error',
    'AAC MP4 muxing received an invalid AudioSpecificConfig description',
  );
}

function prepareAacSamples(
  chunks: readonly ChunkStruct[],
  description: Uint8Array | undefined,
): AacPreparedSamples {
  const normalizedDescription =
    description !== undefined ? normalizeAacDescription(description) : undefined;
  const parsed = chunks.map((chunk) => parseAdtsAccessUnit(chunk.data));
  const adtsCount = parsed.reduce((count, frame) => count + (frame === undefined ? 0 : 1), 0);
  if (adtsCount === 0) {
    if (normalizedDescription !== undefined)
      return { chunks: [...chunks], description: normalizedDescription };
    throw new CapabilityError(
      'AAC MP4 muxing requires AudioSpecificConfig description or ADTS-framed samples',
      {
        op: { kind: 'route', id: 'mux', facts: { mediaType: 'audio', codec: 'aac' } },
        tried: ['mp4'],
      },
    );
  }
  if (adtsCount !== chunks.length) {
    throw new MediaError('mux-error', 'AAC MP4 muxing cannot mix ADTS-framed and raw samples');
  }

  const first = parsed[0] as AacAdtsAccessUnit;
  if (normalizedDescription !== undefined)
    assertAdtsMatchesDescription(first, normalizedDescription);

  const normalized: ChunkStruct[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as ChunkStruct;
    const frame = parsed[i] as AacAdtsAccessUnit;
    assertSameAdtsConfig(first, frame);
    normalized.push(copyChunkWithData(chunk, frame.payload.slice()));
  }

  return {
    chunks: normalized,
    description:
      normalizedDescription ??
      audioSpecificConfig(first.objectType, first.sampleRateIndex, first.channelConfig),
  };
}

function ticks(us: number, timescale: number): number {
  return Math.round((us * timescale) / MICROS_PER_SECOND);
}

/**
 * Recover a per-sample duration (µs, decode order) when the encoder omitted `duration`: sort by
 * presentation time and take each frame's gap to the next presented frame (the last reuses the prior
 * gap). For a single sample the duration is 0. This keeps the DTS timeline contiguous under VFR.
 */
function recoverDurationsUs(chunks: readonly ChunkStruct[]): number[] {
  const n = chunks.length;
  const order = [...chunks.keys()].sort((a, b) => {
    const ca = chunks[a] as ChunkStruct;
    const cb = chunks[b] as ChunkStruct;
    return ca.timestampUs - cb.timestampUs;
  });
  const byDecode = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    const cur = order[k] as number;
    const next = order[k + 1];
    const curTs = (chunks[cur] as ChunkStruct).timestampUs;
    const gap = next !== undefined ? (chunks[next] as ChunkStruct).timestampUs - curTs : undefined;
    byDecode[cur] = gap ?? 0;
  }
  // The last-presented frame has no following gap; reuse the previous presented frame's duration.
  if (n >= 2) {
    const last = order[n - 1] as number;
    const prev = order[n - 2] as number;
    byDecode[last] = byDecode[prev] as number;
  }
  return byDecode;
}

/**
 * Restore one source-timed access-unit interval when independently trimmed adjacent segments were
 * concatenated by a caller that cannot retain a negative first DTS. That clamp creates a distinctive,
 * lossless timing signature: one interval grows by X, the next shrinks by the same X, and the declared
 * durations on both sides agree. Rebalancing only that complementary pair reconstructs the original
 * continuous packet clock; unrelated VFR gaps and stale duration fields remain DTS-authoritative.
 */
function sourceTimedDurationsUs(
  chunks: readonly ChunkStruct[],
  fallbackDurationsUs: readonly number[],
): number[] {
  const durations = chunks.map((chunk, index) => {
    const dts = chunk.dtsUs as number;
    const nextDts = chunks[index + 1]?.dtsUs;
    return nextDts !== undefined
      ? Math.max(0, nextDts - dts)
      : (fallbackDurationsUs[index] as number);
  });
  const toleranceUs = 2;
  for (let index = 0; index + 2 < chunks.length; index++) {
    const current = chunks[index] as ChunkStruct;
    const seamFirst = chunks[index + 1] as ChunkStruct;
    const following = chunks[index + 2] as ChunkStruct;
    const currentDeclared = current.durationUs;
    const seamDeclared = seamFirst.durationUs;
    const followingDeclared = following.durationUs;
    if (
      currentDeclared === undefined ||
      seamDeclared === undefined ||
      followingDeclared === undefined ||
      currentDeclared <= 0 ||
      seamDeclared <= 0 ||
      followingDeclared <= 0 ||
      Math.abs(currentDeclared - followingDeclared) > toleranceUs
    ) {
      continue;
    }
    const currentGap = durations[index] as number;
    const seamGap = durations[index + 1] as number;
    const excessUs = currentGap - currentDeclared;
    const deficitUs = followingDeclared - seamGap;
    if (
      excessUs <= toleranceUs ||
      deficitUs <= toleranceUs ||
      excessUs >= currentDeclared ||
      Math.abs(seamDeclared - seamGap) > toleranceUs ||
      Math.abs(excessUs - deficitUs) > toleranceUs
    ) {
      continue;
    }
    durations[index] = currentDeclared;
    durations[index + 1] = followingDeclared;
  }
  return durations;
}

/**
 * Convert buffered chunk-structs (decode order) into {@link MuxSampleInput}s with correct B-frame timing.
 *
 * The DTS timeline is the cumulative sum of durations in decode order. For monotonic video output,
 * adjacent PTS gaps are authoritative: WebCodecs may retain a stale nominal `duration` across a VFR gap,
 * and putting that discrepancy in `ctts` would fabricate picture reorder (eventually even DTS > PTS).
 * Audio instead preserves every declared coded-sample duration so authored gaps/overlaps remain
 * composition offsets rather than being silently stretched/shrunk. True reordered output retains its
 * decode-order duration path. Composition offset is computed in microseconds first —
 * `ctts = (PTS−base) − DTS` — so a non-reordered stream yields exactly zero at any timescale, while a
 * reordered (B-frame) stream carries the true offset (negative offsets are fine — {@link writeMp4} emits
 * a version-1 `ctts`). PTS is rebased to the minimum so a standalone file starts at t=0. Decode order is
 * preserved (samples are stored as arrived).
 */
export function buildMuxSamples(
  chunks: readonly ChunkStruct[],
  timescale: number,
  mediaType: 'video' | 'audio' = 'video',
): MuxSampleInput[] {
  const n = chunks.length;
  if (n === 0) return [];

  const hasAllDurations = chunks.every((c) => c.durationUs !== undefined);
  const presentationOrderIsDecodeOrder = chunks.every(
    (chunk, index) =>
      index === 0 || chunk.timestampUs >= (chunks[index - 1] as ChunkStruct).timestampUs,
  );
  const durationsUs = presentationOrderIsDecodeOrder
    ? chunks.map((chunk, index) => {
        const next = chunks[index + 1];
        if (mediaType === 'audio' && chunk.durationUs !== undefined) {
          const adjacentClockGap =
            next === undefined
              ? undefined
              : chunk.dtsUs !== undefined && next.dtsUs !== undefined
                ? next.dtsUs - chunk.dtsUs
                : next.timestampUs - chunk.timestampUs;
          // Independently rounded microsecond timestamps and durations may differ by one microsecond.
          // Keep the adjacent clock delta in that case so long audio runs do not accumulate ctts drift;
          // a larger mismatch is an authored discontinuity and the declared sample duration must win.
          if (adjacentClockGap === undefined || Math.abs(adjacentClockGap - chunk.durationUs) > 1) {
            return chunk.durationUs;
          }
          return adjacentClockGap;
        }
        if (next !== undefined) return next.timestampUs - chunk.timestampUs;
        if (chunk.durationUs !== undefined) return chunk.durationUs;
        return index === 0 ? 0 : chunk.timestampUs - (chunks[index - 1] as ChunkStruct).timestampUs;
      })
    : hasAllDurations
      ? chunks.map((c) => c.durationUs as number)
      : recoverDurationsUs(chunks);

  // Verbatim-video/remux fast path: every packet carries the source's true decode timestamp (the demuxer read
  // it from `stts`). Lay the composition offset down as the exact (PTS − DTS), and derive each sample's
  // duration from the gap to the next DTS so writeMp4's cumulative-sum `stts` reconstructs the source
  // decode timeline 1:1 — preserving the original B-frame/open-GOP structure losslessly (ADR-045). The
  // chunks arrive in decode order, so DTS is monotonic and every gap is ≥ 0.
  // Audio has no inter-frame decode dependency. When it supplies explicit durations, preserve its
  // authored PTS/duration discontinuities on a contiguous MP4 decode clock instead of stretching stts
  // deltas merely to reproduce redundant source DTS values.
  if (chunks.every((c) => c.dtsUs !== undefined) && !(mediaType === 'audio' && hasAllDurations)) {
    const sourceDurationsUs = sourceTimedDurationsUs(chunks, durationsUs);
    const out: MuxSampleInput[] = [];
    let durationBoundaryUs = 0;
    let durationBoundaryTicks = 0;
    for (let i = 0; i < n; i++) {
      const c = chunks[i] as ChunkStruct;
      const dts = c.dtsUs as number;
      const durUs = sourceDurationsUs[i] as number;
      durationBoundaryUs += durUs;
      const nextDurationBoundaryTicks = ticks(durationBoundaryUs, timescale);
      out.push({
        data: c.data,
        // Quantize source-timed boundaries, not every interval independently. At clocks such as
        // 44.1 kHz, independently rounding Matroska's alternating 23/24 ms AAC gaps loses a fraction
        // of a tick on nearly every packet and turns harmless local quantization into cumulative drift.
        durationTicks: nextDurationBoundaryTicks - durationBoundaryTicks,
        cttsTicks: ticks(c.timestampUs - dts, timescale),
        keyframe: c.key,
      });
      durationBoundaryTicks = nextDurationBoundaryTicks;
    }
    return out;
  }

  let baseUs = Number.POSITIVE_INFINITY;
  for (const c of chunks) if (c.timestampUs < baseUs) baseUs = c.timestampUs;

  const out: MuxSampleInput[] = [];
  let dtsUs = 0;
  for (let i = 0; i < n; i++) {
    const c = chunks[i] as ChunkStruct;
    const durUs = durationsUs[i] as number;
    const cttsUs = c.timestampUs - baseUs - dtsUs;
    out.push({
      data: c.data,
      durationTicks: ticks(durUs, timescale),
      cttsTicks: ticks(cttsUs, timescale),
      keyframe: c.key,
    });
    dtsUs += durUs;
  }
  return out;
}

/** Per-track recording state, accumulated across `addTrack`/`write` until `finalize`. */
export interface TrackState {
  readonly mediaType: 'video' | 'audio';
  readonly codec: string;
  readonly sampleEntryType: string;
  readonly config: ConfigKind;
  readonly timescale: number;
  readonly description: Uint8Array | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly rotation: number | undefined;
  readonly colr: MuxTrackInput['colr'];
  readonly sampleRate: number | undefined;
  readonly channels: number | undefined;
  gapless: TrackInfo['gapless'];
  readonly chunks: ChunkStruct[];
}

function mp4GaplessFromTrack(
  info: TrackInfo,
  sampleRate: number | undefined,
  config: ConfigKind,
): TrackInfo['gapless'] {
  if (info.gapless !== undefined) return info.gapless;
  if (
    info.mediaType !== 'audio' ||
    config.kind !== 'esds-from-description' ||
    sampleRate === undefined ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    info.codecDelayNs === undefined ||
    !Number.isFinite(info.codecDelayNs) ||
    info.codecDelayNs <= 0
  ) {
    return undefined;
  }
  const leadingSamples = Math.round((info.codecDelayNs * sampleRate) / 1_000_000_000);
  return Number.isSafeInteger(leadingSamples) && leadingSamples > 0
    ? { leadingSamples }
    : undefined;
}

/** Codec priming is not a negative program origin when comparing source-timed track starts. */
export function trackPresentationDelayUs(track: TrackState): number {
  const leadingSamples = track.gapless?.leadingSamples;
  const sampleRate = track.sampleRate;
  if (
    track.mediaType !== 'audio' ||
    track.sampleEntryType !== 'mp4a' ||
    leadingSamples === undefined ||
    !Number.isFinite(leadingSamples) ||
    leadingSamples <= 0 ||
    sampleRate === undefined ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    return 0;
  }
  return (leadingSamples * MICROS_PER_SECOND) / sampleRate;
}

function h273CodePoint(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 0xffff
    ? value
    : undefined;
}

/**
 * Translate exact container-neutral H.273 facts into an ISO-BMFF `colr` declaration. Matroska and
 * nclc/nclx use the same numeric primaries/transfer/matrix code points, so known values cross the
 * container boundary losslessly. Missing fields become H.273 "unspecified" (2), never a guessed colour
 * space. Only Matroska range values 1/2 have an exact nclx flag representation; otherwise nclc retains
 * the three colour code points without asserting a range that the source did not declare.
 */
function mp4ColrFromTrackColor(color: TrackInfo['color']): MuxTrackInput['colr'] {
  if (color === undefined) return undefined;
  const primaries = h273CodePoint(color.primaries);
  const transfer = h273CodePoint(color.transferCharacteristics);
  const matrix = h273CodePoint(color.matrixCoefficients);
  const exactRange = color.range === 1 || color.range === 2 ? color.range : undefined;
  if (
    primaries === undefined &&
    transfer === undefined &&
    matrix === undefined &&
    exactRange === undefined
  ) {
    return undefined;
  }
  return exactRange === undefined
    ? {
        colourType: 'nclc',
        primaries: primaries ?? 2,
        transfer: transfer ?? 2,
        matrix: matrix ?? 2,
      }
    : {
        colourType: 'nclx',
        primaries: primaries ?? 2,
        transfer: transfer ?? 2,
        matrix: matrix ?? 2,
        fullRange: exactRange === 2,
      };
}

/** Resolve geometry/config fields from a track's WebCodecs `DecoderConfig` (narrowed by `mediaType`). */
export function trackStateFrom(info: TrackInfo): TrackState {
  const { sampleEntryType, config } = mapCodec(info.mediaType, info.codec);
  const decoderConfig = info.config;
  const description =
    decoderConfig?.description !== undefined ? toBytes(decoderConfig.description) : undefined;

  if (info.mediaType === 'video') {
    const vc = decoderConfig as VideoDecoderConfig | undefined;
    return {
      mediaType: 'video',
      codec: info.codec,
      sampleEntryType,
      config,
      timescale: videoTimescale(info.fps),
      description,
      width: vc?.codedWidth,
      height: vc?.codedHeight,
      rotation: info.rotation,
      colr: mp4ColrFromTrackColor(info.color),
      sampleRate: undefined,
      channels: undefined,
      gapless: undefined,
      chunks: [],
    };
  }
  const ac = decoderConfig as AudioDecoderConfig | undefined;
  const sampleRate = ac?.sampleRate;
  return {
    mediaType: 'audio',
    codec: info.codec,
    sampleEntryType,
    config,
    // Audio clock = sample rate (sample durations map 1:1 to ticks); 48 kHz is a safe default.
    timescale: sampleRate !== undefined && sampleRate > 0 ? sampleRate : 48_000,
    description,
    width: undefined,
    height: undefined,
    rotation: undefined,
    colr: undefined,
    sampleRate,
    channels: ac?.numberOfChannels,
    gapless: mp4GaplessFromTrack(info, sampleRate, config),
    chunks: [],
  };
}

/**
 * Project one H.264 candidate through the exact buffered MP4/MOV sample preparation used at finalize.
 * The iterable lets browser callers copy/inspect one sealed EncodedVideoChunk at a time rather than
 * materializing a second whole-candidate byte array. Payload framing shares {@link classifyAvcAccessUnit};
 * timing shares {@link buildMuxSamples} and the exact fps-derived track timescale from {@link trackStateFrom}.
 */
export function auditMp4H264MuxedTrack(
  info: TrackInfo,
  chunks: Iterable<ChunkStruct>,
  options?: MuxOptions,
  signal?: AbortSignal,
): MuxedTrackAudit {
  throwIfSourceAborted(signal);
  const state = trackStateFrom(info);
  if (state.mediaType !== 'video' || state.sampleEntryType !== 'avc1') {
    throw new CapabilityError('MP4 H.264 candidate audit requires one AVC video track', {
      op: {
        kind: 'route',
        id: 'h264-quality-output-audit',
        facts: { mediaType: state.mediaType, sampleEntryType: state.sampleEntryType },
      },
      tried: ['mp4', 'mov'],
    });
  }

  const sets = emptyH264ParameterSets();
  let sawAnnexB = false;
  let elementaryPayloadBytes = 0;
  const preparedSampleByteLengths: number[] = [];
  const timingChunks: ChunkStruct[] = [];
  const emptySampleData = new Uint8Array(0);
  const description = state.description;
  const lengthSize =
    description !== undefined && description.byteLength > 4
      ? ((description[4] as number) & 0x03) + 1
      : AVC_NAL_LENGTH_SIZE;

  for (const chunk of chunks) {
    throwIfSourceAborted(signal);
    const classification = classifyAvcAccessUnit(chunk.data, description, lengthSize, signal);
    let preparedByteLength = chunk.data.byteLength;
    if (classification.kind === 'annex-b') {
      sawAnnexB = true;
      if (description === undefined) collectParameterSets(classification.nalus, sets);
      preparedByteLength = lengthPrefixedAvcAccessUnitByteLength(classification.nalus);
    }
    elementaryPayloadBytes += preparedByteLength;
    if (!Number.isSafeInteger(elementaryPayloadBytes)) {
      throw new MediaError('mux-error', 'H.264 candidate payload exceeds safe integer accounting');
    }
    preparedSampleByteLengths.push(preparedByteLength);
    timingChunks.push({
      timestampUs: chunk.timestampUs,
      durationUs: chunk.durationUs,
      key: chunk.key,
      data: emptySampleData,
      ...(chunk.dtsUs !== undefined ? { dtsUs: chunk.dtsUs } : {}),
    });
  }
  throwIfSourceAborted(signal);

  const sampleCount = timingChunks.length;
  if (sampleCount === 0 || elementaryPayloadBytes <= 0) {
    throw new MediaError('mux-error', 'H.264 candidate audit requires positive sample evidence');
  }
  // Perform the same final framing validation as prepareAvcSamples even though the audit needs only sizes.
  resolvedAvcDescription(description, sawAnnexB, sets);
  const samples = buildMuxSamples(timingChunks, state.timescale);
  if (samples.length !== sampleCount) {
    throw new MediaError('mux-error', 'H.264 candidate audit lost MP4 sample evidence');
  }

  let dtsTicks = 0;
  let minimumPtsTicks = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const ptsTicks = dtsTicks + sample.cttsTicks;
    if (ptsTicks < minimumPtsTicks) minimumPtsTicks = ptsTicks;
    dtsTicks += sample.durationTicks;
  }
  if (!Number.isFinite(minimumPtsTicks)) {
    throw new MediaError('mux-error', 'H.264 candidate audit has no presentation origin');
  }
  const ticksToUs = (value: number): number =>
    Math.round((value * MICROS_PER_SECOND) / state.timescale);
  let minimumPtsUs = Number.POSITIVE_INFINITY;
  let maximumEndUs = Number.NEGATIVE_INFINITY;
  dtsTicks = 0;
  for (const sample of samples) {
    // Progressive MP4 neutral demux rebases the complete sample table in ticks. Fragmented neutral demux
    // reads each trun/tfdt PTS first and the rate oracle subtracts the rounded-µs minimum afterward.
    const ptsTicks = dtsTicks + sample.cttsTicks;
    const ptsUs = ticksToUs(options?.fragmented === true ? ptsTicks : ptsTicks - minimumPtsTicks);
    const durationUs = ticksToUs(sample.durationTicks);
    if (durationUs <= 0) {
      throw new MediaError('mux-error', 'H.264 candidate duration vanishes at the MP4 timescale');
    }
    if (ptsUs < minimumPtsUs) minimumPtsUs = ptsUs;
    const endUs = ptsUs + durationUs;
    if (endUs > maximumEndUs) maximumEndUs = endUs;
    dtsTicks += sample.durationTicks;
  }
  const presentationSpanUs = maximumEndUs - minimumPtsUs;
  if (!Number.isSafeInteger(presentationSpanUs) || presentationSpanUs <= 0) {
    throw new MediaError('mux-error', 'H.264 candidate MP4 presentation span is not representable');
  }
  return Object.freeze({
    elementaryPayloadBytes,
    preparedSampleByteLengths: Object.freeze(preparedSampleByteLengths),
    presentationSpanUs,
    sampleCount,
  });
}

/** ContainerDriver capability implementation over the same sealed-packet seam as {@link Mp4Muxer.write}. */
export function auditMp4H264MuxedPackets(
  info: TrackInfo,
  packets: Iterable<Packet>,
  options?: MuxOptions,
  signal?: AbortSignal,
): MuxedTrackAudit {
  const chunks: Iterable<ChunkStruct> = {
    *[Symbol.iterator](): Iterator<ChunkStruct> {
      for (const packet of packets) {
        const chunk = packet.chunk;
        yield {
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? undefined,
          key: chunk.type === 'key',
          data: packetBytes(packet),
          ...(packet.dtsUs !== undefined ? { dtsUs: packet.dtsUs } : {}),
        };
      }
    },
  };
  return auditMp4H264MuxedTrack(info, chunks, options, signal);
}

interface GaplessMuxLayout {
  samples: MuxSampleInput[];
  edit?: MuxTrackInput['edit'];
}

function clampSamplesToDuration(
  samples: readonly MuxSampleInput[],
  targetDurationTicks: number,
): MuxSampleInput[] {
  const out: MuxSampleInput[] = [];
  let remaining = targetDurationTicks;
  for (const sample of samples) {
    if (remaining <= 0) break;
    if (sample.durationTicks <= remaining) {
      out.push(sample);
      remaining -= sample.durationTicks;
      continue;
    }
    out.push({ ...sample, durationTicks: remaining });
    remaining = 0;
  }
  return out;
}

function gaplessLayoutFor(t: TrackState, samples: readonly MuxSampleInput[]): GaplessMuxLayout {
  const sampleRate = t.sampleRate ?? t.timescale;
  if (
    t.mediaType !== 'audio' ||
    t.sampleEntryType !== 'mp4a' ||
    t.gapless === undefined ||
    sampleRate <= 0
  ) {
    return { samples: [...samples] };
  }
  // AAC and MP3-in-MP4 both author the `mp4a` sample entry (mux.ts maps mp3/mp4a.6b/mp4a.40.34 to
  // 'mp4a'), so this gate covers every codec whose presentation trimming is expressed through `elst`.
  // Entries that carry decoder-side trimming themselves (Opus `dOps` pre-skip, FLAC `dfLa`) must NOT
  // be elst-trimmed on top, or the program duration drifts from the source (webm→mp4 copy rows).

  const rawDurationTicks = samples.reduce((total, sample) => total + sample.durationTicks, 0);
  const leadingSamples =
    t.gapless.leadingSamples !== undefined &&
    Number.isFinite(t.gapless.leadingSamples) &&
    t.gapless.leadingSamples >= 0
      ? t.gapless.leadingSamples
      : undefined;
  const trailingSamples =
    t.gapless.trailingSamples !== undefined &&
    Number.isFinite(t.gapless.trailingSamples) &&
    t.gapless.trailingSamples >= 0
      ? t.gapless.trailingSamples
      : undefined;
  const declaredTotalSamples =
    t.gapless.totalSamples !== undefined &&
    Number.isFinite(t.gapless.totalSamples) &&
    t.gapless.totalSamples > 0
      ? t.gapless.totalSamples
      : undefined;
  const rawDecodedSamples = Math.round((rawDurationTicks * sampleRate) / t.timescale);
  const totalSamples =
    declaredTotalSamples ??
    (leadingSamples !== undefined || trailingSamples !== undefined
      ? rawDecodedSamples - (leadingSamples ?? 0) - (trailingSamples ?? 0)
      : undefined);
  if (totalSamples === undefined || !Number.isFinite(totalSamples) || totalSamples <= 0) {
    return { samples: [...samples] };
  }
  const durationTicks = Math.round((totalSamples * t.timescale) / sampleRate);
  if (durationTicks <= 0 || durationTicks > rawDurationTicks) return { samples: [...samples] };

  const requestedMediaTime =
    leadingSamples !== undefined
      ? Math.round((leadingSamples * t.timescale) / sampleRate)
      : trailingSamples !== undefined
        ? 0
        : rawDurationTicks - durationTicks;
  const maxMediaTime = rawDurationTicks - durationTicks;
  const mediaTimeTicks = Math.min(Math.max(0, requestedMediaTime), maxMediaTime);
  const targetDurationTicks = mediaTimeTicks + durationTicks;
  return {
    // Source-proven gapless facts describe a presentation window over an already-authored coded
    // timeline. Preserve every coded access unit and express its leading/trailing trim exclusively
    // through `elst`; shortening the last sample here mutates packet-copy timing. Destination
    // encoder timing has no basis and may still need its excess coded tail bounded to the declared
    // submitted program window.
    samples:
      t.gapless.basis === undefined
        ? clampSamplesToDuration(samples, targetDurationTicks)
        : [...samples],
    edit: { mediaTimeTicks, durationTicks },
  };
}

/** Turn a finalized {@link TrackState} into the {@link MuxTrackInput} {@link writeMp4} consumes. */
export function toMuxTrack(t: TrackState, leadingEmptyUs = 0): MuxTrackInput {
  const prepared =
    t.mediaType === 'video' && t.sampleEntryType === 'avc1'
      ? prepareAvcSamples(t.chunks, t.description)
      : t.mediaType === 'audio' && t.config.kind === 'esds-from-description'
        ? prepareAacSamples(t.chunks, t.description)
        : { chunks: t.chunks, description: t.description };
  const gaplessLayout = gaplessLayoutFor(
    t,
    buildMuxSamples(prepared.chunks, t.timescale, t.mediaType),
  );
  const { samples, edit } = gaplessLayout;
  const leadingEmptyDurationTicks = ticks(Math.max(0, leadingEmptyUs), t.timescale);
  const muxEdit =
    leadingEmptyDurationTicks > 0
      ? {
          ...(edit ?? {
            mediaTimeTicks: 0,
            durationTicks: samples.reduce((total, sample) => total + sample.durationTicks, 0),
          }),
          leadingEmptyDurationTicks,
        }
      : edit;
  const base = {
    mediaType: t.mediaType,
    sampleEntryType: t.sampleEntryType,
    timescale: t.timescale,
    samples,
    ...(t.width !== undefined ? { width: t.width } : {}),
    ...(t.height !== undefined ? { height: t.height } : {}),
    ...(t.rotation !== undefined ? { rotation: t.rotation } : {}),
    ...(t.colr !== undefined ? { colr: t.colr } : {}),
    ...(t.sampleRate !== undefined ? { sampleRate: t.sampleRate } : {}),
    ...(t.channels !== undefined ? { channels: t.channels } : {}),
    ...(muxEdit !== undefined ? { edit: muxEdit } : {}),
    // A newly encoded AAC stream has destination priming that must be declared explicitly; `elst`
    // selects its program window and `roll` prevents readers from applying a historical implicit delay.
    // A packet-copied MP4 edit list is source metadata, not proof that we may invent a new roll group.
    ...(gaplessLayout.edit !== undefined &&
    t.config.kind === 'esds-from-description' &&
    t.gapless?.basis !== 'mp4-edit-list' &&
    (t.gapless?.leadingSamples ?? 0) > 0
      ? { rollDistance: -1 }
      : {}),
  };
  if (t.config.kind === 'raw-box') {
    const description = prepared.description ?? synthesizeRawBoxDescription(t);
    if (description === undefined) {
      throw new CapabilityError(
        `${t.sampleEntryType} MP4 muxing requires ${t.config.boxType} description`,
        {
          op: {
            kind: 'route',
            id: 'mux',
            facts: { mediaType: t.mediaType, codec: t.sampleEntryType },
          },
          tried: ['mp4'],
        },
      );
    }
    return { ...base, codecPrivate: { boxType: t.config.boxType, data: description } };
  }
  // Config box: AVC/AAC synthesize from `description`; other codecs carry it as their raw box.
  if (prepared.description === undefined) return base;
  return { ...base, description: prepared.description };
}

/**
 * `Muxer` over {@link writeMp4}: buffers each track's packets and serializes the whole MP4 on
 * {@link finalize}, emitting it on {@link output}. Single-shot — `addTrack`/`write` after `finalize`,
 * and a second `finalize`, are typed misuse (`mux-error`). `output` carries the finalized bytes (one
 * chunk) and is `error()`d if finalization fails, so failures surface on the reader (doc 05 §3).
 */
export class Mp4Muxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  readonly #tracks = new Map<number, TrackState>();
  readonly #faststart: boolean | 'reserve';
  readonly #maximumPacketCount: number | undefined;
  readonly #fragmented: boolean;
  readonly #brand: ContainerBrand;
  readonly #driverId: 'mp4' | 'mp4-mux';
  #nextId = 1;
  #bufferedPayloadBytes = 0;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions, driverId: 'mp4' | 'mp4-mux' = 'mp4') {
    // Fragmented/CMAF output (ADR-034): finalize emits an init segment + one media segment per fragment
    // via {@link fragmentMp4}, instead of the single faststart `moov`+`mdat` from {@link writeMp4}.
    this.#fragmented = options?.fragmented === true;
    this.#faststart = options?.faststart ?? true;
    this.#maximumPacketCount = options?.maximumPacketCount;
    if (this.#faststart === 'reserve') {
      if (!Number.isSafeInteger(this.#maximumPacketCount) || (this.#maximumPacketCount ?? 0) < 1) {
        throw new MediaError(
          'mux-error',
          "MP4 faststart:'reserve' requires a positive integer maximumPacketCount",
        );
      }
      if (this.#fragmented) {
        throw new MediaError(
          'mux-error',
          "MP4 faststart:'reserve' cannot be combined with fragmented output",
        );
      }
    } else if (this.#maximumPacketCount !== undefined) {
      throw new MediaError(
        'mux-error',
        "MP4 maximumPacketCount is valid only with faststart:'reserve'",
      );
    }
    this.#brand = options?.container === 'mov' || options?.container === 'qt' ? 'mov' : 'mp4';
    this.#driverId = driverId;
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        this.#resolveReady?.();
      },
    });
  }

  addTrack(info: TrackInfo): number {
    this.#assertOpen();
    const id = this.#nextId++;
    this.#tracks.set(id, trackStateFrom(info));
    return id;
  }

  /** Attach destination encoder timing learned after the encoded stream drained, before finalization. */
  setTrackGapless(trackId: number, gapless: NonNullable<TrackInfo['gapless']>): void {
    this.#assertOpen();
    const track = this.#tracks.get(trackId);
    if (track === undefined) {
      throw new MediaError('mux-error', `set gapless timing on unknown track ${trackId}`);
    }
    if (track.mediaType !== 'audio') {
      throw new MediaError('mux-error', `set gapless timing on non-audio track ${trackId}`);
    }
    track.gapless = { ...gapless };
  }

  /**
   * Buffer one encoded packet on its track (decode = arrival order). Extracting the bytes/timing from a
   * real `EncodedVideoChunk`/`EncodedAudioChunk` (`copyTo`) is the only browser-only step (guarded); the
   * resulting struct flows through the pure {@link addChunkStruct}, which the tests drive directly.
   */
  write(trackId: number, packet: Packet): Promise<void> {
    /* v8 ignore start -- requires a real WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
    const chunk = packet.chunk;
    // Check the logical encoded size before `packetBytes` allocates and calls `copyTo`. The shared
    // addChunkStruct path repeats this admission check immediately before committing the retained view.
    this.#assertChunkAdmission(trackId, chunk.byteLength);
    const data = packetBytes(packet);
    this.addChunkStruct(trackId, {
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? undefined,
      key: chunk.type === 'key',
      data,
      ...(packet.dtsUs !== undefined ? { dtsUs: packet.dtsUs } : {}),
    });
    return Promise.resolve();
    /* v8 ignore stop */
  }

  /**
   * Pure packet ingest: append an already-extracted {@link ChunkStruct} to its track's buffer. Shared by
   * {@link write} (after the browser-only `copyTo`) and the Node tests (which feed plain structs), so the
   * timing + serialization are fully validated without WebCodecs.
   */
  addChunkStruct(trackId: number, chunk: ChunkStruct): void {
    const { track, nextBufferedPayloadBytes } = this.#assertChunkAdmission(
      trackId,
      chunk.data.byteLength,
    );
    track.chunks.push(chunk);
    this.#bufferedPayloadBytes = nextBufferedPayloadBytes;
  }

  #assertChunkAdmission(
    trackId: number,
    incomingPayloadBytes: number,
  ): { readonly track: TrackState; readonly nextBufferedPayloadBytes: number } {
    this.#assertOpen();
    const track = this.#tracks.get(trackId);
    if (track === undefined) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    }
    if (
      this.#faststart === 'reserve' &&
      track.chunks.length >= (this.#maximumPacketCount as number)
    ) {
      throw new MediaError(
        'mux-error',
        `[MP4_FASTSTART_RESERVE_PACKET_OVERFLOW] track ${trackId} exceeds maximumPacketCount ${this.#maximumPacketCount}`,
      );
    }
    const nextBufferedPayloadBytes = this.#bufferedPayloadBytes + incomingPayloadBytes;
    if (
      !Number.isSafeInteger(nextBufferedPayloadBytes) ||
      nextBufferedPayloadBytes > MP4_BUFFER_ALL_MAX_PAYLOAD_BYTES
    ) {
      throw new CapabilityError('MP4 buffered mux payload exceeds the in-memory buffer-all limit', {
        op: {
          kind: 'route',
          id: 'mp4-buffer-all-payload',
          facts: {
            bufferedPayloadBytes: this.#bufferedPayloadBytes,
            incomingPayloadBytes,
            maximumBufferedPayloadBytes: MP4_BUFFER_ALL_MAX_PAYLOAD_BYTES,
          },
        },
        tried: [this.#driverId],
        suggestion: 'lower the duration or bitrate, or route to an incremental MP4 muxer',
      });
    }
    return { track, nextBufferedPayloadBytes };
  }

  async finalize(): Promise<void> {
    this.#assertOpen();
    this.#finalized = true;
    await this.#ready; // the readable's `start` has run → the controller is captured
    const controller = this.#controller as ReadableStreamDefaultController<Uint8Array>;
    try {
      const tracks = this.#buildTracks();
      if (this.#fragmented) {
        // Stream the init segment then one media segment per fragment (bounded memory, ADR-034).
        for (const segment of fragmentMp4(tracks)) controller.enqueue(segment);
      } else if (this.#faststart === 'reserve') {
        const maximumPacketCount = this.#maximumPacketCount as number;
        const layout = planReservedMp4ByteStreamLayout(tracks, maximumPacketCount, {
          brand: this.#brand,
        });
        controller.enqueue(layout.ftyp);
        controller.enqueue(positionedChunk(layout.mdatHeader, layout.mdatPosition));
        for (const track of tracks) {
          for (const sample of track.samples) {
            if (sample.data.byteLength > 0) controller.enqueue(sample.data);
          }
        }
        controller.enqueue(positionedChunk(layout.moovPatch, layout.reservationPosition));
      } else {
        controller.enqueue(writeMp4(tracks, { faststart: this.#faststart, brand: this.#brand }));
      }
      controller.close();
    } catch (err) {
      controller.error(err);
      throw err;
    }
  }

  /** Validate the buffered tracks and project them to {@link writeMp4} inputs (insertion order). */
  #buildTracks(): MuxTrackInput[] {
    if (this.#tracks.size === 0) {
      throw new MediaError('mux-error', 'cannot finalize a muxer with no tracks');
    }
    const sourceTimed = [...this.#tracks.values()].every((track) =>
      track.chunks.every((chunk) => chunk.dtsUs !== undefined),
    );
    let globalPresentationOriginUs = Number.POSITIVE_INFINITY;
    if (sourceTimed) {
      for (const track of this.#tracks.values()) {
        const presentationDelayUs = trackPresentationDelayUs(track);
        for (const chunk of track.chunks) {
          globalPresentationOriginUs = Math.min(
            globalPresentationOriginUs,
            chunk.timestampUs + presentationDelayUs,
          );
        }
      }
    }

    const out: MuxTrackInput[] = [];
    for (const [id, track] of this.#tracks) {
      if (track.chunks.length === 0) {
        throw new MediaError('mux-error', `track ${id} received no packets`);
      }
      const firstDtsUs = track.chunks[0]?.dtsUs;
      const leadingEmptyUs =
        sourceTimed && firstDtsUs !== undefined && Number.isFinite(globalPresentationOriginUs)
          ? Math.max(0, firstDtsUs - globalPresentationOriginUs)
          : 0;
      out.push(toMuxTrack(track, leadingEmptyUs));
    }
    return out;
  }

  #assertOpen(): void {
    if (this.#finalized) {
      throw new MediaError('mux-error', 'muxer already finalized');
    }
  }
}

function packetBytes(packet: Packet): Uint8Array {
  const { chunk, data } = packet;
  if (data !== undefined && data.byteLength === chunk.byteLength) {
    return data;
  }
  const copied = new Uint8Array(chunk.byteLength);
  chunk.copyTo(copied);
  return copied;
}
