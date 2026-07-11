import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fromBytes } from '../../sources/source.ts';
import { Mp4Driver } from './mp4-driver.ts';

const MEDIA_ROOT = fileURLToPath(
  new URL('../../../../media-test/fixtures/media/', import.meta.url),
);
const SIBLING_GAPLESS_ROOT = `${MEDIA_ROOT}scenarios/audio-dsp/edge_gapless_aac_decode/`;
const NATIVE_GAPLESS_ROOT = `${MEDIA_ROOT}native-gapless-aac/`;

interface RealAacCase {
  readonly name: string;
  readonly path: string;
  readonly sampleRate: number;
  readonly channels?: number;
  readonly allowedChannels?: readonly number[];
  readonly expectGapless: boolean;
}

const NATIVE_GAPLESS_CASES: readonly RealAacCase[] = readdirSync(NATIVE_GAPLESS_ROOT)
  .filter((file) => file.endsWith('.mp4'))
  .sort()
  .map((file) => ({
    name: `preserved native MP4 gapless AAC control ${file}`,
    path: `${NATIVE_GAPLESS_ROOT}${file}`,
    sampleRate: 44_100,
    channels: 2,
    expectGapless: true,
  }));

const PUBLIC_REAL_CASES: readonly RealAacCase[] = readdirSync(SIBLING_GAPLESS_ROOT)
  .filter((file) => file.endsWith('.mp4'))
  .sort()
  .map((file) => ({
    name: `public CC0 ordinary AAC control ${file}`,
    path: `${SIBLING_GAPLESS_ROOT}${file}`,
    sampleRate: 48_000,
    allowedChannels: [1, 2],
    expectGapless: false,
  }));

const REAL_AAC_CASES: readonly RealAacCase[] = [
  ...NATIVE_GAPLESS_CASES,
  ...PUBLIC_REAL_CASES,
  {
    name: 'ordinary real MP4 with explicit zero-padding edit, 48 kHz stereo AAC',
    path: fileURLToPath(
      new URL('../../../fixtures/media/obs-remux-variable-aac.mp4', import.meta.url),
    ),
    sampleRate: 48_000,
    channels: 2,
    expectGapless: true,
  },
  {
    name: 'ordinary real MP4 without an edit-list gapless window, 22.05 kHz mono AAC',
    path: fileURLToPath(new URL('../../../fixtures/media/movie_5.mp4', import.meta.url)),
    sampleRate: 22_050,
    channels: 1,
    expectGapless: false,
  },
];

describe('MP4 AAC gapless metadata — exact real corpus matrix', () => {
  for (const testCase of REAL_AAC_CASES) {
    it(`${testCase.name}: matches independent stream traits`, async () => {
      const bytes = new Uint8Array(await readFile(testCase.path));
      const demuxer = await Mp4Driver.demux(fromBytes(bytes, { mime: 'audio/mp4' }));
      try {
        const audio = demuxer.tracks.find((track) => track.mediaType === 'audio');
        expect(audio?.codec).toMatch(/^mp4a\.40\./);
        expect(audio?.config).toMatchObject({ sampleRate: testCase.sampleRate });
        if (testCase.channels !== undefined) {
          expect(audio?.config).toMatchObject({ numberOfChannels: testCase.channels });
        }
        if (testCase.allowedChannels !== undefined) {
          expect(testCase.allowedChannels).toContain(
            (audio?.config as AudioDecoderConfig | undefined)?.numberOfChannels,
          );
        }
        expect(audio?.gapless !== undefined).toBe(testCase.expectGapless);
      } finally {
        await demuxer.close();
      }
    });
  }
});
