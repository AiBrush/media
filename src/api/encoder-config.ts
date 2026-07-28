/**
 * Encoder-config synthesis + rate control (S13 layer 1, docs/architecture/codec-pipeline.md §3.2):
 * public `VideoTarget`/`AudioTarget` + demuxed source facts → `VideoEncoderConfig`/`AudioEncoderConfig`
 * with resolved dimensions, rate control, latency mode, and (VPx) alpha — plus the source-evidence and
 * geometry helpers those decisions read. Everything here is *pure* and Node-unit-tested: no WebCodecs
 * objects, no frames, no runtime/browser detection (the quirk classifiers are quarantined in
 * `codec-runtime-quirks.ts` pending their router move, §5 item 2).
 */

import { CapabilityError, InputError } from '../contracts/errors.ts';
import { type SourceGeometry, outputDimensions } from './codec-queries.ts';
import {
  type VideoBitDepth,
  assertSupportedVideoEncodeProfile,
  bitDepthFromCodec,
  declaredLevelBitrate,
  maximumLevelBitrate,
  normalizeVideoBitDepth,
  resolvedVideoEncoderCodecString,
  videoCodecCanCarryAlpha,
  videoCodecToken,
} from './codec-strings.ts';
import type { AudioCodec, AudioTarget, PcmCodec, VideoCodec, VideoTarget } from './types.ts';

// ============ target validation against the resolved codec string ============

/** VPx-alpha capability of the resolved encode codec string, or a typed miss for `alpha:'keep'`. */
export function videoAlphaOption(
  target: VideoTarget,
  codecString: string,
): AlphaOption | undefined {
  if (target.alpha === 'discard') return 'discard';
  if (target.alpha === 'keep') {
    if (videoCodecCanCarryAlpha(codecString)) return 'keep';
    throw new CapabilityError('alpha encode requires VP8/VP9', {
      op: { kind: 'route', id: 'encode' },
      tried: ['webcodecs-video'],
      suggestion: 'target VP8 or VP9, or set alpha:"discard"',
    });
  }
  return undefined;
}

/** Assert an explicitly requested bit depth matches what the resolved codec string can carry. */
export function assertTargetBitDepth(
  target: Pick<VideoTarget, 'bitDepth'>,
  codecString: string,
): void {
  const requested = normalizeVideoBitDepth(target.bitDepth);
  if (requested === undefined) return;
  const codecDepth = bitDepthFromCodec(codecString);
  if (codecDepth === requested) return;
  throw new CapabilityError(
    `video ${requested}-bit output is not available for codec '${codecString}'`,
    {
      op: { kind: 'route', id: 'encode' },
      tried: ['webcodecs-video'],
      suggestion: 'target an 8-bit encode path or add a proven permissive Main10 encoder tail',
    },
  );
}

// ============ rate model (named constants + selection, §5 item 6) ============

type EagerVideoRateTarget = Pick<VideoTarget, 'bitrate' | 'bitrateMode' | 'crf' | 'twoPass'>;

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InputError(`${name} must be finite and positive`);
  }
}

function assertValidVideoBitrate(bitrate: number): void {
  if (!Number.isSafeInteger(bitrate) || bitrate <= 0) {
    throw new InputError('invalid video bitrate');
  }
}

