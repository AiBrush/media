#!/usr/bin/env bun
/** Product-only real-corpus benchmark for public prepared-array MOV mux fixed cost. */

import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import { mp4PacketInfoFromBytes, muxPreparedMp4PacketTracks } from '../src/api/mp4-prepared-mux.ts';
import type { PacketStreams } from '../src/api/types.ts';
import type {
  EncodedChunk,
  Packet,
  PacketInfoMetadata,
  TrackInfo,
} from '../src/contracts/driver.ts';
import { toStream } from '../src/sinks/sink.ts';

const WARMUP = 5;
const SAMPLES = 21;
const CHECK = process.argv.includes('--check');
const SUBJECTS = [
  'fixtures/media/movie_5.mp4',
  'fixtures/media/test.mp4',
  'fixtures/media/obs-remux-variable-aac.mp4',
  'fixtures/media/bear-1280x720.mp4',
  'fixtures/media/bear-rotate-90.mp4',
  '../media-test/fixtures/media/h264_1080p_30s.mp4',
] as const;

interface PreparedTrack {
  readonly track: TrackInfo;
  readonly packets: readonly Packet[];
}

interface Subject {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly tracks: readonly PreparedTrack[];
  readonly direct: Uint8Array;
}

function writableBytes(destination: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(destination)
    ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
    : new Uint8Array(destination);
}

function packetFromRow(row: PacketInfoMetadata, bytes: Uint8Array): Packet {
  if (row.offset === undefined || row.offset < 0 || row.size <= 0) {
    throw new Error('MOV fixed-cost benchmark requires valid packet offsets');
  }
  const data = bytes.subarray(row.offset, row.offset + row.size);
  if (data.byteLength !== row.size) throw new Error('packet offset escaped benchmark source');
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

async function subject(path: string): Promise<Subject> {
  const bytes = new Uint8Array(await readFile(path));
  const table = await mp4PacketInfoFromBytes(bytes, { includeOffsets: true });
  const tracks = table.tracks.map((track, trackIndex) => ({
    track,
    packets: table.packets
      .filter((row) => row.trackIndex === trackIndex)
      .map((row) => packetFromRow(row, bytes)),
  }));
  const nonempty = tracks.filter((entry) => entry.packets.length > 0);
  const direct = muxPreparedMp4PacketTracks({
    tracks: nonempty,
    container: 'mov',
    faststart: true,
  });
  return { path, bytes, tracks: nonempty, direct };
}

function arrayStreams(input: Subject): PacketStreams {
  return {
    tracks: input.tracks.map((entry) => ({
      track: entry.track,
      packetsArray: entry.packets,
    })),
  };
}

function streamStreams(input: Subject): PacketStreams {
  return {
    tracks: input.tracks.map((entry) => {
      let index = 0;
      return {
        track: entry.track,
        packets: new ReadableStream<Packet>({
          pull(controller): void {
            const packet = entry.packets[index];
            if (packet === undefined) {
              controller.close();
              return;
            }
            index++;
            controller.enqueue(packet);
          },
        }),
      };
    }),
  };
}

async function publicMux(streams: PacketStreams): Promise<Blob> {
  const output = await media.mux(streams, { container: 'mov', faststart: true });
  if (!(output instanceof Blob)) throw new Error('MOV fixed-cost benchmark expected a Blob');
  return output;
}

async function publicMuxStreamShape(streams: PacketStreams): Promise<{
  readonly chunks: number;
  readonly maxChunkBytes: number;
  readonly totalBytes: number;
}> {
  const output = await media.mux(streams, {
    container: 'mov',
    faststart: true,
    sink: toStream(),
  });
  if (!(output instanceof ReadableStream)) {
    throw new Error('MOV fixed-cost benchmark expected a ReadableStream');
  }
  const reader = output.getReader();
  let chunks = 0;
  let maxChunkBytes = 0;
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { chunks, maxChunkBytes, totalBytes };
      chunks++;
      maxChunkBytes = Math.max(maxChunkBytes, value.byteLength);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take median of empty samples');
  return value;
}

function checksum(bytes: Uint8Array): number {
  let value = bytes.byteLength;
  for (let index = 0; index < bytes.byteLength; index += 4093) {
    value = Math.imul(value ^ (bytes[index] ?? 0), 16_777_619) >>> 0;
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

const media = createMedia({ worker: false });
const inputs = await Promise.all(SUBJECTS.map(subject));
const results = [];
for (const input of inputs) {
  for (let index = 0; index < WARMUP; index++) {
    await publicMux(arrayStreams(input));
    await publicMux(streamStreams(input));
  }
  const arrayMs: number[] = [];
  const streamMs: number[] = [];
  const directMs: number[] = [];
  let outputChecksum = 0;
  for (let index = 0; index < SAMPLES; index++) {
    let started = Bun.nanoseconds();
    const arrayBlob = await publicMux(arrayStreams(input));
    arrayMs.push((Bun.nanoseconds() - started) / 1_000_000);
    const arrayOutput = new Uint8Array(await arrayBlob.arrayBuffer());
    if (!equalBytes(arrayOutput, input.direct)) {
      throw new Error(`${input.path}: public prepared-array MOV bytes differ from direct writer`);
    }
    outputChecksum = (outputChecksum + checksum(arrayOutput)) >>> 0;

    started = Bun.nanoseconds();
    const streamBlob = await publicMux(streamStreams(input));
    streamMs.push((Bun.nanoseconds() - started) / 1_000_000);
    const streamOutput = new Uint8Array(await streamBlob.arrayBuffer());
    if (!equalBytes(streamOutput, input.direct)) {
      throw new Error(`${input.path}: generic stream MOV bytes differ from direct writer`);
    }
    outputChecksum = (outputChecksum + checksum(streamOutput)) >>> 0;

    started = Bun.nanoseconds();
    const directOutput = muxPreparedMp4PacketTracks({
      tracks: input.tracks,
      container: 'mov',
      faststart: true,
    });
    directMs.push((Bun.nanoseconds() - started) / 1_000_000);
    if (!equalBytes(directOutput, input.direct)) {
      throw new Error(`${input.path}: repeated direct MOV bytes changed`);
    }
    outputChecksum = (outputChecksum + checksum(directOutput)) >>> 0;
  }
  const packets = input.tracks.reduce((total, entry) => total + entry.packets.length, 0);
  const arrayStreamShape = await publicMuxStreamShape(arrayStreams(input));
  const genericStreamShape = await publicMuxStreamShape(streamStreams(input));
  if (
    arrayStreamShape.totalBytes !== input.direct.byteLength ||
    genericStreamShape.totalBytes !== input.direct.byteLength
  ) {
    throw new Error(`${input.path}: stream-shape probe changed MOV output length`);
  }
  const result = {
    path: input.path,
    sourceBytes: input.bytes.byteLength,
    outputBytes: input.direct.byteLength,
    tracks: input.tracks.length,
    packets,
    arrayMedianMs: median(arrayMs),
    streamControlMedianMs: median(streamMs),
    directWriterMedianMs: median(directMs),
    arrayStreamShape,
    genericStreamShape,
    outputChecksum,
  };
  if (CHECK && result.arrayMedianMs > result.streamControlMedianMs * 1.2) {
    throw new Error(`${input.path}: prepared-array route regressed: ${JSON.stringify(result)}`);
  }
  results.push(result);
}

console.info(
  JSON.stringify(
    { benchmark: 'session13-mp4-public-fixed-cost', warmup: WARMUP, samples: SAMPLES, results },
    null,
    2,
  ),
);
