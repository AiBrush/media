import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  type CodecDriver,
  type CodecQuery,
  type CodecSupport,
  DRIVER_API_VERSION,
  type DriverModule,
  type EncodedChunk,
  type Packet,
  type RawFrame,
  type Registry,
  type StageOptions,
  type TrackInfo,
} from '../contracts/driver.ts';
import { Mp4Module } from '../drivers/mp4/mp4-driver.ts';
import { fromBytes } from '../sources/source.ts';
import { sha256Hex } from '../util/digest.ts';
import { createMedia } from './create-media.ts';
import type { MediaEngine } from './engine.ts';

const REAL_H264_AAC_FIXTURE = new URL('../../fixtures/media/movie_5.mp4', import.meta.url);
const FAKE_CODEC_ID = 'trim-composition-structural-h264';
const EXPECTED_DURATION_US = 4_000_000;

function bufferSourceBytes(source: AllowSharedBufferSource): Uint8Array {
  const view = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer as ArrayBufferLike, source.byteOffset, source.byteLength)
    : new Uint8Array(source as ArrayBufferLike);
  return view.slice();
}

class StructuralEncodedChunk {
  readonly type: EncodedVideoChunkType | EncodedAudioChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly byteLength: number;
  readonly #bytes: Uint8Array;

  constructor(init: EncodedVideoChunkInit | EncodedAudioChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this.#bytes = bufferSourceBytes(init.data);
    this.byteLength = this.#bytes.byteLength;
  }

  copyTo(destination: AllowSharedBufferSource): void {
    const view = ArrayBuffer.isView(destination)
      ? new Uint8Array(
          destination.buffer as ArrayBufferLike,
          destination.byteOffset,
          destination.byteLength,
        )
      : new Uint8Array(destination as ArrayBufferLike);
    view.set(this.#bytes);
  }
}

interface StructuralFrameSeed {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly type: EncodedVideoChunkType;
  readonly bytes: Uint8Array;
  readonly ordinal: number;
}

class StructuralVideoFrame {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly type: EncodedVideoChunkType;
  readonly bytes: Uint8Array;
  readonly ordinal: number;
  #closed = false;

  constructor(source: StructuralVideoFrame | StructuralFrameSeed, init?: VideoFrameInit) {
    this.timestamp = init?.timestamp ?? source.timestamp;
    const duration = init !== undefined && 'duration' in init ? init.duration : source.duration;
    this.duration = duration ?? null;
    this.type = source.type;
    this.bytes = source.bytes;
    this.ordinal = source.ordinal;
  }

