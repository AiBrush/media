/**
 * Declarative-job compilation (docs/architecture/execution-runtime §3.5): validate the `MediaJob`, fuse
 * adjacent canonical video transforms (`crop → resize → pad → rotate → flip → colorspace → tonemap`, by
 * rank) into single `convert` stages whenever fusion preserves the declared operator order, and append
 * the final output stage. The result is the ordered flat-op stage list one linked pipeline executes.
 */

import { InputError, MediaError } from '../contracts/errors.ts';
import { validateJob } from './job-schema.ts';
import type { MediaJob, MediaJobInput, MediaJobOutput } from './job.ts';
import type {
  ConvertOptions,
  DecryptOptions,
  RemuxOptions,
  TrimOptions,
  VideoTarget,
} from './types.ts';

export type JobStage =
  | { readonly kind: 'convert'; readonly opts: Omit<ConvertOptions, 'sink'> }
  | { readonly kind: 'trim'; readonly opts: Omit<TrimOptions, 'sink'> }
  | { readonly kind: 'remux'; readonly opts: Omit<RemuxOptions, 'sink'> }
  | { readonly kind: 'decrypt'; readonly opts: Omit<DecryptOptions, 'sink'> };

export interface CompiledJob {
  readonly input: MediaJobInput;
  readonly stages: readonly JobStage[];
}

interface PendingVideo {
  readonly target: VideoTarget;
  readonly lastRank: number;
}

export function compileMediaJob(job: MediaJob): CompiledJob {
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
        throw new InputError('unknown declarative job operation');
    }
  }

  if (hasVideoTransform && validated.output.video === false) {
    throw new InputError('declarative video transforms cannot be combined with output.video:false');
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

/** Compile with the schema-error guarantee: anything non-typed becomes a typed `InputError`. */
export function compileMediaJobSafely(job: MediaJob): CompiledJob {
  try {
    return compileMediaJob(job);
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new InputError('declarative job schema validation failed', error);
  }
}

function mergeOutputVideo(
  output: MediaJobOutput['video'],
  pending: VideoTarget | undefined,
): MediaJobOutput['video'] {
  if (pending === undefined) return output;
  if (output === false) {
    throw new InputError('declarative video transforms cannot be combined with output.video:false');
  }
  return { ...(output ?? {}), ...pending };
}

/**
 * The canonical-order rank of the *first* transform a video target carries (crop=0 … tonemap=6), or
 * `undefined` when it carries none. Fusing a pending transform run into a later target is only
 * order-preserving when every pending rank precedes the target's first own transform.
 */
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
