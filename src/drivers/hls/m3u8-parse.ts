/**
 * HLS playlist (`.m3u8`) parser (RFC 8216) — pure TS, no browser dependency. HLS is *not* a byte
 * container (it carries no media itself): it is a UTF-8 text manifest that points at either variant
 * sub-playlists (a **master/multivariant** playlist) or media **segments** (a **media** playlist). The
 * segments are typically MPEG-TS (or fMP4), so resolving + demuxing them reuses the
 * {@link import('../mpegts/mpegts-driver.ts')} driver — this module only turns the manifest text into a
 * structured, typed model (variants / segments / encryption descriptors) for the engine to drive.
 *
 * The parser is line-oriented and tolerant of CRLF or LF, blank lines, and unknown `#EXT-X-*` tags
 * (forward-compatibility, RFC 8216 §4.1), but **rejects** a manifest that does not begin with `#EXTM3U`.
 */

import { InputError } from '../../contracts/errors.ts';

/** A media-initialization section (`#EXT-X-MAP`) — the fMP4 init segment, when the variant is CMAF. */
export interface HlsMap {
  uri: string;
  byteRange?: HlsByteRange;
  /**
   * The `#EXT-X-KEY` in force when this `#EXT-X-MAP` was declared (RFC 8216 §4.3.2.4: a KEY applies to
   * every Media Segment *and* every Media Initialization Section between it and the next KEY). Absent
   * when the map was declared before any key (or after `METHOD=NONE`) — i.e. the init section is clear.
   */
  key?: HlsKey;
}

/** A `#EXT-X-BYTERANGE` sub-range of a resource: `length` bytes from `offset` (offset defaults per RFC). */
export interface HlsByteRange {
  length: number;
  offset?: number;
}

/** A `#EXT-X-KEY` descriptor — how the following segments are encrypted (RFC 8216 §4.3.2.4). */
export interface HlsKey {
  /** `NONE` clears encryption; `AES-128` / `SAMPLE-AES` are the encrypted methods. */
  method: 'NONE' | 'AES-128' | 'SAMPLE-AES' | 'SAMPLE-AES-CTR';
  /** Key resource URI (absent for `METHOD=NONE`). */
  uri?: string;
  /** 16-byte initialization vector (from `IV=0x…`), when explicitly carried. */
  iv?: Uint8Array;
  /** Key format (`identity` by default) and version list, passed through verbatim. */
  keyFormat?: string;
}

/** One media segment in a media playlist. */
export interface HlsSegment {
  /** Resolved (or raw, when no base was supplied) segment URI. */
  uri: string;
  /** `#EXTINF` duration in seconds. */
  durationSec: number;
  /** `#EXTINF` optional title field. */
  title?: string;
  /** The `#EXT-X-KEY` in force for this segment (inherited until the next KEY tag), if encrypted. */
  key?: HlsKey;
  /** A `#EXT-X-BYTERANGE` constraining this segment within its resource. */
  byteRange?: HlsByteRange;
  /** The `#EXT-X-MAP` init section in force for this segment (fMP4 variants). */
  map?: HlsMap;
  /** True when a `#EXT-X-DISCONTINUITY` precedes this segment (timeline/PID reset). */
  discontinuity: boolean;
  /** Absolute media sequence number (EXT-X-MEDIA-SEQUENCE + index). */
  sequence: number;
}

/** One variant stream in a master playlist (`#EXT-X-STREAM-INF` + its URI). */
export interface HlsVariant {
  /** Resolved (or raw) variant sub-playlist URI. */
  uri: string;
  /** Peak segment bit rate (`BANDWIDTH`, bits/s) — required by the spec. */
  bandwidth: number;
  /** Average segment bit rate (`AVERAGE-BANDWIDTH`), when present. */
  averageBandwidth?: number;
  /** `RESOLUTION=WxH`, when present. */
  resolution?: { width: number; height: number };
  /** Comma-joined RFC 6381 codec strings (`CODECS="…"`), when present. */
  codecs?: string;
  /** `FRAME-RATE`, when present. */
  frameRate?: number;
}

