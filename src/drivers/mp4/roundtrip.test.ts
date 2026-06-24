import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test-support/corpus.ts';
import { muxTracksFromMovie, readMovie } from './mp4-driver.ts';
import { buildSampleData } from './samples.ts';
import { writeMp4 } from './write.ts';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

function strip(s: { size: number; durationTicks: number; cttsTicks: number; keyframe: boolean }) {
  return {
    size: s.size,
    durationTicks: s.durationTicks,
    cttsTicks: s.cttsTicks,
    keyframe: s.keyframe,
  };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('MP4 muxer — reference-reimport round-trip on the real corpus', () => {
  it.each(['2x2-green.mp4', 'movie_5.mp4', 'test.mp4'])(
    '%s: write(parse(x)) re-parses to identical tracks + sample tables, and is a genuine re-layout',
    async (id) => {
      const input = await loadFixture(id);
      const movie = await readMovie(ra(input));
      const tracks = await muxTracksFromMovie(ra(input), movie);
      const output = writeMp4(tracks);

      // Anti-cheat (doc 11 §5): a genuine re-layout, not the ftyp-byte-flip passthrough.
      expect(output.byteLength).toBeGreaterThan(0);
      expect(equalBytes(output, input)).toBe(false);

      const reparsed = await readMovie(ra(output));
      expect(reparsed.tracks.length).toBe(movie.tracks.length);

      for (let t = 0; t < movie.tracks.length; t++) {
        const a = movie.tracks[t];
        const b = reparsed.tracks[t];
        expect(b?.codec).toBe(a?.codec);
        expect(b?.width).toBe(a?.width);
        expect(b?.height).toBe(a?.height);
        expect(b?.sampleRate).toBe(a?.sampleRate);
        expect(b?.channels).toBe(a?.channels);
        expect(b?.timescale).toBe(a?.timescale);
        expect(b?.durationSec).toBe(a?.durationSec);

        // Sample tables match exactly (size + timing + keyframes); byte offsets differ by design.
        const sa = a ? buildSampleData(a).map(strip) : [];
        const sb = b ? buildSampleData(b).map(strip) : [];
        expect(sb).toEqual(sa);
      }
    },
  );

  it('round-trips losslessly through a second remux (double-remux stability)', async () => {
    const input = await loadFixture('2x2-green.mp4');
    const once = writeMp4(await muxTracksFromMovie(ra(input), await readMovie(ra(input))));
    const twice = writeMp4(await muxTracksFromMovie(ra(once), await readMovie(ra(once))));
    expect(equalBytes(twice, once)).toBe(true);
  });
});
