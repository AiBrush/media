import type { ContainerQuery } from '../../contracts/driver.ts';

/** Match the exact MIME, extension, or EBML signature used by the full WebM/Matroska driver. */
export function matchesWebm(query: ContainerQuery): boolean {
  if (
    query.mime !== undefined &&
    (query.mime === 'video/webm' ||
      query.mime === 'audio/webm' ||
      query.mime === 'video/x-matroska')
  ) {
    return true;
  }
  if (
    query.extension !== undefined &&
    (query.extension === 'webm' || query.extension === 'mkv' || query.extension === 'mka')
  ) {
    return true;
  }
  const head = query.head;
  return (
    head !== undefined &&
    head.byteLength >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  );
}
