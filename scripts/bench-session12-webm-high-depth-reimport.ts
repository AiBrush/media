#!/usr/bin/env bun
/**
 * Fresh multi-sample benchmark for exact high-depth VP9/AV1 WebM qualification and reimport.
 * The container scenario uses the pinned real 10-bit AV1 VFR corpus and checks every packet byte/time.
 *
 *   bun scripts/bench-session12-webm-high-depth-reimport.ts
 *   bun scripts/bench-session12-webm-high-depth-reimport.ts --check
 */

import { readFile } from 'node:fs/promises';
import type { TrackInfo } from '../src/contracts/driver.ts';
import { muxTracksFromMovie, readMovie } from '../src/drivers/mp4/mp4-driver.ts';
import { WebmMuxer } from '../src/drivers/webm/ebml-write.ts';
import {
  av1CodecPrivateFromCodecString,
  parseAv1CodecPrivate,
  parseAv1SequenceHeader,
  parseVp9CodecPrivate,
  parseVp9UncompressedHeader,
  qualifyWebmVideoCodec,
  vp9CodecPrivateFromCodecString,
} from '../src/drivers/webm/video-codec-qualification.ts';
import { demuxWebm } from '../src/drivers/webm/webm-driver.ts';

const ROOT = new URL('..', import.meta.url);
const BASELINE_PATH = new URL('fixtures/golden/bench/webm-high-depth-reimport.json', ROOT);
const SOURCE_PATH = new URL('fixtures/media/bear-av1-10bit.mp4', ROOT);
const WARMUP = 5;
const SAMPLES = 21;
const REGRESSION_TOLERANCE = 0.5;
const MEMORY_SLACK_BYTES = 8 * 1024 * 1024;
let checksum = 0;

interface Scenario {
  readonly name: string;
  readonly iterations: number;
  readonly memoryIterations: number;
  readonly operationsPerIteration: number;
  readonly run: () => number;
}

interface ScenarioResult {
  readonly name: string;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly operationsPerSec: number;
  readonly peakProcessHeapMb: number;
  readonly retainedProcessHeapMb: number;
}

interface Baseline {
  readonly generatedAt: string;
  readonly runtime: string;
  readonly warmup: number;
  readonly samples: number;
  readonly scenarios: readonly ScenarioResult[];
  readonly geomeanOperationsPerSec: number;
}

