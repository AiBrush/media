/**
 * Video filter drivers (doc 09 §filters, ladder doc 04: WebGPU → Canvas2D → native CPU → WASM). Implements the
 * four geometric `FilterSpec` ops — `resize`, `crop`, `rotate`, `flip` — on the best available pixel
 * substrate, each as a `TransformStream<VideoFrame, VideoFrame>` per the {@link FilterDriver} contract.
 *
 * Two drivers register (the router ranks them WebGPU-first by substrate, falling back on a miss):
 *
 * - {@link webgpuVideoFilterDriver} (`substrate:'webgpu'`) — `importExternalTexture(frame)` → a sampled
 *   full-screen quad → render to an `OffscreenCanvas` of the target size → a new `VideoFrame`. Device,
 *   pipeline, and sampler are created once per filter instance (stream `start`), reused per frame, and
 *   released on `flush`/`cancel`. WebGL is intentionally skipped: Canvas2D `drawImage` is itself
 *   GPU-accelerated and exact for every geometric op, so it is the single, simpler fallback.
 * - {@link canvas2dVideoFilterDriver} (`substrate:'canvas2d'`) — an `OffscreenCanvas` 2D context with the
 *   op's transform (`setTransform`/`drawImage`).
 *
 * **Frame lifetime (doc 06 §3, the build's hardest invariant):** each input `VideoFrame` is `close()`d
 * **exactly once** — synchronously in a `finally` right after it is consumed by the draw — and a brand-new
 * output `VideoFrame` is constructed from the rendered canvas, carrying the source `timestamp`+`duration`.
 * The draw fully consumes the source pixels before the `transform` returns, so no input frame is ever
 * buffered across an `await`; on `cancel`/error any in-flight frame is closed and GPU resources released.
 *
 * The geometry math lives in {@link ./geometry.ts} (pure, Node-unit-tested). The browser render paths
 * here cannot run under Node — every branch touching `navigator.gpu`/`GPUDevice`/`OffscreenCanvas`/
 * `VideoFrame` is feature-guarded and `/* v8 ignore *​/`-marked; they are validated in the browser harness.
 */

import {
  DRIVER_API_VERSION,
  type DriverModule,
  type FilterDriver,
  type FilterSpec,
  type Registry,
  type StageOptions,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import {
  type Blit,
  type Dims,
  type OrientedDraw,
  cropBlit,
  flipGeometry,
  resizeBlit,
  rotateGeometry,
} from './geometry.ts';
import {
  COLOR_UNIFORM_BYTES,
  type ColorPlan,
  type SourceColor,
  UNIFORM_BYTES,
  isDisplayColorSpace,
  packColorUniforms,
  packUniforms,
  parseColorSpace,
  planColorspace,
  planTonemap,
  uniformsForRecipe,
} from './gpu-uniforms.ts';
import { mapVideoColorSpace } from './video-color-space.ts';

export { type VideoColorSpaceLike, mapVideoColorSpace } from './video-color-space.ts';

/** The geometric video specs handled by the single quad pipeline (resize/crop/rotate/flip). */
type GeometricVideoSpec = Extract<
  FilterSpec,
  { mediaType: 'video'; type: 'resize' | 'crop' | 'rotate' | 'flip' }
>;

/** The colour video specs handled by the second (colour) pipeline (colorspace/tonemap) — ADR-032. */
type ColorVideoSpec = Extract<FilterSpec, { mediaType: 'video'; type: 'colorspace' | 'tonemap' }>;

/** True for the four geometric video filter specs (single quad pipeline). */
function isGeometricVideoSpec(f: FilterSpec): f is GeometricVideoSpec {
  return (
    f.mediaType === 'video' &&
    (f.type === 'resize' || f.type === 'crop' || f.type === 'rotate' || f.type === 'flip')
  );
}

/** True for the two colour video filter specs (colour pipeline). */
function isColorVideoSpec(f: FilterSpec): f is ColorVideoSpec {
  return f.mediaType === 'video' && (f.type === 'colorspace' || f.type === 'tonemap');
}

/**
 * Whether a *Canvas2D* substrate can honestly perform a colour spec. Canvas2D `drawImage(VideoFrame)`
 * yields UA-colour-managed pixels in the display space, so it can correctly satisfy a `colorspace`
 * conversion **to the display gamut** (srgb/bt709) — a passthrough — but it cannot produce a wider gamut
 * (709→2020) nor tonemap HDR (it clamps). Those decline here so the router falls through (ADR-032).
 */
function canvas2dCanColor(f: ColorVideoSpec): boolean {
  if (f.type === 'tonemap') return false;
  const dst = parseColorSpace(f.to);
  return dst !== null && isDisplayColorSpace(dst);
}

// ============ capability detection (cheap, honest; no heavy work) ============

/** WebGPU is usable here when a `navigator.gpu` exists alongside `OffscreenCanvas` and `VideoFrame`. */
function webgpuAvailable(): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/\bFirefox\//.test(ua)) return false;
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { gpu?: unknown }).gpu !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof VideoFrame !== 'undefined'
  );
}

