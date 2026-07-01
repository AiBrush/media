import { describe, expect, it } from 'vitest';
import { createMedia } from '../../api/create-media.ts';
import type { ByteSource } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { fixtureSource, loadFixture } from '../../test-support/corpus.ts';
import { Mp4Driver, Mp4Module, readMovie, readMovieMetadata } from './mp4-driver.ts';
import { buildSamples } from './samples.ts';

function makeRA(bytes: Uint8Array) {
  return {
    read: (o: number, l: number) => Promise.resolve(bytes.subarray(o, o + l)),
    size: bytes.byteLength,
  };
}

async function blobBytes(
  out: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected Blob output');
  return new Uint8Array(await out.arrayBuffer());
}

describe('Mp4Driver.supports', () => {
  it('recognizes mp4 by ftyp magic, mime, and extension; rejects others', async () => {
    const head = (await loadFixture('movie_5.mp4')).subarray(0, 16);
    expect(Mp4Driver.supports({ direction: 'demux', head })).toBe(true);
    expect(Mp4Driver.supports({ direction: 'demux', mime: 'video/mp4' })).toBe(true);
    expect(Mp4Driver.supports({ direction: 'demux', extension: 'mov' })).toBe(true);
    const webmHead = (await loadFixture('movie_5.webm')).subarray(0, 16);
    expect(Mp4Driver.supports({ direction: 'demux', head: webmHead })).toBe(false);
    expect(Mp4Driver.supports({ direction: 'demux', head: new Uint8Array([1, 2, 3, 4]) })).toBe(
      false,
    );
    expect(Mp4Driver.supports({ direction: 'demux' })).toBe(false);
  });
});

