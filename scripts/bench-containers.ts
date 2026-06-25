#!/usr/bin/env bun
/**
 * scripts/bench-containers.ts — fresh, multi-sample benchmark for the pure-TS container / parse ops
 * (BUILD_INSTRUCTIONS §6: "every op has a multi-sample benchmark … wall, throughput … measured across
 * several real §6.1 corpus files, not one"). Mirrors the `scripts/bench-dsp.ts` harness (median of N
 * timed iters after warmup; a separate RSS pass so memory sampling never perturbs the wall; a checksum
 * sink so the optimizer can't elide the work; a machine-readable baseline + a `--check` regression gate).
 *
 * The ops, each run across **≥ 5 real corpus files** (never one):
 *   - **probe**   — `media.probe`: header-only parse → `MediaInfo`, across a **diverse multi-container**
 *                   set (MP4/MOV, WebM, MP3, Ogg, WAV, FLAC, ADTS). A near-constant-cost header read, so
 *                   it is reported as probes/sec (+ file MB for context), not file-MB/s.
 *   - **demux**   — the pure-TS container→samples work the public `demux` does *before* the WebCodecs
 *                   `Encoded*Chunk` wrapping (which is browser-only and unavailable in Node): build the
 *                   full sample table and gather every sample's bytes (`muxTracksFromMovie`). Reported as
 *                   MB/s of the sample bytes gathered. (Labelled honestly — it is the parse+gather unit,
 *                   not the browser chunk emit.)
 *   - **remux**   — `media.remux(→mp4)`: lossless demux→mux stream-copy. MB/s of the output bytes.
 *   - **trim**    — `media.trim(keyframe, 25%–75%)`: keyframe-aligned stream-copy. MB/s of the output.
 *   - **decrypt** — `media.decrypt(cenc)`: CENC AES-CTR sample decryption of a freshly CENC-encrypted
 *                   twin (via the test-support encryptor). MB/s of the decrypted output.
 *
 * `demux`/`remux`/`trim`/`decrypt` run on the **MP4/MOV** corpus (the pure-TS container with a Node
 * stream-copy + decrypt path); `probe` spans every container family. Each metric also reports
 * `throughputRealtime` (media seconds processed per wall second) where the op yields a timed file.
 *
 *   bun run bench-containers              # run + print + (re)write the baseline
 *   bun run bench-containers --check      # run + print + diff vs the committed baseline (non-zero on regress)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createMedia } from '../src/api/create-media.ts';
import type { MediaInfo } from '../src/api/types.ts';
import { muxTracksFromMovie, readMovie } from '../src/drivers/mp4/mp4-driver.ts';
import { fromBytes } from '../src/sources/source.ts';
import { encryptCenc } from '../src/test-support/cenc-encrypt.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/containers.json`;

const WARMUP = 3;
const ITERS = 21;
/** Beyond ±this fraction slower than the committed baseline MB/s, `--check` flags a regression. */
const REGRESSION_TOLERANCE = 0.5;

/** The CENC key/KID used to mint the decrypt op's encrypted twin (any 16-byte key works for a round-trip). */
const CENC_KEY = '000102030405060708090a0b0c0d0e0f';
const CENC_KID = '00112233445566778899aabbccddeeff';

/** A diverse, multi-container probe set (one+ per family); every entry is a real downloaded fixture. */
const PROBE_FILES = [
  'test.mp4', // MP4, A/V, 6 s, 188 KB
  'movie_5.mp4', // MP4, A/V, 5 s
  'movie_5.webm', // WebM/EBML, A/V
  'recorder_headerless.webm', // headerless MediaRecorder WebM
  'sound_5.mp3', // MP3 (frame-sync + Xing)
  'sound_5.oga', // Ogg (Vorbis/Opus granule)
  'speech.wav', // WAV/RIFF PCM
  'flac-verbatim.flac', // FLAC (STREAMINFO)
  'sfx.adts', // ADTS/AAC
];

/** The MP4/MOV set for demux/remux/trim/decrypt (the pure-TS container with a Node stream-copy path). */
const MP4_FILES = [
  '2x2-green.mp4',
  'av1.mp4',
  'four-colors.mp4',
  'h264.mp4',
  'h265.mp4',
  'movie_5.mp4',
  'test.mp4',
];

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  adts: 'audio/aac',
};

let sink = 0; // accumulate a byte from each result to defeat dead-code elimination

