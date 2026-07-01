#!/usr/bin/env bun
/**
 * Session 9 MP4 packet-table benchmark. Times the exact top-deficit hot path on the real massive
 * Chromium fixture: range-read `moov`, parse sample tables, and enumerate packet metadata without
 * reading `mdat`. Reports multi-sample medians plus an RSS delta sample and checksum sink.
 */

import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  mp4PacketInfoMetadata,
  mp4PacketMetadata,
  readMovie,
  readMoviePacketInfo,
} from '../src/drivers/mp4/mp4-driver.ts';
import type { Movie } from '../src/drivers/mp4/parse.ts';

const WARMUP = 2;
const ITERS = 7;
const DEFAULT_FIXTURE = new URL(
  '../../media-test/media-browser-test/fixtures/media/massive_h264_1080p_2h.mp4',
  import.meta.url,
).pathname;

interface RandomAccessLike {
  read(offset: number, length: number): Promise<Uint8Array>;
  size: number;
}

interface BenchResult {
  readonly name: string;
  readonly medianMs: number;
  readonly samplesMs: readonly number[];
  readonly peakMemoryMb: number;
  readonly checksum: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted[mid];
  if (value === undefined) throw new Error('cannot take median of an empty sample set');
  return value;
}

function checksumMovie(movie: Movie): number {
  let checksum = movie.tracks.length;
  for (const track of movie.tracks) {
    checksum = (checksum + track.id * 17 + track.samples.sampleSizes.length * 31) >>> 0;
    checksum = (checksum + Math.round(track.durationSec * 1000)) >>> 0;
  }
  return checksum;
}

function checksumPacketTable(movie: Movie, sourceSize: number): number {
  let checksum = 0;
  const packets = mp4PacketMetadata(movie, sourceSize);
  for (const packet of packets) {
    checksum =
      (checksum +
        packet.trackId * 17 +
        packet.sizeBytes * 3 +
        packet.durationUs +
        packet.ptsUs +
        (packet.dtsUs ?? packet.ptsUs) +
        (packet.keyframe ? 1 : 0)) >>>
      0;
  }
  return (checksum + packets.length * 31) >>> 0;
}

function checksumPacketInfoTable(movie: Movie, sourceSize: number): number {
  let checksum = 0;
  const packets = mp4PacketInfoMetadata(movie, sourceSize);
  for (const packet of packets) {
    checksum =
      (checksum +
        packet.trackIndex * 17 +
        packet.size * 3 +
        packet.ptsUs +
        packet.dtsUs +
        (packet.keyframe ? 1 : 0)) >>>
      0;
  }
  return (checksum + packets.length * 31) >>> 0;
}

async function withFile<T>(path: string, fn: (ra: RandomAccessLike) => Promise<T>): Promise<T> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    const ra: RandomAccessLike = {
      size: stat.size,
      read: async (offset, length) => {
        const bytes = new Uint8Array(length);
        const { bytesRead } = await file.read(bytes, 0, length, offset);
        return bytesRead === bytes.byteLength ? bytes : bytes.subarray(0, bytesRead);
      },
    };
    return await fn(ra);
  } finally {
    await file.close();
  }
}

async function timeSamples(
  fn: () => Promise<number>,
): Promise<{ samplesMs: number[]; checksum: number }> {
  let checksum = 0;
  const samplesMs: number[] = [];
  for (let i = 0; i < WARMUP + ITERS; i++) {
    const t0 = performance.now();
    checksum = (checksum + (await fn())) >>> 0;
    const elapsed = performance.now() - t0;
    if (i >= WARMUP) samplesMs.push(elapsed);
  }
  return { samplesMs, checksum };
}

async function peakMemory(
  fn: () => Promise<number>,
): Promise<{ peakMemoryMb: number; checksum: number }> {
  const base = process.memoryUsage().rss;
  let peak = base;
  const checksum = await fn();
  peak = Math.max(peak, process.memoryUsage().rss);
  return { peakMemoryMb: Math.max(0, peak - base) / (1024 * 1024), checksum };
}

async function bench(
  name: string,
  timed: () => Promise<number>,
  memory: () => Promise<number>,
): Promise<BenchResult> {
  const timedResult = await timeSamples(timed);
  const memoryResult = await peakMemory(memory);
  return {
    name,
    medianMs: median(timedResult.samplesMs),
    samplesMs: timedResult.samplesMs,
    peakMemoryMb: memoryResult.peakMemoryMb,
    checksum: (timedResult.checksum + memoryResult.checksum) >>> 0,
  };
}

