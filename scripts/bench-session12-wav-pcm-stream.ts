#!/usr/bin/env bun
/**
 * Session 12 WAV raw-PCM stream benchmark. The fixture is the exact retained real s24 corpus asset
 * that exposed the decode wall-time loss. The first-chunk cell proves bounded range-backed startup;
 * the complete-drain cell proves that every canonical frame still arrives with a deterministic sample
 * checksum. The legacy full-buffer decoder is used only to establish the expected truth signature.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ByteSource } from '../src/contracts/driver.ts';
import { WavDriver } from '../src/drivers/wav/wav-driver.ts';
import type { PcmAudio } from '../src/dsp/pcm.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 2;
const SAMPLES = 7;
const CHUNK_FRAMES = 4096;
const SAMPLE_STRIDE = 997;
const FIXTURE = fileURLToPath(
  new URL(
    '../../media-test/fixtures/media/scenarios/audio-dsp/throughput_decode_s24/03.wav',
    import.meta.url,
  ),
);

interface RangeSource {
  readonly source: ByteSource;
  readonly bytesRead: () => number;
}

interface RunSample {
  readonly elapsedMs: number;
  readonly bytesRead: number;
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
  return Math.imul(hash ^ (Math.trunc(value) | 0), 16_777_619) >>> 0;
}

function sampleCode(value: number): number {
  return Math.round(value * 1_000_000_000);
}

function checksumPcm(audio: PcmAudio, offset = 0): number {
  let hash = 2_166_136_261;
  hash = mix(hash, audio.sampleRate);
  hash = mix(hash, audio.channels);
  hash = mix(hash, offset);
  hash = mix(hash, audio.frames);
  for (let channel = 0; channel < audio.channels; channel++) {
    const samples = audio.planar[channel];
    if (samples === undefined) throw new Error(`missing channel ${channel}`);
    for (let frame = 0; frame < audio.frames; frame++) {
      const absolute = offset + frame;
      if (absolute % SAMPLE_STRIDE !== 0 && frame !== audio.frames - 1) continue;
      hash = mix(hash, channel);
      hash = mix(hash, absolute);
      hash = mix(hash, sampleCode(samples[frame] ?? 0));
    }
  }
  return hash >>> 0;
}

function checksumStreamTruth(audio: PcmAudio): number {
  let hash = 2_166_136_261;
  for (let offset = 0; offset < audio.frames; offset += CHUNK_FRAMES) {
    const frames = Math.min(CHUNK_FRAMES, audio.frames - offset);
    const chunk: PcmAudio = {
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      frames,
      planar: audio.planar.map((samples) => samples.subarray(offset, offset + frames)),
    };
    hash = mix(hash, checksumPcm(chunk, offset));
  }
  return hash >>> 0;
}

function rangeSource(bytes: Uint8Array): RangeSource {
  const base = fromBytes(bytes, { mime: 'audio/wav' });
  const baseRange = base.range;
  if (baseRange === undefined) throw new Error('byte source did not expose range()');
  let bytesRead = 0;
  const source: ByteSource = {
    stream: base.stream,
    ...(base.size === undefined ? {} : { size: base.size }),
    range: async (start, end) => {
      const result = await baseRange(start, end);
      bytesRead += result.byteLength;
      return result;
    },
  };
  return { source, bytesRead: () => bytesRead };
}

function decodeWavStream(source: ByteSource): Promise<ReadableStream<PcmAudio>> {
  const decode = WavDriver.decodePcmAudioStream;
  if (decode === undefined) throw new Error('WAV decodePcmAudioStream capability is missing');
  return decode.call(WavDriver, source);
}

function decodeWav(source: ByteSource): Promise<PcmAudio> {
  const decode = WavDriver.decodePcmAudio;
  if (decode === undefined) throw new Error('WAV decodePcmAudio capability is missing');
  return decode.call(WavDriver, source);
}

async function firstChunk(bytes: Uint8Array): Promise<RunSample> {
  const ranged = rangeSource(bytes);
  const started = performance.now();
  const stream = await decodeWavStream(ranged.source);
  const reader = stream.getReader();
  try {
    const next = await reader.read();
    if (next.done) throw new Error('WAV stream ended before its first PCM chunk');
    return {
      elapsedMs: performance.now() - started,
      bytesRead: ranged.bytesRead(),
      frames: next.value.frames,
      checksum: checksumPcm(next.value),
    };
  } finally {
    await reader.cancel('benchmark first-chunk sample');
    reader.releaseLock();
  }
}

async function completeDrain(bytes: Uint8Array): Promise<RunSample> {
  const ranged = rangeSource(bytes);
  const started = performance.now();
  const stream = await decodeWavStream(ranged.source);
  const reader = stream.getReader();
  let frames = 0;
  let checksum = 2_166_136_261;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      checksum = mix(checksum, checksumPcm(next.value, frames));
      frames += next.value.frames;
    }
  } finally {
    reader.releaseLock();
  }
  return {
    elapsedMs: performance.now() - started,
    bytesRead: ranged.bytesRead(),
    frames,
    checksum: checksum >>> 0,
  };
}

async function legacyFullDecode(bytes: Uint8Array): Promise<RunSample> {
  const ranged = rangeSource(bytes);
  const started = performance.now();
  const audio = await decodeWav(ranged.source);
  return {
    elapsedMs: performance.now() - started,
    bytesRead: ranged.bytesRead(),
    frames: audio.frames,
    checksum: checksumPcm(audio),
  };
}

function allEqual(values: readonly number[]): boolean {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first);
}

async function main(): Promise<void> {
  const bytes = new Uint8Array(await readFile(FIXTURE));
  const expected = await decodeWav(fromBytes(bytes, { mime: 'audio/wav' }));
  const expectedWholePcmChecksum = checksumPcm(expected);
  const expectedStreamChecksum = checksumStreamTruth(expected);
  const expectedFirstChecksum = checksumPcm({
    sampleRate: expected.sampleRate,
    channels: expected.channels,
    frames: CHUNK_FRAMES,
    planar: expected.planar.map((samples) => samples.subarray(0, CHUNK_FRAMES)),
  });
  const firstSamples: RunSample[] = [];
  const drainSamples: RunSample[] = [];
  const legacySamples: RunSample[] = [];

  for (let index = 0; index < WARMUP + SAMPLES; index++) {
    const first = await firstChunk(bytes);
    const drain = await completeDrain(bytes);
    const legacy = await legacyFullDecode(bytes);
    if (first.frames !== CHUNK_FRAMES) {
      throw new Error(`first chunk ${first.frames} frames != expected ${CHUNK_FRAMES}`);
    }
    if (drain.frames !== expected.frames) {
      throw new Error(`stream frame count ${drain.frames} != expected ${expected.frames}`);
    }
    if (first.checksum !== expectedFirstChecksum) {
      throw new Error('first stream chunk differs from the whole-buffer truth prefix');
    }
    if (drain.checksum !== expectedStreamChecksum) {
      throw new Error(`stream checksum ${drain.checksum} != expected ${expectedStreamChecksum}`);
    }
    if (legacy.frames !== expected.frames || legacy.checksum !== expectedWholePcmChecksum) {
      throw new Error('legacy full-buffer decode differs from the whole-buffer truth');
    }
    if (index >= WARMUP) {
      firstSamples.push(first);
      drainSamples.push(drain);
      legacySamples.push(legacy);
    }
  }

  const first = firstSamples[0];
  const drain = drainSamples[0];
  if (first === undefined || drain === undefined) throw new Error('benchmark produced no samples');
  if (!allEqual(firstSamples.map((sample) => sample.checksum))) {
    throw new Error('first-chunk checksums are not deterministic');
  }
  if (!allEqual(drainSamples.map((sample) => sample.checksum))) {
    throw new Error('complete-drain checksums are not deterministic');
  }
  if (!allEqual(legacySamples.map((sample) => sample.checksum))) {
    throw new Error('legacy full-buffer checksums are not deterministic');
  }
  if (first.bytesRead >= bytes.byteLength) {
    throw new Error(`first chunk read ${first.bytesRead} of ${bytes.byteLength} bytes`);
  }
  console.info(
    JSON.stringify(
      {
        fixture: FIXTURE,
        fixtureBytes: bytes.byteLength,
        warmup: WARMUP,
        samples: SAMPLES,
        expectedFrames: expected.frames,
        expectedChannels: expected.channels,
        expectedSampleRate: expected.sampleRate,
        expectedWholePcmChecksum,
        expectedStreamChecksum,
        firstChunk: {
          frames: first.frames,
          bytesRead: first.bytesRead,
          medianMs: median(firstSamples.map((sample) => sample.elapsedMs)),
          samplesMs: firstSamples.map((sample) => sample.elapsedMs),
          checksum: first.checksum,
        },
        completeDrain: {
          frames: drain.frames,
          bytesRead: drain.bytesRead,
          medianMs: median(drainSamples.map((sample) => sample.elapsedMs)),
          samplesMs: drainSamples.map((sample) => sample.elapsedMs),
          checksum: drain.checksum,
        },
        legacyFullBuffer: {
          frames: legacySamples[0]?.frames,
          bytesRead: legacySamples[0]?.bytesRead,
          medianMs: median(legacySamples.map((sample) => sample.elapsedMs)),
          samplesMs: legacySamples.map((sample) => sample.elapsedMs),
          checksum: legacySamples[0]?.checksum,
        },
      },
      null,
      2,
    ),
  );
}

await main();
