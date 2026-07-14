import type { ContainerQuery } from '../../contracts/driver.ts';

const MP4_MIMES = new Set(['video/mp4', 'video/quicktime', 'audio/mp4', 'audio/x-m4a']);
const MP4_EXTENSIONS = new Set(['mp4', 'mov', 'm4a', 'm4v', 'qt']);

/** Match the exact MIME, extension, or top-level ISO BMFF box signatures used by the full MP4 driver. */
export function matchesMp4(query: ContainerQuery): boolean {
  if (query.mime !== undefined && MP4_MIMES.has(query.mime)) return true;
  if (query.extension !== undefined && MP4_EXTENSIONS.has(query.extension.toLowerCase()))
    return true;
  const head = query.head;
  if (head !== undefined && head.byteLength >= 8) {
    const magic = String.fromCharCode(
      head[4] as number,
      head[5] as number,
      head[6] as number,
      head[7] as number,
    );
    if (magic === 'ftyp' || magic === 'styp' || magic === 'moov') return true;
  }
  return false;
}
