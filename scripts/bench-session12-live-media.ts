#!/usr/bin/env bun
/** Session 12 live MediaStream adapter microbenchmark (ADR-236). */

import { MediaError } from '../src/contracts/errors.ts';
import {
  type LiveTrackProcessorFactory,
  decodeLiveMediaStream,
  fromMediaStream,
} from '../src/sources/live-media.ts';

const WARMUPS = 2;
const SAMPLES = 7;
const FRAMES_PER_SAMPLE = 10_000;
const CANCELLATIONS_PER_SAMPLE = 200;
const FRAME_DURATION_US = 33_333;

class BenchVideoFrame {
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly duration: number | null,
  ) {}

  close(): void {
    this.closeCount++;
  }
}

class BenchTrack extends EventTarget {
  readonly kind = 'video';
  readyState: MediaStreamTrackState = 'live';
  stopCount = 0;

  stop(): void {
    this.stopCount++;
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class BenchMediaStream {
  constructor(private readonly track: BenchTrack) {}

  getTracks(): MediaStreamTrack[] {
    return [this.track] as unknown as MediaStreamTrack[];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.getTracks();
  }

  getAudioTracks(): MediaStreamTrack[] {
    return [];
  }
}

interface ThroughputResult {
  readonly elapsedMs: number;
  readonly frames: number;
  readonly pulls: number;
  readonly checksum: number;
}

interface CancellationResult {
  readonly elapsedMs: number;
  readonly cancellations: number;
  readonly lateFramesClosed: number;
}

interface SampleResult {
  readonly throughput: ThroughputResult;
  readonly cancellation: CancellationResult;
  readonly rssBeforeBytes: number;
  readonly rssAfterBytes: number;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const value = ordered[Math.floor(ordered.length / 2)];
  if (value === undefined) throw new Error('cannot take median of an empty sample');
  return value;
}

function liveSource(track: BenchTrack) {
  return fromMediaStream(new BenchMediaStream(track) as unknown as MediaStream);
}

async function throughputSample(): Promise<ThroughputResult> {
  const track = new BenchTrack();
  let pulls = 0;
  let created = 0;
  let closed = 0;
  const factory: LiveTrackProcessorFactory = {
    create(processorTrack, kind, maxBufferSize): ReadableStream<unknown> {
      if (processorTrack !== (track as unknown as MediaStreamTrack)) {
        throw new Error('processor received the wrong track');
      }
      if (kind !== 'video' || maxBufferSize !== 1) {
        throw new Error(`processor received ${kind} maxBufferSize=${maxBufferSize}`);
      }
      let next = 0;
      return new ReadableStream<unknown>(
        {
          pull(controller): void {
            pulls++;
            if (next >= FRAMES_PER_SAMPLE) {
              controller.close();
              return;
            }
            const frame = new BenchVideoFrame(next * FRAME_DURATION_US, FRAME_DURATION_US);
            const originalClose = frame.close.bind(frame);
            frame.close = (): void => {
              originalClose();
              closed++;
            };
            created++;
            next++;
            controller.enqueue(frame);
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
  const frames = decodeLiveMediaStream(liveSource(track), { processorFactory: factory }).video;
  if (frames === undefined) throw new Error('benchmark live video stream is absent');
  const reader = frames.getReader();
  let count = 0;
  let checksum = 0;
  const started = performance.now();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      checksum = (checksum + next.value.timestamp + (next.value.duration ?? 0)) % 2_147_483_647;
      next.value.close();
      count++;
    }
  } finally {
    reader.releaseLock();
  }
  const elapsedMs = performance.now() - started;
  if (count !== FRAMES_PER_SAMPLE || created !== count || closed !== count) {
    throw new Error(`frame lifecycle ${count} consumed, ${created} created, ${closed} closed`);
  }
  if (pulls !== FRAMES_PER_SAMPLE + 1) {
    throw new Error(`backpressure performed ${pulls} pulls; expected ${FRAMES_PER_SAMPLE + 1}`);
  }
  if (track.stopCount !== 0) throw new Error('adapter stopped its caller-owned track');
  return { elapsedMs, frames: count, pulls, checksum };
}

interface LateReadHarness {
  readonly stream: ReadableStream<unknown>;
  readonly started: Promise<void>;
  readonly cancelCount: () => number;
  readonly releaseCount: () => number;
}

function lateReadHarness(frame: BenchVideoFrame): LateReadHarness {
  let resolveRead:
    | ((result: { readonly done: false; readonly value: BenchVideoFrame }) => void)
    | undefined;
  const pending = new Promise<{ readonly done: false; readonly value: BenchVideoFrame }>(
    (resolve) => {
      resolveRead = resolve;
    },
  );
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let cancels = 0;
  let releases = 0;
  const stream = {
    getReader() {
      return {
        read() {
          markStarted?.();
          return pending;
        },
        cancel() {
          cancels++;
          resolveRead?.({ done: false, value: frame });
          return Promise.resolve();
        },
        releaseLock() {
          releases++;
        },
      };
    },
  } as unknown as ReadableStream<unknown>;
  return { stream, started, cancelCount: () => cancels, releaseCount: () => releases };
}

async function cancellationSample(): Promise<CancellationResult> {
  let lateFramesClosed = 0;
  const started = performance.now();
  for (let index = 0; index < CANCELLATIONS_PER_SAMPLE; index++) {
    const track = new BenchTrack();
    const late = new BenchVideoFrame(index, 1);
    const harness = lateReadHarness(late);
    const controller = new AbortController();
    const reader = decodeLiveMediaStream(liveSource(track), {
      signal: controller.signal,
      processorFactory: { create: () => harness.stream },
    }).video?.getReader();
    if (reader === undefined) throw new Error('benchmark cancellation stream is absent');
    const pending = reader.read();
    await harness.started;
    controller.abort('benchmark cancellation');
    let error: unknown;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    } finally {
      reader.releaseLock();
    }
    if (!(error instanceof MediaError) || error.code !== 'aborted') {
      throw new Error('pending live read did not surface a typed aborted error');
    }
    if (late.closeCount !== 1 || harness.cancelCount() !== 1 || harness.releaseCount() !== 1) {
      throw new Error(
        `cancel lifecycle close=${late.closeCount} cancel=${harness.cancelCount()} release=${harness.releaseCount()}`,
      );
    }
    if (track.stopCount !== 0) throw new Error('cancellation stopped its caller-owned track');
    lateFramesClosed += late.closeCount;
  }
  return {
    elapsedMs: performance.now() - started,
    cancellations: CANCELLATIONS_PER_SAMPLE,
    lateFramesClosed,
  };
}

async function sample(): Promise<SampleResult> {
  Bun.gc(true);
  const rssBeforeBytes = process.memoryUsage().rss;
  const throughput = await throughputSample();
  const cancellation = await cancellationSample();
  Bun.gc(true);
  const rssAfterBytes = process.memoryUsage().rss;
  if (rssBeforeBytes <= 0 || rssAfterBytes <= 0)
    throw new Error('RSS sampling returned no measurement');
  return { throughput, cancellation, rssBeforeBytes, rssAfterBytes };
}

Object.defineProperty(globalThis, 'VideoFrame', {
  configurable: true,
  value: BenchVideoFrame as unknown as typeof VideoFrame,
});

for (let index = 0; index < WARMUPS; index++) await sample();
const measured: SampleResult[] = [];
for (let index = 0; index < SAMPLES; index++) measured.push(await sample());

const checksums = new Set(measured.map((result) => result.throughput.checksum));
if (checksums.size !== 1) throw new Error('throughput checksum changed between measured samples');
const retainedRssBytes = (measured.at(-1)?.rssAfterBytes ?? 0) - (measured[0]?.rssAfterBytes ?? 0);
const retainedAllowanceBytes = 32 * 1024 * 1024;
if (retainedRssBytes > retainedAllowanceBytes) {
  throw new Error(
    `post-GC RSS retained ${retainedRssBytes} bytes; allowance ${retainedAllowanceBytes}`,
  );
}

console.log(
  JSON.stringify(
    {
      warmups: WARMUPS,
      samples: SAMPLES,
      framesPerSample: FRAMES_PER_SAMPLE,
      cancellationsPerSample: CANCELLATIONS_PER_SAMPLE,
      throughput: {
        samplesMs: measured.map((result) => result.throughput.elapsedMs),
        medianMs: median(measured.map((result) => result.throughput.elapsedMs)),
        medianFramesPerSecond:
          (FRAMES_PER_SAMPLE * 1000) /
          median(measured.map((result) => result.throughput.elapsedMs)),
        pulls: measured.map((result) => result.throughput.pulls),
        checksum: measured[0]?.throughput.checksum,
      },
      cancellation: {
        samplesMs: measured.map((result) => result.cancellation.elapsedMs),
        medianMs: median(measured.map((result) => result.cancellation.elapsedMs)),
        medianMicrosecondsPerCancellation:
          (median(measured.map((result) => result.cancellation.elapsedMs)) * 1000) /
          CANCELLATIONS_PER_SAMPLE,
        lateFramesClosed: measured.map((result) => result.cancellation.lateFramesClosed),
      },
      rssBeforeBytes: measured.map((result) => result.rssBeforeBytes),
      rssAfterBytes: measured.map((result) => result.rssAfterBytes),
      retainedRssBytes,
      retainedAllowanceBytes,
    },
    null,
    2,
  ),
);
