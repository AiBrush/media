import { MPEG4_SAMPLE_RATES, parseAsc } from '../../codecs/wasm-aac/aac.ts';
import type { MediaType, Muxer, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';

const TS_PACKET_SIZE = 188;
const TS_CLOCK_HZ = 90_000;
const MICROSECONDS_PER_SECOND = 1_000_000;
const PAT_PID = 0x0000;
const PMT_PID = 0x0100;
const FIRST_ES_PID = 0x0101;
const TS_ID = 1;
const PROGRAM_NUMBER = 1;
const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_AAC = 0x0f;
const VIDEO_STREAM_ID_BASE = 0xe0;
const AUDIO_STREAM_ID_BASE = 0xc0;
const ANNEX_B_START_CODE = new Uint8Array([0, 0, 0, 1]);
const PCR_ADAPTATION_BYTES = 7;

export interface MpegTsChunk {
  readonly data: Uint8Array;
  readonly timestampUs: number;
  readonly durationUs?: number;
  readonly dtsUs?: number;
  readonly key: boolean;
}

type SupportedCodec = 'h264' | 'aac';

interface AvcDecoderConfig {
  readonly lengthSize: number;
  readonly parameterSets: readonly Uint8Array[];
}

interface AacEncoderConfig {
  readonly objectType: number;
  readonly sampleRate: number;
  readonly sampleRateIndex: number;
  readonly channelConfig: number;
}

interface TrackState {
  readonly muxTrackId: number;
  readonly inputTrackId: number;
  readonly mediaType: MediaType;
  readonly codec: SupportedCodec;
  readonly pid: number;
  readonly streamType: number;
  readonly streamId: number;
  readonly avcConfig: AvcDecoderConfig | undefined;
  readonly aacConfig: AacEncoderConfig | undefined;
  readonly chunks: MpegTsChunk[];
}

interface TimedAccessUnit {
  readonly track: TrackState;
  readonly payload: Uint8Array;
  readonly ptsTicks: number;
  readonly dtsTicks: number;
}

interface PacketizedTs {
  readonly bytes: Uint8Array;
  readonly continuity: ReadonlyMap<number, number>;
}

/**
 * Default streaming write granularity: how many 188-byte transport packets each `output` chunk carries.
 * A transport stream is a flat run of fixed-size packets with no front index, so it is the one container
 * that can be emitted as a sequence of packet-aligned writes the instant `finalize` serializes it — the
 * streaming-target shape (doc 09 streaming-output) a `StreamTarget` turns into one positioned write each.
 * 87×188 = 16 356 B ≈ a 16 KB network/disk write unit: small enough to stream incrementally (TTFB, bounded
 * peak copy at the sink), large enough that a long stream is not thousands of micro-enqueues. Every chunk
 * is a whole number of packets (188-aligned), so a consumer that resynchronizes on the `0x47` sync byte
 * sees an intact packet boundary at every chunk edge.
 */
const DEFAULT_WRITE_CHUNK_PACKETS = 87;

export interface MpegTsMuxerOptions {
  readonly fragmented?: boolean;
  /**
   * Streaming write granularity in whole 188-byte packets per emitted `output` chunk (≥ 1). The serialized
   * stream is sliced on packet boundaries into chunks of at most this many packets, each `enqueue`d
   * separately so a positioned-write sink observes incremental, packet-aligned writes rather than one
   * single-shot blob. Omitted ⇒ {@link DEFAULT_WRITE_CHUNK_PACKETS}. The assembled bytes are identical
   * regardless of granularity (this only changes how the output is chunked, never its content).
   */
  readonly writeChunkPackets?: number;
}

export class MpegTsMuxer implements Muxer {
  readonly #tracks: TrackState[] = [];
  readonly #controllerPromise: Promise<ReadableStreamDefaultController<Uint8Array>>;
  readonly #output: ReadableStream<Uint8Array>;
  readonly #writeChunkPackets: number;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #finalized = false;

  constructor(options: MpegTsMuxerOptions = {}) {
    if (options.fragmented === true) {
      throw new CapabilityError(
        'capability-miss',
        'MPEG-TS fragmented muxing is not supported; use a regular TS output target.',
        capabilityDetail({ container: 'ts', fragmented: true }),
      );
    }
    this.#writeChunkPackets = Math.max(
      1,
      Math.floor(options.writeChunkPackets ?? DEFAULT_WRITE_CHUNK_PACKETS),
    );
    let resolveController: (controller: ReadableStreamDefaultController<Uint8Array>) => void =
      () => {};
    this.#controllerPromise = new Promise((resolve) => {
      resolveController = resolve;
    });
    this.#output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        resolveController(controller);
      },
    });
  }

  get output(): ReadableStream<Uint8Array> {
    return this.#output;
  }

  addTrack(info: TrackInfo): number {
    this.#assertWritable();
    const codec = normalizeCodec(info.codec);
    const muxTrackId = this.#tracks.length + 1;
    const pid = FIRST_ES_PID + this.#tracks.length;
    const videoCount = this.#tracks.filter((track) => track.mediaType === 'video').length;
    const audioCount = this.#tracks.filter((track) => track.mediaType === 'audio').length;

    const track: TrackState =
      codec === 'h264'
        ? {
            muxTrackId,
            inputTrackId: info.id,
            mediaType: 'video',
            codec,
            pid,
            streamType: STREAM_TYPE_H264,
            streamId: VIDEO_STREAM_ID_BASE + videoCount,
            avcConfig: parseAvcDecoderConfig(descriptionBytes(info.config)),
            aacConfig: undefined,
            chunks: [],
          }
        : {
            muxTrackId,
            inputTrackId: info.id,
            mediaType: 'audio',
            codec,
            pid,
            streamType: STREAM_TYPE_AAC,
            streamId: AUDIO_STREAM_ID_BASE + audioCount,
            avcConfig: undefined,
            aacConfig: parseAacEncoderConfig(info),
            chunks: [],
          };

    if (track.mediaType !== info.mediaType) {
      throw new CapabilityError(
        'capability-miss',
        'Track media type does not match MPEG-TS codec support.',
        capabilityDetail({ codec: info.codec, mediaType: info.mediaType }),
      );
    }

    this.#tracks.push(track);
    return muxTrackId;
  }

  async write(trackId: number, packet: Packet): Promise<void> {
    const data = new Uint8Array(packet.chunk.byteLength);
    packet.chunk.copyTo(data);
    this.addChunkStruct(trackId, {
      data,
      timestampUs: packet.chunk.timestamp,
      key: packet.chunk.type === 'key',
      ...(packet.chunk.duration !== null && packet.chunk.duration !== undefined
        ? { durationUs: packet.chunk.duration }
        : {}),
      ...(packet.dtsUs !== undefined ? { dtsUs: packet.dtsUs } : {}),
    });
  }

  addChunkStruct(trackId: number, chunk: MpegTsChunk): void {
    this.#assertWritable();
    const track = this.#tracks.find((candidate) => candidate.muxTrackId === trackId);
    if (track === undefined) {
      throw new MediaError('mux-error', 'Cannot write MPEG-TS packet for an unknown mux track.', {
        trackId,
      });
    }
    validateTimestamp(chunk.timestampUs, 'timestampUs');
    if (chunk.dtsUs !== undefined) {
      validateTimestamp(chunk.dtsUs, 'dtsUs');
    }
    if (chunk.durationUs !== undefined) {
      validateDuration(chunk.durationUs, 'durationUs');
    }
    if (chunk.data.byteLength === 0) {
      throw new MediaError('mux-error', 'Cannot mux an empty MPEG-TS access unit.', { trackId });
    }
    track.chunks.push({
      data: copyBytes(chunk.data),
      timestampUs: chunk.timestampUs,
      key: chunk.key,
      ...(chunk.durationUs !== undefined ? { durationUs: chunk.durationUs } : {}),
      ...(chunk.dtsUs !== undefined ? { dtsUs: chunk.dtsUs } : {}),
    });
  }

  async finalize(): Promise<void> {
    this.#assertWritable();
    this.#finalized = true;
    const controller = this.#controller ?? (await this.#controllerPromise);
    try {
      const bytes = writeMpegTs(this.#tracks);
      // Emit the transport stream as a sequence of packet-aligned writes (the streaming-target shape):
      // each chunk is a whole number of 188-byte packets, so a positioned-write sink sees incremental,
      // resynchronizable writes rather than one single-shot blob. The concatenation is byte-identical to
      // `bytes`. An empty stream (no packets) enqueues nothing — just closes.
      const chunkBytes = this.#writeChunkPackets * TS_PACKET_SIZE;
      for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
        controller.enqueue(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength)));
      }
      controller.close();
    } catch (error) {
      controller.error(error);
      throw error;
    }
  }

  #assertWritable(): void {
    if (this.#finalized) {
      throw new MediaError('mux-error', 'Cannot mutate an MPEG-TS muxer after finalize().');
    }
  }
}