/** Canvas2D rendering is usable when `OffscreenCanvas` and `VideoFrame` are present. */
function canvas2dAvailable(): boolean {
  return typeof OffscreenCanvas !== 'undefined' && typeof VideoFrame !== 'undefined';
}

// ============ per-frame draw recipe (substrate-independent) ============

/**
 * The per-frame draw plan, substrate-independent: a `Blit` (resize/crop) or oriented affine (rotate/flip)
 * on the geometric quad pipeline, or a full-frame `ColorPlan` (colorspace/tonemap) on the colour pipeline.
 * Colour ops keep the source dimensions (`dims`) — they recolour, they do not resize.
 */
export type DrawRecipe =
  | { kind: 'blit'; blit: Blit }
  | { kind: 'oriented'; draw: OrientedDraw }
  | { kind: 'color'; plan: ColorPlan; dims: Dims };

/** Resolve a *geometric* spec + concrete source dimensions into a draw recipe (may throw `InputError`). */
export function planDraw(spec: GeometricVideoSpec, srcW: number, srcH: number): DrawRecipe {
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

/** Resolve a *colour* spec + the source colour interpretation into a {@link ColorPlan}. Pure/Node-tested. */
export function planColor(spec: ColorVideoSpec, source: SourceColor): ColorPlan {
  if (spec.type === 'tonemap') return planTonemap(source);
  const dst = parseColorSpace(spec.to);
  if (dst === null) {
    throw new InputError('unsupported-input', `unknown colorspace target '${spec.to}'`);
  }
  return planColorspace(source, dst);
}

/* v8 ignore start -- render-path helpers: only the browser-only renderers call these (they touch
   `VideoFrame`); the geometry they read is unit-tested above via planDraw/resizeBlit/etc. */
/** The output dimensions of a recipe (the canvas/output `VideoFrame` size). */
function recipeDims(recipe: DrawRecipe): Dims {
  if (recipe.kind === 'blit') return recipe.blit.dims;
  if (recipe.kind === 'oriented') return recipe.draw.dims;
  return recipe.dims;
}

/** Build a `VideoFrameInit` carrying the source frame's timing (duration only when present, ADR-011/strict). */
function framedInit(source: VideoFrame): VideoFrameInit {
  const base: VideoFrameInit = { timestamp: source.timestamp };
  return source.duration === null ? base : { ...base, duration: source.duration };
}
/* v8 ignore stop */

// ============ renderer abstraction ============

/**
 * A live, per-filter-instance renderer. Created once when the stream starts (acquiring the GPU device or
 * the 2D context), it draws one source `VideoFrame` into a target-sized canvas per call and is released
 * when the stream finishes or is cancelled. `render` does **not** close the source frame — the
 * `TransformStream` owns close-once discipline.
 */
interface Renderer {
  /** Draw `source` per `recipe` and return a new `VideoFrame` carrying `source`'s timing. */
  render(source: VideoFrame, recipe: DrawRecipe): VideoFrame;
  /** Release the device/context/canvas. Idempotent. */
  dispose(): void;
}

/* v8 ignore start -- browser-only render paths; validated in the Playwright/browser harness. */

/** A reusable `OffscreenCanvas` resized in place to each output's dimensions. */
function ensureCanvas(canvas: OffscreenCanvas | undefined, dims: Dims): OffscreenCanvas {
  if (canvas && canvas.width === dims.width && canvas.height === dims.height) return canvas;
  const next = canvas ?? new OffscreenCanvas(dims.width, dims.height);
  next.width = dims.width;
  next.height = dims.height;
  return next;
}

// ---- Canvas2D ----

/**
 * Canvas2D renderer: `drawImage` with the op's source/destination rects or affine transform. Colour ops
 * are a full-frame 1:1 passthrough — the driver only routes a colorspace conversion *to the display space*
 * here (ADR-032/`canvas2dCanColor`), and Canvas2D `drawImage(VideoFrame)` already yields UA-colour-managed
 * display pixels, so the passthrough is the correct result (tonemap/wide-gamut are declined upstream).
 */
class Canvas2DRenderer implements Renderer {
  private canvas: OffscreenCanvas | undefined;

  render(source: VideoFrame, recipe: DrawRecipe): VideoFrame {
    const dims = recipeDims(recipe);
    this.canvas = ensureCanvas(this.canvas, dims);
    const ctx = this.canvas.getContext('2d', { alpha: true });
    if (ctx === null) {
      throw new MediaError('encode-error', 'OffscreenCanvas 2D context unavailable');
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, dims.width, dims.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (recipe.kind === 'blit') {
      const { src, dst } = recipe.blit;
      ctx.drawImage(
        source,
        src.x,
        src.y,
        src.width,
        src.height,
        dst.x,
        dst.y,
        dst.width,
        dst.height,
      );
    } else if (recipe.kind === 'oriented') {
      const t = recipe.draw.transform;
      ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
      ctx.drawImage(source, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      // Colour op → display-space passthrough (the UA already colour-managed the frame to display).
      ctx.drawImage(source, 0, 0);
    }
    return new VideoFrame(this.canvas, framedInit(source));
  }

  dispose(): void {
    this.canvas = undefined;
  }
}

// ---- WebGPU ----

/**
 * WGSL for a textured full-screen quad. The vertex stage emits a triangle-strip quad in clip space and a
 * source-space position; the fragment stage samples the external texture at the recipe-derived UV. Geometry
 * (which source texels land where) is encoded entirely in the per-frame `Uniforms`, so one pipeline serves
 * every op: `uvScale`/`uvOffset` select the source sub-rect (resize-cover/crop), and `rot`+`flip` re-orient.
 */
const WGSL = /* wgsl */ `
struct Uniforms {
  // Destination placement in the output, top-left/[0,1] convention: the unit quad maps to
  // [posOffset, posOffset + posScale]. A full-output op uses scale (1,1) offset (0,0); resize-'contain'
  // shrinks it so the cleared background forms the letterbox bars.
  posScale : vec2<f32>,
  posOffset : vec2<f32>,
  // Source sub-rect in UV space (resize-'cover'/crop select less than the whole texture).
  uvScale : vec2<f32>,
  uvOffset : vec2<f32>,
  // 2x2 orientation (rows rot0,rot1) applied around the (0.5,0.5) UV centre — rotate/flip.
  rot0 : vec2<f32>,
  rot1 : vec2<f32>,
};
@group(0) @binding(0) var<uniform> u : Uniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var tex : texture_external;

struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) i : u32) -> VSOut {
  // Unit quad as a triangle strip, q.y = 0 at the top (matches the UV/top-left convention).
  var q = array<vec2<f32>, 4>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0));
  let p = u.posOffset + q[i] * u.posScale;        // dest position in [0,1], top-left origin
  // Map [0,1] top-left → NDC (x right, y up): flip y so q.y=0 lands at the top of the output.
  let ndc = vec2<f32>(2.0 * p.x - 1.0, 1.0 - 2.0 * p.y);
  var o : VSOut;
  o.pos = vec4<f32>(ndc, 0.0, 1.0);
  o.uv = q[i];
  return o;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  // Re-orient around the centre, then map into the selected source sub-rect.
  let centred = in.uv - vec2<f32>(0.5, 0.5);
  let oriented = vec2<f32>(
    u.rot0.x * centred.x + u.rot1.x * centred.y,
    u.rot0.y * centred.x + u.rot1.y * centred.y) + vec2<f32>(0.5, 0.5);
  let srcUv = oriented * u.uvScale + u.uvOffset;
  return textureSampleBaseClampToEdge(tex, samp, srcUv);
}
`;

/**
 * WGSL for the **colour** pipeline (ADR-032): a full-frame quad that samples the external texture and
 * applies, per pixel, *decode-transfer (EOTF → linear) → 3×3 gamut matrix → optional tonemap → encode-
 * transfer (OETF)*. The transfer curves and gamut matrix mirror the pure TS math in {@link ./gpu-uniforms.ts}
 * exactly (same constants), so the Node-validated plan and the GPU render agree. Alpha is passed through.
 *
 * `params = vec4(decodeTag, encodeTag, tonemapTag, peak)` and `gamut` is a column-major `mat3x3`, matching
 * {@link packColorUniforms}. Transfer tags: 0 linear · 1 sRGB · 2 BT.709/2020 · 3 PQ · 4 HLG. HDR EOTFs
 * return SDR-white-relative linear light (PQ peak 100, HLG peak 12), so the tonemap operator's `peak`
 * parameter maps the real source peak to 1.0 (black stays at 0).
 */
const COLOR_WGSL = /* wgsl */ `
struct ColorUniforms {
  gamut : mat3x3<f32>,
  params : vec4<f32>,   // (decodeTag, encodeTag, tonemapTag, peak)
};
@group(0) @binding(0) var<uniform> u : ColorUniforms;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var tex : texture_external;

struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) i : u32) -> VSOut {
  var q = array<vec2<f32>, 4>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0));
  let ndc = vec2<f32>(2.0 * q[i].x - 1.0, 1.0 - 2.0 * q[i].y);
  var o : VSOut;
  o.pos = vec4<f32>(ndc, 0.0, 1.0);
  o.uv = q[i];
  return o;
}

// ---- transfer functions (mirror gpu-uniforms.ts eotf/oetf) ----
const BT709_A : f32 = 1.09929682680944;
const BT709_B : f32 = 0.018053968510807;
const PQ_M1 : f32 = 0.1593017578125;          // 2610/16384
const PQ_M2 : f32 = 78.84375;                 // 2523/4096*128
const PQ_C1 : f32 = 0.8359375;                // 3424/4096
const PQ_C2 : f32 = 18.8515625;               // 2413/4096*32
const PQ_C3 : f32 = 18.6875;                  // 2392/4096*32
const PQ_PEAK_WHITE : f32 = 100.0;
const HLG_PEAK_WHITE : f32 = 12.0;
const HLG_A : f32 = 0.17883277;
const HLG_B : f32 = 0.28466892;               // 1 - 4a
const HLG_C : f32 = 0.55991073;               // 0.5 - a*ln(4a)

fn eotf_ch(id : f32, x : f32) -> f32 {
  if (id < 0.5) { return x; }                                   // linear
  if (id < 1.5) {                                               // sRGB
    if (x <= 0.04045) { return x / 12.92; }
    return pow((x + 0.055) / 1.055, 2.4);
  }
  if (id < 2.5) {                                               // BT.709/2020
    if (x < 4.5 * BT709_B) { return x / 4.5; }
    return pow((x + (BT709_A - 1.0)) / BT709_A, 1.0 / 0.45);
  }
  if (id < 3.5) {                                               // PQ
    let xc = clamp(x, 0.0, 1.0);
    let ep = pow(xc, 1.0 / PQ_M2);
    return pow(max(ep - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * ep), 1.0 / PQ_M1) * PQ_PEAK_WHITE;
  }
  // HLG
  if (x <= 0.5) { return (x * x) / 3.0; }
  return ((exp((x - HLG_C) / HLG_A) + HLG_B) / 12.0) * HLG_PEAK_WHITE;
}

fn oetf_ch(id : f32, x : f32) -> f32 {
  if (id < 0.5) { return x; }                                   // linear
  if (id < 1.5) {                                               // sRGB
    if (x <= 0.0031308) { return 12.92 * x; }
    return 1.055 * pow(x, 1.0 / 2.4) - 0.055;
  }
  if (id < 2.5) {                                               // BT.709/2020
    if (x < BT709_B) { return 4.5 * x; }
    return BT709_A * pow(x, 0.45) - (BT709_A - 1.0);
  }
  if (id < 3.5) {                                               // PQ
    let y = clamp(x / PQ_PEAK_WHITE, 0.0, 1.0);
    let ym = pow(y, PQ_M1);
    return pow((PQ_C1 + PQ_C2 * ym) / (1.0 + PQ_C3 * ym), PQ_M2);
  }
  let y = clamp(x / HLG_PEAK_WHITE, 0.0, 1.0);                  // HLG
  if (y <= 1.0 / 12.0) { return sqrt(3.0 * y); }
  return HLG_A * log(12.0 * y - HLG_B) + HLG_C;
}

fn eotf3(id : f32, v : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(eotf_ch(id, v.x), eotf_ch(id, v.y), eotf_ch(id, v.z));
}
fn oetf3(id : f32, v : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(oetf_ch(id, v.x), oetf_ch(id, v.y), oetf_ch(id, v.z));
}

fn reinhard(x : f32, peak : f32) -> f32 {
  let f = (x * (1.0 + x / (peak * peak))) / (1.0 + x);
  let fp = (peak * (1.0 + 1.0)) / (1.0 + peak);
  return f / fp;
}
fn hable(x : f32) -> f32 {
  let A = 0.15; let B = 0.50; let C = 0.10; let D = 0.20; let E = 0.02; let F = 0.30;
  return (x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F) - E / F;
}
fn tonemap3(tag : f32, peak : f32, v : vec3<f32>) -> vec3<f32> {
  if (tag < 0.5) { return v; }
  if (tag < 1.5) {
    return vec3<f32>(reinhard(v.x, peak), reinhard(v.y, peak), reinhard(v.z, peak));
  }
  let n = hable(peak);
  return vec3<f32>(hable(v.x) / n, hable(v.y) / n, hable(v.z) / n);
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let c = textureSampleBaseClampToEdge(tex, samp, in.uv);
  var lin = eotf3(u.params.x, c.rgb);          // decode to linear light
  lin = u.gamut * lin;                          // gamut convert (linear RGB)
  lin = tonemap3(u.params.z, u.params.w, lin);  // HDR -> SDR (no-op when tag 0)
  let outRgb = oetf3(u.params.y, clamp(lin, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(outRgb, c.a);
}
`;

/** GPU device + pipeline bundle created once per filter instance. The colour pipeline is built lazily. */
interface GpuContext {
  device: GPUDevice;
  pipeline: GPURenderPipeline;
  sampler: GPUSampler;
  uniformBuffer: GPUBuffer;
  /** The colour pipeline + its uniform buffer, created on the first colour frame (null until then). */
  color: { pipeline: GPURenderPipeline; uniformBuffer: GPUBuffer } | null;
}

/** WebGPU renderer: import the frame as an external texture and draw a sampled quad to a canvas texture. */
class WebGPURenderer implements Renderer {
  private gpu: GpuContext | undefined;
  private canvas: OffscreenCanvas | undefined;
  private context: GPUCanvasContext | undefined;
  private readonly format: GPUTextureFormat;

  private constructor(gpu: GpuContext, format: GPUTextureFormat) {
    this.gpu = gpu;
    this.format = format;
  }

  /** Acquire an adapter+device and build the pipeline. Throws `CapabilityError` if no adapter is granted. */
  static async create(signal?: AbortSignal): Promise<WebGPURenderer> {
    const gpuApi = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (gpuApi === undefined) {
      throw new CapabilityError('capability-miss', 'WebGPU is not available in this environment', {
        op: 'filter',
        tried: ['webgpu'],
        suggestion: 'use the canvas2d filter driver',
      });
    }
    const adapter = await gpuApi.requestAdapter();
    if (adapter === null) {
      throw new CapabilityError('capability-miss', 'no WebGPU adapter could be acquired', {
        op: 'filter',
        tried: ['webgpu'],
        suggestion: 'use the canvas2d filter driver',
      });
    }
    if (signal?.aborted === true) throw new MediaError('aborted', 'filter cancelled during setup');
    const device = await adapter.requestDevice();
    const format = gpuApi.getPreferredCanvasFormat();
    const module = device.createShaderModule({ code: WGSL });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-strip' },
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    return new WebGPURenderer({ device, pipeline, sampler, uniformBuffer, color: null }, format);
  }

  /** Lazily build (once) the second colour pipeline + its uniform buffer; reused for every colour frame. */
  private colorBundle(gpu: GpuContext): { pipeline: GPURenderPipeline; uniformBuffer: GPUBuffer } {
    if (gpu.color !== null) return gpu.color;
    const module = gpu.device.createShaderModule({ code: COLOR_WGSL });
    const pipeline = gpu.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-strip' },
    });
    const uniformBuffer = gpu.device.createBuffer({
      size: COLOR_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    gpu.color = { pipeline, uniformBuffer };
    return gpu.color;
  }

  render(source: VideoFrame, recipe: DrawRecipe): VideoFrame {
    const gpu = this.gpu;
    if (gpu === undefined) throw new MediaError('encode-error', 'WebGPU renderer already disposed');
    const dims = recipeDims(recipe);

    this.canvas = ensureCanvas(this.canvas, dims);
    if (this.context === undefined) {
      const ctx = this.canvas.getContext('webgpu');
      if (ctx === null)
        throw new MediaError('encode-error', 'OffscreenCanvas WebGPU context unavailable');
      this.context = ctx;
      this.context.configure({
        device: gpu.device,
        format: this.format,
        alphaMode: 'premultiplied',
      });
    }

    // Pick the pipeline + uniform buffer for this recipe (geometric quad vs colour), write its uniforms.
    const { pipeline, uniformBuffer } =
      recipe.kind === 'color'
        ? this.colorBundle(gpu)
        : { pipeline: gpu.pipeline, uniformBuffer: gpu.uniformBuffer };
    gpu.device.queue.writeBuffer(
      uniformBuffer,
      0,
      recipe.kind === 'color'
        ? packColorUniforms(recipe.plan)
        : packUniforms(uniformsForRecipe(recipe, source.displayWidth, source.displayHeight)),
    );

    const external = gpu.device.importExternalTexture({ source });
    const bindGroup = gpu.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: gpu.sampler },
        { binding: 2, resource: external },
      ],
    });

    const encoder = gpu.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);

    // The external texture is consumed by this submit; the canvas now holds the result.
    return new VideoFrame(this.canvas, framedInit(source));
  }

  dispose(): void {
    if (this.gpu !== undefined) {
      this.gpu.uniformBuffer.destroy();
      this.gpu.color?.uniformBuffer.destroy();
      this.gpu.device.destroy();
      this.gpu = undefined;
    }
    this.context = undefined;
    this.canvas = undefined;
  }
}

