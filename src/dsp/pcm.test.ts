import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import {
  type SampleFormat,
  bytesPerSample,
  channelAt,
  decodePcm,
  encodePcm,
  sampleAt,
} from './pcm.ts';

/** Deterministic, well-spread byte pattern (no RNG) — exercises the whole sample-value domain. */
function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
}

const INT_FORMATS: SampleFormat[] = ['u8', 's16', 's24', 's32'];

describe('PCM codec — bit-exact round-trip (decoded-audio-pcm oracle)', () => {
  // The strongest oracle that can fail: over ARBITRARY bytes, encode∘decode must be the identity for
  // every integer format (each integer code survives int → x/2^n → round(x·2^n) through Float64).
  for (const format of INT_FORMATS) {
    for (const channels of [1, 2, 6]) {
      it(`${format} / ${channels}ch round-trips arbitrary PCM byte-for-byte`, () => {
        const bytes = pattern(bytesPerSample(format) * channels * 50);
        const audio = decodePcm(bytes, format, channels, 48000);
        expect(audio.channels).toBe(channels);
        expect(audio.frames).toBe(50);
        expect(encodePcm(audio, format)).toEqual(bytes);
      });
    }
  }

  it('s16 big-endian round-trips arbitrary PCM byte-for-byte', () => {
    const bytes = pattern(2 * 2 * 40);
    const audio = decodePcm(bytes, 's16', 2, 44100, 'be');
    expect(encodePcm(audio, 's16', 'be')).toEqual(bytes);
  });

  it('f32 / f64 round-trip finite floats byte-for-byte', () => {
    const f32 = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25, -0.75, 0.125]);
    const b32 = new Uint8Array(f32.buffer.slice(0));
    expect(encodePcm(decodePcm(b32, 'f32', 2, 48000), 'f32')).toEqual(b32);

    const f64 = new Float64Array([0, 0.5, -0.5, 1, -1, 1 / 3, -2 / 7]);
    const b64 = new Uint8Array(f64.buffer.slice(0));
    expect(encodePcm(decodePcm(b64, 'f64', 1, 48000), 'f64')).toEqual(b64);
  });
});

describe('PCM codec — normalization & clamping', () => {
  it('decodes the documented normalization (full-scale → ±1)', () => {
    // s16: -32768 → -1.0, 32767 → ~+1.0; u8: 0 → -1.0, 255 → ~+1.0 (offset binary).
    const s16 = new Uint8Array(new Int16Array([-32768, 32767, 0]).buffer);
    const a = decodePcm(s16, 's16', 1, 8000);
    expect(sampleAt(channelAt(a.planar, 0), 0)).toBe(-1);
    expect(sampleAt(channelAt(a.planar, 0), 1)).toBeCloseTo(1, 4);
    expect(sampleAt(channelAt(a.planar, 0), 2)).toBe(0);

    const u8 = decodePcm(Uint8Array.of(0, 128, 255), 'u8', 1, 8000);
    expect(sampleAt(channelAt(u8.planar, 0), 0)).toBe(-1);
    expect(sampleAt(channelAt(u8.planar, 0), 1)).toBe(0);
  });

  it('clamps out-of-range floats at the integer encode boundary', () => {
    // A synthetic over-unity signal must saturate, not wrap.
    const planar = [Float64Array.of(2, -2, 0.5)];
    const audio = { sampleRate: 8000, channels: 1, frames: 3, planar };
    const out = new Int16Array(encodePcm(audio, 's16').buffer);
    expect(out[0]).toBe(32767); // +2.0 saturates high
    expect(out[1]).toBe(-32768); // -2.0 saturates low
    expect(out[2]).toBe(16384); // 0.5 · 32768

    const out24 = decodePcm(encodePcm(audio, 's24'), 's24', 1, 8000);
    expect(sampleAt(channelAt(out24.planar, 0), 0)).toBeCloseTo(1, 6); // clamped near +1
  });
});

describe('PCM codec — edges & guards', () => {
  it('drops a trailing partial frame', () => {
    const audio = decodePcm(pattern(2 * 2 * 10 + 3), 's16', 2, 48000); // 3 stray bytes
    expect(audio.frames).toBe(10);
  });

  it('handles empty input (no samples)', () => {
    const audio = decodePcm(new Uint8Array(0), 's16', 2, 48000);
    expect(audio.frames).toBe(0);
    expect(encodePcm(audio, 's16')).toEqual(new Uint8Array(0));
  });

  it('rejects an invalid channel count with a typed InputError', () => {
    expect(() => decodePcm(pattern(8), 's16', 0, 48000)).toThrow(InputError);
    expect(() => decodePcm(pattern(8), 's16', 1.5, 48000)).toThrow(InputError);
  });

  it('sampleAt / channelAt guard both arms', () => {
    const ch = Float64Array.of(10, 20);
    expect(sampleAt(ch, 0)).toBe(10);
    expect(sampleAt(ch, 5)).toBe(0); // out of range → 0
    expect(channelAt([ch], 0)).toBe(ch);
    expect(channelAt([ch], 9).length).toBe(0); // out of range → empty
  });

  it('reports bytes per sample', () => {
    expect(bytesPerSample('u8')).toBe(1);
    expect(bytesPerSample('s24')).toBe(3);
    expect(bytesPerSample('f64')).toBe(8);
  });
});
