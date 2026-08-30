/**
 * Zero-copy bytes/packets/frames ownership helpers (REQUIREMENTS §7.3, 1.1.4).
 * Every stage must avoid copying the full input and must use transferable
 * objects or shared memory where safe and measurably beneficial.
 *
 * `Uint8Array.subarray` is zero-copy (shared ArrayBuffer view, O(1)), while
 * `slice` copies. Workers transfer `ArrayBuffer` ownership via the transfer list
 * so the bytes cross the thread boundary without duplication.
 */

import { MediaError } from '../contracts/errors.ts';

export function zeroCopySubarray(bytes: Uint8Array, start: number, end: number): Uint8Array {
  if (start < 0 || end < start || end > bytes.byteLength) {
    throw new MediaError(
      'demux-error',
      `zeroCopySubarray: range [${start},${end}) out of [0,${bytes.byteLength})`,
    );
  }
  return bytes.subarray(start, end);
}

export function isZeroCopyView(view: Uint8Array, backing: Uint8Array): boolean {
  return view.buffer === backing.buffer;
}

export function transferableForBytes(bytes: Uint8Array): { buffer: ArrayBuffer; view: Uint8Array } {
  // Detach-safe: caller transfers `buffer`, `view` becomes neutered after postMessage.
  return { buffer: bytes.buffer as ArrayBuffer, view: bytes };
}
