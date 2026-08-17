import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import {
  type PackedRgbFormat,
  copyFrameToRgba,
  normalizePackedRgba,
  packedRgbFormat,
  readFrameRgba,
  rgbaCopyBufferSize,
} from './frame-rgba.ts';

// ── runtime doubles ───────────────────────────────────────────────────────────────────────────────
//
// Each double reproduces one REAL, measured `VideoFrame.copyTo` behaviour rather than an invented one:
//
//   converting  — Chromium 149 / Firefox 151: honours `format: 'RGBA'`, resolves with one packed plane.
//   planar-echo — WebKit 26.5: ignores `format`, writes the native planar bytes, resolves with the
//                 native planar `PlaneLayout[]`.
//   refusing    — WebKit 26.5 when an explicit packed layout is supplied: `TypeError`.

type CopyBehaviour = 'converting' | 'planar-echo' | 'refusing' | 'unreported-layout';

interface FrameSeed {
  readonly behaviour: CopyBehaviour;
  readonly width: number;
  readonly height: number;
  readonly format?: VideoPixelFormat | null;
  readonly visibleRect?: { x: number; y: number; width: number; height: number } | null;
  readonly displayWidth?: number;
  readonly displayHeight?: number;
  /** Packed RGBA the runtime would produce for the whole coded picture when it converts. */
  readonly converted?: Uint8Array;
  /** Native bytes a non-converting runtime writes instead. */
  readonly native?: Uint8Array;
}

class FakeVideoFrame {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: { x: number; y: number; width: number; height: number } | null;
  readonly format: VideoPixelFormat | null;
  readonly timestamp = 0;
  readonly duration = null;
  copyCalls = 0;

  constructor(private readonly seed: FrameSeed) {
    this.codedWidth = seed.width;
    this.codedHeight = seed.height;
    this.displayWidth = seed.displayWidth ?? seed.width;
    this.displayHeight = seed.displayHeight ?? seed.height;
    this.visibleRect =
      seed.visibleRect === undefined
        ? { x: 0, y: 0, width: seed.width, height: seed.height }
        : seed.visibleRect;
    this.format = seed.format ?? 'I420';
  }

  async copyTo(
    destination: ArrayBufferView,
    options?: VideoFrameCopyToOptions,
  ): Promise<readonly PlaneLayout[] | undefined> {
    this.copyCalls++;
    const bytes = new Uint8Array(
      destination.buffer,
      destination.byteOffset,
      destination.byteLength,
    );
    const rect = options?.rect ?? {
      x: 0,
      y: 0,
      width: this.codedWidth,
      height: this.codedHeight,
    };
    const width = rect.width ?? this.codedWidth;
    const height = rect.height ?? this.codedHeight;
    if (this.seed.behaviour === 'refusing') {
      throw new TypeError('layout size is invalid');
    }
    if (this.seed.behaviour === 'planar-echo') {
      const native = this.seed.native ?? new Uint8Array(width * height).fill(0x7f);
      bytes.set(native.subarray(0, Math.min(native.length, bytes.length)));
      const luma = width * height;
      return [
        { offset: 0, stride: width },
        { offset: luma, stride: Math.ceil(width / 2) },
        {
          offset: luma + Math.ceil(width / 2) * Math.ceil(height / 2),
          stride: Math.ceil(width / 2),
        },
      ];
    }
    const converted = this.seed.converted ?? new Uint8Array(width * height * 4).fill(0x40);
    bytes.set(converted.subarray(0, Math.min(converted.length, bytes.length)));
    return this.seed.behaviour === 'unreported-layout'
      ? undefined
      : [{ offset: 0, stride: width * 4 }];
  }
}

function frame(seed: FrameSeed): VideoFrame {
  return new FakeVideoFrame(seed) as unknown as VideoFrame;
}

