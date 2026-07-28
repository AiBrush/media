/**
 * Lightweight WAV container proxy/module.
 *
 * Probe stays on the header-only module; every other flow resolves the canonical full WavDriver on
 * first use. Both register-all defaults and query-selective registration consume this same spec.
 */

import type { DriverModule, Registry } from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { wavMuxTrackConfig } from '../audio-container-mux-validation.ts';
import { matchesWav } from '../audio-container-sniff.ts';
import { type LazyContainerSpec, lazyContainer } from '../lazy-container.ts';
import { probeWav } from './wav-probe.ts';

export const WAV_LAZY_CONTAINER_SPEC: LazyContainerSpec = {
  id: 'wav',
  formats: ['wav'],
  supports: matchesWav,
  load: () => import('./wav-driver.ts').then((module) => module.WavDriver),
  probe: true,
  probeImpl: probeWav,
  packetInfo: true,
  transformPcm: true,
  decodePcmAudio: true,
  decodePcmAudioStream: true,
  decodePcmInterleavedStream: true,
  validatesPcmTrim: true,
  muxKind: 'wav',
  validateTrack: (track, trackCount) => {
    wavMuxTrackConfig(track, trackCount);
  },
};

export const WavLazyModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(lazyContainer(WAV_LAZY_CONTAINER_SPEC));
  },
};

export default WavLazyModule;
