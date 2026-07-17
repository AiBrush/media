#!/usr/bin/env bun
/**
 * Fresh multi-sample benchmark for the S02 execution-runtime family:
 *
 * 1. `batchPackets` — the zero-high-water-mark 256-packet batched drain (ADR-278) vs a per-packet
 *    zero-HWM baseline on a 553,501-row packet table, with the read-step oracle asserted every sample.
 * 2. The fused single-pipe declarative job (lazy stream boundary) vs the staged Blob-boundary reference
 *    on the real `sfx-pcm-s16.wav` fixture, with a SHA-256 checksum oracle asserted every sample.
 * 3. `plan()` — planner compile throughput with a structure oracle per iteration.
 * 4. `runCancellable` — orchestration plumbing overhead per dispatched op.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import { batchPackets, runCancellable } from '../src/kernel/executor.ts';
import { plan } from '../src/kernel/planner.ts';
import { toBlob } from '../src/sinks/sink.ts';

const WARMUP = 3;
const SAMPLES = 11;
const PACKET_TABLE_ROWS = 553_501;
const PLANS_PER_SAMPLE = 20_000;
const CANCELLABLES_PER_SAMPLE = 20_000;
const RETAINED_MEMORY_BOUND_BYTES = 64 * 1024 * 1024;
const TRIM_WAV_SHA256 = '210de71b0c07a557db5c229f0af69f628126cdf7c05ac312573745c309289cc1';
const CHECK = process.argv.includes('--check');
let sink = 0;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function measure(run: () => Promise<number>): Promise<readonly number[]> {
  for (let index = 0; index < WARMUP; index++) await run();
  const values: number[] = [];
  for (let index = 0; index < SAMPLES; index++) values.push(await run());
  return values;
}

// ── 1. Batched packet drain ─────────────────────────────────────────────────────────────────────

const packetTable = Array.from({ length: PACKET_TABLE_ROWS }, (_, index) => index);

async function batchedDrainSample(): Promise<number> {
  const started = Bun.nanoseconds();
  const reader = batchPackets<number>(packetTable).getReader();
  let reads = 0;
  let items = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    reads++;
    items += value.length;
    sink = (sink + (value[0] ?? 0)) | 0;
  }
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
  if (reads !== Math.ceil(PACKET_TABLE_ROWS / 256) || items !== PACKET_TABLE_ROWS) {
    throw new Error(`batched drain oracle failed: reads=${reads}, items=${items}`);
  }
  return elapsedMs;
}

async function perPacketDrainSample(): Promise<number> {
  const started = Bun.nanoseconds();
  let index = 0;
  const stream = new ReadableStream<number>(
    {
      pull(controller): void {
        if (index === PACKET_TABLE_ROWS) {
          controller.close();
          return;
        }
        const value = packetTable[index];
        if (value !== undefined) controller.enqueue(value);
        index++;
      },
    },
    { highWaterMark: 0 },
  );
  const reader = stream.getReader();
  let items = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    items++;
    sink = (sink + value) | 0;
  }
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
  if (items !== PACKET_TABLE_ROWS) {
    throw new Error(`per-packet baseline lost work: items=${items}`);
  }
  return elapsedMs;
}

// ── 2. Fused single-pipe job vs staged Blob boundary (real fixture, real engine) ───────────────

const wavBytes = new Uint8Array(
  await readFile(new URL('../fixtures/media/sfx-pcm-s16.wav', import.meta.url)),
);
const engine = createMedia({ worker: false });

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fusedJobSample(): Promise<number> {
  const started = Bun.nanoseconds();
  const output = await engine.run({
    input: wavBytes,
    ops: [{ op: 'trim', start: 0, end: 0.1 }],
    output: { container: 'wav', video: false, audio: { codec: 'pcm-s16' } },
  });
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
  const digest = sha256(new Uint8Array(await output.arrayBuffer()));
  if (digest !== TRIM_WAV_SHA256) {
    throw new Error(`fused job checksum drifted: ${digest}`);
  }
  return elapsedMs;
}

async function stagedJobSample(): Promise<number> {
  const started = Bun.nanoseconds();
  const trimmed = await engine.trim(wavBytes, { start: 0, end: 0.1, sink: toBlob() });
  if (!(trimmed instanceof Blob)) throw new Error('staged trim did not produce a Blob');
  const converted = await engine.convert(trimmed, {
    to: 'wav',
    video: false,
    audio: { codec: 'pcm-s16' },
  });
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
  if (!(converted instanceof Blob)) throw new Error('staged convert did not produce a Blob');
  const digest = sha256(new Uint8Array(await converted.arrayBuffer()));
  if (digest !== TRIM_WAV_SHA256) {
    throw new Error(`staged job checksum drifted: ${digest}`);
  }
  return elapsedMs;
}

// ── 3. Planner throughput ───────────────────────────────────────────────────────────────────────

async function plannerSample(): Promise<number> {
  const started = Bun.nanoseconds();
  for (let index = 0; index < PLANS_PER_SAMPLE; index++) {
    const graph = plan({
      op: 'convert',
      input: {
        container: 'mp4',
        streams: [
          { id: 1, mediaType: 'video', codec: 'h264' },
          { id: 2, mediaType: 'audio', codec: 'aac' },
        ],
      },
      output: {
        container: 'webm',
        targets: [
          {
            stream: 1,
            codec: 'vp9',
            filters: [{ mediaType: 'video', type: 'resize', width: 640, height: 360 }],
          },
        ],
      },
    });
    if (graph.copyOnly || graph.stages.length !== 6) {
      throw new Error(`planner oracle failed at ${index}: ${graph.stages.length}`);
    }
    sink = (sink + graph.stages.length) | 0;
  }
  return (Bun.nanoseconds() - started) / 1_000_000;
}

// ── 4. runCancellable dispatch overhead ─────────────────────────────────────────────────────────

async function cancellableSample(): Promise<number> {
  const started = Bun.nanoseconds();
  for (let index = 0; index < CANCELLABLES_PER_SAMPLE; index++) {
    const inner = Promise.resolve(index) as Promise<number> & { cancel(): void };
    inner.cancel = (): void => undefined;
    const value = await runCancellable([], (scope) => scope.dispatch(inner));
    sink = (sink + value) | 0;
  }
  return (Bun.nanoseconds() - started) / 1_000_000;
}

// ── Run: samples, memory bracket, gate, report ──────────────────────────────────────────────────

const batchedSamples = await measure(batchedDrainSample);
const perPacketSamples = await measure(perPacketDrainSample);
const fusedSamples = await measure(fusedJobSample);
const stagedSamples = await measure(stagedJobSample);
const plannerSamples = await measure(plannerSample);
const cancellableSamples = await measure(cancellableSample);

Bun.gc(true);
const before = process.memoryUsage();
let peakHeapBytes = before.heapUsed;
let peakRssBytes = before.rss;
for (let index = 0; index < 3; index++) {
  await batchedDrainSample();
  await fusedJobSample();
  await plannerSample();
  await cancellableSample();
  const current = process.memoryUsage();
  peakHeapBytes = Math.max(peakHeapBytes, current.heapUsed);
  peakRssBytes = Math.max(peakRssBytes, current.rss);
}
Bun.gc(true);
const after = process.memoryUsage();
const retainedHeapBytes = after.heapUsed - before.heapUsed;
const retainedRssBytes = after.rss - before.rss;
if (
  retainedHeapBytes > RETAINED_MEMORY_BOUND_BYTES ||
  retainedRssBytes > RETAINED_MEMORY_BOUND_BYTES
) {
  throw new Error(
    `execution-runtime benchmark retained too much memory: heap=${retainedHeapBytes}, rss=${retainedRssBytes}`,
  );
}

const batchedMedianMs = median(batchedSamples);
const perPacketMedianMs = median(perPacketSamples);
const fusedMedianMs = median(fusedSamples);
const stagedMedianMs = median(stagedSamples);
const plannerMedianMs = median(plannerSamples);
const cancellableMedianMs = median(cancellableSamples);

if (
  CHECK &&
  (batchedMedianMs > 2_000 ||
    fusedMedianMs > 2_000 ||
    plannerMedianMs > 2_000 ||
    cancellableMedianMs > 2_000 ||
    batchedMedianMs >= perPacketMedianMs)
) {
  throw new Error(
    `execution-runtime benchmark gate failed: batched=${batchedMedianMs}, perPacket=${perPacketMedianMs}, fused=${fusedMedianMs}, planner=${plannerMedianMs}, cancellable=${cancellableMedianMs}`,
  );
}

console.info(
  JSON.stringify({
    benchmark: 's02-execution-runtime',
    warmup: WARMUP,
    samples: SAMPLES,
    batchedPacketDrain: {
      rows: PACKET_TABLE_ROWS,
      readSteps: Math.ceil(PACKET_TABLE_ROWS / 256),
      samplesMs: batchedSamples,
      medianMs: batchedMedianMs,
      packetsPerSec: PACKET_TABLE_ROWS / (batchedMedianMs / 1_000),
    },
    perPacketDrainBaseline: {
      rows: PACKET_TABLE_ROWS,
      samplesMs: perPacketSamples,
      medianMs: perPacketMedianMs,
      packetsPerSec: PACKET_TABLE_ROWS / (perPacketMedianMs / 1_000),
      batchedSpeedup: perPacketMedianMs / batchedMedianMs,
    },
    fusedSinglePipeJob: {
      fixture: 'sfx-pcm-s16.wav trim 0–0.1s → wav pcm-s16',
      sha256: TRIM_WAV_SHA256,
      samplesMs: fusedSamples,
      medianMs: fusedMedianMs,
    },
    stagedBlobBoundaryJob: {
      samplesMs: stagedSamples,
      medianMs: stagedMedianMs,
      fusedSpeedup: stagedMedianMs / fusedMedianMs,
    },
    planner: {
      plansPerSample: PLANS_PER_SAMPLE,
      samplesMs: plannerSamples,
      medianMs: plannerMedianMs,
      plansPerSec: PLANS_PER_SAMPLE / (plannerMedianMs / 1_000),
    },
    cancellable: {
      dispatchesPerSample: CANCELLABLES_PER_SAMPLE,
      samplesMs: cancellableSamples,
      medianMs: cancellableMedianMs,
      dispatchesPerSec: CANCELLABLES_PER_SAMPLE / (cancellableMedianMs / 1_000),
    },
    memory: {
      peakHeapBytes,
      peakRssBytes,
      retainedHeapBytes,
      retainedRssBytes,
      retainedMemoryBoundBytes: RETAINED_MEMORY_BOUND_BYTES,
    },
    sink,
  }),
);

// The probe prefix cache owns a browser-lifetime expiry timer, irrelevant to a completed CLI benchmark.
process.exit(0);
