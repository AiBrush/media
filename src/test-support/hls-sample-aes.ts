import { createCipheriv } from 'node:crypto';

const AES_BLOCK = 16;
const TS_SYNC = 0x47;
const TS_PACKET_SIZE = 188;
const PAT_PID = 0x0000;
const NULL_PID = 0x1fff;
const STREAM_TYPE_AAC_ADTS = 0x0f;
const STREAM_TYPE_H264 = 0x1b;
const H264_CLEAR_LEAD = 32;
const H264_SKIP_BYTES = 144;
const AAC_CLEAR_LEAD = 16;

type SampleAesCodec = 'h264' | 'aac';

interface TsPacket {
  readonly pid: number;
  readonly payloadUnitStart: boolean;
  readonly payload?: Uint8Array;
}

interface SampleAesStream {
  readonly pid: number;
  readonly codec: SampleAesCodec;
}

interface PesBuilder {
  readonly codec: SampleAesCodec;
  readonly chunks: Uint8Array[];
  length: number;
}

interface BlockRun {
  readonly offset: number;
  readonly length: number;
}

export function encryptHlsSampleAesTs(
  clear: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  const out = clear.slice();
  const streamsByPid = new Map<number, SampleAesStream>();
  const builders = new Map<number, PesBuilder>();
  let pmtPid: number | undefined;

  const flush = (pid: number): void => {
    const builder = builders.get(pid);
    builders.delete(pid);
    if (builder === undefined) return;
    const pes = flattenPes(builder);
    encryptPesPayload(pes, builder.codec, key, iv);
    writeBackPes(pes, builder);
  };

  for (
    let packetStart = 0;
    packetStart + TS_PACKET_SIZE <= out.byteLength;
    packetStart += TS_PACKET_SIZE
  ) {
    const packet = parseTsPacket(out, packetStart);
    if (packet === undefined) continue;
    const payload = packet.payload;
    if (packet.pid === PAT_PID) {
      if (pmtPid === undefined && packet.payloadUnitStart && payload !== undefined) {
        const section = sectionFromPayload(payload);
        const pid = section === undefined ? undefined : parsePatPmtPid(section);
        if (pid !== undefined) pmtPid = pid;
      }
      continue;
    }
    if (packet.pid === pmtPid) {
      if (packet.payloadUnitStart && payload !== undefined) {
        const section = sectionFromPayload(payload);
        if (section !== undefined) {
          for (const stream of parsePmtSampleAesStreams(section)) {
            streamsByPid.set(stream.pid, stream);
          }
        }
      }
      continue;
    }
    const stream = streamsByPid.get(packet.pid);
    if (stream === undefined || payload === undefined) continue;
    if (packet.payloadUnitStart) {
      flush(packet.pid);
      builders.set(packet.pid, {
        codec: stream.codec,
        chunks: [payload],
        length: payload.byteLength,
      });
    } else {
      const builder = builders.get(packet.pid);
      if (builder !== undefined) {
        builder.chunks.push(payload);
        builder.length += payload.byteLength;
      }
    }
  }

  for (const pid of [...builders.keys()]) flush(pid);
  return out;
}

function parseTsPacket(bytes: Uint8Array, packetStart: number): TsPacket | undefined {
  if (bytes[packetStart] !== TS_SYNC) return undefined;
  const b1 = bytes[packetStart + 1];
  const b2 = bytes[packetStart + 2];
  const b3 = bytes[packetStart + 3];
  if (b1 === undefined || b2 === undefined || b3 === undefined) return undefined;
  if ((b1 & 0x80) !== 0) return undefined;
  const pid = ((b1 & 0x1f) << 8) | b2;
  if (pid === NULL_PID) return undefined;
  const payloadUnitStart = (b1 & 0x40) !== 0;
  const adaptationFieldControl = (b3 >> 4) & 0x3;
  const hasAdaptation = (adaptationFieldControl & 0x2) !== 0;
  const hasPayload = (adaptationFieldControl & 0x1) !== 0;
  if (adaptationFieldControl === 0) return undefined;
  let cursor = packetStart + 4;
  if (hasAdaptation) {
    const adaptationLength = bytes[cursor];
    if (adaptationLength === undefined) return undefined;
    cursor += 1 + adaptationLength;
  }
  const packetEnd = packetStart + TS_PACKET_SIZE;
  if (!hasPayload || cursor >= packetEnd) return { pid, payloadUnitStart };
  return { pid, payloadUnitStart, payload: bytes.subarray(cursor, packetEnd) };
}

