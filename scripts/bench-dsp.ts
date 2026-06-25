#!/usr/bin/env bun
/**
 * scripts/bench-dsp.ts — fresh, multi-sample benchmark for the pure-TS audio-dsp core
 * (BUILD_INSTRUCTIONS §6: "every op has a multi-sample benchmark … wall, throughputRealtime,
 * peakMemory … measured across several real §6.1 corpus files, not one"; doc 09 §audio-dsp).
 *
 * It runs the real kernels — **resample** (up & down), **gain**, **remix** (both BS.775 directions),
 * and **format-convert** (decode/encode/convert PCM) — on **every real WAV in the corpus** (≥ 5 files,
 * never one), and records, per op × file:
 *
 *   - **wall**              — median ms per op over {@link ITERS} timed iterations (warmup discarded),
 *   - **throughputRealtime**— audio-seconds processed per wall-second (× realtime; "Nx faster than playback"),
 *   - **peakMemory**        — peak RSS growth (MB) over the op's iterations vs a gc'd baseline,
 *   - **mSamplesPerSec**    — raw sample throughput.
 *
 * Wall and memory are measured in **separate passes** (RSS sampling must not perturb the timed loop). A
 * checksum sink reads a real output value each iteration so the optimizer cannot elide the work (no
 * N/A→0 metric, §6.5). The full table prints to stdout and a machine-readable baseline is written to
 * `fixtures/golden/bench/audio-dsp.json` so a regression gate has something to compare against.
 *
 *   bun run bench-dsp                 # run + print + (re)write the baseline
 *   bun run bench-dsp --check         # run + print + diff vs the committed baseline (non-zero on regress)
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readWavPcm } from '../src/drivers/wav/pcm.ts';
import { gain } from '../src/dsp/gain.ts';
import { remix } from '../src/dsp/mix.ts';
import { decodePcm, encodePcm } from '../src/dsp/pcm.ts';
import { resample } from '../src/dsp/resample.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/audio-dsp.json`;

const WARMUP = 20;
const ITERS = 200;
/** Beyond ±this fraction slower than the committed baseline wall, `--check` flags a regression. */
const REGRESSION_TOLERANCE = 0.5;

let sink = 0; // accumulate a byte from each result to defeat dead-code elimination

// ============ stats / timing ============

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Time `fn` over {@link ITERS} runs (after {@link WARMUP}); return the median nanoseconds per run. */
function timeNs(fn: () => number): number {
  for (let i = 0; i < WARMUP; i++) sink = (sink + fn()) | 0;
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = Bun.nanoseconds();
    sink = (sink + fn()) | 0;
    samples.push(Bun.nanoseconds() - t0);
  }
  return median(samples);
}

/**
 * Peak resident-set growth (bytes) while running `fn` {@link ITERS} times, versus a forced-gc baseline
 * taken first. A separate pass from {@link timeNs} so RSS sampling never perturbs the wall measurement.
 */
function peakRssBytes(fn: () => number): number {
  Bun.gc(true);
  const base = process.memoryUsage().rss;
  let peak = base;
  for (let i = 0; i < ITERS; i++) {
    sink = (sink + fn()) | 0;
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }
  return Math.max(0, peak - base);
}

// ============ measured op record ============

interface OpResult {
  op: string;
  /** Samples touched per op invocation (frames × channels of the worked-on buffer). */
  samples: number;
  /** Seconds of audio the worked-on buffer represents (frames / sampleRate). */
  audioSeconds: number;
  wallMs: number;
  throughputRealtime: number;
  mSamplesPerSec: number;
  peakMemoryMb: number;
}

/** Measure one op (wall pass + memory pass) and fold both into an {@link OpResult}. */
function measure(op: string, samples: number, audioSeconds: number, fn: () => number): OpResult {
  const ns = timeNs(fn);
  const peakBytes = peakRssBytes(fn);
  const wallSeconds = ns / 1e9;
  return {
    op,
    samples,
    audioSeconds,
    wallMs: ns / 1e6,
    throughputRealtime: audioSeconds / wallSeconds,
    mSamplesPerSec: samples / wallSeconds / 1e6,
    peakMemoryMb: peakBytes / (1024 * 1024),
  };
}

