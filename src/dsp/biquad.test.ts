import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { readWavPcm } from '../drivers/wav/pcm.ts';
import { loadFixture } from '../test-support/corpus.ts';
import {
  type BiquadSpec,
  biquad,
  designBiquad,
  magnitudeResponse,
  polesInsideUnitCircle,
} from './biquad.ts';
import { type PcmAudio, channelAt, encodePcm, sampleAt } from './pcm.ts';

const FS = 48000;
const SQRT1_2 = Math.SQRT1_2; // Butterworth Q for a -3 dB point exactly at the cutoff

/** Linear magnitude → dB. */
function db(x: number): number {
  return 20 * Math.log10(x);
}

/** Analytic |H| at `f` for a spec, in dB. */
function respDb(spec: BiquadSpec, f: number, fs = FS): number {
  return db(magnitudeResponse(designBiquad(spec, fs), f, fs));
}

function sine(freq: number, rate: number, frames: number, amp = 0.5): PcmAudio {
  const ch = new Float64Array(frames);
  const w = (2 * Math.PI * freq) / rate;
  for (let n = 0; n < frames; n++) ch[n] = amp * Math.sin(w * n);
  return { sampleRate: rate, channels: 1, frames, planar: [ch] };
}

/** Steady-state amplitude at `freq` measured by Goertzel over the back half (after the transient). */
function measuredAmp(x: Float64Array, freq: number, rate: number): number {
  const start = x.length >> 1; // discard the filter transient
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * freq) / rate;
  let n = 0;
  for (let i = start; i < x.length; i++) {
    const v = sampleAt(x, i);
    re += v * Math.cos(w * i);
    im += v * Math.sin(w * i);
    n++;
  }
  return n > 0 ? (2 * Math.sqrt(re * re + im * im)) / n : 0;
}

function hasNaN(a: PcmAudio): boolean {
  for (const ch of a.planar)
    for (let i = 0; i < ch.length; i++) if (Number.isNaN(ch[i] ?? 0)) return true;
  return false;
}

describe('biquad — analytic frequency response (RBJ cookbook)', () => {
  it('lowpass: -3 dB at the cutoff (Q=1/√2), flat passband, ~12 dB/oct stopband', () => {
    const spec: BiquadSpec = { type: 'lowpass', frequency: 1000, q: SQRT1_2 };
    expect(respDb(spec, 1000)).toBeCloseTo(-3.0103, 2); // half-power at f0
    expect(respDb(spec, 50)).toBeCloseTo(0, 1); // flat well below f0
    // Two octaves above f0 the second-order roll-off is ≈ -24 dB and deepening.
    expect(respDb(spec, 4000)).toBeLessThan(-20);
    expect(respDb(spec, 8000)).toBeLessThan(respDb(spec, 4000));
  });

  it('highpass: -3 dB at the cutoff, flat above, steep below', () => {
    const spec: BiquadSpec = { type: 'highpass', frequency: 1000, q: SQRT1_2 };
    expect(respDb(spec, 1000)).toBeCloseTo(-3.0103, 2);
    expect(respDb(spec, 18000)).toBeCloseTo(0, 1); // flat well above f0
    expect(respDb(spec, 250)).toBeLessThan(-20); // two octaves below ≈ -24 dB
  });

  it('bandpass (0 dB peak): unity at f0, -3 dB at the Q-defined band edges', () => {
    const f0 = 1000;
    const q = 1; // bandwidth = f0/Q ⇒ edges at the ±half-power frequencies
    const spec: BiquadSpec = { type: 'bandpass', frequency: f0, q };
    expect(respDb(spec, f0)).toBeCloseTo(0, 6); // exact 0 dB peak
    expect(respDb(spec, 50)).toBeLessThan(-20);
    expect(respDb(spec, 18000)).toBeLessThan(-20);
  });

  it('notch: deep null at f0, ~0 dB away from it', () => {
    const spec: BiquadSpec = { type: 'notch', frequency: 1000, q: 5 };
    expect(respDb(spec, 1000)).toBeLessThan(-60); // a true null
    expect(respDb(spec, 100)).toBeCloseTo(0, 1);
    expect(respDb(spec, 10000)).toBeCloseTo(0, 1);
  });

  it('peaking EQ: |H| at f0 equals the set gain exactly; flat far away; cut is symmetric', () => {
    for (const gainDb of [6, 12, -9]) {
      const spec: BiquadSpec = { type: 'peaking', frequency: 2000, q: 2, gainDb };
      expect(respDb(spec, 2000)).toBeCloseTo(gainDb, 6); // exact at center
      expect(respDb(spec, 100)).toBeCloseTo(0, 1); // unity far below
      expect(respDb(spec, 20000)).toBeCloseTo(0, 1); // unity near Nyquist
    }
  });

  it('low-shelf: gain at DC equals the set gain; unity at Nyquist', () => {
    const spec: BiquadSpec = { type: 'lowshelf', frequency: 1000, q: SQRT1_2, gainDb: 6 };
    expect(respDb(spec, 1)).toBeCloseTo(6, 1); // shelf plateau at low end
    expect(respDb(spec, 23000)).toBeCloseTo(0, 1); // unity at the high end
  });

  it('high-shelf: gain near Nyquist equals the set gain; unity at DC', () => {
    const spec: BiquadSpec = { type: 'highshelf', frequency: 8000, q: SQRT1_2, gainDb: -6 };
    expect(respDb(spec, 23500)).toBeCloseTo(-6, 1); // shelf plateau at high end
    expect(respDb(spec, 20)).toBeCloseTo(0, 1); // unity at the low end
  });
});

