/**
 * Proof-based source-aware stream-copy eligibility for `convert()` (ADR-263).
 *
 * This module decides only whether requested output semantics are already true. The engine separately
 * proves that the routed container has a native writer for the exact target before invoking stream-copy.
 */

import type { ContainerDriver, StageOptions, TrackInfo } from '../contracts/driver.ts';
import type { Source } from '../sources/source.ts';
import { normalizeClockwiseRotation } from '../util/rotation.ts';
import type { AudioCodec, AudioTarget, ConvertOptions, VideoCodec, VideoTarget } from './types.ts';

/** Keep the MP4 Blob-reuse implementation behind the already-lazy semantic proof module. */
export async function reuseBlob(
  input: Blob | undefined,
  container: ContainerDriver,
  source: Source,
  stage: StageOptions,
  opts: ConvertOptions,
): Promise<Blob | undefined> {
  if (input === undefined) return undefined;
  const { tryReuseSemanticMp4Blob } = await import('./remux-metadata.ts');
  return tryReuseSemanticMp4Blob(input, container, source, stage, opts);
}

/** True only for a container-only conversion that requests no track drop, transform, or re-encode. */
export function isPureStreamCopy(opts: {
  video?: false | VideoTarget;
  audio?: false | AudioTarget;
}): boolean {
  if (opts.video === false || opts.audio === false) return false;
  if (opts.video !== undefined && videoTargetRequestsReencode(opts.video)) return false;
  if (opts.audio !== undefined && audioTargetRequestsReencode(opts.audio)) return false;
  return true;
}

function videoTargetRequestsReencode(target: VideoTarget): boolean {
  return (
    target.codec !== undefined ||
    target.width !== undefined ||
    target.height !== undefined ||
    target.fit !== undefined ||
    target.fps !== undefined ||
    target.bitrate !== undefined ||
    target.maxAverageBitrate !== undefined ||
    target.quality !== undefined ||
    target.bitrateMode !== undefined ||
    target.crf !== undefined ||
    target.twoPass === true ||
    target.bitDepth !== undefined ||
    target.alpha !== undefined ||
    target.rotate !== undefined ||
    target.flip !== undefined ||
    target.crop !== undefined ||
    target.pad !== undefined ||
    target.colorspace !== undefined ||
    target.tonemap !== undefined
  );
}

function audioTargetRequestsReencode(target: AudioTarget): boolean {
  return (
    target.codec !== undefined ||
    target.sampleRate !== undefined ||
    target.channels !== undefined ||
    target.bitrate !== undefined ||
    (target.gainDb !== undefined && target.gainDb !== 0) ||
    target.fade !== undefined ||
    target.mixMatrix !== undefined ||
    target.dynamics !== undefined ||
    target.biquad !== undefined
  );
}

/**
 * Cheap pre-probe gate for ADR-263's source-aware semantic no-op route. `true` only means exact source
 * metadata might prove the request is already satisfied; the full predicate still has to prove every
 * stream fact. Always-mutating requests remain on the codec path without paying a metadata probe.
 */
export function mayBeSemanticStreamCopy(opts: ConvertOptions): boolean {
  if (opts.to === undefined || (opts.video === false && opts.audio === false)) return false;
  // Excluding an absent media type is a semantic no-op, but only source metadata can prove absence. A
  // positive post-probe predicate still rejects every real track drop (ADR-283).
  let needsSourceProof = opts.video === false || opts.audio === false;
  const video = opts.video;
  if (video !== undefined && video !== false) {
    if (
      video.fps !== undefined ||
      video.bitrate !== undefined ||
      video.maxAverageBitrate !== undefined ||
      video.quality !== undefined ||
      video.bitrateMode !== undefined ||
      video.crf !== undefined ||
      video.twoPass === true ||
      video.fit !== undefined ||
      video.flip !== undefined ||
      video.crop !== undefined ||
      video.pad !== undefined ||
      video.colorspace !== undefined ||
      video.tonemap !== undefined ||
      (video.rotate !== undefined && video.rotate !== 0)
    ) {
      return false;
    }
    needsSourceProof =
      video.codec !== undefined ||
      video.width !== undefined ||
      video.height !== undefined ||
      video.bitDepth !== undefined ||
      video.alpha !== undefined ||
      video.rotate !== undefined;
  }

  const audio = opts.audio;
  if (audio !== undefined && audio !== false) {
    if (
      audio.bitrate !== undefined ||
      (audio.gainDb !== undefined && audio.gainDb !== 0) ||
      audio.fade !== undefined ||
      audio.mixMatrix !== undefined ||
      audio.dynamics !== undefined ||
      audio.biquad !== undefined
    ) {
      return false;
    }
    needsSourceProof ||=
      audio.codec !== undefined || audio.sampleRate !== undefined || audio.channels !== undefined;
  }
  return needsSourceProof;
}

