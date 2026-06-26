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
/** Walk the top-level boxes and return their fourcc types in file order (ftyp, moov, mdat, moof, …). */
function topLevelBoxTypes(file: Uint8Array): string[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const types: string[] = [];
  let off = 0;
  while (off + 8 <= file.byteLength) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(...file.subarray(off + 4, off + 8));
    if (size === 1) size = Number(dv.getBigUint64(off + 8)); // 64-bit largesize
    if (size <= 0) break;
    types.push(type);
    off += size;
  }
  return types;
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

  it('faststart:false lays mdat BEFORE moov (progressive), still re-parsing losslessly', async () => {
    const out = await bytesOf(
      await media().remux(await fixtureSource('movie_5.mp4'), { to: 'mp4', faststart: false }),
    );
    // Top-level box order is ftyp, mdat, moov (the progressive/non-streamable layout the oracle checks).
    const order = topLevelBoxTypes(out);
    expect(order.indexOf('mdat')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('mdat')).toBeLessThan(order.indexOf('moov'));
    // …and it still round-trips to the same tracks (the byte layout differs, the content does not).
    const orig = await readMovie(ra(await loadFixture('movie_5.mp4')));
    const re = await readMovie(ra(out));
    expect(re.tracks.length).toBe(orig.tracks.length);
    for (let i = 0; i < orig.tracks.length; i++) {
      const reTrack = re.tracks[i];
      const origTrack = orig.tracks[i];
      if (!reTrack || !origTrack) {
        throw new Error(`missing track ${i} after faststart remux round-trip`);
      }
      expect(buildSampleData(reTrack).map(strip)).toEqual(buildSampleData(origTrack).map(strip));
    }
  });

  it('fragmented:true emits an init segment + moof media segments (CMAF), re-parsing to the same tracks', async () => {
    const out = await bytesOf(
      await media().remux(await fixtureSource('movie_5.mp4'), { to: 'mp4', fragmented: true }),
    );
    // A fragmented file carries at least one `moof` (media segment) — never present in a plain MP4 — and
    // its `moov` (the init segment) is sample-less (empty `stbl`; real timing lives in the fragments).
    const order = topLevelBoxTypes(out);
    expect(order.filter((t) => t === 'moof').length).toBeGreaterThan(0);
    expect(order.indexOf('moov')).toBeLessThan(order.indexOf('moof')); // init segment precedes media
    // The fragment-aware demux recovers the same track count + a faithful duration from moof/sidx.
    const orig = await readMovie(ra(await loadFixture('movie_5.mp4')));
    const re = await readMovie(ra(out));
    expect(re.tracks.length).toBe(orig.tracks.length);
    expect(re.durationSec).toBeCloseTo(orig.durationSec, 1);
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
