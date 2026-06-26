#!/usr/bin/env bun
/**
 * scripts/bench-opus.ts — fresh, multi-sample throughput benchmark for the vendored libopus-wasm core
 * (BUILD_INSTRUCTIONS §2 "a benchmark"; ADR-088). The core runs in Node, so encode AND decode throughput
 * are measured here (no browser): re-chunk real/synthetic PCM into 20 ms frames, encode each to an Opus
 * packet, then decode it back — reporting the median of N runs (warmup discarded) + a checksum so the
 * work can't be elided.
 *
 *   bun run scripts/bench-opus.ts
 */

import { FrameAccumulator, frameSamplesAtRate } from '../src/codecs/wasm-opus/opus.ts';
import { readWavPcm } from '../src/drivers/wav/pcm.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const WARMUP = 2;
const ITERS = 7;
const BITRATE = 96_000;

interface CoreLike {
  createEncoder(init: {
    sampleRate: number;
    channels: number;
    bitrate: number | 'auto';
    frameMs: number;
    frameSamples: number;
  }): Promise<{ encode(f: Float32Array): Uint8Array; free(): void }>;
  createDecoder(init: {
    sampleRate: number;
    channels: number;
    preSkip: number;
  }): Promise<{ decode(p: Uint8Array, samples: number): Float32Array; free(): void }>;
}

let sink = 0;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Interleaved f32 from a real WAV fixture (≤2 channels), resampling-free (must be Opus-native). */
async function wavInterleaved(
  id: string,
): Promise<{ rate: number; ch: number; pcm: Float32Array }> {
  const wav = readWavPcm(
    new Uint8Array(await Bun.file(`${ROOT}fixtures/media/${id}`).arrayBuffer()),
  );
  const ch = Math.min(wav.channels, 2);
  const pcm = new Float32Array(wav.frames * ch);
  for (let c = 0; c < ch; c++) {
    const plane = wav.planar[c];
    if (!plane) continue;
    for (let i = 0; i < wav.frames; i++) pcm[i * ch + c] = plane[i] ?? 0;
  }
  return { rate: wav.sampleRate, ch, pcm };
}

/** A synthetic 48 kHz stereo harmonic source of `seconds` length (when no large real fixture exists). */
function synth(seconds: number): { rate: number; ch: number; pcm: Float32Array } {
  const rate = 48_000;
  const ch = 2;
  const frames = rate * seconds;
  const pcm = new Float32Array(frames * ch);
  for (let i = 0; i < frames; i++) {
    const t = (2 * Math.PI * i) / rate;
    pcm[i * ch] = 0.3 * Math.sin(440 * t) + 0.15 * Math.sin(880 * t);
    pcm[i * ch + 1] = 0.3 * Math.sin(660 * t) + 0.15 * Math.sin(1320 * t);
  }
  return { rate, ch, pcm };
}

/** Encode interleaved PCM into Opus packets (one per 20 ms frame). */
async function encodePackets(
  core: CoreLike,
  src: { rate: number; ch: number; pcm: Float32Array },
): Promise<Uint8Array[]> {
  const frameSamples = frameSamplesAtRate(src.rate, 20);
  const enc = await core.createEncoder({
    sampleRate: src.rate,
    channels: src.ch,
    bitrate: BITRATE,
    frameMs: 20,
    frameSamples,
  });
  try {
    const acc = new FrameAccumulator(src.ch, frameSamples);
    acc.push(src.pcm);
    const packets: Uint8Array[] = [];
    for (let f = acc.pull(); f !== undefined; f = acc.pull()) packets.push(enc.encode(f));
    return packets;
  } finally {
    enc.free();
  }
}

async function main(): Promise<void> {
  const mod = (await import('../src/codecs/wasm-opus/opus-core.js')) as {
    default: () => Promise<unknown>;
    createOpusCore: () => CoreLike;
  };
  await mod.default();
  const core = mod.createOpusCore();

  const sources: Array<{ id: string; src: { rate: number; ch: number; pcm: Float32Array } }> = [
    { id: 'sfx-pcm-s16.wav', src: await wavInterleaved('sfx-pcm-s16.wav') },
    { id: 'sfx-pcm-s24.wav', src: await wavInterleaved('sfx-pcm-s24.wav') },
    { id: 'sfx-pcm-f32.wav', src: await wavInterleaved('sfx-pcm-f32.wav') },
    { id: 'synth-48k-stereo-2s', src: synth(2) },
  ];

  const frameSamplesAt = (rate: number): number => frameSamplesAtRate(rate, 20);

  console.info(
    `Opus encode + decode throughput (median of ${ITERS} runs, libopus-wasm, single-thread):`,
  );
  for (const { id, src } of sources) {
    if (![8_000, 12_000, 16_000, 24_000, 48_000].includes(src.rate)) {
      console.info(`  ${id.padEnd(22)} skip (rate ${src.rate} not Opus-native)`);
      continue;
    }
    const samples = src.pcm.length / src.ch;
    const frameSamples = frameSamplesAt(src.rate);

    // ── encode ──
    for (let i = 0; i < WARMUP; i++) {
      sink = (sink + ((await encodePackets(core, src))[0]?.length ?? 0)) | 0;
    }
    const encTimes: number[] = [];
    let packets: Uint8Array[] = [];
    for (let i = 0; i < ITERS; i++) {
      const t0 = Bun.nanoseconds();
      packets = await encodePackets(core, src);
      encTimes.push(Bun.nanoseconds() - t0);
      sink = (sink + (packets[0]?.length ?? 0)) | 0;
    }
    const encNs = median(encTimes);
    const encMs = encNs / 1e6;
    const encMSamplesPerSec = samples / (encNs / 1e9) / 1e6;
    const opusBytes = packets.reduce((n, p) => n + p.byteLength, 0);

    // ── decode ──
    const decTimes: number[] = [];
    for (let i = 0; i < ITERS; i++) {
      const dec = await core.createDecoder({ sampleRate: src.rate, channels: src.ch, preSkip: 0 });
      const t0 = Bun.nanoseconds();
      let acc = 0;
      for (const p of packets) acc += dec.decode(p, frameSamples).length;
      decTimes.push(Bun.nanoseconds() - t0);
      sink = (sink + acc) | 0;
      dec.free();
    }
    const decNs = median(decTimes);
    const decMs = decNs / 1e6;
    const decMSamplesPerSec = samples / (decNs / 1e9) / 1e6;
    const kbps = (opusBytes * 8) / (samples / src.rate) / 1000;

    console.info(
      `  ${id.padEnd(22)} enc ${encMs.toFixed(2).padStart(7)} ms ${encMSamplesPerSec
        .toFixed(1)
        .padStart(6)} Ms/s | dec ${decMs.toFixed(2).padStart(7)} ms ${decMSamplesPerSec
        .toFixed(1)
        .padStart(6)} Ms/s | ${kbps.toFixed(0)} kbps (${src.ch}ch ${src.rate}Hz)`,
    );
  }
  console.info(`\n(checksum ${sink})`);
}

await main();
