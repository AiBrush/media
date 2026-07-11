#!/usr/bin/env bun
/**
 * Session 11 MP4 demux benchmark. Measures public demux setup separately from full packet draining on
 * every huge/massive rotation, with fresh range-backed sources, checksum sinks, an independent RSS pass,
 * and a counted pass proving that driver-owned pull promises equal genuine packet-window range misses.
 */

import { open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { ByteSource, Packet, TrackInfo } from '../src/contracts/driver.ts';
import { Mp4Driver } from '../src/drivers/mp4/mp4-driver.ts';

const { MP4_DEMUX_BENCH_SAMPLES, MP4_DEMUX_BENCH_WARMUP } = process.env;
const WARMUP = Number(MP4_DEMUX_BENCH_WARMUP ?? 2);
const SAMPLES = Number(MP4_DEMUX_BENCH_SAMPLES ?? 7);
const CORPUS = new URL('../../media-test/fixtures/media/scenarios/performance/', import.meta.url)
  .pathname;
const DEFAULT_SUBJECTS = [
  'size-ladder-iterate-packets-huge/huge_h264_1080p_600s.mov',
  'size-ladder-iterate-packets-huge/01.mov',
  'size-ladder-iterate-packets-huge/02.mov',
  'size-ladder-iterate-packets-huge/03.mov',
  'size-ladder-iterate-packets-massive/massive_h264_1080p_2h.mp4',
  'size-ladder-iterate-packets-massive/01.mp4',
  'size-ladder-iterate-packets-massive/02.mp4',
  'size-ladder-iterate-packets-massive/03.mp4',
] as const;

interface Subject {
  readonly name: string;
  readonly size: number;
  readonly handle: Awaited<ReturnType<typeof open>>;
}

interface RangeStats {
  calls: number;
  bytes: number;
}

interface PullStats {
  promise: number;
  synchronous: number;
}

interface OperationSample {
  readonly elapsedMs: number;
  readonly checksum: number;
  readonly packets: number;
  readonly packetStreams: number;
  readonly packetRangeCalls: number;
  readonly packetRangeBytes: number;
  readonly peakRssDelta: number;
  readonly pulls?: PullStats;
}

interface FakeChunkInit {
  readonly type?: EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration?: number;
  readonly data: AllowSharedBufferSource;
}

class FakeEncodedChunk {
  readonly type: EncodedVideoChunkType;
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

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
  return value;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

function sourceFor(subject: Subject, stats: RangeStats): ByteSource {
  return {
    size: subject.size,
    async range(start, end): Promise<Uint8Array> {
      const length = Math.max(0, end - start);
      const bytes = new Uint8Array(length);
      const { bytesRead } = await subject.handle.read(bytes, 0, length, start);
      stats.calls++;
      stats.bytes += bytesRead;
      return bytesRead === bytes.byteLength ? bytes : bytes.subarray(0, bytesRead);
    },
    stream(): ReadableStream<Uint8Array> {
      throw new Error('MP4 demux benchmark must remain range-backed');
    },
  };
}

function checksumTracks(tracks: readonly TrackInfo[]): number {
  let checksum = tracks.length;
  for (const track of tracks) {
    checksum =
      (checksum +
        track.id * 17 +
        track.codec.length * 31 +
        Math.round((track.durationSec ?? 0) * 1_000) * 3) >>>
      0;
  }
  return checksum;
}

function checksumPacket(checksum: number, packet: Packet): number {
  const chunk = packet.chunk as EncodedVideoChunk;
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

async function withObservedPulls<T>(
  run: () => Promise<T>,
): Promise<{ readonly value: T; readonly pulls: PullStats }> {
  const NativeReadableStream = globalThis.ReadableStream;
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ReadableStream');
  const pulls: PullStats = { promise: 0, synchronous: 0 };

  class ObservedReadableStream<R = unknown> extends NativeReadableStream<R> {
    constructor(source: UnderlyingSource<R> = {}, strategy?: QueuingStrategy<R>) {
      const originalPull = source.pull;
      if (originalPull === undefined) {
        super(source, strategy);
        return;
      }
      super(
        {
          ...source,
          pull(controller): void | PromiseLike<void> {
            const result = originalPull.call(source, controller);
            if (result === undefined) pulls.synchronous++;
            else pulls.promise++;
            return result;
          },
        },
        strategy,
      );
    }
  }

  Object.defineProperty(globalThis, 'ReadableStream', {
    configurable: true,
    value: ObservedReadableStream as typeof ReadableStream,
  });
  try {
    return { value: await run(), pulls };
  } finally {
    if (originalDescriptor === undefined) Reflect.deleteProperty(globalThis, 'ReadableStream');
    else Object.defineProperty(globalThis, 'ReadableStream', originalDescriptor);
  }
}

async function setupSample(subjects: readonly Subject[]): Promise<OperationSample> {
  const rssStart = process.memoryUsage().rss;
  let peakRss = rssStart;
  let checksum = 0;
  const started = performance.now();
  for (const subject of subjects) {
    const ranges: RangeStats = { calls: 0, bytes: 0 };
    const demuxer = await Mp4Driver.demux(sourceFor(subject, ranges));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    checksum = (checksum + checksumTracks(demuxer.tracks) + ranges.calls * 19) >>> 0;
    await demuxer.close();
  }
  return {
    elapsedMs: performance.now() - started,
    checksum,
    packets: 0,
    packetStreams: 0,
    packetRangeCalls: 0,
    packetRangeBytes: 0,
    peakRssDelta: Math.max(0, peakRss - rssStart),
  };
}

async function drainSample(
  subjects: readonly Subject[],
  observePulls: boolean,
): Promise<OperationSample> {
  const run = async (): Promise<OperationSample> => {
    const rssStart = process.memoryUsage().rss;
    let peakRss = rssStart;
    let checksum = 0;
    let packets = 0;
    let packetRangeCalls = 0;
    let packetRangeBytes = 0;
    let packetStreams = 0;
    const started = performance.now();
    for (const subject of subjects) {
      const ranges: RangeStats = { calls: 0, bytes: 0 };
      const demuxer = await Mp4Driver.demux(sourceFor(subject, ranges));
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      checksum = (checksum + checksumTracks(demuxer.tracks)) >>> 0;
      const setupRangeCalls = ranges.calls;
      const setupRangeBytes = ranges.bytes;
      try {
        for (const track of demuxer.tracks) {
          packetStreams++;
          const reader = demuxer.packets(track.id).getReader();
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              checksum = checksumPacket(checksum, next.value);
              packets++;
              if ((packets & 0xfff) === 0) {
                peakRss = Math.max(peakRss, process.memoryUsage().rss);
              }
            }
          } finally {
            reader.releaseLock();
          }
        }
      } finally {
        await demuxer.close();
      }
      packetRangeCalls += ranges.calls - setupRangeCalls;
      packetRangeBytes += ranges.bytes - setupRangeBytes;
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const sample: OperationSample = {
      elapsedMs: performance.now() - started,
      checksum: (checksum + packets * 23 + packetStreams * 29) >>> 0,
      packets,
      packetStreams,
      packetRangeCalls,
      packetRangeBytes,
      peakRssDelta: Math.max(0, peakRss - rssStart),
    };
    return sample;
  };

  if (!observePulls) return run();
  const observed = await withObservedPulls(run);
  if (observed.pulls.promise !== observed.value.packetRangeCalls) {
    throw new Error(
      `packet pull promises ${observed.pulls.promise} != genuine range misses ${observed.value.packetRangeCalls}`,
    );
  }
  const expectedPulls = observed.value.packets + observed.value.packetStreams;
  if (observed.pulls.promise + observed.pulls.synchronous !== expectedPulls) {
    throw new Error(
      `packet pulls ${observed.pulls.promise + observed.pulls.synchronous} != ` +
        `${observed.value.packets} packets + ${observed.value.packetStreams} terminal pulls`,
    );
  }
  return { ...observed.value, pulls: observed.pulls };
}

async function measuredSamples(
  run: () => Promise<OperationSample>,
): Promise<{ readonly timings: number[]; readonly checksum: number }> {
  const warmup = positiveInteger(WARMUP, 'warmup');
  const samples = positiveInteger(SAMPLES, 'samples');
  const timings: number[] = [];
  let checksum = 0;
  let expectedMediaChecksum: number | undefined;
  for (let index = 0; index < warmup + samples; index++) {
    const sample = await run();
    expectedMediaChecksum ??= sample.checksum;
    if (sample.checksum !== expectedMediaChecksum) {
      throw new Error(`unstable checksum ${sample.checksum} != ${expectedMediaChecksum}`);
    }
    checksum = (checksum + sample.checksum) >>> 0;
    if (index >= warmup) timings.push(sample.elapsedMs);
  }
  return { timings, checksum };
}

function sampleList(values: readonly number[]): string {
  return values.map((value) => value.toFixed(3)).join(', ');
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const paths =
    requested.length > 0
      ? requested.map((path) => resolve(path))
      : DEFAULT_SUBJECTS.map((name) => `${CORPUS}${name}`);
  const subjects: Subject[] = [];
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
    for (const path of paths) {
      const handle = await open(path, 'r');
      subjects.push({ name: basename(path), handle, size: (await handle.stat()).size });
    }

    const setup = await measuredSamples(() => setupSample(subjects));
    const drain = await measuredSamples(() => drainSample(subjects, false));
    const setupMemory = await setupSample(subjects);
    const drainMemory = await drainSample(subjects, false);
    const counted = await drainSample(subjects, true);
    const pulls = counted.pulls;
    if (pulls === undefined) throw new Error('counted packet drain did not return pull statistics');
    const totalBytes = subjects.reduce((sum, subject) => sum + subject.size, 0);

    console.info(
      `Session 11 MP4 demux — ${subjects.length} real files, ${(totalBytes / 2 ** 30).toFixed(2)} GiB; ` +
        `warmup=${WARMUP}, samples=${SAMPLES}`,
    );
    console.info(
      `demux setup median=${median(setup.timings).toFixed(3)} ms; ` +
        `peakRSS+=${(setupMemory.peakRssDelta / 2 ** 20).toFixed(2)} MiB; ` +
        `checksum=${setup.checksum}; samples=[${sampleList(setup.timings)}]`,
    );
    console.info(
      `drain packets median=${median(drain.timings).toFixed(3)} ms; ` +
        `packets=${counted.packets}; packetRanges=${counted.packetRangeCalls}; ` +
        `rangeGiB=${(counted.packetRangeBytes / 2 ** 30).toFixed(2)}; ` +
        `pullPromises=${pulls.promise}; synchronousPulls=${pulls.synchronous}; ` +
        `peakRSS+=${(drainMemory.peakRssDelta / 2 ** 20).toFixed(2)} MiB; ` +
        `checksum=${drain.checksum}; samples=[${sampleList(drain.timings)}]`,
    );
  } finally {
    await Promise.all(subjects.map(async (subject) => await subject.handle.close()));
    if (originalAudioChunk === undefined) Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    else {
      Object.defineProperty(globalThis, 'EncodedAudioChunk', {
        configurable: true,
        value: originalAudioChunk,
      });
    }
    if (originalVideoChunk === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk');
    else {
      Object.defineProperty(globalThis, 'EncodedVideoChunk', {
        configurable: true,
        value: originalVideoChunk,
      });
    }
  }
}

await main();
