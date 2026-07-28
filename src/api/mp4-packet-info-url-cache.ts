/**
 * Lazy, fact-only reuse for prepared MP4/MOV packet tables.
 *
 * A `blob:` URL plus an exact finite size names one immutable browser Blob snapshot. Ordinary HTTP
 * URLs are mutable even when their current Content-Length is known, so they are deliberately excluded.
 * The cache owns parsed metadata only: no source windows or packet payload bytes enter this module.
 */

import type { PacketInfoMetadata, PacketInfoTable, TrackInfo } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 8;
// Packet rows are object-heavy. This ceiling bounds retained facts to a useful large-input working set
// without turning repeated packet-table calls into an unbounded media-index registry.
const DEFAULT_MAX_ROWS = 262_144;

const SAFE_OPTION_KEYS = new Set(['mime', 'signal', 'size']);

export interface Mp4PacketInfoUrlCacheIdentity {
  /** Complete semantic key excluding the packet-info provider registration. */
  readonly key: string;
  /** Exact provider identity prevents a registration/hot-reload change from serving stale parser facts. */
  readonly provider: object;
}

interface Mp4PacketInfoUrlCacheEntry {
  readonly provider: object;
  readonly table: PacketInfoTable;
  readonly rows: number;
  readonly expiresAtMs: number;
  readonly expiry: ReturnType<typeof setTimeout>;
}

export interface Mp4PacketInfoUrlCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxRows?: number;
}

/**
 * Build an admitted immutable-snapshot identity. Unknown runtime options conservatively bypass reuse so
 * a future semantic option cannot accidentally alias an older cache key.
 */
export function mp4PacketInfoUrlCacheIdentity(
  url: string | URL,
  options: object & {
    readonly mime?: unknown;
    readonly size?: unknown;
    readonly signal?: unknown;
  },
  provider: object,
): Mp4PacketInfoUrlCacheIdentity | undefined {
  const href = String(url);
  const size = options.size;
  if (
    !href.toLowerCase().startsWith('blob:') ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    Object.keys(options).some((key) => !SAFE_OPTION_KEYS.has(key))
  ) {
    return undefined;
  }
  const mime = options.mime;
  if (mime !== undefined && typeof mime !== 'string') return undefined;
  return {
    key: JSON.stringify([href, size, mime ?? 'video/mp4']),
    provider,
  };
}

/** Success-only, absolute-TTL LRU with a shared parsed-row budget. */
export class Mp4PacketInfoUrlCache {
  readonly #entries = new Map<string, Mp4PacketInfoUrlCacheEntry>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxRows: number;
  #rows = 0;

  constructor(options: Mp4PacketInfoUrlCacheOptions = {}) {
    this.#ttlMs = normalizedBound(options.ttlMs, DEFAULT_TTL_MS);
    this.#maxEntries = normalizedBound(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.#maxRows = normalizedBound(options.maxRows, DEFAULT_MAX_ROWS);
  }

  get entryCount(): number {
    return this.#entries.size;
  }

  get rowCount(): number {
    return this.#rows;
  }

  hit(identity: Mp4PacketInfoUrlCacheIdentity, signal?: AbortSignal): PacketInfoTable | undefined {
    throwIfAborted(signal);
    const entry = this.#entries.get(identity.key);
    if (entry === undefined) return undefined;
    if (entry.provider !== identity.provider || entry.expiresAtMs <= Date.now()) {
      this.#drop(identity.key, entry);
      return undefined;
    }

    // Map insertion order is the LRU order. Touching does not extend the absolute TTL.
    this.#entries.delete(identity.key);
    this.#entries.set(identity.key, entry);
    const snapshot = clonePacketInfoTable(entry.table);
    throwIfAborted(signal);
    return snapshot;
  }

  store(
    identity: Mp4PacketInfoUrlCacheIdentity,
    table: PacketInfoTable,
    signal?: AbortSignal,
  ): void {
    throwIfAborted(signal);
    const previous = this.#entries.get(identity.key);
    if (previous !== undefined) this.#drop(identity.key, previous);

    const rows = table.tracks.length + table.packets.length;
    if (
      this.#ttlMs === 0 ||
      this.#maxEntries === 0 ||
      this.#maxRows === 0 ||
      rows > this.#maxRows
    ) {
      return;
    }

    const owned = clonePacketInfoTable(table);
    throwIfAborted(signal);
    while (this.#entries.size >= this.#maxEntries || this.#rows + rows > this.#maxRows) {
      const oldest = this.#entries.entries().next().value;
      if (oldest === undefined) break;
      this.#drop(oldest[0], oldest[1]);
    }
    if (this.#entries.size >= this.#maxEntries || this.#rows + rows > this.#maxRows) return;

    const expiresAtMs = Date.now() + this.#ttlMs;
    const expiry = setTimeout(() => {
      const current = this.#entries.get(identity.key);
      if (current?.expiry === expiry) this.#drop(identity.key, current);
    }, this.#ttlMs);
    this.#entries.set(identity.key, {
      provider: identity.provider,
      table: owned,
      rows,
      expiresAtMs,
      expiry,
    });
    this.#rows += rows;
  }

  clear(): void {
    for (const [key, entry] of this.#entries) this.#drop(key, entry);
  }

  #drop(key: string, expected: Mp4PacketInfoUrlCacheEntry): void {
    if (this.#entries.get(key) !== expected) return;
    this.#entries.delete(key);
    this.#rows -= expected.rows;
    clearTimeout(expected.expiry);
  }
}

function normalizedBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}

function clonePacketInfoTable(table: PacketInfoTable): PacketInfoTable {
  return {
    tracks: table.tracks.map(cloneTrackInfo),
    packets: table.packets.map(clonePacketInfoMetadata),
  };
}

function cloneTrackInfo(track: TrackInfo): TrackInfo {
  return cloneMetadataValue(track) as TrackInfo;
}

function clonePacketInfoMetadata(packet: PacketInfoMetadata): PacketInfoMetadata {
  return { ...packet };
}

/**
 * Track facts can contain nested WebCodecs config/color records and codec-description byte views.
 * Recursively own those small records; packet rows use the specialized shallow clone above.
 */
function cloneMetadataValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (Array.isArray(value)) return value.map(cloneMetadataValue);
  const clone: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) clone[key] = cloneMetadataValue(child);
  return clone;
}

/** Module singleton: loaded only after the public API proves finite-blob eligibility. */
export const mp4PacketInfoUrlCache = new Mp4PacketInfoUrlCache();
