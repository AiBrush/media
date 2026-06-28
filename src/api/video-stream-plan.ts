/**
 * Video filter-chain PLANNING (docs/architecture/09) — the pure builder that turns a public
 * {@link VideoTarget} into the ordered GPU {@link FilterSpec} chain the engine composes on a decoded video
 * stream before the encoder (**crop → resize → rotate → flip → colorspace → tonemap**).
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
import { closeFrame } from '../kernel/frames.ts';
import { type SourceGeometry, buildVideoEncoderConfig, videoCodecToken } from './codec-pipeline.ts';
import type { H264AbrRung, VideoCodec, VideoTarget } from './types.ts';

/**
 * Build the ordered GPU {@link FilterSpec} chain for a {@link VideoTarget}: **crop → resize → rotate →
 * flip → colorspace → tonemap**, each emitted only when the target requests it. Order matters — crop
 * selects a source sub-rect first, then resize scales it to the requested output, then orientation, then
 * full-frame colour conversion. A `resize` is emitted when width/height are given (or implied by a
 * non-identity `fit` against known source dims); `rotate`/`flip` pass straight through. Pure: every spec
 * is a plain object, so the whole chain is Node-validated; the GPU substrate that runs it is
 * browser-only. Empty array ⇒ no filters (the decode→encode is direct).
 */
export function videoFilterSpecs(target: VideoTarget, src: SourceGeometry): FilterSpec[] {
  const specs: FilterSpec[] = [];
  if (target.crop) {
    const { x, y, width, height } = target.crop;
    if (width <= 0 || height <= 0) {
      throw new InputError('unsupported-input', `crop ${width}x${height} must be positive`);
    }
    specs.push({ mediaType: 'video', type: 'crop', x, y, width, height });
  }
  if (target.width !== undefined || target.height !== undefined) {
    const width = target.width ?? src.width;
    const height = target.height ?? src.height;
    if (width === undefined || height === undefined) {
      throw new InputError(
        'unsupported-input',
        'resize needs both width and height (source dimensions are unknown; pass both)',
      );
    }
    if (width <= 0 || height <= 0) {
      throw new InputError('unsupported-input', `resize ${width}x${height} must be positive`);
    }
    specs.push({
      mediaType: 'video',
      type: 'resize',
      width,
      height,
      ...(target.fit !== undefined ? { fit: target.fit } : {}),
    });
  }
  if (target.rotate !== undefined && target.rotate !== 0) {
    specs.push({ mediaType: 'video', type: 'rotate', degrees: target.rotate });
  }
  if (target.flip !== undefined) {
    specs.push({ mediaType: 'video', type: 'flip', axis: target.flip });
  }
  if (target.colorspace !== undefined) {
    const to = target.colorspace.to.trim();
    if (to.length === 0) {
      throw new InputError('unsupported-input', 'colorspace target must be a non-empty string');
    }
    specs.push({ mediaType: 'video', type: 'colorspace', to });
  }
  if (target.tonemap !== undefined) {
    const to = (target.tonemap as { to?: unknown }).to;
    if (to !== 'sdr') {
      throw new InputError('unsupported-input', `tonemap target '${String(to)}' is not supported`);
    }
    specs.push({ mediaType: 'video', type: 'tonemap', to: 'sdr' });
  }
  return specs;
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
    throw new InputError('unsupported-input', `${name} must be a finite positive number`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InputError('unsupported-input', `${name} must be a positive safe integer`);
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
      throw new InputError('unsupported-input', 'frame timestamps must be finite numbers');
    }
    const next = frames[index + 1];
    if (next !== undefined && next.timestamp <= frame.timestamp) {
      throw new InputError('unsupported-input', 'frame timestamps must be strictly increasing');
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
      throw new InputError('unsupported-input', 'cannot infer a positive frame duration');
    }
    intervals.push({ index, timestamp: frame.timestamp, end });
  }
  return intervals;
}

