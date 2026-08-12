/**
 * Replay-backed H.264 preferred-rate / hard-rate / objective-quality orchestration.
 *
 * A fixed-QP analysis pass supplies the ordinary complexity schedule. Up to three scheduled candidates
 * are encoded first; when integer-QP allocation cannot meet the quality floor, up to three native
 * variable-rate candidates are calibrated from exact measured payload. Candidate access units remain in
 * a compressed, hard-ceiling-bounded spool; neither a muxer nor a caller sink sees bytes until both the
 * exact elementary-stream byte check and the decoded `ssim-luma-v1` check pass.
 */

import type { VideoEncoderStageOptions } from '../codecs/webcodecs-video.ts';
import type {
  CodecDriver,
  ContainerDriver,
  Demuxer,
  EncodedChunk,
  MuxOptions,
  Packet,
  TrackInfo,
} from '../contracts/driver.ts';
import {
  CapabilityError,
  type ConstraintAttemptDetail,
  ConstraintUnsatisfiedError,
  InputError,
  MediaError,
} from '../contracts/errors.ts';
import { raceAbort, throwIfSourceAborted } from '../sources/abort.ts';
import type { Source } from '../sources/source.ts';
import type { VideoColorMuxIntent } from './mux-trackinfo.ts';
import type { CallOptions, VideoTarget } from './types.ts';
import {
  type H264QualityConstraintRequest,
  H264_QUALITY_MAX_IN_MEMORY_AGGREGATE_CANDIDATE_BYTES,
  H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES,
  assertH264QualityCandidateMemoryLimit,
  assertH264QualityObjectiveAuditPixelLimit,
  averageBitrateByteBudget,
  collectBoundedCandidateChunks,
  ssimLumaV1,
  uniformQualitySampleTimestamps,
} from './video-quality-constraint.ts';
import {
  type H264TwoPassRunnerContext,
  analyzeH264TwoPass,
  decodeH264ReplayVideo,
  implicitRateControlWarmupFrames,
  installH264TwoPassQuantizer,
  sourceGeometryOf,
} from './video-two-pass-runner.ts';
import {
  type H264FirstPassSample,
  type H264TwoPassPlan,
  assertH264TwoPassPictureEvidenceCapacity,
} from './video-two-pass.ts';

const MAXIMUM_CANDIDATE_PASSES = 3;
const MAXIMUM_NATIVE_RATE_PASSES = 3;
/** Bound a malfunctioning native controller request independently of the exact audited output cap. */
const MAXIMUM_NATIVE_RATE_REQUEST_MULTIPLIER = 4;
const MICROS_PER_SECOND = 1_000_000;
const BITS_PER_BYTE = 8;

export function nextNativeRateRequest(
  currentRequest: number,
  actualBytes: number,
  maximumBytes: number,
  qualityMean: number | undefined,
  minimumQualityMean: number,
): number {
  const rateScale = maximumBytes / actualBytes;
  if (actualBytes > maximumBytes || qualityMean === undefined) {
    return Math.round(currentRequest * rateScale);
  }
  // Near one, `1 - SSIM` is a useful bounded distortion proxy. If the candidate uses the byte budget
  // but misses quality, grow the controller request by the measured/allowed distortion ratio instead
  // of making a negligible payload-only adjustment. The mux audit, not this input hint, remains the
  // output-rate authority.
  const allowedDistortion = Math.max(Number.EPSILON, 1 - minimumQualityMean);
  const measuredDistortion = Math.max(0, 1 - qualityMean);
  const qualityScale = measuredDistortion / allowedDistortion;
  return Math.round(currentRequest * Math.max(rateScale, qualityScale));
}

export interface H264QualityOutputRoute {
  /** The exact already-routed driver object that will instantiate the eventual public muxer. */
  readonly driver: ContainerDriver;
  /** The exact public target token passed to that muxer (`mp4` or `mov` today). */
  readonly format: string;
  /** The same options object that will be passed to the eventual `createMuxer` call. */
  readonly muxOptions: MuxOptions;
}

