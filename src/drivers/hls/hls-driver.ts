/**
 * HLS (`.m3u8`) driver module. HLS is **not** a byte container — it is a text manifest that points at
 * variant sub-playlists (master) or media segments (media). So this module does not register an "hls"
 * `ContainerDriver`; instead it (a) exports the pure {@link parseM3u8} playlist parser (re-exported from
 * {@link import('./m3u8-parse.ts')}), and (b) default-exports a {@link DriverModule} that registers the
 * {@link MpegTsDriver} — the container the HLS **segments** are in — so an engine told to `.use()` HLS can
 * resolve + demux those `.ts` segments. fMP4/CMAF segments are handled by the MP4 driver (registered by
 * the first-party defaults), which is why this module pulls in only the TS dependency it strictly owns.
 *
 * The parent registers first-party drivers via its own `defaults.ts`; this module is registered only on
 * explicit `media.use(HlsModule)` (it is not added to the defaults here, by design).
 */

import { DRIVER_API_VERSION, type DriverModule, type Registry } from '../../contracts/driver.ts';
import { MpegTsDriver } from '../mpegts/mpegts-driver.ts';

export {
  type HlsByteRange,
  type HlsKey,
  type HlsMap,
  type HlsMasterPlaylist,
  type HlsMediaPlaylist,
  type HlsPlaylist,
  type HlsSegment,
  type HlsVariant,
  parseM3u8,
} from './m3u8-parse.ts';

/**
 * The HLS driver module: registers the MPEG-TS container driver used by HLS media segments. Idempotent
 * by driver id (the registry dedupes), so using both {@link HlsModule} and the MPEG-TS module is safe.
 */
export const HlsModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(MpegTsDriver);
  },
};

export default HlsModule;
