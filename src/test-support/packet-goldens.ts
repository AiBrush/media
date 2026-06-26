/**
 * Shared definition of the `golden-packets` baked oracle (doc 11 §1-2, BUILD_INSTRUCTIONS §6.1) — the
 * single source of truth for both `scripts/bake-goldens.ts` (writer) and
 * `src/conformance/golden-packets.test.ts` (asserter), so they can never drift (the same pattern as
 * `dsp-goldens.ts`).
 *
 * **What it pins.** For a handful of deterministic real fixtures across containers, the exact demuxed
 * packet table the engine's *own* demuxer produces — per packet: track id, byte size, PTS µs, duration µs,
 * and (video) the keyframe flag — plus a sha256 over a canonical serialization. This is the bit-exact
 * structural oracle for `demux` (doc 11 §2 maps `demux → golden-packets`).
 *
 * **Node-feasibility.** vitest runs under Node, where the codec seam (`packets()` building
 * `EncodedAudioChunk`/`EncodedVideoChunk`) is browser-only. But every container exposes the *byte geometry +
 * timing* of its packets through a **pure** path that needs no WebCodecs: MP4 via
 * {@link mp4PacketMetadata} (the `Demuxer.packetTable()` fast path), and the elementary-stream containers
 * (FLAC/ADTS/MP3/Ogg) via their pure frame enumerators — exactly the logic `packets()` wraps. So the table
 * is computed here without a browser, and the browser harness later asserts the *same* table emerges from
 * the live `EncodedChunk` stream (timestamp/byteLength), layering the codec-seam facet on top.
 *
 * **Independent corroboration (anti-self-confirmation).** The committed golden carries the engine's table;
 * the bake script ADDITIONALLY cross-checks the packet count and total payload bytes against `ffprobe`
 * (`-show_packets`) at bake time (see scripts/bake-goldens.ts) and records the ffprobe figures in the
 * golden, so a future engine change that silently drifts from an independent demuxer is caught — the golden
 * is not a pure round-trip of our own output. ADR-085.
 */

import { enumerateFlacFrameSpans } from '../codecs/flac/decode.ts';
import type { PacketMetadata } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { enumerateAdtsFrames } from '../drivers/adts/adts-driver.ts';
import { enumerateMp3Packets } from '../drivers/mp3/mp3-driver.ts';
import { Mp4Driver } from '../drivers/mp4/mp4-driver.ts';
import { oggAudioPackets } from '../drivers/ogg/ogg-driver.ts';
import { sha256Hex } from '../util/digest.ts';

/** One row of a golden packet table — the byte geometry + timing of a demuxed packet (no payload bytes). */
export interface GoldenPacketRow {
  readonly trackId: number;
  readonly sizeBytes: number;
  readonly ptsUs: number;
  readonly durationUs: number;
  /** Present only for video tracks (audio packets are all sync samples). */
  readonly keyframe?: boolean;
}

/** Per-track packet count + summed payload bytes — the unit corroborated against ffprobe at bake time. */
export interface PerTrackTally {
  readonly trackId: number;
  readonly count: number;
  readonly bytes: number;
}

/** A committed golden-packets reference for one fixture. */
export interface GoldenPackets {
  readonly container: string;
  /** Number of packets in the table (across all tracks). */
  readonly count: number;
  /** Sum of every packet's `sizeBytes`. */
  readonly totalBytes: number;
  /** sha256 over the canonical serialization of {@link rows}. */
  readonly sha256: string;
  /** Per-track tallies (the granularity at which ffprobe corroborates the table — see scripts/bake-goldens.ts). */
  readonly perTrack: readonly PerTrackTally[];
  /** The packet table (kept in the golden for human review + exact mismatch diagnostics). */
  readonly rows: readonly GoldenPacketRow[];
}