function formatSamples(samplesMs: readonly number[]): string {
  return samplesMs.map((ms) => ms.toFixed(3)).join(', ');
}

async function main(): Promise<void> {
  const input = resolve(process.argv[2] ?? DEFAULT_FIXTURE);
  if (!existsSync(input)) {
    throw new Error(`fixture not found: ${input}`);
  }
  let parsedMovie: Movie | undefined;
  let sourceSize = 0;
  await withFile(input, async (ra) => {
    sourceSize = ra.size;
    parsedMovie = await readMovie(ra);
    return undefined;
  });
  const movie = parsedMovie;
  if (movie === undefined) throw new Error('failed to parse movie');
  const packetCount = movie.tracks.reduce(
    (sum, track) => sum + track.samples.sampleSizes.length,
    0,
  );

  const parseOnly = await bench(
    'readMovie(range moov)',
    () => withFile(input, async (ra) => checksumMovie(await readMovie(ra))),
    () => withFile(input, async (ra) => checksumMovie(await readMovie(ra))),
  );
  const packetInfoParseOnly = await bench(
    'readMoviePacketInfo(range moov)',
    () => withFile(input, async (ra) => checksumMovie(await readMoviePacketInfo(ra))),
    () => withFile(input, async (ra) => checksumMovie(await readMoviePacketInfo(ra))),
  );
  const tableOnly = await bench(
    'mp4PacketMetadata(parsed movie)',
    () => Promise.resolve(checksumPacketTable(movie, sourceSize)),
    () => Promise.resolve(checksumPacketTable(movie, sourceSize)),
  );
  const infoTableOnly = await bench(
    'mp4PacketInfoMetadata(parsed)',
    () => Promise.resolve(checksumPacketInfoTable(movie, sourceSize)),
    () => Promise.resolve(checksumPacketInfoTable(movie, sourceSize)),
  );
  const parseAndTable = await bench(
    'readMovie + mp4PacketMetadata',
    () =>
      withFile(input, async (ra) => {
        const parsed = await readMovie(ra);
        return checksumMovie(parsed) + checksumPacketTable(parsed, ra.size);
      }),
    () =>
      withFile(input, async (ra) => {
        const parsed = await readMovie(ra);
        return checksumMovie(parsed) + checksumPacketTable(parsed, ra.size);
      }),
  );
  const parseAndInfoTable = await bench(
    'readMovie + mp4PacketInfoMetadata',
    () =>
      withFile(input, async (ra) => {
        const parsed = await readMovie(ra);
        return checksumMovie(parsed) + checksumPacketInfoTable(parsed, ra.size);
      }),
    () =>
      withFile(input, async (ra) => {
        const parsed = await readMovie(ra);
        return checksumMovie(parsed) + checksumPacketInfoTable(parsed, ra.size);
      }),
  );
  const packetInfoParseAndTable = await bench(
    'readMoviePacketInfo + metadata',
    () =>
      withFile(input, async (ra) => {
        const parsed = await readMoviePacketInfo(ra);
        return checksumMovie(parsed) + checksumPacketInfoTable(parsed, ra.size);
      }),
    () =>
      withFile(input, async (ra) => {
        const parsed = await readMoviePacketInfo(ra);
        return checksumMovie(parsed) + checksumPacketInfoTable(parsed, ra.size);
      }),
  );

  console.info(
    `Session 9 MP4 packet-table benchmark — median of ${ITERS} iters (warmup ${WARMUP}); ${packetCount} packets; source ${(sourceSize / (1024 * 1024)).toFixed(1)} MiB`,
  );
  for (const result of [
    parseOnly,
    packetInfoParseOnly,
    tableOnly,
    infoTableOnly,
    parseAndTable,
    parseAndInfoTable,
    packetInfoParseAndTable,
  ]) {
    const packetsPerSec = packetCount / (result.medianMs / 1000);
    console.info(
      `${result.name.padEnd(32)} median=${result.medianMs.toFixed(3).padStart(9)} ms ` +
        `packets/s=${packetsPerSec.toFixed(0).padStart(10)} ` +
        `peakRSS+=${result.peakMemoryMb.toFixed(2).padStart(7)} MiB ` +
        `checksum=${result.checksum} samples=[${formatSamples(result.samplesMs)}]`,
    );
  }
}

await main();
