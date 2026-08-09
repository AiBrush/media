import { CapabilityError, InputError } from '../contracts/errors.ts';
import { eotf, oetf } from '../filters/gpu-uniforms.ts';
import type { VideoColorMuxIntent } from './mux-trackinfo.ts';

type VideoCanvas = OffscreenCanvas | HTMLCanvasElement;
type VideoCanvasContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function createVideoCanvas(width: number, height: number): VideoCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new CapabilityError('8-bit pixel conversion requires a canvas surface', {
    op: { kind: 'route', id: 'convert' },
    tried: ['canvas-video-frame'],
  });
}

function canvas2d(canvas: VideoCanvas): VideoCanvasContext {
  const ctx = canvas.getContext('2d', { alpha: true }) as VideoCanvasContext | null;
  if (ctx === null) {
    throw new CapabilityError('8-bit pixel conversion could not allocate 2D canvas', {
      op: { kind: 'route', id: 'convert' },
      tried: ['canvas-video-frame'],
    });
  }
  return ctx;
}

function resizeCanvas(canvas: VideoCanvas, width: number, height: number): VideoCanvas {
  if (canvas.width === width && canvas.height === height) return canvas;
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function canvasBackedVideoFrameStream(): TransformStream<VideoFrame, VideoFrame> {
  let canvas: VideoCanvas | undefined;
  let ctx: VideoCanvasContext | undefined;
  return new TransformStream<VideoFrame, VideoFrame>({
    transform(frame, controller): void {
      try {
        const width = frame.displayWidth || frame.codedWidth;
        const height = frame.displayHeight || frame.codedHeight;
        if (
          !Number.isSafeInteger(width) ||
          width <= 0 ||
          !Number.isSafeInteger(height) ||
          height <= 0
        ) {
          throw new InputError('video frame dimensions required for 8-bit conversion');
        }
        canvas =
          canvas === undefined
            ? createVideoCanvas(width, height)
            : resizeCanvas(canvas, width, height);
        ctx =
          ctx === undefined || canvas.width !== width || canvas.height !== height
            ? canvas2d(canvas)
            : ctx;
        ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, width, height);
        const init: VideoFrameInit =
          frame.duration == null
            ? { timestamp: frame.timestamp }
            : { timestamp: frame.timestamp, duration: frame.duration };
        const out = new VideoFrame(canvas as CanvasImageSource, init);
        let handedOff = false;
        try {
          controller.enqueue(out);
          handedOff = true;
        } finally {
          if (!handedOff) out.close();
        }
      } finally {
        frame.close();
      }
    },
  });
}

export interface LimitedI420Frame {
  readonly data: Uint8Array;
  readonly layout: readonly PlaneLayout[];
}

interface YuvMatrixCoefficients {
  readonly kr: number;
  readonly kb: number;
}

const BT709_YUV: YuvMatrixCoefficients = { kr: 0.2126, kb: 0.0722 };
const BT2020_NCL_YUV: YuvMatrixCoefficients = { kr: 0.2627, kb: 0.0593 };

function assertPackedRgbaDimensions(source: Uint8Array, width: number, height: number): void {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new InputError(
      `RGBA to I420 conversion needs positive integer dimensions, got ${width}x${height}`,
    );
  }
  const required = width * height * 4;
  if (!Number.isSafeInteger(required) || source.byteLength < required) {
    throw new InputError(
      `RGBA to I420 conversion needs ${required} packed bytes, got ${source.byteLength}`,
    );
  }
}

function limitedLuma(value: number): number {
  return Math.max(16, Math.min(235, Math.round(16 + 219 * value)));
}

function limitedChroma(value: number): number {
  return Math.max(16, Math.min(240, Math.round(128 + 224 * value)));
}

/**
 * Convert nonlinear full-range RGB samples into studio-range BT.709 or BT.2020-NCL I420. This explicit
 * boundary prevents Chromium/OpenH264's generic RGBA→I420 fallback from silently applying BT.601. Chroma
 * is the arithmetic mean of each available 2×2 block before 8-bit quantization, including odd edges.
 */
