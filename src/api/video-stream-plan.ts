/**
 * Video filter-chain PLANNING (docs/architecture/09) — the pure builder that turns a public
 * {@link VideoTarget} into the ordered GPU {@link FilterSpec} chain the engine composes on a decoded video
 * stream before the encoder (**crop → resize → pad → rotate → flip → colour transform**).
 *
 * Why a SEPARATE module (split out of `codec-pipeline.ts`): `videoFilterSpecs` is reached ONLY on the
 * convert-with-video-filter path (a live, browser-only decode→filter→encode). Keeping it here, behind the
 * engine's lazy `import('./video-stream-plan.ts')` rather than the static `codec-pipeline.ts` edge, keeps it
 * OUT of the eager kernel closure (BUILD §2, doc 08 §7 byte budget). The geometry math an eager encode DOES
 * touch — `outputDimensions` (which sizes the `VideoEncoderConfig`) and the {@link SourceGeometry} type —
 * stays in `codec-pipeline.ts`; this module imports the type only (erased). Pure: every spec is a plain
 * object, so the chain is Node-validated; the GPU substrate that runs it is browser-only (BUILD §6.1).
 */

import type { FilterSpec } from '../contracts/driver.ts';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { parseColorSpace } from '../filters/gpu-uniforms.ts';
import { closeFrame } from '../kernel/frames.ts';
import type { RouteCost } from '../kernel/tier-thresholds.ts';
import {
  type SourceGeometry,
  buildVideoEncoderConfig,
  outputDimensions,
  videoCodecToken,
  videoPixelRotation,
} from './codec-pipeline.ts';
import type { VideoColorMuxIntent } from './mux-trackinfo.ts';
import { H264_ABR_MAX_RUNGS } from './types.ts';
import type { H264AbrRung, VideoCodec, VideoQualityConstraint, VideoTarget } from './types.ts';

function assertCompatibleVideoColorTransforms(target: VideoTarget): void {
  if (target.colorspace === undefined || target.tonemap === undefined) return;
  throw new CapabilityError(
    'video colorspace conversion and tonemapping cannot be combined in one target',
    {
      op: {
        kind: 'route',
        id: 'convert',
        facts: {
          colorspace: target.colorspace.to,
          tonemap: target.tonemap.to,
        },
      },
      tried: [],
      suggestion: 'request either colorspace conversion or tonemapping, not both',
    },
  );
}

/**
 * Preserve an applied colour transform's standard identity until muxing. The live frame boundary can
 * express the pixel math (`bt2020` primaries with the BT.709-equivalent display curve), but WebCodecs has
 * no BT.2020-10/12 transfer token. A target may request colorspace conversion or tonemapping; composing
 * both is rejected because the intermediate colour standard is not represented by the public target.
 */
export function videoColorMuxIntent(target: VideoTarget): VideoColorMuxIntent | undefined {
  assertCompatibleVideoColorTransforms(target);
  if (target.tonemap !== undefined) {
    if (target.tonemap.to !== 'sdr') return undefined;
    return { kind: 'bt709-sdr', transform: 'tonemap' };
  }
  if (target.colorspace === undefined) return undefined;
  const destination = parseColorSpace(target.colorspace.to);
  if (destination === 'bt2020') return { kind: 'bt2020-sdr', transform: 'colorspace' };
  return undefined;
}

/**
 * Build the ordered GPU {@link FilterSpec} chain for a {@link VideoTarget}: **crop → resize → pad → rotate
 * → flip → colour transform**, each emitted only when the target requests it. Order matters — crop
 * selects a source sub-rect first, resize scales it, pad places it without resampling, then orientation and
 * full-frame colour conversion. A `resize` is emitted when width/height are given and differ from the
 * post-crop geometry; a geometry-identical resize is omitted so a no-op request does not introduce an
 * avoidable YUV→RGB→YUV canvas round trip. `rotate`/`flip` pass straight through. Pure: every spec is a
 * plain object, so the whole chain is Node-validated; the GPU substrate that runs it is browser-only.
 * Empty array ⇒ no filters (the decode→encode is direct).
 */
const EMPTY_FILTER_SPECS: readonly FilterSpec[] = Object.freeze([]);

