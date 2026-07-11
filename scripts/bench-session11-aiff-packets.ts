#!/usr/bin/env bun
/**
 * Session 11 AIFF packet-table benchmark. Parses all four rotated real PCM-s16be subjects from fresh
 * byte views, covering byte-oriented 4 KiB packet sizing across mono/stereo layouts without disk noise.
 */

import { readFile } from 'node:fs/promises';
import { aiffPacketInfoFromBytes } from '../src/drivers/aiff/aiff-driver.ts';

const WARMUP = 2;
const SAMPLES = 9;
const CORPUS = new URL(
  '../../media-test/fixtures/media/scenarios/demux/pcm_s16be/',
  import.meta.url,
).pathname;
const SUBJECTS = ['pcm_s16be.aiff', '01.aiff', '02.aiff', '03.aiff'] as const;

interface Subject {
  readonly name: string;
  readonly bytes: Uint8Array;
}

interface Sample {
  readonly elapsedMs: number;
  readonly checksum: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

function parseBatch(subjects: readonly Subject[]): Sample {
  const started = performance.now();
  let checksum = 0;
  for (const subject of subjects) {
    const table = aiffPacketInfoFromBytes(subject.bytes.slice());
    checksum = (checksum + subject.name.length * 13 + table.tracks.length * 131) >>> 0;
    for (const packet of table.packets) {
      checksum =
        (checksum +
          (packet.offset ?? 0) * 7 +
          packet.size * 31 +
          packet.ptsUs +
          (packet.durationUs ?? 0)) >>>
        0;
    }
  }
  return { elapsedMs: performance.now() - started, checksum };
}

async function main(): Promise<void> {
  const subjects = await Promise.all(
    SUBJECTS.map(
      async (name): Promise<Subject> => ({
        name,
        bytes: new Uint8Array(await readFile(`${CORPUS}${name}`)),
      }),
    ),
  );
  const timings: number[] = [];
  let checksum = 0;
  for (let index = 0; index < WARMUP + SAMPLES; index++) {
    const sample = parseBatch(subjects);
    checksum = (checksum + sample.checksum) >>> 0;
    if (index >= WARMUP) timings.push(sample.elapsedMs);
  }
  const before = process.memoryUsage().rss;
  const memorySample = parseBatch(subjects);
  const peakMemoryMb = Math.max(0, process.memoryUsage().rss - before) / (1024 * 1024);
  checksum = (checksum + memorySample.checksum) >>> 0;
  console.info(
    `Session 11 AIFF packet table — ${subjects.length} rotated files; ` +
      `median=${median(timings).toFixed(3)} ms; peakRSS+=${peakMemoryMb.toFixed(2)} MiB; ` +
      `checksum=${checksum}; samples=[${timings.map((ms) => ms.toFixed(3)).join(', ')}]`,
  );
}

await main();
