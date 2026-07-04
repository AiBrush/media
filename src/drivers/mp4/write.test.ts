import { describe, expect, it } from 'vitest';
import { readMovie } from './mp4-driver.ts';
import { buildSampleData } from './samples.ts';
import { type MuxTrackInput, writeMp4 } from './write.ts';

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
  description: new Uint8Array([0x12, 0x10]),
  sampleRate: 48000,
  channels: 2,
  samples: [{ data: new Uint8Array([9]), durationTicks: 1024, cttsTicks: 0, keyframe: true }],
};

describe('writeMp4 — encode path (synthesizes avcC/esds from description)', () => {
  it('faststart muxes video+audio that re-parse to the right codecs, with ctts + stss', async () => {
    const movie = await readMovie(ra(writeMp4([video, audio])));
    expect(movie.tracks).toHaveLength(2);
    const v = movie.tracks.find((t) => t.mediaType === 'video');
    const a = movie.tracks.find((t) => t.mediaType === 'audio');
    expect(v?.codec).toBe('avc1.42C01E');
    expect(v?.samples.compositionOffsets.length).toBeGreaterThan(0); // ctts written
    expect(v?.samples.syncSamples).toEqual([1]); // stss written (sample 2 is not a keyframe)
    expect(a?.codec).toBe('mp4a.40.2');
    expect(a?.sampleRate).toBe(48000);
    expect(a?.channels).toBe(2);
  });

  it('non-faststart layout (mdat before moov) also re-parses', async () => {
    const movie = await readMovie(ra(writeMp4([video], { faststart: false })));
    expect(movie.tracks[0]?.codec).toBe('avc1.42C01E');
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

  it.each([
    {
      label: 'segment duration',
      track: { ...video, edit: { durationTicks: 0x1_0000_0000, mediaTimeTicks: 0 } },
      message: /segment_duration/,
    },
    {
      label: 'media time',
      track: { ...video, edit: { durationTicks: 300, mediaTimeTicks: 0x8000_0000 } },
      message: /media_time/,
    },
  ] satisfies ReadonlyArray<{
    readonly label: string;
    readonly track: MuxTrackInput;
    readonly message: RegExp;
  }>)('rejects version-0 edit list overflow for $label', ({ track, message }) => {
    expect(() => writeMp4([track])).toThrow(message);
  });
});