function crfBounds(codec: VideoCodec | 'unknown'): { readonly min: number; readonly max: number } {
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

function assertValidVideoCrf(crf: number, codec: VideoCodec | 'unknown'): void {
  const bounds = crfBounds(codec);
  if (!Number.isFinite(crf) || crf < bounds.min || crf > bounds.max) {
    throw new InputError(`video CRF for ${codec} must be in [${bounds.min}, ${bounds.max}]`);
  }
}

function webCodecsQuantizerSupported(codec: VideoCodec | 'unknown'): boolean {
  return codec === 'h264' || codec === 'hevc' || codec === 'vp9' || codec === 'av1';
}

/**
 * Floor for every implicit (planned) video bitrate, in bits/second — keeps tiny encodes viable when the
 * pixel budget would otherwise collapse below what any encoder can spend usefully.
 */
export const IMPLICIT_VIDEO_BITRATE_FLOOR = 300_000;

/**
 * The implicit offline quality budget in aggregate bits per output pixel per second, before per-codec
 * efficiency scaling. Ten left high-detail H.264 resizes near SSIM 0.96–0.98 even with Chromium's
 * quality latency mode; 20 gives the hardware encoder enough headroom across independently rotated
 * real-world sources without changing an explicit bitrate or CRF request (harvest ADR-193).
 */
export const IMPLICIT_BITS_PER_PIXEL_PER_SECOND = 20;

/**
 * Relative rate efficiency of each codec versus H.264 (=1): the planned pixel budget is scaled by this
 * factor, so an AV1 encode spends 0.6× the H.264 rate for the same implicit quality target.
 */
export const VIDEO_CODEC_RATE_EFFICIENCY: Readonly<Record<VideoCodec | 'unknown', number>> = {
  h264: 1,
  hevc: 0.7,
  vp8: 1.1,
  vp9: 0.8,
  av1: 0.6,
  unknown: 1,
};

/** The nominal cadence the planned pixel budget is shaped at (frames/second). */
export const CADENCE_BASELINE_FPS = 30;

/**
 * Frame rates at/below this are "ordinary cadence": the 0.5 tolerance absorbs rational-clock noise
 * around nominal 30 fps (30000/1001 ≈ 29.97, 30.000000x), matching the latency/warmup boundary
 * (ADR-252). Above it, the AV1 cadence scale below kicks in.
 */
export const HIGH_CADENCE_FPS_THRESHOLD = 30.5;

/**
 * Headroom multiplier on measured source-bitrate evidence: temporal prediction and generation loss mean
 * a re-encode needs roughly twice the source's provable rate to stay visually transparent
 * (harvest ADR-193: the 2 Mb/s SSIM bound needed ~2× requested bitrate).
 */
export const EVIDENCE_BITRATE_HEADROOM = 2;

/**
 * Floor for the evidence-based path, in bits/second — a measured low-rate source must not drag an
 * implicit re-encode below the rate where the target codec's encoder is proven visually transparent
 * (the av1→vp9 loss root cause, harvest line 395/448).
 */
export const EVIDENCE_BITRATE_FLOOR = 3_750_000;

/**
 * Ordinary-cadence H.264 evidence floor in bits per output pixel per second. Chromium's realtime
 * encoder needs this density to keep a second-generation 720p scale above the independent SSIM gate;
 * source-rate projection remains authoritative whenever it is already higher.
 */
export const H264_EVIDENCE_BITS_PER_PIXEL_PER_SECOND = 10;

/**
 * High-cadence H.264 evidence floor in bits per output pixel per second. A source-rate projection
 * alone underbudgets 50/60 fps spatial transforms after generation loss; 20 bpp/s is the first shared
 * budget that keeps the independently decoded 60 fps corpus above the visual quality gate while
 * matching the 20 bpp/s no-evidence budget.
 */
export const HIGH_CADENCE_EVIDENCE_BITS_PER_PIXEL_PER_SECOND = 20;

/**
 * Cadence scale for high-fps AV1 output: temporal prediction makes bitrate sublinear in cadence, but a
 * 60 fps stream still needs more rate than the 30 fps-shaped default. `sqrt(fps/30)`, scale-up only,
 * capped at H.264's common budget (1/efficiency) rather than erasing AV1's efficiency advantage
 * (ADR-252; golden-tested at 60/240 fps).
 */
function av1CadenceScale(codec: VideoCodec | 'unknown', frameRate: number | undefined): number {
  if (codec !== 'av1' || frameRate === undefined || frameRate <= HIGH_CADENCE_FPS_THRESHOLD) {
    return 1;
  }
  return Math.min(1 / VIDEO_CODEC_RATE_EFFICIENCY.av1, Math.sqrt(frameRate / CADENCE_BASELINE_FPS));
}

/**
 * Native realtime mode materially reduces ordinary-cadence AV1 and the measured ordinary-cadence
 * AV1→VP9 VOD path while retaining their generous implicit quality budgets. H.264 and every explicit
 * rate/quantizer/two-pass contract, high-cadence output, and unproved source/target pair retain quality
 * mode.
 */
export function videoLatencyMode(
  target: Pick<VideoTarget, 'bitrate' | 'bitrateMode' | 'crf' | 'twoPass'>,
  codec: VideoCodec | 'unknown',
  frameRate: number | undefined,
  sourceCodecString?: string,
): 'quality' | 'realtime' {
  const noExplicitRateControl =
    target.bitrate === undefined && target.bitrateMode === undefined && target.crf === undefined;
  if (
    codec === 'vp9' &&
    videoCodecToken(sourceCodecString ?? '') === 'av1' &&
    frameRate !== undefined &&
    frameRate <= HIGH_CADENCE_FPS_THRESHOLD &&
    noExplicitRateControl &&
    target.twoPass !== true
  ) {
    return 'realtime';
  }
  return codec === 'av1' &&
    frameRate !== undefined &&
    frameRate <= HIGH_CADENCE_FPS_THRESHOLD &&
    noExplicitRateControl &&
    target.twoPass !== true
    ? 'realtime'
    : 'quality';
}

/**
 * The implicit output bitrate. Two paths, both golden-tested against hand-derived values:
 *   - **evidence-based** (source bitrate measured from the packet table + known source dims): scale the
 *     measured rate by spatial/temporal/codec-efficiency ratios, apply
 *     {@link EVIDENCE_BITRATE_HEADROOM}, floor at {@link EVIDENCE_BITRATE_FLOOR}, cap at `maximum`;
 *   - **planned** (no evidence): {@link IMPLICIT_BITS_PER_PIXEL_PER_SECOND} bits/pixel/s scaled by
 *     {@link VIDEO_CODEC_RATE_EFFICIENCY} and the AV1 cadence scale, floored at
 *     {@link IMPLICIT_VIDEO_BITRATE_FLOOR}, capped at `maximum` (the level-table ceiling).
 */
function defaultVideoBitrate(
  codec: VideoCodec | 'unknown',
  width: number,
  height: number,
  maximum: number | undefined,
  frameRate: number | undefined,
  source: SourceGeometry,
  sourceCodecString: string | undefined,
): number {
  const sourceBitrate = source.bitrate;
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const sourceFrameRate = source.fps;
  const sourceCodec =
    sourceCodecString === undefined ? undefined : videoCodecToken(sourceCodecString);
  const sourceEfficiency =
    sourceCodec === undefined ? undefined : VIDEO_CODEC_RATE_EFFICIENCY[sourceCodec];
  if (
    sourceBitrate !== undefined &&
    Number.isSafeInteger(sourceBitrate) &&
    sourceBitrate > 0 &&
    sourceWidth !== undefined &&
    sourceHeight !== undefined &&
    sourceWidth > 0 &&
    sourceHeight > 0
  ) {
    const spatialScale = (width * height) / (sourceWidth * sourceHeight);
    const temporalScale =
      frameRate !== undefined && sourceFrameRate !== undefined && sourceFrameRate > 0
        ? frameRate / sourceFrameRate
        : 1;
    const codecScale =
      sourceEfficiency === undefined
        ? 1
        : Math.max(1, VIDEO_CODEC_RATE_EFFICIENCY[codec] / sourceEfficiency);
    const evidenceBased = Math.round(
      sourceBitrate * spatialScale * temporalScale * codecScale * EVIDENCE_BITRATE_HEADROOM,
    );
    const h264EvidenceDensity =
      codec === 'h264'
        ? frameRate !== undefined && frameRate > HIGH_CADENCE_FPS_THRESHOLD
          ? HIGH_CADENCE_EVIDENCE_BITS_PER_PIXEL_PER_SECOND
          : H264_EVIDENCE_BITS_PER_PIXEL_PER_SECOND
        : 0;
    const evidencePixelFloor = Math.round(width * height * h264EvidenceDensity);
    return Math.min(
      maximum ?? Number.MAX_SAFE_INTEGER,
      Math.max(EVIDENCE_BITRATE_FLOOR, evidencePixelFloor, evidenceBased),
    );
  }
  const planned = Math.max(
    IMPLICIT_VIDEO_BITRATE_FLOOR,
    Math.round(
      width *
        height *
        IMPLICIT_BITS_PER_PIXEL_PER_SECOND *
        VIDEO_CODEC_RATE_EFFICIENCY[codec] *
        av1CadenceScale(codec, frameRate),
    ),
  );
  return maximum === undefined ? planned : Math.min(planned, maximum);
}

function eagerVideoRateConfig(
  target: EagerVideoRateTarget,
  codec: VideoCodec | 'unknown',
  width: number,
  height: number,
  implicitBitrateMaximum: number | undefined,
  frameRate: number | undefined,
  source: SourceGeometry,
  sourceCodecString: string | undefined,
): {
  readonly bitrate?: number;
  readonly bitrateMode?: VideoEncoderBitrateMode;
} {
  if (target.bitrate !== undefined) assertValidVideoBitrate(target.bitrate);
  if (target.crf !== undefined) assertValidVideoCrf(target.crf, codec);
  if (target.bitrate !== undefined && target.crf !== undefined) {
    throw new InputError('bitrate/CRF conflict');
  }
  if (target.twoPass === true && target.bitrate === undefined) {
    throw new InputError('two-pass needs bitrate');
  }
  if (target.twoPass === true) {
    if (codec !== 'h264') {
      throw new CapabilityError(
        `two-pass video encode is currently available only for H.264, not ${codec}`,
        {
          op: { kind: 'route', id: 'encode' },
          tried: ['webcodecs-video'],
          suggestion: 'target H.264 or add a validated two-pass allocator for the requested codec',
        },
      );
    }
    // The engine performs a real fixed-QP analysis encode, then replays the filtered source with a
    // timestamp-exact per-picture H.264 QP schedule. Pass two therefore uses WebCodecs quantizer mode;
    // forwarding `bitrate` here would silently turn it back into the forbidden one-pass ABR path.
    return { bitrateMode: 'quantizer' };
  }
  if (target.crf !== undefined) {
    if (!webCodecsQuantizerSupported(codec)) {
      throw new CapabilityError(`CRF/quantizer encode unsupported for ${codec}`, {
        op: { kind: 'route', id: 'encode' },
        tried: ['webcodecs-video'],
        suggestion: 'route to an encoder tail with native CRF support',
      });
    }
    return { bitrateMode: 'quantizer' };
  }
  return {
    bitrate:
      target.bitrate ??
      defaultVideoBitrate(
        codec,
        width,
        height,
        implicitBitrateMaximum,
        frameRate,
        source,
        sourceCodecString,
      ),
    bitrateMode: target.bitrateMode ?? 'variable',
  };
}

// ============ encoder configs (public target → WebCodecs *EncoderConfig) ============

function sourceQualificationFactsAreUnchanged(
  target: VideoTarget,
  src: SourceGeometry,
  width: number,
  height: number,
  frameRate: number | undefined,
  sourceCodecString: string | undefined,
): boolean {
  if (
    target.codec !== undefined ||
    target.bitrate !== undefined ||
    sourceCodecString === undefined
  ) {
    return false;
  }
  const sourceDepth = bitDepthFromCodec(sourceCodecString);
  const requestedDepth = normalizeVideoBitDepth(target.bitDepth);
  const sourceFps =
    src.fps !== undefined && Number.isFinite(src.fps) && src.fps > 0 ? src.fps : undefined;
  return (
    sourceDepth !== undefined &&
    (requestedDepth === undefined || requestedDepth === sourceDepth) &&
    src.width === width &&
    src.height === height &&
    sourceFps === frameRate
  );
}

function assertEncodableVideoDimensions(codec: string, width: number, height: number): void {
  if (Number.isSafeInteger(width) && width >= 2 && Number.isSafeInteger(height) && height >= 2) {
    return;
  }
  throw new InputError(
    `video encode ${codec} needs at least 2x2 output dimensions; got ${width}x${height}`,
  );
}

/** The fully-resolved video encode plan `buildVideoEncoderConfig` and the codec resolver project from. */
interface VideoEncodePlan {
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number | undefined;
  readonly rateCodec: VideoCodec | 'unknown';
  readonly rateControl: {
    readonly bitrate?: number;
    readonly bitrateMode?: VideoEncoderBitrateMode;
  };
  readonly alpha: AlphaOption | undefined;
}

function videoEncodePlan(
  target: VideoTarget,
  src: SourceGeometry,
  sourceCodecString: string | undefined,
): VideoEncodePlan {
  const { width, height } = outputDimensions(target, src);
  if (width === undefined || height === undefined) {
    throw new InputError('video dims required');
  }
  assertEncodableVideoDimensions('video', width, height);
  if (target.fps !== undefined) assertPositiveFinite('fps', target.fps);
  if (target.bitrate !== undefined) assertValidVideoBitrate(target.bitrate);
  const sourceFps =
    src.fps !== undefined && Number.isFinite(src.fps) && src.fps > 0 ? src.fps : undefined;
  const frameRate = target.fps ?? sourceFps;
  const sourceToken =
    sourceCodecString === undefined ? undefined : videoCodecToken(sourceCodecString);
  const sourceDepth =
    sourceCodecString === undefined ? undefined : bitDepthFromCodec(sourceCodecString);
  const requestedDepth = normalizeVideoBitDepth(target.bitDepth);
  const rateCodec = target.codec ?? sourceToken ?? 'unknown';
  const rateDepth: VideoBitDepth =
    requestedDepth ?? (target.codec === undefined ? sourceDepth : undefined) ?? 8;
  const preserveSourceQualification = sourceQualificationFactsAreUnchanged(
    target,
    src,
    width,
    height,
    frameRate,
    sourceCodecString,
  );
  const implicitBitrateMaximum =
    preserveSourceQualification && sourceCodecString !== undefined
      ? declaredLevelBitrate(sourceCodecString)
      : maximumLevelBitrate(rateCodec, rateDepth);
  const rateControl = eagerVideoRateConfig(
    target,
    rateCodec,
    width,
    height,
    implicitBitrateMaximum,
    frameRate,
    src,
    sourceCodecString,
  );
  const codec = resolvedVideoEncoderCodecString(
    target,
    width,
    height,
    frameRate,
    sourceCodecString,
    rateControl.bitrate,
    preserveSourceQualification,
  );
  assertSupportedVideoEncodeProfile(codec);
  assertTargetBitDepth(target, codec);
  const alpha = videoAlphaOption(target, codec);
  return { codec, width, height, frameRate, rateCodec, rateControl, alpha };
}

/**
 * The ONE public video codec-string resolver (docs/architecture/codec-pipeline.md §5 item 4): explicit
 * token, preserve-source, H.264 source-profile retention, HEVC Main10 request, and VP9/AV1 level sizing
 * all flow through the same {@link videoEncodePlan} that `buildVideoEncoderConfig` assembles its config
 * from, so the resolved string can never drift from the config the encoder is actually given. Throws the
 * same typed errors as the config builder — a string for an impossible encode is never returned.
 */
export function resolveVideoEncoderCodecString(
  target: VideoTarget,
  src: SourceGeometry,
  sourceCodecString: string | undefined,
): string {
  return videoEncodePlan(target, src, sourceCodecString).codec;
}

/**
 * Build the {@link VideoEncoderConfig} for a target stream: the resolved codec string, the post-filter
 * output `width`/`height` (which must be known to configure an encoder), and the optional bitrate +
 * framerate. The latency policy is codec/rate-contract aware: explicit controls retain `quality`, while
 * qualified implicit native paths may select `realtime` under {@link videoLatencyMode}. Throws a typed
 * {@link InputError} when output dims cannot be determined (no target dims, unknown source).
 */
export function buildVideoEncoderConfig(
  target: VideoTarget,
  src: SourceGeometry,
  sourceCodecString: string | undefined,
): VideoEncoderConfig {
  const plan = videoEncodePlan(target, src, sourceCodecString);
  return {
    codec: plan.codec,
    width: plan.width,
    height: plan.height,
    latencyMode: videoLatencyMode(target, plan.rateCodec, plan.frameRate, sourceCodecString),
    ...plan.rateControl,
    ...(plan.alpha !== undefined ? { alpha: plan.alpha } : {}),
    ...(plan.frameRate !== undefined ? { framerate: plan.frameRate } : {}),
  };
}

/**
 * Periodic GOP forcing is a container-layout requirement for fragmented output, not a consequence of an
 * explicit frame rate. Ordinary VOD lets the quality-mode encoder place scene/key frames itself, avoiding
 * needless I-frame overhead at constrained bitrates; fragments keep deterministic two-second boundaries.
 */
export function periodicVideoKeyFrameInterval(
  fps: number | undefined,
  fragmented: boolean,
): number | undefined {
  if (!fragmented || fps === undefined) return undefined;
  return Math.max(1, Math.round(fps * 2));
}

type EncodedAudioCodec = Exclude<AudioCodec, PcmCodec>;

/** Default WebCodecs codec strings for each encoded public audio token (AAC-LC, Opus, …). */
const AUDIO_CODEC_STRING: Record<EncodedAudioCodec, string> = {
  aac: 'mp4a.40.2',
  opus: 'opus',
  mp3: 'mp3',
  flac: 'flac',
  vorbis: 'vorbis',
};

function isPcmCodecToken(token: AudioCodec): token is PcmCodec {
  return token === 'pcm' || token.startsWith('pcm-');
}

/** The public audio token a codec string denotes (`mp4a.*`→`aac`), for preserve-source. */
export function audioCodecToken(codecString: string): AudioCodec | undefined {
  const c = codecString.toLowerCase();
  if (c.startsWith('mp3') || c === 'mp4a.6b' || c === 'mp4a.69') return 'mp3';
  if (c.startsWith('mp4a')) return 'aac';
  if (c.startsWith('opus')) return 'opus';
  if (c.startsWith('flac')) return 'flac';
  if (c.startsWith('vorbis')) return 'vorbis';
  return undefined;
}

/** Resolve the WebCodecs audio codec string to encode to (caller token, else preserve the source). */
export function audioEncoderCodecString(
  token: AudioCodec | undefined,
  sourceCodecString: string | undefined,
): string {
  if (token !== undefined) {
    if (isPcmCodecToken(token)) {
      throw new CapabilityError('PCM uses DSP', {
        op: { kind: 'route', id: 'encode' },
        tried: [],
      });
    }
    return AUDIO_CODEC_STRING[token];
  }
  if (sourceCodecString !== undefined && audioCodecToken(sourceCodecString) !== undefined) {
    return sourceCodecString;
  }
  throw new CapabilityError('unknown audio codec', {
    op: { kind: 'route', id: 'encode' },
    tried: [],
  });
}

/**
 * Build the {@link AudioEncoderConfig} for a target stream: the resolved codec string plus sample rate,
 * channel count, and bitrate. Sample rate/channels fall back to the source track's, since an encoder
 * needs concrete values; absent both target and source they are a typed miss.
 */
export function buildAudioEncoderConfig(
  target: AudioTarget,
  src: { sampleRate: number | undefined; channels: number | undefined },
  sourceCodecString: string | undefined,
): AudioEncoderConfig {
  const codec = audioEncoderCodecString(target.codec, sourceCodecString);
  const sampleRate = target.sampleRate ?? src.sampleRate;
  const channels = target.channels ?? src.channels;
  if (sampleRate === undefined || channels === undefined) {
    throw new InputError('audio layout required');
  }
  return {
    codec,
    sampleRate,
    numberOfChannels: channels,
    ...(target.bitrate !== undefined ? { bitrate: target.bitrate } : {}),
  };
}
