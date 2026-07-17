#!/usr/bin/env bun
/**
 * scripts/bench-s07-sinks.ts — fresh, multi-sample benchmark for the **S07 streaming sinks** (doc 09
 * streaming-output §5 items 2/5/7): the positioned `StreamTarget` drain and its `chunked` coalescing.
 * BUILD_INSTRUCTIONS §6.3: multi-sample (n>1, warmup), across several real corpus files, never one.
 * Mirrors the `bench-streaming.ts` harness style: median of N timed iters after warmup, a byte-image
 * checksum oracle inside every iter (a wrong drain FAILS the bench — the numbers can never be produced
 * by broken output), and a machine-readable baseline + `--check` regression gate.
 *
 * Measured per real corpus file (granularity = 188 B for MPEG-TS packet writes, else 4 KiB):
 *
 *  - **callback drain (unchunked)** — wall + MB/s + `targetWrites` + **first-write latency** (the TTFB
 *    signal, doc 09 §5 item 5): time from `writeToStreamTarget()` to the first destination write. The
 *    sink's claim is that this does NOT scale with output size (no buffering before the first write) —
 *    reported alongside the full-drain wall so the ratio is visible.
 *  - **callback drain (chunked 1 MiB)** — same drain with `chunked` coalescing (doc 09 §5 item 7):
 *    `targetWrites` collapses to ⌈bytes/chunkSize⌉ while the byte image stays identical; `maxWrite`
 *    proves the run bound (≤ chunkSize).
 *  - **positioned drain (random-access writable)** — the fixture streamed append-only, then a 16-byte
 *    header region re-written via `positionedChunk` (doc 09 §5 item 2, the faststart-patch shape),
 *    into a seek-capable destination; validity = checksum of the sparse-applied image vs the expected
 *    patched file.
 *
 *   bun scripts/bench-s07-sinks.ts            # run + print + (re)write the baseline
 *   bun scripts/bench-s07-sinks.ts --check    # run + print + diff vs the committed baseline
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type StreamTargetOptions,
  positionedChunk,
  toStreamTarget,
  writeToStreamTarget,
} from '../src/sinks/stream-target.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/s07-sinks.json`;

const WARMUP = 3;
const ITERS = 15;
/** `--check` flags a median that regressed beyond this fraction vs the committed baseline. */
const REGRESSION_TOLERANCE = 0.5;

/** Real, diverse corpus files (downloaded fixtures — never synthetic, never one). */
const FILES: ReadonlyArray<{ id: string; granularity: number }> = [
  { id: 'bear-1280x720.ts', granularity: 188 }, // MPEG-TS packet-sized tiny writes
  { id: 'h264.mp4', granularity: 4096 },
  { id: 'movie_5.mp4', granularity: 4096 }, // multitrack H.264+AAC
  { id: 'test.mp4', granularity: 4096 }, // B-frames (non-zero ctts)
  { id: 'four-colors.mp4', granularity: 4096 },
];

const CHUNKED: StreamTargetOptions = { chunked: true, chunkSize: 2 ** 20 };

interface DrainSample {
  readonly wallMs: number;
  readonly firstWriteMs: number;
  readonly writes: number;
  readonly maxWriteBytes: number;
}

interface CaseStats {
  readonly bytes: number;
  readonly wallMs: number;
  readonly mbPerSec: number;
  readonly firstWriteMs: number;
  readonly writes: number;
  readonly maxWriteBytes: number;
}

interface Baseline {
  readonly generatedAt: string;
  readonly warmup: number;
  readonly iters: number;
  readonly cases: Record<string, CaseStats>;
}

function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    hash ^= bytes[i] as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((lower as number) + (upper as number)) / 2;
}

function chunkedReadable(bytes: Uint8Array, granularity: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + granularity, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    },
    { highWaterMark: 0 },
  );
}

