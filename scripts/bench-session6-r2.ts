/**
 * Session 6 R2 focused benchmark:
 * - AAC gapless: derive exact sample windows from real MP4/AAC edit-list fixtures.
 * - AAC gapless trim core: slice decoded audio frames by sample count with close-once ownership.
 * - VP9 alpha/HEVC reachability: exercise pure WebCodecs config planning for the R2 edge lanes.
 *
 * This is a local Node/Bun benchmark for the pure pieces. The real VP9-alpha decode/transcode/trim and
 * HEVC browser codec throughput remain browser-harness responsibilities.
 */

import { buildVideoEncoderConfig } from '../src/api/codec-pipeline.ts';
import {
  type AudioSampleFrameForTrim,
  trimAudioGaplessFrameStream,
} from '../src/api/trim-streams.ts';
import { normalizeVideoDecoderConfig } from '../src/codecs/webcodecs-video.ts';
import type { TrackInfo } from '../src/contracts/driver.ts';
import { Mp4Driver } from '../src/drivers/mp4/mp4-driver.ts';
import { fixtureSource } from '../src/test-support/corpus.ts';

const WARMUP = 3;
const ITERS = 21;
const AAC_FIXTURES = ['test.mp4', 'obs-remux-variable-aac.mp4'] as const;

interface BenchResult {
  readonly name: string;
  readonly medianMs: number;
  readonly samples: readonly number[];
  readonly checksum: number;
}

interface GaplessCase {
  readonly id: string;
  readonly sampleRate: number;
  readonly gapless: NonNullable<TrackInfo['gapless']>;
}

class BenchAudioFrame implements AudioSampleFrameForTrim {
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly duration: number | null,
    readonly numberOfFrames: number,
    readonly sampleRate: number,
  ) {}

  close(): void {
    this.closeCount++;
    if (this.closeCount > 1) throw new Error(`audio frame at ${this.timestamp} closed twice`);
  }
}

function startNs(): number {
  return Number(Bun.nanoseconds());
}

function nsToMs(ns: number): number {
  return ns / 1_000_000;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted[mid];
  if (value === undefined) throw new Error('cannot take median of an empty sample set');
  return value;
}

async function runBench(name: string, fn: () => Promise<number> | number): Promise<BenchResult> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples: number[] = [];
  let checksum = 0;
  for (let i = 0; i < ITERS; i++) {
    const start = startNs();
    checksum += await fn();
    samples.push(nsToMs(startNs() - start));
  }
  return { name, medianMs: median(samples), samples, checksum };
}

function audioSampleRate(track: TrackInfo): number {
  const config = track.config;
  if (config !== undefined && 'sampleRate' in config && typeof config.sampleRate === 'number') {
    return config.sampleRate;
  }
  throw new Error(`track ${track.id} has no audio sampleRate config`);
}

async function readGaplessCase(id: string): Promise<GaplessCase> {
  const demuxer = await Mp4Driver.demux(await fixtureSource(id));
  try {
    const audio = demuxer.tracks.find((track) => track.mediaType === 'audio');
    if (audio === undefined) throw new Error(`${id} has no audio track`);
    if (audio.gapless === undefined) throw new Error(`${id} has no AAC gapless sample contract`);
    return { id, sampleRate: audioSampleRate(audio), gapless: audio.gapless };
  } finally {
    await demuxer.close();
  }
}

async function loadGaplessCases(): Promise<readonly GaplessCase[]> {
  const cases: GaplessCase[] = [];
  for (const id of AAC_FIXTURES) cases.push(await readGaplessCase(id));
  return cases;
}

function frameDurationUs(frames: number, sampleRate: number): number {
  return Math.round((frames / sampleRate) * 1_000_000);
}