/* v8 ignore stop */

// ============ stream wiring (shared by both substrates) ============

/** How a substrate builds its renderer when a filter stream starts. */
type RendererFactory = (signal?: AbortSignal) => Promise<Renderer>;

/** The video specs the GPU filter drivers handle: the four geometric ops plus the two colour ops. */
type VideoFilterSpec = GeometricVideoSpec | ColorVideoSpec;

/**
 * Resolve a spec + the live source frame into a {@link DrawRecipe}. Geometric ops read only the frame's
 * display dimensions; colour ops read its `colorSpace` (mapped to a {@link SourceColor}, BT.709 default).
 * Browser-only (reads `VideoFrame`); the pure halves (`planDraw`, `planColor`, `mapVideoColorSpace`) are
 * Node-tested directly.
 */
/* v8 ignore start -- reads a live VideoFrame; the pure planners it delegates to are Node-tested. */
function recipeForFrame(spec: VideoFilterSpec, frame: VideoFrame): DrawRecipe {
  if (isColorVideoSpec(spec)) {
    const source = mapVideoColorSpace(frame.colorSpace);
    const plan = planColor(spec, source);
    return {
      kind: 'color',
      plan,
      dims: { width: frame.displayWidth, height: frame.displayHeight },
    };
  }
  return planDraw(spec, frame.displayWidth, frame.displayHeight);
}
/* v8 ignore stop */

