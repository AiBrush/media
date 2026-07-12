import { readFile } from 'node:fs/promises';
import {
  BACKPRESSURE_THRESHOLD,
  type CodecQueueEventTarget,
  submitAudioCodecInput,
  submitClosableAudioCodecInput,
} from '../src/codecs/webcodecs-audio.ts';
import { enumerateAdtsFrames } from '../src/drivers/adts/adts-driver.ts';

const WARMUP = 7;
const SAMPLES = 51;
const BATCHES = 2_000;

class ImmediateQueue extends EventTarget implements CodecQueueEventTarget {
  readonly queueSize = 0;
}

class BenchmarkFrame {
  closeCount = 0;

  close(): void {
    this.closeCount++;
  }
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample set');
  return value;
}

async function priorCadence(
  queue: ImmediateQueue,
  units: readonly { readonly timestampUs: number; readonly size: number }[],
): Promise<number> {
  let checksum = 0;
  for (const unit of units) {
    // This is the former transform cadence: even an empty queue awaited an already-resolved async drain
    // before native decode, then repeated the same resolved-promise turn before native encode.
    await Promise.resolve();
    checksum = (checksum + unit.timestampUs + unit.size + queue.queueSize) >>> 0;
    await Promise.resolve();
    checksum = (checksum ^ (unit.timestampUs + unit.size)) >>> 0;
  }
  return checksum;
}

async function currentCadence(
  queue: ImmediateQueue,
  units: readonly { readonly timestampUs: number; readonly size: number }[],
): Promise<{ readonly checksum: number; readonly closed: number }> {
  let checksum = 0;
  let closed = 0;
  for (const unit of units) {
    const decode = submitAudioCodecInput(
      queue,
      () => queue.queueSize,
      undefined,
      () => {
        checksum = (checksum + unit.timestampUs + unit.size + queue.queueSize) >>> 0;
      },
    );
    if (decode !== undefined) await decode;
    const frame = new BenchmarkFrame();
    const encode = submitClosableAudioCodecInput(
      queue,
      () => queue.queueSize,
      undefined,
      frame,
      () => {
        checksum = (checksum ^ (unit.timestampUs + unit.size)) >>> 0;
      },
    );
    if (encode !== undefined) await encode;
    if (frame.closeCount !== 1) throw new Error(`frame closed ${frame.closeCount} times`);
    closed += frame.closeCount;
  }
  return { checksum, closed };
}

const fixture = new Uint8Array(
  await readFile(new URL('../fixtures/media/sfx.adts', import.meta.url)),
);
const frames = enumerateAdtsFrames(fixture);
const units = frames.map((frame) => ({ timestampUs: frame.ptsUs, size: frame.size }));
const queue = new ImmediateQueue();
if (queue.queueSize >= BACKPRESSURE_THRESHOLD)
  throw new Error('benchmark queue must be unsaturated');

const priorTruth = await priorCadence(queue, units);
const currentTruth = await currentCadence(queue, units);
if (currentTruth.checksum !== priorTruth || currentTruth.closed !== units.length) {
  throw new Error('cadence benchmark truth mismatch');
}

for (let index = 0; index < WARMUP; index++) {
  await priorCadence(queue, units);
  await currentCadence(queue, units);
}

const priorSamples: number[] = [];
const currentSamples: number[] = [];
let checksum = 0;
for (let sample = 0; sample < SAMPLES; sample++) {
  for (const current of sample % 2 === 0 ? [false, true] : [true, false]) {
    const started = Bun.nanoseconds();
    for (let batch = 0; batch < BATCHES; batch++) {
      if (current) {
        const result = await currentCadence(queue, units);
        checksum = (checksum + result.checksum + result.closed) >>> 0;
      } else {
        checksum = (checksum + (await priorCadence(queue, units))) >>> 0;
      }
    }
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000 / BATCHES;
    (current ? currentSamples : priorSamples).push(elapsedMs);
  }
}

const priorMedianMs = median(priorSamples);
const currentMedianMs = median(currentSamples);
console.log(
  JSON.stringify({
    benchmark: 'session13-aac-opus-cadence',
    fixture: 'sfx.adts',
    inputBytes: fixture.byteLength,
    packets: units.length,
    durationUs: frames.reduce((total, frame) => total + frame.durationUs, 0),
    warmup: WARMUP,
    samples: SAMPLES,
    batchesPerSample: BATCHES,
    priorMedianMs,
    currentMedianMs,
    speedup: priorMedianMs / currentMedianMs,
    checksum,
  }),
);
