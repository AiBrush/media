import type { Progress } from '../contracts/driver.ts';
import { InputError, MediaError } from '../contracts/errors.ts';
import { toBlob } from '../sinks/sink.ts';
import type { MediaInput } from '../sources/source.ts';
import type {
  JobEngine,
  MediaJob,
  MediaJobInput,
  MediaJobOperation,
  MediaJobOutput,
} from './job.ts';
import type {
  AudioTarget,
  CallOptions,
  Cancellable,
  Container,
  ConvertOptions,
  DecryptOptions,
  Output,
  RemuxOptions,
  TrimOptions,
  VideoTarget,
} from './types.ts';

type JobStage =
  | { readonly kind: 'convert'; readonly opts: Omit<ConvertOptions, 'sink'> }
  | { readonly kind: 'trim'; readonly opts: Omit<TrimOptions, 'sink'> }
  | { readonly kind: 'remux'; readonly opts: Omit<RemuxOptions, 'sink'> }
  | { readonly kind: 'decrypt'; readonly opts: Omit<DecryptOptions, 'sink'> };

interface CompiledJob {
  readonly input: MediaJobInput;
  readonly stages: readonly JobStage[];
}

interface ValidatedJob {
  readonly input: MediaJobInput;
  readonly ops: readonly MediaJobOperation[];
  readonly output: MediaJobOutput;
}

interface PendingVideo {
  readonly target: VideoTarget;
  readonly lastRank: number;
}

/** Explicitly names every schema field while retaining indexed access for unknown-field rejection. */
interface PlainRecord extends Record<string, unknown> {
  readonly input?: unknown;
  readonly ops?: unknown;
  readonly output?: unknown;
  readonly container?: unknown;
  readonly video?: unknown;
  readonly audio?: unknown;
  readonly faststart?: unknown;
  readonly fragmented?: unknown;
  readonly op?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly mode?: unknown;
  readonly to?: unknown;
  readonly tags?: unknown;
  readonly trackSelect?: unknown;
  readonly scheme?: unknown;
  readonly keys?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly fit?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly degrees?: unknown;
  readonly axis?: unknown;
  readonly codec?: unknown;
  readonly fps?: unknown;
  readonly bitrate?: unknown;
  readonly bitrateMode?: unknown;
  readonly crf?: unknown;
  readonly twoPass?: unknown;
  readonly bitDepth?: unknown;
  readonly alpha?: unknown;
  readonly rotate?: unknown;
  readonly flip?: unknown;
  readonly crop?: unknown;
  readonly pad?: unknown;
  readonly colorspace?: unknown;
  readonly tonemap?: unknown;
  readonly sampleRate?: unknown;
  readonly channels?: unknown;
  readonly gainDb?: unknown;
  readonly fade?: unknown;
  readonly dynamics?: unknown;
  readonly biquad?: unknown;
  readonly inSec?: unknown;
  readonly outSec?: unknown;
  readonly curve?: unknown;
  readonly normalize?: unknown;
  readonly limit?: unknown;
  readonly targetDbfs?: unknown;
  readonly ceilingDbfs?: unknown;
  readonly knee?: unknown;
  readonly type?: unknown;
  readonly frequency?: unknown;
  readonly q?: unknown;
}

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
  'dynamics',
  'biquad',
] as const;

