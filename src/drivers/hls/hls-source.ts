/**
 * HLS source resolution (RFC 8216) — turn an HLS `.m3u8` **playlist** into a single, demuxable
 * {@link Source} the unmodified engine can `probe`/`demux`/`decode`, **without** teaching the container
 * router about HLS. HLS is not a byte container: a `.m3u8` is a text manifest pointing at media segments
 * (typically MPEG-TS, sometimes fMP4). This module does the manifest-shaped work the engine's single-
 * contiguous-`Source` model can't: parse the playlist, pick a variant (master playlists), fetch each
 * segment, **decrypt** `AES-128` segments (RFC 8216 §4.3.2.4), prepend the fMP4 init section, and
 * concatenate the cleartext into one byte source tagged with the segment container's MIME — so the existing
 * MPEG-TS / MP4 driver demuxes it verbatim. (ADR-023 keeps segment decrypt a source-level concern, separate
 * from demux.)
 *
 * Disjoint by construction: it produces a normal `Source`; the engine is untouched. The resource fetch is
 * **injectable** ({@link HlsResolveOptions.fetchResource}) so the browser uses `fetch` while Node tests (and
 * the corpus) read local segment files — the playlist parse + variant pick + decrypt + stitch is the same
 * real code on both. MPEG-TS is concatenable (a continuous 188-byte packet stream across segments), so the
 * stitched bytes are a valid single TS; fMP4 needs its `EXT-X-MAP` init segment once, up front.
 */

import { InputError, MediaError } from '../../contracts/errors.ts';
import { AES_BLOCK } from '../../crypto/aes.ts';
import { decryptHlsAes128 } from '../../crypto/hls-aes.ts';
import { type Source, fromBytes } from '../../sources/source.ts';
import {
  type HlsKey,
  type HlsMediaPlaylist,
  type HlsSegment,
  type HlsVariant,
  parseM3u8,
} from './m3u8-parse.ts';

/** Fetch a resource's bytes by (resolved) URI — a real `fetch` in the browser, a file read in Node tests. */
export type HlsResourceFetcher = (uri: string) => Promise<Uint8Array>;

/** How to pick a rung from a master (multivariant) playlist. */
export type HlsVariantChoice = 'highest' | 'lowest' | number;

/** Options for {@link resolveHlsSource}. */
export interface HlsResolveOptions {
  /**
   * Fetch a resource (segment / key / sub-playlist) by its resolved URI. Defaults to `fetch` (browser /
   * Node 18+). Inject a reader for local-file corpora or to add auth/caching. Receives the **resolved**
   * absolute URI (the playlist's relative URIs are resolved against `baseUrl` first).
   */
  fetchResource?: HlsResourceFetcher;
  /** Base URL for resolving the playlist's relative segment/variant/key URIs (e.g. the playlist's own URL). */
  baseUrl?: string;
  /** Master-playlist rung selection (default `'highest'` bandwidth). Ignored for a media playlist. */
  variant?: HlsVariantChoice;
  /** Abort the resolution (stops further segment fetches). */
  signal?: AbortSignal;
}

/** The MIME the stitched bytes are tagged with, so the engine routes them to the right segment container. */
const TS_MIME = 'video/mp2t';
const FMP4_MIME = 'video/mp4';

/**
 * Resolve an HLS playlist into a single demuxable {@link Source}: parse → (pick variant) → fetch + decrypt +
 * stitch every segment → a seekable `fromBytes` source the engine probes/demuxes as MPEG-TS (or MP4 for
 * fMP4). `playlistText` is the `.m3u8` document; pass the playlist's own URL as `opts.baseUrl` so relative
 * segment URIs resolve. A master playlist transparently resolves its chosen variant's media playlist (one
 * extra fetch). `AES-128` segments are decrypted with the playlist key (key fetched via `fetchResource`,
 * IV = explicit `IV=` or the segment's media-sequence number per RFC 8216 §4.3.2.4).
 *
 * Honest about scope: only complete (`#EXT-X-ENDLIST`) VOD/EVENT playlists are fully stitched here; a live
 * sliding playlist (no ENDLIST) is rejected with a typed {@link InputError} (a growing manifest is not a
 * single finite source). `SAMPLE-AES` is declined (sample-level decrypt is the decrypt op's CENC/cbcs path,
 * not whole-segment AES-128) — never a fabricated cleartext.
 */
