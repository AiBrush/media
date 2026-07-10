#!/usr/bin/env bun
/**
 * Session 11 Matroska packet-table benchmark. Parses every rotated H.264/MKV subject from a fresh byte
 * view, covering global order, CodecDelay, SPS reorder-depth/DTS synthesis, and attached-picture rows.
 */

import { readFile } from 'node:fs/promises';
import { parseWebm, webmPacketPayloadInfoFromBytes } from '../src/drivers/webm/webm-driver.ts';

const WARMUP = 2;
const SAMPLES = 9;
const CORPUS = new URL('../../media-test/media-browser-test/fixtures/media/', import.meta.url)
  .pathname;
const SUBJECTS = [
  'h264_in_mkv.mkv',
  'scenarios/demux/h264_in_mkv/01.mkv',
  'scenarios/demux/h264_in_mkv/02.mkv',
  'scenarios/demux/h264_in_mkv/03.mkv',
] as const;

interface Subject {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly destroyedHeader: Uint8Array;
  readonly destroyedCluster: Uint8Array;
}

interface Sample {
  readonly elapsedMs: number;
  readonly checksum: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

function parseBatch(subjects: readonly Subject[]): Sample {
  const started = performance.now();
  let checksum = 0;
  for (const subject of subjects) {
    // A fresh view proves the parser retains no previous per-input state while avoiding disk-cache noise.
    const table = webmPacketPayloadInfoFromBytes(subject.bytes.slice());
    checksum = (checksum + table.tracks.length * 131 + table.packets.length * 257) >>> 0;
    for (const packet of table.packets) {
      checksum =
        (checksum +
          packet.trackIndex * 17 +
          packet.size * 31 +
          packet.ptsUs +
          packet.dtsUs +
          (packet.keyframe ? 1 : 0)) >>>
        0;
    }
    try {
      parseWebm(subject.destroyedHeader.slice());
      throw new Error(`${subject.name}: destroyed EBML header was accepted`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('EBML header')) throw error;
      checksum = (checksum + error.message.length * 19) >>> 0;
    }
    try {
      webmPacketPayloadInfoFromBytes(subject.destroyedCluster.slice());
      throw new Error(`${subject.name}: destroyed Cluster header was accepted`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('no media blocks')) throw error;
      checksum = (checksum + error.message.length * 23) >>> 0;
    }
  }
  return { elapsedMs: performance.now() - started, checksum };
}

async function main(): Promise<void> {
  const subjects = await Promise.all(
    SUBJECTS.map(async (name): Promise<Subject> => {
      const bytes = new Uint8Array(await readFile(`${CORPUS}${name}`));
      const destroyedHeader = bytes.slice();
      destroyedHeader[0] = 0x1b;
      const destroyedCluster = bytes.slice();
      const clusterId = [0x1f, 0x43, 0xb6, 0x75] as const;
      let clusterCount = 0;
      for (let index = 0; index + clusterId.length <= destroyedCluster.byteLength; index++) {
        if (clusterId.every((value, offset) => destroyedCluster[index + offset] === value)) {
          destroyedCluster.fill(0, index, index + clusterId.length);
          clusterCount += 1;
          index += clusterId.length - 1;
        }
      }
      if (clusterCount === 0) throw new Error(`${name}: no Cluster`);
      return { name, bytes, destroyedHeader, destroyedCluster };
    }),
  );
  const timings: number[] = [];
  let checksum = 0;
  for (let index = 0; index < WARMUP + SAMPLES; index++) {
    const sample = parseBatch(subjects);
    checksum = (checksum + sample.checksum) >>> 0;
    if (index >= WARMUP) timings.push(sample.elapsedMs);
  }
  const before = process.memoryUsage().rss;
  const memorySample = parseBatch(subjects);
  const peakMemoryMb = Math.max(0, process.memoryUsage().rss - before) / (1024 * 1024);
  checksum = (checksum + memorySample.checksum) >>> 0;
  console.info(
    `Session 11 Matroska packet table — ${subjects.length} rotated files; ` +
      `median=${median(timings).toFixed(3)} ms; peakRSS+=${peakMemoryMb.toFixed(2)} MiB; ` +
      `checksum=${checksum}; samples=[${timings.map((ms) => ms.toFixed(3)).join(', ')}]`,
  );
}

await main();
