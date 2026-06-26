#!/usr/bin/env bun
/**
 * Fluent chain façade benchmark (ADR-010 / D10). Units are chains/sec: this measures the public
 * `load(...).trim(...).resize(...).convert(...).blob()` sugar, lazy runner import, option compilation,
 * sink injection, and intermediate Blob boundaries using a fake engine. It deliberately does not measure
 * WebCodecs/container throughput; the flat ops own those benches.
 *
 *   bun run bench-chain              # run + print + (re)write the baseline
 *   bun run bench-chain --check      # run + print + diff vs the committed baseline
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createMediaChain } from '../src/api/chain.ts';
import type {
  CallOptions,
  Cancellable,
  ConvertOptions,
  DecryptOptions,
  Output,
  RemuxOptions,
  TrimOptions,
} from '../src/api/types.ts';
import type { Sink } from '../src/sinks/sink.ts';
import type { MediaInput } from '../src/sources/source.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/chain.json`;

const WARMUP = 5;
const ITERS = 51;
const REGRESSION_TOLERANCE = 0.5;
const INPUT = new Uint8Array([1, 2, 3, 4]);

let sink = 0;

interface FakeEngine {
  convert(input: MediaInput, opts: ConvertOptions, o?: CallOptions): Cancellable<Output>;
  trim(input: MediaInput, opts: TrimOptions, o?: CallOptions): Cancellable<Output>;
  remux(input: MediaInput, opts: RemuxOptions, o?: CallOptions): Cancellable<Output>;
  decrypt(input: MediaInput, opts: DecryptOptions, o?: CallOptions): Cancellable<Output>;
}

function fakeEngine(): FakeEngine {
  return {
    convert(input, opts): Cancellable<Output> {
      return resolved(materializeFake(input, opts.sink, 'convert'));
    },
    trim(input, opts): Cancellable<Output> {
      return resolved(materializeFake(input, opts.sink, 'trim'));
    },
    remux(input, opts): Cancellable<Output> {
      return resolved(materializeFake(input, opts.sink, 'remux'));
    },
    decrypt(input, opts): Cancellable<Output> {
      return resolved(materializeFake(input, opts.sink, 'decrypt'));
    },
  };
}

function resolved<T>(value: T): Cancellable<T> {
  const promise = Promise.resolve(value) as Cancellable<T>;
  promise.cancel = (): void => {};
  return promise;
}

function materializeFake(input: MediaInput, target: Sink | undefined, label: string): Output {
  sink = (sink + label.length + inputWeight(input)) | 0;
  switch (target?.kind ?? 'blob') {
    case 'blob':
      return new Blob([label]);
    case 'file':
      return target?.kind === 'file' ? new File([label], target.name) : undefined;
    case 'stream':
      return new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode(label));
          controller.close();
        },
      });
    default:
      return undefined;
  }
}

function inputWeight(input: MediaInput): number {
  return input instanceof Uint8Array ? input.byteLength : input instanceof Blob ? input.size : 1;
}

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
  chainsPerSec: number;
  peakMemoryMb: number;
}

async function measure(op: string, fn: () => Promise<number>): Promise<OpResult> {
  const ns = await timeNs(fn);
  const peak = await peakRssBytes(fn);
  return {
    op,
    wallMs: ns / 1e6,
    chainsPerSec: 1 / (ns / 1e9),
    peakMemoryMb: peak / (1024 * 1024),
  };
}

async function benchSingleConvertBlob(): Promise<number> {
  const out = await createMediaChain(fakeEngine(), INPUT)
    .resize(320, 180, 'contain')
    .colorspace('bt2020')
    .to('webm')
    .blob();
  return out.size;
}

async function benchTrimResizeConvertBlob(): Promise<number> {
  const out = await createMediaChain(fakeEngine(), INPUT)
    .trim({ start: 0, end: 1, mode: 'accurate' })
    .resize(160, 90)
    .convert({ to: 'mp4', audio: { codec: 'aac' } })
    .blob();
  return out.size;
}

async function benchFileAndStreamTerminals(): Promise<number> {
  const file = await createMediaChain(fakeEngine(), INPUT).convert({ to: 'mp4' }).file('clip.mp4');
  const stream = await createMediaChain(fakeEngine(), INPUT).convert({ to: 'mp4' }).stream();
  const reader = stream.getReader();
  let total = file.size;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return total;
}

async function benchEmptyReject(): Promise<number> {
  await createMediaChain(fakeEngine(), INPUT)
    .blob()
    .then(
      () => {
        throw new Error('empty chain unexpectedly resolved');
      },
      () => 1,
    );
  return 1;
}

interface Aggregate {
  ops: number;
  geomeanChainsPerSec: number;
  minChainsPerSec: number;
  maxPeakMemoryMb: number;
}

function aggregate(results: readonly OpResult[]): Aggregate {
  const logSum = results.reduce((sum, result) => sum + Math.log(result.chainsPerSec), 0);
  return {
    ops: results.length,
    geomeanChainsPerSec: Math.exp(logSum / results.length),
    minChainsPerSec: results.reduce(
      (min, result) => Math.min(min, result.chainsPerSec),
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
    if (b !== undefined && op.chainsPerSec < b.chainsPerSec * (1 - REGRESSION_TOLERANCE)) {
      out.push(
        `${op.op}: ${op.chainsPerSec.toFixed(0)} chains/s vs baseline ${b.chainsPerSec.toFixed(0)} chains/s`,
      );
    }
  }
  return out;
}

function printOp(result: OpResult): void {
  console.info(
    `  ${result.op.padEnd(34)} ${result.wallMs.toFixed(3).padStart(9)} ms  ${result.chainsPerSec.toFixed(0).padStart(9)} chains/s  ${result.peakMemoryMb.toFixed(2).padStart(8)} MB`,
  );
}

function printAggregate(agg: Aggregate): void {
  console.info(
    `\n  aggregate: ${agg.geomeanChainsPerSec.toFixed(0)} chains/s geomean, ` +
      `${agg.minChainsPerSec.toFixed(0)} chains/s worst, ${agg.maxPeakMemoryMb.toFixed(2)} MB max peak`,
  );
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  console.info(
    `fluent chain benchmark — median of ${ITERS} iters (warmup ${WARMUP}); units are chains/sec:\n`,
  );
  const results = [
    await measure('chain convert blob', benchSingleConvertBlob),
    await measure('chain trim+resize+convert blob', benchTrimResizeConvertBlob),
    await measure('chain file+stream terminals', benchFileAndStreamTerminals),
    await measure('chain empty typed reject', benchEmptyReject),
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
