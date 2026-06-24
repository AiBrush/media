import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fixturesByContainer, loadFixture } from '../test-support/corpus.ts';
import { type DspGolden, dspGoldenDigests } from '../test-support/dsp-goldens.ts';

const GOLDEN_DIR = new URL('../../fixtures/golden/dsp/', import.meta.url).pathname;
const wavFixtures = await fixturesByContainer('wav');

describe('audio-dsp baked goldens (decoded-audio-pcm regression pin)', () => {
  it('has a committed golden for every WAV fixture', () => {
    expect(wavFixtures.length).toBeGreaterThan(0);
  });

  for (const entry of wavFixtures) {
    it(`${entry.id}: recomputed PCM digests match the committed golden`, async () => {
      const golden = JSON.parse(
        await readFile(`${GOLDEN_DIR}${entry.id}.json`, 'utf8'),
      ) as DspGolden;
      const actual = await dspGoldenDigests(await loadFixture(entry.id));
      expect(actual).toEqual(golden);
    });
  }
});
