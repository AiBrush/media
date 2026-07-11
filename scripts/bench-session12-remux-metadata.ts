#!/usr/bin/env bun
/** Real-media benchmark for selection-first remux + target-native metadata composition (ADR-238). */

import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import { parseOgg } from '../src/drivers/ogg/ogg-driver.ts';
import { readOggVorbisComment } from '../src/metadata/ogg-vorbis-comment.ts';
import { readWavTags } from '../src/metadata/pcm-tags.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE_PATH = `${ROOT}fixtures/golden/bench/remux-metadata.json`;
const WARMUP = 3;
const SAMPLES = 15;
const MEMORY_RUNS = 5;
const REGRESSION_TOLERANCE = 0.5;
const MEMORY_SLACK_BYTES = 16 * 1024 * 1024;
const TITLE = 'selection-first benchmark';

interface ChunkInit {
  readonly type: EncodedAudioChunkType | EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration?: number;
  readonly data: AllowSharedBufferSource;
}

class BenchmarkEncodedChunk {
  readonly type: EncodedAudioChunkType | EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: ChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#data = bytesOf(init.data).slice();
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    bytesOf(destination).set(this.#data);
  }
}

interface Scenario {
  readonly name: string;
  readonly inputBytes: number;
  readonly run: () => Promise<Uint8Array>;
  readonly validate: (output: Uint8Array) => void;
}

interface ScenarioResult {
  readonly name: string;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly inputMbPerSec: number;
  readonly outputBytes: number;
  readonly peakProcessHeapMb: number;
}

interface Baseline {
  readonly generatedAt: string;
  readonly runtime: string;
  readonly warmup: number;
  readonly samples: number;
  readonly scenarios: readonly ScenarioResult[];
}

function bytesOf(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
}

function installEncodedChunkShims(): () => void {
  const video = Object.getOwnPropertyDescriptor(globalThis, 'EncodedVideoChunk');
  const audio = Object.getOwnPropertyDescriptor(globalThis, 'EncodedAudioChunk');
  const Chunk = BenchmarkEncodedChunk as unknown as typeof EncodedVideoChunk &
    typeof EncodedAudioChunk;
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    writable: true,
    value: Chunk,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    writable: true,
    value: Chunk,
  });
  return (): void => {
    if (video === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
    else Object.defineProperty(globalThis, 'EncodedVideoChunk', video);
    if (audio === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    else Object.defineProperty(globalThis, 'EncodedAudioChunk', audio);
  };
}

async function outputBytes(output: unknown): Promise<Uint8Array> {
  if (!(output instanceof Blob)) throw new Error('remux metadata benchmark expected Blob output');
  return new Uint8Array(await output.arrayBuffer());
}

function wavData(bytes: Uint8Array): Uint8Array {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('remux metadata benchmark expected RIFF/WAVE');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.byteLength) throw new Error(`truncated WAV ${id} chunk`);
    if (id === 'data') return bytes.subarray(start, end);
    offset = end + (size & 1);
  }
  throw new Error('remux metadata benchmark WAV has no data chunk');
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1);
  return ordered[Math.max(index, 0)] ?? 0;
}

async function peakProcessHeap(scenario: Scenario): Promise<number> {
  Bun.gc(true);
  let peak = process.memoryUsage().heapUsed;
  for (let index = 0; index < MEMORY_RUNS; index++) {
    const output = await scenario.run();
    checksum = (checksum + output.byteLength) | 0;
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }
  return peak;
}

async function measure(scenario: Scenario): Promise<ScenarioResult> {
  let output: Uint8Array = new Uint8Array();
  for (let index = 0; index < WARMUP; index++) output = await scenario.run();
  scenario.validate(output);
  const elapsed: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = Bun.nanoseconds();
    output = await scenario.run();
    elapsed.push((Bun.nanoseconds() - start) / 1_000_000);
    checksum = (checksum + output.byteLength + (output[0] ?? 0)) | 0;
  }
  scenario.validate(output);
  const medianMs = percentile(elapsed, 0.5);
  return {
    name: scenario.name,
    medianMs,
    p95Ms: percentile(elapsed, 0.95),
    inputMbPerSec: scenario.inputBytes / (medianMs / 1_000) / (1024 * 1024),
    outputBytes: output.byteLength,
    peakProcessHeapMb: (await peakProcessHeap(scenario)) / (1024 * 1024),
  };
}

