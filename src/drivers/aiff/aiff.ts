/**
 * AIFF / AIFF-C ⇄ PCM bridge — the pure, big-endian IFF chunk walk (the Node-validatable seam, mirroring
 * `wav/pcm.ts`). AIFF is Electronic Arts' IFF: a `FORM` group whose formType is `AIFF` (uncompressed) or
 * `AIFC` (AIFF-C, which adds a `compressionType`). `COMM` carries the layout (channels, numSampleFrames,
 * sampleSize, and the sample rate as an **80-bit IEEE 754 extended float**); `SSND` carries the samples
 * after an 8-byte offset/blockSize header. Everything is big-endian — only AIFF-C `sowt` flips the
 * samples to little-endian. `writeAiff(readAiffPcm(file), …)` reproduces the source SSND samples
 * **byte-exact** (the `decoded-audio-pcm` oracle).
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

/** The AIFF dialect (`FORM` formType): plain `AIFF` vs AIFF-C `AIFC`. */
export type AiffKind = 'aiff' | 'aifc';

/** The decoded AIFF/AIFF-C audio layout (`COMM`) plus where the samples live (`SSND`). */
export interface AiffLayout {
  kind: AiffKind;
  /** AIFF-C compression 4cc (`NONE`/`twos`/`sowt`/`fl32`/…); `'NONE'` for plain AIFF. */
  compression: string;
  channels: number;
  /** Per the spec field name (`numSampleFrames`): samples *per channel*. */
  frames: number;
  /** Declared bit depth (`sampleSize`); the wire {@link SampleFormat} is derived from it + compression. */
  sampleSize: number;
  sampleRate: number;
  format: SampleFormat;
  endian: Endianness;
}

