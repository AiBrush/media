/**
 * HLS segment decrypt helpers. `AES-128` is full-segment AES-128-CBC + PKCS#7 (RFC 8216 §4.3.2.4);
 * `SAMPLE-AES` here is the Session-8 key-provided MPEG-TS H.264/AAC slice (ADR-121), where TS/PES
 * structure stays in place and only protected sample payload blocks are AES-CBC-decrypted.
 */

import { InputError, MediaError } from '../contracts/errors.ts';
import { AES_BLOCK, aesCbcNoPadding, aesCbcPkcs7 } from './aes.ts';

/** AES-128 key length in bytes. */
const AES128_KEY_LEN = 16;
const TS_SYNC = 0x47;
const TS_PACKET_SIZES = [188, 192, 204] as const;
const PAT_PID = 0x0000;
const NULL_PID = 0x1fff;
const STREAM_TYPE_AAC_ADTS = 0x0f;
const STREAM_TYPE_H264 = 0x1b;
const H264_CLEAR_LEAD = 32;
const H264_SKIP_BYTES = 144;
const AAC_CLEAR_LEAD = 16;

type TsPacketSize = (typeof TS_PACKET_SIZES)[number];
type SampleAesCodec = 'h264' | 'aac';

interface TsFraming {
  readonly packetSize: TsPacketSize;
  readonly start: number;
  readonly tsOffset: number;
}

interface TsPacket {
  readonly pid: number;
  readonly payloadUnitStart: boolean;
  readonly scrambled: boolean;
  readonly payload?: Uint8Array;
}

interface SampleAesStream {
  readonly pid: number;
  readonly codec: SampleAesCodec;
}

interface PesChunk {
  readonly bytes: Uint8Array;
}

interface PesBuilder {
  readonly pid: number;
  readonly codec: SampleAesCodec;
  readonly chunks: PesChunk[];
  length: number;
}

interface BlockRun {
  readonly offset: number;
  readonly length: number;
}

/**
 * Decrypt an HLS `AES-128` (AES-128-CBC + PKCS#7) segment payload. `key` must be 16 bytes, `iv` 16
 * bytes, and the ciphertext a positive multiple of 16 (a CBC invariant) — otherwise the input is not a
 * valid AES-128 segment and a typed {@link InputError} is raised rather than producing garbage. Returns
 * the cleartext segment bytes (PKCS#7 padding removed). An invalid pad surfaces as a SubtleCrypto
 * `OperationError` from the underlying decrypt (wrong key/IV), never a silent wrong result.
 */
export async function decryptHlsAes128(
  payload: Uint8Array,
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (key.byteLength !== AES128_KEY_LEN) {
    throw new InputError(
      'unsupported-input',
      `HLS AES-128 key must be ${AES128_KEY_LEN} bytes, got ${key.byteLength}`,
    );
  }
  if (iv.byteLength !== AES_BLOCK) {
    throw new InputError(
      'unsupported-input',
      `HLS AES-128 IV must be ${AES_BLOCK} bytes, got ${iv.byteLength}`,
    );
  }
  if (payload.byteLength === 0 || payload.byteLength % AES_BLOCK !== 0) {
    throw new InputError(
      'unsupported-input',
      `HLS AES-128 segment must be a positive multiple of ${AES_BLOCK} bytes (CBC), got ${payload.byteLength}`,
    );
  }
  return aesCbcPkcs7(key, iv, payload, 'decrypt');
}

/**
 * Decrypt HLS `SAMPLE-AES` for MPEG-TS H.264/AAC segments with an identity 16-byte key and IV.
 *
 * This is not full-segment AES-128. The transport packets, PAT/PMT/PES headers, timestamps, and packet
 * boundaries stay byte-for-byte in place. Only protected sample payload blocks are AES-CBC-decrypted:
 *
 * - H.264 slice NAL units (`nal_unit_type` 1 and 5): first 32 NAL bytes clear, then a 16-byte encrypted
 *   block every 160 bytes (16 encrypted + up to 144 clear), with CBC IV reset per NAL.
 * - ADTS AAC frames: first 16 frame bytes clear, then all remaining full 16-byte blocks encrypted, with
 *   CBC IV reset per frame.
 */
