/**
 * Validation for the pure WebGPU shader-uniform math. These assert the geometry→shader mapping the GPU
 * renderer relies on — e.g. resize-`contain` must shrink the quad (`posScale` < 1) so the cleared bars show,
 * while resize-`cover` must shrink the sampled rect (`uvScale` < 1). Wrong values here would silently
 * corrupt the GPU output, so they get a real, can-fail Node test even though the device call is in-browser.
 */

import { describe, expect, it } from 'vitest';
import { cropBlit, flipGeometry, resizeBlit, rotateGeometry } from './geometry.ts';
import {
  COLOR_SPACE_IDS,
  COLOR_UNIFORM_BYTES,
  type ColorPlan,
  type Mat3,
  UNIFORM_BYTES,
  applyMat3,
  gamutMatrix,
  packColorUniforms,
  packUniforms,
  planColorspace,
  rgbToXyz,
  uniformsForBlit,
  uniformsForOriented,
  uniformsForRecipe,
} from './gpu-uniforms.ts';

/** Assert two numbers are equal within `eps` (computed color matrices allow ULP-scale drift). */
function near(a: number, b: number, eps = 1e-6): void {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
}

/** Assert a 3×3 equals an expected row-major matrix within `eps`. */
function nearMat(m: Mat3, expected: Mat3, eps = 1e-6): void {
  for (let i = 0; i < 9; i++) near(m[i] ?? Number.NaN, expected[i] ?? Number.NaN, eps);
}

describe('uniformsForBlit — destination placement & source sub-rect', () => {
  it('fill maps the whole source across the whole output (both scales 1)', () => {
    const u = uniformsForBlit(
      resizeBlit(640, 480, { mediaType: 'video', type: 'resize', width: 320, height: 240 }),
      640,
      480,
    );
    expect(u.posScale).toEqual([1, 1]);
    expect(u.posOffset).toEqual([0, 0]);
    expect(u.uvScale).toEqual([1, 1]);
    expect(u.uvOffset).toEqual([0, 0]);
  });

  it('contain shrinks the quad and centres it (letterbox), sampling the whole source', () => {
    const blit = resizeBlit(1920, 1080, {
      mediaType: 'video',
      type: 'resize',
      width: 100,
      height: 100,
      fit: 'contain',
    });
    const u = uniformsForBlit(blit, 1920, 1080);
    // dst is 100×56 at (0,22) within a 100×100 output → posScale.y = 0.56, posOffset.y = 0.22.
    expect(u.posScale[0]).toBeCloseTo(1, 6);
    expect(u.posScale[1]).toBeCloseTo(0.56, 6);
    expect(u.posOffset[0]).toBeCloseTo(0, 6);
    expect(u.posOffset[1]).toBeCloseTo(0.22, 6);
    // The whole source is sampled (no crop).
    expect(u.uvScale).toEqual([1, 1]);
    expect(u.uvOffset).toEqual([0, 0]);
  });

  it('cover fills the quad but samples a centred source sub-rect', () => {
    const blit = resizeBlit(1920, 1080, {
      mediaType: 'video',
      type: 'resize',
      width: 100,
      height: 100,
      fit: 'cover',
    });
    const u = uniformsForBlit(blit, 1920, 1080);
    // Quad is full output.
    expect(u.posScale).toEqual([1, 1]);
    expect(u.posOffset).toEqual([0, 0]);
    // Source crop is the centred 1080×1080 of 1920×1080 → uvScale.x = 1080/1920 = 0.5625, offset.x = 420/1920.
    expect(u.uvScale[0]).toBeCloseTo(0.5625, 6);
    expect(u.uvScale[1]).toBeCloseTo(1, 6);
    expect(u.uvOffset[0]).toBeCloseTo(420 / 1920, 6);
    expect(u.uvOffset[1]).toBeCloseTo(0, 6);
  });

  it('crop fills the quad and samples exactly the crop rect', () => {
    const blit = cropBlit(1000, 800, {
      mediaType: 'video',
      type: 'crop',
      x: 100,
      y: 200,
      width: 400,
      height: 300,
    });
    const u = uniformsForBlit(blit, 1000, 800);
    expect(u.posScale).toEqual([1, 1]);
    expect(u.posOffset).toEqual([0, 0]);
    expect(u.uvScale[0]).toBeCloseTo(0.4, 6);
    expect(u.uvScale[1]).toBeCloseTo(0.375, 6);
    expect(u.uvOffset[0]).toBeCloseTo(0.1, 6);
    expect(u.uvOffset[1]).toBeCloseTo(0.25, 6);
  });

  it('blits never carry a rotation (identity orientation)', () => {
    const u = uniformsForBlit(
      resizeBlit(10, 10, { mediaType: 'video', type: 'resize', width: 5, height: 5 }),
      10,
      10,
    );
    expect(u.rot0).toEqual([1, 0]);
    expect(u.rot1).toEqual([0, 1]);
  });
});

