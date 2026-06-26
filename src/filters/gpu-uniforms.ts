/**
 * Pure WebGPU shader-uniform math for the video filter (doc 09 §filters). Derives, from a {@link DrawRecipe}
 * + source dims, the normalized values the WGSL quad shader reads — destination placement (`posScale`/
 * `posOffset`), source sub-rect (`uvScale`/`uvOffset`), and a ±1 orientation 2×2 (`rot0`/`rot1`) — and packs
 * them into the `std140` uniform buffer. It carries **no** GPU/`VideoFrame` types, so the geometry→shader
 * mapping is unit-tested in Node (the device calls that consume these live in {@link ./gpu-video.ts} and are
 * browser-validated). Keeping this honest matters: a wrong `posScale` would silently break resize-`contain`.
 */

import { InputError } from '../contracts/errors.ts';
import type { Blit, OrientedDraw } from './geometry.ts';
import type { DrawRecipe } from './gpu-video.ts';

/** Byte size of the WGSL `Uniforms` block: 6 × vec2<f32>, tightly packed (16-byte aligned overall). */
export const UNIFORM_BYTES = 48;

/**
 * The shader uniforms, all normalized to [0,1] (or ±1 for orientation):
 * - `posScale`/`posOffset` place the unit quad into the output (top-left convention) — a sub-rect for
 *   resize-`contain` (the cleared background becomes the letterbox), the full output otherwise.
 * - `uvScale`/`uvOffset` select the sampled source sub-rect — less than the whole texture for resize-`cover`
 *   and `crop`, the whole texture otherwise.
 * - `rot0`/`rot1` are the rows of a 2×2 applied about the (0.5,0.5) UV centre — identity for resize/crop,
 *   a ±1 rotation/flip for the oriented ops.
 */
export interface UniformValues {
  readonly posScale: readonly [number, number];
  readonly posOffset: readonly [number, number];
  readonly uvScale: readonly [number, number];
  readonly uvOffset: readonly [number, number];
  readonly rot0: readonly [number, number];
  readonly rot1: readonly [number, number];
}

/** Identity orientation (no rotation/flip) — the rows of a 2×2 identity. */
const ORIENT_IDENTITY = { rot0: [1, 0] as const, rot1: [0, 1] as const };

/**
 * Uniforms for a {@link Blit} (resize/crop): map the destination sub-rect into the output and the source
 * sub-rect into the sampler, with no rotation. Resize-`contain` shrinks `posScale` below 1 (letterbox);
 * resize-`cover`/`crop` shrink `uvScale` below 1 (source crop); resize-`fill` uses both full.
 */
export function uniformsForBlit(blit: Blit, srcW: number, srcH: number): UniformValues {
  const { width: outW, height: outH } = blit.dims;
  return {
    posScale: [blit.dst.width / outW, blit.dst.height / outH],
    posOffset: [blit.dst.x / outW, blit.dst.y / outH],
    uvScale: [blit.src.width / srcW, blit.src.height / srcH],
    uvOffset: [blit.src.x / srcW, blit.src.y / srcH],
    ...ORIENT_IDENTITY,
  };
}

/** Uniforms for an {@link OrientedDraw} (rotate/flip): a pure ±1 re-orientation; the source fills the output. */
export function uniformsForOriented(draw: OrientedDraw): UniformValues {
  // Each op's linear part has ±1 entries; the same 2×2 re-orients UV space about the centred UV (these ops
  // are their own inverse up to sign). Only the signs matter — magnitudes are 1 for the supported angles.
  const t = draw.transform;
  const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);
  return {
    posScale: [1, 1],
    posOffset: [0, 0],
    uvScale: [1, 1],
    uvOffset: [0, 0],
    rot0: [sign(t.a), sign(t.b)],
    rot1: [sign(t.c), sign(t.d)],
  };
}

/**
 * Derive the **geometric** quad uniforms for a blit/oriented recipe. A `color` recipe never reaches here —
 * it rides the separate colour pipeline ({@link packColorUniforms}) — so it is a typed programmer error.
 */
