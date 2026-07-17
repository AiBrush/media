/** Synchronous mux-contract validation shared by lazy proxies and real audio-container muxers. */

import type { MuxOptions, TrackInfo } from '../contracts/driver.ts';
import { CapabilityError, MediaError } from '../contracts/errors.ts';
import type { Endianness, SampleFormat } from '../dsp/pcm.ts';

export type LazyAudioMuxKind = 'wav' | 'mp3' | 'ogg' | 'adts';

export interface WavMuxTrackConfig {
  readonly sampleRate: number;
  readonly channels: number;
  readonly wire: {
    readonly sourceFormat: SampleFormat;
    readonly sourceEndian: Endianness;
    readonly outputFormat: SampleFormat;
  };
}

/** Preserve each real muxer's synchronous fragmented-form rejection before its implementation loads. */
export function assertAudioMuxOptions(
  kind: LazyAudioMuxKind,
  options: MuxOptions | undefined,
): void {
  if (options?.fragmented !== true) return;
  const message =
    kind === 'wav'
      ? 'WAV has no fragmented mux form'
      : kind === 'ogg'
        ? 'fragmented ogg unsupported'
        : `${kind.toUpperCase()} has no fragmented/segmented mux form`;
  throw new CapabilityError(message, {
    op: { kind: 'route', id: 'mux', facts: { fragmented: true } },
    tried: [kind],
  });
}

export function wavMuxTrackConfig(info: TrackInfo, trackCount: number): WavMuxTrackConfig {
  if (trackCount > 0) {
    throw new CapabilityError('the WAV muxer writes one audio stream', {
      op: { kind: 'route', id: 'mux' },
      tried: ['wav'],
    });
  }
  if (info.mediaType !== 'audio') {
    throw new CapabilityError('WAV muxing accepts audio tracks only', {
      op: { kind: 'route', id: 'mux', facts: { mediaType: info.mediaType } },
      tried: ['wav'],
    });
  }
  const wire = pcmWireFormat(info.codec);
  if (wire === undefined) {
    throw new CapabilityError(`WAV muxing accepts raw PCM packets, not '${info.codec}'`, {
      op: { kind: 'route', id: 'mux', facts: { codec: info.codec } },
      tried: ['wav'],
    });
  }
  const config = info.config;
  if (
    config === undefined ||
    !('sampleRate' in config) ||
    !('numberOfChannels' in config) ||
    typeof config.sampleRate !== 'number' ||
    typeof config.numberOfChannels !== 'number'
  ) {
    throw new MediaError(
      'mux-error',
      'WAV muxing requires sampleRate and numberOfChannels metadata',
    );
  }
  if (
    !Number.isFinite(config.sampleRate) ||
    config.sampleRate <= 0 ||
    !Number.isInteger(config.numberOfChannels) ||
    config.numberOfChannels <= 0
  ) {
    throw new MediaError('mux-error', 'WAV muxing received invalid PCM track metadata');
  }
  return { sampleRate: config.sampleRate, channels: config.numberOfChannels, wire };
}

export function validateMp3MuxTrack(info: TrackInfo, trackCount: number): void {
  if (trackCount > 0) {
    throw new CapabilityError('the MP3 muxer writes a single audio stream', {
      op: { kind: 'route', id: 'mux' },
      tried: ['mp3'],
    });
  }
  if (info.mediaType !== 'audio' || info.codec !== 'mp3') {
    throw new CapabilityError(
      `MP3 container carries a single MP3 audio track, not ${info.mediaType}/${info.codec}`,
      { op: { kind: 'route', id: 'mux' }, tried: ['mp3'] },
    );
  }
}

export function oggMuxCodec(info: TrackInfo): 'opus' | 'vorbis' | 'flac' {
  if (info.mediaType !== 'audio') {
    throw new CapabilityError('the ogg muxer writes audio only', {
      op: { kind: 'route', id: 'mux', facts: { mediaType: info.mediaType } },
      tried: ['ogg'],
    });
  }
  const codec = info.codec.toLowerCase();
  if (codec.startsWith('opus')) return 'opus';
  if (codec.startsWith('vorbis')) return 'vorbis';
  if (codec.startsWith('flac')) return 'flac';
  throw new CapabilityError(
    `the ogg muxer cannot write audio codec '${info.codec}' (Opus/Vorbis/FLAC only)`,
    { op: { kind: 'route', id: 'mux', facts: { codec: info.codec } }, tried: ['ogg'] },
  );
}

export function validateOggMuxTrack(info: TrackInfo, trackCount: number): void {
  if (trackCount > 0) {
    throw new CapabilityError('ogg muxer writes one stream', {
      op: { kind: 'route', id: 'mux' },
      tried: ['ogg'],
    });
  }
  oggMuxCodec(info);
}

export interface AdtsMuxTrackConfig {
  readonly aot: number;
  readonly freqIndex: number;
  readonly channelConfig: number;
}

export function adtsMuxTrackConfig(info: TrackInfo, trackCount: number): AdtsMuxTrackConfig {
  if (trackCount > 0) {
    throw new CapabilityError('the ADTS muxer writes a single audio stream', {
      op: { kind: 'route', id: 'mux' },
      tried: ['adts'],
    });
  }
  if (info.mediaType !== 'audio' || !info.codec.toLowerCase().startsWith('mp4a.40.')) {
    throw new CapabilityError(
      `ADTS container carries a single AAC audio track, not ${info.mediaType}/${info.codec}`,
      { op: { kind: 'route', id: 'mux' }, tried: ['adts'] },
    );
  }
  const description = info.config?.description;
  if (description === undefined) {
    throw new MediaError('mux-error', 'ADTS mux needs the AAC track description (the 2-byte ASC)');
  }
  const asc = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  if (asc.byteLength < 2) {
    throw new MediaError('mux-error', 'ADTS mux: AAC track description (ASC) must be ≥ 2 bytes');
  }
  const b0 = asc[0] ?? 0;
  const b1 = asc[1] ?? 0;
  const aot = (b0 >> 3) & 0x1f;
  const freqIndex = ((b0 & 0x7) << 1) | (b1 >> 7);
  const channelConfig = (b1 >> 3) & 0xf;
  if (aot < 1 || aot > 31 || freqIndex > 12 || channelConfig < 1 || channelConfig > 7) {
    throw new MediaError(
      'mux-error',
      `ADTS mux: unsupported ASC (aot=${aot} freqIndex=${freqIndex} channels=${channelConfig})`,
    );
  }
  return { aot, freqIndex, channelConfig };
}

/** AIFF/CAF raw PCM is authored by `transformPcm`, never the encoded-chunk mux seam. */
export function rejectRawPcmChunkMux(kind: 'aiff' | 'caf'): never {
  throw new MediaError(
    'mux-error',
    `${kind} output flows through transformPcm (PCM), not the chunk seam`,
  );
}

function pcmWireFormat(codec: string): WavMuxTrackConfig['wire'] | undefined {
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