export function videoFilterSpecs(target: VideoTarget, src: SourceGeometry): FilterSpec[] {
  assertCompatibleVideoColorTransforms(target);
  const specs: FilterSpec[] = [];
  if (target.crop) {
    const { x, y, width, height } = target.crop;
    if (width <= 0 || height <= 0) {
      throw new InputError(`crop ${width}x${height} must be positive`);
    }
    specs.push({ mediaType: 'video', type: 'crop', x, y, width, height });
  }
  if (target.width !== undefined || target.height !== undefined) {
    const width = target.width ?? src.width;
    const height = target.height ?? src.height;
    if (width === undefined || height === undefined) {
      throw new InputError(
        'resize needs both width and height (source dimensions are unknown; pass both)',
      );
    }
    if (width <= 0 || height <= 0) {
      throw new InputError(`resize ${width}x${height} must be positive`);
    }
    const inputWidth = target.crop?.width ?? src.width;
    const inputHeight = target.crop?.height ?? src.height;
    if (width !== inputWidth || height !== inputHeight) {
      specs.push({
        mediaType: 'video',
        type: 'resize',
        width,
        height,
        ...(target.fit !== undefined ? { fit: target.fit } : {}),
      });
    }
  }
  if (target.pad !== undefined) {
    const currentWidth = target.width ?? target.crop?.width ?? src.width;
    const currentHeight = target.height ?? target.crop?.height ?? src.height;
    if (currentWidth === undefined || currentHeight === undefined) {
      throw new InputError(
        'pad needs known source dimensions (or an explicit resize width and height)',
      );
    }
    const { width, height } = target.pad;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw new InputError(`pad ${width}x${height} must use positive integers`);
    }
    if (width < currentWidth || height < currentHeight) {
      throw new InputError(
        `pad ${width}x${height} cannot contain ${currentWidth}x${currentHeight}`,
      );
    }
    const x = target.pad.x ?? Math.floor((width - currentWidth) / 2);
    const y = target.pad.y ?? Math.floor((height - currentHeight) / 2);
    if (
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      x < 0 ||
      y < 0 ||
      x + currentWidth > width ||
      y + currentHeight > height
    ) {
      throw new InputError(
        `pad placement ${x},${y} + ${currentWidth}x${currentHeight} is outside ${width}x${height}`,
      );
    }
    if (width !== currentWidth || height !== currentHeight || x !== 0 || y !== 0) {
      specs.push({ mediaType: 'video', type: 'pad', width, height, x, y });
    }
  }
  const rotation = videoPixelRotation(target, src);
  if (rotation !== 0) {
    specs.push({ mediaType: 'video', type: 'rotate', degrees: rotation });
  }
  if (target.flip !== undefined) {
    specs.push({ mediaType: 'video', type: 'flip', axis: target.flip });
  }
  if (target.colorspace !== undefined) {
    const to = target.colorspace.to.trim();
    if (to.length === 0) {
      throw new InputError('colorspace target must be a non-empty string');
    }
    specs.push({ mediaType: 'video', type: 'colorspace', to });
  }
  if (target.tonemap !== undefined) {
    const to = (target.tonemap as { to?: unknown }).to;
    if (to !== 'sdr') {
      throw new InputError(`tonemap target '${String(to)}' is not supported`);
    }
    specs.push({ mediaType: 'video', type: 'tonemap', to: 'sdr' });
  }
  return specs.length === 0 ? (EMPTY_FILTER_SPECS as FilterSpec[]) : specs;
}

/**
 * Effective precision after the current video-filter graph. Every shipped pixel filter materializes an
 * RGBA8 `VideoFrame`; timing-only CFR retiming emits no `FilterSpec` and therefore has no pixel boundary.
 */
export function videoTargetPixelBoundaryBitDepth(
  target: VideoTarget,
  src: SourceGeometry,
  sourceHasAlpha = false,
): 8 | undefined {
  return sourceHasAlpha || target.alpha === 'keep' || videoFilterSpecs(target, src).length > 0
    ? 8
    : undefined;
}

/**
 * Cost evidence for router selection of browser video filters. Some filter specs, notably full-frame
 * colour ops (`colorspace`/`tonemap`) do not carry dimensions themselves. Duration also cannot represent
 * the work of even one large frame, so the estimate combines source reads and destination writes over the
 * greater of the source and requested output cadence. Unknown cadence uses the encoder's 30 fps planning
 * default; unknown duration conservatively represents at least one frame.
 */
export function videoFilterRouteCost(target: VideoTarget, src: SourceGeometry): RouteCost {
  const inputPixels = positivePixelArea(src.width, src.height);
  const output = outputDimensions(target, src);
  const outputPixels = positivePixelArea(output.width, output.height);
  const mediaSeconds = positiveFinite(src.durationSec);
  const sourceFps = positiveFinite(src.fps) ?? 0;
  const targetFps = positiveFinite(target.fps) ?? 0;
  const estimatedFps = Math.max(sourceFps, targetFps) || 30;
  const estimatedFrameCount =
    mediaSeconds === undefined ? 1 : Math.ceil(mediaSeconds * estimatedFps);
  const videoFrames = Number.isSafeInteger(estimatedFrameCount)
    ? Math.max(1, estimatedFrameCount)
    : Number.MAX_SAFE_INTEGER;
  const pixelsPerFrame =
    inputPixels !== undefined && outputPixels !== undefined
      ? inputPixels + outputPixels
      : undefined;
  const rawPixelWork = pixelsPerFrame !== undefined ? pixelsPerFrame * videoFrames : undefined;
  const videoPixelWork =
    rawPixelWork === undefined
      ? undefined
      : Number.isFinite(rawPixelWork) && rawPixelWork > 0
        ? rawPixelWork
        : Number.MAX_VALUE;
  return {
    ...(inputPixels !== undefined ? { inputPixels } : {}),
    ...(outputPixels !== undefined ? { outputPixels } : {}),
    ...(videoPixelWork !== undefined ? { videoFrames, videoPixelWork } : {}),
    ...(mediaSeconds !== undefined ? { mediaSeconds } : {}),
  };
}

