/**
 * Router-query builders + codec-route predicates (S13 layer 1, docs/architecture/codec-pipeline.md
 * §3.3): normalize a demuxed track's codec string for `isConfigSupported`, shape the `CodecQuery` the
 * capability router (S01) ranks across tiers, and answer the pure "can this route serve the target?"
 * questions the engine asks before it opens any stream. The pipeline never names a backend — it emits
 * queries; a true miss is the router's typed `CapabilityError`. Pure + Node-unit-tested; no WebCodecs
 * objects, no frames.
 */

import type {
  CodecQuery,
  DecoderConfig,
  EncoderConfig,
  PacketMetadata,
  TrackInfo,
} from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import { normalizeClockwiseRotation } from '../util/rotation.ts';
import {
  avcCodecStringFromDescription,
  bitDepthFromCodec,
  hevcCodecStringFromDescription,
} from './codec-strings.ts';
import type { VideoTarget } from './types.ts';

/**
 * Default WebCodecs DECODE codec strings for a bare codec token a container demux may emit (the WebM/
 * Matroska driver maps its CodecID to the canonical tokens `vp8`/`vp9`/`av1`/…). `VideoDecoder.
 * isConfigSupported` REQUIRES a fully-qualified string — bare `vp9`/`av1` are rejected — so we expand
 * them to a broadly-decodable default profile/level/depth. VP8 is already its own valid string. VP9
 * profile 0 @ L1.0 8-bit (`vp09.00.10.08`) and AV1 Main profile, level 3.0, 8-bit (`av01.0.04M.08`)
 * decode the common 8-bit streams; the decoder reads the ACTUAL profile/level from the bitstream, so a
 * conservative advertised string still decodes higher-rung content (these codecs are self-describing
 * in-band and need no `description`). H.264/HEVC are intentionally absent: they need the `description`
 * codec-private (avcC/hvcC) to form `avc1.PPCCLL`/`hev1…` — handled from the description below when set.
 */
const DECODE_CODEC_STRING: Readonly<Record<string, string>> = {
  vp8: 'vp8',
  vp9: 'vp09.00.10.08',
  av1: 'av01.0.04M.08',
};

/** True when `codec` is already a fully-qualified WebCodecs codec string (has a profile/dotted suffix). */
function isQualifiedCodecString(codec: string): boolean {
  const c = codec.toLowerCase();
  // vp8 is its own complete string; everything else qualified carries a dot (avc1.*, vp09.*, av01.*, …).
  return c === 'vp8' || c.includes('.');
}

/**
 * Normalize a demuxed track's DECODE codec string to one `VideoDecoder`/`AudioDecoder` will accept.
 * A container demux (notably WebM/Matroska) emits the bare canonical token (`vp9`, `av1`, `h264`, …)
 * as `config.codec`, which `isConfigSupported` rejects; this maps it to a valid WebCodecs string:
 *   - already-qualified strings (`avc1.*`, `vp09.*`, `av01.*`, `vp8`, `opus`, `mp4a.*`, …) pass through;
 *   - bare `vp8`/`vp9`/`av1` → their default profile string ({@link DECODE_CODEC_STRING});
 *   - bare `h264`/`hevc` with a `description` (`avcC`/`hvcC`) → the profile-accurate RFC-6381 string;
 *   - anything else is returned unchanged (audio tokens like `opus`/`flac`/`vorbis` are already valid).
 * Pure + total; unit-tested. The wider H.264/HEVC-in-Matroska decode also needs the demuxer to surface
 * the CodecPrivate as `description` — without it the bare token cannot be expanded and decode stays a
 * miss (a demuxer-side gap, not this normalizer's).
 */
export function normalizeDecoderCodec(config: {
  codec: string;
  description?: AllowSharedBufferSource;
}): string {
  const codec = config.codec;
  if (isQualifiedCodecString(codec)) return codec;
  const lower = codec.toLowerCase();
  const mapped = DECODE_CODEC_STRING[lower];
  if (mapped !== undefined) return mapped;
  if ((lower === 'h264' || lower === 'avc') && config.description !== undefined) {
    return avcCodecStringFromDescription(config.description) ?? codec;
  }
  if ((lower === 'hevc' || lower === 'h265') && config.description !== undefined) {
    return hevcCodecStringFromDescription(config.description) ?? codec;
  }
  return codec;
}

/** Codec-router query for one demuxed track, with its codec string normalized for WebCodecs. */
export async function decodeQueryFor(
  track: TrackInfo,
): Promise<CodecQuery & { readonly direction: 'decode'; readonly config: DecoderConfig }> {
  const config = track.config;
  if (config === undefined) {
    throw new MediaError('decode-error', `track ${track.id} has no decoder config`);
  }
  const codec = normalizeDecoderCodec(config);
  return {
    mediaType: track.mediaType,
    direction: 'decode',
    config: codec === config.codec ? config : { ...config, codec },
  };
}