export function limitedI420FromPackedRgba(
  source: Uint8Array,
  width: number,
  height: number,
  color: VideoColorMuxIntent['kind'],
): LimitedI420Frame {
  assertPackedRgbaDimensions(source, width, height);
  const coefficients = color === 'bt2020-sdr' ? BT2020_NCL_YUV : BT709_YUV;
  const { kr, kb } = coefficients;
  const kg = 1 - kr - kb;
  const cbScale = 1 / (2 * (1 - kb));
  const crScale = 1 / (2 * (1 - kr));
  const ySize = width * height;
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const chromaSize = chromaWidth * chromaHeight;
  const data = new Uint8Array(ySize + chromaSize * 2);
  const layout: PlaneLayout[] = [
    { offset: 0, stride: width },
    { offset: ySize, stride: chromaWidth },
    { offset: ySize + chromaSize, stride: chromaWidth },
  ];

  for (let blockY = 0; blockY < chromaHeight; blockY++) {
    for (let blockX = 0; blockX < chromaWidth; blockX++) {
      let cb = 0;
      let cr = 0;
      let count = 0;
      for (let dy = 0; dy < 2; dy++) {
        const y = blockY * 2 + dy;
        if (y >= height) continue;
        for (let dx = 0; dx < 2; dx++) {
          const x = blockX * 2 + dx;
          if (x >= width) continue;
          const sourceOffset = (y * width + x) * 4;
          const r = (source[sourceOffset] ?? 0) / 255;
          const g = (source[sourceOffset + 1] ?? 0) / 255;
          const b = (source[sourceOffset + 2] ?? 0) / 255;
          const luma = kr * r + kg * g + kb * b;
          data[y * width + x] = limitedLuma(luma);
          cb += (b - luma) * cbScale;
          cr += (r - luma) * crScale;
          count++;
        }
      }
      const chromaIndex = blockY * chromaWidth + blockX;
      data[ySize + chromaIndex] = limitedChroma(cb / count);
      data[ySize + chromaSize + chromaIndex] = limitedChroma(cr / count);
    }
  }
  return { data, layout };
}

function limitedI420AFromPackedRgba(
  source: Uint8Array,
  width: number,
  height: number,
  color: VideoColorMuxIntent['kind'],
): LimitedI420Frame {
  const yuv = limitedI420FromPackedRgba(source, width, height, color);
  const alphaOffset = yuv.data.byteLength;
  const data = new Uint8Array(alphaOffset + width * height);
  data.set(yuv.data);
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[alphaOffset + pixel] = source[pixel * 4 + 3] as number;
  }
  return {
    data,
    layout: [...yuv.layout, { offset: alphaOffset, stride: width }],
  };
}

function limitedI420ColorSpace(kind: VideoColorMuxIntent['kind']): VideoColorSpaceInit {
  return (kind === 'bt2020-sdr'
    ? {
        primaries: 'bt2020',
        transfer: 'bt709',
        matrix: 'bt2020-ncl',
        fullRange: false,
      }
    : {
        primaries: 'bt709',
        transfer: 'bt709',
        matrix: 'bt709',
        fullRange: false,
      }) as unknown as VideoColorSpaceInit;
}

type PackedRgbFormat = 'RGBA' | 'RGBX' | 'BGRA' | 'BGRX';
type PackedRgbTransfer = 'bt709' | 'srgb' | 'unknown';

interface PackedRgbaRead {
  readonly data: Uint8Array;
  readonly transfer: PackedRgbTransfer;
}

function packedRgbFormat(format: VideoPixelFormat | null): PackedRgbFormat | undefined {
  return format === 'RGBA' || format === 'RGBX' || format === 'BGRA' || format === 'BGRX'
    ? format
    : undefined;
}

function packedTransfer(transfer: string | null): PackedRgbTransfer {
  if (transfer === 'bt709' || transfer === 'smpte170m') return 'bt709';
  if (transfer === 'iec61966-2-1') return 'srgb';
  return 'unknown';
}

function normalizePackedRgba(data: Uint8Array, format: PackedRgbFormat): void {
  const swapRedBlue = format === 'BGRA' || format === 'BGRX';
  const opaque = format === 'RGBX' || format === 'BGRX';
  for (let offset = 0; offset < data.byteLength; offset += 4) {
    if (swapRedBlue) {
      const red = data[offset] as number;
      data[offset] = data[offset + 2] as number;
      data[offset + 2] = red;
    }
    if (opaque) data[offset + 3] = 0xff;
  }
}

/** Re-encode sRGB nonlinear samples with the BT.709/BT.2020 SDR transfer, preserving alpha. */
export function srgbToBt709TransferInPlace(data: Uint8Array): void {
  if (data.byteLength % 4 !== 0) {
    throw new InputError(
      `sRGB transfer conversion needs packed RGBA bytes, got ${data.byteLength}`,
    );
  }
  for (let offset = 0; offset < data.byteLength; offset += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const sample = (data[offset + channel] as number) / 255;
      data[offset + channel] = Math.round(oetf('bt709', eotf('srgb', sample)) * 255);
    }
  }
}

