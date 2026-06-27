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

import { MPEG4_SAMPLE_RATES, parseAsc } from '../../codecs/wasm-aac/aac.ts';
import { parseAv1Codec } from '../../codecs/wasm-av1/av1.ts';
import { parseVpxCodec } from '../../codecs/wasm-vpx/vpx.ts';
import type { MuxOptions, Muxer, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { parseEsds } from './codec-strings.ts';
import { fragmentMp4 } from './fragment.ts';
import type { MuxSampleInput, MuxTrackInput } from './write.ts';
import { type ContainerBrand, writeMp4 } from './write.ts';

/** The MPEG 90 kHz media clock — the default video timescale (divides 24/25/30/50/60 fps exactly). */
const DEFAULT_VIDEO_TIMESCALE = 90_000;
const MICROS_PER_SECOND = 1_000_000;

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
  throw new CapabilityError(
    'capability-miss',
    `the mp4 muxer cannot write ${mediaType} codec '${codec}'`,
    { op: { op: 'mux', mediaType, codec }, tried: ['mp4'] },
  );
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
): { offset: number; length: 3 | 4 } | undefined {
  for (let i = Math.max(0, from); i + 3 <= data.byteLength; i++) {
    const length = startCodeLengthAt(data, i);
    if (length !== undefined) return { offset: i, length };
  }
  return undefined;
}