export function writeMpegTs(tracks: readonly TrackState[]): Uint8Array {
  if (tracks.length === 0) {
    throw new MediaError('mux-error', 'MPEG-TS muxing requires at least one track.');
  }
  const packetizedTracks = tracks.filter((track) => track.chunks.length > 0);
  if (packetizedTracks.length === 0) {
    throw new MediaError('mux-error', 'MPEG-TS muxing requires at least one packet.');
  }
  const pcrTrack =
    packetizedTracks.find((track) => track.mediaType === 'video') ?? packetizedTracks[0];
  if (pcrTrack === undefined) {
    throw new MediaError('mux-error', 'MPEG-TS muxing requires a PCR track.');
  }

  const continuity = new Map<number, number>();
  const packets: Uint8Array[] = [];
  appendPacketized(packets, packetizePayload(PAT_PID, true, psiPayload(patSection()), continuity));
  appendPacketized(
    packets,
    packetizePayload(
      PMT_PID,
      true,
      psiPayload(pmtSection(packetizedTracks, pcrTrack.pid)),
      continuity,
    ),
  );

  for (const unit of buildTimedAccessUnits(packetizedTracks)) {
    const pes = pesPacket(unit.track.streamId, unit.payload, unit.ptsTicks, unit.dtsTicks);
    const pcrTicks = unit.track.pid === pcrTrack.pid ? unit.dtsTicks : undefined;
    appendPacketized(packets, packetizePayload(unit.track.pid, true, pes, continuity, pcrTicks));
  }

  return concatBytes(packets);
}

