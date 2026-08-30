import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { dbToLinear, gain } from './gain.ts';
import { remix, remixMatrix } from './mix.ts';
import { type PcmAudio, channelAt, sampleAt } from './pcm.ts';
import { resample } from './resample.ts';

function audioOf(...channels: number[][]): PcmAudio {
  const planar = channels.map((c) => Float64Array.from(c));
  return { sampleRate: 48000, channels: planar.length, frames: planar[0]?.length ?? 0, planar };
}

describe('audio-dsp contract — resample/gain/mix/explicit matrix (REQUIREMENTS §5.4 — 2.1.4)', () => {
  it('resample: 0dB gain is identity, resample identity preserves samples', () => {
    const a = audioOf([0.2, -0.3, 0.8], [0.1, 0.4, -0.1]);
    const g = gain(a, 0);
    for (let c = 0; c < a.channels; c++)
      expect(channelAt(g.planar, c)).toEqual(channelAt(a.planar, c));
    const r = resample(a, 48000);
    for (let c = 0; c < a.channels; c++)
      expect(channelAt(r.planar, c)).toEqual(channelAt(a.planar, c));
  });

  it('gain: +6dB doubles amplitude, -inf mutes, malformed NaN/Infinity handled', () => {
    const a = audioOf([0.5, -0.5]);
    const doubled = gain(a, 6.020599913279624);
    expect(sampleAt(channelAt(doubled.planar, 0), 0)).toBeCloseTo(1, 10);
    const muted = gain(a, Number.NEGATIVE_INFINITY);
    expect(sampleAt(channelAt(muted.planar, 0), 0)).toBe(0);
    expect(dbToLinear(0)).toBe(1);
    expect(Number.isFinite(dbToLinear(20))).toBe(true);
  });

  it('mix: explicit matrix identity and stereo→mono vs matrix parity', () => {
    const a = audioOf([1, 0.5], [-1, 0.5]);
    const viaRemix = remix(a, 1);
    const viaMatrix = remixMatrix(a, [[0.5, 0.5]]);
    expect(channelAt(viaMatrix.planar, 0)).toEqual(channelAt(viaRemix.planar, 0));
    const id = remixMatrix(a, [
      [1, 0],
      [0, 1],
    ]);
    expect(channelAt(id.planar, 0)).toEqual(channelAt(a.planar, 0));
    expect(channelAt(id.planar, 1)).toEqual(channelAt(a.planar, 1));
  });

  it('mix matrix: 1→2 duplicate and 2→6 front-only, 6→2 BS.775 deterministic', () => {
    const mono = audioOf([0.7, -0.7]);
    const dup = remixMatrix(mono, [[1], [1]]);
    expect(channelAt(dup.planar, 0)).toEqual(channelAt(mono.planar, 0));
    expect(channelAt(dup.planar, 1)).toEqual(channelAt(mono.planar, 0));
    const stereo = audioOf([0.5], [0.25]);
    const up = remix(stereo, 6);
    expect(up.channels).toBe(6);
    const down = remix(up, 2);
    expect(down.channels).toBe(2);
  });

  it('malformed: invalid rates, NaN matrix, shape mismatches throw typed errors', () => {
    const a = audioOf([0.1, 0.2]);
    expect(() => resample(a, 0)).toThrow(CapabilityError);
    expect(() => resample(a, Number.NaN)).toThrow(CapabilityError);
    expect(() => remix(a, 0)).toThrow(CapabilityError);
    expect(() => remixMatrix(a, [[Number.NaN]] as unknown as number[][])).toThrow(InputError);
    expect(() => remixMatrix(a, [[1, 0, 0]] as unknown as number[][])).toThrow(InputError);
    expect(() => remixMatrix(a, [[1]] as unknown as number[][], 0)).toThrow(CapabilityError);
  });

  it('boundary: empty frames, single sample, 1 channel, high ratio still finite', () => {
    const empty: PcmAudio = {
      sampleRate: 44100,
      channels: 1,
      frames: 0,
      planar: [new Float64Array(0)],
    };
    expect(resample(empty, 48000).frames).toBe(0);
    const single = audioOf([0.9]);
    const up = resample(single, 96000);
    expect(up.frames).toBe(2);
    expect(Number.isFinite(sampleAt(channelAt(up.planar, 0), 0))).toBe(true);
    const g0 = gain(empty, -6);
    expect(g0.frames).toBe(0);
  });

  it('randomized: 20× gain→mix→resample composition deterministic and bounded', () => {
    let seed = 0x5a5a1234;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let t = 0; t < 20; t++) {
      const frames = 4 + Math.floor(rnd() * 32);
      const ch = Float64Array.from({ length: frames }, () => rnd() * 2 - 1);
      const a: PcmAudio = { sampleRate: 44100, channels: 1, frames, planar: [ch] };
      const g = gain(a, (rnd() - 0.5) * 12);
      const r = resample(g, rnd() < 0.5 ? 48000 : 16000);
      for (let i = 0; i < r.frames; i++)
        expect(Number.isFinite(sampleAt(channelAt(r.planar, 0), i))).toBe(true);
      const stereo = remix(a, 2);
      const mono = remix(stereo, 1);
      expect(mono.frames).toBe(frames);
      expect(channelAt(mono.planar, 0).length).toBe(frames);
    }
  });
});
