/**
 * Direct WAV/s16 -> native FLAC authoring for the no-DSP FLAC convert path. This intentionally emits
 * VERBATIM FLAC subframes: the output is a standards-valid, self-MD5'd lossless FLAC stream, while avoiding
 * the canonical Float64 PCM bridge and the LPC/Rice search that dominates tiny no-transform jobs.
 */

import { finalizeMd5, newMd5State, updateMd5 } from '../../codecs/flac/encode.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';
import { parseWavPcmData } from './pcm.ts';

const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43] as const; // fLaC
const STREAMINFO_BLOCK_BYTES = 38; // 4-byte metadata header + 34-byte STREAMINFO body.
const STREAMINFO_BODY_BYTES = 34;
const DEFAULT_BLOCK_SIZE = 4096;
const S16_BYTES = 2;
const MAX_FLAC_CHANNELS = 8;
const MAX_FLAC_SAMPLE_RATE = 0xfffff;
const MAX_FLAC_TOTAL_SAMPLES = 2 ** 36 - 1;
const STREAMINFO_S16_BITS_PER_SAMPLE_MINUS_ONE = 15;

const CRC8_TABLE: Uint8Array = (() => {
  const table = new Uint8Array(256);
  for (let n = 0; n < table.length; n++) {
    let crc = n;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    table[n] = crc;
  }
  return table;
})();

const CRC16_TABLE: Uint16Array = (() => {
  const table = new Uint16Array(256);
  for (let n = 0; n < table.length; n++) {
    let crc = n << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
    table[n] = crc;
  }
  return table;
})();

/**
 * Try the narrow direct route. `undefined` means "unsupported but well-formed enough to let the canonical
 * PCM path try"; malformed s16 geometry throws typed errors just like the canonical encoder would.
 */
export function tryAuthorWavS16Flac(bytes: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  const parsed = parseWavPcmData(bytes);
  if (parsed.format !== 's16') return undefined;

  const { fmt, data } = parsed;
  validateS16FlacLayout(fmt.channels, fmt.sampleRate, data.byteLength);
  const blockAlign = fmt.channels * S16_BYTES;
  const totalSamples = data.byteLength / blockAlign;
  const frameCount = Math.ceil(totalSamples / DEFAULT_BLOCK_SIZE);

  let totalBytes = FLAC_MAGIC.length + STREAMINFO_BLOCK_BYTES;
  let minFrameBytes = 0xffffff;
  let maxFrameBytes = 0;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const samples = frameSamples(totalSamples, frameIndex);
    const frameBytes = flacFrameBytes(fmt.channels, samples, frameIndex);
    minFrameBytes = Math.min(minFrameBytes, frameBytes);
    maxFrameBytes = Math.max(maxFrameBytes, frameBytes);
    totalBytes += frameBytes;
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new InputError(`WAV s16 -> FLAC output is too large (${totalBytes})`);
  }

  const out = new Uint8Array(totalBytes) as Uint8Array<ArrayBuffer>;
  let offset = 0;
  out[offset++] = FLAC_MAGIC[0];
  out[offset++] = FLAC_MAGIC[1];
  out[offset++] = FLAC_MAGIC[2];
  out[offset++] = FLAC_MAGIC[3];

  offset = writeStreamInfo(out, offset, {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    totalSamples,
    minFrameBytes,
    maxFrameBytes,
    md5: pcmPayloadMd5(data),
  });

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    offset = writeVerbatimFrame(out, offset, data, {
      channels: fmt.channels,
      totalSamples,
      frameIndex,
    });
  }
  if (offset !== out.byteLength) {
    throw new MediaError(
      'encode-error',
      'WAV s16 -> FLAC writer produced an unexpected byte count',
    );
  }
  return out;
}