/** Execute one fully validated declarative job through the engine's real flat operations. */
export function runMediaJob(
  engine: JobEngine,
  job: MediaJob,
  callOptions: CallOptions = {},
): Cancellable<Blob> {
  const controller = new AbortController();
  const parentSignal = callOptions.signal;
  const onParentAbort = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted === true) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  let active: Cancellable<Output> | undefined;
  let cancelledActive: Cancellable<Output> | undefined;
  const cancelActive = (): void => {
    const current = active;
    if (current === undefined || current === cancelledActive) return;
    cancelledActive = current;
    try {
      current.cancel();
    } catch {
      // The linked abort remains the primary cancellation fact; a throwing cancel hook cannot replace it.
    }
  };
  controller.signal.addEventListener('abort', cancelActive);

  const promise = (async (): Promise<Blob> => {
    try {
      // Compile before the first abort checkpoint deliberately: malformed later stages must be rejected
      // without invoking an engine operation or normalizing/reading a one-shot input.
      const compiled = compileMediaJobSafely(job);
      throwIfAborted(controller.signal);
      let input = compiled.input;
      let finalBlob: Blob | undefined;
      let lastProgress = 0;
      const total = compiled.stages.length;

      for (let index = 0; index < total; index++) {
        throwIfAborted(controller.signal);
        const stage = compiled.stages[index];
        if (stage === undefined) {
          throw new InputError('unsupported-input', 'declarative job compiled an empty stage');
        }
        const final = index === total - 1;
        const progress = stageProgress(
          callOptions.onProgress,
          stage.kind,
          index,
          total,
          () => lastProgress,
        );
        const stageOptions: CallOptions = {
          ...callOptions,
          signal: controller.signal,
          ...(progress.onProgress !== undefined ? { onProgress: progress.onProgress } : {}),
        };
        cancelledActive = undefined;
        active = dispatchStage(engine, input, stage, final, stageOptions);
        // A progress hook or host constructor can synchronously abort while dispatchStage is obtaining the
        // handle, before `active` is assigned and the abort listener can see it. Close that race explicitly.
        if (controller.signal.aborted) cancelActive();
        const output = await active;
        active = undefined;
        throwIfAborted(controller.signal);
        lastProgress = progress.complete(lastProgress);
        const blob = expectBlob(output, final ? 'final' : 'intermediate');
        if (final) finalBlob = blob;
        else input = blob;
      }

      if (finalBlob === undefined) {
        throw new InputError('unsupported-input', 'declarative job produced no final Blob');
      }
      return finalBlob;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new MediaError('aborted', 'operation aborted', error);
      }
      throw error;
    } finally {
      active = undefined;
      parentSignal?.removeEventListener('abort', onParentAbort);
      controller.signal.removeEventListener('abort', cancelActive);
    }
  })() as Cancellable<Blob>;

  promise.cancel = (): void => controller.abort();
  return promise;
}

function compileMediaJob(job: MediaJob): CompiledJob {
  const validated = validateJob(job);
  const stages: JobStage[] = [];
  let pending: PendingVideo | undefined;
  let hasVideoTransform = false;

  const flushPending = (): void => {
    if (pending === undefined) return;
    stages.push({ kind: 'convert', opts: { video: pending.target } });
    pending = undefined;
  };

  const addTransform = (rank: number, target: VideoTarget): void => {
    hasVideoTransform = true;
    if (pending !== undefined && rank <= pending.lastRank) flushPending();
    pending = {
      target: pending === undefined ? target : { ...pending.target, ...target },
      lastRank: rank,
    };
  };

  for (const operation of validated.ops) {
    switch (operation.op) {
      case 'crop':
        addTransform(0, {
          crop: {
            x: operation.x,
            y: operation.y,
            width: operation.width,
            height: operation.height,
          },
        });
        break;
      case 'resize':
        addTransform(1, {
          width: operation.width,
          height: operation.height,
          ...(operation.fit !== undefined ? { fit: operation.fit } : {}),
        });
        break;
      case 'pad':
        addTransform(2, {
          pad: {
            width: operation.width,
            height: operation.height,
            ...(operation.x !== undefined ? { x: operation.x } : {}),
            ...(operation.y !== undefined ? { y: operation.y } : {}),
          },
        });
        break;
      case 'rotate':
        addTransform(3, { rotate: operation.degrees });
        break;
      case 'flip':
        addTransform(4, { flip: operation.axis });
        break;
      case 'colorspace':
        addTransform(5, { colorspace: { to: operation.to } });
        break;
      case 'tonemap':
        addTransform(6, { tonemap: { to: operation.to ?? 'sdr' } });
        break;
      case 'convert': {
        const { op: _op, ...opts } = operation;
        void _op;
        if (pending !== undefined) {
          if (opts.video === false) {
            throw new InputError(
              'unsupported-input',
              'declarative video transforms cannot feed convert({ video:false })',
            );
          }
          const firstTargetRank = firstVideoTransformRank(opts.video);
          if (firstTargetRank !== undefined && pending.lastRank >= firstTargetRank) {
            flushPending();
            stages.push({ kind: 'convert', opts });
          } else {
            stages.push({
              kind: 'convert',
              opts: {
                ...opts,
                video: { ...(opts.video ?? {}), ...pending.target },
              },
            });
            pending = undefined;
          }
        } else {
          stages.push({ kind: 'convert', opts });
        }
        break;
      }
      case 'trim': {
        flushPending();
        const { op: _op, ...opts } = operation;
        void _op;
        stages.push({ kind: 'trim', opts });
        break;
      }
      case 'remux': {
        flushPending();
        const { op: _op, ...opts } = operation;
        void _op;
        stages.push({ kind: 'remux', opts });
        break;
      }
      case 'decrypt': {
        flushPending();
        const { op: _op, ...opts } = operation;
        void _op;
        stages.push({ kind: 'decrypt', opts });
        break;
      }
      default:
        throw new InputError('unsupported-input', 'unknown declarative job operation');
    }
  }

  if (hasVideoTransform && validated.output.video === false) {
    throw new InputError(
      'unsupported-input',
      'declarative video transforms cannot be combined with output.video:false',
    );
  }
  if (pending !== undefined) {
    const firstOutputRank = firstVideoTransformRank(validated.output.video);
    if (firstOutputRank !== undefined && pending.lastRank >= firstOutputRank) flushPending();
  }
  const outputVideo = mergeOutputVideo(validated.output.video, pending?.target);
  stages.push({
    kind: 'convert',
    opts: {
      to: validated.output.container,
      ...(outputVideo !== undefined ? { video: outputVideo } : {}),
      ...(validated.output.audio !== undefined ? { audio: validated.output.audio } : {}),
      ...(validated.output.faststart !== undefined
        ? { faststart: validated.output.faststart }
        : {}),
      ...(validated.output.fragmented !== undefined
        ? { fragmented: validated.output.fragmented }
        : {}),
    },
  });
  return { input: validated.input, stages };
}

