#!/usr/bin/env bun
/**
 * scripts/bench-streaming.ts — fresh, multi-sample benchmark for **streaming output** (the fragmented-MP4
 * / CMAF writer {@link fragmentMp4} + the {@link StreamTarget} sink), the two deliverables of the
 * streaming-output feature (doc 09 streaming-output, ADR-013). BUILD_INSTRUCTIONS §6.3: "every op has a
 * multi-sample benchmark (n>1, warmup): wall, throughput, peakMemory … measured across several real §6.1
 * corpus files, not one". Mirrors the {@link import('./bench-containers.ts')} harness style: median of N
 * timed iters after warmup; a separate RSS pass so memory sampling never perturbs the wall; a checksum
 * sink so the optimizer cannot elide the work; a machine-readable baseline + a `--check` regression gate.
 *
 * The metrics, each measured across the **≥ 5 real corpus MP4s** (never one), using the *same* real-media
 * path the public `remux` takes (`readMovie` → `muxTracksFromMovie` → sliced sample bytes + verbatim
 * codec-config), so the bytes fragmented are genuine encoded samples — never synthetic:
 *
 *   - **first-byte latency (streaming)** — wall from constructing `fragmentMp4(tracks)` until the **first**
 *     yielded chunk (the `ftyp`+`moov` init segment) is in hand. This is the streaming headline: a CMAF
 *     producer emits the init segment *immediately*, before any media is buffered.
 *   - **first-byte latency (non-streaming `writeMp4`)** — the honest contrast: a faststart MP4 must buffer
 *     **every** sample so `moov` can name absolute offsets, so its first available byte only exists once the
 *     whole file is built — its "first byte" wall == its full-build wall. Reported side-by-side to make the
 *     streaming advantage concrete, not asserted. (Speedup = writeMp4-firstByte ÷ fragment-firstByte.)
 *   - **stream throughput — WritableStream arm** — drain the *whole* fragmented stream end-to-end through
 *     `toStreamTarget(new WritableStream(…))` via {@link writeToStreamTarget}, with the generator wrapped in
 *     a **lazily-pulled** `ReadableStream` (one fragment materialized at a time → bounded memory). MB/s of
 *     the total output bytes; also × realtime (media seconds per wall second).
 *   - **stream throughput — callback arm** — the same generator-backed readable into a position-aware
 *     callback destination, exercising the sink's callback backpressure path. MB/s of the total output.
 *   - **peak memory (streaming drain)** — RSS growth while streaming the WritableStream arm; the streaming
 *     target's whole purpose is that this stays ~one fragment regardless of total output size.
 *
 *   bun run bench-streaming              # run + print + (re)write the baseline
 *   bun run bench-streaming --check      # run + print + diff vs the committed baseline (non-zero on regress)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fragmentMp4 } from '../src/drivers/mp4/fragment.ts';
import { muxTracksFromMovie, readMovie } from '../src/drivers/mp4/mp4-driver.ts';
import type { MuxTrackInput } from '../src/drivers/mp4/write.ts';
import { writeMp4 } from '../src/drivers/mp4/write.ts';
import { type TsParse, parseTs } from '../src/drivers/mpegts/ts-parse.ts';
import { MpegTsMuxer } from '../src/drivers/mpegts/ts-write.ts';
import { toStreamTarget, writeToStreamTarget } from '../src/sinks/stream-target.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA_DIR = `${ROOT}fixtures/media`;
const HARNESS_MEDIA_DIR = new URL(
  '../../media-test/media-browser-test/fixtures/media/',
  import.meta.url,
).pathname;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/streaming.json`;

const WARMUP = 3;
const ITERS = 21;
/** Beyond this fraction slower than the committed baseline (throughput) / faster (latency), `--check` flags. */
const REGRESSION_TOLERANCE = 0.5;

/**
 * Diverse, real, non-fragmented MP4s (tiny → 720p, single + multitrack, AAC/MP3 audio, rotation,
 * B-frames). The same downloaded corpus the container benchmark fragments — every entry is a verified
 * fixture under `fixtures/media`, never synthetic, never one.
 */
