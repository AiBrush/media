import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { be32, box, bytes, cat, full, str } from '../../test-support/mp4-builder.ts';
import { parseMovie, parseMovieMetadata } from './parse.ts';
import { MAX_MP4_SAMPLES_PER_TRACK } from './parse.ts';

function moovWithStsz(count: number, sampleSize = 1024): Uint8Array {
  // Minimal video trak with custom stsz count (constant-size path)
  const avcC = box('avcC', [1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x00]);
  const visualEntry = box(
    'avc1',
    cat(
      new Array(6).fill(0),
      [0, 1],
      new Array(16).fill(0),
      [0, 4],
      [0, 4],
      new Array(50).fill(0),
      avcC,
    ),
  );
  const stbl = box(
    'stbl',
    cat(
      full('stsd', 0, cat(be32(1), visualEntry)),
      cat(
        full('stts', 0, cat(be32(1), be32(1), be32(1024))),
        full('stsz', 0, cat(be32(sampleSize), be32(count))),
        full('stsc', 0, cat(be32(1), be32(1), be32(1), be32(1))),
        full('stco', 0, cat(be32(1), be32(1000))),
      ),
    ),
  );
  const mdia = box(
    'mdia',
    cat(
      full('mdhd', 0, cat(new Array(8).fill(0), be32(1000), be32(2000), new Array(4).fill(0))),
      full('hdlr', 0, cat(new Array(4).fill(0), str('vide'), new Array(12).fill(0))),
      box('minf', stbl),
    ),
  );
  const tkhd = full(
    'tkhd',
    0,
    cat(
      new Array(8).fill(0),
      be32(1),
      new Array(4).fill(0),
      be32(0),
      new Array(8).fill(0),
      new Array(2).fill(0),
      new Array(2).fill(0),
      new Array(2).fill(0),
      new Array(2).fill(0),
      be32(0x00010000),
      be32(0),
      new Array(4).fill(0),
      be32(0),
      be32(0),
      new Array(16).fill(0),
      new Array(8).fill(0),
    ),
  );
  const trak = box('trak', cat(tkhd, mdia));
  const moov = box(
    'moov',
    cat(
      full('mvhd', 0, cat(new Array(8).fill(0), be32(1000), be32(2000), new Array(4).fill(0))),
      trak,
    ),
  );
  return bytes(moov.slice(8));
}

function moovWithStts(count: number): Uint8Array {
  const avcC = box('avcC', [1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x00]);
  const visualEntry = box(
    'avc1',
    cat(
      new Array(6).fill(0),
      [0, 1],
      new Array(16).fill(0),
      [0, 4],
      [0, 4],
      new Array(50).fill(0),
      avcC,
    ),
  );
  const stbl = box(
    'stbl',
    cat(
      full('stsd', 0, cat(be32(1), visualEntry)),
      cat(
        full('stts', 0, cat(be32(1), be32(count), be32(1024))),
        full('stsz', 0, cat(be32(0), be32(1), be32(100))),
        full('stsc', 0, cat(be32(1), be32(1), be32(1), be32(1))),
        full('stco', 0, cat(be32(1), be32(1000))),
      ),
    ),
  );
  const mdia = box(
    'mdia',
    cat(
      full('mdhd', 0, cat(new Array(8).fill(0), be32(1000), be32(2000), new Array(4).fill(0))),
      full('hdlr', 0, cat(new Array(4).fill(0), str('vide'), new Array(12).fill(0))),
      box('minf', stbl),
    ),
  );
  const tkhd = full(
    'tkhd',
    0,
    cat(
      new Array(8).fill(0),
      be32(1),
      new Array(4).fill(0),
      be32(0),
      new Array(8).fill(0),
      new Array(2).fill(0),
      new Array(2).fill(0),
      new Array(2).fill(0),
      new Array(2).fill(0),
      be32(0x00010000),
      be32(0),
      new Array(4).fill(0),
      be32(0),
      be32(0),
      new Array(16).fill(0),
      new Array(8).fill(0),
    ),
  );
  const trak = box('trak', cat(tkhd, mdia));
  const moov = box(
    'moov',
    cat(
      full('mvhd', 0, cat(new Array(8).fill(0), be32(1000), be32(2000), new Array(4).fill(0))),
      trak,
    ),
  );
  return bytes(moov.slice(8));
}

