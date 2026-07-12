#!/usr/bin/env bun
/** Exact VP9-alpha semantic rewrite benchmark for ADR-270 on ADR-263's proof route. */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMedia } from '../src/api/create-media.ts';
import type { EncodedChunk, Packet, TrackInfo } from '../src/contracts/driver.ts';

const FIXTURE = new URL(
  '../../media-test/fixtures/media/scenarios/transcode/vp9_alpha_to_vp9_keepalpha/03.webm',
  import.meta.url,
);
const FIXTURE_SHA256 = '518640653e936308e2c85aae4d6f02b35bbac468b82c36486732e284d599e513';
const WARMUP = 3;
const SAMPLES = 21;

interface PacketTruth {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly type: EncodedChunk['type'];
  readonly dtsUs?: number;
  readonly colorSha256: string;
  readonly alphaSha256?: string;
}

interface ChunkInit {
  readonly type: EncodedAudioChunkType | EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration?: number;
  readonly data: AllowSharedBufferSource;
}

function writableBytes(value: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
}

class BenchmarkEncodedChunk {
  readonly type: EncodedAudioChunkType | EncodedVideoChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #data: Uint8Array;

  constructor(init: ChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#data = writableBytes(init.data).slice();
    this.byteLength = this.#data.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    writableBytes(destination).set(this.#data);
  }
}

function installEncodedChunkShims(): void {
  const Chunk = BenchmarkEncodedChunk as unknown as typeof EncodedVideoChunk &
    typeof EncodedAudioChunk;
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    writable: true,
    value: Chunk,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    writable: true,
    value: Chunk,
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function mad(values: readonly number[]): number {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function bytesOf(chunk: EncodedChunk): Uint8Array {
  const bytes = new Uint8Array(chunk.byteLength);
  chunk.copyTo(bytes);
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function packetTruth(packet: Packet): PacketTruth {
  const color =
    packet.data !== undefined && packet.data.byteLength === packet.chunk.byteLength
      ? packet.data
      : bytesOf(packet.chunk);
  return {
    timestamp: packet.chunk.timestamp,
    duration: packet.chunk.duration,
    type: packet.chunk.type,
    ...(packet.dtsUs !== undefined ? { dtsUs: packet.dtsUs } : {}),
    colorSha256: sha256(color),
    ...(packet.alpha !== undefined ? { alphaSha256: sha256(bytesOf(packet.alpha)) } : {}),
  };
}

function normalizedTrack(track: TrackInfo): unknown {
  return {
    mediaType: track.mediaType,
    codec: track.codec,
    durationSec: track.durationSec,
    alpha: track.alpha,
    rotation: track.rotation,
    config: track.config,
  };
}

async function inspect(bytes: Uint8Array): Promise<{
  readonly track: unknown;
  readonly packets: readonly PacketTruth[];
}> {
  const demuxed = await createMedia({ worker: false }).demux(bytes);
  try {
    const video = demuxed.tracks.find((track) => track.mediaType === 'video');
    if (video === undefined || video.alpha !== true) {
      throw new Error('VP9-alpha benchmark source lost its declared alpha video track');
    }
    const packets: PacketTruth[] = [];
    const reader = demuxed.packets(video.id).getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        packets.push(packetTruth(next.value));
      }
    } finally {
      reader.releaseLock();
    }
    return { track: normalizedTrack(video), packets };
  } finally {
    await demuxed.close();
  }
}

async function convert(
  bytes: Uint8Array,
): Promise<{ readonly bytes: Uint8Array; readonly ms: number }> {
  const media = createMedia({ worker: false });
  const started = Bun.nanoseconds();
  const output = await media.convert(bytes, {
    to: 'webm',
    video: { codec: 'vp9', alpha: 'keep' },
    audio: false,
  });
  const ms = (Bun.nanoseconds() - started) / 1_000_000;
  if (!(output instanceof Blob)) throw new Error('VP9-alpha semantic rewrite expected Blob output');
  return { bytes: new Uint8Array(await output.arrayBuffer()), ms };
}

installEncodedChunkShims();
const input = new Uint8Array(await readFile(FIXTURE));
if (sha256(input) !== FIXTURE_SHA256) throw new Error('selected real03 fixture integrity mismatch');
const expected = await inspect(input);
if (
  expected.packets.length !== 60 ||
  expected.packets.some((packet) => packet.alphaSha256 === undefined)
) {
  throw new Error('selected real03 must expose exact alpha side data on all 60 packets');
}
for (let iteration = 0; iteration < WARMUP; iteration++) await convert(input);

const samplesMs: number[] = [];
let outputBytes = 0;
let outputSha256 = '';
for (let iteration = 0; iteration < SAMPLES; iteration++) {
  const measured = await convert(input);
  samplesMs.push(measured.ms);
  outputBytes = measured.bytes.byteLength;
  outputSha256 = sha256(measured.bytes);
  const actual = await inspect(measured.bytes);
  if (JSON.stringify(actual.track) !== JSON.stringify(expected.track)) {
    throw new Error(`VP9-alpha semantic rewrite changed track truth on sample ${iteration}`);
  }
  if (JSON.stringify(actual.packets) !== JSON.stringify(expected.packets)) {
    throw new Error(`VP9-alpha semantic rewrite changed packet/alpha truth on sample ${iteration}`);
  }
}

console.info(
  JSON.stringify(
    {
      fixture: FIXTURE.pathname.split('/').at(-1),
      inputSha256: FIXTURE_SHA256,
      inputBytes: input.byteLength,
      outputBytes,
      outputSha256,
      packetCount: expected.packets.length,
      alphaPacketCount: expected.packets.filter((packet) => packet.alphaSha256 !== undefined)
        .length,
      warmup: WARMUP,
      samples: SAMPLES,
      medianMs: median(samplesMs),
      madMs: mad(samplesMs),
      samplesMs,
      exactTrackPacketColorAndAlphaTruth: true,
      metadataProvedRedundantAudioExclusion: true,
    },
    null,
    2,
  ),
);
