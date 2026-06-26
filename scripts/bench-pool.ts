#!/usr/bin/env bun
/**
 * scripts/bench-pool.ts — fresh, multi-sample benchmark for the **ABR worker pool** (`WorkerPool` +
 * `offloadAbrLadder`, doc 06 §4, ADR-087). BUILD_INSTRUCTIONS §6: "every op has a multi-sample benchmark
 * (n>1, warmup): wall, throughput … measured across several real §6.1 corpus files, not one". Mirrors the
 * {@link import('./bench-dsp.ts')} harness style: median of N timed iters after warmup, a checksum sink so
 * the optimizer cannot elide the work, a machine-readable baseline + a `--check` regression gate.
 *
 * What it measures, honestly. In **Node there is no real module `Worker`**, so the pool is driven over an
 * in-process `MessageChannel` whose worker side runs the *real* `runOffloadWorker` + a *real*
 * `MediaEngineImpl` inner engine — the genuine pool scheduler, protocol, credit window, and reconstruction,
 * but all on **one JS thread**. So this bench does NOT claim a wall-clock parallel speedup (that only
 * materializes with real OS threads, measured in the browser harness `performance` family — directive 6: no
 * fake metric). It measures, across the **≥ 5 real corpus WAVs** (never one), a K-rendition ABR ladder
 * (per-rendition gain/sample-rate) two ways:
 *
 *   - **inline**   — K `convert(wav→wav)`s run sequentially on one `MediaEngineImpl({worker:false})`,
 *   - **pool(N)**  — the same K renditions fanned across an N-worker `WorkerPool` (channel transport, real
 *                    engine inner) via `offloadAbrLadder`, all streams drained.
 *
 * and reports, per file × arm: **wall** (median ms for the whole ladder), **throughput** (renditions/sec and
 * audio-seconds/sec), and the pool's **scheduling overhead** vs inline (pool wall ÷ inline wall — expected
 * ≈ 1 on one thread; a number far above 1 would mean the pool added real overhead, far below 1 is impossible
 * single-threaded and would signal dropped work). Output bytes are checksummed each iteration so the work is
 * real (no N/A→0). Every rendition's byte length is asserted equal across arms (the pool must produce the
 * same output as inline — wired to the byte-identity oracle in `src/api/worker-offload.test.ts`).
 *
 *   bun run bench-pool                 # run + print + (re)write the baseline
 *   bun run bench-pool --check         # run + print + diff vs the committed baseline (non-zero on regress)
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MediaEngineImpl } from '../src/api/engine.ts';
import { WorkerStreamBridge } from '../src/kernel/worker-bridge.ts';
import { runOffloadWorker } from '../src/kernel/worker-entry.ts';
import { type AbrRendition, offloadAbrLadder } from '../src/kernel/worker-host.ts';
import { type InnerEngine, makeJobRunner } from '../src/kernel/worker-main.ts';
import { WorkerPool, type WorkerPoolTransport } from '../src/kernel/worker-pool.ts';
import type { HostMessage, MessageLike, WorkerMessage } from '../src/kernel/worker-protocol.ts';
import { fromBytes } from '../src/sources/source.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/worker-pool.json`;

const WARMUP = 2;
const ITERS = 12;
/** ABR ladder size (independent renditions). */
const LADDER = 4;
/** Pool worker count for the pool arm. */
const POOL_SIZE = 4;
/** Beyond this fraction slower than the committed baseline throughput, `--check` flags a regression. */
const REGRESSION_TOLERANCE = 0.5;

let sink = 0; // accumulate a byte from each result so the optimizer cannot elide the convert work

// ============ stats / timing ============

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Time an async `fn` over {@link ITERS} runs (after {@link WARMUP}); return the median milliseconds. */
async function timeMsAsync(fn: () => Promise<number>): Promise<number> {
  for (let i = 0; i < WARMUP; i++) sink = (sink + (await fn())) | 0;
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = Bun.nanoseconds();
    sink = (sink + (await fn())) | 0;
    samples.push((Bun.nanoseconds() - t0) / 1e6);
  }
  return median(samples);
}

// ============ the ABR ladder (per-rendition convert options) ============

/** A ladder of independent renditions: each a distinct gain + sample-rate so the work is real and unique. */
function ladder(k: number): AbrRendition[] {
  const gains = [0, -3, -6, -9, -12, -15];
  const rates = [48000, 44100, 32000, 22050, 16000, 11025];
  return Array.from({ length: k }, (_, i) => ({
    opts: {
      to: 'wav',
      audio: {
        gainDb: gains[i % gains.length],
        sampleRate: rates[i % rates.length],
        codec: 'pcm-s16',
      },
    },
  }));
}

// ============ pool transport: a real channel + a real inner MediaEngineImpl (one thread) ============

