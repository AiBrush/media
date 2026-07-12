#!/usr/bin/env bun
/** Strict real-corpus benchmark for ADR-274's single-rewrite MP4 metadata route. */

import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import { muxTracksFromMovie, readMovie } from '../src/drivers/mp4/mp4-driver.ts';
import type { MuxTrackInput } from '../src/drivers/mp4/write.ts';
import { readMp4Tags } from '../src/metadata/mp4-tags.ts';

const WARMUP = 3;
const SAMPLES = 21;
const MEMORY_RUNS = 5;
const FILES = [
  'obs-remux-variable-aac.mp4',
  'bear-4k-hevc.mp4',
  'bear-1280x720.mp4',
  'bear-hevc-10bit-hdr10.mp4',
  'bear-flac.mp4',
  'test.mp4',
  '2x2-green.mp4',
] as const;
const SUBJECTS = [
  ...FILES.map((name) => ({
    name,
    url: new URL(`../fixtures/media/${name}`, import.meta.url),
  })),
  {
    name: 'public-metadata-write-01.mp4',
    url: new URL(
      '../../media-test/fixtures/media/scenarios/metadata/write_mp4_tags/01.mp4',
      import.meta.url,
    ),
  },
  ...(['02.mp4', '03.mp4'] as const).map((name) => ({
    name: `public-metadata-write-${name}`,
    url: new URL(
      `../../media-test/fixtures/media/scenarios/metadata/write_mp4_tags/${name}`,
      import.meta.url,
    ),
  })),
] as const;
const TAGS = {
  title: 'Session 13 direct metadata',
  artist: 'aibrush-media',
  album: 'Exact packet truth',
  comment: 'single relocation without sample projection',
  date: '2026-07-12',
  genre: 'Benchmark',
  trackNumber: '13',
};

interface RandomAccess {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

interface RouteResult {
  readonly elapsedMs: number;
  readonly output: Blob;
}

type Route = 'blob-direct' | 'byte-direct' | 'full-remux-control';

interface Fixture {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly blob: Blob;
}

function ra(bytes: Uint8Array): RandomAccess {
  return {
    size: bytes.byteLength,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function mad(values: readonly number[], center: number): number {
  return median(values.map((value) => Math.abs(value - center)));
}

function trackStructure(track: MuxTrackInput): Omit<MuxTrackInput, 'samples'> & {
  readonly samples: readonly Omit<MuxTrackInput['samples'][number], 'data'>[];
} {
  const { samples, ...metadata } = track;
  return {
    ...metadata,
    samples: samples.map(({ data: _data, ...sample }) => sample),
  };
}

function assertExactBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(`${label}: ${actual.byteLength} bytes != ${expected.byteLength}`);
  }
  for (let index = 0; index < actual.byteLength; index++) {
    if (actual[index] !== expected[index])
      throw new Error(`${label}: first difference at ${index}`);
  }
}

async function assertExactMovieTruth(
  source: Uint8Array,
  output: Uint8Array,
  label: string,
  preserveContainerIdentity: boolean,
): Promise<void> {
  for (const [key, value] of Object.entries(TAGS)) {
    if (readMp4Tags(output)[key] !== value)
      throw new Error(`${label}: tag '${key}' did not re-import`);
  }
  const sourceMovie = await readMovie(ra(source));
  const outputMovie = await readMovie(ra(output));
  if (
    preserveContainerIdentity &&
    (sourceMovie.brand !== outputMovie.brand ||
      sourceMovie.timescale !== outputMovie.timescale ||
      sourceMovie.durationSec !== outputMovie.durationSec ||
      JSON.stringify(sourceMovie.otherTracks) !== JSON.stringify(outputMovie.otherTracks))
  ) {
    throw new Error(`${label}: movie clock/brand/non-media truth changed`);
  }
  const sourceTracks = await muxTracksFromMovie(ra(source), sourceMovie);
  const outputTracks = await muxTracksFromMovie(ra(output), outputMovie);
  if (
    JSON.stringify(outputTracks.map(trackStructure)) !==
    JSON.stringify(sourceTracks.map(trackStructure))
  ) {
    throw new Error(`${label}: track config/timing structure changed`);
  }
  for (let trackIndex = 0; trackIndex < sourceTracks.length; trackIndex++) {
    const sourceTrack = sourceTracks[trackIndex];
    const outputTrack = outputTracks[trackIndex];
    if (sourceTrack === undefined || outputTrack === undefined) {
      throw new Error(`${label}: track ${trackIndex} is missing`);
    }
    for (let sampleIndex = 0; sampleIndex < sourceTrack.samples.length; sampleIndex++) {
      const sourceSample = sourceTrack.samples[sampleIndex];
      const outputSample = outputTrack.samples[sampleIndex];
      if (sourceSample === undefined || outputSample === undefined) {
        throw new Error(`${label}: sample ${trackIndex}:${sampleIndex} is missing`);
      }
      assertExactBytes(
        outputSample.data,
        sourceSample.data,
        `${label} sample ${trackIndex}:${sampleIndex}`,
      );
    }
  }
}

const fixtures = await Promise.all(
  SUBJECTS.map(async (subject): Promise<Fixture> => {
    const bytes = new Uint8Array(await readFile(subject.url));
    return { name: subject.name, bytes, blob: new Blob([bytes], { type: 'video/mp4' }) };
  }),
);
const media = createMedia({ worker: false });
let checksum = 0;

async function runRoute(fixture: Fixture, route: Route): Promise<RouteResult> {
  const start = Bun.nanoseconds();
  const output = await media.remux(route === 'blob-direct' ? fixture.blob : fixture.bytes, {
    to: 'mp4',
    tags: TAGS,
    ...(route === 'full-remux-control' ? { faststart: true } : {}),
  });
  const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
  if (!(output instanceof Blob)) throw new Error('MP4 metadata benchmark expected Blob output');
  checksum = (checksum + output.size) | 0;
  return { elapsedMs, output };
}

// The strict oracle runs outside the timed loop for every real source and both routes.
for (const fixture of fixtures) {
  let byteDirect: Uint8Array | undefined;
  for (const route of ['byte-direct', 'blob-direct', 'full-remux-control'] as const) {
    const result = await runRoute(fixture, route);
    const output = new Uint8Array(await result.output.arrayBuffer());
    await assertExactMovieTruth(
      fixture.bytes,
      output,
      `${fixture.name} ${route}`,
      route !== 'full-remux-control',
    );
    if (route === 'byte-direct') byteDirect = output;
    if (route === 'blob-direct') {
      if (byteDirect === undefined)
        throw new Error(`${fixture.name}: byte direct truth is missing`);
      assertExactBytes(output, byteDirect, `${fixture.name}: blob-direct versus byte-direct`);
    }
  }
}

async function runCorpus(route: Route): Promise<number> {
  const start = Bun.nanoseconds();
  for (const fixture of fixtures) await runRoute(fixture, route);
  return (Bun.nanoseconds() - start) / 1_000_000;
}

async function measureWall(route: Route): Promise<readonly number[]> {
  for (let index = 0; index < WARMUP; index++) await runCorpus(route);
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index++) samples.push(await runCorpus(route));
  return samples;
}

