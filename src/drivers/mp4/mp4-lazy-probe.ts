/** Lightweight finite-range MP4 faststart probe used by the default lazy container proxy. */

import { h264AvcCSampleAspectRatios } from '../../codecs/h264-avcc-crop.ts';
import type { ByteSource, StageOptions, TrackInfo } from '../../contracts/driver.ts';
import { raceAbort, sourceAbortError } from '../../sources/abort.ts';
import { readSimpleVideoFaststartProbe } from './simple-video-probe.ts';

const FASTSTART_PROBE_INITIAL_BYTES = 64 * 1024;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw sourceAbortError(signal);
}

function cloneDescription(description: AllowSharedBufferSource): Uint8Array<ArrayBuffer> {
  if (description instanceof ArrayBuffer) return new Uint8Array(description).slice();
  const view = description as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
}

function detachTrack(track: TrackInfo): TrackInfo {
  const config = track.config;
  if (config?.description === undefined) return { ...track };
  return {
    ...track,
    config: { ...config, description: cloneDescription(config.description) },
  };
}

function bytesOf(value: AllowSharedBufferSource): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  const view = value as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function simpleResultIsCanonicalSubset(brand: string, tracks: readonly TrackInfo[]): boolean {
  // QuickTime language ids carry different public TrackInfo facts. The compact parser's strict mode
  // has already declined schema-recognized display/edit boxes and unsupported/non-media tracks.
  if (brand === 'qt  ') return false;
  for (const track of tracks) {
    if (track.mediaType !== 'video' || track.config?.description === undefined) continue;
    try {
      const ratios = h264AvcCSampleAspectRatios(bytesOf(track.config.description));
      if (ratios.some((ratio) => ratio !== undefined && ratio.width !== ratio.height)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Probe the common finite faststart MP4 shape without loading the full demux/mux driver. `undefined`
 * is a deliberate decline: the lazy proxy then loads and calls the canonical complete driver once.
 */
export async function probeMp4Faststart(
  src: ByteSource,
  options?: StageOptions,
): Promise<readonly TrackInfo[] | undefined> {
  const range = src.range;
  const size = src.size;
  if (range === undefined || size === undefined || !Number.isSafeInteger(size) || size <= 0) {
    return undefined;
  }
  const signal = options?.signal;
  const retained = new Set<Uint8Array>();
  try {
    throwIfAborted(signal);
    const randomAccess = {
      size,
      async read(offset: number, length: number): Promise<Uint8Array> {
        throwIfAborted(signal);
        const requested = range.call(src, offset, offset + length, signal);
        let bytes: Uint8Array;
        try {
          bytes = await raceAbort(requested, signal);
        } catch (error) {
          // A non-cooperative range may fulfill after abort already won. It never entered `retained`,
          // so attach a muted late lease release before propagating the canonical abort.
          if (signal?.aborted === true) {
            void requested.then(
              (lateBytes) => src.releaseRange?.(lateBytes),
              () => {},
            );
          }
          throw error;
        }
        retained.add(bytes);
        throwIfAborted(signal);
        return bytes.byteLength <= length ? bytes : bytes.subarray(0, length);
      },
    };
    const simple = await readSimpleVideoFaststartProbe(
      randomAccess,
      FASTSTART_PROBE_INITIAL_BYTES,
      true,
    );
    const simpleTracks =
      simple !== undefined && simpleResultIsCanonicalSubset(simple.brand, simple.tracks)
        ? simple.tracks
        : undefined;
    throwIfAborted(signal);
    return simpleTracks?.map(detachTrack);
  } finally {
    for (const bytes of retained) src.releaseRange?.(bytes);
  }
}
