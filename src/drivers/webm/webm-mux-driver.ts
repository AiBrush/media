/** Mux-only WebM/Matroska driver used by query-selective output registration (ADR-290). */

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
import { WebmMuxer } from './ebml-write.ts';

function supportsMux(query: ContainerQuery): boolean {
  if (query.direction !== 'mux') return false;
  const extension = query.extension?.toLowerCase();
  if (extension === 'webm' || extension === 'mkv' || extension === 'mka') return true;
  const mime = query.mime?.split(';', 1)[0]?.trim().toLowerCase();
  return mime === 'video/webm' || mime === 'audio/webm' || mime === 'video/x-matroska';
}

/** Exact existing WebM muxer without importing the source parser/probe implementation. */
export const WebmMuxOnlyDriver: ContainerDriver = {
  id: 'webm-mux',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['webm', 'mkv'],
  supports: supportsMux,
  demux(_src: ByteSource): Promise<Demuxer> {
    return Promise.reject(
      new CapabilityError('webm-mux is output-only', {
        op: { kind: 'route', id: 'demux' },
        tried: ['webm-mux'],
      }),
    );
  },
  createMuxer(options?: MuxOptions): Muxer {
    return new WebmMuxer(options, options?.container === 'mkv' ? 'matroska' : 'webm');
  },
};

const WebmMuxOnlyModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(registry: Registry): void {
    registry.addContainer(WebmMuxOnlyDriver);
  },
};

export default WebmMuxOnlyModule;
