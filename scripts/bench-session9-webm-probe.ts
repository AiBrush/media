#!/usr/bin/env bun
/**
 * Session 9 WebM metadata benchmark. Times the long-form VP9 probe path on the real massive fixture and
 * records how many bytes the range-backed metadata path reads before returning track facts.
 */

import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ByteSource, TrackInfo } from '../src/contracts/driver.ts';
import { WebmDriver } from '../src/drivers/webm/webm-driver.ts';

const WARMUP = 2;
const ITERS = 9;
const DEFAULT_FIXTURE = new URL(
  '../../media-test/media-browser-test/fixtures/media/massive_vp9_1080p_2h.webm',
  import.meta.url,
).pathname;

interface BenchResult {
  readonly medianMs: number;
  readonly samplesMs: readonly number[];
  readonly peakMemoryMb: number;
  readonly checksum: number;
  readonly rangeCalls: number;
  readonly rangeBytes: number;
}

interface InstrumentedSource extends ByteSource {
  readonly stats: {
    rangeCalls: number;
    rangeBytes: number;
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted[mid];
  if (value === undefined) throw new Error('cannot take median of an empty sample set');
  return value;
}

function checksumTracks(tracks: readonly TrackInfo[]): number {
  let checksum = tracks.length;
  for (const track of tracks) {
    checksum = (checksum + track.id * 17 + track.codec.length * 31) >>> 0;
    checksum = (checksum + Math.round((track.durationSec ?? 0) * 1000)) >>> 0;
    checksum = (checksum + Math.round((track.fps ?? 0) * 1000)) >>> 0;
    checksum = (checksum + (track.config?.codec.length ?? 0) * 13) >>> 0;
  }
  return checksum;
}

async function sourceForFile(
  path: string,
): Promise<{ source: InstrumentedSource; close(): Promise<void> }> {
  const file = await open(path, 'r');
  const stat = await file.stat();
  const stats = { rangeCalls: 0, rangeBytes: 0 };
  return {
    source: {
      size: stat.size,
      stats,
      range: async (start, end) => {
        const length = Math.max(0, end - start);
        const bytes = new Uint8Array(length);
        const { bytesRead } = await file.read(bytes, 0, length, start);
        stats.rangeCalls++;
        stats.rangeBytes += bytesRead;
        return bytesRead === bytes.byteLength ? bytes : bytes.subarray(0, bytesRead);
      },
      stream(): ReadableStream<Uint8Array> {
        throw new Error('WebM metadata benchmark must not open the full stream');
      },
    },
    close: () => file.close(),
  };
}

async function runOnce(
  path: string,
): Promise<{ elapsedMs: number; checksum: number; rangeCalls: number; rangeBytes: number }> {
  const opened = await sourceForFile(path);
  try {
    const t0 = performance.now();
    if (WebmDriver.probe === undefined) throw new Error('WebmDriver.probe is not registered');
    const tracks = await WebmDriver.probe(opened.source);
    const elapsedMs = performance.now() - t0;
    return {
      elapsedMs,
      checksum: checksumTracks(tracks),
      rangeCalls: opened.source.stats.rangeCalls,
      rangeBytes: opened.source.stats.rangeBytes,
    };
  } finally {
    await opened.close();
  }
}

async function bench(path: string): Promise<BenchResult> {
  const samplesMs: number[] = [];
  let checksum = 0;
  let rangeCalls = 0;
  let rangeBytes = 0;
  for (let i = 0; i < WARMUP + ITERS; i++) {
    const result = await runOnce(path);
    checksum = (checksum + result.checksum) >>> 0;
    if (i >= WARMUP) {
      samplesMs.push(result.elapsedMs);
      rangeCalls += result.rangeCalls;
      rangeBytes += result.rangeBytes;
    }
  }
  const base = process.memoryUsage().rss;
  const memoryResult = await runOnce(path);
  const peak = process.memoryUsage().rss;
  return {
    medianMs: median(samplesMs),
    samplesMs,
    peakMemoryMb: Math.max(0, peak - base) / (1024 * 1024),
    checksum: (checksum + memoryResult.checksum) >>> 0,
    rangeCalls: Math.round(rangeCalls / ITERS),
    rangeBytes: Math.round(rangeBytes / ITERS),
  };
}

function formatSamples(samplesMs: readonly number[]): string {
  return samplesMs.map((ms) => ms.toFixed(3)).join(', ');
}

async function main(): Promise<void> {
  const input = resolve(process.argv[2] ?? DEFAULT_FIXTURE);
  if (!existsSync(input)) throw new Error(`fixture not found: ${input}`);
  const result = await bench(input);
  console.info(
    `Session 9 WebM probe benchmark — median of ${ITERS} iters (warmup ${WARMUP}); ` +
      `rangeCalls=${result.rangeCalls}; rangeBytes=${result.rangeBytes}`,
  );
  console.info(
    `WebmDriver.probe(range prefix) median=${result.medianMs.toFixed(3)} ms ` +
      `peakRSS+=${result.peakMemoryMb.toFixed(2)} MiB checksum=${result.checksum} ` +
      `samples=[${formatSamples(result.samplesMs)}]`,
  );
}

await main();
