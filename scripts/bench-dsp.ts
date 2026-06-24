#!/usr/bin/env bun
/**
 * scripts/bench-dsp.ts — fresh, multi-sample throughput benchmark for the pure-TS audio-dsp core
 * (BUILD_INSTRUCTIONS §2 "a benchmark"; doc 09 §audio-dsp). Runs the real kernels on the real WAV
 * corpus, reports the median of N timed iterations (warmup discarded), and prints a checksum so the
 * optimizer can't elide the work.
 *
 *   bun run bench-dsp
 */

import { readWavPcm } from '../src/drivers/wav/pcm.ts';
import { gain } from '../src/dsp/gain.ts';
import { remix } from '../src/dsp/mix.ts';
import { type PcmAudio, decodePcm, encodePcm } from '../src/dsp/pcm.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const FIXTURES = ['sin_440Hz_-6dBFS_1s.wav', 'speech.wav'];
const WARMUP = 20;
const ITERS = 200;

let sink = 0; // accumulate a byte from each result to defeat dead-code elimination

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Time `fn` over ITERS runs (after WARMUP); return median nanoseconds. */
function timeNs(fn: () => number): number {
  for (let i = 0; i < WARMUP; i++) sink = (sink + fn()) | 0;
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = Bun.nanoseconds();
    sink = (sink + fn()) | 0;
    samples.push(Bun.nanoseconds() - t0);
  }
  return median(samples);
}

function report(label: string, totalSamples: number, ns: number): void {
  const msPerOp = ns / 1e6;
  const mSamplesPerSec = totalSamples / (ns / 1e9) / 1e6;
  console.info(
    `  ${label.padEnd(26)} ${msPerOp.toFixed(3).padStart(8)} ms   ${mSamplesPerSec.toFixed(1).padStart(8)} Msamples/s`,
  );
}

function benchOne(id: string, bytes: Uint8Array): void {
  const audio: PcmAudio = readWavPcm(bytes);
  const total = audio.frames * audio.channels;
  const raw = encodePcm(audio, 's16'); // canonical interleaved s16 bytes to decode from
  console.info(`\n${id} — ${audio.frames} frames × ${audio.channels}ch @ ${audio.sampleRate} Hz`);

  report(
    'decode s16 → planar',
    total,
    timeNs(() => decodePcm(raw, 's16', audio.channels, audio.sampleRate).frames),
  );
  report(
    'encode planar → s16',
    total,
    timeNs(() => encodePcm(audio, 's16')[0] ?? 0),
  );
  report(
    'convert s16 → f32',
    total,
    timeNs(() => encodePcm(audio, 'f32')[0] ?? 0),
  );
  report(
    'gain (-6 dB)',
    total,
    timeNs(() => gain(audio, -6).planar.length),
  );
  report(
    'remix mono → stereo',
    total,
    timeNs(() => remix(audio, 2).channels),
  );
}

async function main(): Promise<void> {
  console.info('audio-dsp throughput (median of', ITERS, 'iterations, pure TS, single-thread):');
  for (const id of FIXTURES) {
    const bytes = new Uint8Array(await Bun.file(`${ROOT}fixtures/media/${id}`).arrayBuffer());
    benchOne(id, bytes);
  }
  console.info(`\n(checksum ${sink})`);
}

await main();