/** Group a packet table into per-track {count, bytes} tallies (sorted by track id) — the ffprobe-comparable unit. */
export function perTrackTallies(rows: readonly GoldenPacketRow[]): PerTrackTally[] {
  const byTrack = new Map<number, { count: number; bytes: number }>();
  for (const r of rows) {
    const t = byTrack.get(r.trackId) ?? { count: 0, bytes: 0 };
    t.count++;
    t.bytes += r.sizeBytes;
    byTrack.set(r.trackId, t);
  }
  return [...byTrack.entries()]
    .map(([trackId, v]) => ({ trackId, count: v.count, bytes: v.bytes }))
    .sort((a, b) => a.trackId - b.trackId);
}

/** Canonical, stable serialization of a packet row set (one row per line) for hashing. */
function serializeRows(rows: readonly GoldenPacketRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.trackId}|${r.sizeBytes}|${r.ptsUs}|${r.durationUs}|${r.keyframe === undefined ? '' : r.keyframe ? '1' : '0'}`,
    )
    .join('\n');
}

/**
 * Compute the engine's demuxed packet table for one fixture, in a Node-feasible (no-WebCodecs) way. The
 * container is selected by the fixture's declared `container` token; an unrecognized token throws (the
 * caller must extend this when a new container joins the golden set — no silent fallthrough).
 */
export async function goldenPacketsFor(
  container: string,
  bytes: Uint8Array,
): Promise<GoldenPackets> {
  const rows = await rowsFor(container, bytes);
  if (rows.length === 0) {
    throw new MediaError('demux-error', `golden-packets: ${container} produced no packets`);
  }
  const totalBytes = rows.reduce((sum, r) => sum + r.sizeBytes, 0);
  return {
    container,
    count: rows.length,
    totalBytes,
    sha256: await sha256Hex(new TextEncoder().encode(serializeRows(rows))),
    perTrack: perTrackTallies(rows),
    rows,
  };
}

async function rowsFor(container: string, bytes: Uint8Array): Promise<GoldenPacketRow[]> {
  switch (container) {
    case 'mp4':
    case 'mov': {
      // The MP4 demuxer's packet-table fast path (pure: parses the sample tables, no payload bytes read).
      const demuxer = await Mp4Driver.demux({
        stream: () => oneShot(bytes),
        size: bytes.byteLength,
      });
      try {
        const table = demuxer.packetTable?.();
        if (!table)
          throw new MediaError('demux-error', 'mp4 fixture lacks a complete sample table');
        return table.map(fromMp4Meta);
      } finally {
        await demuxer.close();
      }
    }
    case 'flac':
      return enumerateFlacFrameSpans(bytes).map((f) => ({
        trackId: 0,
        sizeBytes: f.size,
        ptsUs: f.ptsUs,
        durationUs: f.durationUs,
      }));
    case 'adts':
      return enumerateAdtsFrames(bytes).map((f) => ({
        trackId: 0,
        sizeBytes: f.size,
        ptsUs: f.ptsUs,
        durationUs: f.durationUs,
      }));
    case 'mp3':
      return enumerateMp3Packets(bytes).map((f) => ({
        trackId: 0,
        sizeBytes: f.size,
        ptsUs: f.ptsUs,
        durationUs: f.durationUs,
      }));
    case 'ogg':
      return oggAudioPackets(bytes).map((f) => ({
        trackId: 0,
        sizeBytes: f.size,
        ptsUs: f.ptsUs,
        durationUs: f.durationUs,
      }));
    default:
      throw new MediaError('demux-error', `golden-packets: unsupported container '${container}'`);
  }
}

function fromMp4Meta(p: PacketMetadata): GoldenPacketRow {
  return {
    trackId: p.trackId,
    sizeBytes: p.sizeBytes,
    ptsUs: p.ptsUs,
    durationUs: p.durationUs,
    keyframe: p.keyframe,
  };
}

function oneShot(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.enqueue(bytes);
      c.close();
    },
  });
}
