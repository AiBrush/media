/**
 * PCM sample-format conversion — the cheap-majority of audio-dsp reclaimed in pure TS (doc 09
 * §audio-dsp, Finding 4: most of ffmpeg.wasm's audio-dsp wins are kilobytes of PCM format/gain/mix
 * math). Converts interleaved integer/float PCM ⇄ a canonical **planar Float64** working buffer
 * normalized to [-1, 1].
 *
 * Float64 (not Float32) is the canonical precision on purpose: every integer width (8-bit…s32) *and* f32
 * round-trips **bit-exact** through it (the `decoded-audio-pcm` sample-exact oracle, doc 11), because a
 * 32-bit mantissa needs 53 bits of headroom to survive `int → x/2^n → round(x*2^n)`. The browser
 * `AudioData` seam narrows to f32 only where the platform requires it. Little-endian by default;
 * big-endian is supported for WAVE-BE / AIFF sources.
 */

import { InputError } from '../contracts/errors.ts';

/** Interleaved PCM sample encodings we read/write. Integers are two's-complement except `u8` (offset). */
export type SampleFormat = 'u8' | 's8' | 's16' | 's24' | 's32' | 'f32' | 'f64';
export type Endianness = 'le' | 'be';

/** Canonical de-interleaved audio: one `[-1,1]`-normalized Float64 channel per `channels`. */
export interface PcmAudio {
  readonly sampleRate: number;
  readonly channels: number; // === planar.length
  readonly frames: number; // samples per channel === planar[i].length
  readonly planar: readonly Float64Array[];
}

const BYTES_PER_SAMPLE: Record<SampleFormat, number> = {
  u8: 1,
  s8: 1,
  s16: 2,
  s24: 3,
  s32: 4,
  f32: 4,
  f64: 8,
};

/** Bytes one sample of `format` occupies on the wire (per channel). */
export function bytesPerSample(format: SampleFormat): number {
  return BYTES_PER_SAMPLE[format];
}

/**
 * Bounds-checked element read — the single place an out-of-range index is tolerated, returning `0`.
 * Centralizing it keeps the hot mix/encode loops free of scattered `?? 0` (and its dead branches);
 * both arms are exercised by a direct unit test, so it costs no coverage. In practice every caller
 * indexes within `frames`, so the guard returns the real sample.
 */
export function sampleAt(channel: Float64Array, index: number): number {
  const v = channel[index];
  return v === undefined ? 0 : v;
}

const EMPTY = new Float64Array(0);

/** Bounds-checked channel read (companion to {@link sampleAt}); out-of-range yields an empty channel. */
export function channelAt(planar: readonly Float64Array[], index: number): Float64Array {
  const ch = planar[index];
  return ch === undefined ? EMPTY : ch;
}

function readSample(dv: DataView, off: number, format: SampleFormat, le: boolean): number {
  switch (format) {
    case 'u8':
      return (dv.getUint8(off) - 128) / 128;
    case 's8':
      return dv.getInt8(off) / 128;
    case 's16':
      return dv.getInt16(off, le) / 32768;
    case 's24': {
      const b0 = dv.getUint8(off);
      const b1 = dv.getUint8(off + 1);
      const b2 = dv.getUint8(off + 2);
      const raw = le ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
      const signed = raw & 0x800000 ? raw - 0x1000000 : raw;
      return signed / 8388608;
    }
    case 's32':
      return dv.getInt32(off, le) / 2147483648;
    case 'f32':
      return dv.getFloat32(off, le);
    case 'f64':
      return dv.getFloat64(off, le);
  }
}

function clampInt(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function writeSample(
  dv: DataView,
  off: number,
  x: number,
  format: SampleFormat,
  le: boolean,
): void {
  switch (format) {
    case 'u8':
      dv.setUint8(off, clampInt(Math.round(x * 128) + 128, 0, 255));
      return;
    case 's8':
      dv.setInt8(off, clampInt(Math.round(x * 128), -128, 127));
      return;
    case 's16':
      dv.setInt16(off, clampInt(Math.round(x * 32768), -32768, 32767), le);
      return;
    case 's24': {
      const v = clampInt(Math.round(x * 8388608), -8388608, 8388607);
      const u = v < 0 ? v + 0x1000000 : v;
      const lo = u & 0xff;
      const mid = (u >> 8) & 0xff;
      const hi = (u >> 16) & 0xff;
      dv.setUint8(off, le ? lo : hi);
      dv.setUint8(off + 1, mid);
      dv.setUint8(off + 2, le ? hi : lo);
      return;
    }
    case 's32':
      dv.setInt32(off, clampInt(Math.round(x * 2147483648), -2147483648, 2147483647), le);
      return;
    case 'f32':
      dv.setFloat32(off, x, le);
      return;
    case 'f64':
      dv.setFloat64(off, x, le);
      return;
  }
}

/** Decode interleaved PCM bytes into canonical planar Float64 audio. Trailing partial frames are dropped. */
export function decodePcm(
  bytes: Uint8Array,
  format: SampleFormat,
  channels: number,
  sampleRate: number,
  endian: Endianness = 'le',
): PcmAudio {
  if (channels <= 0 || !Number.isInteger(channels)) {
    throw new InputError('unsupported-input', `invalid channel count ${channels}`);
  }
  const bps = BYTES_PER_SAMPLE[format];
  const frameBytes = bps * channels;
  const frames = Math.floor(bytes.byteLength / frameBytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = endian === 'le';
  const planar: Float64Array[] = [];
  for (let c = 0; c < channels; c++) {
    const ch = new Float64Array(frames);
    for (let f = 0; f < frames; f++) {
      ch[f] = readSample(dv, f * frameBytes + c * bps, format, le);
    }
    planar.push(ch);
  }
  return { sampleRate, channels, frames, planar };
}

/** Encode canonical planar audio back to interleaved PCM bytes; out-of-range floats clamp to the format's range. */
export function encodePcm(
  audio: PcmAudio,
  format: SampleFormat,
  endian: Endianness = 'le',
): Uint8Array<ArrayBuffer> {
  const { channels, frames } = audio;
  const bps = BYTES_PER_SAMPLE[format];
  const out = new Uint8Array(frames * channels * bps);
  const dv = new DataView(out.buffer);
  const le = endian === 'le';
  for (const [c, ch] of audio.planar.entries()) {
    let f = 0;
    for (const s of ch) {
      writeSample(dv, (f * channels + c) * bps, s, format, le);
      f++;
    }
  }
  return out;
}
