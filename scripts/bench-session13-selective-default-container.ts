#!/usr/bin/env bun
/** Fresh-process memory benchmark for query-selective vs register-all default container startup. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SAMPLES = 7;
const CHILD = process.argv[2] === '--child';
const WAV = fileURLToPath(
  new URL(
    '../../media-test/fixtures/media/scenarios/audio-dsp/throughput_decode_s24/02.wav',
    import.meta.url,
  ),
);
const OGG = fileURLToPath(
  new URL(
    '../../media-test/fixtures/media/scenarios/remux/opus_ogg_to_mkv/02.ogg',
    import.meta.url,
  ),
);

type Mode = 'selective' | 'register-all-control';
type Operation = 'wav-decode' | 'ogg-mkv';

interface ChildResult {
  readonly mode: Mode;
  readonly operation: Operation;
  readonly sourceBytes: number;
  readonly outputUnits: number;
  readonly checksum: string;
  readonly elapsedMs: number;
  readonly rssDeltaBytes: number;
  readonly heapDeltaBytes: number;
  readonly externalDeltaBytes: number;
  readonly postGcArrayBufferDeltaBytes: number;
  readonly peakArrayBufferDeltaBytes: number;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('cannot take median of empty values');
  return value;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
  }
}

function memoryDelta(
  after: NodeJS.MemoryUsage,
  before: NodeJS.MemoryUsage,
  field: keyof NodeJS.MemoryUsage,
): number {
  return after[field] - before[field];
}

class BenchmarkAudioData {
  readonly numberOfFrames: number;
  #data: ArrayBuffer | undefined;

  constructor(init: AudioDataInit) {
    this.numberOfFrames = init.numberOfFrames;
    const data = init.data;
    if (data instanceof ArrayBuffer) {
      this.#data = data;
    } else if (ArrayBuffer.isView(data) && data.buffer instanceof ArrayBuffer) {
      this.#data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } else {
      throw new Error('benchmark AudioData needs ArrayBuffer-backed input');
    }
  }

  bits(): Uint32Array {
    if (this.#data === undefined) throw new Error('closed benchmark AudioData');
    return new Uint32Array(this.#data);
  }

  close(): void {
    this.#data = undefined;
  }
}

function mix(hash: number, value: number): number {
  return Math.imul(hash ^ value, 16_777_619) >>> 0;
}

async function child(mode: Mode, operation: Operation): Promise<ChildResult> {
  Object.defineProperty(globalThis, 'AudioData', {
    configurable: true,
    value: BenchmarkAudioData,
  });
  const { createMedia } = await import('../src/api/create-media.ts');
  const media = createMedia({ worker: false });
  const source = new Uint8Array(await readFile(operation === 'wav-decode' ? WAV : OGG));
  await settle();
  const before = process.memoryUsage();
  let peakArrayBuffers = before.arrayBuffers;
  const started = Bun.nanoseconds();
  if (mode === 'register-all-control') await media.preload('probe');

  let outputUnits = 0;
  let checksum: string;
  if (operation === 'ogg-mkv') {
    const output = await media.remux(new Blob([source], { type: 'audio/ogg' }), { to: 'mkv' });
    if (!(output instanceof Blob)) throw new Error('Ogg->MKV benchmark expected Blob output');
    const bytes = new Uint8Array(await output.arrayBuffer());
    outputUnits = bytes.byteLength;
    checksum = createHash('sha256').update(bytes).digest('hex');
    peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers);
  } else {
    const streams = media.decode(new Blob([source], { type: 'audio/wav' }));
    const reader = streams.audio?.getReader();
    if (reader === undefined) throw new Error('WAV benchmark expected an audio stream');
    let hash = 2_166_136_261;
    try {
      for (;;) {
        const next = await reader.read();
        peakArrayBuffers = Math.max(peakArrayBuffers, process.memoryUsage().arrayBuffers);
        if (next.done) break;
        const frame = next.value as unknown as BenchmarkAudioData;
        outputUnits += frame.numberOfFrames;
        for (const value of frame.bits()) hash = mix(hash, value);
        frame.close();
      }
    } finally {
      reader.releaseLock();
    }
    checksum = hash.toString(16).padStart(8, '0');
  }
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
  await settle();
  const after = process.memoryUsage();
  return {
    mode,
    operation,
    sourceBytes: source.byteLength,
    outputUnits,
    checksum,
    elapsedMs,
    rssDeltaBytes: memoryDelta(after, before, 'rss'),
    heapDeltaBytes: memoryDelta(after, before, 'heapUsed'),
    externalDeltaBytes: memoryDelta(after, before, 'external'),
    postGcArrayBufferDeltaBytes: memoryDelta(after, before, 'arrayBuffers'),
    peakArrayBufferDeltaBytes: Math.max(0, peakArrayBuffers - before.arrayBuffers),
  };
}

if (CHILD) {
  const mode = process.argv[3] as Mode | undefined;
  const operation = process.argv[4] as Operation | undefined;
  if (
    (mode !== 'selective' && mode !== 'register-all-control') ||
    (operation !== 'wav-decode' && operation !== 'ogg-mkv')
  ) {
    throw new Error('invalid selective-default benchmark child arguments');
  }
  console.info(JSON.stringify(await child(mode, operation)));
} else {
  const results: ChildResult[] = [];
  for (const operation of ['wav-decode', 'ogg-mkv'] as const) {
    for (const mode of ['selective', 'register-all-control'] as const) {
      for (let sample = 0; sample < SAMPLES; sample++) {
        const childProcess = Bun.spawn(
          [process.execPath, import.meta.path, '--child', mode, operation],
          { stdout: 'pipe', stderr: 'inherit' },
        );
        const text = await new Response(childProcess.stdout).text();
        const status = await childProcess.exited;
        if (status !== 0) throw new Error(`${operation}/${mode} child exited ${status}`);
        results.push(JSON.parse(text) as ChildResult);
      }
    }
  }

  const rows = [];
  for (const operation of ['wav-decode', 'ogg-mkv'] as const) {
    const expected = results.find((result) => result.operation === operation);
    if (expected === undefined) throw new Error(`${operation} produced no samples`);
    for (const result of results.filter((sample) => sample.operation === operation)) {
      if (result.outputUnits !== expected.outputUnits || result.checksum !== expected.checksum) {
        throw new Error(`${operation} route changed output truth`);
      }
    }
    for (const mode of ['selective', 'register-all-control'] as const) {
      const samples = results.filter(
        (sample) => sample.operation === operation && sample.mode === mode,
      );
      rows.push({
        operation,
        mode,
        freshSamples: samples.length,
        sourceBytes: expected.sourceBytes,
        outputUnits: expected.outputUnits,
        checksum: expected.checksum,
        medianMs: median(samples.map((sample) => sample.elapsedMs)),
        medianRssDeltaBytes: median(samples.map((sample) => sample.rssDeltaBytes)),
        rssDeltaSamples: samples.map((sample) => sample.rssDeltaBytes),
        medianHeapDeltaBytes: median(samples.map((sample) => sample.heapDeltaBytes)),
        medianExternalDeltaBytes: median(samples.map((sample) => sample.externalDeltaBytes)),
        medianPeakArrayBufferDeltaBytes: median(
          samples.map((sample) => sample.peakArrayBufferDeltaBytes),
        ),
        postGcArrayBufferDeltaBytes: samples.map((sample) => sample.postGcArrayBufferDeltaBytes),
      });
    }
  }
  console.info(
    JSON.stringify(
      { benchmark: 'session13-selective-default-container', freshProcess: true, rows },
      null,
      2,
    ),
  );
}
