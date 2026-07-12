/**
 * Same-family MP4 remux must preserve the source presentation mapping as well as the coded samples.
 * These real corpus files cover AAC priming, H.264/HEVC B-frame preroll, rotation, VFR, and distinct
 * movie/track timescales. A bare writer call may round segment duration by at most one millisecond;
 * same-family driver remux retains the source movie timescale and every native sample-table fact exactly.
 */

import { describe, expect, it } from 'vitest';
import type { StreamCopyOptions } from '../../contracts/driver.ts';
import { fromBytes } from '../../sources/source.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { Mp4Driver, muxTracksFromMovie, readMovie } from './mp4-driver.ts';
import { buildSampleData } from './samples.ts';
import { writeMp4 } from './write.ts';

const EDIT_FIXTURES = [
  '2x2-green.mp4',
  'bear-4k-hevc.mp4',
  'bear-rotate-90.mp4',
  'obs-remux-variable-aac.mp4',
  'test.mp4',
] as const;

const OUTPUT_MODES = [
  ['materialized stream', {}],
  ['progressive stream', { streaming: true }],
  ['progressive buffer', { buffered: true }],
  ['fragmented stream', { fragmented: true }],
] satisfies ReadonlyArray<readonly [string, StreamCopyOptions]>;

function randomAccess(bytes: Uint8Array): {
  read(offset: number, length: number): Promise<Uint8Array>;
  size: number;
} {
  return {
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
    size: bytes.byteLength,
  };
}