function positivePixelArea(
  width: number | undefined,
  height: number | undefined,
): number | undefined {
  if (
    width === undefined ||
    height === undefined ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  const area = width * height;
  return Number.isFinite(area) && area > 0 ? area : undefined;
}

function positiveFinite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

// ============ video fps retiming (decoded presentation frames → CFR) ============

/** Minimal presentation timing shape for pure CFR retiming plans. */
export interface FrameTiming {
  readonly timestamp: number;
  readonly duration?: number | null;
}

/** Options for planning a constant-frame-rate output timeline. */
export interface CfrFrameRetimingOptions {
  /** Target frames per second. Supports the harness extremes (1 fps and 240 fps) without special cases. */
  readonly fps: number;
  /** Optional explicit output duration from the first input timestamp. Otherwise inferred from frames. */
  readonly durationUs?: number;
}

/** One output CFR frame and the source presentation frame it samples. */
export interface CfrFrameUse {
  readonly outputIndex: number;
  readonly sourceIndex: number;
  readonly timestamp: number;
  readonly duration: number;
  readonly duplicate: boolean;
}

/** A pure, exact retiming plan: output CFR uses plus any source frames that are dropped. */
export interface CfrFrameRetimingPlan {
  readonly fps: number;
  readonly startsAtUs: number | undefined;
  readonly endsAtUs: number | undefined;
  readonly outputs: readonly CfrFrameUse[];
  readonly droppedSourceIndexes: readonly number[];
}

interface TimedInterval {
  readonly index: number;
  readonly timestamp: number;
  readonly end: number;
}

/** A timed frame-like object whose native resources must be explicitly closed by the last consumer. */
export interface TimedClosableFrame extends FrameTiming {
  close(): void;
}

/** Timestamp/duration assigned to a restamped output frame. */
export interface RestampedFrameTiming {
  readonly timestamp: number;
  readonly duration: number;
}

/** Options for the generic close-once frame-stream retimer. */
export interface RetimeTimedFrameStreamOptions<F extends TimedClosableFrame>
  extends CfrFrameRetimingOptions {
  /** Construct a fresh output frame from a source frame and target CFR timing. */
  readonly restamp: (frame: F, timing: RestampedFrameTiming) => F;
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InputError(`${name} must be a finite positive number`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InputError(`${name} must be a positive safe integer`);
  }
}

function cfrTimestampAt(startUs: number, fps: number, frameIndex: number): number {
  return startUs + Math.round((frameIndex * 1_000_000) / fps);
}

function cfrDurationAt(fps: number, frameIndex: number): number {
  return cfrTimestampAt(0, fps, frameIndex + 1) - cfrTimestampAt(0, fps, frameIndex);
}

function positiveFrameDuration(frame: FrameTiming): number | undefined {
  const duration = frame.duration;
  return duration !== undefined && duration !== null && Number.isFinite(duration) && duration > 0
    ? duration
    : undefined;
}

function buildRetimingIntervals(
  frames: readonly FrameTiming[],
  durationUs: number | undefined,
): readonly TimedInterval[] {
  if (frames.length === 0) return [];
  const intervals: TimedInterval[] = [];
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (frame === undefined || !Number.isFinite(frame.timestamp)) {
      throw new InputError('frame timestamps must be finite numbers');
    }
    const next = frames[index + 1];
    if (next !== undefined && next.timestamp <= frame.timestamp) {
      throw new InputError('frame timestamps must be strictly increasing');
    }
    const inferred = next !== undefined ? next.timestamp - frame.timestamp : undefined;
    const declared = positiveFrameDuration(frame);
    const prev = index > 0 ? frames[index - 1] : undefined;
    const fallback = prev !== undefined ? frame.timestamp - prev.timestamp : undefined;
    const first = frames[0];
    const end =
      index === frames.length - 1 && durationUs !== undefined && first !== undefined
        ? first.timestamp + durationUs
        : frame.timestamp + (declared ?? inferred ?? fallback ?? 0);
    if (!Number.isFinite(end) || end <= frame.timestamp) {
      throw new InputError('cannot infer a positive frame duration');
    }
    intervals.push({ index, timestamp: frame.timestamp, end });
  }
  return intervals;
}

