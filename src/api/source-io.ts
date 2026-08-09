/**
 * Source byte-IO helpers for the engine's probe/route paths (moved out of the `engine.ts` god-file,
 * R-S05.1): bounded head reads for container routing, abort-aware whole-source materialization, the
 * probe-prefix handoff cache that lets a `probe` immediately followed by a `decode` of the same URL reuse
 * the probed head bytes, and the cheap HLS-manifest plausibility gate.
 */

import { InputError, MediaError } from '../contracts/errors.ts';
import { raceAbort, throwIfSourceAborted } from '../sources/abort.ts';
import {
  SOURCE_CACHE_KEY,
  SOURCE_URL_KEY,
  type Source,
  peekSourceHead,
} from '../sources/source.ts';
import { CONTAINER_MIME } from './container-mime.ts';

export const HEAD_BYTES = 64 * 1024;
export const HINTED_HEAD_BYTES = 4 * 1024;

interface SourcePrefixHandoffBase {
  readonly bytes: Uint8Array;
  /** Total learned by the range response that produced `bytes`, when the source exposed it. */
  readonly size?: number;
  /** Owned expiry handle; also the entry's generation identity. */
  readonly token: ReturnType<typeof setTimeout>;
}

/** A probed source prefix handed from `probe` to the next op on the same cache-keyed source. */
export type SourcePrefixHandoff = SourcePrefixHandoffBase &
  (
    | {
        readonly reusable?: undefined;
        readonly expiresAtMs?: undefined;
      }
    | {
        /** Finite blob-URL entry reusable by a distinct Source snapshot. */
        readonly reusable: true;
        /** Absolute admission deadline (never extended on a hit). */
        readonly expiresAtMs: number;
        /** Exactly one active expiry timer is owned by a reusable entry. */
      }
  );

export function routeHeadBytes(src: Source): number {
  return src.mimeHint !== undefined || src.filename !== undefined ? HINTED_HEAD_BYTES : HEAD_BYTES;
}

export async function readHead(
  src: Source,
  n: number = HEAD_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return peekSourceHead(src, n, signal);
}

