import { loadAacCore } from '../../codecs/wasm-aac/wasm-aac-driver.ts';
import type { PcmTransform } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { writeWavHeader } from '../wav/pcm.ts';
import type { AdtsLayout, AdtsPacket } from './adts-driver.ts';

const PCM_OUTPUT_FORMAT = 's16' as const;
const ADTS_DIRECT_WASM_S16_MAX_BYTES = 256 * 1024;
const ADTS_DIRECT_DECODE_BATCH_FRAMES = 32;
const WAV_HEADER_BYTES = 44;
const S16_BYTES_PER_SAMPLE = 2;
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([0x0102]).buffer)[0] === 0x02;

function hasPcmDomainWork(o: PcmTransform | undefined): boolean {
  return (
    o?.gainDb !== undefined ||
    o?.fade !== undefined ||
    o?.dynamics !== undefined ||
    o?.biquad !== undefined ||
    o?.timeBounds !== undefined
  );
}

export function canUseAdtsWasmDirectS16Wav(
  byteLength: number,
  sourceSampleRate: number,
  sourceChannels: number,
  o: PcmTransform | undefined,
  wasmOnlyRuntime: boolean,
): boolean {
  if (!Number.isFinite(byteLength) || byteLength < 0) return false;
  if (o?.container !== undefined && o.container !== 'wav') return false;
  if (o?.sampleFormat !== undefined && o.sampleFormat !== PCM_OUTPUT_FORMAT) return false;
  if (o?.endian !== undefined && o.endian !== 'le') return false;
  if (o?.channels !== undefined && o.channels !== sourceChannels) return false;
  if (o?.sampleRate !== undefined && o.sampleRate !== sourceSampleRate) return false;
  if (hasPcmDomainWork(o)) return false;
  return (
    wasmOnlyRuntime ||
    o?.determinism === 'force-software' ||
    byteLength <= ADTS_DIRECT_WASM_S16_MAX_BYTES
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'unknown error';
}

function s16FromUnitFloat(x: number): number {
  const v = Math.round(x * 32768);
  if (v < -32768) return -32768;
  if (v > 32767) return 32767;
  return v;
}

export function writeInterleavedF32S16le(
  dv: DataView,
  offset: number,
  interleaved: Float32Array,
): number {
  if (HOST_LITTLE_ENDIAN && (dv.byteOffset + offset) % S16_BYTES_PER_SAMPLE === 0) {
    const out = new Int16Array(dv.buffer, dv.byteOffset + offset, interleaved.length);
    for (let i = 0; i < interleaved.length; i++) {
      out[i] = s16FromUnitFloat(interleaved[i] ?? 0);
    }
    return offset + interleaved.length * S16_BYTES_PER_SAMPLE;
  }
  let pos = offset;
  for (let i = 0; i < interleaved.length; i++) {
    dv.setInt16(pos, s16FromUnitFloat(interleaved[i] ?? 0), true);
    pos += S16_BYTES_PER_SAMPLE;
  }
  return pos;
}

function payload(bytes: Uint8Array, frame: AdtsPacket): Uint8Array {
  return bytes.subarray(frame.offset + frame.headerBytes, frame.offset + frame.size);
}

function payloadBatch(
  bytes: Uint8Array,
  frames: readonly AdtsPacket[],
  start: number,
  end: number,
): { readonly data: Uint8Array; readonly offsets: Uint32Array } {
  let total = 0;
  for (let i = start; i < end; i++) {
    const frame = frames[i];
    if (frame === undefined) continue;
    total += frame.size - frame.headerBytes;
  }
  const data = new Uint8Array(total);
  const offsets = new Uint32Array(end - start + 1);
  let pos = 0;
  for (let i = start; i < end; i++) {
    const frame = frames[i];
    if (frame === undefined) continue;
    data.set(payload(bytes, frame), pos);
    pos += frame.size - frame.headerBytes;
    offsets[i - start + 1] = pos;
  }
  return { data, offsets };
}

export async function tryDecodeWasmAacToS16Wav(
  bytes: Uint8Array,
  layout: AdtsLayout,
  o: PcmTransform | undefined,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const core = await loadAacCore();
  if (core === null) return undefined;
  let decoder: ReturnType<typeof core.createDecoder> | undefined;
  try {
    decoder = core.createDecoder(layout.asc, layout.info.channels, layout.info.sampleRate);
    const channels = decoder.channels;
    const sampleRate = decoder.sampleRate;
    if (!Number.isInteger(channels) || channels <= 0) {
      throw new MediaError('decode-error', `aac: invalid decoded channel count ${channels}`);
    }
    if (o?.channels !== undefined && o.channels !== channels) return undefined;
    if (o?.sampleRate !== undefined && o.sampleRate !== sampleRate) return undefined;
    let expectedFrames = 0;
    for (const frame of layout.frames) expectedFrames += frame.samples;
    const out = new Uint8Array(WAV_HEADER_BYTES + expectedFrames * channels * S16_BYTES_PER_SAMPLE);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let offset = WAV_HEADER_BYTES;
    for (let start = 0; start < layout.frames.length; start += ADTS_DIRECT_DECODE_BATCH_FRAMES) {
      throwIfAborted(o?.signal);
      const end = Math.min(layout.frames.length, start + ADTS_DIRECT_DECODE_BATCH_FRAMES);
      const batch = payloadBatch(bytes, layout.frames, start, end);
      const interleaved = decoder.decodeMany(batch.data, batch.offsets);
      if (interleaved.length % channels !== 0) {
        throw new MediaError(
          'decode-error',
          `aac: decoded interleaved length ${interleaved.length} is not divisible by ${channels}`,
        );
      }
      const nextOffset = offset + interleaved.length * S16_BYTES_PER_SAMPLE;
      if (nextOffset > out.byteLength) return undefined;
      offset = writeInterleavedF32S16le(dv, offset, interleaved);
    }
    const dataBytes = offset - WAV_HEADER_BYTES;
    const exact =
      out.byteLength === offset ? out : (out.slice(0, offset) as Uint8Array<ArrayBuffer>);
    writeWavHeader(exact, dataBytes, channels, sampleRate, PCM_OUTPUT_FORMAT);
    return exact;
  } catch (e) {
    if (e instanceof MediaError) throw e;
    throw new MediaError('decode-error', `wasm-aac direct WAV decode: ${errMessage(e)}`, e);
  } finally {
    decoder?.free();
  }
}
