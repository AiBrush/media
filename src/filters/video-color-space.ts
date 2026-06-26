/**
 * Shared `VideoColorSpace` mapping/tagging helpers for video filters.
 *
 * The color math itself lives in `gpu-uniforms.ts`; this small module owns the browser-facing color metadata
 * boundary so WebGPU/Canvas2D/CPU filters tag their output frames consistently. It intentionally returns a
 * DOM-shaped plain object instead of constructing browser classes, which keeps the helpers Node-testable.
 */

import type { ColorSpaceId, SourceColor, TransferId } from './gpu-uniforms.ts';
import { parseColorSpace } from './gpu-uniforms.ts';

/** A structural view of `VideoColorSpace` (only the fields the filters read). */
export interface VideoColorSpaceLike {
  readonly primaries: string | null;
  readonly transfer: string | null;
}

/** The default source colour interpretation when a frame carries no metadata: BT.709 SDR. */
export const DEFAULT_SOURCE_COLOR: SourceColor = { primaries: 'bt709', transfer: 'bt709' };

/** DOM-lib-independent RGB color-space metadata for an output `VideoFrame`. */
export interface RgbVideoColorSpaceInit {
  readonly primaries: 'bt709' | 'bt2020' | 'smpte170m';
  readonly transfer: 'bt709' | 'iec61966-2-1' | 'pq' | 'hlg' | 'linear';
  readonly matrix: 'rgb';
  readonly fullRange: true;
}

/** Map a WebCodecs `VideoColorSpace.transfer` token onto a `TransferId` (unknown -> BT.709 SDR). */
function mapTransfer(transfer: string | null): TransferId {
  switch (transfer) {
    case 'bt709':
    case 'smpte170m':
      return 'bt709';
    case 'iec61966-2-1':
      return 'srgb';
    case 'pq':
      return 'pq';
    case 'hlg':
      return 'hlg';
    case 'linear':
      return 'linear';
    default:
      return DEFAULT_SOURCE_COLOR.transfer;
  }
}

/** Map a WebCodecs `VideoColorSpace.primaries` token onto a `ColorSpaceId` (unknown -> BT.709). */
function mapPrimaries(primaries: string | null): ColorSpaceId {
  const parsed = primaries === null ? null : parseColorSpace(primaries);
  return parsed ?? DEFAULT_SOURCE_COLOR.primaries;
}

/** Map a frame's `VideoColorSpace` onto the source colour interpretation the filter plan needs. */
export function mapVideoColorSpace(cs: VideoColorSpaceLike | null | undefined): SourceColor {
  if (cs === null || cs === undefined) return DEFAULT_SOURCE_COLOR;
  return { primaries: mapPrimaries(cs.primaries), transfer: mapTransfer(cs.transfer) };
}

/** DOM/lib token for an output RGB frame's primaries. */
function primariesInitToken(primaries: ColorSpaceId): RgbVideoColorSpaceInit['primaries'] {
  if (primaries === 'bt2020') return 'bt2020';
  if (primaries === 'bt601') return 'smpte170m';
  return 'bt709';
}

/** DOM/lib token for an output RGB frame's transfer. */
function transferInitToken(transfer: TransferId): RgbVideoColorSpaceInit['transfer'] {
  if (transfer === 'srgb') return 'iec61966-2-1';
  return transfer;
}

/**
 * Build the `VideoColorSpaceInit`-shaped tag for a full-range RGB output frame.
 *
 * Geometry outputs preserve the mapped source primaries+transfer; colorspace/tonemap outputs pass the
 * planned target primaries+encode transfer. `matrix:'rgb'` is deliberate because filters emit RGB frames.
 */
export function sourceColorToVideoColorSpaceInit(source: SourceColor): RgbVideoColorSpaceInit {
  return {
    primaries: primariesInitToken(source.primaries),
    transfer: transferInitToken(source.transfer),
    matrix: 'rgb',
    fullRange: true,
  };
}
