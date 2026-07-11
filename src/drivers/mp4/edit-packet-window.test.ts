/**
 * Packet enumeration follows the active edit's presented tail without discarding leading decode
 * pre-roll. Each rotation below keeps real compressed payloads/timing from a different corpus file,
 * shortens every track by two complete trailing samples, and places the first sample before media time.
 */

import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test-support/corpus.ts';
import {
  mp4PacketInfoMetadata,
  mp4PacketMetadata,
  muxTracksFromMovie,
  readMovie,
} from './mp4-driver.ts';
import { writeMp4 } from './write.ts';

const ROTATIONS = [
  'movie_5.mp4',
  'test.mp4',
  'h264.mp4',
  'bear-1280x720.mp4',
  'obs-remux-variable-aac.mp4',
] as const;

function randomAccess(bytes: Uint8Array) {
  return {
    read: (offset: number, length: number) =>
      Promise.resolve(bytes.subarray(offset, offset + length)),
    size: bytes.byteLength,
  };
}

describe('MP4 active-edit packet window', () => {
  it.each(ROTATIONS)(
    '%s retains leading pre-roll and omits samples wholly beyond the active edit end',
    async (fixture) => {
      const source = await loadFixture(fixture);
      const movie = await readMovie(randomAccess(source));
      const tracks = await muxTracksFromMovie(randomAccess(source), movie);
      const expectedCounts: number[] = [];
      const edited = tracks.map((track) => {
        const dropCount = Math.min(2, Math.max(0, track.samples.length - 2));
        const keepCount = track.samples.length - dropCount;
        expectedCounts.push(keepCount);
        const keptDurationTicks = track.samples
          .slice(0, keepCount)
          .reduce((sum, sample) => sum + sample.durationTicks, 0);
        const lastKeptDurationTicks = track.samples[keepCount - 1]?.durationTicks ?? 1;
        const activeEndTicks = Math.max(
          1,
          keptDurationTicks - Math.max(1, Math.floor(lastKeptDurationTicks / 2)),
        );
        const leadingPrerollTicks = Math.min(
          track.samples[0]?.durationTicks ?? 0,
          Math.max(0, activeEndTicks - 1),
        );
        return {
          ...track,
          edit: {
            mediaTimeTicks: leadingPrerollTicks,
            durationTicks: activeEndTicks - leadingPrerollTicks,
          },
        };
      });
      const output = writeMp4(edited, { movieTimescale: movie.timescale });
      const reparsed = await readMovie(randomAccess(output));

      const byTrackId = new Map<number, number>();
      for (const packet of mp4PacketMetadata(reparsed, output.byteLength)) {
        byTrackId.set(packet.trackId, (byTrackId.get(packet.trackId) ?? 0) + 1);
      }
      expect(reparsed.tracks.map((track) => byTrackId.get(track.id) ?? 0)).toEqual(expectedCounts);

      const byTrackIndex = new Map<number, number>();
      for (const packet of mp4PacketInfoMetadata(reparsed, output.byteLength)) {
        byTrackIndex.set(packet.trackIndex, (byTrackIndex.get(packet.trackIndex) ?? 0) + 1);
      }
      expect(reparsed.tracks.map((_, index) => byTrackIndex.get(index) ?? 0)).toEqual(
        expectedCounts,
      );
    },
  );
});