function validateS16FlacLayout(channels: number, sampleRate: number, dataBytes: number): void {
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_FLAC_CHANNELS) {
    throw new InputError(`FLAC encode channel count ${channels} is invalid`);
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > MAX_FLAC_SAMPLE_RATE) {
    throw new InputError(`FLAC encode sample rate ${sampleRate} is invalid`);
  }
  const blockAlign = channels * S16_BYTES;
  if (dataBytes % blockAlign !== 0) {
    throw new InputError('WAV s16 PCM data is not sample-frame aligned');
  }
  const totalSamples = dataBytes / blockAlign;
  if (
    !Number.isSafeInteger(totalSamples) ||
    totalSamples <= 0 ||
    totalSamples > MAX_FLAC_TOTAL_SAMPLES
  ) {
    throw new InputError(`FLAC encode totalSamples ${totalSamples} is invalid`);
  }
}

function pcmPayloadMd5(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const state = newMd5State();
  updateMd5(state, data);
  return finalizeMd5(state);
}

interface StreamInfoInput {
  readonly sampleRate: number;
  readonly channels: number;
  readonly totalSamples: number;
  readonly minFrameBytes: number;
  readonly maxFrameBytes: number;
  readonly md5: Uint8Array;
}

function writeStreamInfo(out: Uint8Array, offset: number, info: StreamInfoInput): number {
  let cursor = offset;
  out[cursor++] = 0x80; // last metadata block + STREAMINFO type.
  out[cursor++] = 0x00;
  out[cursor++] = 0x00;
  out[cursor++] = STREAMINFO_BODY_BYTES;

  const bodyOffset = cursor;
  const body = new DataView(out.buffer, out.byteOffset + bodyOffset, STREAMINFO_BODY_BYTES);
  const nominalBlockSize = Math.min(DEFAULT_BLOCK_SIZE, info.totalSamples);
  body.setUint16(0, nominalBlockSize, false);
  body.setUint16(2, nominalBlockSize, false);
  writeU24(out, bodyOffset + 4, info.minFrameBytes);
  writeU24(out, bodyOffset + 7, info.maxFrameBytes);

  const totalHigh = Math.floor(info.totalSamples / 2 ** 32);
  const packed =
    info.sampleRate * 2 ** 12 +
    (info.channels - 1) * 2 ** 9 +
    STREAMINFO_S16_BITS_PER_SAMPLE_MINUS_ONE * 2 ** 4 +
    totalHigh;
  body.setUint32(10, packed, false);
  body.setUint32(14, info.totalSamples >>> 0, false);
  out.set(info.md5, bodyOffset + 18);
  return bodyOffset + STREAMINFO_BODY_BYTES;
}

interface FrameWriteInput {
  readonly channels: number;
  readonly totalSamples: number;
  readonly frameIndex: number;
}

function writeVerbatimFrame(
  out: Uint8Array,
  offset: number,
  data: Uint8Array,
  input: FrameWriteInput,
): number {
  const frameOffset = offset;
  let cursor = offset;
  const startSample = input.frameIndex * DEFAULT_BLOCK_SIZE;
  const samples = frameSamples(input.totalSamples, input.frameIndex);
  const blockAlign = input.channels * S16_BYTES;

  cursor = writeFrameHeader(out, cursor, input.channels, samples, input.frameIndex);
  const blockByte = startSample * blockAlign;
  for (let channel = 0; channel < input.channels; channel++) {
    out[cursor++] = 0x02; // zero pad bit + VERBATIM subframe type + no wasted-bits flag.
    let sourceOffset = blockByte + channel * S16_BYTES;
    for (let i = 0; i < samples; i++) {
      const lo = data[sourceOffset] as number;
      out[cursor++] = data[sourceOffset + 1] as number;
      out[cursor++] = lo;
      sourceOffset += blockAlign;
    }
  }

  const crc = crc16(out, frameOffset, cursor);
  out[cursor++] = (crc >>> 8) & 0xff;
  out[cursor++] = crc & 0xff;
  return cursor;
}

