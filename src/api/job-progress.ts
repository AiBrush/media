/**
 * Declarative-job progress mapping (docs/architecture/execution-runtime §3.4): each flat stage owns the
 * `[index, index+1]` window of one monotonic `done/total` timeline. Fractions come from a stage's own
 * `done/total` when finite, clamped so the global timeline never decreases — VFR-honest (never a frame
 * count) and safe against late events from an already-completed stage.
 */

import type { Progress } from '../contracts/driver.ts';
import type { JobStage } from './job-compile.ts';
import type { CallOptions } from './types.ts';

export function stageProgress(
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
