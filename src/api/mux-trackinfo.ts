/**
 * Mux `TrackInfo` builders (S13 layer 1, docs/architecture/codec-pipeline.md §3.2): shape the track the
 * `Muxer.addTrack` seam consumes from the decoder config a live encoder *published* — the decoder
 * config, not the public target, is the source of truth so the muxer writes the exact codec box
 * (avcC/hvcC/…) the encoder produced — plus the packet-copy legality predicate and the output-gapless
 * selection. Pure + Node-unit-tested; no WebCodecs objects, no frames.
 */

import { rewriteH264AvcCColor } from '../codecs/h264-avcc-crop.ts';
import type { AudioEncoderOutputTiming, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';
import { audioCodecToken } from './encoder-config.ts';

/**
 * Lossless colour intent carried from an applied pixel transform to the encoder→mux bridge. WebCodecs'
 * string enum collapses BT.2020-10/12 into `bt709`, so the transform plan must retain that standard
 * identity out-of-band until the encoder publishes the remaining coded-output facts.
 */
export type VideoColorMuxIntent =
  | { readonly kind: 'bt2020-sdr'; readonly transform: 'colorspace' }
  | { readonly kind: 'bt709-sdr'; readonly transform: 'tonemap' };

function h273ColorCode(
  value: string | null | undefined,
  codes: Readonly<Record<string, number>>,
): number | undefined {
  return value === undefined || value === null ? undefined : codes[value];
}

/**
 * Project the encoder-published WebCodecs colour declaration into container-neutral H.273 facts. The
 * mapping is deliberately field-wise: an unknown future token omits only that field, and an absent range
 * stays absent rather than being guessed. This is destination metadata — source HDR mastering facts must
 * not leak across a colour transform or a fresh encode.
 */
function videoColorFromDecoderConfig(config: VideoDecoderConfig): TrackInfo['color'] | undefined {
  const colorSpace = config.colorSpace;
  if (colorSpace === undefined) return undefined;
  const primaries = h273ColorCode(colorSpace.primaries, {
    bt709: 1,
    bt470bg: 5,
    smpte170m: 6,
    bt2020: 9,
    smpte432: 12,
  });
  const transferCharacteristics = h273ColorCode(colorSpace.transfer, {
    bt709: 1,
    smpte170m: 6,
    linear: 8,
    'iec61966-2-1': 13,
    pq: 16,
    hlg: 18,
  });
  const matrixCoefficients = h273ColorCode(colorSpace.matrix, {
    rgb: 0,
    bt709: 1,
    bt470bg: 5,
    smpte170m: 6,
    'bt2020-ncl': 9,
  });
  const range = colorSpace.fullRange === true ? 2 : colorSpace.fullRange === false ? 1 : undefined;
  if (
    primaries === undefined &&
    transferCharacteristics === undefined &&
    matrixCoefficients === undefined &&
    range === undefined
  ) {
    return undefined;
  }
  return {
    ...(matrixCoefficients !== undefined ? { matrixCoefficients } : {}),
    ...(range !== undefined ? { range } : {}),
    ...(transferCharacteristics !== undefined ? { transferCharacteristics } : {}),
    ...(primaries !== undefined ? { primaries } : {}),
  };
}

const BT2020_SDR_PUBLISHED_COLOR = {
  primaries: 9,
  transferCharacteristics: 1,
  matrixCoefficients: 9,
  range: 1,
} as const;

const BT709_SDR_PUBLISHED_COLOR = {
  primaries: 1,
  transferCharacteristics: 1,
  matrixCoefficients: 1,
  range: 1,
} as const;

function completePublishedColorMatches(
  published: TrackInfo['color'] | undefined,
  expected: typeof BT2020_SDR_PUBLISHED_COLOR | typeof BT709_SDR_PUBLISHED_COLOR,
): boolean {
  return (
    published?.primaries === expected.primaries &&
    published.transferCharacteristics === expected.transferCharacteristics &&
    published.matrixCoefficients === expected.matrixCoefficients &&
    published.range === expected.range
  );
}

function describePublishedColor(color: TrackInfo['color'] | undefined): string {
  if (color === undefined) return 'none';
  return `primaries=${String(color.primaries)}, transfer=${String(color.transferCharacteristics)}, matrix=${String(color.matrixCoefficients)}, range=${String(color.range)}`;
}

/**
 * Reconcile explicit transform semantics with the encoder's effective coded-output declaration. The
 * encoder remains authoritative for primaries/matrix/range: all four fields must confirm the expected
 * standard tuple before the bridge restores a vocabulary-lost transfer identity. A conflict or omission
 * is a capability miss, never permission to label unknown pixels as the requested space.
 */
function colorForMuxIntent(
  published: TrackInfo['color'] | undefined,
  intent: VideoColorMuxIntent | undefined,
): TrackInfo['color'] | undefined {
  if (intent === undefined) return published;
  const expected =
    intent.kind === 'bt2020-sdr' ? BT2020_SDR_PUBLISHED_COLOR : BT709_SDR_PUBLISHED_COLOR;
  if (!completePublishedColorMatches(published, expected)) {
    throw new CapabilityError(
      `${intent.transform} output requires ${intent.kind} coded colour signaling; encoder published ${describePublishedColor(published)}`,
      {
        op: {
          kind: 'route',
          id: 'mux-video-color',
          facts: { transform: intent.transform, destinationColor: intent.kind },
        },
        tried: ['encoder-decoder-config'],
        suggestion:
          'use an encoder that publishes matching destination primaries, matrix, and range',
      },
    );
  }
  // H.273 transfer 1, 6, 14, and 15 describe the same transfer function. WebCodecs exposes only `bt709`,
  // so matching BT.2020 primaries + NCL matrix + limited range and an explicit BT.2020 transform are the
  // independent facts that disambiguate 14 from a genuine BT.709 destination.
  return intent.kind === 'bt2020-sdr' ? { ...published, transferCharacteristics: 14 } : published;
}

function descriptionBytes(
  description: AllowSharedBufferSource | undefined,
): Uint8Array | undefined {
  if (description === undefined) return undefined;
  return ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
}

function h264ColorCapabilityMiss(
  config: VideoDecoderConfig,
  intent: VideoColorMuxIntent,
  reason: string,
  cause?: unknown,
): CapabilityError {
  return new CapabilityError(
    `${intent.transform} output cannot author truthful H.264 elementary colour signaling: ${reason}`,
    {
      op: {
        kind: 'route',
        id: 'mux-video-color',
        facts: { codec: config.codec, transform: intent.transform, destinationColor: intent.kind },
      },
      tried: ['encoder-decoder-config', 'h264-sps-vui-rewrite'],
      suggestion: 'use AVC-format output with a complete avcC SPS declaration',
    },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Keep H.264's elementary SPS VUI and the container declaration identical. `avc1` proves parameter sets
 * live out-of-band in avcC, so rewriting every SPS there covers MP4, Matroska CodecPrivate, and the MPEG-TS
 * writer's injected Annex-B parameter sets. `avc3` permits later in-band SPS replacement and is declined:
 * a TrackInfo-only bridge cannot inspect or rewrite arbitrary access-unit parameter sets.
 */
function configForMuxIntent(
  config: VideoDecoderConfig,
  intent: VideoColorMuxIntent | undefined,
  color: TrackInfo['color'] | undefined,
): VideoDecoderConfig {
  if (intent === undefined) return config;
  const codec = config.codec.toLowerCase();
  const isH264 = codec === 'h264' || codec.startsWith('avc1') || codec.startsWith('avc3');
  if (!isH264) return config;
  if (!(codec === 'avc1' || codec.startsWith('avc1.'))) {
    throw h264ColorCapabilityMiss(
      config,
      intent,
      'the encoder did not publish an avc1 contract that excludes in-band SPS replacement',
    );
  }
  const description = descriptionBytes(config.description);
  if (description === undefined || description.byteLength === 0) {
    throw h264ColorCapabilityMiss(
      config,
      intent,
      'the encoder published no AVCDecoderConfigurationRecord',
    );
  }
  const primaries = color?.primaries;
  const transferCharacteristics = color?.transferCharacteristics;
  const matrixCoefficients = color?.matrixCoefficients;
  const range = color?.range;
  if (
    primaries === undefined ||
    transferCharacteristics === undefined ||
    matrixCoefficients === undefined ||
    (range !== 1 && range !== 2)
  ) {
    throw h264ColorCapabilityMiss(config, intent, 'the destination H.273 tuple is incomplete');
  }
  try {
    const rewritten = rewriteH264AvcCColor(description, {
      primaries,
      transferCharacteristics,
      matrixCoefficients,
      fullRange: range === 2,
    });
    return { ...config, description: rewritten };
  } catch (error) {
    throw h264ColorCapabilityMiss(
      config,
      intent,
      error instanceof Error ? error.message : 'the avcC SPS could not be rewritten and proved',
      error,
    );
  }
}

/**
 * Build the {@link TrackInfo} the `Muxer.addTrack` needs from the {@link VideoDecoderConfig} the video
 * encoder published (codec string + `description` + coded dims) plus the target framerate (which fixes
 * the mux timescale, mux.ts `videoTimescale`).
 */
export function videoTrackInfoFromDecoderConfig(
  config: VideoDecoderConfig,
  fps: number | undefined,
  durationSec?: number,
  rotation?: number,
  colorIntent?: VideoColorMuxIntent,
): TrackInfo {
  const color = colorForMuxIntent(videoColorFromDecoderConfig(config), colorIntent);
  const muxConfig = configForMuxIntent(config, colorIntent, color);
  return {
    id: 0, // overwritten by the muxer's own id allocation; addTrack returns the real id
    mediaType: 'video',
    codec: config.codec,
    config: muxConfig,
    ...(color !== undefined ? { color } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(rotation !== undefined ? { rotation } : {}),
  };
}

/** Build the audio {@link TrackInfo} for `Muxer.addTrack` from the encoder's {@link AudioDecoderConfig}. */
export function audioTrackInfoFromDecoderConfig(
  config: AudioDecoderConfig,
  durationSec?: number,
  gapless?: TrackInfo['gapless'],
): TrackInfo {
  return {
    id: 0,
    mediaType: 'audio',
    codec: config.codec,
    config,
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(gapless !== undefined ? { gapless } : {}),
  };
}

/**
 * Build AAC gapless facts from the destination encoder's own drained timing. Source delay/padding was
 * already consumed while decoding and is never valid for a new elementary stream (even when both codecs
 * use the same sample rate). Other output codecs keep their implementation-specific signaling paths —
 * e.g. Opus publishes pre-skip in OpusHead/CodecDelay.
 */
export function outputGaplessForAudioEncoder(
  config: AudioDecoderConfig,
  timing: AudioEncoderOutputTiming | undefined,
): TrackInfo['gapless'] | undefined {
  if (audioCodecToken(config.codec) !== 'aac' || timing === undefined) return undefined;
  const { sampleRate, submittedSamples, codedSamples, leadingSamples } = timing;
  if (
    sampleRate !== config.sampleRate ||
    !Number.isSafeInteger(submittedSamples) ||
    submittedSamples <= 0 ||
    codedSamples === undefined ||
    !Number.isSafeInteger(codedSamples) ||
    codedSamples <= 0 ||
    leadingSamples === undefined ||
    !Number.isSafeInteger(leadingSamples) ||
    leadingSamples < 0 ||
    leadingSamples + submittedSamples > codedSamples
  ) {
    return undefined;
  }
  return {
    leadingSamples,
    trailingSamples: codedSamples - leadingSamples - submittedSamples,
    totalSamples: submittedSamples,
  };
}

/**
 * Whether a source audio track can be copied packet-for-packet into a chunk-muxed output container.
 * This is deliberately a destination contract, not a codec-family guess: the source TrackInfo must
 * carry a WebCodecs audio config/description because the muxer uses those exact facts to author its
 * codec-private box or Matroska CodecPrivate. The public caller separately proves that no audio option
 * was requested and that the track is unencrypted.
 */
export function canCopyAudioTrackToContainer(
  container: string,
  track: Pick<TrackInfo, 'mediaType' | 'codec' | 'config' | 'encrypted'>,
): boolean {
  if (track.mediaType !== 'audio' || track.config === undefined || track.encrypted === true) {
    return false;
  }
  const codec = track.codec.toLowerCase();
  switch (container) {
    case 'mp4':
    case 'mov':
      return (
        codec.startsWith('mp4a') ||
        codec === 'aac' ||
        codec === 'mp3' ||
        codec.startsWith('opus') ||
        codec.startsWith('flac')
      );
    case 'webm':
    case 'mkv':
      return (
        codec.startsWith('opus') ||
        codec.startsWith('vorbis') ||
        codec.startsWith('flac') ||
        codec.startsWith('mp4a') ||
        codec === 'aac' ||
        codec === 'mp3'
      );
    default:
      return false;
  }
}