interface FileResult {
  id: string;
  format: string;
  channels: number;
  sampleRate: number;
  frames: number;
  ops: OpResult[];
}

// ============ the op set, per file ============

/** A resample target that is never the source rate (so up- and down-sampling are both exercised, never a no-op). */
function resampleTarget(sampleRate: number): number {
  return sampleRate === 48000 ? 44100 : 48000;
}

function benchFile(id: string, bytes: Uint8Array): FileResult {
  const audio = readWavPcm(bytes); // WavPcm: PcmAudio + the source `format` (for the report)
  const { frames, channels, sampleRate } = audio;
  const samples = frames * channels;
  const audioSeconds = sampleRate > 0 ? frames / sampleRate : 0;
  const s16 = encodePcm(audio, 's16'); // canonical interleaved s16 bytes to decode from
  const stereo = remix(audio, channels === 1 ? 2 : channels); // a 2ch buffer to exercise the downmix
  const target = resampleTarget(sampleRate);
  // Resample output buffer is longer/shorter than the input; report against input samples (the work unit).

  const ops: OpResult[] = [
    measure(
      'decode s16 → planar',
      samples,
      audioSeconds,
      () => decodePcm(s16, 's16', channels, sampleRate).frames,
    ),
    measure('encode planar → s16', samples, audioSeconds, () => encodePcm(audio, 's16')[0] ?? 0),
    measure('convert → f32', samples, audioSeconds, () => encodePcm(audio, 'f32')[0] ?? 0),
    measure('gain (-6 dB)', samples, audioSeconds, () => gain(audio, -6).planar.length),
    measure('remix mono → stereo', samples, audioSeconds, () => remix(audio, 2).channels),
    measure(
      'remix stereo → mono',
      stereo.frames * stereo.channels,
      audioSeconds,
      () => remix(stereo, 1).channels,
    ),
    measure(
      `resample ${sampleRate} → ${target}`,
      samples,
      audioSeconds,
      () => resample(audio, target).frames,
    ),
  ];
  return { id, format: audio.format, channels, sampleRate, frames, ops };
}

// ============ reporting ============

function printFile(r: FileResult): void {
  console.info(
    `\n${r.id} — ${r.frames} frames × ${r.channels}ch @ ${r.sampleRate} Hz (${r.format}, ${(r.frames / r.sampleRate).toFixed(3)}s)`,
  );
  console.info(
    `  ${'op'.padEnd(24)} ${'wall(ms)'.padStart(9)} ${'×realtime'.padStart(11)} ${'Msmpl/s'.padStart(9)} ${'peakMem(MB)'.padStart(12)}`,
  );
  for (const o of r.ops) {
    console.info(
      `  ${o.op.padEnd(24)} ${o.wallMs.toFixed(3).padStart(9)} ${o.throughputRealtime.toFixed(0).padStart(10)}× ${o.mSamplesPerSec.toFixed(1).padStart(9)} ${o.peakMemoryMb.toFixed(2).padStart(12)}`,
    );
  }
}

/** Per-op aggregate across all files: the geomean ×realtime and the worst (min) ×realtime + peak memory. */
interface OpAggregate {
  op: string;
  files: number;
  geomeanRealtime: number;
  minRealtime: number;
  maxPeakMemoryMb: number;
}

function aggregate(results: readonly FileResult[]): OpAggregate[] {
  const byOp = new Map<string, OpResult[]>();
  for (const r of results) {
    for (const o of r.ops) {
      // Group resample variants (which embed the rate) under one stable label.
      const key = o.op.startsWith('resample') ? 'resample (rate change)' : o.op;
      (byOp.get(key) ?? byOp.set(key, []).get(key) ?? []).push(o);
    }
  }
  const out: OpAggregate[] = [];
  for (const [op, list] of byOp) {
    const logSum = list.reduce((s, o) => s + Math.log(o.throughputRealtime), 0);
    out.push({
      op,
      files: list.length,
      geomeanRealtime: Math.exp(logSum / list.length),
      minRealtime: list.reduce(
        (m, o) => Math.min(m, o.throughputRealtime),
        Number.POSITIVE_INFINITY,
      ),
      maxPeakMemoryMb: list.reduce((m, o) => Math.max(m, o.peakMemoryMb), 0),
    });
  }
  return out;
}

