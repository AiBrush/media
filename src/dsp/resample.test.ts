import { describe, expect, it } from 'vitest';
import { CapabilityError } from '../contracts/errors.ts';
import { readWavPcm } from '../drivers/wav/pcm.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { type PcmAudio, channelAt, encodePcm, sampleAt } from './pcm.ts';
import { resample } from './resample.ts';

/** Synthesize a pure sine of `freq` Hz at `rate` for `seconds`, peak amplitude `amp`. */
function sine(freq: number, rate: number, seconds: number, amp = 0.5): PcmAudio {
  const frames = Math.round(rate * seconds);
  const ch = new Float64Array(frames);
  const w = (2 * Math.PI * freq) / rate;
  for (let n = 0; n < frames; n++) ch[n] = amp * Math.sin(w * n);
  return { sampleRate: rate, channels: 1, frames, planar: [ch] };
}

/** Mean of x² over an interior window (skip `edge` samples either side to avoid filter transients). */
function energy(x: Float64Array, edge: number): number {
  let s = 0;
  let n = 0;
  for (let i = edge; i < x.length - edge; i++) {
    const v = sampleAt(x, i);
    s += v * v;
    n++;
  }
  return n > 0 ? s / n : 0;
}

/** Signal-to-noise ratio (dB) of `got` vs `ref` over an interior window (residual = got − ref). */
function snrDb(ref: Float64Array, got: Float64Array, edge: number): number {
  let sig = 0;
  let err = 0;
  let n = 0;
  const len = Math.min(ref.length, got.length);
  for (let i = edge; i < len - edge; i++) {
    const r = sampleAt(ref, i);
    const d = sampleAt(got, i) - r;
    sig += r * r;
    err += d * d;
    n++;
  }
  if (n === 0 || err === 0) return Number.POSITIVE_INFINITY;
  return 10 * Math.log10(sig / err);
}

/** Power at exactly `freq` via a Goertzel-style projection onto cos/sin (no FFT dependency). */
function powerAt(x: Float64Array, freq: number, rate: number): number {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * freq) / rate;
  for (let n = 0; n < x.length; n++) {
    const v = sampleAt(x, n);
    re += v * Math.cos(w * n);
    im += v * Math.sin(w * n);
  }
  const norm = x.length > 0 ? x.length / 2 : 1;
  return Math.sqrt(re * re + im * im) / norm;
}

function maxAbs(x: Float64Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(sampleAt(x, i)));
  return m;
}

