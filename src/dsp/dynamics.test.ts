import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { readWavPcm } from '../drivers/wav/pcm.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { limit, normalizePeak, normalizeRms } from './dynamics.ts';
import { dbToLinear } from './gain.ts';
import { type PcmAudio, channelAt, encodePcm, sampleAt } from './pcm.ts';

function sine(freq: number, rate: number, frames: number, amp = 0.5): PcmAudio {
  const ch = new Float64Array(frames);
  const w = (2 * Math.PI * freq) / rate;
  for (let n = 0; n < frames; n++) ch[n] = amp * Math.sin(w * n);
  return { sampleRate: rate, channels: 1, frames, planar: [ch] };
}

function audioOf(sampleRate: number, ...channels: number[][]): PcmAudio {
  const planar = channels.map((c) => Float64Array.from(c));
  return { sampleRate, channels: planar.length, frames: planar[0]?.length ?? 0, planar };
}

function globalPeak(a: PcmAudio): number {
  let m = 0;
  for (const ch of a.planar)
    for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i] ?? 0));
  return m;
}

function globalRms(a: PcmAudio): number {
  let s = 0;
  let n = 0;
  for (const ch of a.planar)
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i] ?? 0;
      s += v * v;
      n++;
    }
  return n > 0 ? Math.sqrt(s / n) : 0;
}

function hasNaN(a: PcmAudio): boolean {
  for (const ch of a.planar)
    for (let i = 0; i < ch.length; i++) if (Number.isNaN(ch[i] ?? 0)) return true;
  return false;
}

describe('normalizePeak', () => {
  it('scales so the global peak equals the target dBFS exactly', () => {
    for (const target of [0, -1, -3, -6, -12]) {
      const a = sine(1000, 48000, 500, 0.3);
      const out = normalizePeak(a, target);
      expect(globalPeak(out)).toBeCloseTo(dbToLinear(target), 12);
    }
  });

  it('default target is 0 dBFS (peak → 1.0)', () => {
    const out = normalizePeak(sine(1000, 48000, 500, 0.21));
    expect(globalPeak(out)).toBeCloseTo(1, 12);
  });

  it('is a pure scale — sample ratios (waveform shape) are preserved', () => {
    const a = audioOf(48000, [0.1, -0.2, 0.05, 0.4]);
    const out = normalizePeak(a, 0); // peak 0.4 → 1.0, factor 2.5
    expect(Array.from(channelAt(out.planar, 0))).toEqual([0.25, -0.5, 0.125, 1]);
  });

  it('links channels (one factor from the global peak preserves the balance)', () => {
    const a = audioOf(48000, [0.5, -0.25], [0.1, 0.2]); // global peak 0.5 in ch0
    const out = normalizePeak(a, 0); // factor 2.0 applied to BOTH channels
    expect(Array.from(channelAt(out.planar, 0))).toEqual([1, -0.5]);
    expect(Array.from(channelAt(out.planar, 1))).toEqual([0.2, 0.4]);
  });

  it('leaves digital silence unchanged (no divide-by-zero)', () => {
    const a = audioOf(48000, [0, 0, 0]);
    const out = normalizePeak(a, 0);
    expect(Array.from(channelAt(out.planar, 0))).toEqual([0, 0, 0]);
    expect(hasNaN(out)).toBe(false);
  });

  it('leaves the input untouched and rejects a non-finite target', () => {
    const a = sine(1000, 48000, 100, 0.4);
    const before = channelAt(a.planar, 0).slice();
    normalizePeak(a, -3);
    expect(channelAt(a.planar, 0)).toEqual(before);
    expect(() => normalizePeak(a, Number.NaN)).toThrow(InputError);
  });
});

