import { describe, expect, it } from 'vitest';
import type { ByteSource } from '../../contracts/driver.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import {
  Mp4Driver,
  mp4PacketInfoMetadata,
  mp4PacketMetadata,
  muxTracksFromMovie,
  planLazySampleDataFragmentRuns,
  readMovie,
} from './mp4-driver.ts';
import type { Movie, ParsedTrack } from './parse.ts';
import { type SampleData, buildSampleData, buildSamples } from './samples.ts';
import { writeMp4 } from './write.ts';

const ra = (b: Uint8Array) => ({
  read: (o: number, l: number) => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

function strip(s: { size: number; durationTicks: number; cttsTicks: number; keyframe: boolean }) {
  return {
    size: s.size,
    durationTicks: s.durationTicks,
    cttsTicks: s.cttsTicks,
    keyframe: s.keyframe,
  };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function syntheticAudioMovie(sampleSizes: number[], chunkOffsets: number[]): Movie {
  const track: ParsedTrack = {
    id: 1,
    mediaType: 'audio',
    timescale: 48_000,
    durationSec: sampleSizes.length / 48_000,
    codec: 'mp4a.40.2',
    sampleEntryType: 'mp4a',
    config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
    sampleRate: 48_000,
    channels: 2,
    samples: {
      timeToSample: [{ count: sampleSizes.length, delta: 1 }],
      compositionOffsets: [],
      sampleSizes,
      sampleToChunk: chunkOffsets.map((_, i) => ({
        firstChunk: i + 1,
        samplesPerChunk: 1,
        descIndex: 1,
      })),
      chunkOffsets,
      syncSamples: [],
    },
  };
  return { brand: 'isom', timescale: 1_000, durationSec: track.durationSec, tracks: [track] };
}

function syntheticBFrameMovie(): Movie {
  const track: ParsedTrack = {
    id: 7,
    mediaType: 'video',
    timescale: 1_000,
    durationSec: 3,
    codec: 'avc1.64001f',
    sampleEntryType: 'avc1',
    config: { codec: 'avc1.64001f', codedWidth: 16, codedHeight: 16 },
    width: 16,
    height: 16,
    samples: {
      timeToSample: [{ count: 3, delta: 1_000 }],
      compositionOffsets: [
        { count: 1, offset: 2_000 },
        { count: 2, offset: 0 },
      ],
      sampleSizes: [4, 5, 6],
      sampleToChunk: [{ firstChunk: 1, samplesPerChunk: 3, descIndex: 1 }],
      chunkOffsets: [100],
      syncSamples: [1],
    },
  };
  return { brand: 'isom', timescale: 1_000, durationSec: 3, tracks: [track] };
}

function rangeSource(
  bytes: Uint8Array,
  reads: Array<{ offset: number; length: number }>,
): ByteSource {
  return {
    size: bytes.byteLength,
    stream: () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    range: (start: number, end: number): Promise<Uint8Array> => {
      reads.push({ offset: start, length: end - start });
      return Promise.resolve(bytes.subarray(start, end));
    },
  };
}

function sampleData(index: number, keyframe: boolean): SampleData {
  return {
    index,
    offset: index * 10,
    size: 10,
    dtsTicks: index,
    durationTicks: 1,
    cttsTicks: 0,
    keyframe,
  };
}

describe('MP4 muxer — reference-reimport round-trip on the real corpus', () => {
  it.each(['2x2-green.mp4', 'movie_5.mp4', 'test.mp4'])(
    '%s: write(parse(x)) re-parses to identical tracks + sample tables, and is a genuine re-layout',
    async (id) => {
      const input = await loadFixture(id);
      const movie = await readMovie(ra(input));
      const tracks = await muxTracksFromMovie(ra(input), movie);
      const output = writeMp4(tracks);

      // Anti-cheat (doc 11 §5): a genuine re-layout, not the ftyp-byte-flip passthrough.
      expect(output.byteLength).toBeGreaterThan(0);
      expect(equalBytes(output, input)).toBe(false);

      const reparsed = await readMovie(ra(output));
      expect(reparsed.tracks.length).toBe(movie.tracks.length);

      for (let t = 0; t < movie.tracks.length; t++) {
        const a = movie.tracks[t];
        const b = reparsed.tracks[t];
        expect(b?.codec).toBe(a?.codec);
        expect(b?.width).toBe(a?.width);
        expect(b?.height).toBe(a?.height);
        expect(b?.sampleRate).toBe(a?.sampleRate);
        expect(b?.channels).toBe(a?.channels);
        expect(b?.timescale).toBe(a?.timescale);
        expect(b?.durationSec).toBe(a?.durationSec);

        // Sample tables match exactly (size + timing + keyframes); byte offsets differ by design.
        const sa = a ? buildSampleData(a).map(strip) : [];
        const sb = b ? buildSampleData(b).map(strip) : [];
        expect(sb).toEqual(sa);
      }
    },
  );

  it('round-trips losslessly through a second remux (double-remux stability)', async () => {
    const input = await loadFixture('2x2-green.mp4');
    const once = writeMp4(await muxTracksFromMovie(ra(input), await readMovie(ra(input))));
    const twice = writeMp4(await muxTracksFromMovie(ra(once), await readMovie(ra(once))));
    expect(equalBytes(twice, once)).toBe(true);
  });

  it('coalesces range reads instead of fetching once per sample', async () => {
    const input = await loadFixture('movie_5.mp4');
    const reads: Array<{ offset: number; length: number }> = [];
    const countingRa = {
      read: (offset: number, length: number): Promise<Uint8Array> => {
        reads.push({ offset, length });
        return Promise.resolve(input.subarray(offset, offset + length));
      },
      size: input.byteLength,
    };
    const movie = await readMovie(countingRa);
    const sampleCount = movie.tracks.reduce((n, track) => n + buildSampleData(track).length, 0);

    reads.length = 0;
    const tracks = await muxTracksFromMovie(countingRa, movie);
    const copiedSamples = tracks.reduce((n, track) => n + track.samples.length, 0);

    expect(sampleCount).toBeGreaterThan(4);
    expect(copiedSamples).toBe(sampleCount);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThan(sampleCount);
    expect(reads.every((r) => r.length <= 8 * 1024 * 1024)).toBe(true);
  });

  it('fragmented stream-copy emits the init segment before lazy sample-payload reads', async () => {
    if (!Mp4Driver.streamCopy) throw new Error('mp4 driver has no streamCopy');
    const input = await loadFixture('movie_5.mp4');
    const reads: Array<{ offset: number; length: number }> = [];
    const stream = await Mp4Driver.streamCopy(rangeSource(input, reads), { fragmented: true });
    const readsAfterSetup = reads.length;

    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBeGreaterThan(0);
    expect(reads.length).toBe(readsAfterSetup);

    const parts: Uint8Array[] = [first.value as Uint8Array];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
    }
    reader.releaseLock();

    expect(parts.length).toBeGreaterThan(1);
    expect(reads.length).toBeGreaterThan(readsAfterSetup);

    const total = parts.reduce((n, part) => n + part.byteLength, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }

    const sourceMovie = await readMovie(ra(input));
    const reparsed = await readMovie(ra(output));
    expect(reparsed.tracks.length).toBe(sourceMovie.tracks.length);
    for (let i = 0; i < sourceMovie.tracks.length; i++) {
      const sourceTrack = sourceMovie.tracks[i];
      const outTrack = reparsed.tracks[i];
      expect(outTrack?.codec).toBe(sourceTrack?.codec);
      expect(outTrack?.durationSec).toBeCloseTo(sourceTrack?.durationSec ?? 0, 3);
      expect(outTrack?.fragmentSampleCount).toBe(
        sourceTrack ? buildSampleData(sourceTrack).length : 0,
      );
    }
  });

  it('streaming stream-copy emits progressive headers before lazy sample-payload reads', async () => {
    if (!Mp4Driver.streamCopy) throw new Error('mp4 driver has no streamCopy');
    const input = await loadFixture('movie_5.mp4');
    const reads: Array<{ offset: number; length: number }> = [];
    const stream = await Mp4Driver.streamCopy(rangeSource(input, reads), { streaming: true });
    const readsAfterSetup = reads.length;

    const reader = stream.getReader();
    const first = await reader.read();
    const second = await reader.read();
    const third = await reader.read();
    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(third.done).toBe(false);
    expect(reads.length).toBe(readsAfterSetup);

    const parts: Uint8Array[] = [
      first.value as Uint8Array,
      second.value as Uint8Array,
      third.value as Uint8Array,
    ];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
    }
    reader.releaseLock();

    expect(parts.length).toBeGreaterThan(3);
    expect(reads.length).toBeGreaterThan(readsAfterSetup);

    const total = parts.reduce((n, part) => n + part.byteLength, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }

    const sourceMovie = await readMovie(ra(input));
    const reparsed = await readMovie(ra(output));
    expect(reparsed.tracks.length).toBe(sourceMovie.tracks.length);
    for (let i = 0; i < sourceMovie.tracks.length; i++) {
      const sourceTrack = sourceMovie.tracks[i];
      const outTrack = reparsed.tracks[i];
      expect(outTrack?.codec).toBe(sourceTrack?.codec);
      expect(outTrack?.durationSec).toBeCloseTo(sourceTrack?.durationSec ?? 0, 3);
      expect(outTrack ? buildSampleData(outTrack).map(strip) : []).toEqual(
        sourceTrack ? buildSampleData(sourceTrack).map(strip) : [],
      );
    }
  });

  it('buffered stream-copy emits one exact output chunk without eager sample-payload reads', async () => {
    if (!Mp4Driver.streamCopy) throw new Error('mp4 driver has no streamCopy');
    const input = await loadFixture('movie_5.mp4');
    const reads: Array<{ offset: number; length: number }> = [];
    const stream = await Mp4Driver.streamCopy(rangeSource(input, reads), { buffered: true });
    const readsAfterSetup = reads.length;

    const reader = stream.getReader();
    const first = await reader.read();
    const second = await reader.read();
    reader.releaseLock();

    expect(first.done).toBe(false);
    expect(second.done).toBe(true);
    expect(reads.length).toBeGreaterThan(readsAfterSetup);

    const output = first.value as Uint8Array;
    const expected = writeMp4(await muxTracksFromMovie(ra(input), await readMovie(ra(input))));
    expect(equalBytes(output, expected)).toBe(true);
  });

  it('full-range trim uses the ordinary buffered stream-copy layout', async () => {
    if (!Mp4Driver.streamCopy) throw new Error('mp4 driver has no streamCopy');
    const input = await loadFixture('movie_5.mp4');
    const movie = await readMovie(ra(input));
    const untrimmed = await collectBytes(
      await Mp4Driver.streamCopy(rangeSource(input, []), { buffered: true }),
    );
    const fullRange = await collectBytes(
      await Mp4Driver.streamCopy(rangeSource(input, []), {
        trim: { startSec: 0, endSec: movie.durationSec },
        buffered: true,
      }),
    );

    expect(equalBytes(fullRange, input)).toBe(false);
    expect(equalBytes(fullRange, untrimmed)).toBe(true);
  });

  it('keyframe trim range-reads only metadata and selected sample windows', async () => {
    if (!Mp4Driver.streamCopy) throw new Error('mp4 driver has no streamCopy');
    const input = await loadFixture('movie_5.mp4');
    const reads: Array<{ offset: number; length: number }> = [];
    const stream = await Mp4Driver.streamCopy(rangeSource(input, reads), {
      trim: { startSec: 1, endSec: 3 },
      faststart: true,
    });
    const output = await collectBytes(stream);

    const sourceMovie = await readMovie(ra(input));
    const trimmedMovie = await readMovie(ra(output));
    const sourceSampleCount = sourceMovie.tracks.reduce(
      (sum, track) => sum + buildSampleData(track).length,
      0,
    );
    const trimmedSampleCount = trimmedMovie.tracks.reduce(
      (sum, track) => sum + buildSampleData(track).length,
      0,
    );
    const totalReadBytes = reads.reduce((sum, read) => sum + read.length, 0);

    expect(output.byteLength).toBeGreaterThan(0);
    expect(output.byteLength).toBeLessThan(input.byteLength);
    expect(trimmedSampleCount).toBeGreaterThan(0);
    expect(trimmedSampleCount).toBeLessThan(sourceSampleCount);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThan(sourceSampleCount);
    expect(reads.every((read) => read.length <= 8 * 1024 * 1024)).toBe(true);
    expect(totalReadBytes).toBeLessThan(input.byteLength);
  });

  it('lazy source fragments group GOPs until the target sample budget', () => {
    const video = Array.from({ length: 12 }, (_, index) => sampleData(index, index % 3 === 0));
    const videoRuns = planLazySampleDataFragmentRuns(video, 6, true);
    expect(videoRuns.map((run) => run.map((sample) => sample.index))).toEqual([
      [0, 1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10, 11],
    ]);
    expect(videoRuns.every((run) => run[0]?.keyframe === true)).toBe(true);

    const audio = Array.from({ length: 12 }, (_, index) => sampleData(index, true));
    const audioRuns = planLazySampleDataFragmentRuns(audio, 5, false);
    expect(audioRuns.map((run) => run.map((sample) => sample.index))).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8, 9],
      [10, 11],
    ]);
  });

  it('rejects short sample-window reads instead of copying truncated payload', async () => {
    const movie = syntheticAudioMovie([2], [0]);
    const shortRa = {
      read: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array([0xff])),
      size: 2,
    };

    await expect(muxTracksFromMovie(shortRa, movie)).rejects.toThrow(/short read/);
  });

  it('exposes packet metadata from sample tables without reading payload bytes', async () => {
    const input = await loadFixture('movie_5.mp4');
    const reads: Array<{ offset: number; length: number }> = [];
    const demuxed = await Mp4Driver.demux(rangeSource(input, reads));
    const readsAfterMoov = reads.length;

    const table = demuxed.packetTable?.();
    await demuxed.close();

    expect(table).toBeDefined();
    expect(table?.length).toBeGreaterThan(0);
    expect(reads.length).toBe(readsAfterMoov);
  });

  it('packet metadata matches parsed sample tables, preserving B-frame PTS/DTS offsets', () => {
    const movie = syntheticBFrameMovie();
    const table = mp4PacketMetadata(movie, 115);
    const infoTable = mp4PacketInfoMetadata(movie, 115);
    const track = movie.tracks[0];
    if (!track) {
      throw new Error('missing track');
    }
    const expected = buildSamples(track).map((sample) => ({
      trackId: 7,
      sizeBytes: sample.size,
      ptsUs: sample.ptsUs,
      dtsUs: sample.dtsUs,
      durationUs: sample.durationUs,
      keyframe: sample.keyframe,
    }));

    const contractRows = table.map((p) => ({
      trackId: p.trackId,
      sizeBytes: p.sizeBytes,
      ptsUs: p.ptsUs,
      dtsUs: p.dtsUs,
      durationUs: p.durationUs,
      keyframe: p.keyframe,
    }));

    expect(contractRows).toEqual(expected);
    expect(infoTable).toEqual(
      expected.map((packet, index) => ({
        trackIndex: 0,
        offset: [100, 104, 109][index],
        size: packet.sizeBytes,
        ptsUs: packet.ptsUs,
        dtsUs: packet.dtsUs,
        durationUs: packet.durationUs,
        keyframe: packet.keyframe,
      })),
    );
    expect(table[0]).toMatchObject({ trackIndex: 0, size: 4 });
    expect(table[0]?.dtsUs).toBe(0);
    expect(table[0]?.ptsUs).toBe(2_000_000);
    expect(table[1]?.ptsUs).toBe(1_000_000);
  });

  it('packet metadata works when the source size is unknown', () => {
    const table = mp4PacketMetadata(syntheticBFrameMovie());

    expect(table.map((p) => p.sizeBytes)).toEqual([4, 5, 6]);
    expect(table[0]?.trackId).toBe(7);
    expect(table[2]?.dtsUs).toBe(2_000_000);
  });

  it('packet metadata rejects sample tables whose byte ranges escape the source', () => {
    const movie = syntheticBFrameMovie();
    expect(() => mp4PacketMetadata(movie, 112)).toThrow(/outside the source/);
  });

  it('packet metadata rejects impossible ranges even when the source size is unknown', () => {
    const movie = syntheticAudioMovie([2], [-1]);
    expect(() => mp4PacketMetadata(movie)).toThrow(/outside the source/);
  });

  it.each([
    ['negative sample offset', syntheticAudioMovie([2], [-1])],
    ['negative sample size', syntheticAudioMovie([-1], [0])],
  ])('packet metadata rejects %s', (_label, movie) => {
    expect(() => mp4PacketMetadata(movie, 8)).toThrow(/outside the source/);
  });

  it('splits range windows when sample gaps are too large to coalesce', async () => {
    const farOffset = 9 * 1024 * 1024;
    const reads: Array<{ offset: number; length: number }> = [];
    const movie = syntheticAudioMovie([2, 3], [0, farOffset]);
    const countingRa = {
      read: (offset: number, length: number): Promise<Uint8Array> => {
        reads.push({ offset, length });
        return Promise.resolve(new Uint8Array(length));
      },
      size: farOffset + 3,
    };

    const tracks = await muxTracksFromMovie(countingRa, movie);

    expect(tracks[0]?.samples.map((s) => s.data.byteLength)).toEqual([2, 3]);
    expect(reads).toEqual([
      { offset: 0, length: 2 },
      { offset: farOffset, length: 3 },
    ]);
  });

  it('splits range windows when the merged span would exceed the cap', async () => {
    const firstSize = 8 * 1024 * 1024 - 16;
    const secondOffset = firstSize + 1;
    const reads: Array<{ offset: number; length: number }> = [];
    const movie = syntheticAudioMovie([firstSize, 32], [0, secondOffset]);
    const countingRa = {
      read: (offset: number, length: number): Promise<Uint8Array> => {
        reads.push({ offset, length });
        return Promise.resolve(new Uint8Array(length));
      },
      size: secondOffset + 32,
    };

    const tracks = await muxTracksFromMovie(countingRa, movie);

    expect(tracks[0]?.samples.map((s) => s.data.byteLength)).toEqual([firstSize, 32]);
    expect(reads).toEqual([
      { offset: 0, length: firstSize },
      { offset: secondOffset, length: 32 },
    ]);
  });
});
