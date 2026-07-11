#!/usr/bin/env bun
/**
 * Declarative job-runner overhead benchmark (ADR-010). This measures whole-job schema validation,
 * compilation/fusion, flat-op dispatch, Blob handoff, progress/cancellation setup, and typed preflight
 * rejection through a fresh dependency host. It deliberately does not relabel fake host work as codec or
 * container throughput; those paths retain their real-media benchmarks.
 *
 *   bun run scripts/bench-session12-job-runner.ts          # print fresh result + baseline JSON
 *   bun run scripts/bench-session12-job-runner.ts --check  # compare with committed baseline
 */

import { readFile } from 'node:fs/promises';
import { runMediaJob } from '../src/api/job-runner.ts';
import type { JobEngine, MediaJob } from '../src/api/job.ts';
import type { Cancellable, Output } from '../src/api/types.ts';
import { InputError } from '../src/contracts/errors.ts';
import type { Sink } from '../src/sinks/sink.ts';
import type { MediaInput } from '../src/sources/source.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/job-runner.json`;
const WARMUP = 5;
const SAMPLES = 21;
const ITERATIONS = 1_000;
const MEMORY_ITERATIONS = 5_000;
const REGRESSION_TOLERANCE = 0.5;
const MEMORY_SLACK_BYTES = 8 * 1024 * 1024;
const INPUT = new Uint8Array([1, 2, 3, 4]);
const PAYLOAD = new Uint8Array([9, 8, 7, 6]);
let checksum = 0;

const documentedJob: MediaJob = {
  input: INPUT,
  ops: [
    { op: 'trim', start: 0, end: 5 },
    { op: 'resize', width: 1280, height: 720 },
  ],
  output: {
    container: 'mp4',
    video: { codec: 'h264', bitrate: 2_000_000 },
    audio: { codec: 'aac' },
    faststart: true,
  },
};

const fusedJob: MediaJob = {
  input: INPUT,
  ops: [
    { op: 'crop', x: 2, y: 4, width: 640, height: 360 },
    { op: 'resize', width: 320, height: 180, fit: 'cover' },
    { op: 'pad', width: 352, height: 208 },
    { op: 'rotate', degrees: 90 },
    { op: 'flip', axis: 'h' },
    { op: 'colorspace', to: 'bt709' },
    { op: 'tonemap' },
  ],
  output: { container: 'webm', video: { codec: 'vp9' }, audio: false },
};

const boundaryJob: MediaJob = {
  input: INPUT,
  ops: [
    { op: 'resize', width: 640, height: 360 },
    { op: 'crop', x: 0, y: 0, width: 320, height: 180 },
    { op: 'convert', to: 'webm', video: { codec: 'vp9' } },
    { op: 'remux', to: 'mkv', tags: { title: 'job-bench' } },
  ],
  output: { container: 'mp4', video: { codec: 'h264' }, audio: false },
};

const malformedJob = {
  input: INPUT,
  ops: [
    { op: 'trim', start: 0, end: 1 },
    { op: 'resize', width: Number.NaN, height: 180 },
  ],
  output: { container: 'mp4' },
} as MediaJob;

interface Scenario {
  readonly name: string;
  readonly run: (engine: JobEngine) => Promise<number>;
}

interface ScenarioResult {
  readonly name: string;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly jobsPerSec: number;
  readonly peakProcessHeapMb: number;
}

interface Baseline {
  readonly generatedAt: string;
  readonly runtime: string;
  readonly warmup: number;
  readonly samples: number;
  readonly iterations: number;
  readonly scenarios: readonly ScenarioResult[];
  readonly geomeanJobsPerSec: number;
}

const scenarios: readonly Scenario[] = [
  { name: 'documented trim+resize+output', run: (engine) => runValid(engine, documentedJob) },
  { name: 'canonical seven-transform fusion', run: (engine) => runValid(engine, fusedJob) },
  { name: 'unsafe order plus Blob boundaries', run: (engine) => runValid(engine, boundaryJob) },
  { name: 'whole-job typed preflight reject', run: (engine) => runInvalid(engine, malformedJob) },
];

function fakeEngine(): JobEngine {
  return {
    convert(input, opts) {
      return resolved(fakeBlob(input, opts.sink, 'convert'));
    },
    trim(input, opts) {
      return resolved(fakeBlob(input, opts.sink, 'trim'));
    },
    remux(input, opts) {
      return resolved(fakeBlob(input, opts.sink, 'remux'));
    },
    decrypt(input, opts) {
      return resolved(fakeBlob(input, opts.sink, 'decrypt'));
    },
  };
}

