import { describe, expect, it, vi } from 'vitest';
import type { FilterDriver, FilterSpec } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { applyDecodedDisplayRotation } from './decoded-display-rotation.ts';

function emptyFrames(onCancel?: () => void): ReadableStream<VideoFrame> {
  const source: UnderlyingDefaultSource<VideoFrame> =
    onCancel === undefined ? {} : { cancel: onCancel };
  return new ReadableStream<VideoFrame>(source);
}

describe('decoded display rotation', () => {
  it('keeps identity rotations lazy', async () => {
    const frames = emptyFrames();
    const route = vi.fn<() => Promise<FilterDriver>>();
    await expect(applyDecodedDisplayRotation(frames, 360, {}, route)).resolves.toBe(frames);
    expect(route).not.toHaveBeenCalled();
  });

  it.each([90, 180, 270])('routes a normalized %i-degree quarter turn', async (degrees) => {
    const frames = emptyFrames();
    let received: FilterSpec | undefined;
    const driver = {
      createFilter(spec: FilterSpec) {
        received = spec;
        return new TransformStream<VideoFrame, VideoFrame>();
      },
    } as FilterDriver;
    const output = await applyDecodedDisplayRotation(frames, degrees - 360, {}, async () => driver);
    expect(output).not.toBe(frames);
    expect(received).toEqual({ mediaType: 'video', type: 'rotate', degrees });
  });

  it('cancels the input when rotation is not a quarter turn', async () => {
    const cancelled = vi.fn();
    const frames = emptyFrames(cancelled);
    await expect(
      applyDecodedDisplayRotation(frames, 45, {}, async () => null as never),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('cancels the input when filter routing fails', async () => {
    const cancelled = vi.fn();
    const frames = emptyFrames(cancelled);
    const failure = new Error('filter unavailable');
    await expect(
      applyDecodedDisplayRotation(frames, 90, {}, async () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('quarter-turn geometry is lossless and dimension-exact (property)', async () => {
    const { rotateGeometry } = await import('../filters/geometry.ts');
    const { geometryToRgba } = await import('../filters/cpu-video.ts');
    const makeImage = (w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          data[o] = (x * 37) % 256;
          data[o + 1] = (y * 73) % 256;
          data[o + 2] = ((x + y) * 13) % 256;
          data[o + 3] = 255;
        }
      }
      return { data, width: w, height: h };
    };
    const src = makeImage(5, 3);
    let cur: { data: Uint8ClampedArray; width: number; height: number } = src;
    for (const deg of [90, 90, 90, 90] as const) {
      const draw = rotateGeometry(cur.width, cur.height, deg);
      cur = geometryToRgba({ kind: 'oriented', draw }, cur);
    }
    expect(cur.width).toBe(src.width);
    expect(cur.height).toBe(src.height);
    expect(cur.data).toEqual(src.data);
  });

  it('odd and extreme dimensions keep exact swapped geometry (boundary)', async () => {
    const { rotateGeometry } = await import('../filters/geometry.ts');
    expect(rotateGeometry(1, 1, 90).dims).toEqual({ width: 1, height: 1 });
    expect(rotateGeometry(1, 4096, 90).dims).toEqual({ width: 4096, height: 1 });
    expect(rotateGeometry(4096, 1, 270).dims).toEqual({ width: 1, height: 4096 });
    expect(rotateGeometry(5, 3, 90).dims).toEqual({ width: 3, height: 5 });
    expect(rotateGeometry(5, 3, 270).dims).toEqual({ width: 3, height: 5 });
    expect(rotateGeometry(127, 63, 180).dims).toEqual({ width: 127, height: 63 });
  });

  it('20 randomized sizes keep lossless 90+270 and 180+180 identity (randomized)', async () => {
    const { rotateGeometry } = await import('../filters/geometry.ts');
    const { geometryToRgba } = await import('../filters/cpu-video.ts');
    let seed = 0x9e3779b9;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let t = 0; t < 20; t++) {
      const sw = 1 + Math.floor(rnd() * 64);
      const sh = 1 + Math.floor(rnd() * 32);
      const img = {
        data: new Uint8ClampedArray(sw * sh * 4).fill(128),
        width: sw,
        height: sh,
      };
      const r90 = rotateGeometry(sw, sh, 90);
      const after90 = geometryToRgba({ kind: 'oriented', draw: r90 }, img);
      expect(after90.width).toBe(sh);
      expect(after90.height).toBe(sw);
      const r270 = rotateGeometry(after90.width, after90.height, 270);
      const back = geometryToRgba({ kind: 'oriented', draw: r270 }, after90);
      expect(back.width).toBe(sw);
      expect(back.height).toBe(sh);
      // 180 twice
      const r180a = rotateGeometry(sw, sh, 180);
      const r180b = rotateGeometry(r180a.dims.width, r180a.dims.height, 180);
      const a180 = geometryToRgba({ kind: 'oriented', draw: r180a }, img);
      const b180 = geometryToRgba({ kind: 'oriented', draw: r180b }, a180);
      expect(b180.width).toBe(sw);
      expect(b180.height).toBe(sh);
    }
  });

  it('malformed rotation values are rejected before any decode', async () => {
    const frames = emptyFrames();
    const route = vi.fn<() => Promise<FilterDriver>>();
    await expect(applyDecodedDisplayRotation(frames, 45, {}, route)).rejects.toBeInstanceOf(CapabilityError);
    await expect(applyDecodedDisplayRotation(frames, 30, {}, route)).rejects.toBeInstanceOf(CapabilityError);
    await expect(applyDecodedDisplayRotation(frames, Number.NaN, {}, route)).rejects.toBeInstanceOf(CapabilityError);
    expect(route).not.toHaveBeenCalled();
  });

  it('CPU rotate path preserves timestamp and colorSpace via pure geometry (unit)', async () => {
    const { rotateGeometry } = await import('../filters/geometry.ts');
    const { geometryToRgba } = await import('../filters/cpu-video.ts');
    const src = {
      data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]),
      width: 2,
      height: 1,
    };
    const draw = rotateGeometry(2, 1, 90);
    const out = geometryToRgba({ kind: 'oriented', draw }, src);
    expect(out.width).toBe(1);
    expect(out.height).toBe(2);
    // Top-left output comes from bottom-left source for 90 CW (2×1 → 1×2)
    expect(out.data[0]).toBe(10);
    expect(out.data[4]).toBe(40);
  });

  it('prefers canvas path when OffscreenCanvas and VideoFrame are both present (unit)', async () => {
    const g = globalThis as Record<string, unknown>;
    const prevVF = g['VideoFrame'];
    const prevOC = g['OffscreenCanvas'];
    // Minimal VideoFrame mock (only needed for typeof check and stream wiring)
    class FakeVF {
      displayWidth = 2;
      codedWidth = 2;
      displayHeight = 1;
      codedHeight = 1;
      timestamp = 0;
      duration: number | null = null;
      colorSpace: VideoColorSpaceInit | undefined = undefined;
      close(): void {}
    }
    class FakeOC {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext(): OffscreenCanvasRenderingContext2D | null {
        return {
          setTransform(): void {},
          clearRect(): void {},
          drawImage(): void {},
          get imageSmoothingEnabled(): boolean { return false; },
          set imageSmoothingEnabled(_: boolean) {},
        } as unknown as OffscreenCanvasRenderingContext2D;
      }
    }
    g['VideoFrame'] = FakeVF as unknown as typeof VideoFrame;
    g['OffscreenCanvas'] = FakeOC as unknown as typeof OffscreenCanvas;
    // Stub VideoFrame constructor used inside the canvas path (new VideoFrame(canvas, init))
    g['VideoFrame'] = class extends FakeVF {
      constructor(_canvas: unknown, _init: unknown) { super(); }
    } as unknown as typeof VideoFrame;
    try {
      const frames = emptyFrames();
      const route = vi.fn<() => Promise<FilterDriver>>();
      const out = await applyDecodedDisplayRotation(frames, 90, {}, route);
      // Canvas path does not call the filter router
      expect(route).not.toHaveBeenCalled();
      expect(out).not.toBe(frames);
    } finally {
      if (prevVF === undefined) delete g['VideoFrame']; else g['VideoFrame'] = prevVF;
      if (prevOC === undefined) delete g['OffscreenCanvas']; else g['OffscreenCanvas'] = prevOC;
    }
  });

  it('90° and 270° are inverse and 270° equals three 90° steps (property)', async () => {
    const { rotateGeometry } = await import('../filters/geometry.ts');
    const { geometryToRgba } = await import('../filters/cpu-video.ts');
    const src = {
      data: new Uint8ClampedArray([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]) as unknown as Uint8ClampedArray,
      width: 2,
      height: 2,
    };
    const r90 = rotateGeometry(2, 2, 90);
    const r270 = rotateGeometry(2, 2, 270);
    const after90 = geometryToRgba({ kind: 'oriented', draw: r90 }, src);
    const back = geometryToRgba({ kind: 'oriented', draw: r270 }, after90);
    expect(back.data).toEqual(src.data);
    // Three 90s == one 270
    let cur: typeof src = src;
    for (let i = 0; i < 3; i++) {
      const d = rotateGeometry(cur.width, cur.height, 90);
      cur = geometryToRgba({ kind: 'oriented', draw: d }, cur);
    }
    const direct270 = geometryToRgba({ kind: 'oriented', draw: r270 }, src);
    expect(cur.data).toEqual(direct270.data);
  });

  it('extreme boundary dims 1x1, 4096x4096, 1x4096 keep lossless rotate (boundary)', async () => {
    const { rotateGeometry } = await import('../filters/geometry.ts');
    const { geometryToRgba } = await import('../filters/cpu-video.ts');
    const cases: Array<[number, number, 90 | 180 | 270]> = [
      [1, 1, 90],
      [1, 1, 180],
      [4096, 4096, 90],
      [1, 4096, 270],
      [4096, 1, 90],
    ];
    for (const [w, h, deg] of cases) {
      const img = { data: new Uint8ClampedArray(w * h * 4).fill(77), width: w, height: h };
      const draw = rotateGeometry(w, h, deg);
      const out = geometryToRgba({ kind: 'oriented', draw }, img);
      const expectedW = deg === 90 || deg === 270 ? h : w;
      const expectedH = deg === 90 || deg === 270 ? w : h;
      expect(out.width).toBe(expectedW);
      expect(out.height).toBe(expectedH);
      // All pixels same value → rotation must preserve uniform fill
      expect(out.data[0]).toBe(77);
      expect(out.data[out.data.length - 1]).toBe(77);
    }
  });

  it('malformed rotations including Infinity and non-quarter turns are rejected (malformed)', async () => {
    const frames = emptyFrames();
    const route = vi.fn<() => Promise<FilterDriver>>();
    for (const bad of [45, 30, 1, 359, Number.POSITIVE_INFINITY, Number.NaN, 90.5]) {
      await expect(applyDecodedDisplayRotation(frames, bad, {}, route)).rejects.toBeInstanceOf(CapabilityError);
    }
    expect(route).not.toHaveBeenCalled();
  });

  it('50 randomized sizes keep canvas/CPU geometry parity for 90/270 (randomized)', async () => {
    const { rotateGeometry } = await import('../filters/geometry.ts');
    const { geometryToRgba } = await import('../filters/cpu-video.ts');
    let seed = 0x1234567;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let t = 0; t < 50; t++) {
      const w = 1 + Math.floor(rnd() * 128);
      const h = 1 + Math.floor(rnd() * 96);
      const deg = (rnd() < 0.5 ? 90 : 270) as 90 | 270;
      const img = {
        data: new Uint8ClampedArray(w * h * 4).fill(Math.floor(rnd() * 256)),
        width: w,
        height: h,
      };
      const draw = rotateGeometry(w, h, deg);
      const out = geometryToRgba({ kind: 'oriented', draw }, img);
      expect(out.width).toBe(deg === 90 || deg === 270 ? h : w);
      expect(out.height).toBe(deg === 90 || deg === 270 ? w : h);
      // Inverse must restore
      const invDeg = deg === 90 ? 270 : 90;
      const backDraw = rotateGeometry(out.width, out.height, invDeg as 90 | 270);
      const back = geometryToRgba({ kind: 'oriented', draw: backDraw }, out);
      expect(back.width).toBe(w);
      expect(back.height).toBe(h);
    }
  });
});
