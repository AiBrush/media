/** Cheap AVI container detection (mime / extension / RIFF….AVI magic) for pre-load routing. */

import type { ContainerQuery } from '../../contracts/driver.ts';

const AVI_MIMES = new Set(['video/avi', 'video/x-msvideo', 'video/msvideo', 'video/vnd.avi']);

/** True when the query names or carries an AVI source (`RIFF….AVI ` magic). */
export function matchesAvi(q: ContainerQuery): boolean {
  if (q.mime !== undefined && AVI_MIMES.has(q.mime)) return true;
  if (q.extension?.toLowerCase() === 'avi') return true;
  const head = q.head;
  return (
    head !== undefined &&
    head.byteLength >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x41 &&
    head[9] === 0x56 &&
    head[10] === 0x49 &&
    head[11] === 0x20
  );
}