/** PCM audio plus the wire {@link SampleFormat}, endianness, and AIFF dialect for a faithful rewrite. */
export interface AiffPcm extends PcmAudio {
  readonly format: SampleFormat;
  readonly endian: Endianness;
  readonly kind: AiffKind;
  readonly compression: string;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/**
 * Decode an 80-bit IEEE 754 extended-precision float (the AIFF `COMM` sample rate). Unlike float32/64,
 * the 64-bit mantissa is **explicit** (no implicit leading 1), so the value is
 * `(-1)^sign · mantissa · 2^(exponent − 16383 − 63)`. BigInt keeps all 64 mantissa bits exact.
 */
export function readExtendedFloat80(dv: DataView, off: number): number {
  const signExp = dv.getUint16(off); // big-endian: 1-bit sign + 15-bit exponent
  const sign = signExp & 0x8000 ? -1 : 1;
  const exponent = signExp & 0x7fff;
  const mantissa = (BigInt(dv.getUint32(off + 2)) << 32n) | BigInt(dv.getUint32(off + 6));
  if (exponent === 0 && mantissa === 0n) return 0;
  // value = mantissa · 2^(exponent − 16383 − 63); split the scale so Number stays in range.
  return sign * Number(mantissa) * 2 ** (exponent - 16383 - 63);
}

/** Encode a finite non-negative number as an 80-bit IEEE 754 extended float (for the writer). */
export function writeExtendedFloat80(value: number): Uint8Array {
  const out = new Uint8Array(10);
  if (!Number.isFinite(value) || value <= 0) return out; // 0 / non-finite → all-zero extended (0.0)
  // Normalize to mantissa·2^e with the mantissa in [2^63, 2^64) (the explicit leading bit at bit 63).
  const TWO_POW_63 = 2 ** 63;
  const TWO_POW_64 = 2 ** 64;
  let exponent = 16383 + 63;
  let m = value;
  while (m < TWO_POW_63) {
    m *= 2;
    exponent -= 1;
  }
  while (m >= TWO_POW_64) {
    m /= 2;
    exponent += 1;
  }
  const mantissa = BigInt(Math.round(m));
  const dv = new DataView(out.buffer);
  dv.setUint16(0, exponent & 0x7fff);
  dv.setUint32(2, Number((mantissa >> 32n) & 0xffffffffn));
  dv.setUint32(6, Number(mantissa & 0xffffffffn));
  return out;
}

/** Map an AIFF-C compression 4cc + declared bit depth to a wire {@link SampleFormat} + endianness. */
function formatFromCompression(
  compression: string,
  sampleSize: number,
): { format: SampleFormat; endian: Endianness } {
  switch (compression) {
    case 'NONE': // canonical uncompressed AIFF-C
    case 'twos': // two's-complement big-endian PCM (== NONE)
    case 'in16':
    case 'in24':
    case 'in32':
      return { format: intFormat(sampleSize), endian: 'be' };
    case 'sowt': // byte-swapped two's-complement → little-endian PCM
    case 'lpcm':
      return { format: intFormat(sampleSize), endian: 'le' };
    case 'fl32':
    case 'FL32':
      return { format: 'f32', endian: 'be' };
    case 'fl64':
    case 'FL64':
      return { format: 'f64', endian: 'be' };
    default:
      throw new CapabilityError(
        'capability-miss',
        `AIFF-C compression '${compression}' is not linear PCM (needs a codec tier)`,
        { op: 'demux', tried: ['aiff'] },
      );
  }
}

function intFormat(sampleSize: number): SampleFormat {
  // AIFF 8-bit PCM is *signed* (two's-complement), which the dsp's offset-binary `u8` cannot represent
  // exactly; rather than corrupt it by 128, declare an honest miss until a signed-8-bit path exists.
  if (sampleSize <= 8) {
    throw new CapabilityError(
      'capability-miss',
      'AIFF signed 8-bit PCM is not yet supported (the dsp PCM core is offset-binary u8 only)',
      { op: 'demux', tried: ['aiff'] },
    );
  }
  if (sampleSize <= 16) return 's16';
  if (sampleSize <= 24) return 's24';
  if (sampleSize <= 32) return 's32';
  throw new InputError('unsupported-input', `unsupported AIFF sample size ${sampleSize}-bit`);
}

interface Chunk {
  id: string;
  body: number;
  size: number;
}

/** Walk the `FORM` body, returning each chunk's id/offset/size (big-endian, even-padded like RIFF). */
function* chunks(bytes: Uint8Array, dv: DataView): Generator<Chunk> {
  let pos = 12; // FORM(4) + size(4) + formType(4)
  while (pos + 8 <= bytes.byteLength) {
    const id = ascii(bytes, pos, 4);
    const size = dv.getUint32(pos + 4);
    const body = pos + 8;
    yield { id, body, size };
    pos = body + size + (size & 1); // chunks are padded to an even length
  }
}

function parseComm(
  bytes: Uint8Array,
  dv: DataView,
  c: Chunk,
  kind: AiffKind,
): Omit<AiffLayout, 'kind'> {
  if (c.size < 18 || c.body + 18 > bytes.byteLength) {
    throw new MediaError('demux-error', 'AIFF: truncated COMM chunk');
  }
  const channels = dv.getUint16(c.body);
  const frames = dv.getUint32(c.body + 2);
  const sampleSize = dv.getUint16(c.body + 6);
  const sampleRate = readExtendedFloat80(dv, c.body + 8);
  let compression = 'NONE';
  if (kind === 'aifc') {
    if (c.size < 22 || c.body + 22 > bytes.byteLength) {
      throw new MediaError('demux-error', 'AIFF-C: COMM missing compressionType');
    }
    compression = ascii(bytes, c.body + 18, 4);
  }
  const { format, endian } = formatFromCompression(compression, sampleSize);
  if (channels <= 0) throw new MediaError('demux-error', `AIFF: invalid channel count ${channels}`);
  return { compression, channels, frames, sampleSize, sampleRate, format, endian };
}

/** Locate the `COMM` layout + `SSND` sample bytes in an AIFF/AIFF-C file (pure; big-endian). */
function locate(bytes: Uint8Array): {
  layout: AiffLayout;
  ssndBody: number;
  ssndSampleOffset: number;
  ssndSampleBytes: number;
} {
  if (
    bytes.byteLength < 12 ||
    ascii(bytes, 0, 4) !== 'FORM' ||
    (ascii(bytes, 8, 4) !== 'AIFF' && ascii(bytes, 8, 4) !== 'AIFC')
  ) {
    throw new InputError('unsupported-input', 'not an AIFF/AIFF-C (FORM…AIFF/AIFC) file');
  }
  const kind: AiffKind = ascii(bytes, 8, 4) === 'AIFC' ? 'aifc' : 'aiff';
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let comm: Omit<AiffLayout, 'kind'> | undefined;
  let ssnd: { body: number; sampleOffset: number; sampleBytes: number } | undefined;
  for (const c of chunks(bytes, dv)) {
    if (c.id === 'COMM' && comm === undefined) {
      comm = parseComm(bytes, dv, c, kind);
    } else if (c.id === 'SSND' && ssnd === undefined) {
      if (c.size < 8) throw new MediaError('demux-error', 'AIFF: truncated SSND chunk');
      const dataOffset = dv.getUint32(c.body); // skip N alignment bytes before the first sample
      const samples = c.body + 8 + dataOffset;
      const declared = c.size - 8 - dataOffset;
      ssnd = {
        body: c.body,
        sampleOffset: samples,
        sampleBytes: Math.max(0, Math.min(declared, bytes.byteLength - samples)),
      };
    }
  }
  if (!comm) throw new MediaError('demux-error', 'AIFF: no COMM chunk');
  return {
    layout: { kind, ...comm },
    ssndBody: ssnd?.body ?? -1,
    ssndSampleOffset: ssnd?.sampleOffset ?? -1,
    ssndSampleBytes: ssnd?.sampleBytes ?? 0,
  };
}

export interface AiffInfo {
  container: 'aiff';
  codec: string;
  kind: AiffKind;
  sampleRate: number;
  channels: number;
  sampleSize: number;
  frames: number;
  durationSec: number;
}

/** PCM/float codec token per the harness vocabulary: big-endian ints carry a `be` suffix; LE/float don't. */
export function aiffCodec(format: SampleFormat, endian: Endianness): string {
  if (format === 'f32') return 'pcm-f32';
  if (format === 'f64') return 'pcm-f64';
  return endian === 'be' ? `pcm-${format}be` : `pcm-${format}`;
}

/** Parse an AIFF/AIFF-C header into the audio layout + duration (pure; reads no samples). */
export function parseAiff(bytes: Uint8Array): AiffInfo {
  const { layout } = locate(bytes);
  return {
    container: 'aiff',
    codec: aiffCodec(layout.format, layout.endian),
    kind: layout.kind,
    sampleRate: Math.round(layout.sampleRate),
    channels: layout.channels,
    sampleSize: layout.sampleSize,
    frames: layout.frames,
    durationSec: layout.sampleRate > 0 ? layout.frames / layout.sampleRate : 0,
  };
}

/** Read an AIFF/AIFF-C file's samples into canonical planar Float64 audio (honors the wire endianness). */
export function readAiffPcm(bytes: Uint8Array): AiffPcm {
  const { layout, ssndSampleOffset, ssndSampleBytes } = locate(bytes);
  const data =
    ssndSampleOffset < 0
      ? new Uint8Array(0)
      : bytes.subarray(ssndSampleOffset, ssndSampleOffset + ssndSampleBytes);
  const audio = decodePcm(
    data,
    layout.format,
    layout.channels,
    Math.round(layout.sampleRate),
    layout.endian,
  );
  return {
    ...audio,
    format: layout.format,
    endian: layout.endian,
    kind: layout.kind,
    compression: layout.compression,
  };
}

function writeFourCC(dv: DataView, offset: number, tag: string): void {
  for (let i = 0; i < 4; i++) dv.setUint8(offset + i, tag.charCodeAt(i));
}

/** The AIFF-C compression 4cc that re-encodes a given wire format/endianness losslessly. */
function compressionFor(format: SampleFormat, endian: Endianness): string {
  if (format === 'f32') return 'fl32';
  if (format === 'f64') return 'fl64';
  return endian === 'le' ? 'sowt' : 'NONE';
}

/**
 * Serialize canonical audio to a canonical AIFF (`kind:'aiff'`, big-endian) or AIFF-C (`kind:'aifc'`,
 * with a `FVER` + `compressionType`) file in the given wire format. The source sample-format/endianness
 * is preserved so a decode→encode round-trip reproduces the SSND samples byte-exact.
 */
export function writeAiff(
  audio: PcmAudio,
  format: SampleFormat,
  opts: { kind?: AiffKind; endian?: Endianness } = {},
): Uint8Array<ArrayBuffer> {
  // f32/f64 only exist as AIFF-C compressions; force AIFC for them. 'sowt' (LE) likewise needs AIFC.
  const isFloat = format === 'f32' || format === 'f64';
  const endian: Endianness = opts.endian ?? 'be';
  const kind: AiffKind = isFloat || endian === 'le' ? 'aifc' : (opts.kind ?? 'aiff');
  const data = encodePcm(audio, format, endian);
  const bytesPer = bytesPerSample(format);

  // COMM body: channels(2) numFrames(4) sampleSize(2) rate(10) [+ compressionType(4) + Pascal name].
  const compression = compressionFor(format, endian);
  const name = 'aibrush-media';
  // Pascal string: length byte + chars, padded to an even total length.
  const pascalLen = 1 + name.length;
  const pascalPad = pascalLen & 1; // pad the COMM body to an even size
  const commSize = kind === 'aifc' ? 18 + 4 + pascalLen + pascalPad : 18;

  const fverSize = kind === 'aifc' ? 12 : 0; // 'FVER'(4) + size(4) + version(4)
  const ssndSize = 8 + data.byteLength; // offset(4) + blockSize(4) + samples
  const formType = 4; // 'AIFF' | 'AIFC'
  const formBody = formType + fverSize + (8 + commSize + (commSize & 1)) + (8 + ssndSize);

  const out = new Uint8Array(8 + formBody);
  const dv = new DataView(out.buffer);
  writeFourCC(dv, 0, 'FORM');
  dv.setUint32(4, formBody);
  writeFourCC(dv, 8, kind === 'aifc' ? 'AIFC' : 'AIFF');
  let p = 12;

  if (kind === 'aifc') {
    writeFourCC(dv, p, 'FVER');
    dv.setUint32(p + 4, 4);
    dv.setUint32(p + 8, 0xa2805140); // AIFC version 1 (the standard timestamp)
    p += 12;
  }

  writeFourCC(dv, p, 'COMM');
  dv.setUint32(p + 4, commSize);
  dv.setUint16(p + 8, audio.channels);
  dv.setUint32(p + 10, audio.frames);
  dv.setUint16(p + 14, bytesPer * 8);
  out.set(writeExtendedFloat80(audio.sampleRate), p + 16);
  if (kind === 'aifc') {
    writeFourCC(dv, p + 26, compression);
    dv.setUint8(p + 30, name.length);
    for (let i = 0; i < name.length; i++) dv.setUint8(p + 31 + i, name.charCodeAt(i));
  }
  p += 8 + commSize + (commSize & 1);

  writeFourCC(dv, p, 'SSND');
  dv.setUint32(p + 4, ssndSize);
  dv.setUint32(p + 8, 0); // offset
  dv.setUint32(p + 12, 0); // blockSize
  out.set(data, p + 16);
  return out;
}
