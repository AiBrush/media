/**
 * Pure geometry for the video filter drivers (doc 09 §filters, §convert) — the substrate-independent
 * math shared by the WebGPU and Canvas2D paths. These functions take only numbers (source dimensions +
 * a {@link FilterSpec}) and return the output dimensions plus a draw recipe, so they carry **no** browser
 * types and are unit-tested bit-exactly in Node (the GPU/canvas render itself is validated in-browser).
 *
 * Two draw recipes cover the four geometric ops:
 *
 * - {@link Blit} — a source sub-rectangle copied into a destination sub-rectangle (resize/crop). It maps
 *   directly to Canvas2D `drawImage(img, sx,sy,sw,sh, dx,dy,dw,dh)` and to a sampled quad on the GPU.
 * - {@link Affine} — a 2D affine placing the whole source image into the output (rotate/flip). It maps
 *   directly to Canvas2D `setTransform(a,b,c,d,e,f)` + `drawImage(img, 0, 0)` and to a vertex transform
 *   on the GPU. `setTransform` sends source point `(x, y)` to `(a·x + c·y + e, b·x + d·y + f)`.
 *
 * All output dimensions are integers ≥ 1; pixel rects use `Math.round`/`Math.floor` consistently so the
 * recipe is deterministic and reproducible across machines (ADR-007).
 */

import type { FilterSpec } from '../contracts/driver.ts';
import { InputError } from '../contracts/errors.ts';

/** A pixel rectangle (top-left origin, +x right, +y down). */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Output dimensions of a filter, always integers ≥ 1. */
export interface Dims {
  readonly width: number;
  readonly height: number;
}

/** A source-rect → destination-rect copy (resize/crop). The output is `dims`; uncovered area is bars. */
export interface Blit {
  readonly dims: Dims;
  readonly src: Rect;
  readonly dst: Rect;
}

/**
 * A 2D affine (Canvas2D `DOMMatrix` order `a,b,c,d,e,f`) that places the source image at `(0,0)` into the
 * output. Source `(x, y)` → `(a·x + c·y + e, b·x + d·y + f)`. Used for the lossless geometric ops
 * (rotate 90/180/270, flip) where there is no resampling — only re-orientation.
 */
export interface Affine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** An affine placement of the whole source image into an output of `dims`. */
export interface OrientedDraw {
  readonly dims: Dims;
  readonly transform: Affine;
}

/** Identity affine — source maps to itself unchanged. */
export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Apply an {@link Affine} to a point — the same mapping Canvas2D `setTransform` uses. Test helper + GPU math. */
export function applyAffine(t: Affine, x: number, y: number): readonly [number, number] {
  return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
}

/** Validate a dimension is a finite integer ≥ 1 (output frames must have real, non-degenerate size). */
function requirePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new InputError('unsupported-input', `${label} must be a positive integer, got ${value}`);
  }
  return value;
}

/** Validate source dimensions decoded from a `VideoFrame` (display size). */
function requireSourceDims(srcW: number, srcH: number): void {
  if (!Number.isInteger(srcW) || !Number.isInteger(srcH) || srcW < 1 || srcH < 1) {
    throw new InputError('unsupported-input', `invalid source dimensions ${srcW}×${srcH}`);
  }
}

// ============ resize ============

type ResizeSpec = Extract<FilterSpec, { type: 'resize' }>;

/**
 * Resize recipe. The output is always exactly `width × height`; `fit` decides how the source maps in:
 *
 * - `fill` (default): stretch the whole source over the whole output (aspect not preserved).
 * - `contain`: scale to fit inside, preserving aspect; centered, with transparent letterbox bars.
 * - `cover`: scale to cover, preserving aspect; the centered overflow is cropped from the source.
 */
export function resizeBlit(srcW: number, srcH: number, spec: ResizeSpec): Blit {
  requireSourceDims(srcW, srcH);
  const width = requirePositiveInt(spec.width, 'resize width');
  const height = requirePositiveInt(spec.height, 'resize height');
  const dims: Dims = { width, height };
  const fit = spec.fit ?? 'fill';
  const fullSrc: Rect = { x: 0, y: 0, width: srcW, height: srcH };

  if (fit === 'fill') {
    return { dims, src: fullSrc, dst: { x: 0, y: 0, width, height } };
  }

  if (fit === 'contain') {
    // Scale to fit inside the box; center the scaled image, leaving bars on the long axis.
    const scale = Math.min(width / srcW, height / srcH);
    const drawW = Math.max(1, Math.round(srcW * scale));
    const drawH = Math.max(1, Math.round(srcH * scale));
    const dx = Math.floor((width - drawW) / 2);
    const dy = Math.floor((height - drawH) / 2);
    return { dims, src: fullSrc, dst: { x: dx, y: dy, width: drawW, height: drawH } };
  }

  // cover: scale to cover the box; crop the centered overflow from the *source* so the output is full.
  const scale = Math.max(width / srcW, height / srcH);
  const cropW = Math.min(srcW, Math.max(1, Math.round(width / scale)));
  const cropH = Math.min(srcH, Math.max(1, Math.round(height / scale)));
  const sx = Math.floor((srcW - cropW) / 2);
  const sy = Math.floor((srcH - cropH) / 2);
  return {
    dims,
    src: { x: sx, y: sy, width: cropW, height: cropH },
    dst: { x: 0, y: 0, width, height },
  };
}

