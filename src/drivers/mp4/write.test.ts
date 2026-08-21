import { describe, expect, it } from 'vitest';
import { MediaError } from '../../contracts/errors.ts';
import { readMovie } from './mp4-driver.ts';
import { buildSampleData } from './samples.ts';
import { type MuxTrackInput, writeMp4, writeSparseMp4 } from './write.ts';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

function ftypBrands(bytes: Uint8Array): string[] {
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  expect(String.fromCharCode(...bytes.subarray(4, 8))).toBe('ftyp');
  const brands: string[] = [];
  for (let off = 16; off + 4 <= size; off += 4) {
    brands.push(String.fromCharCode(...bytes.subarray(off, off + 4)));
  }
  return brands;
}

// Encode-path tracks: no codecPrivate, so the muxer synthesizes avcC/esds from `description`.
const video: MuxTrackInput = {
  mediaType: 'video',
  sampleEntryType: 'avc1',
  timescale: 600,
  description: new Uint8Array([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x00]),
  width: 4,
  height: 4,
  samples: [
    { data: new Uint8Array([1, 2, 3]), durationTicks: 300, cttsTicks: 0, keyframe: true },
    { data: new Uint8Array([4, 5]), durationTicks: 300, cttsTicks: 300, keyframe: false },
  ],
};
const audio: MuxTrackInput = {
  mediaType: 'audio',
  sampleEntryType: 'mp4a',
  timescale: 48000,
  // AAC-LC, 48 kHz, stereo. Keep the authoritative ASC coherent with the outer sample-entry geometry;
  // stale-entry override behavior is covered separately by the parser/probe matrix.
  description: new Uint8Array([0x11, 0x90]),
  sampleRate: 48000,
  channels: 2,
  samples: [{ data: new Uint8Array([9]), durationTicks: 1024, cttsTicks: 0, keyframe: true }],
};

