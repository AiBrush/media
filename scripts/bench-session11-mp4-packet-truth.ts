#!/usr/bin/env bun
/** Session 11 MP4 packet-truth benchmark: AVC slice classification + real MOV tmcd enumeration. */

import { readFile } from 'node:fs/promises';
import { h264AccessUnitIsKeyPicture } from '../src/drivers/mp4/h264-access-unit.ts';
import { Mp4Driver } from '../src/drivers/mp4/mp4-driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 3;
const SAMPLES = 9;
const CLASSIFICATIONS_PER_SAMPLE = 250_000;
const MOV_PATH = new URL('../fixtures/media-derived/mov-tmcd-copy.mov', import.meta.url).pathname;
const AVC_I = new Uint8Array([0, 0, 0, 2, 0x41, 0xb0]);
const AVC_P = new Uint8Array([0, 0, 0, 2, 0x41, 0xc0]);
const AVC_IDR = new Uint8Array([0, 0, 0, 1, 0x65]);

interface Sample {
  readonly elapsedMs: number;
  readonly checksum: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

async function runSample(mov: Uint8Array): Promise<Sample> {
  const packetInfo = Mp4Driver.packetInfo;
  if (packetInfo === undefined) throw new Error('MP4 packetInfo capability is missing');
  const started = performance.now();
  let checksum = 0;
  for (let index = 0; index < CLASSIFICATIONS_PER_SAMPLE; index++) {
    const accessUnit = index % 3 === 0 ? AVC_I : index % 3 === 1 ? AVC_P : AVC_IDR;
    if (h264AccessUnitIsKeyPicture(accessUnit, 4) === true) checksum++;
  }
  const table = await packetInfo(fromBytes(mov.slice(), { mime: 'video/quicktime' }));
  checksum =
    (checksum +
      table.tracks.length * 131 +
      table.packets.length * 257 +
      table.packets.reduce(
        (sum, packet) =>
          sum + packet.trackIndex * 17 + packet.size * 31 + (packet.keyframe ? 1 : 0),
        0,
      )) >>>
    0;
  return { elapsedMs: performance.now() - started, checksum };
}

async function main(): Promise<void> {
  const mov = new Uint8Array(await readFile(MOV_PATH));
  const timings: number[] = [];
  let checksum = 0;
  for (let index = 0; index < WARMUP + SAMPLES; index++) {
    const sample = await runSample(mov);
    checksum = (checksum + sample.checksum) >>> 0;
    if (index >= WARMUP) timings.push(sample.elapsedMs);
  }
  const before = process.memoryUsage().rss;
  const memorySample = await runSample(mov);
  checksum = (checksum + memorySample.checksum) >>> 0;
  const peakMemoryMb = Math.max(0, process.memoryUsage().rss - before) / (1024 * 1024);
  console.info(
    `Session 11 MP4 packet truth — ${CLASSIFICATIONS_PER_SAMPLE} AVC classifications + 232 real MOV packets; ` +
      `median=${median(timings).toFixed(3)} ms; peakRSS+=${peakMemoryMb.toFixed(2)} MiB; ` +
      `checksum=${checksum}; samples=[${timings.map((ms) => ms.toFixed(3)).join(', ')}]`,
  );
}

await main();