export async function resolveHlsSource(
  playlistText: string,
  opts: HlsResolveOptions = {},
): Promise<Source> {
  const fetchResource = opts.fetchResource ?? defaultFetchResource;
  const media = await resolveMediaPlaylist(playlistText, opts, fetchResource);
  if (!media.endList) {
    throw new InputError(
      'unsupported-input',
      'HLS live playlist (no #EXT-X-ENDLIST) cannot be resolved to a single finite source',
    );
  }
  if (media.segments.length === 0) {
    throw new InputError('unsupported-input', 'HLS media playlist has no segments');
  }

  const parts: Uint8Array[] = [];
  // Prepend the fMP4 init section FIRST (awaited before the segment loop) so the `ftyp`+`moov` lead the
  // fragments; for a TS playlist this is a no-op. Then fetch + decrypt + append each segment in order.
  const fmp4 = await appendInitSection(parts, media.segments[0], fetchResource, opts.signal);
  for (const segment of media.segments) {
    throwIfAborted(opts.signal);
    const raw = await fetchResource(segment.uri);
    parts.push(await decryptSegmentIfNeeded(raw, segment, fetchResource, opts.signal));
  }
  throwIfAborted(opts.signal);

  return fromBytes(concat(parts), { mime: fmp4 ? FMP4_MIME : TS_MIME });
}

// ── playlist resolution (master → media) ──────────────────────────────────────────────────────────

/** Parse the playlist; if it is a master, pick a variant and fetch+parse its media playlist. */
async function resolveMediaPlaylist(
  text: string,
  opts: HlsResolveOptions,
  fetchResource: HlsResourceFetcher,
): Promise<HlsMediaPlaylist> {
  const playlist = parseM3u8(text, opts.baseUrl);
  if (playlist.type === 'media') return playlist;
  // Master: choose a rung, fetch its sub-playlist, and parse THAT (resolving against the variant's URL).
  const variant = pickVariant(playlist.variants, opts.variant ?? 'highest');
  const subText = decodeUtf8(await fetchResource(variant.uri));
  const sub = parseM3u8(subText, variant.uri);
  /* v8 ignore next 3 -- defensive: a STREAM-INF URI pointing at another master (nested multivariant) is
     degenerate and not produced by real packagers; guarded so it is an honest typed error, not a crash. */
  if (sub.type !== 'media') {
    throw new InputError('unsupported-input', 'HLS variant playlist is not a media playlist');
  }
  return sub;
}

/** Pick a variant by bandwidth (`highest`/`lowest`) or an explicit index; never returns undefined. */
function pickVariant(variants: readonly HlsVariant[], choice: HlsVariantChoice): HlsVariant {
  /* v8 ignore next 3 -- unreachable: `parseM3u8` only classifies a playlist as `master` when it parsed ≥1
     variant, and `pickVariant` is called only on a master — so `variants` is never empty here. */
  if (variants.length === 0) {
    throw new InputError('unsupported-input', 'HLS master playlist has no variants');
  }
  if (typeof choice === 'number') {
    const v = variants[choice];
    if (v === undefined) {
      throw new InputError(
        'unsupported-input',
        `HLS variant index ${choice} out of range (0..${variants.length - 1})`,
      );
    }
    return v;
  }
  // Bandwidth-ordered: `BANDWIDTH` is spec-required, so the extremes are well-defined.
  return [...variants].sort((a, b) => a.bandwidth - b.bandwidth)[
    choice === 'highest' ? variants.length - 1 : 0
  ] as HlsVariant;
}

// ── fMP4 init + segment decrypt ─────────────────────────────────────────────────────────────────────

