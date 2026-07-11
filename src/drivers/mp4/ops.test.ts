import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource, StreamCopyOptions } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { fromBytes } from '../../sources/source.ts';
import { fixtureSource, loadFixture } from '../../test-support/corpus.ts';
import { materializeCompatibleMovToMp4Bytes } from './compatible-mov-rewrite.ts';
import { Mp4Module, muxTracksFromMovie, readMovie } from './mp4-driver.ts';
import type { Movie } from './parse.ts';
import { buildSampleData } from './samples.ts';
import { writeMp4 } from './write.ts';

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

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function fourccAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function writeFourcc(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
}

function writeU32At(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function kindedSource(kind: string): ByteSource {
  return {
    kind,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start: (controller) => controller.close(),
      }),
  } as ByteSource & { readonly kind: string };
}

async function quickTimeBrandedCompatibleMov(fixture: string): Promise<Uint8Array> {
  const source = await loadFixture(fixture);
  const movie = await readMovie(ra(source));
  const mp4 = writeMp4(await muxTracksFromMovie(ra(source), movie));
  const out = mp4.slice();
  writeFourcc(out, 8, 'qt  ');
  writeFourcc(out, 16, 'qt  ');
  return out;
}

function withFirstChunkOffset(movie: Movie, offset: number): Movie {
  const trackIndex = movie.tracks.findIndex((track) => track.mediaType === 'video');
  if (trackIndex < 0) throw new Error('expected a video track');
  const track = movie.tracks[trackIndex];
  if (track === undefined) throw new Error('missing video track');
  const tracks = [...movie.tracks];
  tracks[trackIndex] = {
    ...track,
    samples: {
      ...track.samples,
      chunkOffsets: [offset, ...track.samples.chunkOffsets.slice(1)],
    },
  };
  return { ...movie, tracks };
}

