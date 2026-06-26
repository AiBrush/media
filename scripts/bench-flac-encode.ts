#!/usr/bin/env bun
/**
 * scripts/bench-flac-encode.ts — fresh, multi-sample throughput + compression benchmark for the pure-TS
 * FLAC ENCODER (BUILD_INSTRUCTIONS §2 "a benchmark"; ADR-085). Decodes the real IETF FLAC corpus to PCM,
 * re-encodes it with the compressing encoder, and reports the median of N runs (warmup discarded) plus the
 * compression ratio vs a verbatim baseline and a checksum (so the work can't be elided).
 *
 *   bun run scripts/bench-flac-encode.ts
 */

import { decodeFlac } from '../src/codecs/flac/decode.ts';
import {
  type FlacPcm,
  encodeFlac,
  encodeFlacVerbatim,
  flacPcmFromDecoded,
} from '../src/codecs/flac/encode.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const FILES = [
  'flac-08bit.flac',
  'flac-12bit.flac',
  'flac-blocksize-16.flac',
  'flac-5_1ch.flac',
  'flac-24bit-hires.flac',
  'flac-verbatim.flac',
  'flac-fixed-orders.flac',
  'sfx.flac',
];
const WARMUP = 2;
const ITERS = 7;

let sink = 0;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Raw PCM byte size the encoder ingests (samples × channels × ceil(bits/8)). */
function pcmBytes(pcm: FlacPcm): number {
  return pcm.totalSamples * pcm.channels * Math.ceil(pcm.bitsPerSample / 8);
}

async function main(): Promise<void> {
  console.info(
    `FLAC encode throughput + ratio (median of ${ITERS} runs, pure TS, single-thread, blockSize 4096):`,
  );
  for (const id of FILES) {
    const bytes = new Uint8Array(await Bun.file(`${ROOT}fixtures/media/${id}`).arrayBuffer());
    const pcm = flacPcmFromDecoded(decodeFlac(bytes));
    const inBytes = pcmBytes(pcm);

    const compressed = encodeFlac(pcm, { blockSize: 4096 });
    const verbatim = encodeFlacVerbatim(pcm, { blockSize: 4096 });
    const ratio = compressed.byteLength / verbatim.byteLength;

    for (let i = 0; i < WARMUP; i++) {
      sink = (sink + (encodeFlac(pcm, { blockSize: 4096 })[0] ?? 0)) | 0;
    }
    const times: number[] = [];
    for (let i = 0; i < ITERS; i++) {
      const t0 = Bun.nanoseconds();
      const out = encodeFlac(pcm, { blockSize: 4096 });
      times.push(Bun.nanoseconds() - t0);
      sink = (sink + (out[16] ?? 0)) | 0; // a STREAMINFO byte — keeps the encode from being elided
    }
    const ns = median(times);
    const msPerOp = ns / 1e6;
    const mbPerSec = inBytes / (ns / 1e9) / 1e6;
    console.info(
      `  ${id.padEnd(24)} ${msPerOp.toFixed(2).padStart(8)} ms  ${mbPerSec
        .toFixed(1)
        .padStart(7)} MB/s  ratio ${ratio.toFixed(3)}  (${pcm.channels}ch ${pcm.bitsPerSample}bit)`,
    );
  }
  console.info(`\n(checksum ${sink})`);
}

await main();