/**
 * Build the `TransformStream<VideoFrame, VideoFrame>` for a video filter spec (geometric or colour) on a
 * given substrate. The renderer is created on `start`, applied per `transform`, and disposed on `flush`
 * (normal completion) or on `signal` abort (cancellation) — the `Transformer` interface has no `cancel`
 * hook, so teardown on cancel rides the `AbortSignal` listener. Each input frame is closed exactly once in
 * a `finally`; the renderer is released at most once. `start`/render run only in a browser — Node never
 * reaches them (`supports()` is false there, so the router never builds this stream).
 */
function createFilterStream(
  spec: VideoFilterSpec,
  makeRenderer: RendererFactory,
  opts: StageOptions | undefined,
): TransformStream<VideoFrame, VideoFrame> {
  let renderer: Renderer | undefined;
  let disposed = false;
  const signal = opts?.signal;

  const release = (): void => {
    if (disposed) return;
    disposed = true;
    renderer?.dispose();
    renderer = undefined;
  };

  // Cancellation: abort tears down GPU/canvas resources even mid-stream (no in-flight frame is buffered,
  // since `transform` closes its input synchronously before returning).
  if (signal !== undefined) signal.addEventListener('abort', release, { once: true });

  return new TransformStream<VideoFrame, VideoFrame>({
    /* v8 ignore start -- the transformer callbacks run only on a pumped stream with real VideoFrames/GPU;
       they require a browser and are validated in the Playwright harness, never mocked here. */
    async start(): Promise<void> {
      if (signal?.aborted === true)
        throw new MediaError('aborted', 'filter cancelled before start');
      renderer = await makeRenderer(signal);
    },
    transform(frame: VideoFrame, controller): void {
      if (disposed || renderer === undefined) {
        frame.close();
        throw new MediaError(
          signal?.aborted === true ? 'aborted' : 'encode-error',
          signal?.aborted === true ? 'filter cancelled' : 'filter renderer was not initialized',
        );
      }
      try {
        const recipe = recipeForFrame(spec, frame);
        const out = renderer.render(frame, recipe);
        let handedOff = false;
        try {
          controller.enqueue(out);
          handedOff = true;
        } finally {
          if (!handedOff) out.close();
        }
      } finally {
        // The draw consumed the source synchronously; release it exactly once, success or failure.
        frame.close();
      }
    },
    flush(): void {
      signal?.removeEventListener('abort', release);
      release();
    },
    /* v8 ignore stop */
  });
}

