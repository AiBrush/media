#!/usr/bin/env bun

/**
 * S01 router micro-benchmarks (R-S01.1/2/5): selection cost across the new probe/evict/bounded-LRU
 * surfaces, measured fresh with fake drivers so only router work is on the clock (the exemplar pattern
 * of bench-session12-deterministic-routing.ts).
 *
 *   codec.hot            cached probeCodec hit (verdict + driver, zero probes)
 *   codec.cold           uncached probeCodec walk (distinct exact configs)
 *   codec.evict-record   evictCodec bookkeeping alone
 *   codec.evict-reroute  probeCodec on a runtime-evicted ladder head (ADR-284 skip + tail probe)
 *   container.hot        cached mime verdict hit
 *   container.churn      65-distinct-mime sweep — every pick evicts through the LRU bound
 *   filter.hot           cached filter verdict hit (includes the revalidation probe)
 *
 * `--check` gates machine-independent invariants only (finite positive medians; hot ≤ cold) plus the
 * routing-correctness asserts that always run. Numbers are medians over fresh samples with MAD spread.
 */

import type {
  CodecDriver,
  CodecQuery,
  CodecSupport,
  ContainerDriver,
  ContainerQuery,
  EncodedChunk,
  FilterDriver,
  FilterSpec,
  RawFrame,
  Tier,
} from '../src/contracts/driver.ts';
import { DRIVER_API_VERSION } from '../src/contracts/driver.ts';
import { Registry } from '../src/kernel/registry.ts';
import { Router } from '../src/kernel/router.ts';

const WARMUP = 3;
const SAMPLES = 21;
const HOT_ITERATIONS = 10_000;
const COLD_ITERATIONS = 1_000;
const EVICT_ITERATIONS = 5_000;
const CHURN_MIMES = 65;
let sink = 0;

function codec(id: string, tier: Tier): CodecDriver {
  return {
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier,
    supports: (): Promise<CodecSupport> =>
      Promise.resolve({ supported: true, hardwareAccelerated: tier === 'hardware' }),
    createDecoder: () => new TransformStream<EncodedChunk, RawFrame>(),
    createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
  };
}

function container(id: string): ContainerDriver {
  return {
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['mp4'],
    supports: (_q: ContainerQuery): boolean => true,
    demux: () => Promise.reject(new Error('bench container never demuxes')),
    createMuxer: () => {
      throw new Error('bench container never muxes');
    },
  };
}

function filter(id: string): FilterDriver {
  return {
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'filter',
    substrate: 'native',
    supports: (_f: FilterSpec): boolean => true,
    createFilter: () => new TransformStream<VideoFrame, VideoFrame>(),
  };
}

function router(): Router {
  const registry = new Registry();
  registry.addCodec(codec('bench-hardware', 'hardware'));
  registry.addCodec(codec('bench-native', 'native'));
  registry.addCodec(codec('bench-wasm-tail', 'wasm'));
  registry.addContainer(container('bench-container'));
  registry.addFilter(filter('bench-filter'));
  return new Router({ registry });
}

function query(width: number): CodecQuery {
  return {
    mediaType: 'video',
    direction: 'decode',
    config: { codec: 'vp09.00.10.08', codedWidth: width, codedHeight: 16 },
  };
}

const resize: FilterSpec = { mediaType: 'video', type: 'resize', width: 1280, height: 720 };

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[ordered.length >>> 1] ?? Number.NaN;
}

function mad(samples: readonly number[], center: number): number {
  return median(samples.map((value) => Math.abs(value - center)));
}