export interface H264QualityConstrainedCandidate {
  readonly chunks: readonly EncodedChunk[];
  readonly track: TrackInfo;
  readonly byteLength: number;
  readonly averageBitrate: number;
  readonly qualityMean: number;
  readonly qualitySamples: number;
  readonly attempts: readonly ConstraintAttemptDetail[];
}

interface PreparedReplay {
  readonly demuxer: Demuxer;
  readonly track: TrackInfo;
  readonly encoderConfig: VideoEncoderConfig;
  readonly frames: ReadableStream<VideoFrame>;
  readonly colorIntent: VideoColorMuxIntent | undefined;
  close(reason?: unknown): Promise<void>;
}

interface EncodedCandidate {
  readonly chunks?: readonly EncodedChunk[];
  readonly decoderConfig?: VideoDecoderConfig;
  readonly samples: readonly H264FirstPassSample[];
  readonly byteLength: number;
  readonly track: TrackInfo;
  readonly colorIntent: PreparedReplay['colorIntent'];
}

interface QualityMeasurement {
  readonly mean: number;
  readonly samples: number;
}

interface RetainedFeasibleCandidate {
  readonly chunks: readonly EncodedChunk[];
  readonly track: TrackInfo;
  /** Exact compressed bytes retained by the private chunk spool (before mux preparation). */
  readonly spoolByteLength: number;
  readonly byteLength: number;
  readonly averageBitrate: number;
  readonly qualityMean: number;
  readonly qualitySamples: number;
  readonly preferredRateDistance: number;
}

async function cancelUnlocked(
  stream: ReadableStream<unknown> | undefined,
  reason: unknown,
): Promise<void> {
  if (stream === undefined || stream.locked) return;
  await stream.cancel(reason).catch(() => {});
}

function h264Codec(codec: string): boolean {
  const normalized = codec.toLowerCase();
  return normalized.startsWith('avc1.') || normalized.startsWith('avc3.');
}

async function openPreparedReplay(
  src: Source,
  container: ContainerDriver,
  target: VideoTarget,
  signal: AbortSignal,
  options: CallOptions,
  context: H264TwoPassRunnerContext,
): Promise<PreparedReplay> {
  const demuxer = await container.demux(src, context.stageOptions(signal, options));
  let decoded: ReadableStream<VideoFrame> | undefined;
  let filtered: ReadableStream<VideoFrame> | undefined;
  let prepared: ReadableStream<VideoFrame> | undefined;
  try {
    const track = demuxer.tracks.find(
      (candidate) => candidate.mediaType === 'video' && candidate.config !== undefined,
    );
    if (track === undefined) {
      throw new CapabilityError('quality-constrained H.264 source has no decodable video track', {
        op: { kind: 'route', id: 'convert' },
        tried: [container.id],
      });
    }
    const {
      buildVideoEncoderConfigForRuntime,
      decodeQueryFor,
      decodeVideoPacketsWithAlpha,
      unwrapPackets,
    } = await import('./codec-pipeline.ts');
    const encoderConfig = await buildVideoEncoderConfigForRuntime(
      target,
      sourceGeometryOf(track),
      track.codec,
    );
    if (!h264Codec(encoderConfig.codec)) {
      throw new CapabilityError(
        `quality-constrained rate allocation is implemented for H.264, not '${encoderConfig.codec}'`,
        { op: { kind: 'route', id: 'encode' }, tried: ['webcodecs-video'] },
      );
    }
    const decodeQuery = await decodeQueryFor(track);
    const decoder = await context.routeCodec(decodeQuery, options);
    decoded =
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
    filtered = await context.applyVideoFilters(decoded, target, track, signal, options);

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
      targetCodec: encoderConfig.codec,
      ...(target.bitDepth !== undefined ? { targetBitDepth: target.bitDepth } : {}),
      ...(pixelPathBitDepth !== undefined ? { pixelPathBitDepth } : {}),
    });
    prepared = filtered;
    if (bitDepthPlan.kind === 'downconvert' && bitDepthPlan.requiresPixelPath) {
      prepared = prepared.pipeThrough(
        (await import('./video-frame-convert.ts')).canvasBackedVideoFrameStream(),
      );
    }
    if (colorIntent !== undefined) {
      prepared = prepared.pipeThrough(
        (await import('./video-frame-convert.ts')).destinationColorI420FrameStream(
          colorIntent,
          false,
        ),
      );
    }
    if (bitDepthPlan.kind === 'encoder-widen') {
      prepared = prepared.pipeThrough(
        (await import('./video-frame-convert.ts')).widenedI420VideoFrameStream(
          bitDepthPlan.sourceBitDepth,
          bitDepthPlan.targetBitDepth,
        ),
      );
    }
    const ownedPrepared = prepared;
    return {
      demuxer,
      track,
      encoderConfig,
      frames: ownedPrepared,
      colorIntent,
      async close(reason = new MediaError('aborted', 'quality replay closed')): Promise<void> {
        await cancelUnlocked(ownedPrepared, reason);
        await cancelUnlocked(filtered, reason);
        await cancelUnlocked(decoded, reason);
        await demuxer.close();
      },
    };
  } catch (error) {
    await cancelUnlocked(prepared, error);
    await cancelUnlocked(filtered, error);
    await cancelUnlocked(decoded, error);
    await demuxer.close();
    throw error;
  }
}

