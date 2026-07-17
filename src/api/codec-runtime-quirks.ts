/**
 * Browser-runtime transcode quirk classifiers — QUARANTINED capability logic, deliberately OUTSIDE the
 * pure config layer (docs/architecture/codec-pipeline.md §5 items 2/3). These name browsers (WebKit,
 * Firefox) and consult `runtime-detect.ts`, which the pure `codec-strings`/`encoder-config`/
 * `codec-queries`/`mux-trackinfo` modules must never do (grep-enforced by the layering test).
 *
 * Target home per the spec: the S01 capability router, as query-keyed tier de-ranking data — a
 * cross-shard move tracked in the S13 backlog (item 2). Until the router grows that surface, this
 * module keeps the measured browser evidence in one place with byte-identical decline messages so the
 * router move can assert message parity.
 */

import { CapabilityError } from '../contracts/errors.ts';
import { type SourceGeometry, outputDimensions } from './codec-queries.ts';
import { videoCodecToken } from './codec-strings.ts';
import {
  audioCodecToken,
  audioEncoderCodecString,
  buildVideoEncoderConfig,
} from './encoder-config.ts';
import type { AudioTarget, VideoTarget } from './types.ts';

const OPUS_CODEC_STRING = 'opus';
const FIREFOX_OPUS_WASM_ENCODE_SAMPLE_RATE = 48_000;
const FIREFOX_OPUS_WASM_MIN_CHANNELS = 1;
const FIREFOX_OPUS_WASM_MAX_CHANNELS = 2;
const FIREFOX_VP9_TIMEOUT_MIN_DURATION_SEC = 5;
const FIREFOX_VP9_TIMEOUT_MIN_PIXELS = 640 * 360;

/**
 * Runtime evidence from the parent WebKit harness shows this package's WebCodecs path cannot complete
 * a few filtered H.264/VPx transcode sub-modes even though `isConfigSupported` accepts their encoder
 * configs. Return a typed-decline reason for those WebKit-only gaps; callers on Chromium/Firefox should
 * not use this classifier.
 */
export function webkitVideoTranscodeDeclineReason(
  target: VideoTarget,
  src: SourceGeometry,
): string | undefined {
  if (target.alpha === 'keep') {
    return 'WebKit aibrush-media declines alpha-preserving video transcode: WebCodecs frame layout is unstable for the alpha path';
  }
  if (target.colorspace !== undefined) {
    return 'WebKit aibrush-media declines colorspace video transcode: WebCodecs frame layout is unstable for the colorspace path';
  }
  if (target.tonemap !== undefined) {
    return 'WebKit aibrush-media declines tonemap video transcode: WebCodecs frame layout is unstable for the tonemap path';
  }
  if (target.rotate === 90 || target.rotate === 180) {
    return `WebKit aibrush-media declines rotate ${target.rotate} video transcode: VideoEncoder rejects this filtered frame path`;
  }
  if (
    target.fps !== undefined &&
    src.fps !== undefined &&
    Number.isFinite(src.fps) &&
    target.fps < src.fps
  ) {
    return `WebKit aibrush-media declines fps downsample ${src.fps}->${target.fps}: VideoEncoder rejects this retimed frame path`;
  }
  return undefined;
}

function isFirefoxVp9EncodeTimeoutOutput(target: VideoTarget, src: SourceGeometry): boolean {
  if (
    src.durationSec === undefined ||
    !Number.isFinite(src.durationSec) ||
    src.durationSec < FIREFOX_VP9_TIMEOUT_MIN_DURATION_SEC
  ) {
    return false;
  }
  const { width, height } = outputDimensions(target, src);
  if (width === undefined || height === undefined) return false;
  return width * height >= FIREFOX_VP9_TIMEOUT_MIN_PIXELS;
}

/**
 * Focused Firefox evidence shows this package's VPx encode paths can exceed the suite operation budget even
 * when Firefox accepts the WebCodecs config. Keep this classifier Firefox-only and evidence-scoped:
 * Chromium/WebKit use their own browser measurements, and smaller/unknown-duration VP9 outputs are not
 * guessed into NA.
 */
export function firefoxVideoTranscodeDeclineReason(
  target: VideoTarget,
  sourceCodecString: string | undefined,
  src?: SourceGeometry,
): string | undefined {
  const targetCodec = target.codec ?? videoCodecToken(sourceCodecString ?? '');
  if (target.alpha === 'keep' && (targetCodec === 'vp8' || targetCodec === 'vp9')) {
    const codecName = targetCodec.toUpperCase();
    return `Firefox aibrush-media declines VPx alpha-preserving video transcode: the dual-WebCodecs ${codecName} alpha encode path exceeds the suite timeout on a 5 s 320x240 fixture`;
  }
  if (targetCodec === 'vp9' && src !== undefined && isFirefoxVp9EncodeTimeoutOutput(target, src)) {
    return (
      'Firefox aibrush-media declines VP9 video transcode at this duration/resolution: Firefox ' +
      'WebCodecs VP9 encode exceeds the suite timeout on 5 s 640x360-or-larger output paths'
    );
  }
  return undefined;
}

