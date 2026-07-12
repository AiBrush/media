#!/usr/bin/env bun
/** Warm wall/peak/retention benchmark for ADR-277's range-less sequential WAV decode. */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ByteSource } from '../src/contracts/driver.ts';
import { WavDriver } from '../src/drivers/wav/wav-driver.ts';
import type { InterleavedPcmF32 } from '../src/dsp/pcm.ts';
import { type Source, fromBytes } from '../src/sources/source.ts';

const FIXTURE = fileURLToPath(
  new URL(
    '../../media-test/fixtures/media/scenarios/audio-dsp/throughput_decode_s24/03.wav',
    import.meta.url,
  ),
);
const WARMUP = 3;
const SAMPLES = 11;
const SAMPLE_STRIDE = 997;
const RETAINED_LIMIT_BYTES = 2 * 1024 * 1024;

interface RunSample {
  readonly elapsedMs: number;
  readonly peakArrayBufferBytes: number;
  readonly frames: number;
  readonly chunks: number;
  readonly checksum: number;
  readonly rangeCalls: number;
  readonly rangeBytes: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take median of an empty sample');
  return value;
}

function mad(values: readonly number[]): number {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function mix(hash: number, value: number): number {
  return Math.imul(hash ^ (value | 0), 16_777_619) >>> 0;
}

function mixChunk(hash: number, chunk: InterleavedPcmF32, frameOffset: number): number {
  let mixed = mix(mix(hash, frameOffset), chunk.frames);
  const bits = new Uint32Array(chunk.data.buffer);
  for (let frame = 0; frame < chunk.frames; frame++) {
    const absolute = frameOffset + frame;
    if (absolute % SAMPLE_STRIDE !== 0 && frame !== chunk.frames - 1) continue;
    for (let channel = 0; channel < chunk.channels; channel++) {
      mixed = mix(mixed, bits[frame * chunk.channels + channel] ?? 0);
    }
  }
  return mixed;
}

async function collect(): Promise<NodeJS.MemoryUsage> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
  }
  return process.memoryUsage();
}

interface RangeControl {
  readonly source: ByteSource;
  readonly calls: () => number;
  readonly bytes: () => number;
}

