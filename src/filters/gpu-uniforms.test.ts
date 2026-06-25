/**
 * Validation for the pure WebGPU shader-uniform math. These assert the geometry→shader mapping the GPU
 * renderer relies on — e.g. resize-`contain` must shrink the quad (`posScale` < 1) so the cleared bars show,
 * while resize-`cover` must shrink the sampled rect (`uvScale` < 1). Wrong values here would silently
 * corrupt the GPU output, so they get a real, can-fail Node test even though the device call is in-browser.
 */

import { describe, expect, it } from 'vitest';
import { cropBlit, flipGeometry, resizeBlit, rotateGeometry } from './geometry.ts';
import {
  UNIFORM_BYTES,
  packUniforms,
  uniformsForBlit,
  uniformsForOriented,
  uniformsForRecipe,
} from './gpu-uniforms.ts';

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