function frameSamples(totalSamples: number, frameIndex: number): number {
  return Math.min(DEFAULT_BLOCK_SIZE, totalSamples - frameIndex * DEFAULT_BLOCK_SIZE);
}

function flacFrameBytes(channels: number, samples: number, frameIndex: number): number {
  return frameHeaderBytes(samples, frameIndex) + channels * (1 + samples * S16_BYTES) + S16_BYTES;
}

function frameHeaderBytes(samples: number, frameIndex: number): number {
  return 4 + utf8UintBytes(frameIndex) + explicitBlockSizeBytes(samples) + 1;
}

function explicitBlockSizeBytes(samples: number): 0 | 1 | 2 {
  if (standardBlockSizeCode(samples) !== undefined) return 0;
  return samples <= 256 ? 1 : 2;
}

function writeFrameHeader(
  out: Uint8Array,
  offset: number,
  channels: number,
  samples: number,
  frameIndex: number,
): number {
  const start = offset;
  let cursor = offset;
  const standardCode = standardBlockSizeCode(samples);
  const explicitBytes = explicitBlockSizeBytes(samples);
  const blockSizeCode = standardCode ?? (explicitBytes === 1 ? 6 : 7);

  out[cursor++] = 0xff;
  out[cursor++] = 0xf8; // 14-bit sync + fixed-blocksize stream.
  out[cursor++] = blockSizeCode << 4; // sample-rate code 0 means STREAMINFO.
  out[cursor++] = (channels - 1) << 4; // independent channels; sample-size code 0 means STREAMINFO.
  cursor = writeUtf8Uint(out, cursor, frameIndex);
  if (explicitBytes === 1) {
    out[cursor++] = samples - 1;
  } else if (explicitBytes === 2) {
    out[cursor++] = ((samples - 1) >>> 8) & 0xff;
    out[cursor++] = (samples - 1) & 0xff;
  }
  const headerCrc = crc8(out, start, cursor);
  out[cursor++] = headerCrc;
  return cursor;
}

function standardBlockSizeCode(samples: number): number | undefined {
  switch (samples) {
    case 192:
      return 1;
    case 576:
      return 2;
    case 1152:
      return 3;
    case 2304:
      return 4;
    case 256:
      return 8;
    case 512:
      return 9;
    case 1024:
      return 10;
    case 2048:
      return 11;
    case 4096:
      return 12;
    default:
      return undefined;
  }
}

function utf8UintBytes(value: number): number {
  if (value <= 0x7f) return 1;
  let length = 2;
  while (length < 7 && value >= 2 ** (5 * length + 1)) length++;
  return length;
}

function writeUtf8Uint(out: Uint8Array, offset: number, value: number): number {
  if (value <= 0x7f) {
    out[offset] = value;
    return offset + 1;
  }
  const length = utf8UintBytes(value);
  let rest = value;
  for (let i = length - 1; i > 0; i--) {
    out[offset + i] = 0x80 | (rest & 0x3f);
    rest = Math.floor(rest / 64);
  }
  out[offset] = ((0xff << (8 - length)) & 0xff) | rest;
  return offset + length;
}

function crc8(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let offset = start; offset < end; offset++) {
    crc = CRC8_TABLE[crc ^ (bytes[offset] as number)] as number;
  }
  return crc;
}

function crc16(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let offset = start; offset < end; offset++) {
    const index = ((crc >>> 8) ^ (bytes[offset] as number)) & 0xff;
    crc = ((crc << 8) ^ (CRC16_TABLE[index] as number)) & 0xffff;
  }
  return crc;
}

function writeU24(bytes: Uint8Array, offset: number, value: number): void {
  if (value < 0 || value > 0xffffff) {
    throw new MediaError('encode-error', `FLAC frame size ${value} cannot fit in STREAMINFO`);
  }
  bytes[offset] = (value >>> 16) & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = value & 0xff;
}
