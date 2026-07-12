import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import type { MediaInfo } from '../src/api/types.ts';
import type { Source } from '../src/sources/source.ts';

const warmup = 3;
const samples = 21;
const latencyMs = 1;
const media = createMedia({ worker: false });
const subjects = [
  [
    'vp9-alpha-no-default-duration',
    '../../media-test/fixtures/media/scenarios/probe/vp9_alpha/01.webm',
  ],
  ['recorder-headerless', '../fixtures/media/recorder_headerless.webm'],
  ['vp9-opus-declared-timeline', '../fixtures/media/movie_5.webm'],
  ['vp9-alpha-declared-timeline', '../fixtures/media/bear-vp9-alpha.webm'],
  ['av1-opus-declared-timeline', '../../media-test/fixtures/media/av1_720p_5s.webm'],
] as const;

interface Measurement {
  readonly elapsedMs: number;
  readonly reads: readonly (readonly [number, number])[];
  readonly bytesRead: number;
  readonly info: MediaInfo;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('empty benchmark sample');
  return value;
}

async function measure(
  bytes: Uint8Array,
  redundantIntermediateRead: boolean,
): Promise<Measurement> {
  const reads: Array<readonly [number, number]> = [];
  let bytesRead = 0;
  const source: Source = {
    __media: 'source',
    kind: 'url',
    mimeHint: 'video/webm',
    size: bytes.byteLength,
    async range(start, end): Promise<Uint8Array> {
      reads.push([start, end]);
      bytesRead += end - start;
      await new Promise<void>((resolve) => setTimeout(resolve, latencyMs));
      return bytes.subarray(start, end);
    },
    stream(): ReadableStream<Uint8Array> {
      throw new Error('terminal-timeline benchmark must remain range-backed');
    },
  };
  const started = performance.now();
  if (redundantIntermediateRead) {
    await source.range?.(8 * 1024, Math.min(64 * 1024, bytes.byteLength));
  }
  const info = await media.probe(source);
  return { elapsedMs: performance.now() - started, reads, bytesRead, info };
}

const rows = [];
for (const [id, path] of subjects) {
  const bytes = new Uint8Array(await readFile(new URL(path, import.meta.url)));
  for (let index = 0; index < warmup; index++) {
    await measure(bytes, false);
    await measure(bytes, true);
  }
  const current: Measurement[] = [];
  const redundantIntermediateControl: Measurement[] = [];
  for (let index = 0; index < samples; index++) {
    const currentFirst = index % 2 === 0;
    const first = await measure(bytes, !currentFirst);
    const second = await measure(bytes, currentFirst);
    current.push(currentFirst ? first : second);
    redundantIntermediateControl.push(currentFirst ? second : first);
  }
  const truth = JSON.stringify(current[0]?.info);
  if (
    truth === undefined ||
    [...current, ...redundantIntermediateControl].some(
      (measurement) => JSON.stringify(measurement.info) !== truth,
    )
  ) {
    throw new Error(`${id}: transport control changed exact MediaInfo truth`);
  }
  rows.push({
    id,
    sourceBytes: bytes.byteLength,
    current: {
      medianMs: median(current.map((measurement) => measurement.elapsedMs)),
      reads: current[0]?.reads,
      bytesRead: current[0]?.bytesRead,
    },
    redundantIntermediateControl: {
      medianMs: median(redundantIntermediateControl.map((measurement) => measurement.elapsedMs)),
      reads: redundantIntermediateControl[0]?.reads,
      bytesRead: redundantIntermediateControl[0]?.bytesRead,
    },
  });
}

console.log(
  JSON.stringify(
    { benchmark: 'session13-webm-terminal-timeline', warmup, samples, latencyMs, rows },
    undefined,
    2,
  ),
);
