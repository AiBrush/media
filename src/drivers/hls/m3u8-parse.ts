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

/** Parse a `0x…` / `0X…` hex IV into 16 bytes (RFC 8216 §4.3.2.4); `undefined` if not a 32-hex-digit IV. */
function parseHexIv(value: string | undefined): Uint8Array | undefined {
  if (value === undefined) return undefined;
  const hex = value.trim().replace(/^0[xX]/, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
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
  const iv = parseHexIv(attrs.get('IV'));
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
    throw new InputError(
      'unsupported-input',
      'not an HLS playlist (missing #EXTM3U on the first line)',
    );
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
          media.currentMap = {
            uri: resolveUri(uri, baseUrl),
            ...(byteRange !== undefined ? { byteRange } : {}),
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
  return {
    uri,
    durationSec: media.pendingDuration ?? 0,
    ...(media.pendingTitle !== undefined ? { title: media.pendingTitle } : {}),
    ...(media.currentKey !== undefined ? { key: media.currentKey } : {}),
    ...(media.pendingByteRange !== undefined ? { byteRange: media.pendingByteRange } : {}),
    ...(media.currentMap !== undefined ? { map: media.currentMap } : {}),
    discontinuity: media.pendingDiscontinuity,
    sequence: media.mediaSequence + media.segments.length,
  };
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
