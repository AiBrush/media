#!/usr/bin/env bun
/**
 * Real-corpus WebM full-demux benchmark. The checksum covers packet count, byte sizes, timestamps,
 * DTS, keyframe flags, and payload bytes at deterministic sparse offsets so timing cannot be a no-op.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { webmPacketPayloadInfoFromBytes } from '../src/drivers/webm/webm-driver.ts';

const WARMUP = 3;
const SAMPLES = 15;
const SUBJECTS = [
  '../media-test/fixtures/media/scenarios/demux/vp9_1080p_10s/01.webm',
  '../media-test/fixtures/media/scenarios/demux/vp9_1080p_10s/02.webm',
  '../media-test/fixtures/media/scenarios/demux/vp9_1080p_10s/03.webm',
  '../media-test/fixtures/media/scenarios/demux/vp9_1080p_10s/vp9_1080p_10s.webm',
  '../media-test/fixtures/media/scenarios/demux/realworld_mdn_flower_webm/01.webm',
  '../media-test/fixtures/media/scenarios/demux/realworld_mdn_flower_webm/02.webm',
  '../media-test/fixtures/media/scenarios/demux/realworld_mdn_flower_webm/03.webm',
  '../media-test/fixtures/media/scenarios/demux/size_large_large_vp9_1080p_120s/large_vp9_1080p_120s.webm',
] as const;

interface Subject {
  readonly path: string;
  readonly bytes: Uint8Array;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take median of empty samples');
  return value;
}

function checksum(subject: Subject): { readonly packets: number; readonly sha256: string } {
  const table = webmPacketPayloadInfoFromBytes(subject.bytes);
  const hash = createHash('sha256');
  const header = new Uint32Array([
    subject.bytes.byteLength,
    table.tracks.length,
    table.packets.length,
  ]);
  hash.update(new Uint8Array(header.buffer));
  for (const packet of table.packets) {
    const meta = new Float64Array([
      packet.trackIndex,
      packet.size,
      packet.ptsUs,
      packet.dtsUs,
      packet.keyframe ? 1 : 0,
    ]);
    hash.update(new Uint8Array(meta.buffer));
    const step = Math.max(1, Math.floor(packet.data.byteLength / 17));
    for (let offset = 0; offset < packet.data.byteLength; offset += step) {
      hash.update(packet.data.subarray(offset, Math.min(offset + 1, packet.data.byteLength)));
    }
  }
  return { packets: table.packets.length, sha256: hash.digest('hex') };
}

const subjects: readonly Subject[] = await Promise.all(
  SUBJECTS.map(async (path) => ({ path, bytes: new Uint8Array(await readFile(path)) })),
);

const results = [];
for (const subject of subjects) {
  const truth = checksum(subject);
  for (let index = 0; index < WARMUP; index++) checksum(subject);
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index++) {
    const started = performance.now();
    const measured = checksum(subject);
    samples.push(performance.now() - started);
    if (measured.sha256 !== truth.sha256 || measured.packets !== truth.packets) {
      throw new Error(`${subject.path}: exact packet checksum changed during benchmark`);
    }
  }
  results.push({
    path: subject.path,
    sourceBytes: subject.bytes.byteLength,
    packets: truth.packets,
    medianMs: median(samples),
    samplesMs: samples,
    sha256: truth.sha256,
  });
}

console.info(
  JSON.stringify(
    { benchmark: 'session13-webm-demux-packet-table', WARMUP, SAMPLES, results },
    null,
    2,
  ),
);