/** Install a distinct `globalThis.VideoFrame` identity so each test gets its own realm verdict. */
function installRealm(): () => void {
  const previous = Reflect.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  Object.defineProperty(globalThis, 'VideoFrame', {
    configurable: true,
    writable: true,
    value: class ScopedVideoFrame {},
  });
  return () => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'VideoFrame');
    else Object.defineProperty(globalThis, 'VideoFrame', previous);
  };
}

interface CanvasSpy {
  readonly draws: unknown[][];
  readonly restore: () => void;
}

/** Install an OffscreenCanvas whose 2D raster returns a deterministic, position-dependent picture. */
function installCanvas(
  fill: (x: number, y: number) => [number, number, number, number],
): CanvasSpy {
  const draws: unknown[][] = [];
  const previous = Reflect.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  class SpyOffscreenCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext(): unknown {
      const width = this.width;
      const height = this.height;
      return {
        drawImage: (...args: unknown[]): void => {
          draws.push(args);
        },
        getImageData: (): { data: Uint8ClampedArray } => {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const [r, g, b, a] = fill(x, y);
              const offset = (y * width + x) * 4;
              data[offset] = r;
              data[offset + 1] = g;
              data[offset + 2] = b;
              data[offset + 3] = a;
            }
          }
          return { data };
        },
      };
    }
  }
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true,
    writable: true,
    value: SpyOffscreenCanvas,
  });
  return {
    draws,
    restore: () => {
      if (previous === undefined) Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
      else Object.defineProperty(globalThis, 'OffscreenCanvas', previous);
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.restoreAllMocks();
});

function scoped<T extends { restore: () => void }>(spy: T): T {
  cleanups.push(spy.restore);
  return spy;
}

// ── pure helpers ──────────────────────────────────────────────────────────────────────────────────

describe('rgbaCopyBufferSize — explicit copyTo layout sizing', () => {
  it('returns the exact tight RGBA byte count without querying a source frame format', () => {
    expect(rgbaCopyBufferSize(128, 72)).toBe(128 * 72 * 4);
    expect(rgbaCopyBufferSize(1, 1)).toBe(4);
  });

  it('rejects invalid or unsafe dimensions', () => {
    expect(() => rgbaCopyBufferSize(0, 1)).toThrow(InputError);
    expect(() => rgbaCopyBufferSize(1, -1)).toThrow(InputError);
    expect(() => rgbaCopyBufferSize(1.5, 2)).toThrow(InputError);
    expect(() => rgbaCopyBufferSize(Number.MAX_SAFE_INTEGER, 2)).toThrow(InputError);
  });
});

describe('packedRgbFormat', () => {
  it('narrows only the packed 8-bit RGB formats', () => {
    for (const format of ['RGBA', 'RGBX', 'BGRA', 'BGRX'] as const) {
      expect(packedRgbFormat(format)).toBe(format);
    }
    for (const format of ['I420', 'I420A', 'NV12', 'I444', 'RGBA10x6'] as const) {
      expect(packedRgbFormat(format as VideoPixelFormat)).toBeUndefined();
    }
    expect(packedRgbFormat(null)).toBeUndefined();
  });
});

describe('normalizePackedRgba', () => {
  const sample = (): Uint8Array => Uint8Array.of(1, 2, 3, 4, 250, 251, 252, 253);

  it('leaves RGBA untouched', () => {
    const data = sample();
    normalizePackedRgba(data, 'RGBA');
    expect([...data]).toEqual([1, 2, 3, 4, 250, 251, 252, 253]);
  });

  it('swaps red and blue for BGR orders and forces alpha opaque for X formats', () => {
    const cases: Array<[PackedRgbFormat, number[]]> = [
      ['BGRA', [3, 2, 1, 4, 252, 251, 250, 253]],
      ['RGBX', [1, 2, 3, 255, 250, 251, 252, 255]],
      ['BGRX', [3, 2, 1, 255, 252, 251, 250, 255]],
    ];
    for (const [format, expected] of cases) {
      const data = sample();
      normalizePackedRgba(data, format);
      expect([...data], format).toEqual(expected);
    }
  });

  it('is an involution for the channel-order-only formats', () => {
    const original = sample();
    const data = sample();
    normalizePackedRgba(data, 'BGRA');
    normalizePackedRgba(data, 'BGRA');
    expect([...data]).toEqual([...original]);
  });
});

