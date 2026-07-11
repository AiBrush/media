/**
 * Browser-only orchestration for the replay-backed H.264 two-pass convert path. The public engine keeps
 * only the lazy import and dependency callbacks here so probe/default startup stays within the eager
 * kernel budget; this module owns the demux/decode/filter/analysis lifecycle once two-pass is requested.
 */

import type { VideoEncoderStageOptions } from '../codecs/webcodecs-video.ts';
import type {
  CodecDriver,
  CodecQuery,
  ContainerDriver,
  Demuxer,
  EncodedChunk,
  Muxer,
  StageOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, InputError, MediaError } from '../contracts/errors.ts';
import { lazyPipeThrough } from '../kernel/executor.ts';
import type { Source } from '../sources/source.ts';
import type { SourceGeometry } from './codec-pipeline.ts';
import type { CallOptions, VideoTarget } from './types.ts';
import type { H264FirstPassSample, H264TwoPassPlan } from './video-two-pass.ts';

type ApplyVideoFilters = (
  frames: ReadableStream<VideoFrame>,
  target: VideoTarget,
  track: TrackInfo,
  signal: AbortSignal,
  options: CallOptions,
) => Promise<ReadableStream<VideoFrame>>;

/** Callbacks owned by the engine; all browser-only codec/filter routing remains behind this module. */
export interface H264TwoPassRunnerContext {
  readonly routeCodec: (query: CodecQuery, options: CallOptions) => Promise<CodecDriver>;
  readonly applyVideoFilters: ApplyVideoFilters;
  readonly stageOptions: (signal: AbortSignal, options: CallOptions) => StageOptions;
}

export interface H264TwoPassQuantizerInstallation {
  readonly stage: VideoEncoderStageOptions;
  readonly assertComplete: () => void;
}

export function installH264TwoPassQuantizer(
  baseStage: VideoEncoderStageOptions,
  plan: H264TwoPassPlan,
): H264TwoPassQuantizerInstallation {
  const usedTimestamps = new Set<number>();
  return {
    stage: {
      ...baseStage,
      quantizerAt: ({ timestampUs }) => {
        if (usedTimestamps.has(timestampUs)) {
          throw new InputError(
            'unsupported-input',
            `H.264 two-pass replay duplicated picture PTS ${timestampUs}`,
          );
        }
        usedTimestamps.add(timestampUs);
        return plan.quantizerForTimestamp(timestampUs);
      },
    },
    assertComplete: () => {
      if (usedTimestamps.size !== plan.sampleCount) {
        throw new InputError(
          'unsupported-input',
          `H.264 two-pass replay encoded ${usedTimestamps.size}/${plan.sampleCount} analyzed pictures`,
        );
      }
    },
  };
}

