import { describe, expect, it } from 'vitest';
import type { PcmTransform } from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { type BiquadSpec, biquad } from '../dsp/biquad.ts';
import { limit, normalizePeak } from '../dsp/dynamics.ts';
import { dbToLinear } from '../dsp/gain.ts';
import { type PcmAudio, channelAt, sampleAt } from '../dsp/pcm.ts';
import { applyPcmTransform } from './pcm-transform.ts';

function ones(frames = 8, sampleRate = 48_000): PcmAudio {
  return {
    sampleRate,
    channels: 1,
    frames,
    planar: [new Float64Array(frames).fill(1)],
  };
}

describe('applyPcmTransform', () => {
  it('routes equal-power fade through the shared PCM transform helper', () => {
    const out = applyPcmTransform(ones(4), { fade: { inSec: 4 / 48_000, curve: 'equal-power' } });
    const ch = channelAt(out.planar, 0);
    expect(sampleAt(ch, 0)).toBe(0);
    expect(sampleAt(ch, 3)).toBeCloseTo(1, 12);
    expect(sampleAt(ch, 1)).toBeCloseTo(Math.sin(Math.PI / 6), 12);
  });

  it('rejects malformed fade shapes and durations with typed input errors', () => {
    expect(() => applyPcmTransform(ones(), { fade: 'bad' } as unknown as PcmTransform)).toThrow(
      InputError,
    );
    expect(() =>
      applyPcmTransform(ones(), { fade: { inSec: 0.1, curve: 'expo' } } as unknown as PcmTransform),
    ).toThrow(InputError);
    expect(() => applyPcmTransform(ones(), { fade: { inSec: Number.NaN } })).toThrow(InputError);
    expect(() => applyPcmTransform(ones(), { fade: { outSec: -1 } })).toThrow(InputError);
    expect(() => applyPcmTransform(ones(), { fade: { inSec: Number.MAX_SAFE_INTEGER } })).toThrow(
      InputError,
    );
  });

  it('keeps bridges that disable resample on a typed capability miss', () => {
    expect(() =>
      applyPcmTransform(ones(), { sampleRate: 24_000 }, { resample: 'reject', tried: ['test'] }),
    ).toThrow(CapabilityError);
  });

  it('applies biquad before dynamics normalize and limiter in the PCM transform helper', () => {
    const audio: PcmAudio = {
      sampleRate: 48_000,
      channels: 1,
      frames: 8,
      planar: [Float64Array.from([0.4, -0.8, 0.2, 0.6, -0.3, 0.1, -0.5, 0.7])],
    };
    const spec: BiquadSpec = { type: 'highpass', frequency: 1200, q: Math.SQRT1_2 };
    const expected = limit(normalizePeak(biquad(audio, spec), -6), -3, 'hard');
    const out = applyPcmTransform(audio, {
      biquad: spec,
      dynamics: {
        normalize: { mode: 'peak', targetDbfs: -6 },
        limit: { ceilingDbfs: -3, mode: 'hard' },
      },
    });
    expect(channelAt(out.planar, 0)).toEqual(channelAt(expected.planar, 0));
    expect(Math.max(...Array.from(channelAt(out.planar, 0), Math.abs))).toBeCloseTo(
      dbToLinear(-6),
      12,
    );
  });

  it('supports a chain of biquad sections and RMS normalize plus a soft limiter', () => {
    const audio: PcmAudio = {
      sampleRate: 48_000,
      channels: 1,
      frames: 64,
      planar: [
        Float64Array.from(
          Array.from({ length: 64 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48_000)),
        ),
      ],
    };
    const out = applyPcmTransform(audio, {
      biquad: [
        { type: 'lowshelf', frequency: 200, q: Math.SQRT1_2, gainDb: 3 },
        { type: 'peaking', frequency: 1000, q: 1.5, gainDb: -2 },
      ],
      dynamics: { normalize: { mode: 'rms', targetDbfs: -18 }, limit: { mode: 'soft', knee: 0.8 } },
    });
    for (const sample of channelAt(out.planar, 0)) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(Math.abs(sample)).toBeLessThanOrEqual(1);
    }
  });

  it('rejects malformed dynamics and biquad options with typed input errors', () => {
    expect(() =>
      applyPcmTransform(ones(), {
        dynamics: { normalize: { mode: 'lufs', targetDbfs: -14 } },
      } as unknown as PcmTransform),
    ).toThrow(InputError);
    expect(() =>
      applyPcmTransform(ones(), {
        dynamics: { normalize: { mode: 'peak', targetDbfs: Number.NaN } },
      }),
    ).toThrow(InputError);
    expect(() =>
      applyPcmTransform(ones(), {
        dynamics: { limit: { mode: 'brickwall' } },
      } as unknown as PcmTransform),
    ).toThrow(InputError);
    expect(() => applyPcmTransform(ones(), { biquad: null } as unknown as PcmTransform)).toThrow(
      InputError,
    );
    expect(() =>
      applyPcmTransform(ones(), {
        biquad: { type: 'lowpass', frequency: 24_000, q: 1 },
      }),
    ).toThrow(InputError);
  });

  it('honors cancellation before touching samples', () => {
    const ac = new AbortController();
    ac.abort();
    expect(() => applyPcmTransform(ones(), { signal: ac.signal })).toThrow(MediaError);
  });
});