function sectionFromPayload(payload: Uint8Array): Uint8Array | undefined {
  const pointer = payload[0];
  if (pointer === undefined) return undefined;
  const start = 1 + pointer;
  return start <= payload.byteLength ? payload.subarray(start) : undefined;
}

function parsePatPmtPid(section: Uint8Array): number | undefined {
  if (section[0] !== 0x00) return undefined;
  const sectionLength = (((section[1] ?? 0) & 0x0f) << 8) | (section[2] ?? 0);
  const end = Math.min(3 + sectionLength - 4, section.byteLength);
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    const programNumber = ((section[offset] ?? 0) << 8) | (section[offset + 1] ?? 0);
    const pid = (((section[offset + 2] ?? 0) & 0x1f) << 8) | (section[offset + 3] ?? 0);
    if (programNumber !== 0) return pid;
  }
  return undefined;
}

function parsePmtSampleAesStreams(section: Uint8Array): SampleAesStream[] {
  if (section[0] !== 0x02) return [];
  const sectionLength = (((section[1] ?? 0) & 0x0f) << 8) | (section[2] ?? 0);
  const end = Math.min(3 + sectionLength - 4, section.byteLength);
  const programInfoLength = (((section[10] ?? 0) & 0x0f) << 8) | (section[11] ?? 0);
  const streams: SampleAesStream[] = [];
  let offset = 12 + programInfoLength;
  while (offset + 5 <= end) {
    const streamType = section[offset] ?? 0;
    const pid = (((section[offset + 1] ?? 0) & 0x1f) << 8) | (section[offset + 2] ?? 0);
    const esInfoLength = (((section[offset + 3] ?? 0) & 0x0f) << 8) | (section[offset + 4] ?? 0);
    if (streamType === STREAM_TYPE_H264) streams.push({ pid, codec: 'h264' });
    else if (streamType === STREAM_TYPE_AAC_ADTS) streams.push({ pid, codec: 'aac' });
    offset += 5 + esInfoLength;
  }
  return streams;
}

