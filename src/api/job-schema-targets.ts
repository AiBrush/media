/**
 * Target-shape validators for the declarative-job schema: container/codec token gates and the
 * `VideoTarget`/`AudioTarget` structures shared by op-level and output-level validation
 * (docs/architecture/execution-runtime §3.1). Tokens here are opaque codec/container identifiers —
 * never a tier or implementation name.
 */

import { InputError } from '../contracts/errors.ts';
import {
  allowedKeys,
  clonePlainData,
  finiteNumber,
  nonEmptyString,
  nonNegativeInteger,
  optionalBoolean,
  optionalEnum,
  optionalFiniteNumber,
  optionalNonNegativeInteger,
  optionalNonNegativeNumber,
  optionalPositiveInteger,
  optionalPositiveNumber,
  plainArray,
  plainRecord,
  positiveInteger,
  positiveNumber,
} from './job-schema-values.ts';
import type { AudioTarget, Container, DecryptOptions, VideoTarget } from './types.ts';

const VIDEO_TARGET_KEYS = [
  'codec',
  'width',
  'height',
  'fit',
  'fps',
  'bitrate',
  'bitrateMode',
  'crf',
  'twoPass',
  'bitDepth',
  'alpha',
  'rotate',
  'flip',
  'crop',
  'pad',
  'colorspace',
  'tonemap',
] as const;

const AUDIO_TARGET_KEYS = [
  'codec',
  'sampleRate',
  'channels',
  'bitrate',
  'gainDb',
  'fade',
  'mixMatrix',
  'dynamics',
  'biquad',
] as const;

export function validateVideoTarget(value: unknown, label: string): VideoTarget {
  const target = plainRecord(value, label);
  allowedKeys(target, VIDEO_TARGET_KEYS, label);
  optionalEnum(target.codec, ['h264', 'hevc', 'vp8', 'vp9', 'av1'], `${label}.codec`);
  optionalPositiveInteger(target.width, `${label}.width`);
  optionalPositiveInteger(target.height, `${label}.height`);
  optionalEnum(target.fit, ['contain', 'cover', 'fill'], `${label}.fit`);
  optionalPositiveNumber(target.fps, `${label}.fps`);
  optionalPositiveInteger(target.bitrate, `${label}.bitrate`);
  optionalEnum(target.bitrateMode, ['constant', 'variable', 'quantizer'], `${label}.bitrateMode`);
  if (target.crf !== undefined) {
    const crf = finiteNumber(target.crf, `${label}.crf`);
    const maxCrf = target.codec === 'h264' || target.codec === 'hevc' ? 51 : 63;
    if (crf < 0 || crf > maxCrf) {
      throw new InputError(`${label}.crf must be in [0, ${maxCrf}]`);
    }
  }
  optionalBoolean(target.twoPass, `${label}.twoPass`);
  if (target.bitrate !== undefined && target.crf !== undefined) {
    throw new InputError(`${label} cannot combine bitrate and crf`);
  }
  if (target.twoPass === true && target.bitrate === undefined) {
    throw new InputError(`${label}.twoPass requires bitrate`);
  }
  optionalEnum(target.bitDepth, [8, 10, 12], `${label}.bitDepth`);
  optionalEnum(target.alpha, ['keep', 'discard'], `${label}.alpha`);
  if (target.rotate !== undefined) rotation(target.rotate, `${label}.rotate`);
  optionalEnum(target.flip, ['h', 'v'], `${label}.flip`);
  if (target.crop !== undefined) rectangle(target.crop, `${label}.crop`);
  if (target.pad !== undefined) padTarget(target.pad, `${label}.pad`);
  if (target.colorspace !== undefined) colorspaceTarget(target.colorspace, `${label}.colorspace`);
  if (target.tonemap !== undefined) tonemapTarget(target.tonemap, `${label}.tonemap`);
  return clonePlainData(target) as VideoTarget;
}

