/**
 * Session 6 R1 focused benchmark:
 * - fps/retime: CFR frame-retiming plans over real video packet timelines.
 * - trim:compose: accurate-trim frame-window composition over those same real timelines.
 * - Vorbis routing: default-driver WebCodecs-miss → wasm-vorbis selection over a real WebM/Vorbis track.
 *
 * This complements the broad browser harness; it is a fresh, multi-sample local benchmark for the
 * source-owned R1 proof surface and deliberately does not edit the sibling adapter.
 */

import { createMedia } from '../src/api/create-media.ts';
import { type TimedFrameForTrim, trimTimedFrameStream } from '../src/api/trim-streams.ts';
import { type FrameTiming, planCfrFrameRetiming } from '../src/api/video-stream-plan.ts';
import { resetVorbisCoreForTest } from '../src/codecs/wasm-vorbis/wasm-vorbis-driver.ts';
import type { PacketMetadata } from '../src/contracts/driver.ts';
import { registerDefaultDrivers } from '../src/drivers/defaults.ts';
import { demuxWebm } from '../src/drivers/webm/webm-driver.ts';
import { Registry } from '../src/kernel/registry.ts';
import { Router } from '../src/kernel/router.ts';
import { fixtureSource, loadFixture } from '../src/test-support/corpus.ts';

const WARMUP = 3;
const ITERS = 21;
const MICROS_PER_SECOND = 1_000_000;

const RETIME_FIXTURES = [
  'movie_5.mp4',
  'test.mp4',
  'h264.mp4',
  'av1.mp4',
  'h265.mp4',
  'bear-1280x720.mp4',
] as const;

const FPS_TARGETS = [1, 15, 30, 60, 240] as const;

interface TimelineFixture {
  readonly id: string;
  readonly durationUs: number;
  readonly frames: readonly FrameTiming[];
}

interface BenchResult {
  readonly name: string;
  readonly medianMs: number;
  readonly samples: readonly number[];
  readonly checksum: number;
  readonly fixtureCount: number;
}

class BenchFrame implements TimedFrameForTrim {
  closeCount = 0;

  constructor(
    readonly timestamp: number,
    readonly duration: number | null,
  ) {}

  close(): void {
    this.closeCount++;
    if (this.closeCount > 1) throw new Error(`bench frame ${this.timestamp} closed twice`);
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted[mid];
  if (value === undefined) throw new Error('cannot take median of an empty sample set');
  return value;
}

function nsToMs(ns: number): number {
  return ns / 1_000_000;
}

function startNs(): number {
  return Number(Bun.nanoseconds());
}

async function runBench(
  name: string,
  fixtureCount: number,
  fn: () => Promise<number> | number,
): Promise<BenchResult> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples: number[] = [];
  let checksum = 0;
  for (let i = 0; i < ITERS; i++) {
    const start = startNs();
    checksum += await fn();
    samples.push(nsToMs(startNs() - start));
  }
  return { name, medianMs: median(samples), samples, checksum, fixtureCount };
}

function timingsFromPacketTable(
  fixtureId: string,
  table: readonly PacketMetadata[],
  trackId: number,
  durationUs: number,
): TimelineFixture {
  const frames = table
    .filter((packet) => packet.trackId === trackId)
    .sort((a, b) => a.ptsUs - b.ptsUs)
    .map((packet): FrameTiming => ({ timestamp: packet.ptsUs, duration: packet.durationUs }));
  if (frames.length < 3) throw new Error(`${fixtureId} needs at least 3 video packets`);
  return { id: fixtureId, durationUs, frames };
}

async function loadTimelineFixtures(): Promise<readonly TimelineFixture[]> {
  const media = createMedia();
  const out: TimelineFixture[] = [];
  for (const id of RETIME_FIXTURES) {
    const demuxer = await media.demux(await fixtureSource(id));
    try {
      const video = demuxer.tracks.find((track) => track.mediaType === 'video');
      if (video === undefined) throw new Error(`${id} has no video track`);
      const table = demuxer.packetTable?.();
      if (table === undefined) throw new Error(`${id} has no packet table`);
      const durationSec = video.durationSec ?? demuxer.tracks[0]?.durationSec;
      if (durationSec === undefined || durationSec <= 0) throw new Error(`${id} has no duration`);
      out.push(
        timingsFromPacketTable(id, table, video.id, Math.round(durationSec * MICROS_PER_SECOND)),
      );
    } finally {
      await demuxer.close();
    }
  }
  return out;
}

function retimeChecksum(fixtures: readonly TimelineFixture[]): number {
  let checksum = 0;
  for (const fixture of fixtures) {
    for (const fps of FPS_TARGETS) {
      const plan = planCfrFrameRetiming(fixture.frames, {
        fps,
        durationUs: fixture.durationUs,
      });
      checksum += plan.outputs.length * 31 + plan.droppedSourceIndexes.length * 17;
      checksum += Math.round((plan.endsAtUs ?? 0) - (plan.startsAtUs ?? 0));
    }
  }
  return checksum;
}