function capabilityDetail(extra: Record<string, unknown>): Record<string, unknown> {
  return { op: 'mux:mpegts', tried: ['mpegts'], ...extra };
}

function buildTimedAccessUnits(tracks: readonly TrackState[]): TimedAccessUnit[] {
  const units: TimedAccessUnit[] = [];
  const rebaseUs = timestampRebaseUs(tracks);
  for (const track of tracks) {
    for (const chunk of track.chunks) {
      const ptsTicks = usToTsTicks(chunk.timestampUs - rebaseUs);
      const dtsTicks = usToTsTicks((chunk.dtsUs ?? chunk.timestampUs) - rebaseUs);
      units.push({
        track,
        payload: accessUnitPayload(track, chunk),
        ptsTicks,
        dtsTicks,
      });
    }
  }
  return units.sort((left, right) => {
    if (left.dtsTicks !== right.dtsTicks) {
      return left.dtsTicks - right.dtsTicks;
    }
    if (left.ptsTicks !== right.ptsTicks) {
      return left.ptsTicks - right.ptsTicks;
    }
    return left.track.pid - right.track.pid;
  });
}

function timestampRebaseUs(tracks: readonly TrackState[]): number {
  let earliestUs = 0;
  for (const track of tracks) {
    for (const chunk of track.chunks) {
      earliestUs = Math.min(earliestUs, chunk.timestampUs, chunk.dtsUs ?? chunk.timestampUs);
    }
  }
  return earliestUs;
}

function accessUnitPayload(track: TrackState, chunk: MpegTsChunk): Uint8Array {
  if (track.codec === 'h264') {
    return h264AnnexBAccessUnit(chunk.data, track.avcConfig, chunk.key);
  }
  if (track.aacConfig === undefined) {
    throw new CapabilityError(
      'capability-miss',
      'AAC MPEG-TS muxing requires an AAC encoder config.',
      capabilityDetail({ codec: track.codec, trackId: track.inputTrackId }),
    );
  }
  return aacAdtsAccessUnit(chunk.data, track.aacConfig);
}

