import { describe, expect, it } from 'vitest';
import { fixtureSource } from '../../test-support/corpus.ts';
import { Mp4Driver } from './mp4-driver.ts';

describe('MP4 AAC gapless metadata', () => {
  it('derives exact program sample counts from AAC edit lists without changing public durations', async () => {
    const demuxer = await Mp4Driver.demux(await fixtureSource('test.mp4'));
    try {
      const audio = demuxer.tracks.find((track) => track.mediaType === 'audio');
      expect(audio?.codec).toBe('mp4a.40.2');
      expect(audio?.durationSec).toBeCloseTo(6.03718820861678, 12);
      expect(audio?.gapless).toEqual({
        leadingSamples: 0,
        trailingSamples: 440,
        totalSamples: 265800,
      });
    } finally {
      await demuxer.close();
    }
  });

  it('keeps zero-padding AAC edit lists explicit instead of omitting the sample-count contract', async () => {
    const demuxer = await Mp4Driver.demux(await fixtureSource('obs-remux-variable-aac.mp4'));
    try {
      const audio = demuxer.tracks.find((track) => track.mediaType === 'audio');
      expect(audio?.codec).toBe('mp4a.40.2');
      expect(audio?.gapless).toEqual({
        leadingSamples: 0,
        trailingSamples: 0,
        totalSamples: 301008,
      });
    } finally {
      await demuxer.close();
    }
  });

  it('does not invent gapless facts for AAC tracks without a supported edit-list window', async () => {
    const demuxer = await Mp4Driver.demux(await fixtureSource('movie_5.mp4'));
    try {
      const audio = demuxer.tracks.find((track) => track.mediaType === 'audio');
      expect(audio?.codec).toBe('mp4a.40.2');
      expect(audio?.gapless).toBeUndefined();
    } finally {
      await demuxer.close();
    }
  });
});
