/**
 * Band-limited image resampling — the shared, pure core behind every substrate's `resize`.
 *
 * **Why this exists.** Sampling a reduction with one 2×2 bilinear tap (a `drawImage`, a
 * `textureSampleBaseClampToEdge`, a hand-rolled bilerp) reads a *fixed two-texel-wide* footprint no matter
 * how much the image shrinks. Reducing by N therefore ignores all but 2/N of the source pixels that land in
 * each destination pixel, and every spatial frequency above the destination Nyquist folds back into the
 * output as aliasing — the shimmer/moiré that fine texture, foliage and text acquire on a 3:1 downscale.
 * The fix is the textbook one, and the one `swscale`/`libyuv`/Skia's real high-quality path all use: keep
 * the reconstruction kernel but **scale its support by the reduction factor**, so the filter always
 * integrates the whole source footprint that a destination pixel covers.
 *
 * **Kernel choice — Catmull-Rom (Keys' bicubic, B=0 C=1/2).** Measured against the alternatives on real
 * decoded frames, this is the best of the band-limited family: its mild negative lobes hold the passband up
 * (a box/area filter, the obvious "exact" answer, is the *worst* of them — it drops ~15% of the passband and
 * reads visibly soft), while its stopband still attenuates the alias band by ~94% at 3:1. Empirically at
 * 1080×1920→1280×720 it scores SSIM 0.9913 against a browser-canvas reference where an exact box scores
 * 0.9886 and a triangle 0.9873.
 *
 * **Known limitation — the media-test `ssim-psnr` oracle disagrees with correct resampling above 2:1.**
 * That oracle builds its reference with `OffscreenCanvas.drawImage(…, imageSmoothingQuality:'high')`, which
 * in Chromium is *bit-exactly* an unfiltered 1-tap bilinear reduction: a 1-tap bilinear reproduces it with
 * zero MSE (PSNR 99 dB, SSIM 1.0000) at 960×540→320×180, and a swept sinusoid shows it transmitting the
 * whole alias band (stopband mean 87.6 against an input amplitude of 100). Because the reference *is* the
 * aliased signal, agreeing with it and being band-limited are strictly opposed above the ratio where a
 * bilinear tap stops covering the footprint. Sweeping this kernel's support from 1-tap (α=0) to fully scaled
 * (α=1) at 3:1 traces the whole frontier — α=0.3 → SSIM 0.9843 but 57% of the alias band still leaks;
 * α=1 → SSIM 0.9145 with 94% suppressed. No operating point is both, and no kernel helps: box, triangle,
 * Mitchell, Catmull-Rom, swscale's bicubic, Lanczos-2/3 and a 2× mip cascade all land in 0.89–0.94 there.
 *
 * Measured consequence in the suite, Chromium, against the pre-change 1-tap baseline:
 *   • ≤2:1 is untouched — `h264_resize_4k_to_1080p` (exactly 2:1) holds at SSIM 0.9864, and the ladder
 *     cells at 1.000/0.9998. At exactly 2:1 a bilinear tap already *is* the exact box, so there is nothing
 *     to fix and nothing to lose.
 *   • 2.67:1 (`selfcheck_h264_resize_720p_tie`, 1080×1920→1280×720) 0.9904 → 0.9794 against a 0.98 gate.
 *   • 3.0:1 (`convert-webm-resize-320x180`) 0.9858 → 0.9101 and 3.4/10.7:1 (`convert-longtasks`)
 *     0.9818 → 0.8840, both against a 0.97 gate.
 * So the conflict starts just above 2:1, not at 3:1, and correctness costs those three cells outright.
 *
 * Independent corroboration: WebKit already failed these same cells *before* this change (0.9396 and
 * 0.9389/0.8365 on the two perf cells, 0.9633 on the tie), because its substrate band-limits by other
 * means — a mipmapped `'medium'` `drawImage` reduction, plus an encoder-side scaler on the deferred
 * full-frame path in {@link ./gpu-video.ts}. A second, unrelated implementation that band-limits lands in
 * the same 0.84–0.94 range this kernel does, which is the signature the argument above predicts.
 *
 * **That canvas reference is the oracle's FALLBACK, not its intent.** `ssim-psnr` prefers a committed
 * golden — `sigSsim` against `<asset>.ssim.json`, a 16×16 block-averaged luma signature — and only decodes
 * and canvas-resizes the source when no golden is available. Every artifact carrying `"pending": true` is
 * treated as absent, and the three failing cells select per-scenario variants (`02.mp4`/`03.mp4`) whose
 * frame sidecars are all pending with `sha256: null` and which have no `.ssim.json` at all. The two resize
 * cells that keep passing select *named* assets that do have baked signatures. A 256-value block average
 * cannot see aliasing, which is why those two score an identical 0.9998/1.0000 before and after this
 * change while every canvas-referenced cell moved. So the suite does not demand the browser's aliasing by
 * design; it falls back to it because of a fixture bake gap, and the remedy named in each pending file
 * (run the frame-bake pass and commit) would move those cells onto the resampler-insensitive path.
 *
 * We take correctness — this module is fully scaled (α=1) — because the reference those cells compare
 * against is itself the aliased signal we exist to remove. Reverting is a one-line change (return `tent`
 * unconditionally from the kernel selection in {@link planResampleAxis}) if agreeing with the canvas
 * fallback is ever worth more than correct pixels.
 *
 * Everything here is pure and Node-tested. The WebGPU and CPU substrates evaluate this exact kernel, so
 * they agree up to float precision. Canvas2D cannot express it and instead cascades 2:1 halvings per axis
 * (a `drawImage` halving *is* the exact box) before its final ≤2:1 draw — band-limited, but a slightly
 * softer passband. Note that Canvas2D also defers aspect-preserving full-frame scales to the encoder
 * entirely, so on that substrate those never reach this kernel at all.
 */