/** Codec-router query for an encoder config, inferring media type from its structural geometry. */
export function encodeQueryFor(config: EncoderConfig): CodecQuery {
  const mediaType: 'video' | 'audio' = 'width' in config && 'height' in config ? 'video' : 'audio';
  return { mediaType, direction: 'encode', config };
}

/** Assert that a live encoder published the decoder config required to author its container track. */
export function requireEncoderConfig<T>(config: T | undefined, media: 'video' | 'audio'): T {
  if (config === undefined) {
    throw new MediaError('encode-error', `${media} encoder emitted a chunk before config`);
  }
  return config;
}

// ============ source facts a route is planned against ============

/**
 * Source geometry a video encode/filter chain is planned against — the decoded frame's coded dimensions,
 * read from the demux `TrackInfo`'s WebCodecs config. Either may be `undefined` for a headerless source;
 * the resize/crop specs that need concrete dims then fall back to the explicit target dims.
 */
export interface SourceGeometry {
  width: number | undefined;
  height: number | undefined;
  /** Source container display rotation, clockwise-positive, when known. */
  rotation?: number;
  /** Source presentation frame rate when known; used only for rate-conversion capability planning. */
  fps?: number;
  /** Source declared duration when known; used only for runtime budget/capability planning. */
  durationSec?: number;
  /** Measured compressed video bitrate in bits/second, when a packet table proves it. */
  bitrate?: number;
}

/**
 * Resolve the physical quarter-turn a decoded-frame pipeline must bake into pixels.
 *
 * An explicit `rotate` is applied after the source container's display rotation, and the composed
 * orientation is baked into pixels with an identity output matrix. Thus `rotate: 0` is normalization and
 * a 90° source followed by `rotate: 270` is a physical no-op. Omitting `rotate` leaves pixels alone and
 * preserves the source display matrix at the mux boundary.
 */
export function videoPixelRotation(
  target: Pick<VideoTarget, 'rotate'>,
  src: Pick<SourceGeometry, 'rotation'>,
): 0 | 90 | 180 | 270 {
  if (target.rotate === undefined) return 0;
  const sourceRotation = normalizeClockwiseRotation(src.rotation) ?? 0;
  const composedRotation = (sourceRotation + target.rotate) % 360;
  if (
    composedRotation === 0 ||
    composedRotation === 90 ||
    composedRotation === 180 ||
    composedRotation === 270
  ) {
    return composedRotation;
  }
  throw new CapabilityError(
    `cannot bake composed video rotation ${composedRotation}° with the available quarter-turn filters`,
    { op: { kind: 'route', id: 'rotate' }, tried: ['video-filter/quarter-turn'] },
  );
}

/**
 * Rotation metadata for an encoded output. Any explicit rotate request is normalized into pixels and
 * therefore clears the source display matrix; an omitted request preserves it.
 */
export function outputVideoRotation(
  target: Pick<VideoTarget, 'rotate'>,
  sourceRotation: number | undefined,
): number | undefined {
  return target.rotate === undefined ? sourceRotation : undefined;
}

/**
 * Estimate one track's compressed bitrate from packet metadata without reading payload bytes. The
 * decode-time span uses **DTS plus packet duration** — never PTS — so B-frame reorder and VFR packet
 * cadence remain part of the evidence rather than being flattened to a nominal FPS (§3.4; golden-tested
 * against hand-derived VFR and reordered-DTS tables). Invalid/incomplete rows return undefined and let
 * the encoder retain its dimension-based fallback.
 */
export function sourceVideoBitrateFromPacketTable(
  table: readonly PacketMetadata[] | undefined,
  trackId: number,
): number | undefined {
  if (table === undefined) return undefined;
  let bytes = 0;
  let firstDtsUs = Number.POSITIVE_INFINITY;
  let lastEndUs = Number.NEGATIVE_INFINITY;
  for (const packet of table) {
    if (
      packet.trackId !== trackId ||
      !Number.isSafeInteger(packet.sizeBytes) ||
      packet.sizeBytes <= 0 ||
      !Number.isFinite(packet.dtsUs) ||
      !Number.isFinite(packet.durationUs) ||
      packet.durationUs <= 0
    ) {
      continue;
    }
    bytes += packet.sizeBytes;
    firstDtsUs = Math.min(firstDtsUs, packet.dtsUs);
    lastEndUs = Math.max(lastEndUs, packet.dtsUs + packet.durationUs);
  }
  const spanUs = lastEndUs - firstDtsUs;
  if (bytes <= 0 || !Number.isFinite(spanUs) || spanUs <= 0) return undefined;
  const bitrate = Math.round((bytes * 8 * 1_000_000) / spanUs);
  return Number.isSafeInteger(bitrate) && bitrate > 0 ? bitrate : undefined;
}

