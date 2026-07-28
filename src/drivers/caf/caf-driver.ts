/**
 * The CAF (Apple Core Audio Format) container driver — hand-written TS. CAF is **big-endian** chunked
 * (`caff` header + `desc`/`data`/… chunks with signed-64-bit sizes) carrying raw PCM whose endianness is
 * declared in the ASBD format flags (Apple writes `lpcm` little-endian by default). PCM is not a
 * WebCodecs codec — it flows to the TS audio-dsp path — so the packet seam raises a typed
 * {@link CapabilityError} and the codec token is `pcm-s8` / `pcm-s16` / `pcm-s16be` / `pcm-f32` etc.
 * (docs/architecture/09 audio-dsp).
 */

import {
  type ByteSource,
  type ContainerDriver,
  DRIVER_API_VERSION,
  type Demuxer,
  type DriverModule,
  type Muxer,
  type Packet,
  type PcmTransform,
  type Registry,
  type StageOptions,
  type TrackInfo,
} from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import type { PcmAudio } from '../../dsp/pcm.ts';
import { readAllBytes } from '../../sources/read-all.ts';
import { rejectRawPcmChunkMux } from '../audio-container-mux-validation.ts';
import { matchesCaf } from '../audio-container-sniff.ts';
import { resolvePcmSampleFormat, writePcmContainer } from '../pcm-output.ts';
import { applyPcmTransform } from '../pcm-transform.ts';
import { probeCaf } from './caf-probe.ts';
import { parseCaf, readCafPcm } from './caf.ts';

function cafTrackInfo(info: ReturnType<typeof parseCaf>): TrackInfo {
  return {
    id: 0,
    mediaType: 'audio',
    codec: info.codec,
    durationSec: info.durationSec,
    config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
  };
}

export const CafDriver: ContainerDriver = {
  id: 'caf',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['caf'],
  supports: matchesCaf,
  async probe(src: ByteSource, o?: StageOptions): Promise<readonly TrackInfo[]> {
    return [cafTrackInfo(await probeCaf(src, o?.signal))];
  },
  async demux(src: ByteSource, o?: StageOptions): Promise<Demuxer> {
    const info = parseCaf(await readAllBytes(src, o?.signal));
    const track = cafTrackInfo(info);
    return {
      tracks: [track],
      packets(): ReadableStream<Packet> {
        throw new CapabilityError(
          'CAF PCM flows through the TS audio-dsp path (browser seam), not WebCodecs',
          { op: { kind: 'route', id: 'demux' }, tried: ['caf'] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const caf = readCafPcm(await readAllBytes(src, o?.signal));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    const audio = applyPcmTransform(caf, o);
    const container = o?.container ?? 'caf';
    const out = writePcmContainer(
      audio,
      container,
      resolvePcmSampleFormat(container, caf.format, o?.sampleFormat),
      o?.endian ?? caf.endian,
    );
    return new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(out);
        c.close();
      },
    });
  },
  async decodePcmAudio(src: ByteSource, o?: StageOptions): Promise<PcmAudio> {
    const caf = readCafPcm(await readAllBytes(src, o?.signal));
    if (o?.signal?.aborted) throw new MediaError('aborted', 'operation aborted');
    return caf;
  },
  createMuxer(): Muxer {
    // CAF carries raw PCM, not WebCodecs EncodedChunks, so the seam Muxer doesn't map; PCM output is
    // produced by `transformPcm` (writeCaf) — the audio-dsp path (ADR-022), exactly like WAV.
    return rejectRawPcmChunkMux('caf');
  },
};

export const CafModule: DriverModule = {
  apiVersion: DRIVER_API_VERSION,
  register(reg: Registry): void {
    reg.addContainer(CafDriver);
  },
};

export default CafModule;