function regressions(results: readonly ScenarioResult[], baseline: Baseline): string[] {
  const prior = new Map(baseline.scenarios.map((row) => [row.name, row]));
  const failures: string[] = [];
  for (const result of results) {
    const before = prior.get(result.name);
    if (before === undefined) {
      failures.push(`${result.name}: missing baseline row`);
      continue;
    }
    if (result.medianMs > before.medianMs * (1 + REGRESSION_TOLERANCE)) {
      failures.push(
        `${result.name}: ${result.medianMs.toFixed(3)} ms vs ${before.medianMs.toFixed(3)} ms baseline`,
      );
    }
    const heap = result.peakProcessHeapMb * 1024 * 1024;
    const priorHeap = before.peakProcessHeapMb * 1024 * 1024;
    if (heap > priorHeap * 3 + MEMORY_SLACK_BYTES) {
      failures.push(
        `${result.name}: ${result.peakProcessHeapMb.toFixed(2)} MB heap vs ${before.peakProcessHeapMb.toFixed(2)} MB baseline`,
      );
    }
  }
  return failures;
}

const wavInput = new Uint8Array(
  await readFile(new URL('../fixtures/media/speech.wav', import.meta.url)),
);
const webmInput = new Uint8Array(
  await readFile(new URL('../fixtures/media/bear-multitrack.webm', import.meta.url)),
);
const wavPayload = wavData(wavInput).slice();
const media = createMedia({ worker: false });
let checksum = 0;

const scenarios: readonly Scenario[] = [
  {
    name: 'wav full-track selection + tags',
    inputBytes: wavInput.byteLength,
    run: async () =>
      outputBytes(
        await media.remux(wavInput, {
          to: 'wav',
          trackSelect: ['audio:0'],
          tags: { title: TITLE },
        }),
      ),
    validate(output): void {
      const { title } = readWavTags(output);
      if (title !== TITLE) throw new Error('WAV title did not round-trip');
      if (!Buffer.from(wavData(output)).equals(Buffer.from(wavPayload))) {
        throw new Error('WAV selected PCM payload changed');
      }
    },
  },
  {
    name: 'webm vorbis selection -> tagged ogg',
    inputBytes: webmInput.byteLength,
    run: async () =>
      outputBytes(
        await media.remux(webmInput, {
          to: 'ogg',
          trackSelect: ['audio:0'],
          tags: { title: TITLE },
        }),
      ),
    validate(output): void {
      const parsed = parseOgg(output);
      if (parsed.codec !== 'vorbis' || parsed.durationSec <= 0) {
        throw new Error('selected Ogg/Vorbis structure is invalid');
      }
      const { title } = readOggVorbisComment(output);
      if (title !== TITLE) {
        throw new Error('Ogg title did not round-trip');
      }
    },
  },
];

const restore = installEncodedChunkShims();
try {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await measure(scenario);
    results.push(result);
    console.info(
      `${result.name.padEnd(40)} median=${result.medianMs.toFixed(3)}ms ` +
        `p95=${result.p95Ms.toFixed(3)}ms ${result.inputMbPerSec.toFixed(2)}MB/s ` +
        `output=${result.outputBytes}B process-heap=${result.peakProcessHeapMb.toFixed(2)}MB`,
    );
  }
  const fresh: Baseline = {
    generatedAt: new Date().toISOString(),
    runtime: `bun ${Bun.version}`,
    warmup: WARMUP,
    samples: SAMPLES,
    scenarios: results,
  };
  console.info(`checksum=${checksum}`);
  if (process.argv.includes('--check')) {
    const prior = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline;
    const failures = regressions(results, prior);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`REGRESSION: ${failure}`);
      process.exitCode = 1;
    } else {
      console.info(`no regression vs ${prior.generatedAt}`);
    }
  } else {
    console.info(`BASELINE_JSON=${JSON.stringify(fresh)}`);
  }
} finally {
  restore();
}
