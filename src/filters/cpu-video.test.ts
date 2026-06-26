/**
 * Node-side validation for the CPU video filter driver (the cross-browser, no-GPU fallback). The live
 * `VideoFrame`/`copyTo` render runs only in the browser harness, so here we test the **pure per-pixel
 * transforms** — colorspace/tonemap and the geometry — exhaustively, with the key oracle being **parity
 * with the GPU math**: the CPU colour apply must equal an independent recomputation from the *same* pure
 * primitives the GPU shader mirrors (`eotf`/`oetf`/`applyMat3`/tonemap from gpu-uniforms.ts), plus a few
 * hand-computed ground truths. We also cover geometry (crop exact, flip/rotate lossless, resize bilinear),
 * the spec→plan dispatch, the `VideoColorSpace` mapping, and the driver's Node-observable contract.
 */

import { describe, expect, it } from 'vitest';
import type { FilterSpec } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import {
  CpuVideoFilterModule,
  type RgbaImage,
  applyColorPlanRgb,
  applyColorPlanToRgba,
  colorSpecTargetGamut,
  cpuVideoFilterDriver,
  geometryToRgba,
  mapVideoColorSpace,
  planCpuColor,
  planCpuGeometry,
} from './cpu-video.ts';
import {
  type ColorPlan,
  applyMat3,
  eotf,
  gamutMatrix,
  oetf,
  planColorspace,
  planTonemap,
  tonemapHable,
  tonemapReinhard,
} from './gpu-uniforms.ts';

// ---- helpers ----

/** Build an RGBA image from a flat [r,g,b,a,...] byte list. */
function img(width: number, height: number, bytes: readonly number[]): RgbaImage {
  return { data: new Uint8ClampedArray(bytes), width, height };
}

/** A single-pixel RGBA image. */
function px(r: number, g: number, b: number, a = 255): RgbaImage {
  return img(1, 1, [r, g, b, a]);
}

/** Read pixel (x,y) channels from an image. */
function at(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const o = (y * image.width + x) * 4;
  return [
    image.data[o] ?? 0,
    image.data[o + 1] ?? 0,
    image.data[o + 2] ?? 0,
    image.data[o + 3] ?? 0,
  ];
}

/**
 * The **GPU-math reference**: recompute a colour pixel independently from the shared pure primitives the GPU
 * shader inlines (decode-transfer → gamut matrix → optional tonemap → encode-transfer, clamped). The CPU
 * driver must match this — if it transposed the matrix, skipped a clamp, or reordered the stages, it fails.
 */
function referenceColorPixel(
  plan: ColorPlan,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const sat = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
  const lin: [number, number, number] = [
    eotf(plan.decode, r / 255),
    eotf(plan.decode, g / 255),
    eotf(plan.decode, b / 255),
  ];
  const conv = applyMat3(plan.gamut, lin);
  let m: [number, number, number] = [conv[0], conv[1], conv[2]];
  if (plan.tonemap !== null) {
    const t = plan.tonemap;
    const tm = (x: number): number =>
      t.op === 'hable' ? tonemapHable(x, t.peak) : tonemapReinhard(x, t.peak);
    m = [tm(m[0]), tm(m[1]), tm(m[2])];
  }
  return [
    Math.round(sat(oetf(plan.encode, sat(m[0]))) * 255),
    Math.round(sat(oetf(plan.encode, sat(m[1]))) * 255),
    Math.round(sat(oetf(plan.encode, sat(m[2]))) * 255),
  ];
}

// ============ colour apply — GPU parity ============

