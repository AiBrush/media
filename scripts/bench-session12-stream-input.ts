#!/usr/bin/env bun
/** Session 12 direct ReadableStream input benchmark (ADR-231). */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createMedia } from '../src/api/create-media.ts';
import type { MediaInfo } from '../src/api/types.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 2;
const SAMPLES = 7;
const CHUNK_BYTES = 1021;
const FIXTURE_NAMES = [
  'h264.mp4',
  'bear-vp9-alpha.webm',
  'sfx-pcm-s24.wav',
  'sfx.flac',
  'sound_5.mp3',
] as const;

interface Fixture {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly truth: MediaInfo;
}

interface CorpusResult {
  readonly inputBytes: number;
  readonly inputPulls: number;
  readonly metadataSha256: string;
}

interface SampleResult extends CorpusResult {
  readonly elapsedMs: number;
  readonly rssDeltaBytes: number;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('cannot take median of empty samples');
  return value;
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixtureUrl(name: string): URL {
  return new URL(`../fixtures/media/${name}`, import.meta.url);
}

function directStream(bytes: Uint8Array, onPull: () => void): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller): void {
        onPull();
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + CHUNK_BYTES, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    },
    { highWaterMark: 0 },
  );
}

async function loadFixtures(): Promise<readonly Fixture[]> {
  const media = createMedia({ worker: false });
  const fixtures: Fixture[] = [];
  for (const name of FIXTURE_NAMES) {
    const bytes = new Uint8Array(await readFile(fileURLToPath(fixtureUrl(name))));
    fixtures.push({
      name,
      bytes,
      sha256: digest(bytes),
      truth: await media.probe(fromBytes(bytes)),
    });
  }
  return fixtures;
}

async function probeCorpus(
  media: ReturnType<typeof createMedia>,
  fixtures: readonly Fixture[],
  mode: 'bytes' | 'stream',
): Promise<CorpusResult> {
  let inputBytes = 0;
  let inputPulls = 0;
  const metadata = createHash('sha256');
  for (const fixture of fixtures) {
    const input =
      mode === 'bytes'
        ? fromBytes(fixture.bytes)
        : media.from(
            directStream(fixture.bytes, () => {
              inputPulls++;
            }),
            { size: fixture.bytes.byteLength },
          );
    const actual = await media.probe(input);
    const actualJson = JSON.stringify(actual);
    const truthJson = JSON.stringify(fixture.truth);
    if (actualJson !== truthJson) {
      throw new Error(`${fixture.name}: stream metadata diverged from replayable-byte truth`);
    }
    inputBytes += fixture.bytes.byteLength;
    metadata.update(actualJson);
  }
  return { inputBytes, inputPulls, metadataSha256: metadata.digest('hex') };
}

async function sample(
  media: ReturnType<typeof createMedia>,
  fixtures: readonly Fixture[],
  mode: 'bytes' | 'stream',
): Promise<SampleResult> {
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const result = await probeCorpus(media, fixtures, mode);
  return {
    ...result,
    elapsedMs: performance.now() - started,
    rssDeltaBytes: process.memoryUsage().rss - rssBefore,
  };
}

const fixtures = await loadFixtures();
const media = createMedia({ worker: false });
for (let index = 0; index < WARMUP; index++) {
  await probeCorpus(media, fixtures, 'bytes');
  await probeCorpus(media, fixtures, 'stream');
}

const bytesSamples: SampleResult[] = [];
const streamSamples: SampleResult[] = [];
for (let index = 0; index < SAMPLES; index++) {
  bytesSamples.push(await sample(media, fixtures, 'bytes'));
  streamSamples.push(await sample(media, fixtures, 'stream'));
}

const expectedBytes = fixtures.reduce((total, fixture) => total + fixture.bytes.byteLength, 0);
const expectedPulls = fixtures.reduce(
  (total, fixture) => total + Math.ceil(fixture.bytes.byteLength / CHUNK_BYTES) + 1,
  0,
);
for (const result of [...bytesSamples, ...streamSamples]) {
  if (result.inputBytes !== expectedBytes)
    throw new Error('benchmark did not process the full corpus');
}
for (const result of streamSamples) {
  if (result.inputPulls !== expectedPulls) {
    throw new Error(
      `stream input was pulled ${result.inputPulls} times; expected ${expectedPulls}`,
    );
  }
}
const metadataDigests = new Set(
  [...bytesSamples, ...streamSamples].map((result) => result.metadataSha256),
);
if (metadataDigests.size !== 1) throw new Error('metadata output was not deterministic');

console.log(
  JSON.stringify(
    {
      corpus: fixtures.map(({ name, bytes, sha256 }) => ({
        name,
        bytes: bytes.byteLength,
        sha256,
      })),
      warmup: WARMUP,
      samples: SAMPLES,
      chunkBytes: CHUNK_BYTES,
      totalInputBytes: expectedBytes,
      expectedPulls,
      metadataSha256: [...metadataDigests][0],
      bytes: {
        samplesMs: bytesSamples.map((result) => result.elapsedMs),
        medianMs: median(bytesSamples.map((result) => result.elapsedMs)),
        rssDeltaBytes: bytesSamples.map((result) => result.rssDeltaBytes),
      },
      stream: {
        samplesMs: streamSamples.map((result) => result.elapsedMs),
        medianMs: median(streamSamples.map((result) => result.elapsedMs)),
        rssDeltaBytes: streamSamples.map((result) => result.rssDeltaBytes),
        pulls: streamSamples.map((result) => result.inputPulls),
      },
    },
    null,
    2,
  ),
);
