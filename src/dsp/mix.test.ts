import { describe, expect, it } from 'vitest';
import { CapabilityError } from '../contracts/errors.ts';
import { remix } from './mix.ts';
import { type PcmAudio, channelAt, sampleAt } from './pcm.ts';

function audioOf(...channels: number[][]): PcmAudio {
  const planar = channels.map((c) => Float64Array.from(c));
  return { sampleRate: 48000, channels: planar.length, frames: planar[0]?.length ?? 0, planar };
}

const C = Math.SQRT1_2;

describe('remix — up/down-mix', () => {
  it('mono → stereo duplicates the channel', () => {
    const a = audioOf([0.1, -0.2, 0.3]);
    const s = remix(a, 2);
    expect(s.channels).toBe(2);
    expect(s.frames).toBe(3);
    expect(channelAt(s.planar, 0)).toEqual(channelAt(a.planar, 0));
    expect(channelAt(s.planar, 1)).toEqual(channelAt(a.planar, 0));
  });

  it('stereo → mono averages (BS.775)', () => {
    const a = audioOf([1, 0.5, -1], [-1, 0.5, 1]); // L, R
    const m = remix(a, 1);
    expect(m.channels).toBe(1);
    expect(Array.from(channelAt(m.planar, 0))).toEqual([0, 0.5, 0]);
  });

  it('mono → stereo → mono is bit-exact identity', () => {
    const a = audioOf([0.13, -0.61, 0.99, -1, 0]);
    const back = remix(remix(a, 2), 1);
    expect(channelAt(back.planar, 0)).toEqual(channelAt(a.planar, 0));
  });

  it('N → N is an identity copy (new buffers, equal contents)', () => {
    for (const a of [
      audioOf([0.2]),
      audioOf([0.2], [0.3]),
      audioOf([1], [2], [3], [4], [5], [6]),
    ]) {
      const r = remix(a, a.channels);
      expect(r.channels).toBe(a.channels);
      for (let c = 0; c < a.channels; c++) {
        expect(channelAt(r.planar, c)).toEqual(channelAt(a.planar, c));
        expect(channelAt(r.planar, c)).not.toBe(channelAt(a.planar, c)); // copied, not aliased
      }
    }
  });

  it('5.1 → stereo uses BS.775 coefficients (L,R,C,LFE,Ls,Rs)', () => {
    const a = audioOf([1], [2], [3], [9], [4], [5]); // LFE=9 must be dropped
    const s = remix(a, 2);
    expect(s.channels).toBe(2);
    expect(sampleAt(channelAt(s.planar, 0), 0)).toBeCloseTo(1 + C * 3 + C * 4, 12);
    expect(sampleAt(channelAt(s.planar, 1), 0)).toBeCloseTo(2 + C * 3 + C * 5, 12);
  });

  it('5.1 → mono averages the BS.775 downmix', () => {
    const a = audioOf([1], [2], [3], [9], [4], [5]);
    const m = remix(a, 1);
    const lo = 1 + C * 3 + C * 4;
    const ro = 2 + C * 3 + C * 5;
    expect(sampleAt(channelAt(m.planar, 0), 0)).toBeCloseTo(0.5 * (lo + ro), 12);
  });

  it('stereo → 5.1 places L/R up front and zeroes the rest', () => {
    const a = audioOf([0.5, -0.5], [0.25, -0.25]);
    const s = remix(a, 6);
    expect(s.channels).toBe(6);
    expect(channelAt(s.planar, 0)).toEqual(channelAt(a.planar, 0));
    expect(channelAt(s.planar, 1)).toEqual(channelAt(a.planar, 1));
    for (const c of [2, 3, 4, 5]) expect(Array.from(channelAt(s.planar, c))).toEqual([0, 0]);
  });

  it('rejects unsupported layouts and invalid targets with a typed CapabilityError', () => {
    expect(() => remix(audioOf([1], [2], [3]), 7)).toThrow(CapabilityError);
    expect(() => remix(audioOf([1]), 0)).toThrow(CapabilityError);
    expect(() => remix(audioOf([1]), 2.5)).toThrow(CapabilityError);
  });

  it('leaves the input audio untouched', () => {
    const a = audioOf([0.4, -0.4]);
    remix(a, 2);
    expect(channelAt(a.planar, 0)).toEqual(Float64Array.of(0.4, -0.4));
  });
});
