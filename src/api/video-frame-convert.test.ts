import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import {
  canvasBackedVideoFrameStream,
  destinationColorI420FrameStream,
  limitedI420FromPackedRgba,
  srgbToBt709TransferInPlace,
} from './video-frame-convert.ts';

function solidRgba(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([r, g, b, 255], offset);
  return data;
}

describe('limitedI420FromPackedRgba', () => {
  it('maps BT.709 black/white endpoints to studio range with neutral chroma', () => {
    expect(limitedI420FromPackedRgba(solidRgba(2, 2, 0, 0, 0), 2, 2, 'bt709-sdr')).toEqual({
      data: Uint8Array.of(16, 16, 16, 16, 128, 128),
      layout: [
        { offset: 0, stride: 2 },
        { offset: 4, stride: 1 },
        { offset: 5, stride: 1 },
      ],
    });
    expect(
      limitedI420FromPackedRgba(solidRgba(2, 2, 255, 255, 255), 2, 2, 'bt709-sdr').data,
    ).toEqual(Uint8Array.of(235, 235, 235, 235, 128, 128));
  });

  it('uses the distinct BT.709 and BT.2020-NCL luma/chroma matrices', () => {
    expect(limitedI420FromPackedRgba(solidRgba(2, 2, 255, 0, 0), 2, 2, 'bt709-sdr').data).toEqual(
      Uint8Array.of(63, 63, 63, 63, 102, 240),
    );
    expect(limitedI420FromPackedRgba(solidRgba(2, 2, 255, 0, 0), 2, 2, 'bt2020-sdr').data).toEqual(
      Uint8Array.of(74, 74, 74, 74, 97, 240),
    );
  });

  it('averages each available 2x2 chroma footprint and supports odd edges', () => {
    const pixels = Uint8Array.of(255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255);
    const converted = limitedI420FromPackedRgba(pixels, 3, 1, 'bt2020-sdr');
    expect(converted.layout).toEqual([
      { offset: 0, stride: 3 },
      { offset: 3, stride: 2 },
      { offset: 5, stride: 2 },
    ]);
    expect(converted.data).toEqual(Uint8Array.of(74, 74, 29, 97, 240, 240, 119));
  });

  it('rejects invalid dimensions and truncated packed input', () => {
    expect(() => limitedI420FromPackedRgba(new Uint8Array(), 0, 1, 'bt709-sdr')).toThrow(
      InputError,
    );
    expect(() => limitedI420FromPackedRgba(new Uint8Array(7), 2, 1, 'bt709-sdr')).toThrow(
      /needs 8 packed bytes/,
    );
  });

  it('re-encodes Canvas sRGB samples with the BT.709 transfer before YUV conversion', () => {
    const rgba = Uint8Array.of(0, 128, 255, 17);
    srgbToBt709TransferInPlace(rgba);
    expect(rgba).toEqual(Uint8Array.of(0, 115, 255, 17));
    expect(() => srgbToBt709TransferInPlace(new Uint8Array(3))).toThrow(InputError);
  });
});

interface FakeFrameSeed {
  readonly displayWidth?: number;
  readonly displayHeight?: number;
  readonly codedWidth?: number;
  readonly codedHeight?: number;
  readonly timestamp: number;
  readonly duration?: number | null;
}

class FakeCanvasContext {
  readonly draws: { readonly width: number; readonly height: number }[] = [];

  drawImage(
    _source: CanvasImageSource,
    _x: number,
    _y: number,
    width: number,
    height: number,
  ): void {
    this.draws.push({ width, height });
  }
}

class FakeCanvasSurface {
  static forceNullContext = false;
  static readonly contexts: FakeCanvasContext[] = [];

  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(_type: '2d', _options?: CanvasRenderingContext2DSettings): FakeCanvasContext | null {
    if (FakeCanvasSurface.forceNullContext) return null;
    const ctx = new FakeCanvasContext();
    FakeCanvasSurface.contexts.push(ctx);
    return ctx;
  }
}

class FakeVideoFrame {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly timestamp: number;
  readonly duration: number | null;
  closeCount = 0;