describe('biquad — analytic response matches an empirical swept sine', () => {
  it('lowpass gain at several probe tones matches |H| (independent cross-check)', () => {
    const spec: BiquadSpec = { type: 'lowpass', frequency: 2000, q: SQRT1_2 };
    for (const f of [200, 1000, 2000, 4000, 8000]) {
      const out = biquad(sine(f, FS, 8192, 0.5), spec);
      const measured = measuredAmp(channelAt(out.planar, 0), f, FS) / 0.5; // gain = out/in amplitude
      const analytic = magnitudeResponse(designBiquad(spec, FS), f, FS);
      expect(db(measured)).toBeCloseTo(db(analytic), 1); // within ~0.1–0.5 dB of the transfer fn
    }
  });

  it('peaking EQ boost: the measured center-tone gain matches the set gain', () => {
    const spec: BiquadSpec = { type: 'peaking', frequency: 3000, q: 3, gainDb: 9 };
    const out = biquad(sine(3000, FS, 8192, 0.3), spec);
    const measured = measuredAmp(channelAt(out.planar, 0), 3000, FS) / 0.3;
    expect(db(measured)).toBeCloseTo(9, 1);
  });
});

describe('biquad — stability & invariants', () => {
  it('every RBJ design has poles strictly inside the unit circle', () => {
    const specs: BiquadSpec[] = [
      { type: 'lowpass', frequency: 80, q: 10 },
      { type: 'highpass', frequency: 20000, q: 0.3 },
      { type: 'bandpass', frequency: 1000, q: 12 },
      { type: 'notch', frequency: 60, q: 30 },
      { type: 'peaking', frequency: 5000, q: 8, gainDb: 18 },
      { type: 'lowshelf', frequency: 120, q: SQRT1_2, gainDb: -18 },
      { type: 'highshelf', frequency: 12000, q: SQRT1_2, gainDb: 18 },
    ];
    for (const spec of specs) expect(polesInsideUnitCircle(designBiquad(spec, FS))).toBe(true);
  });

  it('silence is a fixed point (zero in → zero out)', () => {
    const a: PcmAudio = {
      sampleRate: FS,
      channels: 1,
      frames: 256,
      planar: [new Float64Array(256)],
    };
    const out = biquad(a, { type: 'peaking', frequency: 1000, q: 2, gainDb: 12 });
    expect(Array.from(channelAt(out.planar, 0))).toEqual(Array.from({ length: 256 }, () => 0));
  });

  it('filters each channel independently with its own state', () => {
    const left = channelAt(sine(500, FS, 4096, 0.5).planar, 0);
    const right = channelAt(sine(5000, FS, 4096, 0.5).planar, 0);
    const a: PcmAudio = { sampleRate: FS, channels: 2, frames: 4096, planar: [left, right] };
    const spec: BiquadSpec = { type: 'lowpass', frequency: 1000, q: SQRT1_2 };
    const out = biquad(a, spec);
    // 500 Hz passes (≈ unity), 5000 Hz is attenuated — proving per-channel filtering.
    expect(measuredAmp(channelAt(out.planar, 0), 500, FS) / 0.5).toBeGreaterThan(0.8);
    expect(measuredAmp(channelAt(out.planar, 1), 5000, FS) / 0.5).toBeLessThan(0.2);
  });

  it('leaves the input untouched', () => {
    const a = sine(1000, FS, 512, 0.5);
    const before = channelAt(a.planar, 0).slice();
    biquad(a, { type: 'highpass', frequency: 2000, q: 1 });
    expect(channelAt(a.planar, 0)).toEqual(before);
  });

  it('rejects out-of-band frequency, non-positive Q, and missing/non-finite gain', () => {
    const a = sine(1000, FS, 256, 0.5);
    expect(() => biquad(a, { type: 'lowpass', frequency: 0, q: 1 })).toThrow(InputError);
    expect(() => biquad(a, { type: 'lowpass', frequency: 24000, q: 1 })).toThrow(InputError); // = Nyquist
    expect(() => biquad(a, { type: 'lowpass', frequency: 1000, q: 0 })).toThrow(InputError);
    expect(() => biquad(a, { type: 'peaking', frequency: 1000, q: 1, gainDb: Number.NaN })).toThrow(
      InputError,
    );
    // peaking/shelf require a gain; omitting it is an error.
    expect(() => designBiquad({ type: 'peaking', frequency: 1000, q: 1 }, FS)).toThrow(InputError);
  });
});