async function codecHotSample(): Promise<number> {
  const candidate = router();
  const exact = query(1920);
  await candidate.probeCodec(exact);
  const start = Bun.nanoseconds();
  for (let index = 0; index < HOT_ITERATIONS; index++) {
    const route = await candidate.probeCodec(exact);
    sink += route.driver.id.length + (route.support.hardwareAccelerated === true ? 1 : 0);
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

async function codecColdSample(): Promise<number> {
  const candidate = router();
  const start = Bun.nanoseconds();
  for (let index = 0; index < COLD_ITERATIONS; index++) {
    const route = await candidate.probeCodec(query(index + 1));
    sink += route.driver.id.length;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

async function evictRecordSample(): Promise<number> {
  const candidate = router();
  const exact = query(1920);
  await candidate.probeCodec(exact);
  const start = Bun.nanoseconds();
  for (let index = 0; index < EVICT_ITERATIONS; index++) {
    sink += candidate.evictCodec(exact, 'bench-hardware') ? 1 : 0;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

async function evictRerouteSample(): Promise<number> {
  const candidate = router();
  const exact = query(1920);
  await candidate.probeCodec(exact);
  candidate.evictCodec(exact, 'bench-hardware');
  const first = await candidate.probeCodec(exact);
  if (first.driver.tier === 'hardware') {
    throw new Error('evicted ladder head was re-selected — eviction contract broken');
  }
  const start = Bun.nanoseconds();
  for (let index = 0; index < EVICT_ITERATIONS; index++) {
    const route = await candidate.probeCodec(exact);
    sink += route.driver.id.length;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

function containerHotSample(): number {
  const candidate = router();
  const exact: ContainerQuery = { direction: 'demux', mime: 'video/mp4' };
  candidate.pickContainer(exact);
  const start = Bun.nanoseconds();
  for (let index = 0; index < HOT_ITERATIONS; index++) {
    sink += candidate.pickContainer(exact).id.length;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

function containerChurnSample(): number {
  const candidate = router();
  const queries: ContainerQuery[] = [];
  for (let index = 0; index < CHURN_MIMES; index++) {
    queries.push({ direction: 'demux', mime: `video/bench-${index}` });
  }
  const start = Bun.nanoseconds();
  for (let index = 0; index < HOT_ITERATIONS; index++) {
    const q = queries[index % CHURN_MIMES];
    if (q !== undefined) sink += candidate.pickContainer(q).id.length;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

function filterHotSample(): number {
  const candidate = router();
  candidate.pickFilter(resize);
  const start = Bun.nanoseconds();
  for (let index = 0; index < HOT_ITERATIONS; index++) {
    sink += candidate.pickFilter(resize).id.length;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

interface Metric {
  readonly name: string;
  readonly iterations: number;
  readonly run: () => number | Promise<number>;
}

const metrics: readonly Metric[] = [
  { name: 'codec.hot', iterations: HOT_ITERATIONS, run: codecHotSample },
  { name: 'codec.cold', iterations: COLD_ITERATIONS, run: codecColdSample },
  { name: 'codec.evict-record', iterations: EVICT_ITERATIONS, run: evictRecordSample },
  { name: 'codec.evict-reroute', iterations: EVICT_ITERATIONS, run: evictRerouteSample },
  { name: 'container.hot', iterations: HOT_ITERATIONS, run: containerHotSample },
  { name: 'container.churn', iterations: HOT_ITERATIONS, run: containerChurnSample },
  { name: 'filter.hot', iterations: HOT_ITERATIONS, run: filterHotSample },
];

async function measure(metric: Metric): Promise<{ us: number; madUs: number }> {
  for (let index = 0; index < WARMUP; index++) await metric.run();
  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) samples.push(await metric.run());
  const center = median(samples);
  return {
    us: (center * 1_000) / metric.iterations,
    madUs: (mad(samples, center) * 1_000) / metric.iterations,
  };
}

const check = process.argv.includes('--check');
const results = new Map<string, number>();
for (const metric of metrics) {
  const { us, madUs } = await measure(metric);
  results.set(metric.name, us);
  console.log(`${metric.name}: ${us.toFixed(3)}us/op (MAD ${madUs.toFixed(3)}us)`);
}
console.log(`sink=${sink}`);

if (check) {
  const failures: string[] = [];
  for (const [name, us] of results) {
    if (!Number.isFinite(us) || us <= 0) failures.push(`${name} not a positive finite median`);
  }
  const hot = results.get('codec.hot') ?? Number.NaN;
  const cold = results.get('codec.cold') ?? Number.NaN;
  if (!(hot <= cold)) failures.push(`cached pick (${hot}us) not cheaper than uncached (${cold}us)`);
  if (failures.length > 0) {
    console.error(`bench-s01-router-caches --check failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('bench-s01-router-caches --check passed');
}