/**
 * The output frame dimensions after a filter chain, given the source coded dims — needed to size the
 * `VideoEncoderConfig`. Mirrors `videoFilterSpecs` (video-stream-plan.ts, lazily imported): crop sets
 * the size to the crop rect; resize to the resize dims; a 90/270 rotate swaps width↔height; flip is
 * dimension-preserving. Returns the source dims unchanged when no geometry op applies. Pure (geometry
 * only), so it is fully Node-tested.
 */
export function outputDimensions(
  target: VideoTarget,
  src: SourceGeometry,
): { width: number | undefined; height: number | undefined } {
  let width = src.width;
  let height = src.height;
  if (target.crop) {
    width = target.crop.width;
    height = target.crop.height;
  }
  if (target.width !== undefined || target.height !== undefined) {
    width = target.width ?? width;
    height = target.height ?? height;
  }
  if (target.pad !== undefined) {
    width = target.pad.width;
    height = target.pad.height;
  }
  const rotation = videoPixelRotation(target, src);
  if (rotation === 90 || rotation === 270) {
    const w = width;
    width = height;
    height = w;
  }
  return { width, height };
}

// ============ VPx-alpha route predicates (pure plan facts, no frames) ============

/**
 * True when a VPx-alpha transcode can preserve the alpha side stream without decoding to merged RGBA
 * frames. Any pixel/timing transform or unproved precision transition must use the general decoded-frame
 * path instead. The caller supplies the already-resolved encoder codec so the comparison cannot be bypassed
 * by a bare target token or an implicit profile default.
 */
export function canUseVpxAlphaPacketTranscode(
  target: VideoTarget,
  sourceHasAlpha: boolean,
  sourceCodec: string,
  targetCodec: string,
): boolean {
  const sourceBitDepth = bitDepthFromCodec(sourceCodec);
  const targetBitDepth = bitDepthFromCodec(targetCodec);
  return (
    sourceHasAlpha &&
    sourceBitDepth !== undefined &&
    targetBitDepth === sourceBitDepth &&
    target.alpha === 'keep' &&
    target.width === undefined &&
    target.height === undefined &&
    target.crop === undefined &&
    target.pad === undefined &&
    target.rotate === undefined &&
    target.flip === undefined &&
    target.colorspace === undefined &&
    target.tonemap === undefined &&
    target.fps === undefined
  );
}

/**
 * True when a VPx-alpha transcode can resize the colour and alpha elementary streams independently.
 * Geometry-only resize preserves the two-plane contract without materializing an intermediate RGBA
 * frame; crop/pad/rotation/colour/timing transforms stay on the merged path until their plane semantics
 * are independently proven. Rate-control options are intentionally allowed: both planes are encoded.
 */
export function canUseVpxAlphaGeometryPacketTranscode(
  target: VideoTarget,
  sourceHasAlpha: boolean,
  sourceCodec: string,
  targetCodec: string,
): boolean {
  const sourceBitDepth = bitDepthFromCodec(sourceCodec);
  const targetBitDepth = bitDepthFromCodec(targetCodec);
  const hasResize = target.width !== undefined || target.height !== undefined;
  return (
    sourceHasAlpha &&
    sourceBitDepth !== undefined &&
    targetBitDepth === sourceBitDepth &&
    target.alpha === 'keep' &&
    hasResize &&
    target.crop === undefined &&
    target.pad === undefined &&
    target.rotate === undefined &&
    target.flip === undefined &&
    target.colorspace === undefined &&
    target.tonemap === undefined &&
    target.fps === undefined
  );
}

/** Prefer a proved decoder qualification over the container's bare family token. */
export function qualifiedVideoSourceCodec(track: Pick<TrackInfo, 'codec' | 'config'>): string {
  return track.config !== undefined && 'codedWidth' in track.config
    ? track.config.codec
    : track.codec;
}

function vpxAlphaProfile(codec: string): string | undefined {
  const normalized = codec.toLowerCase();
  if (normalized === 'vp8') return 'vp8';
  const vp9 = /^vp09\.(\d{2})\./.exec(normalized);
  return vp9?.[1] === undefined ? undefined : `vp9:${vp9[1]}`;
}

/**
 * Whether an unfiltered same-codec VPx transcode can preserve the already-separate alpha elementary
 * stream byte-for-byte while genuinely re-encoding colour. Explicit rate controls apply to both planes,
 * so they keep the dual-encode path.
 */
export function canCopyVpxAlphaSideData(
  target: Pick<VideoTarget, 'bitrate' | 'bitrateMode' | 'crf' | 'twoPass'>,
  sourceCodec: string,
  targetCodec: string,
): boolean {
  const sourceProfile = vpxAlphaProfile(sourceCodec);
  return (
    target.bitrate === undefined &&
    target.bitrateMode === undefined &&
    target.crf === undefined &&
    target.twoPass !== true &&
    sourceProfile !== undefined &&
    sourceProfile === vpxAlphaProfile(targetCodec)
  );
}
