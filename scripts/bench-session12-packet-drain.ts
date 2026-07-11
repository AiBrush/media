#!/usr/bin/env bun
/** Fresh multi-sample benchmark for known-track preflight and sibling-safe packet draining (ADR-245). */

import {
  type MuxerSink,
  createDrainTaskGroup,
  drainEncoderToMuxer,
} from '../src/api/codec-pipeline.ts';
import { createMedia } from '../src/api/create-media.ts';
import { NoopDriverModule } from '../src/conformance/noop-driver.ts';
import type { EncodedChunk, Packet, TrackInfo } from '../src/contracts/driver.ts';
import { CapabilityError } from '../src/contracts/errors.ts';
import { fromBytes } from '../src/sources/source.ts';

const WARMUP = 3;
const SAMPLES = 11;
const PACKETS_PER_SAMPLE = 5_000;
const FAILURES_PER_SAMPLE = 250;
const HANDLES_PER_SAMPLE = 1_000;
const RETAINED_MEMORY_BOUND_BYTES = 64 * 1024 * 1024;
const CHECK = process.argv.includes('--check');
let sink = 0;

const OPUS_TRACK: TrackInfo = {
  id: 1,
  mediaType: 'audio',
  codec: 'opus',
  config: { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 },
};
const noopMedia = createMedia({ worker: false }).use(NoopDriverModule);
const noopSource = fromBytes(new Uint8Array([1, 2, 3, 4]), { mime: 'application/x-noop' });

function packet(timestamp: number): Packet {
  return { chunk: { timestamp } as unknown as EncodedChunk };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function successfulMuxer(onAddTrack: () => void): MuxerSink & { readonly writes: number } {
  let writes = 0;
  return {
    get writes(): number {
      return writes;
    },
    addTrack(track): number {
      if (track !== OPUS_TRACK) throw new Error('known-track benchmark lost track identity');
      onAddTrack();
      return 7;
    },
    write(trackId, value): Promise<void> {
      if (trackId !== 7) throw new Error('known-track benchmark lost mux track id');
      writes++;
      sink = (sink + value.chunk.timestamp + writes) | 0;
      return Promise.resolve();
    },
  };
}

async function successfulDrainSample(): Promise<number> {
  let trackAdded = false;
  let pulls = 0;
  const packets = new ReadableStream<Packet>(
    {
      pull(controller): void {
        if (!trackAdded) throw new Error('packet producer pulled before addTrack validation');
        if (pulls === PACKETS_PER_SAMPLE) {
          controller.close();
          return;
        }
        controller.enqueue(packet(pulls));
        pulls++;
      },
    },
    { highWaterMark: 0 },
  );
  const muxer = successfulMuxer(() => {
    trackAdded = true;
  });
  const signal = new AbortController().signal;
  const started = Bun.nanoseconds();
  await drainEncoderToMuxer(packets, muxer, OPUS_TRACK, signal);
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
  if (pulls !== PACKETS_PER_SAMPLE || muxer.writes !== PACKETS_PER_SAMPLE) {
    throw new Error(`packet drain benchmark lost work: pulls=${pulls}, writes=${muxer.writes}`);
  }
  return elapsedMs;
}

function pendingStream(counters: { pulls: number; cancels: number }): ReadableStream<Packet> {
  return new ReadableStream<Packet>(
    {
      pull(): void {
        counters.pulls++;
      },
      cancel(): void {
        counters.cancels++;
      },
    },
    { highWaterMark: 0 },
  );
}

async function failureGroup(): Promise<void> {
  const valid = { pulls: 0, cancels: 0 };
  const invalid = { pulls: 0, cancels: 0 };
  let added = 0;
  const muxer: MuxerSink = {
    addTrack(track): number {
      if (track.codec === 'illegal') {
        throw new CapabilityError('capability-miss', 'benchmark illegal track', {
          op: 'mux',
          tried: ['benchmark'],
        });
      }
      added++;
      return added;
    },
    write(): Promise<void> {
      throw new Error('pending benchmark stream must not write');
    },
  };
  const parent = new AbortController();
  const group = createDrainTaskGroup(parent.signal);
  try {
    const tasks = [
      drainEncoderToMuxer(pendingStream(valid), muxer, OPUS_TRACK, group.signal),
      drainEncoderToMuxer(
        pendingStream(invalid),
        muxer,
        { id: 2, mediaType: 'audio', codec: 'illegal' },
        group.signal,
      ),
    ];
    await group.run(tasks).then(
      () => {
        throw new Error('illegal-track benchmark unexpectedly succeeded');
      },
      (error: unknown) => {
        if (!(error instanceof CapabilityError)) throw error;
      },
    );
  } finally {
    group.dispose();
  }
  if (valid.pulls !== 1 || valid.cancels !== 1 || invalid.pulls !== 0 || invalid.cancels !== 1) {
    throw new Error(`sibling cancellation oracle failed: ${JSON.stringify({ valid, invalid })}`);
  }
  sink = (sink + valid.cancels + invalid.cancels) | 0;
}

async function failureSample(): Promise<number> {
  const started = Bun.nanoseconds();
  for (let index = 0; index < FAILURES_PER_SAMPLE; index++) await failureGroup();
  return (Bun.nanoseconds() - started) / 1_000_000;
}

async function listenerCleanupSample(): Promise<number> {
  let adds = 0;
  let removes = 0;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const signal = {
    aborted: false,
    reason: undefined,
    onabort: null,
    throwIfAborted(): void {},
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === 'abort') {
        adds++;
        listeners.add(listener);
      }
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === 'abort') {
        removes++;
        listeners.delete(listener);
      }
    },
    dispatchEvent(): boolean {
      return true;
    },
  } as AbortSignal;
  const started = Bun.nanoseconds();
  for (let index = 0; index < HANDLES_PER_SAMPLE; index++) {
    const info = await noopMedia.probe(noopSource, { signal });
    if (info.container !== 'noop') throw new Error('listener benchmark probe route changed');
  }
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
  if (adds !== HANDLES_PER_SAMPLE || removes !== HANDLES_PER_SAMPLE || listeners.size !== 0) {
    throw new Error(
      `operation listener cleanup failed: ${JSON.stringify({ adds, removes, live: listeners.size })}`,
    );
  }
  sink = (sink + adds + removes) | 0;
  return elapsedMs;
}