function compileMediaJobSafely(job: MediaJob): CompiledJob {
  try {
    return compileMediaJob(job);
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new InputError('unsupported-input', 'declarative job schema validation failed', error);
  }
}

function dispatchStage(
  engine: JobEngine,
  input: MediaInput,
  stage: JobStage,
  final: boolean,
  callOptions: CallOptions,
): Cancellable<Output> {
  switch (stage.kind) {
    case 'convert':
      return engine.convert(
        input,
        final ? stage.opts : { ...stage.opts, sink: toBlob() },
        callOptions,
      );
    case 'trim':
      return engine.trim(input, { ...stage.opts, sink: toBlob() }, callOptions);
    case 'remux':
      return engine.remux(input, { ...stage.opts, sink: toBlob() }, callOptions);
    case 'decrypt':
      return engine.decrypt(input, { ...stage.opts, sink: toBlob() }, callOptions);
    default:
      return stage;
  }
}

function stageProgress(
  emit: CallOptions['onProgress'],
  kind: JobStage['kind'],
  index: number,
  total: number,
  current: () => number,
): {
  readonly onProgress?: (progress: Progress) => void;
  readonly complete: (last: number) => number;
} {
  const prefix = `job:${index + 1}/${total}:${kind}`;
  const boundary = index + 1;
  if (emit === undefined) return { complete: () => boundary };
  let last = current();
  let closed = false;
  return {
    onProgress(progress): void {
      if (closed) return;
      let candidate = index;
      if (
        typeof progress.done === 'number' &&
        Number.isFinite(progress.done) &&
        typeof progress.total === 'number' &&
        Number.isFinite(progress.total) &&
        progress.total > 0
      ) {
        candidate = index + clamp(progress.done / progress.total, 0, 1);
      }
      candidate = Math.max(last, Math.min(boundary, candidate));
      if (candidate === last && progress.done !== 0) return;
      last = candidate;
      emit({
        done: candidate,
        total,
        stage: progress.stage.trim() === '' ? prefix : `${prefix}:${progress.stage}`,
      });
    },
    complete(previous): number {
      closed = true;
      const done = Math.max(previous, last, boundary);
      if (last < boundary) emit({ done, total, stage: prefix });
      return done;
    },
  };
}

