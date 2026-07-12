#!/usr/bin/env bun
/** Fresh product benchmark for multipart same-layout WAV re-authoring (ADR-253). */

import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import {
  parseWavPcmData,
  planWavPcmCopy,
  rewriteWavPcmCopy,
  writeWavHeader,
} from '../src/drivers/wav/pcm.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 7;
const SAMPLES = 101;
const SOURCE = new URL('../fixtures/media/stereo-48000.wav', import.meta.url);
let sink = 0;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function mad(values: readonly number[]): number {
  const middle = median(values);
  return median(values.map((value) => Math.abs(value - middle)));
}

function fiveSecondStereoWav(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const parsed = parseWavPcmData(source);
  const repeats = 5;
  const payloadBytes = parsed.data.byteLength * repeats;
  const out = new Uint8Array(44 + payloadBytes);
  writeWavHeader(out, payloadBytes, 2, 48_000, 's16');
  for (let i = 0; i < repeats; i++) out.set(parsed.data, 44 + i * parsed.data.byteLength);
  return out;
}

function referenceBlob(bytes: Uint8Array): Blob {
  const rewritten = rewriteWavPcmCopy(bytes, 's16', 'le', 2, 48_000);
  if (rewritten === undefined) throw new Error('reference WAV rewrite unexpectedly declined');
  return new Blob([rewritten], { type: 'audio/wav' });
}

function multipartBlob(bytes: Uint8Array): Blob {
  const plan = planWavPcmCopy(bytes, 's16', 'le', 2, 48_000);
  if (plan === undefined) throw new Error('multipart WAV rewrite unexpectedly declined');
  if (!(plan.payload.buffer instanceof ArrayBuffer)) {
    throw new Error('benchmark fixture unexpectedly uses shared backing memory');
  }
  return new Blob([plan.header, plan.payload as Uint8Array<ArrayBuffer>], { type: 'audio/wav' });
}

function sampleSync(run: () => Blob): number {
  const started = Bun.nanoseconds();
  const output = run();
  sink = (sink + output.size) | 0;
  return (Bun.nanoseconds() - started) / 1_000_000;
}

const input = fiveSecondStereoWav(new Uint8Array(await readFile(SOURCE)));
const expected = new Uint8Array(await referenceBlob(input).arrayBuffer());
const planned = new Uint8Array(await multipartBlob(input).arrayBuffer());
if (!Buffer.from(planned).equals(Buffer.from(expected))) {
  throw new Error('multipart WAV output changed canonical bytes');
}

for (let i = 0; i < WARMUP; i++) {
  sampleSync(() => referenceBlob(input));
  sampleSync(() => multipartBlob(input));
}

const contiguousSamples: number[] = [];
const multipartSamples: number[] = [];
for (let i = 0; i < SAMPLES; i++) {
  if ((i & 1) === 0) {
    contiguousSamples.push(sampleSync(() => referenceBlob(input)));
    multipartSamples.push(sampleSync(() => multipartBlob(input)));
  } else {
    multipartSamples.push(sampleSync(() => multipartBlob(input)));
    contiguousSamples.push(sampleSync(() => referenceBlob(input)));
  }
}

const media = createMedia({ worker: false });
const publicRun = async (hinted: boolean): Promise<Blob> => {
  const output = await media.convert(
    hinted ? fromBytes(input, { mime: 'audio/wav' }) : fromBytes(input),
    {
      to: 'wav',
      audio: { codec: 'pcm-s16', channels: 2, sampleRate: 48_000 },
    },
  );
  if (!(output instanceof Blob)) throw new Error('public WAV identity benchmark expected Blob');
  return output;
};
await publicRun(true);
await publicRun(false);
const publicHintedSamples: number[] = [];
const publicUnhintedSamples: number[] = [];
for (let i = 0; i < SAMPLES; i++) {
  let started = Bun.nanoseconds();
  let output = await publicRun(true);
  sink = (sink + output.size) | 0;
  publicHintedSamples.push((Bun.nanoseconds() - started) / 1_000_000);
  started = Bun.nanoseconds();
  output = await publicRun(false);
  sink = (sink + output.size) | 0;
  publicUnhintedSamples.push((Bun.nanoseconds() - started) / 1_000_000);
}

const publicOutput = new Uint8Array(await (await publicRun(false)).arrayBuffer());
if (!Buffer.from(publicOutput).equals(Buffer.from(expected))) {
  throw new Error('public WAV identity output changed canonical bytes');
}

const contiguousMedian = median(contiguousSamples);
const multipartMedian = median(multipartSamples);
console.info(
  JSON.stringify(
    {
      fixture: SOURCE.pathname.split('/').at(-1),
      bytes: input.byteLength,
      sampleFrames: 240_000,
      channels: 2,
      warmup: WARMUP,
      samples: SAMPLES,
      contiguousThenBlob: {
        medianMs: contiguousMedian,
        madMs: mad(contiguousSamples),
        jsOutputAllocationBytes: input.byteLength,
      },
      multipartBlob: {
        medianMs: multipartMedian,
        madMs: mad(multipartSamples),
        ratio: contiguousMedian / multipartMedian,
        jsOutputAllocationBytes: 44,
      },
      publicConvertMultipart: {
        hinted: {
          medianMs: median(publicHintedSamples),
          madMs: mad(publicHintedSamples),
        },
        unhinted: {
          medianMs: median(publicUnhintedSamples),
          madMs: mad(publicUnhintedSamples),
        },
      },
      sink,
    },
    null,
    2,
  ),
);
