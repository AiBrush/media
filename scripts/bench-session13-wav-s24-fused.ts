#!/usr/bin/env bun
/** Warm, multi-sample benchmark for fused packed-s24 WAV -> interleaved-f32 streaming. */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ByteSource } from '../src/contracts/driver.ts';
import { WavDriver } from '../src/drivers/wav/wav-driver.ts';
import type { InterleavedPcmF32, PcmAudio } from '../src/dsp/pcm.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 2;
const SAMPLES = 7;
const SAMPLE_STRIDE = 997;
const RETAINED_ARRAY_BUFFER_LIMIT_BYTES = 2 * 1024 * 1024;
const FIXTURE = fileURLToPath(
  new URL(
    '../../media-test/fixtures/media/scenarios/audio-dsp/throughput_decode_s24/03.wav',
    import.meta.url,
  ),
);

interface RangeSource {
  readonly source: ByteSource;
  readonly bytesRead: () => number;
  readonly calls: () => number;
}

interface RunSample {
  readonly elapsedMs: number;
  readonly bytesRead: number;
  readonly rangeCalls: number;
  readonly frames: number;
  readonly checksum: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

function mix(hash: number, value: number): number {
  return Math.imul(hash ^ (value | 0), 16_777_619) >>> 0;
}

function checksumInterleaved(
  data: Float32Array,
  channels: number,
  frames: number,
  frameOffset: number,
): number {
  let hash = 2_166_136_261;
  hash = mix(hash, channels);
  hash = mix(hash, frames);
  hash = mix(hash, frameOffset);
  const bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
  for (let frame = 0; frame < frames; frame++) {
    const absolute = frameOffset + frame;
    if (absolute % SAMPLE_STRIDE !== 0 && frame !== frames - 1) continue;
    for (let channel = 0; channel < channels; channel++) {
      hash = mix(hash, bits[frame * channels + channel] ?? 0);
    }
  }
  return hash >>> 0;
}

function interleaveCanonical(audio: PcmAudio): Float32Array<ArrayBuffer> {
  const out = new Float32Array(new ArrayBuffer(audio.frames * audio.channels * 4));
  for (let channel = 0; channel < audio.channels; channel++) {
    const plane = audio.planar[channel];
    if (plane === undefined) throw new Error(`missing canonical channel ${channel}`);
    for (let frame = 0; frame < audio.frames; frame++) {
      out[frame * audio.channels + channel] = plane[frame] ?? 0;
    }
  }
  return out;
}

function rangeSource(bytes: Uint8Array): RangeSource {
  const base = fromBytes(bytes, { mime: 'audio/wav' });
  const baseRange = base.range;
  if (baseRange === undefined) throw new Error('byte source did not expose range()');
  let bytesRead = 0;
  let calls = 0;
  return {
    source: {
      stream: base.stream,
      ...(base.size === undefined ? {} : { size: base.size }),
      range: async (start, end) => {
        const result = await baseRange(start, end);
        bytesRead += result.byteLength;
        calls++;
        return result;
      },
    },
    bytesRead: () => bytesRead,
    calls: () => calls,
  };
}

async function drainPlanar(bytes: Uint8Array): Promise<RunSample> {
  const decode = WavDriver.decodePcmAudioStream;
  if (decode === undefined) throw new Error('canonical WAV stream capability is missing');
  const ranged = rangeSource(bytes);
  const started = performance.now();
  const reader = (await decode.call(WavDriver, ranged.source)).getReader();
  let frames = 0;
  let checksum = 2_166_136_261;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const interleaved = interleaveCanonical(next.value);
    checksum = mix(
      checksum,
      checksumInterleaved(interleaved, next.value.channels, next.value.frames, frames),
    );
    frames += next.value.frames;
  }
  return {
    elapsedMs: performance.now() - started,
    bytesRead: ranged.bytesRead(),
    rangeCalls: ranged.calls(),
    frames,
    checksum: checksum >>> 0,
  };
}