function resolved<T>(value: T): Cancellable<T> {
  const promise = Promise.resolve(value) as Cancellable<T>;
  promise.cancel = (): void => undefined;
  return promise;
}

function fakeBlob(input: MediaInput, sink: Sink | undefined, operation: string): Output {
  if (sink !== undefined && sink.kind !== 'blob') {
    throw new Error(`job benchmark received non-Blob intermediate sink '${sink.kind}'`);
  }
  checksum = (checksum + operation.length + inputWeight(input)) | 0;
  return new Blob([PAYLOAD]);
}

function inputWeight(input: MediaInput): number {
  if (input instanceof Uint8Array) return input.byteLength;
  if (input instanceof Blob) return input.size;
  return 1;
}

async function runValid(engine: JobEngine, job: MediaJob): Promise<number> {
  const result = await runMediaJob(engine, job);
  checksum = (checksum + result.size) | 0;
  return result.size;
}

async function runInvalid(engine: JobEngine, job: MediaJob): Promise<number> {
  try {
    await runMediaJob(engine, job);
  } catch (error) {
    if (error instanceof InputError && error.code === 'unsupported-input') {
      checksum = (checksum + error.message.length) | 0;
      return 1;
    }
    throw error;
  }
  throw new Error('job benchmark malformed plan unexpectedly succeeded');
}

async function runBatch(scenario: Scenario, iterations: number): Promise<void> {
  const engine = fakeEngine();
  for (let index = 0; index < iterations; index++) checksum += await scenario.run(engine);
}

function percentile(samples: readonly number[], quantile: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1);
  return ordered[Math.max(0, index)] ?? 0;
}

async function peakProcessHeap(scenario: Scenario): Promise<number> {
  Bun.gc(true);
  let peak = process.memoryUsage().heapUsed;
  const engine = fakeEngine();
  for (let index = 0; index < MEMORY_ITERATIONS; index++) {
    checksum += await scenario.run(engine);
    if ((index & 63) === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
  }
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  return peak;
}

async function measure(scenario: Scenario): Promise<ScenarioResult> {
  for (let sample = 0; sample < WARMUP; sample++) await runBatch(scenario, ITERATIONS);
  const elapsed: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const started = Bun.nanoseconds();
    await runBatch(scenario, ITERATIONS);
    elapsed.push((Bun.nanoseconds() - started) / 1_000_000);
  }
  const medianMs = percentile(elapsed, 0.5);
  return {
    name: scenario.name,
    medianMs,
    p95Ms: percentile(elapsed, 0.95),
    jobsPerSec: ITERATIONS / (medianMs / 1_000),
    peakProcessHeapMb: (await peakProcessHeap(scenario)) / (1024 * 1024),
  };
}

function geomean(results: readonly ScenarioResult[]): number {
  const logs = results.reduce((sum, result) => sum + Math.log(result.jobsPerSec), 0);
  return Math.exp(logs / results.length);
}

function baseline(results: readonly ScenarioResult[]): Baseline {
  return {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    warmup: WARMUP,
    samples: SAMPLES,
    iterations: ITERATIONS,
    scenarios: results,
    geomeanJobsPerSec: geomean(results),
  };
}

function regressions(results: readonly ScenarioResult[], prior: Baseline): string[] {
  const byName = new Map(prior.scenarios.map((result) => [result.name, result]));
  const failures: string[] = [];
  for (const result of results) {
    const before = byName.get(result.name);
    if (before === undefined) {
      failures.push(`${result.name}: missing baseline row`);
      continue;
    }
    if (result.jobsPerSec < before.jobsPerSec * (1 - REGRESSION_TOLERANCE)) {
      failures.push(
        `${result.name}: ${result.jobsPerSec.toFixed(0)} jobs/s vs ${before.jobsPerSec.toFixed(0)} baseline`,
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

const results: ScenarioResult[] = [];
for (const scenario of scenarios) {
  const result = await measure(scenario);
  results.push(result);
  console.info(
    `${result.name.padEnd(38)} ${result.medianMs.toFixed(3).padStart(9)} ms/1k  ` +
      `${result.jobsPerSec.toFixed(0).padStart(9)} jobs/s  p95 ${result.p95Ms.toFixed(3)} ms  ` +
      `process-heap ${result.peakProcessHeapMb.toFixed(2)} MB`,
  );
}
const fresh = baseline(results);
console.info(
  `aggregate ${fresh.geomeanJobsPerSec.toFixed(0)} jobs/s geomean; checksum ${checksum}`,
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
