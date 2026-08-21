/**
 * Node-side validation for the GPU video filter drivers. The full pixel render runs only in the browser
 * harness (WebGPU/VideoFrame/OffscreenCanvas cannot be faked, and faking them is banned), so here we test
 * the **pure geometry** exhaustively (the substrate-independent math that decides which texels land where)
 * plus the drivers' Node-observable contract surface: honest `supports()` in a headless env, typed errors
 * for unsupported specs, the spec→recipe dispatch, and registration.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilterSpec } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import {
  type Affine,
  applyAffine,
  cropBlit,
  flipGeometry,
  padBlit,
  resizeBlit,
  rotateGeometry,
} from './geometry.ts';
import {
  COLOR_UNIFORM_BYTES,
  type ColorPlan,
  type ColorSpaceId,
  type Mat3,
  type SourceColor,
  type TransferId,
  applyMat3,
  applyTonemap,
  eotf,
  gamutMatrix,
  isDisplayColorSpace,
  oetf,
  packColorUniforms,
  parseColorSpace,
  planColorspace,
  planTonemap,
  rgbToXyz,
  tonemapHable,
  tonemapReinhard,
  xyzToRgb,
} from './gpu-uniforms.ts';
import {
  GpuVideoFilterModule,
  RESAMPLE_UNIFORM_BYTES,
  WEBGPU_CANVAS_ALPHA_MODE,
  WEBGPU_COLOR_SHADER_SOURCE,
  WEBGPU_GEOMETRY_SHADER_SOURCE,
  WEBGPU_RESAMPLE_H_SHADER_SOURCE,
  WEBGPU_RESAMPLE_V_SHADER_SOURCE,
  blitScales,
  canDeferFullFrameScale,
  canvas2dVideoFilterDriver,
  classifyExternalTextureAlphaSample,
  mapVideoColorSpace,
  packResampleUniforms,
  planColor,
  planDraw,
  premultiplyWebGpuCanvasRgba,
  rotatePackedI420By180,
  webgpuGeometryNeedsCanvasColorManagement,
  webgpuVideoFilterDriver,
} from './gpu-video.ts';

describe('WebGPU premultiplied canvas boundary', () => {
  it('premultiplies translucent straight-alpha RGBA while preserving alpha', () => {
    expect(premultiplyWebGpuCanvasRgba([0.8, 0.4, 0.2, 0.5])).toEqual([0.4, 0.2, 0.1, 0.5]);
    expect(premultiplyWebGpuCanvasRgba([0.25, 0.5, 0.75, 0])).toEqual([0, 0, 0, 0]);
    expect(premultiplyWebGpuCanvasRgba([0.25, 0.5, 0.75, 1])).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('pins the premultiplied canvas mode and both fragment shaders to the probed conversion', () => {
    expect(WEBGPU_CANVAS_ALPHA_MODE).toBe('premultiplied');
    // Both canvas-facing pipelines share the premultiply helper; each consults the probed convention.
    for (const source of [WEBGPU_GEOMETRY_SHADER_SOURCE, WEBGPU_COLOR_SHADER_SOURCE]) {
      expect(source).toContain('return vec4<f32>(c.rgb * c.a, c.a);');
      expect(source).toContain('premultiply_for_canvas(');
    }
    expect(WEBGPU_GEOMETRY_SHADER_SOURCE).toContain('canvas_alpha(c, u.srcPremul.x)');
    expect(WEBGPU_COLOR_SHADER_SOURCE).toContain(
      'return premultiply_for_canvas(vec4<f32>(outRgb, c.a));',
    );
  });
});

describe('external-texture alpha-convention probe (pure decision)', () => {
  const straight: readonly [number, number, number] = [200 / 255, 160 / 255, 80 / 255];
  const premultiplied: readonly [number, number, number] = [
    (200 * 128) / 65025,
    (160 * 128) / 65025,
    (80 * 128) / 65025,
  ];

  it('classifies a straight-alpha readback as straight', () => {
    expect(classifyExternalTextureAlphaSample(straight, straight, premultiplied)).toBe('straight');
  });

  it('classifies a premultiplied readback as premultiplied', () => {
    expect(classifyExternalTextureAlphaSample(premultiplied, straight, premultiplied)).toBe(
      'premultiplied',
    );
  });

  it('is exact at the boundary and robust to f32 sampling dust', () => {
    // A sample equidistant from both conventions resolves to 'straight' (the <= tie-break), and tiny
    // noise around either convention must not flip the answer.
    expect(classifyExternalTextureAlphaSample(straight, straight, premultiplied)).toBe('straight');
    const dust = 1 / 255;
    expect(
      classifyExternalTextureAlphaSample(
        [premultiplied[0] + dust, premultiplied[1], premultiplied[2]],
        straight,
        premultiplied,
      ),
    ).toBe('premultiplied');
  });

  it('wires the probed flag through every canvas-facing shader write', () => {
    // The geometry quad and the resample vertical pass forward sampled premultiplied RGB untouched;
    // the colour pipeline un-premultiplies before its transfer math. Each must consult srcPremul.
    expect(WEBGPU_GEOMETRY_SHADER_SOURCE).toContain('canvas_alpha(c, u.srcPremul.x)');
    expect(WEBGPU_RESAMPLE_V_SHADER_SOURCE).toContain(
      'canvas_alpha(clamp(acc / wsum, vec4<f32>(0.0), vec4<f32>(1.0)), r.srcPremul.x)',
    );
    expect(WEBGPU_COLOR_SHADER_SOURCE).toContain('u.alpha.x > 0.5');
    // The shared helper must skip the multiply under the probed convention.
    expect(WEBGPU_GEOMETRY_SHADER_SOURCE).toContain(
      'select(premultiply_for_canvas(c), c, srcPremul > 0.5)',
    );
  });
});

describe('band-limited resample — GPU-side contract', () => {
  it('routes only density-changing blits to the two-pass resampler', () => {
    const scaling = resizeBlit(1920, 1080, {
      mediaType: 'video',
      type: 'resize',
      width: 640,
      height: 360,
    });
    expect(blitScales(scaling)).toBe(true);
    // A crop moves texels but does not change their density — the cheap one-pass quad still applies.
    expect(
      blitScales(
        cropBlit(1920, 1080, {
          mediaType: 'video',
          type: 'crop',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        }),
      ),
    ).toBe(false);
    // A 1:1 'resize' is likewise a copy.
    expect(
      blitScales(
        resizeBlit(640, 360, { mediaType: 'video', type: 'resize', width: 640, height: 360 }),
      ),
    ).toBe(false);
  });

  it('packs the per-axis uniforms + alpha flag on their own 48-byte ArrayBuffer (writeBuffer-safe)', () => {
    const buf = packResampleUniforms(0, 1920, 640, 1920, 0, 1);
    expect(buf.byteLength).toBe(RESAMPLE_UNIFORM_BYTES);
    expect(buf.byteLength).toBe(48);
    const f = new Float32Array(buf);
    expect(f[0]).toBe(0); // srcStart
    expect(f[1]).toBe(1920); // srcSpan
    expect(f[2]).toBe(3); // scale
    expect(f[3]).toBe(3); // filterScale — widened by the reduction
    expect(f[4]).toBe(6); // support = 2 * filterScale
    expect(f[5]).toBe(1920); // srcLen
    expect(f[6]).toBe(640); // dstLen
    expect(f[7]).toBe(0); // otherStart
    expect(f[8]).toBe(1); // srcPremul (probed external-texture convention)
  });

  it('does not widen the kernel for magnification or 1:1', () => {
    for (const [span, dst] of [
      [640, 1280],
      [640, 640],
    ] as const) {
      const f = new Float32Array(packResampleUniforms(0, span, dst, span, 0, 0));
      expect(f[3]).toBe(1); // filterScale pinned
      expect(f[4]).toBe(1); // tent radius, not the Catmull-Rom 2
    }
  });

  it('carries the source sub-rect through, so crop-and-scale stays one pass', () => {
    const f = new Float32Array(packResampleUniforms(420, 1080, 100, 1920, 55, 0));
    expect(f[0]).toBe(420);
    expect(f[1]).toBe(1080);
    expect(f[7]).toBe(55);
    expect(f[5]).toBe(1920); // clamp bound stays the full texture extent
  });

  it('pins the WGSL kernel to the same Catmull-Rom the CPU driver uses', () => {
    // Both shaders must carry the identical polynomial; a divergence here silently desynchronizes the
    // substrates, which no Node test of the TS side alone would catch.
    for (const source of [WEBGPU_RESAMPLE_H_SHADER_SOURCE, WEBGPU_RESAMPLE_V_SHADER_SOURCE]) {
      expect(source).toContain('return 1.5 * x3 - 2.5 * x2 + 1.0;');
      expect(source).toContain('return -0.5 * x3 + 2.5 * x2 - 4.0 * x + 2.0;');
      // …and must select the tent when the axis is not reducing, matching planResampleAxis().
      expect(source).toContain('if (r.scale > 1.0) { return catrom(t); }');
      expect(source).toContain('return select(0.0, 1.0 - x, x < 1.0);');
      expect(source).toContain('@vertex');
      expect(source).toContain('@fragment');
    }
  });

  it('keeps the horizontal pass unpremultiplied and defers the canvas write to the probed convention', () => {
    expect(WEBGPU_RESAMPLE_H_SHADER_SOURCE).not.toContain('premultiply_for_canvas');
    expect(WEBGPU_RESAMPLE_H_SHADER_SOURCE).not.toContain('canvas_alpha');
    expect(WEBGPU_RESAMPLE_V_SHADER_SOURCE).toContain('canvas_alpha(');
  });

  it('samples the external texture in the first pass and loads texels exactly in the second', () => {
    expect(WEBGPU_RESAMPLE_H_SHADER_SOURCE).toContain('texture_external');
    expect(WEBGPU_RESAMPLE_H_SHADER_SOURCE).toContain('textureSampleBaseClampToEdge');
    // The vertical pass must not re-filter its input: textureLoad reads the intermediate texel exactly.
    expect(WEBGPU_RESAMPLE_V_SHADER_SOURCE).toContain('textureLoad');
    expect(WEBGPU_RESAMPLE_V_SHADER_SOURCE).not.toContain('textureSampleBaseClampToEdge');
  });
});

describe('rotatePackedI420By180', () => {
  it('reverses luma and both chroma planes independently', () => {
    // 4×2 I420: 8 Y samples, then 2 U and 2 V samples.
    const data = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 20, 21]);
    rotatePackedI420By180(data, 4, 2);
    expect([...data]).toEqual([7, 6, 5, 4, 3, 2, 1, 0, 11, 10, 21, 20]);
  });

  it('rejects invalid dimensions and non-packed buffers', () => {
    expect(() => rotatePackedI420By180(new Uint8Array(1), 0, 2)).toThrow(InputError);
    expect(() => rotatePackedI420By180(new Uint8Array(11), 4, 2)).toThrow(InputError);
  });
});

type Corner = readonly [number, number];
interface Corners {
  readonly tl: Corner;
  readonly tr: Corner;
  readonly br: Corner;
  readonly bl: Corner;
}

/** Map the four source corners through an affine, rounding to integers for exact corner assertions. */
function corners(t: Affine, srcW: number, srcH: number): Corners {
  const r = (p: Corner): Corner => [Math.round(p[0]), Math.round(p[1])];
  return {
    tl: r(applyAffine(t, 0, 0)),
    tr: r(applyAffine(t, srcW, 0)),
    br: r(applyAffine(t, srcW, srcH)),
    bl: r(applyAffine(t, 0, srcH)),
  };
}

