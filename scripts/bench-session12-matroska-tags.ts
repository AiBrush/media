#!/usr/bin/env bun
/** Fresh real-media benchmark for offset-stable, idempotent Matroska tag replacement (ADR-244). */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { webmPacketPayloadInfoFromBytes } from '../src/drivers/webm/webm-driver.ts';
import { readMkvTags, writeMkvTags } from '../src/metadata/matroska-tags.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA_ROOT = `${ROOT}fixtures/media/`;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/matroska-tags.json`;
const WARMUP = 3;
const SAMPLES = 15;
const MEMORY_BATCHES = 24;
const REGRESSION_TOLERANCE = 0.5;
const RETAINED_MEMORY_BOUND_BYTES = 32 * 1024 * 1024;
const INPUT_IDS = [
  'movie_5.webm',
  'bear-opus.webm',
  '2x2-green.webm',
  'white.webm',
  'bear-vp9-alpha.webm',
] as const;
const GENERATION_A = {
  title: 'Matroska replacement generation A',
  comment: 'This generation must disappear completely.',
};
const GENERATION_B = {
  title: 'Matroska replacement generation B',
  artist: 'aibrush-media',
  comment: 'offset-stable idempotence '.repeat(24),
};

interface Input {
  readonly id: (typeof INPUT_IDS)[number];
  readonly bytes: Uint8Array;
  readonly packetFingerprint: string;
}

interface BatchResult {
  readonly elapsedMs: number;
  readonly inputBytes: number;
  readonly rewrittenBytes: number;
  readonly outputBytes: number;
  readonly digest: string;
  readonly outputs: readonly Uint8Array[];
}

interface MemoryResult {
  readonly peakProcessHeapBytes: number;
  readonly peakRssBytes: number;
  readonly peakProcessHeapDeltaBytes: number;
  readonly peakRssDeltaBytes: number;
  readonly retainedProcessHeapBytes: number;
  readonly retainedRssBytes: number;
}

interface BenchmarkResult extends MemoryResult {
  readonly generatedAt: string;
  readonly runtime: string;
  readonly fixtures: number;
  readonly warmup: number;
  readonly samples: number;
  readonly generationsPerFixture: number;
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly inputBytesPerSample: number;
  readonly rewrittenBytesPerSample: number;
  readonly outputBytesPerSample: number;
  readonly throughputMBps: number;
  readonly sha256: string;
  readonly retainedMemoryBoundBytes: number;
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1);
  return ordered[Math.max(0, index)] ?? 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sourceBytes(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
}

function packetFingerprint(bytes: Uint8Array): string {
  const table = webmPacketPayloadInfoFromBytes(bytes);
  const hash = createHash('sha256');
  for (const track of table.tracks) {
    hash.update(
      JSON.stringify({
        id: track.id,
        mediaType: track.mediaType,
        codec: track.codec,
        durationSec: track.durationSec,
        codecDelayNs: track.codecDelayNs,
        seekPreRollNs: track.seekPreRollNs,
        gapless: track.gapless,
        color: track.color,
        width: track.width,
        height: track.height,
        rotation: track.rotation,
        fps: track.fps,
        sampleRate: track.sampleRate,
        channels: track.channels,
      }),
    );
    const description = track.config?.description;
    if (description !== undefined) hash.update(sourceBytes(description));
  }
  for (const packet of table.packets) {
    hash.update(
      `${packet.trackIndex}:${packet.size}:${packet.ptsUs}:${packet.dtsUs}:${packet.durationUs ?? ''}:${Number(packet.keyframe)}|`,
    );
    hash.update(packet.data);
    if (packet.alpha !== undefined) hash.update(packet.alpha);
  }
  return hash.digest('hex');
}

function validateTags(output: Uint8Array): void {
  const actual = readMkvTags(output);
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(GENERATION_B).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`Matroska replacement exposed stale tags: ${JSON.stringify(actual)}`);
  }
}

function runBatch(inputs: readonly Input[], retainOutputs: boolean): BatchResult {
  const hash = createHash('sha256');
  const outputs: Uint8Array[] = [];
  let inputBytes = 0;
  let rewrittenBytes = 0;
  let outputBytes = 0;
  let elapsedMs = 0;
  for (const input of inputs) {
    const started = Bun.nanoseconds();
    const generationA = writeMkvTags(input.bytes, GENERATION_A);
    const generationB = writeMkvTags(generationA, GENERATION_B);
    const repeatedB = writeMkvTags(generationB, GENERATION_B);
    elapsedMs += (Bun.nanoseconds() - started) / 1_000_000;
    if (!bytesEqual(generationB, repeatedB)) {
      throw new Error(`${input.id}: repeating generation B was not byte-idempotent`);
    }
    if (generationB.byteLength !== repeatedB.byteLength) {
      throw new Error(`${input.id}: repeating generation B grew the Segment`);
    }
    validateTags(generationB);
    if (packetFingerprint(generationB) !== input.packetFingerprint) {
      throw new Error(`${input.id}: packet/config/timing fingerprint changed`);
    }
    hash.update(generationB);
    inputBytes += input.bytes.byteLength;
    rewrittenBytes += input.bytes.byteLength + generationA.byteLength + generationB.byteLength;
    outputBytes += generationB.byteLength;
    if (retainOutputs) outputs.push(generationB);
  }
  return {
    elapsedMs,
    inputBytes,
    rewrittenBytes,
    outputBytes,
    digest: hash.digest('hex'),
    outputs,
  };
}

