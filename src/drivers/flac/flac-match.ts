/** Registration-only FLAC identification kept independent of every parser/demux implementation. */

import type { ContainerQuery, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError } from '../../contracts/errors.ts';

const FLAC_MIMES = new Set(['audio/flac', 'audio/x-flac']);
const FLAC_EXTENSIONS = new Set(['flac']);

export function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] as number);
  return out;
}

/** Byte offset of the `fLaC` marker, skipping a (legal but rare) ID3v2 prefix. */
export function flacOffset(bytes: Uint8Array): number {
  if (bytes.byteLength >= 10 && ascii(bytes, 0, 3) === 'ID3') {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size =
      ((dv.getUint8(6) & 0x7f) << 21) |
      ((dv.getUint8(7) & 0x7f) << 14) |
      ((dv.getUint8(8) & 0x7f) << 7) |
      (dv.getUint8(9) & 0x7f);
    return 10 + size;
  }
  return 0;
}

export function matchesFlac(q: ContainerQuery): boolean {
  if (q.mime !== undefined && FLAC_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && FLAC_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  return head !== undefined && head.byteLength >= 4 && ascii(head, flacOffset(head), 4) === 'fLaC';
}

/** FLAC writes exactly one FLAC audio stream; this remains synchronous before parser selection. */
export function validateFlacMuxTrack(info: TrackInfo, trackCount: number): void {
  if (trackCount > 0) {
    throw new CapabilityError('the FLAC muxer writes a single audio stream', {
      op: { kind: 'route', id: 'mux' },
      tried: ['flac'],
    });
  }
  if (info.mediaType !== 'audio' || info.codec !== 'flac') {
    throw new CapabilityError(
      `FLAC container carries a single FLAC audio track, not ${info.mediaType}/${info.codec}`,
      { op: { kind: 'route', id: 'mux' }, tried: ['flac'] },
    );
  }
}
