/**
 * Container-neutral VP8/VP9 RFC-6381 codec-string parsing shared by muxers and codec implementations.
 * This module has no codec-runtime dependency.
 */

import { MediaError } from '../contracts/errors.ts';

export type VpxCodec = 'vp8' | 'vp9';

/** Maximum VP9 profile (0–3). */
export const VP9_MAX_PROFILE = 3 as const;

/** Facts from a VP8/VP9 codec string that affect output layout and mux configuration. */
export interface VpxCodecInfo {
  codec: VpxCodec;
  profile: number;
  bitDepth: 8 | 10 | 12;
  subsampling: 0 | 1 | 2 | 3;
}

function asBitDepth(n: number): 8 | 10 | 12 | undefined {
  return n === 8 || n === 10 || n === 12 ? n : undefined;
}

function asSubsampling(n: number): 0 | 1 | 2 | 3 | undefined {
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : undefined;
}

function parseDecimalField(field: string | undefined, name: string): number {
  if (field === undefined || field === '' || !/^\d+$/.test(field)) {
    throw new MediaError(
      'decode-error',
      `vpx: codec-string ${name} field '${field}' is not numeric`,
    );
  }
  return Number.parseInt(field, 10);
}

/** Parse a bare or qualified VP8/VP9 WebCodecs/RFC-6381 codec string. */
export function parseVpxCodec(codecRaw: string): VpxCodecInfo {
  const codec = codecRaw.trim().toLowerCase();
  if (codec === 'vp8') return { codec: 'vp8', profile: 0, bitDepth: 8, subsampling: 1 };
  if (codec === 'vp9') return { codec: 'vp9', profile: 0, bitDepth: 8, subsampling: 1 };
  if (!codec.startsWith('vp09.')) {
    throw new MediaError('decode-error', `vpx: not a VP8/VP9 codec string: '${codecRaw}'`);
  }
  const fields = codec.slice('vp09.'.length).split('.');
  const profile = parseDecimalField(fields[0], 'profile');
  if (profile < 0 || profile > VP9_MAX_PROFILE) {
    throw new MediaError('decode-error', `vpx: VP9 profile ${profile} out of range (0–3)`);
  }
  parseDecimalField(fields[1], 'level');
  const bitDepth = asBitDepth(parseDecimalField(fields[2], 'bitDepth'));
  if (bitDepth === undefined) {
    throw new MediaError('decode-error', `vpx: VP9 bit depth '${fields[2]}' must be 8, 10, or 12`);
  }
  const subsampling =
    fields[3] === undefined ? 1 : asSubsampling(parseDecimalField(fields[3], 'subsampling'));
  if (subsampling === undefined) {
    throw new MediaError('decode-error', `vpx: VP9 chroma subsampling '${fields[3]}' must be 0–3`);
  }
  return { codec: 'vp9', profile, bitDepth, subsampling };
}
