/**
 * `createMedia()` (ADR-009) — the primary entry: a multi-instance, SSR-safe engine. Bare-function
 * sugar (`probe`, `convert`, …), backed by a lazily-created default instance, is also exported for
 * simple one-liner apps.
 */

import type { MediaInput } from '../sources/source.ts';
import { type MediaEngine, MediaEngineImpl } from './engine.ts';
import type {
  CallOptions,
  Cancellable,
  ConvertOptions,
  CreateMediaOptions,
  DecryptOptions,
  Demuxed,
  EncodeOptions,
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
export function preload(...specs: PreloadSpec[]): Promise<void> {
  return shared().preload(...specs);
}
