#!/usr/bin/env bun
/**
 * Session 11 fragmented-audio MP4 probe benchmark. Measures the four real fair-corpus rotations through
 * fresh range-backed sources, checks that every timed probe remains initialization-prefix bounded, and
 * folds exact track metadata plus I/O into a checksum sink.
 */

import { open } from 'node:fs/promises';
import type { ByteSource, TrackInfo } from '../src/contracts/driver.ts';
import { Mp4Driver } from '../src/drivers/mp4/mp4-driver.ts';

const WARMUP = 3;
const SAMPLES = 9;
const MAX_INIT_PREFIX_BYTES = 1024 * 1024;
const CORPUS = new URL(
  '../../media-test/fixtures/media/scenarios/probe/longform_1h_audio/',
  import.meta.url,
).pathname;
const SUBJECT_NAMES = ['01.mp4', '02.mp4', '03.mp4', 'longform_1h_audio.m4a'] as const;

interface Subject {
  readonly name: string;
  readonly size: number;
  readonly handle: Awaited<ReturnType<typeof open>>;
}

interface ProbeStats {
  rangeCalls: number;
  rangeBytes: number;
  maximumEnd: number;
}

interface Sample {
  readonly elapsedMs: number;
  readonly checksum: number;
  readonly rangeCalls: number;
  readonly rangeBytes: number;
  readonly maximumEnd: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

function sourceFor(subject: Subject, stats: ProbeStats): ByteSource {
  return {
    size: subject.size,
    async range(start, end): Promise<Uint8Array> {
      const length = Math.max(0, end - start);
      const bytes = new Uint8Array(length);
      const { bytesRead } = await subject.handle.read(bytes, 0, length, start);
      stats.rangeCalls++;
      stats.rangeBytes += bytesRead;
      stats.maximumEnd = Math.max(stats.maximumEnd, end);
      return bytesRead === bytes.byteLength ? bytes : bytes.subarray(0, bytesRead);
    },
    stream(): ReadableStream<Uint8Array> {
      throw new Error('fragmented-audio probe benchmark must stay range-backed');
    },
  };
}

function checksumTracks(tracks: readonly TrackInfo[]): number {
  let checksum = tracks.length;
  for (const track of tracks) {
    const config = track.config;
    const sampleRate =
      config !== undefined && 'sampleRate' in config && typeof config.sampleRate === 'number'
        ? config.sampleRate
        : 0;
    const channels =
      config !== undefined &&
      'numberOfChannels' in config &&
      typeof config.numberOfChannels === 'number'
        ? config.numberOfChannels
        : 0;
    checksum =
      (checksum +
        track.id * 17 +
        track.codec.length * 31 +
        Math.round((track.durationSec ?? 0) * 1000) * 3 +
        sampleRate * 5 +
        channels * 7) >>>
      0;
  }
  return checksum;
}

async function runSample(subjects: readonly Subject[]): Promise<Sample> {
  const probe = Mp4Driver.probe;
  if (probe === undefined) throw new Error('MP4 probe capability is missing');
  const started = performance.now();
  let checksum = 0;
  let rangeCalls = 0;
  let rangeBytes = 0;
  let maximumEnd = 0;
  for (const subject of subjects) {
    const stats: ProbeStats = { rangeCalls: 0, rangeBytes: 0, maximumEnd: 0 };
    const tracks = await probe(sourceFor(subject, stats));
    if (tracks.length !== 1 || tracks[0]?.mediaType !== 'audio') {
      throw new Error(`${subject.name} did not probe as exactly one audio track`);
    }
    if (stats.maximumEnd > MAX_INIT_PREFIX_BYTES || stats.maximumEnd >= subject.size) {
      throw new Error(
        `${subject.name} escaped init metadata: maxEnd=${stats.maximumEnd}, size=${subject.size}`,
      );
    }
    checksum =
      (checksum +
        checksumTracks(tracks) +
        stats.rangeCalls * 11 +
        stats.rangeBytes * 13 +
        stats.maximumEnd * 17) >>>
      0;
    rangeCalls += stats.rangeCalls;
    rangeBytes += stats.rangeBytes;
    maximumEnd = Math.max(maximumEnd, stats.maximumEnd);
  }
  return {
    elapsedMs: performance.now() - started,
    checksum,
    rangeCalls,
    rangeBytes,
    maximumEnd,
  };
}

async function main(): Promise<void> {
  const subjects: Subject[] = [];
  try {
    for (const name of SUBJECT_NAMES) {
      const handle = await open(`${CORPUS}${name}`, 'r');
      subjects.push({ name, handle, size: (await handle.stat()).size });
    }

    const timings: number[] = [];
    let checksum = 0;
    let representative: Sample | undefined;
    for (let index = 0; index < WARMUP + SAMPLES; index++) {
      const sample = await runSample(subjects);
      checksum = (checksum + sample.checksum) >>> 0;
      if (index >= WARMUP) {
        timings.push(sample.elapsedMs);
        representative = sample;
      }
    }

    Bun.gc(true);
    const before = process.memoryUsage().rss;
    const memorySample = await runSample(subjects);
    const peakMemoryMb = Math.max(0, process.memoryUsage().rss - before) / (1024 * 1024);
    checksum = (checksum + memorySample.checksum) >>> 0;
    representative ??= memorySample;

    console.info(
      `Session 11 fragmented-audio MP4 probe — ${subjects.length} real rotations; ` +
        `median=${median(timings).toFixed(3)} ms (${SAMPLES} samples, warmup ${WARMUP}); ` +
        `rangeCalls=${representative.rangeCalls}; rangeBytes=${representative.rangeBytes}; ` +
        `maxEnd=${representative.maximumEnd}; peakRSS+=${peakMemoryMb.toFixed(2)} MiB; ` +
        `checksum=${checksum}; samples=[${timings.map((ms) => ms.toFixed(3)).join(', ')}]`,
    );
  } finally {
    await Promise.all(subjects.map(async (subject) => await subject.handle.close()));
  }
}

await main();