describe('normalizeRms', () => {
  it('scales so the global RMS equals the target dBFS exactly', () => {
    for (const target of [-12, -18, -20]) {
      const a = sine(1000, 48000, 4096, 0.5);
      const out = normalizeRms(a, target);
      expect(globalRms(out)).toBeCloseTo(dbToLinear(target), 10);
    }
  });

  it('may push peaks past ±1 (RMS-normalize alone is meant to be followed by limit)', () => {
    // A low-RMS but peaky signal: mostly quiet with rare spikes → RMS-normalizing up overshoots ±1.
    const ch = new Float64Array(1000);
    ch[10] = 0.5; // a lone spike; RMS is tiny
    const out = normalizeRms({ sampleRate: 48000, channels: 1, frames: 1000, planar: [ch] }, -6);
    expect(globalPeak(out)).toBeGreaterThan(1); // overshoots → caller must limit
    expect(hasNaN(out)).toBe(false);
  });

  it('leaves digital silence unchanged and rejects a non-finite target', () => {
    const a = audioOf(48000, [0, 0, 0, 0]);
    expect(Array.from(channelAt(normalizeRms(a, -12).planar, 0))).toEqual([0, 0, 0, 0]);
    expect(() => normalizeRms(a, Number.POSITIVE_INFINITY)).toThrow(InputError);
  });
});

describe('limit — hard', () => {
  it('caps every sample at the ceiling; below-ceiling samples are bit-exact', () => {
    const ceiling = dbToLinear(-1); // ≈ 0.8913
    const a = audioOf(48000, [0.2, -0.95, 0.5, 1.0, -0.3, 0.89]);
    const out = limit(a, -1, 'hard');
    const o = channelAt(out.planar, 0);
    expect(globalPeak(out)).toBeLessThanOrEqual(ceiling + 1e-12);
    expect(sampleAt(o, 0)).toBe(0.2); // below ceiling → unchanged
    expect(sampleAt(o, 1)).toBeCloseTo(-ceiling, 12); // -0.95 clamped to -ceiling
    expect(sampleAt(o, 2)).toBe(0.5); // below → unchanged
    expect(sampleAt(o, 3)).toBeCloseTo(ceiling, 12); // 1.0 clamped to ceiling
    expect(sampleAt(o, 4)).toBe(-0.3); // below → unchanged
    expect(sampleAt(o, 5)).toBe(0.89); // 0.89 < 0.8913 → unchanged (bit-exact)
  });

  it('default ceiling is 0 dBFS (±1.0)', () => {
    const out = limit(audioOf(48000, [2, -2, 0.5]));
    expect(globalPeak(out)).toBeLessThanOrEqual(1 + 1e-12);
    expect(Array.from(channelAt(out.planar, 0))).toEqual([1, -1, 0.5]);
  });
});

describe('limit — soft', () => {
  it('never exceeds the ceiling and leaves the linear (below-knee) region bit-exact', () => {
    const ceiling = 1.0;
    const a = sine(1000, 48000, 2000, 1.6); // amplitude well over the ceiling
    const out = limit(a, 0, 'soft');
    expect(globalPeak(out)).toBeLessThanOrEqual(ceiling + 1e-9);
    expect(hasNaN(out)).toBe(false);
    // A small signal entirely below the knee passes through bit-exact.
    const small = sine(1000, 48000, 500, 0.3);
    const outSmall = limit(small, 0, 'soft');
    expect(channelAt(outSmall.planar, 0)).toEqual(channelAt(small.planar, 0));
  });

  it('is monotonic in the input (order-preserving waveshaper)', () => {
    const ceiling = 1.0;
    let prev = Number.NEGATIVE_INFINITY;
    for (let x = -3; x <= 3; x += 0.01) {
      const out = limit(audioOf(48000, [x]), 0, 'soft');
      const y = sampleAt(channelAt(out.planar, 0), 0);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12); // non-decreasing
      expect(Math.abs(y)).toBeLessThanOrEqual(ceiling + 1e-9); // bounded
      prev = y;
    }
  });

  it('rejects a non-finite ceiling and an out-of-range knee', () => {
    const a = sine(1000, 48000, 100, 1.2);
    expect(() => limit(a, Number.NaN, 'hard')).toThrow(InputError);
    expect(() => limit(a, 0, 'soft', 0)).toThrow(InputError); // knee must be in (0, 1]
    expect(() => limit(a, 0, 'soft', 1.5)).toThrow(InputError);
  });

  it('leaves the input untouched', () => {
    const a = sine(1000, 48000, 200, 1.5);
    const before = channelAt(a.planar, 0).slice();
    limit(a, 0, 'soft');
    limit(a, -1, 'hard');
    expect(channelAt(a.planar, 0)).toEqual(before);
  });
});

