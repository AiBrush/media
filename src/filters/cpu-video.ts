/**
 * CPU video filter driver (doc 09 §filters; ladder doc 04: WebGPU → Canvas2D → native CPU → WASM).
 * The cross-browser fallback for resize, crop, pad, rotate, flip, and colorspace when WebGPU or Canvas2D
 * colour management is unavailable. It reads a frame's pixels with `VideoFrame.copyTo` into a
 * tightly-packed RGBA buffer, applies the **same pure math** the GPU path uses — the geometry from
 * {@link ./geometry.ts} and the colour science (gamut matrices, transfer curves, Reinhard/Hable tonemap)
 * from {@link ./gpu-uniforms.ts} — per pixel on the CPU, and emits a new RGBA `VideoFrame`.
 *
 * One driver registers, ranked **below** the GPU substrates (the router tries WebGPU → Canvas2D first and
 * only reaches this on a miss):
 *
 * - {@link cpuVideoFilterDriver} (`substrate:'native'`) — a pure-CPU filter ranked under the GPU/canvas
 *   rungs and above the WASM tail. It is **pure TS**, not WASM: the byte-for-byte colour/geometry math is
 *   plain TypeScript, so it ships zero binary and is Node-validated.
 *
 * **Colour boundary (ADR-038):** the packed-RGBA read ({@link ../util/frame-rgba.ts}, which resolves the
 * runtime's real conversion capability) yields normalized sRGB
 * pixels. That is a sound input for conversion from sRGB to any requested output gamut, but it has already
 * discarded the source's native PQ/HLG representation. Applying a source-aware HDR transfer afterwards
 * would double-convert those display-space samples, so this driver deliberately declines `tonemap` until a
 * native HDR pixel representation is available. Chromium's colour-managed Canvas2D path remains the honest
 * HDR→SDR rung; elsewhere the router returns a typed capability miss instead of wrong pixels.
 *
 * **Frame lifetime (doc 06 §3):** each input `VideoFrame` is `close()`d **exactly once** — in a `finally`
 * after `copyTo` has fully read its pixels into our buffer (the output frame is built from that buffer, never
 * from the source) — and a brand-new RGBA output `VideoFrame` carries the source `timestamp`+`duration`. On
 * `cancel`/abort any in-flight frame is closed and no work is buffered across the boundary.
 *
 * The per-pixel transforms ({@link applyColorPlanToRgba}, {@link geometryToRgba}) are pure (operate on a
 * plain {@link RgbaImage}, no browser types) and Node-tested to **parity with the GPU math**; only the
 * `copyTo`/`VideoFrame` construction touches browser APIs and is feature-guarded + `/* v8 ignore *​/`-marked.
 */

