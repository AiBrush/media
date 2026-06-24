#!/usr/bin/env bun
/**
 * scripts/bench-flac.ts — fresh, multi-sample throughput benchmark for the pure-TS FLAC decoder
 * (BUILD_INSTRUCTIONS §2 "a benchmark"; ADR-024). Decodes the real IETF FLAC conformance corpus and
 * reports the median of N runs (warmup discarded) + a checksum so the work can't be elided.
 *
 *   bun run bench-flac
 */

import { decodeFlac } from '../src/codecs/flac/decode.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const FILES = [
  'sfx.flac',
  'flac-08bit.flac',
  'flac-wasted-bits.flac',
  'flac-12bit.flac',
  'flac-escaped-partitions.flac',
  'flac-qlp2.flac',
  'flac-fixed-orders.flac',
  'flac-verbatim.flac',
];
const WARMUP = 2;
const ITERS = 7;

let sink = 0;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

async function main(): Promise<void> {
  console.info(`FLAC decode throughput (median of ${ITERS} runs, pure TS, single-thread):`);
  for (const id of FILES) {
    const bytes = new Uint8Array(await Bun.file(`${ROOT}fixtures/media/${id}`).arrayBuffer());
    const probe = decodeFlac(bytes);
    const totalSamples = probe.totalSamples * probe.channels;

    for (let i = 0; i < WARMUP; i++) sink = (sink + decodeFlac(bytes).totalSamples) | 0;
    const times: number[] = [];
    for (let i = 0; i < ITERS; i++) {
      const t0 = Bun.nanoseconds();
      sink = (sink + (decodeFlac(bytes).samples[0]?.[0] ?? 0)) | 0;
      times.push(Bun.nanoseconds() - t0);
    }
    const ns = median(times);
    const msPerOp = ns / 1e6;
    const mSamplesPerSec = totalSamples / (ns / 1e9) / 1e6;
    console.info(
      `  ${id.padEnd(28)} ${msPerOp.toFixed(2).padStart(8)} ms  ${mSamplesPerSec.toFixed(1).padStart(7)} Msamples/s  (${probe.channels}ch ${probe.bitsPerSample}bit)`,
    );
  }
  console.info(`\n(checksum ${sink})`);
}

await main();
