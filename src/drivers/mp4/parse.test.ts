import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import {
  be32,
  box,
  bytes,
  cat,
  full,
  moovBox,
  moovPayload,
  zeros,
} from '../../test-support/mp4-builder.ts';
import { parseMovie } from './parse.ts';

describe('parseMovie — format variants', () => {
  const movie = parseMovie('isom', moovPayload());

  it('parses movie-level timing and skips non-AV tracks', () => {
    expect(movie.brand).toBe('isom');
    expect(movie.durationSec).toBe(2); // 1200 / 600
    expect(movie.tracks).toHaveLength(2); // subtitle/text track skipped
  });

  it('parses the video track (avc1, dims, rotation, fps, co64, ctts)', () => {
    const v = movie.tracks.find((t) => t.mediaType === 'video');
    expect(v?.codec).toBe('avc1.640028');
    expect(v?.width).toBe(4);
    expect(v?.height).toBe(4);
    expect(v?.rotation).toBe(90);
    expect(v?.durationSec).toBe(2);
    expect(v?.fps).toBe(1); // 2 samples / 2 s
    expect(v?.samples.chunkOffsets).toEqual([1000]); // co64
    expect(v?.samples.compositionOffsets).toHaveLength(1);
    expect(v?.samples.sampleSizes).toEqual([5, 7]);
  });

  it('parses the audio track (mp4a fallback without esds, constant stsz, stco)', () => {
    const a = movie.tracks.find((t) => t.mediaType === 'audio');
    expect(a?.codec).toBe('mp4a');
    expect(a?.sampleRate).toBe(48000);
    expect(a?.channels).toBe(2);
    expect(a?.samples.sampleSizes).toEqual([100]); // constant-size stsz expanded
    expect(a?.samples.chunkOffsets).toEqual([2000]); // stco
    expect(a?.rotation).toBeUndefined();
  });
});

describe('parseMovie — rotation + codec fallback variants', () => {
  it('falls back to the fourcc for a non-avc codec and reads 180° rotation', () => {
    const m = parseMovie(
      'isom',
      bytes(moovBox({ videoType: 'hvc1', rotationAB: [0xffff0000, 0] }).slice(8)),
    );
    const v = m.tracks.find((t) => t.mediaType === 'video');
    expect(v?.codec).toBe('hvc1');
    expect(v?.rotation).toBe(180);
  });

  it('reads 270° rotation', () => {
    const m = parseMovie('isom', bytes(moovBox({ rotationAB: [0, 0xffff0000] }).slice(8)));
    expect(m.tracks.find((t) => t.mediaType === 'video')?.rotation).toBe(270);
  });
});

describe('parseMovie — error handling', () => {
  it('throws when moov has no mvhd', () => {
    expect(() => parseMovie('isom', bytes(box('moov', []).slice(8)))).toThrowError(MediaError);
  });

  it('throws when moov has no decodable tracks', () => {
    const moov = box('moov', full('mvhd', 0, cat(zeros(8), be32(600), be32(1200), zeros(4))));
    expect(() => parseMovie('isom', bytes(moov.slice(8)))).toThrowError(/no decodable tracks/);
  });
});