export function validateAudioTarget(value: unknown, label: string): AudioTarget {
  const target = plainRecord(value, label);
  allowedKeys(target, AUDIO_TARGET_KEYS, label);
  optionalEnum(
    target.codec,
    [
      'aac',
      'opus',
      'mp3',
      'flac',
      'vorbis',
      'pcm',
      'pcm-u8',
      'pcm-u8be',
      'pcm-s8',
      'pcm-s8be',
      'pcm-s16',
      'pcm-s16be',
      'pcm-s24',
      'pcm-s24be',
      'pcm-s32',
      'pcm-s32be',
      'pcm-f32',
      'pcm-f32be',
      'pcm-f64',
      'pcm-f64be',
    ],
    `${label}.codec`,
  );
  optionalPositiveInteger(target.sampleRate, `${label}.sampleRate`);
  optionalPositiveInteger(target.channels, `${label}.channels`);
  optionalPositiveInteger(target.bitrate, `${label}.bitrate`);
  optionalFiniteNumber(target.gainDb, `${label}.gainDb`);
  if (target.fade !== undefined) fadeTarget(target.fade, `${label}.fade`);
  if (target.mixMatrix !== undefined) {
    const matrix = mixMatrixTarget(target.mixMatrix, `${label}.mixMatrix`);
    if (target.channels !== undefined && matrix.length !== target.channels) {
      throw new InputError(
        `${label}.mixMatrix has ${matrix.length} output row(s), expected ${target.channels}`,
      );
    }
  }
  if (target.dynamics !== undefined) dynamicsTarget(target.dynamics, `${label}.dynamics`);
  if (target.biquad !== undefined) biquadTarget(target.biquad, `${label}.biquad`);
  return clonePlainData(target) as AudioTarget;
}

function mixMatrixTarget(value: unknown, label: string): readonly (readonly number[])[] {
  const matrix = plainArray(value, label);
  if (matrix.length === 0) throw new InputError(`${label} must contain at least one output row`);
  let inputChannels: number | undefined;
  for (let output = 0; output < matrix.length; output++) {
    const rowLabel = `${label}[${output}]`;
    const row = plainArray(matrix[output], rowLabel);
    if (row.length === 0) throw new InputError(`${rowLabel} must contain at least one coefficient`);
    inputChannels ??= row.length;
    if (row.length !== inputChannels) {
      throw new InputError(
        `${rowLabel} has ${row.length} coefficient(s), expected ${inputChannels}`,
      );
    }
    for (let input = 0; input < row.length; input++) {
      finiteNumber(row[input], `${rowLabel}[${input}]`);
    }
  }
  return matrix as readonly (readonly number[])[];
}

/** Validate `undefined` (absent), `false` (stream disabled), or a target object via `validate`. */
export function optionalTarget<T extends object>(
  value: unknown,
  validate: (candidate: unknown, label: string) => T,
  label: string,
): false | T | undefined {
  if (value === undefined || value === false) return value;
  return validate(value, label);
}

export function containerValue(value: unknown, label: string): Container {
  if (typeof value !== 'string' || !isContainer(value)) {
    throw new InputError(`${label} is not a supported container token`);
  }
  return value;
}

function isContainer(value: string): value is Container {
  switch (value) {
    case 'mp4':
    case 'mov':
    case 'webm':
    case 'mkv':
    case 'ogg':
    case 'wav':
    case 'mp3':
    case 'aac':
    case 'adts':
    case 'flac':
    case 'aiff':
    case 'caf':
    case 'avi':
    case 'ts':
    case 'm2ts':
    case 'mts':
    case 'mpegts':
      return true;
    default:
      return false;
  }
}

export function encryptionScheme(value: unknown, label: string): DecryptOptions['scheme'] {
  switch (value) {
    case 'cenc':
    case 'cens':
    case 'cbcs':
    case 'hls-aes128':
    case 'hls-sample-aes':
      return value;
    default:
      throw new InputError(`${label} is not supported`);
  }
}

export function rotation(value: unknown, label: string): NonNullable<VideoTarget['rotate']> {
  if (value === 0 || value === 90 || value === 180 || value === 270) return value;
  throw new InputError(`${label} must be 0, 90, 180, or 270`);
}

