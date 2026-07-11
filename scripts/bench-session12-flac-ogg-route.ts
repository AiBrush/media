#!/usr/bin/env bun
/** Fresh public-route benchmark for zero-config native FLAC -> Ogg packet copy (ADR-240). */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import type { Packet, PacketInfoMetadata } from '../src/contracts/driver.ts';
import { enumerateFlacFrames, parseFlac } from '../src/drivers/flac/flac-driver.ts';
import { oggPacketInfoTable, parseOgg } from '../src/drivers/ogg/ogg-driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const MEDIA_ROOT = `${ROOT}fixtures/media/`;
const WARMUP = 2;
const SAMPLES = 7;
const MEMORY_RUNS = 3;
const RETAINED_MEMORY_BOUND_BYTES = 64 * 1024 * 1024;
const ROUTES = ['remux', 'convert'] as const;
const INPUT_IDS = [
  'sfx.flac',
  'flac-08bit.flac',
  'flac-12bit.flac',
  'flac-24bit-hires.flac',
  'flac-5_1ch.flac',
] as const;

interface Input {
  readonly id: (typeof INPUT_IDS)[number];
  readonly bytes: Uint8Array;
}

interface BatchResult {
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly digest: string;
  readonly elapsedMs: number;
}

interface OggInput extends Input {
  readonly ogg: Uint8Array;
  readonly frames: ReturnType<typeof enumerateFlacFrames>;
}

interface DemuxBatchResult extends BatchResult {
  readonly discontiguousPackets: number;
}

interface MemoryResult {
  readonly peakProcessHeapBytes: number;
  readonly peakRssBytes: number;
  readonly retainedHeapBytes: number;
  readonly retainedRssBytes: number;
}

