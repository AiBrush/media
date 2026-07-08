import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import {
  be16,
  be32,
  be64,
  box,
  bytes,
  cat,
  full,
  moovBox,
  moovPayload,
  str,
  zeros,
} from '../../test-support/mp4-builder.ts';
import { parseMovie, parseMovieMetadata } from './parse.ts';
import { buildSamples } from './samples.ts';

function withFirstFourccRenamed(source: Uint8Array, from: string, to: string): Uint8Array {
  const out = source.slice();
  const needle = [...from].map((char) => char.charCodeAt(0));
  const replacement = [...to].map((char) => char.charCodeAt(0));
  for (let i = 0; i <= out.byteLength - needle.length; i++) {
    if (needle.every((byte, offset) => out[i + offset] === byte)) {
      out.set(replacement, i);
      return out;
    }
  }
  throw new Error(`fourcc ${from} not found`);
}

describe('parseMovie — format variants', () => {
  const movie = parseMovie('isom', moovPayload());

  it('parses movie-level timing and surfaces the non-AV track instead of dropping it (ADR-185)', () => {
    expect(movie.brand).toBe('isom');
    expect(movie.durationSec).toBe(2); // 1200 / 600
    expect(movie.tracks).toHaveLength(2); // decodable AV tracks only
    // The declared text trak is never dropped: it surfaces honestly with its handler + entry fourcc.
    expect(movie.otherTracks).toEqual([
      {
        id: 3,
        handler: 'text',
        codec: 'tx3g',
        timescale: 1000,
        durationSec: 1,
        sampleCount: 0,
        trakIndex: 2,
      },
    ]);
  });

  it('parses the video track (avc1, dims, rotation, fps, co64, ctts)', () => {
    const v = movie.tracks.find((t) => t.mediaType === 'video');
    expect(v?.codec).toBe('avc1.640028');
    expect(v?.width).toBe(4);
    expect(v?.height).toBe(4);
    expect(v?.rotation).toBe(90);
    expect(v?.durationSec).toBe(2);
    expect(v?.fps).toBe(1); // 2 samples / 2 s
    expect(v?.trakIndex).toBe(0); // file-order position, for ffprobe-faithful track listings
    expect(v?.samples.chunkOffsets).toEqual([1000]); // co64
    expect(v?.samples.compositionOffsets).toHaveLength(1);
    expect(v?.samples.sampleSizes).toEqual([5, 7]);
  });

  it('parses the audio track (mp4a fallback without esds, constant stsz, stco)', () => {
    const a = movie.tracks.find((t) => t.mediaType === 'audio');
    expect(a?.codec).toBe('mp4a');
    expect(a?.sampleRate).toBe(48000);
    expect(a?.channels).toBe(2);
    expect(a?.trakIndex).toBe(1);
    expect(a?.samples.sampleSizes).toEqual([100]); // constant-size stsz expanded
    expect(a?.samples.chunkOffsets).toEqual([2000]); // stco
    expect(a?.rotation).toBeUndefined();
  });
});

