import type { Packet, TrackInfo } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import type { VideoTarget } from './types.ts';

const MICROS_PER_SECOND = 1_000_000;
const TRIM_VIDEO_BITS_PER_PIXEL = 0.45;
const TRIM_VIDEO_MIN_BITRATE = 4_000_000;
const TRIM_VIDEO_MAX_BITRATE = 50_000_000;
const TRIM_VIDEO_DEFAULT_BITRATE = 20_000_000;

export interface TrimBoundsUs {
  readonly startUs: number;
  readonly endUs: number;
}

export interface TimedFrameForTrim {
  readonly timestamp: number;
  readonly duration?: number | null;
  close(): void;
}

export interface AudioSampleFrameForTrim extends TimedFrameForTrim {
  readonly numberOfFrames: number;
  readonly sampleRate: number;
}

type RestampFrame<T extends TimedFrameForTrim> = (
  frame: T,
  timestamp: number,
  duration: number | null,
) => T;

type RestampAudioSampleFrame<T extends AudioSampleFrameForTrim> = (
  frame: T,
  startFrame: number,
  frameCount: number,
  timestamp: number,
) => T;

export function trimBoundsUs(startSec: number, endSec: number): TrimBoundsUs {
  return {
    startUs: Math.round(startSec * MICROS_PER_SECOND),
    endUs: Math.round(endSec * MICROS_PER_SECOND),
  };
}

export function trimPacketCopyTrack(track: TrackInfo, bounds: TrimBoundsUs): TrackInfo {
  return {
    ...track,
    durationSec: Math.max(0, bounds.endUs - bounds.startUs) / MICROS_PER_SECOND,
  };
}

export function trimAudioPacketStream(
  packets: ReadableStream<Packet>,
  bounds: TrimBoundsUs,
): ReadableStream<Packet> {
  let baseUs: number | undefined;
  return packets.pipeThrough(
    new TransformStream<Packet, Packet>({
      transform(packet, controller): void {
        const startUs = Math.round(packet.chunk.timestamp);
        const duration = packet.chunk.duration;
        const durationUs = duration === null ? undefined : Math.max(0, Math.round(duration));
        const endUs = durationUs === undefined ? startUs + 1 : startUs + durationUs;
        if (endUs <= bounds.startUs || startUs >= bounds.endUs) return;
        baseUs ??= startUs;
        controller.enqueue(restampAudioPacket(packet, startUs - baseUs, baseUs));
      },
    }),
  );
}

export function trimEncodeTrack(track: TrackInfo): TrackInfo {
  const { durationSec: _durationSec, ...rest } = track;
  return rest;
}

/**
 * Accurate trim is a decode->encode operation. With no public trim bitrate knob, choose a high-quality
 * VBR target from source geometry so adjacent separately-trimmed segments remain perceptually stable
 * when concatenated and compared against one direct trim.
 */
export function trimVideoEncodeTarget(track: TrackInfo): VideoTarget {
  const width = track.config && 'codedWidth' in track.config ? track.config.codedWidth : undefined;
  const height =
    track.config && 'codedHeight' in track.config ? track.config.codedHeight : undefined;
  if (!positiveFinite(width) || !positiveFinite(height)) {
    return { bitrate: TRIM_VIDEO_DEFAULT_BITRATE, bitrateMode: 'variable' };
  }
  const fps = positiveFinite(track.fps) ? track.fps : 30;
  return {
    bitrate: clampInt(
      width * height * fps * TRIM_VIDEO_BITS_PER_PIXEL,
      TRIM_VIDEO_MIN_BITRATE,
      TRIM_VIDEO_MAX_BITRATE,
    ),
    bitrateMode: 'variable',
  };
}

/**
 * Keep decoded frames whose presentation timestamp is inside `[startUs, endUs)`, close every skipped
 * source frame immediately, stop/cancel upstream at the first frame on/after `endUs`, and rebase the first
 * kept frame to timestamp 0. `restamp` must return either the original frame (when timing is unchanged) or
 * a new frame; this helper closes the original when a replacement is emitted, while downstream owns the
 * returned frame.
 */