describe('applyColorPlanToRgba — parity with the GPU colour math', () => {
  const planes = {
    identity: planColorspace({ primaries: 'bt709', transfer: 'bt709' }, 'bt709'),
    toSrgb: planColorspace({ primaries: 'bt709', transfer: 'bt709' }, 'srgb'),
    fromSrgbTo709: planColorspace({ primaries: 'srgb', transfer: 'srgb' }, 'bt709'),
    from601To709: planColorspace({ primaries: 'bt601', transfer: 'bt709' }, 'bt709'),
    to2020: planColorspace({ primaries: 'bt709', transfer: 'bt709' }, 'bt2020'),
    tonemapPq: planTonemap({ primaries: 'bt2020', transfer: 'pq' }),
    tonemapHlg: planTonemap({ primaries: 'bt2020', transfer: 'hlg' }),
  } as const;

  const SAMPLES: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
    [255, 0, 0, 255],
    [0, 255, 0, 128],
    [0, 0, 255, 0],
    [128, 64, 200, 255],
    [10, 240, 130, 77],
  ];

  for (const [name, plan] of Object.entries(planes)) {
    it(`matches the GPU reference for every sample pixel under '${name}'`, () => {
      for (const [r, g, b, a] of SAMPLES) {
        const out = applyColorPlanToRgba(plan, px(r, g, b, a));
        const [er, eg, eb] = referenceColorPixel(plan, r, g, b);
        const [or, og, ob, oa] = at(out, 0, 0);
        // CPU and the reference share the exact primitives, so they agree to ≤1 LSB (rounding).
        expect(Math.abs(or - er)).toBeLessThanOrEqual(1);
        expect(Math.abs(og - eg)).toBeLessThanOrEqual(1);
        expect(Math.abs(ob - eb)).toBeLessThanOrEqual(1);
        expect(oa).toBe(a); // alpha preserved exactly
      }
    });
  }

  it('applyColorPlanRgb is the per-pixel core the image apply uses (same result)', () => {
    const plan = planes.to2020;
    const c = applyColorPlanRgb(plan, [128 / 255, 64 / 255, 200 / 255]);
    const out = applyColorPlanToRgba(plan, px(128, 64, 200));
    const [or, og, ob] = at(out, 0, 0);
    expect(or).toBe(Math.round(c[0] * 255));
    expect(og).toBe(Math.round(c[1] * 255));
    expect(ob).toBe(Math.round(c[2] * 255));
  });
});

