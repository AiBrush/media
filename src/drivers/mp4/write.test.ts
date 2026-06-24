import { describe, expect, it } from 'vitest';
import { readMovie } from './mp4-driver.ts';
import { type MuxTrackInput, writeMp4 } from './write.ts';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

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
});