describe('resample — quality (band-limited windowed-sinc)', () => {
  it('equal in/out rate is a bit-exact identity copy (new buffer)', () => {
    const a = sine(1000, 48000, 0.05);
    const r = resample(a, 48000);
    expect(r.sampleRate).toBe(48000);
    expect(r.frames).toBe(a.frames);
    expect(channelAt(r.planar, 0)).toEqual(channelAt(a.planar, 0));
    expect(channelAt(r.planar, 0)).not.toBe(channelAt(a.planar, 0)); // copied, not aliased
  });

  it('output length is round(frames · outRate / inRate) — up and down', () => {
    for (const [inR, outR] of [
      [44100, 48000],
      [48000, 44100],
      [16000, 48000],
      [48000, 16000],
      [44100, 22050],
      [8000, 44100],
    ] as const) {
      const a = sine(500, inR, 0.1);
      const r = resample(a, outR);
      expect(r.frames).toBe(Math.round((a.frames * outR) / inR));
      expect(r.sampleRate).toBe(outR);
    }
  });

  it('preserves a tone frequency (peak power stays at f) when upsampling 44100 → 48000', () => {
    const f = 997;
    const a = sine(f, 44100, 0.25);
    const r = resample(a, 48000);
    const ch = channelAt(r.planar, 0);
    const atF = powerAt(ch, f, 48000);
    // The tone survives at f; spurious energy a major-third away is far weaker.
    expect(atF).toBeGreaterThan(0.45); // ~0.5 amplitude preserved
    expect(powerAt(ch, f * 1.25, 48000)).toBeLessThan(atF * 0.02);
  });

  it('44100 → 48000 → 44100 round-trip has high SNR (> 60 dB)', () => {
    const a = sine(997, 44100, 0.25);
    const up = resample(a, 48000);
    const back = resample(up, 44100);
    const snr = snrDb(channelAt(a.planar, 0), channelAt(back.planar, 0), 64);
    expect(snr).toBeGreaterThan(60);
  });

  it('48000 → 44100 → 48000 round-trip (down-first) has high SNR (> 60 dB)', () => {
    const a = sine(1234, 48000, 0.25);
    const down = resample(a, 44100);
    const back = resample(down, 48000);
    const snr = snrDb(channelAt(a.planar, 0), channelAt(back.planar, 0), 64);
    expect(snr).toBeGreaterThan(60);
  });

  it('anti-aliases: a tone above the new Nyquist is killed, never folded to a spurious in-band tone', () => {
    // 22000 Hz at 44100 (just under the old 22050 Nyquist) → 22050 Hz out (new Nyquist 11025): the tone
    // is well above the new Nyquist, deep in the stopband, so a band-limited resampler must KILL it. If
    // it instead aliased, it would fold to |22000 − 22050| = 50 Hz at full amplitude — a gross artifact.
    const a = sine(22000, 44100, 0.25, 0.9);
    const r = resample(a, 22050);
    const ch = channelAt(r.planar, 0);
    expect(maxAbs(ch)).toBeLessThan(0.9 * 10 ** (-50 / 20)); // > 50 dB suppression of the out-of-band tone
    expect(energy(ch, 16)).toBeLessThan(energy(channelAt(a.planar, 0), 16) * 1e-5); // > 50 dB power drop
    // No alias: there is no significant energy at the would-be folded frequency (50 Hz) either.
    expect(powerAt(ch, 50, 22050)).toBeLessThan(0.9 * 10 ** (-50 / 20));
  });

  it('preserves DC (a constant signal stays constant)', () => {
    const frames = 2000;
    const ch = new Float64Array(frames).fill(0.5);
    const a: PcmAudio = { sampleRate: 44100, channels: 1, frames, planar: [ch] };
    const r = resample(a, 48000);
    const out = channelAt(r.planar, 0);
    // Interior is flat at 0.5 (edges roll off as the kernel runs past the signal — skip them).
    for (let i = 200; i < out.length - 200; i++) {
      expect(sampleAt(out, i)).toBeCloseTo(0.5, 4);
    }
  });

  it('resamples every channel of a stereo signal independently', () => {
    const left = sine(440, 44100, 0.1, 0.5).planar[0];
    const right = sine(660, 44100, 0.1, 0.3).planar[0];
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    if (!left || !right) return;
    const a: PcmAudio = {
      sampleRate: 44100,
      channels: 2,
      frames: left.length,
      planar: [left, right],
    };
    const r = resample(a, 48000);
    expect(r.channels).toBe(2);
    expect(powerAt(channelAt(r.planar, 0), 440, 48000)).toBeGreaterThan(0.45);
    expect(powerAt(channelAt(r.planar, 1), 660, 48000)).toBeGreaterThan(0.27);
    // No cross-talk: the 660 tone is absent from the left channel and vice-versa.
    expect(powerAt(channelAt(r.planar, 0), 660, 48000)).toBeLessThan(0.01);
    expect(powerAt(channelAt(r.planar, 1), 440, 48000)).toBeLessThan(0.01);
  });

  it('leaves the input audio untouched', () => {
    const a = sine(1000, 44100, 0.05);
    const before = channelAt(a.planar, 0).slice();
    resample(a, 48000);
    expect(channelAt(a.planar, 0)).toEqual(before);
  });

  it('handles empty input (no samples) without crashing', () => {
    const a: PcmAudio = {
      sampleRate: 44100,
      channels: 1,
      frames: 0,
      planar: [new Float64Array(0)],
    };
    const r = resample(a, 48000);
    expect(r.frames).toBe(0);
    expect(channelAt(r.planar, 0).length).toBe(0);
  });

  it('rejects an invalid target sample rate with a typed CapabilityError', () => {
    const a = sine(1000, 44100, 0.01);
    expect(() => resample(a, 0)).toThrow(CapabilityError);
    expect(() => resample(a, -48000)).toThrow(CapabilityError);
    expect(() => resample(a, 44100.5)).toThrow(CapabilityError);
    expect(() => resample(a, Number.NaN)).toThrow(CapabilityError);
  });
});

