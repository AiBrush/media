#!/usr/bin/env bun
/**
 * Image-probe throughput benchmark on the REAL downloaded image corpus (BUILD §6.3: every feature ships
 * a fresh, multi-sample benchmark — not one file, not a cached number). Reports per-format median latency
 * (median of 7 batch means), probes/sec, MB/s, peak RSS growth in a separate pass, and a machine-readable
 * baseline with a `--check` regression gate.
 *
 *   bun run bench-image                 # run + print + (re)write the baseline
 *   bun run bench-image --check         # run + print + diff vs the committed baseline
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { probeImage } from '../src/codecs/image/probe.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = `${ROOT}fixtures/media-derived/img`;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/image.json`;

const FILES = ['test.png', 'test.jpeg', 'test.webp', 'anim2.gif', 'test.avif'] as const;
const WARMUP = 500;
const BATCH = 4000;
const SAMPLES = 7;
const MEMORY_ITERS = 10000;
/** Beyond ±this fraction slower than the committed baseline probes/sec, `--check` flags a regression. */
const REGRESSION_TOLERANCE = 0.5;

let sink = 0; // accumulate parsed facts so the optimizer cannot elide probe work

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function foldProbe(bytes: Uint8Array): number {
  const info = probeImage(bytes);
  return (
    info.width ^ info.height ^ info.frameCount ^ Math.round((info.durationSec ?? 0) * 1_000_000)
  );
}

function timeNs(bytes: Uint8Array): number {
  for (let i = 0; i < WARMUP; i++) sink = (sink + foldProbe(bytes)) | 0;
  const means: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < BATCH; i++) sink = (sink + foldProbe(bytes)) | 0;
    means.push((Bun.nanoseconds() - t0) / BATCH);
  }
  return median(means);
}

function peakRssBytes(bytes: Uint8Array): number {
  Bun.gc(true);
  const base = process.memoryUsage().rss;
  let peak = base;
  for (let i = 0; i < MEMORY_ITERS; i++) {
    sink = (sink + foldProbe(bytes)) | 0;
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }
  return Math.max(0, peak - base);
}

interface FileResult {
  id: string;
  format: string;
  width: number;
  height: number;
  frames: number;
  durationSec?: number;
  bytes: number;
  wallUs: number;
  probesPerSec: number;
  mbps: number;
  peakMemoryMb: number;
}

async function benchFile(id: string): Promise<FileResult> {
  const bytes = new Uint8Array(await Bun.file(`${DIR}/${id}`).arrayBuffer());
  const ns = timeNs(bytes);
  const peak = peakRssBytes(bytes);
  const info = probeImage(bytes);
  const seconds = ns / 1e9;
  return {
    id,
    format: info.format,
    width: info.width,
    height: info.height,
    frames: info.frameCount,
    ...(info.durationSec !== undefined ? { durationSec: info.durationSec } : {}),
    bytes: bytes.byteLength,
    wallUs: ns / 1e3,
    probesPerSec: 1 / seconds,
    mbps: bytes.byteLength / 1e6 / seconds,
    peakMemoryMb: peak / (1024 * 1024),
  };
}

interface Aggregate {
  files: number;
  geomeanProbesPerSec: number;
  minProbesPerSec: number;
  maxPeakMemoryMb: number;
}

function aggregate(results: readonly FileResult[]): Aggregate {
  const logSum = results.reduce((sum, r) => sum + Math.log(r.probesPerSec), 0);
  return {
    files: results.length,
    geomeanProbesPerSec: Math.exp(logSum / results.length),
    minProbesPerSec: results.reduce(
      (min, r) => Math.min(min, r.probesPerSec),
      Number.POSITIVE_INFINITY,
    ),
    maxPeakMemoryMb: results.reduce((max, r) => Math.max(max, r.peakMemoryMb), 0),
  };
}

interface Baseline {
  generatedAt: string;
  runtime: string;
  warmup: number;
  batch: number;
  samples: number;
  memoryIters: number;
  files: FileResult[];
  aggregate: Aggregate;
}

function buildBaseline(files: FileResult[], agg: Aggregate): Baseline {
  return {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    warmup: WARMUP,
    batch: BATCH,
    samples: SAMPLES,
    memoryIters: MEMORY_ITERS,
    files,
    aggregate: agg,
  };
}

function regressions(fresh: Aggregate, base: Baseline): string[] {
  if (fresh.geomeanProbesPerSec < base.aggregate.geomeanProbesPerSec * (1 - REGRESSION_TOLERANCE)) {
    return [
      `image-probe: ${fresh.geomeanProbesPerSec.toFixed(0)} probes/s vs baseline ${base.aggregate.geomeanProbesPerSec.toFixed(0)} probes/s`,
    ];
  }
  return [];
}

function printFile(r: FileResult): void {
  const duration = r.durationSec === undefined ? '-' : `${r.durationSec.toFixed(3)}s`;
  console.info(
    `  ${r.id.padEnd(11)} ${r.wallUs.toFixed(2).padStart(7)} us  ${r.probesPerSec.toFixed(0).padStart(9)} probe/s  ${r.mbps.toFixed(0).padStart(7)} MB/s  ${r.peakMemoryMb.toFixed(2).padStart(8)} MB  ` +
      `${r.format}/${r.width}x${r.height}/${r.frames}f/${duration}/${r.bytes}B`,
  );
}

function printAggregate(agg: Aggregate): void {
  console.info(
    `\n  aggregate: ${agg.geomeanProbesPerSec.toFixed(0)} probes/s geomean, ` +
      `${agg.minProbesPerSec.toFixed(0)} probes/s worst, ${agg.maxPeakMemoryMb.toFixed(2)} MB max peak`,
  );
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  if (FILES.length < 5) {
    throw new Error(`image benchmark needs >= 5 real image fixtures; found ${FILES.length}`);
  }
  console.info(
    `image-probe benchmark — median of ${SAMPLES} batch-means (${BATCH} probes/batch, warmup ${WARMUP}) on ${FILES.length} real media files:\n`,
  );

  const results: FileResult[] = [];
  for (const file of FILES) {
    const result = await benchFile(file);
    results.push(result);
    printFile(result);
  }
  const agg = aggregate(results);
  printAggregate(agg);
  console.info(`\n(checksum ${sink})`);

  if (check) {
    const base = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
    const regressed = regressions(agg, base);
    if (regressed.length > 0) {
      console.error(`\nREGRESSION vs ${BASELINE_PATH} (> ${REGRESSION_TOLERANCE * 100}% slower):`);
      for (const r of regressed) console.error(`  - ${r}`);
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