export function uniformsForRecipe(recipe: DrawRecipe, srcW: number, srcH: number): UniformValues {
  if (recipe.kind === 'blit') return uniformsForBlit(recipe.blit, srcW, srcH);
  if (recipe.kind === 'oriented') return uniformsForOriented(recipe.draw);
  /* v8 ignore next 2 -- unreachable: colour recipes use packColorUniforms, never the geometric pipeline. */
  throw new InputError('unsupported-input', 'colour recipe has no geometric uniforms');
}

/** Pack {@link UniformValues} into the {@link UNIFORM_BYTES} std140 layout, on its own `ArrayBuffer`. */
export function packUniforms(v: UniformValues): Float32Array<ArrayBuffer> {
  const out = new Float32Array(new ArrayBuffer(UNIFORM_BYTES));
  out.set([
    v.posScale[0],
    v.posScale[1],
    v.posOffset[0],
    v.posOffset[1],
    v.uvScale[0],
    v.uvScale[1],
    v.uvOffset[0],
    v.uvOffset[1],
    v.rot0[0],
    v.rot0[1],
    v.rot1[0],
    v.rot1[1],
  ]);
  return out;
}

// ============ colorspace + tonemap math (pure, Node-tested — ADR-032) ============
//
// The color ops (`colorspace`, `tonemap`) need per-pixel color science, not geometry, so they ride a
// **second** shader pipeline (see {@link ./gpu-video.ts}) that applies, per pixel:
//
//   decode-transfer (EOTF → linear light) → 3×3 linear-RGB gamut matrix → optional tonemap → encode-transfer.
//
// Everything that decides those values is pure and lives here: the gamut matrices are built from CIE xy
// primaries + the D65 white point by the standard construction (so they reproduce the published constants
// bit-exactly), the transfer curves are closed-form EOTF/OETF pairs, the tonemap operator is normalized so
// it maps black→0 and the source peak→1 exactly, and the plan selector turns a `FilterSpec` color op + the
// source `VideoColorSpace` (passed in as a plain triplet so this file stays free of DOM types) into a
// {@link ColorPlan}. The browser-only render that consumes the plan is validated in the Playwright harness.

/** A colour space's RGB primaries/gamut identity (the SDR gamuts we convert between). */
export type ColorSpaceId = 'srgb' | 'bt709' | 'bt601' | 'bt2020';

/** The complete in-tree SDR/wide-gamut matrix set; every ordered pair is covered by {@link gamutMatrix}. */
export const COLOR_SPACE_IDS: readonly ColorSpaceId[] = ['srgb', 'bt709', 'bt601', 'bt2020'];

/** A transfer characteristic (opto-electronic curve). `linear` is the identity (already light-linear). */
export type TransferId = 'srgb' | 'bt709' | 'pq' | 'hlg' | 'linear';

/** A row-major 3×3 matrix (rows `[m0..m2]`, `[m3..m5]`, `[m6..m8]`); `out_i = Σ_j m[i*3+j]·v_j`. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** CIE 1931 xy chromaticity coordinates. */
type XY = readonly [number, number];

/** The RGB primaries + white point that define a gamut (D65 throughout for the spaces we support). */
interface Primaries {
  readonly r: XY;
  readonly g: XY;
  readonly b: XY;
  readonly w: XY;
}

/** The D65 white point (CIE 1931 2°), shared by sRGB/BT.709/BT.601-525/BT.2020. */
const D65: XY = [0.3127, 0.329];

/**
 * Per-gamut primaries. sRGB and BT.709 share primaries (so their gamut matrix is identity — only the
 * transfer differs); BT.601 here is the 525-line SMPTE-C set (WebCodecs' `smpte170m`, the common SD/NTSC
 * tag); BT.2020 is the wide UHD gamut.
 */