export async function readAllSource(
  src: Source,
  signal: AbortSignal | undefined,
  maximumBytes?: number,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  assertMaximumReadBytes(maximumBytes);
  if (maximumBytes !== undefined && src.size !== undefined && src.size > maximumBytes) {
    throw sourceTooLarge(src.size, maximumBytes);
  }
  if (src.range && src.size !== undefined) {
    const bytes = await raceAbort(src.range(0, src.size, signal), signal);
    if (maximumBytes !== undefined && bytes.byteLength > maximumBytes) {
      throw sourceTooLarge(bytes.byteLength, maximumBytes);
    }
    return bytes;
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      if (maximumBytes !== undefined && value.byteLength > maximumBytes - total) {
        throw sourceTooLarge(total + value.byteLength, maximumBytes);
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (e) {
    await reader.cancel(e).catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  throwIfAborted(signal);
  return out;
}

function assertMaximumReadBytes(maximumBytes: number | undefined): void {
  if (
    maximumBytes !== undefined &&
    (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
  ) {
    throw new InputError('maximum source byte limit must be a positive safe integer');
  }
}

function sourceTooLarge(observedBytes: number, maximumBytes: number): InputError {
  return new InputError(
    `source exceeds the ${maximumBytes}-byte operation limit`,
    { observedBytes, maximumBytes },
  );
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new MediaError('aborted', 'aborted');
  }
}

export function extensionOf(filename: string | undefined): string | undefined {
  if (filename === undefined) return undefined;
  const dot = filename.lastIndexOf('.');
  return dot >= 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : undefined;
}

/**
 * Whether a source's declared MIME/extension is HLS-plausible enough to warrant a content sniff.
 * A manifest arrives either self-described (`.m3u8`, `application/vnd.apple.mpegurl`) or — as the
 * harness labels them — mislabeled as an MPEG-TS stream (`video/mp2t`). Every definite non-HLS
 * container (mp4/wav/flac/webm/…) returns `false` so the HLS path costs it no extra head read.
 */
export function sourceMayBeHlsManifest(src: Source): boolean {
  const ext = extensionOf(src.filename);
  if (ext === 'm3u8' || ext === 'm3u') return true;
  const mime = src.mimeHint?.toLowerCase().split(';', 1)[0]?.trim();
  if (mime !== undefined && /(?:mpegurl|m3u8)|^(?:video|audio)\/mp2t$/.test(mime)) return true;
  // Known media extensions and concrete audio/video/image MIME families cannot be a text playlist, so
  // they skip the extra read. Generic or text MIME, unknown extensions, and no hints remain ambiguous:
  // confirm their actual `#EXTM3U` bytes, preserving replay for every non-match.
  if (
    (ext !== undefined && CONTAINER_MIME[ext] !== undefined) ||
    /^(?:audio|video|image)\//.test(mime ?? '')
  ) {
    return false;
  }
  return true;
}

/** Cheap eager gate before loading the finite blob-URL handoff implementation. */
export function sourceMayHaveBlobProbeHandoff(src: Source): boolean {
  return !!src[SOURCE_CACHE_KEY]?.startsWith('blob:');
}

/**
 * Object spread snapshots an optional Source property. URL-backed `size` and redirect provenance are
 * learned later, so install forwarding accessors without widening the public optional-property types.
 */
function preserveLiveSourceFacts(
  wrapped: Source,
  src: Source,
  handedOffSize: () => number | undefined,
): Source {
  Object.defineProperties(wrapped, {
    size: {
      configurable: true,
      enumerable: true,
      get: () => src.size ?? handedOffSize(),
    },
    [SOURCE_URL_KEY]: {
      configurable: true,
      enumerable: true,
      get: () => src[SOURCE_URL_KEY],
    },
  });
  return wrapped;
}

export function cacheProbeRanges(
  src: Source,
  handoff?: Map<string, SourcePrefixHandoff>,
  mode: 'local' | 'store' | 'consume' = 'local',
  options: { readonly maxBytes?: number; readonly ttlMs?: number } = {},
): Source {
  const range = src.range;
  if (range === undefined) return src;
  const cacheKey = src[SOURCE_CACHE_KEY];
  const consumed =
    mode === 'consume' && cacheKey !== undefined && handoff !== undefined
      ? handoff.get(cacheKey)
      : undefined;
  let cached = consumed?.bytes;
  let cachedSize = consumed?.size;
  if (mode === 'consume' && cacheKey !== undefined && handoff !== undefined) {
    dropSourcePrefixHandoff(handoff, cacheKey);
  }
  const wrapped: Source = {
    ...src,
    // `fromURL()` learns size and its final redirect URL during a range response. Object spread would
    // snapshot/omit those late facts, so every Source wrapper must keep them live. A fresh Source that
    // consumes a probe prefix also needs the total learned by the probe: otherwise parsing wholly from
    // the cached prefix leaves the new URL unread and MP4 cannot validate its terminal boxes/mdat.
    range: async (start, end, signal) => {
      throwIfSourceAborted(signal);
      const sourceSize = src.size ?? cachedSize;
      const cachedCoversEnd =
        cached !== undefined &&
        (end <= cached.byteLength ||
          (sourceSize !== undefined && cached.byteLength >= sourceSize && end >= sourceSize));
      if (cached !== undefined && start >= 0 && cachedCoversEnd) {
        return cached.subarray(start, end);
      }
      const bytes = await raceAbort(range.call(src, start, end, signal), signal);
      throwIfSourceAborted(signal);
      cachedSize =
        src.size ??
        cachedSize ??
        (start === 0 && bytes.byteLength < Math.max(0, Math.trunc(end))
          ? bytes.byteLength
          : undefined);
      const cacheable = options.maxBytes === undefined || bytes.byteLength <= options.maxBytes;
      if (
        start === 0 &&
        cacheable &&
        (cached === undefined || bytes.byteLength > cached.byteLength)
      ) {
        cached = bytes;
        if (mode === 'store' && cacheKey !== undefined && handoff !== undefined) {
          storeSourcePrefixHandoff(handoff, cacheKey, bytes, cachedSize, options.ttlMs);
        }
      }
      return bytes;
    },
  };
  return preserveLiveSourceFacts(wrapped, src, () => cachedSize);
}

function storeSourcePrefixHandoff(
  handoff: Map<string, SourcePrefixHandoff>,
  cacheKey: string,
  bytes: Uint8Array,
  size: number | undefined,
  ttlMs = 250,
): void {
  dropSourcePrefixHandoff(handoff, cacheKey);
  const token = setTimeout(() => dropSourcePrefixHandoff(handoff, cacheKey, token), ttlMs);
  handoff.set(cacheKey, {
    bytes,
    ...(size !== undefined ? { size } : {}),
    token,
  });
}

function dropSourcePrefixHandoff(
  handoff: Map<string, SourcePrefixHandoff>,
  key: string,
  expectedToken?: ReturnType<typeof setTimeout>,
): void {
  const entry = handoff.get(key);
  if (entry === undefined || (expectedToken !== undefined && entry.token !== expectedToken)) {
    return;
  }
  handoff.delete(key);
  clearTimeout(entry.token);
}

export function clearSourcePrefixHandoffs(handoff: Map<string, SourcePrefixHandoff>): void {
  for (const entry of handoff.values()) clearTimeout(entry.token);
  handoff.clear();
}
