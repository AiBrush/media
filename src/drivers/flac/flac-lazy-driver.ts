/**
 * The lazy FLAC container proxy the defaults bundle registers (ADR-004 miss-only loading). Probe,
 * packet-info, and packet demux run natively on the cheap `flac-sniff` fast paths without pulling the
 * full driver chunk; mux/stream-copy/PCM methods load `flac-driver.ts` on first use. The FLAC
 * single-audio-stream constraint is a `validateTrack` rule on the shared {@link LazyMuxer}.
 */

import type {
  ByteSource,
  ContainerDriver,
  ContainerQuery,
  Demuxer,
  MuxOptions,
  Muxer,
  Packet,
  PacketInfoTable,
  PcmTransform,
  StageOptions,
  StreamCopyOptions,
  TrackInfo,
} from '../../contracts/driver.ts';
import { DRIVER_API_VERSION } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import type { PcmAudio } from '../../dsp/index.ts';
import { readByteStream } from '../../util/byte-stream.ts';
import { type LazyContainerLoader, LazyMuxer, missingLazyMethod } from '../lazy-muxer.ts';
import { validateFlacMuxTrack } from './flac-match.ts';
import {
  type FastFlacFrameSpan,
  fastFlacFrames,
  flacMetadataLayout,
  flacPacketInfoTable,
  flacTrackInfo,
  matchesFlac,
  parseFlacStreamInfo,
  readSeekableFlacStreamInfo,
} from './flac-sniff.ts';

/** Build the lazy FLAC container driver registered by the defaults bundle. */
export function lazyFlacContainerDriver(): ContainerDriver {
  let driver: ContainerDriver | undefined;
  let loadPromise: Promise<ContainerDriver> | undefined;
  const load: LazyContainerLoader = async (): Promise<ContainerDriver> => {
    if (driver !== undefined) return driver;
    loadPromise ??= import('./flac-driver.ts').then((m) => m.FlacDriver);
    driver = await loadPromise;
    return driver;
  };
  return {
    id: 'flac',
    apiVersion: DRIVER_API_VERSION,
    kind: 'container',
    formats: ['flac'],
    streamCopyTargets: ['ogg'],
    supports(q: ContainerQuery): boolean {
      return matchesFlac(q);
    },
    async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
      if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      const info =
        (await readSeekableFlacStreamInfo(src, o?.signal)) ??
        parseFlacStreamInfo(await readByteStream(src.stream()));
      if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      return [flacTrackInfo(info)];
    },
    async packetInfo(src: ByteSource, o?: StageOptions): Promise<PacketInfoTable> {
      const bytes = await readFlacBytes(src);
      if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      const table = flacPacketInfoTable(bytes);
      if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
      return table;
    },
    async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
      const bytes = await readFlacBytes(src);
      const layout = flacMetadataLayout(bytes);
      const frames = fastFlacFrames(bytes, layout);
      const track = flacTrackInfo(layout.info, bytes.slice(layout.start, layout.audioStart));
      return {
        tracks: [track],
        packets(trackId: number): ReadableStream<Packet> {
          if (trackId !== 0) throw new MediaError('demux-error', `no track ${trackId}`);
          return flacPacketStream(bytes, frames, o?.signal);
        },
        close: () => Promise.resolve(),
      };
    },
    createMuxer(o?: MuxOptions): Muxer {
      return new LazyMuxer({
        driverId: 'flac',
        load,
        muxOptions: o,
        validateTrack: validateFlacMuxTrack,
      });
    },
    async streamCopy(src: ByteSource, o?: StreamCopyOptions): Promise<ReadableStream<Uint8Array>> {
      const streamCopy = (await load()).streamCopy;
      if (streamCopy === undefined) throw missingLazyMethod('flac', 'streamCopy');
      return streamCopy(src, o);
    },
    async decodePcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
      const decodePcm = (await load()).decodePcm;
      if (decodePcm === undefined) throw missingLazyMethod('flac', 'decodePcm');
      return decodePcm(src, o);
    },
    async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
      const decodePcmAudio = (await load()).decodePcmAudio;
      if (decodePcmAudio === undefined) throw missingLazyMethod('flac', 'decodePcmAudio');
      return decodePcmAudio(src, o);
    },
    async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
      const transformPcm = (await load()).transformPcm;
      if (transformPcm === undefined) throw missingLazyMethod('flac', 'transformPcm');
      return transformPcm(src, o);
    },
  };
}

async function readFlacBytes(src: ByteSource): Promise<Uint8Array> {
  if (src.range !== undefined && src.size !== undefined) return src.range(0, src.size);
  return readByteStream(src.stream());
}

function flacPacketStream(
  bytes: Uint8Array,
  frames: readonly FastFlacFrameSpan[],
  signal: AbortSignal | undefined,
): ReadableStream<Packet> {
  if (typeof EncodedAudioChunk === 'undefined') {
    throw new CapabilityError(
      'FLAC packet demux requires the browser codec layer (WebCodecs EncodedAudioChunk)',
      { op: { kind: 'route', id: 'demux' }, tried: ['flac'] },
    );
  }
  let i = 0;
  return new ReadableStream<Packet>({
    pull(controller): void {
      if (signal?.aborted) {
        controller.error(new MediaError('aborted', 'operation aborted'));
        return;
      }
      const frame = frames[i];
      if (frame === undefined) {
        controller.close();
        return;
      }
      i++;
      const data = bytes.slice(frame.offset, frame.offset + frame.size);
      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: frame.ptsUs,
        duration: frame.durationUs,
        data,
      });
      controller.enqueue({ chunk, data, sizeBytes: frame.size });
    },
  });
}
