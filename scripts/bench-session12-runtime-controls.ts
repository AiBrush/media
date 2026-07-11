#!/usr/bin/env bun
/** Fresh multi-sample benchmark for ADR-237 routing/runtime controls. */

import { createMedia } from '../src/api/create-media.ts';
import type {
  CodecDriver,
  CodecQuery,
  CodecSupport,
  EncodedChunk,
  RawFrame,
} from '../src/contracts/driver.ts';
import { DRIVER_API_VERSION } from '../src/contracts/driver.ts';
import { Registry } from '../src/kernel/registry.ts';
import { Router } from '../src/kernel/router.ts';
import { resolveWasmAssetUrl } from '../src/kernel/wasm-loader-runtime.ts';
import {
  normalizeWasmAssetBaseUrl,
  resolveWasmRuntimeProfile,
} from '../src/kernel/wasm-runtime.ts';

const WARMUP = 3;
const SAMPLES = 11;
const PIN_ITERATIONS = 2_500;
const CONTROL_ITERATIONS = 20_000;
let sink = 0;

const query: CodecQuery = {
  mediaType: 'audio',
  direction: 'decode',
  config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
};

function codec(id: string, supported: boolean): CodecDriver {
  return {
    id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: id === 'hardware' ? 'hardware' : 'wasm',
    supports: (): Promise<CodecSupport> => Promise.resolve({ supported }),
    createDecoder: () => new TransformStream<EncodedChunk, RawFrame>(),
    createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
  };
}

function freshRouter(): Router {
  const registry = new Registry();
  registry.addCodec(codec('hardware', true));
  registry.addCodec(codec('pinned-wasm', true));
  return new Router({ registry });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function pinnedSample(): Promise<number> {
  const router = freshRouter();
  const start = Bun.nanoseconds();
  for (let index = 0; index < PIN_ITERATIONS; index += 1) {
    const selected = await router.pickCodec(query, { pinDriver: 'pinned-wasm' });
    if (selected.id !== 'pinned-wasm') throw new Error(`pin escaped to ${selected.id}`);
    sink += selected.id.length;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

function controlsSample(): number {
  const defaultAsset = new URL('file:///package/chunks/aac_wasm_bg.wasm');
  const start = Bun.nanoseconds();
  for (let index = 0; index < CONTROL_ITERATIONS; index += 1) {
    const runtime = resolveWasmRuntimeProfile({
      enableThreads: false,
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
    });
    const root = normalizeWasmAssetBaseUrl('file:///tmp/aibrush-runtime-cores');
    const asset = resolveWasmAssetUrl('./aac_wasm_bg.wasm', defaultAsset, root);
    if (
      runtime.kind !== 'baseline' ||
      asset.href !== 'file:///tmp/aibrush-runtime-cores/aac_wasm_bg.wasm'
    ) {
      throw new Error('runtime control benchmark oracle failed');
    }
    sink += asset.pathname.length;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

function engineCreationSample(): number {
  const start = Bun.nanoseconds();
  for (let index = 0; index < CONTROL_ITERATIONS; index += 1) {
    const engine = createMedia({
      enableThreads: false,
      assetBaseUrl: 'file:///tmp/aibrush-runtime-cores',
      worker: false,
    });
    sink += typeof engine.probe === 'function' ? 1 : 0;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

async function measureAsync(run: () => Promise<number>): Promise<readonly number[]> {
  for (let index = 0; index < WARMUP; index += 1) await run();
  const values: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) values.push(await run());
  return values;
}

function measure(run: () => number): readonly number[] {
  for (let index = 0; index < WARMUP; index += 1) run();
  const values: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) values.push(run());
  return values;
}

const pinTimes = await measureAsync(pinnedSample);
const controlTimes = measure(controlsSample);
const engineTimes = measure(engineCreationSample);

console.info(
  JSON.stringify({
    benchmark: 'session12-runtime-controls',
    warmup: WARMUP,
    samples: SAMPLES,
    pin: {
      iterations: PIN_ITERATIONS,
      medianMs: median(pinTimes),
      medianUsPerPick: (median(pinTimes) * 1_000) / PIN_ITERATIONS,
      samplesMs: pinTimes,
    },
    resolve: {
      iterations: CONTROL_ITERATIONS,
      medianMs: median(controlTimes),
      medianUsPerControlSet: (median(controlTimes) * 1_000) / CONTROL_ITERATIONS,
      samplesMs: controlTimes,
    },
    createMedia: {
      iterations: CONTROL_ITERATIONS,
      medianMs: median(engineTimes),
      medianUsPerEngine: (median(engineTimes) * 1_000) / CONTROL_ITERATIONS,
      samplesMs: engineTimes,
    },
    sink,
  }),
);
