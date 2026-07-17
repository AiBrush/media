/**
 * Mux `TrackInfo` builders (S13 layer 1, docs/architecture/codec-pipeline.md §3.2): shape the track the
 * `Muxer.addTrack` seam consumes from the decoder config a live encoder *published* — the decoder
 * config, not the public target, is the source of truth so the muxer writes the exact codec box
 * (avcC/hvcC/…) the encoder produced — plus the packet-copy legality predicate and the output-gapless
 * selection. Pure + Node-unit-tested; no WebCodecs objects, no frames.
 */

import type { TrackInfo } from '../contracts/driver.ts';
import { audioCodecToken } from './encoder-config.ts';

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
): TrackInfo {
  return {
    id: 0, // overwritten by the muxer's own id allocation; addTrack returns the real id
    mediaType: 'video',
    codec: config.codec,
    config,
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
 * Select gapless facts for an encoded output track. Source gapless facts are consumed while decoding the
 * input; an Opus re-encode must instead publish the encoder's own OpusHead/CodecDelay because Opus always
 * runs at 48 kHz and its priming is not expressed in the source codec's sample units.
 */
export function outputGaplessForAudioEncoder(
  config: AudioDecoderConfig,
  sourceTrack: Pick<TrackInfo, 'gapless'> | undefined,
): TrackInfo['gapless'] | undefined {
  return audioCodecToken(config.codec) === 'opus' ? undefined : sourceTrack?.gapless;
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
