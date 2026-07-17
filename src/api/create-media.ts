/**
 * `createMedia()` (ADR-009) — the primary entry: a multi-instance, SSR-safe engine. Bare-function
 * sugar (`probe`, `convert`, …), backed by a lazily-created default instance, is also exported for
 * simple one-liner apps.
 */

import type { MediaInput } from '../sources/source.ts';
import { type MediaEngine, MediaEngineImpl } from './engine.ts';
import type { MediaJob } from './job.ts';
import type {
  CallOptions,
  Cancellable,
  ConvertOptions,
  CreateMediaOptions,
  DecryptOptions,
  Demuxed,
  EncodeOptions,
  H264AbrRung,
  MediaChain,
  MediaInfo,
  MediaStreams,
  MuxSpec,
  Output,
  PacketStreams,
  PreloadSpec,
  RemuxOptions,
  TrimOptions,
} from './types.ts';

/** Create an engine instance. Backend choice is invisible; pass options per ADR-006/007/019. */
export function createMedia(opts?: CreateMediaOptions): MediaEngine {
  return new MediaEngineImpl(opts);
}

let defaultInstance: MediaEngine | undefined;

/** The lazily-created default instance backing the bare-function sugar. */
function shared(): MediaEngine {
  defaultInstance ??= createMedia();
  return defaultInstance;
}

/**
 * Dispose and drop the shared default instance behind the bare-function sugar (R-S05.5, ADR-321), so
 * SSR request handlers and test suites can guarantee the *next* bare call builds a fresh, isolated
 * engine (fresh registry/router/pool caches) instead of silently sharing state process-wide. Anything
 * still holding the old instance (e.g. a chain captured before the reset) sees typed
 * `MediaError('aborted', 'engine disposed')` failures rather than resurrecting torn-down pools.
 * No-op when no default instance was ever created.
 */
export async function resetDefaultMedia(): Promise<void> {
  const current = defaultInstance;
  defaultInstance = undefined;
  if (current !== undefined) await current.dispose();
}

export function probe(input: MediaInput, o?: CallOptions): Cancellable<MediaInfo> {
  return shared().probe(input, o);
}
export function convert(
  input: MediaInput,
  opts: ConvertOptions,
  o?: CallOptions,
): Cancellable<Output> {
  return shared().convert(input, opts, o);
}
export function h264AbrLadder(
  input: MediaInput,
  ladder: readonly H264AbrRung[],
  o?: CallOptions,
): Cancellable<readonly Output[]> {
  return shared().h264AbrLadder(input, ladder, o);
}
/** `transcode` is an exported alias of `convert` (ADR-012). */
export const transcode = convert;
export function remux(input: MediaInput, opts: RemuxOptions, o?: CallOptions): Cancellable<Output> {
  return shared().remux(input, opts, o);
}
export function trim(input: MediaInput, opts: TrimOptions, o?: CallOptions): Cancellable<Output> {
  return shared().trim(input, opts, o);
}
export function demux(input: MediaInput, o?: CallOptions): Cancellable<Demuxed> {
  return shared().demux(input, o);
}
export function decode(input: MediaInput, o?: CallOptions): MediaStreams {
  return shared().decode(input, o);
}
/** Decode and return the single frame at/just-after `timeUs` (frame-accurate seek). */
export function seek(input: MediaInput, timeUs: number, o?: CallOptions): Cancellable<VideoFrame> {
  return shared().seek(input, timeUs, o);
}
export function encode(
  frames: MediaStreams,
  opts: EncodeOptions,
  o?: CallOptions,
): Cancellable<Output> {
  return shared().encode(frames, opts, o);
}
export function mux(streams: PacketStreams, opts: MuxSpec, o?: CallOptions): Cancellable<Output> {
  return shared().mux(streams, opts, o);
}
export function decrypt(
  input: MediaInput,
  opts: DecryptOptions,
  o?: CallOptions,
): Cancellable<Output> {
  return shared().decrypt(input, opts, o);
}
/** Intent-level capability pre-flight: `true` iff the requested target is producible (never throws). */
export function canConvert(opts: ConvertOptions): Promise<boolean> {
  return shared().canConvert(opts);
}
export function preload(...specs: PreloadSpec[]): Promise<void> {
  return shared().preload(...specs);
}
export function load(input: MediaInput): MediaChain {
  return shared().load(input);
}
export function run(job: MediaJob, o?: CallOptions): Cancellable<Blob> {
  return shared().run(job, o);
}
