#!/usr/bin/env bun
/**
 * scripts/bench-webm-fragment.ts — fresh, multi-sample benchmark for the fragmented/CMAF WebM muxer
 * ({@link fragmentWebm} / {@link WebmMuxer} with `{ fragmented: true }`, ADR-091; BUILD_INSTRUCTIONS §2
 * "a benchmark", §6.3). For each real WebM corpus file it: demuxes once to per-track frames, then re-muxes
 * those frames as a fragmented WebM, measuring the **mux** step only (median of N runs, warmup discarded).
 *
 * Units are MB/s of muxed output. It also records the **streaming-output** property that motivates the
 * feature: the number of emitted chunks (init + one per Cluster) and the *peak single-chunk* size — peak
 * output memory stays bounded to one Cluster, not the whole movie — plus a byte-sum checksum so the work
 * cannot be elided.
 *
 *   bun run bench-webm-fragment            # run + print + (re)write the baseline
 *   bun run bench-webm-fragment --check    # run + print + diff vs the committed baseline
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type ChunkStruct, WebmMuxer } from '../src/drivers/webm/ebml-write.ts';
import { type WebmDemux, demuxWebm } from '../src/drivers/webm/webm-driver.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/webm-fragment.json`;

const WARMUP = 2;
const ITERS = 11;
const REGRESSION_TOLERANCE = 0.5;

// Diverse real WebM: vp9+opus, a long multi-GOP vp8, vp9-alpha, opus audio-only, a tiny clip, and
// headerless recorder output. bear-multitrack carries non-WebM-muxable codecs (theora/PCM) — its
// WebM-native tracks (vp8 + vorbis) are exercised; the rest are skipped (same rule as the oracle).
const FILES = [
  'movie_5.webm',
  'white.webm',
  'bear-vp9-alpha.webm',
  'bear-opus.webm',
  '2x2-green.webm',
  'recorder_headerless.webm',
  'bear-multitrack.webm',
] as const;

let sink = 0;

/** A WebCodecs codec string the WebM muxer can write, or `undefined` for codecs with no Matroska CodecID. */
function muxableCodec(codec: string): string | undefined {
  switch (codec) {
    case 'vp8':
      return 'vp8';
    case 'vp9':
      return 'vp09.00.10.08';
    case 'av1':
      return 'av01.0.04M.08';
    case 'h264':
      return 'avc1.42E01E';
    case 'hevc':
      return 'hvc1.1.6.L93.B0';
    case 'opus':
      return 'opus';
    case 'vorbis':
      return 'vorbis';
    case 'aac':
      return 'mp4a.40.2';
    case 'flac':
      return 'flac';
    case 'mp3':
      return 'mp3';
    default:
      return undefined;
  }
}

interface PreparedTrack {
  codecString: string;
  mediaType: 'video' | 'audio';
  fps: number | undefined;
  config: VideoDecoderConfig | AudioDecoderConfig;
  chunks: ChunkStruct[];
}

/** Project a demuxed WebM into the muxer-ready, codec-legal tracks (skipping theora/PCM). */
function prepareTracks(demux: WebmDemux): PreparedTrack[] {
  const out: PreparedTrack[] = [];
  demux.info.tracks.forEach((track, index) => {
    const codecString = muxableCodec(track.codec);
    const frames = demux.framesByIndex[index];
    if (codecString === undefined || frames === undefined || frames.length === 0) return;
    const config: VideoDecoderConfig | AudioDecoderConfig =
      track.mediaType === 'video'
        ? {
            codec: codecString,
            codedWidth: track.width ?? 0,
            codedHeight: track.height ?? 0,
            ...(track.description !== undefined ? { description: track.description } : {}),
          }
        : {
            codec: codecString,
            sampleRate: track.sampleRate ?? 48_000,
            numberOfChannels: track.channels ?? 2,
            ...(track.description !== undefined ? { description: track.description } : {}),
          };
    out.push({
      codecString,
      mediaType: track.mediaType,
      fps: track.fps,
      config,
      chunks: frames.map((frame) => ({
        timestampUs: frame.timestampUs,
        durationUs: undefined,
        key: frame.keyframe,
        data: frame.data,
      })),
    });
  });
  return out;
}

interface MuxOutcome {
  bytes: number;
  chunks: number;
  peakChunkBytes: number;
}

/** Mux the prepared tracks as a fragmented WebM and drain `output`, recording streaming-output stats. */
async function muxFragmented(tracks: readonly PreparedTrack[]): Promise<MuxOutcome> {
  const muxer = new WebmMuxer({ fragmented: true });
  for (const track of tracks) {
    const id = muxer.addTrack({
      id: 1,
      mediaType: track.mediaType,
      codec: track.codecString,
      ...(track.fps !== undefined ? { fps: track.fps } : {}),
      config: track.config,
    });
    for (const chunk of track.chunks) muxer.addChunkStruct(id, chunk);
  }
  await muxer.finalize();
  const reader = muxer.output.getReader();
  let bytes = 0;
  let chunks = 0;
  let peakChunkBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    chunks++;
    if (value.byteLength > peakChunkBytes) peakChunkBytes = value.byteLength;
    sink = (sink + (value[0] ?? 0)) | 0;
  }
  return { bytes, chunks, peakChunkBytes };
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