/** The faststart-patch shape: the whole file appended, then the first 16 bytes re-written. */
function patchedReadable(
  bytes: Uint8Array,
  granularity: number,
  patch: Uint8Array,
): ReadableStream<Uint8Array> {
  let offset = 0;
  let patched = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        if (offset < bytes.byteLength) {
          const end = Math.min(offset + granularity, bytes.byteLength);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
          return;
        }
        if (!patched) {
          patched = true;
          controller.enqueue(positionedChunk(patch, 0));
          return;
        }
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

/** Drain through the position-aware callback arm into a byte image; verify the image checksum. */
async function drainCallback(
  source: ReadableStream<Uint8Array>,
  imageSize: number,
  expectedChecksum: number,
  options?: StreamTargetOptions,
): Promise<DrainSample> {
  const image = new Uint8Array(imageSize);
  let writes = 0;
  let maxWriteBytes = 0;
  let firstWriteMs = -1;
  const start = performance.now();
  await writeToStreamTarget(
    toStreamTarget((chunk, position) => {
      if (writes === 0) firstWriteMs = performance.now() - start;
      writes++;
      if (chunk.byteLength > maxWriteBytes) maxWriteBytes = chunk.byteLength;
      image.set(chunk, position);
    }, options),
    source,
  );
  const wallMs = performance.now() - start;
  const checksum = fnv1a(image);
  if (checksum !== expectedChecksum) {
    throw new Error(`callback drain corrupted the byte image (${checksum} != ${expectedChecksum})`);
  }
  return { wallMs, firstWriteMs, writes, maxWriteBytes };
}

/** Drain through the random-access WritableStream arm (seek-capable) and verify the applied image. */
async function drainRandomAccess(
  source: ReadableStream<Uint8Array>,
  imageSize: number,
  expectedChecksum: number,
): Promise<DrainSample> {
  const image = new Uint8Array(imageSize);
  let cursor = 0;
  let writes = 0;
  let maxWriteBytes = 0;
  let firstWriteMs = -1;
  const start = performance.now();
  const destination = Object.assign(
    new WritableStream<Uint8Array | { type: 'write'; position: number; data: Uint8Array }>({
      write(chunk): void {
        if (writes === 0) firstWriteMs = performance.now() - start;
        writes++;
        const data = chunk instanceof Uint8Array ? chunk : chunk.data;
        const position = chunk instanceof Uint8Array ? cursor : chunk.position;
        if (data.byteLength > maxWriteBytes) maxWriteBytes = data.byteLength;
        image.set(data, position);
        cursor = position + data.byteLength;
      },
    }),
    {
      seek(position: number): Promise<void> {
        cursor = position;
        return Promise.resolve();
      },
    },
  ) as unknown as WritableStream<Uint8Array>;
  await writeToStreamTarget(toStreamTarget(destination), source);
  const wallMs = performance.now() - start;
  const checksum = fnv1a(image);
  if (checksum !== expectedChecksum) {
    throw new Error(
      `positioned drain corrupted the byte image (${checksum} != ${expectedChecksum})`,
    );
  }
  return { wallMs, firstWriteMs, writes, maxWriteBytes };
}

function stats(bytes: number, samples: readonly DrainSample[]): CaseStats {
  const wallMs = median(samples.map((s) => s.wallMs));
  return {
    bytes,
    wallMs: round(wallMs, 3),
    mbPerSec: round(bytes / (1024 * 1024) / (wallMs / 1000), 1),
    firstWriteMs: round(median(samples.map((s) => s.firstWriteMs)), 4),
    writes: median(samples.map((s) => s.writes)),
    maxWriteBytes: median(samples.map((s) => s.maxWriteBytes)),
  };
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

async function benchFile(id: string, granularity: number): Promise<Record<string, CaseStats>> {
  const bytes = new Uint8Array(await readFile(`${MEDIA_DIR}/${id}`));
  const plainChecksum = fnv1a(bytes);

  const patch = new Uint8Array(16);
  for (let i = 0; i < patch.length; i++) patch[i] = 0xa5 ^ i;
  const patchedImage = bytes.slice();
  patchedImage.set(patch.subarray(0, Math.min(16, patchedImage.byteLength)), 0);
  const patchedChecksum = fnv1a(patchedImage);

  const unchunked: DrainSample[] = [];
  const chunked: DrainSample[] = [];
  const positioned: DrainSample[] = [];
  for (let iter = 0; iter < WARMUP + ITERS; iter++) {
    const u = await drainCallback(
      chunkedReadable(bytes, granularity),
      bytes.byteLength,
      plainChecksum,
    );
    const c = await drainCallback(
      chunkedReadable(bytes, granularity),
      bytes.byteLength,
      plainChecksum,
      CHUNKED,
    );
    const p = await drainRandomAccess(
      patchedReadable(bytes, granularity, patch),
      bytes.byteLength,
      patchedChecksum,
    );
    if (iter >= WARMUP) {
      unchunked.push(u);
      chunked.push(c);
      positioned.push(p);
    }
  }
  return {
    [`${id}#callback-unchunked`]: stats(bytes.byteLength, unchunked),
    [`${id}#callback-chunked-1MiB`]: stats(bytes.byteLength, chunked),
    [`${id}#positioned-random-access`]: stats(bytes.byteLength, positioned),
  };
}

function printCase(name: string, s: CaseStats): void {
  const first =
    s.firstWriteMs >= 0 ? `firstWrite ${s.firstWriteMs.toFixed(4)} ms` : 'firstWrite n/a';
  console.log(
    `  ${name.padEnd(46)} ${String(s.wallMs).padStart(8)} ms  ${String(s.mbPerSec).padStart(8)} MB/s  ${String(s.writes).padStart(6)} writes  maxWrite ${s.maxWriteBytes} B  ${first}`,
  );
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const cases: Record<string, CaseStats> = {};
  for (const file of FILES) {
    Object.assign(cases, await benchFile(file.id, file.granularity));
  }

  console.log(
    `S07 sinks benchmark — median of ${ITERS} iters after ${WARMUP} warmup, per real fixture:`,
  );
  for (const [name, s] of Object.entries(cases)) printCase(name, s);

  // The coalescing claim, asserted fresh (never a fabricated number): chunked writes ≪ unchunked.
  for (const file of FILES) {
    const u = cases[`${file.id}#callback-unchunked`];
    const c = cases[`${file.id}#callback-chunked-1MiB`];
    if (u === undefined || c === undefined) throw new Error(`missing case for ${file.id}`);
    if (c.writes > Math.ceil(u.bytes / (CHUNKED.chunkSize as number)) + 1) {
      throw new Error(`${file.id}: chunked writes ${c.writes} exceed the coalescing bound`);
    }
    if (c.maxWriteBytes > (CHUNKED.chunkSize as number)) {
      throw new Error(`${file.id}: chunked maxWrite ${c.maxWriteBytes} exceeds chunkSize`);
    }
  }

  if (check) {
    const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
    const regressions: string[] = [];
    for (const [name, s] of Object.entries(cases)) {
      const base = baseline.cases[name];
      if (base === undefined) continue;
      if (s.mbPerSec < base.mbPerSec * (1 - REGRESSION_TOLERANCE)) {
        regressions.push(`${name}: throughput ${s.mbPerSec} MB/s < baseline ${base.mbPerSec}`);
      }
      if (s.writes > base.writes) {
        regressions.push(`${name}: targetWrites ${s.writes} > baseline ${base.writes}`);
      }
    }
    if (regressions.length > 0) {
      console.error(`\n--check FAILED:\n  ${regressions.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('\n--check OK: no regression vs baseline');
    return;
  }

  const baseline: Baseline = {
    generatedAt: new Date().toISOString(),
    warmup: WARMUP,
    iters: ITERS,
    cases,
  };
  await mkdir(dirname(BASELINE_PATH), { recursive: true });
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`\nbaseline written to ${BASELINE_PATH}`);
}

await main();
