#!/usr/bin/env bun
/**
 * Pure colorspace-kernel benchmark for C7 matrix coverage. This measures the Node-validatable color math
 * (`applyColorPlanToRgba`) over RGBA stress buffers derived from the real image corpus dimensions/bytes.
 * It is intentionally *not* a browser GPU/media throughput claim; decoded-pixel/WebGPU timing belongs to
 * the browser harness. The value here is a local regression gate for the shared 709/2020/601 matrix path.
 *
 *   bun run bench-colorspace              # run + print + (re)write the baseline
 *   bun run bench-colorspace --check      # run + print + diff vs the committed baseline
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { probeImage } from '../src/codecs/image/probe.ts';
import { type RgbaImage, applyColorPlanToRgba } from '../src/filters/cpu-video.ts';
import { type ColorPlan, planColorspace } from '../src/filters/gpu-uniforms.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/colorspace.json`;
const FILES = [
  'fixtures/media/img-still.png',
  'fixtures/media/img-still.jpg',
  'fixtures/media/img-still.webp',
  'fixtures/media/img-anim2.gif',
  'fixtures/media/img-still.avif',
] as const;

const WARMUP = 3;
const ITERS = 21;
const REGRESSION_TOLERANCE = 0.5;

let sink = 0;

interface Fixture {
  readonly id: string;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly bytes: number;
  readonly image: RgbaImage;
}

interface Op {
  readonly name: string;
  readonly plan: ColorPlan;
}

interface OpResult {
  readonly op: string;
  readonly fixtures: number;
  readonly pixels: number;
  readonly wallMs: number;
  readonly megapixelsPerSec: number;
  readonly peakMemoryMb: number;
}

interface Aggregate {
  readonly ops: number;
  readonly fixtures: number;
  readonly megapixels: number;
  readonly geomeanMegapixelsPerSec: number;
  readonly minMegapixelsPerSec: number;
  readonly maxPeakMemoryMb: number;
}

interface Baseline {
  readonly generatedAt: string;
  readonly runtime: string;
  readonly warmup: number;
  readonly iters: number;
  readonly fixtures: readonly Omit<Fixture, 'image'>[];
  readonly ops: readonly OpResult[];
  readonly aggregate: Aggregate;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function rgbaFromEncodedBytes(id: string, bytes: Uint8Array): Fixture {
  if (bytes.byteLength === 0) throw new Error(`${id} is empty`);
  const info = probeImage(bytes);
  const pixels = info.width * info.height;
  const data = new Uint8ClampedArray(pixels * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const src = i * 3;
    data[o] = view.getUint8(src % view.byteLength);
    data[o + 1] = view.getUint8((src + 1) % view.byteLength);
    data[o + 2] = view.getUint8((src + 2) % view.byteLength);
    data[o + 3] = 255;
  }
  return {
    id,
    format: info.format,
    width: info.width,
    height: info.height,
    pixels,
    bytes: bytes.byteLength,
    image: { data, width: info.width, height: info.height },
  };
}

async function loadFixtures(): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];
  for (const file of FILES) {
    const bytes = new Uint8Array(await Bun.file(`${ROOT}${file}`).arrayBuffer());
    fixtures.push(rgbaFromEncodedBytes(file, bytes));
  }
  return fixtures;
}

function foldImage(image: RgbaImage): number {
  const view = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const mid = Math.max(0, Math.floor(view.byteLength / 2) - 1);
  return (
    view.getUint8(0) ^
    view.getUint8(mid) ^
    view.getUint8(view.byteLength - 1) ^
    image.width ^
    image.height
  );
}

function applyToCorpus(fixtures: readonly Fixture[], plan: ColorPlan): number {
  let pixels = 0;
  for (const fixture of fixtures) {
    const out = applyColorPlanToRgba(plan, fixture.image);
    sink = (sink + foldImage(out)) | 0;
    pixels += fixture.pixels;
  }
  return pixels;
}

function timeNs(fixtures: readonly Fixture[], plan: ColorPlan): number {
  for (let i = 0; i < WARMUP; i++) sink = (sink + applyToCorpus(fixtures, plan)) | 0;
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = Bun.nanoseconds();
    sink = (sink + applyToCorpus(fixtures, plan)) | 0;
    samples.push(Bun.nanoseconds() - t0);
  }
  return median(samples);
}

function peakRssBytes(fixtures: readonly Fixture[], plan: ColorPlan): number {
  Bun.gc(true);
  const base = process.memoryUsage().rss;
  let peak = base;
  for (let i = 0; i < ITERS; i++) {
    sink = (sink + applyToCorpus(fixtures, plan)) | 0;
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }
  return Math.max(0, peak - base);
}

function measure(fixtures: readonly Fixture[], op: Op): OpResult {
  const pixels = fixtures.reduce((sum, fixture) => sum + fixture.pixels, 0);
  const ns = timeNs(fixtures, op.plan);
  const peak = peakRssBytes(fixtures, op.plan);
  const seconds = ns / 1e9;
  return {
    op: op.name,
    fixtures: fixtures.length,
    pixels,
    wallMs: ns / 1e6,
    megapixelsPerSec: pixels / 1e6 / seconds,
    peakMemoryMb: peak / (1024 * 1024),
  };
}

function aggregate(results: readonly OpResult[]): Aggregate {
  const logSum = results.reduce((sum, result) => sum + Math.log(result.megapixelsPerSec), 0);
  return {
    ops: results.length,
    fixtures: results[0]?.fixtures ?? 0,
    megapixels: results.reduce((sum, result) => sum + result.pixels / 1e6, 0),
    geomeanMegapixelsPerSec: Math.exp(logSum / results.length),
    minMegapixelsPerSec: results.reduce(
      (min, result) => Math.min(min, result.megapixelsPerSec),
      Number.POSITIVE_INFINITY,
    ),
    maxPeakMemoryMb: results.reduce((max, result) => Math.max(max, result.peakMemoryMb), 0),
  };
}

function fixtureSummary(fixture: Fixture): Omit<Fixture, 'image'> {
  return {
    id: fixture.id,
    format: fixture.format,
    width: fixture.width,
    height: fixture.height,
    pixels: fixture.pixels,
    bytes: fixture.bytes,
  };
}

function buildBaseline(fixtures: readonly Fixture[], ops: readonly OpResult[]): Baseline {
  return {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    warmup: WARMUP,
    iters: ITERS,
    fixtures: fixtures.map(fixtureSummary),
    ops,
    aggregate: aggregate(ops),
  };
}

function regressions(fresh: readonly OpResult[], base: Baseline): string[] {
  const baseByOp = new Map(base.ops.map((op) => [op.op, op]));
  const out: string[] = [];
  for (const op of fresh) {
    const b = baseByOp.get(op.op);
    if (b !== undefined && op.megapixelsPerSec < b.megapixelsPerSec * (1 - REGRESSION_TOLERANCE)) {
      out.push(
        `${op.op}: ${op.megapixelsPerSec.toFixed(1)} MP/s vs baseline ${b.megapixelsPerSec.toFixed(1)} MP/s`,
      );
    }
  }
  return out;
}

function printOp(result: OpResult): void {
  console.info(
    `  ${result.op.padEnd(30)} ${result.wallMs.toFixed(3).padStart(9)} ms  ${result.megapixelsPerSec.toFixed(1).padStart(9)} MP/s  ${result.peakMemoryMb.toFixed(2).padStart(8)} MB`,
  );
}

function printAggregate(agg: Aggregate): void {
  console.info(
    `\n  aggregate: ${agg.geomeanMegapixelsPerSec.toFixed(1)} MP/s geomean, ` +
      `${agg.minMegapixelsPerSec.toFixed(1)} MP/s worst, ${agg.maxPeakMemoryMb.toFixed(2)} MB max peak`,
  );
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const fixtures = await loadFixtures();
  if (fixtures.length < 5) {
    throw new Error(`colorspace benchmark needs >= 5 corpus fixtures; found ${fixtures.length}`);
  }
  const ops: readonly Op[] = [
    {
      name: 'colorspace rgba 709->2020',
      plan: planColorspace({ primaries: 'bt709', transfer: 'bt709' }, 'bt2020'),
    },
    {
      name: 'colorspace rgba 2020->709',
      plan: planColorspace({ primaries: 'bt2020', transfer: 'bt709' }, 'bt709'),
    },
    {
      name: 'colorspace rgba 601->2020',
      plan: planColorspace({ primaries: 'bt601', transfer: 'bt709' }, 'bt2020'),
    },
    {
      name: 'colorspace rgba 2020->601',
      plan: planColorspace({ primaries: 'bt2020', transfer: 'bt709' }, 'bt601'),
    },
  ];

  console.info(
    `colorspace kernel benchmark — median of ${ITERS} iters (warmup ${WARMUP}) on ${fixtures.length} real-corpus image fixtures:\n`,
  );
  for (const fixture of fixtures) {
    console.info(
      `  fixture ${fixture.id} ${fixture.format}/${fixture.width}x${fixture.height}/${fixture.bytes}B`,
    );
  }
  console.info('');

  const results = ops.map((op) => measure(fixtures, op));
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
  await writeFile(BASELINE_PATH, `${JSON.stringify(buildBaseline(fixtures, results), null, 2)}\n`);
  console.info(`\nbaseline written -> ${BASELINE_PATH}`);
}

await main();
