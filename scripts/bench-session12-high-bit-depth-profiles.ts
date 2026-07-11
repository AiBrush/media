#!/usr/bin/env bun
/**
 * Fresh multi-sample benchmark for VP9/AV1 profile+level config planning and bit-depth lifecycle
 * classification. This is pure planning overhead; browser encoder throughput remains covered by the real-media
 * encode benchmarks and focused browser proof.
 *
 *   bun scripts/bench-session12-high-bit-depth-profiles.ts
 *   bun scripts/bench-session12-high-bit-depth-profiles.ts --check
 */

import { readFile } from 'node:fs/promises';
import {
  type SourceGeometry,
  buildVideoEncoderConfig,
  isPureStreamCopy,
} from '../src/api/codec-pipeline.ts';
import type { VideoTarget } from '../src/api/types.ts';
import {
  planVideoBitDepthConversion,
  videoTargetPixelBoundaryBitDepth,
} from '../src/api/video-stream-plan.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/high-bit-depth-profiles.json`;
const WARMUP = 5;
const SAMPLES = 21;
const ITERATIONS = 10_000;
const MEMORY_ITERATIONS = 50_000;
const REGRESSION_TOLERANCE = 0.5;
const MEMORY_SLACK_BYTES = 8 * 1024 * 1024;
let checksum = 0;

interface ConfigCase {
  readonly target: VideoTarget;
  readonly source: SourceGeometry;
  readonly sourceCodec?: string;
  readonly expectedCodec: string;
}

interface Scenario {
  readonly name: string;
  readonly plansPerIteration: number;
  readonly run: () => number;
}

interface ScenarioResult {
  readonly name: string;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly plansPerSec: number;
  readonly peakProcessHeapMb: number;
}

interface Baseline {
  readonly generatedAt: string;
  readonly runtime: string;
  readonly warmup: number;
  readonly samples: number;
  readonly iterations: number;
  readonly scenarios: readonly ScenarioResult[];
  readonly geomeanPlansPerSec: number;
}

const SOURCE_1080: SourceGeometry = { width: 1920, height: 1080, fps: 30 };

const configCases: readonly ConfigCase[] = [
  {
    target: { codec: 'vp9', width: 1280, height: 720, fps: 30 },
    source: SOURCE_1080,
    expectedCodec: 'vp09.00.40.08',
  },
  {
    target: { codec: 'vp9', width: 1920, height: 1080, fps: 60 },
    source: SOURCE_1080,
    expectedCodec: 'vp09.00.50.08',
  },
  {
    target: { codec: 'vp9', width: 3840, height: 2160, fps: 30 },
    source: SOURCE_1080,
    expectedCodec: 'vp09.00.52.08',
  },
  {
    target: { codec: 'vp9', width: 7680, height: 4320, fps: 60 },
    source: SOURCE_1080,
    expectedCodec: 'vp09.00.62.08',
  },
  {
    target: { codec: 'av1', width: 1280, height: 720, fps: 30 },
    source: SOURCE_1080,
    expectedCodec: 'av01.0.08M.08',
  },
  {
    target: { codec: 'av1', width: 1920, height: 1080, fps: 60 },
    source: SOURCE_1080,
    expectedCodec: 'av01.0.12M.08',
  },
  {
    target: { codec: 'av1', width: 3840, height: 2160, fps: 30 },
    source: SOURCE_1080,
    expectedCodec: 'av01.0.17M.08',
  },
  {
    target: { codec: 'av1', width: 7680, height: 4320, fps: 60 },
    source: SOURCE_1080,
    expectedCodec: 'av01.0.18M.08',
  },
  {
    target: { codec: 'vp9', width: 1280, height: 720, bitDepth: 10 },
    source: SOURCE_1080,
    expectedCodec: 'vp09.02.40.10',
  },
  {
    target: { codec: 'vp9', width: 1280, height: 720, bitDepth: 12 },
    source: SOURCE_1080,
    expectedCodec: 'vp09.02.40.12',
  },
  {
    target: { codec: 'av1', width: 1280, height: 720, bitDepth: 10 },
    source: SOURCE_1080,
    expectedCodec: 'av01.0.08M.10',
  },
  {
    target: { codec: 'av1', width: 1280, height: 720, bitDepth: 12 },
    source: SOURCE_1080,
    expectedCodec: 'av01.2.05M.12',
  },
  {
    target: { codec: 'vp9', width: 1280, height: 720, bitrate: 50_000_000 },
    source: SOURCE_1080,
    expectedCodec: 'vp09.00.50.08',
  },
  {
    target: { codec: 'av1', width: 1280, height: 720, bitrate: 50_000_000 },
    source: SOURCE_1080,
    expectedCodec: 'av01.0.14M.08',
  },
  {
    target: { codec: 'av1', width: 1280, height: 720, bitrate: 50_000_000, bitDepth: 12 },
    source: SOURCE_1080,
    expectedCodec: 'av01.2.09M.12',
  },
  {
    target: { width: 1280, height: 720, bitDepth: 12 },
    source: SOURCE_1080,
    sourceCodec: 'vp09.00.31.08',
    expectedCodec: 'vp09.02.40.12',
  },
];

