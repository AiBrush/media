/**
 * Public API types (docs/architecture/07) — the developer-facing option and result shapes. All backend
 * choice is invisible (ADR-003); options are flat typed objects (ADR-011).
 */

import type { Determinism, EncodedChunk, Progress, TrackInfo } from '../contracts/driver.ts';
import type { Sink } from '../sinks/sink.ts';

export type { Output } from '../sinks/sink.ts';

/** Diagnostic event delivered to the `onLog` hook. */
export interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  detail?: unknown;
}

/** Options for {@link createMedia}. */
export interface CreateMediaOptions {
  determinism?: Determinism; // default 'auto'                 (ADR-007)
  enableThreads?: boolean; // default = crossOriginIsolated    (ADR-006)
  worker?: boolean | { pool?: number }; // default true (heavy) (ADR-019)
  assetBaseUrl?: string; // default = import.meta.url-resolved  (ADR-005)
  onLog?: (e: LogEvent) => void;
}

/** Hidden power-user/test override (ADR-014); not part of the primary signatures. */
export interface StrategyOverride {
  determinism?: Determinism;
  /** Pin a specific driver id for the operation. */
  pinDriver?: string;
}

/** Per-call options accepted by every op. */
export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  strategy?: StrategyOverride;
}

export type Container = 'mp4' | 'mov' | 'webm' | 'mkv' | 'ogg' | 'wav' | 'mp3' | 'aac' | 'ts';
export type VideoCodec = 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1';
export type AudioCodec = 'aac' | 'opus' | 'mp3' | 'flac' | 'vorbis' | 'pcm';

export interface VideoTarget {
  codec?: VideoCodec;
  width?: number;
  height?: number;
  fit?: 'contain' | 'cover' | 'fill';
  fps?: number;
  bitrate?: number;
  crf?: number;
  rotate?: 0 | 90 | 180 | 270;
  flip?: 'h' | 'v';
  crop?: { x: number; y: number; width: number; height: number };
}

export interface AudioTarget {
  codec?: AudioCodec;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
}

export interface ConvertOptions {
  to?: Container;
  video?: false | VideoTarget;
  audio?: false | AudioTarget;
  faststart?: boolean;
  fragmented?: boolean;
  sink?: Sink;
}

export interface RemuxOptions {
  to: Container;
  faststart?: boolean;
  fragmented?: boolean;
  sink?: Sink;
}

export interface TrimOptions {
  start: number;
  end: number;
  mode?: 'keyframe' | 'accurate';
  sink?: Sink;
}

export type EncryptionScheme = 'cenc' | 'cbcs' | 'hls-aes128';
export type KeyMap = Record<string, string>;

export interface DecryptOptions {
  scheme: EncryptionScheme;
  keys: KeyMap;
  sink?: Sink;
}

export interface EncodeOptions {
  to?: Container;
  video?: VideoTarget;
  audio?: AudioTarget;
  sink?: Sink;
}

export interface MuxSpec {
  container: Container;
  faststart?: boolean;
  fragmented?: boolean;
  sink?: Sink;
}

/** A probe result (ADR-013). */
export interface MediaInfoTrack {
  id: number;
  type: 'video' | 'audio';
  codec: string;
  durationSec?: number;
  width?: number;
  height?: number;
  rotation?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  language?: string;
}

export interface MediaInfo {
  container: string;
  durationSec: number;
  sizeBytes?: number;
  tracks: MediaInfoTrack[];
  tags?: Record<string, string>;
}

/** A live demux result (public-facing). */
export interface Demuxed {
  readonly tracks: readonly TrackInfo[];
  packets(trackId: number): ReadableStream<EncodedChunk>;
  close(): Promise<void>;
}

/** Decoded frame streams (the result of `decode`). */
export interface MediaStreams {
  video?: ReadableStream<VideoFrame>;
  audio?: ReadableStream<AudioData>;
}

/** Encoded packet streams (the input to `mux`). */
export interface PacketStreams {
  video?: ReadableStream<EncodedChunk>;
  audio?: ReadableStream<EncodedChunk>;
}

/** Warmup spec for `preload`. */
export type PreloadSpec =
  | string
  | {
      op: string;
      video?: string;
      audio?: string;
      container?: string;
      level?: 'chunks' | 'compile' | 'ready';
    };

/** A cancellable op result: a `Promise` that also exposes `.cancel()`. */
export type Cancellable<T> = Promise<T> & { cancel(): void };
