/**
 * Shared lazy container proxy construction.
 *
 * Kept separate from the register-all defaults bundle so query-selective registration can install
 * one family proxy without evaluating unrelated codec, image, filter, or container wiring.
 */

import type {
  ByteSource,
  ContainerDriver,
  ContainerQuery,
  DecryptParams,
  Demuxer,
  MuxOptions,
  Muxer,
  PacketInfoBatchOptions,
  PacketInfoBatchStream,
  PacketInfoTable,
  PcmTransform,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../contracts/driver.ts';
import type { InterleavedPcmF32, PcmAudio } from '../dsp/index.ts';
import {
  type LazyAudioMuxKind,
  assertAudioMuxOptions,
  rejectRawPcmChunkMux,
} from './audio-container-mux-validation.ts';
import { type LazyContainerLoader, LazyMuxer, missingLazyMethod } from './lazy-muxer.ts';

/**
 * A lazy container proxy description. The boolean flags mirror the loaded module's optional method
 * surface **exactly** — `lazy-container-conformance.test.ts` loads every spec and fails on any drift
 * in either direction, so an advertised method can never miss at call time and a real method can
 * never be silently hidden from the router.
 */
export interface LazyContainerSpec {
  readonly id: string;
  readonly formats: readonly string[];
  readonly streamCopyTargets?: readonly string[];
  readonly supports: (q: ContainerQuery) => boolean;
  readonly load: LazyContainerLoader;
  readonly probe?: true;
  /**
   * An optional lightweight implementation for the advertised probe seam. Other operations still
   * resolve through `load()`, preserving one canonical full-driver capability surface.
   */
  readonly probeImpl?: NonNullable<ContainerDriver['probe']>;
  readonly packetInfo?: true;
  readonly packetInfoBatches?: true;
  readonly streamCopy?: true;
  readonly decrypt?: true;
  readonly transformPcm?: true;
  readonly decodePcm?: true;
  readonly decodePcmAudio?: true;
  readonly decodePcmAudioStream?: true;
  readonly decodePcmInterleavedStream?: true;
  readonly validatesStreamCopyTrim?: true;
  readonly validatesPcmTrim?: true;
  readonly muxKind?: LazyAudioMuxKind;
  readonly rejectChunkMux?: 'aiff' | 'caf';
  readonly validateTrack?: (track: TrackInfo, trackCount: number) => void;
}

/** Build the lazy proxy for one container spec: cheap pre-load gates, load-on-first-flow methods. */
export function lazyContainer(spec: LazyContainerSpec): ContainerDriver {
  let driver: ContainerDriver | undefined;
  let loadPromise: Promise<ContainerDriver> | undefined;
  const load = async (): Promise<ContainerDriver> => {
    if (driver !== undefined) return driver;
    loadPromise ??= spec.load();
    driver = await loadPromise;
    return driver;
  };
  return {
    id: spec.id,
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: spec.formats,
    ...(spec.streamCopyTargets === undefined ? {} : { streamCopyTargets: spec.streamCopyTargets }),
    supports: spec.supports,
    ...(spec.probe === true
      ? {
          async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
            if (spec.probeImpl !== undefined) return spec.probeImpl(src, o);
            const loaded = await load();
            const probe = loaded.probe;
            if (probe === undefined) throw missingLazyMethod(spec.id, 'probe');
            return probe.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.packetInfo === true
      ? {
          async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
            const loaded = await load();
            const packetInfo = loaded.packetInfo;
            if (packetInfo === undefined) throw missingLazyMethod(spec.id, 'packetInfo');
            return packetInfo.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.packetInfoBatches === true
      ? {
          async packetInfoBatches(
            src: ByteSource,
            o?: PacketInfoBatchOptions,
          ): Promise<PacketInfoBatchStream> {
            const loaded = await load();
            const packetInfoBatches = loaded.packetInfoBatches;
            if (packetInfoBatches === undefined) {
              throw missingLazyMethod(spec.id, 'packetInfoBatches');
            }
            return packetInfoBatches.call(loaded, src, o);
          },
        }
      : {}),
    async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
      const loaded = await load();
      return loaded.demux(src, o);
    },
    createMuxer(o?: MuxOptions): Muxer {
      if (spec.rejectChunkMux !== undefined) return rejectRawPcmChunkMux(spec.rejectChunkMux);
      if (spec.muxKind !== undefined) assertAudioMuxOptions(spec.muxKind, o);
      return new LazyMuxer({
        driverId: spec.id,
        load,
        muxOptions: o,
        validateTrack: spec.validateTrack,
        pcmSeam: true,
      });
    },
    ...(spec.streamCopy === true
      ? {
          async streamCopy(
            src: ByteSource,
            o?: StreamCopyOptions,
          ): Promise<ReadableStream<Uint8Array>> {
            const loaded = await load();
            const streamCopy = loaded.streamCopy;
            if (streamCopy === undefined) throw missingLazyMethod(spec.id, 'streamCopy');
            return streamCopy.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.decrypt === true
      ? {
          async decrypt(src: ByteSource, o: DecryptParams): Promise<ReadableStream<Uint8Array>> {
            const loaded = await load();
            const decrypt = loaded.decrypt;
            if (decrypt === undefined) throw missingLazyMethod(spec.id, 'decrypt');
            return decrypt.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.transformPcm === true
      ? {
          async transformPcm(
            src: ByteSource,
            o?: PcmTransform,
          ): Promise<ReadableStream<Uint8Array>> {
            const loaded = await load();
            const transformPcm = loaded.transformPcm;
            if (transformPcm === undefined) throw missingLazyMethod(spec.id, 'transformPcm');
            return transformPcm.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.decodePcm === true
      ? {
          async decodePcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
            const loaded = await load();
            const decodePcm = loaded.decodePcm;
            if (decodePcm === undefined) throw missingLazyMethod(spec.id, 'decodePcm');
            return decodePcm.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.decodePcmAudio === true
      ? {
          async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
            const loaded = await load();
            const decodePcmAudio = loaded.decodePcmAudio;
            if (decodePcmAudio === undefined) throw missingLazyMethod(spec.id, 'decodePcmAudio');
            return decodePcmAudio.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.decodePcmAudioStream === true
      ? {
          async decodePcmAudioStream(
            src: ByteSource,
            o?: StageOptions,
          ): Promise<ReadableStream<PcmAudio>> {
            const loaded = await load();
            const decodePcmAudioStream = loaded.decodePcmAudioStream;
            if (decodePcmAudioStream === undefined) {
              throw missingLazyMethod(spec.id, 'decodePcmAudioStream');
            }
            return decodePcmAudioStream.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.decodePcmInterleavedStream === true
      ? {
          async decodePcmInterleavedStream(
            src: ByteSource,
            o?: StageOptions,
          ): Promise<ReadableStream<InterleavedPcmF32>> {
            const loaded = await load();
            const decodePcmInterleavedStream = loaded.decodePcmInterleavedStream;
            if (decodePcmInterleavedStream === undefined) {
              throw missingLazyMethod(spec.id, 'decodePcmInterleavedStream');
            }
            return decodePcmInterleavedStream.call(loaded, src, o);
          },
        }
      : {}),
    ...(spec.validatesStreamCopyTrim === true ? { validatesStreamCopyTrim: true } : {}),
    ...(spec.validatesPcmTrim === true ? { validatesPcmTrim: true } : {}),
  };
}
