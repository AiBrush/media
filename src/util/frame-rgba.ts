/**
 * `src/util/frame-rgba.ts` — the engine's single packed-RGBA readback for a decoded `VideoFrame`.
 *
 * `VideoFrame.copyTo({ format: 'RGBA' })` is the fast, canvas-free way to read a decoded picture, and
 * it is the route this module still prefers. The conversion is optional in the WebCodecs specification
 * ("if the combination is not supported, reject with NotSupportedError"), and browsers disagree today:
 *
 * | Runtime          | `copyTo` with `format: 'RGBA'` from a planar frame                              |
 * | ---------------- | ------------------------------------------------------------------------------- |
 * | Chromium, Gecko  | converts, and returns one packed plane whose stride is `width × 4`               |
 * | WebKit           | ignores `format`, resolves with the frame's NATIVE planar layout and plane bytes |
 *
 * WebKit's non-conversion is silent — the promise resolves and the destination receives Y/UV samples
 * that a caller reinterprets as RGBA — but it is not *dishonest*: the resolved `PlaneLayout[]` describes
 * the planar layout that was actually written. An explicit packed layout makes it throw `TypeError`
 * instead. Both signals are checked here, so a wrong picture can never reach a filter, an encoder, or a
 * quality measurement; the read is redone through Canvas2D, which is the platform's own colour-managed
 * YUV→RGB converter and is correct on every supported runtime.
 *
 * The non-converting verdict is remembered per `VideoFrame` realm so a WebKit run pays the failed copy
 * once rather than once per frame, and a frame whose native format is already packed RGB is copied in
 * that native format and channel-normalized here — that never depends on the conversion at all.
 */

import { CapabilityError, InputError } from '../contracts/errors.ts';

/** Bytes per pixel in every packed RGBA representation this module reads or writes. */
export const RGBA_BYTES_PER_PIXEL = 4;

/** The packed 8-bit RGB `VideoPixelFormat`s that need channel normalization rather than conversion. */
export type PackedRgbFormat = 'RGBA' | 'RGBX' | 'BGRA' | 'BGRX';

/** Narrow a frame's pixel format to a packed RGB format, or `undefined` for planar/unknown formats. */
export function packedRgbFormat(format: VideoPixelFormat | null): PackedRgbFormat | undefined {
  return format === 'RGBA' || format === 'RGBX' || format === 'BGRA' || format === 'BGRX'
    ? format
    : undefined;
}

/** Rewrite packed RGB bytes in place as straight RGBA: swap red/blue for BGR, force opaque for X. */
export function normalizePackedRgba(
  data: Uint8Array | Uint8ClampedArray,
  format: PackedRgbFormat,
): void {
  const swapRedBlue = format === 'BGRA' || format === 'BGRX';
  const opaque = format === 'RGBX' || format === 'BGRX';
  if (!swapRedBlue && !opaque) return;
  for (let offset = 0; offset < data.length; offset += RGBA_BYTES_PER_PIXEL) {
    if (swapRedBlue) {
      const red = data[offset] as number;
      data[offset] = data[offset + 2] as number;
      data[offset + 2] = red;
    }
    if (opaque) data[offset + 3] = 0xff;
  }
}

/**
 * Return the exact destination size for a tightly packed RGBA `VideoFrame.copyTo` layout.
 *
 * `allocationSize({ format: 'RGBA' })` is not usable for every valid decoded frame: a Chromium HDR frame
 * can expose a null source format even though `copyTo` can perform the requested conversion, and WebKit
 * answers with the frame's native planar size. Supplying the layout ourselves makes the destination size
 * deterministic and avoids that optional source-format query.
 */
export function rgbaCopyBufferSize(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new InputError(`RGBA copy dimensions must be positive integers (${width}×${height})`);
  }
  const size = width * height * RGBA_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(size)) {
    throw new InputError(`RGBA copy buffer size is not safely representable (${width}×${height})`);
  }
  return size;
}

