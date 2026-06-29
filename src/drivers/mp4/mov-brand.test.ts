/**
 * The `ftyp` major-brand the MP4 writer emits per target container. Both `mp4` and `mov` targets now use
 * the ISO-compatible brand set because the authored byte layout is ISO-BMFF; WebKit can raise a decode
 * error when the same layout is advertised as stricter QuickTime (`qt  `). The requested target still
 * threads through `WriteOptions.brand`, but branding stays playback-safe.
 */

import { describe, expect, it } from 'vitest';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { Mp4Driver, readMovie } from './mp4-driver.ts';
import { type ContainerBrand, type MuxTrackInput, writeMp4 } from './write.ts';

const SAMPLE_TRACK: MuxTrackInput = {
  mediaType: 'audio',
  sampleEntryType: 'mp4a',
  timescale: 48000,
  samples: [
    { data: new Uint8Array([1, 2, 3, 4]), durationTicks: 1024, cttsTicks: 0, keyframe: true },
  ],
};

/** The four `ftyp` major-brand bytes (payload offset 0 → file offset 8). */
function majorBrand(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
}

describe('writeMp4 ftyp major-brand by target container', () => {
  it.each<[ContainerBrand, string]>([
    ['mp4', 'isom'],
    ['mov', 'isom'],
  ])('brand=%s → major_brand %j', (brand, expected) => {
    expect(majorBrand(writeMp4([SAMPLE_TRACK], { brand }))).toBe(expected);
  });

  it('defaults to the ISO mp4 brand when no brand is given (mp4 targets unchanged)', () => {
    expect(majorBrand(writeMp4([SAMPLE_TRACK]))).toBe('isom');
  });

  it('the target brand option round-trips as a playback-safe ISO brand', async () => {
    for (const [brand, expected] of [
      ['mp4', 'isom'],
      ['mov', 'isom'],
    ] as const) {
      const out = writeMp4([SAMPLE_TRACK], { brand });
      const movie = await readMovie({
        read: (o, l) => Promise.resolve(out.subarray(o, o + l)),
        size: out.byteLength,
      });
      expect(movie.brand).toBe(expected);
    }
  });
});

describe('remux to mov vs mp4 — the stream-copy threads the brand from the target token', () => {
  async function remuxBrand(container: string): Promise<string> {
    const src = fromBytes(await loadFixture('movie_5.mp4'), { mime: 'video/mp4' });
    if (!Mp4Driver.streamCopy) throw new Error('no streamCopy');
    const stream = await Mp4Driver.streamCopy(src, { container });
    const reader = stream.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    return majorBrand(value ?? new Uint8Array());
  }

  it("a 'mov' remux keeps the ISO brand set for WebKit playback compatibility", async () => {
    expect(await remuxBrand('mov')).toBe('isom');
    expect(await remuxBrand('mp4')).toBe('isom');
  });
});
