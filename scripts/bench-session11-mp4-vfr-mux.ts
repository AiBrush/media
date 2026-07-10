#!/usr/bin/env bun
/** Session 11 MP4 VFR mux-timing benchmark: monotonic PTS gaps with stale nominal durations. */

import { type ChunkStruct, buildMuxSamples } from '../src/drivers/mp4/mux.ts';

const WARMUP = 2;
const SAMPLES = 9;
const TABLES_PER_SAMPLE = 500;
const FRAMES_PER_TABLE = 626;
const TIMESCALE = 90_000;

interface Sample {
  readonly elapsedMs: number;
  readonly checksum: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

function makeChunks(): ChunkStruct[] {
  const chunks: ChunkStruct[] = [];
  let timestampUs = 0;
  for (let index = 0; index < FRAMES_PER_TABLE; index++) {
    chunks.push({
      timestampUs,
      durationUs: 16_667,
      key: index === 0,
      data: new Uint8Array([index & 0xff]),
    });
    timestampUs += index > 0 && index % 37 === 0 ? 33_333 : index % 53 === 0 ? 16_666 : 16_667;
  }
  return chunks;
}

function runSample(chunks: readonly ChunkStruct[]): Sample {
  const started = performance.now();
  let checksum = 0;
  for (let tableIndex = 0; tableIndex < TABLES_PER_SAMPLE; tableIndex++) {
    const samples = buildMuxSamples(chunks, TIMESCALE);
    for (const sample of samples) {
      if (sample.cttsTicks !== 0) throw new Error('monotonic encoder output fabricated reorder');
      checksum =
        (checksum + sample.durationTicks * 17 + sample.data.byteLength * 31 + sample.cttsTicks) >>>
        0;
    }
  }
  return { elapsedMs: performance.now() - started, checksum };
}

function main(): void {
  const chunks = makeChunks();
  const timings: number[] = [];
  let checksum = 0;
  for (let index = 0; index < WARMUP + SAMPLES; index++) {
    const sample = runSample(chunks);
    checksum = (checksum + sample.checksum) >>> 0;
    if (index >= WARMUP) timings.push(sample.elapsedMs);
  }
  const before = process.memoryUsage().rss;
  const memorySample = runSample(chunks);
  checksum = (checksum + memorySample.checksum) >>> 0;
  const peakMemoryMb = Math.max(0, process.memoryUsage().rss - before) / (1024 * 1024);
  console.info(
    `Session 11 MP4 VFR mux timing — ${TABLES_PER_SAMPLE}×${FRAMES_PER_TABLE} packets; ` +
      `median=${median(timings).toFixed(3)} ms; peakRSS+=${peakMemoryMb.toFixed(2)} MiB; ` +
      `checksum=${checksum}; samples=[${timings.map((ms) => ms.toFixed(3)).join(', ')}]`,
  );
}

main();
