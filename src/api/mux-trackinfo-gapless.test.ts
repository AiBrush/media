import { describe, expect, it } from 'vitest';
import type { AudioEncoderOutputTiming, TrackInfo } from '../contracts/driver.ts';
import { outputGaplessForAudioEncoder } from './mux-trackinfo.ts';

const AAC_CONFIG: AudioDecoderConfig = {
  codec: 'mp4a.40.2',
  sampleRate: 48_000,
  numberOfChannels: 2,
  description: new Uint8Array([0x11, 0x90]),
};

describe('outputGaplessForAudioEncoder — destination-owned audio timing', () => {
  it('derives priming, remainder, and exact program count from the drained destination encoder', () => {
    const timing: AudioEncoderOutputTiming = {
      sampleRate: 48_000,
      submittedSamples: 192_000,
      codedSamples: 195_584,
      leadingSamples: 2_112,
    };
    expect(outputGaplessForAudioEncoder(AAC_CONFIG, timing)).toEqual({
      leadingSamples: 2_112,
      trailingSamples: 1_472,
      totalSamples: 192_000,
    });
  });

  it('cannot reuse a source MP3 LAME delay as the newly encoded AAC delay', () => {
    const sourceMp3Gapless: NonNullable<TrackInfo['gapless']> = {
      leadingSamples: 576,
      trailingSamples: 913,
      totalSamples: 110_255,
    };
    const destinationTiming: AudioEncoderOutputTiming = {
      sampleRate: 48_000,
      submittedSamples: sourceMp3Gapless.totalSamples as number,
      codedSamples: 113_664,
      leadingSamples: 2_112,
    };
    const output = outputGaplessForAudioEncoder(AAC_CONFIG, destinationTiming);
    expect(output?.leadingSamples).toBe(2_112);
    expect(output?.leadingSamples).not.toBe(sourceMp3Gapless.leadingSamples);
    expect(output?.totalSamples).toBe(110_255);
  });

  it('declines incomplete, inconsistent, or wrong-clock facts instead of guessing', () => {
    expect(
      outputGaplessForAudioEncoder(AAC_CONFIG, {
        sampleRate: 48_000,
        submittedSamples: 10_000,
        codedSamples: 12_288,
      }),
    ).toBeUndefined();
    expect(
      outputGaplessForAudioEncoder(AAC_CONFIG, {
        sampleRate: 44_100,
        submittedSamples: 10_000,
        codedSamples: 13_312,
        leadingSamples: 2_112,
      }),
    ).toBeUndefined();
    expect(
      outputGaplessForAudioEncoder(AAC_CONFIG, {
        sampleRate: 48_000,
        submittedSamples: 12_000,
        codedSamples: 13_312,
        leadingSamples: 2_112,
      }),
    ).toBeUndefined();
  });

  it('turns the MP3 encoder lead-in and whole-frame capacity into a trimmable window', () => {
    // 240 000 program samples at 48 kHz cost LAME 210 whole MPEG-1 frames (241 920 samples) once its
    // 1105-sample lead-in is in front of them; the balance is the terminal padding a muxer must trim.
    expect(
      outputGaplessForAudioEncoder(
        { codec: 'mp3', sampleRate: 48_000, numberOfChannels: 2 },
        {
          sampleRate: 48_000,
          submittedSamples: 240_000,
          codedSamples: 241_920,
          leadingSamples: 1_105,
        },
      ),
    ).toEqual({ leadingSamples: 1_105, trailingSamples: 815, totalSamples: 240_000 });
  });

  it('declines an MP3 encode that proved no lead-in rather than muxing it untrimmed', () => {
    expect(
      outputGaplessForAudioEncoder(
        { codec: 'mp3', sampleRate: 48_000, numberOfChannels: 2 },
        { sampleRate: 48_000, submittedSamples: 240_000, codedSamples: 241_920 },
      ),
    ).toBeUndefined();
  });

  it('combines Opus pre-skip with coded capacity to derive exact terminal padding', () => {
    expect(
      outputGaplessForAudioEncoder(
        { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
        {
          sampleRate: 48_000,
          submittedSamples: 48_000,
          codedSamples: 48_960,
          leadingSamples: 312,
        },
      ),
    ).toEqual({ leadingSamples: 312, trailingSamples: 648, totalSamples: 48_000 });
  });
});
