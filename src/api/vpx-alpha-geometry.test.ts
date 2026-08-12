import { describe, expect, it } from 'vitest';
import { vpxAlphaFrameForEncode } from './vpx-alpha-geometry.ts';

interface GeometryFrameSeed {
  readonly rgba: Uint8Array;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly visibleRect: DOMRectInit | null;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly allocationPadding?: number;
}

const compactI420Layout = (width: number, height: number): PlaneLayout[] => {
  const luma = width * height;
  const chromaWidth = Math.ceil(width / 2);
  const chroma = chromaWidth * Math.ceil(height / 2);
  return [
    { offset: 0, stride: width },
    { offset: luma, stride: chromaWidth },
    { offset: luma + chroma, stride: chromaWidth },
  ];
};

function destinationBytes(destination: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(destination)
    ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
    : new Uint8Array(destination);
}

class GeometryVideoFrame {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly visibleRect: DOMRectReadOnly | null;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly rgba: Uint8Array | undefined;
  readonly packed: Uint8Array | undefined;
  readonly init: VideoFrameBufferInit | undefined;
  readonly copyOptions: VideoFrameCopyToOptions[] = [];
  readonly allocationPadding: number;
  cloneCalls = 0;

  constructor(value: GeometryFrameSeed | Uint8Array, init?: VideoFrameBufferInit) {
    if (value instanceof Uint8Array) {
      if (init === undefined) throw new Error('missing output init');
      const chromaStride = Math.ceil(init.codedWidth / 2);
      if (
        init.layout?.[0] === undefined ||
        init.layout[1] === undefined ||
        init.layout[2] === undefined ||
        init.layout[0].stride < init.codedWidth ||
        init.layout[1].stride < chromaStride ||
        init.layout[2].stride < chromaStride
      ) {
        throw new TypeError('invalid coded-plane layout');
      }
      this.codedWidth = init.codedWidth;
      this.codedHeight = init.codedHeight;
      this.visibleRect = (init.visibleRect ?? {
        x: 0,
        y: 0,
        width: init.codedWidth,
        height: init.codedHeight,
      }) as DOMRectReadOnly;
      this.displayWidth = init.displayWidth ?? this.visibleRect.width;
      this.displayHeight = init.displayHeight ?? this.visibleRect.height;
      this.timestamp = init.timestamp;
      this.duration = init.duration ?? null;
      this.rgba = undefined;
      this.packed = value.slice();
      this.init = init;
      this.allocationPadding = 0;
      return;
    }
    this.codedWidth = value.codedWidth;
    this.codedHeight = value.codedHeight;
    this.visibleRect = value.visibleRect as DOMRectReadOnly;
    this.displayWidth = value.displayWidth;
    this.displayHeight = value.displayHeight;
    this.timestamp = value.timestamp;
    this.duration = value.duration;
    this.rgba = value.rgba;
    this.packed = undefined;
    this.init = undefined;
    this.allocationPadding = value.allocationPadding ?? 0;
  }

  allocationSize(options?: VideoFrameCopyToOptions): number {
    if (options !== undefined) this.copyOptions.push(options);
    const visibleRect = this.visibleRect ?? {
      x: 0,
      y: 0,
      width: this.codedWidth,
      height: this.codedHeight,
    };
    const width = options?.rect?.width ?? visibleRect.width;
    const height = options?.rect?.height ?? visibleRect.height;
    return width * height * 4 + this.allocationPadding;
  }

  copyTo(
    destination: AllowSharedBufferSource,
    options?: VideoFrameCopyToOptions,
  ): Promise<PlaneLayout[]> {
    if (options !== undefined) this.copyOptions.push(options);
    const visibleRect = this.visibleRect ?? {
      x: 0,
      y: 0,
      width: this.codedWidth,
      height: this.codedHeight,
    };
    const rect = {
      x: options?.rect?.x ?? visibleRect.x,
      y: options?.rect?.y ?? visibleRect.y,
      width: options?.rect?.width ?? visibleRect.width,
      height: options?.rect?.height ?? visibleRect.height,
    };
    const bytes = destinationBytes(destination);
    if (this.rgba !== undefined) {
      if (options?.format !== 'RGBA')
        throw new Error(`unexpected packed format ${options?.format}`);
      const destinationLayout = options.layout?.[0] ?? { offset: 0, stride: rect.width * 4 };
      for (let row = 0; row < rect.height; row++) {
        const sourceOffset = ((rect.y + row) * this.codedWidth + rect.x) * 4;
        const destinationOffset = destinationLayout.offset + row * destinationLayout.stride;
        bytes.set(
          this.rgba.subarray(sourceOffset, sourceOffset + rect.width * 4),
          destinationOffset,
        );
      }
      return Promise.resolve([destinationLayout]);
    }
    if (
      options?.format !== 'I420' ||
      this.packed === undefined ||
      this.init?.layout === undefined
    ) {
      throw new Error(`cannot copy constructed format ${options?.format}`);
    }
    const destinationLayout = options.layout ?? compactI420Layout(rect.width, rect.height);
    for (let plane = 0; plane < 3; plane++) {
      const subsampling = plane === 0 ? 1 : 2;
      const sourcePlane = this.init.layout[plane];
      const destinationPlane = destinationLayout[plane];
      if (sourcePlane === undefined || destinationPlane === undefined) {
        throw new Error(`missing I420 plane ${plane}`);
      }
      const sourceX = rect.x / subsampling;
      const sourceY = rect.y / subsampling;
      const rowBytes = Math.ceil(rect.width / subsampling);
      const rows = Math.ceil(rect.height / subsampling);
      for (let row = 0; row < rows; row++) {
        const sourceOffset = sourcePlane.offset + (sourceY + row) * sourcePlane.stride + sourceX;
        const destinationOffset = destinationPlane.offset + row * destinationPlane.stride;
        bytes.set(this.packed.subarray(sourceOffset, sourceOffset + rowBytes), destinationOffset);
      }
    }
    return Promise.resolve(destinationLayout);
  }

