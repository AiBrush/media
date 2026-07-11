/** Exact MPEG-TS family hints and magic shared by the concrete driver and its lazy default proxy. */

import type { ContainerQuery } from '../../contracts/driver.ts';
import { detectFraming } from './ts-framing.ts';

/** Canonical TS token first, followed by every public output alias. */
export const MPEG_TS_FORMATS = ['ts', 'm2ts', 'mts', 'mpegts'] as const;

const MPEG_TS_MIMES = new Set(['video/mp2t', 'video/mpeg', 'application/x-mpegts', 'audio/mp2t']);
const MPEG_TS_EXTENSIONS = new Set([...MPEG_TS_FORMATS, 'm2t']);

/** True for a public MPEG-TS alias or the established `.m2t` input spelling. */
export function isMpegTsExtension(value: string): boolean {
  return MPEG_TS_EXTENSIONS.has(value.toLowerCase());
}

/** Match MIME, filename extension, or a real 188/192/204-byte transport sync column. */
export function matchesMpegTs(query: ContainerQuery): boolean {
  if (query.mime !== undefined && MPEG_TS_MIMES.has(normalizeMime(query.mime))) return true;
  if (query.extension !== undefined && isMpegTsExtension(query.extension)) return true;
  return query.head !== undefined && detectFraming(query.head) !== undefined;
}

function normalizeMime(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}