describe('resample — on the real WAV corpus', () => {
  it('sin_440Hz_-6dBFS_1s.wav: 44100→48000→44100 round-trip preserves the tone (SNR high, no clipping)', async () => {
    const file = await loadFixture('sin_440Hz_-6dBFS_1s.wav');
    const a = readWavPcm(file);
    expect(a.sampleRate).toBe(44100);
    expect(a.channels).toBe(1);

    const up = resample(a, 48000);
    expect(up.sampleRate).toBe(48000);
    expect(up.frames).toBe(Math.round((a.frames * 48000) / 44100));

    const back = resample(up, 44100);
    expect(back.frames).toBe(Math.round((up.frames * 44100) / 48000));

    const ref = channelAt(a.planar, 0);
    const got = channelAt(back.planar, 0);
    // Real-audio quality: high round-trip SNR on the upsample/downsample branches both exercised.
    expect(snrDb(ref, got, 128)).toBeGreaterThan(60);

    // No clipping introduced by the resampler (stays within the source's peak + a tiny ringing margin).
    expect(maxAbs(channelAt(up.planar, 0))).toBeLessThanOrEqual(maxAbs(ref) + 0.02);
    expect(maxAbs(got)).toBeLessThanOrEqual(maxAbs(ref) + 0.02);

    // The intermediate upsampled tone is still 440 Hz and energy is preserved within tolerance.
    expect(powerAt(channelAt(up.planar, 0), 440, 48000)).toBeGreaterThan(0.4);
    const eIn = energy(ref, 128);
    const eUp = energy(channelAt(up.planar, 0), 128);
    expect(eUp).toBeGreaterThan(eIn * 0.9);
    expect(eUp).toBeLessThan(eIn * 1.1);
  });

  it('speech.wav: 16000→48000 upsample then back preserves energy with no clipping', async () => {
    const file = await loadFixture('speech.wav');
    const a = readWavPcm(file);
    expect(a.sampleRate).toBe(16000);
    expect(a.channels).toBe(1);

    const up = resample(a, 48000); // upsample branch
    expect(up.frames).toBe(Math.round((a.frames * 48000) / 16000));
    const back = resample(up, 16000); // downsample branch
    expect(back.frames).toBe(Math.round((up.frames * 16000) / 48000));

    const ref = channelAt(a.planar, 0);
    // Energy preserved within tolerance through the full up+down round-trip on real speech.
    const eIn = energy(ref, 64);
    const eOut = energy(channelAt(back.planar, 0), 64);
    expect(eOut).toBeGreaterThan(eIn * 0.85);
    expect(eOut).toBeLessThan(eIn * 1.15);

    // No clipping anywhere in the resampled output (re-encoding to s16 would not saturate).
    expect(maxAbs(channelAt(up.planar, 0))).toBeLessThanOrEqual(maxAbs(ref) + 0.02);
    expect(maxAbs(channelAt(back.planar, 0))).toBeLessThanOrEqual(maxAbs(ref) + 0.02);
    // The upsampled audio re-encodes to s16 cleanly (no NaN / no overflow → valid byte length).
    expect(encodePcm(up, 's16').byteLength).toBe(up.frames * 2);
  });
});

describe('resample — filter-support edges (kernel taps outside the prototype table)', () => {
  it('a tiny signal upsampled by a large ratio stays finite (out-of-support taps read 0)', () => {
    // At the first/last outputs the windowed-sinc reaches past the (very short) input, so the kernel
    // reads prototype taps outside the table → the out-of-support `return 0` arm runs; output is finite.
    const tiny: PcmAudio = {
      sampleRate: 8000,
      channels: 1,
      frames: 4,
      planar: [Float64Array.from([0.5, -0.5, 0.25, -0.25])],
    };
    const up = resample(tiny, 48000); // 6× → edges hit the support boundary
    expect(up.frames).toBeGreaterThan(4);
    const out = channelAt(up.planar, 0);
    for (let i = 0; i < up.frames; i++) expect(Number.isFinite(sampleAt(out, i))).toBe(true);
    expect(maxAbs(out)).toBeLessThanOrEqual(0.6); // bounded by the input peak; no edge blow-up
  });

  it('a same-rate resample is an identity pass-through (ratio 1)', () => {
    const a: PcmAudio = {
      sampleRate: 44100,
      channels: 1,
      frames: 5,
      planar: [Float64Array.from([0.1, 0.2, 0.3, 0.4, 0.5])],
    };
    expect(Array.from(channelAt(resample(a, 44100).planar, 0))).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
  });
});
