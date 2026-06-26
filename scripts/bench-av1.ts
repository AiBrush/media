#!/usr/bin/env bun
/**
 * scripts/bench-av1.ts — fresh, multi-sample throughput benchmark for the vendored dav1d AV1-decode core
 * (BUILD_INSTRUCTIONS §2 "a benchmark"; ADR-093). The dav1d.js core runs in Node, so decode throughput is
 * measured here (no browser): demux a real AV1 mp4 to access units (the engine's own MP4 demuxer), decode
 * every frame, and report the median of N runs (warmup discarded) + Mpixels/s + a checksum so the work
 * can't be elided.
 *
 *   bun run scripts/bench-av1.ts
 */

import { muxTracksFromMovie, readMovie } from '../src/drivers/mp4/mp4-driver.ts';

interface CoreLike {
  createDecoder(init: {
    codec: 'av1';
    profile: number;
    level: number;
    tier: 'main' | 'high';
    bitDepth: 8 | 10 | 12;
    monochrome: boolean;
    chromaSubsampling: '420';
  }): Promise<{
    decode(packet: Uint8Array): { width: number; height: number; data: Uint8Array }[];
    free(): void;
  }>;
}

const ROOT = new URL('..', import.meta.url).pathname;
const WARMUP = 2;
const ITERS = 7;
const FILES = ['av1.mp4'] as const;

let sink = 0;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** A minimal `RandomAccess` over fixture bytes. */
function randomAccess(bytes: Uint8Array): {
  size: number;
  read(o: number, l: number): Promise<Uint8Array>;
} {
  return {
    size: bytes.byteLength,
    read: (offset, length) =>
      Promise.resolve(bytes.subarray(offset, Math.min(offset + length, bytes.byteLength))),
  };
}

/** Per-frame AV1 access units + the coded dims, via the engine's MP4 demuxer. */
async function av1Units(
  id: string,
): Promise<{ units: Uint8Array[]; width: number; height: number }> {
  const bytes = new Uint8Array(await Bun.file(`${ROOT}fixtures/media/${id}`).arrayBuffer());
  const ra = randomAccess(bytes);
  const movie = await readMovie(ra);
  const tracks = await muxTracksFromMovie(ra, movie);
  const video = tracks.find(
    (t) => t.samples[0]?.data !== undefined && t.sampleEntryType === 'av01',
  );
  if (!video) throw new Error(`${id}: no AV1 track`);
  return {
    units: video.samples.map((s) => s.data),
    width: video.width ?? 0,
    height: video.height ?? 0,
  };
}

async function main(): Promise<void> {
  const mod = (await import('../src/codecs/wasm-av1/dav1d-core.js')) as {
    default: (u?: unknown) => Promise<unknown>;
    createDav1dCore: () => CoreLike;
  };
  await mod.default(new URL('../src/codecs/wasm-av1/dav1d_wasm_bg.wasm', import.meta.url));
  const core = mod.createDav1dCore();

  console.info(`AV1 decode throughput (median of ${ITERS} runs, dav1d-wasm, single-thread):`);
  for (const id of FILES) {
    const { units, width, height } = await av1Units(id);

    const decodeAll = async (): Promise<number> => {
      const dec = await core.createDecoder({
        codec: 'av1',
        profile: 0,
        level: 0,
        tier: 'main',
        bitDepth: 8,
        monochrome: false,
        chromaSubsampling: '420',
      });
      let pixels = 0;
      for (const unit of units) {
        for (const f of dec.decode(unit)) {
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
      `  ${id.padEnd(20)} ${ms.toFixed(2).padStart(8)} ms  ${mPixPerSec
        .toFixed(1)
        .padStart(7)} Mpx/s  (${width}x${height}, ${units.length} frames)`,
    );
  }
  console.info(`\n(checksum ${sink})`);
}

await main();