import {
  DRIVER_API_VERSION,
  type DriverModule,
  type FilterDriver,
  type FilterSpec,
  type FilterSubstrate,
  type Registry,
  type StageOptions,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { RGBA_BYTES_PER_PIXEL, readFrameRgba } from '../util/frame-rgba.ts';
import {
  type Affine,
  type Blit,
  type Dims,
  type OrientedDraw,
  cropBlit,
  flipGeometry,
  padBlit,
  resizeBlit,
  rotateGeometry,
} from './geometry.ts';
import {
  type ColorPlan,
  type ColorSpaceId,
  type SourceColor,
  applyMat3,
  applyTonemap,
  eotf,
  oetf,
  parseColorSpace,
  planColorspace,
  planTonemap,
} from './gpu-uniforms.ts';
import { planResampleAxis, resampleRgbaRegion } from './resample.ts';
import {
  type RgbVideoColorSpaceInit,
  mapVideoColorSpace,
  sourceColorToVideoColorSpaceInit,
} from './video-color-space.ts';

export { type VideoColorSpaceLike, mapVideoColorSpace } from './video-color-space.ts';

// ============ pure image model + per-pixel transforms (Node-tested) ============

/** A tightly-packed RGBA8 image: `data.length === width * height * 4`, row-major, 4 bytes/pixel. */
export interface RgbaImage {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Bytes per RGBA pixel. */
const RGBA = RGBA_BYTES_PER_PIXEL;

/** Allocate a transparent-black RGBA image of the given dimensions. */
function blankRgba(dims: Dims): RgbaImage {
  return {
    data: new Uint8ClampedArray(dims.width * dims.height * RGBA),
    width: dims.width,
    height: dims.height,
  };
}

/** A `DataView` over an image's bytes — `getUint8` returns a plain `number` (no `?? 0` dead branches). */
function viewOf(img: RgbaImage): DataView {
  return new DataView(img.data.buffer, img.data.byteOffset, img.data.byteLength);
}

/** Read the four channels of pixel `(x, y)` (assumed in-bounds) via a {@link DataView}. */
function getPixel(
  view: DataView,
  width: number,
  x: number,
  y: number,
): [number, number, number, number] {
  // DataView reads centralize the buffer access and keep the per-pixel loops free of `?? 0` (pcm.ts pattern).
  const o = (y * width + x) * RGBA;
  return [view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3)];
}

/** Write the four channels of pixel `(x, y)` (assignment is unaffected by the index-access flag). */
function setPixel(
  img: RgbaImage,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const o = (y * img.width + x) * RGBA;
  img.data[o] = r;
  img.data[o + 1] = g;
  img.data[o + 2] = b;
  img.data[o + 3] = a;
}

// ---- colour (colorspace / tonemap): full-frame, dims unchanged ----

/** A channel triple in [0,1]. */
type Rgb = [number, number, number];

/** Clamp a scalar to [0,1]. */
function sat01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Apply a {@link ColorPlan} to one normalized RGB triple — the exact pipeline the colour shader runs per
 * pixel (ADR-032): decode-transfer (EOTF → linear) → 3×3 gamut matrix → optional tonemap (per channel,
 * clamped) → encode-transfer (OETF), each clamped to [0,1]. Pure; shared by the per-image apply and the
 * GPU-parity test.
 */
export function applyColorPlanRgb(plan: ColorPlan, rgb: Rgb): Rgb {
  const lin: Rgb = [
    eotf(plan.decode, rgb[0]),
    eotf(plan.decode, rgb[1]),
    eotf(plan.decode, rgb[2]),
  ];
  const conv = applyMat3(plan.gamut, lin);
  let mapped: Rgb = [conv[0], conv[1], conv[2]];
  if (plan.tonemap !== null) {
    const t = plan.tonemap;
    mapped = [applyTonemap(t, mapped[0]), applyTonemap(t, mapped[1]), applyTonemap(t, mapped[2])];
  }
  return [
    sat01(oetf(plan.encode, sat01(mapped[0]))),
    sat01(oetf(plan.encode, sat01(mapped[1]))),
    sat01(oetf(plan.encode, sat01(mapped[2]))),
  ];
}

/**
 * Apply a {@link ColorPlan} to a whole RGBA image (same dimensions), preserving alpha. Each pixel's RGB is
 * normalized to [0,1], run through {@link applyColorPlanRgb}, and written back as 8-bit. Pure/Node-tested.
 */
export function applyColorPlanToRgba(plan: ColorPlan, src: RgbaImage): RgbaImage {
  const out = blankRgba({ width: src.width, height: src.height });
  const view = viewOf(src);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const [r, g, b, a] = getPixel(view, src.width, x, y);
      const c = applyColorPlanRgb(plan, [r / 255, g / 255, b / 255]);
      setPixel(
        out,
        x,
        y,
        Math.round(c[0] * 255),
        Math.round(c[1] * 255),
        Math.round(c[2] * 255),
        a,
      );
    }
  }
  return out;
}

// ---- geometry (resize / crop / rotate / flip) ----

/** A 2×2-and-translation integer affine inverse, for the lossless oriented ops (rotate/flip). */
function invertAffine(t: Affine): Affine {
  // For [[a c][b d]] (Canvas order) with translation (e,f): inverse linear part / -inv·translation.
  const det = t.a * t.d - t.b * t.c;
  if (det === 0) throw new InputError('degenerate orientation transform');
  const ia = t.d / det;
  const ib = -t.b / det;
  const ic = -t.c / det;
  const id = t.a / det;
  // inverse translation: -(M^-1)·(e,f)
  const ie = -(ia * t.e + ic * t.f);
  const if_ = -(ib * t.e + id * t.f);
  return { a: ia, b: ib, c: ic, d: id, e: ie, f: if_ };
}

