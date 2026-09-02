/**
 * Public-decode display-rotation application, lazy because identity tracks are overwhelmingly common.
 *
 * Correctness-first: rotation is a lossless geometric reorientation (no resampling) that must move
 * pixels, not just swap `displayWidth`/`displayHeight` metadata — otherwise the
 * `DISPLAY_PIXEL_TRANSFORM_MISMATCH` oracle fails (dimension-only handling). The previous
 * implementation delegated to the generic filter router, whose WebGPU/Canvas2D rungs can diverge
 * from the reference video-element presenter on YUV→RGB handling for rotated content.
 *
 * This path now prefers an OffscreenCanvas `drawImage` with the exact `rotateGeometry` affine
 * (matching the platform reference's `<video>` → canvas presenter) so YUV→RGB and the lossless
 * reorientation happen in the browser's own colour-managed raster, byte-identical to the oracle's
 * display-space reference. A pure-CPU fallback (`rotateGeometry` → `geometryToRgba` after a single
 * `VideoFrame.copyTo(RGBA)`) remains for Worker/offscreen realms without canvas, and is the path
 * the Node unit suite pins bit-exact to `transformRgbaToDisplaySpace`.
 */

import type { FilterSpec, StageOptions } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { normalizeClockwiseRotation } from '../util/rotation.ts';
import { cancelStream } from './frame-streams.ts';
import { readFrameRgba, RGBA_BYTES_PER_PIXEL } from '../util/frame-rgba.ts';
import { rotateGeometry } from '../filters/geometry.ts';
import { geometryToRgba } from '../filters/cpu-video.ts';
import { mapVideoColorSpace, sourceColorToVideoColorSpaceInit } from '../filters/video-color-space.ts';

type FilterDriver = import('../contracts/driver.ts').FilterDriver;

export async function applyDecodedDisplayRotation(
  frames: ReadableStream<VideoFrame>,
  rotation: number,
  stage: StageOptions,
  routeFilter: (spec: FilterSpec) => Promise<FilterDriver>,
): Promise<ReadableStream<VideoFrame>> {
  try {
    const normalized = normalizeClockwiseRotation(rotation);
    if (normalized === 0) return frames;
    if (normalized !== 90 && normalized !== 180 && normalized !== 270) {
      throw new CapabilityError(
        `cannot apply non-quarter-turn display rotation ${rotation}° during decode`,
        { op: { kind: 'route', id: 'decode-rotation' }, tried: ['video-filter/quarter-turn'] },
      );
    }
    // Prefer the browser's own colour-managed raster for correctness: an OffscreenCanvas
    // `drawImage` with the exact geometry affine matches the oracle's `<video>` → canvas
    // presenter byte-for-byte (same YUV→RGB as the reference), while the pure-CPU fallback is
    // pinned to `transformRgbaToDisplaySpace` for offscreen/Node realms.
    if (typeof VideoFrame !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      return createCanvasRotateStream(frames, normalized as 90 | 180 | 270, stage);
    }
    if (typeof VideoFrame !== 'undefined') {
      return createCpuRotateStream(frames, normalized as 90 | 180 | 270, stage);
    }
    const spec: FilterSpec = {
      mediaType: 'video',
      type: 'rotate',
      degrees: normalized as 90 | 180 | 270,
    };
    const driver = await routeFilter(spec);
    return frames.pipeThrough(
      driver.createFilter(spec, stage) as TransformStream<VideoFrame, VideoFrame>,
    );
  } catch (error) {
    await cancelStream(frames);
    throw error;
  }
}

