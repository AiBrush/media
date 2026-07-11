#!/usr/bin/env bun

import type { PcmAudio } from '../src/dsp/pcm.ts';
import { resample } from '../src/dsp/resample.ts';

const SAMPLE_RATE = 48_000;
const FRAMES = SAMPLE_RATE;
const WARMUP = 3;
const SAMPLES = 21;

const planar = [new Float64Array(FRAMES), new Float64Array(FRAMES)];
for (let frame = 0; frame < FRAMES; frame++) {
  const left = planar[0];
  const right = planar[1];
  if (left === undefined || right === undefined) throw new Error('stereo fixture missing');
  left[frame] = Math.sin(frame * 0.021) * 0.8;
  right[frame] = Math.cos(frame * 0.017) * 0.7;
}
const audio: PcmAudio = { sampleRate: SAMPLE_RATE, channels: 2, frames: FRAMES, planar };
let sink = 0;

function execute(): number {
  const output = resample(audio, 44_100);
  return output.planar[0]?.[output.frames - 1] ?? 0;
}

for (let index = 0; index < WARMUP; index++) sink += execute();
const elapsed: number[] = [];
for (let sample = 0; sample < SAMPLES; sample++) {
  const start = Bun.nanoseconds();
  sink += execute();
  elapsed.push((Bun.nanoseconds() - start) / 1_000_000);
}
elapsed.sort((a, b) => a - b);
const medianMs = elapsed[elapsed.length >>> 1] ?? 0;
console.log(
  `resample.stereo-48k-to-44k1: median=${medianMs.toFixed(3)}ms ` +
    `realtime=${(1_000 / medianMs).toFixed(1)}x sink=${sink.toFixed(9)}`,
);