describe('writeMp4 — encode path (synthesizes avcC/esds from description)', () => {
  it('rejects sparse extents and offsets outside uint64 before touching the target', () => {
    let targetCalls = 0;
    const target = {
      setSize(): void {
        targetCalls++;
      },
      write(): void {
        targetCalls++;
      },
    };
    const uint64Overflow = 0x1_0000_0000_0000_0000n;

    expect(() =>
      writeSparseMp4([video], target, {
        fileSize: uint64Overflow,
        sampleOffsets: [[4_096n, 8_192n]],
      }),
    ).toThrow(/unsigned 64-bit box limit/);
    expect(() =>
      writeSparseMp4([video], target, {
        fileSize: 0xffff_ffff_ffff_ffffn,
        sampleOffsets: [[4_096n, uint64Overflow]],
      }),
    ).toThrow(/unsigned 64-bit bigint/);
    expect(targetCalls).toBe(0);
  });

  it('faststart muxes video+audio that re-parse to the right codecs, with ctts + stss', async () => {
    const movie = await readMovie(ra(writeMp4([video, audio])));
    expect(movie.tracks).toHaveLength(2);
    const v = movie.tracks.find((t) => t.mediaType === 'video');
    const a = movie.tracks.find((t) => t.mediaType === 'audio');
    expect(v?.codec).toBe('avc1.42C01E');
    expect(v?.samples.compositionOffsets.counts.length).toBeGreaterThan(0); // ctts written
    expect([...(v?.samples.syncSamples ?? [])]).toEqual([1]); // stss written (sample 2 is not a keyframe)
    expect(a?.codec).toBe('mp4a.40.2');
    expect(a?.sampleRate).toBe(48000);
    expect(a?.channels).toBe(2);
  });

  it('non-faststart layout (mdat before moov) also re-parses', async () => {
    const movie = await readMovie(ra(writeMp4([video], { faststart: false })));
    expect(movie.tracks[0]?.codec).toBe('avc1.42C01E');
  });

  it.each([
    {
      colourType: 'nclc' as const,
      colr: { colourType: 'nclc' as const, primaries: 1, transfer: 1, matrix: 1 },
    },
    {
      colourType: 'nclx' as const,
      colr: {
        colourType: 'nclx' as const,
        primaries: 9,
        transfer: 16,
        matrix: 9,
        fullRange: true,
      },
    },
  ])('round-trips $colourType color, pixel aspect, and signed clean aperture', async ({ colr }) => {
    const sideDataVideo: MuxTrackInput = {
      ...video,
      colr,
      pasp: { hSpacing: 4, vSpacing: 3 },
      clap: {
        cleanApertureWidthN: 15,
        cleanApertureWidthD: 2,
        cleanApertureHeightN: 7,
        cleanApertureHeightD: 1,
        horizOffN: -1,
        horizOffD: 2,
        vertOffN: 3,
        vertOffD: 4,
      },
    };
    const reparsed = (await readMovie(ra(writeMp4([sideDataVideo])))).tracks[0];
    expect(reparsed?.colr).toEqual(colr);
    expect(reparsed?.pasp).toEqual(sideDataVideo.pasp);
    expect(reparsed?.clap).toEqual(sideDataVideo.clap);
  });

  it('advertises compatible codec brands from the actual video sample entries', () => {
    const { description: _description, ...videoBase } = video;
    const hevc: MuxTrackInput = {
      ...videoBase,
      sampleEntryType: 'hvc1',
      codecPrivate: {
        boxType: 'hvcC',
        data: new Uint8Array([1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x78]),
      },
    };

    expect(ftypBrands(writeMp4([video, audio]))).toEqual(['isom', 'iso2', 'avc1', 'mp41']);
    expect(ftypBrands(writeMp4([hevc, audio]))).toEqual(['isom', 'iso2', 'hvc1', 'mp41']);
    expect(ftypBrands(writeMp4([audio]))).toEqual(['isom', 'iso2', 'mp41']);
  });

  it('honors explicit interleaved chunk layout when tracks share one mdat payload', async () => {
    const interleavedVideo: MuxTrackInput = {
      ...video,
      sampleChunks: [
        { firstSample: 0, sampleCount: 1, payloadOffset: 0 },
        { firstSample: 1, sampleCount: 1, payloadOffset: 4 },
      ],
    };
    const interleavedAudio: MuxTrackInput = {
      ...audio,
      sampleChunks: [{ firstSample: 0, sampleCount: 1, payloadOffset: 3 }],
    };

    const bytes = writeMp4([interleavedVideo, interleavedAudio]);
    const movie = await readMovie(ra(bytes));
    const reparsedVideo = movie.tracks.find((track) => track.mediaType === 'video');
    const reparsedAudio = movie.tracks.find((track) => track.mediaType === 'audio');
    const videoSamples = reparsedVideo ? buildSampleData(reparsedVideo) : [];
    const audioSamples = reparsedAudio ? buildSampleData(reparsedAudio) : [];

    expect(videoSamples.map((sample) => sample.size)).toEqual([3, 2]);
    expect(audioSamples.map((sample) => sample.size)).toEqual([1]);
    expect(videoSamples[0]?.offset).toBeLessThan(audioSamples[0]?.offset ?? 0);
    expect(audioSamples[0]?.offset).toBeLessThan(videoSamples[1]?.offset ?? 0);
    expect(
      Array.from(bytes.subarray(videoSamples[0]?.offset ?? 0, (videoSamples[0]?.offset ?? 0) + 3)),
    ).toEqual([1, 2, 3]);
    expect(
      Array.from(bytes.subarray(audioSamples[0]?.offset ?? 0, (audioSamples[0]?.offset ?? 0) + 1)),
    ).toEqual([9]);
    expect(
      Array.from(bytes.subarray(videoSamples[1]?.offset ?? 0, (videoSamples[1]?.offset ?? 0) + 2)),
    ).toEqual([4, 5]);
  });

  it.each([
    {
      label: 'one track missing chunks',
      tracks: [
        { ...video, sampleChunks: [{ firstSample: 0, sampleCount: 2, payloadOffset: 0 }] },
        audio,
      ],
      message: /must be provided for every track/,
    },
    {
      label: 'negative field',
      tracks: [
        { ...video, sampleChunks: [{ firstSample: -1, sampleCount: 2, payloadOffset: 0 }] },
        { ...audio, sampleChunks: [{ firstSample: 0, sampleCount: 1, payloadOffset: 5 }] },
      ],
      message: /invalid firstSample/,
    },
    {
      label: 'empty chunk',
      tracks: [
        { ...video, sampleChunks: [{ firstSample: 0, sampleCount: 0, payloadOffset: 0 }] },
        { ...audio, sampleChunks: [{ firstSample: 0, sampleCount: 1, payloadOffset: 0 }] },
      ],
      message: /empty chunk/,
    },
    {
      label: 'out-of-order samples',
      tracks: [
        { ...video, sampleChunks: [{ firstSample: 1, sampleCount: 1, payloadOffset: 0 }] },
        { ...audio, sampleChunks: [{ firstSample: 0, sampleCount: 1, payloadOffset: 2 }] },
      ],
      message: /cover track samples in order/,
    },
    {
      label: 'chunk extends past samples',
      tracks: [
        { ...video, sampleChunks: [{ firstSample: 0, sampleCount: 3, payloadOffset: 0 }] },
        { ...audio, sampleChunks: [{ firstSample: 0, sampleCount: 1, payloadOffset: 5 }] },
      ],
      message: /extends past the track sample table/,
    },
    {
      label: 'incomplete coverage',
      tracks: [
        { ...video, sampleChunks: [{ firstSample: 0, sampleCount: 1, payloadOffset: 0 }] },
        { ...audio, sampleChunks: [{ firstSample: 0, sampleCount: 1, payloadOffset: 3 }] },
      ],
      message: /does not cover every track sample/,
    },
    {
      label: 'mdat gap',
      tracks: [
        { ...video, sampleChunks: [{ firstSample: 0, sampleCount: 2, payloadOffset: 0 }] },
        { ...audio, sampleChunks: [{ firstSample: 0, sampleCount: 1, payloadOffset: 6 }] },
      ],
      message: /without gaps/,
    },
    {
      label: 'overlapping mdat chunks',
      tracks: [
        { ...video, sampleChunks: [{ firstSample: 0, sampleCount: 2, payloadOffset: 0 }] },
        { ...audio, sampleChunks: [{ firstSample: 0, sampleCount: 1, payloadOffset: 0 }] },
      ],
      message: /without gaps/,
    },
  ] satisfies ReadonlyArray<{
    readonly label: string;
    readonly tracks: readonly MuxTrackInput[];
    readonly message: RegExp;
  }>)('rejects explicit chunk layout with $label', ({ tracks, message }) => {
    expect(() => writeMp4([...tracks])).toThrow(message);
  });

  it.each([
    {
      label: 'constant IV on non-cbcs',
      encryption: {
        schemeType: 'cenc',
        kid: new Uint8Array(16),
        perSampleIvSize: 0,
        constantIv: new Uint8Array(16),
      },
      message: /default_constant_IV is valid only for cbcs/,
    },
    {
      label: 'cbcs constant IV with per-sample IV size',
      encryption: {
        schemeType: 'cbcs',
        kid: new Uint8Array(16),
        perSampleIvSize: 8,
        constantIv: new Uint8Array(16),
      },
      message: /requires perSampleIvSize 0/,
    },
    {
      label: 'missing cbcs constant IV',
      encryption: {
        schemeType: 'cbcs',
        kid: new Uint8Array(16),
        perSampleIvSize: 0,
      },
      message: /requires a cbcs default_constant_IV/,
    },
    {
      label: 'missing per-sample IVs',
      encryption: {
        schemeType: 'cenc',
        kid: new Uint8Array(16),
        perSampleIvSize: 8,
      },
      message: /requires one IV per sample/,
    },
    {
      label: 'wrong IV count',
      encryption: {
        schemeType: 'cenc',
        kid: new Uint8Array(16),
        perSampleIvSize: 8,
        ivs: [new Uint8Array(8)],
      },
      message: /IV count 1 does not match sample count 2/,
    },
    {
      label: 'wrong IV length',
      encryption: {
        schemeType: 'cenc',
        kid: new Uint8Array(16),
        perSampleIvSize: 8,
        ivs: [new Uint8Array(8), new Uint8Array(16)],
      },
      message: /IV length 16 does not match perSampleIvSize 8/,
    },
  ] satisfies ReadonlyArray<{
    readonly label: string;
    readonly encryption: NonNullable<MuxTrackInput['encryption']>;
    readonly message: RegExp;
  }>)('rejects invalid encryption metadata with $label', ({ encryption, message }) => {
    expect(() => writeMp4([{ ...video, encryption }])).toThrow(message);
  });

  /**
   * The version-0 `elst` `segment_duration` bound and the movie-header duration bound are NOT
   * independent, so they cannot be provoked separately. `trackMovieDurationTicks` branches on exactly
   * the condition `editMovieTicks` branches on and returns `segmentDuration + leadingEmptyDuration`,
   * and a leading empty edit is never negative — so `segmentDuration > 0xffffffff` implies
   * `movieDuration > 0xffffffff`. `moov` writes `mvhd` before any `trak`, so the movie-header guard
   * always fires first and the `segment_duration` branch is unreachable for well-formed input. These
   * two tests assert that ordering deliberately rather than pretending the guards are separable.
   */
  it('reports the movie-header bound first when an edit overflows both version-0 fields', () => {
    // 0x1_0000_0000 media ticks at 600 Hz is 7,158,278,827 movie ticks at 1 kHz — over u32 by ~2.9e9,
    // and the `elst` segment would be the same 7,158,278,827.
    expect(() =>
      writeMp4([{ ...video, edit: { durationTicks: 0x1_0000_0000, mediaTimeTicks: 0 } }]),
    ).toThrow(/mvhd duration/);
  });

  it('writes an edit landing exactly on the u32 maximum, and refuses one tick beyond', async () => {
    // A guard that rejected the legal maximum would be as wrong as one that wrapped, so pin both
    // sides with an edit list actually present. At the audio clock the edit's movie ticks ARE its
    // media ticks, so `segment_duration` is exactly 0xffffffff here.
    const atLimit: MuxTrackInput = {
      mediaType: 'audio',
      sampleEntryType: 'mp4a',
      timescale: 48_000,
      description: new Uint8Array([0x11, 0x90]),
      sampleRate: 48_000,
      channels: 2,
      mediaDurationTicks: 0xffff_ffff,
      edit: { mediaTimeTicks: 0, durationTicks: 0xffff_ffff },
      samples: [{ data: new Uint8Array([1]), durationTicks: 1, cttsTicks: 0, keyframe: true }],
    };
    const movie = await readMovie(ra(writeMp4([atLimit])));
    expect(movie.timescale).toBe(48_000);
    expect(movie.tracks[0]?.edit?.durationMovieTicks).toBe(0xffff_ffff);

    expect(() =>
      writeMp4([
        {
          ...atLimit,
          mediaDurationTicks: 0x1_0000_0000,
          edit: { mediaTimeTicks: 0, durationTicks: 0x1_0000_0000 },
        },
      ]),
    ).toThrow(/duration 4294967296 exceeds the version-0 32-bit field/);
  });

  it('rejects a version-0 edit list media_time overflow on its own', () => {
    // `media_time` is an i32 in the MEDIA clock, bounded by nothing else here: a 300-tick edit keeps
    // every duration field tiny, so this guard is genuinely reachable in isolation.
    expect(() =>
      writeMp4([{ ...video, edit: { durationTicks: 300, mediaTimeTicks: 0x8000_0000 } }]),
    ).toThrow(/media_time/);
  });
});