function validateJob(job: MediaJob): ValidatedJob {
  const value = plainRecord(job, 'declarative job');
  allowedKeys(value, ['input', 'ops', 'output'], 'declarative job');
  if (!Object.hasOwn(value, 'input') || value.input === undefined || value.input === null) {
    throw new InputError('unsupported-input', 'declarative job requires an input');
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
    throw new InputError('unsupported-input', `${label} requires a string op`);
  }
  switch (discriminant) {
    case 'trim': {
      allowedKeys(operation, ['op', 'start', 'end', 'mode'], label);
      const start = finiteNumber(operation.start, `${label}.start`);
      const end = finiteNumber(operation.end, `${label}.end`);
      if (start < 0 || end <= start) {
        throw new InputError('unsupported-input', `${label} needs 0 <= start < end`);
      }
      if (
        operation.mode !== undefined &&
        operation.mode !== 'keyframe' &&
        operation.mode !== 'accurate'
      ) {
        throw new InputError('unsupported-input', `${label}.mode is not supported`);
      }
      return {
        op: 'trim',
        start,
        end,
        ...(operation.mode !== undefined ? { mode: operation.mode } : {}),
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
        throw new InputError('unsupported-input', `${label}.fit is not supported`);
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
        throw new InputError('unsupported-input', `${label}.axis is not supported`);
      }
      return { op: 'flip', axis: operation.axis };
    case 'colorspace': {
      allowedKeys(operation, ['op', 'to'], label);
      return { op: 'colorspace', to: nonEmptyString(operation.to, `${label}.to`) };
    }
    case 'tonemap':
      allowedKeys(operation, ['op', 'to'], label);
      if (operation.to !== undefined && operation.to !== 'sdr') {
        throw new InputError('unsupported-input', `${label}.to is not supported`);
      }
      return { op: 'tonemap', ...(operation.to !== undefined ? { to: operation.to } : {}) };
    default:
      throw new InputError('unsupported-input', `${label} has unknown op '${discriminant}'`);
  }
}

function validateVideoTarget(value: unknown, label: string): VideoTarget {
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
      throw new InputError('unsupported-input', `${label}.crf must be in [0, ${maxCrf}]`);
    }
  }
  optionalBoolean(target.twoPass, `${label}.twoPass`);
  if (target.bitrate !== undefined && target.crf !== undefined) {
    throw new InputError('unsupported-input', `${label} cannot combine bitrate and crf`);
  }
  if (target.twoPass === true && target.bitrate === undefined) {
    throw new InputError('unsupported-input', `${label}.twoPass requires bitrate`);
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

function validateAudioTarget(value: unknown, label: string): AudioTarget {
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
  if (target.dynamics !== undefined) dynamicsTarget(target.dynamics, `${label}.dynamics`);
  if (target.biquad !== undefined) biquadTarget(target.biquad, `${label}.biquad`);
  return clonePlainData(target) as AudioTarget;
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
    throw new InputError('unsupported-input', `${label}.to is not supported`);
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
    throw new InputError('unsupported-input', `${label} needs normalize and/or limit`);
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
      throw new InputError('unsupported-input', `${itemLabel}.gainDb is required for ${spec.type}`);
    }
  }
}

function mergeOutputVideo(
  output: MediaJobOutput['video'],
  pending: VideoTarget | undefined,
): MediaJobOutput['video'] {
  if (pending === undefined) return output;
  if (output === false) {
    throw new InputError(
      'unsupported-input',
      'declarative video transforms cannot be combined with output.video:false',
    );
  }
  return { ...(output ?? {}), ...pending };
}

function firstVideoTransformRank(target: false | VideoTarget | undefined): number | undefined {
  if (target === undefined || target === false) return undefined;
  if (target.crop !== undefined) return 0;
  if (target.width !== undefined || target.height !== undefined || target.fit !== undefined)
    return 1;
  if (target.pad !== undefined) return 2;
  if (target.rotate !== undefined) return 3;
  if (target.flip !== undefined) return 4;
  if (target.colorspace !== undefined) return 5;
  if (target.tonemap !== undefined) return 6;
  return undefined;
}

