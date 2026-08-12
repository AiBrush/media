/** Lazy live-frame filter orchestration kept outside the startup-sensitive engine kernel. */

import type { FilterDriver, FilterSpec, StageOptions, TrackInfo } from '../contracts/driver.ts';
import { composeChain } from '../kernel/executor.ts';
import type { RouteCost } from '../kernel/tier-thresholds.ts';
import { MICROS_PER_SECOND, audioGeometryOf, sourceGeometryOf } from './op-support.ts';
import type { AudioTarget, CallOptions, VideoTarget } from './types.ts';

export interface MediaFilterRunnerContext {
  routeFilter(spec: FilterSpec, options: CallOptions, cost?: RouteCost): Promise<FilterDriver>;
  stageOptions(signal: AbortSignal, options: CallOptions): StageOptions;
}

export async function applyVideoFrameFilters(
  frames: ReadableStream<VideoFrame>,
  target: VideoTarget,
  track: TrackInfo,
  signal: AbortSignal,
  options: CallOptions,
  context: MediaFilterRunnerContext,
): Promise<ReadableStream<VideoFrame>> {
  const { retimeVideoFrameStream, videoFilterRouteCost, videoFilterSpecs } = await import(
    './video-stream-plan.ts'
  );
  const sourceGeometry = sourceGeometryOf(track);
  const specs = videoFilterSpecs(target, sourceGeometry);
  const routeCost = videoFilterRouteCost(target, sourceGeometry);
  let output = frames;
  const stages: TransformStream<VideoFrame, VideoFrame>[] = [];
  for (const spec of specs) {
    const driver = await context.routeFilter(spec, options, routeCost);
    stages.push(
      driver.createFilter(spec, context.stageOptions(signal, options)) as TransformStream<
        VideoFrame,
        VideoFrame
      >,
    );
  }
  if (stages.length > 0) output = composeChain(output, stages);
  if (target.fps !== undefined) {
    const durationUs =
      track.durationSec !== undefined && Number.isFinite(track.durationSec) && track.durationSec > 0
        ? Math.round(track.durationSec * MICROS_PER_SECOND)
        : undefined;
    output = retimeVideoFrameStream(
      output,
      durationUs === undefined ? { fps: target.fps } : { fps: target.fps, durationUs },
    );
  }
  return output;
}

export async function applyAudioFrameFilters(
  frames: ReadableStream<AudioData>,
  target: AudioTarget,
  track: TrackInfo,
  signal: AbortSignal,
  options: CallOptions,
  context: MediaFilterRunnerContext,
): Promise<ReadableStream<AudioData>> {
  const { audioFilterSpecs, audioTargetCanBypassFilterPlanner } = await import(
    './audio-stream-plan.ts'
  );
  if (audioTargetCanBypassFilterPlanner(target)) return frames;
  const specs = audioFilterSpecs(target, audioGeometryOf(track));
  if (specs.length === 0) return frames;
  const stages: TransformStream<AudioData, AudioData>[] = [];
  for (const spec of specs) {
    const driver = await context.routeFilter(spec, options);
    stages.push(
      driver.createFilter(spec, context.stageOptions(signal, options)) as TransformStream<
        AudioData,
        AudioData
      >,
    );
  }
  return composeChain(frames, stages);
}
