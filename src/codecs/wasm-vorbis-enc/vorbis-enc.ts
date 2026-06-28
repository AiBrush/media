/**
 * Pure Vorbis-encode helpers and the typed contract implemented by `vorbis-enc-core.js`.
 */

import { MediaError } from '../../contracts/errors.ts';
import { VORBIS_CODEC, VORBIS_MAX_CHANNELS, buildVorbisExtradata } from '../wasm-vorbis/vorbis.ts';

export { VORBIS_CODEC, buildVorbisExtradata };

const DEFAULT_QUALITY = 0.4;
const MIN_QUALITY = -0.1;
const MAX_QUALITY = 1;

export interface VorbisEncoderInit {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitrate: number | 'auto';
  readonly quality: number;
}

export interface VorbisEncodedPacket {
  readonly data: Uint8Array;
  readonly granulepos: number;
  readonly eos: boolean;
}

export interface VorbisWasmEncoder {
  headers(): readonly [Uint8Array, Uint8Array, Uint8Array];
  encode(interleaved: Float32Array, frames: number): readonly VorbisEncodedPacket[];
  finish(): readonly VorbisEncodedPacket[];
  free(): void;
}

export interface VorbisEncWasmCore {
  createEncoder(init: VorbisEncoderInit): Promise<VorbisWasmEncoder>;
}

export interface VorbisEncRuntime {
  readonly HEAPU8: Uint8Array;
  readonly HEAPF32: Float32Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _ab_vorbis_create(sampleRate: number, channels: number, bitrate: number, quality: number): number;
  _ab_vorbis_headers(handle: number): number;
  _ab_vorbis_feed(handle: number, interleavedPtr: number, frames: number): number;
  _ab_vorbis_finish(handle: number): number;
  _ab_vorbis_packet_count(handle: number): number;
  _ab_vorbis_packet_data(handle: number, index: number): number;
  _ab_vorbis_packet_bytes(handle: number, index: number): number;
  _ab_vorbis_packet_granulepos(handle: number, index: number): number;
  _ab_vorbis_packet_eos(handle: number, index: number): number;
  _ab_vorbis_clear_packets(handle: number): void;
  _ab_vorbis_destroy(handle: number): void;
}

interface VorbisEncoderTuning {
  readonly quality?: number;
}

type VorbisAudioEncoderConfig = AudioEncoderConfig & {
  readonly vorbis?: VorbisEncoderTuning;
};

export function normalizeVorbisEncoderConfig(config: AudioEncoderConfig): VorbisEncoderInit {
  if (config.codec !== VORBIS_CODEC) {
    throw new MediaError(
      'encode-error',
      `vorbis: wasm-vorbis-enc cannot encode codec '${config.codec}'`,
    );
  }
  const sampleRate = config.sampleRate;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new MediaError('encode-error', `vorbis: invalid sample rate ${sampleRate}`);
  }
  const channels = config.numberOfChannels;
  if (!Number.isInteger(channels) || channels < 1 || channels > VORBIS_MAX_CHANNELS) {
    throw new MediaError(
      'encode-error',
      `vorbis: wasm-vorbis-enc supports 1-${VORBIS_MAX_CHANNELS} channels, got ${channels}`,
    );
  }
  const bitrate =
    config.bitrate !== undefined && Number.isFinite(config.bitrate) && config.bitrate > 0
      ? Math.round(config.bitrate)
      : 'auto';
  const candidateQuality = (config as VorbisAudioEncoderConfig).vorbis?.quality;
  const quality =
    candidateQuality !== undefined &&
    Number.isFinite(candidateQuality) &&
    candidateQuality >= MIN_QUALITY &&
    candidateQuality <= MAX_QUALITY
      ? candidateQuality
      : DEFAULT_QUALITY;
  return { sampleRate, channels, bitrate, quality };
}

export function interleaveF32(planes: readonly Float32Array[], frames: number): Float32Array {
  if (!Number.isInteger(frames) || frames < 0) {
    throw new MediaError('encode-error', `vorbis: invalid frame count ${frames}`);
  }
  const channels = planes.length;
  if (channels < 1 || channels > VORBIS_MAX_CHANNELS) {
    throw new MediaError(
      'encode-error',
      `vorbis: invalid channel count ${channels} for interleave`,
    );
  }
  const out = new Float32Array(frames * channels);
  for (let c = 0; c < channels; c++) {
    const plane = planes[c];
    if (plane === undefined || plane.length !== frames) {
      throw new MediaError('encode-error', `vorbis: plane ${c} is not ${frames} frames`);
    }
    for (let i = 0; i < frames; i++) out[i * channels + c] = plane[i] ?? 0;
  }
  return out;
}

export function samplesToMicros(samples: number, sampleRate: number): number {
  return Math.round((samples / sampleRate) * 1_000_000);
}

export function errMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return 'unknown error';
}
