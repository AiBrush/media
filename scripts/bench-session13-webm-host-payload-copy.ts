#!/usr/bin/env bun
/** Exact H.264+Opus prepared-MKV payload ownership benchmark for ADR-257 investigation. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type PreparedWebmChunk,
  muxPreparedWebmChunkTracks,
  muxPreparedWebmPacketTracks,
} from '../src/api/flac-mkv-mux.ts';
import { mp4PacketInfoFromBytes } from '../src/api/mp4-prepared-mux.ts';
import type {
  EncodedChunk,
  Packet,
  PacketInfoMetadata,
  TrackInfo,
} from '../src/contracts/driver.ts';
import { oggPacketBytes, oggPacketInfoFromBytes } from '../src/drivers/ogg/ogg-driver.ts';

const ROOT = '../media-test/fixtures/media/scenarios/mux/swap_audio_video_with_opus_to_mkv/';
const WARMUP = 3;
const SAMPLES = 15;
const CHECK = process.argv.includes('--check');

function destinationBytes(destination: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(destination)
    ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
    : new Uint8Array(destination);
}

function chunk(
  timestampUs: number,
  durationUs: number | undefined,
  keyframe: boolean,
  data: Uint8Array,
): EncodedChunk {
  return {
    byteLength: data.byteLength,
    timestamp: timestampUs,
    duration: durationUs ?? null,
    type: keyframe ? 'key' : 'delta',
    copyTo(destination: AllowSharedBufferSource): void {
      destinationBytes(destination).set(data);
    },
  } as EncodedChunk;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take median of empty samples');
  return value;
}

const videoBytes = new Uint8Array(await readFile(`${ROOT}h264_1080p_30s.mp4`));
const videoTable = await mp4PacketInfoFromBytes(videoBytes, { includeOffsets: true });
const videoTrackIndex = videoTable.tracks.findIndex((track) => track.mediaType === 'video');
const videoTrack = videoTable.tracks[videoTrackIndex];
if (videoTrack === undefined) throw new Error('MKV payload benchmark has no H.264 track');
const videoRows = videoTable.packets.filter((row) => row.trackIndex === videoTrackIndex);

const audioBytes = new Uint8Array(await readFile(`${ROOT}opus.ogg`));
const audioTable = oggPacketInfoFromBytes(audioBytes);
const audioTrack = audioTable.tracks[0];
if (audioTrack === undefined) throw new Error('MKV payload benchmark has no Opus track');

function preparedChunk(row: PacketInfoMetadata, data: Uint8Array): PreparedWebmChunk {
  return {
    timestampUs: row.ptsUs,
    key: row.keyframe,
    data,
    dtsUs: row.dtsUs,
    ...(row.durationUs !== undefined ? { durationUs: row.durationUs } : {}),
  };
}

const chunkTracks: readonly [
  { readonly track: TrackInfo; readonly chunks: readonly PreparedWebmChunk[] },
  { readonly track: TrackInfo; readonly chunks: readonly PreparedWebmChunk[] },
] = [
  {
    track: videoTrack,
    chunks: videoRows.map((row) => {
      if (row.offset === undefined) throw new Error('MKV video packet lost its byte offset');
      return preparedChunk(row, videoBytes.subarray(row.offset, row.offset + row.size));
    }),
  },
  {
    track: audioTrack,
    chunks: audioTable.packets.map((row) => preparedChunk(row, oggPacketBytes(audioBytes, row))),
  },
];

const bareTracks = chunkTracks.map((entry) => ({
  track: entry.track,
  packets: entry.chunks.map((item) =>
    chunk(item.timestampUs, item.durationUs, item.key, item.data),
  ),
}));
const ownedTracks = chunkTracks.map((entry, trackIndex) => ({
  track: entry.track,
  packets: entry.chunks.map((item, itemIndex): Packet => {
    const hostChunk = bareTracks[trackIndex]?.packets[itemIndex];
    if (hostChunk === undefined) throw new Error('MKV benchmark lost a host chunk');
    return {
      chunk: hostChunk,
      data: item.data,
      sizeBytes: item.data.byteLength,
      ...(item.dtsUs !== undefined ? { dtsUs: item.dtsUs } : {}),
    };
  }),
}));

function writeBare(): Uint8Array {
  return muxPreparedWebmPacketTracks({ tracks: bareTracks, container: 'mkv' });
}

function writeOwned(): Uint8Array {
  return muxPreparedWebmPacketTracks({ tracks: ownedTracks, container: 'mkv' });
}

function writeViews(): Uint8Array {
  return muxPreparedWebmChunkTracks({ tracks: chunkTracks, container: 'mkv' });
}

const bareTruth = writeBare();
const ownedTruth = writeOwned();
const viewsTruth = writeViews();
if (
  !Buffer.from(bareTruth).equals(Buffer.from(ownedTruth)) ||
  !Buffer.from(bareTruth).equals(Buffer.from(viewsTruth))
) {
  throw new Error('prepared MKV payload ownership paths changed output bytes');
}

for (let index = 0; index < WARMUP; index++) {
  writeBare();
  writeOwned();
  writeViews();
}
const bareMs: number[] = [];
const ownedMs: number[] = [];
const viewsMs: number[] = [];
let checksum = 0;
for (let index = 0; index < SAMPLES; index++) {
  let started = Bun.nanoseconds();
  checksum += writeBare().byteLength;
  bareMs.push((Bun.nanoseconds() - started) / 1_000_000);
  started = Bun.nanoseconds();
  checksum += writeOwned().byteLength;
  ownedMs.push((Bun.nanoseconds() - started) / 1_000_000);
  started = Bun.nanoseconds();
  checksum += writeViews().byteLength;
  viewsMs.push((Bun.nanoseconds() - started) / 1_000_000);
}
const bareHostChunkMedianMs = median(bareMs);
const ownedPacketMedianMs = median(ownedMs);
const directViewMedianMs = median(viewsMs);
if (CHECK && directViewMedianMs > bareHostChunkMedianMs * 1.1) {
  throw new Error('direct prepared MKV payload views regressed');
}
console.info(
  JSON.stringify(
    {
      benchmark: 'session13-webm-host-payload-copy',
      videoPackets: chunkTracks[0].chunks.length,
      audioPackets: chunkTracks[1].chunks.length,
      outputBytes: bareTruth.byteLength,
      sha256: createHash('sha256').update(bareTruth).digest('hex'),
      warmup: WARMUP,
      samples: SAMPLES,
      bareHostChunkMedianMs,
      ownedPacketMedianMs,
      directViewMedianMs,
      hostCopyPenaltyMs: bareHostChunkMedianMs - directViewMedianMs,
      checksum,
    },
    null,
    2,
  ),
);
