/**
 * `createMedia()` (ADR-009) — the primary entry: a multi-instance, SSR-safe engine. Bare-function
 * sugar (`probe`, `convert`, …), backed by a lazily-created default instance, is also exported for
 * simple one-liner apps.
 */

import { type MediaEngine, MediaEngineImpl } from './engine.ts';
import type { CreateMediaOptions } from './types.ts';

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

/** Build the typed one-line wrappers without duplicating one closure body for every engine verb. */
function bare<K extends keyof MediaEngine>(method: K): MediaEngine[K] {
  return ((...args: unknown[]) => {
    const media = shared();
    return (media[method] as (...values: unknown[]) => unknown)(...args);
  }) as MediaEngine[K];
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

export const probe: MediaEngine['probe'] = bare('probe');
export const convert: MediaEngine['convert'] = bare('convert');
export const h264AbrLadder: MediaEngine['h264AbrLadder'] = bare('h264AbrLadder');
/** `transcode` is an exported alias of `convert` (ADR-012). */
export const transcode = convert;
export const remux: MediaEngine['remux'] = bare('remux');
/** Declare a remux's output-sink contract (seek/reservation/finalization, retention) before it runs. */
export const planRemuxOutput: MediaEngine['planRemuxOutput'] = bare('planRemuxOutput');
export const trim: MediaEngine['trim'] = bare('trim');
export const demux: MediaEngine['demux'] = bare('demux');
/** Materialize all packet-info rows. Prefer {@link packetInfoBatches} for very large files. */
export const packetInfo: MediaEngine['packetInfo'] = bare('packetInfo');
/** Enumerate packet-info rows pull-by-pull without retaining prior batches. */
export const packetInfoBatches: MediaEngine['packetInfoBatches'] = bare('packetInfoBatches');
export const decode: MediaEngine['decode'] = bare('decode');
/** Decode and return the single frame at/just-after `timeUs` (frame-accurate seek). */
export const seek: MediaEngine['seek'] = bare('seek');
export const encode: MediaEngine['encode'] = bare('encode');
export const mux: MediaEngine['mux'] = bare('mux');
export const decrypt: MediaEngine['decrypt'] = bare('decrypt');
/** Intent-level capability pre-flight: `true` iff the requested target is producible (never throws). */
export const canConvert: MediaEngine['canConvert'] = bare('canConvert');
export const preload: MediaEngine['preload'] = bare('preload');
export const load: MediaEngine['load'] = bare('load');
export const run: MediaEngine['run'] = bare('run');
