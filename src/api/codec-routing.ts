/**
 * Cheap codec/container routing predicates used by the eager engine kernel. The heavier codec-seam
 * helpers (encoder config synthesis, packet drains, seek frame selection) stay in `codec-pipeline.ts`
 * and are imported lazily from live decode/encode paths to preserve the doc 08 eager-kernel budget.
 */

import type { PcmContainer, TrackInfo } from '../contracts/driver.ts';
import { InputError } from '../contracts/errors.ts';
import type { AudioTarget, Container, VideoTarget } from './types.ts';

/**
 * Container tokens with a working EncodedChunk-seam `Muxer` (`createMuxer` returns a real muxer, not a
 * typed mux miss): MP4/MOV (`writeMp4`), WebM/MKV (`ebml-write`), Ogg (`ogg-write`), MPEG-TS (`ts-write`,
 * H.264/AAC only), native FLAC (`FlacMuxer`, fed by the pure-TS FLAC encode codec driver, ADR-085), and
 * MP3 (`Mp3Muxer` — a bare concatenation of MPEG Layer III frames), and ADTS (`AdtsMuxer` — raw AAC access
 * units each wrapped in a 7-byte ADTS header), both fed by a remux or the codec encode driver. The raw-PCM
 * containers (WAV/AIFF/CAF) go through the audio-dsp `transformPcm` path instead (ADR-022) and stay a typed
 * mux miss here — so a codec-seam convert/encode/remux targeting one of those surfaces an honest miss rather
 * than pretend. This mirrors the registered muxers' own truth; an illegal codec-in-container is still
 * rejected by the muxer's `addTrack`/`mapCodec` (the single source of codec-legality), so this set never
 * over-claims.
 */
const CODEC_MUX_CONTAINERS = new Set<Container>([
  'mp4',
  'mov',
  'webm',
  'mkv',
  'ogg',
  'ts',
  'flac',
  'mp3',
  'adts',
]);

/** True when {@link container} has a working EncodedChunk-seam muxer. */
export function containerHasChunkMuxer(container: Container): boolean {
  return CODEC_MUX_CONTAINERS.has(container);
}

/**
 * Choose the output container for an encode/convert. An explicit `to` always wins; otherwise default to
 * the source container when it is itself chunk-muxable (so a same-container re-encode keeps the format),
 * else `mp4` (the universally-muxable default for the codec seam). Returns the token unchanged — the
 * caller routes it through the container router, which raises a typed miss for a non-muxable target.
 */
export function chooseOutputContainer(
  to: Container | undefined,
  sourceContainer: string | undefined,
): Container {
  if (to !== undefined) return to;
  if (sourceContainer !== undefined && isContainerToken(sourceContainer)) {
    return containerHasChunkMuxer(sourceContainer) ? sourceContainer : 'mp4';
  }
  return 'mp4';
}

const CONTAINER_TOKENS = new Set<string>([
  'mp4',
  'mov',
  'webm',
  'mkv',
  'ogg',
  'wav',
  'mp3',
  'aac',
  'adts',
  'flac',
  'aiff',
  'caf',
  'avi',
  'ts',
  'm2ts',
  'mts',
  'mpegts',
]);

function isContainerToken(s: string): s is Container {
  return CONTAINER_TOKENS.has(s);
}

/**
 * Raw-PCM container tokens whose audio is carried as uncompressed samples and re-serialized through the
 * TS audio-dsp `transformPcm` path (ADR-022), NOT the WebCodecs EncodedChunk muxer: WAV (RIFF/PCM), AIFF/
 * AIFF-C, and CAF. A `convert` to one of these with a PCM/no-codec audio target routes to the source
 * container's `transformPcm` (a same-container PCM transform — channel mix / format / sample-rate) rather
 * than the codec seam. The set is the engine's gate for that route; a non-PCM container falls through.
 */
const PCM_CONTAINERS = new Set<PcmContainer>(['wav', 'aiff', 'caf']);