  clone(): GeometryVideoFrame {
    this.cloneCalls++;
    throw new Error('deferred geometry must be repacked, not cloned');
  }
}

async function withVideoFrameConstructor<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  Object.defineProperty(globalThis, 'VideoFrame', {
    configurable: true,
    value: GeometryVideoFrame,
  });
  try {
    return await fn();
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'VideoFrame');
    else Object.defineProperty(globalThis, 'VideoFrame', original);
  }
}

describe('vpxAlphaFrameForEncode', () => {
  it('repacks coded pixels at full swing and round-trips the preserved visible crop', async () => {
    await withVideoFrameConstructor(async () => {
      const red = Array.from({ length: 16 }, (_, index) => index);
      const rgba = Uint8Array.from(red.flatMap((value) => [value, 7, 9, 255]));
      const frame = new GeometryVideoFrame({
        rgba,
        codedWidth: 4,
        codedHeight: 4,
        visibleRect: { x: 2, y: 2, width: 2, height: 2 },
        displayWidth: 1,
        displayHeight: 1,
        timestamp: 12,
        duration: 34,
      });

      const output = (await vpxAlphaFrameForEncode(
        frame as unknown as VideoFrame,
      )) as unknown as GeometryVideoFrame;

      expect(frame.cloneCalls).toBe(0);
      expect(frame.copyOptions).toEqual([
        {
          format: 'RGBA',
          rect: { x: 0, y: 0, width: 4, height: 4 },
          layout: [{ offset: 0, stride: 16 }],
        },
        {
          format: 'RGBA',
          rect: { x: 0, y: 0, width: 4, height: 4 },
          layout: [{ offset: 0, stride: 16 }],
        },
      ]);
      expect(output.packed).toEqual(
        Uint8Array.from([...red, 128, 128, 128, 128, 128, 128, 128, 128]),
      );
      expect(output.init).toMatchObject({
        format: 'I420',
        codedWidth: 4,
        codedHeight: 4,
        visibleRect: { x: 2, y: 2, width: 2, height: 2 },
        displayWidth: 1,
        displayHeight: 1,
        timestamp: 12,
        duration: 34,
        colorSpace: {
          primaries: 'bt709',
          transfer: 'bt709',
          matrix: 'bt709',
          fullRange: true,
        },
      });
      const visibleCopy = new Uint8Array(6);
      await output.copyTo(visibleCopy, {
        format: 'I420',
        rect: { x: 2, y: 2, width: 2, height: 2 },
        layout: compactI420Layout(2, 2),
      });
      expect(visibleCopy).toEqual(Uint8Array.from([10, 11, 14, 15, 128, 128]));
    });
  });

  it('uses the compact display-raster path for an uncropped unscaled frame', async () => {
    await withVideoFrameConstructor(async () => {
      const frame = new GeometryVideoFrame({
        rgba: Uint8Array.from([0, 1, 2, 255, 64, 1, 2, 255, 128, 1, 2, 255, 255, 1, 2, 255]),
        codedWidth: 2,
        codedHeight: 2,
        visibleRect: { x: 0, y: 0, width: 2, height: 2 },
        displayWidth: 2,
        displayHeight: 2,
        timestamp: 5,
        duration: null,
      });

      const output = (await vpxAlphaFrameForEncode(
        frame as unknown as VideoFrame,
      )) as unknown as GeometryVideoFrame;

      expect(output.packed).toEqual(Uint8Array.from([0, 64, 128, 255, 128, 128]));
      expect(output.init).not.toHaveProperty('duration');
      expect(frame.copyOptions).toHaveLength(2);
    });
  });

  it('trims padded coded copies and omits a null source visible rectangle', async () => {
    await withVideoFrameConstructor(async () => {
      const frame = new GeometryVideoFrame({
        rgba: Uint8Array.from([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]),
        codedWidth: 2,
        codedHeight: 2,
        visibleRect: null,
        displayWidth: 1,
        displayHeight: 1,
        timestamp: 6,
        duration: 7,
        allocationPadding: 8,
      });

      const output = (await vpxAlphaFrameForEncode(
        frame as unknown as VideoFrame,
      )) as unknown as GeometryVideoFrame;

      expect(output.packed).toEqual(Uint8Array.from([1, 2, 3, 4, 128, 128]));
      expect(output.init).not.toHaveProperty('visibleRect');
      expect(output.init).toMatchObject({ displayWidth: 1, displayHeight: 1 });
    });
  });
});