export async function decryptHlsSampleAesTs(
  payload: Uint8Array,
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  assertSampleAesKeyIv(key, iv);
  if (payload.byteLength === 0) {
    throw new InputError('unsupported-input', 'HLS SAMPLE-AES segment is empty');
  }

  const framing = detectTsFraming(payload);
  if (framing === undefined) {
    throw new InputError('unsupported-input', 'HLS SAMPLE-AES decrypt expects an MPEG-TS segment');
  }

  const out = payload.slice();
  const streamsByPid = new Map<number, SampleAesStream>();
  const builders = new Map<number, PesBuilder>();
  let pmtPid: number | undefined;
  let sawScrambled = false;
  let sawSupportedStream = false;
  let decryptedBlocks = 0;

  const flush = async (pid: number): Promise<void> => {
    const builder = builders.get(pid);
    builders.delete(pid);
    if (builder === undefined) return;
    const pes = flattenPes(builder);
    decryptedBlocks += await decryptPesPayload(pes, builder.codec, key, iv);
    writeBackPes(pes, builder);
  };

  for (
    let packetStart = framing.start;
    packetStart + framing.tsOffset + 188 <= out.byteLength;
    packetStart += framing.packetSize
  ) {
    const syncAt = packetStart + framing.tsOffset;
    const packet = parseTsPacket(out, syncAt);
    if (packet === undefined) continue;
    if (packet.scrambled) {
      sawScrambled = true;
      continue;
    }

    const { pid, payloadUnitStart, payload: packetPayload } = packet;
    if (pid === PAT_PID) {
      if (pmtPid === undefined && payloadUnitStart && packetPayload !== undefined) {
        const section = sectionFromPayload(packetPayload);
        const patPmtPid = section === undefined ? undefined : parsePatPmtPid(section);
        if (patPmtPid !== undefined) pmtPid = patPmtPid;
      }
      continue;
    }

    if (pid === pmtPid) {
      if (payloadUnitStart && packetPayload !== undefined) {
        const section = sectionFromPayload(packetPayload);
        if (section !== undefined) {
          for (const stream of parsePmtSampleAesStreams(section)) {
            streamsByPid.set(stream.pid, stream);
            sawSupportedStream = true;
          }
        }
      }
      continue;
    }

    const stream = streamsByPid.get(pid);
    if (stream === undefined || packetPayload === undefined) continue;
    if (payloadUnitStart) {
      await flush(pid);
      builders.set(pid, {
        pid,
        codec: stream.codec,
        chunks: [{ bytes: packetPayload }],
        length: packetPayload.byteLength,
      });
    } else {
      const builder = builders.get(pid);
      if (builder !== undefined) {
        builder.chunks.push({ bytes: packetPayload });
        builder.length += packetPayload.byteLength;
      }
    }
  }

  for (const pid of [...builders.keys()]) await flush(pid);

  if (!sawSupportedStream) {
    if (sawScrambled) {
      throw new InputError(
        'unsupported-input',
        'MPEG-TS transport scrambling is not HLS SAMPLE-AES',
      );
    }
    throw new MediaError('decode-error', 'HLS SAMPLE-AES found no H.264/AAC TS streams');
  }
  if (decryptedBlocks === 0) {
    throw new MediaError('decode-error', 'HLS SAMPLE-AES found no encrypted sample blocks');
  }
  return out;
}

function assertSampleAesKeyIv(key: Uint8Array<ArrayBuffer>, iv: Uint8Array<ArrayBuffer>): void {
  if (key.byteLength !== AES128_KEY_LEN) {
    throw new InputError(
      'unsupported-input',
      `HLS SAMPLE-AES key must be ${AES128_KEY_LEN} bytes, got ${key.byteLength}`,
    );
  }
  if (iv.byteLength !== AES_BLOCK) {
    throw new InputError(
      'unsupported-input',
      `HLS SAMPLE-AES IV must be ${AES_BLOCK} bytes, got ${iv.byteLength}`,
    );
  }
}

function detectTsFraming(bytes: Uint8Array): TsFraming | undefined {
  const run = 8;
  for (const packetSize of TS_PACKET_SIZES) {
    const tsOffset = packetSize === 192 ? 4 : 0;
    const scanLimit = Math.min(bytes.byteLength, packetSize * 4);
    for (let base = 0; base + tsOffset < scanLimit; base += 1) {
      const first = base + tsOffset;
      if (bytes[first] !== TS_SYNC) continue;
      let ok = true;
      for (let i = 0; i < run; i += 1) {
        const at = first + i * packetSize;
        if (at >= bytes.byteLength) {
          ok = i >= 2;
          break;
        }
        if (bytes[at] !== TS_SYNC) {
          ok = false;
          break;
        }
      }
      if (ok) return { packetSize, start: base, tsOffset };
    }
  }
  return undefined;
}