// ============ stats / timing (async) ============

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Time async `fn` over {@link ITERS} runs (after {@link WARMUP}); return the median nanoseconds per run. */
async function timeNs(fn: () => Promise<number>): Promise<number> {
  for (let i = 0; i < WARMUP; i++) sink = (sink + (await fn())) | 0;
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = Bun.nanoseconds();
    sink = (sink + (await fn())) | 0;
    samples.push(Bun.nanoseconds() - t0);
  }
  return median(samples);
}

/**
 * Peak resident-set growth (bytes) while running async `fn` {@link ITERS} times, versus a forced-gc
 * baseline. A separate pass from {@link timeNs} so RSS sampling never perturbs the wall measurement.
 */
async function peakRssBytes(fn: () => Promise<number>): Promise<number> {
  Bun.gc(true);
  const base = process.memoryUsage().rss;
  let peak = base;
  for (let i = 0; i < ITERS; i++) {
    sink = (sink + (await fn())) | 0;
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }
  return Math.max(0, peak - base);
}

// ============ measured op record ============

interface OpResult {
  op: string;
  /** Bytes processed per op invocation (the work unit: header / sample bytes / output bytes). */
  bytes: number;
  /** Seconds of media the file represents (0 when not meaningful, e.g. a header-only probe metric). */
  mediaSeconds: number;
  wallMs: number;
  mbPerSec: number;
  /** Media seconds processed per wall second (× realtime); 0 when `mediaSeconds` is 0. */
  throughputRealtime: number;
  peakMemoryMb: number;
}

/** Measure one async op (wall pass + memory pass) and fold both into an {@link OpResult}. */
async function measure(
  op: string,
  bytes: number,
  mediaSeconds: number,
  fn: () => Promise<number>,
): Promise<OpResult> {
  const ns = await timeNs(fn);
  const peakBytes = await peakRssBytes(fn);
  const wallSeconds = ns / 1e9;
  return {
    op,
    bytes,
    mediaSeconds,
    wallMs: ns / 1e6,
    mbPerSec: bytes / (1024 * 1024) / wallSeconds,
    throughputRealtime: mediaSeconds > 0 ? mediaSeconds / wallSeconds : 0,
    peakMemoryMb: peakBytes / (1024 * 1024),
  };
}

interface FileResult {
  id: string;
  container: string;
  sizeBytes: number;
  durationSec: number;
  ops: OpResult[];
}

// ============ per-file op builders ============

const engine = createMedia();

function source(id: string, bytes: Uint8Array) {
  const ext = id.slice(id.lastIndexOf('.') + 1).toLowerCase();
  const mime = MIME[ext];
  return fromBytes(bytes, mime ? { mime } : {});
}

async function blobBytes(out: unknown): Promise<Uint8Array> {
  if (!(out instanceof Blob)) throw new Error('expected a Blob output');
  return new Uint8Array(await out.arrayBuffer());
}

