#!/usr/bin/env bun
/**
 * scripts/bench-audio-stream.ts — fresh, multi-sample benchmark for the **stream-stateful** audio-dsp
 * stages (BUILD_INSTRUCTIONS §6.3; doc 09 §audio-dsp; ADR — lossy-seam audio filter). These are the
 * streaming twins (`fadeStage`/`biquadStage`/`dynamicsStage`) of the whole-signal kernels that let
 * fade/biquad/dynamics cross the **codec seam** — fed a *stream of PcmAudio chunks* (the `AudioData` the
 * engine decodes) rather than one buffer, carrying state across chunk boundaries.
 *
 * It drives each stage over **realistic codec-seam chunk sizes** (1024-frame access units, the AAC frame
 * size) on **every real WAV in the corpus** (≥ 5 files, never one) and records, per op × file:
 *
 *   - **wall**              — median ms to stream the whole file through the staged chunks (warmup discarded),
 *   - **throughputRealtime**— audio-seconds processed per wall-second (× realtime; "Nx faster than playback"),
 *   - **mSamplesPerSec**    — raw sample throughput,
 *   - **peakMemory**        — peak RSS growth (MB) over the op's iterations vs a gc'd baseline,
 *   - **chunkOverhead**     — chunked-stream wall ÷ whole-signal-kernel wall (the cost of streaming state).
 *
 * Wall and memory are measured in **separate passes** (RSS sampling must not perturb the timed loop). A
 * checksum sink reads a real output value each iteration so the optimizer cannot elide the work (no
 * N/A→0 metric, §6.5). The full table prints to stdout and a machine-readable baseline is written to
 * `fixtures/golden/bench/audio-stream.json` so a regression gate has something to compare against.
 *
 *   bun run bench-audio-stream            # run + print + (re)write the baseline
 *   bun run bench-audio-stream --check    # run + print + diff vs the committed baseline (non-zero on regress)
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readWavPcm } from '../src/drivers/wav/pcm.ts';
import { biquad } from '../src/dsp/biquad.ts';
import { limit, normalizeRms } from '../src/dsp/dynamics.ts';
import { fadeOut } from '../src/dsp/fade.ts';
import type { PcmAudio } from '../src/dsp/pcm.ts';
import {
  type StatefulAudioStage,
  biquadStage,
  dynamicsStage,
  fadeStage,
} from '../src/dsp/stream.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/audio-stream.json`;

const WARMUP = 10;
const ITERS = 60;
/** The codec-seam access-unit size we chunk by (AAC frame = 1024 samples); realistic decoder output. */
const CHUNK_FRAMES = 1024;
/** Beyond ±this fraction slower than the committed baseline wall, `--check` flags a regression. */
const REGRESSION_TOLERANCE = 0.5;

let sink = 0; // accumulate a value from each result to defeat dead-code elimination

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

/** Peak resident-set growth (bytes) over {@link ITERS} runs vs a forced-gc baseline (separate pass). */
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

// ============ chunked driver ============

/** Split `audio` into consecutive `CHUNK_FRAMES`-frame chunks (the realistic decoder access-unit stream). */
function chunkBy(audio: PcmAudio, size: number): PcmAudio[] {
  const chunks: PcmAudio[] = [];
  for (let start = 0; start < audio.frames; start += size) {
    const n = Math.min(size, audio.frames - start);
    chunks.push({
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      frames: n,
      planar: audio.planar.map((ch) => ch.subarray(start, start + n)),
    });
  }
  return chunks;
}

/** Drive a freshly-built stage over the pre-split chunks; return a checksum of the first output sample. */
function drive(makeStage: () => StatefulAudioStage, chunks: readonly PcmAudio[]): number {
  const stage = makeStage();
  let acc = 0;
  for (const c of chunks) {
    for (const out of stage.push(c)) acc += out.planar[0]?.[0] ?? 0;
  }
  for (const out of stage.flush()) acc += out.planar[0]?.[0] ?? 0;
  return acc | 0;
}

// ============ measured op record ============

interface OpResult {
  op: string;
  samples: number;
  audioSeconds: number;
  wallMs: number;
  throughputRealtime: number;
  mSamplesPerSec: number;
  peakMemoryMb: number;
  /** Chunked-stream wall ÷ whole-signal-kernel wall — the streaming-state overhead factor (≈1 is ideal). */
  chunkOverhead: number;
}

