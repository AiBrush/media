import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../contracts/driver.ts';
import { selectDecodeTrackInfo, selectTrackInfos } from './track-select.ts';

interface SyntheticTrack extends TrackInfo {
  readonly declaredDefault: boolean;
  readonly identity: string;
}

function seededUint32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function shuffle<T>(values: T[], next: () => number): void {
  for (let index = values.length - 1; index > 0; index--) {
    const other = next() % (index + 1);
    const value = values[index];
    const replacement = values[other];
    if (value === undefined || replacement === undefined) continue;
    values[index] = replacement;
    values[other] = value;
  }
}

describe('track selection — seeded multitrack discovery properties', () => {
  it('selects per-type ordinals deterministically and retains each declared track object', () => {
    const next = seededUint32(0x7aacc0de);

    for (let caseIndex = 0; caseIndex < 128; caseIndex++) {
      const tracks: SyntheticTrack[] = [];
      const videoCount = 2 + (next() % 5);
      const audioCount = 1 + (next() % 4);
      for (let index = 0; index < videoCount; index++) {
        tracks.push({
          id: 1000 + caseIndex * 20 + index,
          mediaType: 'video',
          codec: index % 2 === 0 ? 'vp9' : 'h264',
          bitrate: 500_000 + index * 100_000,
          language: index % 2 === 0 ? 'und' : 'eng',
          config: {
            codec: index % 2 === 0 ? 'vp09.00.10.08' : 'avc1.640028',
            codedWidth: 320 + index * 16,
            codedHeight: 180 + index * 8,
          },
          declaredDefault: (next() & 1) === 1,
          identity: `case-${caseIndex}-video-${index}`,
        });
      }
      for (let index = 0; index < audioCount; index++) {
        tracks.push({
          id: 2000 + caseIndex * 20 + index,
          mediaType: 'audio',
          codec: index % 2 === 0 ? 'opus' : 'aac',
          bitrate: 64_000 + index * 16_000,
          language: index % 2 === 0 ? 'swe' : 'eng',
          config: {
            codec: index % 2 === 0 ? 'opus' : 'mp4a.40.2',
            sampleRate: 48_000,
            numberOfChannels: 1 + (index % 2),
          },
          declaredDefault: (next() & 1) === 1,
          identity: `case-${caseIndex}-audio-${index}`,
        });
      }
      shuffle(tracks, next);

      const discoveredVideos = tracks.filter((track) => track.mediaType === 'video');
      const discoveredAudio = tracks.filter((track) => track.mediaType === 'audio');
      const videoIndex = next() % discoveredVideos.length;
      const audioIndex = next() % discoveredAudio.length;
      const expectedVideo = discoveredVideos[videoIndex];
      const expectedAudio = discoveredAudio[audioIndex];
      if (expectedVideo === undefined || expectedAudio === undefined) {
        throw new Error('seeded multitrack case unexpectedly lacked a selected track');
      }

      const selected = selectTrackInfos(tracks, [
        `audio:${audioIndex}@0`,
        `video:${videoIndex}`,
        `video:${videoIndex}`,
      ]);
      expect(selected).toEqual([expectedAudio, expectedVideo]);
      expect(selected[0]).toBe(expectedAudio);
      expect(selected[1]).toBe(expectedVideo);
      expect(selectDecodeTrackInfo(tracks, 'video', [`video:${videoIndex}`])).toBe(expectedVideo);
      expect(selectDecodeTrackInfo(tracks, 'audio', [`audio:${audioIndex}`])).toBe(expectedAudio);

      expect(expectedVideo).toMatchObject({
        declaredDefault: expectedVideo.declaredDefault,
        identity: expectedVideo.identity,
        bitrate: expectedVideo.bitrate,
        language: expectedVideo.language,
        config: expectedVideo.config,
      });
      expect(expectedAudio).toMatchObject({
        declaredDefault: expectedAudio.declaredDefault,
        identity: expectedAudio.identity,
        bitrate: expectedAudio.bitrate,
        language: expectedAudio.language,
        config: expectedAudio.config,
      });
    }
  });
});
