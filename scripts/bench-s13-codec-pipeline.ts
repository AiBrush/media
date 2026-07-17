#!/usr/bin/env bun

/**
 * S13 codec-pipeline micro-benchmarks (R-S13.1/4/5/6/8/10): the shared-brain hot paths measured fresh
 * after the god-file split, with can-fail correctness asserts inline (never a smoke run):
 *
 *   config.video        buildVideoEncoderConfig across the golden matrix (implicit + evidence rows)
 *   config.resolve      resolveVideoEncoderCodecString on the same rows (shares ONE plan — no drift)
 *   evidence.table      sourceVideoBitrateFromPacketTable over a 10k-row VFR/B-frame packet table
 *   unwrap.project      unwrapPackets projection of 5k packets under HWM-0 backpressure
 *   pairing.frames      encodeVpxAlphaFrameStreams pairing 2k aligned colour/alpha frames
 *   pairing.decode      decodeVideoPacketsWithAlpha merge pairing of 500 frame pairs (WeakMap sidecar)
 *
 * `--check` gates machine-independent invariants only (finite positive medians; resolver overhead ≤ 3×
 * the config build, both projecting the same plan). Numbers are medians over fresh samples with MAD.
 */

import {
  type SourceGeometry,
  buildVideoEncoderConfig,
  decodeVideoPacketsWithAlpha,
  encodeVpxAlphaFrameStreams,
  resolveVideoEncoderCodecString,
  sourceVideoBitrateFromPacketTable,
  unwrapPackets,
} from '../src/api/codec-pipeline.ts';
import type { VideoTarget } from '../src/api/types.ts';
import type { EncodedChunk, Packet, PacketMetadata, RawFrame } from '../src/contracts/driver.ts';

const WARMUP = 3;
const SAMPLES = 15;
const CONFIG_ITERATIONS = 2_000;
const TABLE_ROWS = 10_000;
const UNWRAP_PACKETS = 5_000;
const PAIRING_FRAMES = 2_000;
const DECODE_PAIRS = 500;
const check = process.argv.includes('--check');
let sink = 0;

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1] ?? Number.NaN;
  const high = sorted[mid] ?? Number.NaN;
  return sorted.length % 2 === 0 ? (low + high) / 2 : high;
}

function mad(xs: readonly number[], m: number): number {
  return median(xs.map((x) => Math.abs(x - m)));
}

async function sample(label: string, run: () => Promise<number> | number): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < WARMUP; i++) await run();
  for (let i = 0; i < SAMPLES; i++) {
    const start = performance.now();
    const ops = await run();
    const elapsed = performance.now() - start;
    times.push((elapsed * 1e6) / ops); // ns per op
  }
  const m = median(times);
  const spread = mad(times, m);
  console.log(
    `${label.padEnd(18)} ${m.toFixed(1).padStart(10)} ns/op  (MAD ${spread.toFixed(1)}, n=${SAMPLES})`,
  );
  if (!(Number.isFinite(m) && m > 0)) throw new Error(`${label}: non-finite median`);
  return m;
}

function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// ── golden config matrix (mirrors the unit-test goldens — a wrong string/bitrate fails the bench) ──

const CONFIG_ROWS: readonly [VideoTarget, SourceGeometry, string | undefined, string, number?][] = [
  [
    { codec: 'h264', width: 1280, height: 720, fps: 30 },
    { width: 1920, height: 1080 },
    undefined,
    'avc1.42E01F',
    18_432_000,
  ],
  [
    { codec: 'vp9', width: 1280, height: 720, fps: 30 },
    { width: 1920, height: 1080 },
    undefined,
    'vp09.00.40.08',
    14_745_600,
  ],
  [
    { codec: 'av1', width: 1280, height: 720, fps: 60 },
    { width: 1920, height: 1080 },
    undefined,
    'av01.0.09M.08',
    15_640_071,
  ],
  [{ codec: 'hevc', bitDepth: 10 }, { width: 1920, height: 1080 }, undefined, 'hev1.2.4.L120.B0'],
  [{}, { width: 1920, height: 1080 }, 'avc1.640028', 'avc1.640028'],
  [
    { codec: 'vp9' },
    { width: 1920, height: 1080, fps: 24, bitrate: 4_000_000 },
    'av01.0.05M.08',
    'vp09.00.40.08',
    10_666_667,
  ],
];

