#!/usr/bin/env bun
/** Terminal byte-collector benchmark for ADR-268's sole exact-owned chunk adoption. */

import { collect } from '../src/kernel/executor.ts';

const BYTES = 8 * 1024 * 1024;
const WARMUP = 3;
const SAMPLES = 21;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function mad(values: readonly number[]): number {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function streamFrom(chunk: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function copyingCollect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function measure(
  input: Uint8Array,
  run: (stream: ReadableStream<Uint8Array>) => Promise<Uint8Array>,
): Promise<{ readonly samplesMs: number[]; readonly output: Uint8Array }> {
  let output: Uint8Array = new Uint8Array(0);
  for (let iteration = 0; iteration < WARMUP; iteration++) output = await run(streamFrom(input));
  const samplesMs: number[] = [];
  for (let iteration = 0; iteration < SAMPLES; iteration++) {
    const started = Bun.nanoseconds();
    output = await run(streamFrom(input));
    samplesMs.push((Bun.nanoseconds() - started) / 1_000_000);
  }
  return { samplesMs, output };
}

function assertExact(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(
      `${label} produced ${actual.byteLength} bytes; expected ${expected.byteLength}`,
    );
  }
  for (let index = 0; index < expected.byteLength; index++) {
    if (actual[index] !== expected[index]) {
      throw new Error(`${label} changed byte ${index}`);
    }
  }
}

const input = new Uint8Array(BYTES);
for (let index = 0; index < input.byteLength; index++) input[index] = (index * 131 + 17) & 0xff;

const adopted = await measure(input, collect);
const copied = await measure(input, copyingCollect);
assertExact(adopted.output, input, 'adopted collector');
assertExact(copied.output, input, 'copying collector');
if (adopted.output.buffer !== input.buffer) {
  throw new Error('product collector did not adopt the exact-owned terminal chunk');
}
if (copied.output.buffer === input.buffer) {
  throw new Error('copying control unexpectedly retained the input buffer');
}

console.info(
  JSON.stringify(
    {
      bytes: BYTES,
      warmup: WARMUP,
      samples: SAMPLES,
      product: {
        medianMs: median(adopted.samplesMs),
        madMs: mad(adopted.samplesMs),
        outputAllocBytes: 0,
      },
      formerCopyingControl: {
        medianMs: median(copied.samplesMs),
        madMs: mad(copied.samplesMs),
        outputAllocBytes: BYTES,
      },
      exactBytes: true,
    },
    null,
    2,
  ),
);