/**
 * Firefox's WebCodecs Opus encoder is accepted by feature detection but is budget-unstable in a long,
 * ordered full-suite run. For Firefox only, shape Opus audio transcodes to libopus' canonical 48 kHz input
 * rate so the existing audio-dsp resampler can feed the wasm-opus encoder deterministically. Callers still
 * decide whether the runtime is Firefox; this pure helper only resolves the internal target.
 */
export function firefoxOpusAudioEncodeTarget(
  target: AudioTarget,
  sourceCodecString: string | undefined,
): AudioTarget {
  const codec = audioEncoderCodecString(target.codec, sourceCodecString);
  if (codec !== OPUS_CODEC_STRING) return target;
  if (target.sampleRate === FIREFOX_OPUS_WASM_ENCODE_SAMPLE_RATE) return target;
  return { ...target, sampleRate: FIREFOX_OPUS_WASM_ENCODE_SAMPLE_RATE };
}

/** Firefox full-family evidence: MP3 decode → Opus encode is budget-unstable after prior codec rows. */
export function firefoxAudioTranscodeDeclineReason(
  target: AudioTarget,
  sourceCodecString: string | undefined,
): string | undefined {
  const targetCodec = audioEncoderCodecString(target.codec, sourceCodecString);
  const sourceCodec =
    sourceCodecString === undefined ? undefined : audioCodecToken(sourceCodecString);
  if (targetCodec === OPUS_CODEC_STRING && sourceCodec === 'mp3') {
    return (
      'Firefox aibrush-media declines MP3-to-Opus audio transcode: Firefox WebCodecs MP3 decode plus ' +
      'Opus encode is budget-unstable in the full transcode family, and the wasm-MP3 browser route is unavailable'
    );
  }
  return undefined;
}

/** True when a Firefox Opus encode config can be routed through wasm-opus instead of WebCodecs. */
export function firefoxOpusEncodeUsesWasm(config: AudioEncoderConfig): boolean {
  return (
    config.codec === OPUS_CODEC_STRING &&
    config.sampleRate === FIREFOX_OPUS_WASM_ENCODE_SAMPLE_RATE &&
    Number.isInteger(config.numberOfChannels) &&
    config.numberOfChannels >= FIREFOX_OPUS_WASM_MIN_CHANNELS &&
    config.numberOfChannels <= FIREFOX_OPUS_WASM_MAX_CHANNELS
  );
}

export async function buildVideoEncoderConfigForRuntime(
  target: VideoTarget,
  src: SourceGeometry,
  sourceCodecString: string | undefined,
): Promise<VideoEncoderConfig> {
  const runtime = await import('./runtime-detect.ts');
  const decline = runtime.isWebKitRuntime()
    ? webkitVideoTranscodeDeclineReason(target, src)
    : runtime.isFirefoxRuntime()
      ? firefoxVideoTranscodeDeclineReason(target, sourceCodecString, src)
      : undefined;
  if (decline !== undefined) {
    throw new CapabilityError(decline, {
      op: { kind: 'route', id: 'convert' },
      tried: ['webcodecs-video'],
    });
  }
  return buildVideoEncoderConfig(target, src, sourceCodecString);
}

export async function resolveAudioEncodeTargetForRuntime(
  target: AudioTarget,
  sourceCodecString: string | undefined,
): Promise<AudioTarget> {
  const runtime = await import('./runtime-detect.ts');
  if (!runtime.isFirefoxRuntime()) return target;
  const audioTarget = firefoxOpusAudioEncodeTarget(target, sourceCodecString);
  const decline = firefoxAudioTranscodeDeclineReason(audioTarget, sourceCodecString);
  if (decline !== undefined) {
    throw new CapabilityError(decline, {
      op: { kind: 'route', id: 'convert' },
      tried: ['webcodecs-audio', 'wasm-mp3', 'wasm-opus'],
    });
  }
  return audioTarget;
}

export async function audioEncodeNeedsSoftwareRuntime(
  config: AudioEncoderConfig,
): Promise<boolean> {
  const runtime = await import('./runtime-detect.ts');
  return runtime.isFirefoxRuntime() && firefoxOpusEncodeUsesWasm(config);
}