async function measurePeakRss(route: Route): Promise<number> {
  Bun.gc(true);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  let retained: Blob | undefined;
  for (let run = 0; run < MEMORY_RUNS; run++) {
    for (const fixture of fixtures) {
      retained = (await runRoute(fixture, route)).output;
      peak = Math.max(peak, process.memoryUsage().rss);
    }
  }
  checksum = (checksum + (retained?.size ?? 0)) | 0;
  return Math.max(0, peak - baseline);
}

const blobSamples = await measureWall('blob-direct');
const directSamples = await measureWall('byte-direct');
const controlSamples = await measureWall('full-remux-control');
const blobMedian = median(blobSamples);
const directMedian = median(directSamples);
const controlMedian = median(controlSamples);
const blobPeakRss = await measurePeakRss('blob-direct');
const directPeakRss = await measurePeakRss('byte-direct');
const controlPeakRss = await measurePeakRss('full-remux-control');
console.info(
  `metadata/write_mp4_tags blob-direct: files=${fixtures.length} warmup=${WARMUP} n=${SAMPLES} ` +
    `medianMs=${blobMedian.toFixed(3)} madMs=${mad(blobSamples, blobMedian).toFixed(3)} ` +
    `peakRssMiB=${(blobPeakRss / 1024 / 1024).toFixed(2)}`,
);
console.info(
  `metadata/write_mp4_tags byte-direct: files=${fixtures.length} warmup=${WARMUP} n=${SAMPLES} ` +
    `medianMs=${directMedian.toFixed(3)} madMs=${mad(directSamples, directMedian).toFixed(3)} ` +
    `peakRssMiB=${(directPeakRss / 1024 / 1024).toFixed(2)}`,
);
console.info(
  `metadata/write_mp4_tags full-remux-control: files=${fixtures.length} warmup=${WARMUP} n=${SAMPLES} ` +
    `medianMs=${controlMedian.toFixed(3)} madMs=${mad(controlSamples, controlMedian).toFixed(3)} ` +
    `peakRssMiB=${(controlPeakRss / 1024 / 1024).toFixed(2)} speedup=${(
      controlMedian / blobMedian
    ).toFixed(3)}x`,
);
console.info(`checksum=${checksum}`);
