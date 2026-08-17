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
import { raceAbort } from '../sources/abort.ts';
import type { Source } from '../sources/source.ts';
import { packedRgbFormat } from '../util/frame-rgba.ts';
import type { SourceGeometry } from './codec-pipeline.ts';
import {
  type RuntimeVideoFallbackKind,
  type RuntimeVideoTerminalContext,
  decodeVideoWithRuntimeFallback,
  planRuntimeVideoFallback,
} from './replayable-video-decoder.ts';
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

export interface RoutedVideoEncoder {
  readonly codec: CodecDriver;
  readonly config: VideoEncoderConfig;
  readonly usedAlternateConfig: boolean;
}

/**
 * Route the preferred encoder config, then try a caller-provided portable rate contract and finally an
 * implicitly inherited H.264 Main/High profile as Constrained Baseline. Every retry happens before frame
 * consumption and only after a typed capability miss; successful preferred routes, explicit codec targets,
 * non-H.264 sources, and non-capability failures are left untouched.
 */
export async function routeVideoEncoderWithImplicitH264Fallback(
  config: VideoEncoderConfig,
  target: Pick<VideoTarget, 'codec'>,
  sourceCodecString: string | undefined,
  options: CallOptions,
  routeCodec: H264TwoPassRunnerContext['routeCodec'],
  alternateConfig?: VideoEncoderConfig,
): Promise<RoutedVideoEncoder> {
  const { encodeQueryFor, h264CodecStringForDimensions } = await import('./codec-pipeline.ts');
  try {
    return {
      codec: await routeCodec(encodeQueryFor(config), options),
      config,
      usedAlternateConfig: false,
    };
  } catch (error: unknown) {
    if (!isTypedCapabilityError(error)) throw error;
    let terminalError = error;
    if (alternateConfig !== undefined) {
      try {
        return {
          codec: await routeCodec(encodeQueryFor(alternateConfig), options),
          config: alternateConfig,
          usedAlternateConfig: true,
        };
      } catch (alternateError: unknown) {
        if (!isTypedCapabilityError(alternateError)) throw alternateError;
        terminalError = alternateError;
      }
    }
    const inheritedH264Profile =
      target.codec === undefined &&
      /^(?:avc1|avc3)\.(?:4d|64)/i.test(sourceCodecString ?? '') &&
      /^(?:avc1|avc3)\.(?:4d|64)/i.test(config.codec);
    if (!inheritedH264Profile) throw terminalError;
    const profileBase = alternateConfig ?? config;
    const fallbackConfig: VideoEncoderConfig = {
      ...profileBase,
      codec: h264CodecStringForDimensions(
        profileBase.width,
        profileBase.height,
        profileBase.framerate,
      ),
    };
    return {
      codec: await routeCodec(encodeQueryFor(fallbackConfig), options),
      config: fallbackConfig,
      usedAlternateConfig: alternateConfig !== undefined,
    };
  }
}

/**
 * Native ABR encoders under-allocate their first few pictures before their rate model has observations.
 * Prime H.264 targets with disposable pictures. Explicit H.264 average bitrate still keeps its
 * exact output budget; only explicit constant/quantizer modes and two-pass schedules opt out. AV1's
 * high-cadence implicit path retains its eight-picture prime and all other codecs remain unprimed.
 */