async function packedRgbaFromFrame(
  frame: VideoFrame,
  width: number,
  height: number,
  intent: VideoColorMuxIntent,
): Promise<PackedRgbaRead> {
  const byteLength = width * height * 4;
  const data = new Uint8Array(byteLength);
  const nativeFormat = packedRgbFormat(frame.format);
  const rect = { x: 0, y: 0, width, height };
  const layout = [{ offset: 0, stride: width * 4 }];
  if (nativeFormat !== undefined) {
    // Omitting `format` and `colorSpace` requests the frame's native packed bytes. Asking for RGBA without
    // a colorSpace would instead default to sRGB and irreversibly gamut-map a correctly tagged BT.2020
    // CPU-filter output before we can build its BT.2020-NCL planes.
    await frame.copyTo(data, { rect, layout });
    normalizePackedRgba(data, nativeFormat);
    return { data, transfer: packedTransfer(frame.colorSpace.transfer) };
  }
  if (intent.kind === 'bt2020-sdr' && (frame.colorSpace.primaries as string | null) === 'bt2020') {
    throw new CapabilityError(
      'BT.2020 destination frame has no copyable native RGB format; an sRGB copy would lose gamut',
      {
        op: { kind: 'route', id: 'convert-video-color' },
        tried: ['video-frame-native-rgb-copy'],
        suggestion: 'use a filter substrate that emits a copyable packed RGB frame',
      },
    );
  }
  // Canvas/WebGPU frames can expose a null native format. Their only portable RGB copy target is sRGB;
  // WebGPU BT.2020 output deliberately carries target-coded numeric values in that canvas, while the
  // Canvas2D tone-map output genuinely uses sRGB and is transfer-converted below.
  await frame.copyTo(data, { format: 'RGBA', colorSpace: 'srgb', rect, layout });
  return { data, transfer: 'srgb' };
}

/**
 * Materialize transformed RGB as exact limited-range I420 immediately before video encode. The VPx
 * dual-stream alpha route can request I420A so this colour boundary never destroys its fourth plane.
 * `onInputOwned` fires synchronously once the transform has assumed close-on-every-exit ownership; the
 * observer may stop pre-entry tracking but must not close the frame itself.
 */
export function destinationColorI420FrameStream(
  intent: VideoColorMuxIntent,
  preserveAlpha = false,
  onInputOwned?: (frame: VideoFrame) => void,
): TransformStream<VideoFrame, VideoFrame> {
  return new TransformStream<VideoFrame, VideoFrame>({
    async transform(frame, controller): Promise<void> {
      try {
        // The transform owns `frame` from this synchronous boundary onward and closes it in the
        // `finally` below on success or failure. Callers that retain pre-entry cleanup responsibility
        // can use this handshake to stop tracking the frame without guessing from writer.write().
        onInputOwned?.(frame);
        const width = frame.displayWidth || frame.codedWidth;
        const height = frame.displayHeight || frame.codedHeight;
        if (
          !Number.isSafeInteger(width) ||
          width <= 0 ||
          !Number.isSafeInteger(height) ||
          height <= 0
        ) {
          throw new InputError('destination colour conversion requires video frame dimensions');
        }
        const rgbaByteLength = width * height * 4;
        if (!Number.isSafeInteger(rgbaByteLength)) {
          throw new InputError('destination colour conversion frame is too large');
        }
        const rgba = await packedRgbaFromFrame(frame, width, height, intent);
        if (intent.transform === 'tonemap') {
          if (rgba.transfer === 'srgb') srgbToBt709TransferInPlace(rgba.data);
          else if (rgba.transfer !== 'bt709') {
            throw new CapabilityError(
              'tone-map destination RGB transfer is neither sRGB nor BT.709',
              {
                op: { kind: 'route', id: 'convert-video-color' },
                tried: ['video-frame-color-space'],
              },
            );
          }
        }
        const converted = preserveAlpha
          ? limitedI420AFromPackedRgba(rgba.data, width, height, intent.kind)
          : limitedI420FromPackedRgba(rgba.data, width, height, intent.kind);
        const base: VideoFrameBufferInit = {
          format: preserveAlpha ? 'I420A' : 'I420',
          codedWidth: width,
          codedHeight: height,
          timestamp: frame.timestamp,
          colorSpace: limitedI420ColorSpace(intent.kind),
          layout: [...converted.layout],
        };
        const out = new VideoFrame(
          converted.data,
          frame.duration === null ? base : { ...base, duration: frame.duration },
        );
        let handedOff = false;
        try {
          controller.enqueue(out);
          handedOff = true;
        } finally {
          if (!handedOff) out.close();
        }
      } finally {
        frame.close();
      }
    },
  });
}
