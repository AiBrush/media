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

import {
  AAC_LC_ACCESS_UNIT_SAMPLES,
  WEBKIT_ADTS_AAC_LEADING_SAMPLES,
} from '../codecs/webcodecs-audio.ts';
import type { TrackInfo } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES } from '../drivers/mp3/mp3-gapless.ts';
import { defaultOpusAudioEncodeTarget } from './audio-target-defaults.ts';
import type { SourceGeometry } from './codec-queries.ts';
import { videoCodecToken } from './codec-strings.ts';
import {
  audioCodecToken,
  audioEncoderCodecString,
  buildVideoEncoderConfig,
} from './encoder-config.ts';
import type { AudioTarget, VideoTarget } from './types.ts';

const OPUS_CODEC_STRING = 'opus';
const VORBIS_CODEC_STRING = 'vorbis';
const FIREFOX_OPUS_WASM_ENCODE_SAMPLE_RATE = 48_000;
const FIREFOX_OPUS_WASM_MIN_CHANNELS = 1;
const FIREFOX_OPUS_WASM_MAX_CHANNELS = 2;

/** Firefox exposes one AAC-LC access unit of native ADTS decoder priming. */
export const FIREFOX_ADTS_AAC_LEADING_SAMPLES = AAC_LC_ACCESS_UNIT_SAMPLES;

function isAdtsAac(
  sourceContainerId: string | undefined,
  sourceCodecString: string | undefined,
): boolean {
  if (sourceContainerId !== 'adts' || sourceCodecString === undefined) return false;
  return audioCodecToken(sourceCodecString) === 'aac' || sourceCodecString.toLowerCase() === 'aac';
}

/**
 * Raw ADTS has no edit list capable of declaring the native AAC decoder's presentation lead-in.
 * Keep the measured correction specific to the first-party ADTS driver and AAC codec strings.
 */
export function webkitAdtsAacLeadingSamples(
  sourceContainerId: string | undefined,
  sourceCodecString: string | undefined,
): number {
  return isAdtsAac(sourceContainerId, sourceCodecString) ? WEBKIT_ADTS_AAC_LEADING_SAMPLES : 0;
}

/** Firefox's native ADTS AAC decoder exposes exactly one 1,024-sample AAC-LC priming access unit. */
export function firefoxAdtsAacLeadingSamples(
  sourceContainerId: string | undefined,
  sourceCodecString: string | undefined,
): number {
  return isAdtsAac(sourceContainerId, sourceCodecString) ? FIREFOX_ADTS_AAC_LEADING_SAMPLES : 0;
}

/** Resolve the measured ADTS correction only after positively identifying the native runtime. */
export async function audioDecodeLeadingSamplesForRuntime(
  sourceContainerId: string | undefined,
  sourceCodecString: string | undefined,
  decoderDriverId: string,
): Promise<number> {
  if (decoderDriverId !== 'webcodecs-audio') return 0;
  if (!isAdtsAac(sourceContainerId, sourceCodecString)) return 0;
  const runtime = await import('./runtime-detect.ts');
  if (runtime.isWebKitRuntime()) return WEBKIT_ADTS_AAC_LEADING_SAMPLES;
  return runtime.isFirefoxRuntime() ? FIREFOX_ADTS_AAC_LEADING_SAMPLES : 0;
}

/**
 * WebKit's native raw-MP3 decoder consumes Layer III's synthesis/filterbank latency but leaves the
 * LAME encoder delay exposed. Account for only that codec-standard portion of an explicit Xing/LAME
 * presentation tuple; WASM and other decoder routes keep the complete parsed window.
 */
export async function audioDecodeNativeGaplessSuppressionForRuntime(
  sourceContainerId: string | undefined,
  track: TrackInfo,
  decoderDriverId: string,
): Promise<number> {
  if (
    decoderDriverId !== 'webcodecs-audio' ||
    sourceContainerId !== 'mp3' ||
    track.gapless?.basis !== 'mp3-xing-lame' ||
    audioCodecToken(track.codec) !== 'mp3'
  ) {
    return 0;
  }
  const runtime = await import('./runtime-detect.ts');
  return runtime.isWebKitRuntime() ? MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES : 0;
}