describe('probe (golden-metadata invariants) across the real MP4 corpus', () => {
  it('metadata-only probe returns the same track facts as demux without reading packet streams', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const src = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      size: bytes.byteLength,
      range: (start: number, end: number) => Promise.resolve(bytes.subarray(start, end)),
    };
    const tracks = await Mp4Driver.probe?.(src);
    const demuxer = await Mp4Driver.demux(src);
    try {
      expect(tracks).toEqual(demuxer.tracks);
    } finally {
      await demuxer.close();
    }
  });

  it('metadata-only parser preserves track facts without materializing sample-size tables', async () => {
    const bytes = await loadFixture('test.mp4');
    const metadata = await readMovieMetadata(makeRA(bytes));
    const full = await readMovie(makeRA(bytes));
    expect(metadata.tracks).toHaveLength(full.tracks.length);

    for (const track of metadata.tracks) {
      expect(track.samples.sampleSizes).toHaveLength(0);
      expect(track.samples.sampleToChunk).toHaveLength(0);
      expect(track.samples.chunkOffsets).toHaveLength(0);

      const fullTrack = full.tracks.find((candidate) => candidate.id === track.id);
      expect(fullTrack).toBeDefined();
      if (!fullTrack) continue;
      if (fullTrack.samples.sampleSizes.length > 0) {
        expect(track.samples.timeToSample.length).toBeGreaterThan(0);
      }
      expect({
        id: track.id,
        mediaType: track.mediaType,
        codec: track.codec,
        durationSec: track.durationSec,
        fps: track.fps,
        width: track.width,
        height: track.height,
        rotation: track.rotation,
        sampleRate: track.sampleRate,
        channels: track.channels,
        encrypted: track.encryption !== undefined,
        config: track.config,
      }).toEqual({
        id: fullTrack.id,
        mediaType: fullTrack.mediaType,
        codec: fullTrack.codec,
        durationSec: fullTrack.durationSec,
        fps: fullTrack.fps,
        width: fullTrack.width,
        height: fullTrack.height,
        rotation: fullTrack.rotation,
        sampleRate: fullTrack.sampleRate,
        channels: fullTrack.channels,
        encrypted: fullTrack.encryption !== undefined,
        config: fullTrack.config,
      });
    }
  });

  it('metadata-only probe accepts a range source whose total size is not known yet', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const reads: Array<[number, number]> = [];
    const src: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      range: (start, end) => {
        reads.push([start, end]);
        return Promise.resolve(bytes.subarray(start, end));
      },
    };
    const tracks = await Mp4Driver.probe?.(src);
    expect(tracks?.length).toBeGreaterThan(0);
    expect(tracks?.some((track) => track.mediaType === 'video')).toBe(true);
    expect(reads).toEqual([
      [0, 64],
      [24, 2206],
    ]);
  });

  it('metadata-only probe honors cancellation before and after the metadata read', async () => {
    const bytes = await loadFixture('movie_5.mp4');
    const source = (range: (start: number, end: number) => Promise<Uint8Array>): ByteSource => ({
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      size: bytes.byteLength,
      range,
    });
    await expect(
      Mp4Driver.probe?.(
        source((start, end) => Promise.resolve(bytes.subarray(start, end))),
        {
          signal: AbortSignal.abort(),
        },
      ),
    ).rejects.toThrow(MediaError);

    const controller = new AbortController();
    let reads = 0;
    await expect(
      Mp4Driver.probe?.(
        source((start, end) => {
          reads++;
          const out = bytes.subarray(start, end);
          if (reads >= 2) controller.abort();
          return Promise.resolve(out);
        }),
        { signal: controller.signal },
      ),
    ).rejects.toThrow(MediaError);
    expect(reads).toBe(2);
  });

  it('omits packetTable for fragmented MP4s whose init sample tables are empty', async () => {
    const bytes = await blobBytes(
      await createMedia()
        .use(Mp4Module)
        .remux(await fixtureSource('movie_5.mp4'), { to: 'mp4', fragmented: true }),
    );
    const src: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
      size: bytes.byteLength,
      range: (start, end) => Promise.resolve(bytes.subarray(start, end)),
    };
    const demuxer = await Mp4Driver.demux(src);
    try {
      expect(demuxer.tracks.length).toBeGreaterThan(0);
      expect(demuxer.packetTable).toBeUndefined();
    } finally {
      await demuxer.close();
    }
  });

  it('2x2-green.mp4 — tiny h264 video (exact 2×2) + mp3-in-mp4 audio', async () => {
    const info = await createMedia()
      .use(Mp4Module)
      .probe(await fixtureSource('2x2-green.mp4'));
    expect(info.container).toBe('mp4');
    expect(info.durationSec).toBeGreaterThan(0);
    const video = info.tracks.filter((t) => t.type === 'video');
    expect(video).toHaveLength(1);
    expect(video[0]?.codec.startsWith('avc1.')).toBe(true);
    expect(video[0]?.width).toBe(2);
    expect(video[0]?.height).toBe(2);
    // It also carries an mp3 audio track (oti 0x6b) — preserved verbatim on remux.
    expect(info.tracks.find((t) => t.type === 'audio')?.codec).toBe('mp4a.6b');
  });

  it.each(['movie_5.mp4', 'test.mp4'])(
    '%s — h264 video + aac audio with sane params',
    async (id) => {
      const info = await createMedia()
        .use(Mp4Module)
        .probe(await fixtureSource(id));
      expect(info.container).toBe('mp4');
      expect(info.durationSec).toBeGreaterThan(0.1);

      const video = info.tracks.find((t) => t.type === 'video');
      expect(video?.codec.startsWith('avc1.')).toBe(true);
      expect(video?.width).toBeGreaterThan(0);
      expect(video?.height).toBeGreaterThan(0);

      const audio = info.tracks.find((t) => t.type === 'audio');
      expect(audio?.codec).toBe('mp4a.40.2');
      expect([44100, 48000, 32000, 22050, 24000, 16000]).toContain(audio?.sampleRate);
      expect(audio?.channels).toBeGreaterThanOrEqual(1);
    },
  );
});

