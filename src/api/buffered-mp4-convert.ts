import type { PacketMetadata, PacketMetadataStats } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import {
  MP4_PROJECTED_CONTAINER_HEADROOM_BYTES,
  SAFE_SINGLE_ARRAY_BUFFER_BYTES,
} from '../internal/buffer-policy.ts';

/**
 * The payload portion of a finite MP4/MOV output must leave room for ISO BMFF tables and framing inside
 * the product's conservative single-`ArrayBuffer` planning ceiling.
 */
export const BUFFERED_MP4_CONVERT_MAX_PROJECTED_PAYLOAD_BYTES =
  SAFE_SINGLE_ARRAY_BUFFER_BYTES - MP4_PROJECTED_CONTAINER_HEADROOM_BYTES;

/** Exact first-party driver ids whose ordinary MP4/MOV mux route buffers into one output array. */
export function isBuiltInBufferedMp4MuxDriverId(driverId: string): boolean {
  return driverId === 'mp4' || driverId === 'mp4-mux';
}

/** Project known encoded bitrates over a finite presentation duration, including container headroom. */
export function projectedBufferedMp4OutputBytes(
  durationSec: number | undefined,
  plannedBitratesBps: readonly number[],
): number | undefined {
  if (durationSec === undefined || !Number.isFinite(durationSec) || durationSec <= 0) {
    return undefined;
  }
  let totalBitrateBps = 0;
  for (const bitrate of plannedBitratesBps) {
    if (!Number.isFinite(bitrate) || bitrate <= 0) continue;
    totalBitrateBps += bitrate;
    if (!Number.isFinite(totalBitrateBps)) return Number.POSITIVE_INFINITY;
  }
  if (totalBitrateBps <= 0) return undefined;
  const payloadBytes = Math.ceil((durationSec * totalBitrateBps) / 8);
  const projectedOutputBytes = payloadBytes + MP4_PROJECTED_CONTAINER_HEADROOM_BYTES;
  return Number.isSafeInteger(projectedOutputBytes)
    ? projectedOutputBytes
    : Number.POSITIVE_INFINITY;
}

/**
 * Derive the selected program's presentation span from complete packet metadata. Container duration can
 * be an absolute timeline endpoint (notably Matroska with a large non-zero timestamp origin); using it as
 * elapsed work can reject a few seconds of real media as a multi-day buffered output. Require at least one
 * valid packet for every selected track, then measure the global `[minimum PTS, maximum PTS+duration)` span
 * so genuine inter-track offsets are retained while a common origin shift cancels out.
 */
export function packetTablePresentationSpanSec(
  table: readonly PacketMetadata[] | undefined,
  selectedTrackIds: readonly number[],
): number | undefined {
  if (table === undefined || selectedTrackIds.length === 0) return undefined;
  const selected = new Set(selectedTrackIds);
  const seen = new Set<number>();
  let firstPtsUs = Number.POSITIVE_INFINITY;
  let lastEndUs = Number.NEGATIVE_INFINITY;
  for (const packet of table) {
    if (
      !selected.has(packet.trackId) ||
      !Number.isFinite(packet.ptsUs) ||
      !Number.isFinite(packet.durationUs) ||
      packet.durationUs <= 0
    ) {
      continue;
    }
    const endUs = packet.ptsUs + packet.durationUs;
    if (!Number.isFinite(endUs)) continue;
    seen.add(packet.trackId);
    firstPtsUs = Math.min(firstPtsUs, packet.ptsUs);
    lastEndUs = Math.max(lastEndUs, endUs);
  }
  if (seen.size !== selected.size) return undefined;
  const spanSec = (lastEndUs - firstPtsUs) / 1_000_000;
  return Number.isFinite(spanSec) && spanSec > 0 ? spanSec : undefined;
}

/** Combine constant-sized per-track summaries into the selected program's presentation span. */
export function packetStatsPresentationSpanSec(
  stats: readonly (PacketMetadataStats | undefined)[],
): number | undefined {
  if (stats.length === 0 || stats.some((entry) => entry === undefined)) return undefined;
  let firstPtsUs = Number.POSITIVE_INFINITY;
  let lastEndUs = Number.NEGATIVE_INFINITY;
  for (const entry of stats) {
    if (
      entry === undefined ||
      entry.packetCount <= 0 ||
      !Number.isFinite(entry.presentationStartUs) ||
      !Number.isFinite(entry.presentationEndUs)
    ) {
      return undefined;
    }
    firstPtsUs = Math.min(firstPtsUs, entry.presentationStartUs);
    lastEndUs = Math.max(lastEndUs, entry.presentationEndUs);
  }
  const spanSec = (lastEndUs - firstPtsUs) / 1_000_000;
  return Number.isFinite(spanSec) && spanSec > 0 ? spanSec : undefined;
}

/**
 * Fail a known-impossible buffer-all MP4/MOV conversion before any decoder or encoder packet stream is
 * pulled. Unknown duration/rate evidence is left to the muxer's authoritative retained-byte guard.
 */
export function assertBufferedMp4ConvertProjection(
  target: 'mp4' | 'mov',
  outputDriverId: string,
  durationSec: number | undefined,
  plannedBitratesBps: readonly number[],
): void {
  const projectedOutputBytes = projectedBufferedMp4OutputBytes(durationSec, plannedBitratesBps);
  if (
    projectedOutputBytes === undefined ||
    projectedOutputBytes <= SAFE_SINGLE_ARRAY_BUFFER_BYTES
  ) {
    return;
  }
  const summedPlannedBitrateBps = plannedBitratesBps.reduce(
    (sum, bitrate) => (Number.isFinite(bitrate) && bitrate > 0 ? sum + bitrate : sum),
    0,
  );
  throw new CapabilityError(
    `buffered ${target.toUpperCase()} convert projection exceeds the safe single-ArrayBuffer limit`,
    {
      op: {
        kind: 'route',
        id: 'buffered-mp4-convert-projection',
        facts: {
          container: target,
          durationSec,
          plannedBitrateBps: Number.isFinite(summedPlannedBitrateBps)
            ? summedPlannedBitrateBps
            : undefined,
          projectedOutputBytes: Number.isFinite(projectedOutputBytes)
            ? projectedOutputBytes
            : undefined,
          projectionOverflow: !Number.isFinite(projectedOutputBytes),
          maximumProjectedOutputBytes: SAFE_SINGLE_ARRAY_BUFFER_BYTES,
          containerHeadroomBytes: MP4_PROJECTED_CONTAINER_HEADROOM_BYTES,
        },
      },
      tried: [outputDriverId],
      suggestion: 'lower the duration or bitrate, or route to an incremental MP4 muxer',
    },
  );
}