/** Subtract a decoder-proven consumed prefix from parsed gapless facts without mutating the track. */
export function audioTrackAfterNativeGaplessSuppression(
  track: TrackInfo,
  suppressedSamples: number,
): TrackInfo {
  const leadingSamples = track.gapless?.leadingSamples;
  if (
    !Number.isSafeInteger(suppressedSamples) ||
    suppressedSamples <= 0 ||
    leadingSamples === undefined ||
    !Number.isSafeInteger(leadingSamples) ||
    leadingSamples < suppressedSamples
  ) {
    return track;
  }
  return {
    ...track,
    gapless: { ...track.gapless, leadingSamples: leadingSamples - suppressedSamples },
  };
}

/**
 * Keep destination duration-based padding authoring aligned with a decoder stream whose measured
 * leading interval was removed. The count is on the source track's sample clock; no resampling guess
 * is needed because duration is the shared unit at the encoder/muxer boundary.
 */
export function audioTrackAfterLeadingSampleTrim(
  track: TrackInfo,
  leadingSamples: number,
): TrackInfo {
  if (leadingSamples === 0) return track;
  const config = track.config;
  if (
    !Number.isSafeInteger(leadingSamples) ||
    leadingSamples < 0 ||
    config === undefined ||
    !('sampleRate' in config) ||
    !Number.isFinite(config.sampleRate) ||
    config.sampleRate <= 0 ||
    track.durationSec === undefined ||
    !Number.isFinite(track.durationSec)
  ) {
    return track;
  }
  return {
    ...track,
    durationSec: Math.max(0, track.durationSec - leadingSamples / config.sampleRate),
  };
}

/**
 * Typed decline for filtered H.264/VPx transcode sub-modes on WebKit.
 *
 * **Most of what this used to decline was never a capability gap.** Those sub-modes completed on WebKit
 * all along; what failed was the colour range they were muxed with. WebKit's decoder tags frames
 * `fullRange: true`, and on a filtered path Canvas2D yields full-swing display RGB which the encoder
 * converts to YUV with the codec-default STUDIO swing — yet it still publishes `fullRange: true`. With no
 * SPS VUI in those outputs (parsed: `vui: false`), the `colr` authored from that claim was the only signal
 * a decoder had, so studio samples passed through unexpanded: decoded luma [18.2, 245.8] for a source
 * spanning [3, 255], gradient energy 8.35/9.70 = 0.861 against 219/255 = 0.859 for exactly that
 * compression. `mux-trackinfo.ts` now authors the codec default for an RGB-sourced encode, and the same
 * conversions measure SSIM 0.9927 (flip) and 0.9926 (colorspace) with luma restored to [2.8, 255] — so
 * `colorspace`, `rotate:90|180` and fps downsample are no longer declined here.
 *
 * What remains is genuinely unverified rather than merely suspected: the alpha path has its own frame
 * layout question, and `tonemap` is already declined honestly upstream by the filter driver ("no filter
 * driver for video tonemap"), which is the accurate source of truth for it. Neither is kept on the
 * strength of the disproven claim above. Callers on Chromium/Firefox should not use this classifier.
 */
export function webkitVideoTranscodeDeclineReason(target: VideoTarget): string | undefined {
  if (target.alpha === 'keep') {
    return 'WebKit aibrush-media declines alpha-preserving video transcode: WebCodecs frame layout is unstable for the alpha path';
  }
  if (target.tonemap !== undefined) {
    return 'WebKit aibrush-media declines tonemap video transcode: WebCodecs frame layout is unstable for the tonemap path';
  }
  return undefined;
}

/**
 * WebKit accepts Constrained-Baseline H.264 configurations that later fail during sustained cross-codec
 * encode. Its High-profile encoder is stable for the same variable-rate contract. Preserve the computed
 * level byte and change only the profile/compatibility fields for a known non-AVC source.
 */
export function webkitCrossCodecH264Config(
  config: VideoEncoderConfig,
  sourceCodecString: string | undefined,
): VideoEncoderConfig {
  const sourceCodec = videoCodecToken(sourceCodecString ?? '');
  if (
    sourceCodec === undefined ||
    sourceCodec === 'h264' ||
    !/^avc1\.42[0-9a-f]{2}[0-9a-f]{2}$/i.test(config.codec)
  ) {
    return config;
  }
  return { ...config, codec: config.codec.replace(/^avc1\.42[0-9a-f]{2}/i, 'avc1.6400') };
}

/**
 * Firefox VPx alpha: dual-WebCodecs encode path can exceed suite operation budget.
 * Keep this classifier Firefox-only; Chromium/WebKit use their own measurements.
 */