  constructor(source: FakeFrameSeed | FakeCanvasSurface, init?: VideoFrameInit) {
    if (source instanceof FakeCanvasSurface) {
      this.displayWidth = source.width;
      this.displayHeight = source.height;
      this.codedWidth = source.width;
      this.codedHeight = source.height;
      this.timestamp = init?.timestamp ?? 0;
      this.duration = init !== undefined && 'duration' in init ? (init.duration ?? null) : null;
      return;
    }
    this.displayWidth = source.displayWidth ?? source.codedWidth ?? 0;
    this.displayHeight = source.displayHeight ?? source.codedHeight ?? 0;
    this.codedWidth = source.codedWidth ?? source.displayWidth ?? 0;
    this.codedHeight = source.codedHeight ?? source.displayHeight ?? 0;
    this.timestamp = source.timestamp;
    this.duration = source.duration ?? null;
  }

  close(): void {
    this.closeCount++;
    if (this.closeCount > 1) throw new Error('fake frame closed twice');
  }
}

function replaceGlobal(name: string, value: unknown): () => void {
  const target = globalThis as unknown as Record<string, unknown>;
  const hadOwn = Object.prototype.hasOwnProperty.call(target, name);
  const previous = target[name];
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (!hadOwn) {
      Reflect.deleteProperty(target, name);
      return;
    }
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: previous,
    });
  };
}

function deleteGlobal(name: string): () => void {
  const target = globalThis as unknown as Record<string, unknown>;
  const hadOwn = Object.prototype.hasOwnProperty.call(target, name);
  const previous = target[name];
  Reflect.deleteProperty(target, name);
  return () => {
    if (!hadOwn) return;
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: previous,
    });
  };
}

interface FakePackedFrameSeed {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly timestamp: number;
  readonly duration?: number | null;
  readonly format?: VideoPixelFormat | null;
  readonly colorSpace?: {
    readonly primaries: string | null;
    readonly transfer: string | null;
    readonly matrix: string | null;
    readonly fullRange: boolean | null;
  };
}

const FAKE_SRGB = {
  primaries: 'bt709',
  transfer: 'iec61966-2-1',
  matrix: 'rgb',
  fullRange: true,
} as const;

class FakePackedVideoFrame {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly rgba: Uint8Array | undefined;
  readonly packed: Uint8Array | undefined;
  readonly bufferInit: VideoFrameBufferInit | undefined;
  readonly format: VideoPixelFormat | null;
  readonly colorSpace: {
    readonly primaries: string | null;
    readonly transfer: string | null;
    readonly matrix: string | null;
    readonly fullRange: boolean | null;
  };
  closeCount = 0;

  constructor(source: FakePackedFrameSeed | Uint8Array, init?: VideoFrameBufferInit) {
    if (source instanceof Uint8Array) {
      if (init === undefined) throw new Error('fake packed output needs an init');
      this.displayWidth = init.codedWidth;
      this.displayHeight = init.codedHeight;
      this.codedWidth = init.codedWidth;
      this.codedHeight = init.codedHeight;
      this.timestamp = init.timestamp;
      this.duration = init.duration ?? null;
      this.rgba = undefined;
      this.packed = source.slice();
      this.bufferInit = init;
      this.format = init.format;
      this.colorSpace = {
        primaries: init.colorSpace?.primaries ?? null,
        transfer: init.colorSpace?.transfer ?? null,
        matrix: init.colorSpace?.matrix ?? null,
        fullRange: init.colorSpace?.fullRange ?? null,
      };
      return;
    }
    this.displayWidth = source.width;
    this.displayHeight = source.height;
    this.codedWidth = source.width;
    this.codedHeight = source.height;
    this.timestamp = source.timestamp;
    this.duration = source.duration ?? null;
    this.rgba = source.rgba;
    this.packed = undefined;
    this.bufferInit = undefined;
    this.format = source.format ?? null;
    this.colorSpace = source.colorSpace ?? FAKE_SRGB;
  }