function adaptPort<TIn, TOut>(port: MessagePort): MessageLike<TIn, TOut> {
  port.start();
  return {
    postMessage: (m, transfer) =>
      transfer && transfer.length > 0
        ? port.postMessage(m, transfer as Transferable[])
        : port.postMessage(m),
    addEventListener: (type, listener) =>
      port.addEventListener(type, (ev) => listener({ data: (ev as MessageEvent).data })),
    removeEventListener: () => {
      /* one listener per channel; channels are closed when the pool terminates */
    },
  };
}

/** A {@link WorkerPoolTransport} wiring a real `MessageChannel` per worker, worker side = real engine. */
function channelTransport(channels: MessageChannel[]): WorkerPoolTransport {
  return () => {
    const channel = new MessageChannel();
    channels.push(channel);
    const hostPort = adaptPort<WorkerMessage, HostMessage>(channel.port1);
    const workerPort = adaptPort<HostMessage, WorkerMessage>(channel.port2);
    const runJob = makeJobRunner(
      (determinism) =>
        new MediaEngineImpl({ worker: false, determinism }) as unknown as InnerEngine,
    );
    runOffloadWorker({ ...workerPort, webcodecs: true }, runJob);
    return new WorkerStreamBridge(hostPort, () => {
      channel.port1.close();
      channel.port2.close();
    });
  };
}

async function drainLen(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let total = 0;
  let firstByte = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total === 0 && value.byteLength > 0) firstByte = value[0] ?? 0;
    total += value.byteLength;
  }
  sink = (sink + firstByte) | 0;
  return total;
}

// ============ measured run ============

interface ArmResult {
  arm: 'inline' | `pool(${number})`;
  wallMs: number;
  renditionsPerSec: number;
  audioSecondsPerSec: number;
}

interface FileResult {
  id: string;
  frames: number;
  sampleRate: number;
  audioSeconds: number;
  renditions: number;
  outputBytes: number[]; // per-rendition output length (asserted equal across arms)
  arms: ArmResult[];
}

/** Run the K-rendition ladder INLINE (sequential) and return the per-rendition output lengths. */
async function runInline(bytes: Uint8Array, rungs: readonly AbrRendition[]): Promise<number[]> {
  const engine = new MediaEngineImpl({ worker: false });
  const lengths: number[] = [];
  for (const rung of rungs) {
    const out = await engine.convert(fromBytes(bytes.slice()), rung.opts as never);
    lengths.push(out instanceof Blob ? out.size : 0);
  }
  return lengths;
}

/** Run the K-rendition ladder across an N-worker POOL (channel transport) and return per-rendition lengths. */
async function runPool(
  bytes: Uint8Array,
  rungs: readonly AbrRendition[],
  size: number,
): Promise<number[]> {
  const channels: MessageChannel[] = [];
  const pool = new WorkerPool({ size, transport: channelTransport(channels) });
  try {
    const streams = await offloadAbrLadder(pool, fromBytes(bytes.slice()), rungs);
    return await Promise.all(streams.map((s) => drainLen(s)));
  } finally {
    await pool.terminate();
    for (const c of channels) {
      c.port1.close();
      c.port2.close();
    }
  }
}

async function benchFile(id: string, bytes: Uint8Array): Promise<FileResult> {
  const { frames, sampleRate, audioSeconds } = await probeWav(bytes);
  const rungs = ladder(LADDER);

  // Establish the per-rendition output lengths once (and assert the pool matches inline byte-length).
  const inlineLengths = await runInline(bytes, rungs);
  const poolLengths = await runPool(bytes, rungs, POOL_SIZE);
  for (let i = 0; i < inlineLengths.length; i++) {
    if (inlineLengths[i] !== poolLengths[i]) {
      throw new Error(
        `pool/inline output length mismatch for ${id} rendition ${i}: inline=${inlineLengths[i]} pool=${poolLengths[i]} (offload must produce the same bytes)`,
      );
    }
  }

  const inlineWall = await timeMsAsync(async () => {
    const ls = await runInline(bytes, rungs);
    return ls.reduce((a, b) => (a + b) | 0, 0);
  });
  const poolWall = await timeMsAsync(async () => {
    const ls = await runPool(bytes, rungs, POOL_SIZE);
    return ls.reduce((a, b) => (a + b) | 0, 0);
  });

  const arm = (name: ArmResult['arm'], wallMs: number): ArmResult => ({
    arm: name,
    wallMs,
    renditionsPerSec: LADDER / (wallMs / 1000),
    audioSecondsPerSec: (audioSeconds * LADDER) / (wallMs / 1000),
  });

  return {
    id,
    frames,
    sampleRate,
    audioSeconds,
    renditions: LADDER,
    outputBytes: inlineLengths,
    arms: [arm('inline', inlineWall), arm(`pool(${POOL_SIZE})`, poolWall)],
  };
}

