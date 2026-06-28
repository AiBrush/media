/**
 * CPU video filter driver (doc 09 §filters; ladder doc 04: WebGPU → Canvas2D → native CPU → WASM).
 * The cross-browser fallback that runs **every** video `FilterSpec` — resize, crop, rotate, flip, colorspace,
 * tonemap — without WebGPU or Canvas2D colour management, for engines (Firefox/Safari often lack WebGPU)
 * where the GPU drivers' `supports()` is false. It reads a frame's pixels with `VideoFrame.copyTo` into a
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
 * **Why the CPU path is *more* capable than Canvas2D for colour (ADR-038):** `copyTo` to `'RGBA'` yields
 * the frame's pixels in the frame's **own** colour space (the UA does only the YUV→RGB matrix, not display
 * tone-management), which is exactly the input the {@link ColorPlan} expects (decode the source transfer →
 * linear → gamut → tonemap → encode the target transfer). So the CPU driver can do a *genuine* colorspace
 * conversion to **any** target (including wide gamut) and a *genuine* HDR→SDR tonemap — unlike the Canvas2D
 * fallback, which can only passthrough-to-display. `supports()` is therefore honest about **all six** ops.
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
import {
  type Affine,
  type Blit,
  type Dims,
  type OrientedDraw,
  cropBlit,
  flipGeometry,
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
const RGBA = 4;

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
  if (det === 0) throw new InputError('unsupported-input', 'degenerate orientation transform');
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

/** Bilinear-sample the source at fractional `(sx, sy)`, clamping to the source edges (matches GPU linear). */
function sampleBilinear(
  view: DataView,
  src: RgbaImage,
  sx: number,
  sy: number,
): [number, number, number, number] {
  const clampX = (v: number): number => (v < 0 ? 0 : v > src.width - 1 ? src.width - 1 : v);
  const clampY = (v: number): number => (v < 0 ? 0 : v > src.height - 1 ? src.height - 1 : v);
  const fx = clampX(sx);
  const fy = clampY(sy);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = clampX(x0 + 1);
  const y1 = clampY(y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const p00 = getPixel(view, src.width, x0, y0);
  const p10 = getPixel(view, src.width, x1, y0);
  const p01 = getPixel(view, src.width, x0, y1);
  const p11 = getPixel(view, src.width, x1, y1);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  // Bilinear per channel: interpolate the top and bottom edges in x, then between them in y. Unrolled (a
  // computed channel index would widen to `| undefined` under noUncheckedIndexedAccess).
  const bilerp = (i: 0 | 1 | 2 | 3): number =>
    Math.round(lerp(lerp(p00[i], p10[i], tx), lerp(p01[i], p11[i], tx), ty));
  return [bilerp(0), bilerp(1), bilerp(2), bilerp(3)];
}

/**
 * Resize {@link Blit} (source rect scaled into the destination rect): bilinear-resample the source sub-rect
 * into the `dst` rect of a `blit.dims` output. Pixels outside `dst` (the `contain` letterbox) stay
 * transparent black — matching the GPU's cleared background and Canvas2D's `clearRect`.
 */
function resizeBlitToRgba(blit: Blit, src: RgbaImage): RgbaImage {
  const out = blankRgba(blit.dims);
  const view = viewOf(src);
  const sxScale = blit.src.width / blit.dst.width;
  const syScale = blit.src.height / blit.dst.height;
  for (let dy = 0; dy < blit.dst.height; dy++) {
    // Sample at destination-pixel centres mapped back into the source rect.
    const sy = blit.src.y + (dy + 0.5) * syScale - 0.5;
    for (let dx = 0; dx < blit.dst.width; dx++) {
      const sx = blit.src.x + (dx + 0.5) * sxScale - 0.5;
      const [r, g, b, a] = sampleBilinear(view, src, sx, sy);
      setPixel(out, blit.dst.x + dx, blit.dst.y + dy, r, g, b, a);
    }
  }
  return out;
}

/** A {@link Blit} is an exact copy when its source and destination rects are the same size (crop / 1:1). */
function isExactBlit(blit: Blit): boolean {
  return blit.src.width === blit.dst.width && blit.src.height === blit.dst.height;
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

/** The geometric video specs this driver handles (resize/crop/rotate/flip). */
type GeometricVideoSpec = Extract<
  FilterSpec,
  { mediaType: 'video'; type: 'resize' | 'crop' | 'rotate' | 'flip' }
>;

/** The colour video specs this driver handles (colorspace/tonemap). */
type ColorVideoSpec = Extract<FilterSpec, { mediaType: 'video'; type: 'colorspace' | 'tonemap' }>;

/** Any video spec the CPU driver handles (all six). */
type CpuVideoSpec = GeometricVideoSpec | ColorVideoSpec;

/** True for the four geometric video specs. */
function isGeometricVideoSpec(f: FilterSpec): f is GeometricVideoSpec {
  return (
    f.mediaType === 'video' &&
    (f.type === 'resize' || f.type === 'crop' || f.type === 'rotate' || f.type === 'flip')
  );
}

/** True for the two colour video specs. */
function isColorVideoSpec(f: FilterSpec): f is ColorVideoSpec {
  return f.mediaType === 'video' && (f.type === 'colorspace' || f.type === 'tonemap');
}

/** Any video spec the CPU driver handles (all six geometric + colour ops). */
function isCpuVideoSpec(f: FilterSpec): f is CpuVideoSpec {
  return isGeometricVideoSpec(f) || isColorVideoSpec(f);
}

/** Resolve a geometric spec + concrete source dims into a CPU geometry recipe (may throw `InputError`). */
export function planCpuGeometry(spec: GeometricVideoSpec, srcW: number, srcH: number): CpuGeometry {
  switch (spec.type) {
    case 'resize':
      return { kind: 'blit', blit: resizeBlit(srcW, srcH, spec) };
    case 'crop':
      return { kind: 'blit', blit: cropBlit(srcW, srcH, spec) };
    case 'rotate':
      return { kind: 'oriented', draw: rotateGeometry(srcW, srcH, spec.degrees) };
    case 'flip':
      return { kind: 'oriented', draw: flipGeometry(srcW, srcH, spec.axis) };
    /* v8 ignore next 2 -- unreachable default (the union is exhaustive). */
    default:
      return exhaustive(spec);
  }
}

/** Resolve a colour spec + the source colour interpretation into a {@link ColorPlan}. Pure/Node-tested. */
export function planCpuColor(spec: ColorVideoSpec, source: SourceColor): ColorPlan {
  if (spec.type === 'tonemap') return planTonemap(source);
  const dst = parseColorSpace(spec.to);
  if (dst === null) {
    throw new InputError('unsupported-input', `unknown colorspace target '${spec.to}'`);
  }
  return planColorspace(source, dst);
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

/** Cast through the lib.dom lag for BT.2020/PQ/HLG tokens; the runtime accepts the spec-defined values. */
function domColorSpace(init: RgbVideoColorSpaceInit): VideoColorSpaceInit {
  return init as VideoColorSpaceInit;
}

/** Read a frame's pixels into a tightly-packed RGBA {@link RgbaImage} (async — `copyTo` returns a Promise). */
async function frameToRgba(frame: VideoFrame): Promise<RgbaImage> {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  const layout: PlaneLayout[] = [{ offset: 0, stride: width * RGBA }];
  const size = frame.allocationSize({ format: 'RGBA', rect: { x: 0, y: 0, width, height } });
  const data = new Uint8ClampedArray(Math.max(size, width * height * RGBA));
  await frame.copyTo(data, { format: 'RGBA', rect: { x: 0, y: 0, width, height }, layout });
  return { data, width, height };
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
  if (isColorVideoSpec(spec)) {
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
 * The CPU video filter driver (`substrate:'native'`, ranked **below** WebGPU + Canvas2D). Handles **all six**
 * video ops on the CPU via `VideoFrame.copyTo` + the shared pure math, so filters work even without WebGPU
 * or Canvas2D colour management (the cross-browser fallback). `supports()` is honest: true for every video
 * geometric/colour spec when `VideoFrame` is present, false otherwise (e.g. Node) and for audio specs. The
 * router only reaches it on a GPU miss (substrate ranking), so it never steals work from the GPU drivers.
 */
export const cpuVideoFilterDriver: FilterDriver = {
  id: 'cpu-video-filter',
  apiVersion: DRIVER_API_VERSION,
  kind: 'filter',
  substrate: CPU_SUBSTRATE,
  supports(f: FilterSpec): boolean {
    return isCpuVideoSpec(f) && videoFrameRgbaAvailable();
  },
  createFilter(f: FilterSpec, o?: StageOptions): TransformStream<VideoFrame, VideoFrame> {
    if (!isCpuVideoSpec(f)) {
      throw new CapabilityError('capability-miss', `cpu filter does not handle ${f.type}`, {
        op: 'filter',
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
