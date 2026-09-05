/**
 * Map a driver's probe result onto the public {@link MediaInfo}. This lives outside `op-support.ts`
 * because only the lazily loaded probe runner needs it: keeping it here leaves the eager kernel with
 * the routing/normalization helpers alone.
 */

import type { ContainerDriver, ProbeTracks, TrackInfo } from '../contracts/driver.ts';
import type { Source } from '../sources/source.ts';
import type { MediaInfo, MediaInfoTrack } from './types.ts';

export function toMediaInfo(
  container: ContainerDriver,
  tracks: ProbeTracks,
  src: Source,
): MediaInfo {
  const infoTracks = tracks.map(toInfoTrack);
  const durationSec = infoTracks.reduce((max, t) => Math.max(max, t.durationSec ?? 0), 0);
  const tags = tracks.tags;
  return {
    container: container.formats[0] ?? 'unknown',
    durationSec,
    ...(src.size !== undefined ? { sizeBytes: src.size } : {}),
    tracks: infoTracks,
    ...(tags !== undefined && Object.keys(tags).length > 0 ? { tags: { ...tags } } : {}),
  };
}

function toInfoTrack(t: TrackInfo): MediaInfoTrack {
  const base: MediaInfoTrack = {
    id: t.id,
    type: t.nonMedia ? 'other' : t.mediaType,
    codec: t.codec,
  };
  if (t.durationSec !== undefined) base.durationSec = t.durationSec;
  if (t.language !== undefined) base.language = t.language;
  if (t.defaultDisposition !== undefined) base.defaultDisposition = t.defaultDisposition;
  if (t.encrypted === true) base.encrypted = true;
  if (t.encryptionScheme !== undefined) base.encryptionScheme = t.encryptionScheme;
  if (t.fps !== undefined) base.fps = t.fps;
  if (t.rotation !== undefined) base.rotation = t.rotation;
  const config = t.config;
  if (config && 'codedWidth' in config) {
    if (config.codedWidth !== undefined) base.width = config.codedWidth;
    if (config.codedHeight !== undefined) base.height = config.codedHeight;
  }
  if (config && 'sampleRate' in config) {
    base.sampleRate = config.sampleRate;
    base.channels = config.numberOfChannels;
  }
  return base;
}
