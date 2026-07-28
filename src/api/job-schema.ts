/**
 * Declarative-job schema validation (docs/architecture/execution-runtime §3.1). A `MediaJob` crosses the
 * worker boundary as plain structured-clone data, so every field is validated structurally before any
 * engine operation runs or a one-shot input is consumed. Malformed jobs raise a typed `InputError`;
 * validated targets are snapshotted (deep plain-data clones) so later caller mutation cannot leak in.
 */

import { InputError } from '../contracts/errors.ts';
import {
  containerValue,
  encryptionScheme,
  optionalTarget,
  rotation,
  validateAudioTarget,
  validateVideoTarget,
} from './job-schema-targets.ts';
import {
  allowedKeys,
  finiteNumber,
  nonEmptyString,
  nonNegativeInteger,
  optionalBoolean,
  optionalNonNegativeInteger,
  optionalStringArray,
  optionalStringRecord,
  plainArray,
  plainRecord,
  positiveInteger,
  requiredStringRecord,
} from './job-schema-values.ts';
import type { MediaJob, MediaJobInput, MediaJobOperation, MediaJobOutput } from './job.ts';

export interface ValidatedJob {
  readonly input: MediaJobInput;
  readonly ops: readonly MediaJobOperation[];
  readonly output: MediaJobOutput;
}

export function validateJob(job: MediaJob): ValidatedJob {
  const value = plainRecord(job, 'declarative job');
  allowedKeys(value, ['input', 'ops', 'output'], 'declarative job');
  if (!Object.hasOwn(value, 'input') || value.input === undefined || value.input === null) {
    throw new InputError('declarative job requires an input');
  }
  const jobOps = plainArray(value.ops, 'declarative job ops');
  const output = validateOutput(value.output);
  const operations: MediaJobOperation[] = [];
  for (let index = 0; index < jobOps.length; index++) {
    operations.push(validateOperation(jobOps[index], index));
  }
  return { input: jobInput(value.input, 'declarative job.input'), ops: operations, output };
}

function validateOutput(value: unknown): MediaJobOutput {
  const output = plainRecord(value, 'declarative job output');
  allowedKeys(
    output,
    ['container', 'video', 'audio', 'faststart', 'fragmented'],
    'declarative job output',
  );
  const container = containerValue(output.container, 'declarative job output.container');
  const video = optionalTarget(output.video, validateVideoTarget, 'output.video');
  const audio = optionalTarget(output.audio, validateAudioTarget, 'output.audio');
  optionalBoolean(output.faststart, 'output.faststart');
  optionalBoolean(output.fragmented, 'output.fragmented');
  return {
    container,
    ...(video !== undefined ? { video } : {}),
    ...(audio !== undefined ? { audio } : {}),
    ...(output.faststart !== undefined ? { faststart: output.faststart as boolean } : {}),
    ...(output.fragmented !== undefined ? { fragmented: output.fragmented as boolean } : {}),
  };
}

