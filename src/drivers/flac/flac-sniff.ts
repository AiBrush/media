import type { ContainerQuery } from '../../contracts/driver.ts';

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
    const b6 = dv.getUint8(6);
    const b7 = dv.getUint8(7);
    const b8 = dv.getUint8(8);
    const b9 = dv.getUint8(9);
    const size = ((b6 & 0x7f) << 21) | ((b7 & 0x7f) << 14) | ((b8 & 0x7f) << 7) | (b9 & 0x7f);
    return 10 + size; // ID3v2 header (10) + synchsafe tag size
  }
  return 0;
}

export function matchesFlac(q: ContainerQuery): boolean {
  if (q.mime !== undefined && FLAC_MIMES.has(q.mime)) return true;
  if (q.extension !== undefined && FLAC_EXTENSIONS.has(q.extension.toLowerCase())) return true;
  const head = q.head;
  return head !== undefined && head.byteLength >= 4 && ascii(head, flacOffset(head), 4) === 'fLaC';
}
