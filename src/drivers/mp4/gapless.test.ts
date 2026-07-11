import { describe, expect, it } from 'vitest';
import { gaplessFromMp4Edit } from './gapless.ts';

describe('MP4 edit-list gapless projection', () => {
  it('clamps an impossible declared program duration to the coded sample capacity', () => {
    expect(gaplessFromMp4Edit(1024, 47143 / 44100, 44100, 44100, 47104)).toEqual({
      basis: 'mp4-edit-list',
      leadingSamples: 1024,
      trailingSamples: 0,
      totalSamples: 46080,
    });
  });

  it('preserves a possible shorter edit and independently derives its terminal padding', () => {
    expect(gaplessFromMp4Edit(1024, 44673 / 44100, 44100, 44100, 46080)).toEqual({
      basis: 'mp4-edit-list',
      leadingSamples: 1024,
      trailingSamples: 383,
      totalSamples: 44673,
    });
  });
});
