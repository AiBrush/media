#!/usr/bin/env bun
/**
 * Public `media.preload(...)` warmup benchmark (BUILD §6: every shipped op gets a fresh, multi-sample
 * benchmark). Units are **warmups/sec**, not bytes/sec: preload does not process media payload bytes.
 *
 * Rows:
 *   - default probe warmup: imports/registers the lazy default driver bundle and warms common container
 *     probes.
 *   - convert ready h264/aac/mp4: warms target container, codec, filter, and predicted AAC wasm paths.
 *   - decode mp3 wasm compile path: exercises the predicted WASM compile warmup path; the warmup phase
 *     performs the first same-session compile/load, while timed samples track the memoized path app code
 *     pays when it repeats an already-completed preload.
 *   - idempotent repeat: measures the no-op cost after an identical spec has already completed.
 *
 *   bun run bench-preload              # run + print + (re)write the baseline
 *   bun run bench-preload --check      # run + print + diff vs the committed baseline
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createMedia } from '../src/api/create-media.ts';
import type { PreloadSpec } from '../src/api/types.ts';
import { resetMp3CoreForTest } from '../src/codecs/wasm-mp3/wasm-mp3-driver.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/preload.json`;

const WARMUP = 3;
const ITERS = 21;
const REGRESSION_TOLERANCE = 0.5;

let sink = 0;

const CONVERT_READY_SPEC = {
  op: 'convert',
  video: 'h264',
  audio: 'aac',
  container: 'mp4',
  level: 'ready',
} as const satisfies PreloadSpec;

const MP3_COMPILE_SPEC = {
  op: 'decode',
  audio: 'mp3',
  level: 'compile',
} as const satisfies PreloadSpec;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

async function timeNs(fn: () => Promise<number>): Promise<number> {
  for (let i = 0; i < WARMUP; i++) sink = (sink + (await fn())) | 0;
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = Bun.nanoseconds();
    sink = (sink + (await fn())) | 0;
    samples.push(Bun.nanoseconds() - t0);
  }
  return median(samples);
}

async function peakRssBytes(fn: () => Promise<number>): Promise<number> {
  Bun.gc(true);
  const base = process.memoryUsage().rss;
  let peak = base;
  for (let i = 0; i < ITERS; i++) {
    sink = (sink + (await fn())) | 0;
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }
  return Math.max(0, peak - base);
}

interface OpResult {
  op: string;
  wallMs: number;
  warmupsPerSec: number;
  peakMemoryMb: number;
}

async function measure(op: string, fn: () => Promise<number>): Promise<OpResult> {
  const ns = await timeNs(fn);
  const peak = await peakRssBytes(fn);
  const seconds = ns / 1e9;
  return {
    op,
    wallMs: ns / 1e6,
    warmupsPerSec: 1 / seconds,
    peakMemoryMb: peak / (1024 * 1024),
  };
}

async function benchDefaultProbe(): Promise<number> {
  await createMedia().preload('probe');
  return 1;
}

async function benchConvertReady(): Promise<number> {
  await createMedia().preload(CONVERT_READY_SPEC);
  return 2;
}

async function benchMp3Compile(): Promise<number> {
  resetMp3CoreForTest();
  await createMedia().preload(MP3_COMPILE_SPEC);
  return 3;
}

async function benchIdempotentRepeat(): Promise<number> {
  const media = createMedia();
  await media.preload(CONVERT_READY_SPEC);
  await media.preload(CONVERT_READY_SPEC);
  return 4;
}

interface Aggregate {
  ops: number;
  geomeanWarmupsPerSec: number;
  minWarmupsPerSec: number;
  maxPeakMemoryMb: number;
}

function aggregate(results: readonly OpResult[]): Aggregate {
  const logSum = results.reduce((sum, result) => sum + Math.log(result.warmupsPerSec), 0);
  return {
    ops: results.length,
    geomeanWarmupsPerSec: Math.exp(logSum / results.length),
    minWarmupsPerSec: results.reduce(
      (min, result) => Math.min(min, result.warmupsPerSec),
      Number.POSITIVE_INFINITY,
    ),
    maxPeakMemoryMb: results.reduce((max, result) => Math.max(max, result.peakMemoryMb), 0),
  };
}

interface Baseline {
  generatedAt: string;
  runtime: string;
  warmup: number;
  iters: number;
  ops: OpResult[];
  aggregate: Aggregate;
}

function buildBaseline(ops: OpResult[], agg: Aggregate): Baseline {
  return {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    warmup: WARMUP,
    iters: ITERS,
    ops,
    aggregate: agg,
  };
}

function regressions(fresh: readonly OpResult[], base: Baseline): string[] {
  const baseByOp = new Map(base.ops.map((op) => [op.op, op]));
  const out: string[] = [];
  for (const op of fresh) {
    const b = baseByOp.get(op.op);
    if (b === undefined) continue;
    if (op.warmupsPerSec < b.warmupsPerSec * (1 - REGRESSION_TOLERANCE)) {
      out.push(
        `${op.op}: ${op.warmupsPerSec.toFixed(0)} warmups/s vs baseline ${b.warmupsPerSec.toFixed(0)} warmups/s`,
      );
    }
  }
  return out;
}

function printOp(result: OpResult): void {
  console.info(
    `  ${result.op.padEnd(32)} ${result.wallMs.toFixed(3).padStart(9)} ms  ${result.warmupsPerSec.toFixed(0).padStart(9)} warmups/s  ${result.peakMemoryMb.toFixed(2).padStart(8)} MB`,
  );
}

function printAggregate(agg: Aggregate): void {
  console.info(
    `\n  aggregate: ${agg.geomeanWarmupsPerSec.toFixed(0)} warmups/s geomean, ` +
      `${agg.minWarmupsPerSec.toFixed(0)} warmups/s worst, ${agg.maxPeakMemoryMb.toFixed(2)} MB max peak`,
  );
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  console.info(
    `preload benchmark — median of ${ITERS} iters (warmup ${WARMUP}); units are warmups/sec:\n`,
  );
  const results = [
    await measure('preload default probe', benchDefaultProbe),
    await measure('preload ready h264/aac/mp4', benchConvertReady),
    await measure('preload compile mp3 wasm path', benchMp3Compile),
    await measure('preload idempotent repeat', benchIdempotentRepeat),
  ];
  for (const result of results) printOp(result);
  const agg = aggregate(results);
  printAggregate(agg);
  console.info(`\n(checksum ${sink})`);

  if (check) {
    const base = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
    const regressed = regressions(results, base);
    if (regressed.length > 0) {
      console.error(`\nREGRESSION vs ${BASELINE_PATH} (> ${REGRESSION_TOLERANCE * 100}% slower):`);
      for (const item of regressed) console.error(`  - ${item}`);
      process.exit(1);
    }
    console.info(`\nno regression vs baseline (${base.generatedAt}).`);
    return;
  }

  await mkdir(dirname(BASELINE_PATH), { recursive: true });
  await writeFile(BASELINE_PATH, `${JSON.stringify(buildBaseline(results, agg), null, 2)}\n`);
  console.info(`\nbaseline written -> ${BASELINE_PATH}`);
}

await main();
