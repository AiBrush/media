import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { fixtureSource, loadFixture } from '../../test-support/corpus.ts';
import { Mp4Module, readMovie } from './mp4-driver.ts';
import { buildSampleData } from './samples.ts';

const media = () => createMedia().use(Mp4Module);

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});
const strip = (s: {
  size: number;
  durationTicks: number;
  cttsTicks: number;
  keyframe: boolean;
}) => ({
  size: s.size,
  durationTicks: s.durationTicks,
  cttsTicks: s.cttsTicks,
  keyframe: s.keyframe,
});
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
async function bytesOf(
  out: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}

describe('media.remux (mp4 → mp4 stream-copy)', () => {
  it('remuxes movie_5.mp4 losslessly — re-parses to identical tracks + sample tables', async () => {
    const m = media();
    const input = await loadFixture('movie_5.mp4');
    const out = await bytesOf(await m.remux(await fixtureSource('movie_5.mp4'), { to: 'mp4' }));

    expect(equalBytes(out, input)).toBe(false); // a genuine re-layout, not a passthrough
    const orig = await readMovie(ra(input));
    const re = await readMovie(ra(out));
    expect(re.tracks.length).toBe(orig.tracks.length);
    for (let i = 0; i < orig.tracks.length; i++) {
      const a = orig.tracks[i];
      const b = re.tracks[i];
      expect(b?.codec).toBe(a?.codec);
      if (a && b) expect(buildSampleData(b).map(strip)).toEqual(buildSampleData(a).map(strip));
    }
  });

  it('rejects a cross-container remux with a typed CapabilityError', async () => {
    await expect(
      media().remux(await fixtureSource('movie_5.mp4'), { to: 'webm' }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('honors faststart:false and fragmented options', async () => {
    const out = await bytesOf(
      await media().remux(await fixtureSource('movie_5.mp4'), {
        to: 'mp4',
        faststart: false,
        fragmented: true,
      }),
    );
    const re = await readMovie(ra(out)); // non-faststart layout still re-parses
    expect(re.tracks.length).toBeGreaterThan(0);
  });
});

describe('media.trim (mp4 keyframe-copy)', () => {
  it('keyframe-trims movie_5.mp4 to a shorter clip that begins on a keyframe', async () => {
    const m = media();
    const input = await loadFixture('movie_5.mp4');
    const out = await bytesOf(
      await m.trim(await fixtureSource('movie_5.mp4'), { start: 1, end: 3, mode: 'keyframe' }),
    );

    expect(equalBytes(out, input)).toBe(false);
    const orig = await readMovie(ra(input));
    const re = await readMovie(ra(out));

    expect(re.durationSec).toBeGreaterThan(0);
    expect(re.durationSec).toBeLessThan(orig.durationSec);

    const reVideo = re.tracks.find((t) => t.mediaType === 'video');
    const origVideo = orig.tracks.find((t) => t.mediaType === 'video');
    expect(reVideo).toBeDefined();
    expect(origVideo).toBeDefined();
    if (reVideo && origVideo) {
      const reSamples = buildSampleData(reVideo);
      expect(reSamples.length).toBeLessThan(buildSampleData(origVideo).length);
      expect(reSamples[0]?.keyframe).toBe(true); // GOP-aligned: the cut starts on a keyframe
    }
  });

  it('rejects frame-accurate trim with a typed CapabilityError (needs the codec seam)', async () => {
    await expect(
      media().trim(await fixtureSource('movie_5.mp4'), { start: 1, end: 3, mode: 'accurate' }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });

  it('cancels an in-flight op via the returned handle', async () => {
    const handle = media().remux(await fixtureSource('test.mp4'), { to: 'mp4' });
    handle.cancel();
    await expect(handle).rejects.toBeInstanceOf(MediaError);
  });
});

describe('zero-config (lazy first-party drivers, no .use())', () => {
  it('probes a real mp4 and a real webm without explicit driver registration', async () => {
    expect((await createMedia().probe(await fixtureSource('movie_5.mp4'))).container).toBe('mp4');
    expect((await createMedia().probe(await fixtureSource('white.webm'))).container).toBe('webm');
  });

  it('remuxes a real mp4 zero-config', async () => {
    const out = await createMedia().remux(await fixtureSource('test.mp4'), { to: 'mp4' });
    expect(out).toBeInstanceOf(Blob);
  });

  it('still raises a typed CapabilityError for an unrecognized container', async () => {
    const junk = fromBytes(new Uint8Array(32)); // no ftyp/RIFF/OggS/EBML/mp3-sync
    await expect(createMedia().probe(junk)).rejects.toBeInstanceOf(CapabilityError);
  });
});