// ── readback routing ──────────────────────────────────────────────────────────────────────────────

describe('copyFrameToRgba — converting runtimes', () => {
  it('uses copyTo and never rasterizes when the runtime honours the requested format', async () => {
    cleanups.push(installRealm());
    const canvas = scoped(installCanvas(() => [9, 9, 9, 9]));
    const converted = new Uint8Array(4 * 2 * 4).map((_, index) => index % 251);
    const source = frame({ behaviour: 'converting', width: 4, height: 2, converted });

    const image = await readFrameRgba(source);

    expect(image.width).toBe(4);
    expect(image.height).toBe(2);
    expect([...image.data]).toEqual([...converted]);
    expect(canvas.draws).toHaveLength(0);
  });

  it('trusts a runtime that resolves without reporting plane layouts', async () => {
    cleanups.push(installRealm());
    const canvas = scoped(installCanvas(() => [9, 9, 9, 9]));
    const converted = new Uint8Array(2 * 2 * 4).fill(0x21);
    const source = frame({ behaviour: 'unreported-layout', width: 2, height: 2, converted });

    const image = await readFrameRgba(source);

    expect([...image.data]).toEqual([...converted]);
    expect(canvas.draws).toHaveLength(0);
  });

  it('forwards the requested colour space and rectangle to copyTo', async () => {
    cleanups.push(installRealm());
    scoped(installCanvas(() => [9, 9, 9, 9]));
    const source = frame({ behaviour: 'converting', width: 8, height: 8 });
    const spy = vi.spyOn(source, 'copyTo');

    await readFrameRgba(source, { colorSpace: 'srgb', rect: { x: 2, y: 1, width: 4, height: 3 } });

    expect(spy).toHaveBeenCalledTimes(1);
    const options = spy.mock.calls[0]?.[1];
    expect(options?.format).toBe('RGBA');
    expect(options?.colorSpace).toBe('srgb');
    expect(options?.rect).toEqual({ x: 2, y: 1, width: 4, height: 3 });
    expect(options?.layout).toEqual([{ offset: 0, stride: 4 * 4 }]);
  });

  it('omits colorSpace entirely when the caller did not ask for one', async () => {
    cleanups.push(installRealm());
    scoped(installCanvas(() => [9, 9, 9, 9]));
    const source = frame({ behaviour: 'converting', width: 2, height: 2 });
    const spy = vi.spyOn(source, 'copyTo');

    await readFrameRgba(source);

    expect(spy.mock.calls[0]?.[1] ?? {}).not.toHaveProperty('colorSpace');
  });
});