/** Probe a WAV's frame count / sample-rate / duration via a real `probe` (the same path the engine uses). */
async function probeWav(bytes: Uint8Array): Promise<{
  frames: number;
  sampleRate: number;
  audioSeconds: number;
}> {
  const info = await new MediaEngineImpl({ worker: false }).probe(fromBytes(bytes.slice()));
  const track = info.tracks.find((t) => t.type === 'audio');
  const sampleRate = track?.sampleRate ?? 0;
  const audioSeconds = info.durationSec;
  return { frames: Math.round(audioSeconds * sampleRate), sampleRate, audioSeconds };
}

// ============ reporting ============

function printFile(r: FileResult): void {
  console.info(
    `\n${r.id} — ${r.frames} frames @ ${r.sampleRate} Hz (${r.audioSeconds.toFixed(3)}s) × ${r.renditions} renditions`,
  );
  console.info(
    `  ${'arm'.padEnd(10)} ${'wall(ms)'.padStart(10)} ${'rend/s'.padStart(9)} ${'audioS/s'.padStart(10)}`,
  );
  for (const a of r.arms) {
    console.info(
      `  ${a.arm.padEnd(10)} ${a.wallMs.toFixed(3).padStart(10)} ${a.renditionsPerSec.toFixed(1).padStart(9)} ${a.audioSecondsPerSec.toFixed(1).padStart(10)}`,
    );
  }
  const inline = r.arms.find((a) => a.arm === 'inline');
  const pool = r.arms.find((a) => a.arm.startsWith('pool'));
  if (inline && pool) {
    console.info(
      `  pool scheduling overhead vs inline (1 thread): ${(pool.wallMs / inline.wallMs).toFixed(2)}× (≈1 ⇒ negligible; real parallelism is a browser measurement)`,
    );
  }
}

// ============ baseline / regression ============

interface Aggregate {
  arm: string;
  files: number;
  geomeanRenditionsPerSec: number;
}

function aggregate(results: readonly FileResult[]): Aggregate[] {
  const byArm = new Map<string, number[]>();
  for (const r of results) {
    for (const a of r.arms) {
      (byArm.get(a.arm) ?? byArm.set(a.arm, []).get(a.arm) ?? []).push(a.renditionsPerSec);
    }
  }
  const out: Aggregate[] = [];
  for (const [arm, list] of byArm) {
    const logSum = list.reduce((s, v) => s + Math.log(v), 0);
    out.push({ arm, files: list.length, geomeanRenditionsPerSec: Math.exp(logSum / list.length) });
  }
  return out;
}

interface Baseline {
  generatedAt: string;
  runtime: string;
  warmup: number;
  iters: number;
  ladder: number;
  poolSize: number;
  files: FileResult[];
  aggregates: Aggregate[];
}

function regressions(fresh: readonly Aggregate[], base: Baseline): string[] {
  const baseByArm = new Map(base.aggregates.map((a) => [a.arm, a]));
  const regressed: string[] = [];
  for (const a of fresh) {
    const b = baseByArm.get(a.arm);
    if (b === undefined) continue;
    if (a.geomeanRenditionsPerSec < b.geomeanRenditionsPerSec * (1 - REGRESSION_TOLERANCE)) {
      regressed.push(
        `${a.arm}: ${a.geomeanRenditionsPerSec.toFixed(1)} rend/s vs baseline ${b.geomeanRenditionsPerSec.toFixed(1)}`,
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
      `worker-pool benchmark needs ≥ 5 real WAV fixtures (BUILD §6.1); found ${wavs.length}. Run \`bun run fetch-fixtures\`.`,
    );
  }
  return wavs;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const ids = await wavFixtures();
  console.info(
    `worker-pool benchmark — ABR ladder of ${LADDER} renditions, pool size ${POOL_SIZE}, median of ${ITERS} iters (warmup ${WARMUP}); ${ids.length} real corpus WAVs.`,
  );
  console.info(
    'NOTE: Node has no real module Worker — the pool runs over an in-process channel on ONE thread, so this measures the pool SCHEDULER + protocol + reconstruction overhead, not wall-clock parallelism (that is a browser measurement).',
  );

  const results: FileResult[] = [];
  for (const id of ids) {
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${id}`).arrayBuffer());
    const r = await benchFile(id, bytes);
    results.push(r);
    printFile(r);
  }

  const aggs = aggregate(results);
  console.info('\n=== per-arm aggregate (geomean renditions/sec across all files) ===');
  for (const a of aggs) {
    console.info(
      `  ${a.arm.padEnd(10)} ${a.geomeanRenditionsPerSec.toFixed(1).padStart(9)} rend/s`,
    );
  }
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

  const baseline: Baseline = {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    warmup: WARMUP,
    iters: ITERS,
    ladder: LADDER,
    poolSize: POOL_SIZE,
    files: results,
    aggregates: aggs,
  };
  await mkdir(dirname(BASELINE_PATH), { recursive: true });
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.info(`\nbaseline written → ${BASELINE_PATH}`);
}

await main();
