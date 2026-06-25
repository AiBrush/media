#!/usr/bin/env bun
/**
 * scripts/bench-sources.ts — fresh, multi-sample throughput benchmark for the input **source** layer
 * (BUILD_INSTRUCTIONS §2 "a benchmark"; ADR-013). Measures the per-read overhead of the source seam on
 * **real** corpus files, comparing:
 *   - a full `stream()` drain vs. an MP4-probe-shaped scatter of range reads (header + trailing `moov`),
 *   - an uncached URL source (every range re-fetches the in-memory range server) vs. a `cacheSource`
 *     where the second pass is served entirely from the range cache (the preload win: zero re-fetch).
 *
 * The "network" is a deterministic in-memory range server backed by the file's real bytes (so the number
 * reflects the source/cache code, not a flaky socket). Reports the median of N runs (warmup discarded) and
 * a byte checksum so the work can't be optimized away.
 *
 *   bun run bench-sources
 */

import { cacheSource } from '../src/sources/cache.ts';
import { type Source, fromBytes } from '../src/sources/source.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const FILES = ['h264.mp4', 'bear-1280x720.mp4', 'movie_5.mp4'];
const WARMUP = 3;
const ITERS = 11;

let sink = 0;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** A deterministic in-memory range server backed by real bytes, plus a fetch-call counter. */
function rangeServer(bytes: Uint8Array): { fetch: typeof fetch; calls: () => number } {
  let count = 0;
  const total = bytes.byteLength;
  const fetchImpl = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    count++;
    const method = (init?.method ?? 'GET').toUpperCase();
    const header = init?.headers as { Range?: string } | undefined;
    const range = header?.Range ?? null;
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Length': String(total) } });
    }
    if (range) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!m) return new Response(null, { status: 416 });
      const a = Number(m[1]);
      const end = Math.min(Number(m[2]) + 1, total);
      const slice = bytes.subarray(a, Math.max(a, end));
      return new Response(slice.slice().buffer, {
        status: 206,
        headers: { 'Content-Range': `bytes ${a}-${a + slice.byteLength - 1}/${total}` },
      });
    }
    return new Response(bytes.slice().buffer, {
      status: 200,
      headers: { 'Content-Length': String(total) },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls: () => count };
}

async function drain(s: ReadableStream<Uint8Array>): Promise<number> {
  const reader = s.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    sink = (sink + (value[0] ?? 0)) | 0;
  }
  return n;
}

/** An MP4-probe-shaped scatter: head 64 KiB + trailing 64 KiB (where `moov` usually sits) + 8 mid windows. */
function probeWindows(size: number): [number, number][] {
  const head: [number, number] = [0, Math.min(64 * 1024, size)];
  const tail: [number, number] = [Math.max(0, size - 64 * 1024), size];
  const mids: [number, number][] = [];
  for (let i = 1; i <= 8; i++) {
    const lo = Math.floor((size * i) / 10);
    mids.push([lo, Math.min(lo + 4096, size)]);
  }
  return [head, tail, ...mids];
}

async function readRanges(src: Source, windows: readonly [number, number][]): Promise<number> {
  let n = 0;
  for (const [lo, hi] of windows) {
    if (!src.range) throw new Error('source has no range()');
    const bytes = await src.range(lo, hi);
    n += bytes.byteLength;
    sink = (sink + (bytes[0] ?? 0)) | 0;
  }
  return n;
}

async function timeMedian(fn: () => Promise<number>): Promise<{ ms: number; bytes: number }> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < ITERS; i++) {
    const t0 = Bun.nanoseconds();
    bytes = await fn();
    times.push(Bun.nanoseconds() - t0);
  }
  return { ms: median(times) / 1e6, bytes };
}

function mibPerSec(bytes: number, ms: number): number {
  return bytes / (1024 * 1024) / (ms / 1000);
}

async function main(): Promise<void> {
  console.info(
    `Source read throughput (median of ${ITERS} runs; in-memory range server, real files):\n`,
  );
  for (const id of FILES) {
    const bytes = new Uint8Array(await Bun.file(`${ROOT}fixtures/media/${id}`).arrayBuffer());
    const { fetch, calls } = rangeServer(bytes);
    globalThis.fetch = fetch;
    const windows = probeWindows(bytes.byteLength);
    const rangeBytes = windows.reduce((n, [lo, hi]) => n + (hi - lo), 0);

    // 1) Full drain — bytes source (in-memory baseline) vs URL source (through the range server).
    const fullBytes = await timeMedian(() => drain(fromBytes(bytes).stream()));
    const fullUrl = await timeMedian(() => drain(cacheSource(`mem://${id}`).stream()));

    // 2) Probe-shaped scatter of range reads through an uncached URL source (each window = one fetch).
    const before = calls();
    const rangeUrl = await timeMedian(() => readRanges(cacheSource(`mem://${id}`), windows));
    const fetchesPerPass = (calls() - before) / (WARMUP + ITERS);

    // 3) Same scatter, but a *primed* cache: warm once, then every read is a cache hit (zero re-fetch).
    const primed = cacheSource(`mem://${id}`);
    await readRanges(primed, windows); // warm
    const baseHits = calls();
    const rangeCached = await timeMedian(() => readRanges(primed, windows));
    const refetches = calls() - baseHits;

    console.info(`  ${id}  (${(bytes.byteLength / 1024).toFixed(0)} KiB)`);
    console.info(
      `    full drain   bytes-src ${mibPerSec(fullBytes.bytes, fullBytes.ms).toFixed(0).padStart(6)} MiB/s` +
        ` · url-src ${mibPerSec(fullUrl.bytes, fullUrl.ms).toFixed(0).padStart(6)} MiB/s`,
    );
    console.info(
      `    range scatter ${windows.length} windows / ${(rangeBytes / 1024).toFixed(0)} KiB:` +
        ` uncached ${rangeUrl.ms.toFixed(3)} ms (${fetchesPerPass.toFixed(0)} fetch/pass)` +
        ` · cached ${rangeCached.ms.toFixed(3)} ms (${refetches} re-fetch)` +
        ` → ${(rangeUrl.ms / Math.max(rangeCached.ms, 1e-6)).toFixed(1)}× faster`,
    );
  }
  console.info(`\n(checksum ${sink})`);
}

await main();