const PRIMARIES: Readonly<Record<ColorSpaceId, Primaries>> = {
  srgb: { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], w: D65 },
  bt709: { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], w: D65 },
  bt601: { r: [0.63, 0.34], g: [0.31, 0.595], b: [0.155, 0.07], w: D65 },
  bt2020: { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046], w: D65 },
};

/** Multiply a {@link Mat3} by a 3-vector. The exact mapping the colour shader applies in linear RGB. */
export function applyMat3(m: Mat3, v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Row-major 3×3 product `a·b`. */
function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const [b0, b1, b2, b3, b4, b5, b6, b7, b8] = b;
  return [
    a0 * b0 + a1 * b3 + a2 * b6,
    a0 * b1 + a1 * b4 + a2 * b7,
    a0 * b2 + a1 * b5 + a2 * b8,
    a3 * b0 + a4 * b3 + a5 * b6,
    a3 * b1 + a4 * b4 + a5 * b7,
    a3 * b2 + a4 * b5 + a5 * b8,
    a6 * b0 + a7 * b3 + a8 * b6,
    a6 * b1 + a7 * b4 + a8 * b7,
    a6 * b2 + a7 * b5 + a8 * b8,
  ];
}

/** Inverse of a row-major 3×3 (cofactor / determinant). Throws if singular (never, for real primaries). */
function invMat3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (det === 0) throw new InputError('unsupported-input', 'singular colour matrix');
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  return [A / det, D / det, G / det, B / det, E / det, H / det, C / det, F / det, I / det];
}

/** XYZ (Y=1) of an xy chromaticity. */
function xyToXyz([x, y]: XY): [number, number, number] {
  return [x / y, 1, (1 - x - y) / y];
}

/**
 * The linear-RGB → CIE XYZ matrix for a gamut, built from its primaries + white by the canonical
 * construction `M = [R G B] · diag(S)` where `S` solves `M·[1,1,1]ᵀ = XYZ(white)` — i.e. each primary
 * column scaled so equal RGB reproduces the white point. This reproduces the published matrices exactly
 * (e.g. sRGB/BT.709 → `0.41239080, 0.21263901, …`).
 */
export function rgbToXyz(id: ColorSpaceId): Mat3 {
  const p = PRIMARIES[id];
  const r = xyToXyz(p.r);
  const g = xyToXyz(p.g);
  const b = xyToXyz(p.b);
  const w = xyToXyz(p.w);
  // Solve [r g b]·S = w for the per-primary scale S (the columns are r,g,b).
  const cols: Mat3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const s = applyMat3(invMat3(cols), w);
  return [
    r[0] * s[0],
    g[0] * s[1],
    b[0] * s[2],
    r[1] * s[0],
    g[1] * s[1],
    b[1] * s[2],
    r[2] * s[0],
    g[2] * s[1],
    b[2] * s[2],
  ];
}

/** The CIE XYZ → linear-RGB matrix for a gamut (inverse of {@link rgbToXyz}). */
export function xyzToRgb(id: ColorSpaceId): Mat3 {
  return invMat3(rgbToXyz(id));
}

/** Identity 3×3 (returned when source and destination gamuts share primaries, e.g. sRGB↔BT.709). */
export const MAT3_IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Whether two gamuts have value-equal primaries + white (e.g. sRGB and BT.709 do). */
function samePrimaries(a: Primaries, b: Primaries): boolean {
  const eq = (p: XY, q: XY): boolean => p[0] === q[0] && p[1] === q[1];
  return eq(a.r, b.r) && eq(a.g, b.g) && eq(a.b, b.b) && eq(a.w, b.w);
}

/**
 * The linear-RGB → linear-RGB gamut conversion `dst ← src`, i.e. `XYZ→RGB(dst) · RGB→XYZ(src)`. When the
 * two gamuts share primaries (sRGB↔BT.709) this is **exactly** the identity (no float dust — the shader
 * then skips a no-op multiply); 709↔2020/601 carry the real (published) matrices (e.g. 2020→709
 * `1.6605, −0.5876, −0.0728, …`).
 */
