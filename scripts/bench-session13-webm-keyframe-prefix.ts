import { readFile } from 'node:fs/promises';
import type { ByteSource, TrackInfo } from '../src/contracts/driver.ts';
import { WebmDriver } from '../src/drivers/webm/webm-driver.ts';

const warmup = 3;
const samples = 21;
const simulatedRangeLatencyMs = 1;
const firstWindowBytes = 8 * 1024;
const beforeFirstClusterPayloadBytes = 430;

const subjects = [
  {
    id: 'public-vp9-alpha-large-keyframe',
    path: new URL(
      '../../media-test/fixtures/media/scenarios/probe/vp9_alpha/vp9_alpha.webm',
      import.meta.url,
    ),
  },
  {
    id: 'public-av1',
    path: new URL('../../media-test/fixtures/media/av1_720p_5s.webm', import.meta.url),
  },
  {
    id: 'corpus-vp9-alpha',
    path: new URL('../fixtures/media/bear-vp9-alpha.webm', import.meta.url),
  },
  { id: 'corpus-vp9-opus', path: new URL('../fixtures/media/movie_5.webm', import.meta.url) },
  {
    id: 'public-vp8-vorbis',
    path: new URL(
      '../../media-test/fixtures/media/scenarios/demux/realworld_mdn_flower_webm/02.webm',
      import.meta.url,
    ),
  },
] as const;

interface Measurement {
  readonly elapsedMs: number;
  readonly reads: readonly (readonly [number, number])[];
  readonly transferredBytes: number;
  readonly tracks: readonly TrackInfo[];
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('benchmark requires at least one sample');
  return value;
}

async function probe(source: ByteSource): Promise<readonly TrackInfo[]> {
  const run = WebmDriver.probe;
  if (run === undefined) throw new Error('WebM metadata probe is unavailable');
  return run(source);
}

async function fullTruth(bytes: Uint8Array): Promise<readonly TrackInfo[]> {
  return probe({
    size: bytes.byteLength,
    stream: () => new Blob([Uint8Array.from(bytes).buffer]).stream(),
  });
}

async function measure(
  bytes: Uint8Array,
  sequenceHeaderAvailableInFirstWindow: boolean,
): Promise<Measurement> {
  const reads: Array<readonly [number, number]> = [];
  let transferredBytes = 0;
  const source: ByteSource = {
    size: bytes.byteLength,
    async range(start, requestedEnd): Promise<Uint8Array> {
      const end =
        !sequenceHeaderAvailableInFirstWindow && reads.length === 0
          ? Math.min(requestedEnd, beforeFirstClusterPayloadBytes)
          : requestedEnd;
      reads.push([start, end]);
      transferredBytes += end - start;
      await new Promise<void>((resolve) => setTimeout(resolve, simulatedRangeLatencyMs));
      return bytes.subarray(start, end);
    },
    stream(): ReadableStream<Uint8Array> {
      throw new Error('keyframe-prefix benchmark must remain range-backed');
    },
  };
  const started = performance.now();
  const tracks = await probe(source);
  return {
    elapsedMs: performance.now() - started,
    reads,
    transferredBytes,
    tracks,
  };
}

const rows = [];
for (const subject of subjects) {
  const bytes = new Uint8Array(await readFile(subject.path));
  const expected = JSON.stringify(await fullTruth(bytes));
  for (let index = 0; index < warmup; index++) {
    await measure(bytes, true);
    await measure(bytes, false);
  }
  const current: Measurement[] = [];
  const sequenceUnavailableControl: Measurement[] = [];
  for (let index = 0; index < samples; index++) {
    const currentFirst = index % 2 === 0;
    const first = await measure(bytes, currentFirst);
    const second = await measure(bytes, !currentFirst);
    current.push(currentFirst ? first : second);
    sequenceUnavailableControl.push(currentFirst ? second : first);
  }
  for (const measurement of [...current, ...sequenceUnavailableControl]) {
    if (JSON.stringify(measurement.tracks) !== expected) {
      throw new Error(`${subject.id}: a benchmark control changed exact TrackInfo truth`);
    }
  }
  rows.push({
    id: subject.id,
    bytes: bytes.byteLength,
    current: {
      medianMs: median(current.map((measurement) => measurement.elapsedMs)),
      reads: current[0]?.reads,
      transferredBytes: current[0]?.transferredBytes,
    },
    sequenceUnavailableControl: {
      medianMs: median(sequenceUnavailableControl.map((measurement) => measurement.elapsedMs)),
      reads: sequenceUnavailableControl[0]?.reads,
      transferredBytes: sequenceUnavailableControl[0]?.transferredBytes,
    },
  });
}

console.log(
  JSON.stringify(
    {
      benchmark: 'session13-webm-keyframe-prefix',
      warmup,
      samples,
      simulatedRangeLatencyMs,
      firstWindowBytes,
      rows,
    },
    undefined,
    2,
  ),
);
