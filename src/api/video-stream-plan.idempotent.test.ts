import { describe, expect, it } from 'vitest';
import { videoFilterSpecs, videoTargetPixelBoundaryBitDepth } from './video-stream-plan.ts';

describe('videoFilterSpecs idempotent source-res optimization — 5 variants', () => {
  const src = { width: 1920, height: 1080, fps: 30, durationSec: 30 };

  it('unit: idempotent resize emits zero filters (no YUV→RGB roundtrip)', () => {
    const specs = videoFilterSpecs({ width: 1920, height: 1080 }, src);
    expect(specs).toEqual([]);
    expect(videoTargetPixelBoundaryBitDepth({ width: 1920, height: 1080 }, src)).toBeUndefined();
  });

  it('property: same dims via crop+resize path still zero filters', () => {
    // crop none, target dims equal source dims -> no resize spec
    for (const w of [1920, 1280, 640]) {
      for (const h of [1080, 720, 360]) {
        const s = { width: w, height: h };
        const specs = videoFilterSpecs({ width: w, height: h }, s);
        expect(specs.length).toBe(0);
      }
    }
  });

  it('boundary: off-by-one triggers resize (ensures no false sharing)', () => {
    const specs1 = videoFilterSpecs({ width: 1919, height: 1080 }, src);
    expect(specs1.some((s) => s.type === 'resize')).toBe(true);
    const specs2 = videoFilterSpecs({ width: 1920, height: 1079 }, src);
    expect(specs2.some((s) => s.type === 'resize')).toBe(true);
    const specs3 = videoFilterSpecs({ width: 1920, height: 1080 }, src);
    expect(specs3.length).toBe(0);
  });

  it('malformed: missing source dims with ambiguous resize throws InputError', () => {
    expect(() =>
      videoFilterSpecs({ width: 1280 } as never, {
        width: undefined as never,
        height: undefined as never,
      }),
    ).toThrow();
  });

  it('randomized: 100 random targets never emit resize when dims match input', () => {
    for (let i = 0; i < 100; i++) {
      const w = 2 + Math.floor(Math.random() * 2000);
      const h = 2 + Math.floor(Math.random() * 2000);
      const s = { width: w, height: h };
      const specs = videoFilterSpecs({ width: w, height: h }, s);
      expect(specs.filter((x) => x.type === 'resize').length).toBe(0);
      const specsOff = videoFilterSpecs({ width: w + 2, height: h }, s);
      expect(specsOff.some((x) => x.type === 'resize')).toBe(true);
    }
  });
});