describe('parseMovieMetadata — metadata-only sample tables', () => {
  it('preserves track timing while leaving packet byte tables empty', () => {
    const movie = parseMovieMetadata('isom', moovPayload());
    expect(movie.needsFragmentTiming).toBe(false);

    const video = movie.tracks.find((t) => t.mediaType === 'video');
    expect(video?.fps).toBe(1);
    expect(video?.samples.timeToSample).toEqual([{ count: 2, delta: 300 }]);
    expect(video?.samples.sampleSizes).toEqual([]);
    expect(video?.samples.sampleToChunk).toEqual([]);
    expect(video?.samples.chunkOffsets).toEqual([]);

    const audio = movie.tracks.find((t) => t.mediaType === 'audio');
    expect(audio?.samples.timeToSample).toEqual([{ count: 1, delta: 48000 }]);
    expect(audio?.samples.sampleSizes).toEqual([]);
  });

  it('falls back to stts sample counts when metadata has no stsz box', () => {
    const withoutVideoStsz = withFirstFourccRenamed(moovPayload(), 'stsz', 'free');
    const movie = parseMovieMetadata('isom', withoutVideoStsz);

    const video = movie.tracks.find((t) => t.mediaType === 'video');
    expect(video?.fps).toBe(1);
    expect(video?.samples.timeToSample).toEqual([{ count: 2, delta: 300 }]);
    expect(video?.samples.sampleSizes).toEqual([]);
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

  it('parses QuickTime .mp3 audio sample entries as mp3', () => {
    const m = parseMovie('isom', bytes(moovBox({ audioType: '.mp3' }).slice(8)));
    const a = m.tracks.find((t) => t.mediaType === 'audio');
    expect(a?.codec).toBe('mp3');
    expect(a?.config.codec).toBe('mp3');
    expect(a?.sampleRate).toBe(48000);
    expect(a?.channels).toBe(2);
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

// ============ QTFF extensions: colr/pasp/clap + never-drop-a-trak (task #11 / ADR-185) ============
//
// Synthetic minimal moovs (mp4-builder precedent) exercise exactly the branches the real fixture
// corpus cannot supply: a `clap` box (no obtainable tool writes one for H.264), unknown H.273 code
// points, an ICC-profile `colr`, and malformed non-media traks. Everything corpus-coverable is
// validated against real files + ffprobe truth in golden-metadata.test.ts.

const mvhd600 = full('mvhd', 1, cat(zeros(16), be32(600), be64(1200), zeros(4)));

function tkhd0(trackId: number): number[] {
  return full(
    'tkhd',
    0,
    cat(
      zeros(8),
      be32(trackId),
      zeros(4),
      be32(0),
      zeros(8 + 2 + 2 + 2 + 2),
      be32(0x00010000),
      be32(0),
      zeros(4),
      be32(0),
      be32(0x00010000),
      zeros(16),
      zeros(8),
    ),
  );
}

function mdiaFor(handler: string, stblChildren: number[]): number[] {
  return box(
    'mdia',
    cat(
      full('mdhd', 0, cat(zeros(8), be32(600), be32(1200), zeros(4))),
      full('hdlr', 0, cat(zeros(4), str(handler), zeros(12))),
      box('minf', box('stbl', stblChildren)),
    ),
  );
}

/** A minimal avc1 video trak whose sample entry carries the given extension boxes. */
function videoTrakWith(extensions: number[]): number[] {
  const avcC = box('avcC', [1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x00]);
  const entry = box(
    'avc1',
    cat(zeros(6), be16(1), zeros(16), be16(4), be16(4), zeros(50), avcC, extensions),
  );
  return box(
    'trak',
    cat(
      tkhd0(1),
      mdiaFor(
        'vide',
        cat(
          full('stsd', 0, cat(be32(1), entry)),
          full('stts', 0, cat(be32(1), be32(1), be32(600))),
          full('stsz', 0, cat(be32(0), be32(1), be32(5))),
          full('stsc', 0, cat(be32(1), be32(1), be32(1), be32(1))),
          full('stco', 0, cat(be32(1), be32(1000))),
        ),
      ),
    ),
  );
}

function movieWith(traks: number[][]): ReturnType<typeof parseMovie> {
  return parseMovie('qt  ', bytes(box('moov', cat(mvhd600, ...traks)).slice(8)));
}

describe('parseMovie — colr/pasp/clap sample-entry extensions', () => {
  it('parses a clap box into the raw clean-aperture fractions', () => {
    const clap = box(
      'clap',
      cat(be32(3), be32(1), be32(2), be32(1), ...[be32(-1 >>> 0), be32(2)], be32(0), be32(1)),
    );
    const movie = movieWith([videoTrakWith(clap)]);
    const v = movie.tracks[0];
    expect(v?.clap).toEqual({
      cleanApertureWidthN: 3,
      cleanApertureWidthD: 1,
      cleanApertureHeightN: 2,
      cleanApertureHeightD: 1,
      horizOffN: -1, // signed per QTFF/ISO 12.1.4.1 — a centred crop uses negative/zero offsets
      horizOffD: 2,
      vertOffN: 0,
      vertOffD: 1,
    });
  });

  it('keeps unknown H.273 code points raw but maps nothing into the decoder colorSpace (honest omission)', () => {
    const colr = box('colr', cat(str('nclc'), be16(22), be16(23), be16(24)));
    const movie = movieWith([videoTrakWith(colr)]);
    const v = movie.tracks[0];
    expect(v?.colr).toEqual({ colourType: 'nclc', primaries: 22, transfer: 23, matrix: 24 });
    expect(v?.colorSpace).toBeUndefined();
    expect((v?.config as VideoDecoderConfig).colorSpace).toBeUndefined();
  });

  it('ignores an ICC-profile colr (rICC/prof) — no fake nclc fields, no colorSpace guess', () => {
    const colr = box('colr', cat(str('rICC'), zeros(8)));
    const movie = movieWith([videoTrakWith(colr)]);
    const v = movie.tracks[0];
    expect(v?.colr).toBeUndefined();
    expect(v?.colorSpace).toBeUndefined();
  });

  it('maps a fully-specified nclc into config.colorSpace exactly once per field', () => {
    const colr = box('colr', cat(str('nclc'), be16(1), be16(1), be16(1)));
    const pasp = box('pasp', cat(be32(4), be32(3)));
    const movie = movieWith([videoTrakWith(cat(colr, pasp))]);
    const v = movie.tracks[0];
    expect(v?.colorSpace).toEqual({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' });
    expect((v?.config as VideoDecoderConfig).colorSpace).toEqual({
      primaries: 'bt709',
      transfer: 'bt709',
      matrix: 'bt709',
    });
    expect(v?.pasp).toEqual({ hSpacing: 4, vSpacing: 3 });
  });

  it('nclx full_range bit maps to colorSpace.fullRange (set and unset)', () => {
    for (const [rangeByte, expected] of [
      [0x80, true],
      [0x00, false],
    ] as const) {
      const colr = box('colr', cat(str('nclx'), be16(9), be16(16), be16(9), [rangeByte]));
      const movie = movieWith([videoTrakWith(colr)]);
      const v = movie.tracks[0];
      expect(v?.colr).toEqual({
        colourType: 'nclx',
        primaries: 9,
        transfer: 16,
        matrix: 9,
        fullRange: expected,
      });
      expect(v?.colorSpace).toEqual({
        primaries: 'bt2020',
        transfer: 'pq',
        matrix: 'bt2020-ncl',
        fullRange: expected,
      });
    }
  });
});

describe('parseMovie — non-media traks are never dropped, however malformed', () => {
  it('a data trak with a handler but no minf/stbl still surfaces (codec falls back to empty)', () => {
    const dataTrak = box(
      'trak',
      cat(
        tkhd0(7),
        box(
          'mdia',
          cat(
            full('mdhd', 0, cat(zeros(8), be32(1000), be32(500), zeros(4))),
            full('hdlr', 0, cat(zeros(4), str('meta'), zeros(12))),
          ),
        ),
      ),
    );
    const movie = movieWith([videoTrakWith([]), dataTrak]);
    expect(movie.otherTracks).toEqual([
      {
        id: 7,
        handler: 'meta',
        codec: '',
        timescale: 1000,
        durationSec: 0.5,
        sampleCount: 0,
        trakIndex: 1,
      },
    ]);
  });

  it('a trak with no mdia at all still surfaces with the tkhd id (never dropped, never throws)', () => {
    const bareTrak = box('trak', tkhd0(9));
    const movie = movieWith([videoTrakWith([]), bareTrak]);
    expect(movie.otherTracks).toEqual([
      { id: 9, handler: '', codec: '', timescale: 0, durationSec: 0, sampleCount: 0, trakIndex: 1 },
    ]);
  });

  it('a moov whose only trak is non-media still raises the no-decodable-tracks demux error', () => {
    const textOnly = box(
      'trak',
      cat(tkhd0(1), mdiaFor('text', full('stsd', 0, cat(be32(1), box('tx3g', zeros(8)))))),
    );
    expect(() => movieWith([textOnly])).toThrowError(/no decodable tracks/);
  });

  it('AV traks keep strict structure errors (a vide trak without stbl still fails the parse)', () => {
    const brokenVideo = box(
      'trak',
      cat(
        tkhd0(1),
        box(
          'mdia',
          cat(
            full('mdhd', 0, cat(zeros(8), be32(600), be32(600), zeros(4))),
            full('hdlr', 0, cat(zeros(4), str('vide'), zeros(12))),
          ),
        ),
      ),
    );
    expect(() => movieWith([brokenVideo])).toThrowError(MediaError);
  });
});

// ====== Real-.mov regressions the crafted moovBox (positive ctts, no edit) could not surface ======
//
// Both defects were found on the fair harness's real QuickTime files and are pinned here against
// ffprobe 8.0 truth (recipes: ffmpeg-authored .mov variants of h264_1080p_5s / huge_h264_1080p_600s):
//   • A *version-0* `ctts` with genuinely-negative composition offsets (real B-frame reorder). Read as
//     unsigned, −40 ticks became 4294967256, exploding the PTS and breaking decode-seek frame selection.
//     ffmpeg's own mov demuxer reads these signed; so must we (ADR-185 addendum).
//   • An edit list presenting fewer seconds than the media track spans. ffprobe reports the
//     edit-*presentation* duration as the stream duration, while avg_frame_rate stays frames ÷ media
//     span. The parser exposes both: `edit.durationSec` (presentation) and `durationSec`/`fps` (media),
//     so probe can report the ffprobe-faithful stream duration without perturbing lossless round-trip.

/** A minimal avc1 visual sample entry (4×4, avcC 0x6400xx) for a custom sample table. */
function avc1SampleEntry(): number[] {
  const avcC = box('avcC', [1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x00]);
  return box('avc1', cat(zeros(6), be16(1), zeros(16), be16(4), be16(4), zeros(50), avcC));
}

describe('parseMovie — version-0 ctts negative composition offsets (real .mov B-frame reorder)', () => {
  it('reads a version-0 ctts signed, so −40 ticks is −40 (not 4294967256) and PTS stays sane', () => {
    // ctts v0, 3 entries: +0, +40, −40 (the −40 stored two's-complement, exactly as ffmpeg writes it).
    const ctts = full(
      'ctts',
      0,
      cat(be32(3), be32(1), be32(0), be32(1), be32(40), be32(1), be32(-40 >>> 0)),
    );
    const trak = box(
      'trak',
      cat(
        tkhd0(1),
        mdiaFor(
          'vide',
          cat(
            full('stsd', 0, cat(be32(1), avc1SampleEntry())),
            full('stts', 0, cat(be32(1), be32(3), be32(400))),
            ctts,
            full('stsz', 0, cat(be32(0), be32(3), be32(5), be32(6), be32(7))),
            full('stsc', 0, cat(be32(1), be32(1), be32(3), be32(1))),
            full('stco', 0, cat(be32(1), be32(1000))),
          ),
        ),
      ),
    );
    const movie = movieWith([trak]);
    const v = movie.tracks[0];
    expect(v).toBeDefined();
    if (!v) return;

    // The negative offset survives as a small signed value (the whole point — 4294967256 would be a bug).
    expect(v.samples.compositionOffsets).toEqual([
      { count: 1, offset: 0 },
      { count: 1, offset: 40 },
      { count: 1, offset: -40 },
    ]);

    // End to end (mdhd timescale 600): dts 0/400/800 ticks, ctts 0/+40/−40 → PTS 0/440/760 ticks. The
    // third sample's PTS lands at 1_266_667 µs; the pre-fix unsigned read would have made it ~7.16e12 µs.
    const s = buildSamples(v);
    expect(s.map((x) => x.ptsUs)).toEqual([0, 733_333, 1_266_667]);
    expect(s.map((x) => x.dtsUs)).toEqual([0, 666_667, 1_333_333]);
  });
});

describe('parseMovie — edit-list presentation duration vs media duration (ffprobe stream duration)', () => {
  it('exposes edit.durationSec (presentation) while durationSec/fps stay on the media span', () => {
    // Media track spans 3 s (mdhd 1800/600) but the edit presents only 2 s of it, starting 1 s in — the
    // structural shape of the real 01.mov (9.4667 s media, 6.4667 s presentation). movie timescale = 600.
    const edts = box(
      'edts',
      full('elst', 0, cat(be32(1), be32(1200), be32(600), be16(1), be16(0))),
    );
    const trak = box(
      'trak',
      cat(
        tkhd0(1),
        edts,
        box(
          'mdia',
          cat(
            full('mdhd', 0, cat(zeros(8), be32(600), be32(1800), zeros(4))),
            full('hdlr', 0, cat(zeros(4), str('vide'), zeros(12))),
            box(
              'minf',
              box(
                'stbl',
                cat(
                  full('stsd', 0, cat(be32(1), avc1SampleEntry())),
                  full('stts', 0, cat(be32(1), be32(30), be32(60))), // 30 samples × 60 ticks = 1800 = 3 s
                  full('stsz', 0, cat(be32(5), be32(30))), // constant size, 30 samples
                  full('stsc', 0, cat(be32(1), be32(1), be32(30), be32(1))),
                  full('stco', 0, cat(be32(1), be32(1000))),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    const movie = movieWith([trak]);
    const v = movie.tracks[0];
    expect(v).toBeDefined();
    if (!v) return;

    // durationSec stays the raw media span (mdhd) — the value lossless remux round-trips and fps uses.
    expect(v.durationSec).toBe(3);
    // fps = frames ÷ media span (== ffprobe avg_frame_rate), never inflated by the shorter presentation.
    expect(v.fps).toBe(10);
    // edit.durationSec is the presentation duration ffprobe reports as the *stream* duration (segment
    // duration ÷ movie timescale = 1200/600); mediaTimeTicks is the 1 s leading skip.
    expect(v.edit).toEqual({ mediaTimeTicks: 600, durationSec: 2 });
  });
});
