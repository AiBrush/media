/**
 * Track-selection helpers (`audio:0`, `video:1`, optional single-source `@0`) — reached only when a
 * `convert`/`remux`/`mux` request carries explicit `trackSelect` selectors, so this lives OUT of the eager
 * kernel and is pulled in lazily from those op paths (doc 08 §7 budget split). The trivial "were any
 * selectors given?" predicate stays inline at the call site; the parse/select logic is here.
 */

import type { TrackInfo } from '../contracts/driver.ts';
import { InputError } from '../contracts/errors.ts';

const TRACK_SELECTOR = /^(video|audio):(\d+)(?:@(\d+))?$/;

interface ParsedTrackSelector {
  mediaType: 'video' | 'audio';
  index: number;
  sourceIndex: number | undefined;
}

function parseTrackSelector(raw: string): ParsedTrackSelector {
  const match = TRACK_SELECTOR.exec(raw);
  if (!match) {
    // Name the offending selector (R-S05.10) so a caller mixing several can see which one is malformed.
    throw new InputError(`bad selector '${raw}' (expected 'video:N' | 'audio:N' | '…@S')`, { raw });
  }
  const mediaType = match[1] === 'video' ? 'video' : 'audio';
  const index = Number(match[2]);
  const sourceIndex = match[3] === undefined ? undefined : Number(match[3]);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    (sourceIndex !== undefined && (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0))
  ) {
    throw new InputError(`invalid track selector '${raw}'`);
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
 *
 * **Selector contract — non-zero source suffixes (documented drop, R-S05.10):** the `@S` suffix names a
 * source *slot*; this single-source path serves slot `0` only, so a well-formed selector addressed to
 * another slot (`video:0@1`) is deliberately skipped — it belongs to a different source, not to this
 * one, and dropping it here is what lets one selector list be fanned across the future multi-source
 * assembly seam without per-source rewrites. When *every* selector addresses another slot the selection
 * is empty and a typed `InputError('no track')` still surfaces (never a silent empty mux).
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
    if (selector.sourceIndex !== undefined && selector.sourceIndex !== 0) continue; // other-slot selector: documented drop (see contract above)
    const matching = tracks.filter((track) => track.mediaType === selector.mediaType);
    const track = matching[selector.index];
    if (track && !seen.has(track)) {
      seen.add(track);
      out.push(track);
    }
  }
  if (out.length === 0) {
    throw new InputError('no track');
  }
  return out;
}
