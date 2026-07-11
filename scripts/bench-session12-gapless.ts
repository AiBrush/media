#!/usr/bin/env bun
/**
 * Session 12 AAC gapless benchmark. Freshly reads the exact public CC0 controls and the separate
 * native-gapless validation corpus, then runs setup and complete packet drains over warm multi-sample
 * passes. The checksum includes track gapless metadata and packet timing/geometry so a partial or
 * metadata-only shortcut cannot produce the benchmark result.
 */

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Packet, TrackInfo } from '../src/contracts/driver.ts';
import { Mp4Driver } from '../src/drivers/mp4/mp4-driver.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 2;
const SAMPLES = 7;
const MEDIA_ROOT = resolve(new URL('../../media-test/fixtures/media/', import.meta.url).pathname);
const PUBLIC_ROOT = resolve(`${MEDIA_ROOT}/scenarios/audio-dsp/edge_gapless_aac_decode`);
const NATIVE_ROOT = resolve(`${MEDIA_ROOT}/native-gapless-aac`);
const DEFAULT_SUBJECTS = [
  ...['01.mp4', '02.mp4', '03.mp4', '04.mp4', '05.mp4'].map((file) =>
    resolve(`${NATIVE_ROOT}/${file}`),
  ),
  ...['01.mp4', '02.mp4', '03.mp4', '04.mp4', '05.mp4'].map((file) =>
    resolve(`${PUBLIC_ROOT}/${file}`),
  ),
  resolve(`${MEDIA_ROOT}/gapless_aac.m4a`),
] as const;

interface Subject {
  readonly path: string;
  readonly label: string;
}

interface Sample {
  readonly elapsedMs: number;
  readonly checksum: number;
  readonly packets: number;
  readonly tracks: number;
}

interface FakeChunkInit {
  readonly type?: EncodedAudioChunkType;
  readonly timestamp: number;
  readonly duration?: number;
  readonly data: AllowSharedBufferSource;
}

class FakeEncodedChunk {
  readonly type: EncodedAudioChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;

  constructor(init: FakeChunkInit) {
    this.type = init.type ?? 'key';
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.byteLength = init.data.byteLength;
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

function checksumTrack(checksum: number, track: TrackInfo): number {
  const gapless = track.gapless !== undefined ? 17 : 29;
  return (
    (checksum +
      track.id * 31 +
      track.codec.length * 37 +
      Math.round((track.durationSec ?? 0) * 1_000) * 41 +
      gapless) >>>
    0
  );
}

function checksumPacket(checksum: number, packet: Packet): number {
  const chunk = packet.chunk as EncodedAudioChunk;
  return (
    (checksum +
      (packet.sizeBytes ?? chunk.byteLength) * 3 +
      chunk.timestamp * 5 +
      (packet.dtsUs ?? chunk.timestamp) * 7 +
      (chunk.duration ?? 0) * 11 +
      (chunk.type === 'key' ? 13 : 0)) >>>
    0
  );
}

async function runSample(subjects: readonly Subject[], drainPackets: boolean): Promise<Sample> {
  const started = performance.now();
  let checksum = 0;
  let packets = 0;
  let tracks = 0;
  for (const subject of subjects) {
    const bytes = new Uint8Array(await readFile(subject.path));
    const demuxer = await Mp4Driver.demux(fromBytes(bytes, { mime: 'audio/mp4' }));
    try {
      for (const track of demuxer.tracks) {
        tracks++;
        checksum = checksumTrack(checksum, track);
        if (!drainPackets) continue;
        const reader = demuxer.packets(track.id).getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            checksum = checksumPacket(checksum, next.value);
            packets++;
          }
        } finally {
          reader.releaseLock();
        }
      }
    } finally {
      await demuxer.close();
    }
  }
  return { elapsedMs: performance.now() - started, checksum, packets, tracks };
}

async function measure(
  subjects: readonly Subject[],
  drainPackets: boolean,
): Promise<{ readonly samples: readonly Sample[]; readonly checksum: number }> {
  const measured: Sample[] = [];
  let checksum = 0;
  let expectedChecksum: number | undefined;
  for (let index = 0; index < WARMUP + SAMPLES; index++) {
    const sample = await runSample(subjects, drainPackets);
    expectedChecksum ??= sample.checksum;
    if (sample.checksum !== expectedChecksum) {
      throw new Error(`unstable checksum ${sample.checksum} != ${expectedChecksum}`);
    }
    checksum = (checksum + sample.checksum) >>> 0;
    if (index >= WARMUP) measured.push(sample);
  }
  return { samples: measured, checksum };
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const paths = requested.length > 0 ? requested.map((path) => resolve(path)) : DEFAULT_SUBJECTS;
  const subjects: readonly Subject[] = paths.map((path) => ({ path, label: basename(path) }));
  const originalAudioChunk = globalThis.EncodedAudioChunk;
  const originalVideoChunk = globalThis.EncodedVideoChunk;
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    value: FakeEncodedChunk as unknown as typeof EncodedAudioChunk,
  });
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    value: FakeEncodedChunk as unknown as typeof EncodedVideoChunk,
  });
  try {
    const setup = await measure(subjects, false);
    const drain = await measure(subjects, true);
    const packetCount = drain.samples[0]?.packets;
    const trackCount = drain.samples[0]?.tracks;
    if (packetCount === undefined || trackCount === undefined) {
      throw new Error('gapless benchmark produced no measured sample');
    }
    console.info(
      `Session 12 AAC gapless — ${subjects.length} exact real files; ` +
        `warmup=${WARMUP}, samples=${SAMPLES}, tracks=${trackCount}, packets=${packetCount}`,
    );
    console.info(
      `setup median=${median(setup.samples.map((sample) => sample.elapsedMs)).toFixed(3)} ms; ` +
        `checksum=${setup.checksum}; ` +
        `samples=[${setup.samples.map((sample) => sample.elapsedMs.toFixed(3)).join(', ')}]`,
    );
    console.info(
      `complete packet drain median=${median(drain.samples.map((sample) => sample.elapsedMs)).toFixed(3)} ms; ` +
        `checksum=${drain.checksum}; ` +
        `samples=[${drain.samples.map((sample) => sample.elapsedMs.toFixed(3)).join(', ')}]`,
    );
  } finally {
    if (originalAudioChunk === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    else
      Object.defineProperty(globalThis, 'EncodedAudioChunk', {
        configurable: true,
        value: originalAudioChunk,
      });
    if (originalVideoChunk === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
    else
      Object.defineProperty(globalThis, 'EncodedVideoChunk', {
        configurable: true,
        value: originalVideoChunk,
      });
  }
}

await main();