function h264AnnexBAccessUnit(
  data: Uint8Array,
  avcConfig: AvcDecoderConfig | undefined,
  key: boolean,
): Uint8Array {
  if (isAnnexB(data)) {
    return copyBytes(data);
  }
  if (avcConfig === undefined) {
    throw new CapabilityError(
      'capability-miss',
      'H.264 MPEG-TS muxing requires Annex B samples or avcC decoder configuration.',
      capabilityDetail({ codec: 'h264' }),
    );
  }

  const parts: Uint8Array[] = [];
  if (key) {
    for (const parameterSet of avcConfig.parameterSets) {
      parts.push(ANNEX_B_START_CODE, parameterSet);
    }
  }

  let offset = 0;
  while (offset < data.byteLength) {
    if (offset + avcConfig.lengthSize > data.byteLength) {
      throw new MediaError('mux-error', 'Invalid length-prefixed H.264 access unit.', {
        codec: 'h264',
      });
    }
    const nalLength = readNalLength(data, offset, avcConfig.lengthSize);
    offset += avcConfig.lengthSize;
    if (nalLength <= 0 || offset + nalLength > data.byteLength) {
      throw new MediaError('mux-error', 'Invalid H.264 NAL length while writing MPEG-TS.', {
        codec: 'h264',
      });
    }
    parts.push(ANNEX_B_START_CODE, data.subarray(offset, offset + nalLength));
    offset += nalLength;
  }
  return concatBytes(parts);
}

function aacAdtsAccessUnit(data: Uint8Array, config: AacEncoderConfig): Uint8Array {
  if (isAdtsFrame(data)) {
    return copyBytes(data);
  }
  return concatBytes([adtsHeader(data.byteLength, config), data]);
}

function pesPacket(
  streamId: number,
  payload: Uint8Array,
  ptsTicks: number,
  dtsTicks: number,
): Uint8Array {
  const hasDts = ptsTicks !== dtsTicks;
  const timestampBytes = hasDts
    ? concatBytes([timestampField(0x3, ptsTicks), timestampField(0x1, dtsTicks)])
    : timestampField(0x2, ptsTicks);
  const pesHeaderDataLength = timestampBytes.byteLength;
  const packetLengthValue = 3 + pesHeaderDataLength + payload.byteLength;
  const pesPacketLength = packetLengthValue <= 0xffff ? packetLengthValue : 0;
  const header = new Uint8Array(9 + pesHeaderDataLength);
  header[0] = 0x00;
  header[1] = 0x00;
  header[2] = 0x01;
  header[3] = streamId & 0xff;
  writeU16(header, 4, pesPacketLength);
  header[6] = 0x80;
  header[7] = hasDts ? 0xc0 : 0x80;
  header[8] = pesHeaderDataLength;
  header.set(timestampBytes, 9);
  return concatBytes([header, payload]);
}

