/**
 * Cheap codec/container routing predicates used by the eager engine kernel. The heavier codec-seam
 * helpers (encoder config synthesis, packet drains, seek frame selection) stay in `codec-pipeline.ts`
 * and are imported lazily from live decode/encode paths to preserve the doc 08 eager-kernel budget.
 */

import type { PcmContainer } from '../contracts/driver.ts';
import type { Container } from './types.ts';

/**
 * Container tokens with a working EncodedChunk-seam `Muxer` (`createMuxer` returns a real muxer, not a
 * typed mux miss): MP4/MOV (`writeMp4`), WebM/MKV (`ebml-write`), Ogg (`ogg-write`), MPEG-TS (`ts-write`,
 * H.264/AAC only), native FLAC (`FlacMuxer`, fed by the pure-TS FLAC encode codec driver, ADR-085), and
 * MP3 (`Mp3Muxer` — a bare concatenation of MPEG Layer III frames), and ADTS (`AdtsMuxer` — raw AAC access
 * units each wrapped in a 7-byte ADTS header), both fed by a remux or the codec encode driver. WAV has a
 * narrow raw-PCM packet muxer for explicit packet-stream assembly, and AVI writes RIFF `hdrl`/`movi`/`idx1`
 * packet layouts. Ordinary WAV/AIFF/CAF PCM authoring still prefers the audio-dsp `transformPcm` path
 * (ADR-022). This mirrors the registered muxers' own truth; an illegal codec-in-container is still rejected
 * by the muxer's `addTrack`/`mapCodec` (the single source of codec-legality), so this set never over-claims.
 */
const CODEC_MUX_CONTAINERS = '|mp4|mov|webm|mkv|ogg|ts|m2ts|mts|mpegts|flac|mp3|adts|aac|wav|avi|';

/** True when {@link container} has a working EncodedChunk-seam muxer. */
export function containerHasChunkMuxer(container: string): container is Container {
  return hasDelimitedToken(CODEC_MUX_CONTAINERS, container);
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
  return sourceContainer !== undefined &&
    !isPcmContainer(sourceContainer) &&
    containerHasChunkMuxer(sourceContainer)
    ? sourceContainer
    : 'mp4';
}

function hasDelimitedToken(tokens: string, token: string): boolean {
  return tokens.includes(`|${token}|`);
}

/**
 * Raw-PCM container tokens whose audio is carried as uncompressed samples and re-serialized through the
 * TS audio-dsp `transformPcm` path (ADR-022), NOT the WebCodecs EncodedChunk muxer: WAV (RIFF/PCM), AIFF/
 * AIFF-C, and CAF. A `convert` to one of these with a PCM/no-codec audio target routes to the source
 * container's `transformPcm` (a same-container PCM transform — channel mix / format / sample-rate) rather
 * than the codec seam. The set is the engine's gate for that route; a non-PCM container falls through.
 */
/** True when {@link container} is a raw-PCM container served by the `transformPcm` audio-dsp path. */
export function isPcmContainer(container: string): container is PcmContainer {
  return container === 'wav' || container === 'aiff' || container === 'caf';
}

// Track-selection helpers (`selectTrackInfos`/`hasTrackSelection`) moved to `track-select.ts` so they load
// lazily only when a `trackSelect` request is present (doc 08 §7 eager-kernel budget split).
