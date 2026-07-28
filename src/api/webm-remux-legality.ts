import type { TrackInfo } from '../contracts/driver.ts';
import { CapabilityError } from '../contracts/errors.ts';

function isWebmSubsetTrack(track: TrackInfo): boolean {
  const codec = track.codec.toLowerCase();
  if (track.mediaType === 'video') {
    return (
      codec.startsWith('vp8') ||
      codec.startsWith('vp08') ||
      codec.startsWith('vp9') ||
      codec.startsWith('vp09') ||
      codec.startsWith('av1') ||
      codec.startsWith('av01')
    );
  }
  return codec.startsWith('opus') || codec.startsWith('vorbis');
}

/**
 * Remux must preserve coded packets, so a track outside the WebM subset cannot be repaired by this path.
 * Matroska accepts the broader codec map; only a literal `webm` target needs this additional gate.
 */
export function assertWebmRemuxTracksLegal(target: string, tracks: readonly TrackInfo[]): void {
  if (target !== 'webm') return;
  const illegal = tracks.find((track) => !isWebmSubsetTrack(track));
  if (illegal === undefined) return;
  throw new CapabilityError(
    `remux webm cannot carry ${illegal.mediaType} codec '${illegal.codec}' without transcoding`,
    {
      op: {
        kind: 'route',
        id: 'remux',
        facts: {
          container: target,
          mediaType: illegal.mediaType,
          codec: illegal.codec,
        },
      },
      tried: ['webm', illegal.codec],
      suggestion: "use Matroska ('mkv') for packet-copy or transcode to a WebM codec",
    },
  );
}