function randomAccess(bytes: Uint8Array): {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
} {
  return {
    size: bytes.byteLength,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

class MsbBitWriter {
  readonly #bits: number[] = [];

  write(value: number, width: number): void {
    for (let shift = width - 1; shift >= 0; shift--) this.#bits.push((value >> shift) & 1);
  }

  bytes(): Uint8Array {
    const output = new Uint8Array(Math.ceil(this.#bits.length / 8));
    for (let index = 0; index < this.#bits.length; index++) {
      const byteIndex = index >> 3;
      output[byteIndex] =
        (output[byteIndex] ?? 0) | ((this.#bits[index] ?? 0) << (7 - (index & 7)));
    }
    return output;
  }
}

/** VP9 §6.2 key header through frame size; entropy payload is immaterial to qualification. */
function vp9KeyHeader(bitDepth: 10 | 12): Uint8Array {
  const bits = new MsbBitWriter();
  bits.write(2, 2); // frame_marker
  bits.write(0, 1); // profile_low_bit
  bits.write(1, 1); // profile_high_bit => profile 2
  bits.write(0, 1); // show_existing_frame
  bits.write(0, 1); // frame_type => key
  bits.write(1, 1); // show_frame
  bits.write(0, 1); // error_resilient_mode
  bits.write(0x49, 8);
  bits.write(0x83, 8);
  bits.write(0x42, 8);
  bits.write(bitDepth === 12 ? 1 : 0, 1);
  bits.write(2, 3); // BT.709
  bits.write(0, 1); // studio range
  bits.write(319, 16);
  bits.write(239, 16);
  return bits.bytes();
}

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (left === undefined || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function hashBytes(seed: number, bytes: Uint8Array): number {
  let hash = seed;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16_777_619);
  return hash | 0;
}

function hashText(seed: number, value: string): number {
  let hash = seed;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  return hash | 0;
}

const sourceBytes = new Uint8Array(await readFile(SOURCE_PATH));
const movie = await readMovie(randomAccess(sourceBytes));
const muxTracks = await muxTracksFromMovie(randomAccess(sourceBytes), movie);
const sourceTrack = muxTracks.find((track) => track.sampleEntryType === 'av01');
const parsedTrack = movie.tracks.find((track) => track.sampleEntryType === 'av01');
if (
  sourceTrack === undefined ||
  parsedTrack === undefined ||
  parsedTrack.codecPrivate === undefined
) {
  throw new Error('real 10-bit AV1 benchmark fixture has no qualified AV1 track');
}
const benchmarkSourceTrack = sourceTrack;
const realAv1C = parsedTrack.codecPrivate.data;
const realConfigObus = realAv1C.subarray(4);
const trackInfo: TrackInfo = {
  id: 0,
  mediaType: 'video',
  codec: parsedTrack.codec,
  durationSec: parsedTrack.durationSec,
  ...(parsedTrack.fps !== undefined ? { fps: parsedTrack.fps } : {}),
  config: parsedTrack.config,
};
const muxer = new WebmMuxer();
const muxTrackId = muxer.addTrack(trackInfo);
const expectedTimestamps: number[] = [];
let dtsTicks = 0;
for (const sample of benchmarkSourceTrack.samples) {
  const timestampUs = Math.round(
    ((dtsTicks + sample.cttsTicks) * 1_000_000) / benchmarkSourceTrack.timescale,
  );
  expectedTimestamps.push(Math.round(timestampUs / 1000) * 1000);
  muxer.addChunkStruct(muxTrackId, {
    timestampUs,
    durationUs: Math.round((sample.durationTicks * 1_000_000) / benchmarkSourceTrack.timescale),
    dtsUs: Math.round((dtsTicks * 1_000_000) / benchmarkSourceTrack.timescale),
    key: sample.keyframe,
    data: sample.data,
  });
  dtsTicks += sample.durationTicks;
}
await muxer.finalize();
const realWebm = await collect(muxer.output);

const vp9Private10 = vp9CodecPrivateFromCodecString('vp09.02.31.10');
const vp9Private12 = vp9CodecPrivateFromCodecString('vp09.02.52.12');
const vp9Header10 = vp9KeyHeader(10);
const vp9Header12 = vp9KeyHeader(12);
const av1Private12 = av1CodecPrivateFromCodecString('av01.2.08H.12');

function runVp9Matrix(): number {
  const private10 = parseVp9CodecPrivate(vp9Private10);
  const private12 = parseVp9CodecPrivate(vp9Private12);
  const header10 = parseVp9UncompressedHeader(vp9Header10);
  const header12 = parseVp9UncompressedHeader(vp9Header12);
  const qualified = qualifyWebmVideoCodec({
    codec: 'vp9',
    firstKeyframe: vp9Header10,
    width: 320,
    height: 240,
    fps: 25,
    sourceSizeBytes: 100_000,
    durationSec: 1,
  });
  const conservative = qualifyWebmVideoCodec({ codec: 'vp9', firstKeyframe: vp9Header12 });
  if (
    private10.codec !== 'vp09.02.31.10' ||
    private12.codec !== 'vp09.02.52.12' ||
    header10.bitDepth !== 10 ||
    header12.bitDepth !== 12 ||
    qualified.codec !== 'vp09.02.20.10' ||
    conservative.codec !== 'vp09.02.62.12'
  ) {
    throw new Error('VP9 qualification oracle failed');
  }
  return hashText(hashText(2_166_136_261, qualified.codec), conservative.codec);
}

function runAv1Matrix(): number {
  const private10 = parseAv1CodecPrivate(realAv1C);
  const private12 = parseAv1CodecPrivate(av1Private12);
  const bitstream10 = parseAv1SequenceHeader(realConfigObus);
  const qualified = qualifyWebmVideoCodec({ codec: 'av1', codecPrivate: realAv1C });
  if (
    private10.codec !== 'av01.0.00M.10' ||
    private12.codec !== 'av01.2.08H.12' ||
    bitstream10.codec !== 'av01.0.00M.10' ||
    qualified.codec !== 'av01.0.00M.10' ||
    !bytesEqual(qualified.description, realAv1C)
  ) {
    throw new Error('AV1 qualification oracle failed');
  }
  return hashText(hashText(2_166_136_261, private12.codec), bitstream10.codec);
}

function runRealReimport(): number {
  const demux = demuxWebm(realWebm);
  const track = demux.info.tracks[0];
  const frames = demux.framesByIndex[0];
  if (
    track?.decoderCodec !== 'av01.0.00M.10' ||
    !bytesEqual(track.description, realAv1C) ||
    frames === undefined ||
    frames.length !== benchmarkSourceTrack.samples.length
  ) {
    throw new Error('real AV1 WebM metadata/count oracle failed');
  }
  let hash = 2_166_136_261;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const sample = benchmarkSourceTrack.samples[index];
    const expectedTimestamp = expectedTimestamps[index];
    if (
      frame === undefined ||
      sample === undefined ||
      expectedTimestamp === undefined ||
      frame.timestampUs !== expectedTimestamp ||
      !bytesEqual(frame.data, sample.data)
    ) {
      throw new Error(`real AV1 WebM packet oracle failed at ${index}`);
    }
    hash = hashBytes(Math.imul(hash ^ frame.timestampUs, 16_777_619), frame.data);
  }
  return hash;
}

const scenarios: readonly Scenario[] = [
  {
    name: 'VP9 high-depth qualification',
    iterations: 10_000,
    memoryIterations: 50_000,
    operationsPerIteration: 6,
    run: runVp9Matrix,
  },
  {
    name: 'AV1 high-depth qualification',
    iterations: 10_000,
    memoryIterations: 50_000,
    operationsPerIteration: 4,
    run: runAv1Matrix,
  },
  {
    name: 'real 10-bit AV1 WebM reimport',
    iterations: 100,
    memoryIterations: 1_000,
    operationsPerIteration: 1,
    run: runRealReimport,
  },
];

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1);
  return ordered[Math.max(0, index)] ?? 0;
}

function runBatch(scenario: Scenario, iterations: number): void {
  for (let index = 0; index < iterations; index++) checksum = (checksum + scenario.run()) | 0;
}

function memorySample(scenario: Scenario): {
  readonly peakBytes: number;
  readonly retainedBytes: number;
} {
  runBatch(scenario, Math.min(100, scenario.memoryIterations));
  Bun.gc(true);
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  for (let index = 0; index < scenario.memoryIterations; index++) {
    checksum = (checksum + scenario.run()) | 0;
    if ((index & 31) === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
  }
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  Bun.gc(true);
  const retained = process.memoryUsage().heapUsed - before;
  if (peak <= 0) throw new Error(`${scenario.name}: process heap sample was not positive`);
  if (retained > MEMORY_SLACK_BYTES) {
    throw new Error(`${scenario.name}: retained heap grew by ${retained} bytes`);
  }
  return { peakBytes: peak, retainedBytes: retained };
}

function measure(scenario: Scenario): ScenarioResult {
  for (let sample = 0; sample < WARMUP; sample++) runBatch(scenario, scenario.iterations);
  const elapsed: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const started = Bun.nanoseconds();
    runBatch(scenario, scenario.iterations);
    elapsed.push((Bun.nanoseconds() - started) / 1_000_000);
  }
  const medianMs = percentile(elapsed, 0.5);
  const memory = memorySample(scenario);
  return {
    name: scenario.name,
    medianMs,
    p95Ms: percentile(elapsed, 0.95),
    operationsPerSec: (scenario.operationsPerIteration * scenario.iterations) / (medianMs / 1_000),
    peakProcessHeapMb: memory.peakBytes / (1024 * 1024),
    retainedProcessHeapMb: memory.retainedBytes / (1024 * 1024),
  };
}

function geomean(results: readonly ScenarioResult[]): number {
  return Math.exp(
    results.reduce((sum, result) => sum + Math.log(result.operationsPerSec), 0) / results.length,
  );
}

function regressions(results: readonly ScenarioResult[], prior: Baseline): string[] {
  const priorByName = new Map(prior.scenarios.map((result) => [result.name, result]));
  const failures: string[] = [];
  for (const result of results) {
    const before = priorByName.get(result.name);
    if (before === undefined) {
      failures.push(`${result.name}: missing baseline row`);
      continue;
    }
    if (result.operationsPerSec < before.operationsPerSec * (1 - REGRESSION_TOLERANCE)) {
      failures.push(
        `${result.name}: ${result.operationsPerSec.toFixed(0)} ops/s vs ${before.operationsPerSec.toFixed(0)} baseline`,
      );
    }
    const freshPeak = result.peakProcessHeapMb * 1024 * 1024;
    const priorPeak = before.peakProcessHeapMb * 1024 * 1024;
    if (freshPeak > priorPeak * 3 + MEMORY_SLACK_BYTES) {
      failures.push(
        `${result.name}: ${result.peakProcessHeapMb.toFixed(2)} MB heap vs ${before.peakProcessHeapMb.toFixed(2)} MB baseline`,
      );
    }
    if (result.retainedProcessHeapMb * 1024 * 1024 > MEMORY_SLACK_BYTES) {
      failures.push(
        `${result.name}: retained ${result.retainedProcessHeapMb.toFixed(2)} MB after forced GC`,
      );
    }
  }
  return failures;
}

const results = scenarios.map(measure);
for (const result of results) {
  console.info(
    `${result.name.padEnd(34)} ${result.medianMs.toFixed(3).padStart(9)} ms  ` +
      `${result.operationsPerSec.toFixed(0).padStart(10)} ops/s  p95 ${result.p95Ms.toFixed(3)} ms  ` +
      `heap ${result.peakProcessHeapMb.toFixed(2)} MB  retained ${result.retainedProcessHeapMb.toFixed(2)} MB`,
  );
}

const fresh: Baseline = {
  generatedAt: new Date().toISOString(),
  runtime: `bun ${Bun.version}`,
  warmup: WARMUP,
  samples: SAMPLES,
  scenarios: results,
  geomeanOperationsPerSec: geomean(results),
};
console.info(
  `aggregate ${fresh.geomeanOperationsPerSec.toFixed(0)} ops/s geomean; checksum ${checksum}`,
);

if (process.argv.includes('--check')) {
  const prior = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
  const failures = regressions(results, prior);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`REGRESSION: ${failure}`);
    process.exit(1);
  }
  console.info(`no regression vs ${prior.generatedAt}`);
} else {
  console.info(`BASELINE_JSON=${JSON.stringify(fresh)}`);
}