function frameStream(frames: readonly FrameTiming[]): ReadableStream<BenchFrame> {
  let index = 0;
  return new ReadableStream<BenchFrame>({
    pull(controller): void {
      const frame = frames[index];
      index++;
      if (frame === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(new BenchFrame(frame.timestamp, frame.duration ?? null));
    },
  });
}

async function collectTrimmed(
  frames: readonly FrameTiming[],
  startUs: number,
  endUs: number,
): Promise<number> {
  const reader = trimTimedFrameStream(
    frameStream(frames),
    { startUs, endUs },
    (_frame, timestamp, duration) => new BenchFrame(timestamp, duration),
  ).getReader();
  let checksum = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) return checksum;
      checksum += read.value.timestamp + (read.value.duration ?? 0);
      read.value.close();
    }
  } finally {
    reader.releaseLock();
  }
}

async function trimComposeChecksum(fixtures: readonly TimelineFixture[]): Promise<number> {
  let checksum = 0;
  for (const fixture of fixtures) {
    const first = fixture.frames[0];
    const split = fixture.frames[Math.floor(fixture.frames.length / 2)];
    const last = fixture.frames[fixture.frames.length - 1];
    if (first === undefined || split === undefined || last === undefined) {
      throw new Error(`${fixture.id} timeline is unexpectedly empty`);
    }
    const startUs = first.timestamp;
    const splitUs = split.timestamp;
    const endUs = Math.min(fixture.durationUs, last.timestamp + (last.duration ?? 1));
    checksum += await collectTrimmed(fixture.frames, startUs, endUs);
    checksum += await collectTrimmed(fixture.frames, startUs, splitUs);
    checksum += await collectTrimmed(fixture.frames, splitUs, endUs);
  }
  return checksum;
}

function installAudioRoutingShims(): () => void {
  const originalAudioDecoder = globalThis.AudioDecoder;
  const originalAudioData = globalThis.AudioData;
  const originalEncodedAudioChunk = globalThis.EncodedAudioChunk;
  const isConfigSupported = async (config: AudioDecoderConfig): Promise<AudioDecoderSupport> => ({
    supported: false,
    config,
  });
  Object.defineProperty(globalThis, 'AudioDecoder', {
    configurable: true,
    writable: true,
    value: { isConfigSupported } as unknown as typeof AudioDecoder,
  });
  Object.defineProperty(globalThis, 'AudioData', {
    configurable: true,
    writable: true,
    value: class BenchAudioData {
      close(): void {}
    } as unknown as typeof AudioData,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    writable: true,
    value: class BenchEncodedAudioChunk {} as unknown as typeof EncodedAudioChunk,
  });
  return () => {
    if (originalAudioDecoder === undefined) Reflect.deleteProperty(globalThis, 'AudioDecoder');
    else
      Object.defineProperty(globalThis, 'AudioDecoder', {
        configurable: true,
        writable: true,
        value: originalAudioDecoder,
      });
    if (originalAudioData === undefined) Reflect.deleteProperty(globalThis, 'AudioData');
    else
      Object.defineProperty(globalThis, 'AudioData', {
        configurable: true,
        writable: true,
        value: originalAudioData,
      });
    if (originalEncodedAudioChunk === undefined)
      Reflect.deleteProperty(globalThis, 'EncodedAudioChunk');
    else
      Object.defineProperty(globalThis, 'EncodedAudioChunk', {
        configurable: true,
        writable: true,
        value: originalEncodedAudioChunk,
      });
  };
}

async function loadVorbisConfig(): Promise<AudioDecoderConfig> {
  const bytes = await loadFixture('bear-multitrack.webm');
  const demuxed = demuxWebm(bytes);
  const vorbis = demuxed.info.tracks.find((track) => track.codec === 'vorbis');
  if (vorbis?.description === undefined)
    throw new Error('bear-multitrack.webm has no Vorbis track');
  return {
    codec: 'vorbis',
    sampleRate: vorbis.sampleRate ?? 0,
    numberOfChannels: vorbis.channels ?? 0,
    description: vorbis.description,
  };
}

async function vorbisRouteChecksum(config: AudioDecoderConfig): Promise<number> {
  const reg = new Registry();
  registerDefaultDrivers(reg);
  const router = new Router({ registry: reg });
  let checksum = 0;
  for (let i = 0; i < 5; i++) {
    router.clearCache();
    const picked = await router.pickCodec({ mediaType: 'audio', direction: 'decode', config });
    if (picked.id !== 'wasm-vorbis') throw new Error(`expected wasm-vorbis, got ${picked.id}`);
    checksum += picked.id.length;
  }
  return checksum;
}

async function main(): Promise<void> {
  const timelines = await loadTimelineFixtures();
  const vorbisConfig = await loadVorbisConfig();
  const restoreAudio = installAudioRoutingShims();
  try {
    resetVorbisCoreForTest();
    const results = [
      await runBench('fps retime plan (real packet timelines)', timelines.length, () =>
        retimeChecksum(timelines),
      ),
      await runBench('trim compose windows (real packet timelines)', timelines.length, () =>
        trimComposeChecksum(timelines),
      ),
      await runBench('vorbis decode route (webcodecs miss -> wasm)', 1, () =>
        vorbisRouteChecksum(vorbisConfig),
      ),
    ];
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          warmup: WARMUP,
          iters: ITERS,
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    restoreAudio();
    resetVorbisCoreForTest();
  }
}

await main();