/**
 * Plan decoded-frame retiming onto a constant-frame-rate output grid. The planner uses source
 * presentation timestamp intervals, not source-index ratios, so VFR→CFR holds each frame for its true
 * displayed duration. Upsampling duplicates source indexes; downsampling drops source indexes. The final
 * output frame is clamped to the source end so Σ(durations) equals the source duration exactly — a
 * non-integer-second source at low fps (22.507 s at 1 fps) keeps a short tail rather than over-running.
 */
export function planCfrFrameRetiming(
  frames: readonly FrameTiming[],
  options: CfrFrameRetimingOptions,
): CfrFrameRetimingPlan {
  assertPositiveFinite('fps', options.fps);
  if (options.durationUs !== undefined) assertPositiveFinite('durationUs', options.durationUs);
  const intervals = buildRetimingIntervals(frames, options.durationUs);
  if (intervals.length === 0) {
    return {
      fps: options.fps,
      startsAtUs: undefined,
      endsAtUs: undefined,
      outputs: [],
      droppedSourceIndexes: [],
    };
  }
  const first = intervals[0];
  const last = intervals[intervals.length - 1];
  if (first === undefined || last === undefined) {
    throw new InputError('cannot retime an empty frame interval plan');
  }
  const durationUs = last.end - first.timestamp;
  const outputCount = Math.max(1, Math.round((durationUs * options.fps) / 1_000_000));
  const outputs: CfrFrameUse[] = [];
  let sourceCursor = 0;
  for (let outputIndex = 0; outputIndex < outputCount; outputIndex++) {
    const timestamp = cfrTimestampAt(first.timestamp, options.fps, outputIndex);
    while (
      sourceCursor + 1 < intervals.length &&
      timestamp >= (intervals[sourceCursor]?.end ?? Number.POSITIVE_INFINITY)
    ) {
      sourceCursor++;
    }
    const interval = intervals[sourceCursor];
    if (interval === undefined) {
      throw new InputError('retiming source interval was not found');
    }
    const previous = outputs[outputs.length - 1];
    // Interior frames hold a uniform 1/fps; the final grid frame is clamped to the source end so
    // Σ(durations) == the source duration exactly. A non-integer-second source at low fps (a 22.507 s input
    // at 1 fps) must not pad its tail to a full period, which would over-run the true length (23 s). The
    // remainder telescopes onto the last frame (`last.end − its timestamp`), so the sum is exact regardless
    // of rounding; sources whose end lands on the grid are unchanged (the remainder is exactly one period).
    const isLastOutput = outputIndex === outputCount - 1;
    outputs.push({
      outputIndex,
      sourceIndex: interval.index,
      timestamp,
      duration: isLastOutput ? last.end - timestamp : cfrDurationAt(options.fps, outputIndex),
      duplicate: previous?.sourceIndex === interval.index,
    });
  }
  const used = new Set(outputs.map((o) => o.sourceIndex));
  const droppedSourceIndexes = intervals.map((i) => i.index).filter((index) => !used.has(index));
  return {
    fps: options.fps,
    startsAtUs: first.timestamp,
    endsAtUs: last.end,
    outputs,
    droppedSourceIndexes,
  };
}

/**
 * Streaming CFR retimer with one-frame lookahead and close-once ownership. Each consumed source frame is
 * closed exactly once after all output duplicates for its presentation interval have been restamped and
 * enqueued. Emitted frames are fresh objects owned by the downstream consumer. When the caller declares the
 * source duration (`durationUs`), the last emitted frame is clamped to the source end so the materialized
 * duration matches the input regardless of how fine-grained the source frames are (a 30 fps → 1 fps
 * downsample lands its last grid point mid-stream, not on the tiny final source frame).
 */