function printAggregates(aggs: readonly OpAggregate[]): void {
  console.info('\n=== per-op aggregate across all corpus files ===');
  console.info(
    `  ${'op'.padEnd(24)} ${'files'.padStart(5)} ${'geomean×rt'.padStart(11)} ${'worst×rt'.padStart(9)} ${'maxMem(MB)'.padStart(11)}`,
  );
  for (const a of aggs) {
    console.info(
      `  ${a.op.padEnd(24)} ${String(a.files).padStart(5)} ${a.geomeanRealtime.toFixed(0).padStart(10)}× ${a.minRealtime.toFixed(0).padStart(8)}× ${a.maxPeakMemoryMb.toFixed(2).padStart(11)}`,
    );
  }
}

// ============ baseline record ============

interface Baseline {
  generatedAt: string;
  runtime: string;
  warmup: number;
  iters: number;
  files: FileResult[];
  aggregates: OpAggregate[];
}

function buildBaseline(files: FileResult[], aggregates: OpAggregate[]): Baseline {
  return {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    warmup: WARMUP,
    iters: ITERS,
    files,
    aggregates,
  };
}

/** Compare fresh aggregates against the committed baseline; return the regressed op labels (if any). */
function regressions(fresh: readonly OpAggregate[], base: Baseline): string[] {
  const baseByOp = new Map(base.aggregates.map((a) => [a.op, a]));
  const regressed: string[] = [];
  for (const a of fresh) {
    const b = baseByOp.get(a.op);
    if (b === undefined) continue;
    // A drop in geomean ×realtime beyond the tolerance is a regression (slower than baseline).
    if (a.geomeanRealtime < b.geomeanRealtime * (1 - REGRESSION_TOLERANCE)) {
      regressed.push(
        `${a.op}: ${a.geomeanRealtime.toFixed(0)}× vs baseline ${b.geomeanRealtime.toFixed(0)}×`,
      );
    }
  }
  return regressed;
}

// ============ main ============

async function wavFixtures(): Promise<string[]> {
  const all = await readdir(MEDIA_DIR);
  const wavs = all.filter((f) => f.endsWith('.wav')).sort();
  if (wavs.length < 5) {
    throw new Error(
      `audio-dsp benchmark needs ≥ 5 real WAV fixtures (BUILD_INSTRUCTIONS §6.1); found ${wavs.length}. Run \`bun run fetch-fixtures\`.`,
    );
  }
  return wavs;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const ids = await wavFixtures();
  console.info(
    `audio-dsp benchmark — pure TS, single-thread, median of ${ITERS} iters (warmup ${WARMUP}); ${ids.length} real corpus files:`,
  );

  const results: FileResult[] = [];
  for (const id of ids) {
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${id}`).arrayBuffer());
    const r = benchFile(id, bytes);
    results.push(r);
    printFile(r);
  }

  const aggs = aggregate(results);
  printAggregates(aggs);
  console.info(`\n(checksum ${sink})`);

  if (check) {
    const base = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
    const regressed = regressions(aggs, base);
    if (regressed.length > 0) {
      console.error(`\nREGRESSION vs ${BASELINE_PATH} (> ${REGRESSION_TOLERANCE * 100}% slower):`);
      for (const r of regressed) console.error(`  - ${r}`);
      process.exit(1);
    }
    console.info(`\nno regression vs baseline (${base.generatedAt}).`);
    return;
  }

  await mkdir(dirname(BASELINE_PATH), { recursive: true });
  await writeFile(BASELINE_PATH, `${JSON.stringify(buildBaseline(results, aggs), null, 2)}\n`);
  console.info(`\nbaseline written → ${BASELINE_PATH}`);
}

await main();