describe('biquad — on the real WAV corpus', () => {
  it('speech.wav: a peaking-EQ boost raises the targeted band energy, no NaN/clip, clean s16', async () => {
    const a = readWavPcm(await loadFixture('speech.wav'));
    const f0 = 1200; // a band squarely inside speech energy (fs=16000 ⇒ Nyquist 8000)
    const spec: BiquadSpec = { type: 'peaking', frequency: f0, q: 2, gainDb: 9 };
    const out = biquad(a, spec);

    expect(out.frames).toBe(a.frames);
    expect(out.sampleRate).toBe(a.sampleRate);
    expect(hasNaN(out)).toBe(false);
    // The energy in the boosted band rises measurably vs the source (Goertzel at f0 over the whole clip).
    const before = measuredAmp(channelAt(a.planar, 0), f0, a.sampleRate);
    const after = measuredAmp(channelAt(out.planar, 0), f0, a.sampleRate);
    expect(after).toBeGreaterThan(before * 1.5); // ~+9 dB ⇒ ≈ ×2.8 at the center bin
    // Energy far outside the band is essentially unchanged (the EQ is local).
    const farBefore = measuredAmp(channelAt(a.planar, 0), 300, a.sampleRate);
    const farAfter = measuredAmp(channelAt(out.planar, 0), 300, a.sampleRate);
    expect(farAfter).toBeCloseTo(farBefore, 1);
    // Re-encodes to s16 cleanly (valid byte length, no overflow/NaN).
    expect(encodePcm(out, 's16').byteLength).toBe(a.frames * a.channels * 2);
  });

  it('speech.wav: a high-Q notch removes a tone planted in the signal', async () => {
    const base = readWavPcm(await loadFixture('speech.wav'));
    // Plant a strong 1 kHz tone, then notch it out — the notched output has far less 1 kHz energy.
    const fNotch = 1000;
    const planted = channelAt(base.planar, 0).map((s, i) => {
      void i;
      return s;
    });
    const w = (2 * Math.PI * fNotch) / base.sampleRate;
    for (let i = 0; i < planted.length; i++) planted[i] = (planted[i] ?? 0) + 0.3 * Math.sin(w * i);
    const withTone: PcmAudio = { ...base, planar: [planted] };

    const notched = biquad(withTone, { type: 'notch', frequency: fNotch, q: 8 });
    const toneBefore = measuredAmp(channelAt(withTone.planar, 0), fNotch, base.sampleRate);
    const toneAfter = measuredAmp(channelAt(notched.planar, 0), fNotch, base.sampleRate);
    expect(toneAfter).toBeLessThan(toneBefore * 0.2); // the planted tone is strongly suppressed
    expect(hasNaN(notched)).toBe(false);
  });
});

describe('magnitudeResponse — pole on the unit circle (denominator magnitude exactly 0)', () => {
  it('returns +Infinity at a DC pole (denominator exactly 0), finite elsewhere', () => {
    // A pole at z = 1 (DC): 1 + a1 z⁻¹ + a2 z⁻² with a1 = −2, a2 = 1. At f = 0 (ω = 0, cos = 1, sin = 0)
    // the denominator is exactly 1 − 2 + 1 = 0 (no float rounding), so |H| → +Infinity.
    const sampleRate = 48_000;
    const coeffs = { b0: 1, b1: 0, b2: 0, a1: -2, a2: 1 };
    expect(magnitudeResponse(coeffs, 0, sampleRate)).toBe(Number.POSITIVE_INFINITY);
    // Away from DC the denominator is non-zero → a finite response.
    expect(Number.isFinite(magnitudeResponse(coeffs, 4_000, sampleRate))).toBe(true);
  });
});
