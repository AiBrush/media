/**
 * The no-op / identity reference driver module — three drivers (codec, container, filter) that wire up
 * the seams without doing real media work. They exist to (a) prove the conformance harness runs and
 * (b) let kernel/registry/router tests exercise the full registration + selection path without real
 * WebCodecs/WASM. They are explicitly identity passthroughs — never presented as doing real work.
 */

import {
  type CodecDriver,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type EncodedChunk,
  type FilterDriver,
  type Muxer,
  type RawFrame,
  type Registry,
} from '../contracts/driver.ts';

function emptyByteStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c): void {
      c.close();
    },
  });
}

function emptyChunkStream(): ReadableStream<EncodedChunk> {
  return new ReadableStream<EncodedChunk>({
    start(c): void {
      c.close();
    },
  });
}

/** Identity codec driver: passthrough decoder/encoder; supports only the synthetic `noop` codec. */
export const NOOP_CODEC: CodecDriver = {
  id: 'noop-codec',
  apiVersion: DRIVER_API_VERSION,
  kind: 'codec',
  tier: 'wasm',
  supports: (q) => Promise.resolve({ supported: q.config.codec === 'noop' }),
  createDecoder: () => new TransformStream<EncodedChunk, RawFrame>(),
  createEncoder: () => new TransformStream<RawFrame, EncodedChunk>(),
};

/** Identity container driver: empty demux, passthrough muxer; supports the synthetic `noop` format. */
export const NOOP_CONTAINER: ContainerDriver = {
  id: 'noop-container',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['noop'],
  supports: (q) => q.mime === 'application/x-noop' || q.extension === 'noop',
  demux: (): Promise<Demuxer> =>
    Promise.resolve({
      tracks: [],
      packets: () => emptyChunkStream(),
      close: () => Promise.resolve(),
    }),
  createMuxer: (): Muxer => {
    let nextTrack = 0;
    return {
      output: emptyByteStream(),
      addTrack: () => nextTrack++,
      write: () => Promise.resolve(),
      finalize: () => Promise.resolve(),
    };
  },
};

/** Identity filter driver: passthrough resize. */
export const NOOP_FILTER: FilterDriver = {
  id: 'noop-filter',
  apiVersion: DRIVER_API_VERSION,
  kind: 'filter',
  substrate: 'wasm',
  supports: (f) => f.type === 'resize',
  createFilter: () => new TransformStream<VideoFrame, VideoFrame>(),
};

/** A {@link DriverModule} that registers all three identity drivers. */
export const NoopDriverModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addCodec(NOOP_CODEC);
    reg.addContainer(NOOP_CONTAINER);
    reg.addFilter(NOOP_FILTER);
  },
};

export default NoopDriverModule;
