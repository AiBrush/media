/**
 * CAF (Apple Core Audio Format) ⇄ PCM bridge — the pure, big-endian chunk walk (the Node-validatable
 * seam, mirroring `wav/pcm.ts`). A CAF file is a `caff` header (version+flags) followed by chunks, each a
 * 4cc type + a **signed 64-bit** size (a final `data` chunk may declare `-1` = "to EOF"). The `desc`
 * chunk is the Audio Stream Basic Description (ASBD): an f64 sample rate, a format 4cc (`lpcm` for raw
 * PCM), and format flags whose bits select **float** and **little-endian**. The `data` chunk is a u32
 * `mEditCount` then the interleaved samples. `writeCaf(readCafPcm(file), …)` reproduces the source `data`
 * samples **byte-exact** (the `decoded-audio-pcm` oracle).
 */

import { CapabilityError, InputError, MediaError } from '../../contracts/errors.ts';
import {
  type Endianness,
  type PcmAudio,
  type SampleFormat,
  bytesPerSample,
  decodePcm,
  encodePcm,
} from '../../dsp/pcm.ts';

// CoreAudio ASBD format flags (kAudioFormatFlag*): bit 0 = IsFloat, bit 1 = IsLittleEndian (CAF stores
// the canonical flags, where 0x2 means little-endian PCM). CoreAudio canonicalizes integer PCM to
// **signed** two's-complement at every depth (it omits IsSignedInteger in the file but `afinfo` reports
// "signed integer"), so 8-bit CAF PCM is signed (`s8`) rather than WAV-style offset-binary `u8`.
const FLAG_FLOAT = 0x1;
const FLAG_LITTLE_ENDIAN = 0x2;

/** The decoded CAF ASBD (`desc`) — enough to read/locate raw PCM. */
export interface CafAsbd {
  sampleRate: number;
  formatId: string;
  formatFlags: number;
  bytesPerPacket: number;
  framesPerPacket: number;
  channels: number;
  bitsPerChannel: number;
}