type Route = (typeof ROUTES)[number];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function bufferSourceBytes(source: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return new Uint8Array(source);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Independent Ogg page/lacing walk; reconstructs packets that cross non-payload page headers. */
function delaceOggPackets(bytes: Uint8Array): readonly Uint8Array[] {
  const packets: Uint8Array[] = [];
  let pending: number[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (
      offset + 27 > bytes.byteLength ||
      String.fromCharCode(...bytes.subarray(offset, offset + 4)) !== 'OggS' ||
      bytes[offset + 4] !== 0
    ) {
      throw new Error(`invalid Ogg page at byte ${offset}`);
    }
    const segmentCount = bytes[offset + 26] ?? 0;
    const lacingStart = offset + 27;
    const bodyStart = lacingStart + segmentCount;
    if (bodyStart > bytes.byteLength) throw new Error(`truncated Ogg lacing at byte ${offset}`);
    let bodyLength = 0;
    for (let index = 0; index < segmentCount; index += 1) {
      bodyLength += bytes[lacingStart + index] ?? 0;
    }
    const pageEnd = bodyStart + bodyLength;
    if (pageEnd > bytes.byteLength) throw new Error(`truncated Ogg page at byte ${offset}`);
    let payloadOffset = bodyStart;
    for (let index = 0; index < segmentCount; index += 1) {
      const lace = bytes[lacingStart + index] ?? 0;
      pending.push(...bytes.subarray(payloadOffset, payloadOffset + lace));
      payloadOffset += lace;
      if (lace < 255) {
        packets.push(Uint8Array.from(pending));
        pending = [];
      }
    }
    offset = pageEnd;
  }
  if (pending.length > 0) throw new Error('truncated Ogg packet at end of stream');
  return packets;
}

type CapturedChunkInit = {
  readonly type: EncodedAudioChunkType | EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration?: number | null;
  readonly data: AllowSharedBufferSource;
};

class CapturedEncodedChunk {
  readonly type: EncodedAudioChunkType | EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: CapturedChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#data = bufferSourceBytes(init.data).slice();
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    const bytes = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    bytes.set(this.#data);
  }
}

type HostChunkConstructor = typeof EncodedVideoChunk & typeof EncodedAudioChunk;

function installChunkConstructors(chunkConstructor: HostChunkConstructor): () => void {
  const videoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'EncodedVideoChunk');
  const audioDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'EncodedAudioChunk');
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    writable: true,
    value: chunkConstructor,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    writable: true,
    value: chunkConstructor,
  });
  return (): void => {
    if (videoDescriptor === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
    else Object.defineProperty(globalThis, 'EncodedVideoChunk', videoDescriptor);
    if (audioDescriptor === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    else Object.defineProperty(globalThis, 'EncodedAudioChunk', audioDescriptor);
  };
}

function installThrowingChunkConstructors(): () => void {
  class ThrowingEncodedChunk {
    constructor() {
      throw new Error('native FLAC-to-Ogg benchmark touched a host EncodedChunk constructor');
    }
  }
  return installChunkConstructors(ThrowingEncodedChunk as unknown as HostChunkConstructor);
}

function installCaptureChunkConstructors(): () => void {
  return installChunkConstructors(CapturedEncodedChunk as unknown as HostChunkConstructor);
}

function validateOutput(input: Input, output: Uint8Array): void {
  const sourceInfo = parseFlac(input.bytes);
  const sourceFrames = enumerateFlacFrames(input.bytes);
  const info = parseOgg(output);
  if (info.codec !== 'flac') throw new Error(`${input.id}: output codec is '${info.codec}'`);
  if (info.sampleRate !== sourceInfo.sampleRate || info.channels !== sourceInfo.channels) {
    throw new Error(`${input.id}: Ogg-FLAC layout changed`);
  }
  if (Math.round(info.durationSec * info.sampleRate) !== sourceInfo.totalSamples) {
    throw new Error(`${input.id}: Ogg granule does not preserve the FLAC sample total`);
  }

  const table = oggPacketInfoTable(output);
  const description = table.tracks[0]?.config?.description;
  if (description === undefined) throw new Error(`${input.id}: Ogg-FLAC STREAMINFO is missing`);
  const streamInfo = parseFlac(bufferSourceBytes(description));
  if (
    streamInfo.totalSamples !== sourceInfo.totalSamples ||
    streamInfo.bitsPerSample !== sourceInfo.bitsPerSample
  ) {
    throw new Error(`${input.id}: embedded FLAC STREAMINFO changed`);
  }

  const packets = delaceOggPackets(output).filter(
    (packet) => packet[0] === 0xff && ((packet[1] ?? 0) & 0xfc) === 0xf8,
  );
  if (packets.length !== sourceFrames.length) {
    throw new Error(`${input.id}: copied ${packets.length}/${sourceFrames.length} FLAC frames`);
  }
  for (let index = 0; index < packets.length; index += 1) {
    const packet = packets[index];
    const frame = sourceFrames[index];
    if (packet === undefined || frame === undefined)
      throw new Error(`${input.id}: missing frame ${index}`);
    if (!bytesEqual(packet, frame.data)) throw new Error(`${input.id}: frame ${index} changed`);
  }
  const frameSamples = sourceFrames.reduce((total, frame) => total + frame.samples, 0);
  if (frameSamples !== sourceInfo.totalSamples) {
    throw new Error(`${input.id}: native frame walk does not cover STREAMINFO total samples`);
  }
}

async function runBatch(inputs: readonly Input[], route: Route): Promise<BatchResult> {
  const media = createMedia();
  const digest = createHash('sha256');
  let inputBytes = 0;
  let outputBytes = 0;
  let elapsedMs = 0;
  for (const input of inputs) {
    const source = fromBytes(input.bytes, { mime: 'audio/flac' });
    const started = performance.now();
    const output =
      route === 'remux'
        ? await media.remux(source, { to: 'ogg' })
        : await media.convert(source, { to: 'ogg' });
    if (!(output instanceof Blob)) throw new Error(`${input.id}: benchmark expected Blob output`);
    const bytes = new Uint8Array(await output.arrayBuffer());
    elapsedMs += performance.now() - started;
    validateOutput(input, bytes);
    inputBytes += input.bytes.byteLength;
    outputBytes += bytes.byteLength;
    digest.update(bytes);
  }
  return { inputBytes, outputBytes, digest: digest.digest('hex'), elapsedMs };
}

async function benchmarkRoute(inputs: readonly Input[], route: Route): Promise<void> {
  for (let index = 0; index < WARMUP; index += 1) await runBatch(inputs, route);
  const samplesMs: number[] = [];
  const digests = new Set<string>();
  let inputBytes = 0;
  let outputBytes = 0;
  for (let index = 0; index < SAMPLES; index += 1) {
    const result = await runBatch(inputs, route);
    samplesMs.push(result.elapsedMs);
    inputBytes = result.inputBytes;
    outputBytes = result.outputBytes;
    digests.add(result.digest);
  }
  if (digests.size !== 1) throw new Error(`FLAC-to-Ogg ${route} output was not deterministic`);
  const medianMs = median(samplesMs);
  console.info(
    JSON.stringify({
      name: `public-native-flac-to-ogg-${route}`,
      fixtures: INPUT_IDS.length,
      warmup: WARMUP,
      samplesMs,
      medianMs,
      inputBytesPerSample: inputBytes,
      outputBytesPerSample: outputBytes,
      inputThroughputMBps: inputBytes / (medianMs / 1000) / 1_000_000,
      sha256: [...digests][0],
    }),
  );
}

async function authorOggInputs(inputs: readonly Input[]): Promise<readonly OggInput[]> {
  const media = createMedia();
  const outputs: OggInput[] = [];
  for (const input of inputs) {
    const output = await media.remux(fromBytes(input.bytes, { mime: 'audio/flac' }), { to: 'ogg' });
    if (!(output instanceof Blob)) throw new Error(`${input.id}: benchmark expected Blob output`);
    const ogg = new Uint8Array(await output.arrayBuffer());
    validateOutput(input, ogg);
    outputs.push({ ...input, ogg, frames: enumerateFlacFrames(input.bytes) });
  }
  return outputs;
}

async function capturedPacketPayloads(
  stream: ReadableStream<Packet>,
): Promise<readonly Uint8Array[]> {
  const reader = stream.getReader();
  const payloads: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return payloads;
      const payload = new Uint8Array(value.chunk.byteLength);
      value.chunk.copyTo(payload);
      payloads.push(payload);
    }
  } finally {
    reader.releaseLock();
  }
}