export function trimTimedFrameStream<T extends TimedFrameForTrim>(
  frames: ReadableStream<T>,
  bounds: TrimBoundsUs,
  restamp: RestampFrame<T>,
): ReadableStream<T> {
  const reader = frames.getReader();
  let released = false;
  let anchorUs: number | undefined;

  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const cancelReader = async (reason?: unknown): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await reader.cancel(reason);
    } finally {
      reader.releaseLock();
    }
  };

  return new ReadableStream<T>({
    async pull(controller): Promise<void> {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        const frame = value;
        if (frame.timestamp < bounds.startUs) {
          frame.close();
          continue;
        }
        if (frame.timestamp >= bounds.endUs) {
          frame.close();
          await cancelReader();
          controller.close();
          return;
        }
        anchorUs ??= frame.timestamp;
        const duration = frame.duration ?? null;
        let out: T;
        try {
          out = restamp(frame, frame.timestamp - anchorUs, duration);
        } catch (e) {
          frame.close();
          await cancelReader(e);
          throw e;
        }
        if (out !== frame) frame.close();
        try {
          controller.enqueue(out);
        } catch (e) {
          out.close();
          throw e;
        }
        return;
      }
    },
    async cancel(reason): Promise<void> {
      await cancelReader(reason);
    },
  });
}

export function trimAudioGaplessFrameStream<T extends AudioSampleFrameForTrim>(
  frames: ReadableStream<T>,
  gapless: NonNullable<TrackInfo['gapless']>,
  restamp: RestampAudioSampleFrame<T>,
): ReadableStream<T> {
  const leadingSamples = sampleCountOrZero(gapless.leadingSamples, 'leadingSamples');
  const totalSamples = optionalSampleCount(gapless.totalSamples, 'totalSamples');
  if (leadingSamples === 0 && totalSamples === undefined) return frames;

  const reader = frames.getReader();
  let released = false;
  let decodedSamples = 0;
  let emittedSamples = 0;
  const contentStart = leadingSamples;
  const contentEnd =
    totalSamples === undefined ? Number.POSITIVE_INFINITY : contentStart + totalSamples;

  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const cancelReader = async (reason?: unknown): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await reader.cancel(reason);
    } finally {
      reader.releaseLock();
    }
  };

  return new ReadableStream<T>({
    async pull(controller): Promise<void> {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }

        const frame = value;
        const frameStart = decodedSamples;
        const frameEnd = frameStart + frame.numberOfFrames;
        decodedSamples = frameEnd;

        const keepStart = Math.max(frameStart, contentStart);
        const keepEnd = Math.min(frameEnd, contentEnd);
        if (keepEnd <= keepStart) {
          frame.close();
          if (frameEnd >= contentEnd) {
            await cancelReader();
            controller.close();
            return;
          }
          continue;
        }

        const startFrame = keepStart - frameStart;
        const frameCount = keepEnd - keepStart;
        const timestamp = samplesToMicros(emittedSamples, frame.sampleRate);
        emittedSamples += frameCount;

        let out: T;
        try {
          out = restamp(frame, startFrame, frameCount, timestamp);
        } catch (e) {
          frame.close();
          await cancelReader(e);
          throw e;
        }
        if (out !== frame) frame.close();
        try {
          controller.enqueue(out);
        } catch (e) {
          out.close();
          throw e;
        }
        if (keepEnd >= contentEnd) {
          await cancelReader();
          controller.close();
        }
        return;
      }
    },
    async cancel(reason): Promise<void> {
      await cancelReader(reason);
    },
  });
}

function restampAudioPacket(packet: Packet, timestampUs: number, baseUs: number): Packet {
  const chunk = packet.chunk;
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  const duration = chunk.duration;
  const init: EncodedAudioChunkInit = {
    type: chunk.type as EncodedAudioChunkType,
    timestamp: Math.max(0, timestampUs),
    data,
    ...(duration !== null ? { duration } : {}),
  };
  return {
    chunk: new EncodedAudioChunk(init),
    ...(packet.dtsUs !== undefined
      ? { dtsUs: Math.max(0, Math.round(packet.dtsUs) - baseUs) }
      : {}),
    ...(packet.sizeBytes !== undefined ? { sizeBytes: packet.sizeBytes } : {}),
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function positiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function sampleCountOrZero(value: number | undefined, label: string): number {
  return optionalSampleCount(value, label) ?? 0;
}

function optionalSampleCount(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new MediaError('decode-error', `gapless ${label} must be a non-negative sample count`);
  }
  return Math.round(value);
}

function samplesToMicros(samples: number, sampleRate: number): number {
  return sampleRate > 0 ? Math.round((samples / sampleRate) * MICROS_PER_SECOND) : 0;
}