describe('MP4 per-track sample-count budget', () => {
  it('rejects stsz constant >MAX with typed demux-error and budget message', () => {
    const payload = moovWithStsz(MAX_MP4_SAMPLES_PER_TRACK + 1);
    expect(() => parseMovie('isom', payload)).toThrow(MediaError);
    try {
      parseMovie('isom', payload);
    } catch (e) {
      expect((e as MediaError).code).toBe('demux-error');
      expect((e as Error).message).toMatch(/budget exceeded/);
    }
    expect(() => parseMovieMetadata('isom', payload)).toThrow(MediaError);
  });

  it('rejects stts sum >MAX with typed demux-error', () => {
    const payload = moovWithStts(MAX_MP4_SAMPLES_PER_TRACK + 1);
    expect(() => parseMovie('isom', payload)).toThrow(MediaError);
    try {
      parseMovie('isom', payload);
    } catch (e) {
      expect((e as MediaError).code).toBe('demux-error');
      expect((e as Error).message).toMatch(/budget exceeded/);
    }
  });

  it('accepts exactly MAX samples at the boundary', () => {
    const payload = moovWithStsz(MAX_MP4_SAMPLES_PER_TRACK, 1);
    const movie = parseMovie('isom', payload);
    expect(movie.tracks[0]?.samples.sampleSizes.length).toBe(MAX_MP4_SAMPLES_PER_TRACK);
    const meta = parseMovieMetadata('isom', payload);
    expect(meta.tracks[0]?.moovSampleCount).toBe(MAX_MP4_SAMPLES_PER_TRACK);
  });

  it('20× randomized 1–10 samples bit-exact on sample count and duration', () => {
    let seed = 0x9e3779b9;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let i = 0; i < 20; i++) {
      const n = (next() % 10) + 1;
      const payload = moovWithStsz(n, 100);
      const movie = parseMovie('isom', payload);
      expect(movie.tracks[0]?.samples.sampleSizes.length).toBe(n);
      expect(movie.tracks[0]?.durationSec).toBeCloseTo(2, 5);
      const meta = parseMovieMetadata('isom', payload);
      expect(meta.tracks[0]?.moovSampleCount).toBe(n);
    }
  });

  it('rejects truncated / malformed without OOM', () => {
    const valid = moovWithStsz(5);
    const truncated = valid.subarray(0, 20);
    expect(() => parseMovie('isom', truncated)).toThrow();
    expect(() => parseMovie('isom', new Uint8Array([0, 1, 2, 3]))).toThrow();
    // stsz declares large count but box is truncated — should throw truncated, not allocate
    const badStsz = full('stsz', 0, cat(be32(0), be32(100000), be32(1), be32(2)));
    // badStsz as raw moov should fail either truncated or budget
    const badMoov = (() => {
      const avcC = box('avcC', [1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x00]);
      const visualEntry = box(
        'avc1',
        cat(
          new Array(6).fill(0),
          [0, 1],
          new Array(16).fill(0),
          [0, 4],
          [0, 4],
          new Array(50).fill(0),
          avcC,
        ),
      );
      const stbl = box('stbl', cat(full('stsd', 0, cat(be32(1), visualEntry)), badStsz));
      const mdia = box(
        'mdia',
        cat(
          full('mdhd', 0, cat(new Array(8).fill(0), be32(1000), be32(2000), new Array(4).fill(0))),
          full('hdlr', 0, cat(new Array(4).fill(0), str('vide'), new Array(12).fill(0))),
          box('minf', stbl),
        ),
      );
      const tkhd = full(
        'tkhd',
        0,
        cat(
          new Array(8).fill(0),
          be32(1),
          new Array(4).fill(0),
          be32(0),
          new Array(8).fill(0),
          new Array(2).fill(0),
          new Array(2).fill(0),
          new Array(2).fill(0),
          new Array(2).fill(0),
          be32(0x00010000),
          be32(0),
          new Array(4).fill(0),
          be32(0),
          be32(0),
          new Array(16).fill(0),
          new Array(8).fill(0),
        ),
      );
      const trak = box('trak', cat(tkhd, mdia));
      const moov = box(
        'moov',
        cat(
          full('mvhd', 0, cat(new Array(8).fill(0), be32(1000), be32(2000), new Array(4).fill(0))),
          trak,
        ),
      );
      return bytes(moov.slice(8));
    })();
    expect(() => parseMovie('isom', badMoov)).toThrow(MediaError);
  });
});