/** A packed RGBA image and the geometry it was read at. */
export interface RgbaFrameImage {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Coded-space source rectangle, matching `VideoFrameCopyToOptions.rect`. */
export interface RgbaReadRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ReadFrameRgbaOptions {
  /** Coded-space rectangle to read; defaults to the frame's visible rectangle. */
  readonly rect?: RgbaReadRect;
  /** Request predefined-colour-space output, exactly as `VideoFrameCopyToOptions.colorSpace` does. */
  readonly colorSpace?: PredefinedColorSpace;
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/**
 * Realms whose `copyTo` was observed to ignore a requested RGBA conversion. Keyed by the realm's
 * `VideoFrame` constructor so a replaced global (another realm, or a test double) is judged on its own
 * behaviour instead of inheriting a neighbour's verdict.
 */
const nonConvertingRealms = new WeakSet<object>();

function realmKey(): object | undefined {
  const videoFrame = (globalThis as { VideoFrame?: unknown }).VideoFrame;
  return typeof videoFrame === 'function' ? (videoFrame as unknown as object) : undefined;
}

/**
 * True when a resolved `copyTo` really produced one packed RGBA plane. A runtime that ignored the
 * requested format resolves with its native planar layout, which fails this check on plane count or
 * stride. A runtime that reports no layout at all is trusted: the specification requires the sequence,
 * so an absent one carries no counter-evidence.
 */
function describesPackedRgba(layouts: unknown, width: number): boolean {
  if (!Array.isArray(layouts)) return true;
  if (layouts.length !== 1) return false;
  const plane = layouts[0] as { offset?: unknown; stride?: unknown } | undefined;
  if (plane === undefined) return false;
  const stride = plane.stride;
  return typeof stride === 'number' && stride >= width * RGBA_BYTES_PER_PIXEL;
}

/** A refusal to perform the requested conversion, as opposed to a genuine copy failure. */
function isConversionRefusal(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    (error.name === 'NotSupportedError' || error.name === 'TypeError')
  );
}

function visibleRectOf(frame: VideoFrame): RgbaReadRect {
  const visible = frame.visibleRect;
  if (visible !== null && visible !== undefined) {
    return { x: visible.x, y: visible.y, width: visible.width, height: visible.height };
  }
  return { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
}

function create2dContext(width: number, height: number): Canvas2D {
  if (typeof OffscreenCanvas !== 'undefined') {
    const context = new OffscreenCanvas(width, height).getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    }) as OffscreenCanvasRenderingContext2D | null;
    if (context !== null) return context;
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', {
      alpha: true,
      willReadFrequently: true,
    }) as CanvasRenderingContext2D | null;
    if (context !== null) return context;
  }
  throw new CapabilityError('packed RGBA frame readback requires a 2D canvas surface', {
    op: { kind: 'route', id: 'video-frame-rgba-read' },
    tried: ['video-frame-copy-to-rgba', 'canvas-2d-raster'],
    suggestion: 'run the operation in a realm that provides OffscreenCanvas or a DOM canvas',
  });
}

/**
 * Read the requested coded-space rectangle through the platform's presentation raster.
 *
 * A `VideoFrame` presents as its visible rectangle scaled to `displayWidth`×`displayHeight`, so the
 * coded-space rectangle is mapped into that presentation space before sampling. When the frame is
 * neither cropped nor display-scaled — the ordinary decoded case — the mapping is the identity.
 */
function drawFrameToRgba(
  frame: VideoFrame,
  destination: Uint8Array | Uint8ClampedArray,
  rect: RgbaReadRect,
): void {
  // The canvas is created for this read alone, so it already starts transparent black.
  const context = create2dContext(rect.width, rect.height);
  const visible = visibleRectOf(frame);
  const scaleX = visible.width > 0 ? (frame.displayWidth || visible.width) / visible.width : 1;
  const scaleY = visible.height > 0 ? (frame.displayHeight || visible.height) / visible.height : 1;
  context.drawImage(
    frame as unknown as CanvasImageSource,
    (rect.x - visible.x) * scaleX,
    (rect.y - visible.y) * scaleY,
    rect.width * scaleX,
    rect.height * scaleY,
    0,
    0,
    rect.width,
    rect.height,
  );
  destination.set(context.getImageData(0, 0, rect.width, rect.height).data);
}

/**
 * Fill `destination` with tightly packed RGBA samples for `rect` (default: the visible rectangle).
 *
 * `destination` must hold at least `width × height × 4` bytes; only that prefix is written, so callers
 * may pass an oversized pooled buffer.
 */
export async function copyFrameToRgba(
  frame: VideoFrame,
  destination: Uint8Array | Uint8ClampedArray,
  options?: ReadFrameRgbaOptions,
): Promise<void> {
  const rect = options?.rect ?? visibleRectOf(frame);
  const required = rgbaCopyBufferSize(rect.width, rect.height);
  if (destination.length < required) {
    throw new InputError(
      `RGBA destination holds ${destination.length} bytes, need ${required} for ${rect.width}×${rect.height}`,
    );
  }
  const view = destination.length === required ? destination : destination.subarray(0, required);
  const layout: PlaneLayout[] = [{ offset: 0, stride: rect.width * RGBA_BYTES_PER_PIXEL }];

  // Packed RGB frames carry the samples we want already: copying them in their native format and
  // normalizing the channel order here is exact everywhere and never asks for a conversion at all.
  const packed = packedRgbFormat(frame.format);
  if (packed !== undefined && packed !== 'RGBA') {
    await frame.copyTo(view, { rect, layout });
    normalizePackedRgba(view, packed);
    return;
  }

  const realm = realmKey();
  if (realm === undefined || !nonConvertingRealms.has(realm)) {
    try {
      const layouts = await frame.copyTo(view, {
        format: 'RGBA',
        ...(options?.colorSpace === undefined ? {} : { colorSpace: options.colorSpace }),
        rect,
        layout,
      });
      if (describesPackedRgba(layouts, rect.width)) return;
    } catch (error) {
      if (!isConversionRefusal(error)) throw error;
    }
    if (realm !== undefined) nonConvertingRealms.add(realm);
  }

  drawFrameToRgba(frame, view, rect);
}

/** Read `rect` (default: the visible rectangle) into a newly allocated packed RGBA image. */
export async function readFrameRgba(
  frame: VideoFrame,
  options?: ReadFrameRgbaOptions,
): Promise<RgbaFrameImage> {
  const rect = options?.rect ?? visibleRectOf(frame);
  const data = new Uint8ClampedArray(rgbaCopyBufferSize(rect.width, rect.height));
  await copyFrameToRgba(frame, data, options);
  return { data, width: rect.width, height: rect.height };
}