/** A parsed master (multivariant) playlist: it lists variant sub-playlists, never segments. */
export interface HlsMasterPlaylist {
  type: 'master';
  version?: number;
  variants: HlsVariant[];
}

/** A parsed media playlist: an ordered segment list plus its playlist-level attributes. */
export interface HlsMediaPlaylist {
  type: 'media';
  version?: number;
  /** `#EXT-X-TARGETDURATION` (seconds) — the maximum segment duration. */
  targetDuration?: number;
  /** `#EXT-X-MEDIA-SEQUENCE` — the sequence number of the first segment (default 0). */
  mediaSequence: number;
  /** `#EXT-X-PLAYLIST-TYPE` — `VOD` (immutable) or `EVENT` (append-only); absent for live sliding. */
  playlistType?: 'VOD' | 'EVENT';
  /** True when `#EXT-X-ENDLIST` is present (a complete, non-live playlist). */
  endList: boolean;
  segments: HlsSegment[];
  /** Total duration: the sum of segment `#EXTINF` durations (seconds). */
  durationSec: number;
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;

// ── attribute-list parsing (RFC 8216 §4.2) ────────────────────────────────────────────────────────

/**
 * Parse an HLS attribute list (`KEY=VALUE,KEY="quoted, value",KEY=0xHEX`). Commas inside double quotes
 * do not separate attributes; values are returned with quotes stripped. Robust to spaces around `=`.
 */
function parseAttributes(list: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  const n = list.length;
  while (i < n) {
    // key
    let key = '';
    while (i < n && list[i] !== '=') key += list[i++];
    if (i >= n) break; // malformed trailing key with no '=' — ignore it
    i++; // skip '='
    // value: quoted (commas allowed) or bare (ends at the next comma)
    let value = '';
    if (list[i] === '"') {
      i++;
      while (i < n && list[i] !== '"') value += list[i++];
      i++; // skip closing quote
    } else {
      while (i < n && list[i] !== ',') value += list[i++];
    }
    out.set(key.trim(), value);
    if (list[i] === ',') i++; // skip the separator
  }
  return out;
}

/** Parse `RESOLUTION=1920x1080` → `{ width, height }`. */
function parseResolution(value: string | undefined): { width: number; height: number } | undefined {
  if (value === undefined) return undefined;
  const m = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!m) return undefined;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * Parse an `IV=` attribute (RFC 8216 §4.3.2.4 / §4.2 hexadecimal-sequence): a `0x`/`0X`-prefixed hex
 * string of 1..32 digits, interpreted as a 128-bit big-endian integer and left-padded with zeros to 16
 * bytes (so `IV=0X7F` is `00…007f`). Returns `undefined` when the value is not a well-formed sequence —
 * a missing prefix, a non-hex digit, or wider than 128 bits — leaving the caller to decide tolerance.
 */
function parseHexIv(value: string): Uint8Array | undefined {
  const digits = /^0[xX]([0-9a-fA-F]{1,32})$/.exec(value.trim())?.[1];
  if (digits === undefined) return undefined;
  const hex = digits.padStart(32, '0');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Resolve a KEY's `IV=` attribute: `undefined` when absent (⇒ the implicit media-sequence IV per RFC
 * 8216 §4.3.2.4). A present-but-malformed IV is a hard {@link InputError} for the methods this engine
 * actually decrypts (`AES-128` / `SAMPLE-AES`) — never a silent fall-back to the sequence IV, which
 * would decrypt to garbage — but is tolerated (dropped) for opaque DRM methods whose IV is not ours to
 * interpret (e.g. `SAMPLE-AES-CTR` with a non-`identity` KEYFORMAT).
 */
function parseKeyIv(raw: string | undefined, method: HlsKey['method']): Uint8Array | undefined {
  if (raw === undefined) return undefined;
  const iv = parseHexIv(raw);
  if (iv !== undefined) return iv;
  if (method === 'AES-128' || method === 'SAMPLE-AES') {
    throw new InputError(
      `malformed EXT-X-KEY IV "${raw.trim()}" for METHOD=${method} (RFC 8216 §4.3.2.4)`,
    );
  }
  return undefined;
}

/** Parse `#EXT-X-BYTERANGE:length[@offset]`. */
function parseByteRange(value: string): HlsByteRange | undefined {
  const m = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!m) return undefined;
  const length = Number(m[1]);
  return m[2] !== undefined ? { length, offset: Number(m[2]) } : { length };
}