export function retimeTimedFrameStream<F extends TimedClosableFrame>(
  frames: ReadableStream<F>,
  options: RetimeTimedFrameStreamOptions<F>,
): ReadableStream<F> {
  assertPositiveFinite('fps', options.fps);
  if (options.durationUs !== undefined) assertPositiveFinite('durationUs', options.durationUs);
  const reader = frames.getReader();
  let startUs: number | undefined;
  let previous: F | undefined;
  let previousDelta: number | undefined;
  let outputIndex = 0;
  let inputDone = false;
  let released = false;
  const pending: F[] = [];

  const releaseReader = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  const closePending = (): void => {
    for (const frame of pending.splice(0)) closeFrame(frame);
  };

  const processFrameInterval = (frame: F, endUs: number, isFinal = false): void => {
    try {
      if (!Number.isFinite(endUs) || endUs <= frame.timestamp) {
        throw new InputError('cannot infer a positive frame duration');
      }
      const start = startUs ?? frame.timestamp;
      startUs = start;
      // Authoritative end of the materialized output, which bounds EVERY grid frame — not just those sampled
      // from the final source frame. A declared source duration is known up front (`start + durationUs`), so
      // a fine-grained downsample clamps correctly even when its last grid point lands mid-stream: at 30 fps →
      // 1 fps the true final source frame spans ~1/30 s (far below the 1 s CFR period), so the last grid point
      // (t = 22 s for a 22.5 s source) is emitted inside an *interior* source interval, never the tiny final
      // one — a clamp tied only to the final source frame misses it and the output over-runs by ~a full
      // period (23 s). Absent a declared duration the source end is known only at the final interval (best
      // effort: the trailing frame still can't over-run its own interval).
      const hardEndUs =
        options.durationUs !== undefined ? start + options.durationUs : isFinal ? endUs : undefined;
      for (;;) {
        const timestamp = cfrTimestampAt(start, options.fps, outputIndex);
        if (timestamp >= endUs) break;
        if (hardEndUs !== undefined && timestamp >= hardEndUs) break;
        // Interior frames hold a uniform 1/fps; the last emitted frame is clamped to the source end so the
        // materialized duration matches the input (a 22.5 s source at 1 fps ⇒ a 0.5 s tail frame, not a
        // full 1 s that would over-run). Only the final grid point sees a remainder shorter than one period,
        // so steady-state cadence — and high-fps cases where the remainder is negligible — are unchanged.
        const uniform = cfrDurationAt(options.fps, outputIndex);
        const duration =
          hardEndUs !== undefined ? Math.min(uniform, hardEndUs - timestamp) : uniform;
        const out = options.restamp(frame, { timestamp, duration });
        if (Object.is(frame, out)) {
          throw new InputError('retime restamp must return a fresh output frame');
        }
        pending.push(out);
        outputIndex++;
      }
    } finally {
      closeFrame(frame);
    }
  };

  const readUntilPendingOrDone = async (): Promise<void> => {
    while (pending.length === 0 && !inputDone) {
      const read = await reader.read();
      if (read.done) {
        inputDone = true;
        if (previous === undefined) {
          releaseReader();
          return;
        }
        const frame = previous;
        previous = undefined;
        const start = startUs ?? frame.timestamp;
        const requestedEnd =
          options.durationUs !== undefined ? start + options.durationUs : undefined;
        const end =
          requestedEnd ??
          frame.timestamp +
            (positiveFrameDuration(frame) ?? previousDelta ?? cfrDurationAt(options.fps, 0));
        processFrameInterval(frame, end, true);
        releaseReader();
        return;
      }
      const frame = read.value;
      if (!Number.isFinite(frame.timestamp)) {
        closeFrame(frame);
        throw new InputError('frame timestamps must be finite numbers');
      }
      if (previous === undefined) {
        previous = frame;
        startUs = frame.timestamp;
        continue;
      }
      if (frame.timestamp <= previous.timestamp) {
        closeFrame(frame);
        closeFrame(previous);
        previous = undefined;
        throw new InputError('frame timestamps must be strictly increasing');
      }
      const end = frame.timestamp;
      const frameToProcess = previous;
      previous = undefined;
      previousDelta = end - frameToProcess.timestamp;
      try {
        processFrameInterval(frameToProcess, end);
      } catch (e) {
        closeFrame(frame);
        throw e;
      }
      previous = frame;
    }
  };

  return new ReadableStream<F>(
    {
      async pull(controller): Promise<void> {
        try {
          await readUntilPendingOrDone();
          const next = pending.shift();
          if (next !== undefined) {
            try {
              controller.enqueue(next);
            } catch (e) {
              closeFrame(next);
              throw e;
            }
            return;
          }
          if (inputDone) controller.close();
        } catch (e) {
          closePending();
          if (previous !== undefined) {
            closeFrame(previous);
            previous = undefined;
          }
          await reader.cancel(e).catch(() => {});
          releaseReader();
          controller.error(e);
        }
      },
      async cancel(reason): Promise<void> {
        closePending();
        if (previous !== undefined) {
          closeFrame(previous);
          previous = undefined;
        }
        await reader.cancel(reason).catch(() => {});
        releaseReader();
      },
    },
    { highWaterMark: 0 },
  );
}

/** VideoFrame-specialized CFR retimer; browser-only when called, Node-safe to import. */
export function retimeVideoFrameStream(
  frames: ReadableStream<VideoFrame>,
  options: CfrFrameRetimingOptions,
): ReadableStream<VideoFrame> {
  return retimeTimedFrameStream(frames, {
    ...options,
    restamp(frame, timing): VideoFrame {
      return new VideoFrame(frame, timing);
    },
  });
}

// ============ video rate-control planning ============

interface VideoRateControlTarget
  extends Pick<VideoTarget, 'bitrate' | 'maxAverageBitrate' | 'quality' | 'crf'> {
  readonly bitrateMode?: VideoEncoderBitrateMode;
  readonly twoPass?: boolean;
}