function expectBlob(output: Output, boundary: 'intermediate' | 'final'): Blob {
  if (output instanceof Blob) return output;
  throw new InputError(
    'unsupported-input',
    `declarative job ${boundary} default sink did not produce a Blob`,
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new MediaError('aborted', 'operation aborted', signal.reason);
}

function plainRecord(value: unknown, label: string): PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputError('unsupported-input', `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InputError('unsupported-input', `${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !('value' in descriptor)
    ) {
      throw new InputError(
        'unsupported-input',
        `${label} must contain enumerable string data fields only`,
      );
    }
  }
  return value as PlainRecord;
}

function allowedKeys(value: PlainRecord, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key))
      throw new InputError('unsupported-input', `${label} has unknown field '${key}'`);
  }
}

function plainArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new InputError('unsupported-input', `${label} must be an array`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !isCanonicalArrayIndex(key, value.length) ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !('value' in descriptor)
    ) {
      throw new InputError(
        'unsupported-input',
        `${label} must contain enumerable data elements only`,
      );
    }
  }
  return value;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function jobInput(value: unknown, label: string): MediaJobInput {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) {
    if (value.locked) {
      throw new InputError('unsupported-input', `${label} ReadableStream is already locked`);
    }
    return value;
  }
  throw new InputError('unsupported-input', `${label} is not structured-cloneable job media`);
}

function clonePlainData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => clonePlainData(item));
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: clonePlainData(item),
      writable: true,
    });
  }
  return result;
}

function optionalTarget<T extends object>(
  value: unknown,
  validate: (candidate: unknown, label: string) => T,
  label: string,
): false | T | undefined {
  if (value === undefined || value === false) return value;
  return validate(value, label);
}

function containerValue(value: unknown, label: string): Container {
  if (typeof value !== 'string' || !isContainer(value)) {
    throw new InputError('unsupported-input', `${label} is not a supported container token`);
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

function encryptionScheme(value: unknown, label: string): DecryptOptions['scheme'] {
  switch (value) {
    case 'cenc':
    case 'cens':
    case 'cbcs':
    case 'hls-aes128':
    case 'hls-sample-aes':
      return value;
    default:
      throw new InputError('unsupported-input', `${label} is not supported`);
  }
}

function rotation(value: unknown, label: string): NonNullable<VideoTarget['rotate']> {
  if (value === 0 || value === 90 || value === 180 || value === 270) return value;
  throw new InputError('unsupported-input', `${label} must be 0, 90, 180, or 270`);
}

function requiredStringRecord(value: unknown, label: string): Record<string, string> {
  const record = plainRecord(value, label);
  const result = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') {
      throw new InputError('unsupported-input', `${label}.${key} must be a string`);
    }
    result[key] = item;
  }
  return result;
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  return value === undefined ? undefined : requiredStringRecord(value, label);
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const strings = plainArray(value, label);
  if (strings.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new InputError('unsupported-input', `${label} must be an array of non-empty strings`);
  }
  return strings as readonly string[];
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InputError('unsupported-input', `${label} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError('unsupported-input', `${label} must be a finite number`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result <= 0) throw new InputError('unsupported-input', `${label} must be positive`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  const result = positiveNumber(value, label);
  if (!Number.isSafeInteger(result)) {
    throw new InputError('unsupported-input', `${label} must be a positive safe integer`);
  }
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new InputError('unsupported-input', `${label} must be a non-negative safe integer`);
  }
  return result;
}

function optionalPositiveNumber(value: unknown, label: string): void {
  if (value !== undefined) positiveNumber(value, label);
}

function optionalPositiveInteger(value: unknown, label: string): void {
  if (value !== undefined) positiveInteger(value, label);
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, label);
}

function optionalNonNegativeNumber(value: unknown, label: string): void {
  if (value === undefined) return;
  const result = finiteNumber(value, label);
  if (result < 0) throw new InputError('unsupported-input', `${label} must be non-negative`);
}

function optionalFiniteNumber(value: unknown, label: string): void {
  if (value !== undefined) finiteNumber(value, label);
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new InputError('unsupported-input', `${label} must be a boolean`);
  }
}

function optionalEnum<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  optional = true,
): void {
  if (value === undefined && optional) return;
  if (!allowed.some((candidate) => candidate === value)) {
    throw new InputError('unsupported-input', `${label} is not supported`);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