export function gamutMatrix(src: ColorSpaceId, dst: ColorSpaceId): Mat3 {
  if (samePrimaries(PRIMARIES[src], PRIMARIES[dst])) return MAT3_IDENTITY;
  return mulMat3(xyzToRgb(dst), rgbToXyz(src));
}

// ---- transfer functions (per-channel scalars; `eotf` linearizes, `oetf` is its inverse) ----

const SRGB_OETF_THRESH = 0.0031308;
const SRGB_EOTF_THRESH = 0.04045;
// BT.709/BT.2020 SDR "camera" OETF constants (BT.1886-consistent): a·x^0.45 − (a−1), linear below β.
const BT709_A = 1.09929682680944;
const BT709_B = 0.018053968510807;
// SMPTE ST 2084 (PQ) constants.
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;
// HDR EOTFs below return linear light in SDR-diffuse-white-relative units (100 nits = 1.0).
const PQ_PEAK_WHITE = 100;
const HLG_PEAK_WHITE = 12;
// ARIB STD-B67 / BT.2100 HLG OETF constants.
const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A;
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);

/** Clamp to [0,1] — transfer inputs/outputs are normalized signal values. */
function sat(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Electro-optical transfer (decode): normalized signal → light-linear. SDR transfers return [0,1] where
 * 1.0 is diffuse white. HDR transfers return the same **white-relative** unit: PQ code 1.0 is 10000 nits,
 * i.e. 100× SDR white; HLG code 1.0 is 12× reference white. That makes the tonemap `peak` parameter real
 * rather than decorative: PQ peak 100 and HLG peak 12 both map back to SDR white after tone mapping.
 */
export function eotf(id: TransferId, x: number): number {
  switch (id) {
    case 'linear':
      return x;
    case 'srgb':
      return x <= SRGB_EOTF_THRESH ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    case 'bt709':
      return x < 4.5 * BT709_B ? x / 4.5 : ((x + (BT709_A - 1)) / BT709_A) ** (1 / 0.45);
    case 'pq': {
      const ep = sat(x) ** (1 / PQ_M2);
      return (Math.max(ep - PQ_C1, 0) / (PQ_C2 - PQ_C3 * ep)) ** (1 / PQ_M1) * PQ_PEAK_WHITE;
    }
    case 'hlg':
      return (
        (x <= 0.5 ? (x * x) / 3 : (Math.exp((x - HLG_C) / HLG_A) + HLG_B) / 12) * HLG_PEAK_WHITE
      );
    /* v8 ignore next 2 -- unreachable: TransferId is a closed union. */
    default:
      return assertNeverTransfer(id);
  }
}

/**
 * Opto-electronic transfer (encode): light-linear → normalized signal. This is the inverse of {@link eotf}
 * in the same units. Output filter plans currently encode to SDR (sRGB/BT.709), but PQ/HLG are still
 * implemented so the transfer pair stays complete and testable.
 */
export function oetf(id: TransferId, x: number): number {
  switch (id) {
    case 'linear':
      return x;
    case 'srgb':
      return x <= SRGB_OETF_THRESH ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    case 'bt709':
      return x < BT709_B ? 4.5 * x : BT709_A * x ** 0.45 - (BT709_A - 1);
    case 'pq': {
      const ym = sat(x / PQ_PEAK_WHITE) ** PQ_M1;
      return ((PQ_C1 + PQ_C2 * ym) / (1 + PQ_C3 * ym)) ** PQ_M2;
    }
    case 'hlg': {
      const y = sat(x / HLG_PEAK_WHITE);
      return y <= 1 / 12 ? Math.sqrt(3 * y) : HLG_A * Math.log(12 * y - HLG_B) + HLG_C;
    }
    /* v8 ignore next 2 -- unreachable: TransferId is a closed union. */
    default:
      return assertNeverTransfer(id);
  }
}

// ---- tonemap operators (HDR linear luminance → SDR [0,1]) ----

/** A tone-mapping operator and the source peak luminance (in the same linear units) it normalizes to 1.0. */
export interface Tonemap {
  readonly op: 'reinhard' | 'hable';
  readonly peak: number;
}

/**
 * Extended Reinhard `L·(1 + L/peak²) / (1 + L)`, then normalized by its own value at `peak` so the source
 * peak maps to exactly 1.0. Monotonic, fixes black at 0. `peak` ≥ 1 (an HDR scene exceeds the SDR 1.0).
 */
export function tonemapReinhard(L: number, peak: number): number {
  const f = (x: number): number => (x * (1 + x / (peak * peak))) / (1 + x);
  return f(L) / f(peak);
}

/** Hable (Uncharted-2 filmic) curve, normalized so `peak` maps to 1.0. Monotonic, fixes black at 0. */
export function tonemapHable(L: number, peak: number): number {
  const A = 0.15;
  const B = 0.5;
  const C = 0.1;
  const D = 0.2;
  const E = 0.02;
  const F = 0.3;
  const f = (x: number): number =>
    (x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F) - E / F;
  return f(L) / f(peak);
}

/** Apply a {@link Tonemap} to a linear luminance (dispatch over the operator). */
export function applyTonemap(t: Tonemap, L: number): number {
  return t.op === 'hable' ? tonemapHable(L, t.peak) : tonemapReinhard(L, t.peak);
}

// ---- plan selection (FilterSpec color op + source VideoColorSpace → ColorPlan) ----

/**
 * The compiled color operation: linearize with `decode`, convert gamut with `gamut`, optionally compress
 * HDR with `tonemap`, then re-encode with `encode`. This is exactly what the color shader executes per
 * pixel; it is pure data so the spec→plan decision is unit-tested without a GPU.
 */
export interface ColorPlan {
  readonly decode: TransferId;
  readonly gamut: Mat3;
  readonly tonemap: Tonemap | null;
  readonly encode: TransferId;
}

/** The source frame's color characteristics, as a plain triplet (mapped from `VideoColorSpace` by the caller). */
export interface SourceColor {
  readonly primaries: ColorSpaceId;
  readonly transfer: TransferId;
}

/** Token aliases accepted for a `colorspace`/output gamut target (lower-cased, separators stripped). */
const COLOR_SPACE_ALIASES: Readonly<Record<string, ColorSpaceId>> = {
  srgb: 'srgb',
  iec6196621: 'srgb',
  bt709: 'bt709',
  rec709: 'bt709',
  '709': 'bt709',
  bt601: 'bt601',
  rec601: 'bt601',
  '601': 'bt601',
  smpte170m: 'bt601',
  smptec: 'bt601',
  bt470bg: 'bt601',
  bt2020: 'bt2020',
  rec2020: 'bt2020',
  '2020': 'bt2020',
  bt2020ncl: 'bt2020',
};

/**
 * Parse a free-form `colorspace.to` token into a {@link ColorSpaceId}, tolerating common spellings
 * (`bt709`/`rec709`/`709`, `smpte170m`→`bt601`, `bt2020ncl`→`bt2020`, …). Returns `null` for an
 * unrecognized target so callers can decline honestly rather than convert to a guessed gamut.
 */
export function parseColorSpace(token: string): ColorSpaceId | null {
  const key = token.toLowerCase().replace(/[\s._-]/g, '');
  return COLOR_SPACE_ALIASES[key] ?? null;
}

/** The conventional SDR display transfer for an output gamut (sRGB uses the sRGB curve; the rest BT.709). */
function displayTransferFor(id: ColorSpaceId): TransferId {
  return id === 'srgb' ? 'srgb' : 'bt709';
}

/** True when an output gamut is the display space a UA-color-managed Canvas2D can honestly produce. */
export function isDisplayColorSpace(id: ColorSpaceId): boolean {
  return id === 'srgb' || id === 'bt709';
}

/**
 * Plan a `colorspace` conversion: decode the source transfer to linear, convert `source.primaries →
 * dst` gamut (identity when they share primaries), no tonemap, re-encode to `dst`'s display transfer.
 */
export function planColorspace(source: SourceColor, dst: ColorSpaceId): ColorPlan {
  return {
    decode: source.transfer,
    gamut: gamutMatrix(source.primaries, dst),
    tonemap: null,
    encode: displayTransferFor(dst),
  };
}

/** Default peak luminance (in the format's linear units, where SDR diffuse white = 1.0) per HDR transfer. */
function defaultPeak(transfer: TransferId): number {
  // PQ normalizes 1.0 to 10000 nits; SDR reference white ≈ 100 nits ⇒ peak ≈ 100× white.
  // HLG scene-linear ranges to 12× the reference; both are clamped to ≥ 1 so the operator is well-defined.
  if (transfer === 'pq') return PQ_PEAK_WHITE;
  if (transfer === 'hlg') return HLG_PEAK_WHITE;
  return 1;
}

/**
 * Plan an HDR→SDR `tonemap`: decode the source HDR transfer (PQ/HLG, else its own) to linear, convert the
 * source gamut → BT.709 (the SDR target), compress with extended Reinhard normalized to the source peak,
 * and encode to the BT.709 display transfer. SDR-in (peak ≤ 1) collapses to a gamut-only pass.
 */
export function planTonemap(source: SourceColor): ColorPlan {
  const peak = defaultPeak(source.transfer);
  return {
    decode: source.transfer,
    gamut: gamutMatrix(source.primaries, 'bt709'),
    tonemap: peak > 1 ? { op: 'reinhard', peak } : null,
    encode: 'bt709',
  };
}

// ---- color uniform packing (the second pipeline's std140 buffer) ----

/** Byte size of the color shader's `ColorUniforms`: a `mat3x3` (3×vec4) + one `vec4` of scalar params. */
export const COLOR_UNIFORM_BYTES = 64;

/** Numeric tags the color shader switches on for the transfer curves (kept in sync with the WGSL). */
const TRANSFER_TAG: Readonly<Record<TransferId, number>> = {
  linear: 0,
  srgb: 1,
  bt709: 2,
  pq: 3,
  hlg: 4,
};

/** Numeric tag for the tonemap operator (0 = none). */
function tonemapTag(t: Tonemap | null): number {
  if (t === null) return 0;
  return t.op === 'reinhard' ? 1 : 2;
}

/**
 * Pack a {@link ColorPlan} into the color shader's std140 buffer: the 3×3 gamut matrix as three `vec4`
 * columns (WGSL `mat3x3` column-major, w-lane padding 0) followed by a `vec4(decodeTag, encodeTag,
 * tonemapTag, peak)`. Owns its `ArrayBuffer` so WebGPU `writeBuffer` accepts it.
 */
export function packColorUniforms(plan: ColorPlan): Float32Array<ArrayBuffer> {
  const out = new Float32Array(new ArrayBuffer(COLOR_UNIFORM_BYTES));
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = plan.gamut;
  // WGSL `mat3x3` is column-major; each column occupies a 4-float (vec4) slot with a 0 w-lane.
  // column 0 = (m0,m3,m6), column 1 = (m1,m4,m7), column 2 = (m2,m5,m8).
  out.set([m0, m3, m6, 0, m1, m4, m7, 0, m2, m5, m8, 0], 0);
  out.set(
    [
      TRANSFER_TAG[plan.decode],
      TRANSFER_TAG[plan.encode],
      tonemapTag(plan.tonemap),
      plan.tonemap === null ? 0 : plan.tonemap.peak,
    ],
    12,
  );
  return out;
}

/* v8 ignore next 3 -- unreachable exhaustiveness guard for the TransferId union. */
function assertNeverTransfer(value: never): never {
  throw new InputError('unsupported-input', `unhandled transfer characteristic: ${String(value)}`);
}
