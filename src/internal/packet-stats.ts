/** Constant-space packet evidence reduction shared by demuxers that already retain compact frame rows. */

import type { PacketMetadataStats } from '../contracts/driver.ts';

export interface PacketStatsRow {
  readonly size: number;
  readonly ptsUs: number;
  readonly dtsUs?: number;
  readonly durationUs?: number;
}

export function packetStatsFromRows(
  rows: Iterable<PacketStatsRow>,
): PacketMetadataStats | undefined {
  let packetCount = 0;
  let totalSizeBytes = 0;
  let decodeStartUs = Number.POSITIVE_INFINITY;
  let decodeEndUs = Number.NEGATIVE_INFINITY;
  let presentationStartUs = Number.POSITIVE_INFINITY;
  let presentationEndUs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const dtsUs = row.dtsUs ?? row.ptsUs;
    const durationUs = row.durationUs;
    if (
      !Number.isSafeInteger(row.size) ||
      row.size <= 0 ||
      !Number.isFinite(row.ptsUs) ||
      !Number.isFinite(dtsUs) ||
      durationUs === undefined ||
      !Number.isFinite(durationUs) ||
      durationUs <= 0
    ) {
      return undefined;
    }
    packetCount++;
    totalSizeBytes += row.size;
    if (!Number.isSafeInteger(totalSizeBytes)) return undefined;
    decodeStartUs = Math.min(decodeStartUs, dtsUs);
    decodeEndUs = Math.max(decodeEndUs, dtsUs + durationUs);
    presentationStartUs = Math.min(presentationStartUs, row.ptsUs);
    presentationEndUs = Math.max(presentationEndUs, row.ptsUs + durationUs);
  }
  return packetCount === 0
    ? undefined
    : {
        packetCount,
        totalSizeBytes,
        decodeStartUs,
        decodeEndUs,
        presentationStartUs,
        presentationEndUs,
      };
}