const MP4_FILES = [
  '2x2-green.mp4', // 2×2 — tiny dims
  'av1.mp4', // AV1 video
  'four-colors.mp4', // small synthetic-source but real-encoded MP4
  'h264.mp4', // small H.264
  'h265.mp4', // HEVC
  'movie_5.mp4', // H.264 + AAC, multitrack, faststart
  'test.mp4', // H.264 + AAC, B-frames (non-zero ctts)
];

/** Real MPEG-TS/HLS segment fixtures for packet-aligned `StreamTarget` writes (R3 target:writes). */
const TS_FILES = [
  { id: 'bear-1280x720.ts', path: `${MEDIA_DIR}/bear-1280x720.ts` },
  { id: 'h264_ts.ts', path: `${HARNESS_MEDIA_DIR}h264_ts.ts` },
  { id: 'hls_vod_000.ts', path: `${HARNESS_MEDIA_DIR}hls_vod_000.ts` },
  { id: 'hls_vod_001.ts', path: `${HARNESS_MEDIA_DIR}hls_vod_001.ts` },
  { id: 'hls_vod_002.ts', path: `${HARNESS_MEDIA_DIR}hls_vod_002.ts` },
  { id: 'hls_vod_003.ts', path: `${HARNESS_MEDIA_DIR}hls_vod_003.ts` },
  { id: 'hls_vod_004.ts', path: `${HARNESS_MEDIA_DIR}hls_vod_004.ts` },
] as const;

let sink = 0; // accumulate a byte from each result to defeat dead-code elimination

// ============ stats / timing ============

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

// ============ the streaming source under test ============

/** A `RandomAccess` over an in-memory buffer (mirrors the driver's buffered path). */
const ra = (b: Uint8Array) => ({
  read: (o: number, l: number): Promise<Uint8Array> => Promise.resolve(b.subarray(o, o + l)),
  size: b.byteLength,
});

/**
 * Wrap the synchronous {@link fragmentMp4} generator in a `ReadableStream<Uint8Array>` that pulls **one
 * fragment per `pull`** — so a piped {@link StreamTarget} only ever holds the current fragment in flight
 * (bounded memory, the streaming guarantee), exactly as a real streaming muxer would feed a sink.
 */
function fragmentReadable(tracks: readonly MuxTrackInput[]): ReadableStream<Uint8Array> {
  const gen = fragmentMp4(tracks);
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      const { value, done } = gen.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
}

/** Total output bytes of the fragmented stream (sum of every segment) — the throughput work unit. */
function fragmentedOutputBytes(tracks: readonly MuxTrackInput[]): number {
  let total = 0;
  for (const seg of fragmentMp4(tracks)) total += seg.byteLength;
  return total;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(chunks);
}

function tsDurationSec(parsed: TsParse): number {
  return parsed.tracks.reduce((max, track) => Math.max(max, track.durationSec), 0);
}

function mpegTsMuxerFromParsed(parsed: TsParse, writeChunkPackets?: number): MpegTsMuxer {
  const muxer =
    writeChunkPackets === undefined ? new MpegTsMuxer() : new MpegTsMuxer({ writeChunkPackets });
  const trackIds = parsed.tracks.map((track, index) =>
    muxer.addTrack({
      id: index,
      mediaType: track.stream.mediaType,
      codec: track.stream.codec,
      durationSec: track.durationSec,
      ...(track.fps !== undefined ? { fps: track.fps } : {}),
      config: track.config,
    }),
  );
  const units = parsed.tracks
    .flatMap((track, trackIndex) => track.units.map((unit) => ({ trackIndex, unit })))
    .sort(
      (left, right) => left.unit.dtsUs - right.unit.dtsUs || left.trackIndex - right.trackIndex,
    );
  for (const { trackIndex, unit } of units) {
    const trackId = trackIds[trackIndex];
    if (trackId === undefined) throw new Error(`missing MPEG-TS mux track ${trackIndex}`);
    muxer.addChunkStruct(trackId, {
      data: unit.data,
      timestampUs: unit.ptsUs,
      dtsUs: unit.dtsUs,
      key: unit.keyframe,
    });
  }
  return muxer;
}

async function drainMpegTsToWritable(parsed: TsParse, writeChunkPackets?: number): Promise<number> {
  const muxer = mpegTsMuxerFromParsed(parsed, writeChunkPackets);
  await muxer.finalize();
  let received = 0;
  let firstByte = 0;
  const writable = new WritableStream<Uint8Array>({
    write(chunk): void {
      if (received === 0) firstByte = chunk[0] ?? 0;
      received += chunk.byteLength;
    },
  });
  await writeToStreamTarget(toStreamTarget(writable), muxer.output);
  return (received + firstByte) % 251;
}