/** Parse a `#EXT-X-KEY` / `#EXT-X-SESSION-KEY` attribute list into an {@link HlsKey}. */
function parseKey(attrs: Map<string, string>): HlsKey {
  const method = (attrs.get('METHOD') ?? 'NONE') as HlsKey['method'];
  const uri = attrs.get('URI');
  const iv = parseKeyIv(attrs.get('IV'), method);
  const keyFormat = attrs.get('KEYFORMAT');
  return {
    method,
    ...(uri !== undefined ? { uri } : {}),
    ...(iv !== undefined ? { iv } : {}),
    ...(keyFormat !== undefined ? { keyFormat } : {}),
  };
}

// ── URI resolution ────────────────────────────────────────────────────────────────────────────────

/** Resolve a (possibly relative) playlist URI against an optional base, RFC 3986 style. */
function resolveUri(uri: string, base: string | undefined): string {
  if (base === undefined) return uri;
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri; // a non-URL base (e.g. a bare path) leaves the URI untouched rather than throwing
  }
}

// ── tag extraction ────────────────────────────────────────────────────────────────────────────────

/** A line is a tag (`#EXT…`), a comment (`#` but not `#EXT`), a URI, or blank. */
function lineKind(line: string): 'tag' | 'comment' | 'uri' | 'blank' {
  if (line.length === 0) return 'blank';
  if (line.startsWith('#EXT')) return 'tag';
  if (line.startsWith('#')) return 'comment';
  return 'uri';
}

/** Split a `#TAG:value` line into its name and (possibly empty) value; a value-less tag has `value=''`. */
function splitTag(line: string): { name: string; value: string } {
  const colon = line.indexOf(':');
  return colon < 0
    ? { name: line, value: '' }
    : { name: line.slice(0, colon), value: line.slice(colon + 1) };
}

// ── the parser ────────────────────────────────────────────────────────────────────────────────────

/**
 * Mutable accumulator while scanning a media playlist's segment list. Optional fields are typed
 * `T | undefined` (not `?:`) because the scan deliberately resets them to `undefined` after each segment
 * (`exactOptionalPropertyTypes` distinguishes "absent" from "present-but-undefined").
 */
interface MediaState {
  version: number | undefined;
  targetDuration: number | undefined;
  mediaSequence: number;
  playlistType: 'VOD' | 'EVENT' | undefined;
  endList: boolean;
  segments: HlsSegment[];
  // Pending per-segment attributes that apply to the next URI line.
  pendingDuration: number | undefined;
  pendingTitle: string | undefined;
  pendingByteRange: HlsByteRange | undefined;
  pendingDiscontinuity: boolean;
  // Inherited-until-changed state.
  currentKey: HlsKey | undefined;
  currentMap: HlsMap | undefined;
  // Running end offset of the previous `#EXT-X-BYTERANGE` sub-range, for the §4.3.2.2 continuation form
  // (a range with no `@offset` resumes at the previous sub-range's end within the *same* resource).
  byteRangeCursor: { uri: string; end: number } | undefined;
}

/**
 * Parse an `.m3u8` document into a typed {@link HlsPlaylist}. `baseUrl` (optional) resolves relative
 * segment/variant URIs (e.g. the playlist's own URL). Throws {@link InputError} when the text does not
 * start with the required `#EXTM3U` tag (per RFC 8216 §4.3.1.1 — that is how an `.m3u8` is identified).
 */