export function firefoxVideoTranscodeDeclineReason(
  target: VideoTarget,
  sourceCodecString: string | undefined,
  _src?: SourceGeometry,
): string | undefined {
  const targetCodec = target.codec ?? videoCodecToken(sourceCodecString ?? '');
  if (target.alpha === 'keep' && (targetCodec === 'vp8' || targetCodec === 'vp9')) {
    const codecName = targetCodec.toUpperCase();
    return `Firefox aibrush-media declines VPx alpha-preserving video transcode: dual-WebCodecs ${codecName} alpha encode exceeds suite operation budget`;
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

/** True when an Opus encode config can be routed through wasm-opus instead of WebCodecs. */
export function firefoxOpusEncodeUsesWasm(config: AudioEncoderConfig): boolean {
  return (
    config.codec === OPUS_CODEC_STRING &&
    config.sampleRate === FIREFOX_OPUS_WASM_ENCODE_SAMPLE_RATE &&
    Number.isInteger(config.numberOfChannels) &&
    config.numberOfChannels >= FIREFOX_OPUS_WASM_MIN_CHANNELS &&
    config.numberOfChannels <= FIREFOX_OPUS_WASM_MAX_CHANNELS
  );
}

/** Firefox 151 accepts Vorbis AudioEncoder configs but emits silence for non-silent PCM. */
export function firefoxVorbisEncodeUsesWasm(config: AudioEncoderConfig): boolean {
  return config.codec === VORBIS_CODEC_STRING;
}

/** Firefox exposes decoded VPx alpha as packed BGRX, which has already lost full-swing luma bytes. */
export async function vpxAlphaDecodeSoftwareDriverForRuntime(
  colorDriverId: string,
): Promise<'wasm-vpx' | undefined> {
  if (colorDriverId !== 'webcodecs-video') return undefined;
  const runtime = await import('./runtime-detect.ts');
  return runtime.isFirefoxRuntime() ? 'wasm-vpx' : undefined;
}

export async function buildVideoEncoderConfigForRuntime(
  target: VideoTarget,
  src: SourceGeometry,
  sourceCodecString: string | undefined,
): Promise<VideoEncoderConfig> {
  const runtime = await import('./runtime-detect.ts');
  const decline = runtime.isWebKitRuntime()
    ? webkitVideoTranscodeDeclineReason(target)
    : runtime.isFirefoxRuntime()
      ? firefoxVideoTranscodeDeclineReason(target, sourceCodecString, src)
      : undefined;
  if (decline !== undefined) {
    throw new CapabilityError(decline, {
      op: { kind: 'route', id: 'convert' },
      tried: ['webcodecs-video'],
    });
  }
  const config = buildVideoEncoderConfig(target, src, sourceCodecString);
  return runtime.isWebKitRuntime() ? webkitCrossCodecH264Config(config, sourceCodecString) : config;
}

export async function resolveAudioEncodeTargetForRuntime(
  target: AudioTarget,
  sourceCodecString: string | undefined,
): Promise<AudioTarget> {
  const runtime = await import('./runtime-detect.ts');
  const portableTarget = defaultOpusAudioEncodeTarget(target, sourceCodecString);
  if (!runtime.isFirefoxRuntime()) return portableTarget;
  const audioTarget = firefoxOpusAudioEncodeTarget(portableTarget, sourceCodecString);
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
  return (await audioEncodeSoftwareDriverForRuntime(config)) !== undefined;
}

/** Return the codec-specific software encoder pin required by measured runtime behavior. */
export async function audioEncodeSoftwareDriverForRuntime(
  config: AudioEncoderConfig,
): Promise<'wasm-opus' | 'wasm-vorbis-enc' | undefined> {
  const runtime = await import('./runtime-detect.ts');
  // Firefox's native encoder is budget-unstable in the full matrix. WebKit's accepts the same 48 kHz
  // stereo configuration but the browser corpus proves severe waveform corruption (2.27 dB SNR versus
  // libopus/Chromium's passing output). Both runtimes therefore use the already-vendored libopus tier;
  // Chromium retains its native path. Firefox 151 also advertises native Vorbis encode but emits only
  // silent packets, so use the independently decoded libvorbisenc tail for that codec.
  if (runtime.isFirefoxRuntime() && firefoxVorbisEncodeUsesWasm(config)) {
    return 'wasm-vorbis-enc';
  }
  return (runtime.isFirefoxRuntime() || runtime.isWebKitRuntime()) &&
    firefoxOpusEncodeUsesWasm(config)
    ? 'wasm-opus'
    : undefined;
}