async function drainMpegTsToCallback(parsed: TsParse, writeChunkPackets?: number): Promise<number> {
  const muxer = mpegTsMuxerFromParsed(parsed, writeChunkPackets);
  await muxer.finalize();
  let writes = 0;
  let end = 0;
  let firstByte = 0;
  await writeToStreamTarget(
    toStreamTarget((chunk, position) => {
      if (writes === 0) firstByte = chunk[0] ?? 0;
      writes += 1;
      end = position + chunk.byteLength;
    }),
    muxer.output,
  );
  return (end + writes + firstByte) % 251;
}

// ============ measured op record ============

interface OpResult {
  op: string;
  /** Bytes processed per invocation (output bytes for throughput ops; the init-segment size for first-byte). */
  bytes: number;
  /** Seconds of media the file represents (0 when not meaningful, e.g. first-byte latency). */
  mediaSeconds: number;
  wallMs: number;
  mbPerSec: number;
  /** Media seconds processed per wall second (× realtime); 0 when `mediaSeconds` is 0 (a latency metric). */
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
    mbPerSec: wallSeconds > 0 ? bytes / (1024 * 1024) / wallSeconds : 0,
    throughputRealtime: mediaSeconds > 0 && wallSeconds > 0 ? mediaSeconds / wallSeconds : 0,
    peakMemoryMb: peakBytes / (1024 * 1024),
  };
}

interface FileResult {
  id: string;
  sizeBytes: number;
  durationSec: number;
  /** Total bytes of the produced stream — the streaming throughput work unit. */
  outputBytes: number;
  /** Human label for the stream layout (`CMAF` or `MPEG-TS`). */
  outputKind: string;
  ops: OpResult[];
}

// ============ per-file benches ============

/** Movie duration in seconds (max track duration), for the × realtime metric. */
function movieDurationSec(tracks: readonly MuxTrackInput[]): number {
  let dur = 0;
  for (const t of tracks) {
    if (t.timescale <= 0) continue;
    let ticks = 0;
    for (const s of t.samples) ticks += s.durationTicks;
    dur = Math.max(dur, ticks / t.timescale);
  }
  return dur;
}

async function benchFile(id: string): Promise<FileResult> {
  const bytes = new Uint8Array(await Bun.file(`${MEDIA_DIR}/${id}`).arrayBuffer());
  // The same real-media path `remux` takes: parse → MuxTrackInput[] with sliced sample bytes + verbatim
  // codec-config. `MuxTrackInput` *is* `FragmentTrackInput`, so these feed `fragmentMp4` directly.
  const movie = await readMovie(ra(bytes));
  const tracks = await muxTracksFromMovie(ra(bytes), movie);
  if (tracks.length === 0 || tracks.every((t) => t.samples.length === 0)) {
    throw new Error(`${id}: no fragmentable samples (need a real A/V MP4)`);
  }
  const durationSec = movieDurationSec(tracks);
  const outputBytes = fragmentedOutputBytes(tracks);
  const ops: OpResult[] = [];

  // (1) first-byte latency, streaming: construct the generator and pull only the init segment.
  ops.push(
    await measure('first-byte (fragment init)', 0, 0, async () => {
      const gen = fragmentMp4(tracks);
      const first = gen.next(); // ftyp + moov, produced before any media is buffered
      gen.return(undefined); // stop — we only timed time-to-first-byte
      return first.value?.byteLength ?? 0;
    }),
  );

  // (2) first-byte latency, non-streaming writeMp4 (the honest contrast): a faststart MP4 has no byte to
  //     hand out until the whole file is serialized, so its "first byte" wall == its full-build wall.
  ops.push(
    await measure(
      'first-byte (writeMp4 full)',
      0,
      0,
      async () => writeMp4(tracks as MuxTrackInput[]).byteLength % 251,
    ),
  );

  // (3) stream throughput — WritableStream arm: drain the whole CMAF stream end-to-end through a
  //     StreamTarget(WritableStream), pulling one fragment at a time. Work unit = total output bytes.
  ops.push(
    await measure('stream→writable', outputBytes, durationSec, async () => {
      let received = 0;
      const writable = new WritableStream<Uint8Array>({
        write(chunk): void {
          received += chunk.byteLength;
        },
      });
      await writeToStreamTarget(toStreamTarget(writable), fragmentReadable(tracks));
      return received % 251;
    }),
  );

  // (4) stream throughput — callback arm: the same generator-backed readable into a position-aware
  //     callback destination (exercises the sink's callback backpressure path). Work unit = output bytes.
  ops.push(
    await measure('stream→callback', outputBytes, durationSec, async () => {
      let last = 0;
      await writeToStreamTarget(
        toStreamTarget((chunk, position) => {
          last = position + chunk.byteLength;
        }),
        fragmentReadable(tracks),
      );
      return last % 251;
    }),
  );

  return { id, sizeBytes: bytes.byteLength, durationSec, outputBytes, outputKind: 'CMAF', ops };
}