function processHeapBytes(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

function measureMemory(inputs: readonly Input[]): MemoryResult {
  Bun.gc(true);
  const before = process.memoryUsage();
  const beforeProcessHeapBytes = before.heapUsed + before.arrayBuffers;
  let peakProcessHeapBytes = beforeProcessHeapBytes;
  let peakRssBytes = before.rss;
  const retained: Uint8Array[] = [];
  for (let batch = 0; batch < MEMORY_BATCHES; batch++) {
    const result = runBatch(inputs, true);
    retained.push(...result.outputs);
    peakProcessHeapBytes = Math.max(peakProcessHeapBytes, processHeapBytes());
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }
  retained.length = 0;
  Bun.gc(true);
  const after = process.memoryUsage();
  const retainedProcessHeapBytes = after.heapUsed + after.arrayBuffers - beforeProcessHeapBytes;
  const retainedRssBytes = after.rss - before.rss;
  const peakProcessHeapDeltaBytes = peakProcessHeapBytes - beforeProcessHeapBytes;
  const peakRssDeltaBytes = peakRssBytes - before.rss;
  if (peakProcessHeapDeltaBytes <= 0 || peakRssDeltaBytes <= 0) {
    throw new Error(
      `Matroska replacement memory samples must be positive: heap=${peakProcessHeapDeltaBytes}, rss=${peakRssDeltaBytes}`,
    );
  }
  if (
    retainedProcessHeapBytes > RETAINED_MEMORY_BOUND_BYTES ||
    retainedRssBytes > RETAINED_MEMORY_BOUND_BYTES
  ) {
    throw new Error(
      `Matroska replacement retained too much memory: heap=${retainedProcessHeapBytes}, rss=${retainedRssBytes}`,
    );
  }
  return {
    peakProcessHeapBytes,
    peakRssBytes,
    peakProcessHeapDeltaBytes,
    peakRssDeltaBytes,
    retainedProcessHeapBytes,
    retainedRssBytes,
  };
}

function checkBaseline(result: BenchmarkResult, baseline: BenchmarkResult): void {
  if (result.sha256 !== baseline.sha256) {
    throw new Error(`Matroska replacement digest changed: ${result.sha256} != ${baseline.sha256}`);
  }
  if (result.outputBytesPerSample !== baseline.outputBytesPerSample) {
    throw new Error(
      `Matroska replacement size changed: ${result.outputBytesPerSample} != ${baseline.outputBytesPerSample}`,
    );
  }
  if (result.medianMs > baseline.medianMs * (1 + REGRESSION_TOLERANCE)) {
    throw new Error(
      `Matroska replacement regressed: ${result.medianMs.toFixed(3)} ms vs ${baseline.medianMs.toFixed(3)} ms`,
    );
  }
}

const inputs = await Promise.all(
  INPUT_IDS.map(async (id): Promise<Input> => {
    const bytes = new Uint8Array(await readFile(`${MEDIA_ROOT}${id}`));
    return { id, bytes, packetFingerprint: packetFingerprint(bytes) };
  }),
);
for (let warmup = 0; warmup < WARMUP; warmup++) runBatch(inputs, false);
const samplesMs: number[] = [];
const digests = new Set<string>();
let last: BatchResult | undefined;
for (let sample = 0; sample < SAMPLES; sample++) {
  last = runBatch(inputs, false);
  samplesMs.push(last.elapsedMs);
  digests.add(last.digest);
}
if (last === undefined || digests.size !== 1) {
  throw new Error('Matroska replacement output was not deterministic');
}
const medianMs = percentile(samplesMs, 0.5);
const result: BenchmarkResult = {
  generatedAt: new Date().toISOString(),
  runtime: `bun ${Bun.version}`,
  fixtures: INPUT_IDS.length,
  warmup: WARMUP,
  samples: SAMPLES,
  generationsPerFixture: 3,
  samplesMs,
  medianMs,
  p95Ms: percentile(samplesMs, 0.95),
  inputBytesPerSample: last.inputBytes,
  rewrittenBytesPerSample: last.rewrittenBytes,
  outputBytesPerSample: last.outputBytes,
  throughputMBps: last.rewrittenBytes / (medianMs / 1_000) / 1_000_000,
  sha256: last.digest,
  retainedMemoryBoundBytes: RETAINED_MEMORY_BOUND_BYTES,
  ...measureMemory(inputs),
};
console.info(JSON.stringify(result, null, 2));
if (process.argv.includes('--check')) {
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as BenchmarkResult;
  checkBaseline(result, baseline);
  console.info('Matroska tag replacement benchmark check passed');
}