export function sourceGeometryOf(track: TrackInfo): SourceGeometry {
  const config = track.config;
  const durationSec =
    track.durationSec !== undefined && Number.isFinite(track.durationSec) && track.durationSec > 0
      ? track.durationSec
      : undefined;
  if (config !== undefined && 'codedWidth' in config) {
    return {
      width: config.codedWidth,
      height: config.codedHeight,
      ...(track.fps !== undefined ? { fps: track.fps } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
    };
  }
  return {
    width: undefined,
    height: undefined,
    ...(track.fps !== undefined ? { fps: track.fps } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
  };
}

interface ClosableHandle {
  close(): void;
}

function closeIfClosable(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('close' in value)) return;
  const close = (value as { readonly close?: unknown }).close;
  if (typeof close === 'function') (close as ClosableHandle['close']).call(value);
}

async function cancelStream(stream: ReadableStream<unknown>): Promise<void> {
  await stream.cancel(new MediaError('aborted', 'stream not consumed')).catch(() => {});
}

/** Perform the real first encode pass and retain only timestamped complexity evidence. */
export async function analyzeH264TwoPass(
  src: Source,
  container: ContainerDriver,
  target: VideoTarget,
  signal: AbortSignal,
  options: CallOptions,
  fragmented: boolean,
  context: H264TwoPassRunnerContext,
): Promise<H264TwoPassPlan> {
  if (src.kind === 'stream') {
    throw new CapabilityError(
      'capability-miss',
      'H.264 two-pass convert requires a replayable source; a ReadableStream is single-use',
      {
        op: 'convert',
        tried: ['webcodecs-video'],
        suggestion:
          'provide bytes, Blob, URL, or OPFS input so the filtered source can be replayed',
      },
    );
  }
  if (target.bitrate === undefined) {
    throw new InputError(
      'unsupported-input',
      'H.264 two-pass video encode requires a target bitrate',
    );
  }

  const demuxer: Demuxer = await container.demux(src, context.stageOptions(signal, options));
  let firstPassStream: ReadableStream<EncodedChunk> | undefined;
  let decodedFrames: ReadableStream<VideoFrame> | undefined;
  let filteredFrames: ReadableStream<VideoFrame> | undefined;
  try {
    const track = demuxer.tracks.find(
      (candidate) => candidate.mediaType === 'video' && candidate.config !== undefined,
    );
    if (track === undefined) {
      throw new CapabilityError(
        'capability-miss',
        'H.264 two-pass source has no decodable video track',
        { op: 'convert', tried: [container.id] },
      );
    }
    const {
      buildVideoEncoderConfigForRuntime,
      decodeQueryFor,
      decodeVideoPacketsWithAlpha,
      encodeQueryFor,
      periodicVideoKeyFrameInterval,
      unwrapPackets,
    } = await import('./codec-pipeline.ts');
    const config = await buildVideoEncoderConfigForRuntime(
      target,
      sourceGeometryOf(track),
      track.codec,
    );
    const { planVideoBitDepthConversion, videoTargetPixelBoundaryBitDepth } = await import(
      './video-stream-plan.ts'
    );
    const pixelPathBitDepth = videoTargetPixelBoundaryBitDepth(
      target,
      sourceGeometryOf(track),
      track.alpha === true,
    );
    const bitDepthPlan = planVideoBitDepthConversion({
      sourceCodec: track.codec,
      targetCodec: config.codec,
      ...(target.bitDepth !== undefined ? { targetBitDepth: target.bitDepth } : {}),
      ...(pixelPathBitDepth !== undefined ? { pixelPathBitDepth } : {}),
    });
    if (
      !config.codec.toLowerCase().startsWith('avc1.') &&
      !config.codec.toLowerCase().startsWith('avc3.')
    ) {
      throw new CapabilityError(
        'capability-miss',
        `two-pass rate allocation is implemented for H.264, not '${config.codec}'`,
        { op: 'encode', tried: ['webcodecs-video'] },
      );
    }
    const decodeQuery = await decodeQueryFor(track);
    const decoder = await context.routeCodec(decodeQuery, options);
    const encoder = await context.routeCodec(encodeQueryFor(config), options);
    /* v8 ignore start -- the two live WebCodecs passes are browser-validated. */
    decodedFrames =
      track.alpha === true
        ? decodeVideoPacketsWithAlpha(demuxer.packets(track.id), () =>
            decoder.createDecoder(decodeQuery.config, context.stageOptions(signal, options)),
          )
        : lazyPipeThrough<EncodedChunk, VideoFrame>(
            unwrapPackets(demuxer.packets(track.id)),
            () =>
              decoder.createDecoder(
                decodeQuery.config,
                context.stageOptions(signal, options),
              ) as TransformStream<EncodedChunk, VideoFrame>,
            { closeValue: closeIfClosable },
          );
    filteredFrames = await context.applyVideoFilters(decodedFrames, target, track, signal, options);
    const { H264_FIRST_PASS_QUANTIZER, planH264TwoPass } = await import('./video-two-pass.ts');
    const keyFrameInterval = periodicVideoKeyFrameInterval(target.fps, fragmented);
    const stage: VideoEncoderStageOptions = {
      ...context.stageOptions(signal, options),
      quantizer: H264_FIRST_PASS_QUANTIZER,
      ...(keyFrameInterval === undefined ? {} : { keyFrameInterval }),
    };
    const firstPassInput = bitDepthPlan.requiresPixelPath
      ? filteredFrames.pipeThrough(
          (await import('./video-frame-convert.ts')).canvasBackedVideoFrameStream(),
        )
      : filteredFrames;
    firstPassStream = firstPassInput.pipeThrough(encoder.createEncoder(config, stage));
    const reader = firstPassStream.getReader();
    const samples: H264FirstPassSample[] = [];
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value;
        samples.push({
          timestampUs: chunk.timestamp,
          byteLength: chunk.byteLength,
          keyFrame: chunk.type === 'key',
          ...(chunk.duration === null ? {} : { durationUs: chunk.duration }),
        });
      }
    } catch (error: unknown) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return planH264TwoPass(samples, target.bitrate, track.durationSec);
    /* v8 ignore stop */
  } finally {
    if (firstPassStream !== undefined && !firstPassStream.locked) {
      await firstPassStream
        .cancel(new MediaError('aborted', 'H.264 first pass closed'))
        .catch(() => {});
    } else if (filteredFrames !== undefined && !filteredFrames.locked) {
      await cancelStream(filteredFrames);
    } else if (decodedFrames !== undefined && !decodedFrames.locked) {
      await cancelStream(decodedFrames);
    }
    await demuxer.close();
  }
}