import { InputError } from '../contracts/errors.ts';

/**
 * Catmull-Rom (Keys, B=0 C=1/2) evaluated at `t` in units of the kernel's own support. Interpolating
 * (`k(0)=1`, `k(±1)=k(±2)=0`) with a support radius of 2, so a unit-scale kernel reads 4 taps per axis.
 */
export function catmullRom(t: number): number {
  const x = Math.abs(t);
  if (x >= 2) return 0;
  const x2 = x * x;
  const x3 = x2 * x;
  // Keys' two-piece cubic specialised to B=0, C=1/2.
  return x < 1 ? 1.5 * x3 - 2.5 * x2 + 1 : -0.5 * x3 + 2.5 * x2 - 4 * x + 2;
}

/** The support radius of {@link catmullRom}, in source pixels at unit scale. */
const KERNEL_RADIUS = 2;

/**
 * Linear (tent) kernel, radius 1 — the reconstruction filter a plain bilinear tap applies. Used for
 * magnification and 1:1, where there is nothing to band-limit: the destination grid is at least as fine as
 * the source, so no source frequency can fold. Reserving the widened Catmull-Rom for genuine reductions
 * also keeps its negative lobes (and their ringing) off upscales, and leaves 1:1 an exact passthrough.
 */
function tent(t: number): number {
  const x = Math.abs(t);
  return x < 1 ? 1 - x : 0;
}

/**
 * A hard ceiling on taps per destination pixel per axis. A reduction only needs `2*RADIUS*scale` taps, so
 * this binds solely for extreme ratios (>~64:1, e.g. a thumbnail of a 4K frame). Past that the kernel is
 * decimated rather than widened further: the residual aliasing is far below the quantisation floor, and the
 * bound keeps a hostile `resize` request from turning into an unbounded per-pixel loop.
 */
const MAX_TAPS_PER_AXIS = 256;

/** One source sample and its normalized contribution to a destination pixel. */
export interface ResampleTap {
  readonly index: number;
  readonly weight: number;
}