describe('copyFrameToRgba — runtimes that ignore the requested format', () => {
  it('discards a planar echo and re-reads through the presentation raster', async () => {
    cleanups.push(installRealm());
    const canvas = scoped(installCanvas((x, y) => [x * 10, y * 10, 7, 255]));
    const native = new Uint8Array(4 * 2).fill(0xab);
    const source = frame({ behaviour: 'planar-echo', width: 4, height: 2, native });

    const image = await readFrameRgba(source);

    expect(canvas.draws).toHaveLength(1);
    // Every pixel must come from the raster, so no 0xab planar sample may survive anywhere.
    expect([...image.data].some((byte) => byte === 0xab)).toBe(false);
    expect([...image.data.slice(0, 4)]).toEqual([0, 0, 7, 255]);
    expect([...image.data.slice(4, 8)]).toEqual([10, 0, 7, 255]);
  });

  it('rasterizes when copyTo refuses the conversion outright', async () => {
    cleanups.push(installRealm());
    const canvas = scoped(installCanvas(() => [1, 2, 3, 255]));
    const source = frame({ behaviour: 'refusing', width: 2, height: 2 });

    const image = await readFrameRgba(source);

    expect(canvas.draws).toHaveLength(1);
    expect([...image.data.slice(0, 4)]).toEqual([1, 2, 3, 255]);
  });

  it('remembers the verdict so later frames in the same realm skip the doomed copy', async () => {
    cleanups.push(installRealm());
    scoped(installCanvas(() => [4, 5, 6, 255]));
    const first = frame({ behaviour: 'planar-echo', width: 2, height: 2 });
    await readFrameRgba(first);

    const second = new FakeVideoFrame({ behaviour: 'planar-echo', width: 2, height: 2 });
    await readFrameRgba(second as unknown as VideoFrame);

    expect((first as unknown as FakeVideoFrame).copyCalls).toBe(1);
    expect(second.copyCalls).toBe(0);
  });

  it('judges each realm on its own behaviour', async () => {
    const restoreFirst = installRealm();
    scoped(installCanvas(() => [4, 5, 6, 255]));
    await readFrameRgba(frame({ behaviour: 'planar-echo', width: 2, height: 2 }));
    restoreFirst();

    cleanups.push(installRealm());
    const converting = new FakeVideoFrame({ behaviour: 'converting', width: 2, height: 2 });
    await readFrameRgba(converting as unknown as VideoFrame);

    expect(converting.copyCalls).toBe(1);
  });

  it('reports a typed capability error when no raster surface exists', async () => {
    cleanups.push(installRealm());
    const previousOffscreen = Reflect.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
    Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
    cleanups.push(() => {
      if (previousOffscreen !== undefined) {
        Object.defineProperty(globalThis, 'OffscreenCanvas', previousOffscreen);
      }
    });

    await expect(
      readFrameRgba(frame({ behaviour: 'refusing', width: 2, height: 2 })),
    ).rejects.toThrow(CapabilityError);
  });

  it('propagates a genuine copy failure instead of masking it with a raster', async () => {
    cleanups.push(installRealm());
    const canvas = scoped(installCanvas(() => [0, 0, 0, 255]));
    const source = frame({ behaviour: 'converting', width: 2, height: 2 });
    vi.spyOn(source, 'copyTo').mockRejectedValue(
      new DOMException('frame is closed', 'InvalidStateError'),
    );

    await expect(readFrameRgba(source)).rejects.toThrow('frame is closed');
    expect(canvas.draws).toHaveLength(0);
  });
});

describe('copyFrameToRgba — packed RGB sources', () => {
  it('copies non-RGBA packed frames natively and normalizes the channel order itself', async () => {
    cleanups.push(installRealm());
    const canvas = scoped(installCanvas(() => [0, 0, 0, 255]));
    const bgra = Uint8Array.of(10, 20, 30, 40, 50, 60, 70, 80);
    const source = frame({
      behaviour: 'converting',
      width: 2,
      height: 1,
      format: 'BGRA',
      converted: bgra,
    });
    const spy = vi.spyOn(source, 'copyTo');

    const image = await readFrameRgba(source);

    expect(spy.mock.calls[0]?.[1] ?? {}).not.toHaveProperty('format');
    expect([...image.data]).toEqual([30, 20, 10, 40, 70, 60, 50, 80]);
    expect(canvas.draws).toHaveLength(0);
  });

  it('requests the identity conversion for natively RGBA frames', async () => {
    cleanups.push(installRealm());
    scoped(installCanvas(() => [0, 0, 0, 255]));
    const source = frame({ behaviour: 'converting', width: 2, height: 1, format: 'RGBA' });
    const spy = vi.spyOn(source, 'copyTo');

    await readFrameRgba(source);

    expect(spy.mock.calls[0]?.[1]?.format).toBe('RGBA');
  });
});

