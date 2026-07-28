/**
 * Raw-PCM codec-token projection shared only by the lazily loaded PCM and FLAC authoring plans.
 */

import type { Endianness, SampleFormat } from '../dsp/pcm.ts';

export function pcmSampleFormat(codec: string | undefined): SampleFormat | undefined {
  if (codec === undefined || codec === 'pcm') return undefined;
  const normalized = codec.endsWith('be') ? codec.slice(0, -2) : codec;
  switch (normalized) {
    case 'pcm-u8':
      return 'u8';
    case 'pcm-s8':
      return 's8';
    case 'pcm-s16':
      return 's16';
    case 'pcm-s24':
      return 's24';
    case 'pcm-s32':
      return 's32';
    case 'pcm-f32':
      return 'f32';
    case 'pcm-f64':
      return 'f64';
    default:
      return undefined;
  }
}

export function pcmEndian(codec: string | undefined): Endianness | undefined {
  if (codec === undefined || codec === 'pcm') return undefined;
  return codec.endsWith('be') ? 'be' : 'le';
}
