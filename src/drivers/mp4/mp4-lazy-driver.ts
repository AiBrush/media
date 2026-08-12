/** Lightweight MP4/MOV proxy shared by register-all and query-selective registration. */

import type { DriverModule, Registry } from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { type LazyContainerSpec, lazyContainer } from '../lazy-container.ts';
import { matchesMp4 } from './mp4-sniff.ts';

export const MP4_LAZY_CONTAINER_SPEC: LazyContainerSpec = {
  id: 'mp4',
  formats: ['mp4', 'mov'],
  supports: matchesMp4,
  load: () => import('./mp4-driver.ts').then((module) => module.Mp4Driver),
  probe: true,
  probeImpl: (src, options) =>
    import('./mp4-lazy-probe.ts').then((module) => module.probeMp4Faststart(src, options)),
  packetInfo: true,
  packetInfoBatches: true,
  auditMuxedTrack: true,
  streamCopy: true,
  decrypt: true,
  validatesStreamCopyTrim: true,
  gaplessSeam: true,
};

export const Mp4LazyModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(registry: Registry): void {
    registry.addContainer(lazyContainer(MP4_LAZY_CONTAINER_SPEC));
  },
};

export default Mp4LazyModule;