describe('colour apply — ground-truth invariants', () => {
  const identity = planColorspace({ primaries: 'bt709', transfer: 'bt709' }, 'bt709');

  it('an identity colorspace (709→709) is a passthrough (black/white/grey unchanged within 1 LSB)', () => {
    for (const [r, g, b] of [
      [0, 0, 0],
      [255, 255, 255],
      [128, 128, 128],
      [200, 50, 100],
    ] as const) {
      const [or, og, ob] = at(applyColorPlanToRgba(identity, px(r, g, b)), 0, 0);
      expect(Math.abs(or - r)).toBeLessThanOrEqual(1);
      expect(Math.abs(og - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(ob - b)).toBeLessThanOrEqual(1);
    }
  });

  it('a colorspace conversion preserves both black and white (shared D65 ⇒ equal-RGB is a fixed point)', () => {
    // Gamut conversions between D65 spaces map (1,1,1)→(1,1,1) and (0,0,0)→(0,0,0) exactly.
    for (const plan of [
      planColorspace({ primaries: 'bt709', transfer: 'bt709' }, 'bt2020'),
      planColorspace({ primaries: 'bt2020', transfer: 'bt709' }, 'bt709'),
      planColorspace({ primaries: 'bt601', transfer: 'bt709' }, 'bt709'),
    ]) {
      expect(at(applyColorPlanToRgba(plan, px(0, 0, 0)), 0, 0).slice(0, 3)).toEqual([0, 0, 0]);
      const white = at(applyColorPlanToRgba(plan, px(255, 255, 255)), 0, 0).slice(0, 3);
      for (const c of white) expect(c).toBeGreaterThanOrEqual(254); // white → white (≤1 LSB rounding)
    }
  });

  it('a tonemap preserves black and maps normalized HDR transfer peaks to SDR white', () => {
    const tm = planTonemap({ primaries: 'bt2020', transfer: 'pq' });
    expect(at(applyColorPlanToRgba(tm, px(0, 0, 0)), 0, 0).slice(0, 3)).toEqual([0, 0, 0]);
    const peak = at(applyColorPlanToRgba(tm, px(255, 255, 255)), 0, 0).slice(0, 3);
    for (const c of peak) expect(c).toBeGreaterThanOrEqual(254);
  });

  it('HLG tonemap uses the 12x source peak and maps HLG code peak to SDR white', () => {
    const tm = planTonemap({ primaries: 'bt2020', transfer: 'hlg' });
    expect(tm.tonemap?.peak).toBe(12);
    const peak = at(applyColorPlanToRgba(tm, px(255, 255, 255)), 0, 0).slice(0, 3);
    for (const c of peak) expect(c).toBeGreaterThanOrEqual(254);
  });

  it('709→2020 shrinks a saturated primary toward the wider gamut (red gains green/blue, loses red)', () => {
    const to2020 = planColorspace({ primaries: 'bt709', transfer: 'bt709' }, 'bt2020');
    const [r, g, b] = at(applyColorPlanToRgba(to2020, px(255, 0, 0)), 0, 0);
    expect(r).toBeLessThan(255); // BT.709 red sits inside BT.2020 ⇒ < full-red in 2020 coords
    expect(r).toBeGreaterThan(150);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
  });

  it('tonemap of a bright HDR pixel does not blow past white and keeps black at black', () => {
    const tm = planTonemap({ primaries: 'bt2020', transfer: 'pq' });
    const bright = at(applyColorPlanToRgba(tm, px(230, 230, 230)), 0, 0);
    for (const c of bright.slice(0, 3)) expect(c).toBeLessThanOrEqual(255);
    expect(at(applyColorPlanToRgba(tm, px(0, 0, 0)), 0, 0).slice(0, 3)).toEqual([0, 0, 0]);
  });
});

// ============ geometry ============

describe('geometryToRgba — crop (exact, lossless)', () => {
  // A 3×2 image with distinct pixels: row0 = R,G,B ; row1 = C,M,Y.
  const src = img(3, 2, [
    255,
    0,
    0,
    255,
    0,
    255,
    0,
    255,
    0,
    0,
    255,
    255, // row 0
    0,
    255,
    255,
    255,
    255,
    0,
    255,
    255,
    255,
    255,
    0,
    255, // row 1
  ]);

  it('extracts an in-bounds sub-rectangle 1:1', () => {
    const recipe = planCpuGeometry(
      { mediaType: 'video', type: 'crop', x: 1, y: 0, width: 2, height: 2 },
      3,
      2,
    );
    const out = geometryToRgba(recipe, src);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(at(out, 0, 0)).toEqual([0, 255, 0, 255]); // G
    expect(at(out, 1, 0)).toEqual([0, 0, 255, 255]); // B
    expect(at(out, 0, 1)).toEqual([255, 0, 255, 255]); // M
    expect(at(out, 1, 1)).toEqual([255, 255, 0, 255]); // Y
  });
});

describe('geometryToRgba — flip (lossless mirror)', () => {
  const src = img(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]); // [R, B]

  it('horizontal flip mirrors left↔right', () => {
    const recipe = planCpuGeometry({ mediaType: 'video', type: 'flip', axis: 'h' }, 2, 1);
    const out = geometryToRgba(recipe, src);
    expect(out.width).toBe(2);
    expect(at(out, 0, 0)).toEqual([0, 0, 255, 255]); // was rightmost (B)
    expect(at(out, 1, 0)).toEqual([255, 0, 0, 255]); // was leftmost (R)
  });

  it('vertical flip mirrors top↔bottom', () => {
    const col = img(1, 2, [255, 0, 0, 255, 0, 0, 255, 255]); // top R, bottom B
    const recipe = planCpuGeometry({ mediaType: 'video', type: 'flip', axis: 'v' }, 1, 2);
    const out = geometryToRgba(recipe, col);
    expect(at(out, 0, 0)).toEqual([0, 0, 255, 255]); // bottom now on top
    expect(at(out, 0, 1)).toEqual([255, 0, 0, 255]);
  });
});