/**
 * Plan decoded-frame retiming onto a constant-frame-rate output grid. The planner uses source
 * presentation timestamp intervals, not source-index ratios, so VFR→CFR holds each frame for its true
 * displayed duration. Upsampling duplicates source indexes; downsampling drops source indexes.
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
    throw new InputError('unsupported-input', 'cannot retime an empty frame interval plan');
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
      throw new InputError('unsupported-input', 'retiming source interval was not found');
    }
    const previous = outputs[outputs.length - 1];
    outputs.push({
      outputIndex,
      sourceIndex: interval.index,
      timestamp,
      duration: cfrDurationAt(options.fps, outputIndex),
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
 * enqueued. Emitted frames are fresh objects owned by the downstream consumer.
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

  const processFrameInterval = (frame: F, endUs: number): void => {
    if (!Number.isFinite(endUs) || endUs <= frame.timestamp) {
      throw new InputError('unsupported-input', 'cannot infer a positive frame duration');
    }
    const start = startUs ?? frame.timestamp;
    startUs = start;
    try {
      for (;;) {
        const timestamp = cfrTimestampAt(start, options.fps, outputIndex);
        if (timestamp >= endUs) break;
        const duration = cfrDurationAt(options.fps, outputIndex);
        const out = options.restamp(frame, { timestamp, duration });
        if (Object.is(frame, out)) {
          throw new InputError(
            'unsupported-input',
            'retime restamp must return a fresh output frame',
          );
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
        processFrameInterval(frame, end);
        releaseReader();
        return;
      }
      const frame = read.value;
      if (!Number.isFinite(frame.timestamp)) {
        closeFrame(frame);
        throw new InputError('unsupported-input', 'frame timestamps must be finite numbers');
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
        throw new InputError('unsupported-input', 'frame timestamps must be strictly increasing');
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

  return new ReadableStream<F>({
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
  });
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

interface VideoRateControlTarget extends Pick<VideoTarget, 'bitrate' | 'crf'> {
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
      readonly webCodecsConfigurable: false;
    };

function crfBounds(codec: VideoCodec | 'unknown'): { min: number; max: number } {
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
    throw new InputError(
      'unsupported-input',
      `video CRF for ${codec} must be in [${bounds.min}, ${bounds.max}]`,
    );
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
  if (bitrate !== undefined) assertValidBitrate(bitrate);
  if (crf !== undefined) assertValidCrf(crf, codec);
  if (hasBitrate && hasCrf) {
    throw new InputError('unsupported-input', 'video bitrate and CRF are mutually exclusive');
  }
  if (twoPass && !hasBitrate) {
    throw new InputError('unsupported-input', 'two-pass video encode requires a target bitrate');
  }
  if (twoPass) {
    if (bitrate === undefined) {
      throw new InputError('unsupported-input', 'two-pass video encode requires a target bitrate');
    }
    return {
      mode: 'two-pass-bitrate',
      bitrate,
      passes: 2,
      webCodecsConfigurable: false,
    };
  }
  if (hasCrf) {
    if (crf === undefined) {
      throw new InputError('unsupported-input', 'video CRF is missing');
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
      throw new InputError('unsupported-input', 'video bitrate is missing');
    }
    return { mode: 'bitrate', bitrate, bitrateMode: target.bitrateMode ?? 'variable' };
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
      readonly requiresPixelPath: true;
    };

function normalizeBitDepth(depth: number | undefined): VideoBitDepth | undefined {
  if (depth === undefined) return undefined;
  if (depth === 8 || depth === 10 || depth === 12) return depth;
  throw new InputError('unsupported-input', `unsupported video bit depth ${depth}`);
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
  if (
    sourceBitDepth === undefined ||
    targetBitDepth === undefined ||
    sourceBitDepth === targetBitDepth
  ) {
    return { kind: 'none', sourceBitDepth, targetBitDepth, requiresPixelPath: false };
  }
  if (sourceBitDepth > targetBitDepth && sourceBitDepth === 10 && targetBitDepth === 8) {
    return { kind: 'downconvert', sourceBitDepth, targetBitDepth, requiresPixelPath: true };
  }
  throw new CapabilityError(
    'capability-miss',
    `video bit-depth conversion ${sourceBitDepth}-bit → ${targetBitDepth}-bit is not available in the current codec pipeline`,
    {
      op: 'convert',
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
      readonly fps?: number;
    };
  };
  readonly config: VideoEncoderConfig;
}

function assertValidBitrate(bitrate: number): void {
  if (!Number.isSafeInteger(bitrate) || bitrate <= 0) {
    throw new InputError('unsupported-input', 'video bitrate must be a positive safe integer');
  }
}

/** Normalize an H.264 ABR ladder into per-rung convert options plus exact encoder configs. */
export function planH264AbrLadder(
  ladder: readonly H264AbrRung[],
  source: SourceGeometry,
): readonly PlannedH264AbrRung[] {
  if (ladder.length === 0) {
    throw new InputError('unsupported-input', 'H.264 ABR ladder must contain at least one rung');
  }
  return ladder.map((rung, index): PlannedH264AbrRung => {
    assertPositiveInteger('ABR rung width', rung.width);
    assertPositiveInteger('ABR rung height', rung.height);
    assertValidBitrate(rung.bitrate);
    if (rung.fps !== undefined) assertPositiveFinite('ABR rung fps', rung.fps);
    const video =
      rung.fps === undefined
        ? {
            codec: 'h264' as const,
            width: rung.width,
            height: rung.height,
            bitrate: rung.bitrate,
          }
        : {
            codec: 'h264' as const,
            width: rung.width,
            height: rung.height,
            bitrate: rung.bitrate,
            fps: rung.fps,
          };
    const options = { to: 'mp4' as const, video };
    return {
      name: rung.name ?? `${rung.height}p-${index}`,
      options,
      config: buildVideoEncoderConfig(video, source, undefined),
    };
  });
}