function withUnmappedFirstTrack(movie: Movie): Movie {
  const trackIndex = movie.tracks.findIndex((track) => track.mediaType === 'video');
  if (trackIndex < 0) throw new Error('expected a video track');
  const track = movie.tracks[trackIndex];
  if (track === undefined) throw new Error('missing video track');
  const tracks = [...movie.tracks];
  tracks[trackIndex] = {
    ...track,
    samples: {
      ...track.samples,
      chunkOffsets: [],
      sampleToChunk: [],
    },
  };
  return { ...movie, tracks };
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

  it('MOV→MP4 compatible brand rewrite keeps sample bytes and offsets untouched', async () => {
    const input = await quickTimeBrandedCompatibleMov('movie_5.mp4');
    const out = await bytesOf(
      await media().remux(fromBytes(input, { mime: 'video/quicktime' }), { to: 'mp4' }),
    );
    const ftypSize = u32(input, 0);

    expect(fourccAt(input, 8)).toBe('qt  ');
    expect(fourccAt(out, 8)).toBe('isom');
    expect(fourccAt(out, 16)).toBe('mp42');
    expect(out.byteLength).toBe(input.byteLength);
    expect(out.subarray(ftypSize)).toEqual(input.subarray(ftypSize));
    expect(equalBytes(out, input)).toBe(false);

    const orig = await readMovie(ra(input));
    const re = await readMovie(ra(out));
    expect(re.tracks.length).toBe(orig.tracks.length);
    for (let i = 0; i < orig.tracks.length; i++) {
      const a = orig.tracks[i];
      const b = re.tracks[i];
      if (!a || !b) throw new Error(`missing track ${i} after compatible MOV->MP4 rewrite`);
      expect(b.codec).toBe(a.codec);
      expect(buildSampleData(b).map(strip)).toEqual(buildSampleData(a).map(strip));
    }
  });

  it('MOV→MP4 compatible brand rewrite rejects unsafe shortcut shapes before output', async () => {
    const input = await quickTimeBrandedCompatibleMov('movie_5.mp4');
    const movie = await readMovie(ra(input));
    const opts: StreamCopyOptions = { container: 'mp4', buffered: true };

    await expect(
      materializeCompatibleMovToMp4Bytes(
        kindedSource('bytes'),
        { read: ra(input).read },
        movie,
        opts,
      ),
    ).resolves.toBeUndefined();
    await expect(
      materializeCompatibleMovToMp4Bytes(kindedSource('bytes'), ra(input), movie, {
        ...opts,
        container: 'mov',
      }),
    ).resolves.toBeUndefined();
    await expect(
      materializeCompatibleMovToMp4Bytes(kindedSource('bytes'), ra(input), movie, {
        ...opts,
        trim: { startSec: 0, endSec: 1 },
      }),
    ).resolves.toBeUndefined();

    const wrongFirstBox = input.slice();
    writeFourcc(wrongFirstBox, 4, 'free');
    await expect(
      materializeCompatibleMovToMp4Bytes(kindedSource('bytes'), ra(wrongFirstBox), movie, opts),
    ).resolves.toBeUndefined();

    const wrongSecondBox = input.slice();
    writeFourcc(wrongSecondBox, u32(wrongSecondBox, 0) + 4, 'free');
    await expect(
      materializeCompatibleMovToMp4Bytes(kindedSource('bytes'), ra(wrongSecondBox), movie, opts),
    ).resolves.toBeUndefined();

    const tinyFtyp = input.slice();
    writeU32At(tinyFtyp, 0, 16);
    await expect(
      materializeCompatibleMovToMp4Bytes(kindedSource('bytes'), ra(tinyFtyp), movie, opts),
    ).resolves.toBeUndefined();

    const invalidTopBox = new Uint8Array(16);
    writeU32At(invalidTopBox, 0, 4);
    writeFourcc(invalidTopBox, 4, 'ftyp');
    await expect(
      materializeCompatibleMovToMp4Bytes(kindedSource('bytes'), ra(invalidTopBox), movie, opts),
    ).resolves.toBeUndefined();

    const zeroSizeFtyp = new Uint8Array(24);
    writeU32At(zeroSizeFtyp, 0, 0);
    writeFourcc(zeroSizeFtyp, 4, 'ftyp');
    await expect(
      materializeCompatibleMovToMp4Bytes(kindedSource('bytes'), ra(zeroSizeFtyp), movie, opts),
    ).resolves.toBeUndefined();

    const largeSizeFtyp = new Uint8Array(32);
    writeU32At(largeSizeFtyp, 0, 1);
    writeFourcc(largeSizeFtyp, 4, 'ftyp');
    writeU32At(largeSizeFtyp, 8, 0);
    writeU32At(largeSizeFtyp, 12, 24);
    writeFourcc(largeSizeFtyp, 24, 'free');
    await expect(
      materializeCompatibleMovToMp4Bytes(kindedSource('bytes'), ra(largeSizeFtyp), movie, opts),
    ).resolves.toBeUndefined();

    await expect(
      materializeCompatibleMovToMp4Bytes(
        kindedSource('bytes'),
        ra(input),
        withFirstChunkOffset(movie, input.byteLength + 1),
        opts,
      ),
    ).rejects.toBeInstanceOf(MediaError);

    await expect(
      materializeCompatibleMovToMp4Bytes(
        kindedSource('bytes'),
        ra(input),
        withUnmappedFirstTrack(movie),
        opts,
      ),
    ).rejects.toBeInstanceOf(MediaError);

    await expect(
      materializeCompatibleMovToMp4Bytes(
        kindedSource('bytes'),
        {
          size: input.byteLength,
          read: (offset, length) =>
            Promise.resolve(
              input.subarray(
                offset,
                offset + (offset === 0 && length === input.byteLength ? length - 1 : length),
              ),
            ),
        },
        movie,
        opts,
      ),
    ).rejects.toBeInstanceOf(MediaError);

    const urlBytes = input.slice();
    const urlOut = await materializeCompatibleMovToMp4Bytes(
      kindedSource('url'),
      ra(urlBytes),
      movie,
      opts,
    );
    expect(urlOut?.buffer).toBe(urlBytes.buffer);
    expect(fourccAt(urlBytes, 8)).toBe('isom');
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

  it('remuxes a FRAGMENTED-input MP4 (empty moov, moof/traf samples) — recovers every sample, not a "no samples" reject', async () => {
    // A fragmented/CMAF MP4 keeps its per-sample timing in `moof`/`traf`/`trun`, so its `moov` sample
    // tables are empty and the progressive sample builder yields nothing. Stream-copy must recover those
    // samples (ADR-186), never reject the file with "track N has no samples to stream-copy" — the
    // `size_longform_audio_to_mp4` failure, whose real inputs are fragmented long-form audio MP4s.
    const source = await loadFixture('bear-av-frag.mp4');
    const sourceMovie = await readMovie(ra(source));
    // Premise: every track's `moov` table is empty, so the recovery is the only way to see the samples.
    for (const track of sourceMovie.tracks) {
      expect(buildSampleData(track).length).toBe(0);
    }
    const expected = (await muxTracksFromMovie(ra(source), sourceMovie)).map(
      (t) => t.samples.length,
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.every((count) => count > 0)).toBe(true);

    const out = await bytesOf(
      await media().remux(await fixtureSource('bear-av-frag.mp4'), { to: 'mp4' }),
    );

    // The output is a plain progressive MP4 whose `moov` now carries the full recovered sample tables —
    // every track keeps exactly its recovered sample count (no track dropped, no sample lost).
    const re = await readMovie(ra(out));
    expect(re.tracks.length).toBe(sourceMovie.tracks.length);
    expect(re.tracks.map((track) => buildSampleData(track).length)).toEqual(expected);
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

  it('full-range keyframe trim reimports as an idempotent packet copy', async () => {
    const m = media();
    const input = await loadFixture('movie_5.mp4');
    const orig = await readMovie(ra(input));
    const out = await bytesOf(
      await m.trim(await fixtureSource('movie_5.mp4'), {
        start: 0,
        end: orig.durationSec,
        mode: 'keyframe',
      }),
    );

    expect(equalBytes(out, input)).toBe(false);
    const re = await readMovie(ra(out));
    expect(re.tracks.length).toBe(orig.tracks.length);
    for (let i = 0; i < orig.tracks.length; i++) {
      const a = orig.tracks[i];
      const b = re.tracks[i];
      expect(b?.codec).toBe(a?.codec);
      if (a && b) expect(buildSampleData(b).map(strip)).toEqual(buildSampleData(a).map(strip));
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