function packetizePayload(
  pid: number,
  payloadUnitStart: boolean,
  payload: Uint8Array,
  continuity: Map<number, number>,
  pcrTicks?: number,
): PacketizedTs {
  const packets: Uint8Array[] = [];
  let offset = 0;
  let first = true;
  while (offset < payload.byteLength) {
    const wantPcr = first && pcrTicks !== undefined;
    const maxPayloadBytes = wantPcr
      ? TS_PACKET_SIZE - 4 - 1 - PCR_ADAPTATION_BYTES
      : TS_PACKET_SIZE - 4;
    const payloadBytes = Math.min(maxPayloadBytes, payload.byteLength - offset);
    const adaptationLength =
      wantPcr || payloadBytes < TS_PACKET_SIZE - 4 ? TS_PACKET_SIZE - 5 - payloadBytes : undefined;
    if (wantPcr && (adaptationLength === undefined || adaptationLength < PCR_ADAPTATION_BYTES)) {
      throw new MediaError(
        'mux-error',
        'Internal MPEG-TS packetizer could not reserve PCR space.',
        { pid },
      );
    }

    const packet = new Uint8Array(TS_PACKET_SIZE);
    packet.fill(0xff);
    const continuityCounter = continuity.get(pid) ?? 0;
    continuity.set(pid, (continuityCounter + 1) & 0x0f);
    packet[0] = 0x47;
    packet[1] = (first && payloadUnitStart ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
    packet[2] = pid & 0xff;
    packet[3] =
      adaptationLength === undefined ? 0x10 | continuityCounter : 0x30 | continuityCounter;

    let payloadOffset = 4;
    if (adaptationLength !== undefined) {
      packet[4] = adaptationLength;
      payloadOffset = 5 + adaptationLength;
      if (adaptationLength > 0) {
        packet[5] = wantPcr ? 0x10 : 0x00;
        if (wantPcr && pcrTicks !== undefined) {
          writePcr(packet, 6, pcrTicks);
        }
      }
    }

    packet.set(payload.subarray(offset, offset + payloadBytes), payloadOffset);
    packets.push(packet);
    offset += payloadBytes;
    first = false;
  }
  return { bytes: concatBytes(packets), continuity };
}

function patSection(): Uint8Array {
  const sectionLength = 13;
  const withoutCrc = new Uint8Array(12);
  withoutCrc[0] = 0x00;
  withoutCrc[1] = 0xb0 | ((sectionLength >> 8) & 0x0f);
  withoutCrc[2] = sectionLength & 0xff;
  writeU16(withoutCrc, 3, TS_ID);
  withoutCrc[5] = 0xc1;
  withoutCrc[6] = 0x00;
  withoutCrc[7] = 0x00;
  writeU16(withoutCrc, 8, PROGRAM_NUMBER);
  withoutCrc[10] = 0xe0 | ((PMT_PID >> 8) & 0x1f);
  withoutCrc[11] = PMT_PID & 0xff;
  return appendCrc(withoutCrc);
}

function pmtSection(tracks: readonly TrackState[], pcrPid: number): Uint8Array {
  const sectionLength = 9 + tracks.length * 5 + 4;
  const withoutCrc = new Uint8Array(12 + tracks.length * 5);
  withoutCrc[0] = 0x02;
  withoutCrc[1] = 0xb0 | ((sectionLength >> 8) & 0x0f);
  withoutCrc[2] = sectionLength & 0xff;
  writeU16(withoutCrc, 3, PROGRAM_NUMBER);
  withoutCrc[5] = 0xc1;
  withoutCrc[6] = 0x00;
  withoutCrc[7] = 0x00;
  withoutCrc[8] = 0xe0 | ((pcrPid >> 8) & 0x1f);
  withoutCrc[9] = pcrPid & 0xff;
  withoutCrc[10] = 0xf0;
  withoutCrc[11] = 0x00;
  let offset = 12;
  for (const track of tracks) {
    withoutCrc[offset] = track.streamType;
    withoutCrc[offset + 1] = 0xe0 | ((track.pid >> 8) & 0x1f);
    withoutCrc[offset + 2] = track.pid & 0xff;
    withoutCrc[offset + 3] = 0xf0;
    withoutCrc[offset + 4] = 0x00;
    offset += 5;
  }
  return appendCrc(withoutCrc);
}

function psiPayload(section: Uint8Array): Uint8Array {
  const payload = new Uint8Array(section.byteLength + 1);
  payload[0] = 0;
  payload.set(section, 1);
  return payload;
}

function appendCrc(sectionWithoutCrc: Uint8Array): Uint8Array {
  const output = new Uint8Array(sectionWithoutCrc.byteLength + 4);
  output.set(sectionWithoutCrc, 0);
  writeU32(output, sectionWithoutCrc.byteLength, crc32Mpeg2(sectionWithoutCrc));
  return output;
}

function timestampField(prefix: number, ticks: number): Uint8Array {
  const value = normalizeTimestamp33(ticks);
  return new Uint8Array([
    (prefix << 4) | (((Math.floor(value / 2 ** 30) & 0x07) << 1) | 0x01),
    Math.floor(value / 2 ** 22) & 0xff,
    ((Math.floor(value / 2 ** 15) & 0x7f) << 1) | 0x01,
    Math.floor(value / 2 ** 7) & 0xff,
    ((value & 0x7f) << 1) | 0x01,
  ]);
}

function writePcr(packet: Uint8Array, offset: number, ticks: number): void {
  const base = normalizeTimestamp33(ticks);
  packet[offset] = Math.floor(base / 2 ** 25) & 0xff;
  packet[offset + 1] = Math.floor(base / 2 ** 17) & 0xff;
  packet[offset + 2] = Math.floor(base / 2 ** 9) & 0xff;
  packet[offset + 3] = Math.floor(base / 2 ** 1) & 0xff;
  packet[offset + 4] = ((base & 0x01) << 7) | 0x7e;
  packet[offset + 5] = 0x00;
}

function adtsHeader(payloadLength: number, config: AacEncoderConfig): Uint8Array {
  const frameLength = payloadLength + 7;
  if (frameLength > 0x1fff) {
    throw new MediaError('mux-error', 'AAC frame is too large for an ADTS header.', {
      frameLength,
    });
  }
  const profile = config.objectType - 1;
  const header = new Uint8Array(7);
  header[0] = 0xff;
  header[1] = 0xf1;
  header[2] =
    ((profile & 0x03) << 6) |
    ((config.sampleRateIndex & 0x0f) << 2) |
    ((config.channelConfig >> 2) & 0x01);
  header[3] = ((config.channelConfig & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  header[4] = (frameLength >> 3) & 0xff;
  header[5] = ((frameLength & 0x07) << 5) | 0x1f;
  header[6] = 0xfc;
  return header;
}

function parseAvcDecoderConfig(description: Uint8Array | undefined): AvcDecoderConfig | undefined {
  if (description === undefined) {
    return undefined;
  }
  if (description.byteLength < 7 || description[0] !== 1) {
    throw new CapabilityError(
      'capability-miss',
      'Invalid avcC description for MPEG-TS H.264 muxing.',
      capabilityDetail({ codec: 'h264' }),
    );
  }
  const lengthSize = ((description[4] as number) & 0x03) + 1;
  if (lengthSize < 1 || lengthSize > 4) {
    throw new CapabilityError(
      'capability-miss',
      'Unsupported H.264 NAL length size in avcC description.',
      capabilityDetail({ codec: 'h264', lengthSize }),
    );
  }
  const parameterSets: Uint8Array[] = [];
  let offset = 5;
  const spsCount = (description[offset] as number) & 0x1f;
  offset += 1;
  for (let index = 0; index < spsCount; index += 1) {
    const sps = readLengthPrefixedBytes(description, offset);
    parameterSets.push(sps.bytes);
    offset = sps.nextOffset;
  }
  if (offset >= description.byteLength) {
    throw new CapabilityError(
      'capability-miss',
      'Invalid avcC PPS table for MPEG-TS muxing.',
      capabilityDetail({ codec: 'h264' }),
    );
  }
  const ppsCount = description[offset] as number;
  offset += 1;
  for (let index = 0; index < ppsCount; index += 1) {
    const pps = readLengthPrefixedBytes(description, offset);
    parameterSets.push(pps.bytes);
    offset = pps.nextOffset;
  }
  if (parameterSets.length === 0) {
    throw new CapabilityError(
      'capability-miss',
      'H.264 avcC description is missing SPS/PPS parameter sets.',
      capabilityDetail({ codec: 'h264' }),
    );
  }
  return { lengthSize, parameterSets };
}

function parseAacEncoderConfig(info: TrackInfo): AacEncoderConfig {
  const description = descriptionBytes(info.config);
  const asc = description === undefined ? undefined : parseAsc(description);
  const sampleRate = asc?.sampleRate ?? audioConfigNumber(info, 'sampleRate');
  const channelConfig = asc?.channels ?? audioConfigNumber(info, 'numberOfChannels');
  const objectType = asc?.objectType ?? 2;
  if (objectType < 1 || objectType > 4) {
    throw new CapabilityError(
      'capability-miss',
      'ADTS-in-TS output supports AAC object types 1 through 4.',
      capabilityDetail({ codec: info.codec, objectType }),
    );
  }
  const sampleRateIndex = MPEG4_SAMPLE_RATES.indexOf(sampleRate);
  if (sampleRateIndex < 0) {
    throw new CapabilityError(
      'capability-miss',
      'AAC sample rate is not representable in ADTS.',
      capabilityDetail({ codec: info.codec, sampleRate }),
    );
  }
  if (!Number.isInteger(channelConfig) || channelConfig < 1 || channelConfig > 7) {
    throw new CapabilityError(
      'capability-miss',
      'AAC channel count is not representable in ADTS.',
      capabilityDetail({ codec: info.codec, channelConfig }),
    );
  }
  return { objectType, sampleRate, sampleRateIndex, channelConfig };
}

function audioConfigNumber(info: TrackInfo, key: 'sampleRate' | 'numberOfChannels'): number {
  const config = info.config;
  if (
    key === 'sampleRate' &&
    config !== undefined &&
    'sampleRate' in config &&
    typeof config.sampleRate === 'number'
  ) {
    return config.sampleRate;
  }
  if (
    key === 'numberOfChannels' &&
    config !== undefined &&
    'numberOfChannels' in config &&
    typeof config.numberOfChannels === 'number'
  ) {
    return config.numberOfChannels;
  }
  throw new CapabilityError(
    'capability-miss',
    `AAC MPEG-TS muxing requires ${key} metadata.`,
    capabilityDetail({ codec: info.codec }),
  );
}

function descriptionBytes(config: TrackInfo['config']): Uint8Array | undefined {
  const description =
    config !== undefined && 'description' in config && config.description !== undefined
      ? config.description
      : undefined;
  return description === undefined ? undefined : copyBufferSource(description);
}

function readLengthPrefixedBytes(
  data: Uint8Array,
  offset: number,
): { readonly bytes: Uint8Array; readonly nextOffset: number } {
  if (offset + 2 > data.byteLength) {
    throw new CapabilityError(
      'capability-miss',
      'Truncated H.264 avcC parameter set.',
      capabilityDetail({ codec: 'h264' }),
    );
  }
  const length = readU16(data, offset);
  const bytesOffset = offset + 2;
  const nextOffset = bytesOffset + length;
  if (length <= 0 || nextOffset > data.byteLength) {
    throw new CapabilityError(
      'capability-miss',
      'Invalid H.264 avcC parameter set length.',
      capabilityDetail({ codec: 'h264' }),
    );
  }
  return { bytes: copyBytes(data.subarray(bytesOffset, nextOffset)), nextOffset };
}

function normalizeCodec(codec: string): SupportedCodec {
  const lower = codec.toLowerCase();
  if (lower === 'h264' || lower.startsWith('avc1') || lower.startsWith('avc3')) {
    return 'h264';
  }
  if (lower === 'aac' || lower.startsWith('mp4a')) {
    return 'aac';
  }
  throw new CapabilityError(
    'capability-miss',
    'MPEG-TS muxing currently supports H.264 and AAC tracks.',
    capabilityDetail({ codec }),
  );
}

function readNalLength(data: Uint8Array, offset: number, lengthSize: number): number {
  let value = 0;
  for (let index = 0; index < lengthSize; index += 1) {
    value = value * 256 + (data[offset + index] as number);
  }
  return value;
}

function isAnnexB(data: Uint8Array): boolean {
  if (data.byteLength < 4) return false;
  const b0 = data[0] as number;
  const b1 = data[1] as number;
  const b2 = data[2] as number;
  const b3 = data[3] as number;
  return b0 === 0x00 && b1 === 0x00 && (b2 === 0x01 || (b2 === 0x00 && b3 === 0x01));
}

function isAdtsFrame(data: Uint8Array): boolean {
  if (data.byteLength < 7) return false;
  const b0 = data[0] as number;
  const b1 = data[1] as number;
  if (b0 !== 0xff || (b1 & 0xf0) !== 0xf0) {
    return false;
  }
  const frameLength =
    (((data[3] as number) & 0x03) << 11) |
    ((data[4] as number) << 3) |
    (((data[5] as number) >> 5) & 0x07);
  return frameLength === data.byteLength;
}

function validateTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new MediaError('mux-error', `Invalid MPEG-TS ${name}.`, { [name]: value });
  }
}

function validateDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new MediaError('mux-error', `Invalid MPEG-TS ${name}.`, { [name]: value });
  }
}

function usToTsTicks(timestampUs: number): number {
  return Math.round((timestampUs * TS_CLOCK_HZ) / MICROSECONDS_PER_SECOND);
}

function normalizeTimestamp33(ticks: number): number {
  const modulo = 2 ** 33;
  return ((Math.round(ticks) % modulo) + modulo) % modulo;
}

function readU16(data: Uint8Array, offset: number): number {
  return (data[offset] as number) * 256 + (data[offset + 1] as number);
}

function writeU16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = (value >> 8) & 0xff;
  data[offset + 1] = value & 0xff;
}

function writeU32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

function crc32Mpeg2(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
      crc >>>= 0;
    }
  }
  return crc >>> 0;
}

function copyBufferSource(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  }
  return new Uint8Array(source).slice();
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function appendPacketized(packets: Uint8Array[], packetized: PacketizedTs): void {
  for (let offset = 0; offset < packetized.bytes.byteLength; offset += TS_PACKET_SIZE) {
    packets.push(packetized.bytes.subarray(offset, offset + TS_PACKET_SIZE));
  }
}