function benchConfigBuild(): number {
  for (let i = 0; i < CONFIG_ITERATIONS; i++) {
    for (const [target, src, sourceCodec, codec, bitrate] of CONFIG_ROWS) {
      const config = buildVideoEncoderConfig(target, src, sourceCodec);
      if (i === 0) {
        assertEqual(config.codec, codec, 'config codec');
        if (bitrate !== undefined) assertEqual(config.bitrate, bitrate, 'config bitrate');
      }
      sink += config.width;
    }
  }
  return CONFIG_ITERATIONS * CONFIG_ROWS.length;
}

function benchResolve(): number {
  for (let i = 0; i < CONFIG_ITERATIONS; i++) {
    for (const [target, src, sourceCodec, codec] of CONFIG_ROWS) {
      const resolved = resolveVideoEncoderCodecString(target, src, sourceCodec);
      if (i === 0) assertEqual(resolved, codec, 'resolved codec string');
      sink += resolved.length;
    }
  }
  return CONFIG_ITERATIONS * CONFIG_ROWS.length;
}

// ── evidence table (VFR + B-frame reorder: DTS+duration span, PTS adversarial) ────────────────────

const packetTable: PacketMetadata[] = Array.from({ length: TABLE_ROWS }, (_, i) => ({
  trackId: 1,
  sizeBytes: 500 + (i % 7) * 100,
  ptsUs: ((i * 7919) % TABLE_ROWS) * 33_000, // adversarial PTS — must not affect the result
  dtsUs: i * 33_000,
  durationUs: i % 3 === 0 ? 16_667 : 41_667,
  keyframe: i % 48 === 0,
}));
// span = (last dts + its duration) − first dts; bytes = Σ sizeBytes — derived once, asserted per run.
const tableBytes = packetTable.reduce((total, row) => total + row.sizeBytes, 0);
const lastRow = packetTable[TABLE_ROWS - 1];
if (lastRow === undefined) throw new Error('empty packet table');
const tableSpanUs = lastRow.dtsUs + lastRow.durationUs - 0;
const expectedTableBitrate = Math.round((tableBytes * 8 * 1_000_000) / tableSpanUs);

function benchEvidenceTable(): number {
  const bitrate = sourceVideoBitrateFromPacketTable(packetTable, 1);
  assertEqual(bitrate, expectedTableBitrate, 'packet-table bitrate');
  sink += bitrate ?? 0;
  return TABLE_ROWS;
}

// ── live pairing with counting fakes (close-exactly-once asserted every sample) ──────────────────

class BenchFrame {
  closeCount = 0;
  constructor(readonly timestamp: number) {}
  close(): void {
    this.closeCount++;
  }
}

function frameSource(frames: readonly BenchFrame[]): ReadableStream<VideoFrame> {
  let i = 0;
  return new ReadableStream<VideoFrame>(
    {
      pull(controller): void {
        const frame = frames[i];
        i++;
        if (frame === undefined) controller.close();
        else controller.enqueue(frame as unknown as VideoFrame);
      },
      cancel(): void {
        for (let rest = i; rest < frames.length; rest++) frames[rest]?.close();
      },
    },
    { highWaterMark: 0 },
  );
}

const closingEncoder = (): TransformStream<RawFrame, EncodedChunk> =>
  new TransformStream<RawFrame, EncodedChunk>({
    transform(frame, controller): void {
      const timestamp = (frame as unknown as { timestamp: number }).timestamp;
      frame.close();
      controller.enqueue({ timestamp } as unknown as EncodedChunk);
    },
  });

async function benchFramePairing(): Promise<number> {
  const colors = Array.from({ length: PAIRING_FRAMES }, (_, i) => new BenchFrame(i));
  const alphas = Array.from({ length: PAIRING_FRAMES }, (_, i) => new BenchFrame(i));
  const reader = encodeVpxAlphaFrameStreams(frameSource(colors), frameSource(alphas), {
    encodeConfig: { codec: 'vp09.00.10.08', width: 2, height: 2 },
    createEncoder: closingEncoder,
  }).getReader();
  let packets = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.alpha === undefined) throw new Error('pairing lost an alpha chunk');
    packets++;
  }
  assertEqual(packets, PAIRING_FRAMES, 'paired packet count');
  for (const frame of colors) assertEqual(frame.closeCount, 1, 'colour close-once');
  for (const frame of alphas) assertEqual(frame.closeCount, 1, 'alpha close-once');
  return PAIRING_FRAMES;
}

