#!/usr/bin/env bun
/** Fresh-process module-residency benchmark for selective native-audio transcode registration. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CodecQuery, ContainerQuery, TrackInfo } from '../src/contracts/driver.ts';
import { registerDefaultCodecForQuery } from '../src/drivers/default-codec-registration.ts';
import { registerDefaultContainerForQuery } from '../src/drivers/default-container-registration.ts';
import { Registry } from '../src/kernel/registry.ts';
import { Router } from '../src/kernel/router.ts';
import { fromBytes } from '../src/sources/source.ts';

const SAMPLES = 7;
const CHILD = process.argv[2] === '--child';
const INPUTS = [
  '../fixtures/media/sfx.adts',
  '../../media-test/fixtures/media/scenarios/transcode/aac_to_opus_webm/01.aac',
  '../../media-test/fixtures/media/scenarios/transcode/aac_to_opus_webm/02.aac',
  '../../media-test/fixtures/media/scenarios/transcode/aac_to_opus_webm/03.aac',
  '../../media-test/fixtures/media/scenarios/transcode/aac_to_opus_webm/aac_adts.aac',
] as const;

type Mode = 'selective' | 'register-all-control';

interface ChildResult {
  readonly mode: Mode;
  readonly sourceBytes: number;
  readonly trackCount: number;
  readonly durationUs: number;
  readonly checksum: string;
  readonly elapsedMs: number;
  readonly rssDeltaBytes: number;
  readonly heapDeltaBytes: number;
  readonly externalDeltaBytes: number;
  readonly arrayBufferDeltaBytes: number;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('cannot take median of empty values');
  return value;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
  }
}

function memoryDelta(
  after: NodeJS.MemoryUsage,
  before: NodeJS.MemoryUsage,
  field: keyof NodeJS.MemoryUsage,
): number {
  return after[field] - before[field];
}

function installSupportedNativeAudio(): void {
  const support = async (
    config: AudioDecoderConfig | AudioEncoderConfig,
  ): Promise<{ readonly supported: true; readonly config: typeof config }> => ({
    supported: true,
    config,
  });
  Object.defineProperty(globalThis, 'AudioDecoder', {
    configurable: true,
    value: { isConfigSupported: support } as unknown as typeof AudioDecoder,
  });
  Object.defineProperty(globalThis, 'AudioEncoder', {
    configurable: true,
    value: { isConfigSupported: support } as unknown as typeof AudioEncoder,
  });
}

function foldTrack(hash: ReturnType<typeof createHash>, track: TrackInfo): void {
  const config = track.config;
  hash.update(`${track.mediaType}|${track.codec}|${track.durationSec ?? -1}|`);
  if (config !== undefined && 'sampleRate' in config) {
    hash.update(`${config.sampleRate}|${config.numberOfChannels}|`);
    if (config.description !== undefined) {
      const description = ArrayBuffer.isView(config.description)
        ? new Uint8Array(
            config.description.buffer,
            config.description.byteOffset,
            config.description.byteLength,
          )
        : new Uint8Array(config.description);
      hash.update(description);
    }
  }
}

async function child(mode: Mode): Promise<ChildResult> {
  installSupportedNativeAudio();
  const sources = await Promise.all(
    INPUTS.map(
      async (path) => new Uint8Array(await readFile(fileURLToPath(new URL(path, import.meta.url)))),
    ),
  );
  const registry = new Registry();
  const router = new Router({ registry });
  await settle();
  const before = process.memoryUsage();
  const started = Bun.nanoseconds();
  const sourceQuery: ContainerQuery = {
    direction: 'demux',
    extension: 'aac',
    mime: 'audio/aac',
  };
  const targetQuery: ContainerQuery = { direction: 'mux', extension: 'webm' };
  const decodeQuery: CodecQuery = {
    mediaType: 'audio',
    direction: 'decode',
    config: {
      codec: 'mp4a.40.2',
      sampleRate: 48_000,
      numberOfChannels: 2,
      description: new Uint8Array([0x11, 0x90]),
    },
  };
  const encodeQuery: CodecQuery = {
    mediaType: 'audio',
    direction: 'encode',
    config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
  };

  if (mode === 'selective') {
    if (!(await registerDefaultContainerForQuery(registry, sourceQuery))) {
      throw new Error('selective ADTS registration declined');
    }
    if (!(await registerDefaultContainerForQuery(registry, targetQuery))) {
      throw new Error('selective WebM registration declined');
    }
    if (!(await registerDefaultCodecForQuery(registry, decodeQuery, { determinism: 'auto' }))) {
      throw new Error('selective AAC registration declined');
    }
    if (!(await registerDefaultCodecForQuery(registry, encodeQuery, { determinism: 'auto' }))) {
      throw new Error('selective Opus registration declined');
    }
  } else {
    const { registerDefaultDrivers } = await import('../src/drivers/defaults.ts');
    registerDefaultDrivers(registry);
  }
  router.clearCache();

  const source = router.pickContainer(sourceQuery);
  const target = router.pickContainer(targetQuery);
  const decoder = await router.pickCodec(decodeQuery, { determinism: 'auto' });
  const encoder = await router.pickCodec(encodeQuery, { determinism: 'auto' });
  if (
    source.id !== 'adts' ||
    target.id !== (mode === 'selective' ? 'webm-mux' : 'webm') ||
    decoder.id !== 'webcodecs-audio' ||
    encoder.id !== 'webcodecs-audio'
  ) {
    throw new Error(`unexpected route ${source.id}/${target.id}/${decoder.id}/${encoder.id}`);
  }
  target.createMuxer({ container: 'webm' });

  let sourceBytes = 0;
  let trackCount = 0;
  let durationUs = 0;
  const hash = createHash('sha256');
  for (const bytes of sources) {
    sourceBytes += bytes.byteLength;
    const demuxer = await source.demux(fromBytes(bytes, { mime: 'audio/aac' }));
    try {
      for (const track of demuxer.tracks) {
        trackCount++;
        durationUs += Math.round((track.durationSec ?? 0) * 1_000_000);
        foldTrack(hash, track);
      }
    } finally {
      await demuxer.close();
    }
  }
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
  const checksum = hash.digest('hex');
  await settle();
  const after = process.memoryUsage();
  return {
    mode,
    sourceBytes,
    trackCount,
    durationUs,
    checksum,
    elapsedMs,
    rssDeltaBytes: memoryDelta(after, before, 'rss'),
    heapDeltaBytes: memoryDelta(after, before, 'heapUsed'),
    externalDeltaBytes: memoryDelta(after, before, 'external'),
    arrayBufferDeltaBytes: memoryDelta(after, before, 'arrayBuffers'),
  };
}

if (CHILD) {
  const mode = process.argv[3] as Mode | undefined;
  if (mode !== 'selective' && mode !== 'register-all-control') {
    throw new Error('invalid selective-native-audio benchmark child mode');
  }
  console.info(JSON.stringify(await child(mode)));
} else {
  const results: ChildResult[] = [];
  for (const mode of ['selective', 'register-all-control'] as const) {
    for (let sample = 0; sample < SAMPLES; sample++) {
      const childProcess = Bun.spawn([process.execPath, import.meta.path, '--child', mode], {
        stdout: 'pipe',
        stderr: 'inherit',
      });
      const output = await new Response(childProcess.stdout).text();
      const status = await childProcess.exited;
      if (status !== 0) throw new Error(`${mode} child exited ${status}`);
      results.push(JSON.parse(output) as ChildResult);
    }
  }
  const expected = results[0];
  if (expected === undefined) throw new Error('benchmark produced no samples');
  for (const result of results) {
    if (
      result.sourceBytes !== expected.sourceBytes ||
      result.trackCount !== expected.trackCount ||
      result.durationUs !== expected.durationUs ||
      result.checksum !== expected.checksum
    ) {
      throw new Error('selective native-audio route changed source track truth');
    }
  }
  const rows = (['selective', 'register-all-control'] as const).map((mode) => {
    const samples = results.filter((sample) => sample.mode === mode);
    return {
      mode,
      freshSamples: samples.length,
      sourceBytes: expected.sourceBytes,
      trackCount: expected.trackCount,
      durationUs: expected.durationUs,
      checksum: expected.checksum,
      medianMs: median(samples.map((sample) => sample.elapsedMs)),
      medianRssDeltaBytes: median(samples.map((sample) => sample.rssDeltaBytes)),
      rssDeltaSamples: samples.map((sample) => sample.rssDeltaBytes),
      medianHeapDeltaBytes: median(samples.map((sample) => sample.heapDeltaBytes)),
      medianExternalDeltaBytes: median(samples.map((sample) => sample.externalDeltaBytes)),
      medianArrayBufferDeltaBytes: median(samples.map((sample) => sample.arrayBufferDeltaBytes)),
    };
  });
  console.info(
    JSON.stringify(
      { benchmark: 'session13-selective-native-audio-registration', freshProcess: true, rows },
      null,
      2,
    ),
  );
}