// ============ drivers ============

/** A spec the WebGPU driver can handle: every geometric op + both colour ops (all targets), ADR-032. */
function webgpuHandles(f: FilterSpec): f is VideoFilterSpec {
  return isGeometricVideoSpec(f) || isColorVideoSpec(f);
}

/**
 * A spec the Canvas2D driver can *honestly* handle: every geometric op, plus a `colorspace` op only when
 * its target resolves to the display gamut (a UA-colour-managed passthrough). Tonemap and wide-gamut
 * colorspace are declined so the router falls through rather than emitting wrong pixels (ADR-032).
 */
function canvas2dHandles(f: FilterSpec): f is VideoFilterSpec {
  if (isGeometricVideoSpec(f)) return true;
  return isColorVideoSpec(f) && canvas2dCanColor(f);
}

/**
 * The primary WebGPU video filter driver (`substrate:'webgpu'`). `supports()` is honest: it returns
 * `false` (so the router falls through to Canvas2D) unless this is a geometric **or** colour video spec
 * **and** WebGPU + `OffscreenCanvas` + `VideoFrame` are present. Heavy device acquisition happens lazily in
 * `createFilter`'s stream `start`, never in `supports()` (doc 04: probing stays cheap).
 */
export const webgpuVideoFilterDriver: FilterDriver = {
  id: 'webgpu-video-filter',
  apiVersion: DRIVER_API_VERSION,
  kind: 'filter',
  substrate: 'webgpu',
  supports(f: FilterSpec): boolean {
    return webgpuHandles(f) && webgpuAvailable();
  },
  createFilter(f: FilterSpec, o?: StageOptions): TransformStream<VideoFrame, VideoFrame> {
    if (!webgpuHandles(f)) {
      throw new CapabilityError('capability-miss', `webgpu filter does not handle ${f.type}`, {
        op: 'filter',
        tried: [webgpuVideoFilterDriver.id],
      });
    }
    return createFilterStream(
      f,
      /* v8 ignore next -- browser-only renderer construction. */
      (signal) => WebGPURenderer.create(signal),
      o,
    );
  },
};