describe('geometryToRgba — rotate (lossless, dim swap)', () => {
  // 2×1 image [R, G]; a 90° CW rotation gives a 1×2 image with R on top, G on bottom.
  const src = img(2, 1, [255, 0, 0, 255, 0, 255, 0, 255]);

  it('90° CW swaps dims and rotates pixels clockwise', () => {
    const recipe = planCpuGeometry({ mediaType: 'video', type: 'rotate', degrees: 90 }, 2, 1);
    const out = geometryToRgba(recipe, src);
    expect(out.width).toBe(1);
    expect(out.height).toBe(2);
    // Top-left source pixel (R) rotates to the top; the next column (G) to the bottom.
    expect(at(out, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(out, 0, 1)).toEqual([0, 255, 0, 255]);
  });

  it('180° keeps dims and reverses both axes', () => {
    const recipe = planCpuGeometry({ mediaType: 'video', type: 'rotate', degrees: 180 }, 2, 1);
    const out = geometryToRgba(recipe, src);
    expect(out.width).toBe(2);
    expect(at(out, 0, 0)).toEqual([0, 255, 0, 255]); // G now first
    expect(at(out, 1, 0)).toEqual([255, 0, 0, 255]); // R now last
  });

  it('four 90° rotations restore the original image (lossless round-trip)', () => {
    let cur = src;
    let w = 2;
    let h = 1;
    for (let i = 0; i < 4; i++) {
      const recipe = planCpuGeometry({ mediaType: 'video', type: 'rotate', degrees: 90 }, w, h);
      cur = geometryToRgba(recipe, cur);
      [w, h] = [h, w];
    }
    expect(cur.width).toBe(2);
    expect(cur.height).toBe(1);
    expect(at(cur, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(cur, 1, 0)).toEqual([0, 255, 0, 255]);
  });
});

describe('geometryToRgba — resize (bilinear)', () => {
  it('upscaling a 1×1 fills the whole output with that colour', () => {
    const recipe = planCpuGeometry(
      { mediaType: 'video', type: 'resize', width: 4, height: 4 },
      1,
      1,
    );
    const out = geometryToRgba(recipe, px(10, 20, 30));
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) expect(at(out, x, y)).toEqual([10, 20, 30, 255]);
    }
  });

  it('downscaling a 2×2 to 1×1 averages toward the source pixels (bilinear, in-gamut)', () => {
    // 2×2: [0, 100; 200, 255] grey. A 1×1 resize samples near the centre → an interior value.
    const src = img(
      2,
      2,
      [0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 255, 255, 255, 255],
    );
    const recipe = planCpuGeometry(
      { mediaType: 'video', type: 'resize', width: 1, height: 1 },
      2,
      2,
    );
    const [r] = at(geometryToRgba(recipe, src), 0, 0);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(255);
  });

  it('contain leaves transparent letterbox bars outside the drawn rect', () => {
    // 2×1 source into a 2×2 contain box ⇒ scaled to 2×1, centred vertically, rows 0 and ? bars.
    const src = img(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]);
    const recipe = planCpuGeometry(
      { mediaType: 'video', type: 'resize', width: 2, height: 2, fit: 'contain' },
      2,
      1,
    );
    const out = geometryToRgba(recipe, src);
    // One of the two rows is the drawn image, the other is a transparent bar (alpha 0).
    const rowAlpha = (y: number): number => at(out, 0, y)[3] + at(out, 1, y)[3];
    expect(rowAlpha(0) === 0 || rowAlpha(1) === 0).toBe(true);
  });
});

// ============ spec → plan dispatch ============