export type VideoRateControlPlan =
  | { readonly mode: 'default' }
  | {
      readonly mode: 'bitrate';
      readonly bitrate: number;
      readonly bitrateMode: VideoEncoderBitrateMode;
    }
  | {
      readonly mode: 'crf';
      readonly crf: number;
      readonly codec: VideoCodec | 'unknown';
      readonly bitrateMode: 'quantizer';
      readonly quantizer: number;
      readonly webCodecsConfigurable: true;
    }
  | {
      readonly mode: 'crf';
      readonly crf: number;
      readonly codec: VideoCodec | 'unknown';
      readonly bitrateMode: 'quantizer';
      readonly webCodecsConfigurable: false;
    }
  | {
      readonly mode: 'two-pass-bitrate';
      readonly bitrate: number;
      readonly passes: 2;
      readonly webCodecsConfigurable: true;
      readonly requiresReplay: true;
      readonly firstPassQuantizer: 28;
    }
  | {
      readonly mode: 'quality-constrained-bitrate';
      readonly preferredAverageBitrate: number;
      readonly maxAverageBitrate: number;
      readonly metric: 'ssim-luma-v1';
      readonly minimumMean: number;
      readonly samples: number;
      readonly webCodecsConfigurable: true;
      readonly requiresReplay: true;
      readonly requiresFiniteSource: true;
      readonly firstPassQuantizer: 28;
      readonly maximumCandidatePasses: 3;
    };

function crfBounds(codec: VideoCodec | 'unknown'): {
  min: number;
  max: number;
} {
  switch (codec) {
    case 'h264':
    case 'hevc':
      return { min: 0, max: 51 };
    case 'vp8':
    case 'vp9':
    case 'av1':
    case 'unknown':
      return { min: 0, max: 63 };
  }
}

function assertValidCrf(crf: number, codec: VideoCodec | 'unknown'): void {
  const bounds = crfBounds(codec);
  if (!Number.isFinite(crf) || crf < bounds.min || crf > bounds.max) {
    throw new InputError(`video CRF for ${codec} must be in [${bounds.min}, ${bounds.max}]`);
  }
}

function webCodecsQuantizerSupported(codec: VideoCodec | 'unknown'): boolean {
  return codec === 'h264' || codec === 'hevc' || codec === 'vp9' || codec === 'av1';
}

/** Pure rate-control planner for video transcode paths that may use non-WebCodecs encoder tails. */
export function planVideoRateControl(
  target: VideoRateControlTarget,
  codecString: string | undefined,
): VideoRateControlPlan {
  const codec = codecString === undefined ? 'unknown' : (videoCodecToken(codecString) ?? 'unknown');
  const bitrate = target.bitrate;
  const crf = target.crf;
  const hasBitrate = bitrate !== undefined;
  const hasCrf = crf !== undefined;
  const twoPass = target.twoPass === true;
  const hasQualityContract = target.quality !== undefined || target.maxAverageBitrate !== undefined;
  if (bitrate !== undefined) assertValidBitrate(bitrate);
  if (crf !== undefined) assertValidCrf(crf, codec);
  if (hasBitrate && hasCrf) {
    throw new InputError('video bitrate and CRF are mutually exclusive');
  }
  if (hasQualityContract) {
    if (
      bitrate === undefined ||
      target.maxAverageBitrate === undefined ||
      target.quality === undefined
    ) {
      throw new InputError(
        'quality-constrained video encode requires bitrate, maxAverageBitrate, and quality',
      );
    }
    assertValidBitrate(target.maxAverageBitrate);
    if (target.maxAverageBitrate < bitrate) {
      throw new InputError('maxAverageBitrate must be greater than or equal to bitrate');
    }
    if (
      target.quality.metric !== 'ssim-luma-v1' ||
      !Number.isFinite(target.quality.minimumMean) ||
      target.quality.minimumMean < 0 ||
      target.quality.minimumMean > 1
    ) {
      throw new InputError('invalid ssim-luma-v1 quality constraint');
    }
    const samples = target.quality.samples ?? 8;
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > 256) {
      throw new InputError('quality sample count must be a safe integer in [1, 256]');
    }
    if (
      target.crf !== undefined ||
      target.bitrateMode !== undefined ||
      target.twoPass !== undefined
    ) {
      throw new InputError(
        'quality-constrained bitrate cannot combine with CRF, bitrateMode, or twoPass',
      );
    }
    if (codec !== 'h264') {
      throw new CapabilityError(
        `quality-constrained bitrate is currently available only for H.264, not ${codec}`,
        { op: { kind: 'route', id: 'encode' }, tried: ['webcodecs-video'] },
      );
    }
    return {
      mode: 'quality-constrained-bitrate',
      preferredAverageBitrate: bitrate,
      maxAverageBitrate: target.maxAverageBitrate,
      metric: target.quality.metric,
      minimumMean: target.quality.minimumMean,
      samples,
      webCodecsConfigurable: true,
      requiresReplay: true,
      requiresFiniteSource: true,
      firstPassQuantizer: 28,
      maximumCandidatePasses: 3,
    };
  }
  if (twoPass && !hasBitrate) {
    throw new InputError('two-pass video encode requires a target bitrate');
  }
  if (twoPass) {
    if (bitrate === undefined) {
      throw new InputError('two-pass video encode requires a target bitrate');
    }
    return {
      mode: 'two-pass-bitrate',
      bitrate,
      passes: 2,
      webCodecsConfigurable: true,
      requiresReplay: true,
      firstPassQuantizer: 28,
    };
  }
  if (hasCrf) {
    if (crf === undefined) {
      throw new InputError('video CRF is missing');
    }
    return webCodecsQuantizerSupported(codec)
      ? {
          mode: 'crf',
          crf,
          codec,
          bitrateMode: 'quantizer',
          quantizer: crf,
          webCodecsConfigurable: true,
        }
      : {
          mode: 'crf',
          crf,
          codec,
          bitrateMode: 'quantizer',
          webCodecsConfigurable: false,
        };
  }
  if (hasBitrate) {
    if (bitrate === undefined) {
      throw new InputError('video bitrate is missing');
    }
    return {
      mode: 'bitrate',
      bitrate,
      bitrateMode: target.bitrateMode ?? 'variable',
    };
  }
  return { mode: 'default' };
}