  copyTo(
    destination: AllowSharedBufferSource,
    options?: VideoFrameCopyToOptions,
  ): Promise<PlaneLayout[]> {
    if (options?.format === undefined) {
      expect(this.format === 'RGBA' || this.format === 'BGRA').toBe(true);
      expect(options?.colorSpace).toBeUndefined();
    } else {
      expect(options.format).toBe('RGBA');
      expect(options.colorSpace).toBe('srgb');
    }
    if (this.rgba === undefined) throw new Error('fake packed output cannot be copied as RGBA');
    new Uint8Array(
      destination instanceof ArrayBuffer || destination instanceof SharedArrayBuffer
        ? destination
        : destination.buffer,
      destination instanceof ArrayBuffer || destination instanceof SharedArrayBuffer
        ? 0
        : destination.byteOffset,
      destination instanceof ArrayBuffer || destination instanceof SharedArrayBuffer
        ? destination.byteLength
        : destination.byteLength,
    ).set(this.rgba);
    return Promise.resolve([{ offset: 0, stride: this.displayWidth * 4 }]);
  }

  close(): void {
    this.closeCount++;
    if (this.closeCount > 1) throw new Error('fake packed frame closed twice');
  }
}

describe('destinationColorI420FrameStream', () => {
  it.each([
    {
      preserveAlpha: false,
      sourceFormat: 'RGBA',
      sourceColorSpace: {
        primaries: 'bt2020',
        transfer: 'bt709',
        matrix: 'rgb',
        fullRange: true,
      },
      format: 'I420',
      colorSpace: {
        primaries: 'bt2020',
        transfer: 'bt709',
        matrix: 'bt2020-ncl',
        fullRange: false,
      },
      data: Uint8Array.of(74, 74, 74, 74, 97, 240),
      layout: [
        { offset: 0, stride: 2 },
        { offset: 4, stride: 1 },
        { offset: 5, stride: 1 },
      ],
    },
    {
      preserveAlpha: true,
      sourceFormat: null,
      sourceColorSpace: FAKE_SRGB,
      format: 'I420A',
      colorSpace: {
        primaries: 'bt2020',
        transfer: 'bt709',
        matrix: 'bt2020-ncl',
        fullRange: false,
      },
      data: Uint8Array.of(74, 74, 74, 74, 97, 240, 0, 64, 128, 255),
      layout: [
        { offset: 0, stride: 2 },
        { offset: 4, stride: 1 },
        { offset: 5, stride: 1 },
        { offset: 6, stride: 2 },
      ],
    },
  ])(
    'materializes $format with destination tags, timing, and close-once ownership',
    async ({ preserveAlpha, sourceFormat, sourceColorSpace, format, colorSpace, data, layout }) => {
      const restoreVideoFrame = replaceGlobal(
        'VideoFrame',
        FakePackedVideoFrame as unknown as typeof VideoFrame,
      );
      try {
        const frame = new FakePackedVideoFrame({
          rgba: Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 64, 255, 0, 0, 128, 255, 0, 0, 255),
          width: 2,
          height: 2,
          timestamp: 12,
          duration: 34,
          format: sourceFormat as VideoPixelFormat | null,
          colorSpace: sourceColorSpace,
        });
        const owned: VideoFrame[] = [];
        const stream = destinationColorI420FrameStream(
          { kind: 'bt2020-sdr', transform: 'colorspace' },
          preserveAlpha,
          (value) => {
            expect((value as unknown as FakePackedVideoFrame).closeCount).toBe(0);
            owned.push(value);
          },
        );
        const writer = stream.writable.getWriter();
        const reader = stream.readable.getReader();
        const read = reader.read();
        await writer.write(frame as unknown as VideoFrame);
        const result = await read;
        const out = result.value as unknown as FakePackedVideoFrame;

        expect(result.done).toBe(false);
        expect(owned).toEqual([frame as unknown as VideoFrame]);
        expect(frame.closeCount).toBe(1);
        expect(out.packed).toEqual(data);
        expect(out.bufferInit).toMatchObject({
          format,
          codedWidth: 2,
          codedHeight: 2,
          timestamp: 12,
          duration: 34,
          colorSpace,
          layout,
        });

        out.close();
        await writer.close();
        reader.releaseLock();
        writer.releaseLock();
      } finally {
        restoreVideoFrame();
      }
    },
  );

  it('converts Canvas tone-map sRGB output to BT.709 before limited-range I420', async () => {
    const restoreVideoFrame = replaceGlobal(
      'VideoFrame',
      FakePackedVideoFrame as unknown as typeof VideoFrame,
    );
    try {
      const frame = new FakePackedVideoFrame({
        rgba: solidRgba(2, 2, 128, 128, 128),
        width: 2,
        height: 2,
        timestamp: 56,
        format: null,
        colorSpace: FAKE_SRGB,
      });
      const stream = destinationColorI420FrameStream({
        kind: 'bt709-sdr',
        transform: 'tonemap',
      });
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      const read = reader.read();
      await writer.write(frame as unknown as VideoFrame);
      const result = await read;
      const out = result.value as unknown as FakePackedVideoFrame;

      expect(frame.closeCount).toBe(1);
      expect(out.packed).toEqual(Uint8Array.of(115, 115, 115, 115, 128, 128));
      expect(out.bufferInit).toMatchObject({
        format: 'I420',
        colorSpace: {
          primaries: 'bt709',
          transfer: 'bt709',
          matrix: 'bt709',
          fullRange: false,
        },
      });

      out.close();
      await writer.close();
      reader.releaseLock();
      writer.releaseLock();
    } finally {
      restoreVideoFrame();
    }
  });

  it('announces transform ownership before a conversion failure and closes the input once', async () => {
    const restoreVideoFrame = replaceGlobal(
      'VideoFrame',
      FakePackedVideoFrame as unknown as typeof VideoFrame,
    );
    try {
      const frame = new FakePackedVideoFrame({
        rgba: new Uint8Array(),
        width: 0,
        height: 2,
        timestamp: 78,
      });
      const owned: VideoFrame[] = [];
      const stream = destinationColorI420FrameStream(
        { kind: 'bt709-sdr', transform: 'tonemap' },
        false,
        (value) => owned.push(value),
      );
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      const [write, read] = await Promise.allSettled([
        writer.write(frame as unknown as VideoFrame),
        reader.read(),
      ]);

      expect(write.status).toBe('rejected');
      expect(read.status).toBe('rejected');
      if (write.status === 'rejected') expect(write.reason).toBeInstanceOf(InputError);
      if (read.status === 'rejected') expect(read.reason).toBeInstanceOf(InputError);
      expect(owned).toEqual([frame as unknown as VideoFrame]);
      expect(frame.closeCount).toBe(1);

      reader.releaseLock();
      writer.releaseLock();
    } finally {
      restoreVideoFrame();
    }
  });
});

