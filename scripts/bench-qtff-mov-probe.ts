#!/usr/bin/env bun
/**
 * QuickTime `.mov` probe/enumeration benchmark (task #11 / ADR-185). Times `parseMovieMetadata` on the
 * real 596 s 1080p Big Buck Bunny QuickTime header (395 KB `moov`, 3 traks incl. `tmcd`, v2 sound
 * description with wave-nested `esds`, `colr`) — the exact file class whose track enumeration the task
 * fixes. Guards that surfacing non-media traks + colr/pasp/clap stays O(index): the input is a
 * header-only file (no `mdat` exists to scan), and wall-time must not regress.
 *
 *   bun scripts/bench-qtff-mov-probe.ts
 */

import { readFile } from 'node:fs/promises';
import { parseMovieMetadata } from '../src/drivers/mp4/parse.ts';
import { Reader, boxes } from '../src/drivers/mp4/reader.ts';

const WARMUP = 5;
const ITERS = 21;
const FIXTURE = new URL(
  '../fixtures/media-derived/big_buck_bunny_1080p_h264.header.mov',
  import.meta.url,
).pathname;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take median of an empty sample set');
  return value;
}

function moovPayloadOf(file: Uint8Array): { brand: string; moov: Uint8Array } {
  const r = new Reader(file);
  let brand = 'mp42';
  for (const box of boxes(r, file.byteLength)) {
    if (box.type === 'ftyp') {
      brand = String.fromCharCode(...file.subarray(box.payloadStart, box.payloadStart + 4));
    }
    if (box.type === 'moov') return { brand, moov: file.subarray(box.payloadStart, box.end) };
  }
  throw new Error('no moov in fixture');
}

async function main(): Promise<void> {
  const file = new Uint8Array(await readFile(FIXTURE));
  const { brand, moov } = moovPayloadOf(file);

  // Correctness checksum alongside the timing: the parse must keep yielding the same track facts.
  let checksum = 0;
  const samples: number[] = [];
  for (let i = 0; i < WARMUP + ITERS; i++) {
    const t0 = performance.now();
    const movie = parseMovieMetadata(brand, moov);
    const t1 = performance.now();
    checksum =
      movie.tracks.length * 1000 +
      (movie.otherTracks?.length ?? 0) * 100 +
      Math.round(movie.durationSec);
    if (i >= WARMUP) samples.push(t1 - t0);
  }

  const med = median(samples);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  console.info('bench-qtff-mov-probe — parseMovieMetadata on big_buck_bunny_1080p_h264.header.mov');
  console.info(`  moov bytes : ${moov.byteLength}`);
  console.info(`  iterations : ${ITERS} (+${WARMUP} warmup)`);
  console.info(`  median     : ${med.toFixed(3)} ms`);
  console.info(`  min / max  : ${min.toFixed(3)} / ${max.toFixed(3)} ms`);
  console.info(`  checksum   : ${checksum} (tracks*1000 + otherTracks*100 + round(durationSec))`);
}

await main();