function flattenPes(builder: PesBuilder): Uint8Array {
  if (builder.chunks.length === 1) return (builder.chunks[0] as Uint8Array).slice();
  const out = new Uint8Array(builder.length);
  let offset = 0;
  for (const chunk of builder.chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function writeBackPes(pes: Uint8Array, builder: PesBuilder): void {
  let offset = 0;
  for (const chunk of builder.chunks) {
    chunk.set(pes.subarray(offset, offset + chunk.byteLength));
    offset += chunk.byteLength;
  }
}

function encryptPesPayload(
  pes: Uint8Array,
  codec: SampleAesCodec,
  key: Uint8Array,
  iv: Uint8Array,
): void {
  const payloadStart = pesPayloadStart(pes);
  if (payloadStart === undefined) return;
  const payload = pes.subarray(payloadStart);
  if (codec === 'h264') encryptH264SampleAes(payload, key, iv);
  else encryptAacSampleAes(payload, key, iv);
}

function pesPayloadStart(pes: Uint8Array): number | undefined {
  if (pes.byteLength < 9) return undefined;
  if (pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) return undefined;
  const headerDataLength = pes[8] ?? 0;
  const start = 9 + headerDataLength;
  return start <= pes.byteLength ? start : undefined;
}

function encryptH264SampleAes(payload: Uint8Array, key: Uint8Array, iv: Uint8Array): void {
  for (const nal of annexBNalRanges(payload)) {
    const header = payload[nal.start];
    if (header === undefined) continue;
    const nalType = header & 0x1f;
    if (nalType !== 1 && nalType !== 5) continue;
    cryptBlockRuns(payload, h264EncryptedRuns(nal.start, nal.end), key, iv);
  }
}

function annexBNalRanges(payload: Uint8Array): { readonly start: number; readonly end: number }[] {
  const starts: { readonly startCode: number; readonly body: number }[] = [];
  for (let offset = 0; offset + 3 < payload.byteLength; offset += 1) {
    if (payload[offset] !== 0x00 || payload[offset + 1] !== 0x00) continue;
    if (payload[offset + 2] === 0x01 && isPlausibleH264NalHeader(payload, offset + 3)) {
      starts.push({ startCode: offset, body: offset + 3 });
      offset += 2;
    } else if (
      offset + 4 < payload.byteLength &&
      payload[offset + 2] === 0x00 &&
      payload[offset + 3] === 0x01 &&
      isPlausibleH264NalHeader(payload, offset + 4)
    ) {
      starts.push({ startCode: offset, body: offset + 4 });
      offset += 3;
    }
  }
  const ranges: { readonly start: number; readonly end: number }[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const current = starts[i];
    if (current === undefined) continue;
    const next = starts[i + 1];
    const end = next === undefined ? payload.byteLength : next.startCode;
    if (current.body < end) ranges.push({ start: current.body, end });
  }
  return ranges;
}

function isPlausibleH264NalHeader(payload: Uint8Array, offset: number): boolean {
  const header = payload[offset];
  if (header === undefined || (header & 0x80) !== 0) return false;
  const nalType = header & 0x1f;
  return nalType > 0 && nalType < 24;
}

function h264EncryptedRuns(nalStart: number, nalEnd: number): BlockRun[] {
  const runs: BlockRun[] = [];
  let offset = nalStart + H264_CLEAR_LEAD;
  while (nalEnd - offset > AES_BLOCK) {
    runs.push({ offset, length: AES_BLOCK });
    offset += AES_BLOCK;
    offset += Math.min(H264_SKIP_BYTES, Math.max(0, nalEnd - offset));
  }
  return runs;
}

function encryptAacSampleAes(payload: Uint8Array, key: Uint8Array, iv: Uint8Array): void {
  for (const frame of adtsFrameRanges(payload)) {
    const encryptedBytes =
      Math.floor((frame.end - frame.start - AAC_CLEAR_LEAD) / AES_BLOCK) * AES_BLOCK;
    if (encryptedBytes <= 0) continue;
    cryptBlockRuns(
      payload,
      [{ offset: frame.start + AAC_CLEAR_LEAD, length: encryptedBytes }],
      key,
      iv,
    );
  }
}

function adtsFrameRanges(payload: Uint8Array): { readonly start: number; readonly end: number }[] {
  const ranges: { readonly start: number; readonly end: number }[] = [];
  let offset = 0;
  while (offset + 7 <= payload.byteLength) {
    const b0 = payload[offset] ?? 0;
    const b1 = payload[offset + 1] ?? 0;
    if (b0 !== 0xff || (b1 & 0xf0) !== 0xf0) break;
    const frameLength =
      (((payload[offset + 3] ?? 0) & 0x03) << 11) |
      ((payload[offset + 4] ?? 0) << 3) |
      ((payload[offset + 5] ?? 0) >> 5);
    if (frameLength < 7 || offset + frameLength > payload.byteLength) break;
    ranges.push({ start: offset, end: offset + frameLength });
    offset += frameLength;
  }
  return ranges;
}

function cryptBlockRuns(
  target: Uint8Array,
  runs: readonly BlockRun[],
  key: Uint8Array,
  iv: Uint8Array,
): void {
  const total = runs.reduce((sum, run) => sum + run.length, 0);
  if (total === 0) return;
  const clear = new Uint8Array(total);
  let offset = 0;
  for (const run of runs) {
    clear.set(target.subarray(run.offset, run.offset + run.length), offset);
    offset += run.length;
  }
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encrypted = new Uint8Array(Buffer.concat([cipher.update(clear), cipher.final()]));
  offset = 0;
  for (const run of runs) {
    target.set(encrypted.subarray(offset, offset + run.length), run.offset);
    offset += run.length;
  }
}
