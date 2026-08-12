/**
 * Container-neutral AV1 RFC-6381 codec-string parsing shared by muxers and codec implementations.
 * This module has no codec-runtime dependency.
 */

import { MediaError } from '../contracts/errors.ts';

export type Av1Codec = 'av1';
export type Av1Profile = 0 | 1 | 2;
export type Av1Tier = 'main' | 'high';
export type Av1BitDepth = 8 | 10 | 12;
export type Av1ChromaSubsampling = '400' | '420' | '422' | '444';

/** Parsed AV1 codec-string facts used for routing and configuration. */
export interface Av1CodecInfo {
  codec: Av1Codec;
  profile: Av1Profile;
  level: number;
  tier: Av1Tier;
  bitDepth: Av1BitDepth;
  monochrome: boolean;
  chromaSubsampling: Av1ChromaSubsampling;
}

const AV1_MAX_LEVEL = 31 as const;
const BARE_AV1_DEFAULT: Av1CodecInfo = {
  codec: 'av1',
  profile: 0,
  level: 4,
  tier: 'main',
  bitDepth: 8,
  monochrome: false,
  chromaSubsampling: '420',
};

function parseDecimalField(field: string | undefined, name: string): number {
  if (field === undefined || field === '' || !/^\d+$/.test(field)) {
    throw new MediaError(
      'decode-error',
      `av1: codec-string ${name} field '${field}' is not numeric`,
    );
  }
  return Number.parseInt(field, 10);
}

function asAv1Profile(n: number): Av1Profile | undefined {
  return n === 0 || n === 1 || n === 2 ? n : undefined;
}

function asAv1BitDepth(n: number): Av1BitDepth | undefined {
  return n === 8 || n === 10 || n === 12 ? n : undefined;
}

function parseLevelTier(field: string | undefined): { level: number; tier: Av1Tier } {
  if (field === undefined || !/^\d{2}[mMhH]$/.test(field)) {
    throw new MediaError(
      'decode-error',
      `av1: codec-string level/tier field '${field}' is malformed`,
    );
  }
  const level = Number.parseInt(field.slice(0, 2), 10);
  if (level < 0 || level > AV1_MAX_LEVEL) {
    throw new MediaError('decode-error', `av1: level ${level} out of range (0–31)`);
  }
  return { level, tier: field.endsWith('H') || field.endsWith('h') ? 'high' : 'main' };
}

function parseMonochrome(field: string | undefined): boolean {
  if (field === undefined || field === '0') return false;
  if (field === '1') return true;
  throw new MediaError('decode-error', `av1: monochrome flag '${field}' must be 0 or 1`);
}

function parseChromaSubsampling(
  monochrome: boolean,
  field: string | undefined,
): Av1ChromaSubsampling {
  if (monochrome) return '400';
  if (field === undefined) return '420';
  if (!/^[01][01][0-3]$/.test(field)) {
    throw new MediaError(
      'decode-error',
      `av1: chroma-subsampling field '${field}' must be a three-digit xyP code`,
    );
  }
  const subsamplingX = field[0] === '1';
  const subsamplingY = field[1] === '1';
  if (subsamplingX && subsamplingY) return '420';
  if (subsamplingX && !subsamplingY) return '422';
  if (!subsamplingX && !subsamplingY) return '444';
  throw new MediaError('decode-error', `av1: chroma-subsampling field '${field}' is invalid`);
}

/** Parse a bare or qualified AV1 WebCodecs/RFC-6381 codec string. */
export function parseAv1Codec(codecRaw: string): Av1CodecInfo {
  const codec = codecRaw.trim().toLowerCase();
  if (codec === 'av1') return { ...BARE_AV1_DEFAULT };
  if (!codec.startsWith('av01.')) {
    throw new MediaError('decode-error', `av1: not an AV1 codec string: '${codecRaw}'`);
  }

  const fields = codec.slice('av01.'.length).split('.');
  const profile = asAv1Profile(parseDecimalField(fields[0], 'profile'));
  if (profile === undefined) {
    throw new MediaError('decode-error', `av1: profile '${fields[0]}' must be 0, 1, or 2`);
  }
  const { level, tier } = parseLevelTier(fields[1]);
  const bitDepth = asAv1BitDepth(parseDecimalField(fields[2], 'bitDepth'));
  if (bitDepth === undefined) {
    throw new MediaError('decode-error', `av1: bit depth '${fields[2]}' must be 8, 10, or 12`);
  }
  const monochrome = parseMonochrome(fields[3]);
  const chromaSubsampling = parseChromaSubsampling(monochrome, fields[4]);

  return { codec: 'av1', profile, level, tier, bitDepth, monochrome, chromaSubsampling };
}
