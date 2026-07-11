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
import { rejectRawPcmChunkMux } from '../audio-container-mux-validation.ts';
import { matchesCaf } from '../audio-container-sniff.ts';
import { resolvePcmSampleFormat, writePcmContainer } from '../pcm-output.ts';
import { applyPcmTransform } from '../pcm-transform.ts';
import { parseCaf, readCafPcm } from './caf.ts';

/**
 * Read the whole source. CAF's `data` chunk may declare size `-1` ("to EOF"), so both probe and PCM
 * transforms need the full byte length; the file is bounded and PCM carries no separate index.
 */
async function readAll(src: ByteSource): Promise<Uint8Array> {
  if (src.range && src.size !== undefined) return src.range(0, src.size);
  const reader = src.stream().getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of parts) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export const CafDriver: ContainerDriver = {
  id: 'caf',
  apiVersion: DRIVER_API_VERSION,
  kind: 'container',
  formats: ['caf'],
  supports: matchesCaf,
  async demux(src: ByteSource): Promise<Demuxer> {
    // A CAF `data` chunk may declare size -1 ("to EOF"); duration then needs the whole file. Reading it
    // all keeps probe correct for both forms (the file is bounded and PCM has no separate index).
    const info = parseCaf(await readAll(src));
    const track: TrackInfo = {
      id: 0,
      mediaType: 'audio',
      codec: info.codec,
      durationSec: info.durationSec,
      config: { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels },
    };
    return {
      tracks: [track],
      packets(): ReadableStream<Packet> {
        throw new CapabilityError(
          'capability-miss',
          'CAF PCM flows through the TS audio-dsp path (browser seam), not WebCodecs',
          { op: 'demux', tried: ['caf'] },
        );
      },
      close: () => Promise.resolve(),
    };
  },
  async transformPcm(src: ByteSource, o?: PcmTransform): Promise<ReadableStream<Uint8Array>> {
    const caf = readCafPcm(await readAll(src));
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
    const caf = readCafPcm(await readAll(src));
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
