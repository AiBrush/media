import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import type { MediaInfo } from '../src/api/types.ts';
import type { ByteSource, TrackInfo } from '../src/contracts/driver.ts';
import { WebmDriver, WebmModule } from '../src/drivers/webm/webm-driver.ts';
import type { Source } from '../src/sources/source.ts';

const fixture = new URL(
  '../../media-test/fixtures/media/scenarios/probe/realworld_mdn_flower_webm/02.webm',
  import.meta.url,
).pathname;
const bytes = new Uint8Array(await readFile(fixture));
const simulatedRangeLatencyMs = 3;
const warmup = 3;
const samples = 21;

interface ProbeMeasurement {
  readonly elapsedMs: number;
  readonly reads: number;
  readonly transferredBytes: number;
  readonly tracks: readonly TrackInfo[];
}

interface PublicProbeMeasurement {
  readonly elapsedMs: number;
  readonly reads: readonly (readonly [number, number])[];
  readonly transferredBytes: number;
  readonly tracks: MediaInfo['tracks'];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function measure(capFirstReadAt4KiB: boolean): Promise<ProbeMeasurement> {
  let reads = 0;
  let transferredBytes = 0;
  const source: ByteSource = {
    size: bytes.byteLength,
    async range(start, requestedEnd): Promise<Uint8Array> {
      reads++;
      const end =
        capFirstReadAt4KiB && reads === 1 ? Math.min(requestedEnd, 4 * 1024) : requestedEnd;
      await new Promise<void>((resolve) => setTimeout(resolve, simulatedRangeLatencyMs));
      transferredBytes += end - start;
      return bytes.subarray(start, end);
    },
    stream(): ReadableStream<Uint8Array> {
      throw new Error('metadata-window benchmark must remain range-backed');
    },
  };
  const start = performance.now();
  const tracks = await WebmDriver.probe?.(source);
  const elapsedMs = performance.now() - start;
  if (tracks === undefined) throw new Error('WebM probe is unavailable');
  return { elapsedMs, reads, transferredBytes, tracks };
}

async function measurePublic(): Promise<PublicProbeMeasurement> {
  const reads: Array<readonly [number, number]> = [];
  let transferredBytes = 0;
  const source: Source = {
    __media: 'source',
    kind: 'url',
    mimeHint: 'video/webm',
    size: bytes.byteLength,
    async range(start, end): Promise<Uint8Array> {
      reads.push([start, end]);
      await new Promise<void>((resolve) => setTimeout(resolve, simulatedRangeLatencyMs));
      transferredBytes += end - start;
      return bytes.subarray(start, end);
    },
    stream(): ReadableStream<Uint8Array> {
      throw new Error('public metadata-window benchmark must remain range-backed');
    },
  };
  const engine = createMedia().use(WebmModule);
  const start = performance.now();
  const info = await engine.probe(source);
  return {
    elapsedMs: performance.now() - start,
    reads,
    transferredBytes,
    tracks: info.tracks,
  };
}

for (let index = 0; index < warmup; index++) {
  await measure(false);
  await measure(true);
  await measurePublic();
}

const current: ProbeMeasurement[] = [];
const former: ProbeMeasurement[] = [];
const publicCurrent: PublicProbeMeasurement[] = [];
for (let index = 0; index < samples; index++) {
  const currentFirst = index % 2 === 0;
  const first = await measure(!currentFirst);
  const second = await measure(currentFirst);
  current.push(currentFirst ? first : second);
  former.push(currentFirst ? second : first);
  publicCurrent.push(await measurePublic());
}

const expected = JSON.stringify(current[0]?.tracks);
if (
  expected === undefined ||
  current.some((measurement) => JSON.stringify(measurement.tracks) !== expected) ||
  former.some((measurement) => JSON.stringify(measurement.tracks) !== expected)
) {
  throw new Error('metadata-window benchmark changed exact track truth');
}
const expectedPublic = JSON.stringify(publicCurrent[0]?.tracks);
if (
  expectedPublic === undefined ||
  publicCurrent.some((measurement) => JSON.stringify(measurement.tracks) !== expectedPublic)
) {
  throw new Error('public metadata-window benchmark changed exact track truth');
}

console.log(
  JSON.stringify(
    {
      fixtureBytes: bytes.byteLength,
      simulatedRangeLatencyMs,
      warmup,
      samples,
      current8KiB: {
        medianMs: median(current.map((measurement) => measurement.elapsedMs)),
        reads: current[0]?.reads,
        transferredBytes: current[0]?.transferredBytes,
      },
      former4KiBThen64KiB: {
        medianMs: median(former.map((measurement) => measurement.elapsedMs)),
        reads: former[0]?.reads,
        transferredBytes: former[0]?.transferredBytes,
      },
      public8KiBWithSharedPrefix: {
        medianMs: median(publicCurrent.map((measurement) => measurement.elapsedMs)),
        reads: publicCurrent[0]?.reads,
        transferredBytes: publicCurrent[0]?.transferredBytes,
      },
    },
    undefined,
    2,
  ),
);