function rectangle(value: unknown, label: string): void {
  const rectangleValue = plainRecord(value, label);
  allowedKeys(rectangleValue, ['x', 'y', 'width', 'height'], label);
  nonNegativeInteger(rectangleValue.x, `${label}.x`);
  nonNegativeInteger(rectangleValue.y, `${label}.y`);
  positiveInteger(rectangleValue.width, `${label}.width`);
  positiveInteger(rectangleValue.height, `${label}.height`);
}

function padTarget(value: unknown, label: string): void {
  const pad = plainRecord(value, label);
  allowedKeys(pad, ['width', 'height', 'x', 'y'], label);
  positiveInteger(pad.width, `${label}.width`);
  positiveInteger(pad.height, `${label}.height`);
  optionalNonNegativeInteger(pad.x, `${label}.x`);
  optionalNonNegativeInteger(pad.y, `${label}.y`);
}

function colorspaceTarget(value: unknown, label: string): void {
  const target = plainRecord(value, label);
  allowedKeys(target, ['to'], label);
  nonEmptyString(target.to, `${label}.to`);
}

function tonemapTarget(value: unknown, label: string): void {
  const target = plainRecord(value, label);
  allowedKeys(target, ['to'], label);
  if (target.to !== 'sdr') {
    throw new InputError(`${label}.to is not supported`);
  }
}

function fadeTarget(value: unknown, label: string): void {
  const fade = plainRecord(value, label);
  allowedKeys(fade, ['inSec', 'outSec', 'curve'], label);
  optionalNonNegativeNumber(fade.inSec, `${label}.inSec`);
  optionalNonNegativeNumber(fade.outSec, `${label}.outSec`);
  optionalEnum(fade.curve, ['linear', 'equal-power'], `${label}.curve`);
}

function dynamicsTarget(value: unknown, label: string): void {
  const dynamics = plainRecord(value, label);
  allowedKeys(dynamics, ['normalize', 'limit'], label);
  if (dynamics.normalize === undefined && dynamics.limit === undefined) {
    throw new InputError(`${label} needs normalize and/or limit`);
  }
  if (dynamics.normalize !== undefined) {
    const normalize = plainRecord(dynamics.normalize, `${label}.normalize`);
    allowedKeys(normalize, ['mode', 'targetDbfs'], `${label}.normalize`);
    optionalEnum(normalize.mode, ['peak', 'rms'], `${label}.normalize.mode`, false);
    finiteNumber(normalize.targetDbfs, `${label}.normalize.targetDbfs`);
  }
  if (dynamics.limit !== undefined) {
    const limit = plainRecord(dynamics.limit, `${label}.limit`);
    allowedKeys(limit, ['ceilingDbfs', 'mode', 'knee'], `${label}.limit`);
    optionalFiniteNumber(limit.ceilingDbfs, `${label}.limit.ceilingDbfs`);
    optionalEnum(limit.mode, ['hard', 'soft'], `${label}.limit.mode`);
    optionalFiniteNumber(limit.knee, `${label}.limit.knee`);
  }
}

function biquadTarget(value: unknown, label: string): void {
  const values = Array.isArray(value) ? plainArray(value, label) : [value];
  for (let index = 0; index < values.length; index++) {
    const itemLabel = Array.isArray(value) ? `${label}[${index}]` : label;
    const spec = plainRecord(values[index], itemLabel);
    allowedKeys(spec, ['type', 'frequency', 'q', 'gainDb'], itemLabel);
    optionalEnum(
      spec.type,
      ['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf'],
      `${itemLabel}.type`,
      false,
    );
    positiveNumber(spec.frequency, `${itemLabel}.frequency`);
    positiveNumber(spec.q, `${itemLabel}.q`);
    optionalFiniteNumber(spec.gainDb, `${itemLabel}.gainDb`);
    if (
      (spec.type === 'peaking' || spec.type === 'lowshelf' || spec.type === 'highshelf') &&
      spec.gainDb === undefined
    ) {
      throw new InputError(`${itemLabel}.gainDb is required for ${spec.type}`);
    }
  }
}
