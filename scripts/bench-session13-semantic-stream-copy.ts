#!/usr/bin/env bun
/** Fresh multi-file product benchmark for ADR-263/281's source-aware semantic no-op convert route. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import type { PacketInfoMetadata, PacketInfoTable } from '../src/contracts/driver.ts';
import { Mp4Driver } from '../src/drivers/mp4/mp4-driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 3;
const SAMPLES = 21;
const MEMORY_SAMPLES = 3;
const CHECK = process.argv.includes('--check');
const SUBJECTS = [
  'fixtures/media/movie_5.mp4',
  'fixtures/media/obs-remux-variable-aac.mp4',
  'fixtures/media/bear-1280x720.mp4',
  'fixtures/media/h264.mp4',
  'fixtures/media/test.mp4',
] as const;

interface Sample {
  readonly elapsedMs: number;
  readonly outputBytes: number;
  readonly checksum: number;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('cannot take a median of no samples');
  return value;
}

function normalizedRows(
  rows: readonly PacketInfoMetadata[],
): readonly Omit<PacketInfoMetadata, 'offset'>[] {
  return rows.map(({ offset: _offset, ...row }) => row);
}

function payloadHashes(bytes: Uint8Array, rows: readonly PacketInfoMetadata[]): readonly string[] {
  return rows.map((row) => {
    if (row.offset === undefined) throw new Error('MP4 packet-info row must expose an offset');
    return createHash('sha256')
      .update(bytes.subarray(row.offset, row.offset + row.size))
      .digest('hex');
  });
}

async function packetInfo(bytes: Uint8Array): Promise<PacketInfoTable> {
  const inspect = Mp4Driver.packetInfo;
  if (inspect === undefined) throw new Error('MP4 must expose packetInfo');
  return inspect.call(Mp4Driver, fromBytes(bytes, { mime: 'video/mp4' }));
}

async function convert(
  source: Uint8Array | Blob,
  bytes: Uint8Array,
): Promise<{ readonly blob: Blob; readonly elapsedMs: number }> {
  const media = createMedia({ worker: false });
  const info = await media.probe(bytes);
  const video = info.tracks.find((track) => track.type === 'video');
  if (
    video?.width === undefined ||
    video.height === undefined ||
    video.rotation !== 0 ||
    !video.codec.toLowerCase().startsWith('avc1')
  ) {
    throw new Error('benchmark source must be an unrotated H.264 video with known coded geometry');
  }
  const started = Bun.nanoseconds();
  const output = await media.convert(source, {
    to: 'mp4',
    video: { codec: 'h264', width: video.width, height: video.height, rotate: 0 },
  });
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
  if (!(output instanceof Blob)) throw new Error('semantic copy benchmark expected Blob output');
  return { blob: output, elapsedMs };
}

const results = [];
for (const path of SUBJECTS) {
  const input = new Uint8Array(await readFile(path));
  const inputInfo = await packetInfo(input);
  const routes = [
    { route: 'blob-direct', source: new Blob([input], { type: 'video/mp4' }) },
    { route: 'owned-byte-control', source: input },
  ] as const;
  for (const route of routes) {
    for (let index = 0; index < WARMUP; index++) await convert(route.source, input);
    const samples: Sample[] = [];
    let truthOutput: Uint8Array | undefined;
    for (let index = 0; index < SAMPLES; index++) {
      const measured = await convert(route.source, input);
      const output = new Uint8Array(await measured.blob.arrayBuffer());
      truthOutput ??= output;
      samples.push({
        elapsedMs: measured.elapsedMs,
        outputBytes: output.byteLength,
        checksum: createHash('sha256').update(output).digest().readUInt32BE(0),
      });
    }
    if (truthOutput === undefined) throw new Error(`${path} produced no measured output`);
    const outputInfo = await packetInfo(truthOutput);
    if (
      JSON.stringify(normalizedRows(outputInfo.packets)) !==
      JSON.stringify(normalizedRows(inputInfo.packets))
    ) {
      throw new Error(`${path} changed packet timing/size/keyframe truth`);
    }
    const inputHashes = payloadHashes(input, inputInfo.packets);
    const outputHashes = payloadHashes(truthOutput, outputInfo.packets);
    if (JSON.stringify(outputHashes) !== JSON.stringify(inputHashes)) {
      throw new Error(`${path} changed encoded packet payload bytes`);
    }
    if (route.route === 'blob-direct' && !Buffer.from(truthOutput).equals(Buffer.from(input))) {
      throw new Error(`${path} Blob semantic no-op was not byte-identical`);
    }
    const medianMs = median(samples.map((sample) => sample.elapsedMs));
    if (CHECK && medianMs > 100) {
      throw new Error(
        `${path} semantic-copy median ${medianMs.toFixed(3)}ms exceeds safety ceiling`,
      );
    }
    Bun.gc(true);
    const baseline = process.memoryUsage();
    let peakRss = baseline.rss;
    let peakHeap = baseline.heapUsed;
    let peakArrayBuffers = baseline.arrayBuffers;
    let memoryChecksum = 0;
    const retainedOutputs: Blob[] = [];
    for (let index = 0; index < MEMORY_SAMPLES; index++) {
      const measured = await convert(route.source, input);
      retainedOutputs.push(measured.blob);
      memoryChecksum = (memoryChecksum + measured.blob.size) >>> 0;
      const usage = process.memoryUsage();
      peakRss = Math.max(peakRss, usage.rss);
      peakHeap = Math.max(peakHeap, usage.heapUsed);
      peakArrayBuffers = Math.max(peakArrayBuffers, usage.arrayBuffers);
    }
    results.push({
      path,
      route: route.route,
      sourceBytes: input.byteLength,
      packetCount: inputInfo.packets.length,
      warmup: WARMUP,
      samples: SAMPLES,
      medianMs,
      sampleMs: samples.map((sample) => sample.elapsedMs),
      outputBytes: samples.map((sample) => sample.outputBytes),
      checksum: samples.reduce((sum, sample) => (sum + sample.checksum) >>> 0, 0),
      memorySamples: MEMORY_SAMPLES,
      peakRssDeltaBytes: Math.max(0, peakRss - baseline.rss),
      peakHeapDeltaBytes: Math.max(0, peakHeap - baseline.heapUsed),
      peakArrayBuffersDeltaBytes: Math.max(0, peakArrayBuffers - baseline.arrayBuffers),
      memoryChecksum,
    });
  }
}

console.info(JSON.stringify({ benchmark: 'session13-semantic-stream-copy', results }, null, 2));