/**
 * If the first segment carries an `#EXT-X-MAP` (fMP4 / CMAF), fetch + prepend that init section once (it
 * holds the `ftyp`+`moov` the fragments need). Returns whether the stream is fMP4 (so the caller tags the
 * MIME as MP4). A byte-ranged map is honored. TS segments have no map ⇒ returns false, nothing prepended.
 */
async function appendInitSection(
  parts: Uint8Array[],
  first: HlsSegment | undefined,
  fetchResource: HlsResourceFetcher,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const map = first?.map;
  if (map === undefined) return false;
  throwIfAborted(signal);
  const init = await fetchResource(map.uri);
  parts.push(map.byteRange ? sliceByteRange(init, map.byteRange) : init);
  return true;
}

/**
 * Decrypt a segment when an `AES-128` key is in force; pass a clear segment through untouched. The key is
 * fetched once per distinct key URI (memoized by the fetcher's own caching if any); the IV is the explicit
 * `IV=` or, per RFC 8216 §4.3.2.4, the segment's 64-bit media-sequence number in the low bytes of a 16-byte
 * big-endian block. A `SAMPLE-AES` method is declined (that is sample-level, not whole-segment).
 */
async function decryptSegmentIfNeeded(
  raw: Uint8Array,
  segment: HlsSegment,
  fetchResource: HlsResourceFetcher,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const ranged = segment.byteRange ? sliceByteRange(raw, segment.byteRange) : raw;
  const key = segment.key;
  if (key === undefined || key.method === 'NONE') return ranged;
  if (key.method !== 'AES-128') {
    throw new MediaError(
      'decode-error',
      `HLS ${key.method} is not supported by source resolution (whole-segment AES-128 only)`,
    );
  }
  if (key.uri === undefined) {
    throw new InputError('unsupported-input', 'HLS AES-128 #EXT-X-KEY is missing its key URI');
  }
  throwIfAborted(signal);
  const keyBytes = toExact(await fetchResource(key.uri));
  const iv = toExact(ivForSegment(key, segment.sequence));
  return decryptHlsAes128(toExact(ranged), keyBytes, iv);
}

/** The 16-byte IV for a segment: the explicit `IV=` if present, else the media sequence as 16-byte BE. */
function ivForSegment(key: HlsKey, sequence: number): Uint8Array {
  if (key.iv !== undefined) return key.iv;
  const iv = new Uint8Array(AES_BLOCK);
  // The sequence number occupies the low 8 bytes, big-endian (RFC 8216 §4.3.2.4). `sequence` fits in 32
  // bits for any real corpus, so writing the low 4 bytes is exact; the upper bytes stay zero.
  const view = new DataView(iv.buffer);
  view.setUint32(AES_BLOCK - 4, sequence >>> 0, false);
  return iv;
}

// ── byte helpers ────────────────────────────────────────────────────────────────────────────────────

/** Slice a `#EXT-X-BYTERANGE` window (`length` bytes from `offset`, default 0) out of a resource. */
function sliceByteRange(bytes: Uint8Array, range: { length: number; offset?: number }): Uint8Array {
  const offset = range.offset ?? 0;
  return bytes.subarray(offset, offset + range.length);
}

/** Concatenate segment byte arrays into one contiguous buffer. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Copy a (possibly view-backed) `Uint8Array` onto its own exact `ArrayBuffer` for the WebCrypto APIs. */
function toExact(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Default resource fetch: a real HTTP/relative `fetch` (browser / Node ≥18). Honest miss when absent. */
/* v8 ignore start -- the real network fetch path; Node tests inject a local-file fetcher. */
async function defaultFetchResource(uri: string): Promise<Uint8Array> {
  if (typeof fetch !== 'function') {
    throw new InputError(
      'unsupported-input',
      'no `fetch` available to load HLS resources — provide `fetchResource`',
    );
  }
  const res = await fetch(uri);
  if (!res.ok) {
    throw new InputError(
      'unsupported-input',
      `HLS resource fetch failed for ${uri} (${res.status})`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}
/* v8 ignore stop */

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation cancelled');
}