export function implicitRateControlWarmupFrames(
  target: Pick<VideoTarget, 'bitrate' | 'quality' | 'bitrateMode' | 'crf' | 'twoPass'>,
  codec: string,
  frameRate: number | undefined,
): number | undefined {
  if (
    target.bitrateMode !== undefined ||
    target.crf !== undefined ||
    target.twoPass === true ||
    target.quality !== undefined
  ) {
    return undefined;
  }
  const normalized = codec.toLowerCase();
  if (target.bitrate !== undefined) {
    if (!normalized.startsWith('avc1.') && !normalized.startsWith('avc3.')) return undefined;
    return frameRate !== undefined && frameRate > 30.5 ? 8 : 3;
  }
  // Container time-base division can report nominal 30 fps as 30.0000003; require a real cadence step.
  if (normalized.startsWith('av01.') && frameRate !== undefined && frameRate > 30.5) return 8;
  if (normalized.startsWith('avc1.') || normalized.startsWith('avc3.')) return 3;
  return undefined;
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
          throw new InputError(`H.264 two-pass replay duplicated picture PTS ${timestampUs}`);
        }
        usedTimestamps.add(timestampUs);
        return plan.quantizerForTimestamp(timestampUs);
      },
    },
    assertComplete: () => {
      if (usedTimestamps.size !== plan.sampleCount) {
        throw new InputError(
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
      ...(track.rotation !== undefined ? { rotation: track.rotation } : {}),
      ...(track.fps !== undefined ? { fps: track.fps } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(track.bitrate !== undefined ? { bitrate: track.bitrate } : {}),
    };
  }
  return {
    width: undefined,
    height: undefined,
    ...(track.rotation !== undefined ? { rotation: track.rotation } : {}),
    ...(track.fps !== undefined ? { fps: track.fps } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(track.bitrate !== undefined ? { bitrate: track.bitrate } : {}),
  };
}

async function cancelStream(stream: ReadableStream<unknown>): Promise<void> {
  await stream.cancel(new MediaError('aborted', 'stream not consumed')).catch(() => {});
}

export type H264ReplayDecodePhase = 'source-replay' | 'private-candidate';

/** Preserve the typed boundary across independently emitted ESM chunks and worker realms. */
function isTypedCapabilityError(error: unknown): error is CapabilityError {
  const value = typeof error === 'object' && error !== null ? error : undefined;
  return (
    error instanceof CapabilityError ||
    (value !== undefined &&
      Object.prototype.toString.call(value) === '[object Error]' &&
      'name' in value &&
      value.name === 'CapabilityError' &&
      'code' in value &&
      value.code === 'capability-miss')
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Attach the exact private/source phase to a terminal native decode miss. A private candidate was
 * generated by this operation, so its failure is a decode fault rather than evidence that the caller's
 * source codec is unavailable. Source misses remain capability-typed, but only with explicit attempt and
 * commit evidence after the bounded fallback seam has made its decision.
 */
export function tagH264ReplayDecodeError(
  error: unknown,
  phase: H264ReplayDecodePhase,
  codec: string,
  driverId: string,
  fallbackKind: RuntimeVideoFallbackKind | undefined,
  terminal: RuntimeVideoTerminalContext,
): unknown {
  if (!isTypedCapabilityError(error)) return error;
  const facts = {
    phase,
    codec,
    primaryDriver: driverId,
    attempt: terminal.attempt,
    primaryFrameEmitted: terminal.primaryFrameEmitted,
    fallback: fallbackKind ?? 'none',
  } as const;
  const message = `H.264 ${phase} decode failed on ${terminal.attempt}: ${describeError(error)}`;
  if (phase === 'private-candidate') {
    return new MediaError('decode-error', message, facts, { cause: error });
  }
  return new CapabilityError(
    message,
    {
      op: { kind: 'route', id: 'h264-source-replay-decode', facts },
      tried:
        terminal.attempt === 'fallback' && fallbackKind !== undefined
          ? [driverId, fallbackKind]
          : [driverId],
      suggestion: terminal.primaryFrameEmitted
        ? 'the decoder failed after publishing source frames; retry from a fresh operation'
        : 'try another browser or provide a source codec with a registered software decode tail',
    },
    { cause: error },
  );
}

/** Decode one replay leg with the same bounded native-to-software policy as ordinary convert. */
export function decodeH264ReplayVideo(
  chunks: ReadableStream<EncodedChunk>,
  decoder: CodecDriver,
  config: VideoDecoderConfig,
  signal: AbortSignal,
  options: CallOptions,
  context: H264TwoPassRunnerContext,
  phase: H264ReplayDecodePhase,
): ReadableStream<VideoFrame> {
  const decodeStage = context.stageOptions(signal, options);
  const fallbackKind = planRuntimeVideoFallback(decoder.id, config.codec, {
    ...(decodeStage.determinism === undefined ? {} : { determinism: decodeStage.determinism }),
    ...(decodeStage.pinDriver === undefined ? {} : { pinDriver: decodeStage.pinDriver }),
  });
  const createFallback =
    fallbackKind === undefined
      ? undefined
      : async (): Promise<TransformStream<EncodedChunk, VideoFrame>> => {
          if (fallbackKind === 'wasm-vpx') {
            const fallbackOptions: CallOptions = {
              ...options,
              strategy: { ...options.strategy, pinDriver: 'wasm-vpx' },
            };
            const fallback = await context.routeCodec(
              { mediaType: 'video', direction: 'decode', config },
              fallbackOptions,
            );
            return fallback.createDecoder(
              config,
              context.stageOptions(signal, fallbackOptions),
            ) as TransformStream<EncodedChunk, VideoFrame>;
          }
          const fallbackOptions: CallOptions = {
            ...options,
            strategy: { ...options.strategy, determinism: 'force-software' },
          };
          return decoder.createDecoder(
            config,
            context.stageOptions(signal, fallbackOptions),
          ) as TransformStream<EncodedChunk, VideoFrame>;
        };
  return decodeVideoWithRuntimeFallback(
    chunks,
    () => decoder.createDecoder(config, decodeStage) as TransformStream<EncodedChunk, VideoFrame>,
    createFallback,
    {
      signal,
      mapTerminalError: (error, terminal) =>
        tagH264ReplayDecodeError(error, phase, config.codec, decoder.id, fallbackKind, terminal),
    },
  );
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
      'H.264 two-pass convert requires a replayable source; a ReadableStream is single-use',
      {
        op: { kind: 'route', id: 'convert' },
        tried: ['webcodecs-video'],
        suggestion:
          'provide bytes, Blob, URL, or OPFS input so the filtered source can be replayed',
      },
    );
  }
  if (target.bitrate === undefined) {
    throw new InputError('H.264 two-pass video encode requires a target bitrate');
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
      throw new CapabilityError('H.264 two-pass source has no decodable video track', {
        op: { kind: 'route', id: 'convert' },
        tried: [container.id],
      });
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
    const { planVideoBitDepthConversion, videoColorMuxIntent, videoTargetPixelBoundaryBitDepth } =
      await import('./video-stream-plan.ts');
    const colorIntent = videoColorMuxIntent(target);
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
        `two-pass rate allocation is implemented for H.264, not '${config.codec}'`,
        { op: { kind: 'route', id: 'encode' }, tried: ['webcodecs-video'] },
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
        : decodeH264ReplayVideo(
            unwrapPackets(demuxer.packets(track.id)),
            decoder,
            decodeQuery.config,
            signal,
            options,
            context,
            'source-replay',
          );
    filteredFrames = await context.applyVideoFilters(decodedFrames, target, track, signal, options);
    const { H264_FIRST_PASS_QUANTIZER, assertH264TwoPassPictureEvidenceCapacity, planH264TwoPass } =
      await import('./video-two-pass.ts');
    const keyFrameInterval = periodicVideoKeyFrameInterval(target.fps, fragmented);
    const stage: VideoEncoderStageOptions = {
      ...context.stageOptions(signal, options),
      quantizer: H264_FIRST_PASS_QUANTIZER,
      ...(keyFrameInterval === undefined ? {} : { keyFrameInterval }),
    };
    let firstPassInput = filteredFrames;
    if (bitDepthPlan.kind === 'downconvert' && bitDepthPlan.requiresPixelPath) {
      firstPassInput = firstPassInput.pipeThrough(
        (await import('./video-frame-convert.ts')).canvasBackedVideoFrameStream(),
      );
    }
    if (colorIntent !== undefined) {
      firstPassInput = firstPassInput.pipeThrough(
        (await import('./video-frame-convert.ts')).destinationColorI420FrameStream(
          colorIntent,
          target.alpha === 'keep',
        ),
      );
    }
    if (bitDepthPlan.kind === 'encoder-widen') {
      firstPassInput = firstPassInput.pipeThrough(
        (await import('./video-frame-convert.ts')).widenedI420VideoFrameStream(
          bitDepthPlan.sourceBitDepth,
          bitDepthPlan.targetBitDepth,
        ),
      );
    }
    firstPassStream = firstPassInput.pipeThrough(encoder.createEncoder(config, stage));
    const reader = firstPassStream.getReader();
    const samples: H264FirstPassSample[] = [];
    try {
      while (true) {
        const result = await raceAbort(reader.read(), signal);
        if (result.done) break;
        const chunk = result.value;
        assertH264TwoPassPictureEvidenceCapacity(samples.length + 1);
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
  capabilityFallbackTarget?: VideoTarget,
): Promise<void> {
  const {
    buildVideoEncoderConfig,
    assertVideoEncoderOutputBitDepth,
    drainEncoderToMuxer,
    encodeVideoFramesWithAlpha,
    periodicVideoKeyFrameInterval,
    requireEncoderConfig,
    outputVideoRotation,
    videoTrackInfoFromDecoderConfig,
  } = await import('./codec-pipeline.ts');
  const sourceGeometry = sourceTrack
    ? sourceGeometryOf(sourceTrack)
    : { width: target.width, height: target.height };
  const config = await (
    await import('./codec-runtime-quirks.ts')
  ).buildVideoEncoderConfigForRuntime(target, sourceGeometry, sourceTrack?.codec);
  const { planVideoBitDepthConversion, videoColorMuxIntent, videoTargetPixelBoundaryBitDepth } =
    await import('./video-stream-plan.ts');
  const pixelPathBitDepth =
    sourceTrack === undefined
      ? undefined
      : videoTargetPixelBoundaryBitDepth(target, sourceGeometry, sourceTrack.alpha === true);
  // A source track proves this runner was reached from convert/live after the engine composed the target
  // filter plan. Public encode() receives already-shaped frames and has no such proof, so target colour
  // options there must never manufacture transform metadata.
  const colorIntent = sourceTrack === undefined ? undefined : videoColorMuxIntent(target);
  const bitDepthPlan = planVideoBitDepthConversion({
    ...(sourceTrack?.codec !== undefined ? { sourceCodec: sourceTrack.codec } : {}),
    targetCodec: config.codec,
    ...(target.bitDepth !== undefined ? { targetBitDepth: target.bitDepth } : {}),
    ...(pixelPathBitDepth !== undefined ? { pixelPathBitDepth } : {}),
  });
  const preferredEncoderConfig: VideoEncoderConfig =
    target.alpha === 'keep' ? { ...config, alpha: 'discard' } : config;
  const alternateEncoderConfig =
    capabilityFallbackTarget === undefined
      ? undefined
      : buildVideoEncoderConfig(capabilityFallbackTarget, sourceGeometry, sourceTrack?.codec);
  if (target.twoPass === true && twoPassPlan === undefined) {
    throw new CapabilityError(
      'H.264 two-pass encode needs a replayable convert source and cannot consume a one-shot frame stream',
      {
        op: { kind: 'route', id: 'encode' },
        tried: ['webcodecs-video'],
        suggestion: 'use convert() with bytes, Blob, URL, or OPFS input',
      },
    );
  }
  if (target.quality !== undefined) {
    throw new CapabilityError(
      'quality-constrained H.264 encode needs a finite replayable convert source',
      {
        op: { kind: 'route', id: 'encode' },
        tried: ['webcodecs-video'],
        suggestion: 'use convert() with bytes, Blob, or a finite replayable Source',
      },
    );
  }
  const routed = await routeVideoEncoderWithImplicitH264Fallback(
    preferredEncoderConfig,
    target,
    sourceTrack?.codec,
    options,
    context.routeCodec,
    alternateEncoderConfig,
  );
  const { codec, config: encoderConfig } = routed;
  const effectiveTarget =
    routed.usedAlternateConfig && capabilityFallbackTarget !== undefined
      ? capabilityFallbackTarget
      : target;
  const keyFrameInterval = periodicVideoKeyFrameInterval(target.fps, fragmented);
  const rateControlWarmupFrames = implicitRateControlWarmupFrames(
    effectiveTarget,
    encoderConfig.codec,
    encoderConfig.framerate,
  );
  /* v8 ignore start -- requires a real VideoEncoder; validated in the browser harness (BUILD §6.1). */
  let decoderConfig: VideoDecoderConfig | undefined;
  let stage: VideoEncoderStageOptions = {
    ...context.stageOptions(signal, options),
    onDecoderConfig: (configValue) => {
      decoderConfig = configValue;
    },
    ...(effectiveTarget.crf !== undefined ? { quantizer: effectiveTarget.crf } : {}),
    ...(keyFrameInterval !== undefined ? { keyFrameInterval } : {}),
    ...(rateControlWarmupFrames !== undefined ? { rateControlWarmupFrames } : {}),
  };
  let assertTwoPassComplete: (() => void) | undefined;
  if (twoPassPlan !== undefined) {
    const installation = installH264TwoPassQuantizer(stage, twoPassPlan);
    stage = installation.stage;
    assertTwoPassComplete = installation.assertComplete;
  }
  const alphaStage: VideoEncoderStageOptions = {
    ...context.stageOptions(signal, options),
    ...(effectiveTarget.crf !== undefined ? { quantizer: effectiveTarget.crf } : {}),
    ...(keyFrameInterval !== undefined ? { keyFrameInterval } : {}),
    ...(rateControlWarmupFrames !== undefined ? { rateControlWarmupFrames } : {}),
  };
  if (bitDepthPlan.kind === 'encoder-widen' && target.alpha === 'keep') {
    throw new CapabilityError('high-bit-depth alpha widening is not available', {
      op: { kind: 'route', id: 'convert-video-bit-depth' },
      tried: ['videoframe-planar-alpha'],
      suggestion: 'discard alpha or target 8-bit output',
    });
  }
  let encodeInput = frames;
  if (bitDepthPlan.kind === 'downconvert' && bitDepthPlan.requiresPixelPath) {
    encodeInput = encodeInput.pipeThrough(
      (await import('./video-frame-convert.ts')).canvasBackedVideoFrameStream(),
    );
  }
  if (colorIntent !== undefined) {
    encodeInput = encodeInput.pipeThrough(
      (await import('./video-frame-convert.ts')).destinationColorI420FrameStream(
        colorIntent,
        target.alpha === 'keep',
      ),
    );
  }
  if (bitDepthPlan.kind === 'encoder-widen') {
    encodeInput = encodeInput.pipeThrough(
      (await import('./video-frame-convert.ts')).widenedI420VideoFrameStream(
        bitDepthPlan.sourceBitDepth,
        bitDepthPlan.targetBitDepth,
      ),
    );
  }
  // Observe what the encoder is actually handed. A packed-RGB frame means the encoder owns the RGB→YUV
  // conversion, which fixes the colour range it produced regardless of what it later claims — see
  // `mux-trackinfo.ts` `videoColorFromDecoderConfig`. Observation, never inference from the request.
  let encoderInputWasRgb = false;
  encodeInput = encodeInput.pipeThrough(
    new TransformStream<VideoFrame, VideoFrame>({
      transform(frame, controller): void {
        encoderInputWasRgb = packedRgbFormat(frame.format) !== undefined;
        controller.enqueue(frame);
      },
    }),
  );
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
    () => {
      const publishedConfig = requireEncoderConfig(decoderConfig, 'video');
      assertVideoEncoderOutputBitDepth(publishedConfig, target.bitDepth);
      return videoTrackInfoFromDecoderConfig(
        publishedConfig,
        target.fps,
        sourceTrack?.durationSec,
        outputVideoRotation(target, sourceTrack?.rotation),
        colorIntent,
        encoderInputWasRgb,
      );
    },
    signal,
  );
  assertTwoPassComplete?.();
  /* v8 ignore stop */
}
