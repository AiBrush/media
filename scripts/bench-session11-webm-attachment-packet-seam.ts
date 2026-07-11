#!/usr/bin/env bun
/**
 * Multi-sample public Matroska demux -> prepared packet mux benchmark on the real attachment-bearing
 * Session 11 corpus. Every emitted byte reaches a checksum sink; correctness is independently gated by
 * exact AttachedFile payload comparison and ffprobe in webm-attachment-packet-seam.test.ts.
 */

import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import type { PacketStreams } from '../src/api/types.ts';
import type { Packet } from '../src/contracts/driver.ts';
import { WebmModule } from '../src/drivers/webm/webm-driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 7;
const SAMPLES = 9;
const SUBJECTS = [
  'h264_in_mkv.mkv',
  'scenarios/metadata/write_mkv_tags/01.mkv',
  'scenarios/metadata/write_mkv_tags/02.mkv',
  'scenarios/metadata/write_mkv_tags/03.mkv',
  'av1_720p_5s.webm',
  'tiny_vp9_360p_2s.webm',
  'video_1x1.webm',
  'realworld_mdn_flower.webm',
] as const;
const MEDIA_ROOT = new URL('../../media-test/fixtures/media/', import.meta.url).pathname;

interface Subject {
  readonly id: string;
  readonly bytes: Uint8Array;
}

interface Sample {
  readonly elapsedMs: number;
  readonly checksum: number;
  readonly outputBytes: number;
  readonly peakRss: number;
}

class BenchEncodedChunk {
  readonly type: EncodedVideoChunkType | EncodedAudioChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: EncodedVideoChunkInit | EncodedAudioChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#data = ArrayBuffer.isView(init.data)
      ? new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength).slice()
      : new Uint8Array(init.data).slice();
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: BufferSource): void {
    const output = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    output.set(this.#data);
  }
}

function installEncodedChunkConstructors(): void {
  const chunkConstructor = BenchEncodedChunk as unknown as typeof EncodedVideoChunk &
    typeof EncodedAudioChunk;
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    value: chunkConstructor,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    value: chunkConstructor,
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

async function collectPackets(stream: ReadableStream<Packet>): Promise<Packet[]> {
  const reader = stream.getReader();
  const packets: Packet[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return packets;
      packets.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function outputBytes(
  output: Blob | ReadableStream<Uint8Array> | undefined,
): Promise<Uint8Array> {
  if (output instanceof Blob) return new Uint8Array(await output.arrayBuffer());
  if (!(output instanceof ReadableStream)) throw new Error('expected packet mux output');
  const reader = output.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

installEncodedChunkConstructors();
const media = createMedia().use(WebmModule);

async function run(subjects: readonly Subject[], sampleMemory = false): Promise<Sample> {
  const started = performance.now();
  let checksum = 0x811c9dc5;
  let outputBytesLength = 0;
  let peakRss = sampleMemory ? process.memoryUsage().rss : 0;
  const sampleRss = (): void => {
    if (sampleMemory) peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };
  for (const subject of subjects) {
    const demuxed = await media.demux(fromBytes(subject.bytes));
    sampleRss();
    try {
      const tracks = await Promise.all(
        demuxed.tracks
          .filter((track) => track.config !== undefined)
          .map(async (track) => ({
            track,
            packetsArray: await collectPackets(demuxed.packets(track.id)),
          })),
      );
      sampleRss();
      const streams: PacketStreams = { tracks };
      const output = await outputBytes(await media.mux(streams, { container: 'mkv' }));
      sampleRss();
      outputBytesLength += output.byteLength;
      for (const byte of output) checksum = Math.imul(checksum ^ byte, 0x01000193) >>> 0;
    } finally {
      await demuxed.close();
    }
  }
  return {
    elapsedMs: performance.now() - started,
    checksum,
    outputBytes: outputBytesLength,
    peakRss,
  };
}

const subjects = await Promise.all(
  SUBJECTS.map(
    async (id): Promise<Subject> => ({
      id,
      bytes: new Uint8Array(await readFile(`${MEDIA_ROOT}${id}`)),
    }),
  ),
);
const inputLength = subjects.reduce((total, subject) => total + subject.bytes.byteLength, 0);
const timings: number[] = [];
let checksum = 0;
let outputLength = 0;
for (let index = 0; index < WARMUP + SAMPLES; index++) {
  const sample = await run(subjects);
  checksum = (checksum + sample.checksum) >>> 0;
  outputLength = sample.outputBytes;
  if (index >= WARMUP) timings.push(sample.elapsedMs);
}

Bun.gc(true);
const rssBefore = process.memoryUsage().rss;
const memorySample = await run(subjects, true);
const peakMemoryMb = Math.max(0, memorySample.peakRss - rssBefore) / (1024 * 1024);
checksum = (checksum + memorySample.checksum) >>> 0;

console.info(
  `Session 11 Matroska attachment packet seam — files=${subjects.length}; input=${inputLength} bytes; ` +
    `output=${outputLength} bytes; median=${median(timings).toFixed(3)} ms; ` +
    `peakRSS+=${peakMemoryMb.toFixed(2)} MiB; checksum=${checksum}; ` +
    `samples=[${timings.map((time) => time.toFixed(3)).join(', ')}]`,
);