export function parseM3u8(text: string, baseUrl?: string): HlsPlaylist {
  // Tolerate a UTF-8 BOM and either line ending; ignore surrounding whitespace per line.
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') {
    throw new InputError('not an HLS playlist (missing #EXTM3U on the first line)');
  }

  // Decide master-vs-media lazily: a master has EXT-X-STREAM-INF; a media has EXTINF/segment URIs. We
  // accumulate both candidate states in one pass and pick based on which signal we actually saw.
  const variants: HlsVariant[] = [];
  let pendingStreamInf: Map<string, string> | undefined;
  let version: number | undefined;

  const media: MediaState = {
    version: undefined,
    targetDuration: undefined,
    mediaSequence: 0,
    playlistType: undefined,
    endList: false,
    segments: [],
    pendingDuration: undefined,
    pendingTitle: undefined,
    pendingByteRange: undefined,
    pendingDiscontinuity: false,
    currentKey: undefined,
    currentMap: undefined,
    byteRangeCursor: undefined,
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const kind = lineKind(line);
    if (kind === 'blank' || kind === 'comment') continue;

    if (kind === 'uri') {
      if (pendingStreamInf) {
        // The URI completing an EXT-X-STREAM-INF: a master-playlist variant.
        variants.push(variantFrom(pendingStreamInf, resolveUri(line, baseUrl)));
        pendingStreamInf = undefined;
      } else if (media.pendingDuration !== undefined) {
        // The URI completing an EXTINF: a media-playlist segment.
        media.segments.push(segmentFrom(media, resolveUri(line, baseUrl)));
        media.pendingDuration = undefined;
        media.pendingTitle = undefined;
        media.pendingByteRange = undefined;
        media.pendingDiscontinuity = false;
      }
      // A bare URI with no preceding STREAM-INF/EXTINF is malformed; skip it (forward-compatible).
      continue;
    }

    // kind === 'tag'
    const { name, value } = splitTag(line);
    switch (name) {
      case '#EXT-X-VERSION':
        version = toInt(value);
        break;
      case '#EXT-X-STREAM-INF':
        pendingStreamInf = parseAttributes(value);
        break;
      case '#EXT-X-TARGETDURATION':
        media.targetDuration = toNum(value);
        break;
      case '#EXT-X-MEDIA-SEQUENCE':
        media.mediaSequence = toInt(value) ?? 0;
        break;
      case '#EXT-X-PLAYLIST-TYPE':
        media.playlistType =
          value.trim() === 'EVENT' ? 'EVENT' : value.trim() === 'VOD' ? 'VOD' : undefined;
        break;
      case '#EXT-X-ENDLIST':
        media.endList = true;
        break;
      case '#EXTINF': {
        const comma = value.indexOf(',');
        const durStr = comma < 0 ? value : value.slice(0, comma);
        media.pendingDuration = toNum(durStr) ?? 0;
        const title = comma < 0 ? '' : value.slice(comma + 1).trim();
        if (title.length > 0) media.pendingTitle = title;
        break;
      }
      case '#EXT-X-BYTERANGE':
        media.pendingByteRange = parseByteRange(value);
        break;
      case '#EXT-X-DISCONTINUITY':
        media.pendingDiscontinuity = true;
        break;
      case '#EXT-X-KEY': {
        const key = parseKey(parseAttributes(value));
        const resolvedKey =
          key.uri === undefined ? key : { ...key, uri: resolveUri(key.uri, baseUrl) };
        media.currentKey = key.method === 'NONE' ? undefined : resolvedKey; // METHOD=NONE clears inheritance
        break;
      }
      case '#EXT-X-MAP': {
        const attrs = parseAttributes(value);
        const uri = attrs.get('URI');
        if (uri !== undefined) {
          const br = attrs.get('BYTERANGE');
          const byteRange = br !== undefined ? parseByteRange(br) : undefined;
          // Snapshot the KEY in force NOW: an encrypted init section is decrypted with the key that
          // applies at the map's declaration point, not the one in force at a later segment (§4.3.2.4).
          media.currentMap = {
            uri: resolveUri(uri, baseUrl),
            ...(byteRange !== undefined ? { byteRange } : {}),
            ...(media.currentKey !== undefined ? { key: media.currentKey } : {}),
          };
        }
        break;
      }
      default:
        // Unknown / unhandled EXT-X tag — ignored for forward-compatibility (RFC 8216 §4.1).
        break;
    }
  }

  if (variants.length > 0) {
    return {
      type: 'master',
      ...(version !== undefined ? { version } : {}),
      variants,
    };
  }
  const durationSec = media.segments.reduce((sum, s) => sum + s.durationSec, 0);
  return {
    type: 'media',
    ...(version !== undefined ? { version } : {}),
    ...(media.targetDuration !== undefined ? { targetDuration: media.targetDuration } : {}),
    mediaSequence: media.mediaSequence,
    ...(media.playlistType !== undefined ? { playlistType: media.playlistType } : {}),
    endList: media.endList,
    segments: media.segments,
    durationSec,
  };
}

