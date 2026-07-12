import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { audioFilterSpecs } from './audio-stream-plan.ts';

describe('audio stream plan validation branches', () => {
  const source = { sampleRate: 48_000, channels: 2 };

  it('rejects every invalid fade representation and unsafe frame count', () => {
    expect(() =>
      audioFilterSpecs(
        { fade: { inSec: Number.MAX_VALUE } },
        { sampleRate: Number.MAX_SAFE_INTEGER, channels: 2 },
      ),
    ).toThrowError(InputError);
    expect(() =>
      audioFilterSpecs({ fade: { curve: 'logarithmic' as 'linear' } }, source),
    ).toThrowError(InputError);
    expect(() =>
      audioFilterSpecs({ fade: { inSec: 1 } }, { sampleRate: 48_000.5, channels: 2 }),
    ).toThrowError(InputError);
    expect(() =>
      audioFilterSpecs({ fade: { inSec: 1 } }, { sampleRate: 0, channels: 2 }),
    ).toThrowError(InputError);
  });

  it('rejects non-finite and unsupported dynamics fields independently', () => {
    expect(() =>
      audioFilterSpecs(
        { dynamics: { normalize: { mode: 'peak', targetDbfs: Number.NaN } } },
        source,
      ),
    ).toThrowError(InputError);
    expect(() =>
      audioFilterSpecs({ dynamics: { limit: { ceilingDbfs: Number.POSITIVE_INFINITY } } }, source),
    ).toThrowError(InputError);
    expect(() =>
      audioFilterSpecs({ dynamics: { limit: { mode: 'brickwall' as 'hard' } } }, source),
    ).toThrowError(InputError);
    expect(() =>
      audioFilterSpecs({ dynamics: { limit: { knee: Number.NaN } } }, source),
    ).toThrowError(InputError);
  });

  it('emits each optional dynamics side independently', () => {
    expect(
      audioFilterSpecs({ dynamics: { normalize: { mode: 'peak', targetDbfs: -1 } } }, source),
    ).toEqual([
      {
        mediaType: 'audio',
        type: 'dynamics',
        dynamics: { normalize: { mode: 'peak', targetDbfs: -1 } },
      },
    ]);
    expect(audioFilterSpecs({ dynamics: { limit: {} } }, source)).toEqual([
      {
        mediaType: 'audio',
        type: 'dynamics',
        dynamics: { limit: { ceilingDbfs: 0, mode: 'hard' } },
      },
    ]);
  });
});
