#!/usr/bin/env bun
/** General packet-count crossover benchmark for multitrack MP4 packet-array routing. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDrainTaskGroup, drainEncoderToMuxer } from '../src/api/codec-pipeline.ts';
import {
  mp4PacketInfoFromBytes,
  muxPreparedMp4PacketTracksStream,
} from '../src/api/mp4-prepared-mux.ts';
import { muxPacketStreams } from '../src/api/mux-packet-streams.ts';
import type { PacketStreams } from '../src/api/types.ts';
import type {
  EncodedChunk,
  Packet,
  PacketInfoMetadata,
  TrackInfo,
} from '../src/contracts/driver.ts';
import { adtsPacketInfoFromBytes } from '../src/drivers/adts/adts-driver.ts';
import { Mp4Muxer } from '../src/drivers/mp4/mux.ts';
import { materialize, toBlob } from '../src/sinks/sink.ts';

const WARMUP = 5;
const SAMPLES = 15;
const CHECK = process.argv.includes('--check');
const PACKET_COUNTS = [2, 8, 16, 32, 64, 256, 512, 1_024, 2_048] as const;

function bytesOf(destination: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(destination)
    ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
    : new Uint8Array(destination);
}

function encodedChunk(
  data: Uint8Array,
  timestamp: number,
  duration: number | undefined,
  keyframe: boolean,
): EncodedChunk {
  return {
    byteLength: data.byteLength,
    timestamp,
    duration: duration ?? null,
    type: keyframe ? 'key' : 'delta',
    copyTo(destination: AllowSharedBufferSource): void {
      bytesOf(destination).set(data);
    },
  } as EncodedChunk;
}

function packet(row: PacketInfoMetadata, data: Uint8Array, timeOffsetUs = 0): Packet {
  const ptsUs = row.ptsUs + timeOffsetUs;
  const dtsUs = row.dtsUs + timeOffsetUs;
  return {
    chunk: encodedChunk(data, ptsUs, row.durationUs, row.keyframe),
    data,
    dtsUs,
    sizeBytes: data.byteLength,
  };
}

function cycleSpan(rows: readonly PacketInfoMetadata[]): number {
  let endUs = 0;
  for (const row of rows) endUs = Math.max(endUs, row.dtsUs + (row.durationUs ?? 0));
  if (endUs <= 0) throw new Error('cannot repeat a packet table without positive duration');
  return endUs;
}

function repeatPackets(
  rows: readonly PacketInfoMetadata[],
  source: Uint8Array,
  count: number,
): Packet[] {
  const spanUs = cycleSpan(rows);
  const packets: Packet[] = [];
  for (let index = 0; index < count; index++) {
    const row = rows[index % rows.length];
    if (row === undefined || row.offset === undefined) {
      throw new Error('packet-array crossover benchmark needs byte offsets');
    }
    const cycle = Math.floor(index / rows.length);
    packets.push(packet(row, source.subarray(row.offset, row.offset + row.size), cycle * spanUs));
  }
  return packets;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take median of empty samples');
  return value;
}

async function blobBytes(output: Blob): Promise<Uint8Array> {
  return new Uint8Array(await output.arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const videoSource = new Uint8Array(await readFile('fixtures/media/obs-remux-variable-aac.mp4'));
const videoTable = await mp4PacketInfoFromBytes(videoSource, { includeOffsets: true });
const videoTrackIndex = videoTable.tracks.findIndex((track) => track.mediaType === 'video');
const sourceVideoTrack = videoTable.tracks[videoTrackIndex];
if (sourceVideoTrack === undefined) throw new Error('crossover benchmark has no H.264 video track');
const videoRows = videoTable.packets.filter((row) => row.trackIndex === videoTrackIndex);

const audioSource = new Uint8Array(
  await readFile('fixtures/media-derived/adts/speech-vbr-long-64s-mono.aac'),
);
const audioTable = adtsPacketInfoFromBytes(audioSource);
const sourceAudioTrack = audioTable.tracks[0];
if (sourceAudioTrack === undefined) throw new Error('crossover benchmark has no AAC audio track');
const audioRows = audioTable.packets;

const maximumPackets = PACKET_COUNTS.at(-1);
if (maximumPackets === undefined)
  throw new Error('crossover benchmark needs packet-count subjects');
const maximumVideoPackets = Math.ceil(maximumPackets * 0.4);
const maximumAudioPackets = maximumPackets - maximumVideoPackets;
const allVideoPackets = repeatPackets(videoRows, videoSource, maximumVideoPackets);
const allAudioPackets = repeatPackets(audioRows, audioSource, maximumAudioPackets);
const videoTrack: TrackInfo = {
  ...sourceVideoTrack,
  durationSec:
    (cycleSpan(videoRows) * Math.ceil(maximumVideoPackets / videoRows.length)) / 1_000_000,
};
const audioTrack: TrackInfo = {
  ...sourceAudioTrack,
  durationSec:
    (cycleSpan(audioRows) * Math.ceil(maximumAudioPackets / audioRows.length)) / 1_000_000,
};
function inputs(packetCount: number): {
  readonly streams: PacketStreams;
  readonly tracks: readonly [
    { readonly track: TrackInfo; readonly packets: readonly Packet[] },
    { readonly track: TrackInfo; readonly packets: readonly Packet[] },
  ];
} {
  const videoCount = Math.ceil(packetCount * 0.4);
  const audioCount = packetCount - videoCount;
  const videoPackets = allVideoPackets.slice(0, videoCount);
  const audioPackets = allAudioPackets.slice(0, audioCount);
  return {
    streams: {
      video: { track: videoTrack, packetsArray: videoPackets },
      audio: { track: audioTrack, packetsArray: audioPackets },
    },
    tracks: [
      { track: videoTrack, packets: videoPackets },
      { track: audioTrack, packets: audioPackets },
    ],
  };
}

async function generic(packetCount: number): Promise<Blob> {
  const controller = new AbortController();
  const muxer = new Mp4Muxer({ container: 'mp4', faststart: true });
  const group = createDrainTaskGroup(controller.signal);
  try {
    const drains = muxPacketStreams(inputs(packetCount).streams).map((input) =>
      drainEncoderToMuxer(input.packets, muxer, input.track, group.signal),
    );
    await group.run(drains);
    await muxer.finalize();
  } finally {
    group.dispose();
  }
  const output = await materialize(toBlob(), muxer.output, {
    signal: controller.signal,
    mime: 'video/mp4',
  });
  if (!(output instanceof Blob)) throw new Error('generic mux did not return a Blob');
  return output;
}

async function prepared(packetCount: number): Promise<Blob> {
  const signal = new AbortController().signal;
  const output = await materialize(
    toBlob(),
    muxPreparedMp4PacketTracksStream({
      tracks: inputs(packetCount).tracks,
      container: 'mp4',
      faststart: true,
    }),
    { signal, mime: 'video/mp4' },
  );
  if (!(output instanceof Blob)) throw new Error('prepared mux did not return a Blob');
  return output;
}

const results = [];
for (const packetCount of PACKET_COUNTS) {
  const genericTruth = await blobBytes(await generic(packetCount));
  const preparedTruth = await blobBytes(await prepared(packetCount));
  if (!Buffer.from(genericTruth).equals(Buffer.from(preparedTruth))) {
    throw new Error(`${packetCount} packet generic/prepared output mismatch`);
  }
  for (let index = 0; index < WARMUP; index++) {
    await generic(packetCount);
    await prepared(packetCount);
  }
  const genericMs: number[] = [];
  const preparedMs: number[] = [];
  let checksum = 0;
  for (let index = 0; index < SAMPLES; index++) {
    let started = Bun.nanoseconds();
    checksum += (await generic(packetCount)).size;
    genericMs.push((Bun.nanoseconds() - started) / 1_000_000);
    started = Bun.nanoseconds();
    checksum += (await prepared(packetCount)).size;
    preparedMs.push((Bun.nanoseconds() - started) / 1_000_000);
  }
  const genericMedianMs = median(genericMs);
  const preparedMedianMs = median(preparedMs);
  if (CHECK && preparedMedianMs > genericMedianMs * 1.25) {
    throw new Error(`${packetCount} packet prepared path regressed by more than 25%`);
  }
  results.push({
    packetCount,
    videoPackets: Math.ceil(packetCount * 0.4),
    audioPackets: packetCount - Math.ceil(packetCount * 0.4),
    warmup: WARMUP,
    samples: SAMPLES,
    genericMedianMs,
    preparedMedianMs,
    speedup: genericMedianMs / preparedMedianMs,
    outputBytes: genericTruth.byteLength,
    sha256: sha256(genericTruth),
    checksum,
  });
}

console.info(
  JSON.stringify({ benchmark: 'session13-mp4-multitrack-array-crossover', results }, null, 2),
);