async function benchTsFile(id: string, path: string): Promise<FileResult> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const parsed = parseTs(bytes);
  const durationSec = tsDurationSec(parsed);
  const referenceMuxer = mpegTsMuxerFromParsed(parsed);
  await referenceMuxer.finalize();
  const outputBytes = (await collectStream(referenceMuxer.output)).byteLength;
  const ops: OpResult[] = [];

  ops.push(
    await measure('ts stream→writable', outputBytes, durationSec, async () =>
      drainMpegTsToWritable(parsed),
    ),
  );
  ops.push(
    await measure('ts stream→callback', outputBytes, durationSec, async () =>
      drainMpegTsToCallback(parsed),
    ),
  );
  ops.push(
    await measure('ts tiny-writes 188B', outputBytes, durationSec, async () =>
      drainMpegTsToCallback(parsed, 1),
    ),
  );

  return { id, sizeBytes: bytes.byteLength, durationSec, outputBytes, outputKind: 'MPEG-TS', ops };
}

// ============ reporting ============

/** A first-byte/latency metric (mediaSeconds 0) is reported as wall(ms), not MB/s. */
function isLatency(op: string): boolean {
  return op.startsWith('first-byte');
}

function throughputCell(o: OpResult): string {
  return isLatency(o.op) ? `${o.wallMs.toFixed(3)} ms` : `${o.mbPerSec.toFixed(1)} MB/s`;
}

function printFile(r: FileResult): void {
  console.info(
    `\n${r.id} — ${(r.sizeBytes / 1024).toFixed(1)} KB in, ${(r.outputBytes / 1024).toFixed(1)} KB ${r.outputKind}, ${r.durationSec.toFixed(3)} s`,
  );
  console.info(
    `  ${'op'.padEnd(26)} ${'wall(ms)'.padStart(9)} ${'throughput'.padStart(12)} ${'×realtime'.padStart(11)} ${'peakMem(MB)'.padStart(12)}`,
  );
  for (const o of r.ops) {
    const rt = o.throughputRealtime > 0 ? `${o.throughputRealtime.toFixed(0)}×` : '—';
    console.info(
      `  ${o.op.padEnd(26)} ${o.wallMs.toFixed(3).padStart(9)} ${throughputCell(o).padStart(12)} ${rt.padStart(11)} ${o.peakMemoryMb.toFixed(2).padStart(12)}`,
    );
  }
  // The streaming win, made explicit: time-to-first-byte of the CMAF init segment vs the whole-file build.
  const frag = r.ops.find((o) => o.op === 'first-byte (fragment init)');
  const full = r.ops.find((o) => o.op === 'first-byte (writeMp4 full)');
  if (frag && full && frag.wallMs > 0) {
    console.info(
      `  → first-byte speedup vs non-streaming writeMp4: ${(full.wallMs / frag.wallMs).toFixed(1)}×`,
    );
  }
}

/** Per-op aggregate across all files: median wall, geomean MB/s (throughput ops), worst peak memory. */
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
    // Geomean over throughput ops only; a latency op's MB/s is 0 (excluded → its geomean cell is N/A).
    const thr = list.filter((o) => o.mbPerSec > 0);
    const logSum = thr.reduce((s, o) => s + Math.log(o.mbPerSec), 0);
    out.push({
      op,
      files: list.length,
      medianWallMs: median(list.map((o) => o.wallMs)),
      geomeanMbPerSec: thr.length > 0 ? Math.exp(logSum / thr.length) : 0,
      minMbPerSec: thr.reduce((m, o) => Math.min(m, o.mbPerSec), Number.POSITIVE_INFINITY),
      maxPeakMemoryMb: list.reduce((m, o) => Math.max(m, o.peakMemoryMb), 0),
    });
  }
  return out;
}