describe('uniformsForOriented — rotation/flip sign patterns', () => {
  it('0° rotation is the identity orientation, full coverage', () => {
    const u = uniformsForOriented(rotateGeometry(640, 480, 0));
    expect(u.posScale).toEqual([1, 1]);
    expect(u.uvScale).toEqual([1, 1]);
    expect(u.rot0).toEqual([1, 0]);
    expect(u.rot1).toEqual([0, 1]);
  });

  it('90° encodes a ±1 rotation 2×2', () => {
    const u = uniformsForOriented(rotateGeometry(640, 480, 90));
    // From affine {a:0,b:1,c:-1,d:0}: rot0=[sign(a),sign(b)]=[0,1], rot1=[sign(c),sign(d)]=[-1,0].
    expect(u.rot0).toEqual([0, 1]);
    expect(u.rot1).toEqual([-1, 0]);
  });

  it('180° encodes a negated identity', () => {
    const u = uniformsForOriented(rotateGeometry(640, 480, 180));
    expect(u.rot0).toEqual([-1, 0]);
    expect(u.rot1).toEqual([0, -1]);
  });

  it('270° encodes the opposite rotation from 90°', () => {
    const u = uniformsForOriented(rotateGeometry(640, 480, 270));
    expect(u.rot0).toEqual([0, -1]);
    expect(u.rot1).toEqual([1, 0]);
  });

  it('horizontal flip negates the x basis only', () => {
    const u = uniformsForOriented(flipGeometry(640, 480, 'h'));
    expect(u.rot0).toEqual([-1, 0]);
    expect(u.rot1).toEqual([0, 1]);
  });

  it('vertical flip negates the y basis only', () => {
    const u = uniformsForOriented(flipGeometry(640, 480, 'v'));
    expect(u.rot0).toEqual([1, 0]);
    expect(u.rot1).toEqual([0, -1]);
  });
});

describe('uniformsForRecipe — dispatch', () => {
  it('routes a blit recipe through uniformsForBlit', () => {
    const blit = resizeBlit(100, 100, {
      mediaType: 'video',
      type: 'resize',
      width: 50,
      height: 25,
      fit: 'contain',
    });
    const viaRecipe = uniformsForRecipe({ kind: 'blit', blit }, 100, 100);
    expect(viaRecipe).toEqual(uniformsForBlit(blit, 100, 100));
  });

  it('routes an oriented recipe through uniformsForOriented', () => {
    const draw = rotateGeometry(100, 100, 90);
    const viaRecipe = uniformsForRecipe({ kind: 'oriented', draw }, 100, 100);
    expect(viaRecipe).toEqual(uniformsForOriented(draw));
  });
});

