import { describe, expect, it } from 'vitest';
import { dbToLinear, gain } from './gain.ts';
import { type PcmAudio, channelAt, sampleAt } from './pcm.ts';

function audioOf(...channels: number[][]): PcmAudio {
  const planar = channels.map((c) => Float64Array.from(c));
  return { sampleRate: 48000, channels: planar.length, frames: planar[0]?.length ?? 0, planar };
}

describe('gain', () => {
  it('dbToLinear maps the reference points', () => {
    expect(dbToLinear(0)).toBe(1);
    expect(dbToLinear(-6.020599913279624)).toBeCloseTo(0.5, 12);
    expect(dbToLinear(6.020599913279624)).toBeCloseTo(2, 12);
    expect(dbToLinear(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('0 dB is bit-exact identity', () => {
    const a = audioOf([0, 0.3, -0.7, 1, -1], [0.1, -0.2, 0.5, -0.5, 0]);
    const g = gain(a, 0);
    for (let c = 0; c < a.channels; c++) {
      expect(channelAt(g.planar, c)).toEqual(channelAt(a.planar, c));
    }
  });

  it('scales every sample by exactly the linear factor (multi-channel)', () => {
    const a = audioOf([0.1, -0.25, 0.5], [0.2, -0.4, 0.8]);
    const db = -6.020599913279624;
    const factor = dbToLinear(db);
    const g = gain(a, db);
    expect(g.channels).toBe(2);
    expect(g.frames).toBe(3);
    for (let c = 0; c < a.channels; c++) {
      for (let i = 0; i < a.frames; i++) {
        expect(sampleAt(channelAt(g.planar, c), i)).toBe(
          sampleAt(channelAt(a.planar, c), i) * factor,
        );
      }
    }
  });

  it('does real work — a non-zero gain changes the samples (not a passthrough)', () => {
    const a = audioOf([0.4, -0.4]);
    const g = gain(a, 6);
    expect(channelAt(g.planar, 0)).not.toEqual(channelAt(a.planar, 0));
    expect(channelAt(a.planar, 0)).toEqual(Float64Array.of(0.4, -0.4)); // input untouched
  });
});