/* v8 ignore start -- requires a real VideoEncoder; validated in the browser harness (BUILD §6.1). */
/** Encode one filtered video stream and drain its chunks into the muxer. */
export async function encodeVideoStream(
  frames: ReadableStream<VideoFrame>,
  target: VideoTarget,
  sourceTrack: TrackInfo | undefined,
  muxer: Muxer,
  signal: AbortSignal,
  options: CallOptions,
  fragmented: boolean,
  twoPassPlan: H264TwoPassPlan | undefined,
  context: H264TwoPassRunnerContext,
): Promise<void> {
  const {
    buildVideoEncoderConfig,
    drainEncoderToMuxer,
    encodeQueryFor,
    encodeVideoFramesWithAlpha,
    periodicVideoKeyFrameInterval,
    requireEncoderConfig,
    videoTrackInfoFromDecoderConfig,
  } = await import('./codec-pipeline.ts');
  const sourceGeometry = sourceTrack
    ? sourceGeometryOf(sourceTrack)
    : { width: target.width, height: target.height };
  const config = buildVideoEncoderConfig(target, sourceGeometry, sourceTrack?.codec);
  const { planVideoBitDepthConversion, videoTargetPixelBoundaryBitDepth } = await import(
    './video-stream-plan.ts'
  );
  const pixelPathBitDepth =
    sourceTrack === undefined
      ? undefined
      : videoTargetPixelBoundaryBitDepth(target, sourceGeometry, sourceTrack.alpha === true);
  const bitDepthPlan = planVideoBitDepthConversion({
    ...(sourceTrack?.codec !== undefined ? { sourceCodec: sourceTrack.codec } : {}),
    targetCodec: config.codec,
    ...(target.bitDepth !== undefined ? { targetBitDepth: target.bitDepth } : {}),
    ...(pixelPathBitDepth !== undefined ? { pixelPathBitDepth } : {}),
  });
  const encoderConfig: VideoEncoderConfig =
    target.alpha === 'keep' ? { ...config, alpha: 'discard' } : config;
  if (target.twoPass === true && twoPassPlan === undefined) {
    throw new CapabilityError(
      'capability-miss',
      'H.264 two-pass encode needs a replayable convert source and cannot consume a one-shot frame stream',
      {
        op: 'encode',
        tried: ['webcodecs-video'],
        suggestion: 'use convert() with bytes, Blob, URL, or OPFS input',
      },
    );
  }
  const codec = await context.routeCodec(encodeQueryFor(encoderConfig), options);
  const keyFrameInterval = periodicVideoKeyFrameInterval(target.fps, fragmented);
  /* v8 ignore start -- requires a real VideoEncoder; validated in the browser harness (BUILD §6.1). */
  let decoderConfig: VideoDecoderConfig | undefined;
  let stage: VideoEncoderStageOptions = {
    ...context.stageOptions(signal, options),
    onDecoderConfig: (configValue) => {
      decoderConfig = configValue;
    },
    ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
    ...(keyFrameInterval !== undefined ? { keyFrameInterval } : {}),
  };
  let assertTwoPassComplete: (() => void) | undefined;
  if (twoPassPlan !== undefined) {
    const installation = installH264TwoPassQuantizer(stage, twoPassPlan);
    stage = installation.stage;
    assertTwoPassComplete = installation.assertComplete;
  }
  const alphaStage: VideoEncoderStageOptions = {
    ...context.stageOptions(signal, options),
    ...(target.crf !== undefined ? { quantizer: target.crf } : {}),
    ...(keyFrameInterval !== undefined ? { keyFrameInterval } : {}),
  };
  const encodeInput = bitDepthPlan.requiresPixelPath
    ? frames.pipeThrough((await import('./video-frame-convert.ts')).canvasBackedVideoFrameStream())
    : frames;
  const chunks =
    target.alpha === 'keep'
      ? encodeVideoFramesWithAlpha(encodeInput, {
          config: encoderConfig,
          createEncoder: (configValue, stageOptions) =>
            codec.createEncoder(configValue, stageOptions),
          colorStage: stage,
          alphaStage,
        })
      : encodeInput.pipeThrough(codec.createEncoder(encoderConfig, stage));
  await drainEncoderToMuxer(
    chunks,
    muxer,
    () =>
      videoTrackInfoFromDecoderConfig(
        requireEncoderConfig(decoderConfig, 'video'),
        target.fps,
        sourceTrack?.durationSec,
        sourceTrack?.rotation,
      ),
    signal,
  );
  assertTwoPassComplete?.();
  /* v8 ignore stop */
}