/**
 * Crop/exact-copy {@link Blit} (source and destination rects equal size, no scaling): copy the source
 * sub-rectangle 1:1 into the output — lossless, exact. The output is `blit.dims`.
 */
function exactBlitToRgba(blit: Blit, src: RgbaImage): RgbaImage {
  const out = blankRgba(blit.dims);
  const view = viewOf(src);
  for (let dy = 0; dy < blit.dst.height; dy++) {
    const sy = blit.src.y + dy;
    const oy = blit.dst.y + dy;
    for (let dx = 0; dx < blit.dst.width; dx++) {
      const [r, g, b, a] = getPixel(view, src.width, blit.src.x + dx, sy);
      setPixel(out, blit.dst.x + dx, oy, r, g, b, a);
    }
  }
  return out;
}

/**
 * Resize {@link Blit} (source rect scaled into the destination rect): band-limited resample of the source
 * sub-rect into the `dst` rect of a `blit.dims` output, via the shared {@link ./resample.ts} kernel — a
 * Catmull-Rom whose support widens with the reduction factor, so a >2:1 downscale integrates its whole
 * source footprint instead of point-sampling 2 of every N texels. Pixels outside `dst` (the `contain`
 * letterbox) stay transparent black. A fractional destination edge contributes its geometric coverage to
 * the adjacent pixel, matching the antialiased Canvas2D/WebGPU substrates instead of using a fractional
 * typed-array index.
 */
function resizeBlitToRgba(blit: Blit, src: RgbaImage): RgbaImage {
  const out = blankRgba(blit.dims);
  const startX = Math.max(0, Math.floor(blit.dst.x));
  const startY = Math.max(0, Math.floor(blit.dst.y));
  const endX = Math.min(out.width, Math.ceil(blit.dst.x + blit.dst.width));
  const endY = Math.min(out.height, Math.ceil(blit.dst.y + blit.dst.height));
  if (endX <= startX || endY <= startY) return out;

  // Plan over the FULL destination rect (so the sample grid does not shift when the rect is clipped by the
  // output bounds), then read back only the covered window.
  const axisX = planResampleAxis(src.width, Math.round(blit.dst.width), blit.src.x, blit.src.width);
  const axisY = planResampleAxis(
    src.height,
    Math.round(blit.dst.height),
    blit.src.y,
    blit.src.height,
  );
  const resampled = resampleRgbaRegion(src, axisX, axisY);

  const coverage = (pixel: number, start: number, end: number): number =>
    Math.max(0, Math.min(pixel + 1, end) - Math.max(pixel, start));
  for (let oy = startY; oy < endY; oy++) {
    const ry = Math.min(resampled.height - 1, Math.max(0, Math.round(oy - blit.dst.y)));
    const coverageY = coverage(oy, blit.dst.y, blit.dst.y + blit.dst.height);
    for (let ox = startX; ox < endX; ox++) {
      const rx = Math.min(resampled.width - 1, Math.max(0, Math.round(ox - blit.dst.x)));
      const o = (ry * resampled.width + rx) * RGBA;
      const alphaCoverage = coverageY * coverage(ox, blit.dst.x, blit.dst.x + blit.dst.width);
      // Uint8ClampedArray rounds and clamps on store, which is exactly what the kernel's negative lobes need.
      setPixel(
        out,
        ox,
        oy,
        resampled.data[o] ?? 0,
        resampled.data[o + 1] ?? 0,
        resampled.data[o + 2] ?? 0,
        (resampled.data[o + 3] ?? 0) * alphaCoverage,
      );
    }
  }
  return out;
}

/** A {@link Blit} is an exact copy when its source and destination rects are the same size (crop / 1:1). */
function isExactBlit(blit: Blit): boolean {
  return (
    blit.src.width === blit.dst.width &&
    blit.src.height === blit.dst.height &&
    Number.isSafeInteger(blit.dst.x) &&
    Number.isSafeInteger(blit.dst.y)
  );
}

/**
 * Oriented (rotate 90/180/270, flip) {@link OrientedDraw}: lossless re-orientation, no resampling. The
 * forward affine maps source→output; we invert it and, for each integer output pixel, copy the source pixel
 * it came from (the inverse of a ±1 integer affine lands exactly on integer source coords).
 */
