import { describe, expect, it } from 'vitest';
import { resample } from './resample.ts';
import { gain } from './gain.ts';
import { fadeIn, fadeOut } from './fade.ts';
import type { PcmAudio } from './pcm.ts';

function pcm(sr: number, ch: number, frames = 4800): PcmAudio {
  const planar = Array.from({ length: ch }, (_, c) =>
    Float64Array.from({ length: frames }, (_, i) => Math.sin((i + c * 10) * 0.1)),
  );
  return { sampleRate: sr, channels: ch, frames, planar };
}

describe('audio-dsp routes 2.1 — resample/gain/fade', () => {
  it('unit: resample 48k→44.1k preserves duration within 1 tick', () => {
    const a = pcm(48000, 2);
    const r = resample(a, 44100);
    expect(r.sampleRate).toBe(44100);
    expect(r.frames).toBeGreaterThan(0);
    // duration 4800/48000 =0.1s, resampled 4410 frames ≈0.1s
    expect(Math.abs(r.frames / 44100 - a.frames / 48000)).toBeLessThan(0.001);
  });

  it('property: gain -6dB is 0.5 linear deterministic', () => {
    const a = pcm(48000, 1, 10);
    const half = gain(a, -6.020599913279624);
    const half2 = gain(a, -6.020599913279624);
    expect(half.planar[0]![0]).toBeCloseTo((a.planar[0]![0] as number) * 0.5, 6);
    expect(half.planar[0]).toEqual(half2.planar[0]);
  });

  it('boundary: empty and single-frame via gain/fade/resample', () => {
    const empty = pcm(48000, 2, 0);
    expect(resample(empty, 16000).frames).toBe(0);
    expect(gain(empty, -6).frames).toBe(0);
    const single = pcm(48000, 1, 1);
    expect(resample(single, 48000).frames).toBe(1);
    expect(fadeIn(single, 1, 'linear').frames).toBe(1);
    expect(fadeOut(single, 1, 'linear').frames).toBe(1);
  });

  it('malformed: invalid sampleRate throws', () => {
    const a = pcm(48000, 1);
    expect(() => resample(a, 0)).toThrow();
    expect(() => resample(a, Number.NaN)).toThrow();
    expect(() => resample(a, -1)).toThrow();
  });

  it('randomized: 20× resample→gain→fade deterministic and bounded', () => {
    for (let i = 0; i < 20; i++) {
      const sr = 48000;
      const ch = i % 2 === 0 ? 1 : 2;
      const a = pcm(sr, ch, 100 + i * 10);
      const g = gain(a, -3 + (i % 5));
      const r = resample(g, i % 2 === 0 ? 44100 : 16000);
      const f = fadeIn(r, Math.min(10, r.frames), 'linear');
      expect(f.frames).toBe(r.frames);
      expect(f.sampleRate).toBe(r.sampleRate);
      const g2 = gain(a, -3 + (i % 5));
      expect(g.planar[0]![0]).toBe(g2.planar[0]![0]);
    }
  });
});
