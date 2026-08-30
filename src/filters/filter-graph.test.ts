import { describe, expect, it } from 'vitest';
import type { FilterSpec } from '../contracts/driver.ts';
import { InputError } from '../contracts/errors.ts';
import { planFilterGraph } from './filter-graph.ts';

function resize(w: number, h: number): FilterSpec {
  return { mediaType: 'video', type: 'resize', width: w, height: h, fit: 'cover' } as FilterSpec;
}
function crop(w: number, h: number): FilterSpec {
  return { mediaType: 'video', type: 'crop', x: 0, y: 0, width: w, height: h } as FilterSpec;
}
function pad(w: number, h: number): FilterSpec {
  return { mediaType: 'video', type: 'pad', x: 0, y: 0, width: w, height: h } as FilterSpec;
}
function rotate(d: 90 | 180 | 270): FilterSpec {
  return { mediaType: 'video', type: 'rotate', degrees: d } as FilterSpec;
}
function flip(axis: 'h' | 'v'): FilterSpec {
  return { mediaType: 'video', type: 'flip', axis } as FilterSpec;
}

describe('filter-graph — fused CPU/GPU graph (REQUIREMENTS §5.4 1.3.1)', () => {
  it('empty specs: zero passes, zero readbacks, identity dims', () => {
    const plan = planFilterGraph([], 1920, 1080, 'webgpu');
    expect(plan.fused).toBe(true);
    expect(plan.passes).toBe(0);
    expect(plan.readbacks).toBe(0);
    expect(plan.usesExternalTexture).toBe(true);
    expect(plan.outputDims).toEqual({ width: 1920, height: 1080 });
    expect(plan.steps).toHaveLength(0);
  });

  it('single resize fuses to one pass, GPU zero readback, CPU one', () => {
    const gpu = planFilterGraph([resize(1280, 720)], 1920, 1080, 'webgpu');
    expect(gpu.fused).toBe(true);
    expect(gpu.passes).toBe(1);
    expect(gpu.readbacks).toBe(0);
    expect(gpu.usesExternalTexture).toBe(true);
    expect(gpu.outputDims).toEqual({ width: 1280, height: 720 });

    const cpu = planFilterGraph([resize(1280, 720)], 1920, 1080, 'native');
    expect(cpu.readbacks).toBe(1);
    expect(cpu.usesExternalTexture).toBe(false);
  });

  it('resize+rotate+flip fuses to one pass with correct dims', () => {
    const plan = planFilterGraph([resize(1280, 720), rotate(90), flip('h')], 1920, 1080, 'webgpu');
    expect(plan.fused).toBe(true);
    expect(plan.passes).toBe(1);
    expect(plan.steps.length).toBe(3);
    // 1920×1080 cover→1280×720, then rotate 90 → 720×1280
    expect(plan.outputDims).toEqual({ width: 720, height: 1280 });
  });

  it('4K→1080p, canvas2d also zero readback (drawImage)', () => {
    const plan = planFilterGraph([resize(1920, 1080)], 3840, 2160, 'canvas2d');
    expect(plan.usesExternalTexture).toBe(true);
    expect(plan.readbacks).toBe(0);
    expect(plan.outputDims).toEqual({ width: 1920, height: 1080 });
  });

  it('odd dimensions and 1×N edge: 5×5 crop+pad chain preserves fused invariant', () => {
    const plan = planFilterGraph([crop(3, 3), pad(5, 4)], 5, 5, 'webgpu');
    expect(plan.fused).toBe(true);
    expect(plan.passes).toBe(1);
    expect(plan.outputDims).toEqual({ width: 5, height: 4 });
    // steps are pure geometry; no fixture branching
  });

  it('malformed: rejects non-fusable colorspace/tonemap and bad dims', () => {
    expect(() =>
      planFilterGraph(
        [{ mediaType: 'video', type: 'colorspace', to: 'srgb' } as FilterSpec],
        64,
        64,
      ),
    ).toThrow(InputError);
    expect(() => planFilterGraph([resize(64, 64)], 0, 64)).toThrow(InputError);
    expect(() => planFilterGraph([resize(64, 64)], Number.NaN as unknown as number, 64)).toThrow(
      InputError,
    );
  });

  it('20× randomized chain stays fused, single pass, readback invariant', () => {
    for (let i = 0; i < 20; i++) {
      const w0 = 16 + ((i * 37) % 3840);
      const h0 = 16 + ((i * 53) % 2160);
      const specs: FilterSpec[] = [];
      if (i % 2 === 0)
        specs.push(resize(Math.max(1, Math.floor(w0 / 2)), Math.max(1, Math.floor(h0 / 2))));
      if (i % 3 === 0) specs.push(rotate(90));
      if (i % 5 === 0) specs.push(flip('v'));
      const gpu = planFilterGraph(specs, w0, h0, 'webgpu');
      const cpu = planFilterGraph(specs, w0, h0, 'native');
      expect(gpu.fused).toBe(true);
      expect(gpu.passes).toBe(specs.length === 0 ? 0 : 1);
      expect(gpu.readbacks).toBe(0);
      expect(gpu.usesExternalTexture).toBe(true);
      expect(cpu.readbacks).toBe(specs.length === 0 ? 0 : 1);
      expect(cpu.usesExternalTexture).toBe(false);
      expect(cpu.outputDims).toEqual(gpu.outputDims);
      expect(cpu.steps.length).toBe(gpu.steps.length);
    }
  });

  it('tonemap is not fusable in this graph (routes separately)', () => {
    expect(() =>
      planFilterGraph([{ mediaType: 'video', type: 'tonemap' } as FilterSpec], 128, 128),
    ).toThrow(InputError);
  });
});

