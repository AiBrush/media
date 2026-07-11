#!/usr/bin/env bun
/** Fresh multi-sample benchmark for Session 12 aliases, 188/192/204 sniffing, and direct AES-128. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import type { Container } from '../src/api/types.ts';
import { MpegTsDriver } from '../src/drivers/mpegts/mpegts-driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const HLS_ROOT = `${ROOT}fixtures/media-derived/hls-aes128/`;
const DERIVED_ROOT = `${ROOT}fixtures/media-derived/`;
const KEY_HEX = '8f2b64a103e75cd94e12bb07f388916c';
const WARMUP = 2;
const SAMPLES = 7;
const TS_PACKET_BYTES = 188;

interface AesInput {
  readonly path: string;
  readonly mime: 'video/mp2t' | 'audio/aac';
  readonly iv: string;
  bytes?: Uint8Array;
}

interface AliasInput {
  readonly path: string;
  readonly mime: 'video/mp2t' | 'audio/aac';
  readonly to: Container;
  bytes?: Uint8Array;
}

const AES_INPUTS: AesInput[] = [
  ...Array.from(
    { length: 6 },
    (_, index): AesInput => ({
      path: `ffmpeg-explicit-seq47/seg0${47 + index}.ts`,
      mime: 'video/mp2t',
      iv: '0000000000000000000000000000002f',
    }),
  ),
  ...Array.from(
    { length: 6 },
    (_, index): AesInput => ({
      path: `audio-adts/seg00${index}.aac`,
      mime: 'audio/aac',
      iv: index.toString(16).padStart(32, '0'),
    }),
  ),
];

const ALIAS_INPUTS: AliasInput[] = [
  { path: 'mpegts/aac_22k_long.m2t', mime: 'video/mp2t', to: 'm2ts' },
  { path: 'mpegts/aac_44k_multi.m2t', mime: 'video/mp2t', to: 'mts' },
  { path: 'mpegts/aac_48k_split.m2t', mime: 'video/mp2t', to: 'mpegts' },
  { path: 'hls-aes128/audio-adts/clear000.aac', mime: 'audio/aac', to: 'aac' },
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function asBytes(output: unknown): Promise<Uint8Array> {
  if (!(output instanceof Blob)) throw new Error('benchmark expected a Blob output');
  return new Uint8Array(await output.arrayBuffer());
}

function updateChecksum(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  hash.update(bytes);
  hash.update(Uint8Array.of(bytes.byteLength & 0xff, (bytes.byteLength >>> 8) & 0xff));
}

async function loadInputs(): Promise<void> {
  await Promise.all(
    AES_INPUTS.map(async (input) => {
      input.bytes = new Uint8Array(await readFile(`${HLS_ROOT}${input.path}`));
    }),
  );
  await Promise.all(
    ALIAS_INPUTS.map(async (input) => {
      input.bytes = new Uint8Array(await readFile(`${DERIVED_ROOT}${input.path}`));
    }),
  );
}

async function decryptBatch(): Promise<{ readonly bytes: number; readonly digest: string }> {
  const media = createMedia();
  const hash = createHash('sha256');
  let bytes = 0;
  for (const input of AES_INPUTS) {
    if (input.bytes === undefined) throw new Error(`unloaded AES input ${input.path}`);
    const output = await asBytes(
      await media.decrypt(fromBytes(input.bytes, { mime: input.mime }), {
        scheme: 'hls-aes128',
        keys: { key: KEY_HEX, iv: input.iv },
      }),
    );
    bytes += input.bytes.byteLength;
    updateChecksum(hash, output);
  }
  return { bytes, digest: hash.digest('hex') };
}

async function aliasBatch(): Promise<{ readonly bytes: number; readonly digest: string }> {
  const media = createMedia();
  const hash = createHash('sha256');
  let bytes = 0;
  for (const input of ALIAS_INPUTS) {
    if (input.bytes === undefined) throw new Error(`unloaded alias input ${input.path}`);
    const output = await asBytes(
      await media.remux(fromBytes(input.bytes, { mime: input.mime }), { to: input.to }),
    );
    bytes += input.bytes.byteLength;
    updateChecksum(hash, output);
  }
  return { bytes, digest: hash.digest('hex') };
}

function asM2ts(source: Uint8Array): Uint8Array {
  const packets = Math.floor(source.byteLength / TS_PACKET_BYTES);
  const output = new Uint8Array(packets * 192);
  for (let index = 0; index < packets; index += 1) {
    const start = index * 192;
    output[start + 3] = index & 0xff;
    output.set(source.subarray(index * 188, (index + 1) * 188), start + 4);
  }
  return output;
}

function asRs204(source: Uint8Array): Uint8Array {
  const packets = Math.floor(source.byteLength / TS_PACKET_BYTES);
  const output = new Uint8Array(packets * 204);
  for (let index = 0; index < packets; index += 1) {
    output.set(source.subarray(index * 188, (index + 1) * 188), index * 204);
  }
  return output;
}

async function framingInputs(): Promise<readonly Uint8Array[]> {
  const source = new Uint8Array(await readFile(`${DERIVED_ROOT}h264_720p.head.ts`));
  const head = source.subarray(0, TS_PACKET_BYTES * 12);
  return [head, asM2ts(head), asRs204(head)];
}

async function timedBatch(
  name: string,
  run: () => Promise<{ readonly bytes: number; readonly digest: string }>,
): Promise<void> {
  for (let index = 0; index < WARMUP; index += 1) await run();
  const times: number[] = [];
  const digests = new Set<string>();
  let bytes = 0;
  for (let index = 0; index < SAMPLES; index += 1) {
    const start = performance.now();
    const result = await run();
    times.push(performance.now() - start);
    bytes = result.bytes;
    digests.add(result.digest);
  }
  if (digests.size !== 1) throw new Error(`${name} output was not deterministic`);
  const medianMs = median(times);
  console.info(
    JSON.stringify({
      name,
      warmup: WARMUP,
      samplesMs: times,
      medianMs,
      inputBytesPerSample: bytes,
      throughputMBps: bytes / (medianMs / 1000) / 1_000_000,
      sha256: [...digests][0],
    }),
  );
}

async function benchFraming(): Promise<void> {
  const variants = await framingInputs();
  const repeats = 2_000;
  const times: number[] = [];
  let matches = 0;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const start = performance.now();
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const head of variants) {
        if (MpegTsDriver.supports({ direction: 'demux', head })) matches += 1;
      }
    }
    times.push(performance.now() - start);
  }
  const expected = variants.length * repeats * SAMPLES;
  if (matches !== expected) throw new Error(`framing benchmark matched ${matches}/${expected}`);
  console.info(
    JSON.stringify({
      name: 'mpegts-188-192-204-sniff',
      samplesMs: times,
      medianMs: median(times),
      predicatesPerSample: variants.length * repeats,
      matches,
    }),
  );
}

await loadInputs();
await timedBatch('direct-hls-aes128-ts-adts-12-segments', decryptBatch);
await timedBatch('public-container-alias-native-remux', aliasBatch);
await benchFraming();