// ============ bit-depth conversion planning ============

export type VideoBitDepth = 8 | 10 | 12;

export interface VideoBitDepthConversionRequest {
  readonly sourceCodec?: string;
  readonly targetCodec?: string;
  readonly sourceBitDepth?: number;
  readonly targetBitDepth?: number;
  /** Effective depth of an already-planned pixel-filter boundary; omitted means frames stay native. */
  readonly pixelPathBitDepth?: number;
}

export type VideoBitDepthConversionPlan =
  | {
      readonly kind: 'none';
      readonly sourceBitDepth: VideoBitDepth | undefined;
      readonly targetBitDepth: VideoBitDepth | undefined;
      readonly requiresPixelPath: false;
    }
  | {
      readonly kind: 'downconvert';
      readonly sourceBitDepth: VideoBitDepth;
      readonly targetBitDepth: VideoBitDepth;
      /** False when an earlier filter has already materialized the requested 8-bit precision. */
      readonly requiresPixelPath: boolean;
    }
  | {
      /** Lower-depth integer samples are left-shifted into an explicit high-depth planar frame. */
      readonly kind: 'encoder-widen';
      readonly sourceBitDepth: 8 | 10;
      readonly targetBitDepth: 10 | 12;
      readonly requiresPixelPath: true;
    };

function normalizeBitDepth(depth: number | undefined): VideoBitDepth | undefined {
  if (depth === undefined) return undefined;
  if (depth === 8 || depth === 10 || depth === 12) return depth;
  throw new InputError(`unsupported video bit depth ${depth}`);
}

function bitDepthFromAvc(codec: string): VideoBitDepth | undefined {
  const match = /^avc[13]\.([0-9a-f]{2})/i.exec(codec);
  if (!match) return undefined;
  const profileHex = match[1];
  if (profileHex === undefined) return undefined;
  const profile = Number.parseInt(profileHex, 16);
  return profile === 110 ? 10 : 8;
}

function hevcProfileIdc(codecString: string): number | undefined {
  const match = /^(?:hev1|hvc1)\.([ABC]?)(\d+)\./i.exec(codecString);
  if (!match) return undefined;
  const idc = Number(match[2]);
  return Number.isInteger(idc) ? idc : undefined;
}

function bitDepthFromHevc(codec: string): VideoBitDepth | undefined {
  const profile = hevcProfileIdc(codec);
  if (profile === undefined) return undefined;
  if (profile === 1) return 8;
  if (profile === 2) return 10;
  return undefined;
}

function bitDepthFromDelimitedCodec(
  codec: string,
  prefix: 'vp09' | 'av01',
): VideoBitDepth | undefined {
  const fields = codec.split('.');
  if (fields[0]?.toLowerCase() !== prefix) return undefined;
  const rawDepth = fields[3];
  if (rawDepth === undefined) return undefined;
  return normalizeBitDepth(Number(rawDepth));
}

function bitDepthFromCodec(codec: string | undefined): VideoBitDepth | undefined {
  if (codec === undefined) return undefined;
  const lower = codec.toLowerCase();
  return (
    bitDepthFromAvc(lower) ??
    bitDepthFromHevc(lower) ??
    bitDepthFromDelimitedCodec(lower, 'vp09') ??
    bitDepthFromDelimitedCodec(lower, 'av01') ??
    (lower === 'vp8' ? 8 : undefined)
  );
}

