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
