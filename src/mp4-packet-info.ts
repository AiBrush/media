/**
 * `@aibrush/media/mp4-packet-info` — startup-sensitive MP4/MOV packet metadata.
 *
 * This focused entry keeps callers that only need the public packet table from loading the complete
 * driver-author surface (`@aibrush/media/core`), including unrelated containers, HLS, workers, and
 * muxers. It deliberately re-exports the same implementation rather than maintaining a second parser.
 */

export {
  mp4PacketInfoFromBytes,
  mp4PacketInfoFromUrl,
} from './api/mp4-prepared-mux.ts';
export type {
  Mp4PacketInfoFromBytesOptions,
  Mp4PacketInfoFromUrlOptions,
} from './api/mp4-prepared-mux.ts';
export { CapabilityError, InputError, MediaError } from './contracts/errors.ts';