/** A `RandomAccess` over an in-memory buffer (mirrors the driver's buffered path). */
const ra = (b: Uint8Array) => ({
  read: (o: number, l: number): Promise<Uint8Array> => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

/** Total sample bytes the demux gather touches (sum over tracks of every sample's size). */
async function sampleByteCount(bytes: Uint8Array): Promise<number> {
  const tracks = await muxTracksFromMovie(ra(bytes), await readMovie(ra(bytes)));
  let total = 0;
  for (const t of tracks) for (const s of t.samples) total += s.data.byteLength;
  return total;
}

/** Probe each file once for its real container/size/duration (used to label + scale the metrics). */
async function probeInfo(id: string, bytes: Uint8Array): Promise<MediaInfo> {
  return engine.probe(source(id, bytes));
}

// ============ benches ============

async function benchProbe(): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const id of PROBE_FILES) {
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${id}`).arrayBuffer());
    const info = await probeInfo(id, bytes);
    // Work unit for a header parse is the file's MB (a probe-rate proxy); mediaSeconds=0 (not a timed copy).
    const op = await measure('probe', bytes.byteLength, 0, async () => {
      const i = await engine.probe(source(id, bytes));
      return i.tracks.length + (i.durationSec | 0);
    });
    out.push({
      id,
      container: info.container,
      sizeBytes: bytes.byteLength,
      durationSec: info.durationSec,
      ops: [op],
    });
  }
  return out;
}

async function benchMp4Ops(): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const id of MP4_FILES) {
    const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${id}`).arrayBuffer());
    const info = await probeInfo(id, bytes);
    const dur = info.durationSec;
    const ops: OpResult[] = [];

    // demux: build the sample table + gather every sample's bytes (the pure-TS container→samples work).
    const gathered = await sampleByteCount(bytes);
    ops.push(
      await measure('demux (table+gather)', gathered, dur, async () => {
        const tracks = await muxTracksFromMovie(ra(bytes), await readMovie(ra(bytes)));
        return (tracks[0]?.samples[0]?.data[0] ?? 0) + tracks.length;
      }),
    );

    // remux: lossless demux→mux stream-copy; the work unit is the produced byte count.
    const remuxOut = await blobBytes(await engine.remux(source(id, bytes), { to: 'mp4' }));
    ops.push(
      await measure(
        'remux (→mp4)',
        remuxOut.byteLength,
        dur,
        async () =>
          (await blobBytes(await engine.remux(source(id, bytes), { to: 'mp4' }))).byteLength % 251,
      ),
    );

    // trim: keyframe-aligned stream-copy of the middle half (25%–75%). Skip when the file is too short
    // to carve a non-empty inner range (a degenerate 0-length trim is not representative work).
    const start = dur * 0.25;
    const end = dur * 0.75;
    if (end - start > 0.001) {
      const trimOut = await blobBytes(
        await engine.trim(source(id, bytes), { mode: 'keyframe', start, end }),
      );
      const trimSeconds = end - start;
      ops.push(
        await measure(
          'trim (keyframe 25–75%)',
          trimOut.byteLength,
          trimSeconds,
          async () =>
            (
              await blobBytes(
                await engine.trim(source(id, bytes), { mode: 'keyframe', start, end }),
              )
            ).byteLength % 251,
        ),
      );
    }

    // decrypt: mint a CENC twin (encrypt the first present track type), then time the AES-CTR decrypt.
    const target: 'audio' | 'video' = info.tracks.some((t) => t.type === 'audio')
      ? 'audio'
      : 'video';
    const enc = await encryptCenc(bytes, { keyHex: CENC_KEY, kidHex: CENC_KID, mediaType: target });
    const decOut = await blobBytes(
      await engine.decrypt(source('enc.mp4', enc), {
        scheme: 'cenc',
        keys: { [CENC_KID]: CENC_KEY },
      }),
    );
    ops.push(
      await measure(
        'decrypt (cenc)',
        decOut.byteLength,
        dur,
        async () =>
          (
            await blobBytes(
              await engine.decrypt(source('enc.mp4', enc), {
                scheme: 'cenc',
                keys: { [CENC_KID]: CENC_KEY },
              }),
            )
          ).byteLength % 251,
      ),
    );

    out.push({ id, container: info.container, sizeBytes: bytes.byteLength, durationSec: dur, ops });
  }
  return out;
}

// ============ reporting ============

/** `probe` is a bounded header read, not a whole-file scan — its honest throughput is probes/sec, not
 *  file-MB/s. Byte ops (demux/remux/trim/decrypt) genuinely process every reported byte → MB/s. */
function isProbe(op: string): boolean {
  return op === 'probe';
}

/** The throughput cell for an op: `probes/s` for probe (rate), else `MB/s` (true byte throughput). */
function throughputCell(o: OpResult): string {
  return isProbe(o.op) ? `${(1000 / o.wallMs).toFixed(0)} /s` : `${o.mbPerSec.toFixed(1)} MB/s`;
}

function printFile(r: FileResult): void {
  console.info(
    `\n${r.id} — ${r.container}, ${(r.sizeBytes / 1024).toFixed(1)} KB, ${r.durationSec.toFixed(3)} s`,
  );
  console.info(
    `  ${'op'.padEnd(24)} ${'wall(ms)'.padStart(9)} ${'throughput'.padStart(12)} ${'×realtime'.padStart(11)} ${'peakMem(MB)'.padStart(12)}`,
  );
  for (const o of r.ops) {
    const rt = o.throughputRealtime > 0 ? `${o.throughputRealtime.toFixed(0)}×` : '—';
    console.info(
      `  ${o.op.padEnd(24)} ${o.wallMs.toFixed(3).padStart(9)} ${throughputCell(o).padStart(12)} ${rt.padStart(11)} ${o.peakMemoryMb.toFixed(2).padStart(12)}`,
    );
  }
}

/** Per-op aggregate across all files: median wall, geomean MB/s, worst (min) MB/s + peak memory. */
interface OpAggregate {
  op: string;
  files: number;
  medianWallMs: number;
  geomeanMbPerSec: number;
  minMbPerSec: number;
  maxPeakMemoryMb: number;
}

