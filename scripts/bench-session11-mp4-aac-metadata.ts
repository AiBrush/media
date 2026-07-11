#!/usr/bin/env bun
/**
 * Session 11 MP4 AAC metadata benchmark. Probes every rotated tiny/massive fixture through fresh,
 * range-backed Source identities so the measurement covers ASC parsing without reading multi-hour
 * media payloads or benefiting from the engine's repeated-probe prefix cache.
 */

import { open } from 'node:fs/promises';
import { Mp4Driver } from '../src/drivers/mp4/mp4-driver.ts';
import type { Source } from '../src/sources/source.ts';

const WARMUP = 2;
const SAMPLES = 9;
const CORPUS = new URL('../../media-test/fixtures/media/scenarios/performance/', import.meta.url)
  .pathname;
const SUBJECTS = [
  'size-ladder-extract-metadata-massive/massive_h264_1080p_2h.mp4',
  'size-ladder-extract-metadata-massive/01.mp4',
  'size-ladder-extract-metadata-massive/02.mp4',
  'size-ladder-extract-metadata-massive/03.mp4',
  'size-ladder-extract-metadata-tiny/tiny_h264_360p_2s.mp4',
  'size-ladder-extract-metadata-tiny/01.mp4',
  'size-ladder-extract-metadata-tiny/02.mp4',
  'size-ladder-extract-metadata-tiny/03.mp4',
] as const;

interface Subject {
  readonly name: string;
  readonly size: number;
  readonly handle: Awaited<ReturnType<typeof open>>;
}

interface Sample {
  readonly elapsedMs: number;
  readonly checksum: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

function sourceFor(subject: Subject): Source {
  return {
    __media: 'source',
    kind: 'url',
    mimeHint: 'video/mp4',
    size: subject.size,
    range: async (start, end) => {
      const bytes = new Uint8Array(Math.max(0, end - start));
      const { bytesRead } = await subject.handle.read(bytes, 0, bytes.byteLength, start);
      return bytesRead === bytes.byteLength ? bytes : bytes.subarray(0, bytesRead);
    },
    stream(): ReadableStream<Uint8Array> {
      throw new Error('MP4 AAC metadata benchmark must stay range-backed');
    },
  };
}

async function runSample(subjects: readonly Subject[]): Promise<Sample> {
  const probe = Mp4Driver.probe;
  if (probe === undefined) throw new Error('MP4 probe capability is missing');
  const started = performance.now();
  let checksum = 0;
  for (const subject of subjects) {
    const tracks = await probe(sourceFor(subject));
    const audio = tracks.find((track) => track.mediaType === 'audio' && track.nonMedia !== true);
    if (audio === undefined) throw new Error(`${subject.name} has no audio track`);
    const config = audio.config;
    if (
      config === undefined ||
      !('sampleRate' in config) ||
      typeof config.sampleRate !== 'number' ||
      typeof config.numberOfChannels !== 'number'
    ) {
      throw new Error(`${subject.name} has no complete audio metadata`);
    }
    checksum =
      (checksum +
        subject.name.length * 13 +
        audio.codec.length * 17 +
        config.sampleRate * 19 +
        config.numberOfChannels * 23) >>>
      0;
  }
  return { elapsedMs: performance.now() - started, checksum };
}

async function main(): Promise<void> {
  const subjects: Subject[] = [];
  try {
    for (const name of SUBJECTS) {
      const handle = await open(`${CORPUS}${name}`, 'r');
      subjects.push({ name, handle, size: (await handle.stat()).size });
    }

    const timings: number[] = [];
    let checksum = 0;
    for (let index = 0; index < WARMUP + SAMPLES; index++) {
      const sample = await runSample(subjects);
      checksum = (checksum + sample.checksum) >>> 0;
      if (index >= WARMUP) timings.push(sample.elapsedMs);
    }
    const before = process.memoryUsage().rss;
    const memorySample = await runSample(subjects);
    checksum = (checksum + memorySample.checksum) >>> 0;
    const peakMemoryMb = Math.max(0, process.memoryUsage().rss - before) / (1024 * 1024);
    console.info(
      `Session 11 MP4 AAC metadata — ${subjects.length} rotated range-backed files; ` +
        `median=${median(timings).toFixed(3)} ms; peakRSS+=${peakMemoryMb.toFixed(2)} MiB; ` +
        `checksum=${checksum}; samples=[${timings.map((ms) => ms.toFixed(3)).join(', ')}]`,
    );
  } finally {
    await Promise.all(subjects.map(async (subject) => await subject.handle.close()));
  }
}

await main();