function sampleFacts(track: Parameters<typeof buildSampleData>[0]): Array<{
  size: number;
  durationTicks: number;
  cttsTicks: number;
  keyframe: boolean;
}> {
  return buildSampleData(track).map(({ size, durationTicks, cttsTicks, keyframe }) => ({
    size,
    durationTicks,
    cttsTicks,
    keyframe,
  }));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

describe('MP4 same-family remux edit-list preservation', () => {
  it.each(EDIT_FIXTURES)('%s preserves every supported edit and coded sample fact', async (id) => {
    const source = await loadFixture(id);
    const sourceMovie = await readMovie(randomAccess(source));
    expect(sourceMovie.tracks.some((track) => track.edit !== undefined)).toBe(true);
    if (id === 'obs-remux-variable-aac.mp4') {
      expect(
        sourceMovie.tracks.find((track) => track.mediaType === 'video')?.edit
          ?.leadingEmptyDurationSec,
      ).toBe(0.021);
    }

    const muxTracks = await muxTracksFromMovie(randomAccess(source), sourceMovie);
    for (let index = 0; index < sourceMovie.tracks.length; index++) {
      const sourceTrack = sourceMovie.tracks[index];
      const muxTrack = muxTracks[index];
      if (sourceTrack === undefined || muxTrack === undefined) {
        throw new Error(`${id}: remux track ${index} is missing`);
      }
      expect(muxTrack.edit).toEqual(
        sourceTrack.edit === undefined
          ? undefined
          : {
              mediaTimeTicks: sourceTrack.edit.mediaTimeTicks,
              durationTicks: Math.round(sourceTrack.edit.durationSec * sourceTrack.timescale),
              movieTimescale: sourceTrack.edit.movieTimescale,
              durationMovieTicks: sourceTrack.edit.durationMovieTicks,
              ...(sourceTrack.edit.leadingEmptyDurationSec !== undefined
                ? {
                    leadingEmptyDurationTicks: Math.round(
                      sourceTrack.edit.leadingEmptyDurationSec * sourceTrack.timescale,
                    ),
                  }
                : {}),
              ...(sourceTrack.edit.leadingEmptyDurationMovieTicks !== undefined
                ? {
                    leadingEmptyDurationMovieTicks: sourceTrack.edit.leadingEmptyDurationMovieTicks,
                  }
                : {}),
            },
      );
    }

    const output = writeMp4(muxTracks);
    const outputMovie = await readMovie(randomAccess(output));
    expect(outputMovie.tracks).toHaveLength(sourceMovie.tracks.length);

    for (let index = 0; index < sourceMovie.tracks.length; index++) {
      const sourceTrack = sourceMovie.tracks[index];
      const outputTrack = outputMovie.tracks[index];
      if (sourceTrack === undefined || outputTrack === undefined) {
        throw new Error(`${id}: output track ${index} is missing`);
      }
      expect(outputTrack.edit?.mediaTimeTicks).toBe(sourceTrack.edit?.mediaTimeTicks);
      if (sourceTrack.edit !== undefined) {
        expect(outputTrack.edit).toBeDefined();
        expect(
          Math.abs((outputTrack.edit?.durationSec ?? 0) - sourceTrack.edit.durationSec),
        ).toBeLessThanOrEqual(0.001);
        expect(outputTrack.edit?.leadingEmptyDurationSec).toBe(
          sourceTrack.edit.leadingEmptyDurationSec,
        );
      }
      expect(sampleFacts(outputTrack)).toEqual(sampleFacts(sourceTrack));
      expect(outputTrack.mediaDurationTicks).toBe(sourceTrack.mediaDurationTicks);
      expect(outputTrack.durationSec).toBe(sourceTrack.durationSec);
      expect(outputTrack.fps).toBe(sourceTrack.fps);
      expect(outputTrack.colr).toEqual(sourceTrack.colr);
      expect(outputTrack.pasp).toEqual(sourceTrack.pasp);
      expect(outputTrack.clap).toEqual(sourceTrack.clap);
    }
  });

  it.each(OUTPUT_MODES)(
    '%s preserves an active edit preceded by an empty segment',
    async (_label, options) => {
      if (Mp4Driver.streamCopy === undefined) throw new Error('MP4 streamCopy is unavailable');
      const source = await loadFixture('obs-remux-variable-aac.mp4');
      const output = await collect(
        await Mp4Driver.streamCopy(fromBytes(source, { mime: 'video/mp4' }), options),
      );
      const movie = await readMovie(randomAccess(output));
      const sourceMovie = await readMovie(randomAccess(source));
      const sourceVideo = sourceMovie.tracks.find((track) => track.mediaType === 'video');
      const video = movie.tracks.find((track) => track.mediaType === 'video');
      expect(video?.edit).toEqual({
        mediaTimeTicks: 2880,
        durationSec: 6.283,
        durationMovieTicks: 6283,
        movieTimescale: 1000,
        leadingEmptyDurationSec: 0.021,
        leadingEmptyDurationMovieTicks: 21,
      });
      expect(video?.mediaDurationTicks).toBe(sourceVideo?.mediaDurationTicks);
      expect(video?.durationSec).toBe(sourceVideo?.durationSec);
      expect(video?.fps).toBe(sourceVideo?.fps);
      expect(video?.colr).toEqual(sourceVideo?.colr);
      expect(video?.pasp).toEqual(sourceVideo?.pasp);
      expect(video?.clap).toEqual(sourceVideo?.clap);
    },
  );

  it.each(OUTPUT_MODES)('%s retains source movie-timescale precision', async (_label, options) => {
    if (Mp4Driver.streamCopy === undefined) throw new Error('MP4 streamCopy is unavailable');
    const source = await loadFixture('test.mp4');
    const output = await collect(
      await Mp4Driver.streamCopy(fromBytes(source, { mime: 'video/mp4' }), options),
    );
    const movie = await readMovie(randomAccess(output));
    expect(movie.timescale).toBe(2500);
    expect(movie.tracks.find((track) => track.mediaType === 'audio')?.edit?.durationSec).toBe(
      6.0272,
    );
  });

  it('reports a contained video edit as the demux timeline for cross-container muxers', async () => {
    const source = await loadFixture('h264.mp4');
    const sourceMovie = await readMovie(randomAccess(source));
    const tracks = await muxTracksFromMovie(randomAccess(source), sourceMovie);
    const editedTracks = tracks.map((track) => {
      if (track.mediaType !== 'video') return track;
      const codedDurationTicks = track.samples.reduce(
        (total, sample) => total + sample.durationTicks,
        0,
      );
      const prerollTicks = Math.max(1, Math.floor(codedDurationTicks / 4));
      return {
        ...track,
        edit: {
          mediaTimeTicks: prerollTicks,
          durationTicks: codedDurationTicks - prerollTicks,
        },
      };
    });
    const editedVideo = editedTracks.find((track) => track.mediaType === 'video');
    if (editedVideo === undefined || editedVideo.edit === undefined) {
      throw new Error('real H.264 fixture has no edited video track');
    }
    const output = writeMp4(editedTracks, { movieTimescale: sourceMovie.timescale });
    const demuxer = await Mp4Driver.demux(fromBytes(output, { mime: 'video/mp4' }));
    const video = demuxer.tracks.find((track) => track.mediaType === 'video');
    expect(video?.durationSec).toBeCloseTo(
      editedVideo.edit.durationTicks / editedVideo.timescale,
      6,
    );
    await demuxer.close();
  });
});
