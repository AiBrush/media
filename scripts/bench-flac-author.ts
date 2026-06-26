#!/usr/bin/env bun
/**
 * scripts/bench-flac-author.ts — fresh, multi-sample throughput benchmark for FLAC *authoring* (the
 * `convert(→flac)` PCM route; ADR-024). Encodes the real WAV/PCM corpus to native FLAC and reports the
 * median of N runs (warmup discarded), the compression ratio vs the raw PCM, plus a checksum so the work
 * cannot be elided. Companion to `bench-flac.ts` (decode throughput).
 *
 *   bun run bench-flac-author
 */

import { encodeFlac, flacPcmFromPcmAudio } from '../src/codecs/flac/encode.ts';
import { readWavPcm } from '../src/drivers/wav/pcm.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const FILES = [
  'sfx-pcm-u8.wav',
  'sfx-pcm-s16.wav',
  'sfx-pcm-s24.wav',
  'sfx-pcm-s32.wav',
  'stereo-48000.wav',
  'sin_440Hz_-6dBFS_1s.wav',
  'speech.wav',
  'sfx-pcm-f32.wav',
] as const;
const WARMUP = 2;
const ITERS = 7;

let sink = 0;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

async function main(): Promise<void> {
  console.info(`FLAC authoring throughput (median of ${ITERS} runs, pure TS, single-thread):`);
  for (const id of FILES) {
    const bytes = new Uint8Array(await Bun.file(`${ROOT}fixtures/media/${id}`).arrayBuffer());
    const wav = readWavPcm(bytes);
    const pcm = flacPcmFromPcmAudio(wav, wav.format);
    const totalSamples = pcm.totalSamples * pcm.channels;
    const rawBytes = totalSamples * Math.ceil(pcm.bitsPerSample / 8);

    for (let i = 0; i < WARMUP; i++) sink = (sink + encodeFlac(pcm).byteLength) | 0;
    const times: number[] = [];
    let outBytes = 0;
    for (let i = 0; i < ITERS; i++) {
      const t0 = Bun.nanoseconds();
      const out = encodeFlac(pcm);
      times.push(Bun.nanoseconds() - t0);
      outBytes = out.byteLength;
      sink = (sink + (out[0] ?? 0)) | 0;
    }
    const ns = median(times);
    const msPerOp = ns / 1e6;
    const mSamplesPerSec = totalSamples / (ns / 1e9) / 1e6;
    const ratio = outBytes / rawBytes;
    console.info(
      `  ${id.padEnd(28)} ${msPerOp.toFixed(2).padStart(8)} ms  ${mSamplesPerSec.toFixed(1).padStart(7)} Msamples/s  ${(ratio * 100).toFixed(1).padStart(5)}% of raw  (${pcm.channels}ch ${pcm.bitsPerSample}bit)`,
    );
  }
  console.info(`\n(checksum ${sink})`);
}

await main();