async function runDemuxBatch(inputs: readonly OggInput[]): Promise<DemuxBatchResult> {
  const media = createMedia();
  const digest = createHash('sha256');
  let inputBytes = 0;
  let outputBytes = 0;
  let elapsedMs = 0;
  let discontiguousPackets = 0;
  for (const input of inputs) {
    const started = performance.now();
    const demuxed = await media.demux(fromBytes(input.ogg, { mime: 'audio/ogg' }));
    let payloads: readonly Uint8Array[] = [];
    try {
      const track = demuxed.tracks.find((candidate) => candidate.codec === 'flac');
      if (track === undefined) throw new Error(`${input.id}: benchmark demux found no FLAC track`);
      const rows = (
        demuxed as typeof demuxed & {
          packetInfoTable?: () => readonly (PacketInfoMetadata & {
            readonly spans?: readonly { readonly offset: number; readonly size: number }[];
          })[];
        }
      ).packetInfoTable?.();
      discontiguousPackets +=
        rows?.filter((row) => row.offset === undefined && (row.spans?.length ?? 0) > 1).length ?? 0;
      payloads = await capturedPacketPayloads(demuxed.packets(track.id));
    } finally {
      await demuxed.close();
    }
    elapsedMs += performance.now() - started;

    if (payloads.length !== input.frames.length) {
      throw new Error(`${input.id}: demuxed ${payloads.length}/${input.frames.length} FLAC frames`);
    }
    for (let index = 0; index < input.frames.length; index += 1) {
      const payload = payloads[index];
      const frame = input.frames[index];
      if (payload === undefined || frame === undefined)
        throw new Error(`${input.id}: missing frame ${index}`);
      if (!bytesEqual(payload, frame.data))
        throw new Error(`${input.id}: demuxed frame ${index} changed`);
      digest.update(payload);
      outputBytes += payload.byteLength;
    }
    inputBytes += input.ogg.byteLength;
  }
  if (discontiguousPackets === 0)
    throw new Error('demux benchmark did not exercise a cross-page packet');
  return {
    inputBytes,
    outputBytes,
    digest: digest.digest('hex'),
    elapsedMs,
    discontiguousPackets,
  };
}