function aggregate(results: readonly FileResult[]): OpAggregate[] {
  const byOp = new Map<string, OpResult[]>();
  for (const r of results) {
    for (const o of r.ops) {
      const list = byOp.get(o.op) ?? [];
      list.push(o);
      byOp.set(o.op, list);
    }
  }
  const out: OpAggregate[] = [];
  for (const [op, list] of byOp) {
    const logSum = list.reduce((s, o) => s + Math.log(o.mbPerSec), 0);
    out.push({
      op,
      files: list.length,
      medianWallMs: median(list.map((o) => o.wallMs)),
      geomeanMbPerSec: Math.exp(logSum / list.length),
      minMbPerSec: list.reduce((m, o) => Math.min(m, o.mbPerSec), Number.POSITIVE_INFINITY),
      maxPeakMemoryMb: list.reduce((m, o) => Math.max(m, o.peakMemoryMb), 0),
    });
  }
  return out;
}

function printAggregates(aggs: readonly OpAggregate[]): void {
  console.info('\n=== per-op aggregate across all corpus files ===');
  console.info('(probe throughput is probes/sec — a bounded header read; byte ops are MB/s)');
  console.info(
    `  ${'op'.padEnd(24)} ${'files'.padStart(5)} ${'medWall(ms)'.padStart(12)} ${'geoThru'.padStart(12)} ${'worst'.padStart(11)} ${'maxMem(MB)'.padStart(11)}`,
  );
  for (const a of aggs) {
    const geo = isProbe(a.op)
      ? `${(1000 / a.medianWallMs).toFixed(0)} /s`
      : `${a.geomeanMbPerSec.toFixed(1)} MB/s`;
    const worst = isProbe(a.op) ? '—' : `${a.minMbPerSec.toFixed(1)} MB/s`;
    console.info(
      `  ${a.op.padEnd(24)} ${String(a.files).padStart(5)} ${a.medianWallMs.toFixed(3).padStart(12)} ${geo.padStart(12)} ${worst.padStart(11)} ${a.maxPeakMemoryMb.toFixed(2).padStart(11)}`,
    );
  }
}

// ============ baseline record ============

interface Baseline {
  generatedAt: string;
  runtime: string;
  warmup: number;
  iters: number;
  files: FileResult[];
  aggregates: OpAggregate[];
}

function buildBaseline(files: FileResult[], aggregates: OpAggregate[]): Baseline {
  return {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    warmup: WARMUP,
    iters: ITERS,
    files,
    aggregates,
  };
}

/** Compare fresh aggregates against the committed baseline; return the regressed op labels (if any). */
function regressions(fresh: readonly OpAggregate[], base: Baseline): string[] {
  const baseByOp = new Map(base.aggregates.map((a) => [a.op, a]));
  const regressed: string[] = [];
  for (const a of fresh) {
    const b = baseByOp.get(a.op);
    if (b === undefined) continue;
    if (a.geomeanMbPerSec < b.geomeanMbPerSec * (1 - REGRESSION_TOLERANCE)) {
      regressed.push(
        `${a.op}: ${a.geomeanMbPerSec.toFixed(1)} MB/s vs baseline ${b.geomeanMbPerSec.toFixed(1)} MB/s`,
      );
    }
  }
  return regressed;
}

// ============ main ============

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  if (PROBE_FILES.length < 5 || MP4_FILES.length < 5) {
    throw new Error(
      `container benchmark needs ≥ 5 real files per op (BUILD_INSTRUCTIONS §6.1); have probe=${PROBE_FILES.length}, mp4=${MP4_FILES.length}.`,
    );
  }
  console.info(
    `container/parse benchmark — pure TS, single-thread, median of ${ITERS} iters (warmup ${WARMUP}); probe×${PROBE_FILES.length} files, demux/remux/trim/decrypt×${MP4_FILES.length} MP4 files:`,
  );

  const probeResults = await benchProbe();
  const mp4Results = await benchMp4Ops();
  for (const r of probeResults) printFile(r);
  for (const r of mp4Results) printFile(r);

  const aggs = aggregate([...probeResults, ...mp4Results]);
  printAggregates(aggs);
  console.info(`\n(checksum ${sink})`);

  if (check) {
    const base = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
    const regressed = regressions(aggs, base);
    if (regressed.length > 0) {
      console.error(`\nREGRESSION vs ${BASELINE_PATH} (> ${REGRESSION_TOLERANCE * 100}% slower):`);
      for (const r of regressed) console.error(`  - ${r}`);
      process.exit(1);
    }
    console.info(`\nno regression vs baseline (${base.generatedAt}).`);
    return;
  }

  await mkdir(dirname(BASELINE_PATH), { recursive: true });
  await writeFile(
    BASELINE_PATH,
    `${JSON.stringify(buildBaseline([...probeResults, ...mp4Results], aggs), null, 2)}\n`,
  );
  console.info(`\nbaseline written → ${BASELINE_PATH}`);
}

await main();