function printAggregates(aggs: readonly OpAggregate[]): void {
  console.info('\n=== per-op aggregate across all corpus files ===');
  console.info(
    '(first-byte ops report wall(ms) — a latency metric; stream ops report MB/s throughput)',
  );
  console.info(
    `  ${'op'.padEnd(26)} ${'files'.padStart(5)} ${'medWall(ms)'.padStart(12)} ${'geoThru'.padStart(12)} ${'worst'.padStart(11)} ${'maxMem(MB)'.padStart(11)}`,
  );
  for (const a of aggs) {
    const isLat = isLatency(a.op);
    const geo = isLat ? `${a.medianWallMs.toFixed(3)} ms` : `${a.geomeanMbPerSec.toFixed(1)} MB/s`;
    const worst = isLat ? '—' : `${a.minMbPerSec.toFixed(1)} MB/s`;
    console.info(
      `  ${a.op.padEnd(26)} ${String(a.files).padStart(5)} ${a.medianWallMs.toFixed(3).padStart(12)} ${geo.padStart(12)} ${worst.padStart(11)} ${a.maxPeakMemoryMb.toFixed(2).padStart(11)}`,
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

/**
 * Compare fresh aggregates to the committed baseline; return the regressed op labels. Throughput ops
 * regress when MB/s drops > tolerance; latency ops (first-byte) regress when median wall rises > tolerance
 * (slower time-to-first-byte) — each measured in its own honest unit.
 */
function regressions(fresh: readonly OpAggregate[], base: Baseline): string[] {
  const baseByOp = new Map(base.aggregates.map((a) => [a.op, a]));
  const regressed: string[] = [];
  for (const a of fresh) {
    const b = baseByOp.get(a.op);
    if (b === undefined) continue;
    if (isLatency(a.op)) {
      if (a.medianWallMs > b.medianWallMs * (1 + REGRESSION_TOLERANCE)) {
        regressed.push(
          `${a.op}: ${a.medianWallMs.toFixed(3)} ms vs baseline ${b.medianWallMs.toFixed(3)} ms (slower first byte)`,
        );
      }
    } else if (a.geomeanMbPerSec < b.geomeanMbPerSec * (1 - REGRESSION_TOLERANCE)) {
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
  if (MP4_FILES.length < 5 || TS_FILES.length < 5) {
    throw new Error(
      `streaming benchmark needs ≥ 5 real files per family (BUILD_INSTRUCTIONS §6.1); have mp4=${MP4_FILES.length}, ts=${TS_FILES.length}.`,
    );
  }
  console.info(
    `streaming-output benchmark — fragmented-MP4/CMAF + MPEG-TS packet writes through StreamTarget, pure TS, single-thread,\nmedian of ${ITERS} iters (warmup ${WARMUP}); ${MP4_FILES.length} real MP4 files + ${TS_FILES.length} real TS/HLS segment files:`,
  );

  const results: FileResult[] = [];
  for (const id of MP4_FILES) results.push(await benchFile(id));
  for (const file of TS_FILES) results.push(await benchTsFile(file.id, file.path));
  for (const r of results) printFile(r);

  const aggs = aggregate(results);
  printAggregates(aggs);
  console.info(`\n(checksum ${sink})`);

  if (check) {
    const base = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
    const regressed = regressions(aggs, base);
    if (regressed.length > 0) {
      console.error(`\nREGRESSION vs ${BASELINE_PATH} (> ${REGRESSION_TOLERANCE * 100}%):`);
      for (const r of regressed) console.error(`  - ${r}`);
      process.exit(1);
    }
    console.info(`\nno regression vs baseline (${base.generatedAt}).`);
    return;
  }

  await mkdir(dirname(BASELINE_PATH), { recursive: true });
  await writeFile(BASELINE_PATH, `${JSON.stringify(buildBaseline(results, aggs), null, 2)}\n`);
  console.info(`\nbaseline written → ${BASELINE_PATH}`);
}

await main();