interface FileResult {
  id: string;
  tracks: number;
  frames: number;
  outBytes: number;
  chunks: number;
  /** init + clusters; peak single-chunk size proves bounded per-Cluster output memory. */
  peakChunkBytes: number;
  wallMs: number;
  mbPerSec: number;
}

async function benchFile(id: string): Promise<FileResult> {
  const bytes = new Uint8Array(await readFile(`${ROOT}fixtures/media/${id}`));
  const demux = demuxWebm(bytes);
  const tracks = prepareTracks(demux);
  if (tracks.length === 0) throw new Error(`no WebM-muxable tracks in ${id}`);
  const frames = tracks.reduce((sum, t) => sum + t.chunks.length, 0);

  for (let i = 0; i < WARMUP; i++) sink = (sink + (await muxFragmented(tracks)).chunks) | 0;
  const samples: number[] = [];
  let last: MuxOutcome = { bytes: 0, chunks: 0, peakChunkBytes: 0 };
  for (let i = 0; i < ITERS; i++) {
    const t0 = Bun.nanoseconds();
    last = await muxFragmented(tracks);
    samples.push(Bun.nanoseconds() - t0);
  }
  const ns = median(samples);
  return {
    id,
    tracks: tracks.length,
    frames,
    outBytes: last.bytes,
    chunks: last.chunks,
    peakChunkBytes: last.peakChunkBytes,
    wallMs: ns / 1e6,
    mbPerSec: last.bytes / (1024 * 1024) / (ns / 1e9),
  };
}

interface Aggregate {
  files: number;
  geomeanMbPerSec: number;
  minMbPerSec: number;
}

function aggregate(results: readonly FileResult[]): Aggregate {
  const logSum = results.reduce((sum, r) => sum + Math.log(Math.max(r.mbPerSec, 1e-9)), 0);
  return {
    files: results.length,
    geomeanMbPerSec: Math.exp(logSum / results.length),
    minMbPerSec: results.reduce((min, r) => Math.min(min, r.mbPerSec), Number.POSITIVE_INFINITY),
  };
}

interface Baseline {
  generatedAt: string;
  runtime: string;
  warmup: number;
  iters: number;
  files: FileResult[];
  aggregate: Aggregate;
}

function regressions(fresh: readonly FileResult[], base: Baseline): string[] {
  const baseById = new Map(base.files.map((f) => [f.id, f]));
  const out: string[] = [];
  for (const r of fresh) {
    const b = baseById.get(r.id);
    if (b !== undefined && r.mbPerSec < b.mbPerSec * (1 - REGRESSION_TOLERANCE)) {
      out.push(`${r.id}: ${r.mbPerSec.toFixed(1)} MB/s vs baseline ${b.mbPerSec.toFixed(1)} MB/s`);
    }
  }
  return out;
}

function printFile(r: FileResult): void {
  console.info(
    `  ${r.id.padEnd(26)} ${r.wallMs.toFixed(3).padStart(8)} ms  ${r.mbPerSec
      .toFixed(1)
      .padStart(7)} MB/s  ${String(r.frames).padStart(5)} frames  ${String(r.chunks).padStart(
      4,
    )} chunks  peak ${(r.peakChunkBytes / 1024).toFixed(1).padStart(7)} KB`,
  );
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  console.info(
    `fragmented WebM mux throughput — median of ${ITERS} runs (warmup ${WARMUP}); units are MB/s of output:\n`,
  );
  const results: FileResult[] = [];
  for (const id of FILES) results.push(await benchFile(id));
  for (const r of results) printFile(r);
  const agg = aggregate(results);
  console.info(
    `\n  aggregate: ${agg.geomeanMbPerSec.toFixed(1)} MB/s geomean, ${agg.minMbPerSec.toFixed(
      1,
    )} MB/s worst, over ${agg.files} files`,
  );
  console.info(`\n(checksum ${sink})`);

  if (check) {
    const base = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
    const regressed = regressions(results, base);
    if (regressed.length > 0) {
      console.error(`\nREGRESSION vs ${BASELINE_PATH} (> ${REGRESSION_TOLERANCE * 100}% slower):`);
      for (const item of regressed) console.error(`  - ${item}`);
      process.exit(1);
    }
    console.info(`\nno regression vs baseline (${base.generatedAt}).`);
    return;
  }

  const baseline: Baseline = {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    warmup: WARMUP,
    iters: ITERS,
    files: results,
    aggregate: agg,
  };
  await mkdir(dirname(BASELINE_PATH), { recursive: true });
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.info(`\nbaseline written -> ${BASELINE_PATH}`);
}

await main();