/** True when {@link container} is a raw-PCM container served by the `transformPcm` audio-dsp path. */
export function isPcmContainer(container: Container): container is PcmContainer {
  return PCM_CONTAINERS.has(container as PcmContainer);
}

const TRACK_SELECTOR = /^(video|audio):(\d+)(?:@(\d+))?$/;

interface ParsedTrackSelector {
  mediaType: 'video' | 'audio';
  index: number;
  sourceIndex: number | undefined;
}

function parseTrackSelector(raw: string): ParsedTrackSelector {
  const match = TRACK_SELECTOR.exec(raw);
  if (!match) {
    throw new InputError('unsupported-input', 'bad selector');
  }
  const mediaType = match[1] === 'video' ? 'video' : 'audio';
  const index = Number(match[2]);
  const sourceIndex = match[3] === undefined ? undefined : Number(match[3]);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    (sourceIndex !== undefined && (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0))
  ) {
    throw new InputError('unsupported-input', `invalid track selector '${raw}'`);
  }
  return { mediaType, index, sourceIndex };
}

/** True when an operation was given explicit single-source track selectors. */
export function hasTrackSelection(selectors: readonly string[] | undefined): boolean {
  return selectors !== undefined && selectors.length > 0;
}

/**
 * Select tracks by harness/public selectors (`audio:0`, `video:1`, optional single-source `@0`). The
 * order of selectors is preserved and duplicates are collapsed, so muxers see the caller's intended
 * track order without writing the same source track twice.
 */
export function selectTrackInfos<T extends Pick<TrackInfo, 'mediaType'>>(
  tracks: readonly T[],
  selectors: readonly string[] | undefined,
): T[] {
  if (!hasTrackSelection(selectors)) return [...tracks];
  const requested = selectors ?? [];
  const out: T[] = [];
  const seen = new Set<T>();
  for (const raw of requested) {
    const selector = parseTrackSelector(raw);
    if (selector.sourceIndex !== undefined && selector.sourceIndex !== 0) continue;
    const matching = tracks.filter((track) => track.mediaType === selector.mediaType);
    const track = matching[selector.index];
    if (track && !seen.has(track)) {
      seen.add(track);
      out.push(track);
    }
  }
  if (out.length === 0) {
    throw new InputError('unsupported-input', 'no track');
  }
  return out;
}

/**
 * Decide whether a `convert` request is a pure **container change with no re-encode** — i.e. neither
 * stream is dropped, no video filter/codec/dims/fps/bitrate change is requested, and no audio
 * codec/rate/channel/bitrate change is requested. Such a request is a stream-copy (the remux fast path),
 * which preserves codec-private/DTS/B-frames losslessly (ADR-021) and is always preferred over the codec
 * seam. Any re-encode trigger (a codec target, a filter, a dimension/rate change) returns `false`.
 */
export function isPureStreamCopy(opts: {
  video?: false | VideoTarget;
  audio?: false | AudioTarget;
}): boolean {
  if (opts.video === false || opts.audio === false) return false;
  if (opts.video !== undefined && videoTargetRequestsReencode(opts.video)) return false;
  if (opts.audio !== undefined && audioTargetRequestsReencode(opts.audio)) return false;
  return true;
}

function videoTargetRequestsReencode(t: VideoTarget): boolean {
  return (
    t.codec !== undefined ||
    t.width !== undefined ||
    t.height !== undefined ||
    t.fps !== undefined ||
    t.bitrate !== undefined ||
    t.crf !== undefined ||
    t.rotate !== undefined ||
    t.flip !== undefined ||
    t.crop !== undefined ||
    t.colorspace !== undefined ||
    t.tonemap !== undefined
  );
}

function audioTargetRequestsReencode(t: AudioTarget): boolean {
  return (
    t.codec !== undefined ||
    t.sampleRate !== undefined ||
    t.channels !== undefined ||
    t.bitrate !== undefined ||
    (t.gainDb !== undefined && t.gainDb !== 0) ||
    t.fade !== undefined ||
    t.dynamics !== undefined ||
    t.biquad !== undefined
  );
}
