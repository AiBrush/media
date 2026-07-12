#!/usr/bin/env bun
/** Fresh real-fixture benchmark for ADR-254's one-pass faststart moov writer. */

import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import { mp4PacketInfoFromBytes, muxPreparedMp4PacketTracks } from '../src/api/mp4-prepared-mux.ts';
import type { EncodedChunk, Packet, PacketInfoMetadata } from '../src/contracts/driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 10;
const SAMPLES = 101;
const COMBINED_SAMPLES = 31;
const CHECK = process.argv.includes('--check');
const source = new Uint8Array(await readFile('fixtures/media/obs-remux-variable-aac.mp4'));
const table = await mp4PacketInfoFromBytes(source, { includeOffsets: true });

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
    this.#data = writableBytes(init.data).slice();
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    writableBytes(destination).set(this.#data);
  }
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

function writableBytes(destination: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(destination)
    ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
    : new Uint8Array(destination);
}

function packet(row: PacketInfoMetadata): Packet {
  if (row.offset === undefined) throw new Error('MOV benchmark needs packet offsets');
  const data = source.subarray(row.offset, row.offset + row.size);
  const chunk = {
    byteLength: data.byteLength,
    timestamp: row.ptsUs,
    duration: row.durationUs ?? null,
    type: row.keyframe ? 'key' : 'delta',
    copyTo(destination: AllowSharedBufferSource): void {
      writableBytes(destination).set(data);
    },
  } as EncodedChunk;
  return { chunk, data, dtsUs: row.dtsUs, sizeBytes: row.size };
}

const tracks = table.tracks.map((track, trackIndex) => ({
  track,
  packets: table.packets.filter((row) => row.trackIndex === trackIndex).map(packet),
}));

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take median of empty samples');
  return value;
}

function write(faststart: boolean): number {
  return muxPreparedMp4PacketTracks({ tracks, container: 'mov', faststart }).byteLength;
}

for (let index = 0; index < WARMUP; index++) {
  write(true);
  write(false);
}

const faststartMs: number[] = [];
const nonFaststartMs: number[] = [];
let checksum = 0;
for (let index = 0; index < SAMPLES; index++) {
  let started = Bun.nanoseconds();
  checksum += write(true);
  faststartMs.push((Bun.nanoseconds() - started) / 1_000_000);
  started = Bun.nanoseconds();
  checksum += write(false);
  nonFaststartMs.push((Bun.nanoseconds() - started) / 1_000_000);
}

const result = {
  benchmark: 'session13-mp4-prepared-mov',
  fixture: 'fixtures/media/obs-remux-variable-aac.mp4',
  packets: table.packets.length,
  warmup: WARMUP,
  samples: SAMPLES,
  faststartMedianMs: median(faststartMs),
  nonFaststartMedianMs: median(nonFaststartMs),
  checksum,
};

const rotatedPath = 'fixtures/media/bear-rotate-90.mp4';
const rotated = new Uint8Array(await readFile(rotatedPath));
const media = createMedia({ worker: false });
const restore = installEncodedChunkShims();
const combinedFaststartMs: number[] = [];
const combinedNonFaststartMs: number[] = [];
let combinedChecksum = 0;
async function combinedRemux(faststart: boolean): Promise<number> {
  const output = await media.remux(fromBytes(rotated, { mime: 'video/mp4' }), {
    to: 'mov',
    faststart,
  });
  if (!(output instanceof Blob))
    throw new Error('combined MOV remux benchmark expected Blob output');
  return output.size;
}
try {
  for (let index = 0; index < WARMUP; index++) {
    await combinedRemux(true);
    await combinedRemux(false);
  }
  for (let index = 0; index < COMBINED_SAMPLES; index++) {
    let started = Bun.nanoseconds();
    combinedChecksum += await combinedRemux(true);
    combinedFaststartMs.push((Bun.nanoseconds() - started) / 1_000_000);
    started = Bun.nanoseconds();
    combinedChecksum += await combinedRemux(false);
    combinedNonFaststartMs.push((Bun.nanoseconds() - started) / 1_000_000);
  }
} finally {
  restore();
}

const combinedResult = {
  benchmark: 'session13-mp4-demux-remux-composition',
  fixture: rotatedPath,
  sourceBytes: rotated.byteLength,
  warmup: WARMUP,
  samples: COMBINED_SAMPLES,
  faststartMedianMs: median(combinedFaststartMs),
  nonFaststartMedianMs: median(combinedNonFaststartMs),
  checksum: combinedChecksum,
};
if (CHECK && result.faststartMedianMs > 20) {
  throw new Error(`faststart MOV benchmark exceeded safety ceiling: ${JSON.stringify(result)}`);
}
if (CHECK && combinedResult.faststartMedianMs > 20) {
  throw new Error(
    `combined demux/remux benchmark exceeded safety ceiling: ${JSON.stringify(combinedResult)}`,
  );
}
console.info(JSON.stringify({ writer: result, combined: combinedResult }, null, 2));
