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

import { readFileSync, readdirSync } from 'node:fs';
import { resolveHlsSource } from '../src/drivers/hls/hls-source.ts';
import { cacheSource } from '../src/sources/cache.ts';
import { cacheRepeatedProbeRangesFor } from '../src/sources/probe-range-cache.ts';
import { drainStream, readAllBytes } from '../src/sources/read-all.ts';
import { type Source, fromBytes, fromURL } from '../src/sources/source.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const FILES = ['h264.mp4', 'bear-1280x720.mp4', 'movie_5.mp4'];
/** Baked AES-128 HLS variants (RFC 8216 shapes) benched for playlist-resolve + decrypt + stitch cost. */
const HLS_VARIANTS = ['implicit-seq47', 'seq-2pow32', 'byterange', 'audio-adts'];
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

/**
 * Playlist-resolve + AES-128-decrypt + stitch throughput on the baked RFC 8216 corpus. Each iteration
 * re-parses the `.m3u8`, re-fetches every segment/key from an in-memory map (so the number is the
 * parse + WebCrypto-decrypt + concat cost, not disk I/O), and drains the stitched cleartext. Reports the
 * median of N runs and the decrypted MiB/s per variant shape (implicit / past-2^32-sequence IV,
 * byte-range, packed-audio) — a fresh, multi-sample bench that fails loud if a variant stops resolving.
 */
async function benchHls(): Promise<void> {
  const root = `${ROOT}fixtures/media-derived/hls-aes128/`;
  console.info(
    `\nHLS resolve+decrypt throughput (median of ${ITERS} runs; in-memory fetch, baked AES-128 corpus):\n`,
  );
  for (const id of HLS_VARIANTS) {
    const dir = `${root}${id}/`;
    const files = new Map<string, Uint8Array>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile())
        files.set(entry.name, new Uint8Array(readFileSync(`${dir}${entry.name}`)));
    }
    const playlistBytes = files.get('media.m3u8');
    if (playlistBytes === undefined) throw new Error(`bench HLS: ${id}/media.m3u8 is missing`);
    const playlistText = new TextDecoder().decode(playlistBytes);
    const baseUrl = `file://${dir}media.m3u8`;
    const fetchResource = (uri: string): Promise<Uint8Array> => {
      const bytes = files.get(uri.split('/').pop() ?? uri);
      if (bytes === undefined) throw new Error(`bench HLS fetch miss: ${uri}`);
      return Promise.resolve(bytes);
    };
    const { ms, bytes } = await timeMedian(async () =>
      drain((await resolveHlsSource(playlistText, { baseUrl, fetchResource })).stream()),
    );
    console.info(
      `  ${id.padEnd(15)} ${(bytes / 1024).toFixed(0).padStart(5)} KiB decrypted` +
        ` · ${ms.toFixed(3).padStart(8)} ms · ${mibPerSec(bytes, ms).toFixed(0).padStart(5)} MiB/s`,
    );
  }
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

    // 4) Whole-object read (sources.md §5 items 5/6): the canonical `readAllBytes` fast paths —
    //    owned in-memory buffer, one plain full GET via `Source.readAll` — vs the generic
    //    multi-pull stream drain of the same URL source.
    const wholeOwned = await timeMedian(async () => {
      const out = await readAllBytes(fromBytes(bytes));
      sink = (sink + (out[0] ?? 0)) | 0;
      return out.byteLength;
    });
    const wholeUrl = await timeMedian(async () => {
      const out = await readAllBytes(fromURL(`mem://${id}`));
      sink = (sink + (out[0] ?? 0)) | 0;
      return out.byteLength;
    });
    const wholeDrain = await timeMedian(async () => {
      const out = await drainStream(fromURL(`mem://${id}`).stream());
      sink = (sink + (out[0] ?? 0)) | 0;
      return out.byteLength;
    });

    // 5) Repeated probes of the same source object through the per-engine probe-range cache
    //    (sources.md §5 items 3/9): after one warm pass every window is a bounded in-memory hit
    //    served through the forwarding-Proxy wrapper — zero re-fetch — vs a fresh uncached scatter.
    const reuseWindows = windows.slice(0, 6); // head + tail + 4 mid windows (≤ 8 cached intervals)
    const engine = {};
    const probeSrc = fromURL(`mem://${id}`);
    await readRanges(cacheRepeatedProbeRangesFor(engine, probeSrc), reuseWindows); // warm
    const probeBase = calls();
    const probeCached = await timeMedian(() =>
      readRanges(cacheRepeatedProbeRangesFor(engine, probeSrc), reuseWindows),
    );
    const probeRefetches = calls() - probeBase;
    const freshBase = calls();
    const probeFresh = await timeMedian(() => readRanges(fromURL(`mem://${id}`), reuseWindows));
    const probeFreshFetches = (calls() - freshBase) / (WARMUP + ITERS);

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
    console.info(
      `    whole read   owned ${mibPerSec(wholeOwned.bytes, wholeOwned.ms).toFixed(0).padStart(6)} MiB/s` +
        ` · url readAll ${mibPerSec(wholeUrl.bytes, wholeUrl.ms).toFixed(0).padStart(6)} MiB/s` +
        ` · url drain ${mibPerSec(wholeDrain.bytes, wholeDrain.ms).toFixed(0).padStart(6)} MiB/s` +
        ` → readAll ${(wholeDrain.ms / Math.max(wholeUrl.ms, 1e-6)).toFixed(1)}× vs drain`,
    );
    console.info(
      `    probe reuse  ${reuseWindows.length} windows: fresh ${probeFresh.ms.toFixed(3)} ms` +
        ` (${probeFreshFetches.toFixed(0)} fetch/pass) · engine-cached ${probeCached.ms.toFixed(3)} ms` +
        ` (${probeRefetches} re-fetch) → ${(probeFresh.ms / Math.max(probeCached.ms, 1e-6)).toFixed(1)}× faster`,
    );
  }
  await benchHls();
  console.info(`\n(checksum ${sink})`);
}

await main();
