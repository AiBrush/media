#!/usr/bin/env bun

import { createMedia } from '../src/api/create-media.ts';
import type { ImageOps } from '../src/codecs/image/index.ts';
import type {
  CodecDriver,
  CodecQuery,
  CodecSupport,
  DriverModule,
  EncodedChunk,
  RawFrame,
} from '../src/contracts/driver.ts';
import { DRIVER_API_VERSION } from '../src/contracts/driver.ts';
import { CapabilityError } from '../src/contracts/errors.ts';
import { Registry } from '../src/kernel/registry.ts';
import { Router } from '../src/kernel/router.ts';

const WARMUP = 3;
const SAMPLES = 21;
const COLD_ITERATIONS = 1_000;
const HOT_ITERATIONS = 10_000;
const IMAGE_DECLINE_ITERATIONS = 100;
let sink = 0;

const softwareWebCodecs: CodecDriver = {
  id: 'benchmark-webcodecs-software',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'hardware',
  supports(_query, options): Promise<CodecSupport> {
    return Promise.resolve(
      options?.determinism === 'force-software'
        ? { supported: true, hardwareAccelerated: false }
        : { supported: true, hardwareAccelerated: true },
    );
  },
  createDecoder: () => new TransformStream<EncodedChunk, RawFrame>(),
  createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
};

function router(): Router {
  const registry = new Registry();
  registry.addCodec(softwareWebCodecs);
  return new Router({ registry });
}

function query(width: number): CodecQuery {
  return {
    mediaType: 'video',
    direction: 'decode',
    config: { codec: 'avc1.42001e', codedWidth: width, codedHeight: 16 },
  };
}

const benchmarkImageOps: ImageOps = {
  formats: ['png'],
  sniff: (bytes) =>
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      ? 'png'
      : undefined,
  probe: () => {
    throw new Error('software-decline benchmark must not probe image metadata');
  },
  canDecode: () => true,
  decode: () => {
    throw new Error('software-decline benchmark must not construct an image decoder');
  },
  decodeFrames(): AsyncGenerator<VideoFrame, void, undefined> {
    throw new Error('software-decline benchmark must not construct an image decoder');
  },
};

const benchmarkImageModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(registry): void {
    (registry as { addImageOps?: (ops: ImageOps) => void }).addImageOps?.(benchmarkImageOps);
  },
};

const imageMedia = createMedia().use(benchmarkImageModule);
const imageHead = new Uint8Array(4096);
imageHead.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[ordered.length >>> 1] ?? 0;
}

async function coldSample(): Promise<number> {
  const candidate = router();
  const start = Bun.nanoseconds();
  for (let index = 0; index < COLD_ITERATIONS; index++) {
    const picked = await candidate.pickCodec(query(index + 1), {
      determinism: 'force-software',
    });
    sink += picked.id.length;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

async function hotSample(): Promise<number> {
  const candidate = router();
  const exact = query(1920);
  await candidate.pickCodec(exact, { determinism: 'force-software' });
  const start = Bun.nanoseconds();
  for (let index = 0; index < HOT_ITERATIONS; index++) {
    const picked = await candidate.pickCodec(exact, { determinism: 'force-software' });
    sink += picked.id.length;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

async function imageDeclineSample(): Promise<number> {
  const start = Bun.nanoseconds();
  for (let index = 0; index < IMAGE_DECLINE_ITERATIONS; index++) {
    let pulls = 0;
    let cancels = 0;
    const input = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          pulls++;
          controller.enqueue(imageHead);
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    const video = imageMedia.decode(imageMedia.from(input, { mime: 'image/png' }), {
      strategy: { determinism: 'force-software' },
    }).video;
    if (video === undefined) throw new Error('image decline benchmark lost its video stream');
    const reader = video.getReader();
    try {
      await reader.read();
      throw new Error('force-software image decode unexpectedly succeeded');
    } catch (error) {
      if (!(error instanceof CapabilityError) || error.code !== 'capability-miss') throw error;
    } finally {
      reader.releaseLock();
    }
    if (pulls !== 1 || cancels !== 1) {
      throw new Error(`image decline lifecycle mismatch: pulls=${pulls} cancels=${cancels}`);
    }
    sink += pulls + cancels;
  }
  return (Bun.nanoseconds() - start) / 1_000_000;
}

async function measure(run: () => Promise<number>): Promise<number> {
  for (let index = 0; index < WARMUP; index++) await run();
  const elapsed: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) elapsed.push(await run());
  return median(elapsed);
}

const coldMs = await measure(coldSample);
const hotMs = await measure(hotSample);
const imageDeclineMs = await measure(imageDeclineSample);
console.log(
  `routing.force-software: cold=${((coldMs * 1_000) / COLD_ITERATIONS).toFixed(3)}us/pick ` +
    `hot=${((hotMs * 1_000) / HOT_ITERATIONS).toFixed(3)}us/pick ` +
    `image-decline=${((imageDeclineMs * 1_000) / IMAGE_DECLINE_ITERATIONS).toFixed(3)}us/op ` +
    `sink=${sink}`,
);