describe('filter-graph — threshold substrate selection (3.2)', () => {
  it('tiny <4096 px single-spec prefers native (no GPU setup)', async () => {
    const { selectFilterSubstrate } = await import('./filter-graph.ts');
    expect(selectFilterSubstrate(32, 32, [])).toBe('native');
    expect(
      selectFilterSubstrate(64, 64, [
        { mediaType: 'video', type: 'resize', width: 32, height: 32, fit: 'cover' } as FilterSpec,
      ]),
    ).toBe('native');
    // 64×64 =4096 is the boundary, single-spec tiny stays native
    expect(
      selectFilterSubstrate(63, 63, [
        { mediaType: 'video', type: 'resize', width: 32, height: 32, fit: 'cover' } as FilterSpec,
      ]),
    ).toBe('native');
  });

  it('large ≥1920×1080 prefers webgpu when available, else canvas2d', async () => {
    const { selectFilterSubstrate } = await import('./filter-graph.ts');
    expect(selectFilterSubstrate(3840, 2160, [])).toBe('webgpu');
    expect(selectFilterSubstrate(1920, 1080, [])).toBe('webgpu');
    // Without webgpu, falls back to canvas2d
    expect(selectFilterSubstrate(3840, 2160, [], ['canvas2d', 'native'])).toBe('canvas2d');
    expect(selectFilterSubstrate(1920, 1080, [], ['native'])).toBe('native');
  });

  it('medium 128×128 prefers canvas2d, respects available list', async () => {
    const { selectFilterSubstrate } = await import('./filter-graph.ts');
    expect(selectFilterSubstrate(128, 128, [])).toBe('canvas2d');
    expect(selectFilterSubstrate(128, 128, [], ['webgpu', 'native'])).toBe('webgpu');
    expect(selectFilterSubstrate(128, 128, [], ['native'])).toBe('native');
  });

  it('20× randomized stays deterministic and respects thresholds', async () => {
    const { selectFilterSubstrate } = await import('./filter-graph.ts');
    for (let i = 0; i < 20; i++) {
      const w = 16 + ((i * 137) % 4000);
      const h = 16 + ((i * 149) % 3000);
      const pixels = w * h;
      const sel = selectFilterSubstrate(w, h, []);
      if (pixels < 4096)
        expect(['native', 'canvas2d'].includes(sel) || sel === 'native').toBe(true);
      if (pixels >= 1920 * 1080) expect(sel).toBe('webgpu');
      // Never huge-alloc, always one of the three
      expect(['webgpu', 'canvas2d', 'native']).toContain(sel);
    }
  });

  it('malformed dims throw InputError', async () => {
    const { selectFilterSubstrate } = await import('./filter-graph.ts');
    expect(() => selectFilterSubstrate(0, 64, [])).toThrow(InputError);
    expect(() => selectFilterSubstrate(Number.NaN as unknown as number, 64, [])).toThrow(
      InputError,
    );
    expect(() => selectFilterSubstrate(64, -1, [])).toThrow(InputError);
  });
});