describe('the movie clock', () => {
  /** One audio track whose whole duration is a single long sample — lets a u32 boundary be reached. */
  function longAudio(timescale: number, durationTicks: number): MuxTrackInput {
    return {
      mediaType: 'audio',
      sampleEntryType: 'mp4a',
      timescale,
      description: new Uint8Array([0x11, 0x90]),
      sampleRate: timescale,
      channels: 2,
      samples: [{ data: new Uint8Array([1]), durationTicks, cttsTicks: 0, keyframe: true }],
    };
  }

  it('runs an audio-only movie at the audio rate so declared durations are exact', async () => {
    // 44 101 frames at 44.1 kHz is 1000.0226… ms: no millisecond clock can state it, and the legacy
    // 1 kHz movie clock declared 1000 ms, i.e. 44 100 frames — one frame short of the media.
    const bytes = writeMp4([longAudio(44_100, 44_101)]);
    const movie = await readMovie(ra(bytes));
    expect(movie.timescale).toBe(44_100);
    expect(movie.durationSec).toBe(44_101 / 44_100);
    expect(Math.round(movie.durationSec * 44_100)).toBe(44_101);
  });

  it('keeps the millisecond clock when a movie is not audio-only or mixes audio rates', async () => {
    // Video present: the video clock has its own exactness requirement, so the rule does not apply.
    expect((await readMovie(ra(writeMp4([video, audio])))).timescale).toBe(1_000);
    // Two audio rates: whichever is adopted, the other is still rescaled — no clock is exact for both.
    const mixed = writeMp4([longAudio(48_000, 48_000), longAudio(44_100, 44_100)]);
    expect((await readMovie(ra(mixed))).timescale).toBe(1_000);
  });

  it('honors an explicitly pinned movie timescale over the audio rate', async () => {
    // A remux that preserves a source movie's edits depends on keeping that movie's own clock.
    const bytes = writeMp4([longAudio(48_000, 48_000)], { movieTimescale: 600 });
    expect((await readMovie(ra(bytes))).timescale).toBe(600);
  });

  // 0xffffffff ticks is ~24.9 h at 48 kHz, ~27.1 h at 44.1 kHz and ~149 h at 8 kHz. At the limit the
  // exact clock is kept; one tick past it, NO movie clock can help — `mdhd` is in the track clock —
  // so the write is a typed failure and never a wrapped duration (REQUIREMENTS §8.4).
  it.each([{ rate: 48_000 }, { rate: 44_100 }, { rate: 8_000 }])(
    'holds the exact clock at the u32 duration limit and refuses to truncate past it ($rate Hz)',
    async ({ rate }) => {
      const atLimit = await readMovie(ra(writeMp4([longAudio(rate, 0xffff_ffff)])));
      expect(atLimit.timescale).toBe(rate);
      expect(atLimit.durationSec).toBe(0xffff_ffff / rate);

      let thrown: unknown;
      try {
        writeMp4([longAudio(rate, 0x1_0000_0000)]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MediaError);
      expect((thrown as MediaError).message).toMatch(/mdhd duration 4294967296 exceeds/);
    },
  );

  it('falls back to the millisecond clock one tick past the limit rather than truncating', async () => {
    // The audio clock only loses range where the movie timeline is LONGER than the media — here a
    // leading empty edit delays a 1 s track far enough that 48 kHz movie ticks overflow u32 while
    // millisecond ticks still fit. The coarse clock is chosen; nothing is written wrapped.
    const track: MuxTrackInput = {
      ...longAudio(48_000, 48_000),
      edit: { mediaTimeTicks: 0, durationTicks: 48_000, leadingEmptyDurationTicks: 0xffff_ffff },
    };
    const movie = await readMovie(ra(writeMp4([track])));
    expect(movie.timescale).toBe(1_000);
    expect(movie.tracks[0]?.edit?.durationMovieTicks).toBe(1_000);
    // One tick less on the empty edit still fits the audio clock, so exactness is kept.
    const exact = await readMovie(
      ra(
        writeMp4([
          {
            ...track,
            edit: { ...track.edit, leadingEmptyDurationTicks: 0xffff_ffff - 48_000 },
          } as MuxTrackInput,
        ]),
      ),
    );
    expect(exact.timescale).toBe(48_000);
  });

  it('does not lose usable range by adopting the audio clock', () => {
    // The exact clock equals the track clock, so the movie duration IS the media duration and `mdhd`
    // binds at the same value. The legacy 1 kHz movie clock never bought reach: pinning it explicitly
    // fails at exactly the same input, which is why this change costs no headroom.
    expect(() => writeMp4([longAudio(48_000, 0x1_0000_0000)])).toThrow(/mdhd duration/);
    expect(() => writeMp4([longAudio(48_000, 0x1_0000_0000)], { movieTimescale: 1_000 })).toThrow(
      /mdhd duration/,
    );
  });
});
