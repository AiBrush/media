#!/usr/bin/env bun
/**
 * scripts/bench-mpegts-demux.ts — fresh, multi-sample wall-time benchmark for the MPEG-TS demux core
 * (`parseTs`: transport framing → PSI → PES reassembly → per-access-unit split incl. the stateful AAC
 * ADTS de-framer). Guards the ADR-184 requirement that de-framing stays a streaming, single-pass scan
 * with no per-frame buffering: the ≥30 s audio fixture makes any O(n²) buffering or per-frame copy
 * regression visible as a throughput drop. Reports the median of N runs (warmup discarded) plus a
 * checksum derived from the parsed units so the work cannot be elided.
 *
 *   bun scripts/bench-mpegts-demux.ts
 */

import { parseTs } from '../src/drivers/mpegts/ts-parse.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const FILES = [
  // ≥30 s audio-only ADTS AAC (691 frames, 88 PES): the de-framer hot path.
  'fixtures/media-derived/mpegts/aac_22k_long.m2t',
  // Broadcast-style packing: every ADTS frame crosses a PES boundary (worst-case pending-buffer path).
  'fixtures/media-derived/mpegts/aac_48k_split.m2t',
  // Real A/V transport stream (H.264 + AAC): the mixed-PID demux path.
  'fixtures/media/bear-1280x720.ts',
];
const WARMUP = 2;
const ITERS = 9;

let sink = 0;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function checksum(parsed: ReturnType<typeof parseTs>): number {
  let acc = 0;
  for (const track of parsed.tracks) {
    acc = (acc + track.units.length) | 0;
    const first = track.units[0];
    const last = track.units[track.units.length - 1];
    acc = (acc + (first?.data[0] ?? 0) + (last?.data[last.data.byteLength - 1] ?? 0)) | 0;
    acc = (acc + (last?.ptsUs ?? 0)) | 0;
  }
  return acc;
}

async function main(): Promise<void> {
  console.info(`MPEG-TS demux (parseTs) wall time — median of ${ITERS} runs, warmup ${WARMUP}:`);
  for (const rel of FILES) {
    const bytes = new Uint8Array(await Bun.file(`${ROOT}${rel}`).arrayBuffer());
    const parsed = parseTs(bytes);
    const unitCount = parsed.tracks.reduce((n, t) => n + t.units.length, 0);

    for (let i = 0; i < WARMUP; i++) sink = (sink + checksum(parseTs(bytes))) | 0;
    const times: number[] = [];
    for (let i = 0; i < ITERS; i++) {
      const t0 = Bun.nanoseconds();
      sink = (sink + checksum(parseTs(bytes))) | 0;
      times.push(Bun.nanoseconds() - t0);
    }
    const ns = median(times);
    const msPerOp = ns / 1e6;
    const mbPerSec = bytes.byteLength / (ns / 1e9) / 1e6;
    const unitsPerSec = unitCount / (ns / 1e9);
    const name = rel.split('/').pop() ?? rel;
    console.info(
      `  ${name.padEnd(24)} ${msPerOp.toFixed(3).padStart(9)} ms  ${mbPerSec.toFixed(0).padStart(6)} MB/s  ${Math.round(unitsPerSec).toString().padStart(9)} units/s  (${unitCount} units, ${(bytes.byteLength / 1024).toFixed(0)} KiB)`,
    );
  }
  console.info(`\n(checksum ${sink})`);
}

await main();