async function drainFused(bytes: Uint8Array): Promise<RunSample> {
  const decode = WavDriver.decodePcmInterleavedStream;
  if (decode === undefined) throw new Error('fused WAV stream capability is missing');
  const ranged = rangeSource(bytes);
  const started = performance.now();
  const reader = (await decode.call(WavDriver, ranged.source)).getReader();
  let frames = 0;
  let checksum = 2_166_136_261;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const chunk: InterleavedPcmF32 = next.value;
    checksum = mix(checksum, checksumInterleaved(chunk.data, chunk.channels, chunk.frames, frames));
    frames += chunk.frames;
  }
  return {
    elapsedMs: performance.now() - started,
    bytesRead: ranged.bytesRead(),
    rangeCalls: ranged.calls(),
    frames,
    checksum: checksum >>> 0,
  };
}

async function completeFusedStream(
  fixture: Uint8Array,
  expectedFrames: number,
): Promise<ReadableStream<InterleavedPcmF32>> {
  const decode = WavDriver.decodePcmInterleavedStream;
  if (decode === undefined) throw new Error('fused WAV stream capability is missing');
  const ownedInput = fixture.slice();
  const stream = await decode.call(WavDriver, fromBytes(ownedInput, { mime: 'audio/wav' }));
  const reader = stream.getReader();
  let frames = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    frames += next.value.frames;
  }
  reader.releaseLock();
  if (frames !== expectedFrames) throw new Error(`retention run decoded ${frames} frames`);
  return stream;
}

async function retainedCompletedStreamBytes(
  fixture: Uint8Array,
  expectedFrames: number,
): Promise<number> {
  await completeFusedStream(fixture, expectedFrames);
  Bun.gc(true);
  const baselineBytes = process.memoryUsage().arrayBuffers;
  const retained = await completeFusedStream(fixture, expectedFrames);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  Bun.gc(true);
  const retainedBytes = Math.max(0, process.memoryUsage().arrayBuffers - baselineBytes);
  if (retained.locked) throw new Error('completed fused stream kept its reader locked');
  if (retainedBytes > RETAINED_ARRAY_BUFFER_LIMIT_BYTES) {
    throw new Error(
      `completed fused stream retained ${retainedBytes} ArrayBuffer bytes; limit ${RETAINED_ARRAY_BUFFER_LIMIT_BYTES}`,
    );
  }
  return retainedBytes;
}

async function main(): Promise<void> {
  const bytes = new Uint8Array(await readFile(FIXTURE));
  const planar: RunSample[] = [];
  const fused: RunSample[] = [];
  for (let iteration = 0; iteration < WARMUP + SAMPLES; iteration++) {
    const planarSample = await drainPlanar(bytes);
    const fusedSample = await drainFused(bytes);
    if (
      fusedSample.frames !== planarSample.frames ||
      fusedSample.checksum !== planarSample.checksum
    ) {
      throw new Error('fused interleaved output differs from canonical Float32 narrowing');
    }
    if (iteration >= WARMUP) {
      planar.push(planarSample);
      fused.push(fusedSample);
    }
  }
  const representative = fused[0];
  if (representative === undefined) throw new Error('benchmark produced no samples');
  const completedStreamRetainedArrayBufferBytes = await retainedCompletedStreamBytes(
    bytes,
    representative.frames,
  );
  console.info(
    JSON.stringify(
      {
        fixture: FIXTURE,
        fixtureBytes: bytes.byteLength,
        warmup: WARMUP,
        samples: SAMPLES,
        frames: representative.frames,
        checksum: representative.checksum,
        completedStreamRetainedArrayBufferBytes,
        retainedArrayBufferLimitBytes: RETAINED_ARRAY_BUFFER_LIMIT_BYTES,
        canonicalPlanarThenInterleave: {
          medianMs: median(planar.map((sample) => sample.elapsedMs)),
          samplesMs: planar.map((sample) => sample.elapsedMs),
          rangeCalls: planar.map((sample) => sample.rangeCalls),
          bytesRead: planar.map((sample) => sample.bytesRead),
        },
        fusedPackedToInterleaved: {
          medianMs: median(fused.map((sample) => sample.elapsedMs)),
          samplesMs: fused.map((sample) => sample.elapsedMs),
          rangeCalls: fused.map((sample) => sample.rangeCalls),
          bytesRead: fused.map((sample) => sample.bytesRead),
        },
      },
      null,
      2,
    ),
  );
}

await main();