function packetSource(count: number): ReadableStream<Packet> {
  let i = 0;
  return new ReadableStream<Packet>(
    {
      pull(controller): void {
        if (i < count) {
          controller.enqueue({
            chunk: { timestamp: i } as unknown as EncodedChunk,
            alpha: { timestamp: i } as unknown as EncodedVideoChunk,
          });
          i++;
        } else {
          controller.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

async function benchUnwrap(): Promise<number> {
  const reader = unwrapPackets(packetSource(UNWRAP_PACKETS)).getReader();
  let chunks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.timestamp !== chunks) throw new Error('unwrap reordered chunks');
    chunks++;
  }
  assertEqual(chunks, UNWRAP_PACKETS, 'unwrapped chunk count');
  return UNWRAP_PACKETS;
}

/** 2×2 RGBA frame whose pixels the decode pairing merges; close-once asserted per sample. */
class BenchPixelFrame extends BenchFrame {
  readonly codedWidth = 2;
  readonly codedHeight = 2;
  readonly displayWidth = 2;
  readonly displayHeight = 2;
  readonly duration = null;
  readonly format = null;
  allocationSize(): number {
    return 16;
  }
  copyTo(destination: AllowSharedBufferSource): Promise<PlaneLayout[]> {
    const bytes = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    bytes.fill(128);
    return Promise.resolve([{ offset: 0, stride: 8 }]);
  }
}

async function benchDecodePairing(): Promise<number> {
  const colors = Array.from({ length: DECODE_PAIRS }, (_, i) => new BenchPixelFrame(i));
  const alphas = Array.from({ length: DECODE_PAIRS }, (_, i) => new BenchPixelFrame(i));
  const constructedFrames: BenchPixelFrame[] = [];
  const FakeVideoFrame = function (
    this: unknown,
    _data: AllowSharedBufferSource,
    init: VideoFrameBufferInit,
  ): BenchPixelFrame {
    const frame = new BenchPixelFrame(init.timestamp);
    constructedFrames.push(frame);
    return frame;
  } as unknown as typeof VideoFrame;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  Object.defineProperty(globalThis, 'VideoFrame', { configurable: true, value: FakeVideoFrame });
  try {
    let decoderCount = 0;
    const createDecoder = (): TransformStream<EncodedChunk, RawFrame> => {
      decoderCount++;
      const planes = decoderCount === 1 ? colors : alphas;
      let i = 0;
      return new TransformStream<EncodedChunk, RawFrame>({
        transform(_chunk, controller): void {
          const plane = planes[i++];
          if (plane !== undefined) controller.enqueue(plane as unknown as RawFrame);
        },
      });
    };
    const reader = decodeVideoPacketsWithAlpha(
      packetSource(DECODE_PAIRS),
      createDecoder,
    ).getReader();
    let merged = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      merged++;
      value.close();
    }
    assertEqual(merged, DECODE_PAIRS, 'merged frame count');
    for (const frame of colors) assertEqual(frame.closeCount, 1, 'decode colour close-once');
    for (const frame of alphas) assertEqual(frame.closeCount, 1, 'decode alpha close-once');
    for (const frame of constructedFrames) assertEqual(frame.closeCount, 1, 'merged close-once');
  } finally {
    if (original !== undefined) Object.defineProperty(globalThis, 'VideoFrame', original);
    else Reflect.deleteProperty(globalThis, 'VideoFrame');
  }
  return DECODE_PAIRS;
}

const configNs = await sample('config.video', benchConfigBuild);
const resolveNs = await sample('config.resolve', benchResolve);
await sample('evidence.table', benchEvidenceTable);
await sample('unwrap.project', benchUnwrap);
await sample('pairing.frames', benchFramePairing);
await sample('pairing.decode', benchDecodePairing);

if (check) {
  // Machine-independent: the resolver projects the SAME plan as the config build; sharing means its
  // cost stays within a small factor (no duplicated second resolution pipeline).
  if (resolveNs > configNs * 3) {
    throw new Error(`config.resolve ${resolveNs}ns exceeds 3x config.video ${configNs}ns`);
  }
  console.log('bench-s13-codec-pipeline: check OK');
}
sink = Math.trunc(sink % 7);
if (sink === Number.MIN_SAFE_INTEGER) throw new Error('unreachable sink guard');
