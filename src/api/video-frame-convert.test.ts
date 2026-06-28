import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { canvasBackedVideoFrameStream } from './video-frame-convert.ts';

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