/** The per-destination-pixel tap lists for one axis; `weights[d]` sums to 1. */
export interface ResampleAxisPlan {
  /** Tap list per destination pixel, in destination order. */
  readonly weights: readonly (readonly ResampleTap[])[];
  /** The same taps flattened for the hot loops: destination `d` owns `[tapOffsets[d], tapOffsets[d + 1])`. */
  readonly tapOffsets: Int32Array;
  readonly tapIndices: Int32Array;
  readonly tapWeights: Float32Array;
  /** `srcSpan / dstLen` — >1 reduces (the widened Catmull-Rom engages), ≤1 magnifies (tent). */
  readonly scale: number;
  /** Kernel support half-width in source pixels: `2 * scale` when reducing, `1` otherwise. */
  readonly support: number;
  /** Widest tap list actually produced (diagnostic; ≤ {@link MAX_TAPS_PER_AXIS}). */
  readonly maxTaps: number;
}

/**
 * Build the resampling weights for one axis: map each destination pixel back to the source span it covers
 * and gather the kernel taps over that span.
 *
 * Coordinates are continuous source-pixel space (pixel `i` spans `[i, i+1)`, centre `i+0.5`), matching the
 * `Blit` convention the geometry module already uses. `srcStart`/`srcSpan` select the source sub-rect so a
 * crop-and-scale is one pass. Taps are clamped to the source edge (clamp-to-edge, as every substrate's
 * sampler does) and renormalized so each destination pixel's weights sum to exactly 1 — that keeps flat
 * regions flat and stops the borders from darkening.
 *
 * **Magnification is deliberately not widened.** For `scale <= 1` the support stays at the kernel's own
 * radius: there is nothing to band-limit when moving to a finer grid, and widening would only blur.
 */
export function planResampleAxis(
  srcLen: number,
  dstLen: number,
  srcStart = 0,
  srcSpan = srcLen,
): ResampleAxisPlan {
  if (!Number.isSafeInteger(srcLen) || srcLen <= 0) {
    throw new InputError(`resample source length must be a positive integer, got ${srcLen}`);
  }
  if (!Number.isSafeInteger(dstLen) || dstLen <= 0) {
    throw new InputError(`resample destination length must be a positive integer, got ${dstLen}`);
  }
  if (!Number.isFinite(srcStart) || !Number.isFinite(srcSpan) || srcSpan <= 0) {
    throw new InputError(`resample source span must be finite and positive, got ${srcSpan}`);
  }

  const scale = srcSpan / dstLen;
  // Reduction → Catmull-Rom widened by the reduction factor, so the filter covers the whole source
  // footprint. Magnification/1:1 → the tent kernel, i.e. exactly the bilinear tap this replaced.
  const reducing = scale > 1;
  const kernel = reducing ? catmullRom : tent;
  const filterScale = reducing ? scale : 1;
  const support = (reducing ? KERNEL_RADIUS : 1) * filterScale;
  // Past the tap ceiling, step the kernel across the footprint instead of sampling every texel. `stride`
  // stays 1 for every ratio a real resize uses.
  const stride = Math.max(1, Math.ceil((2 * support) / MAX_TAPS_PER_AXIS));

  const weights: (readonly ResampleTap[])[] = [];
  let maxTaps = 0;
  for (let d = 0; d < dstLen; d++) {
    const centre = srcStart + (d + 0.5) * scale;
    const first = Math.ceil(centre - support - 0.5);
    const last = Math.floor(centre + support - 0.5);
    const taps: ResampleTap[] = [];
    let sum = 0;
    for (let s = first; s <= last; s += stride) {
      const weight = kernel((s + 0.5 - centre) / filterScale);
      if (weight === 0) continue;
      taps.push({ index: s < 0 ? 0 : s > srcLen - 1 ? srcLen - 1 : s, weight });
      sum += weight;
    }
    // A kernel whose taps cancel (only possible for a degenerate span) falls back to the nearest texel.
    if (taps.length === 0 || sum === 0) {
      const nearest = Math.min(srcLen - 1, Math.max(0, Math.round(centre - 0.5)));
      weights.push([{ index: nearest, weight: 1 }]);
      maxTaps = Math.max(maxTaps, 1);
      continue;
    }
    const normalized = taps.map((t) => ({ index: t.index, weight: t.weight / sum }));
    weights.push(normalized);
    maxTaps = Math.max(maxTaps, normalized.length);
  }
  return { weights, ...flattenTaps(weights), scale, support, maxTaps };
}

