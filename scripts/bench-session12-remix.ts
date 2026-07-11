#!/usr/bin/env bun

import { remix } from '../src/dsp/mix.ts';
import type { PcmAudio } from '../src/dsp/pcm.ts';

const SAMPLE_RATE = 48_000;
const FRAMES = SAMPLE_RATE * 10;
const WARMUP = 5;
const SAMPLES = 51;

let sink = 0;

function fixture(channels: number): PcmAudio {
  return {
    sampleRate: SAMPLE_RATE,
    channels,
    frames: FRAMES,
    planar: Array.from({ length: channels }, (_, channel) => {
      const samples = new Float64Array(FRAMES);
      for (let frame = 0; frame < FRAMES; frame++) {
        samples[frame] = Math.sin((frame + channel * 17) * 0.017) * (1 - channel * 0.05);
      }
      return samples;
    }),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >>> 1] ?? 0;
}

function run(name: string, audio: PcmAudio, channels: number): void {
  const execute = (): number => {
    const output = remix(audio, channels);
    return output.planar[0]?.[output.frames - 1] ?? 0;
  };
  for (let index = 0; index < WARMUP; index++) sink += execute();
  const elapsed: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = Bun.nanoseconds();
    sink += execute();
    elapsed.push((Bun.nanoseconds() - start) / 1_000_000);
  }
  const medianMs = median(elapsed);
  const inputSamples = audio.frames * audio.channels;
  console.log(
    `${name}: median=${medianMs.toFixed(3)}ms throughput=${(inputSamples / (medianMs / 1_000) / 1_000_000).toFixed(1)}Msamples/s`,
  );
}

const stereo = fixture(2);
const surround = fixture(6);
run('remix.stereo-to-mono', stereo, 1);
run('remix.surround-to-stereo', surround, 2);
run('remix.surround-to-mono', surround, 1);
console.log(`sink=${sink.toFixed(6)}`);
