import type { Packet, PacketInfoMetadata, TrackInfo } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { audioDataToPcm, pcmRangeToPlanarInit } from '../dsp/audio-data.ts';
import type { VideoTarget } from './types.ts';

const MICROS_PER_SECOND = 1_000_000;
const TRIM_VIDEO_BITS_PER_PIXEL = 0.45;
const TRIM_H264_BITS_PER_PIXEL = 0.9;
const TRIM_VIDEO_MIN_BITRATE = 4_000_000;
const TRIM_VIDEO_MAX_BITRATE = 50_000_000;
const TRIM_H264_MAX_BITRATE = 62_500_000;
const TRIM_VIDEO_DEFAULT_BITRATE = 20_000_000;
const TRIM_VIDEO_SOURCE_BITRATE_HEADROOM = 2;
const TRIM_AUDIO_PACKET_INFO_WINDOW_BYTES = 8 * 1024 * 1024;
const TRIM_AUDIO_PACKET_INFO_GAP_BYTES = 256 * 1024;

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

export interface TrimAudioPacketInfoSource {
  range?(start: number, end: number): Promise<Uint8Array>;
}

interface TrimAudioPacketInfoWindow {
  start: number;
  end: number;
}

interface TrimPacketInfoRangeRow {
  readonly offset: number;
  readonly size: number;
  window: TrimAudioPacketInfoWindow | undefined;
}

export interface TrimAudioPacketInfoRow {
  readonly offset: number;
  readonly size: number;
  readonly sourceTimestampUs: number;
  readonly sourceDtsUs: number;
  readonly timestampUs: number;
  readonly dtsUs: number;
  readonly durationUs: number;
  window: TrimAudioPacketInfoWindow | undefined;
}

export interface TrimVideoPacketInfoRow {
  readonly offset: number;
  readonly size: number;
  readonly timestampUs: number;
  readonly dtsUs: number;
  readonly durationUs: number;
  readonly keyframe: boolean;
  window: TrimAudioPacketInfoWindow | undefined;
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
  const { gapless: _gapless, ...trackWithoutGapless } = track;
  return {
    ...trackWithoutGapless,
    durationSec: Math.max(0, bounds.endUs - bounds.startUs) / MICROS_PER_SECOND,
  };
}

/** Whether compressed audio can carry an exact sub-packet trim through the destination container. */
export function canUseMp4AacPacketInfoTrim(track: TrackInfo, outputContainer: string): boolean {
  const config = track.config;
  const sampleRate =
    config !== undefined && 'sampleRate' in config && positiveFinite(config.sampleRate)
      ? config.sampleRate
      : undefined;
  const container = outputContainer.toLowerCase();
  return (
    (container === 'mp4' || container === 'mov') &&
    track.mediaType === 'audio' &&
    /^(?:aac|mp4a(?:\.|$))/i.test(track.codec) &&
    sampleRate !== undefined
  );
}