/** PCM audio plus the wire {@link SampleFormat} + endianness, for a faithful CAF rewrite. */
export interface CafPcm extends PcmAudio {
  readonly format: SampleFormat;
  readonly endian: Endianness;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/** Map an `lpcm` ASBD (bits + float/endian flags) to a wire {@link SampleFormat} + endianness. */
function formatFromAsbd(asbd: CafAsbd): { format: SampleFormat; endian: Endianness } {
  if (asbd.formatId !== 'lpcm') {
    throw new CapabilityError(
      `CAF format '${asbd.formatId}' is not linear PCM (needs a codec tier)`,
      { op: { kind: 'route', id: 'demux' }, tried: ['caf'] },
    );
  }
  const endian: Endianness = asbd.formatFlags & FLAG_LITTLE_ENDIAN ? 'le' : 'be';
  const bits = asbd.bitsPerChannel;
  if (asbd.formatFlags & FLAG_FLOAT) {
    if (bits === 32) return { format: 'f32', endian };
    if (bits === 64) return { format: 'f64', endian };
    throw new InputError(`unsupported CAF float depth ${bits}-bit`);
  }
  if (bits === 8) return { format: 's8', endian };
  if (bits === 16) return { format: 's16', endian };
  if (bits === 24) return { format: 's24', endian };
  if (bits === 32) return { format: 's32', endian };
  throw new InputError(`unsupported CAF PCM depth ${bits}-bit`);
}

const MAX_SAFE_CAF_CHUNK_SIZE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Validate one signed CAF chunk size before converting it to a JS number. `-1` is the sole negative
 * sentinel and is legal only for a trailing `data` chunk ("through EOF").
 */
export function parseCafChunkSize(raw: bigint, type: string): number {
  if (raw < -1n) throw new InputError(`CAF: invalid negative '${type}' chunk size`);
  if (raw === -1n && type !== 'data') {
    throw new InputError('CAF: only a final data chunk may declare size -1');
  }
  if (raw > MAX_SAFE_CAF_CHUNK_SIZE) {
    throw new InputError(`CAF: '${type}' chunk size exceeds the safe integer range`);
  }
  return Number(raw);
}

interface CafChunk {
  type: string;
  body: number;
  size: number; // -1 means "to EOF" (final data chunk)
}

/** Walk CAF chunks after the 8-byte `caff` header (no even-padding — sizes are exact s64). */
function* cafChunks(bytes: Uint8Array, dv: DataView): Generator<CafChunk> {
  let pos = 8; // 'caff'(4) + mFileVersion(2) + mFileFlags(2)
  while (pos < bytes.byteLength) {
    if (bytes.byteLength - pos < 12) {
      throw new MediaError('demux-error', 'CAF: truncated chunk header');
    }
    const type = ascii(bytes, pos, 4);
    const size = parseCafChunkSize(dv.getBigInt64(pos + 4), type);
    const body = pos + 12;
    const availableBodyBytes = bytes.byteLength - body;
    if (size !== -1 && size > availableBodyBytes) {
      throw new MediaError('demux-error', `CAF: truncated '${type}' chunk`);
    }
    yield { type, body, size };
    if (size === -1) return; // a -1 ("to EOF") data chunk is necessarily the last one
    pos = body + size;
  }
}

/** Parse the fixed 32-byte Audio Stream Basic Description body of a CAF `desc` chunk. */
export function parseCafAsbd(bytes: Uint8Array): CafAsbd {
  if (bytes.byteLength < 32) {
    throw new MediaError('demux-error', 'CAF: truncated Audio Description (desc) chunk');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    sampleRate: dv.getFloat64(0),
    formatId: ascii(bytes, 8, 4),
    formatFlags: dv.getUint32(12),
    bytesPerPacket: dv.getUint32(16),
    framesPerPacket: dv.getUint32(20),
    channels: dv.getUint32(24),
    bitsPerChannel: dv.getUint32(28),
  };
}

function parseDesc(bytes: Uint8Array, c: CafChunk): CafAsbd {
  if (c.size < 32 || c.body + 32 > bytes.byteLength) {
    throw new MediaError('demux-error', 'CAF: truncated Audio Description (desc) chunk');
  }
  return parseCafAsbd(bytes.subarray(c.body, c.body + 32));
}

/** Locate the `desc` ASBD + the `data` chunk's sample range in a CAF file (pure; big-endian). */
function locate(bytes: Uint8Array): {
  asbd: CafAsbd;
  sampleOffset: number;
  sampleBytes: number;
} {
  if (bytes.byteLength < 8 || ascii(bytes, 0, 4) !== 'caff') {
    throw new InputError('not a CAF (caff) file');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let asbd: CafAsbd | undefined;
  let data: { sampleOffset: number; sampleBytes: number } | undefined;
  for (const c of cafChunks(bytes, dv)) {
    if (c.type === 'desc' && asbd === undefined) {
      asbd = parseDesc(bytes, c);
    } else if (c.type === 'data' && data === undefined) {
      // The data chunk opens with a u32 mEditCount; the samples follow. A size of -1 runs to EOF.
      const availableBodyBytes = bytes.byteLength - c.body;
      if (availableBodyBytes < 4) {
        throw new MediaError('demux-error', 'CAF: truncated data chunk edit count');
      }
      if (c.size !== -1 && c.size < 4) {
        throw new MediaError('demux-error', 'CAF: data chunk is smaller than its edit count');
      }
      const samples = c.body + 4;
      const declared = c.size === -1 ? bytes.byteLength - samples : c.size - 4;
      data = {
        sampleOffset: samples,
        sampleBytes: Math.max(0, Math.min(declared, bytes.byteLength - samples)),
      };
    }
  }
  if (!asbd) throw new MediaError('demux-error', 'CAF: no Audio Description (desc) chunk');
  return {
    asbd,
    sampleOffset: data?.sampleOffset ?? -1,
    sampleBytes: data?.sampleBytes ?? 0,
  };
}

export interface CafInfo {
  container: 'caf';
  codec: string;
  sampleRate: number;
  channels: number;
  bitsPerChannel: number;
  frames: number;
  durationSec: number;
}

/** PCM/float codec token per the harness vocabulary: big-endian ints carry a `be` suffix; LE/float don't. */
export function cafCodec(format: SampleFormat, endian: Endianness): string {
  if (format === 'f32') return 'pcm-f32';
  if (format === 'f64') return 'pcm-f64';
  if (format === 's8') return 'pcm-s8';
  return endian === 'be' ? `pcm-${format}be` : `pcm-${format}`;
}

/** Number of whole sample frames in the located PCM `data` for the given ASBD. */
function frameCount(asbd: CafAsbd, sampleBytes: number, format: SampleFormat): number {
  const frameBytes = asbd.channels * bytesPerSample(format);
  return frameBytes > 0 ? Math.floor(sampleBytes / frameBytes) : 0;
}

/** Build public CAF metadata from a parsed ASBD and the exact number of available sample bytes. */
export function cafInfoFromAsbd(asbd: CafAsbd, sampleBytes: number): CafInfo {
  const { format, endian } = formatFromAsbd(asbd);
  const frames = frameCount(asbd, sampleBytes, format);
  return {
    container: 'caf',
    codec: cafCodec(format, endian),
    sampleRate: Math.round(asbd.sampleRate),
    channels: asbd.channels,
    bitsPerChannel: asbd.bitsPerChannel,
    frames,
    durationSec: asbd.sampleRate > 0 ? frames / asbd.sampleRate : 0,
  };
}

/** Parse a CAF header into the audio layout + duration (pure; reads no samples beyond the header). */
export function parseCaf(bytes: Uint8Array): CafInfo {
  const { asbd, sampleBytes } = locate(bytes);
  return cafInfoFromAsbd(asbd, sampleBytes);
}

/** Read a CAF file's samples into canonical planar Float64 audio (honors the ASBD endianness). */
export function readCafPcm(bytes: Uint8Array): CafPcm {
  const { asbd, sampleOffset, sampleBytes } = locate(bytes);
  const { format, endian } = formatFromAsbd(asbd);
  const data =
    sampleOffset < 0 ? new Uint8Array(0) : bytes.subarray(sampleOffset, sampleOffset + sampleBytes);
  const audio = decodePcm(data, format, asbd.channels, Math.round(asbd.sampleRate), endian);
  return { ...audio, format, endian };
}

function writeFourCC(dv: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) dv.setUint8(offset + i, tag.charCodeAt(i));
}

/**
 * Serialize canonical audio to a minimal, valid CAF file (`caff` + `desc` + `data`) in the given wire
 * format/endianness. Source format/endianness is preserved, so a decode→encode round-trip reproduces the
 * `data` samples byte-exact.
 */
export function writeCaf(
  audio: PcmAudio,
  format: SampleFormat,
  endian: Endianness = 'le',
): Uint8Array<ArrayBuffer> {
  if (format === 'u8') {
    throw new CapabilityError('CAF 8-bit PCM is signed; use pcm-s8', {
      op: { kind: 'route', id: 'pcm-write', facts: { container: 'caf', sampleFormat: format } },
      tried: ['caf'],
    });
  }
  const data = encodePcm(audio, format, endian);
  const bytesPer = bytesPerSample(format);
  const isFloat = format === 'f32' || format === 'f64';
  const flags = (isFloat ? FLAG_FLOAT : 0) | (endian === 'le' ? FLAG_LITTLE_ENDIAN : 0);

  const DESC_SIZE = 32;
  const dataSize = 4 + data.byteLength; // mEditCount(4) + samples
  const out = new Uint8Array(8 + (12 + DESC_SIZE) + (12 + dataSize));
  const dv = new DataView(out.buffer);

  writeFourCC(dv, 0, 'caff');
  dv.setUint16(4, 1); // mFileVersion
  dv.setUint16(6, 0); // mFileFlags

  writeFourCC(dv, 8, 'desc');
  dv.setBigInt64(12, BigInt(DESC_SIZE));
  dv.setFloat64(20, audio.sampleRate);
  writeFourCC(dv, 28, 'lpcm');
  dv.setUint32(32, flags);
  dv.setUint32(36, audio.channels * bytesPer); // mBytesPerPacket
  dv.setUint32(40, 1); // mFramesPerPacket
  dv.setUint32(44, audio.channels); // mChannelsPerFrame
  dv.setUint32(48, bytesPer * 8); // mBitsPerChannel

  const dataChunk = 8 + 12 + DESC_SIZE;
  writeFourCC(dv, dataChunk, 'data');
  dv.setBigInt64(dataChunk + 4, BigInt(dataSize));
  dv.setUint32(dataChunk + 12, 0); // mEditCount
  out.set(data, dataChunk + 16);
  return out;
}
