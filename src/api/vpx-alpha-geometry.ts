/** Full-swing sample boundary between display-RGB geometry filters and VPx alpha encoders. */

import { closeFrame } from '../kernel/frames.ts';
import { readFrameRgba } from '../util/frame-rgba.ts';
import { RGBA_BYTES_PER_PIXEL, vpxAlphaI420FromPackedGrayscale } from './vpx-alpha-pixels.ts';
import { bufferInitFromSourceFrame, rgbaPixelsFromFrame } from './vpx-alpha.ts';

/** A coded/display size mismatch is the filter's explicit deferred full-frame-scale representation. */
export function canDeferVpxAlphaFrameRepack(
  frame: Pick<VideoFrame, 'codedWidth' | 'codedHeight' | 'displayWidth' | 'displayHeight'>,
): boolean {
  return frame.codedWidth !== frame.displayWidth || frame.codedHeight !== frame.displayHeight;
}

async function codedRgbaPixelsFromFrame(frame: VideoFrame): Promise<{
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}> {
  const width = frame.codedWidth;
  const height = frame.codedHeight;
  return readFrameRgba(frame, { rect: { x: 0, y: 0, width, height } });
}

function sourceGeometryInit(
  frame: VideoFrame,
): Pick<VideoFrameBufferInit, 'visibleRect' | 'displayWidth' | 'displayHeight'> {
  const visibleRect = frame.visibleRect;
  return {
    ...(visibleRect === null
      ? {}
      : {
          visibleRect: {
            x: visibleRect.x,
            y: visibleRect.y,
            width: visibleRect.width,
            height: visibleRect.height,
          },
        }),
    displayWidth: frame.displayWidth,
    displayHeight: frame.displayHeight,
  };
}

/**
 * Restore a resized grayscale alpha raster to direct full-swing I420 luma. Feeding display RGB straight
 * to VideoEncoder applies studio-swing conversion (0 becomes 16), while alpha payload samples are values.
 * The caller retains `frame`; the returned frame is independently owned.
 */
export async function vpxAlphaFrameForEncode(frame: VideoFrame): Promise<VideoFrame> {
  // Chromium requires buffer-layout strides to cover coded geometry even when visibleRect is cropped.
  // Repack the full coded raster, then preserve its crop and deferred display scale for VideoEncoder.
  const visibleRect = frame.visibleRect;
  const hasFullCodedVisibleRect =
    visibleRect !== null &&
    visibleRect.x === 0 &&
    visibleRect.y === 0 &&
    visibleRect.width === frame.codedWidth &&
    visibleRect.height === frame.codedHeight;
  const pixels =
    hasFullCodedVisibleRect && !canDeferVpxAlphaFrameRepack(frame)
      ? await rgbaPixelsFromFrame(frame)
      : await codedRgbaPixelsFromFrame(frame);
  const packed = vpxAlphaI420FromPackedGrayscale(
    pixels.data,
    pixels.width,
    pixels.height,
    { offset: 0, stride: pixels.width * RGBA_BYTES_PER_PIXEL },
    'RGBA',
  );
  return new VideoFrame(packed.data, {
    ...bufferInitFromSourceFrame(frame, 'I420', frame.codedWidth, frame.codedHeight, packed.layout),
    ...sourceGeometryInit(frame),
    colorSpace: {
      primaries: 'bt709',
      transfer: 'bt709',
      matrix: 'bt709',
      fullRange: true,
    },
  });
}

/** Repack filtered alpha frames while preserving close-exactly-once ownership. */
export function prepareVpxAlphaFramesForEncode(
  frames: ReadableStream<VideoFrame>,
): ReadableStream<VideoFrame> {
  return frames.pipeThrough(
    new TransformStream<VideoFrame, VideoFrame>({
      async transform(frame, controller): Promise<void> {
        try {
          const output = await vpxAlphaFrameForEncode(frame);
          let handedOff = false;
          try {
            controller.enqueue(output);
            handedOff = true;
          } finally {
            if (!handedOff) closeFrame(output);
          }
        } finally {
          closeFrame(frame);
        }
      },
    }),
  );
}
