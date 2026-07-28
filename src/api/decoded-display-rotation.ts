/**
 * Public-decode display-rotation application, lazy because identity tracks are overwhelmingly common.
 */

import type { FilterDriver, FilterSpec, StageOptions } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { normalizeClockwiseRotation } from '../util/rotation.ts';
import { cancelStream } from './frame-streams.ts';

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
    const spec: FilterSpec = {
      mediaType: 'video',
      type: 'rotate',
      degrees: normalized,
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