/** True only when every requested media semantic is exactly proved by source track metadata. */
export function isSemanticStreamCopy(opts: ConvertOptions, tracks: readonly TrackInfo[]): boolean {
  if (!mayBeSemanticStreamCopy(opts) || tracks.length === 0) return false;
  if (
    tracks.some(
      (track) =>
        track.nonMedia === true ||
        track.containerProjection !== undefined ||
        track.config === undefined ||
        track.encrypted,
    )
  ) {
    return false;
  }
  const videoTracks = tracks.filter((track) => track.mediaType === 'video');
  const audioTracks = tracks.filter((track) => track.mediaType === 'audio');
  if (
    videoTracks.length > 1 ||
    audioTracks.length > 1 ||
    videoTracks.length + audioTracks.length !== tracks.length
  ) {
    return false;
  }

  const videoTarget = opts.video;
  if (videoTarget === false) {
    if (videoTracks.length !== 0) return false;
  } else if (videoTarget !== undefined) {
    const videoTrack = videoTracks[0];
    if (videoTrack === undefined || !videoSemanticsMatch(videoTarget, videoTrack)) return false;
  }
  const audioTarget = opts.audio;
  if (audioTarget === false) {
    if (audioTracks.length !== 0) return false;
  } else if (audioTarget !== undefined) {
    const audioTrack = audioTracks[0];
    if (audioTrack === undefined || !audioSemanticsMatch(audioTarget, audioTrack)) return false;
  }
  return true;
}

function videoSemanticsMatch(target: VideoTarget, track: TrackInfo): boolean {
  const config = track.config;
  if (config === undefined || !('codedWidth' in config)) return false;
  const codec = config.codec;
  const family = videoFamily(codec);
  if (target.codec !== undefined && family !== target.codec) return false;
  if (target.width !== undefined && target.width !== config.codedWidth) return false;
  if (target.height !== undefined && target.height !== config.codedHeight) return false;
  if (
    target.rotate !== undefined &&
    (target.rotate !== 0 || normalizeClockwiseRotation(track.rotation) !== 0)
  ) {
    return false;
  }
  if (target.bitDepth !== undefined && target.bitDepth !== videoBitDepth(codec)) return false;
  if (target.alpha === 'keep') {
    if (track.alpha !== true || !codecCanCarryAlpha(family)) return false;
  } else if (target.alpha === 'discard') {
    if (track.alpha === true) return false;
    if (family === undefined || codecCanCarryAlpha(family)) return false;
  }
  return true;
}

function audioSemanticsMatch(
  target: Exclude<ConvertOptions['audio'], false | undefined>,
  track: TrackInfo,
): boolean {
  const config = track.config;
  if (config === undefined || !('sampleRate' in config)) return false;
  if (target.codec !== undefined && audioFamily(config.codec) !== target.codec) return false;
  if (target.sampleRate !== undefined && target.sampleRate !== config.sampleRate) return false;
  if (target.channels !== undefined && target.channels !== config.numberOfChannels) return false;
  return true;
}

function videoFamily(codec: string): VideoCodec | undefined {
  const normalized = codec.toLowerCase();
  if (normalized.startsWith('avc1') || normalized.startsWith('avc3')) return 'h264';
  if (normalized.startsWith('hev1') || normalized.startsWith('hvc1')) return 'hevc';
  if (normalized === 'vp8' || normalized.startsWith('vp8.')) return 'vp8';
  if (normalized === 'vp9' || normalized.startsWith('vp09.')) return 'vp9';
  return normalized.startsWith('av01.') ? 'av1' : undefined;
}

function audioFamily(codec: string): AudioCodec | undefined {
  const normalized = codec.toLowerCase();
  if (normalized === 'aac' || normalized.startsWith('mp4a.40.')) return 'aac';
  if (normalized === 'opus' || normalized === 'a_opus') return 'opus';
  if (normalized === 'mp3' || normalized === 'mp4a.6b' || normalized === 'a_mpeg/l3') return 'mp3';
  if (normalized === 'flac' || normalized === 'a_flac') return 'flac';
  if (normalized === 'vorbis' || normalized === 'a_vorbis') return 'vorbis';
  return undefined;
}

function codecCanCarryAlpha(codec: VideoCodec | undefined): boolean {
  return codec === 'vp8' || codec === 'vp9';
}

function videoBitDepth(codec: string): 8 | 10 | 12 | undefined {
  const normalized = codec.toLowerCase();
  const avc = /^avc[13]\.([0-9a-f]{2})/.exec(normalized);
  if (avc?.[1] !== undefined) {
    const profile = Number.parseInt(avc[1], 16);
    if (profile === 110) return 10;
    if (profile === 66 || profile === 77 || profile === 88 || profile === 100) return 8;
    return undefined;
  }
  const hevc = /^(?:hev1|hvc1)\.[abc]?(\d+)\./.exec(normalized);
  if (hevc?.[1] === '1') return 8;
  if (hevc?.[1] === '2') return 10;
  if (normalized === 'vp8' || normalized.startsWith('vp8.')) return 8;
  const delimited = /^(?:vp09|av01)\.[^.]+\.[^.]+\.(8|08|10|12)(?:\.|$)/.exec(normalized);
  if (delimited?.[1] === '8' || delimited?.[1] === '08') return 8;
  if (delimited?.[1] === '10') return 10;
  return delimited?.[1] === '12' ? 12 : undefined;
}
