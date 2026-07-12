#!/usr/bin/env bun
/** Fresh real-media benchmark for ADR-286's bounded large MP4/MOV metadata walker. */

import { stat } from 'node:fs/promises';
import { type FileHandle, open } from 'node:fs/promises';
import type { ByteSource, TrackInfo } from '../src/contracts/driver.ts';
import { Mp4Driver } from '../src/drivers/mp4/mp4-driver.ts';

const WARMUP = 5;
const SAMPLES = 31;

const REQUIRED_SUBJECTS = [
  'fixtures/media/bear-1280x720.mp4',
  'fixtures/media/test.mp4',
  'fixtures/media/obs-remux-variable-aac.mp4',
  'fixtures/media/bear-4k-hevc.mp4',
  'fixtures/media/bear-hevc-10bit-hdr10.mp4',
  'fixtures/media/bear-rotate-90.mp4',
] as const;

// Public acceptance assets are benchmark data, not harness implementation. Keep them optional so the
// product benchmark remains runnable in a standalone checkout while measuring the exact contested shapes
// whenever the sibling acceptance corpus is present.
const OPTIONAL_ACCEPTANCE_SUBJECTS = [
  '../media-test/fixtures/media/h264_4k_10s.mp4',
  '../media-test/fixtures/media/hevc_1080p_10s.mp4',
  '../media-test/fixtures/media/h264_vfr.mp4',
  '../media-test/fixtures/media/large_h264_1080p_120s.mp4',
] as const;

interface ReadStats {
  reads: number;
  bytes: number;
  largestReadBytes: number;
}

interface Observation {
  readonly elapsedMs: number;
  readonly stats: ReadStats;
  readonly tracks: readonly TrackInfo[];
}

interface SubjectResult {
  readonly path: string;
  readonly sourceBytes: number;
  readonly optimizedMedianMs: number;
  readonly genericMedianMs: number;
  readonly ratio: number;
  readonly optimizedReads: number;
  readonly genericReads: number;
  readonly optimizedBytes: number;
  readonly genericBytes: number;
  readonly optimizedLargestReadBytes: number;
  readonly genericLargestReadBytes: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

async function existingOptionalSubjects(): Promise<string[]> {
  const existing: string[] = [];
  for (const path of OPTIONAL_ACCEPTANCE_SUBJECTS) {
    try {
      await stat(path);
      existing.push(path);
    } catch (error) {
      const code = (error as { readonly code?: unknown }).code;
      if (code !== 'ENOENT') throw error;
    }
  }
  return existing;
}

function rangeSource(
  file: FileHandle,
  size: number,
  stats: ReadStats,
  optimized: boolean,
): ByteSource {
  return {
    size,
    ...(optimized ? { mimeHint: 'video/mp4' } : {}),
    stream(): ReadableStream<Uint8Array> {
      throw new Error('large MP4 probe benchmark must stay range-backed');
    },
    async range(start, end): Promise<Uint8Array> {
      const length = Math.max(0, end - start);
      const bytes = new Uint8Array(length);
      const { bytesRead } = await file.read(bytes, 0, length, start);
      stats.reads++;
      stats.bytes += bytesRead;
      stats.largestReadBytes = Math.max(stats.largestReadBytes, bytesRead);
      return bytesRead === length ? bytes : bytes.subarray(0, bytesRead);
    },
  };
}

async function observe(file: FileHandle, size: number, optimized: boolean): Promise<Observation> {
  const probe = Mp4Driver.probe;
  if (probe === undefined) throw new Error('Mp4Driver lost its metadata-only probe');
  const stats: ReadStats = { reads: 0, bytes: 0, largestReadBytes: 0 };
  const started = Bun.nanoseconds();
  const tracks = await probe(rangeSource(file, size, stats, optimized));
  return {
    elapsedMs: (Bun.nanoseconds() - started) / 1_000_000,
    stats,
    tracks,
  };
}

function assertTrackTruth(
  path: string,
  optimized: readonly TrackInfo[],
  generic: readonly TrackInfo[],
): void {
  if (JSON.stringify(optimized) !== JSON.stringify(generic)) {
    throw new Error(`${path}: optimized probe changed authoritative track truth`);
  }
}

async function benchmarkSubject(path: string): Promise<SubjectResult> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const optimizedTimes: number[] = [];
    const genericTimes: number[] = [];
    let optimizedStats: ReadStats | undefined;
    let genericStats: ReadStats | undefined;
    let optimizedTruth: readonly TrackInfo[] | undefined;
    let genericTruth: readonly TrackInfo[] | undefined;

    for (let iteration = 0; iteration < WARMUP + SAMPLES; iteration++) {
      const optimizedFirst = iteration % 2 === 0;
      const first = await observe(file, size, optimizedFirst);
      const second = await observe(file, size, !optimizedFirst);
      const optimized = optimizedFirst ? first : second;
      const generic = optimizedFirst ? second : first;
      assertTrackTruth(path, optimized.tracks, generic.tracks);
      optimizedStats = optimized.stats;
      genericStats = generic.stats;
      optimizedTruth = optimized.tracks;
      genericTruth = generic.tracks;
      if (iteration >= WARMUP) {
        optimizedTimes.push(optimized.elapsedMs);
        genericTimes.push(generic.elapsedMs);
      }
    }

    if (
      optimizedStats === undefined ||
      genericStats === undefined ||
      optimizedTruth === undefined ||
      genericTruth === undefined
    ) {
      throw new Error(`${path}: benchmark produced no observations`);
    }
    assertTrackTruth(path, optimizedTruth, genericTruth);
    const optimizedMedianMs = median(optimizedTimes);
    const genericMedianMs = median(genericTimes);
    return {
      path,
      sourceBytes: size,
      optimizedMedianMs,
      genericMedianMs,
      ratio: optimizedMedianMs / genericMedianMs,
      optimizedReads: optimizedStats.reads,
      genericReads: genericStats.reads,
      optimizedBytes: optimizedStats.bytes,
      genericBytes: genericStats.bytes,
      optimizedLargestReadBytes: optimizedStats.largestReadBytes,
      genericLargestReadBytes: genericStats.largestReadBytes,
    };
  } finally {
    await file.close();
  }
}

const subjects = [...REQUIRED_SUBJECTS, ...(await existingOptionalSubjects())];
if (subjects.length < 5) {
  throw new Error(
    `large MP4 probe benchmark needs at least five real files; found ${subjects.length}`,
  );
}

const results: SubjectResult[] = [];
for (const path of subjects) results.push(await benchmarkSubject(path));

console.info(
  JSON.stringify(
    {
      benchmark: 'session13-large-mp4-probe',
      warmup: WARMUP,
      samples: SAMPLES,
      results,
    },
    null,
    2,
  ),
);