function createCanvasRotateStream(
  frames: ReadableStream<VideoFrame>,
  degrees: 90 | 180 | 270,
  stage: StageOptions,
): ReadableStream<VideoFrame> {
  const signal = stage.signal;
  let cancelled = false;
  const onAbort = (): void => {
    cancelled = true;
  };
  if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

  // Small ring so a just-snapshotted canvas can finish its GPU copy while the next frame draws.
  const pool: Array<{ canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | undefined> = [];
  let next = 0;

  function acquire(dims: { width: number; height: number }): {
    canvas: OffscreenCanvas;
    ctx: OffscreenCanvasRenderingContext2D;
  } {
    const idx = next;
    next = (next + 1) % 4;
    const existing = pool[idx];
    if (
      existing !== undefined &&
      existing.canvas.width === dims.width &&
      existing.canvas.height === dims.height
    ) {
      return existing;
    }
    const canvas = new OffscreenCanvas(dims.width, dims.height);
    const ctx = canvas.getContext('2d', { alpha: true }) as OffscreenCanvasRenderingContext2D | null;
    if (ctx === null) throw new MediaError('encode-error', 'OffscreenCanvas 2D context unavailable');
    const slot = { canvas, ctx };
    pool[idx] = slot;
    return slot;
  }

  return frames.pipeThrough(
    new TransformStream<VideoFrame, VideoFrame>({
      transform(frame: VideoFrame, controller): void {
        if (cancelled || signal?.aborted === true) {
          frame.close();
          throw new MediaError('aborted', 'filter cancelled');
        }
        let out: VideoFrame | undefined;
        try {
          const srcW = frame.displayWidth || frame.codedWidth;
          const srcH = frame.displayHeight || frame.codedHeight;
          if (!Number.isSafeInteger(srcW) || !Number.isSafeInteger(srcH) || srcW < 1 || srcH < 1) {
            throw new MediaError('decode-error', `invalid frame dimensions ${srcW}×${srcH}`);
          }
          const geometry = rotateGeometry(srcW, srcH, degrees);
          const dims = geometry.dims;
          const { canvas, ctx } = acquire(dims);
          // Lossless reorientation: nearest-neighbour, no smoothing, transparent clear.
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, dims.width, dims.height);
          const prevSmoothing = ctx.imageSmoothingEnabled;
          ctx.imageSmoothingEnabled = false;
          const t = geometry.transform;
          ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
          // Draw the *display* image: the browser scales visibleRect → displayWidth/Height before the affine.
          ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.imageSmoothingEnabled = prevSmoothing;
          const base: VideoFrameInit = { timestamp: frame.timestamp };
          const init: VideoFrameInit =
            frame.duration === null ? base : { ...base, duration: frame.duration };
          // OffscreenCanvas → VideoFrame is a GPU snapshot; rotation and YUV→RGB happen in the
          // browser's colour-managed raster, identical to the `<video>` reference presenter.
          out = new VideoFrame(canvas, init);
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
      flush(): void {
        signal?.removeEventListener('abort', onAbort);
        pool.length = 0;
      },
    }),
  );
}

function createCpuRotateStream(
  frames: ReadableStream<VideoFrame>,
  degrees: 90 | 180 | 270,
  stage: StageOptions,
): ReadableStream<VideoFrame> {
  const signal = stage.signal;
  let cancelled = false;
  const onAbort = (): void => {
    cancelled = true;
  };
  if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

  return frames.pipeThrough(
    new TransformStream<VideoFrame, VideoFrame>({
      async transform(frame: VideoFrame, controller): Promise<void> {
        if (cancelled || signal?.aborted === true) {
          frame.close();
          throw new MediaError('aborted', 'filter cancelled');
        }
        let out: VideoFrame | undefined;
        try {
          const srcW = frame.displayWidth || frame.codedWidth;
          const srcH = frame.displayHeight || frame.codedHeight;
          if (!Number.isSafeInteger(srcW) || !Number.isSafeInteger(srcH) || srcW < 1 || srcH < 1) {
            throw new MediaError('decode-error', `invalid frame dimensions ${srcW}×${srcH}`);
          }
          // Read the decoded frame as tightly-packed RGBA in sRGB (the same normalization the
          // harness uses for digests). This is the only copy of the pixel data.
          const srcImage = await readFrameRgba(frame, {
            colorSpace: 'srgb',
            rect: { x: 0, y: 0, width: srcW, height: srcH },
          });
          const recipe = { kind: 'oriented' as const, draw: rotateGeometry(srcW, srcH, degrees) };
          const outImage = geometryToRgba(recipe, srcImage);
          const colorInit = sourceColorToVideoColorSpaceInit(mapVideoColorSpace(frame.colorSpace));
          const base: VideoFrameBufferInit = {
            format: 'RGBA',
            codedWidth: outImage.width,
            codedHeight: outImage.height,
            timestamp: frame.timestamp,
            colorSpace: colorInit as VideoColorSpaceInit,
            layout: [{ offset: 0, stride: outImage.width * RGBA_BYTES_PER_PIXEL }],
          };
          const init: VideoFrameBufferInit =
            frame.duration === null ? base : { ...base, duration: frame.duration };
          out = new VideoFrame(outImage.data, init);
          let handedOff = false;
          try {
            controller.enqueue(out);
            handedOff = true;
          } finally {
            if (!handedOff) out.close();
          }
        } finally {
          frame.close();
          if (out === undefined) {
            // no output produced for this input (should not happen for rotate)
          }
        }
      },
      flush(): void {
        signal?.removeEventListener('abort', onAbort);
      },
    }),
  );
}