describe('copyFrameToRgba — geometry and destination contract', () => {
  it('defaults to the visible rectangle rather than the coded rectangle', async () => {
    cleanups.push(installRealm());
    scoped(installCanvas(() => [0, 0, 0, 255]));
    const source = frame({
      behaviour: 'converting',
      width: 16,
      height: 16,
      visibleRect: { x: 2, y: 3, width: 10, height: 6 },
      displayWidth: 10,
      displayHeight: 6,
    });
    const spy = vi.spyOn(source, 'copyTo');

    const image = await readFrameRgba(source);

    expect(image.width).toBe(10);
    expect(image.height).toBe(6);
    expect(spy.mock.calls[0]?.[1]?.rect).toEqual({ x: 2, y: 3, width: 10, height: 6 });
  });

  it('maps a coded-space rectangle into presentation space for the raster route', async () => {
    cleanups.push(installRealm());
    const canvas = scoped(installCanvas(() => [0, 0, 0, 255]));
    const source = frame({
      behaviour: 'planar-echo',
      width: 32,
      height: 32,
      visibleRect: { x: 4, y: 4, width: 16, height: 8 },
      displayWidth: 32,
      displayHeight: 16,
    });

    await readFrameRgba(source, { rect: { x: 8, y: 4, width: 8, height: 4 } });

    // visible 16×8 presents as 32×16 ⇒ scale ×2; (8,4) is (4,0) inside the visible rect ⇒ (8,0) drawn.
    expect(canvas.draws[0]?.slice(1)).toEqual([8, 0, 16, 8, 0, 0, 8, 4]);
  });

  it('writes only the required prefix of an oversized destination', async () => {
    cleanups.push(installRealm());
    scoped(installCanvas(() => [0, 0, 0, 255]));
    const converted = new Uint8Array(2 * 2 * 4).fill(0x33);
    const destination = new Uint8Array(2 * 2 * 4 + 8).fill(0xee);
    await copyFrameToRgba(
      frame({ behaviour: 'converting', width: 2, height: 2, converted }),
      destination,
    );

    expect([...destination.slice(0, 16)]).toEqual([...converted]);
    expect([...destination.slice(16)]).toEqual([0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee]);
  });

  it('rejects a destination that cannot hold the requested rectangle', async () => {
    cleanups.push(installRealm());
    await expect(
      copyFrameToRgba(frame({ behaviour: 'converting', width: 4, height: 4 }), new Uint8Array(8)),
    ).rejects.toThrow(InputError);
  });

  it('reads every geometry the raster route may be handed', async () => {
    cleanups.push(installRealm());
    scoped(installCanvas((x, y) => [(x * 3) % 256, (y * 5) % 256, 0, 255]));
    const sizes: Array<[number, number]> = [
      [1, 1],
      [1, 7],
      [7, 1],
      [3, 5],
      [17, 2],
    ];
    for (const [width, height] of sizes) {
      const image = await readFrameRgba(frame({ behaviour: 'refusing', width, height }));
      expect(image.data.length, `${width}×${height}`).toBe(width * height * 4);
      expect([...image.data.slice(0, 4)], `${width}×${height}`).toEqual([0, 0, 0, 255]);
    }
  });

  it('round-trips randomized pictures through the converting route byte for byte', async () => {
    cleanups.push(installRealm());
    scoped(installCanvas(() => [0, 0, 0, 255]));
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >>> 8) & 0xff;
    };
    for (let trial = 0; trial < 24; trial++) {
      const width = 1 + (next() % 9);
      const height = 1 + (next() % 9);
      const converted = new Uint8Array(width * height * 4).map(() => next());
      const image = await readFrameRgba(
        frame({ behaviour: 'converting', width, height, converted }),
      );
      expect([...image.data], `${width}×${height}`).toEqual([...converted]);
    }
  });
});