function benchAudioStream(
  sampleRate: number,
  codedSamples: number,
  chunkFrames: number,
): ReadableStream<BenchAudioFrame> {
  let emitted = 0;
  return new ReadableStream<BenchAudioFrame>({
    pull(controller): void {
      if (emitted >= codedSamples) {
        controller.close();
        return;
      }
      const frameCount = Math.min(chunkFrames, codedSamples - emitted);
      const timestamp = frameDurationUs(emitted, sampleRate);
      emitted += frameCount;
      controller.enqueue(
        new BenchAudioFrame(
          timestamp,
          frameDurationUs(frameCount, sampleRate),
          frameCount,
          sampleRate,
        ),
      );
    },
  });
}

function restampBenchAudio(
  frame: BenchAudioFrame,
  startFrame: number,
  frameCount: number,
  timestamp: number,
): BenchAudioFrame {
  if (startFrame === 0 && frameCount === frame.numberOfFrames && timestamp === frame.timestamp) {
    return frame;
  }
  return new BenchAudioFrame(
    timestamp,
    frameDurationUs(frameCount, frame.sampleRate),
    frameCount,
    frame.sampleRate,
  );
}

async function collectGaplessTrim(item: GaplessCase): Promise<number> {
  const codedSamples =
    (item.gapless.leadingSamples ?? 0) +
    (item.gapless.totalSamples ?? 0) +
    (item.gapless.trailingSamples ?? 0);
  const reader = trimAudioGaplessFrameStream(
    benchAudioStream(item.sampleRate, codedSamples, 1024),
    item.gapless,
    restampBenchAudio,
  ).getReader();
  let checksum = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) return checksum;
      checksum += read.value.timestamp + read.value.numberOfFrames;
      read.value.close();
    }
  } finally {
    reader.releaseLock();
  }
}

async function gaplessTrimChecksum(cases: readonly GaplessCase[]): Promise<number> {
  let checksum = 0;
  for (const item of cases) checksum += await collectGaplessTrim(item);
  return checksum;
}

async function gaplessDemuxChecksum(): Promise<number> {
  let checksum = 0;
  for (const id of AAC_FIXTURES) {
    const item = await readGaplessCase(id);
    checksum +=
      item.sampleRate +
      (item.gapless.leadingSamples ?? 0) +
      (item.gapless.totalSamples ?? 0) +
      (item.gapless.trailingSamples ?? 0);
  }
  return checksum;
}

function configPlanningChecksum(): number {
  let checksum = 0;
  const vp9 = buildVideoEncoderConfig({ codec: 'vp9' }, { width: 1280, height: 720 }, undefined);
  const hevc = buildVideoEncoderConfig({}, { width: 3840, height: 2160 }, 'hvc1.1.6.L150.90');
  const decoder = normalizeVideoDecoderConfig(
    { codec: 'vp09.00.10.08', codedWidth: 1280, codedHeight: 720 },
    'prefer-hardware',
  );
  checksum += vp9.width + vp9.height + (vp9.alpha === 'keep' ? 1 : 0);
  checksum += hevc.width + hevc.height + (hevc.codec.startsWith('hvc1.') ? 1 : 0);
  if (decoder.codedWidth === undefined || decoder.codedHeight === undefined) {
    throw new Error('normalized VP9 decoder config lost coded dimensions');
  }
  checksum += decoder.codedWidth + decoder.codedHeight;
  return checksum;
}

function formatMs(value: number): string {
  return value.toFixed(3).padStart(8);
}

async function main(): Promise<void> {
  const cases = await loadGaplessCases();
  if (cases.length < AAC_FIXTURES.length) {
    throw new Error(`need ${AAC_FIXTURES.length} AAC gapless fixtures, found ${cases.length}`);
  }
  const results = [
    await runBench('aac-gapless-demux-real-mp4', gaplessDemuxChecksum),
    await runBench('aac-gapless-trim-sample-window', () => gaplessTrimChecksum(cases)),
    await runBench('vp9-alpha-hevc-config-planning', configPlanningChecksum),
  ];

  console.log(
    `Session 6 R2 benchmark - median of ${ITERS} iters (warmup ${WARMUP}); ` +
      `${cases.length} real AAC edit-list fixtures`,
  );
  for (const result of results) {
    console.log(
      `${result.name.padEnd(34)} median=${formatMs(result.medianMs)} ms checksum=${result.checksum}`,
    );
  }
}

await main();