/**
 * The Canvas2D fallback video filter driver (`substrate:'canvas2d'`, ranked after WebGPU). Geometric ops
 * via an `OffscreenCanvas` 2D context — exact for crop/rotate/flip and bilinear for resize — plus a
 * display-space `colorspace` passthrough. `supports()` is honest about `OffscreenCanvas`/`VideoFrame`
 * availability and declines tonemap / wide-gamut colorspace (ADR-032).
 */
export const canvas2dVideoFilterDriver: FilterDriver = {
  id: 'canvas2d-video-filter',
  apiVersion: DRIVER_API_VERSION,
  kind: 'filter',
  substrate: 'canvas2d',
  supports(f: FilterSpec): boolean {
    return canvas2dHandles(f) && canvas2dAvailable();
  },
  createFilter(f: FilterSpec, o?: StageOptions): TransformStream<VideoFrame, VideoFrame> {
    if (!canvas2dHandles(f)) {
      throw new CapabilityError('capability-miss', `canvas2d filter does not handle ${f.type}`, {
        op: 'filter',
        tried: [canvas2dVideoFilterDriver.id],
      });
    }
    return createFilterStream(
      f,
      /* v8 ignore next -- browser-only renderer construction. */
      () => Promise.resolve(new Canvas2DRenderer()),
      o,
    );
  },
};

/* v8 ignore start -- unreachable exhaustiveness guard (a `never` parameter). */
/** Exhaustiveness guard — unreachable if the `GeometricVideoSpec` union is fully handled. */
function exhaustive(value: never): never {
  throw new MediaError('encode-error', `unhandled geometric filter spec: ${String(value)}`);
}
/* v8 ignore stop */

/**
 * Driver module registering both video filter substrates (WebGPU primary + Canvas2D fallback). The router
 * picks the highest-substrate driver whose `supports()` is true, so a WebGPU-capable browser uses the GPU
 * and others fall back automatically — no caller choice (doc 04, ADR-003).
 */
export const GpuVideoFilterModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addFilter(webgpuVideoFilterDriver);
    reg.addFilter(canvas2dVideoFilterDriver);
  },
};

export default GpuVideoFilterModule;
