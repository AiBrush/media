#!/usr/bin/env bun
/** Warm timing and retained-memory benchmark for ADR-261's raw PCM rewrite source cache. */

import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import { parseWavPcmData, writeWavHeader } from '../src/drivers/wav/pcm.ts';
import { SOURCE_CACHE_KEY, type Source } from '../src/sources/source.ts';

const FIXTURE = new URL('../fixtures/media/stereo-48000.wav', import.meta.url);
const WARMUP = 3;
const SAMPLES = 21;
const ROTATING_SOURCES = 12;
const SOURCE_BYTES = 1024 * 1024;
const RETAINED_ARRAY_BUFFER_LIMIT = 8 * 1024 * 1024 + 64 * 1024;

interface KeyedSource {
  readonly source: Source;
  readonly reads: () => number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function mad(values: readonly number[]): number {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function derivedWav(seed: Uint8Array, rotation: number): Uint8Array<ArrayBuffer> {
  const parsed = parseWavPcmData(seed);
  const blockAlign = 4;
  const payloadBytes = Math.floor((SOURCE_BYTES - 44) / blockAlign) * blockAlign;
  const bytes = new Uint8Array(44 + payloadBytes);
  writeWavHeader(bytes, payloadBytes, 2, 48_000, 's16');
  const shift = (rotation * 4_093 * blockAlign) % parsed.data.byteLength;
  let outputOffset = 44;
  let inputOffset = shift;
  while (outputOffset < bytes.byteLength) {
    const length = Math.min(parsed.data.byteLength - inputOffset, bytes.byteLength - outputOffset);
    bytes.set(parsed.data.subarray(inputOffset, inputOffset + length), outputOffset);
    outputOffset += length;
    inputOffset = 0;
  }
  return bytes;
}

function keyedSource(bytes: Uint8Array, key: string): KeyedSource {
  let reads = 0;
  return {
    source: {
      __media: 'source',
      kind: 'url',
      size: bytes.byteLength,
      mimeHint: 'audio/wav',
      [SOURCE_CACHE_KEY]: `bench:session13:wav-cache:${key}`,
      stream: () => {
        throw new Error('WAV cache benchmark must use range()');
      },
      range: (start, end) => {
        reads++;
        return Promise.resolve(bytes.slice(start, end));
      },
    },
    reads: () => reads,
  };
}

async function digest(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

async function collect(): Promise<NodeJS.MemoryUsage> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
  }
  return process.memoryUsage();
}

const fixture = new Uint8Array(await readFile(FIXTURE));
const sources = Array.from({ length: ROTATING_SOURCES }, (_, index) => {
  const bytes = derivedWav(fixture, index);
  return { bytes, keyed: keyedSource(bytes, String(index)) };
});
const first = sources[0];
if (first === undefined) throw new Error('benchmark source matrix is empty');
const engine = createMedia({ worker: false });
const options = {
  to: 'wav',
  audio: { codec: 'pcm-s16' as const, sampleRate: 48_000, channels: 2 },
} as const;
const run = async (entry: (typeof sources)[number]): Promise<Blob> => {
  const output = await engine.convert(entry.keyed.source, options);
  if (!(output instanceof Blob)) throw new Error('WAV cache benchmark expected Blob output');
  return output;
};

for (let iteration = 0; iteration < WARMUP; iteration++) await run(first);
const hotSamples: number[] = [];
for (let iteration = 0; iteration < SAMPLES; iteration++) {
  const started = Bun.nanoseconds();
  await run(first);
  hotSamples.push((Bun.nanoseconds() - started) / 1_000_000);
}
if (first.keyed.reads() !== 1)
  throw new Error('same exact source did not remain a one-read hot path');

await collect();
const before = process.memoryUsage();
const expectedDigests = new Map<number, string>();
for (let index = 0; index < sources.length; index++) {
  const entry = sources[index];
  if (entry === undefined) continue;
  const output = await run(entry);
  expectedDigests.set(index, await digest(new Blob([entry.bytes])));
  const outputDigest = await digest(output);
  if (outputDigest !== expectedDigests.get(index)) {
    throw new Error(`WAV cache benchmark changed output bytes for rotation ${index}`);
  }
}
const after = await collect();
const retainedArrayBuffers = Math.max(0, after.arrayBuffers - before.arrayBuffers);
if (retainedArrayBuffers > RETAINED_ARRAY_BUFFER_LIMIT) {
  throw new Error(
    `WAV cache retained ${retainedArrayBuffers} ArrayBuffer bytes; limit ${RETAINED_ARRAY_BUFFER_LIMIT}`,
  );
}

const oldestReadsBefore = first.keyed.reads();
const oldestOutput = await run(first);
if ((await digest(oldestOutput)) !== expectedDigests.get(0)) {
  throw new Error('evicted WAV source changed output bytes after re-read');
}
if (first.keyed.reads() !== oldestReadsBefore + 1) {
  throw new Error('oldest distinct source was not evicted under the total-byte budget');
}
const newest = sources.at(-1);
if (newest === undefined) throw new Error('missing newest cache source');
const newestReadsBefore = newest.keyed.reads();
await run(newest);
if (newest.keyed.reads() !== newestReadsBefore) {
  throw new Error('recent exact source lost its warm cache entry');
}

console.info(
  JSON.stringify(
    {
      fixture: FIXTURE.pathname.split('/').at(-1),
      sourceBytes: first.bytes.byteLength,
      warmup: WARMUP,
      samples: SAMPLES,
      hotSameSource: {
        medianMs: median(hotSamples),
        madMs: mad(hotSamples),
        rangeReads: oldestReadsBefore,
      },
      rotatingDistinctSources: {
        count: sources.length,
        retainedArrayBuffers,
        retainedArrayBufferLimit: RETAINED_ARRAY_BUFFER_LIMIT,
        oldestReadsAfterRevisit: first.keyed.reads(),
        newestReadsAfterRevisit: newest.keyed.reads(),
      },
      outputSha256: Object.fromEntries(expectedDigests),
    },
    null,
    2,
  ),
);