// ============ crop ============

type CropSpec = Extract<FilterSpec, { type: 'crop' }>;

/**
 * Crop recipe — copy the requested source sub-rectangle 1:1 into a same-size output. The rect must lie
 * fully inside the source and be non-degenerate; an out-of-bounds, non-integer, or empty rect is a typed
 * {@link InputError} (validated against the real source dims at the first frame, never a silent clamp).
 */
export function cropBlit(srcW: number, srcH: number, spec: CropSpec): Blit {
  requireSourceDims(srcW, srcH);
  const { x, y, width, height } = spec;
  if (![x, y, width, height].every((n) => Number.isInteger(n))) {
    throw new InputError(
      'unsupported-input',
      `crop rect must be integers, got ${x},${y} ${width}×${height}`,
    );
  }
  if (width < 1 || height < 1) {
    throw new InputError('unsupported-input', `crop size must be ≥ 1, got ${width}×${height}`);
  }
  if (x < 0 || y < 0 || x + width > srcW || y + height > srcH) {
    throw new InputError(
      'unsupported-input',
      `crop rect ${x},${y} ${width}×${height} is outside the ${srcW}×${srcH} source`,
    );
  }
  return {
    dims: { width, height },
    src: { x, y, width, height },
    dst: { x: 0, y: 0, width, height },
  };
}

// ============ rotate ============

type RotateSpec = Extract<FilterSpec, { type: 'rotate' }>;

/**
 * Rotation recipe (lossless, no resampling). 90°/270° swap width↔height; the affine re-orients the whole
 * source into the new output. Angles are clockwise, as in display-rotation metadata.
 */
export function rotateGeometry(
  srcW: number,
  srcH: number,
  degrees: RotateSpec['degrees'],
): OrientedDraw {
  requireSourceDims(srcW, srcH);
  switch (degrees) {
    case 0:
      return { dims: { width: srcW, height: srcH }, transform: IDENTITY };
    case 90:
      // CW 90°: (x,y) → (srcH − y, x); output is srcH × srcW.
      return {
        dims: { width: srcH, height: srcW },
        transform: { a: 0, b: 1, c: -1, d: 0, e: srcH, f: 0 },
      };
    case 180:
      // (x,y) → (srcW − x, srcH − y); output keeps the size.
      return {
        dims: { width: srcW, height: srcH },
        transform: { a: -1, b: 0, c: 0, d: -1, e: srcW, f: srcH },
      };
    case 270:
      // CW 270° (= CCW 90°): (x,y) → (y, srcW − x); output is srcH × srcW.
      return {
        dims: { width: srcH, height: srcW },
        transform: { a: 0, b: -1, c: 1, d: 0, e: 0, f: srcW },
      };
    /* v8 ignore next 2 -- unreachable: `degrees` is the literal union 0|90|180|270. */
    default:
      return assertNever(degrees);
  }
}

// ============ flip ============

type FlipSpec = Extract<FilterSpec, { type: 'flip' }>;

/**
 * Flip recipe (lossless). `h` mirrors across the vertical axis (left↔right); `v` mirrors across the
 * horizontal axis (top↔bottom). Dimensions are unchanged.
 */
export function flipGeometry(srcW: number, srcH: number, axis: FlipSpec['axis']): OrientedDraw {
  requireSourceDims(srcW, srcH);
  const dims: Dims = { width: srcW, height: srcH };
  if (axis === 'h') {
    // (x,y) → (srcW − x, y).
    return { dims, transform: { a: -1, b: 0, c: 0, d: 1, e: srcW, f: 0 } };
  }
  // (x,y) → (x, srcH − y).
  return { dims, transform: { a: 1, b: 0, c: 0, d: -1, e: 0, f: srcH } };
}

/** Exhaustiveness guard for discriminated unions — unreachable at runtime if the types are honored. */
function assertNever(value: never): never {
  /* v8 ignore next */
  throw new InputError('unsupported-input', `unhandled filter geometry case: ${String(value)}`);
}
