import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { readWavPcm } from '../drivers/wav/pcm.ts';
import { loadFixture } from '../test-support/corpus.ts';
import { crossfade, fadeIn, fadeOut } from './fade.ts';
import { type PcmAudio, channelAt, encodePcm, sampleAt } from './pcm.ts';

/** A constant-1.0 signal — the cleanest way to read a fade's gain envelope directly off the output. */
function ones(frames: number, channels = 1, sampleRate = 48000): PcmAudio {
  const planar = Array.from({ length: channels }, () => new Float64Array(frames).fill(1));
  return { sampleRate, channels, frames, planar };
}

function sine(freq: number, rate: number, frames: number, amp = 0.5, phase = 0): PcmAudio {
  const ch = new Float64Array(frames);
  const w = (2 * Math.PI * freq) / rate;
  for (let n = 0; n < frames; n++) ch[n] = amp * Math.sin(w * n + phase);
  return { sampleRate: rate, channels: 1, frames, planar: [ch] };
}

function rms(x: Float64Array, from: number, to: number): number {
  let s = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const v = sampleAt(x, i);
    s += v * v;
    n++;
  }
  return n > 0 ? Math.sqrt(s / n) : 0;
}

function maxAbs(x: Float64Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(sampleAt(x, i)));
  return m;
}

describe('fade — envelope shape & endpoints', () => {
  it('linear fade-in ramps 0 → 1 exactly over the region, unity after', () => {
    const n = 100;
    const out = channelAt(fadeIn(ones(200), n, 'linear').planar, 0);
    expect(sampleAt(out, 0)).toBe(0); // exact silence at the start
    expect(sampleAt(out, n - 1)).toBeCloseTo(1, 12); // exact unity at the last ramped sample
    expect(sampleAt(out, 49)).toBeCloseTo(49 / (n - 1), 12); // linear: g = i/(N-1)
    for (let i = n; i < 200; i++) expect(sampleAt(out, i)).toBe(1); // pass-through after the fade
    // Monotonic non-decreasing ramp.
    for (let i = 1; i < n; i++)
      expect(sampleAt(out, i)).toBeGreaterThanOrEqual(sampleAt(out, i - 1));
  });

  it('linear fade-out ramps 1 → 0 exactly over the trailing region, unity before', () => {
    const n = 80;
    const frames = 200;
    const out = channelAt(fadeOut(ones(frames), n, 'linear').planar, 0);
    expect(sampleAt(out, frames - 1)).toBe(0); // exact silence at the very end
    const start = frames - n;
    expect(sampleAt(out, start)).toBeCloseTo(1, 12); // first faded sample is still unity
    for (let i = 0; i < start; i++) expect(sampleAt(out, i)).toBe(1); // pass-through before the fade
    // Monotonic non-increasing ramp through the tail.
    for (let i = start + 1; i < frames; i++)
      expect(sampleAt(out, i)).toBeLessThanOrEqual(sampleAt(out, i - 1));
  });

  it('equal-power fade-in uses sin(t·π/2) with exact endpoints', () => {
    const n = 64;
    const out = channelAt(fadeIn(ones(n), n, 'equal-power').planar, 0);
    expect(sampleAt(out, 0)).toBe(0);
    expect(sampleAt(out, n - 1)).toBeCloseTo(1, 12);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      expect(sampleAt(out, i)).toBeCloseTo(Math.sin((t * Math.PI) / 2), 12);
    }
  });

  it('equal-power fade-in/out are power-complementary (sin² + cos² = 1)', () => {
    const n = 128;
    const fin = channelAt(fadeIn(ones(n), n, 'equal-power').planar, 0);
    const fout = channelAt(fadeOut(ones(n), n, 'equal-power').planar, 0);
    for (let i = 0; i < n; i++) {
      const gi = sampleAt(fin, i);
      const go = sampleAt(fout, i);
      expect(gi * gi + go * go).toBeCloseTo(1, 12); // constant summed power at every position
    }
  });

  it('applies the fade to every channel of a multi-channel signal', () => {
    const out = fadeIn(ones(50, 2), 50, 'linear');
    expect(out.channels).toBe(2);
    expect(sampleAt(channelAt(out.planar, 0), 0)).toBe(0);
    expect(sampleAt(channelAt(out.planar, 1), 0)).toBe(0);
    expect(sampleAt(channelAt(out.planar, 0), 49)).toBeCloseTo(1, 12);
    expect(sampleAt(channelAt(out.planar, 1), 49)).toBeCloseTo(1, 12);
  });
});