function tapCandidateSamples(
  samples: H264FirstPassSample[],
): TransformStream<EncodedChunk, EncodedChunk> {
  return new TransformStream<EncodedChunk, EncodedChunk>({
    transform(chunk, controller): void {
      assertH264TwoPassPictureEvidenceCapacity(samples.length + 1);
      samples.push({
        timestampUs: chunk.timestamp,
        byteLength: chunk.byteLength,
        keyFrame: chunk.type === 'key',
        ...(chunk.duration === null ? {} : { durationUs: chunk.duration }),
      });
      controller.enqueue(chunk);
    },
  });
}

async function encodeCandidate(
  src: Source,
  container: ContainerDriver,
  target: VideoTarget,
  plan: H264TwoPassPlan,
  maximumBytes: number,
  signal: AbortSignal,
  options: CallOptions,
  fragmented: boolean,
  context: H264TwoPassRunnerContext,
  nativeBitrate?: number,
): Promise<EncodedCandidate> {
  const replay = await openPreparedReplay(src, container, target, signal, options, context);
  let encoded: ReadableStream<EncodedChunk> | undefined;
  try {
    const { encodeQueryFor, periodicVideoKeyFrameInterval, requireEncoderConfig } = await import(
      './codec-pipeline.ts'
    );
    const encoderConfig: VideoEncoderConfig =
      nativeBitrate === undefined
        ? replay.encoderConfig
        : { ...replay.encoderConfig, bitrate: nativeBitrate, bitrateMode: 'variable' };
    const encoder: CodecDriver = await context.routeCodec(encodeQueryFor(encoderConfig), options);
    let decoderConfig: VideoDecoderConfig | undefined;
    const keyFrameInterval = periodicVideoKeyFrameInterval(target.fps, fragmented);
    const rateControlWarmupFrames =
      nativeBitrate === undefined
        ? undefined
        : implicitRateControlWarmupFrames(
            { bitrate: nativeBitrate },
            encoderConfig.codec,
            encoderConfig.framerate,
          );
    const baseStage = {
      ...context.stageOptions(signal, options),
      onDecoderConfig: (value) => {
        decoderConfig = value;
      },
      ...(keyFrameInterval === undefined ? {} : { keyFrameInterval }),
      ...(rateControlWarmupFrames === undefined ? {} : { rateControlWarmupFrames }),
    } satisfies VideoEncoderStageOptions;
    const installation =
      nativeBitrate === undefined ? installH264TwoPassQuantizer(baseStage, plan) : undefined;
    const samples: H264FirstPassSample[] = [];
    encoded = replay.frames
      .pipeThrough(encoder.createEncoder(encoderConfig, installation?.stage ?? baseStage))
      .pipeThrough(tapCandidateSamples(samples));
    const spool = await collectBoundedCandidateChunks(encoded, maximumBytes, signal);
    installation?.assertComplete();
    if (spool.chunks !== undefined) {
      requireEncoderConfig(decoderConfig, 'video');
    }
    return {
      ...(spool.chunks === undefined ? {} : { chunks: spool.chunks }),
      ...(decoderConfig === undefined ? {} : { decoderConfig }),
      samples,
      byteLength: spool.byteLength,
      track: replay.track,
      colorIntent: replay.colorIntent,
    };
  } finally {
    await cancelUnlocked(encoded, new MediaError('aborted', 'private H.264 candidate closed'));
    await replay.close();
  }
}