function hashText(seed: number, value: string): number {
  let hash = seed;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  return hash | 0;
}

function runConfigMatrix(): number {
  let hash = 2_166_136_261;
  for (const testCase of configCases) {
    const config = buildVideoEncoderConfig(testCase.target, testCase.source, testCase.sourceCodec);
    if (config.codec !== testCase.expectedCodec) {
      throw new Error(`config oracle: ${config.codec} != ${testCase.expectedCodec}`);
    }
    hash = hashText(hash, config.codec);
    hash = Math.imul(hash ^ config.width ^ config.height, 16_777_619);
  }
  return hash;
}

function runLifecycleMatrix(): number {
  const plans = [
    planVideoBitDepthConversion({ sourceBitDepth: 8, targetBitDepth: 8 }),
    planVideoBitDepthConversion({ sourceBitDepth: 8, targetBitDepth: 10 }),
    planVideoBitDepthConversion({ sourceBitDepth: 8, targetBitDepth: 12 }),
    planVideoBitDepthConversion({ sourceBitDepth: 10, targetBitDepth: 12 }),
    planVideoBitDepthConversion({ sourceBitDepth: 10, targetBitDepth: 8 }),
    planVideoBitDepthConversion({ sourceBitDepth: 12, targetBitDepth: 8 }),
    planVideoBitDepthConversion({
      sourceBitDepth: 12,
      targetBitDepth: 8,
      pixelPathBitDepth: 8,
    }),
  ];
  const targets: readonly VideoTarget[] = [
    { crop: { x: 0, y: 0, width: 1280, height: 720 } },
    { width: 1280, height: 720 },
    { pad: { width: 2560, height: 1440 } },
    { rotate: 90 },
    { flip: 'h' },
    { colorspace: { to: 'bt2020' } },
    { tonemap: { to: 'sdr' } },
    { alpha: 'keep' },
    { fps: 24 },
  ];
  let hash = 2_166_136_261;
  for (const plan of plans) {
    hash = hashText(hash, plan.kind);
    hash = Math.imul(hash ^ Number(plan.requiresPixelPath), 16_777_619);
  }
  for (const target of targets) {
    hash = Math.imul(
      hash ^ (videoTargetPixelBoundaryBitDepth(target, SOURCE_1080) ?? 0),
      16_777_619,
    );
  }
  hash = Math.imul(
    hash ^ (videoTargetPixelBoundaryBitDepth({}, SOURCE_1080, true) ?? 0),
    16_777_619,
  );
  return hash;
}

function runRouteGuardMatrix(): number {
  const reencodeTargets: readonly VideoTarget[] = [
    { fit: 'contain' },
    { bitDepth: 10 },
    { bitrateMode: 'constant' },
    { twoPass: true },
    { alpha: 'discard' },
  ];
  let hash = 2_166_136_261;
  for (const target of reencodeTargets) {
    const pureCopy = isPureStreamCopy({ video: target });
    if (pureCopy) throw new Error('declared video work bypassed the encode planner');
    hash = Math.imul(hash ^ Number(pureCopy), 16_777_619);
  }
  const explicitNoTwoPass = isPureStreamCopy({ video: { twoPass: false } });
  if (!explicitNoTwoPass) throw new Error('twoPass:false became fictional encode work');
  return Math.imul(hash ^ Number(explicitNoTwoPass), 16_777_619);
}