async function benchmarkDemux(inputs: readonly OggInput[]): Promise<void> {
  for (let index = 0; index < WARMUP; index += 1) await runDemuxBatch(inputs);
  const samplesMs: number[] = [];
  const digests = new Set<string>();
  let inputBytes = 0;
  let outputBytes = 0;
  let discontiguousPackets = 0;
  for (let index = 0; index < SAMPLES; index += 1) {
    const result = await runDemuxBatch(inputs);
    samplesMs.push(result.elapsedMs);
    inputBytes = result.inputBytes;
    outputBytes = result.outputBytes;
    discontiguousPackets = result.discontiguousPackets;
    digests.add(result.digest);
  }
  if (digests.size !== 1) throw new Error('cross-page Ogg demux output was not deterministic');
  const medianMs = median(samplesMs);
  console.info(
    JSON.stringify({
      name: 'public-ogg-flac-cross-page-demux',
      fixtures: INPUT_IDS.length,
      discontiguousPackets,
      warmup: WARMUP,
      samplesMs,
      medianMs,
      inputBytesPerSample: inputBytes,
      outputBytesPerSample: outputBytes,
      inputThroughputMBps: inputBytes / (medianMs / 1000) / 1_000_000,
      sha256: [...digests][0],
    }),
  );
}

async function measureDemuxMemory(inputs: readonly OggInput[]): Promise<MemoryResult> {
  Bun.gc(true);
  const before = process.memoryUsage();
  let peakProcessHeapBytes = before.heapUsed;
  let peakRssBytes = before.rss;
  for (let index = 0; index < MEMORY_RUNS; index += 1) {
    await runDemuxBatch(inputs);
    const sample = process.memoryUsage();
    peakProcessHeapBytes = Math.max(peakProcessHeapBytes, sample.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, sample.rss);
  }
  Bun.gc(true);
  const after = process.memoryUsage();
  if (peakProcessHeapBytes <= 0 || peakRssBytes <= 0) {
    throw new Error('cross-page demux process-memory samples must be positive');
  }
  const retainedHeapBytes = after.heapUsed - before.heapUsed;
  const retainedRssBytes = after.rss - before.rss;
  if (
    retainedHeapBytes > RETAINED_MEMORY_BOUND_BYTES ||
    retainedRssBytes > RETAINED_MEMORY_BOUND_BYTES
  ) {
    throw new Error(
      `cross-page demux retained too much memory: heap=${retainedHeapBytes}, rss=${retainedRssBytes}`,
    );
  }
  return { peakProcessHeapBytes, peakRssBytes, retainedHeapBytes, retainedRssBytes };
}

const inputs = await Promise.all(
  INPUT_IDS.map(
    async (id): Promise<Input> => ({
      id,
      bytes: new Uint8Array(await readFile(`${MEDIA_ROOT}${id}`)),
    }),
  ),
);
let oggInputs: readonly OggInput[] | undefined;
const restoreThrowing = installThrowingChunkConstructors();
try {
  for (const route of ROUTES) await benchmarkRoute(inputs, route);
  oggInputs = await authorOggInputs(inputs);
} finally {
  restoreThrowing();
}
if (oggInputs === undefined) throw new Error('FLAC-to-Ogg benchmark produced no demux inputs');

const restoreCapture = installCaptureChunkConstructors();
try {
  await benchmarkDemux(oggInputs);
  const memory = await measureDemuxMemory(oggInputs);
  console.info(
    JSON.stringify({
      name: 'public-ogg-flac-cross-page-demux-memory',
      runs: MEMORY_RUNS,
      retainedMemoryBoundBytes: RETAINED_MEMORY_BOUND_BYTES,
      ...memory,
    }),
  );
} finally {
  restoreCapture();
}