describe('packUniforms — std140 byte layout', () => {
  it('packs 12 floats (6 × vec2) into a 48-byte own ArrayBuffer in declared order', () => {
    const u = uniformsForBlit(
      resizeBlit(200, 100, {
        mediaType: 'video',
        type: 'resize',
        width: 50,
        height: 50,
        fit: 'contain',
      }),
      200,
      100,
    );
    const packed = packUniforms(u);
    expect(packed.byteLength).toBe(UNIFORM_BYTES);
    expect(packed.buffer.byteLength).toBe(UNIFORM_BYTES);
    // GPU uniforms are f32, so compare against the f32-rounded source values (Math.fround), exactly.
    const f32 = (n: number): number => Math.fround(n);
    expect(Array.from(packed)).toEqual(
      [
        u.posScale[0],
        u.posScale[1],
        u.posOffset[0],
        u.posOffset[1],
        u.uvScale[0],
        u.uvScale[1],
        u.uvOffset[0],
        u.uvOffset[1],
        u.rot0[0],
        u.rot0[1],
        u.rot1[0],
        u.rot1[1],
      ].map(f32),
    );
  });

  it('UNIFORM_BYTES is a multiple of 16 (valid uniform-buffer binding size)', () => {
    expect(UNIFORM_BYTES % 16).toBe(0);
  });

  it('produces an independent buffer each call (no shared mutable state)', () => {
    const u = uniformsForOriented(rotateGeometry(8, 8, 180));
    const a = packUniforms(u);
    const b = packUniforms(u);
    expect(a).not.toBe(b);
    expect(a.buffer).not.toBe(b.buffer);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('colorspace gamut matrices — complete supported pair coverage', () => {
  const identity: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const bt709ToBt2020: Mat3 = [
    0.6274039, 0.32928304, 0.04331307, 0.06909729, 0.9195404, 0.01136232, 0.01639144, 0.08801331,
    0.89559525,
  ];
  const bt2020ToBt709: Mat3 = [
    1.660491, -0.58764114, -0.07284986, -0.12455047, 1.1328999, -0.00834942, -0.01815076,
    -0.1005789, 1.11872966,
  ];

  it('exports the complete first-party color-space set used by tests and benchmarks', () => {
    expect(COLOR_SPACE_IDS).toEqual(['srgb', 'bt709', 'bt601', 'bt2020']);
  });

  it('pins BT.709 -> BT.2020 to the published BT.2087 conversion matrix', () => {
    nearMat(gamutMatrix('bt709', 'bt2020'), bt709ToBt2020, 1e-5);
  });

  it('pins BT.2020 -> BT.709 to the published BT.2087 conversion matrix', () => {
    nearMat(gamutMatrix('bt2020', 'bt709'), bt2020ToBt709, 1e-5);
  });

  it('keeps sRGB <-> BT.709 as exact identity because their primaries match', () => {
    expect(gamutMatrix('srgb', 'bt709')).toEqual(identity);
    expect(gamutMatrix('bt709', 'srgb')).toEqual(identity);
  });

  it('round-trips every ordered supported gamut pair through its inverse matrix', () => {
    const sample: readonly [number, number, number] = [0.23, 0.47, 0.81];
    for (const src of COLOR_SPACE_IDS) {
      for (const dst of COLOR_SPACE_IDS) {
        const converted = applyMat3(gamutMatrix(src, dst), sample);
        const roundTrip = applyMat3(gamutMatrix(dst, src), converted);
        near(roundTrip[0], sample[0], 1e-9);
        near(roundTrip[1], sample[1], 1e-9);
        near(roundTrip[2], sample[2], 1e-9);
      }
    }
  });

  it('all supported RGB->XYZ matrices share D65 white exactly enough for white to be a fixed point', () => {
    for (const id of COLOR_SPACE_IDS) {
      const white = applyMat3(rgbToXyz(id), [1, 1, 1]);
      near(white[0], 0.95045593, 1e-6);
      near(white[1], 1, 1e-12);
      near(white[2], 1.08905775, 1e-6);
    }
  });
});

describe('packColorUniforms — BT.709/BT.2020 GPU matrix layout', () => {
  it('packs a 709 -> 2020 color plan column-major with no-tonemap params', () => {
    const plan: ColorPlan = planColorspace({ primaries: 'bt709', transfer: 'bt709' }, 'bt2020');
    const buf = packColorUniforms(plan);
    expect(buf.byteLength).toBe(COLOR_UNIFORM_BYTES);
    expect(buf.buffer.byteLength).toBe(COLOR_UNIFORM_BYTES);

    const m = gamutMatrix('bt709', 'bt2020');
    const f = (i: number): number => Math.fround(m[i] ?? Number.NaN);
    expect(Array.from(buf.slice(0, 12))).toEqual([
      f(0),
      f(3),
      f(6),
      0,
      f(1),
      f(4),
      f(7),
      0,
      f(2),
      f(5),
      f(8),
      0,
    ]);
    expect(Array.from(buf.slice(12, 16))).toEqual([2, 2, 0, 0]);
  });
});
