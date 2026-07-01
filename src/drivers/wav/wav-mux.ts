import type { MuxOptions, Muxer, Packet, TrackInfo } from '../../contracts/driver.ts';
import { CapabilityError, MediaError } from '../../contracts/errors.ts';
import { type Endianness, type SampleFormat, bytesPerSample, decodePcm } from '../../dsp/pcm.ts';
import { writeWav, writeWavHeader } from './pcm.ts';

interface PcmWireFormat {
  readonly sourceFormat: SampleFormat;
  readonly sourceEndian: Endianness;
  readonly outputFormat: SampleFormat;
}

interface WavMuxTrack {
  readonly id: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly wire: PcmWireFormat;
  readonly chunks: Uint8Array[];
  audioBytes: number;
}

export interface WavChunkStruct {
  readonly data: Uint8Array;
}

function pcmWireFormat(codec: string): PcmWireFormat | undefined {
  switch (codec) {
    case 'pcm-u8':
    case 'pcm-u8be':
      return { sourceFormat: 'u8', sourceEndian: 'le', outputFormat: 'u8' };
    case 'pcm-s8':
      return { sourceFormat: 's8', sourceEndian: 'le', outputFormat: 'u8' };
    case 'pcm-s16':
      return { sourceFormat: 's16', sourceEndian: 'le', outputFormat: 's16' };
    case 'pcm-s16be':
      return { sourceFormat: 's16', sourceEndian: 'be', outputFormat: 's16' };
    case 'pcm-s24':
      return { sourceFormat: 's24', sourceEndian: 'le', outputFormat: 's24' };
    case 'pcm-s24be':
      return { sourceFormat: 's24', sourceEndian: 'be', outputFormat: 's24' };
    case 'pcm-s32':
      return { sourceFormat: 's32', sourceEndian: 'le', outputFormat: 's32' };
    case 'pcm-s32be':
      return { sourceFormat: 's32', sourceEndian: 'be', outputFormat: 's32' };
    case 'pcm-f32':
      return { sourceFormat: 'f32', sourceEndian: 'le', outputFormat: 'f32' };
    case 'pcm-f32be':
      return { sourceFormat: 'f32', sourceEndian: 'be', outputFormat: 'f32' };
    case 'pcm-f64':
      return { sourceFormat: 'f64', sourceEndian: 'le', outputFormat: 'f64' };
    case 'pcm-f64be':
      return { sourceFormat: 'f64', sourceEndian: 'be', outputFormat: 'f64' };
    default:
      return undefined;
  }
}

function audioConfig(info: TrackInfo): AudioDecoderConfig | undefined {
  const config = info.config;
  if (
    config !== undefined &&
    'sampleRate' in config &&
    'numberOfChannels' in config &&
    typeof config.sampleRate === 'number' &&
    typeof config.numberOfChannels === 'number'
  ) {
    return config;
  }
  return undefined;
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
    if (options?.fragmented === true) {
      throw new CapabilityError('capability-miss', 'WAV has no fragmented mux form', {
        op: { op: 'mux', fragmented: true },
        tried: ['wav'],
      });
    }
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
    if (this.#track !== undefined) {
      throw new CapabilityError('capability-miss', 'the WAV muxer writes one audio stream', {
        op: { op: 'mux' },
        tried: ['wav'],
      });
    }
    if (info.mediaType !== 'audio') {
      throw new CapabilityError('capability-miss', 'WAV muxing accepts audio tracks only', {
        op: { op: 'mux', mediaType: info.mediaType },
        tried: ['wav'],
      });
    }
    const wire = pcmWireFormat(info.codec);
    if (wire === undefined) {
      throw new CapabilityError(
        'capability-miss',
        `WAV muxing accepts raw PCM packets, not '${info.codec}'`,
        { op: { op: 'mux', codec: info.codec }, tried: ['wav'] },
      );
    }
    const config = audioConfig(info);
    if (config === undefined) {
      throw new MediaError(
        'mux-error',
        'WAV muxing requires sampleRate and numberOfChannels metadata',
      );
    }
    const sampleRate = config.sampleRate;
    const channels = config.numberOfChannels;
    if (
      !Number.isFinite(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isInteger(channels) ||
      channels <= 0
    ) {
      throw new MediaError('mux-error', 'WAV muxing received invalid PCM track metadata');
    }
    const id = 0;
    this.#track = { id, sampleRate, channels, wire, chunks: [], audioBytes: 0 };
    return id;
  }

  write(trackId: number, packet: Packet): Promise<void> {
    this.addChunkStruct(trackId, { data: copyChunkBytes(packet) });
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
      if (
        track.wire.sourceEndian === 'le' &&
        track.wire.sourceFormat === track.wire.outputFormat
      ) {
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