function orientedToRgba(draw: OrientedDraw, src: RgbaImage): RgbaImage {
  const out = blankRgba(draw.dims);
  const view = viewOf(src);
  const inv = invertAffine(draw.transform);
  const clampX = (v: number): number => (v < 0 ? 0 : v > src.width - 1 ? src.width - 1 : v);
  const clampY = (v: number): number => (v < 0 ? 0 : v > src.height - 1 ? src.height - 1 : v);
  for (let oy = 0; oy < draw.dims.height; oy++) {
    for (let ox = 0; ox < draw.dims.width; ox++) {
      // Sample at the output pixel centre, map back to source, round to the nearest source texel. The
      // inverse of a ±1 integer affine lands exactly inside the source for the four supported orientations;
      // the clamp is a defensive guard (dead for valid orientations).
      const cx = ox + 0.5;
      const cy = oy + 0.5;
      const sx = clampX(Math.floor(inv.a * cx + inv.c * cy + inv.e));
      const sy = clampY(Math.floor(inv.b * cx + inv.d * cy + inv.f));
      const [r, g, b, a] = getPixel(view, src.width, sx, sy);
      setPixel(out, ox, oy, r, g, b, a);
    }
  }
  return out;
}

/** The CPU draw recipe: a blit (resize/crop) or an oriented affine (rotate/flip). */
export type CpuGeometry = { kind: 'blit'; blit: Blit } | { kind: 'oriented'; draw: OrientedDraw };

/** Apply a geometric recipe to an image (dispatch over blit-exact / blit-resize / oriented). Pure. */
export function geometryToRgba(recipe: CpuGeometry, src: RgbaImage): RgbaImage {
  if (recipe.kind === 'oriented') return orientedToRgba(recipe.draw, src);
  return isExactBlit(recipe.blit)
    ? exactBlitToRgba(recipe.blit, src)
    : resizeBlitToRgba(recipe.blit, src);
}

// ============ spec → plan resolution (pure; mirrors gpu-video, kept local) ============

/** The geometric video specs this driver handles (resize/crop/pad/rotate/flip). */
type GeometricVideoSpec = Extract<
  FilterSpec,
  { mediaType: 'video'; type: 'resize' | 'crop' | 'pad' | 'rotate' | 'flip' }
>;

/** All colour specs understood by the pure planning helpers. */
type ColorVideoSpec = Extract<FilterSpec, { mediaType: 'video'; type: 'colorspace' | 'tonemap' }>;

/** The one colour spec whose normalized-sRGB input contract the CPU renderer can satisfy. */
type CpuColorVideoSpec = Extract<FilterSpec, { mediaType: 'video'; type: 'colorspace' }>;

/** Any video spec the CPU driver can honestly render. */
type CpuVideoSpec = GeometricVideoSpec | CpuColorVideoSpec;

/** True for the five geometric video specs. */
function isGeometricVideoSpec(f: FilterSpec): f is GeometricVideoSpec {
  return (
    f.mediaType === 'video' &&
    (f.type === 'resize' ||
      f.type === 'crop' ||
      f.type === 'pad' ||
      f.type === 'rotate' ||
      f.type === 'flip')
  );
}

/** True for the normalized-sRGB colour conversion the CPU renderer can perform. */
function isCpuColorVideoSpec(f: FilterSpec): f is CpuColorVideoSpec {
  return f.mediaType === 'video' && f.type === 'colorspace';
}

/** True for every video spec the CPU driver can honestly render. */
function isCpuVideoSpec(f: FilterSpec): f is CpuVideoSpec {
  return isGeometricVideoSpec(f) || isCpuColorVideoSpec(f);
}

/** Resolve a geometric spec + concrete source dims into a CPU geometry recipe (may throw `InputError`). */
export function planCpuGeometry(spec: GeometricVideoSpec, srcW: number, srcH: number): CpuGeometry {
  switch (spec.type) {
    case 'resize':
      return { kind: 'blit', blit: resizeBlit(srcW, srcH, spec) };
    case 'crop':
      return { kind: 'blit', blit: cropBlit(srcW, srcH, spec) };
    case 'pad':
      return { kind: 'blit', blit: padBlit(srcW, srcH, spec) };
    case 'rotate':
      return { kind: 'oriented', draw: rotateGeometry(srcW, srcH, spec.degrees) };
    case 'flip':
      return { kind: 'oriented', draw: flipGeometry(srcW, srcH, spec.axis) };
    /* v8 ignore next 2 -- unreachable default (the union is exhaustive). */
    default:
      return exhaustive(spec);
  }
}