// ============ resize geometry ============

describe('resizeBlit — fit modes', () => {
  it('fill stretches the whole source over the whole output (aspect not preserved)', () => {
    const b = resizeBlit(1920, 1080, {
      mediaType: 'video',
      type: 'resize',
      width: 100,
      height: 100,
    });
    expect(b.dims).toEqual({ width: 100, height: 100 });
    expect(b.src).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(b.dst).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('fill is the default fit', () => {
    const b = resizeBlit(640, 480, { mediaType: 'video', type: 'resize', width: 320, height: 240 });
    expect(b.dst).toEqual({ x: 0, y: 0, width: 320, height: 240 });
    expect(b.src).toEqual({ x: 0, y: 0, width: 640, height: 480 });
  });

  it('contain preserves aspect and letterboxes inside the box (16:9 → square)', () => {
    const b = resizeBlit(1920, 1080, {
      mediaType: 'video',
      type: 'resize',
      width: 100,
      height: 100,
      fit: 'contain',
    });
    // scale = min(100/1920, 100/1080) = 100/1920 → drawn 100 × 56, centred vertically.
    expect(b.dims).toEqual({ width: 100, height: 100 });
    expect(b.src).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(b.dst.width).toBe(100);
    expect(b.dst.height).toBe(56); // round(1080 * 100/1920) = round(56.25)
    expect(b.dst.x).toBe(0);
    expect(b.dst.y).toBe(22); // floor((100 - 56) / 2)
  });

  it('splits an odd contain remainder evenly instead of biasing the trailing bar', () => {
    const b = resizeBlit(1080, 1920, {
      mediaType: 'video',
      type: 'resize',
      width: 1280,
      height: 720,
      fit: 'contain',
    });
    expect(b.dst).toEqual({ x: 437.5, y: 0, width: 405, height: 720 });
  });

  it('cover preserves aspect and crops the centred overflow from the source (16:9 → square)', () => {
    const b = resizeBlit(1920, 1080, {
      mediaType: 'video',
      type: 'resize',
      width: 100,
      height: 100,
      fit: 'cover',
    });
    // scale = max(100/1920, 100/1080) = 100/1080 → crop a centred 1080×1080 square, draw to full 100×100.
    expect(b.dims).toEqual({ width: 100, height: 100 });
    expect(b.dst).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(b.src.width).toBe(1080); // round(100 / (100/1080)) = 1080
    expect(b.src.height).toBe(1080);
    expect(b.src.x).toBe(420); // floor((1920 - 1080) / 2)
    expect(b.src.y).toBe(0);
  });

  it('cover of a portrait source into a landscape box crops top/bottom', () => {
    const b = resizeBlit(1080, 1920, {
      mediaType: 'video',
      type: 'resize',
      width: 200,
      height: 100,
      fit: 'cover',
    });
    // scale = max(200/1080, 100/1920) = 200/1080 → crop a centred 1080×540 region.
    expect(b.src.width).toBe(1080);
    expect(b.src.height).toBe(540); // round(100 / (200/1080))
    expect(b.src.x).toBe(0);
    expect(b.src.y).toBe(690); // floor((1920 - 540) / 2)
    expect(b.dst).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it('contain/cover of an equal-aspect target is a plain rescale (no bars, no crop)', () => {
    for (const fit of ['contain', 'cover'] as const) {
      const b = resizeBlit(1920, 1080, {
        mediaType: 'video',
        type: 'resize',
        width: 960,
        height: 540,
        fit,
      });
      expect(b.src).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
      expect(b.dst).toEqual({ x: 0, y: 0, width: 960, height: 540 });
    }
  });

  it('upscales (target larger than source)', () => {
    const b = resizeBlit(320, 240, {
      mediaType: 'video',
      type: 'resize',
      width: 1280,
      height: 960,
    });
    expect(b.dst).toEqual({ x: 0, y: 0, width: 1280, height: 960 });
  });

  it('handles a 1×1 source and a 1×1 target', () => {
    const b = resizeBlit(1, 1, { mediaType: 'video', type: 'resize', width: 1, height: 1 });
    expect(b.dims).toEqual({ width: 1, height: 1 });
    expect(b.dst).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('contain never produces a zero-size draw rect for extreme aspect ratios', () => {
    const b = resizeBlit(1000, 1, {
      mediaType: 'video',
      type: 'resize',
      width: 10,
      height: 100,
      fit: 'contain',
    });
    expect(b.dst.width).toBeGreaterThanOrEqual(1);
    expect(b.dst.height).toBeGreaterThanOrEqual(1);
  });

  it('cover never produces a zero-size source crop for extreme aspect ratios', () => {
    const b = resizeBlit(1000, 1, {
      mediaType: 'video',
      type: 'resize',
      width: 10,
      height: 100,
      fit: 'cover',
    });
    expect(b.src.width).toBeGreaterThanOrEqual(1);
    expect(b.src.height).toBeGreaterThanOrEqual(1);
    expect(b.src.width).toBeLessThanOrEqual(1000);
    expect(b.src.height).toBeLessThanOrEqual(1);
  });

  it('rejects non-positive or non-integer target dimensions', () => {
    const base = { mediaType: 'video', type: 'resize' } as const;
    expect(() => resizeBlit(100, 100, { ...base, width: 0, height: 10 })).toThrow(InputError);
    expect(() => resizeBlit(100, 100, { ...base, width: 10, height: -5 })).toThrow(InputError);
    expect(() => resizeBlit(100, 100, { ...base, width: 10.5, height: 10 })).toThrow(InputError);
  });

  it('rejects an invalid source size', () => {
    expect(() =>
      resizeBlit(0, 100, { mediaType: 'video', type: 'resize', width: 10, height: 10 }),
    ).toThrow(InputError);
  });
});

describe('canDeferFullFrameScale — native-surface resize boundary', () => {
  const source = { displayWidth: 1920, displayHeight: 1080 };

  it('defers full-source/full-destination resize for fill and equal-aspect fit modes', () => {
    for (const target of [
      [320, 180],
      [1920, 1080],
      [3840, 2160],
    ] as const) {
      for (const fit of [undefined, 'contain', 'cover'] as const) {
        expect(
          canDeferFullFrameScale(
            source,
            planDraw(
              {
                mediaType: 'video',
                type: 'resize',
                width: target[0],
                height: target[1],
                ...(fit === undefined ? {} : { fit }),
              },
              source.displayWidth,
              source.displayHeight,
            ),
          ),
          `${target[0]}x${target[1]} ${String(fit)}`,
        ).toBe(true);
      }
    }
  });

  it('retains colour-managed rendering for legacy SD YUV matrices', () => {
    const recipe = planDraw(
      { mediaType: 'video', type: 'resize', width: 320, height: 180 },
      source.displayWidth,
      source.displayHeight,
    );
    for (const matrix of ['smpte170m', 'bt470bg'] as const) {
      expect(canDeferFullFrameScale({ ...source, colorSpace: { matrix } }, recipe)).toBe(false);
    }
    for (const matrix of ['bt709', 'rgb', null] as const) {
      expect(canDeferFullFrameScale({ ...source, colorSpace: { matrix } }, recipe)).toBe(true);
    }
  });

  it('retains rendering when contain needs bars or cover needs a source crop', () => {
    for (const fit of ['contain', 'cover'] as const) {
      expect(
        canDeferFullFrameScale(
          source,
          planDraw(
            { mediaType: 'video', type: 'resize', width: 320, height: 320, fit },
            source.displayWidth,
            source.displayHeight,
          ),
        ),
      ).toBe(false);
    }
  });

  it('retains rendering for a fill that changes display aspect ratio', () => {
    expect(
      canDeferFullFrameScale(
        { displayWidth: 1080, displayHeight: 1920 },
        planDraw({ mediaType: 'video', type: 'resize', width: 1280, height: 720 }, 1080, 1920),
      ),
    ).toBe(false);
  });

  it('retains rendering for crop, pad, rotate, flip and colour recipes', () => {
    const recipes = [
      planDraw(
        { mediaType: 'video', type: 'crop', x: 10, y: 10, width: 320, height: 180 },
        source.displayWidth,
        source.displayHeight,
      ),
      planDraw(
        { mediaType: 'video', type: 'pad', x: 64, y: 36, width: 2048, height: 1152 },
        source.displayWidth,
        source.displayHeight,
      ),
      planDraw(
        { mediaType: 'video', type: 'rotate', degrees: 90 },
        source.displayWidth,
        source.displayHeight,
      ),
      planDraw(
        { mediaType: 'video', type: 'flip', axis: 'h' },
        source.displayWidth,
        source.displayHeight,
      ),
      {
        kind: 'color' as const,
        plan: planColor(
          { mediaType: 'video', type: 'colorspace', to: 'bt709' },
          { primaries: 'bt709', transfer: 'bt709' },
        ),
        dims: { width: source.displayWidth, height: source.displayHeight },
      },
    ];
    for (const recipe of recipes) expect(canDeferFullFrameScale(source, recipe)).toBe(false);
  });
});

// ============ pad geometry ============

describe('padBlit — exact placement on a larger transparent canvas', () => {
  it('centers by default with deterministic floor placement for odd remainders', () => {
    const blit = padBlit(2, 1, {
      mediaType: 'video',
      type: 'pad',
      width: 5,
      height: 4,
      x: 1,
      y: 1,
    });
    expect(blit).toEqual({
      dims: { width: 5, height: 4 },
      src: { x: 0, y: 0, width: 2, height: 1 },
      dst: { x: 1, y: 1, width: 2, height: 1 },
    });
  });

  it('honors an explicit in-bounds placement without scaling', () => {
    expect(
      padBlit(2, 1, { mediaType: 'video', type: 'pad', width: 5, height: 4, x: 3, y: 0 }),
    ).toMatchObject({ dst: { x: 3, y: 0, width: 2, height: 1 } });
  });

  it('rejects shrinking, fractional dimensions, and out-of-bounds offsets', () => {
    expect(() =>
      padBlit(2, 2, { mediaType: 'video', type: 'pad', width: 1, height: 2, x: 0, y: 0 }),
    ).toThrow(InputError);
    expect(() =>
      padBlit(2, 2, {
        mediaType: 'video',
        type: 'pad',
        width: 3.5,
        height: 3,
        x: 0,
        y: 0,
      }),
    ).toThrow(InputError);
    expect(() =>
      padBlit(2, 2, { mediaType: 'video', type: 'pad', width: 3, height: 3, x: 2, y: 0 }),
    ).toThrow(InputError);
  });

  it('dispatches through the shared GPU/Canvas draw recipe', () => {
    expect(
      planDraw({ mediaType: 'video', type: 'pad', width: 4, height: 3, x: 1, y: 1 }, 2, 1),
    ).toEqual({
      kind: 'blit',
      blit: {
        dims: { width: 4, height: 3 },
        src: { x: 0, y: 0, width: 2, height: 1 },
        dst: { x: 1, y: 1, width: 2, height: 1 },
      },
    });
  });
});

// ============ crop geometry ============

describe('cropBlit — bounds & validation', () => {
  it('copies an in-bounds sub-rectangle 1:1 into a same-size output', () => {
    const b = cropBlit(1920, 1080, {
      mediaType: 'video',
      type: 'crop',
      x: 100,
      y: 50,
      width: 640,
      height: 360,
    });
    expect(b.dims).toEqual({ width: 640, height: 360 });
    expect(b.src).toEqual({ x: 100, y: 50, width: 640, height: 360 });
    expect(b.dst).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });

  it('allows a crop flush against the right/bottom edge', () => {
    const b = cropBlit(100, 100, {
      mediaType: 'video',
      type: 'crop',
      x: 60,
      y: 60,
      width: 40,
      height: 40,
    });
    expect(b.src).toEqual({ x: 60, y: 60, width: 40, height: 40 });
  });

  it('rejects a rect that overflows the source bounds', () => {
    const base = { mediaType: 'video', type: 'crop' } as const;
    expect(() => cropBlit(100, 100, { ...base, x: 80, y: 0, width: 40, height: 10 })).toThrow(
      InputError,
    );
    expect(() => cropBlit(100, 100, { ...base, x: 0, y: 80, width: 10, height: 40 })).toThrow(
      InputError,
    );
  });

  it('rejects negative origin', () => {
    expect(() =>
      cropBlit(100, 100, { mediaType: 'video', type: 'crop', x: -1, y: 0, width: 10, height: 10 }),
    ).toThrow(InputError);
  });

  it('rejects zero/negative or non-integer crop sizes', () => {
    const base = { mediaType: 'video', type: 'crop', x: 0, y: 0 } as const;
    expect(() => cropBlit(100, 100, { ...base, width: 0, height: 10 })).toThrow(InputError);
    expect(() => cropBlit(100, 100, { ...base, width: 10, height: 0 })).toThrow(InputError);
    expect(() => cropBlit(100, 100, { ...base, width: 10.5, height: 10 })).toThrow(InputError);
  });
});

// ============ rotate geometry ============

describe('rotateGeometry — dimension swap & corner mapping', () => {
  it('0° is identity, dims unchanged', () => {
    const r = rotateGeometry(1920, 1080, 0);
    expect(r.dims).toEqual({ width: 1920, height: 1080 });
    expect(corners(r.transform, 1920, 1080)).toEqual({
      tl: [0, 0],
      tr: [1920, 0],
      br: [1920, 1080],
      bl: [0, 1080],
    });
  });

  it('90° CW swaps dims and rotates the corners clockwise', () => {
    const r = rotateGeometry(1920, 1080, 90);
    expect(r.dims).toEqual({ width: 1080, height: 1920 });
    // Top-left of source becomes the top-right of the output; bottom-left becomes the top-left.
    expect(corners(r.transform, 1920, 1080)).toEqual({
      tl: [1080, 0],
      tr: [1080, 1920],
      br: [0, 1920],
      bl: [0, 0],
    });
  });

  it('180° keeps dims and flips corners diagonally', () => {
    const r = rotateGeometry(1920, 1080, 180);
    expect(r.dims).toEqual({ width: 1920, height: 1080 });
    expect(corners(r.transform, 1920, 1080)).toEqual({
      tl: [1920, 1080],
      tr: [0, 1080],
      br: [0, 0],
      bl: [1920, 0],
    });
  });

  it('270° CW swaps dims and rotates the corners counter-clockwise', () => {
    const r = rotateGeometry(1920, 1080, 270);
    expect(r.dims).toEqual({ width: 1080, height: 1920 });
    expect(corners(r.transform, 1920, 1080)).toEqual({
      tl: [0, 1920],
      tr: [0, 0],
      br: [1080, 0],
      bl: [1080, 1920],
    });
  });

  it('the output of each rotation is fully inside the declared output box', () => {
    for (const deg of [0, 90, 180, 270] as const) {
      const r = rotateGeometry(640, 480, deg);
      for (const p of Object.values(corners(r.transform, 640, 480))) {
        expect(p[0]).toBeGreaterThanOrEqual(0);
        expect(p[0]).toBeLessThanOrEqual(r.dims.width);
        expect(p[1]).toBeGreaterThanOrEqual(0);
        expect(p[1]).toBeLessThanOrEqual(r.dims.height);
      }
    }
  });

  it('two 90° rotations equal one 180° rotation (composition on corners)', () => {
    const once = rotateGeometry(640, 480, 90);
    // After one 90°, dims are 480×640; rotating that 90° again maps to the 180° corners of the original.
    const after90 = corners(once.transform, 640, 480);
    const twice = rotateGeometry(480, 640, 90);
    const composed = {
      tl: applyAffine(twice.transform, after90.tl[0], after90.tl[1]),
      br: applyAffine(twice.transform, after90.br[0], after90.br[1]),
    };
    const oneEighty = corners(rotateGeometry(640, 480, 180).transform, 640, 480);
    expect([Math.round(composed.tl[0]), Math.round(composed.tl[1])]).toEqual(oneEighty.tl);
    expect([Math.round(composed.br[0]), Math.round(composed.br[1])]).toEqual(oneEighty.br);
  });

  it('rejects an invalid source size', () => {
    expect(() => rotateGeometry(0, 10, 90)).toThrow(InputError);
  });
});

// ============ flip geometry ============

describe('flipGeometry — mirror axes', () => {
  it('horizontal flip mirrors left↔right, dims unchanged', () => {
    const r = flipGeometry(1920, 1080, 'h');
    expect(r.dims).toEqual({ width: 1920, height: 1080 });
    expect(corners(r.transform, 1920, 1080)).toEqual({
      tl: [1920, 0],
      tr: [0, 0],
      br: [0, 1080],
      bl: [1920, 1080],
    });
  });

  it('vertical flip mirrors top↔bottom, dims unchanged', () => {
    const r = flipGeometry(1920, 1080, 'v');
    expect(r.dims).toEqual({ width: 1920, height: 1080 });
    expect(corners(r.transform, 1920, 1080)).toEqual({
      tl: [0, 1080],
      tr: [1920, 1080],
      br: [1920, 0],
      bl: [0, 0],
    });
  });

  it('flipping the same axis twice is an identity round-trip on the corners', () => {
    for (const axis of ['h', 'v'] as const) {
      const once = flipGeometry(640, 480, axis);
      const round = corners(once.transform, 640, 480);
      const back = {
        tl: applyAffine(once.transform, round.tl[0], round.tl[1]),
        br: applyAffine(once.transform, round.br[0], round.br[1]),
      };
      expect([Math.round(back.tl[0]), Math.round(back.tl[1])]).toEqual([0, 0]);
      expect([Math.round(back.br[0]), Math.round(back.br[1])]).toEqual([640, 480]);
    }
  });

  it('rejects an invalid source size', () => {
    expect(() => flipGeometry(10, 0, 'h')).toThrow(InputError);
  });
});

describe('applyAffine', () => {
  it('maps a point with the documented a,b,c,d,e,f convention', () => {
    // 90° CW transform for a 4×2 source: (x,y) → (2 − y, x).
    const t: Affine = { a: 0, b: 1, c: -1, d: 0, e: 2, f: 0 };
    expect(applyAffine(t, 0, 0)).toEqual([2, 0]);
    expect(applyAffine(t, 4, 0)).toEqual([2, 4]);
    expect(applyAffine(t, 0, 2)).toEqual([0, 0]);
  });
});

// ============ driver spec→recipe dispatch ============

describe('planDraw — spec dispatch over the four geometric ops', () => {
  it('routes resize to a blit recipe', () => {
    const r = planDraw({ mediaType: 'video', type: 'resize', width: 64, height: 64 }, 128, 96);
    expect(r.kind).toBe('blit');
    if (r.kind === 'blit') expect(r.blit.dims).toEqual({ width: 64, height: 64 });
  });

  it('routes crop to a blit recipe', () => {
    const r = planDraw(
      { mediaType: 'video', type: 'crop', x: 0, y: 0, width: 32, height: 32 },
      128,
      96,
    );
    expect(r.kind).toBe('blit');
    if (r.kind === 'blit') expect(r.blit.src).toEqual({ x: 0, y: 0, width: 32, height: 32 });
  });

  it('routes rotate to an oriented recipe with the swapped dims', () => {
    const r = planDraw({ mediaType: 'video', type: 'rotate', degrees: 90 }, 128, 96);
    expect(r.kind).toBe('oriented');
    if (r.kind === 'oriented') expect(r.draw.dims).toEqual({ width: 96, height: 128 });
  });

  it('routes flip to an oriented recipe', () => {
    const r = planDraw({ mediaType: 'video', type: 'flip', axis: 'h' }, 128, 96);
    expect(r.kind).toBe('oriented');
    if (r.kind === 'oriented') expect(r.draw.dims).toEqual({ width: 128, height: 96 });
  });

  it('propagates a crop-out-of-bounds InputError from the recipe', () => {
    expect(() =>
      planDraw({ mediaType: 'video', type: 'crop', x: 200, y: 0, width: 10, height: 10 }, 128, 96),
    ).toThrow(InputError);
  });
});

// ============ driver contract surface (Node-observable) ============

/** Audio specs — never handled by these (video) drivers, regardless of environment. */
const AUDIO_SPECS: readonly FilterSpec[] = [
  { mediaType: 'audio', type: 'gain', db: 3 },
  { mediaType: 'audio', type: 'resample', sampleRate: 48000 },
  { mediaType: 'audio', type: 'remix', channels: 2 },
];

/** Colour specs the WebGPU driver handles; Canvas2D handles display-space colorspace plus Chromium tonemap. */
const WEBGPU_COLOR_SPECS: readonly FilterSpec[] = [
  { mediaType: 'video', type: 'colorspace', to: 'bt709' },
  { mediaType: 'video', type: 'colorspace', to: 'bt2020' },
];

const TONEMAP_SPEC: FilterSpec = { mediaType: 'video', type: 'tonemap', to: 'sdr' };

const COLOR_SPECS: readonly FilterSpec[] = [
  ...WEBGPU_COLOR_SPECS,
  { mediaType: 'video', type: 'tonemap', to: 'sdr' },
];

/** Colour specs Canvas2D can honestly handle (a UA-managed display-space passthrough). */
const CANVAS2D_COLOR_OK: readonly FilterSpec[] = [
  { mediaType: 'video', type: 'colorspace', to: 'bt709' },
  { mediaType: 'video', type: 'colorspace', to: 'srgb' },
];

/** Colour specs Canvas2D must decline without Chromium's colour-managed VideoFrame draw. */
const CANVAS2D_COLOR_DECLINE: readonly FilterSpec[] = [
  { mediaType: 'video', type: 'colorspace', to: 'bt2020' },
  { mediaType: 'video', type: 'colorspace', to: 'bt601' },
  { mediaType: 'video', type: 'tonemap', to: 'sdr' },
];

const GEOMETRIC: readonly FilterSpec[] = [
  { mediaType: 'video', type: 'resize', width: 10, height: 10 },
  { mediaType: 'video', type: 'crop', x: 0, y: 0, width: 5, height: 5 },
  { mediaType: 'video', type: 'rotate', degrees: 90 },
  { mediaType: 'video', type: 'flip', axis: 'v' },
];

describe('WebGPU geometric colour-management routing', () => {
  it('routes non-BT.709 YUV matrices through Canvas2D for UA colour-managed sampling', () => {
    expect(webgpuGeometryNeedsCanvasColorManagement({ matrix: 'smpte170m' })).toBe(true);
    expect(webgpuGeometryNeedsCanvasColorManagement({ matrix: 'bt470bg' })).toBe(true);
    expect(webgpuGeometryNeedsCanvasColorManagement({ matrix: 'bt709', fullRange: false })).toBe(
      true,
    );
  });

  it('keeps full-range/untagged BT.709, RGB, unknown, and absent matrices on the WebGPU fast path', () => {
    expect(webgpuGeometryNeedsCanvasColorManagement({ matrix: 'bt709', fullRange: true })).toBe(
      false,
    );
    expect(webgpuGeometryNeedsCanvasColorManagement({ matrix: 'bt709' })).toBe(false);
    expect(webgpuGeometryNeedsCanvasColorManagement({ matrix: 'rgb', fullRange: true })).toBe(
      false,
    );
    expect(webgpuGeometryNeedsCanvasColorManagement({ matrix: null })).toBe(false);
    expect(webgpuGeometryNeedsCanvasColorManagement(undefined)).toBe(false);
  });
});

describe('FilterDriver identity & metadata', () => {
  it('webgpu driver declares the webgpu substrate and v1 api', () => {
    expect(webgpuVideoFilterDriver.kind).toBe('filter');
    expect(webgpuVideoFilterDriver.substrate).toBe('webgpu');
    expect(webgpuVideoFilterDriver.apiVersion).toBe(1);
    expect(webgpuVideoFilterDriver.id).toBe('webgpu-video-filter');
  });

  it('canvas2d driver declares the canvas2d substrate and v1 api', () => {
    expect(canvas2dVideoFilterDriver.kind).toBe('filter');
    expect(canvas2dVideoFilterDriver.substrate).toBe('canvas2d');
    expect(canvas2dVideoFilterDriver.apiVersion).toBe(1);
    expect(canvas2dVideoFilterDriver.id).toBe('canvas2d-video-filter');
  });

  it('the two drivers have distinct ids (so the registry keeps both)', () => {
    expect(webgpuVideoFilterDriver.id).not.toBe(canvas2dVideoFilterDriver.id);
  });
});

describe('supports() — honest in a headless (no GPU/canvas/VideoFrame) environment', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The node test runner exposes no browser pixel surface: no OffscreenCanvas/VideoFrame and no
  // navigator.gpu (a `navigator` shim may exist, but without `.gpu`). That is precisely what makes
  // `supports()` honestly return false below — so these assertions test real behavior, not a mock.
  const gpuPresent =
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { gpu?: unknown }).gpu !== 'undefined';

  it('this test process has no browser pixel APIs (no OffscreenCanvas/VideoFrame/WebGPU)', () => {
    expect(typeof OffscreenCanvas).toBe('undefined');
    expect(typeof VideoFrame).toBe('undefined');
    expect(gpuPresent).toBe(false);
  });

  it('webgpu supports() is false for every geometric spec when WebGPU is absent', () => {
    for (const spec of GEOMETRIC) expect(webgpuVideoFilterDriver.supports(spec)).toBe(false);
  });

  it('webgpu supports() is false for every colour spec when WebGPU is absent (env-gated, not handler-gated)', () => {
    for (const spec of COLOR_SPECS) expect(webgpuVideoFilterDriver.supports(spec)).toBe(false);
  });

  it('webgpu supports() is false on Firefox before probing navigator.gpu', () => {
    const firefoxNavigator: Partial<Navigator> = {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
    };
    vi.stubGlobal('navigator', firefoxNavigator);

    expect(
      webgpuVideoFilterDriver.supports({
        mediaType: 'video',
        type: 'resize',
        width: 320,
        height: 240,
      }),
    ).toBe(false);
  });

  it('canvas2d supports() is false for every geometric spec when OffscreenCanvas is absent', () => {
    for (const spec of GEOMETRIC) expect(canvas2dVideoFilterDriver.supports(spec)).toBe(false);
  });

  it('both drivers reject audio specs (these never depend on the environment)', () => {
    for (const spec of AUDIO_SPECS) {
      expect(webgpuVideoFilterDriver.supports(spec)).toBe(false);
      expect(canvas2dVideoFilterDriver.supports(spec)).toBe(false);
    }
  });
});

describe('createFilter() — typed rejection of specs the driver does not handle', () => {
  for (const driver of [webgpuVideoFilterDriver, canvas2dVideoFilterDriver]) {
    it(`${driver.id} throws CapabilityError for every audio spec`, () => {
      for (const spec of AUDIO_SPECS) {
        expect(() => driver.createFilter(spec)).toThrow(CapabilityError);
      }
    });
  }

  it('canvas2d throws CapabilityError for tonemap / wide-gamut colorspace without Chromium canvas colour management', () => {
    for (const spec of CANVAS2D_COLOR_DECLINE) {
      expect(() => canvas2dVideoFilterDriver.createFilter(spec)).toThrow(CapabilityError);
    }
  });

  it('canvas2d accepts tonemap on Chromium user agents after WebGPU declines it', () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/149' });
    try {
      expect(() => canvas2dVideoFilterDriver.createFilter(TONEMAP_SPEC)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('webgpu handles colorspace specs, including wide-gamut colorspace', () => {
    // createFilter is gated by the *handler* predicate, not the environment, so it builds a stream in Node
    // for any spec the driver claims (the router gates on supports() + availability separately).
    for (const spec of WEBGPU_COLOR_SPECS) {
      expect(() => webgpuVideoFilterDriver.createFilter(spec)).not.toThrow();
    }
  });

  it('webgpu declines tonemap so the router can try an honest HDR-capable fallback', () => {
    expect(() => webgpuVideoFilterDriver.createFilter(TONEMAP_SPEC)).toThrow(CapabilityError);
  });
});

describe('createFilter() — builds a TransformStream for a handled spec', () => {
  // Stream construction is synchronous and substrate-agnostic: it wires the Transformer + abort listener
  // but does NOT touch the GPU/canvas (the renderer is built lazily on the stream's `start`, which we do
  // not pump here). So this runs in Node, exercising the happy-path return without a browser.
  for (const driver of [webgpuVideoFilterDriver, canvas2dVideoFilterDriver]) {
    it(`${driver.id} returns readable+writable sides for each geometric op`, () => {
      for (const spec of GEOMETRIC) {
        const stream = driver.createFilter(spec);
        expect(stream).toBeInstanceOf(TransformStream);
        expect(stream.readable).toBeInstanceOf(ReadableStream);
        expect(stream.writable).toBeInstanceOf(WritableStream);
      }
    });

    it(`${driver.id} accepts StageOptions with an AbortSignal without starting the renderer`, () => {
      const controller = new AbortController();
      const stream = driver.createFilter(
        { mediaType: 'video', type: 'resize', width: 8, height: 8 },
        { signal: controller.signal },
      );
      expect(stream).toBeInstanceOf(TransformStream);
      // Aborting after construction must not throw synchronously (teardown rides the listener).
      expect(() => controller.abort()).not.toThrow();
    });
  }

  it('webgpu builds a TransformStream for each owned colour op', () => {
    for (const spec of WEBGPU_COLOR_SPECS) {
      const stream = webgpuVideoFilterDriver.createFilter(spec);
      expect(stream).toBeInstanceOf(TransformStream);
    }
  });

  it('canvas2d builds a TransformStream for a display-space colorspace op', () => {
    for (const spec of CANVAS2D_COLOR_OK) {
      const stream = canvas2dVideoFilterDriver.createFilter(spec);
      expect(stream).toBeInstanceOf(TransformStream);
    }
  });
});

describe('GpuVideoFilterModule — registration', () => {
  it('registers both filter substrates and only filters', () => {
    const added: { filters: string[]; others: number } = { filters: [], others: 0 };
    GpuVideoFilterModule.register({
      addFilter: (d) => {
        expect(d.kind).toBe('filter');
        added.filters.push(d.id);
      },
      addCodec: () => {
        added.others++;
      },
      addContainer: () => {
        added.others++;
      },
    });
    expect(added.filters).toEqual(['webgpu-video-filter', 'canvas2d-video-filter']);
    expect(added.others).toBe(0);
  });

  it('declares DRIVER_API_VERSION 1', () => {
    expect(GpuVideoFilterModule.apiVersion).toBe(1);
  });
});

// ============ colorspace + tonemap math (pure, real/can-fail — ADR-032) ============
//
// The GPU pixel render is browser-validated; here we lock the *math* the shader applies with falsifiable
// oracles: the gamut matrices against the published constants (sRGB/BT.709→XYZ, the 709/2020 luma rows,
// 2020↔709), the transfer curves (monotonic, black→0, SDR white→1, HDR peak→100/12, round-trip), the
// tonemap operators (monotonic, black→0, peak→1.0), and the spec→ColorPlan selection + VideoColorSpace
// mapping.

/** Assert two numbers are equal within `eps` (matrices/transfers are computed, not stored, so allow ULP). */
function near(a: number, b: number, eps = 1e-6): void {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
}
/** Assert a 3×3 equals an expected row-major matrix within `eps`. */
function nearMat(m: Mat3, expected: readonly number[], eps = 1e-6): void {
  for (let i = 0; i < 9; i++) near(m[i] ?? Number.NaN, expected[i] ?? Number.NaN, eps);
}

describe('gamut matrices — exact published values', () => {
  it('sRGB and BT.709 share primaries → RGB→XYZ is the canonical sRGB matrix', () => {
    // The published sRGB (D65) RGB→XYZ matrix.
    const expected = [
      0.4123908, 0.35758434, 0.18048079, 0.21263901, 0.71516868, 0.07219232, 0.01933082, 0.11919478,
      0.95053215,
    ];
    nearMat(rgbToXyz('srgb'), expected, 1e-6);
    nearMat(rgbToXyz('bt709'), expected, 1e-6);
  });

  it('the BT.709 luma row (Y) is (0.2126, 0.7152, 0.0722)', () => {
    const m = rgbToXyz('bt709');
    near(m[3] ?? Number.NaN, 0.2126, 5e-5);
    near(m[4] ?? Number.NaN, 0.7152, 5e-5);
    near(m[5] ?? Number.NaN, 0.0722, 5e-5);
  });

  it('the BT.2020 luma row (Y) is (0.2627, 0.6780, 0.0593)', () => {
    const m = rgbToXyz('bt2020');
    near(m[3] ?? Number.NaN, 0.2627, 5e-5);
    near(m[4] ?? Number.NaN, 0.678, 5e-5);
    near(m[5] ?? Number.NaN, 0.0593, 5e-5);
  });

  it('the BT.601/SMPTE-C luma row (Y) is (0.2124, 0.7011, 0.0866)', () => {
    const m = rgbToXyz('bt601');
    near(m[3] ?? Number.NaN, 0.2124, 5e-5);
    near(m[4] ?? Number.NaN, 0.7011, 5e-5);
    near(m[5] ?? Number.NaN, 0.0866, 5e-5);
  });

  it('BT.2020 → BT.709 is the published BT.2087 conversion matrix', () => {
    const expected = [
      1.660491, -0.58764114, -0.07284986, -0.12455047, 1.1328999, -0.00834942, -0.01815076,
      -0.1005789, 1.11872966,
    ];
    nearMat(gamutMatrix('bt2020', 'bt709'), expected, 1e-5);
  });

  it('a gamut matrix between identical primaries (sRGB↔BT.709) is exactly the identity', () => {
    expect(gamutMatrix('srgb', 'bt709')).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(gamutMatrix('bt709', 'srgb')).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(gamutMatrix('bt2020', 'bt2020')).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('xyzToRgb is the inverse of rgbToXyz (round-trips a unit RGB vector)', () => {
    for (const id of ['srgb', 'bt601', 'bt2020'] as const) {
      const fwd = rgbToXyz(id);
      const inv = xyzToRgb(id);
      const v: readonly [number, number, number] = [0.3, 0.6, 0.1];
      const round = applyMat3(inv, applyMat3(fwd, v));
      near(round[0], v[0], 1e-9);
      near(round[1], v[1], 1e-9);
      near(round[2], v[2], 1e-9);
    }
  });

  it('709→2020 then 2020→709 composes to the identity on a colour vector (gamut round-trip)', () => {
    const v: readonly [number, number, number] = [0.8, 0.2, 0.5];
    const wide = applyMat3(gamutMatrix('bt709', 'bt2020'), v);
    const back = applyMat3(gamutMatrix('bt2020', 'bt709'), wide);
    near(back[0], v[0], 1e-9);
    near(back[1], v[1], 1e-9);
    near(back[2], v[2], 1e-9);
  });

  it('a pure-red linear vector stays on the red axis under an identity gamut but not under 709→2020', () => {
    const red: readonly [number, number, number] = [1, 0, 0];
    expect(applyMat3(gamutMatrix('bt709', 'bt709'), red)).toEqual([1, 0, 0]);
    const wideRed = applyMat3(gamutMatrix('bt709', 'bt2020'), red);
    // BT.709 red sits inside BT.2020, so its 2020 coordinates gain small green/blue and < 1 red.
    expect(wideRed[0]).toBeLessThan(1);
    expect(wideRed[0]).toBeGreaterThan(0.5);
    expect(wideRed[1]).toBeGreaterThan(0);
    expect(wideRed[2]).toBeGreaterThan(0);
  });
});

describe('transfer functions — EOTF/OETF invariants', () => {
  const SDR_TRANSFERS: readonly TransferId[] = ['srgb', 'bt709', 'linear'];
  const HDR_TRANSFERS: ReadonlyArray<readonly [TransferId, number]> = [
    ['pq', 100],
    ['hlg', 12],
  ];
  const TRANSFERS: readonly TransferId[] = ['srgb', 'bt709', 'pq', 'hlg', 'linear'];

  it('SDR transfers map black→0 and diffuse white (1.0)→1.0', () => {
    for (const id of SDR_TRANSFERS) {
      near(oetf(id, 0), 0, 1e-6);
      near(oetf(id, 1), 1, 1e-6);
      near(eotf(id, 0), 0, 1e-6);
      near(eotf(id, 1), 1, 1e-6);
    }
  });

  it('HDR transfers decode code-value peak into SDR-white-relative linear units', () => {
    for (const [id, peak] of HDR_TRANSFERS) {
      near(eotf(id, 0), 0, 1e-6);
      near(eotf(id, 1), peak, 1e-5);
      near(oetf(id, 0), 0, 1e-6);
      near(oetf(id, peak), 1, 1e-6);
    }
  });

  it('every OETF is monotonically non-decreasing on [0,1]', () => {
    for (const id of TRANSFERS) {
      let prev = Number.NEGATIVE_INFINITY;
      for (let i = 0; i <= 256; i++) {
        const y = oetf(id, i / 256);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = y;
      }
    }
  });

  it('eotf is the inverse of oetf for each transfer in white-relative units', () => {
    const samples: Readonly<Record<TransferId, readonly number[]>> = {
      srgb: [0.05, 0.2, 0.5, 0.75, 0.9],
      bt709: [0.05, 0.2, 0.5, 0.75, 0.9],
      linear: [0.05, 0.2, 0.5, 0.75, 0.9],
      pq: [0.01, 0.5, 1, 10, 100],
      hlg: [0.01, 0.5, 1, 6, 12],
    };
    for (const id of TRANSFERS) {
      for (const x of samples[id]) {
        near(eotf(id, oetf(id, x)), x, 1e-5);
      }
    }
  });

  it('sRGB OETF matches the spec at the piecewise knee and mid-grey', () => {
    near(oetf('srgb', 0.0031308), 12.92 * 0.0031308, 1e-9); // linear segment boundary
    near(oetf('srgb', 1), 1, 1e-9);
    near(oetf('srgb', 0.18), 0.4613561, 1e-6); // 18% grey → ~0.461 sRGB
  });

  it('linear transfer is the identity', () => {
    for (const x of [0, 0.25, 0.5, 1]) {
      expect(eotf('linear', x)).toBe(x);
      expect(oetf('linear', x)).toBe(x);
    }
  });

  it('PQ decodes a mid code value to roughly SDR white in white-relative units', () => {
    // PQ packs 10000 nits into [0,1]; ~0.5 code is around the 100-nit SDR-white neighborhood.
    const lin = eotf('pq', 0.5);
    expect(lin).toBeGreaterThan(0.5);
    expect(lin).toBeLessThan(1);
  });

  it('HLG code 0.5 is the reference-white neighborhood and code 1.0 is the 12x peak', () => {
    near(eotf('hlg', 0.5), 1, 1e-6);
    near(eotf('hlg', 1), 12, 1e-6);
  });
});

describe('tonemap operators — HDR→SDR invariants', () => {
  const PEAKS = [2, 4, 10, 100];

  it('extended Reinhard fixes black at 0 and maps the source peak to exactly 1.0', () => {
    for (const peak of PEAKS) {
      expect(tonemapReinhard(0, peak)).toBe(0);
      near(tonemapReinhard(peak, peak), 1, 1e-9);
    }
  });

  it('Hable fixes black at 0 and maps the source peak to exactly 1.0', () => {
    for (const peak of PEAKS) {
      expect(tonemapHable(0, peak)).toBe(0);
      near(tonemapHable(peak, peak), 1, 1e-9);
    }
  });

  it('both operators are monotonically increasing on [0, peak] and never exceed 1.0', () => {
    for (const op of [tonemapReinhard, tonemapHable]) {
      for (const peak of PEAKS) {
        let prev = Number.NEGATIVE_INFINITY;
        for (let i = 0; i <= 200; i++) {
          const L = (peak * i) / 200;
          const y = op(L, peak);
          expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
          expect(y).toBeLessThanOrEqual(1 + 1e-9);
          prev = y;
        }
      }
    }
  });

  it('Reinhard lifts the mid-tones (mid input maps above the linear ratio)', () => {
    // Extended Reinhard, peak=4: f(x)=x(1+x/16)/(1+x); f(2)=0.75, f(4)=1.0 ⇒ R(2,4)=0.75.
    // At L = peak/2 the output (0.75) exceeds the naive linear ratio L/peak = 0.5 — the curve lifts mids.
    near(tonemapReinhard(2, 4), 0.75, 1e-9);
    expect(tonemapReinhard(2, 4)).toBeGreaterThan(0.5);
  });

  it('applyTonemap dispatches by the operator tag (the same selection the shader makes)', () => {
    expect(applyTonemap({ op: 'reinhard', peak: 4 }, 2)).toBe(tonemapReinhard(2, 4));
    expect(applyTonemap({ op: 'hable', peak: 4 }, 2)).toBe(tonemapHable(2, 4));
  });
});

describe('planColorspace / planTonemap — pipeline selection', () => {
  const src709: SourceColor = { primaries: 'bt709', transfer: 'bt709' };
  const srcPQ2020: SourceColor = { primaries: 'bt2020', transfer: 'pq' };

  it('709→709 colorspace is decode-709, identity gamut, no tonemap, encode-709', () => {
    const p = planColorspace(src709, 'bt709');
    expect(p.decode).toBe('bt709');
    expect(p.encode).toBe('bt709');
    expect(p.tonemap).toBeNull();
    expect(p.gamut).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('709→sRGB keeps the identity gamut but re-encodes to the sRGB transfer', () => {
    const p = planColorspace(src709, 'srgb');
    expect(p.gamut).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(p.encode).toBe('srgb');
  });

  it('709→2020 carries the real gamut matrix and a BT.709-decoded / BT.709-display plan', () => {
    const p = planColorspace(src709, 'bt2020');
    expect(p.decode).toBe('bt709');
    expect(p.encode).toBe('bt709');
    expect(p.tonemap).toBeNull();
    nearMat(p.gamut, gamutMatrix('bt709', 'bt2020'), 1e-12);
    expect(p.gamut).not.toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('tonemap of a PQ/2020 source decodes PQ, converts 2020→709, tonemaps to peak, encodes 709', () => {
    const p = planTonemap(srcPQ2020);
    expect(p.decode).toBe('pq');
    expect(p.encode).toBe('bt709');
    expect(p.tonemap).not.toBeNull();
    expect(p.tonemap?.op).toBe('reinhard');
    expect(p.tonemap?.peak).toBe(100);
    nearMat(p.gamut, gamutMatrix('bt2020', 'bt709'), 1e-12);
  });

  it('tonemap of an HLG source uses the 12x reference-white peak', () => {
    const p = planTonemap({ primaries: 'bt2020', transfer: 'hlg' });
    expect(p.decode).toBe('hlg');
    expect(p.tonemap?.peak).toBe(12);
  });

  it('tonemap of an already-SDR source (peak ≤ 1) collapses to a gamut-only pass (no operator)', () => {
    const p = planTonemap({ primaries: 'bt709', transfer: 'bt709' });
    expect(p.tonemap).toBeNull();
    expect(p.encode).toBe('bt709');
  });

  it("planColor starts colorspace math from WebGPU's normalized sRGB import representation", () => {
    const cs = planColor({ mediaType: 'video', type: 'colorspace', to: 'bt2020' }, src709);
    expect(cs).toEqual(planColorspace({ primaries: 'srgb', transfer: 'srgb' }, 'bt2020'));
    expect(cs.decode).toBe('srgb');

    // `importExternalTexture` has already converted both sources to sRGB. Reusing the original 601/709
    // tags here would apply their gamut/transfer a second time and make identical imported pixels diverge.
    const from601 = planColor(
      { mediaType: 'video', type: 'colorspace', to: 'bt2020' },
      { primaries: 'bt601', transfer: 'bt709' },
    );
    expect(from601).toEqual(cs);
  });

  it('planColor retains source metadata for tone-map and rejects an unknown colorspace target', () => {
    const tm = planColor({ mediaType: 'video', type: 'tonemap', to: 'sdr' }, srcPQ2020);
    expect(tm.tonemap).not.toBeNull();
    expect(tm.decode).toBe('pq');
    expect(() =>
      planColor({ mediaType: 'video', type: 'colorspace', to: 'not-a-space' }, src709),
    ).toThrow(InputError);
  });
});

describe('parseColorSpace — token aliases', () => {
  it('maps the common spellings to the canonical ColorSpaceId', () => {
    const cases: ReadonlyArray<readonly [string, ColorSpaceId]> = [
      ['bt709', 'bt709'],
      ['rec709', 'bt709'],
      ['709', 'bt709'],
      ['BT.709', 'bt709'],
      ['sRGB', 'srgb'],
      ['bt2020', 'bt2020'],
      ['rec2020', 'bt2020'],
      ['bt2020ncl', 'bt2020'],
      ['smpte170m', 'bt601'],
      ['bt601', 'bt601'],
      ['bt470bg', 'bt601'],
    ];
    for (const [token, id] of cases) expect(parseColorSpace(token)).toBe(id);
  });

  it('returns null for an unrecognized token (so callers decline rather than guess)', () => {
    expect(parseColorSpace('xyz-unknown')).toBeNull();
    expect(parseColorSpace('')).toBeNull();
  });

  it('isDisplayColorSpace is true only for srgb/bt709', () => {
    expect(isDisplayColorSpace('srgb')).toBe(true);
    expect(isDisplayColorSpace('bt709')).toBe(true);
    expect(isDisplayColorSpace('bt2020')).toBe(false);
    expect(isDisplayColorSpace('bt601')).toBe(false);
  });
});

describe('mapVideoColorSpace — VideoColorSpace → SourceColor', () => {
  it('maps known primaries/transfer tokens', () => {
    expect(mapVideoColorSpace({ primaries: 'bt2020', transfer: 'pq' })).toEqual({
      primaries: 'bt2020',
      transfer: 'pq',
    });
    expect(mapVideoColorSpace({ primaries: 'bt709', transfer: 'hlg' })).toEqual({
      primaries: 'bt709',
      transfer: 'hlg',
    });
    expect(mapVideoColorSpace({ primaries: 'smpte170m', transfer: 'smpte170m' })).toEqual({
      primaries: 'bt601',
      transfer: 'bt709',
    });
  });

  it('defaults missing/unknown primaries and transfer to BT.709 SDR', () => {
    expect(mapVideoColorSpace(null)).toEqual({ primaries: 'bt709', transfer: 'bt709' });
    expect(mapVideoColorSpace(undefined)).toEqual({ primaries: 'bt709', transfer: 'bt709' });
    expect(mapVideoColorSpace({ primaries: null, transfer: null })).toEqual({
      primaries: 'bt709',
      transfer: 'bt709',
    });
    expect(mapVideoColorSpace({ primaries: 'unknown', transfer: 'weird' })).toEqual({
      primaries: 'bt709',
      transfer: 'bt709',
    });
  });

  it('maps the iec61966-2-1 transfer to the sRGB curve', () => {
    expect(mapVideoColorSpace({ primaries: 'bt709', transfer: 'iec61966-2-1' }).transfer).toBe(
      'srgb',
    );
  });
});

describe('packColorUniforms — std140 layout', () => {
  const plan: ColorPlan = {
    decode: 'pq',
    gamut: gamutMatrix('bt2020', 'bt709'),
    tonemap: { op: 'reinhard', peak: 100 },
    encode: 'bt709',
  };

  it('produces an 80-byte buffer on its own ArrayBuffer (WebGPU writeBuffer-safe)', () => {
    const buf = packColorUniforms(plan, 0);
    expect(buf.byteLength).toBe(COLOR_UNIFORM_BYTES);
    expect(buf.byteLength).toBe(80);
    expect(buf.buffer.byteLength).toBe(80);
    expect(buf.byteOffset).toBe(0);
  });

  it('lays out the gamut matrix column-major with a 0 w-lane per column', () => {
    const m = plan.gamut;
    const buf = packColorUniforms(plan, 0);
    // Stored as f32, so compare the f32-rounded source values exactly (per the build's f32-pack convention).
    const f = (i: number): number => Math.fround(m[i] ?? Number.NaN);
    // column 0 = (m0, m3, m6), column 1 = (m1, m4, m7), column 2 = (m2, m5, m8).
    expect(buf[0]).toBe(f(0));
    expect(buf[1]).toBe(f(3));
    expect(buf[2]).toBe(f(6));
    expect(buf[3]).toBe(0);
    expect(buf[4]).toBe(f(1));
    expect(buf[5]).toBe(f(4));
    expect(buf[6]).toBe(f(7));
    expect(buf[7]).toBe(0);
    expect(buf[8]).toBe(f(2));
    expect(buf[9]).toBe(f(5));
    expect(buf[10]).toBe(f(8));
    expect(buf[11]).toBe(0);
  });

  it('packs the params vec4 as (decodeTag, encodeTag, tonemapTag, peak) and the alpha flag after it', () => {
    const buf = packColorUniforms(plan, 1);
    expect(buf[12]).toBe(3); // pq
    expect(buf[13]).toBe(2); // bt709
    expect(buf[14]).toBe(1); // reinhard
    expect(buf[15]).toBe(100); // peak
    expect(Array.from(buf.slice(16, 20))).toEqual([1, 0, 0, 0]); // (srcPremul, pad)
  });

  it('encodes a no-tonemap plan with tag 0 and peak 0', () => {
    const buf = packColorUniforms(
      {
        decode: 'bt709',
        gamut: gamutMatrix('bt709', 'bt709'),
        tonemap: null,
        encode: 'srgb',
      },
      0,
    );
    expect(buf[12]).toBe(2); // bt709 decode
    expect(buf[13]).toBe(1); // srgb encode
    expect(buf[14]).toBe(0); // no tonemap
    expect(buf[15]).toBe(0);
  });
});

describe('WebGPU device acquisition failure — the ranked Canvas2D rung still renders', () => {
  // A granted `navigator.gpu` is not a granted adapter. Headless Chromium, a GPU-blocklisted profile,
  // and a software-rendering container all expose WebGPU and hand back `null` from requestAdapter().
  // The transform must still run on the next ranked substrate instead of becoming unavailable.
  const RESIZE: FilterSpec = { mediaType: 'video', type: 'resize', width: 320, height: 240 };

  /** Load a pristine module instance: the "no adapter" verdict is realm state, not per-call state. */
  async function loadWithoutAdapter(): Promise<typeof import('./gpu-video.ts')> {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
      gpu: {
        requestAdapter: (): Promise<null> => Promise.resolve(null),
        getPreferredCanvasFormat: (): string => 'bgra8unorm',
      },
    });
    vi.stubGlobal('OffscreenCanvas', class StubOffscreenCanvas {});
    vi.stubGlobal('VideoFrame', class StubVideoFrame {});
    vi.resetModules();
    return await import('./gpu-video.ts');
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('starts the filter on Canvas2D and stops offering WebGPU once no adapter is granted', async () => {
    const mod = await loadWithoutAdapter();
    expect(mod.webgpuVideoFilterDriver.supports(RESIZE)).toBe(true);

    const stream = mod.webgpuVideoFilterDriver.createFilter(RESIZE);
    const writer = stream.writable.getWriter();
    // `close()` settles the transformer's `start()`: a failed acquisition would reject here.
    await writer.close();
    expect((await stream.readable.getReader().read()).done).toBe(true);

    // The realm has now demonstrated it cannot grant an adapter, so the route stops being offered.
    expect(mod.webgpuVideoFilterDriver.supports(RESIZE)).toBe(false);
  });

  it('still surfaces the typed capability error for a spec Canvas2D cannot render', async () => {
    const mod = await loadWithoutAdapter();
    const stream = mod.webgpuVideoFilterDriver.createFilter({
      mediaType: 'video',
      type: 'colorspace',
      to: 'bt2020',
    });
    // `vi.resetModules()` gives the reloaded graph its own error classes, so assert on the typed
    // identity the public contract exposes rather than on cross-registry class identity.
    await expect(stream.writable.getWriter().close()).rejects.toMatchObject({
      name: 'CapabilityError',
      message: 'no WebGPU adapter could be acquired',
    });
  });
});