function validateOperation(value: unknown, index: number): MediaJobOperation {
  const label = `declarative job op[${index}]`;
  const operation = plainRecord(value, label);
  const discriminant = operation.op;
  if (typeof discriminant !== 'string') {
    throw new InputError(`${label} requires a string op`);
  }
  switch (discriminant) {
    case 'trim': {
      allowedKeys(operation, ['op', 'start', 'end', 'mode', 'fragmented'], label);
      const start = finiteNumber(operation.start, `${label}.start`);
      const end = finiteNumber(operation.end, `${label}.end`);
      if (start < 0 || end <= start) {
        throw new InputError(`${label} needs 0 <= start < end`);
      }
      if (
        operation.mode !== undefined &&
        operation.mode !== 'keyframe' &&
        operation.mode !== 'accurate'
      ) {
        throw new InputError(`${label}.mode is not supported`);
      }
      optionalBoolean(operation.fragmented, `${label}.fragmented`);
      return {
        op: 'trim',
        start,
        end,
        ...(operation.mode !== undefined ? { mode: operation.mode } : {}),
        ...(operation.fragmented !== undefined
          ? { fragmented: operation.fragmented as boolean }
          : {}),
      };
    }
    case 'convert': {
      allowedKeys(operation, ['op', 'to', 'video', 'audio', 'faststart', 'fragmented'], label);
      const to =
        operation.to === undefined ? undefined : containerValue(operation.to, `${label}.to`);
      const video = optionalTarget(operation.video, validateVideoTarget, `${label}.video`);
      const audio = optionalTarget(operation.audio, validateAudioTarget, `${label}.audio`);
      optionalBoolean(operation.faststart, `${label}.faststart`);
      optionalBoolean(operation.fragmented, `${label}.fragmented`);
      return {
        op: 'convert',
        ...(to !== undefined ? { to } : {}),
        ...(video !== undefined ? { video } : {}),
        ...(audio !== undefined ? { audio } : {}),
        ...(operation.faststart !== undefined ? { faststart: operation.faststart as boolean } : {}),
        ...(operation.fragmented !== undefined
          ? { fragmented: operation.fragmented as boolean }
          : {}),
      };
    }
    case 'remux': {
      allowedKeys(operation, ['op', 'to', 'faststart', 'fragmented', 'tags', 'trackSelect'], label);
      const to = containerValue(operation.to, `${label}.to`);
      optionalBoolean(operation.faststart, `${label}.faststart`);
      optionalBoolean(operation.fragmented, `${label}.fragmented`);
      const tags = optionalStringRecord(operation.tags, `${label}.tags`);
      const trackSelect = optionalStringArray(operation.trackSelect, `${label}.trackSelect`);
      return {
        op: 'remux',
        to,
        ...(operation.faststart !== undefined ? { faststart: operation.faststart as boolean } : {}),
        ...(operation.fragmented !== undefined
          ? { fragmented: operation.fragmented as boolean }
          : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(trackSelect !== undefined ? { trackSelect } : {}),
      };
    }
    case 'decrypt': {
      allowedKeys(operation, ['op', 'scheme', 'keys'], label);
      const scheme = encryptionScheme(operation.scheme, `${label}.scheme`);
      const keys = requiredStringRecord(operation.keys, `${label}.keys`);
      return { op: 'decrypt', scheme, keys };
    }
    case 'resize': {
      allowedKeys(operation, ['op', 'width', 'height', 'fit'], label);
      const width = positiveInteger(operation.width, `${label}.width`);
      const height = positiveInteger(operation.height, `${label}.height`);
      if (
        operation.fit !== undefined &&
        operation.fit !== 'contain' &&
        operation.fit !== 'cover' &&
        operation.fit !== 'fill'
      ) {
        throw new InputError(`${label}.fit is not supported`);
      }
      return {
        op: 'resize',
        width,
        height,
        ...(operation.fit !== undefined ? { fit: operation.fit } : {}),
      };
    }
    case 'crop': {
      allowedKeys(operation, ['op', 'x', 'y', 'width', 'height'], label);
      return {
        op: 'crop',
        x: nonNegativeInteger(operation.x, `${label}.x`),
        y: nonNegativeInteger(operation.y, `${label}.y`),
        width: positiveInteger(operation.width, `${label}.width`),
        height: positiveInteger(operation.height, `${label}.height`),
      };
    }
    case 'pad': {
      allowedKeys(operation, ['op', 'width', 'height', 'x', 'y'], label);
      const x = optionalNonNegativeInteger(operation.x, `${label}.x`);
      const y = optionalNonNegativeInteger(operation.y, `${label}.y`);
      return {
        op: 'pad',
        width: positiveInteger(operation.width, `${label}.width`),
        height: positiveInteger(operation.height, `${label}.height`),
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
      };
    }
    case 'rotate': {
      allowedKeys(operation, ['op', 'degrees'], label);
      const degrees = rotation(operation.degrees, `${label}.degrees`);
      return { op: 'rotate', degrees };
    }
    case 'flip':
      allowedKeys(operation, ['op', 'axis'], label);
      if (operation.axis !== 'h' && operation.axis !== 'v') {
        throw new InputError(`${label}.axis is not supported`);
      }
      return { op: 'flip', axis: operation.axis };
    case 'colorspace': {
      allowedKeys(operation, ['op', 'to'], label);
      return { op: 'colorspace', to: nonEmptyString(operation.to, `${label}.to`) };
    }
    case 'tonemap':
      allowedKeys(operation, ['op', 'to'], label);
      if (operation.to !== undefined && operation.to !== 'sdr') {
        throw new InputError(`${label}.to is not supported`);
      }
      return { op: 'tonemap', ...(operation.to !== undefined ? { to: operation.to } : {}) };
    default:
      throw new InputError(`${label} has unknown op '${discriminant}'`);
  }
}

function jobInput(value: unknown, label: string): MediaJobInput {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) {
    if (value.locked) {
      throw new InputError(`${label} ReadableStream is already locked`);
    }
    return value;
  }
  throw new InputError(`${label} is not structured-cloneable job media`);
}
