import type { MuxOptions, Muxer, Packet, TrackInfo } from '../../contracts/driver.ts';
import { MediaError } from '../../contracts/errors.ts';
import { bytesPerSample, decodePcm } from '../../dsp/pcm.ts';
import {
  type WavMuxTrackConfig,
  assertAudioMuxOptions,
  wavMuxTrackConfig,
} from '../audio-container-mux-validation.ts';
import { writeWav, writeWavHeader } from './pcm.ts';

interface WavMuxTrack {
  readonly id: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly wire: WavMuxTrackConfig['wire'];
  readonly chunks: Uint8Array[];
  audioBytes: number;
}

export interface WavChunkStruct {
  readonly data: Uint8Array;
}

function copyChunkBytes(packet: Packet): Uint8Array {
  const data = new Uint8Array(packet.chunk.byteLength);
  packet.chunk.copyTo(data);
  return data;
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function writeRawPcmWav(track: WavMuxTrack): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + track.audioBytes);
  writeWavHeader(out, track.audioBytes, track.channels, track.sampleRate, track.wire.outputFormat);
  let offset = 44;
  for (const chunk of track.chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Single-track raw-PCM `Muxer` that authors a legal RIFF/WAVE file on finalize. */
export class WavMuxer implements Muxer {
  readonly output: ReadableStream<Uint8Array>;

  #track: WavMuxTrack | undefined;
  #finalized = false;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #ready: Promise<void>;
  #resolveReady: (() => void) | undefined;

  constructor(options?: MuxOptions) {
    assertAudioMuxOptions('wav', options);
    this.#ready = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    this.output = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.#controller = controller;
        this.#resolveReady?.();
      },
    });
  }

  addTrack(info: TrackInfo): number {
    this.#assertOpen();
    const { wire, sampleRate, channels } = wavMuxTrackConfig(
      info,
      this.#track === undefined ? 0 : 1,
    );
    const id = 0;
    this.#track = { id, sampleRate, channels, wire, chunks: [], audioBytes: 0 };
    return id;
  }

  write(trackId: number, packet: Packet): Promise<void> {
    this.addChunkStruct(trackId, { data: copyChunkBytes(packet) });
    return Promise.resolve();
  }

  writePcm(trackId: number, data: Uint8Array): Promise<void> {
    this.addChunkStruct(trackId, { data });
    return Promise.resolve();
  }

  addChunkStruct(trackId: number, chunk: WavChunkStruct): void {
    this.#assertOpen();
    const track = this.#track;
    if (track === undefined || track.id !== trackId) {
      throw new MediaError('mux-error', `write to unknown track ${trackId}`);
    }
    const frameBytes = bytesPerSample(track.wire.sourceFormat) * track.channels;
    if (frameBytes <= 0 || chunk.data.byteLength % frameBytes !== 0) {
      throw new MediaError('mux-error', 'WAV mux packet does not contain whole PCM sample frames');
    }
    track.chunks.push(chunk.data.slice());
    track.audioBytes += chunk.data.byteLength;
  }

  async finalize(): Promise<void> {
    this.#assertOpen();
    this.#finalized = true;
    await this.#ready;
    const controller = this.#controller as ReadableStreamDefaultController<Uint8Array>;
    try {
      const track = this.#track;
      if (track === undefined) {
        throw new MediaError('mux-error', 'cannot finalize a WAV muxer with no tracks');
      }
      if (track.audioBytes === 0) {
        throw new MediaError('mux-error', `track ${track.id} received no PCM packets`);
      }
      if (track.wire.sourceEndian === 'le' && track.wire.sourceFormat === track.wire.outputFormat) {
        controller.enqueue(writeRawPcmWav(track));
        controller.close();
        return;
      }
      const pcmBytes = concatChunks(track.chunks, track.audioBytes);
      const audio = decodePcm(
        pcmBytes,
        track.wire.sourceFormat,
        track.channels,
        track.sampleRate,
        track.wire.sourceEndian,
      );
      controller.enqueue(writeWav(audio, track.wire.outputFormat, 'le'));
      controller.close();
    } catch (err) {
      controller.error(err);
      throw err;
    }
  }

  #assertOpen(): void {
    if (this.#finalized) throw new MediaError('mux-error', 'muxer already finalized');
  }
}
