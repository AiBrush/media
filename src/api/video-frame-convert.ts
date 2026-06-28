import { CapabilityError, InputError } from '../contracts/errors.ts';

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
  throw new CapabilityError('capability-miss', '8-bit pixel conversion requires a canvas surface', {
    op: 'convert',
    tried: ['canvas-video-frame'],
  });
}

function canvas2d(canvas: VideoCanvas): VideoCanvasContext {
  const ctx = canvas.getContext('2d', { alpha: true }) as VideoCanvasContext | null;
  if (ctx === null) {
    throw new CapabilityError(
      'capability-miss',
      '8-bit pixel conversion could not allocate 2D canvas',
      {
        op: 'convert',
        tried: ['canvas-video-frame'],
      },
    );
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
          throw new InputError(
            'unsupported-input',
            'video frame dimensions required for 8-bit conversion',
          );
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