/** Build an {@link HlsVariant} from a STREAM-INF attribute list + its resolved URI. */
function variantFrom(attrs: Map<string, string>, uri: string): HlsVariant {
  const bandwidth = toInt(attrs.get('BANDWIDTH')) ?? 0;
  const averageBandwidth = toInt(attrs.get('AVERAGE-BANDWIDTH'));
  const resolution = parseResolution(attrs.get('RESOLUTION'));
  const codecs = attrs.get('CODECS');
  const frameRate = toNum(attrs.get('FRAME-RATE'));
  return {
    uri,
    bandwidth,
    ...(averageBandwidth !== undefined ? { averageBandwidth } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(codecs !== undefined ? { codecs } : {}),
    ...(frameRate !== undefined ? { frameRate } : {}),
  };
}

/** Build an {@link HlsSegment} from the pending per-segment state + its resolved URI. */
function segmentFrom(media: MediaState, uri: string): HlsSegment {
  const byteRange = segmentByteRange(media, uri);
  return {
    uri,
    durationSec: media.pendingDuration ?? 0,
    ...(media.pendingTitle !== undefined ? { title: media.pendingTitle } : {}),
    ...(media.currentKey !== undefined ? { key: media.currentKey } : {}),
    ...(byteRange !== undefined ? { byteRange } : {}),
    ...(media.currentMap !== undefined ? { map: media.currentMap } : {}),
    discontinuity: media.pendingDiscontinuity,
    sequence: media.mediaSequence + media.segments.length,
  };
}

/**
 * Materialize this segment's `#EXT-X-BYTERANGE` window and advance the continuation cursor (RFC 8216
 * §4.3.2.2). An explicit `length@offset` is used verbatim; a bare `length` (no `@offset`) resumes at the
 * previous sub-range's end within the **same** resource. A first/orphan continuation, or one whose
 * previous segment is a different resource (or not a sub-range at all), is a typed {@link InputError}.
 * A segment with no byte range clears the cursor — a following continuation can only follow a sub-range.
 */
function segmentByteRange(media: MediaState, uri: string): HlsByteRange | undefined {
  const pending = media.pendingByteRange;
  if (pending === undefined) {
    media.byteRangeCursor = undefined;
    return undefined;
  }
  const offset = pending.offset ?? continuationOffset(media, uri);
  media.byteRangeCursor = { uri, end: offset + pending.length };
  return { length: pending.length, offset };
}

/** The resume offset for an `@offset`-less `#EXT-X-BYTERANGE`: the previous sub-range's end (same resource). */
function continuationOffset(media: MediaState, uri: string): number {
  const cursor = media.byteRangeCursor;
  if (cursor === undefined || cursor.uri !== uri) {
    throw new InputError(
      'EXT-X-BYTERANGE without an offset must continue a sub-range of the same preceding media resource (RFC 8216 §4.3.2.2)',
    );
  }
  return cursor.end;
}

/** Parse an integer attribute value (`undefined` when absent / non-numeric). */
function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isNaN(n) ? undefined : n;
}

/** Parse a decimal attribute value (`undefined` when absent / non-numeric). */
function toNum(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseFloat(value.trim());
  return Number.isNaN(n) ? undefined : n;
}