/**
 * Resolve a colour spec for the packed-RGBA representation consumed below. `VideoFrame.copyTo(RGBA)` is
 * explicitly requested in sRGB, so colorspace conversion starts from sRGB instead of re-applying the
 * decoded frame's original primaries/transfer. The tone-map branch remains a pure planning primitive for
 * parity tests, but the CPU driver does not route it because this representation is no longer native HDR.
 */
export function planCpuColor(spec: ColorVideoSpec, source: SourceColor): ColorPlan {
  if (spec.type === 'tonemap') return planTonemap(source);
  const dst = parseColorSpace(spec.to);
  if (dst === null) {
    throw new InputError(`unknown colorspace target '${spec.to}'`);
  }
  return planColorspace({ primaries: 'srgb', transfer: 'srgb' }, dst);
}

// ---- VideoColorSpace ↔ SourceColor / target tagging (pure plan side; render side is browser-only) ----

/** The output gamut a colour spec targets (for tagging the output frame's colour space). */
export function colorSpecTargetGamut(spec: ColorVideoSpec): ColorSpaceId {
  if (spec.type === 'tonemap') return 'bt709';
  return parseColorSpace(spec.to) ?? 'bt709';
}

// ============ browser-only render + stream wiring ============

/* v8 ignore start -- browser-only: everything below touches `VideoFrame`/`copyTo`/`navigator`-class APIs and
   is validated in the Playwright harness. The pure transforms above (applyColorPlanToRgba/geometryToRgba/
   plan resolution) are Node-tested to GPU parity; these glue functions are not mockable here. */

/** RGBA filtering is usable when `OffscreenCanvas`-independent `VideoFrame` (+ its `copyTo`) is present. */
function videoFrameRgbaAvailable(): boolean {
  return typeof VideoFrame !== 'undefined';
}

/** True when the CPU filter can read the source frames for a spec in this environment. */
export function cpuVideoFilterSupports(f: FilterSpec): boolean {
  return isCpuVideoSpec(f) && videoFrameRgbaAvailable();
}

/** Cast through the lib.dom lag for BT.2020/PQ/HLG tokens; the runtime accepts the spec-defined values. */
function domColorSpace(init: RgbVideoColorSpaceInit): VideoColorSpaceInit {
  return init as VideoColorSpaceInit;
}

/** Read a frame's pixels into a tightly-packed RGBA {@link RgbaImage} (async — the read is a copy). */
async function frameToRgba(frame: VideoFrame): Promise<RgbaImage> {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  return readFrameRgba(frame, {
    colorSpace: 'srgb',
    rect: { x: 0, y: 0, width, height },
  });
}

/** Build an RGBA output `VideoFrame` from a buffer, carrying timing (duration conditional) + colour space. */
function rgbaToFrame(
  img: RgbaImage,
  timestamp: number,
  duration: number | null,
  colorSpace: RgbVideoColorSpaceInit,
): VideoFrame {
  const base: VideoFrameBufferInit = {
    format: 'RGBA',
    codedWidth: img.width,
    codedHeight: img.height,
    timestamp,
    colorSpace: domColorSpace(colorSpace),
    layout: [{ offset: 0, stride: img.width * RGBA }],
  };
  const init: VideoFrameBufferInit = duration === null ? base : { ...base, duration };
  return new VideoFrame(img.data, init);
}