function parseTsPacket(bytes: Uint8Array, syncAt: number): TsPacket | undefined {
  if (bytes[syncAt] !== TS_SYNC) return undefined;
  const b1 = bytes[syncAt + 1];
  const b2 = bytes[syncAt + 2];
  const b3 = bytes[syncAt + 3];
  if (b1 === undefined || b2 === undefined || b3 === undefined) return undefined;
  if ((b1 & 0x80) !== 0) return undefined;
  const pid = ((b1 & 0x1f) << 8) | b2;
  if (pid === NULL_PID) return undefined;
  const payloadUnitStart = (b1 & 0x40) !== 0;
  const scrambled = (b3 & 0xc0) !== 0;
  const adaptationFieldControl = (b3 >> 4) & 0x3;
  if (adaptationFieldControl === 0) return undefined;
  const hasAdaptation = (adaptationFieldControl & 0x2) !== 0;
  const hasPayload = (adaptationFieldControl & 0x1) !== 0;

  let cursor = syncAt + 4;
  const packetEnd = syncAt + 188;
  if (hasAdaptation) {
    const adaptationLength = bytes[cursor];
    if (adaptationLength === undefined) return undefined;
    cursor += 1 + adaptationLength;
  }
  if (!hasPayload || cursor >= packetEnd) return { pid, payloadUnitStart, scrambled };
  return {
    pid,
    payloadUnitStart,
    scrambled,
    payload: bytes.subarray(cursor, packetEnd),
  };
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
  for (let i = 8; i + 4 <= end; i += 4) {
    const programNumber = ((section[i] ?? 0) << 8) | (section[i + 1] ?? 0);
    const pid = (((section[i + 2] ?? 0) & 0x1f) << 8) | (section[i + 3] ?? 0);
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
  if (builder.chunks.length === 1) return (builder.chunks[0] as PesChunk).bytes.slice();
  const out = new Uint8Array(builder.length);
  let offset = 0;
  for (const chunk of builder.chunks) {
    out.set(chunk.bytes, offset);
    offset += chunk.bytes.byteLength;
  }
  return out;
}

function writeBackPes(pes: Uint8Array, builder: PesBuilder): void {
  let offset = 0;
  for (const chunk of builder.chunks) {
    chunk.bytes.set(pes.subarray(offset, offset + chunk.bytes.byteLength));
    offset += chunk.bytes.byteLength;
  }
}

async function decryptPesPayload(
  pes: Uint8Array,
  codec: SampleAesCodec,
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
): Promise<number> {
  const payloadStart = pesPayloadStart(pes);
  if (payloadStart === undefined) return 0;
  const payload = pes.subarray(payloadStart);
  return codec === 'h264'
    ? decryptH264SampleAes(payload, key, iv)
    : decryptAacSampleAes(payload, key, iv);
}

function pesPayloadStart(pes: Uint8Array): number | undefined {
  if (pes.byteLength < 9) return undefined;
  if (pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) return undefined;
  const streamId = pes[3] ?? 0;
  const isMedia = (streamId >= 0xc0 && streamId <= 0xdf) || (streamId >= 0xe0 && streamId <= 0xef);
  if (!isMedia) return undefined;
  const headerDataLength = pes[8] ?? 0;
  const start = 9 + headerDataLength;
  return start <= pes.byteLength ? start : undefined;
}

async function decryptH264SampleAes(
  payload: Uint8Array,
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
): Promise<number> {
  let blocks = 0;
  for (const nal of annexBNalRanges(payload)) {
    const header = payload[nal.start];
    if (header === undefined) continue;
    const nalType = header & 0x1f;
    if (nalType !== 1 && nalType !== 5) continue;
    const runs = h264EncryptedRuns(nal.start, nal.end);
    blocks += await decryptBlockRuns(payload, runs, key, iv);
  }
  return blocks;
}

function annexBNalRanges(payload: Uint8Array): { readonly start: number; readonly end: number }[] {
  const starts: { startCode: number; body: number }[] = [];
  for (let i = 0; i + 3 < payload.byteLength; i += 1) {
    if (payload[i] !== 0x00 || payload[i + 1] !== 0x00) continue;
    if (payload[i + 2] === 0x01 && isPlausibleH264NalHeader(payload, i + 3)) {
      starts.push({ startCode: i, body: i + 3 });
      i += 2;
    } else if (i + 4 < payload.byteLength && payload[i + 2] === 0x00 && payload[i + 3] === 0x01) {
      if (!isPlausibleH264NalHeader(payload, i + 4)) continue;
      starts.push({ startCode: i, body: i + 4 });
      i += 3;
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

async function decryptAacSampleAes(
  payload: Uint8Array,
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
): Promise<number> {
  let blocks = 0;
  for (const frame of adtsFrameRanges(payload)) {
    const encryptedBytes =
      Math.floor((frame.end - frame.start - AAC_CLEAR_LEAD) / AES_BLOCK) * AES_BLOCK;
    if (encryptedBytes <= 0) continue;
    blocks += await decryptBlockRuns(
      payload,
      [{ offset: frame.start + AAC_CLEAR_LEAD, length: encryptedBytes }],
      key,
      iv,
    );
  }
  return blocks;
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

async function decryptBlockRuns(
  target: Uint8Array,
  runs: readonly BlockRun[],
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
): Promise<number> {
  const total = runs.reduce((sum, run) => sum + run.length, 0);
  if (total === 0) return 0;
  const cipher = new Uint8Array(total);
  let offset = 0;
  for (const run of runs) {
    cipher.set(target.subarray(run.offset, run.offset + run.length), offset);
    offset += run.length;
  }
  const clear = await aesCbcNoPadding(key, iv, cipher, 'decrypt');
  offset = 0;
  for (const run of runs) {
    target.set(clear.subarray(offset, offset + run.length), run.offset);
    offset += run.length;
  }
  return total / AES_BLOCK;
}