function sequentialSource(bytes: Uint8Array): Source {
  return {
    __media: 'source',
    kind: 'stream',
    size: bytes.byteLength,
    mimeHint: 'audio/wav',
    stream: () => {
      let offset = 0;
      return new ReadableStream<Uint8Array>(
        {
          pull(controller): void {
            if (offset >= bytes.byteLength) {
              controller.close();
              return;
            }
            const end = Math.min(bytes.byteLength, offset + 64 * 1024);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
}

async function run(
  blob: Blob,
  bytes: Uint8Array,
  mode: 'sequential' | 'former-full-buffer',
): Promise<RunSample> {
  const decode = WavDriver.decodePcmInterleavedStream;
  if (decode === undefined) throw new Error('WAV fused decoder is unavailable');
  const before = await collect();
  let peakArrayBuffers = before.arrayBuffers;
  const started = Bun.nanoseconds();
  let control: RangeControl | undefined;
  let source: ByteSource;
  if (mode === 'former-full-buffer') {
    const owned = new Uint8Array(await blob.arrayBuffer());
    const memorySource = fromBytes(owned, { mime: 'audio/wav' });
    const range = memorySource.range;
    if (range === undefined) throw new Error('full-buffer control did not expose range()');
    let calls = 0;
    let bytes = 0;
    control = {
      source: {
        ...memorySource,
        range: async (start, end) => {
          const result = await range(start, end);
          calls++;
          bytes += result.byteLength;
          return result;
        },
      },
      calls: () => calls,
      bytes: () => bytes,
    };
    source = control.source;
    peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers);
  } else {
    source = sequentialSource(bytes);
  }
  const stream = await decode.call(WavDriver, source);
  const reader = stream.getReader();
  let frames = 0;
  let chunks = 0;
  let checksum = 2_166_136_261;
  try {
    for (;;) {
      const next = await reader.read();
      peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers);
      if (next.done) break;
      if (next.value.frames > 4096)
        throw new Error('WAV public chunk cadence exceeded 4,096 frames');
      checksum = mixChunk(checksum, next.value, frames);
      frames += next.value.frames;
      chunks++;
    }
  } finally {
    reader.releaseLock();
  }
  return {
    elapsedMs: (Bun.nanoseconds() - started) / 1_000_000,
    peakArrayBufferBytes: Math.max(0, peakArrayBuffers - before.arrayBuffers),
    frames,
    chunks,
    checksum: checksum >>> 0,
    rangeCalls: control?.calls() ?? 0,
    rangeBytes: control?.bytes() ?? 0,
  };
}

async function retainedCompletedStreamBytes(blob: Blob, bytes: Uint8Array): Promise<number> {
  const decode = WavDriver.decodePcmInterleavedStream;
  if (decode === undefined) throw new Error('WAV fused decoder is unavailable');
  await run(blob, bytes, 'sequential');
  const before = await collect();
  const retained = await decode.call(WavDriver, sequentialSource(bytes));
  const reader = retained.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
  }
  reader.releaseLock();
  const after = await collect();
  if (retained.locked) throw new Error('completed sequential WAV stream retained a reader lock');
  return Math.max(0, after.arrayBuffers - before.arrayBuffers);
}

const fixture = new Uint8Array(await readFile(FIXTURE));
const blob = new Blob([fixture], { type: 'audio/wav' });
const sequential: RunSample[] = [];
const formerFullBuffer: RunSample[] = [];
for (let iteration = 0; iteration < WARMUP + SAMPLES; iteration++) {
  const sequentialSample = await run(blob, fixture, 'sequential');
  const rangeSample = await run(blob, fixture, 'former-full-buffer');
  if (
    sequentialSample.frames !== rangeSample.frames ||
    sequentialSample.chunks !== rangeSample.chunks ||
    sequentialSample.checksum !== rangeSample.checksum
  ) {
    throw new Error('sequential Blob decode changed sample or chunk-cadence truth');
  }
  if (iteration >= WARMUP) {
    sequential.push(sequentialSample);
    formerFullBuffer.push(rangeSample);
  }
}

const representative = sequential[0];
if (representative === undefined) throw new Error('WAV sequential benchmark produced no samples');
if (sequential.some((sample) => sample.peakArrayBufferBytes <= 0)) {
  throw new Error('WAV sequential benchmark did not capture a positive peak ArrayBuffer sample');
}
const retainedArrayBufferBytes = await retainedCompletedStreamBytes(blob, fixture);
if (retainedArrayBufferBytes > RETAINED_LIMIT_BYTES) {
  throw new Error(
    `completed sequential WAV stream retained ${retainedArrayBufferBytes} bytes; limit ${RETAINED_LIMIT_BYTES}`,
  );
}

console.info(
  JSON.stringify(
    {
      fixture: FIXTURE,
      fixtureBytes: fixture.byteLength,
      warmup: WARMUP,
      samples: SAMPLES,
      frames: representative.frames,
      chunks: representative.chunks,
      checksum: representative.checksum,
      retainedCompletedStreamArrayBufferBytes: retainedArrayBufferBytes,
      retainedLimitBytes: RETAINED_LIMIT_BYTES,
      sequentialBoundedSource: {
        medianMs: median(sequential.map((sample) => sample.elapsedMs)),
        madMs: mad(sequential.map((sample) => sample.elapsedMs)),
        medianPeakArrayBufferBytes: median(sequential.map((sample) => sample.peakArrayBufferBytes)),
        peakSamples: sequential.map((sample) => sample.peakArrayBufferBytes),
        rangeCalls: sequential.map((sample) => sample.rangeCalls),
      },
      formerFullBufferControl: {
        medianMs: median(formerFullBuffer.map((sample) => sample.elapsedMs)),
        madMs: mad(formerFullBuffer.map((sample) => sample.elapsedMs)),
        medianPeakArrayBufferBytes: median(
          formerFullBuffer.map((sample) => sample.peakArrayBufferBytes),
        ),
        peakSamples: formerFullBuffer.map((sample) => sample.peakArrayBufferBytes),
        rangeCalls: formerFullBuffer.map((sample) => sample.rangeCalls),
        rangeBytes: formerFullBuffer.map((sample) => sample.rangeBytes),
      },
    },
    null,
    2,
  ),
);