/** Plan the bit-depth portion of a video transcode before the live pixel/encoder path is built. */
export function planVideoBitDepthConversion(
  request: VideoBitDepthConversionRequest,
): VideoBitDepthConversionPlan {
  const sourceBitDepth =
    normalizeBitDepth(request.sourceBitDepth) ?? bitDepthFromCodec(request.sourceCodec);
  const targetBitDepth =
    normalizeBitDepth(request.targetBitDepth) ?? bitDepthFromCodec(request.targetCodec);
  const pixelPathBitDepth = normalizeBitDepth(request.pixelPathBitDepth);
  if (
    pixelPathBitDepth !== undefined &&
    targetBitDepth !== undefined &&
    targetBitDepth > pixelPathBitDepth &&
    (sourceBitDepth === undefined || sourceBitDepth > pixelPathBitDepth)
  ) {
    throw new CapabilityError(
      `${targetBitDepth}-bit output would cross a ${pixelPathBitDepth}-bit video filter boundary`,
      {
        op: { kind: 'route', id: 'convert' },
        tried: ['webcodecs-video', 'gpu-video-filter'],
        suggestion:
          'remove pixel filters, target 8-bit output, or add a proven high-bit-depth filter path',
      },
    );
  }
  if (
    sourceBitDepth === undefined ||
    targetBitDepth === undefined ||
    sourceBitDepth === targetBitDepth
  ) {
    return {
      kind: 'none',
      sourceBitDepth,
      targetBitDepth,
      requiresPixelPath: false,
    };
  }
  if (sourceBitDepth > targetBitDepth && targetBitDepth === 8) {
    return {
      kind: 'downconvert',
      sourceBitDepth,
      targetBitDepth,
      requiresPixelPath: pixelPathBitDepth !== 8,
    };
  }
  if (sourceBitDepth === 8 && (targetBitDepth === 10 || targetBitDepth === 12)) {
    return {
      kind: 'encoder-widen',
      sourceBitDepth,
      targetBitDepth,
      requiresPixelPath: true,
    };
  }
  if (sourceBitDepth === 10 && targetBitDepth === 12) {
    return {
      kind: 'encoder-widen',
      sourceBitDepth,
      targetBitDepth,
      requiresPixelPath: true,
    };
  }
  throw new CapabilityError(
    `video bit-depth conversion ${sourceBitDepth}-bit → ${targetBitDepth}-bit is not available in the current codec pipeline`,
    {
      op: { kind: 'route', id: 'convert' },
      tried: ['webcodecs-video', 'gpu-video-filter'],
      suggestion:
        'add a proven pixel-depth conversion stage and an encoder that can author the target depth',
    },
  );
}

// ============ H.264 ABR ladder planning (fanout normalization; worker pool runs it) ============

export interface PlannedH264AbrRung {
  readonly name: string;
  readonly options: {
    readonly to: 'mp4';
    readonly video: {
      readonly codec: 'h264';
      readonly width: number;
      readonly height: number;
      readonly bitrate: number;
      readonly maxAverageBitrate?: number;
      readonly quality?: VideoQualityConstraint;
      readonly fps?: number;
    };
  };
  readonly config: VideoEncoderConfig;
}

function assertValidBitrate(bitrate: number): void {
  if (!Number.isSafeInteger(bitrate) || bitrate <= 0) {
    throw new InputError('video bitrate must be a positive safe integer');
  }
}

/** Normalize an H.264 ABR ladder into per-rung convert options plus exact encoder configs. */
export function planH264AbrLadder(
  ladder: readonly H264AbrRung[],
  source: SourceGeometry,
): readonly PlannedH264AbrRung[] {
  if (ladder.length === 0) {
    throw new InputError('H.264 ABR ladder must contain at least one rung');
  }
  if (ladder.length > H264_ABR_MAX_RUNGS) {
    throw new InputError(`H.264 ABR ladder may contain at most ${H264_ABR_MAX_RUNGS} rungs`, {
      rungCount: ladder.length,
      maximumRungs: H264_ABR_MAX_RUNGS,
    });
  }
  return ladder.map((rung, index): PlannedH264AbrRung => {
    assertPositiveInteger('ABR rung width', rung.width);
    assertPositiveInteger('ABR rung height', rung.height);
    assertValidBitrate(rung.bitrate);
    if (rung.fps !== undefined) assertPositiveFinite('ABR rung fps', rung.fps);
    const hasMaximum = rung.maxAverageBitrate !== undefined;
    const hasQuality = rung.quality !== undefined;
    if (hasMaximum !== hasQuality) {
      throw new InputError(
        'quality-constrained ABR rung requires bitrate, maxAverageBitrate, and quality together',
      );
    }
    const video = {
      codec: 'h264' as const,
      width: rung.width,
      height: rung.height,
      bitrate: rung.bitrate,
      ...(rung.maxAverageBitrate !== undefined && rung.quality !== undefined
        ? {
            maxAverageBitrate: rung.maxAverageBitrate,
            quality: { ...rung.quality },
          }
        : {}),
      ...(rung.fps !== undefined ? { fps: rung.fps } : {}),
    };
    if (hasMaximum && hasQuality) planVideoRateControl(video, 'h264');
    const options = { to: 'mp4' as const, video };
    return {
      name: rung.name ?? `${rung.height}p-${index}`,
      options,
      config: buildVideoEncoderConfig(video, source, undefined),
    };
  });
}
