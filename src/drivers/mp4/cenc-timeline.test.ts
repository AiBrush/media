import { describe, expect, it } from 'vitest';
import { normalizeDecryptedFragmentTracks } from './mp4-driver.ts';
import type { MuxSampleInput, MuxTrackInput } from './write.ts';

function presentationTicks(track: MuxTrackInput): number[] {
  const edit = track.edit?.mediaTimeTicks ?? 0;
  let dts = 0;
  return track.samples.map((sample) => {
    const pts = dts + sample.cttsTicks - edit;
    dts += sample.durationTicks;
    return pts;
  });
}

function samples(ctts: readonly number[]): MuxSampleInput[] {
  return ctts.map((cttsTicks, index) => ({
    data: new Uint8Array([index]),
    durationTicks: 1001,
    cttsTicks,
    keyframe: index === 0,
  }));
}

describe('fragmented CENC clear-output timeline normalization', () => {
  it('turns signed B-frame CTOs into non-negative CTO + compensating edit without changing any PTS', () => {
    const video: MuxTrackInput = {
      mediaType: 'video',
      sampleEntryType: 'avc1',
      timescale: 30_000,
      samples: samples([0, 3003, 0, -2002, -1001]),
    };
    const audio: MuxTrackInput = {
      mediaType: 'audio',
      sampleEntryType: 'mp4a',
      timescale: 48_000,
      samples: samples([0, 0, 0]),
    };

    const before = presentationTicks(video);
    const [normalizedVideo, normalizedAudio] = normalizeDecryptedFragmentTracks([video, audio]);
    if (normalizedVideo === undefined || normalizedAudio === undefined) {
      throw new Error('normalizer dropped a track');
    }

    expect(normalizedVideo.samples.map((sample) => sample.cttsTicks)).toEqual([
      2002, 5005, 2002, 0, 1001,
    ]);
    expect(normalizedVideo.edit).toEqual({ mediaTimeTicks: 2002, durationTicks: 5005 });
    expect(presentationTicks(normalizedVideo)).toEqual(before);
    expect(normalizedVideo.samples.every((sample) => sample.cttsTicks >= 0)).toBe(true);
    expect(normalizedAudio).toBe(audio);
  });
});
