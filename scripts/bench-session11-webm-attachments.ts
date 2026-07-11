#!/usr/bin/env bun
/**
 * Multi-sample same-container Matroska attachment stream-copy benchmark on the real Session 11 corpus.
 * Every output byte reaches an FNV-1a checksum sink, so attachment and packet serialization cannot be
 * elided. Correctness is gated separately by webm-stream-copy.test.ts against raw digests and ffprobe.
 */

import { readFile } from 'node:fs/promises';
import { WebmDriver } from '../src/drivers/webm/webm-driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 3;
const SAMPLES = 9;
const SUBJECT = new URL(
  '../../media-test/fixtures/media/scenarios/metadata/write_mkv_tags/03.mkv',
  import.meta.url,
).pathname;

interface Sample {
  readonly elapsedMs: number;
  readonly checksum: number;
  readonly outputBytes: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

async function run(input: Uint8Array): Promise<Sample> {
  const streamCopy = WebmDriver.streamCopy;
  if (streamCopy === undefined) throw new Error('WebmDriver.streamCopy is unavailable');
  const started = performance.now();
  const stream = await streamCopy(fromBytes(input, { mime: 'video/x-matroska' }), {
    container: 'mkv',
  });
  const reader = stream.getReader();
  let checksum = 0x811c9dc5;
  let outputBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    outputBytes += value.byteLength;
    for (const byte of value) checksum = Math.imul(checksum ^ byte, 0x01000193) >>> 0;
  }
  return { elapsedMs: performance.now() - started, checksum, outputBytes };
}

const input = new Uint8Array(await readFile(SUBJECT));
const timings: number[] = [];
let checksum = 0;
let outputBytes = 0;
for (let index = 0; index < WARMUP + SAMPLES; index++) {
  const sample = await run(input);
  checksum = (checksum + sample.checksum) >>> 0;
  outputBytes = sample.outputBytes;
  if (index >= WARMUP) timings.push(sample.elapsedMs);
}

const rssBefore = process.memoryUsage().rss;
const memorySample = await run(input);
const peakMemoryMb = Math.max(0, process.memoryUsage().rss - rssBefore) / (1024 * 1024);
checksum = (checksum + memorySample.checksum) >>> 0;

console.info(
  `Session 11 Matroska attachment stream copy — input=${input.byteLength} bytes; ` +
    `output=${outputBytes} bytes; median=${median(timings).toFixed(3)} ms; ` +
    `peakRSS+=${peakMemoryMb.toFixed(2)} MiB; checksum=${checksum}; ` +
    `samples=[${timings.map((time) => time.toFixed(3)).join(', ')}]`,
);