describe('dynamics — on the real WAV corpus', () => {
  it('speech.wav: peak-normalize to -1 dBFS hits the target exactly and re-encodes clean', async () => {
    const a = readWavPcm(await loadFixture('speech.wav'));
    const out = normalizePeak(a, -1);
    expect(globalPeak(out)).toBeCloseTo(dbToLinear(-1), 12);
    expect(out.frames).toBe(a.frames);
    expect(hasNaN(out)).toBe(false);
    expect(encodePcm(out, 's16').byteLength).toBe(a.frames * a.channels * 2); // valid, no overflow
  });

  it('sin_440Hz: a 4× over-boosted clip is limited to the ceiling with below-ceiling samples bit-exact', async () => {
    const src = readWavPcm(await loadFixture('sin_440Hz_-6dBFS_1s.wav'));
    // Boost ×4 so much of the tone exceeds 0 dBFS, then hard-limit at -0.5 dBFS.
    const boosted: PcmAudio = {
      sampleRate: src.sampleRate,
      channels: src.channels,
      frames: src.frames,
      planar: src.planar.map((ch) => ch.map((s) => s * 4)),
    };
    const ceiling = dbToLinear(-0.5);
    const out = limit(boosted, -0.5, 'hard');
    expect(globalPeak(out)).toBeLessThanOrEqual(ceiling + 1e-12);
    expect(hasNaN(out)).toBe(false);
    // Every sample that was already under the ceiling is preserved exactly.
    const bo = channelAt(boosted.planar, 0);
    const oo = channelAt(out.planar, 0);
    for (let i = 0; i < src.frames; i += 313) {
      if (Math.abs(sampleAt(bo, i)) <= ceiling) expect(sampleAt(oo, i)).toBe(sampleAt(bo, i));
      else expect(Math.abs(sampleAt(oo, i))).toBeCloseTo(ceiling, 12);
    }
    expect(encodePcm(out, 's16').byteLength).toBe(src.frames * src.channels * 2);
  });

  it('speech.wav: RMS-normalize then soft-limit yields a bounded, NaN-free, clean-encoding result', async () => {
    const a = readWavPcm(await loadFixture('speech.wav'));
    const limited = limit(normalizeRms(a, -14), 0, 'soft'); // loudness-ish target then a brickwall
    expect(globalPeak(limited)).toBeLessThanOrEqual(1 + 1e-9);
    expect(hasNaN(limited)).toBe(false);
    expect(encodePcm(limited, 's16').byteLength).toBe(a.frames * a.channels * 2);
  });
});

describe('dynamics — empty / degenerate audio (zero-sample fixed points)', () => {
  const empty: PcmAudio = {
    sampleRate: 48000,
    channels: 1,
    frames: 0,
    planar: [new Float64Array(0)],
  };
  const noChannels: PcmAudio = { sampleRate: 48000, channels: 0, frames: 0, planar: [] };

  it('normalizeRms over a zero-sample signal is an identity (RMS reduces to 0, no divide)', () => {
    // Exercises globalRms' `count > 0 ? … : 0` false arm (no samples) → silence-path clone.
    const out = normalizeRms(empty, -12);
    expect(out.frames).toBe(0);
    expect(out.planar[0]?.length).toBe(0);
    expect(normalizeRms(noChannels, -12).planar).toEqual([]);
  });

  it('normalizePeak over a zero-sample signal is an identity (peak 0)', () => {
    expect(normalizePeak(empty, 0).planar[0]?.length).toBe(0);
    expect(normalizePeak(noChannels, 0).channels).toBe(0);
  });

  it('soft-limit with knee = 1 (the inclusive upper bound) is accepted', () => {
    // knee must be in (0, 1]; 1 is valid (the whole sub-ceiling region is linear).
    const out = limit(audioOf(48000, [0.5, 1.5, -1.5]), 0, 'soft', 1);
    expect(globalPeak(out)).toBeLessThanOrEqual(1 + 1e-9);
    expect(channelAt(out.planar, 0)[0]).toBe(0.5); // below ceiling → bit-exact
  });
});
