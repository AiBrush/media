#!/usr/bin/env bun
/**
 * Focused Session 6 R3 benchmark: WebM/MKV driver-native keyframe stream-copy trim.
 *
 * Runs the exact R3 trim cells over real sibling-harness fixtures, validates each output by reparsing
 * it with the WebM/MKV parser, and reports median wall time plus source/output throughput. This is a
 * fresh multi-sample benchmark, not a committed broad-suite baseline.
 */

import { readFile } from 'node:fs/promises';
import { WebmDriver, demuxWebm, parseWebm } from '../src/drivers/webm/webm-driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA_TEST = `${ROOT}../media-test/media-browser-test/fixtures/media/`;
const WARMUP = 2;
const ITERS = 9;

interface BenchCase {
  id: string;
  asset: string;
  container: 'webm' | 'mkv';
  startUs: number;
  endUs: number;
}

interface BenchResult {
  id: string;
  asset: string;
  sourceBytes: number;
  outputBytes: number;
  outputPackets: number;
  medianMs: number;
  sourceMbPerSec: number;
  outputMbPerSec: number;
}

const CASES: readonly BenchCase[] = [
  {
    id: 'trim/vp9_keyframe_aligned',
    asset: 'vp9_1080p_10s.webm',
    container: 'webm',
    startUs: 1_000_000,
    endUs: 5_000_000,
  },
  {
    id: 'trim/mkv_keyframe_aligned',
    asset: 'h264_in_mkv.mkv',
    container: 'mkv',
    startUs: 1_000_000,
    endUs: 5_000_000,
  },
  {
    id: 'trim/av1_keyframe_aligned',
    asset: 'av1_720p_5s.webm',
    container: 'webm',
    startUs: 1_000_000,
    endUs: 4_000_000,
  },
  {
    id: 'trim/vp8_keyframe_aligned',
    asset: 'vp8_720p_10s.webm',
    container: 'webm',
    startUs: 1_000_000,
    endUs: 5_000_000,
  },
  {
    id: 'trim/vp9_noop_full_range_idempotent',
    asset: 'vp9_1080p_10s.webm',
    container: 'webm',
    startUs: 0,
    endUs: 10_000_000,
  },
];

let checksumSink = 0;

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    checksumSink = (checksumSink + (value[0] ?? 0)) | 0;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.byteLength;
  }
  return out;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

async function trimOnce(input: Uint8Array, c: BenchCase): Promise<Uint8Array> {
  const streamCopy = WebmDriver.streamCopy;
  if (streamCopy === undefined) throw new Error('WebmDriver.streamCopy is not implemented');
  return collect(
    await streamCopy(
      fromBytes(input, { mime: c.container === 'mkv' ? 'video/x-matroska' : 'video/webm' }),
      {
        container: c.container,
        trim: { startSec: c.startUs / 1e6, endSec: c.endUs / 1e6 },
      },
    ),
  );
}

function validateOutput(bytes: Uint8Array, c: BenchCase): number {
  const info = parseWebm(bytes);
  if (info.container !== c.container) {
    throw new Error(`${c.id}: expected ${c.container}, got ${info.container}`);
  }
  const packets = demuxWebm(bytes).framesByIndex.reduce((sum, frames) => sum + frames.length, 0);
  if (packets === 0) throw new Error(`${c.id}: trim produced no packets`);
  return packets;
}

async function benchCase(c: BenchCase): Promise<BenchResult> {
  const input = new Uint8Array(await readFile(`${MEDIA_TEST}${c.asset}`));
  let output = await trimOnce(input, c);
  let outputPackets = validateOutput(output, c);
  for (let i = 0; i < WARMUP; i++) {
    output = await trimOnce(input, c);
    outputPackets = validateOutput(output, c);
  }
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const start = performance.now();
    output = await trimOnce(input, c);
    samples.push(performance.now() - start);
    outputPackets = validateOutput(output, c);
  }
  const medianMs = median(samples);
  const seconds = medianMs / 1000;
  const sourceMb = input.byteLength / (1024 * 1024);
  const outputMb = output.byteLength / (1024 * 1024);
  return {
    id: c.id,
    asset: c.asset,
    sourceBytes: input.byteLength,
    outputBytes: output.byteLength,
    outputPackets,
    medianMs,
    sourceMbPerSec: sourceMb / seconds,
    outputMbPerSec: outputMb / seconds,
  };
}

const results: BenchResult[] = [];
for (const c of CASES) results.push(await benchCase(c));

console.log(
  JSON.stringify(
    {
      benchmark: 'webm-keyframe-trim',
      warmup: WARMUP,
      iters: ITERS,
      results,
      checksumSink,
    },
    null,
    2,
  ),
);