const scenarios: readonly Scenario[] = [
  {
    name: 'profile-level config matrix',
    plansPerIteration: configCases.length,
    run: runConfigMatrix,
  },
  {
    name: 'depth and filter lifecycle matrix',
    plansPerIteration: 17,
    run: runLifecycleMatrix,
  },
  {
    name: 'public encode-route guard matrix',
    plansPerIteration: 6,
    run: runRouteGuardMatrix,
  },
];

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1);
  return ordered[Math.max(0, index)] ?? 0;
}

function runBatch(scenario: Scenario, iterations: number): void {
  for (let index = 0; index < iterations; index++) checksum = (checksum + scenario.run()) | 0;
}

function peakProcessHeap(scenario: Scenario): number {
  Bun.gc(true);
  let peak = process.memoryUsage().heapUsed;
  for (let index = 0; index < MEMORY_ITERATIONS; index++) {
    checksum = (checksum + scenario.run()) | 0;
    if ((index & 63) === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
  }
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  if (peak <= 0) throw new Error(`${scenario.name}: memory sample was not positive`);
  return peak;
}

function measure(scenario: Scenario): ScenarioResult {
  for (let sample = 0; sample < WARMUP; sample++) runBatch(scenario, ITERATIONS);
  const elapsed: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const started = Bun.nanoseconds();
    runBatch(scenario, ITERATIONS);
    elapsed.push((Bun.nanoseconds() - started) / 1_000_000);
  }
  const medianMs = percentile(elapsed, 0.5);
  return {
    name: scenario.name,
    medianMs,
    p95Ms: percentile(elapsed, 0.95),
    plansPerSec: (scenario.plansPerIteration * ITERATIONS) / (medianMs / 1_000),
    peakProcessHeapMb: peakProcessHeap(scenario) / (1024 * 1024),
  };
}

function geomean(results: readonly ScenarioResult[]): number {
  return Math.exp(
    results.reduce((sum, result) => sum + Math.log(result.plansPerSec), 0) / results.length,
  );
}

function regressions(results: readonly ScenarioResult[], prior: Baseline): string[] {
  const priorByName = new Map(prior.scenarios.map((result) => [result.name, result]));
  const failures: string[] = [];
  for (const result of results) {
    const before = priorByName.get(result.name);
    if (before === undefined) {
      failures.push(`${result.name}: missing baseline row`);
      continue;
    }
    if (result.plansPerSec < before.plansPerSec * (1 - REGRESSION_TOLERANCE)) {
      failures.push(
        `${result.name}: ${result.plansPerSec.toFixed(0)} plans/s vs ${before.plansPerSec.toFixed(0)} baseline`,
      );
    }
    const freshHeap = result.peakProcessHeapMb * 1024 * 1024;
    const priorHeap = before.peakProcessHeapMb * 1024 * 1024;
    if (freshHeap > priorHeap * 3 + MEMORY_SLACK_BYTES) {
      failures.push(
        `${result.name}: ${result.peakProcessHeapMb.toFixed(2)} MB heap vs ${before.peakProcessHeapMb.toFixed(2)} MB baseline`,
      );
    }
  }
  return failures;
}

const results = scenarios.map(measure);
for (const result of results) {
  console.info(
    `${result.name.padEnd(34)} ${result.medianMs.toFixed(3).padStart(9)} ms  ` +
      `${result.plansPerSec.toFixed(0).padStart(10)} plans/s  p95 ${result.p95Ms.toFixed(3)} ms  ` +
      `process-heap ${result.peakProcessHeapMb.toFixed(2)} MB`,
  );
}

const fresh: Baseline = {
  generatedAt: new Date().toISOString(),
  runtime: `bun ${Bun.version}`,
  warmup: WARMUP,
  samples: SAMPLES,
  iterations: ITERATIONS,
  scenarios: results,
  geomeanPlansPerSec: geomean(results),
};
console.info(
  `aggregate ${fresh.geomeanPlansPerSec.toFixed(0)} plans/s geomean; checksum ${checksum}`,
);

if (process.argv.includes('--check')) {
  const prior = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
  const failures = regressions(results, prior);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`REGRESSION: ${failure}`);
    process.exit(1);
  }
  console.info(`no regression vs ${prior.generatedAt}`);
} else {
  console.info(`BASELINE_JSON=${JSON.stringify(fresh)}`);
}