async function measure(run: () => Promise<number>): Promise<readonly number[]> {
  for (let index = 0; index < WARMUP; index++) await run();
  const values: number[] = [];
  for (let index = 0; index < SAMPLES; index++) values.push(await run());
  return values;
}

function collectGarbage(): void {
  Bun.gc(true);
}

const successSamples = await measure(successfulDrainSample);
const failureSamples = await measure(failureSample);
const listenerSamples = await measure(listenerCleanupSample);
// Bracket memory only after both hot loops have initialized/JITed, so retained RSS measures repeated
// task-domain work rather than one-time module/runtime startup.
collectGarbage();
const before = process.memoryUsage();
let peakProcessHeapBytes = before.heapUsed;
let peakRssBytes = before.rss;
for (let index = 0; index < 3; index++) {
  await successfulDrainSample();
  await failureSample();
  await listenerCleanupSample();
  const current = process.memoryUsage();
  peakProcessHeapBytes = Math.max(peakProcessHeapBytes, current.heapUsed);
  peakRssBytes = Math.max(peakRssBytes, current.rss);
}
collectGarbage();
const after = process.memoryUsage();
const retainedHeapBytes = after.heapUsed - before.heapUsed;
const retainedRssBytes = after.rss - before.rss;
if (peakProcessHeapBytes <= 0 || peakRssBytes <= 0) {
  throw new Error('packet drain memory samples must be positive');
}
if (
  retainedHeapBytes > RETAINED_MEMORY_BOUND_BYTES ||
  retainedRssBytes > RETAINED_MEMORY_BOUND_BYTES
) {
  throw new Error(
    `packet drain retained too much memory: heap=${retainedHeapBytes}, rss=${retainedRssBytes}`,
  );
}

const successMedianMs = median(successSamples);
const failureMedianMs = median(failureSamples);
const listenerMedianMs = median(listenerSamples);
if (CHECK && (successMedianMs > 500 || failureMedianMs > 500 || listenerMedianMs > 500)) {
  throw new Error(
    `packet drain benchmark exceeded safety ceiling: success=${successMedianMs}, failure=${failureMedianMs}, listeners=${listenerMedianMs}`,
  );
}

console.info(
  JSON.stringify({
    benchmark: 'session12-packet-drain',
    warmup: WARMUP,
    samples: SAMPLES,
    success: {
      packetsPerSample: PACKETS_PER_SAMPLE,
      samplesMs: successSamples,
      medianMs: successMedianMs,
      packetsPerSec: PACKETS_PER_SAMPLE / (successMedianMs / 1_000),
    },
    siblingFailure: {
      failuresPerSample: FAILURES_PER_SAMPLE,
      samplesMs: failureSamples,
      medianMs: failureMedianMs,
      groupsPerSec: FAILURES_PER_SAMPLE / (failureMedianMs / 1_000),
    },
    operationListenerCleanup: {
      handlesPerSample: HANDLES_PER_SAMPLE,
      samplesMs: listenerSamples,
      medianMs: listenerMedianMs,
      handlesPerSec: HANDLES_PER_SAMPLE / (listenerMedianMs / 1_000),
    },
    memory: {
      peakProcessHeapBytes,
      peakRssBytes,
      retainedHeapBytes,
      retainedRssBytes,
      retainedMemoryBoundBytes: RETAINED_MEMORY_BOUND_BYTES,
    },
    sink,
  }),
);

// Probe's bounded prefix cache owns a browser-lifetime expiry timer. It is intentionally irrelevant to a
// completed CLI benchmark and would otherwise keep Bun's event loop alive until that timer expires.
process.exit(0);
