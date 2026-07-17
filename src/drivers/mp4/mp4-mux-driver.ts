/** Mux-only MP4/MOV driver used by query-selective output registration (ADR-290). */

import type {
  ByteSource,
  ContainerDriver,
  ContainerQuery,
  Demuxer,
  DriverModule,
  MuxOptions,
  Muxer,
  Registry,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError } from '../../contracts/errors.ts';
import { Mp4Muxer } from './mux.ts';

function supportsMux(query: ContainerQuery): boolean {
  if (query.direction !== 'mux') return false;
  const extension = query.extension?.toLowerCase();
  if (extension === 'mp4' || extension === 'mov') return true;
  const mime = query.mime?.split(';', 1)[0]?.trim().toLowerCase();
  return (
    mime === 'video/mp4' ||
    mime === 'audio/mp4' ||
    mime === 'application/mp4' ||
    mime === 'video/quicktime'
  );
}

/** Exact existing MP4 muxer without importing the source parser/probe implementation. */
export const Mp4MuxOnlyDriver: ContainerDriver = {
  id: 'mp4-mux',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['mp4', 'mov'],
  supports: supportsMux,
  demux(_src: ByteSource): Promise<Demuxer> {
    return Promise.reject(
      new CapabilityError('mp4-mux is output-only', {
        op: { kind: 'route', id: 'demux' },
        tried: ['mp4-mux'],
      }),
    );
  },
  createMuxer(options?: MuxOptions): Muxer {
    return new Mp4Muxer(options);
  },
};

const Mp4MuxOnlyModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(registry: Registry): void {
    registry.addContainer(Mp4MuxOnlyDriver);
  },
};

export default Mp4MuxOnlyModule;
