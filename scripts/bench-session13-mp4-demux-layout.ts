#!/usr/bin/env bun
/** Fresh real-fixture benchmark for ADR-251's fused MP4 cold-demux layout scan. */

import { readFile } from 'node:fs/promises';
import type { ByteSource, PacketMetadata, TrackInfo } from '../src/contracts/driver.ts';
import { Mp4Driver } from '../src/drivers/mp4/mp4-driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 3;
const SAMPLES = 11;
const RANGE_LATENCY_MS = 3;
const CHECK = process.argv.includes('--check');

interface SubjectSpec {
  readonly path: string;
  readonly layout: 'faststart' | 'tail-moov';
  readonly maximumReads: number;
}

interface Sample {
  readonly elapsedMs: number;
  readonly reads: number;
  readonly rangeBytes: number;
  readonly packetCount: number;
  readonly checksum: number;
}

const SUBJECTS: readonly SubjectSpec[] = [
  {
    path: 'fixtures/media/bear-1280x720.mp4',
    layout: 'faststart',
    maximumReads: 1,
  },
  {
    path: 'fixtures/media/obs-remux-variable-aac.mp4',
    layout: 'tail-moov',
    maximumReads: 2,
  },
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

function checksumTable(tracks: readonly TrackInfo[], packets: readonly PacketMetadata[]): number {
  let checksum = tracks.length;
  for (const track of tracks) {
    checksum =
      (checksum +
        track.id * 17 +
        track.codec.length * 31 +
        Math.round((track.durationSec ?? 0) * 1_000) * 3) >>>
      0;
  }
  for (const packet of packets) {
    checksum =
      (checksum +
        packet.trackId * 13 +
        packet.sizeBytes * 3 +
        packet.ptsUs * 5 +
        packet.dtsUs * 7 +
        (packet.durationUs ?? 0) * 11 +
        (packet.keyframe ? 19 : 0)) >>>
      0;
  }
  return checksum;
}

function latencySource(
  bytes: Uint8Array,
  stats: { reads: number; rangeBytes: number },
): ByteSource & { readonly kind: 'url' } {
  return {
    kind: 'url',
    size: bytes.byteLength,
    stream(): ReadableStream<Uint8Array> {
      throw new Error('layout benchmark must stay range-backed');
    },
    async range(start, end): Promise<Uint8Array> {
      stats.reads++;
      stats.rangeBytes += end - start;
      await new Promise<void>((resolve) => setTimeout(resolve, RANGE_LATENCY_MS));
      return bytes.subarray(start, end);
    },
  };
}

async function sample(bytes: Uint8Array): Promise<Sample> {
  const stats = { reads: 0, rangeBytes: 0 };
  const started = Bun.nanoseconds();
  const demuxer = await Mp4Driver.demux(latencySource(bytes, stats));
  try {
    const packets = demuxer.packetTable?.();
    if (packets === undefined) throw new Error('progressive MP4 benchmark lost packetTable');
    return {
      elapsedMs: (Bun.nanoseconds() - started) / 1_000_000,
      reads: stats.reads,
      rangeBytes: stats.rangeBytes,
      packetCount: packets.length,
      checksum: checksumTable(demuxer.tracks, packets),
    };
  } finally {
    await demuxer.close();
  }
}

const results = [];
for (const subject of SUBJECTS) {
  const bytes = new Uint8Array(await readFile(subject.path));
  const truthDemuxer = await Mp4Driver.demux(fromBytes(bytes, { mime: 'video/mp4' }));
  const truthPackets = truthDemuxer.packetTable?.();
  if (truthPackets === undefined) throw new Error(`${subject.path} lost its packet table`);
  const truthChecksum = checksumTable(truthDemuxer.tracks, truthPackets);
  await truthDemuxer.close();

  for (let index = 0; index < WARMUP; index++) await sample(bytes);
  const samples: Sample[] = [];
  for (let index = 0; index < SAMPLES; index++) samples.push(await sample(bytes));
  for (const measured of samples) {
    if (measured.packetCount !== truthPackets.length || measured.checksum !== truthChecksum) {
      throw new Error(`${subject.path} packet truth changed during the layout benchmark`);
    }
    if (measured.reads > subject.maximumReads) {
      throw new Error(
        `${subject.path} used ${measured.reads} reads, expected <= ${subject.maximumReads}`,
      );
    }
    if (measured.rangeBytes >= bytes.byteLength) {
      throw new Error(`${subject.path} materialized payload bytes during metadata enumeration`);
    }
  }
  const medianMs = median(samples.map((measured) => measured.elapsedMs));
  if (CHECK && medianMs > 100) {
    throw new Error(
      `${subject.path} layout median ${medianMs.toFixed(3)}ms exceeds safety ceiling`,
    );
  }
  results.push({
    path: subject.path,
    layout: subject.layout,
    sourceBytes: bytes.byteLength,
    packetCount: truthPackets.length,
    warmup: WARMUP,
    samples: SAMPLES,
    injectedRangeLatencyMs: RANGE_LATENCY_MS,
    medianMs,
    sampleMs: samples.map((measured) => measured.elapsedMs),
    reads: samples.map((measured) => measured.reads),
    rangeBytes: samples.map((measured) => measured.rangeBytes),
    checksum: truthChecksum,
  });
}

console.info(JSON.stringify({ benchmark: 'session13-mp4-demux-layout', results }, null, 2));