function flattenTaps(weights: readonly (readonly ResampleTap[])[]): {
  tapOffsets: Int32Array;
  tapIndices: Int32Array;
  tapWeights: Float32Array;
} {
  let total = 0;
  for (const taps of weights) total += taps.length;
  const tapOffsets = new Int32Array(weights.length + 1);
  const tapIndices = new Int32Array(total);
  const tapWeights = new Float32Array(total);
  let at = 0;
  for (let d = 0; d < weights.length; d++) {
    tapOffsets[d] = at;
    for (const tap of weights[d] as readonly ResampleTap[]) {
      tapIndices[at] = tap.index;
      tapWeights[at] = tap.weight;
      at++;
    }
  }
  tapOffsets[weights.length] = at;
  return { tapOffsets, tapIndices, tapWeights };
}

/**
 * Resample a tightly-packed RGBA8 region with {@link planResampleAxis} weights, separably: a horizontal
 * pass into a float scratch buffer, then a vertical pass out of it. Separable costs `tapsX + tapsY` reads
 * per output pixel instead of `tapsX * tapsY`, which is what makes a 10:1 reduction affordable.
 *
 * Intermediates stay in float so the horizontal pass does not quantise before the vertical one; only the
 * final write rounds. Channels are filtered independently (straight, non-premultiplied RGBA — the same
 * convention the previous bilinear path used).
 */
export function resampleRgbaRegion(
  src: { readonly data: Uint8ClampedArray; readonly width: number; readonly height: number },
  axisX: ResampleAxisPlan,
  axisY: ResampleAxisPlan,
): { data: Float32Array; width: number; height: number } {
  const dstW = axisX.weights.length;
  const dstH = axisY.weights.length;
  const srcW = src.width;
  const srcH = src.height;
  const data = src.data;
  const xOffsets = axisX.tapOffsets;
  const xIndices = axisX.tapIndices;
  const xWeights = axisX.tapWeights;

  // Horizontal pass, row-major so the source row and the destination row both stay in cache.
  const horizontal = new Float32Array(dstW * srcH * 4);
  for (let y = 0; y < srcH; y++) {
    const rowBase = y * srcW * 4;
    const outBase = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const end = xOffsets[x + 1] as number;
      for (let t = xOffsets[x] as number; t < end; t++) {
        const o = rowBase + (xIndices[t] as number) * 4;
        const w = xWeights[t] as number;
        r += (data[o] as number) * w;
        g += (data[o + 1] as number) * w;
        b += (data[o + 2] as number) * w;
        a += (data[o + 3] as number) * w;
      }
      const q = outBase + x * 4;
      horizontal[q] = r;
      horizontal[q + 1] = g;
      horizontal[q + 2] = b;
      horizontal[q + 3] = a;
    }
  }

  // Vertical pass: each destination row accumulates whole intermediate rows one tap at a time, so the
  // inner loop is a contiguous multiply-add over `dstW * 4` floats.
  const yOffsets = axisY.tapOffsets;
  const yIndices = axisY.tapIndices;
  const yWeights = axisY.tapWeights;
  const rowLen = dstW * 4;
  const out = new Float32Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const outBase = y * rowLen;
    const end = yOffsets[y + 1] as number;
    for (let t = yOffsets[y] as number; t < end; t++) {
      const inBase = (yIndices[t] as number) * rowLen;
      const w = yWeights[t] as number;
      for (let i = 0; i < rowLen; i++) {
        out[outBase + i] = (out[outBase + i] as number) + (horizontal[inBase + i] as number) * w;
      }
    }
  }
  return { data: out, width: dstW, height: dstH };
}