function chunkStream(chunks: readonly EncodedChunk[]): ReadableStream<EncodedChunk> {
  let index = 0;
  return new ReadableStream<EncodedChunk>(
    {
      pull(controller): void {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
}

type DisplayRgbaMaterializer = (
  frame: VideoFrame,
  width: number,
  height: number,
) => Promise<Uint8Array>;

async function materializeDisplayedRgba(
  frame: VideoFrame,
  width: number,
  height: number,
): Promise<Uint8Array> {
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  } else {
    throw new CapabilityError('ssim-luma-v1 display scaling requires a canvas surface', {
      op: { kind: 'route', id: 'h264-quality-display-reference' },
      tried: ['offscreen-canvas', 'html-canvas'],
    });
  }
  const context = canvas.getContext('2d', { alpha: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (context === null) {
    throw new CapabilityError('ssim-luma-v1 could not allocate a display reference surface', {
      op: { kind: 'route', id: 'h264-quality-display-reference' },
      tried: ['canvas-2d'],
    });
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'medium';
  context.drawImage(frame as unknown as CanvasImageSource, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength).slice();
}

/** Copy the displayed picture, materializing deferred WebCodecs display scaling when necessary. */
export async function copyDisplayedRgbaForQuality(
  frame: VideoFrame,
  materialize: DisplayRgbaMaterializer = materializeDisplayedRgba,
): Promise<{
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}> {
  const width = frame.displayWidth || frame.codedWidth;
  const height = frame.displayHeight || frame.codedHeight;
  assertH264QualityObjectiveAuditPixelLimit(width, height);
  const visible = frame.visibleRect ?? {
    x: 0,
    y: 0,
    width: frame.codedWidth,
    height: frame.codedHeight,
  };
  if (visible.width !== width || visible.height !== height) {
    return { data: await materialize(frame, width, height), width, height };
  }
  const data = new Uint8Array(width * height * 4);
  await frame.copyTo(data, {
    format: 'RGBA',
    colorSpace: 'srgb',
    rect: { x: visible.x, y: visible.y, width, height },
    layout: [{ offset: 0, stride: width * 4 }],
  });
  return { data, width, height };
}

function assertH264QualityOutputRoute(route: H264QualityOutputRoute): void {
  if (route.driver.auditMuxedTrack !== undefined) return;
  throw new CapabilityError(
    'H.264 objective-quality rate audit requires a mux route with exact sample accounting',
    {
      op: {
        kind: 'route',
        id: 'h264-quality-output-audit',
        facts: { outputDriver: route.driver.id, outputFormat: route.format },
      },
      tried: [route.driver.id],
      suggestion: 'use a mux route with exact encoded-track audit support or omit the constraint',
    },
  );
}

function encodedCandidatePackets(
  chunks: readonly EncodedChunk[],
  signal: AbortSignal,
): Iterable<Packet> {
  return {
    *[Symbol.iterator](): Iterator<Packet> {
      for (const chunk of chunks) {
        throwIfSourceAborted(signal);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        throwIfSourceAborted(signal);
        yield { chunk, data };
      }
    },
  };
}

async function auditCandidateOutput(
  candidate: EncodedCandidate,
  target: VideoTarget,
  outputRoute: H264QualityOutputRoute,
  signal: AbortSignal,
): Promise<{
  readonly track: TrackInfo;
  readonly elementaryPayloadBytes: number;
  readonly preparedSampleByteLengths: readonly number[];
  readonly presentationSpanUs: number;
  readonly sampleCount: number;
}> {
  if (candidate.chunks === undefined || candidate.decoderConfig === undefined) {
    throw new InputError('an over-ceiling H.264 candidate has no mux-auditable private spool');
  }
  const { outputVideoRotation, videoTrackInfoFromDecoderConfig } = await import(
    './codec-pipeline.ts'
  );
  const provisionalTrack = videoTrackInfoFromDecoderConfig(
    candidate.decoderConfig,
    target.fps,
    undefined,
    outputVideoRotation(target, candidate.track.rotation),
    candidate.colorIntent,
  );
  const auditMuxedTrack = outputRoute.driver.auditMuxedTrack;
  if (auditMuxedTrack === undefined) {
    throw new CapabilityError('selected mux route cannot audit an H.264 candidate', {
      op: { kind: 'route', id: 'h264-quality-output-audit' },
      tried: [outputRoute.driver.id],
    });
  }
  throwIfSourceAborted(signal);
  const audit = await raceAbort(
    auditMuxedTrack.call(
      outputRoute.driver,
      provisionalTrack,
      encodedCandidatePackets(candidate.chunks, signal),
      outputRoute.muxOptions,
      signal,
    ),
    signal,
  );
  if (
    typeof audit !== 'object' ||
    audit === null ||
    !Array.isArray(audit.preparedSampleByteLengths)
  ) {
    throw invalidMuxAudit(outputRoute, 'returned malformed candidate evidence');
  }
  let preparedByteTotal = 0;
  let preparedByteLengthsValid = true;
  for (const value of audit.preparedSampleByteLengths) {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > Number.MAX_SAFE_INTEGER - preparedByteTotal
    ) {
      preparedByteLengthsValid = false;
      break;
    }
    preparedByteTotal += value;
  }
  if (
    !Number.isSafeInteger(audit.elementaryPayloadBytes) ||
    audit.elementaryPayloadBytes <= 0 ||
    !Number.isSafeInteger(audit.presentationSpanUs) ||
    audit.presentationSpanUs <= 0 ||
    !Number.isSafeInteger(audit.sampleCount) ||
    audit.sampleCount <= 0 ||
    audit.sampleCount !== candidate.samples.length ||
    audit.preparedSampleByteLengths.length !== audit.sampleCount ||
    !preparedByteLengthsValid ||
    preparedByteTotal !== audit.elementaryPayloadBytes
  ) {
    throw invalidMuxAudit(
      outputRoute,
      `returned invalid ${audit.sampleCount}/${candidate.samples.length} candidate evidence`,
    );
  }
  return {
    ...audit,
    track: { ...provisionalTrack, durationSec: audit.presentationSpanUs / MICROS_PER_SECOND },
  };
}

function invalidMuxAudit(outputRoute: H264QualityOutputRoute, reason: string): CapabilityError {
  return new CapabilityError(`selected mux route ${reason}`, {
    op: {
      kind: 'route',
      id: 'h264-quality-output-audit',
      facts: { outputDriver: outputRoute.driver.id, outputFormat: outputRoute.format },
    },
    tried: [outputRoute.driver.id],
    suggestion: 'use a mux route with valid exact encoded-track audit support',
  });
}

async function measureCandidateQuality(
  src: Source,
  container: ContainerDriver,
  target: VideoTarget,
  plan: H264TwoPassPlan,
  candidate: EncodedCandidate,
  request: H264QualityConstraintRequest,
  signal: AbortSignal,
  options: CallOptions,
  context: H264TwoPassRunnerContext,
): Promise<QualityMeasurement> {
  if (candidate.chunks === undefined || candidate.decoderConfig === undefined) {
    throw new InputError('an over-ceiling H.264 candidate has no decodable private spool');
  }
  const replay = await openPreparedReplay(src, container, target, signal, options, context);
  let decoded: ReadableStream<VideoFrame> | undefined;
  let sourceReader: ReadableStreamDefaultReader<VideoFrame> | undefined;
  let candidateReader: ReadableStreamDefaultReader<VideoFrame> | undefined;
  let sourceDone = false;
  let candidateDone = false;
  let sum = 0;
  let samples = 0;
  try {
    const decoder = await context.routeCodec(
      {
        mediaType: 'video',
        direction: 'decode',
        config: candidate.decoderConfig,
      },
      options,
    );
    decoded = decodeH264ReplayVideo(
      chunkStream(candidate.chunks),
      decoder,
      candidate.decoderConfig,
      signal,
      options,
      context,
      'private-candidate',
    );
    sourceReader = replay.frames.getReader();
    candidateReader = decoded.getReader();
    const selected = new Set(
      uniformQualitySampleTimestamps(plan.timestampsUs, request.quality.samples),
    );
    for (;;) {
      const sourceResult = await raceAbort(sourceReader.read(), signal);
      sourceDone = sourceResult.done;
      let candidateResult: Awaited<ReturnType<typeof candidateReader.read>>;
      try {
        candidateResult = await raceAbort(candidateReader.read(), signal);
        candidateDone = candidateResult.done;
      } catch (error) {
        if (!sourceResult.done) sourceResult.value.close();
        throw error;
      }
      if (sourceResult.done || candidateResult.done) {
        if (!sourceResult.done) sourceResult.value.close();
        if (!candidateResult.done) candidateResult.value.close();
        if (sourceResult.done !== candidateResult.done) {
          throw new InputError('H.264 candidate changed the filtered presentation frame count');
        }
        break;
      }
      const sourceFrame = sourceResult.value;
      const candidateFrame = candidateResult.value;
      try {
        if (sourceFrame.timestamp !== candidateFrame.timestamp) {
          throw new InputError(
            `H.264 candidate changed picture PTS ${sourceFrame.timestamp} to ${candidateFrame.timestamp}`,
          );
        }
        if (selected.has(sourceFrame.timestamp)) {
          const copied = await Promise.allSettled([
            copyDisplayedRgbaForQuality(sourceFrame),
            copyDisplayedRgbaForQuality(candidateFrame),
          ]);
          const sourcePixels = copied[0];
          const candidatePixels = copied[1];
          if (sourcePixels?.status === 'rejected') throw sourcePixels.reason;
          if (candidatePixels?.status === 'rejected') throw candidatePixels.reason;
          if (sourcePixels === undefined || candidatePixels === undefined) {
            throw new InputError('ssim-luma-v1 frame copy evidence is incomplete');
          }
          sum += ssimLumaV1(sourcePixels.value, candidatePixels.value);
          samples++;
        }
      } finally {
        sourceFrame.close();
        candidateFrame.close();
      }
    }
    if (samples !== selected.size || samples === 0) {
      throw new InputError(
        `ssim-luma-v1 evaluated ${samples}/${selected.size} selected presentation samples`,
      );
    }
    return { mean: sum / samples, samples };
  } catch (error) {
    if (sourceReader !== undefined && !sourceDone) {
      await sourceReader.cancel(error).catch(() => {});
    }
    if (candidateReader !== undefined && !candidateDone) {
      await candidateReader.cancel(error).catch(() => {});
    }
    throw error;
  } finally {
    sourceReader?.releaseLock();
    candidateReader?.releaseLock();
    await cancelUnlocked(decoded, new MediaError('aborted', 'quality decoder closed'));
    await replay.close();
  }
}

function sameSchedule(a: H264TwoPassPlan, b: H264TwoPassPlan): boolean {
  if (a.quantizers.length !== b.quantizers.length) return false;
  return a.quantizers.every((value, index) => value === b.quantizers[index]);
}

function materializeFeasibleCandidate(
  candidate: RetainedFeasibleCandidate,
  attempts: readonly ConstraintAttemptDetail[],
): H264QualityConstrainedCandidate {
  return {
    chunks: candidate.chunks,
    track: candidate.track,
    byteLength: candidate.byteLength,
    averageBitrate: candidate.averageBitrate,
    qualityMean: candidate.qualityMean,
    qualitySamples: candidate.qualitySamples,
    attempts,
  };
}

/**
 * Produce one fully-audited private candidate. The returned chunks are safe to mux exactly once; a
 * failure returns no bytes and carries the complete bounded attempt evidence.
 */
export async function analyzeH264QualityConstrained(
  src: Source,
  container: ContainerDriver,
  target: VideoTarget,
  request: H264QualityConstraintRequest,
  signal: AbortSignal,
  options: CallOptions,
  fragmented: boolean,
  outputRoute: H264QualityOutputRoute,
  context: H264TwoPassRunnerContext,
): Promise<H264QualityConstrainedCandidate> {
  assertH264QualityOutputRoute(outputRoute);
  let plan = await analyzeH264TwoPass(src, container, target, signal, options, fragmented, context);
  const maximumBytes = averageBitrateByteBudget(request.maxAverageBitrate, plan.durationUs);
  assertH264QualityCandidateMemoryLimit(maximumBytes);
  const attempts: ConstraintAttemptDetail[] = [];
  // Exactly one feasible spool may survive an iteration. While a retry is encoded, its individual
  // spool limit is also clipped by the remaining aggregate allowance, so compressed candidate payloads
  // can never exceed the documented fallback + current-candidate bound.
  let bestFeasible: RetainedFeasibleCandidate | undefined;

  for (let attempt = 1; attempt <= MAXIMUM_CANDIDATE_PASSES; attempt++) {
    const retainedSpoolBytes = bestFeasible?.spoolByteLength ?? 0;
    const candidateSpoolLimit = Math.min(
      H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES,
      H264_QUALITY_MAX_IN_MEMORY_AGGREGATE_CANDIDATE_BYTES - retainedSpoolBytes,
    );
    const candidate = await encodeCandidate(
      src,
      container,
      target,
      plan,
      candidateSpoolLimit,
      signal,
      options,
      fragmented,
      context,
    );
    const candidateDurationUs = plan.validateCandidateTimeline(candidate.samples);
    const outputAudit =
      candidate.chunks === undefined || candidate.decoderConfig === undefined
        ? undefined
        : await auditCandidateOutput(candidate, target, outputRoute, signal);
    const auditedDurationUs = outputAudit?.presentationSpanUs ?? candidateDurationUs;
    const auditedPayloadBytes = outputAudit?.elementaryPayloadBytes ?? candidate.byteLength;
    const candidateMaximumBytes = averageBitrateByteBudget(
      request.maxAverageBitrate,
      auditedDurationUs,
    );
    assertH264QualityCandidateMemoryLimit(candidateMaximumBytes);
    const averageBitrate =
      (auditedPayloadBytes * BITS_PER_BYTE * MICROS_PER_SECOND) / auditedDurationUs;
    let quality: QualityMeasurement | undefined;
    if (auditedPayloadBytes <= candidateMaximumBytes && outputAudit !== undefined) {
      quality = await measureCandidateQuality(
        src,
        container,
        target,
        plan,
        candidate,
        request,
        signal,
        options,
        context,
      );
    }
    attempts.push({
      attempt,
      targetBytes: plan.targetBytes,
      actualBytes: auditedPayloadBytes,
      averageBitrate,
      ...(quality === undefined
        ? {}
        : { qualityMean: quality.mean, qualitySamples: quality.samples }),
    });
    let feasible = false;
    if (
      auditedPayloadBytes <= candidateMaximumBytes &&
      outputAudit !== undefined &&
      quality !== undefined &&
      quality.mean >= request.quality.minimumMean
    ) {
      feasible = true;
      const preferredRateDistance = Math.abs(averageBitrate - request.bitrate);
      if (
        bestFeasible === undefined ||
        preferredRateDistance < bestFeasible.preferredRateDistance
      ) {
        bestFeasible = {
          chunks: candidate.chunks as readonly EncodedChunk[],
          track: outputAudit.track,
          spoolByteLength: candidate.byteLength,
          byteLength: auditedPayloadBytes,
          averageBitrate,
          qualityMean: quality.mean,
          qualitySamples: quality.samples,
          preferredRateDistance,
        };
      }
    }

    if (attempt === MAXIMUM_CANDIDATE_PASSES) break;
    const recalibrationSamples =
      outputAudit === undefined
        ? candidate.samples
        : candidate.samples.map((sample, index) => {
            const byteLength = outputAudit.preparedSampleByteLengths[index];
            if (byteLength === undefined) {
              throw new InputError('H.264 mux audit sample-byte evidence is incomplete');
            }
            return { ...sample, byteLength };
          });
    // A feasible candidate establishes a safe fallback, so remaining work optimizes the declared
    // preferred rate itself. Failed candidates still spend only toward the hard ceiling, preserving the
    // original quality-recovery behavior without inventing a hidden proximity threshold.
    const nextTargetBytes = feasible
      ? averageBitrateByteBudget(request.bitrate, auditedDurationUs)
      : candidateMaximumBytes;
    if (nextTargetBytes === 0) break;
    const next = plan.recalibrate(recalibrationSamples, nextTargetBytes);
    if (sameSchedule(plan, next)) break;
    plan = next;
  }

  if (bestFeasible !== undefined) {
    return materializeFeasibleCandidate(bestFeasible, attempts);
  }

  // Per-picture integer QPs have a coarse whole-stream rate step and may be less efficient than the
  // browser's native lookahead/controller on a particular device. Keep that hardware route behind the
  // same private spool, mux audit, timeline validation, and decoded-quality gate. The controller request
  // may exceed the authored output ceiling because it is only an input hint; exact output payload never
  // may. Each retry derives solely from the previous measured response.
  const maximumNativeRequest = Math.min(
    Number.MAX_SAFE_INTEGER,
    request.maxAverageBitrate * MAXIMUM_NATIVE_RATE_REQUEST_MULTIPLIER,
  );
  let nativeBitrate = request.maxAverageBitrate;
  for (let nativePass = 1; nativePass <= MAXIMUM_NATIVE_RATE_PASSES; nativePass++) {
    const candidate = await encodeCandidate(
      src,
      container,
      target,
      plan,
      H264_QUALITY_MAX_IN_MEMORY_CANDIDATE_BYTES,
      signal,
      options,
      fragmented,
      context,
      nativeBitrate,
    );
    const candidateDurationUs = plan.validateCandidateTimeline(candidate.samples);
    const outputAudit =
      candidate.chunks === undefined || candidate.decoderConfig === undefined
        ? undefined
        : await auditCandidateOutput(candidate, target, outputRoute, signal);
    const auditedDurationUs = outputAudit?.presentationSpanUs ?? candidateDurationUs;
    const auditedPayloadBytes = outputAudit?.elementaryPayloadBytes ?? candidate.byteLength;
    const candidateMaximumBytes = averageBitrateByteBudget(
      request.maxAverageBitrate,
      auditedDurationUs,
    );
    assertH264QualityCandidateMemoryLimit(candidateMaximumBytes);
    const averageBitrate =
      (auditedPayloadBytes * BITS_PER_BYTE * MICROS_PER_SECOND) / auditedDurationUs;
    const quality =
      auditedPayloadBytes <= candidateMaximumBytes && outputAudit !== undefined
        ? await measureCandidateQuality(
            src,
            container,
            target,
            plan,
            candidate,
            request,
            signal,
            options,
            context,
          )
        : undefined;
    attempts.push({
      attempt: attempts.length + 1,
      targetBytes: candidateMaximumBytes,
      actualBytes: auditedPayloadBytes,
      averageBitrate,
      ...(quality === undefined
        ? {}
        : { qualityMean: quality.mean, qualitySamples: quality.samples }),
    });
    if (
      candidate.chunks !== undefined &&
      outputAudit !== undefined &&
      quality !== undefined &&
      quality.mean >= request.quality.minimumMean
    ) {
      return {
        chunks: candidate.chunks,
        track: outputAudit.track,
        byteLength: auditedPayloadBytes,
        averageBitrate,
        qualityMean: quality.mean,
        qualitySamples: quality.samples,
        attempts,
      };
    }
    if (nativePass === MAXIMUM_NATIVE_RATE_PASSES || auditedPayloadBytes <= 0) break;
    const calibrated = nextNativeRateRequest(
      nativeBitrate,
      auditedPayloadBytes,
      candidateMaximumBytes,
      quality?.mean,
      request.quality.minimumMean,
    );
    const nextNativeBitrate = Math.max(1, Math.min(maximumNativeRequest, calibrated));
    if (nextNativeBitrate === nativeBitrate) break;
    nativeBitrate = nextNativeBitrate;
  }

  throw new ConstraintUnsatisfiedError(
    'no bounded H.264 candidate satisfied both maxAverageBitrate and objective quality',
    {
      constraint: 'h264-quality-rate',
      preferredAverageBitrate: request.bitrate,
      maxAverageBitrate: request.maxAverageBitrate,
      minimumQualityMean: request.quality.minimumMean,
      metric: request.quality.metric,
      attempts,
    },
  );
}
