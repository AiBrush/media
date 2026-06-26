import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { MediaInfo } from '../../api/types.ts';
import { fixtureSource, loadGoldenMetadata } from '../../test-support/corpus.ts';
import { Mp4Module } from './mp4-driver.ts';

const MP4S = [
  '2x2-green.mp4',
  'movie_5.mp4',
  'test.mp4',
  'h264.mp4',
  'four-colors.mp4',
  'av1.mp4',
  'h265.mp4',
  'bear-hevc-10bit-hdr10.mp4',
  'bear-4k-hevc.mp4',
];

const HEVC_MP4S = [
  { id: 'h265.mp4', codec: 'hvc1.1.6.L60.90', width: 320, height: 240, bitDepth: 8 },
  { id: 'bear-4k-hevc.mp4', codec: 'hev1.1.6.L150.90', width: 3840, height: 2160, bitDepth: 8 },
  {
    id: 'bear-hevc-10bit-hdr10.mp4',
    codec: 'hev1.2.4.L93.90',
    width: 1280,
    height: 720,
    bitDepth: 10,
  },
] as const;

describe('golden-metadata oracle (probe, mp4)', () => {
  it.each(MP4S)('%s probe matches the committed golden exactly', async (id) => {
    const info = await createMedia()
      .use(Mp4Module)
      .probe(await fixtureSource(id));
    expect(info).toEqual(await loadGoldenMetadata(id));
  });

  it.each(HEVC_MP4S)(
    '$id HEVC fixture exposes the exact hvc1/hev1 codec string ($bitDepth-bit)',
    async ({ id, codec, width, height }) => {
      const info = await createMedia()
        .use(Mp4Module)
        .probe(await fixtureSource(id));
      const videoTrack = info.tracks.find((track) => track.type === 'video');
      expect(videoTrack).toMatchObject({ codec, width, height });
      expect(info).toEqual(await loadGoldenMetadata(id));
    },
  );

  it('the oracle can fail — it rejects tampered metadata (anti-cheat, doc 11 §5)', async () => {
    const golden = (await loadGoldenMetadata('2x2-green.mp4')) as MediaInfo;
    const tampered = structuredClone(golden);
    const track = tampered.tracks[0];
    if (track) track.width = 999;

    const info = await createMedia()
      .use(Mp4Module)
      .probe(await fixtureSource('2x2-green.mp4'));
    expect(info).not.toEqual(tampered); // a wrong golden would be rejected
    expect(info).toEqual(golden); // …and the true golden still matches
  });
});