async function expectTransformRejection(
  frame: FakeVideoFrame,
  isExpectedError: (error: unknown) => boolean,
): Promise<void> {
  const stream = canvasBackedVideoFrameStream();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const read = reader.read();
  const write = writer.write(frame as unknown as VideoFrame);
  const [readResult, writeResult] = await Promise.allSettled([read, write]);
  expect(readResult.status).toBe('rejected');
  if (readResult.status === 'rejected') expect(isExpectedError(readResult.reason)).toBe(true);
  expect(writeResult.status).toBe('rejected');
  if (writeResult.status === 'rejected') expect(isExpectedError(writeResult.reason)).toBe(true);
  reader.releaseLock();
  writer.releaseLock();
}

describe('canvasBackedVideoFrameStream', () => {
  it('uses an available canvas surface, preserves timing, and closes input frames once', async () => {
    FakeCanvasSurface.forceNullContext = false;
    FakeCanvasSurface.contexts.length = 0;
    const restoreCanvas = replaceGlobal(
      'OffscreenCanvas',
      FakeCanvasSurface as unknown as typeof OffscreenCanvas,
    );
    const restoreVideoFrame = replaceGlobal(
      'VideoFrame',
      FakeVideoFrame as unknown as typeof VideoFrame,
    );
    try {
      const stream = canvasBackedVideoFrameStream();
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      const first = new FakeVideoFrame({
        displayWidth: 2,
        displayHeight: 3,
        timestamp: 11,
      });
      const firstRead = reader.read();
      await writer.write(first as unknown as VideoFrame);
      const firstResult = await firstRead;
      const firstOut = firstResult.value as unknown as FakeVideoFrame;
      expect(firstResult.done).toBe(false);
      expect(first.closeCount).toBe(1);
      expect(firstOut.timestamp).toBe(11);
      expect(firstOut.duration).toBeNull();
      expect(firstOut.displayWidth).toBe(2);
      expect(firstOut.displayHeight).toBe(3);

      const second = new FakeVideoFrame({
        displayWidth: 0,
        displayHeight: 0,
        codedWidth: 4,
        codedHeight: 5,
        timestamp: 22,
        duration: 33,
      });
      const secondRead = reader.read();
      await writer.write(second as unknown as VideoFrame);
      const secondResult = await secondRead;
      const secondOut = secondResult.value as unknown as FakeVideoFrame;
      expect(secondResult.done).toBe(false);
      expect(second.closeCount).toBe(1);
      expect(secondOut.timestamp).toBe(22);
      expect(secondOut.duration).toBe(33);
      expect(secondOut.displayWidth).toBe(4);
      expect(secondOut.displayHeight).toBe(5);
      expect(FakeCanvasSurface.contexts[0]?.draws).toEqual([
        { width: 2, height: 3 },
        { width: 4, height: 5 },
      ]);

      await writer.close();
      reader.releaseLock();
      writer.releaseLock();
    } finally {
      restoreVideoFrame();
      restoreCanvas();
    }
  });

  it('throws a typed input error for unusable frame dimensions and closes the input frame', async () => {
    const frame = new FakeVideoFrame({
      displayWidth: 0,
      displayHeight: 1,
      codedWidth: 0,
      codedHeight: 1,
      timestamp: 0,
    });
    await expectTransformRejection(frame, (error) => error instanceof InputError);
    expect(frame.closeCount).toBe(1);
  });

  it('uses the document canvas fallback when OffscreenCanvas is absent', async () => {
    const createdTags: string[] = [];
    const restoreCanvas = deleteGlobal('OffscreenCanvas');
    const restoreDocument = replaceGlobal('document', {
      createElement(tag: string): FakeCanvasSurface {
        createdTags.push(tag);
        return new FakeCanvasSurface(0, 0);
      },
    } as unknown as Document);
    const restoreVideoFrame = replaceGlobal(
      'VideoFrame',
      FakeVideoFrame as unknown as typeof VideoFrame,
    );
    try {
      const stream = canvasBackedVideoFrameStream();
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      const frame = new FakeVideoFrame({
        displayWidth: 6,
        displayHeight: 7,
        timestamp: 44,
      });
      const read = reader.read();
      await writer.write(frame as unknown as VideoFrame);
      const result = await read;
      const out = result.value as unknown as FakeVideoFrame;
      expect(result.done).toBe(false);
      expect(createdTags).toEqual(['canvas']);
      expect(out.displayWidth).toBe(6);
      expect(out.displayHeight).toBe(7);
      expect(frame.closeCount).toBe(1);
      await writer.close();
      reader.releaseLock();
      writer.releaseLock();
    } finally {
      restoreVideoFrame();
      restoreDocument();
      restoreCanvas();
    }
  });

  it('throws a typed capability miss when no canvas substrate exists and closes the input frame', async () => {
    const restoreCanvas = deleteGlobal('OffscreenCanvas');
    const restoreDocument = deleteGlobal('document');
    try {
      const frame = new FakeVideoFrame({
        displayWidth: 2,
        displayHeight: 2,
        timestamp: 0,
      });
      await expectTransformRejection(frame, (error) => error instanceof CapabilityError);
      expect(frame.closeCount).toBe(1);
    } finally {
      restoreDocument();
      restoreCanvas();
    }
  });

  it('throws a typed capability miss when the canvas cannot allocate a 2D context', async () => {
    FakeCanvasSurface.forceNullContext = true;
    FakeCanvasSurface.contexts.length = 0;
    const restoreCanvas = replaceGlobal(
      'OffscreenCanvas',
      FakeCanvasSurface as unknown as typeof OffscreenCanvas,
    );
    try {
      const frame = new FakeVideoFrame({
        displayWidth: 2,
        displayHeight: 2,
        timestamp: 0,
      });
      await expectTransformRejection(frame, (error) => error instanceof CapabilityError);
      expect(frame.closeCount).toBe(1);
    } finally {
      FakeCanvasSurface.forceNullContext = false;
      restoreCanvas();
    }
  });
});
