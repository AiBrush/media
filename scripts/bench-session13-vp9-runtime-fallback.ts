/**
 * ADR-284 seam microbenchmark. This isolates the bounded recording/replay coordinator; the authoritative
 * real VP9→AV1 wall/memory result remains the fresh public browser export because Node has no VideoDecoder.
 */

import { performance } from 'node:perf_hooks';
import { decodeVideoWithRuntimeFallback } from '../src/api/replayable-video-decoder.ts';
import type { EncodedChunk, RawFrame } from '../src/contracts/driver.ts';
import { CapabilityError } from '../src/contracts/errors.ts';

const WARMUP = 5;
const SAMPLES = 31;
const PACKETS = 180;

class BenchFrame {
  constructor(readonly timestamp: number) {}
  close(): void {}
}

function input(): ReadableStream<EncodedChunk> {
  return new ReadableStream<EncodedChunk>({
    start(controller): void {
      for (let index = 0; index < PACKETS; index++) {
        controller.enqueue({
          byteLength: 1_024,
          timestamp: index * 33_333,
        } as unknown as EncodedChunk);
      }
      controller.close();
    },
  });
}

function decoder(failFirst: boolean): TransformStream<EncodedChunk, VideoFrame> {
  let first = true;
  return new TransformStream<EncodedChunk, RawFrame>({
    transform(chunk, controller): void {
      if (failFirst && first) {
        first = false;
        throw new CapabilityError('capability-miss', 'bench native runtime miss');
      }
      controller.enqueue(new BenchFrame(chunk.timestamp) as unknown as RawFrame);
    },
  }) as TransformStream<EncodedChunk, VideoFrame>;
}

async function drain(stream: ReadableStream<VideoFrame>): Promise<number> {
  const reader = stream.getReader();
  let checksum = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return checksum >>> 0;
      checksum = (checksum + result.value.timestamp) >>> 0;
      result.value.close();
    }
  } finally {
    reader.releaseLock();
  }
}

async function direct(): Promise<number> {
  return drain(input().pipeThrough(decoder(false)));
}

async function guarded(): Promise<number> {
  return drain(
    decodeVideoWithRuntimeFallback(
      input(),
      () => decoder(false),
      async () => decoder(false),
    ),
  );
}

async function failFirstReplay(): Promise<number> {
  return drain(
    decodeVideoWithRuntimeFallback(
      input(),
      () => decoder(true),
      async () => decoder(false),
    ),
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function mad(values: readonly number[], center: number): number {
  return median(values.map((value) => Math.abs(value - center)));
}

async function measure(name: string, run: () => Promise<number>): Promise<void> {
  let checksum = 0;
  for (let index = 0; index < WARMUP; index++) checksum = await run();
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index++) {
    const start = performance.now();
    checksum = await run();
    samples.push(performance.now() - start);
  }
  const wall = median(samples);
  console.log(
    `${name}: ${wall.toFixed(3)} ms median, ${mad(samples, wall).toFixed(3)} ms MAD, checksum=${checksum}`,
  );
}

await measure('direct-native', direct);
await measure('bounded-primary', guarded);
await measure('fail-first-replay', failFirstReplay);