describe('fade — edges & guards', () => {
  it('a zero/negative duration is an identity copy (new buffer)', () => {
    const a = sine(1000, 48000, 100);
    for (const d of [0, -10]) {
      const r = fadeIn(a, d);
      expect(channelAt(r.planar, 0)).toEqual(channelAt(a.planar, 0));
      expect(channelAt(r.planar, 0)).not.toBe(channelAt(a.planar, 0));
    }
  });

  it('a duration ≥ length fades the whole signal (clamped to the available frames)', () => {
    const out = channelAt(fadeIn(ones(40), 1000, 'linear').planar, 0);
    expect(sampleAt(out, 0)).toBe(0);
    expect(sampleAt(out, 39)).toBeCloseTo(1, 12); // last sample still reaches unity
  });

  it('leaves the input audio untouched', () => {
    const a = sine(1000, 48000, 100);
    const before = channelAt(a.planar, 0).slice();
    fadeIn(a, 50);
    fadeOut(a, 50);
    expect(channelAt(a.planar, 0)).toEqual(before);
  });

  it('rejects a malformed duration with a typed InputError', () => {
    const a = sine(1000, 48000, 100);
    expect(() => fadeIn(a, 1.5)).toThrow(InputError);
    expect(() => fadeOut(a, Number.NaN)).toThrow(InputError);
  });
});

describe('crossfade', () => {
  it('result length is a.frames + b.frames − overlap; head/tail pass through', () => {
    const a = ones(100);
    const b = ones(120);
    const n = 40;
    const x = crossfade(a, b, n, 'linear');
    expect(x.frames).toBe(100 + 120 - n);
    const out = channelAt(x.planar, 0);
    // a's non-overlapped head (first 100 − 40 = 60 samples) is a, unfaded.
    for (let i = 0; i < 60; i++) expect(sampleAt(out, i)).toBe(1);
    // b's non-overlapped tail (last 120 − 40 = 80 samples) is b, unfaded.
    for (let i = x.frames - 80; i < x.frames; i++) expect(sampleAt(out, i)).toBe(1);
  });

  it('equal-power cross-fade is constant-power across the join for uncorrelated signals', () => {
    // The defining property: with a ⟂ b (decorrelated), E[(a·cos + b·sin)²] = cos²·E[a²] + sin²·E[b²];
    // when both have equal power that is constant in t. Use two equal-amplitude tones at well-separated
    // frequencies (≈ orthogonal over the window) so the overlap RMS tracks the un-faded source RMS.
    const a = sine(437, 48000, 3000, 0.5);
    const b = sine(983, 48000, 3000, 0.5);
    const n = 2000;
    const out = channelAt(crossfade(a, b, n, 'equal-power').planar, 0);
    const overlapStart = a.frames - n;
    const ref = rms(channelAt(a.planar, 0), 0, a.frames); // == rms(b) (equal amplitude)
    const win = 300;
    const early = rms(out, overlapStart + 50, overlapStart + 50 + win);
    const mid = rms(out, overlapStart + (n >> 1) - win / 2, overlapStart + (n >> 1) + win / 2);
    const late = rms(out, overlapStart + n - 50 - win, overlapStart + n - 50);
    // No power dip anywhere in the join: early ≈ mid ≈ late ≈ the source RMS (within a few %).
    expect(mid).toBeCloseTo(ref, 1);
    expect(early).toBeCloseTo(ref, 1);
    expect(late).toBeCloseTo(ref, 1);
  });

  it('linear cross-fade of uncorrelated tones dips in power at the midpoint; equal-power does not', () => {
    const a = sine(400, 48000, 2000, 0.5);
    const b = sine(900, 48000, 2000, 0.5, Math.PI / 3); // different freq + phase ⇒ uncorrelated
    const n = 1600;
    const overlapStart = a.frames - n;
    const mid = overlapStart + (n >> 1);
    const win = 200;

    const lin = channelAt(crossfade(a, b, n, 'linear').planar, 0);
    const eq = channelAt(crossfade(a, b, n, 'equal-power').planar, 0);
    const edge = rms(eq, overlapStart + 20, overlapStart + 20 + win);
    const linMid = rms(lin, mid - win / 2, mid + win / 2);
    const eqMid = rms(eq, mid - win / 2, mid + win / 2);
    // Equal-power holds power across the join; linear sags noticeably below it at the midpoint.
    expect(eqMid).toBeGreaterThan(linMid);
    expect(eqMid).toBeCloseTo(edge, 1); // equal-power midpoint ≈ the (un-faded) edge power
  });

  it('rejects incompatible inputs (channels / sample-rate) with a typed CapabilityError', () => {
    expect(() => crossfade(ones(100, 1), ones(100, 2), 10)).toThrow(CapabilityError);
    expect(() => crossfade(ones(100, 1, 44100), ones(100, 1, 48000), 10)).toThrow(CapabilityError);
  });

  it('clamps the overlap to the shorter input (and a negative overlap to zero)', () => {
    const x = crossfade(ones(50), ones(200), 1000, 'linear'); // overlap clamps to 50
    expect(x.frames).toBe(50 + 200 - 50); // == 200
    // A negative overlap is a valid integer → clamps to 0 (plain concatenation), not an error.
    const cat = crossfade(ones(50), ones(60), -5, 'linear');
    expect(cat.frames).toBe(110);
    // Only a non-integer overlap is rejected.
    expect(() => crossfade(ones(50), ones(50), 2.5)).toThrow(InputError);
  });
});