  close(): void {
    if (this.#closed) throw new Error(`structural frame ${this.ordinal} closed twice`);
    this.#closed = true;
  }
}

interface VideoEncoderStageOptions extends StageOptions {
  readonly onDecoderConfig?: (config: VideoDecoderConfig) => void;
}

function structuralH264Module(): DriverModule {
  let sourceConfig: VideoDecoderConfig | undefined;
  const codec: CodecDriver = {
    id: FAKE_CODEC_ID,
    apiVersion: DRIVER_API_VERSION,
    kind: 'codec',
    tier: 'native',
    supports(query: CodecQuery): Promise<CodecSupport> {
      const token = query.config.codec.toLowerCase();
      return Promise.resolve({
        supported:
          query.mediaType === 'video' &&
          (token === 'h264' || token.startsWith('avc1.') || token.startsWith('avc3.')),
        hardwareAccelerated: false,
      });
    },
    createDecoder(config): TransformStream<EncodedChunk, RawFrame> {
      sourceConfig = config as VideoDecoderConfig;
      const frames: StructuralVideoFrame[] = [];
      let ordinal = 0;
      return new TransformStream<EncodedChunk, RawFrame>({
        transform(chunk): void {
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          frames.push(
            new StructuralVideoFrame({
              timestamp: chunk.timestamp,
              duration: chunk.duration ?? null,
              type: chunk.type as EncodedVideoChunkType,
              bytes,
              ordinal,
            }),
          );
          ordinal++;
        },
        flush(controller): void {
          // A real decoder emits presentation order even when MP4 packets arrive in decode order.
          frames.sort(
            (left, right) => left.timestamp - right.timestamp || left.ordinal - right.ordinal,
          );
          for (const frame of frames) controller.enqueue(frame as unknown as RawFrame);
        },
      });
    },
    createEncoder(_config, options): TransformStream<RawFrame, EncodedChunk> {
      const published = sourceConfig;
      if (published === undefined) throw new Error('structural encoder started before its decoder');
      (options as VideoEncoderStageOptions | undefined)?.onDecoderConfig?.(published);
      return new TransformStream<RawFrame, EncodedChunk>({
        transform(value, controller): void {
          const frame = value as unknown as StructuralVideoFrame;
          try {
            controller.enqueue(
              new StructuralEncodedChunk({
                type: frame.type,
                timestamp: frame.timestamp,
                ...(frame.duration !== null ? { duration: frame.duration } : {}),
                data: frame.bytes,
              }) as unknown as EncodedChunk,
            );
          } finally {
            frame.close();
          }
        },
      });
    },
  };
  return {
    apiVersion: DRIVER_API_VERSION,
    register(registry: Registry): void {
      registry.addCodec(codec);
    },
  };
}

function installStructuralWebCodecs(): () => void {
  const originalVideoFrame = globalThis.VideoFrame;
  const originalVideoChunk = globalThis.EncodedVideoChunk;
  const originalAudioChunk = globalThis.EncodedAudioChunk;
  Object.defineProperty(globalThis, 'VideoFrame', {
    configurable: true,
    value: StructuralVideoFrame as unknown as typeof VideoFrame,
  });
  Object.defineProperty(globalThis, 'EncodedVideoChunk', {
    configurable: true,
    value: StructuralEncodedChunk as unknown as typeof EncodedVideoChunk,
  });
  Object.defineProperty(globalThis, 'EncodedAudioChunk', {
    configurable: true,
    value: StructuralEncodedChunk as unknown as typeof EncodedAudioChunk,
  });
  return () => {
    restoreGlobal('VideoFrame', originalVideoFrame);
    restoreGlobal('EncodedVideoChunk', originalVideoChunk);
    restoreGlobal('EncodedAudioChunk', originalAudioChunk);
  };
}

function restoreGlobal<K extends 'VideoFrame' | 'EncodedVideoChunk' | 'EncodedAudioChunk'>(
  key: K,
  value: (typeof globalThis)[K] | undefined,
): void {
  if (value === undefined) Reflect.deleteProperty(globalThis, key);
  else Object.defineProperty(globalThis, key, { configurable: true, value });
}

async function blobBytes(value: unknown): Promise<Uint8Array> {
  if (!(value instanceof Blob)) throw new Error('expected trim/mux Blob output');
  return new Uint8Array(await value.arrayBuffer());
}

function copyPacketAtOffset(
  packet: Packet,
  mediaType: TrackInfo['mediaType'],
  offsetUs: number,
  presentationOffsetUs = offsetUs,
): Packet {
  const bytes = new Uint8Array(packet.chunk.byteLength);
  packet.chunk.copyTo(bytes);
  const init = {
    type: packet.chunk.type,
    timestamp: Math.round(packet.chunk.timestamp) + presentationOffsetUs,
    ...(packet.chunk.duration !== null ? { duration: Math.round(packet.chunk.duration) } : {}),
    data: bytes,
  };
  const chunk =
    mediaType === 'video'
      ? new EncodedVideoChunk(init as EncodedVideoChunkInit)
      : new EncodedAudioChunk(init as EncodedAudioChunkInit);
  return {
    ...packet,
    chunk,
    data: bytes,
    ...(packet.dtsUs !== undefined ? { dtsUs: Math.round(packet.dtsUs) + offsetUs } : {}),
  };
}

interface ConcatenatedTrack {
  track: TrackInfo;
  packets: Packet[];
  gapless: TrackInfo['gapless'];
}

function packetDtsUs(packet: Packet): number {
  return Math.round(packet.dtsUs ?? packet.chunk.timestamp);
}

function packetDurationUs(packet: Packet): number {
  return Math.max(0, Math.round(packet.chunk.duration ?? 0));
}

function packetPayloadBytes(packet: Packet): Uint8Array {
  if (packet.data !== undefined && packet.data.byteLength === packet.chunk.byteLength) {
    return packet.data;
  }
  const bytes = new Uint8Array(packet.chunk.byteLength);
  packet.chunk.copyTo(bytes);
  return bytes;
}

function samePayload(left: Packet, right: Packet): boolean {
  if (left.chunk.byteLength !== right.chunk.byteLength) return false;
  const leftBytes = packetPayloadBytes(left);
  const rightBytes = packetPayloadBytes(right);
  return leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function isSharedBoundaryPacket(
  prior: Packet,
  current: Packet,
  presentationOffsetUs: number,
): boolean {
  return (
    prior.chunk.type === current.chunk.type &&
    packetDurationUs(prior) === packetDurationUs(current) &&
    Math.round(prior.chunk.timestamp) ===
      Math.round(current.chunk.timestamp) + presentationOffsetUs &&
    samePayload(prior, current)
  );
}

function gaplessPresentationDurationUs(track: TrackInfo): number | undefined {
  const config = track.config;
  const sampleRate = config !== undefined && 'sampleRate' in config ? config.sampleRate : undefined;
  const totalSamples = track.gapless?.totalSamples;
  if (
    track.mediaType === 'audio' &&
    sampleRate !== undefined &&
    Number.isFinite(sampleRate) &&
    sampleRate > 0 &&
    totalSamples !== undefined &&
    Number.isFinite(totalSamples) &&
    totalSamples >= 0
  ) {
    return Math.round((totalSamples * 1_000_000) / sampleRate);
  }
  return undefined;
}

function trackPresentationSpanUs(track: TrackInfo, packets: readonly Packet[]): number {
  return (
    gaplessPresentationDurationUs(track) ??
    packets.reduce(
      (endUs, packet) =>
        Math.max(endUs, Math.round(packet.chunk.timestamp) + packetDurationUs(packet)),
      0,
    )
  );
}

function composeAdjacentGapless(
  prior: TrackInfo['gapless'],
  current: TrackInfo['gapless'],
): TrackInfo['gapless'] {
  if (
    prior?.basis !== 'mp4-edit-list' ||
    current?.basis !== 'mp4-edit-list' ||
    prior.totalSamples === undefined ||
    current.totalSamples === undefined ||
    !Number.isSafeInteger(prior.totalSamples) ||
    !Number.isSafeInteger(current.totalSamples)
  ) {
    return undefined;
  }
  const totalSamples = prior.totalSamples + current.totalSamples;
  if (!Number.isSafeInteger(totalSamples) || totalSamples <= 0) return undefined;
  return {
    basis: 'mp4-edit-list',
    leadingSamples: prior.leadingSamples ?? 0,
    trailingSamples: current.trailingSamples ?? 0,
    totalSamples,
  };
}

/** Coded-sample concat through only the public demux + mux seams, matching the adapter operation. */
async function concatMp4(media: MediaEngine, segments: readonly Blob[]): Promise<Blob> {
  const byTrack = new Map<string, ConcatenatedTrack>();
  let offsetUs = 0;
  for (const segment of segments) {
    const demuxed = await media.demux(segment);
    let segmentPresentationSpanUs = 0;
    let segmentHasPackets = false;
    try {
      const ordinals = new Map<TrackInfo['mediaType'], number>();
      for (const track of demuxed.tracks) {
        const ordinal = ordinals.get(track.mediaType) ?? 0;
        ordinals.set(track.mediaType, ordinal + 1);
        const key = `${track.mediaType}:${ordinal}`;
        let entry = byTrack.get(key);
        if (entry === undefined) {
          entry = { track, packets: [], gapless: track.gapless };
        } else {
          entry.gapless = composeAdjacentGapless(entry.gapless, track.gapless);
        }
        byTrack.set(key, entry);
        const packets: Packet[] = [];
        const reader = demuxed.packets(track.id).getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            packets.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        segmentPresentationSpanUs = Math.max(
          segmentPresentationSpanUs,
          trackPresentationSpanUs(track, packets),
        );
        if (packets.length === 0) continue;
        segmentHasPackets = true;
        const first = packets[0] as Packet;
        const prior = entry.packets.at(-1);
        const sharedBoundary =
          track.mediaType === 'audio' &&
          prior !== undefined &&
          isSharedBoundaryPacket(prior, first, offsetUs);
        const firstDtsUs = packetDtsUs(first);
        const priorDecodeEndUs =
          prior === undefined ? offsetUs : packetDtsUs(prior) + packetDurationUs(prior);
        const decodeOffsetUs = sharedBoundary
          ? packetDtsUs(prior as Packet) - firstDtsUs
          : Math.max(offsetUs, priorDecodeEndUs) - firstDtsUs;
        for (let index = sharedBoundary ? 1 : 0; index < packets.length; index++) {
          const packet = packets[index];
          if (packet === undefined) continue;
          entry.packets.push(copyPacketAtOffset(packet, track.mediaType, decodeOffsetUs, offsetUs));
        }
      }
    } finally {
      await demuxed.close();
    }
    if (segmentHasPackets) offsetUs += segmentPresentationSpanUs;
    else offsetUs += Math.round((await media.probe(segment)).durationSec * 1_000_000);
  }

  const output = await media.mux(
    {
      tracks: [...byTrack.values()].map((entry) => {
        const { gapless: _sourceGapless, ...track } = entry.track;
        return {
          track: {
            ...track,
            durationSec: offsetUs / 1_000_000,
            ...(entry.gapless !== undefined ? { gapless: entry.gapless } : {}),
          },
          packets: new ReadableStream<Packet>({
            start(controller): void {
              for (const packet of entry.packets) controller.enqueue(packet);
              controller.close();
            },
          }),
        };
      }),
    },
    { container: 'mp4', faststart: true },
  );
  if (!(output instanceof Blob)) throw new Error('expected concat mux Blob output');
  return output;
}

interface ObservedSample {
  readonly ptsUs: number;
  readonly dtsUs: number;
  readonly durationUs: number;
  readonly digest: string;
}

interface ObservedTrack {
  readonly type: TrackInfo['mediaType'];
  readonly codec: string;
  readonly samples: readonly ObservedSample[];
}

async function observePresentation(
  media: MediaEngine,
  bytes: Uint8Array,
): Promise<{
  readonly durationUs: number;
  readonly tracks: readonly ObservedTrack[];
}> {
  const source = fromBytes(bytes, { mime: 'video/mp4' });
  const demuxed = await media.demux(source);
  try {
    const observed: Array<{
      type: TrackInfo['mediaType'];
      codec: string;
      samples: Array<ObservedSample & { sourcePtsUs: number; sourceDtsUs: number }>;
    }> = [];
    let originUs = Number.POSITIVE_INFINITY;
    let durationUs = 0;
    for (const track of demuxed.tracks) {
      const samples: Array<ObservedSample & { sourcePtsUs: number; sourceDtsUs: number }> = [];
      let packetEndUs = 0;
      const reader = demuxed.packets(track.id).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const data = new Uint8Array(value.chunk.byteLength);
          value.chunk.copyTo(data);
          const sourcePtsUs = Math.round(value.chunk.timestamp);
          const sourceDtsUs = Math.round(value.dtsUs ?? value.chunk.timestamp);
          const durationUs = Math.round(value.chunk.duration ?? 0);
          originUs = Math.min(originUs, sourcePtsUs);
          packetEndUs = Math.max(packetEndUs, sourcePtsUs + durationUs);
          samples.push({
            sourcePtsUs,
            sourceDtsUs,
            ptsUs: sourcePtsUs,
            dtsUs: sourceDtsUs,
            durationUs,
            digest: await sha256Hex(data),
          });
        }
      } finally {
        reader.releaseLock();
      }
      durationUs = Math.max(durationUs, gaplessPresentationDurationUs(track) ?? packetEndUs);
      observed.push({ type: track.mediaType, codec: track.codec, samples });
    }
    const origin = Number.isFinite(originUs) ? originUs : 0;
    return {
      durationUs,
      tracks: observed.map((track) => ({
        type: track.type,
        codec: track.codec,
        samples: track.samples.map((sample) => ({
          ptsUs: sample.sourcePtsUs - origin,
          dtsUs: sample.sourceDtsUs - origin,
          durationUs: sample.durationUs,
          digest: sample.digest,
        })),
      })),
    };
  } finally {
    await demuxed.close();
  }
}

describe('real H.264/AAC accurate-trim composition', () => {
  it('[0.5s,2.5s] ++ [2.5s,4.5s] matches [0.5s,4.5s] after a public concat mux', async () => {
    const restore = installStructuralWebCodecs();
    const media = createMedia({ worker: false }).use(Mp4Module).use(structuralH264Module());
    try {
      const input = new Uint8Array(await readFile(REAL_H264_AAC_FIXTURE));
      const trim = async (start: number, end: number): Promise<Blob> => {
        const output = await media.trim(fromBytes(input, { mime: 'video/mp4' }), {
          start,
          end,
          mode: 'accurate',
        });
        if (!(output instanceof Blob)) throw new Error('expected accurate trim Blob output');
        return output;
      };

      const left = await trim(0.5, 2.5);
      const right = await trim(2.5, 4.5);
      const direct = await trim(0.5, 4.5);
      const concatenated = await concatMp4(media, [left, right]);
      const [directView, concatenatedView] = await Promise.all([
        observePresentation(media, await blobBytes(direct)),
        observePresentation(media, await blobBytes(concatenated)),
      ]);

      expect(directView.durationUs).toBe(EXPECTED_DURATION_US);
      expect(concatenatedView.durationUs).toBe(EXPECTED_DURATION_US);
      expect(concatenatedView.tracks).toEqual(directView.tracks);
      for (const track of concatenatedView.tracks) {
        const ordered = [...track.samples].sort((left, right) => left.ptsUs - right.ptsUs);
        for (let index = 1; index < ordered.length; index++) {
          const previous = ordered[index - 1];
          const current = ordered[index];
          if (previous === undefined || current === undefined) continue;
          expect(current.ptsUs, `${track.type} overlap at sample ${index}`).toBeGreaterThanOrEqual(
            previous.ptsUs + previous.durationUs - 1,
          );
          expect(
            current.ptsUs,
            `${track.type} missing/duplicate sample near the 2s composition seam`,
          ).toBeLessThanOrEqual(previous.ptsUs + previous.durationUs + 1);
        }
      }
    } finally {
      restore();
      await media.dispose();
    }
  }, 60_000);
});
