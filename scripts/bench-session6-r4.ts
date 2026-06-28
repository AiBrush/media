#!/usr/bin/env bun
/**
 * Session 6 R4 focused benchmark:
 * - CRF/quantizer and bitrate/two-pass rate-control planning.
 * - 10-bit→8-bit bit-depth planning.
 * - H.264 ABR ladder normalization.
 * - Tiny 1x1 H.264 encoder config.
 * - Codec-specific WebCodecs quantizer encode-option generation.
 *
 * This is deliberately package-local and Node-visible: it does not pretend to measure browser WebCodecs
 * encode throughput, and it does not edit/register the sibling browser benchmark adapter.
 */

import { buildVideoEncoderConfig } from '../src/api/codec-pipeline.ts';
import {
  planH264AbrLadder,
  planVideoBitDepthConversion,
  planVideoRateControl,
} from '../src/api/video-stream-plan.ts';
import { videoEncodeOptions } from '../src/codecs/webcodecs-video.ts';

const WARMUP = 5;
const ITERS = 51;
const OPS_PER_SAMPLE = 5_000;

interface BenchResult {
  readonly name: string;
  readonly medianMs: number;
  readonly opsPerSec: number;
  readonly checksum: number;
  readonly samples: readonly number[];
}

let sink = 0;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function elapsedMs(startNs: number): number {
  return (Number(Bun.nanoseconds()) - startNs) / 1_000_000;
}

async function runBench(name: string, fn: () => number): Promise<BenchResult> {
  for (let i = 0; i < WARMUP; i++) sink = (sink + fn()) | 0;
  const samples: number[] = [];
  let checksum = 0;
  for (let sample = 0; sample < ITERS; sample++) {
    const start = Number(Bun.nanoseconds());
    let local = 0;
    for (let op = 0; op < OPS_PER_SAMPLE; op++) local = (local + fn()) | 0;
    checksum = (checksum + local) | 0;
    samples.push(elapsedMs(start));
  }
  const medianMs = median(samples);
  return {
    name,
    medianMs,
    opsPerSec: OPS_PER_SAMPLE / (medianMs / 1_000),
    checksum,
    samples,
  };
}

function benchCrfConfig(): number {
  const sizes = [
    { width: 320, height: 180, fps: 30 },
    { width: 1280, height: 720, fps: 30 },
    { width: 1920, height: 1080, fps: 60 },
  ] as const;
  let checksum = 0;
  for (const size of sizes) {
    const config = buildVideoEncoderConfig(
      { codec: 'h264', crf: 23, fps: size.fps },
      size,
      undefined,
    );
    checksum += config.codec.length + config.width + config.height;
    checksum += config.bitrateMode === 'quantizer' ? 101 : 0;
  }
  return checksum;
}

function benchRatePlans(): number {
  const plans = [
    planVideoRateControl({ bitrate: 3_000_000 }, 'avc1.42E01E'),
    planVideoRateControl({ bitrate: 3_000_000, twoPass: true }, 'avc1.42E01E'),
    planVideoRateControl({ crf: 23 }, 'avc1.42E01E'),
    planVideoRateControl({ crf: 31 }, 'vp09.00.10.08'),
    planVideoRateControl({ crf: 23 }, 'vp8'),
  ];
  return plans.reduce((sum, plan) => {
    if (plan.mode === 'default') return sum + 1;
    if (plan.mode === 'bitrate') return sum + plan.bitrate;
    if (plan.mode === 'two-pass-bitrate') return sum + plan.bitrate + plan.passes;
    return sum + plan.crf + (plan.webCodecsConfigurable ? 17 : 3);
  }, 0);
}

function benchBitDepthPlans(): number {
  const plans = [
    planVideoBitDepthConversion({
      sourceCodec: 'avc1.6E0033',
      targetCodec: 'avc1.42E028',
    }),
    planVideoBitDepthConversion({
      sourceCodec: 'vp09.00.10.10',
      targetCodec: 'av01.0.04M.08',
    }),
    planVideoBitDepthConversion({
      sourceCodec: 'avc1.42E01E',
      targetCodec: 'avc1.42E028',
    }),
  ];
  return plans.reduce(
    (sum, plan) =>
      sum +
      (plan.sourceBitDepth ?? 0) * 31 +
      (plan.targetBitDepth ?? 0) * 17 +
      (plan.requiresPixelPath ? 7 : 0),
    0,
  );
}

function benchH264AbrPlan(): number {
  const ladder = planH264AbrLadder(
    [
      { name: '1080p', width: 1920, height: 1080, bitrate: 5_000_000, fps: 30 },
      { name: '720p', width: 1280, height: 720, bitrate: 3_000_000, fps: 30 },
      { name: '540p', width: 960, height: 540, bitrate: 1_600_000, fps: 30 },
      { name: '360p', width: 640, height: 360, bitrate: 800_000, fps: 30 },
      { name: 'tiny', width: 1, height: 1, bitrate: 50_000, fps: 30 },
    ],
    { width: 1920, height: 1080 },
  );
  return ladder.reduce(
    (sum, rung) =>
      sum +
      rung.name.length +
      rung.config.codec.length +
      rung.config.width +
      rung.config.height +
      rung.options.video.bitrate,
    0,
  );
}

function benchTinyH264Config(): number {
  const config = buildVideoEncoderConfig(
    { codec: 'h264', width: 1, height: 1, fps: 30, bitDepth: 8 },
    { width: 1920, height: 1080 },
    undefined,
  );
  return config.codec.length + config.width + config.height + (config.framerate ?? 0);
}

function benchQuantizerEncodeOptions(): number {
  const codecs = ['avc1.42E01E', 'hvc1.1.6.L93.B0', 'vp09.00.10.08', 'av01.0.04M.08'] as const;
  let checksum = 0;
  for (let i = 0; i < codecs.length; i++) {
    const codec = codecs[i];
    if (codec === undefined) throw new Error('codec fixture missing');
    const opts = videoEncodeOptions(i, 2, codec, 23 + i);
    checksum += opts.keyFrame ? 11 : 3;
    checksum +=
      opts.avc?.quantizer ??
      opts.hevc?.quantizer ??
      opts.vp9?.quantizer ??
      opts.av1?.quantizer ??
      0;
  }
  return checksum;
}

async function main(): Promise<void> {
  const results = await Promise.all([
    runBench('r4.crf-config-h264', benchCrfConfig),
    runBench('r4.rate-plan-matrix', benchRatePlans),
    runBench('r4.bit-depth-plan', benchBitDepthPlans),
    runBench('r4.h264-abr-plan', benchH264AbrPlan),
    runBench('r4.tiny-h264-config', benchTinyH264Config),
    runBench('r4.quantizer-encode-options', benchQuantizerEncodeOptions),
  ]);
  for (const result of results) {
    console.log(
      `${result.name}: median=${result.medianMs.toFixed(4)}ms/${OPS_PER_SAMPLE} ops ` +
        `opsPerSec=${result.opsPerSec.toFixed(0)} checksum=${result.checksum}`,
    );
  }
  const aggregate = results.reduce((sum, result) => sum + Math.log(result.opsPerSec), 0);
  console.log(`geomeanOpsPerSec=${Math.exp(aggregate / results.length).toFixed(0)} sink=${sink}`);
}

await main();