describe('demux sample tables (golden-packets invariants)', () => {
  it.each(['2x2-green.mp4', 'movie_5.mp4', 'test.mp4'])(
    '%s — samples reference real in-bounds bytes with monotonic DTS and a leading keyframe',
    async (id) => {
      const bytes = await loadFixture(id);
      const movie = await readMovie(makeRA(bytes));
      expect(movie.brand.length).toBe(4);

      for (const track of movie.tracks) {
        const samples = buildSamples(track);
        expect(samples.length).toBe(track.samples.sampleSizes.length);
        expect(samples.length).toBeGreaterThan(0);

        // Every sample points at real, in-bounds file bytes.
        for (const s of samples) {
          expect(s.offset).toBeGreaterThanOrEqual(0);
          expect(s.offset + s.size).toBeLessThanOrEqual(bytes.byteLength);
        }
        // DTS is monotonically non-decreasing.
        for (let i = 1; i < samples.length; i++) {
          expect(samples[i]?.dtsUs).toBeGreaterThanOrEqual(samples[i - 1]?.dtsUs ?? 0);
        }
        // Video must begin on a keyframe; audio frames are all sync.
        expect(samples[0]?.keyframe).toBe(true);
        // Sizes sum to the stsz total (no samples dropped/duplicated).
        const sumSizes = samples.reduce((a, s) => a + s.size, 0);
        const stszTotal = track.samples.sampleSizes.reduce((a, n) => a + n, 0);
        expect(sumSizes).toBe(stszTotal);
      }
    },
  );

  it('preserves B-frame reordering: some PTS differs from DTS when ctts is present', async () => {
    const bytes = await loadFixture('test.mp4');
    const movie = await readMovie(makeRA(bytes));
    const video = movie.tracks.find((t) => t.mediaType === 'video');
    expect(video).toBeDefined();
    if (video && video.samples.compositionOffsets.length > 0) {
      const samples = buildSamples(video);
      expect(samples.some((s) => s.ptsUs !== s.dtsUs)).toBe(true);
    }
  });
});

describe('demux over a non-seekable source + browser-only seam', () => {
  it('buffers a range-less source and still demuxes tracks', async () => {
    const bytes = await loadFixture('2x2-green.mp4');
    const streamSource: ByteSource = {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c): void {
            c.enqueue(bytes);
            c.close();
          },
        }),
    };
    const demuxer = await Mp4Driver.demux(streamSource);
    expect(demuxer.tracks.length).toBeGreaterThan(0);
    const firstId = demuxer.tracks[0]?.id ?? 0;

    // In node (no WebCodecs) the packet seam raises a typed CapabilityError, not a crash.
    expect(() => demuxer.packets(firstId)).toThrowError(CapabilityError);
    // An unknown track id is a typed demux error.
    expect(() => demuxer.packets(9999)).toThrowError(MediaError);
    await demuxer.close();
  });

  it('createMuxer returns a Muxer over the byte-muxer (round-trip covered in mux.test.ts)', () => {
    const muxer = Mp4Driver.createMuxer({ faststart: true });
    expect(muxer.output).toBeInstanceOf(ReadableStream);
    expect(typeof muxer.addTrack).toBe('function');
    expect(typeof muxer.write).toBe('function');
    expect(typeof muxer.finalize).toBe('function');
    // addTrack allocates a positive track id (write()'s real-EncodedChunk path is browser-only).
    const id = muxer.addTrack({
      id: 1,
      mediaType: 'video',
      codec: 'avc1.42C01E',
      config: { codec: 'avc1.42C01E', codedWidth: 4, codedHeight: 4 },
    });
    expect(id).toBeGreaterThan(0);
  });

  it('createMuxer accepts a fragmented mux (CMAF output, ADR-034)', () => {
    // Fragmented/CMAF mux is now supported: the muxer constructs (it emits init + moof segments on
    // finalize). The full fragmented round-trip is validated in mux.test.ts; here we only assert that
    // requesting it no longer raises a capability miss.
    expect(() => Mp4Driver.createMuxer({ fragmented: true })).not.toThrow();
  });
});
