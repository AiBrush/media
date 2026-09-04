/**
 * `@aibrush/media/hls` — the HLS (RFC 8216) manifest surface on its own: playlist parsing, key/segment
 * resolution to a byte source, and the encrypted-segment check. Startup-sensitive callers that only
 * resolve manifests (players, harness adapters) reach it in one small request instead of importing the
 * complete `/core` graph. It re-exports the canonical implementation; nothing is duplicated in source.
 */

export {
  type HlsResolveOptions,
  type HlsResourceFetcher,
  type HlsVariantChoice,
  hlsPlaylistHasEncryptedSegments,
  isHlsPlaylist,
  resolveHlsProbeSource,
  resolveHlsSource,
  resolveHlsSourceFromSource,
} from './drivers/hls/hls-source.ts';
export { parseM3u8 } from './drivers/hls/m3u8-parse.ts';
export type { HlsPlaylist } from './drivers/hls/m3u8-parse.ts';
export { CapabilityError, InputError, MediaError } from './contracts/errors.ts';