/** Split one Annex-B access unit into NAL unit payloads (start codes removed). */
function annexBNalUnits(data: Uint8Array): Uint8Array[] | undefined {
  const first = findStartCode(data, 0);
  if (first === undefined) return undefined;
  const out: Uint8Array[] = [];
  let payloadOffset = first.offset + first.length;
  for (;;) {
    const next = findStartCode(data, payloadOffset);
    let payloadEnd = next?.offset ?? data.byteLength;
    // Annex-B permits zero_byte/trailing_zero_8bits before the next start code; those are not NAL payload.
    while (payloadEnd > payloadOffset && data[payloadEnd - 1] === 0) payloadEnd--;
    if (payloadEnd > payloadOffset) out.push(data.subarray(payloadOffset, payloadEnd));
    if (next === undefined) break;
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

function pushUniqueParameterSet(out: Uint8Array[], nal: Uint8Array): void {
  if (out.some((item) => equalBytes(item, nal))) return;
  out.push(nal.slice());
}

function collectParameterSets(nalus: readonly Uint8Array[], sets: H264ParameterSets): void {
  for (const nal of nalus) {
    const type = h264NalType(nal);
    if (type === H264_NAL_TYPE_SPS) pushUniqueParameterSet(sets.sps, nal);
    else if (type === H264_NAL_TYPE_PPS) pushUniqueParameterSet(sets.pps, nal);
  }
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
      'capability-miss',
      'H.264 MP4 muxing requires avcC description or Annex-B SPS/PPS parameter sets',
      { op: { op: 'mux', mediaType: 'video', codec: 'h264' }, tried: ['mp4'] },
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
      'capability-miss',
      `Opus MP4 muxing requires a family-0 mono/stereo channel layout, got ${fallbackChannels}`,
      { op: { op: 'mux', mediaType: 'audio', codec: 'opus' }, tried: ['mp4'] },
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
        'capability-miss',
        'Opus MP4 muxing currently supports OpusHead mapping-family 0 mono/stereo tracks',
        { op: { op: 'mux', mediaType: 'audio', codec: 'opus' }, tried: ['mp4'] },
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
function isLengthPrefixedAvc(data: Uint8Array, lengthSize: number): boolean {
  let pos = 0;
  let sawNal = false;
  while (pos + lengthSize <= data.byteLength) {
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = len * 256 + (data[pos + i] as number);
    if (len === 0) return false; // a zero-length NAL never occurs in a valid avcC AU
    pos += lengthSize + len;
    sawNal = true;
    if (pos > data.byteLength) return false; // a length overran the buffer ⇒ not length-prefixed
  }
  return sawNal && pos === data.byteLength; // consumed the buffer exactly ⇒ well-formed avcC AU
}

function prepareAvcSamples(
  chunks: readonly ChunkStruct[],
  description: Uint8Array | undefined,
): AvcPreparedSamples {
  const sets: H264ParameterSets = { sps: [], pps: [] };
  let sawAnnexB = false;
  // With an `avcC` description, NAL length size = (lengthSizeMinusOne & 3) + 1 (byte 4 of avcC); default 4.
  const lengthSize =
    description !== undefined && description.byteLength > 4
      ? ((description[4] as number) & 0x03) + 1
      : AVC_NAL_LENGTH_SIZE;
  const normalized = chunks.map((chunk): ChunkStruct => {
    // An `avcC`-described chunk that already parses as length-prefixed is passed through verbatim — never
    // run through the Annex-B start-code scan, which would mis-split a length prefix containing `00 00 01`.
    if (description !== undefined && isLengthPrefixedAvc(chunk.data, lengthSize)) return chunk;
    const nalus = annexBNalUnits(chunk.data);
    if (nalus === undefined) return chunk;
    sawAnnexB = true;
    collectParameterSets(nalus, sets);
    return copyChunkWithData(chunk, lengthPrefixedAvcAccessUnit(nalus));
  });
  if (description !== undefined) return { chunks: normalized, description };
  if (!sawAnnexB) {
    throw new CapabilityError(
      'capability-miss',
      'H.264 MP4 muxing requires avcC description or Annex-B access units with SPS/PPS',
      { op: { op: 'mux', mediaType: 'video', codec: 'h264' }, tried: ['mp4'] },
    );
  }
  return { chunks: normalized, description: avcCFromParameterSets(sets) };
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
    throw new CapabilityError(
      'capability-miss',
      'AAC MP4 muxing requires a representable MPEG-4 audio object type',
      { op: { op: 'mux', mediaType: 'audio', codec: 'aac', objectType }, tried: ['mp4'] },
    );
  }
  if (MPEG4_SAMPLE_RATES[sampleRateIndex] === undefined) {
    throw new CapabilityError(
      'capability-miss',
      'AAC MP4 muxing requires a representable MPEG-4 sampling-frequency index',
      { op: { op: 'mux', mediaType: 'audio', codec: 'aac', sampleRateIndex }, tried: ['mp4'] },
    );
  }
  if (!Number.isInteger(channelConfig) || channelConfig < 1 || channelConfig > 7) {
    throw new CapabilityError(
      'capability-miss',
      'AAC MP4 muxing requires a representable channel configuration',
      { op: { op: 'mux', mediaType: 'audio', codec: 'aac', channelConfig }, tried: ['mp4'] },
    );
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
      'capability-miss',
      'AAC MP4 muxing requires AudioSpecificConfig description or ADTS-framed samples',
      { op: { op: 'mux', mediaType: 'audio', codec: 'aac' }, tried: ['mp4'] },
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
 * Convert buffered chunk-structs (decode order) into {@link MuxSampleInput}s with correct B-frame timing.
 *
 * The DTS timeline is the cumulative sum of durations in decode order (DTS is contiguous; spacing is each
 * frame's own duration). The composition offset is computed in microseconds first — `ctts = (PTS−base) −
 * DTS` — so a non-reordered stream (PTS already in decode order, PTS gaps == durations) yields exactly
 * `ctts == 0` for every sample at any timescale, while a reordered (B-frame) stream carries the true
 * offset (negative offsets are fine — {@link writeMp4} emits a version-1 `ctts`). PTS is rebased to the
 * minimum so a standalone file starts at t=0. Decode order is preserved (samples are stored as arrived).
 */
export function buildMuxSamples(
  chunks: readonly ChunkStruct[],
  timescale: number,
): MuxSampleInput[] {
  const n = chunks.length;
  if (n === 0) return [];

  const hasAllDurations = chunks.every((c) => c.durationUs !== undefined);
  const durationsUs = hasAllDurations
    ? chunks.map((c) => c.durationUs as number)
    : recoverDurationsUs(chunks);

  // Verbatim-remux fast path: every packet carries the source's true decode timestamp (the demuxer read
  // it from `stts`). Lay the composition offset down as the exact (PTS − DTS), and derive each sample's
  // duration from the gap to the next DTS so writeMp4's cumulative-sum `stts` reconstructs the source
  // decode timeline 1:1 — preserving the original B-frame/open-GOP structure losslessly (ADR-045). The
  // chunks arrive in decode order, so DTS is monotonic and every gap is ≥ 0.
  if (chunks.every((c) => c.dtsUs !== undefined)) {
    const out: MuxSampleInput[] = [];
    for (let i = 0; i < n; i++) {
      const c = chunks[i] as ChunkStruct;
      const dts = c.dtsUs as number;
      const next = chunks[i + 1]?.dtsUs;
      const durUs = next !== undefined ? Math.max(0, next - dts) : (durationsUs[i] as number);
      out.push({
        data: c.data,
        durationTicks: ticks(durUs, timescale),
        cttsTicks: ticks(c.timestampUs - dts, timescale),
        keyframe: c.key,
      });
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
interface TrackState {
  readonly mediaType: 'video' | 'audio';
  readonly codec: string;
  readonly sampleEntryType: string;
  readonly config: ConfigKind;
  readonly timescale: number;
  readonly description: Uint8Array | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly sampleRate: number | undefined;
  readonly channels: number | undefined;
  readonly chunks: ChunkStruct[];
}

/** Resolve geometry/config fields from a track's WebCodecs `DecoderConfig` (narrowed by `mediaType`). */
function trackStateFrom(info: TrackInfo): TrackState {
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
      sampleRate: undefined,
      channels: undefined,
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
    sampleRate,
    channels: ac?.numberOfChannels,
    chunks: [],
  };
}

/** Turn a finalized {@link TrackState} into the {@link MuxTrackInput} {@link writeMp4} consumes. */
function toMuxTrack(t: TrackState): MuxTrackInput {
  const prepared =
    t.mediaType === 'video' && t.sampleEntryType === 'avc1'
      ? prepareAvcSamples(t.chunks, t.description)
      : t.mediaType === 'audio' && t.config.kind === 'esds-from-description'
        ? prepareAacSamples(t.chunks, t.description)
        : { chunks: t.chunks, description: t.description };
  const samples = buildMuxSamples(prepared.chunks, t.timescale);
  const base = {
    mediaType: t.mediaType,
    sampleEntryType: t.sampleEntryType,
    timescale: t.timescale,
    samples,
    ...(t.width !== undefined ? { width: t.width } : {}),
    ...(t.height !== undefined ? { height: t.height } : {}),
    ...(t.sampleRate !== undefined ? { sampleRate: t.sampleRate } : {}),
    ...(t.channels !== undefined ? { channels: t.channels } : {}),
  };
  if (t.config.kind === 'raw-box') {
    const description = prepared.description ?? synthesizeRawBoxDescription(t);
    if (description === undefined) {
      throw new CapabilityError(
        'capability-miss',
        `${t.sampleEntryType} MP4 muxing requires ${t.config.boxType} description`,
        {
          op: { op: 'mux', mediaType: t.mediaType, codec: t.sampleEntryType },
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
  readonly #faststart: boolean;
  readonly #fragmented: boolean;
  readonly #brand: ContainerBrand;
  #nextId = 1;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions) {
    // Fragmented/CMAF output (ADR-034): finalize emits an init segment + one media segment per fragment
    // via {@link fragmentMp4}, instead of the single faststart `moov`+`mdat` from {@link writeMp4}.
    this.#fragmented = options?.fragmented === true;
    this.#faststart = options?.faststart ?? true;
    this.#brand = options?.container === 'mov' || options?.container === 'qt' ? 'mov' : 'mp4';
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

  /**
   * Buffer one encoded packet on its track (decode = arrival order). Extracting the bytes/timing from a
   * real `EncodedVideoChunk`/`EncodedAudioChunk` (`copyTo`) is the only browser-only step (guarded); the
   * resulting struct flows through the pure {@link addChunkStruct}, which the tests drive directly.
   */
  write(trackId: number, packet: Packet): Promise<void> {
    /* v8 ignore start -- requires a real WebCodecs Encoded*Chunk; validated under browser-mode (Phase 1) */
    const chunk = packet.chunk;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
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
    this.#assertOpen();
    const track = this.#tracks.get(trackId);
    if (track === undefined) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    }
    track.chunks.push(chunk);
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
    const out: MuxTrackInput[] = [];
    for (const [id, track] of this.#tracks) {
      if (track.chunks.length === 0) {
        throw new MediaError('mux-error', `track ${id} received no packets`);
      }
      out.push(toMuxTrack(track));
    }
    return out;
  }

  #assertOpen(): void {
    if (this.#finalized) {
      throw new MediaError('mux-error', 'muxer already finalized');
    }
  }
}