describe('fade — on the real WAV corpus', () => {
  it('speech.wav: a linear fade-in silences the start, preserves the tail, and never clips', async () => {
    const a = readWavPcm(await loadFixture('speech.wav'));
    expect(a.channels).toBe(1);
    const n = Math.round(a.sampleRate * 0.1); // 100 ms fade
    const out = fadeIn(a, n, 'linear');
    const got = channelAt(out.planar, 0);
    const src = channelAt(a.planar, 0);

    expect(out.frames).toBe(a.frames);
    expect(sampleAt(got, 0)).toBe(0); // exact silence at t=0
    expect(sampleAt(got, n - 1)).toBeCloseTo(sampleAt(src, n - 1), 12); // unity at the fade end
    // Tail (past the fade) is bit-exact the source.
    for (let i = n; i < a.frames; i += 997) expect(sampleAt(got, i)).toBe(sampleAt(src, i));
    // A fade only attenuates → no clipping, and total energy strictly drops.
    expect(maxAbs(got)).toBeLessThanOrEqual(maxAbs(src));
    expect(rms(got, 0, n)).toBeLessThan(rms(src, 0, n));
    // Re-encodes to s16 cleanly (valid byte length, no overflow/NaN).
    expect(encodePcm(out, 's16').byteLength).toBe(a.frames * 2);
  });

  it('real 440 Hz clip + an uncorrelated tone: equal-power cross-fade joins them with no runaway', async () => {
    const a = readWavPcm(await loadFixture('sin_440Hz_-6dBFS_1s.wav')); // a real 440 Hz tone @ 44100
    const b: PcmAudio = sine(623, a.sampleRate, a.frames, 0.4); // an uncorrelated tone at a's rate
    const n = Math.round(a.sampleRate * 0.25);
    const x = crossfade(a, b, n, 'equal-power');
    expect(x.frames).toBe(a.frames + b.frames - n);

    const peakA = maxAbs(channelAt(a.planar, 0));
    const peakB = maxAbs(channelAt(b.planar, 0));
    const out = channelAt(x.planar, 0);
    // Equal-power sums a·cos + b·sin; the absolute ceiling for any two bounded signals is
    // √2·max(peakA,peakB) (since cos+sin ≤ √2). No runaway — the join can't blow past that.
    expect(maxAbs(out)).toBeLessThanOrEqual(Math.SQRT2 * Math.max(peakA, peakB) + 1e-9);
    // The exclusive head is exactly `a` (the real clip), unfaded.
    const src = channelAt(a.planar, 0);
    for (let i = 0; i < a.frames - n; i += 503) expect(sampleAt(out, i)).toBe(sampleAt(src, i));
    // Re-encodes to s16 cleanly through the whole join.
    expect(encodePcm(x, 's16').byteLength).toBe(x.frames * 2);
  });
});

describe('fade — single-frame (degenerate N=1) regions use t=0', () => {
  it('fadeIn over exactly 1 frame zeros only that first sample (t=0 ⇒ gain 0)', () => {
    const out = fadeIn(ones(5), 1, 'linear'); // n = min(1, 5) = 1 ⇒ denom = 1, t = 0
    const o = channelAt(out.planar, 0);
    expect(sampleAt(o, 0)).toBe(0); // gainIn(0) = 0
    expect(Array.from(o).slice(1)).toEqual([1, 1, 1, 1]); // the rest pass through
  });

  it('fadeOut over exactly 1 frame zeros only the last sample (t=0 ⇒ gainOut 1?) ', () => {
    // For fade-out, the single ramped sample is the LAST one at t=0 ⇒ gainOut(0)=1 (unchanged).
    const out = fadeOut(ones(4), 1, 'equal-power'); // n = 1 ⇒ denom = 1, position t = 0
    const o = channelAt(out.planar, 0);
    expect(Array.from(o)).toEqual([1, 1, 1, 1]); // gainOut(0) = cos(0) = 1
  });

  it('a 1-frame signal faded over 1 frame is a fixed point (no off-by-one crash)', () => {
    expect(Array.from(channelAt(fadeIn(ones(1), 1).planar, 0))).toEqual([0]);
    expect(Array.from(channelAt(fadeOut(ones(1), 1).planar, 0))).toEqual([1]);
  });
});
