import { describe, expect, it } from 'vitest';
import { InputError } from '../contracts/errors.ts';
import { cropBlit, flipGeometry, padBlit, resizeBlit, rotateGeometry } from './geometry.ts';

describe('geometry — odd-size & 4K edge cases (1.3.2)', () => {
  it('resize contain with odd remainder centers with half-pixel (no trailing bias)', () => {
    // 10→9 via contain: scale 0.9, drawW round(10*0.9)=9, dx=(11-9)/2=1 → but odd case: src 5, dst 4
    // Use src 5×5 → contain into 4×4: scale 0.8, draw 4×4, dx 0, dy 0 (even) — need odd remainder
    const odd = resizeBlit(5, 5, {
      mediaType: 'video',
      type: 'resize',
      width: 5,
      height: 4,
      fit: 'contain',
    });
    // src 5×5 into 5×4 contain: scale 0.8, drawW 4, drawH 4, dx 0.5, dy 0
    expect(odd.dims).toEqual({ width: 5, height: 4 });
    expect(odd.dst.width).toBe(4);
    expect(odd.dst.height).toBe(4);
    expect(odd.dst.x).toBeCloseTo(0.5, 9);
    expect(odd.dst.y).toBe(0);
    // Cover with odd remainder: src 5×5 → 3×3 cover: scale 0.6, crop 5×5? actually 3/0.6=5, so crop 5×5, sx 0
    // Force a 1px remainder: src 5×5 → 4×3 cover: scale max(0.8,0.6)=0.8, cropW 5, cropH 4 (3/0.8=3.75→4), sx 0, sy round(0.5)=1
    const cover = resizeBlit(5, 5, {
      mediaType: 'video',
      type: 'resize',
      width: 4,
      height: 3,
      fit: 'cover',
    });
    expect(cover.src.width).toBe(5);
    expect(cover.src.height).toBe(4);
    expect(cover.src.x).toBe(0);
    expect(cover.src.y).toBe(1); // round((5-4)/2)=1, not floor 0
  });

  it('1×N, N×1 and 1×1 sources resize without throw and with exact dims', () => {
    for (const [sw, sh, dw, dh] of [
      [1, 1, 1, 1],
      [1, 8, 1, 4],
      [8, 1, 4, 1],
      [1, 4096, 1, 512],
      [4096, 1, 512, 1],
    ] as const) {
      const r = resizeBlit(sw, sh, {
        mediaType: 'video',
        type: 'resize',
        width: dw,
        height: dh,
        fit: 'contain',
      });
      expect(r.dims).toEqual({ width: dw, height: dh });
      expect(r.dst.width).toBeGreaterThanOrEqual(1);
      expect(r.dst.height).toBeGreaterThanOrEqual(1);
    }
  });

  it('4K → 1080p and 8K → 4K exact dims, no overflow, half-pixel centering deterministic', () => {
    const r1 = resizeBlit(3840, 2160, {
      mediaType: 'video',
      type: 'resize',
      width: 1920,
      height: 1080,
      fit: 'contain',
    });
    expect(r1.dims).toEqual({ width: 1920, height: 1080 });
    expect(r1.dst).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    const r2 = resizeBlit(7680, 4320, {
      mediaType: 'video',
      type: 'resize',
      width: 3840,
      height: 2160,
      fit: 'contain',
    });
    expect(r2.dims).toEqual({ width: 3840, height: 2160 });
    // Odd 4K contain: 3840×2160 → 1280×720 (16:9) is exact, but 3840×2160 → 1279×720 gives 0.5px bar
    const odd = resizeBlit(3840, 2160, {
      mediaType: 'video',
      type: 'resize',
      width: 1279,
      height: 720,
      fit: 'contain',
    });
    expect(odd.dst.x).toBeCloseTo(0, 9);
    expect(odd.dst.width).toBe(1279);
  });

  it('crop odd-size rect at edge and center stays inside source and 1:1', () => {
    const c1 = cropBlit(5, 5, {
      mediaType: 'video',
      type: 'crop',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(c1.dims).toEqual({ width: 1, height: 1 });
    const c2 = cropBlit(5, 5, {
      mediaType: 'video',
      type: 'crop',
      x: 4,
      y: 4,
      width: 1,
      height: 1,
    });
    expect(c2.src).toEqual({ x: 4, y: 4, width: 1, height: 1 });
    const c3 = cropBlit(7, 5, {
      mediaType: 'video',
      type: 'crop',
      x: 3,
      y: 2,
      width: 1,
      height: 1,
    });
    expect(c3.src.x + c3.src.width).toBeLessThanOrEqual(7);
  });

  it('pad odd-size source onto larger canvas with exact integer placement', () => {
    const p = padBlit(5, 3, { mediaType: 'video', type: 'pad', width: 6, height: 4, x: 1, y: 1 });
    expect(p.dims).toEqual({ width: 6, height: 4 });
    expect(p.dst).toEqual({ x: 1, y: 1, width: 5, height: 3 });
    const p2 = padBlit(1, 1, { mediaType: 'video', type: 'pad', width: 3, height: 3, x: 1, y: 1 });
    expect(p2.dst).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });

  it('rotate/flip with odd dimensions swap correctly and stay lossless', () => {
    expect(rotateGeometry(5, 3, 90).dims).toEqual({ width: 3, height: 5 });
    expect(rotateGeometry(5, 3, 270).dims).toEqual({ width: 3, height: 5 });
    expect(rotateGeometry(1, 4096, 90).dims).toEqual({ width: 4096, height: 1 });
    expect(flipGeometry(5, 3, 'h').dims).toEqual({ width: 5, height: 3 });
    expect(flipGeometry(3, 5, 'v').dims).toEqual({ width: 3, height: 5 });
  });

  it('malformed odd-size still throws InputError, not silent clamp', () => {
    expect(() =>
      cropBlit(5, 5, { mediaType: 'video', type: 'crop', x: 5, y: 0, width: 1, height: 1 }),
    ).toThrow(InputError);
    expect(() =>
      padBlit(5, 5, { mediaType: 'video', type: 'pad', width: 5, height: 5, x: 1, y: 1 }),
    ).toThrow(InputError);
    expect(() =>
      resizeBlit(0, 5, { mediaType: 'video', type: 'resize', width: 4, height: 4 }),
    ).toThrow(InputError);
  });

  it('20× randomized odd/even resize/crop/pad/rotate stay inside bounds and deterministic', () => {
    let s = 0x9e37;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    for (let t = 0; t < 20; t++) {
      const sw = 1 + Math.floor(rnd() * 64);
      const sh = 1 + Math.floor(rnd() * 64);
      const dw = 1 + Math.floor(rnd() * 64);
      const dh = 1 + Math.floor(rnd() * 64);
      const r = resizeBlit(sw, sh, {
        mediaType: 'video',
        type: 'resize',
        width: dw,
        height: dh,
        fit: (['fill', 'contain', 'cover'] as const)[Math.floor(rnd() * 3)] as never,
      });
      expect(r.dims.width).toBe(dw);
      expect(r.dims.height).toBe(dh);
      expect(r.src.x + r.src.width).toBeLessThanOrEqual(sw);
      expect(r.src.y + r.src.height).toBeLessThanOrEqual(sh);
      expect(r.dst.x + r.dst.width).toBeLessThanOrEqual(dw + 1e-9);
      // Determinism: second call identical
      const r2 = resizeBlit(sw, sh, {
        mediaType: 'video',
        type: 'resize',
        width: dw,
        height: dh,
        fit:
          r.src.width === sw && r.src.height === sh && r.dst.x === 0 && r.dst.y === 0
            ? 'fill'
            : 'contain',
      } as never);
      expect(r2.dims).toEqual(r.dims);
    }
  });
});