export function trimAudioPacketInfoTrack(
  track: TrackInfo,
  bounds: TrimBoundsUs,
  rows: readonly TrimAudioPacketInfoRow[] = [],
  outputContainer?: string,
): TrackInfo {
  const { gapless: _gapless, ...trackWithoutGapless } = track;
  const trimmedTrack: TrackInfo = {
    ...trackWithoutGapless,
    durationSec: Math.max(0, bounds.endUs - bounds.startUs) / MICROS_PER_SECOND,
  };
  const config = track.config;
  const sampleRate =
    config !== undefined && 'sampleRate' in config && positiveFinite(config.sampleRate)
      ? config.sampleRate
      : undefined;
  if (
    outputContainer === undefined ||
    !canUseMp4AacPacketInfoTrim(track, outputContainer) ||
    sampleRate === undefined ||
    rows.length === 0
  ) {
    return trimmedTrack;
  }

  const first = rows[0];
  if (first === undefined) return trimmedTrack;
  const leadingSamples = microsecondsToSamples(
    Math.max(0, bounds.startUs - first.sourceDtsUs),
    sampleRate,
  );
  const totalSamples = microsecondsToSamples(
    Math.max(0, bounds.endUs - bounds.startUs),
    sampleRate,
  );
  const codedSamples = rows.reduce(
    (total, row) => total + microsecondsToSamples(row.durationUs, sampleRate),
    0,
  );
  if (
    !Number.isSafeInteger(leadingSamples) ||
    !Number.isSafeInteger(totalSamples) ||
    !Number.isSafeInteger(codedSamples) ||
    totalSamples <= 0 ||
    leadingSamples + totalSamples > codedSamples
  ) {
    return trimmedTrack;
  }
  return {
    ...trimmedTrack,
    gapless: {
      basis: 'mp4-edit-list',
      leadingSamples,
      trailingSamples: codedSamples - leadingSamples - totalSamples,
      totalSamples,
    },
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

export function planTrimAudioPacketInfoRows(
  packets: readonly PacketInfoMetadata[],
  trackIndex: number,
  bounds: TrimBoundsUs,
): readonly TrimAudioPacketInfoRow[] | undefined {
  const rows: TrimAudioPacketInfoRow[] = [];

  for (const packet of packets) {
    if (packet.trackIndex !== trackIndex) continue;
    const row = trimAudioPacketInfoRow(packet, bounds);
    if (row === undefined) continue;
    if (row === false) return undefined;
    rows.push(row);
  }
  if (rows.length === 0) return undefined;
  // Keep the compressed access units on one contiguous coded clock. A cut inside the first unit is
  // represented later by an MP4 edit (`leadingSamples`), not by clamping that packet to PTS zero while
  // leaving the following packet at its cut-relative PTS. The latter creates an artificial AAC overlap.
  const codedOriginUs = rows[0]?.sourceDtsUs;
  if (codedOriginUs === undefined) return undefined;
  const normalized = rows.map(
    (row): TrimAudioPacketInfoRow => ({
      ...row,
      timestampUs: row.sourceTimestampUs - codedOriginUs,
      dtsUs: row.sourceDtsUs - codedOriginUs,
    }),
  );
  assignTrimPacketInfoWindows(normalized);
  return normalized;
}

export function planTrimVideoPacketInfoRows(
  packets: readonly PacketInfoMetadata[],
  trackIndex: number,
  bounds: TrimBoundsUs,
): readonly TrimVideoPacketInfoRow[] | undefined {
  const trackRows: TrimVideoPacketInfoRow[] = [];
  for (const packet of packets) {
    if (packet.trackIndex !== trackIndex) continue;
    const row = trimVideoPacketInfoRow(packet);
    if (row === undefined) return undefined;
    trackRows.push(row);
  }
  if (trackRows.length === 0) return undefined;

  let startIndex = -1;
  for (let i = 0; i < trackRows.length; i++) {
    const row = trackRows[i];
    if (row === undefined) continue;
    if (row.keyframe && row.timestampUs <= bounds.startUs) startIndex = i;
    if (row.timestampUs > bounds.startUs && startIndex >= 0) break;
  }
  if (startIndex < 0) return undefined;

  let endIndex = trackRows.length;
  for (let i = startIndex + 1; i < trackRows.length; i++) {
    const row = trackRows[i];
    if (row?.keyframe && row.timestampUs >= bounds.endUs) {
      endIndex = i + 1;
      break;
    }
  }
  const rows = trackRows.slice(startIndex, endIndex);
  if (rows.length === 0) return undefined;
  assignTrimPacketInfoWindows(rows);
  return rows;
}

export function planSeekVideoPacketInfoRows(
  packets: readonly PacketInfoMetadata[],
  trackIndex: number,
  targetUs: number,
): readonly TrimVideoPacketInfoRow[] | undefined {
  if (!Number.isFinite(targetUs) || targetUs < 0) return undefined;
  const startUs = Math.round(targetUs);
  const endUs = startUs < Number.MAX_SAFE_INTEGER ? startUs + 1 : Number.MAX_SAFE_INTEGER;
  return planTrimVideoPacketInfoRows(packets, trackIndex, { startUs, endUs });
}

export function estimateTrackBitrateFromPacketInfo(
  packets: readonly PacketInfoMetadata[],
  trackIndex: number,
): number | undefined {
  let bytes = 0;
  let minDtsUs = Number.POSITIVE_INFINITY;
  let maxEndUs = Number.NEGATIVE_INFINITY;
  for (const packet of packets) {
    if (packet.trackIndex !== trackIndex) continue;
    if (
      !validByteSize(packet.size) ||
      !Number.isFinite(packet.dtsUs) ||
      packet.durationUs === undefined ||
      !Number.isFinite(packet.durationUs) ||
      packet.durationUs <= 0
    ) {
      return undefined;
    }
    const dtsUs = Math.round(packet.dtsUs);
    const endUs = dtsUs + Math.round(packet.durationUs);
    bytes += packet.size;
    minDtsUs = Math.min(minDtsUs, dtsUs);
    maxEndUs = Math.max(maxEndUs, endUs);
  }
  if (bytes <= 0 || !Number.isFinite(minDtsUs) || !Number.isFinite(maxEndUs)) return undefined;
  const durationSec = (maxEndUs - minDtsUs) / MICROS_PER_SECOND;
  if (!(durationSec > 0)) return undefined;
  return Math.round((bytes * 8) / durationSec);
}

export function trimAudioPacketInfoStream(
  source: TrimAudioPacketInfoSource,
  rows: readonly TrimAudioPacketInfoRow[],
  signal: AbortSignal | undefined,
): ReadableStream<Packet> {
  const reader = new TrimPacketInfoWindowReader(source);
  let index = 0;
  return new ReadableStream<Packet>(
    {
      async pull(controller): Promise<void> {
        if (index >= rows.length) {
          controller.close();
          return;
        }
        throwIfAborted(signal);
        const row = rows[index];
        index++;
        if (row === undefined) {
          controller.close();
          return;
        }
        const data = await reader.bytesFor(row, signal);
        throwIfAborted(signal);
        controller.enqueue({
          chunk: new EncodedAudioChunk({
            type: 'key',
            timestamp: row.timestampUs,
            duration: row.durationUs,
            data,
          }),
          data,
          dtsUs: row.dtsUs,
          sizeBytes: row.size,
        });
      },
    },
    { highWaterMark: 0 },
  );
}

export function trimVideoPacketInfoChunkStream(
  source: TrimAudioPacketInfoSource,
  rows: readonly TrimVideoPacketInfoRow[],
  signal: AbortSignal | undefined,
): ReadableStream<EncodedVideoChunk> {
  const reader = new TrimPacketInfoWindowReader(source);
  let index = 0;
  return new ReadableStream<EncodedVideoChunk>(
    {
      async pull(controller): Promise<void> {
        if (index >= rows.length) {
          controller.close();
          return;
        }
        throwIfAborted(signal);
        const row = rows[index];
        index++;
        if (row === undefined) {
          controller.close();
          return;
        }
        const data = await reader.bytesFor(row, signal);
        throwIfAborted(signal);
        controller.enqueue(
          new EncodedVideoChunk({
            type: row.keyframe ? 'key' : 'delta',
            timestamp: row.timestampUs,
            duration: row.durationUs,
            data,
          }),
        );
      },
    },
    { highWaterMark: 0 },
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
export function trimVideoEncodeTarget(track: TrackInfo, sourceBitrate?: number): VideoTarget {
  const isH264 = /^(?:avc[13](?:\.|$)|h264$)/i.test(track.codec);
  const fps = positiveFinite(track.fps) ? track.fps : 30;
  // High-cadence H.264 needs a picture-quality contract rather than another level-bound ABR increase:
  // fixed QP 8 keeps later open-GOP anchors transparent without inflating ordinary-cadence trims.
  if (isH264 && fps > 30.5) return { crf: 8 };
  return trimVideoVariableRateTarget(track, sourceBitrate);
}

/** Portable high-rate fallback for runtimes whose H.264 encoder rejects quantizer mode. */
export function trimVideoEncodeFallbackTarget(
  track: TrackInfo,
  sourceBitrate?: number,
): VideoTarget | undefined {
  const fps = positiveFinite(track.fps) ? track.fps : 30;
  return /^(?:avc[13](?:\.|$)|h264$)/i.test(track.codec) && fps > 30.5
    ? trimVideoVariableRateTarget(track, sourceBitrate)
    : undefined;
}

function trimVideoVariableRateTarget(track: TrackInfo, sourceBitrate?: number): VideoTarget {
  const width = track.config && 'codedWidth' in track.config ? track.config.codedWidth : undefined;
  const height =
    track.config && 'codedHeight' in track.config ? track.config.codedHeight : undefined;
  const isH264 = /^(?:avc[13](?:\.|$)|h264$)/i.test(track.codec);
  const maximumBitrate = isH264 ? TRIM_H264_MAX_BITRATE : TRIM_VIDEO_MAX_BITRATE;
  if (!positiveFinite(width) || !positiveFinite(height)) {
    return { bitrate: TRIM_VIDEO_DEFAULT_BITRATE, bitrateMode: 'variable' };
  }
  const fps = positiveFinite(track.fps) ? track.fps : 30;
  const geometryBitrate = clampInt(
    width * height * fps * (isH264 ? TRIM_H264_BITS_PER_PIXEL : TRIM_VIDEO_BITS_PER_PIXEL),
    TRIM_VIDEO_MIN_BITRATE,
    maximumBitrate,
  );
  const sourceAwareBitrate =
    sourceBitrate !== undefined && Number.isFinite(sourceBitrate) && sourceBitrate > 0
      ? clampInt(
          sourceBitrate * TRIM_VIDEO_SOURCE_BITRATE_HEADROOM,
          TRIM_VIDEO_MIN_BITRATE,
          maximumBitrate,
        )
      : undefined;
  return {
    // Geometry is the minimum quality budget, not a cap. A measured low-rate source still needs that
    // budget to survive a second generation, while a dense source retains 2× evidence headroom.
    bitrate: Math.max(geometryBitrate, sourceAwareBitrate ?? 0),
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

  return new ReadableStream<T>(
    {
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
          const sourceDuration = frame.duration ?? null;
          // A VFR timestamp can land microscopically before the exclusive boundary after the container
          // timescale is rounded (for example 3_999_999 µs for a logical 4 s frame). Keep that frame — its
          // presentation starts inside the requested window — but do not let its declared duration extend
          // the authored subclip past `endUs`. The encoder and muxer then receive the exact residual span.
          const duration =
            sourceDuration === null
              ? null
              : Math.min(sourceDuration, Math.max(0, bounds.endUs - frame.timestamp));
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
    },
    { highWaterMark: 0 },
  );
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

  return new ReadableStream<T>(
    {
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
    },
    { highWaterMark: 0 },
  );
}

/* v8 ignore start -- browser-only AudioData constructors; stream ownership is tested with fakes. */
export function restampAudioData(
  frame: AudioData,
  timestamp: number,
  _duration: number | null,
): AudioData {
  return restampAudioDataRange(frame, 0, frame.numberOfFrames, timestamp);
}

export function restampAudioDataRange(
  frame: AudioData,
  startFrame: number,
  frameCount: number,
  timestamp: number,
): AudioData {
  if (startFrame === 0 && frameCount === frame.numberOfFrames && frame.timestamp === timestamp) {
    return frame;
  }
  const { init } = pcmRangeToPlanarInit(audioDataToPcm(frame), startFrame, frameCount, timestamp);
  return new AudioData(init);
}

/** Rebase one decoded video frame while preserving its pixels and close-once ownership contract. */
export function restampVideoFrame(
  frame: VideoFrame,
  timestamp: number,
  duration: number | null,
): VideoFrame {
  if (frame.timestamp === timestamp && frame.duration === duration) return frame;
  const init: VideoFrameInit = duration === null ? { timestamp } : { timestamp, duration };
  return new VideoFrame(frame, init);
}
/* v8 ignore stop */

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

function trimVideoPacketInfoRow(packet: PacketInfoMetadata): TrimVideoPacketInfoRow | undefined {
  const offset = packet.offset;
  if (
    offset === undefined ||
    !validByteOffset(offset) ||
    !validByteSize(packet.size) ||
    !Number.isFinite(packet.ptsUs) ||
    !Number.isFinite(packet.dtsUs) ||
    packet.durationUs === undefined ||
    !Number.isFinite(packet.durationUs) ||
    packet.durationUs <= 0
  ) {
    return undefined;
  }
  return {
    offset: Math.round(offset),
    size: Math.round(packet.size),
    timestampUs: Math.round(packet.ptsUs),
    dtsUs: Math.round(packet.dtsUs),
    durationUs: Math.round(packet.durationUs),
    keyframe: packet.keyframe,
    window: undefined,
  };
}

function trimAudioPacketInfoRow(
  packet: PacketInfoMetadata,
  bounds: TrimBoundsUs,
): TrimAudioPacketInfoRow | undefined | false {
  const offset = packet.offset;
  if (
    offset === undefined ||
    !validByteOffset(offset) ||
    !validByteSize(packet.size) ||
    !Number.isFinite(packet.ptsUs) ||
    !Number.isFinite(packet.dtsUs) ||
    packet.durationUs === undefined ||
    !Number.isFinite(packet.durationUs) ||
    packet.durationUs <= 0
  ) {
    return false;
  }
  const timestampUs = Math.round(packet.ptsUs);
  const sourceDtsUs = Math.round(packet.dtsUs);
  const durationUs = Math.round(packet.durationUs);
  const endUs = timestampUs + durationUs;
  // An encoded access unit cannot be split at a sample-accurate boundary. Keep every overlapping unit;
  // the derived MP4 edit discards the leading/trailing fractions. Adjacent independent cuts therefore
  // share their boundary unit by design, allowing a concat implementation to collapse it by identity.
  if (endUs <= bounds.startUs || timestampUs >= bounds.endUs) {
    return undefined;
  }
  return {
    offset: Math.round(offset),
    size: Math.round(packet.size),
    sourceTimestampUs: timestampUs,
    sourceDtsUs,
    timestampUs,
    dtsUs: sourceDtsUs,
    durationUs,
    window: undefined,
  };
}

function assignTrimPacketInfoWindows(rows: readonly TrimPacketInfoRangeRow[]): void {
  const byOffset = [...rows].sort((a, b) => a.offset - b.offset);
  let current: TrimAudioPacketInfoWindow | undefined;
  for (const row of byOffset) {
    const end = packetInfoByteEnd(row);
    if (current === undefined) {
      current = { start: row.offset, end };
      row.window = current;
      continue;
    }
    const gap = row.offset - current.end;
    const combinedSpan = end - current.start;
    if (
      gap <= TRIM_AUDIO_PACKET_INFO_GAP_BYTES &&
      combinedSpan <= TRIM_AUDIO_PACKET_INFO_WINDOW_BYTES
    ) {
      current.end = Math.max(current.end, end);
      row.window = current;
      continue;
    }
    current = { start: row.offset, end };
    row.window = current;
  }
}

class TrimPacketInfoWindowReader {
  readonly #source: TrimAudioPacketInfoSource;
  #currentWindow: TrimAudioPacketInfoWindow | undefined;
  #currentBytes: Uint8Array | undefined;

  constructor(source: TrimAudioPacketInfoSource) {
    this.#source = source;
  }

  async bytesFor(
    row: TrimPacketInfoRangeRow,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const range = this.#source.range;
    if (range === undefined) {
      throw new MediaError('demux-error', 'packet-info trim needs range reads');
    }
    const window = row.window;
    if (window === undefined) {
      throw new MediaError('demux-error', 'packet-info trim row has no read window');
    }
    if (window !== this.#currentWindow) {
      const bytes = await range.call(this.#source, window.start, window.end);
      throwIfAborted(signal);
      const expected = window.end - window.start;
      if (bytes.byteLength !== expected) {
        throw new MediaError(
          'demux-error',
          `packet-info trim window [${window.start}, ${window.end}) short read: got ${bytes.byteLength} of ${expected} bytes`,
        );
      }
      this.#currentWindow = window;
      this.#currentBytes = bytes;
    }
    const bytes = this.#currentBytes;
    if (bytes === undefined) {
      throw new MediaError('demux-error', 'packet-info trim window bytes are missing');
    }
    const rel = row.offset - window.start;
    return bytes.subarray(rel, rel + row.size);
  }
}

function packetInfoByteEnd(row: TrimPacketInfoRangeRow): number {
  return row.offset + row.size;
}

function validByteOffset(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validByteSize(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function positiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function microsecondsToSamples(microseconds: number, sampleRate: number): number {
  return Math.round((microseconds * sampleRate) / MICROS_PER_SECOND);
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
