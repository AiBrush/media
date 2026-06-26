#!/usr/bin/env bun
/**
 * scripts/bench-vpx.ts — fresh, multi-sample throughput benchmark for the vendored ogv.js VP8/VP9 decode
 * cores (BUILD_INSTRUCTIONS §2 "a benchmark"; ADR-094). The ogv.js cores run in Node, so decode throughput
 * is measured here (no browser): demux a real VP8 + a real VP9 WebM to access units (the engine's own WebM
 * demuxer), decode every frame, and report the median of N runs (warmup discarded) + Mpixels/s + a checksum.
 *
 *   bun run scripts/bench-vpx.ts
 */

import { demuxWebm } from '../src/drivers/webm/webm-driver.ts';

interface CoreLike {
  createDecoder(init: {
    codec: 'vp8' | 'vp9';
    profile: number;
    bitDepth: 8 | 10 | 12;
    codedWidth?: number;
    codedHeight?: number;
  }): Promise<{
    decode(packet: Uint8Array): { width: number; height: number; data: Uint8Array }[];
    free(): void;
  }>;
}

const ROOT = new URL('..', import.meta.url).pathname;
const WARMUP = 2;
const ITERS = 7;
const FILES: ReadonlyArray<{ id: string; codec: 'vp8' | 'vp9'; width: number; height: number }> = [
  { id: 'white.webm', codec: 'vp8', width: 320, height: 240 },
  { id: 'movie_5.webm', codec: 'vp9', width: 320, height: 240 },
];

let sink = 0;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Per-frame access units for the named codec's video track. */
async function units(id: string, codec: 'vp8' | 'vp9'): Promise<Uint8Array[]> {
  const bytes = new Uint8Array(await Bun.file(`${ROOT}fixtures/media/${id}`).arrayBuffer());
  const demux = demuxWebm(bytes);
  const index = demux.info.tracks.findIndex(
    (t) => t.mediaType === 'video' && (t.codec ?? '').includes(codec),
  );
  if (index < 0) throw new Error(`${id}: no ${codec} track`);
  return (demux.framesByIndex[index] ?? []).map((f) => f.data);
}

async function main(): Promise<void> {
  const mod = (await import('../src/codecs/wasm-vpx/vpx-core.js')) as {
    default: (u?: unknown) => Promise<unknown>;
    createVpxCore: () => CoreLike;
  };
  await mod.default(new URL('../src/codecs/wasm-vpx/vpx.wasm', import.meta.url));
  const core = mod.createVpxCore();

  console.info(
    `VP8/VP9 decode throughput (median of ${ITERS} runs, ogv.js libvpx, single-thread):`,
  );
  for (const { id, codec, width, height } of FILES) {
    const aus = await units(id, codec);

    const decodeAll = async (): Promise<number> => {
      const dec = await core.createDecoder({
        codec,
        profile: 0,
        bitDepth: 8,
        codedWidth: width,
        codedHeight: height,
      });
      let pixels = 0;
      for (const au of aus) {
        for (const f of dec.decode(au)) {
          pixels += f.width * f.height;
          sink = (sink + (f.data[0] ?? 0)) | 0;
        }
      }
      dec.free();
      return pixels;
    };

    for (let i = 0; i < WARMUP; i++) sink = (sink + (await decodeAll())) | 0;
    const times: number[] = [];
    let pixels = 0;
    for (let i = 0; i < ITERS; i++) {
      const t0 = Bun.nanoseconds();
      pixels = await decodeAll();
      times.push(Bun.nanoseconds() - t0);
    }
    const ns = median(times);
    const ms = ns / 1e6;
    const mPixPerSec = pixels / (ns / 1e9) / 1e6;
    console.info(
      `  ${id.padEnd(20)} ${codec}  ${ms.toFixed(2).padStart(8)} ms  ${mPixPerSec
        .toFixed(1)
        .padStart(7)} Mpx/s  (${width}x${height}, ${aus.length} frames)`,
    );
  }
  console.info(`\n(checksum ${sink})`);
}

await main();
