#!/usr/bin/env bun
/**
 * Session 11 WebCodecs video-decode setup benchmark. This measures the product's exact-config
 * capability-key/cache/decision work only; browser VideoDecoder throughput remains a headed-harness
 * measurement. Each lookup uses a separately allocated but structurally equal decoder config, matching
 * repeated demux operations after the Router has cached its chosen driver.
 */

import { createMedia } from '../src/api/create-media.ts';
import {
  createVideoDecoderAccelerationCache,
  immediateVideoDecoderAcceleration,
} from '../src/codecs/webcodecs-video.ts';
import { fixtureSource } from '../src/test-support/corpus.ts';

const WARMUP = 3;
const SAMPLES = 9;
const LOOKUPS_PER_SAMPLE = 100_000;

const FIXTURE_IDS = [
  'movie_5.webm',
  'h264.mp4',
  'bear-open-gop-frag.mp4',
  'bear-hevc-10bit-hdr10.mp4',
  'av1.mp4',
] as const;

interface Sample {
  readonly elapsedMs: number;
  readonly checksum: number;
}

function cloneConfig(config: VideoDecoderConfig): VideoDecoderConfig {
  const description = config.description;
  const descriptionCopy =
    description === undefined
      ? undefined
      : ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice()
        : new Uint8Array(description).slice();
  return {
    ...config,
    ...(descriptionCopy !== undefined ? { description: descriptionCopy } : {}),
    ...(config.colorSpace !== undefined ? { colorSpace: { ...config.colorSpace } } : {}),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error('cannot take the median of an empty sample');
  return value;
}

async function loadRealConfigs(): Promise<readonly VideoDecoderConfig[]> {
  const media = createMedia();
  const configs: VideoDecoderConfig[] = [];
  for (const id of FIXTURE_IDS) {
    const demuxer = await media.demux(await fixtureSource(id));
    try {
      const config = demuxer.tracks.find((track) => track.mediaType === 'video')?.config;
      if (config === undefined || (!('codedWidth' in config) && !('codedHeight' in config))) {
        throw new Error(`${id} has no VideoDecoderConfig`);
      }
      configs.push(config);
    } finally {
      await demuxer.close();
    }
  }
  return configs;
}

function runSample(configs: readonly VideoDecoderConfig[]): Sample {
  const cache = createVideoDecoderAccelerationCache(configs.length);
  for (const config of configs) cache.set(config, undefined, 'prefer-hardware');
  const repeatedConfigs = configs.map(cloneConfig);
  let checksum = 0;
  const started = performance.now();
  for (let index = 0; index < LOOKUPS_PER_SAMPLE; index++) {
    const config = repeatedConfigs[index % repeatedConfigs.length];
    if (config === undefined) throw new Error('decoder config rotation is empty');
    const cached = cache.get(config, undefined);
    const acceleration = immediateVideoDecoderAcceleration('auto', cached);
    if (acceleration !== 'prefer-hardware')
      throw new Error('lost exact hardware capability verdict');
    checksum = (checksum + config.codec.length + index) >>> 0;
  }
  return { elapsedMs: performance.now() - started, checksum };
}

const configs = await loadRealConfigs();
const timings: number[] = [];
let checksum = 0;
for (let index = 0; index < WARMUP + SAMPLES; index++) {
  const sample = runSample(configs);
  checksum = (checksum + sample.checksum) >>> 0;
  if (index >= WARMUP) timings.push(sample.elapsedMs);
}
const beforeRss = process.memoryUsage().rss;
const memorySample = runSample(configs);
checksum = (checksum + memorySample.checksum) >>> 0;
const peakMemoryMb = Math.max(0, process.memoryUsage().rss - beforeRss) / (1024 * 1024);
const medianMs = median(timings);

console.info(
  `Session 11 video decode acceleration setup — ${LOOKUPS_PER_SAMPLE} exact config ` +
    `lookups across ${configs.length} real codec/config shapes; median=${medianMs.toFixed(3)} ms ` +
    `(${((medianMs * 1_000) / LOOKUPS_PER_SAMPLE).toFixed(3)} us/decoder); ` +
    `peakRSS+=${peakMemoryMb.toFixed(2)} MiB; checksum=${checksum}; ` +
    `samples=[${timings.map((value) => value.toFixed(3)).join(', ')}]`,
);