/** Apply one spec to one frame on the CPU, producing a new RGBA frame. Does **not** close the source. */
async function filterFrameCpu(spec: CpuVideoSpec, frame: VideoFrame): Promise<VideoFrame> {
  const src = await frameToRgba(frame);
  const timestamp = frame.timestamp;
  const duration = frame.duration;
  if (isCpuColorVideoSpec(spec)) {
    const plan = planCpuColor(spec, mapVideoColorSpace(frame.colorSpace));
    const out = applyColorPlanToRgba(plan, src);
    const target = colorSpecTargetGamut(spec);
    return rgbaToFrame(
      out,
      timestamp,
      duration,
      sourceColorToVideoColorSpaceInit({ primaries: target, transfer: plan.encode }),
    );
  }
  const recipe = planCpuGeometry(spec, src.width, src.height);
  const out = geometryToRgba(recipe, src);
  return rgbaToFrame(
    out,
    timestamp,
    duration,
    sourceColorToVideoColorSpaceInit(mapVideoColorSpace(frame.colorSpace)),
  );
}

/**
 * Build the `TransformStream<VideoFrame, VideoFrame>` for a CPU video filter spec. Each input frame is read
 * (`copyTo`), transformed, and `close()`d exactly once in a `finally`; cancellation rides the `AbortSignal`
 * listener (the `Transformer` has no `cancel` hook). `transform` is async (CPU `copyTo` is a Promise), but no
 * frame is buffered across stream calls — the source is consumed and closed within its own `transform`.
 */
function createCpuFilterStream(
  spec: CpuVideoSpec,
  opts: StageOptions | undefined,
): TransformStream<VideoFrame, VideoFrame> {
  let cancelled = false;
  const signal = opts?.signal;
  const onAbort = (): void => {
    cancelled = true;
  };
  if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

  return new TransformStream<VideoFrame, VideoFrame>({
    async transform(frame: VideoFrame, controller): Promise<void> {
      if (cancelled || signal?.aborted === true) {
        frame.close();
        throw new MediaError('aborted', 'filter cancelled');
      }
      try {
        const out = await filterFrameCpu(spec, frame);
        let handedOff = false;
        try {
          controller.enqueue(out);
          handedOff = true;
        } finally {
          if (!handedOff) out.close();
        }
      } finally {
        // `copyTo` fully read the source into our buffer before the await resolved; release it exactly once.
        frame.close();
      }
    },
    flush(): void {
      signal?.removeEventListener('abort', onAbort);
    },
  });
}

/* v8 ignore stop */

// ============ driver ============

/** Exhaustiveness guard for the geometric spec union (unreachable at runtime). */
/* v8 ignore start -- unreachable exhaustiveness guard (a `never` parameter). */
function exhaustive(value: never): never {
  throw new MediaError('encode-error', `unhandled CPU filter spec: ${String(value)}`);
}
/* v8 ignore stop */

/** The pure-TS CPU substrate, ranked below GPU/canvas rungs and above the WASM tail. */
const CPU_SUBSTRATE: FilterSubstrate = 'native';

/**
 * The CPU video filter driver (`substrate:'native'`, ranked **below** WebGPU + Canvas2D). Handles geometry
 * and colorspace conversion via normalized-sRGB `VideoFrame.copyTo` plus shared pure math. It intentionally
 * declines HDR tone-map because that read boundary cannot expose the native PQ/HLG samples its plan needs.
 * The router only reaches this driver on a GPU miss, and receives a typed capability miss if no honest HDR
 * substrate exists.
 */
export const cpuVideoFilterDriver: FilterDriver = {
  id: 'cpu-video-filter',
  apiVersion: DRIVER_API_VERSION,
  kind: 'filter',
  substrate: CPU_SUBSTRATE,
  supports(f: FilterSpec): boolean {
    return cpuVideoFilterSupports(f);
  },
  createFilter(f: FilterSpec, o?: StageOptions): TransformStream<VideoFrame, VideoFrame> {
    if (!isCpuVideoSpec(f)) {
      throw new CapabilityError(`cpu filter does not handle ${f.type}`, {
        op: { kind: 'route', id: 'filter' },
        tried: [cpuVideoFilterDriver.id],
      });
    }
    return createCpuFilterStream(f, o);
  },
};

/**
 * Driver module registering the CPU video filter fallback. The router ranks substrates WebGPU → Canvas2D →
 * (this) native → WASM, so a WebGPU/Canvas2D-capable browser uses the GPU path and others fall back to the
 * CPU — no caller choice (doc 04, ADR-003/038).
 */
export const CpuVideoFilterModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addFilter(cpuVideoFilterDriver);
  },
};

export default CpuVideoFilterModule;