/** Measure one streaming op: a timed pass, a memory pass, and a whole-signal baseline for the overhead. */
function measure(
  op: string,
  samples: number,
  audioSeconds: number,
  makeStage: () => StatefulAudioStage,
  chunks: readonly PcmAudio[],
  whole: () => number,
): OpResult {
  const ns = timeNs(() => drive(makeStage, chunks));
  const wholeNs = timeNs(whole);
  const peakBytes = peakRssBytes(() => drive(makeStage, chunks));
  const wallSeconds = ns / 1e9;
  return {
    op,
    samples,
    audioSeconds,
    wallMs: ns / 1e6,
    throughputRealtime: audioSeconds / wallSeconds,
    mSamplesPerSec: samples / wallSeconds / 1e6,
    peakMemoryMb: peakBytes / (1024 * 1024),
    chunkOverhead: wholeNs > 0 ? ns / wholeNs : 0,
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

function eqFrequency(sampleRate: number): number {
  return Math.min(1000, sampleRate / 4);
}

function benchFile(id: string, bytes: Uint8Array): FileResult {
  const audio = readWavPcm(bytes);
  const { frames, channels, sampleRate, format } = audio;
  const samples = frames * channels;
  const audioSeconds = sampleRate > 0 ? frames / sampleRate : 0;
  const chunks = chunkBy(audio, CHUNK_FRAMES);
  const fadeN = Math.round(0.5 * sampleRate); // a 0.5 s fade-out tail (the look-ahead buffer)
  const eqSpec = { type: 'highpass' as const, frequency: eqFrequency(sampleRate), q: Math.SQRT1_2 };

  const ops: OpResult[] = [
    measure(
      'fade-out (0.5s, equal-power)',
      samples,
      audioSeconds,
      () => fadeStage({ curve: 'equal-power', inFrames: 0, outFrames: fadeN }),
      chunks,
      () => fadeOut(audio, fadeN, 'equal-power').frames,
    ),
    measure(
      'biquad highpass (DF2T, stateful)',
      samples,
      audioSeconds,
      () => biquadStage(eqSpec, sampleRate),
      chunks,
      () => biquad(audio, eqSpec).frames,
    ),
    measure(
      'dynamics rms→limit (whole-signal buffer)',
      samples,
      audioSeconds,
      () =>
        dynamicsStage({
          normalize: { mode: 'rms', targetDbfs: -14 },
          limit: { ceilingDbfs: -1, mode: 'soft' },
        }),
      chunks,
      () => limit(normalizeRms(audio, -14), -1, 'soft').frames,
    ),
  ];
  return { id, format, channels, sampleRate, frames, ops };
}

// ============ reporting ============

function printFile(r: FileResult): void {
  console.info(
    `\n${r.id} — ${r.frames} frames × ${r.channels}ch @ ${r.sampleRate} Hz (${r.format}, ${(r.frames / r.sampleRate).toFixed(3)}s)`,
  );
  console.info(
    `  ${'op'.padEnd(38)} ${'wall(ms)'.padStart(9)} ${'×realtime'.padStart(11)} ${'Msmpl/s'.padStart(9)} ${'overhead'.padStart(9)} ${'peakMem(MB)'.padStart(12)}`,
  );
  for (const o of r.ops) {
    console.info(
      `  ${o.op.padEnd(38)} ${o.wallMs.toFixed(3).padStart(9)} ${o.throughputRealtime.toFixed(0).padStart(10)}× ${o.mSamplesPerSec.toFixed(1).padStart(9)} ${o.chunkOverhead.toFixed(2).padStart(8)}× ${o.peakMemoryMb.toFixed(2).padStart(12)}`,
    );
  }
}

interface OpAggregate {
  op: string;
  files: number;
  geomeanRealtime: number;
  minRealtime: number;
  maxChunkOverhead: number;
  maxPeakMemoryMb: number;
}

function aggregate(results: readonly FileResult[]): OpAggregate[] {
  const byOp = new Map<string, OpResult[]>();
  for (const r of results) {
    for (const o of r.ops) (byOp.get(o.op) ?? byOp.set(o.op, []).get(o.op) ?? []).push(o);
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
      maxChunkOverhead: list.reduce((m, o) => Math.max(m, o.chunkOverhead), 0),
      maxPeakMemoryMb: list.reduce((m, o) => Math.max(m, o.peakMemoryMb), 0),
    });
  }
  return out;
}

function printAggregates(aggs: readonly OpAggregate[]): void {
  console.info('\n=== per-op aggregate across all corpus files ===');
  console.info(
    `  ${'op'.padEnd(38)} ${'files'.padStart(5)} ${'geomean×rt'.padStart(11)} ${'worst×rt'.padStart(9)} ${'maxOverhd'.padStart(9)} ${'maxMem(MB)'.padStart(11)}`,
  );
  for (const a of aggs) {
    console.info(
      `  ${a.op.padEnd(38)} ${String(a.files).padStart(5)} ${a.geomeanRealtime.toFixed(0).padStart(10)}× ${a.minRealtime.toFixed(0).padStart(8)}× ${a.maxChunkOverhead.toFixed(2).padStart(8)}× ${a.maxPeakMemoryMb.toFixed(2).padStart(11)}`,
    );
  }
}

// ============ baseline record ============

interface Baseline {
  generatedAt: string;
  runtime: string;
  warmup: number;
  iters: number;
  chunkFrames: number;
  files: FileResult[];
  aggregates: OpAggregate[];
}

function buildBaseline(files: FileResult[], aggregates: OpAggregate[]): Baseline {
  return {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    warmup: WARMUP,
    iters: ITERS,
    chunkFrames: CHUNK_FRAMES,
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
      `audio-stream benchmark needs ≥ 5 real WAV fixtures (BUILD_INSTRUCTIONS §6.1); found ${wavs.length}. Run \`bun run fetch-fixtures\`.`,
    );
  }
  return wavs;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const ids = await wavFixtures();
  console.info(
    `audio-stream benchmark — stream-stateful stages over ${CHUNK_FRAMES}-frame chunks, median of ${ITERS} iters (warmup ${WARMUP}); ${ids.length} real corpus files:`,
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