describe('planCpuColor / planCpuGeometry — dispatch', () => {
  const src709 = { primaries: 'bt709', transfer: 'bt709' } as const;

  it('colorspace → a no-tonemap plan with the right gamut matrix', () => {
    const p = planCpuColor({ mediaType: 'video', type: 'colorspace', to: 'bt2020' }, src709);
    expect(p.tonemap).toBeNull();
    expect(p.gamut).toEqual(gamutMatrix('bt709', 'bt2020'));
  });

  it('tonemap → a Reinhard plan that converts the source gamut to 709', () => {
    const p = planCpuColor(
      { mediaType: 'video', type: 'tonemap', to: 'sdr' },
      {
        primaries: 'bt2020',
        transfer: 'pq',
      },
    );
    expect(p.tonemap?.op).toBe('reinhard');
    expect(p.encode).toBe('bt709');
  });

  it('rejects an unknown colorspace target with a typed InputError', () => {
    expect(() =>
      planCpuColor({ mediaType: 'video', type: 'colorspace', to: 'nope' }, src709),
    ).toThrow(InputError);
  });

  it('geometry dispatch returns blit for resize/crop and oriented for rotate/flip', () => {
    expect(
      planCpuGeometry({ mediaType: 'video', type: 'resize', width: 4, height: 4 }, 8, 8).kind,
    ).toBe('blit');
    expect(
      planCpuGeometry({ mediaType: 'video', type: 'crop', x: 0, y: 0, width: 4, height: 4 }, 8, 8)
        .kind,
    ).toBe('blit');
    expect(planCpuGeometry({ mediaType: 'video', type: 'rotate', degrees: 90 }, 8, 8).kind).toBe(
      'oriented',
    );
    expect(planCpuGeometry({ mediaType: 'video', type: 'flip', axis: 'h' }, 8, 8).kind).toBe(
      'oriented',
    );
  });

  it('propagates a crop-out-of-bounds InputError', () => {
    expect(() =>
      planCpuGeometry(
        { mediaType: 'video', type: 'crop', x: 100, y: 0, width: 4, height: 4 },
        8,
        8,
      ),
    ).toThrow(InputError);
  });
});

describe('mapVideoColorSpace + colorSpecTargetGamut', () => {
  it('maps every transfer token onto the right TransferId', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['bt709', 'bt709'],
      ['smpte170m', 'bt709'],
      ['iec61966-2-1', 'srgb'],
      ['pq', 'pq'],
      ['hlg', 'hlg'],
      ['linear', 'linear'],
      ['some-future-transfer', 'bt709'], // unknown → default SDR
    ];
    for (const [token, id] of cases) {
      expect(mapVideoColorSpace({ primaries: 'bt709', transfer: token }).transfer).toBe(id);
    }
  });

  it('maps every primaries token onto the right ColorSpaceId', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['bt709', 'bt709'],
      ['bt2020', 'bt2020'],
      ['smpte170m', 'bt601'],
      ['bt470bg', 'bt601'],
      ['totally-unknown', 'bt709'], // unknown → default BT.709
    ];
    for (const [token, id] of cases) {
      expect(mapVideoColorSpace({ primaries: token, transfer: 'bt709' }).primaries).toBe(id);
    }
  });

  it('maps known tokens and defaults the unknown/absent to BT.709 SDR', () => {
    expect(mapVideoColorSpace({ primaries: 'bt2020', transfer: 'pq' })).toEqual({
      primaries: 'bt2020',
      transfer: 'pq',
    });
    expect(mapVideoColorSpace(null)).toEqual({ primaries: 'bt709', transfer: 'bt709' });
    expect(mapVideoColorSpace({ primaries: 'weird', transfer: 'odd' })).toEqual({
      primaries: 'bt709',
      transfer: 'bt709',
    });
  });

  it('colorSpecTargetGamut reads the target, falls back to bt709 for an unknown one, and is bt709 for tonemap', () => {
    expect(colorSpecTargetGamut({ mediaType: 'video', type: 'colorspace', to: 'bt2020' })).toBe(
      'bt2020',
    );
    expect(colorSpecTargetGamut({ mediaType: 'video', type: 'colorspace', to: 'srgb' })).toBe(
      'srgb',
    );
    // An unknown target tags the output as BT.709 (the safe display default) rather than throwing here.
    expect(colorSpecTargetGamut({ mediaType: 'video', type: 'colorspace', to: 'mystery' })).toBe(
      'bt709',
    );
    expect(colorSpecTargetGamut({ mediaType: 'video', type: 'tonemap', to: 'sdr' })).toBe('bt709');
  });

  it('maps a frame whose primaries are explicitly null to the BT.709 default', () => {
    expect(mapVideoColorSpace({ primaries: null, transfer: 'pq' })).toEqual({
      primaries: 'bt709',
      transfer: 'pq',
    });
  });
});

