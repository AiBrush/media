/** Lightweight finite-range MP4 faststart probe used by the default lazy container proxy. */

import { h264AvcCSampleAspectRatios } from '../../codecs/h264-avcc-crop.ts';
import type { ByteSource, ProbeTracks, StageOptions, TrackInfo } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { raceAbort, sourceAbortError } from '../../sources/abort.ts';
import { readSimpleVideoFaststartProbe } from './simple-video-probe.ts';

const FASTSTART_PROBE_INITIAL_BYTES = 64 * 1024;
/**
 * A Blob range is a real copy out of blob storage, so a metadata-only probe uses the same bounded layout
 * window as the driver's probe path: a small faststart file must not be materialized wholesale to read
 * its `moov`. In-memory bytes and remote sources keep the wider first window.
 */
const BLOB_FASTSTART_PROBE_INITIAL_BYTES = 16 * 1024;

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
 * True when walking the top-level boxes present in `head` proves no `moov` can ever be read: a box
 * declares an end beyond the finite source size, so the extent after it does not exist. Every other
 * shape — a box that runs past the *window* rather than the file, a `size: 0` box that legally extends
 * to EOF, a `moov` reached first, a header we cannot read yet — returns false and keeps the normal path.
 */
function isUnreachableIsoBmffLayout(head: Uint8Array, size: number): boolean {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let offset = 0;
  while (offset + 8 <= head.byteLength) {
    let boxSize = view.getUint32(offset);
    let headerSize = 8;
    if (boxSize === 1) {
      if (offset + 16 > head.byteLength) return false;
      const high = view.getUint32(offset + 8);
      const low = view.getUint32(offset + 12);
      boxSize = high * 0x1_0000_0000 + low;
      headerSize = 16;
    } else if (boxSize === 0) {
      return false;
    }
    if (boxSize < headerSize) return false;
    const type = String.fromCharCode(
      head[offset + 4] ?? 0,
      head[offset + 5] ?? 0,
      head[offset + 6] ?? 0,
      head[offset + 7] ?? 0,
    );
    if (type === 'moov') return false;
    const end = offset + boxSize;
    if (end > size) return true;
    offset = end;
  }
  return false;
}

/**
 * Probe the common finite faststart MP4 shape without loading the full demux/mux driver. `undefined`
 * is a deliberate decline: the lazy proxy then loads and calls the canonical complete driver once.
 */
export async function probeMp4Faststart(
  src: ByteSource,
  options?: StageOptions,
): Promise<ProbeTracks | undefined> {
  const range = src.range;
  const size = src.size;
  if (range === undefined || size === undefined || !Number.isSafeInteger(size) || size <= 0) {
    return undefined;
  }
  const signal = options?.signal;
  const retained = new Set<Uint8Array>();
  try {
    throwIfAborted(signal);
    // The head is read once and reused: the layout pre-check and the compact parser both start at
    // offset 0, and a second underlying range request there would be pure waste.
    let firstHead: Uint8Array | undefined;
    const randomAccess = {
      size,
      async read(offset: number, length: number): Promise<Uint8Array> {
        throwIfAborted(signal);
        if (offset === 0 && firstHead !== undefined && length <= firstHead.byteLength) {
          return length === firstHead.byteLength ? firstHead : firstHead.subarray(0, length);
        }
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
        const view = bytes.byteLength <= length ? bytes : bytes.subarray(0, length);
        if (firstHead === undefined && offset === 0) firstHead = view;
        return view;
      },
    };
    // A top-level box that declares an extent past a known finite EOF makes every later box —
    // including the `moov`, if the file has one — unreachable, so the file cannot be a movie. Reaching
    // that conclusion from the head the compact parser is about to read anyway keeps a malformed input
    // from walking (and materializing) the boxes it declares, and from loading the complete driver.
    const initialBytes =
      (src as ByteSource & { readonly kind?: string }).kind === 'blob'
        ? BLOB_FASTSTART_PROBE_INITIAL_BYTES
        : FASTSTART_PROBE_INITIAL_BYTES;
    if (isUnreachableIsoBmffLayout(await randomAccess.read(0, Math.min(size, initialBytes)), size)) {
      throw new MediaError('demux-error', 'no moov box found (not a valid MP4/MOV)');
    }
    const simple = await readSimpleVideoFaststartProbe(
      randomAccess,
      initialBytes,
      true,
    );
    const simpleTracks =
      simple !== undefined && simpleResultIsCanonicalSubset(simple.brand, simple.tracks)
        ? simple.tracks
        : undefined;
    throwIfAborted(signal);
    if (simpleTracks === undefined || simple === undefined) return undefined;
    // The `ftyp` brand came out of the same head window this probe already read, so reporting it as a
    // container tag costs nothing. Non-enumerable: the result still behaves as the plain track array.
    return Object.defineProperty(simpleTracks.map(detachTrack), 'tags', {
      value: Object.freeze({ major_brand: simple.brand }),
      enumerable: false,
      configurable: true,
    }) as ProbeTracks;
  } finally {
    for (const bytes of retained) src.releaseRange?.(bytes);
  }
}
