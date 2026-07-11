#!/usr/bin/env bun
/**
 * Public AudioData -> PCM WAV encode benchmark (ADR-243). Every iteration creates fresh frame streams
 * over five downloaded WPT PCM fixtures, consumes the returned Blob, checks exact post-AudioData sample
 * truth, and folds output bytes into a checksum. Wall and memory are measured in separate passes.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createMedia } from '../src/api/create-media.ts';
import type { PcmCodec } from '../src/api/types.ts';
import { readWavPcm } from '../src/drivers/wav/pcm.ts';
import type { PcmAudio, SampleFormat } from '../src/dsp/pcm.ts';

const WARMUPS = 2;
const SAMPLES = 7;
const MEMORY_SAMPLES = 3;
const MEMORY_CORPUS_REPEATS = 12;
const RETAINED_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const CHUNK_SIZES = [1, 7, 257, 1021, 4096] as const;
const CORPUS = [
  { id: 'sfx-pcm-u8.wav', format: 'u8', codec: 'pcm-u8' },
  { id: 'sfx-pcm-s16.wav', format: 's16', codec: 'pcm-s16' },
  { id: 'sfx-pcm-s24.wav', format: 's24', codec: 'pcm-s24' },
  { id: 'sfx-pcm-s32.wav', format: 's32', codec: 'pcm-s32' },
  { id: 'sfx-pcm-f32.wav', format: 'f32', codec: 'pcm-f32' },
] as const satisfies readonly {
  readonly id: string;
  readonly format: SampleFormat;
  readonly codec: PcmCodec;
}[];

interface CorpusEntry {
  readonly id: string;
  readonly format: SampleFormat;
  readonly codec: PcmCodec;
  readonly bytes: Uint8Array;
  readonly audio: PcmAudio;
}

interface RunResult {
  readonly elapsedMs: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly frames: number;
  readonly checksum: number;
  readonly retainedOutputs: readonly Uint8Array[];
}

interface MemoryResult {
  readonly baselineHeapBytes: number;
  readonly peakHeapBytes: number;
  readonly baselineArrayBufferBytes: number;
  readonly peakArrayBufferBytes: number;
  readonly baselineRssBytes: number;
  readonly peakRssBytes: number;
  readonly postGcHeapBytes: number;
  readonly postGcArrayBufferBytes: number;
  readonly postGcRssBytes: number;
  readonly checksum: number;
}

class BenchAudioData {
  readonly format = 'f32-planar' as const;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly timestamp: number;
  readonly duration: number;
  closeCount = 0;

  readonly #planes: readonly Float64Array[];

  constructor(audio: PcmAudio, start: number, frames: number) {
    this.sampleRate = audio.sampleRate;
    this.numberOfChannels = audio.channels;
    this.numberOfFrames = frames;
    this.timestamp = Math.round((start / audio.sampleRate) * 1_000_000);
    this.duration = Math.round((frames / audio.sampleRate) * 1_000_000);
    this.#planes = audio.planar.map((plane) => plane.subarray(start, start + frames));
  }

  allocationSize(options: AudioDataCopyToOptions): number {
    return (this.#planes[options.planeIndex]?.length ?? 0) * Float32Array.BYTES_PER_ELEMENT;
  }

  copyTo(destination: AllowSharedBufferSource, options: AudioDataCopyToOptions): void {
    if (options.format !== undefined && options.format !== 'f32-planar') {
      throw new Error(`benchmark frame cannot copy ${options.format}`);
    }
    const source = this.#planes[options.planeIndex];
    if (source === undefined) throw new Error(`benchmark frame has no plane ${options.planeIndex}`);
    const view = destination as ArrayBufferView;
    const output = new Float32Array(view.buffer, view.byteOffset, source.length);
    for (let index = 0; index < source.length; index++) output[index] = source[index] ?? 0;
  }

  clone(): AudioData {
    throw new Error('benchmark does not clone AudioData');
  }

  close(): void {
    this.closeCount++;
  }
}

function frameStream(audio: PcmAudio): {
  readonly stream: ReadableStream<AudioData>;
  readonly frames: readonly BenchAudioData[];
} {
  const frames: BenchAudioData[] = [];
  let cursor = 0;
  let chunkIndex = 0;
  return {
    frames,
    stream: new ReadableStream<AudioData>(
      {
        pull(controller): void {
          if (cursor >= audio.frames) {
            controller.close();
            return;
          }
          const count = Math.min(
            CHUNK_SIZES[chunkIndex % CHUNK_SIZES.length] ?? 1,
            audio.frames - cursor,
          );
          const frame = new BenchAudioData(audio, cursor, count);
          frames.push(frame);
          controller.enqueue(frame as unknown as AudioData);
          cursor += count;
          chunkIndex++;
        },
      },
      { highWaterMark: 0 },
    ),
  };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('benchmark has no measured samples');
  return value;
}

function mix(hash: number, value: number): number {
  return Math.imul(hash ^ (value & 0xff), 16_777_619) >>> 0;
}

function checksumBytes(hash: number, bytes: Uint8Array): number {
  let output = hash;
  for (const byte of bytes) output = mix(output, byte);
  return output;
}

function expectedSample(value: number, format: SampleFormat): number {
  const copied = Math.fround(value);
  switch (format) {
    case 'u8':
      return (Math.max(0, Math.min(255, Math.round(copied * 128) + 128)) - 128) / 128;
    case 's8':
      return Math.max(-128, Math.min(127, Math.round(copied * 128))) / 128;
    case 's16':
      return Math.max(-32_768, Math.min(32_767, Math.round(copied * 32_768))) / 32_768;
    case 's24':
      return Math.max(-8_388_608, Math.min(8_388_607, Math.round(copied * 8_388_608))) / 8_388_608;
    case 's32':
      return (
        Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(copied * 2_147_483_648))) /
        2_147_483_648
      );
    case 'f32':
    case 'f64':
      return copied;
  }
}

function verifyOutput(source: PcmAudio, format: SampleFormat, outputBytes: Uint8Array): void {
  const actual = readWavPcm(outputBytes);
  if (
    actual.format !== format ||
    actual.sampleRate !== source.sampleRate ||
    actual.channels !== source.channels ||
    actual.frames !== source.frames
  ) {
    throw new Error(
      `WAV reimport mismatch ${actual.format}/${actual.sampleRate}/${actual.channels}/${actual.frames}`,
    );
  }
  for (let channel = 0; channel < source.channels; channel++) {
    const expectedPlane = source.planar[channel];
    const actualPlane = actual.planar[channel];
    if (expectedPlane === undefined || actualPlane === undefined) {
      throw new Error(`WAV reimport missing channel ${channel}`);
    }
    for (let frame = 0; frame < source.frames; frame++) {
      const expected = expectedSample(expectedPlane[frame] ?? 0, format);
      if (actualPlane[frame] !== expected) {
        throw new Error(
          `WAV sample mismatch channel=${channel} frame=${frame} expected=${expected} actual=${String(actualPlane[frame])}`,
        );
      }
    }
  }
}

async function outputBytes(
  output: Blob | File | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (!(output instanceof Blob)) throw new Error('benchmark expected Blob output');
  return new Uint8Array(await output.arrayBuffer());
}

const media = createMedia();

async function runCorpus(
  corpus: readonly CorpusEntry[],
  retainOutputs: boolean,
): Promise<RunResult> {
  const retainedOutputs: Uint8Array[] = [];
  let inputBytes = 0;
  let totalOutputBytes = 0;
  let frames = 0;
  let checksum = 2_166_136_261;
  const started = performance.now();
  const pending: Array<{
    readonly entry: CorpusEntry;
    readonly framed: ReturnType<typeof frameStream>;
    readonly output: Blob | File | ReadableStream<Uint8Array> | undefined;
  }> = [];
  for (const entry of corpus) {
    const framed = frameStream(entry.audio);
    const output = await media.encode(
      { audio: framed.stream },
      {
        to: 'wav',
        audio: {
          codec: entry.codec,
          sampleRate: entry.audio.sampleRate,
          channels: entry.audio.channels,
        },
      },
    );
    pending.push({ entry, framed, output });
  }
  const elapsedMs = performance.now() - started;

  for (const result of pending) {
    const bytes = await outputBytes(result.output);
    verifyOutput(result.entry.audio, result.entry.format, bytes);
    if (!result.framed.frames.every((frame) => frame.closeCount === 1)) {
      throw new Error(`${result.entry.id} frame ownership is not close-once`);
    }
    inputBytes += result.entry.bytes.byteLength;
    totalOutputBytes += bytes.byteLength;
    frames += result.entry.audio.frames;
    checksum = checksumBytes(checksum, bytes);
    if (retainOutputs) retainedOutputs.push(bytes);
  }
  return {
    elapsedMs,
    inputBytes,
    outputBytes: totalOutputBytes,
    frames,
    checksum,
    retainedOutputs,
  };
}

async function memorySample(corpus: readonly CorpusEntry[]): Promise<MemoryResult> {
  Bun.gc(true);
  const baseline = process.memoryUsage();
  let peakHeapBytes = baseline.heapUsed;
  let peakArrayBufferBytes = baseline.arrayBuffers;
  let peakRssBytes = baseline.rss;
  let checksum = 2_166_136_261;
  const retained: Uint8Array[] = [];
  for (let repeat = 0; repeat < MEMORY_CORPUS_REPEATS; repeat++) {
    const result = await runCorpus(corpus, true);
    checksum = mix(checksum, result.checksum);
    retained.push(...result.retainedOutputs);
    const usage = process.memoryUsage();
    peakHeapBytes = Math.max(peakHeapBytes, usage.heapUsed);
    peakArrayBufferBytes = Math.max(peakArrayBufferBytes, usage.arrayBuffers);
    peakRssBytes = Math.max(peakRssBytes, usage.rss);
  }
  if (peakArrayBufferBytes <= baseline.arrayBuffers) {
    throw new Error('memory pass produced no positive retained-output ArrayBuffer sample');
  }
  retained.length = 0;
  Bun.gc(true);
  const post = process.memoryUsage();
  if (post.heapUsed - baseline.heapUsed > RETAINED_MEMORY_LIMIT_BYTES) {
    throw new Error('WAV frame encode retained more than the 64 MiB heap allowance');
  }
  if (post.rss - baseline.rss > RETAINED_MEMORY_LIMIT_BYTES) {
    throw new Error('WAV frame encode retained more than the 64 MiB RSS allowance');
  }
  if (post.arrayBuffers - baseline.arrayBuffers > RETAINED_MEMORY_LIMIT_BYTES) {
    throw new Error('WAV frame encode retained more than the 64 MiB ArrayBuffer allowance');
  }
  return {
    baselineHeapBytes: baseline.heapUsed,
    peakHeapBytes,
    baselineArrayBufferBytes: baseline.arrayBuffers,
    peakArrayBufferBytes,
    baselineRssBytes: baseline.rss,
    peakRssBytes,
    postGcHeapBytes: post.heapUsed,
    postGcArrayBufferBytes: post.arrayBuffers,
    postGcRssBytes: post.rss,
    checksum,
  };
}

const corpus: CorpusEntry[] = [];
for (const spec of CORPUS) {
  const bytes = new Uint8Array(
    await readFile(fileURLToPath(new URL(`../fixtures/media/${spec.id}`, import.meta.url))),
  );
  corpus.push({ ...spec, bytes, audio: readWavPcm(bytes) });
}

for (let warmup = 0; warmup < WARMUPS; warmup++) await runCorpus(corpus, false);
const measured: RunResult[] = [];
for (let sample = 0; sample < SAMPLES; sample++) measured.push(await runCorpus(corpus, false));
const checksums = new Set(measured.map((result) => result.checksum));
if (checksums.size !== 1) throw new Error('WAV frame encode checksum changed between samples');

const memory: MemoryResult[] = [];
for (let sample = 0; sample < MEMORY_SAMPLES; sample++) memory.push(await memorySample(corpus));
const medianMs = median(measured.map((result) => result.elapsedMs));
const first = measured[0];
if (first === undefined) throw new Error('WAV frame encode benchmark produced no sample');

console.info(
  JSON.stringify(
    {
      corpus: CORPUS.map(({ id, format }) => ({ id, format })),
      warmups: WARMUPS,
      samples: SAMPLES,
      memorySamples: MEMORY_SAMPLES,
      memoryCorpusRepeats: MEMORY_CORPUS_REPEATS,
      inputBytesPerSample: first.inputBytes,
      outputBytesPerSample: first.outputBytes,
      framesPerSample: first.frames,
      samplesMs: measured.map((result) => result.elapsedMs),
      medianMs,
      medianInputMBps: first.inputBytes / 1_000_000 / (medianMs / 1000),
      checksum: first.checksum,
      memory: memory.map((sample) => ({
        ...sample,
        peakHeapDeltaBytes: sample.peakHeapBytes - sample.baselineHeapBytes,
        peakArrayBufferDeltaBytes: sample.peakArrayBufferBytes - sample.baselineArrayBufferBytes,
        peakRssDeltaBytes: sample.peakRssBytes - sample.baselineRssBytes,
        retainedHeapBytes: sample.postGcHeapBytes - sample.baselineHeapBytes,
        retainedArrayBufferBytes: sample.postGcArrayBufferBytes - sample.baselineArrayBufferBytes,
        retainedRssBytes: sample.postGcRssBytes - sample.baselineRssBytes,
      })),
    },
    undefined,
    2,
  ),
);