// ============ driver contract surface (Node-observable) ============

const ALL_VIDEO: readonly FilterSpec[] = [
  { mediaType: 'video', type: 'resize', width: 8, height: 8 },
  { mediaType: 'video', type: 'crop', x: 0, y: 0, width: 4, height: 4 },
  { mediaType: 'video', type: 'rotate', degrees: 270 },
  { mediaType: 'video', type: 'flip', axis: 'h' },
  { mediaType: 'video', type: 'colorspace', to: 'bt2020' },
  { mediaType: 'video', type: 'tonemap', to: 'sdr' },
];

const AUDIO: readonly FilterSpec[] = [
  { mediaType: 'audio', type: 'gain', db: 3 },
  { mediaType: 'audio', type: 'resample', sampleRate: 48000 },
  { mediaType: 'audio', type: 'remix', channels: 2 },
];

describe('cpuVideoFilterDriver — identity & honest supports()', () => {
  it('declares the native CPU substrate, ranked below the GPU substrates', () => {
    expect(cpuVideoFilterDriver.kind).toBe('filter');
    expect(cpuVideoFilterDriver.substrate).toBe('native');
    expect(cpuVideoFilterDriver.apiVersion).toBe(1);
    expect(cpuVideoFilterDriver.id).toBe('cpu-video-filter');
  });

  it('supports() is false for every video spec in Node (no VideoFrame), and always for audio', () => {
    expect(typeof VideoFrame).toBe('undefined');
    for (const spec of ALL_VIDEO) expect(cpuVideoFilterDriver.supports(spec)).toBe(false);
    for (const spec of AUDIO) expect(cpuVideoFilterDriver.supports(spec)).toBe(false);
  });
});

describe('cpuVideoFilterDriver.createFilter — handler gating', () => {
  it('builds a TransformStream for every video op (handler-gated, not env-gated)', () => {
    for (const spec of ALL_VIDEO) {
      const stream = cpuVideoFilterDriver.createFilter(spec);
      expect(stream).toBeInstanceOf(TransformStream);
      expect(stream.readable).toBeInstanceOf(ReadableStream);
      expect(stream.writable).toBeInstanceOf(WritableStream);
    }
  });

  it('throws CapabilityError for every audio spec', () => {
    for (const spec of AUDIO) {
      expect(() => cpuVideoFilterDriver.createFilter(spec)).toThrow(CapabilityError);
    }
  });

  it('accepts an AbortSignal without throwing synchronously on abort', () => {
    const controller = new AbortController();
    const stream = cpuVideoFilterDriver.createFilter(
      { mediaType: 'video', type: 'resize', width: 8, height: 8 },
      { signal: controller.signal },
    );
    expect(stream).toBeInstanceOf(TransformStream);
    expect(() => controller.abort()).not.toThrow();
  });
});

describe('CpuVideoFilterModule — registration', () => {
  it('registers exactly the one CPU filter driver and nothing else', () => {
    const added: { filters: string[]; others: number } = { filters: [], others: 0 };
    CpuVideoFilterModule.register({
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
    expect(added.filters).toEqual(['cpu-video-filter']);
    expect(added.others).toBe(0);
  });

  it('declares DRIVER_API_VERSION 1', () => {
    expect(CpuVideoFilterModule.apiVersion).toBe(1);
  });
});
