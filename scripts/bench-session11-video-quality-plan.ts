#!/usr/bin/env bun
/** Session 11 video-quality planner benchmark: rate control, filter plans, and total-pixel routing cost. */

import { buildVideoEncoderConfig } from '../src/api/codec-pipeline.ts';
import { videoFilterRouteCost, videoFilterSpecs } from '../src/api/video-stream-plan.ts';

const WARMUP = 3;
const SAMPLES = 9;
const PLANS_PER_SAMPLE = 100_000;

interface Sample {
  readonly elapsedMs: number;
  readonly checksum: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

function runSample(): Sample {
  const started = performance.now();
  let checksum = 0;
  for (let index = 0; index < PLANS_PER_SAMPLE; index++) {
    const h264 = buildVideoEncoderConfig(
      { codec: 'h264', width: 1280, height: 720, fps: 30 },
      { width: 1920, height: 1080 },
      undefined,
    );
    const vp8 = buildVideoEncoderConfig(
      { codec: 'vp8', width: 640, height: 360 },
      { width: 1920, height: 1080 },
      undefined,
    );
    const explicit = buildVideoEncoderConfig(
      { codec: 'h264', bitrate: 2_000_000 },
      { width: 1920, height: 1080 },
      undefined,
    );
    const noOp = videoFilterSpecs({ width: 1280, height: 720 }, { width: 1280, height: 720 });
    const resize = videoFilterSpecs({ width: 1280, height: 720 }, { width: 1920, height: 1080 });
    const short4k = videoFilterRouteCost(
      { width: 1920, height: 1080 },
      { width: 3840, height: 2160, fps: 30, durationSec: 0.1 },
    );
    const tinyDuration360p = videoFilterRouteCost(
      { width: 320, height: 180 },
      { width: 640, height: 360, fps: 30, durationSec: 1 / 30 },
    );
    const resize1080p = videoFilterRouteCost(
      { width: 1280, height: 720 },
      { width: 1920, height: 1080, fps: 30, durationSec: 1 },
    );
    const fpsUp = videoFilterRouteCost(
      { fps: 30 },
      { width: 640, height: 360, fps: 15, durationSec: 1 },
    );
    const fpsDown = videoFilterRouteCost(
      { fps: 15 },
      { width: 640, height: 360, fps: 30, durationSec: 1 },
    );
    checksum =
      (checksum +
        (h264.bitrate ?? 0) +
        (vp8.bitrate ?? 0) +
        (explicit.bitrate ?? 0) +
        noOp.length * 131 +
        resize.length * 257 +
        Math.trunc(short4k.videoPixelWork ?? 0) +
        Math.trunc(tinyDuration360p.videoPixelWork ?? 0) +
        Math.trunc(resize1080p.videoPixelWork ?? 0) +
        Math.trunc(fpsUp.videoPixelWork ?? 0) +
        Math.trunc(fpsDown.videoPixelWork ?? 0) +
        (short4k.videoFrames ?? 0) * 17 +
        (fpsUp.videoFrames ?? 0) * 31 +
        index) >>>
      0;
  }
  return { elapsedMs: performance.now() - started, checksum };
}

function main(): void {
  const timings: number[] = [];
  let checksum = 0;
  for (let index = 0; index < WARMUP + SAMPLES; index++) {
    const sample = runSample();
    checksum = (checksum + sample.checksum) >>> 0;
    if (index >= WARMUP) timings.push(sample.elapsedMs);
  }
  const before = process.memoryUsage().rss;
  const memorySample = runSample();
  checksum = (checksum + memorySample.checksum) >>> 0;
  const peakMemoryMb = Math.max(0, process.memoryUsage().rss - before) / (1024 * 1024);
  console.info(
    `Session 11 video-quality planning — ${PLANS_PER_SAMPLE} mixed rate/filter/work plans; ` +
      `median=${median(timings).toFixed(3)} ms; peakRSS+=${peakMemoryMb.toFixed(2)} MiB; ` +
      `checksum=${checksum}; samples=[${timings.map((ms) => ms.toFixed(3)).join(', ')}]`,
  );
}

main();
