/**
 * Declarative-job orchestration (docs/architecture/execution-runtime §3.5): compile the validated job,
 * then execute the flat stages as **one linked pipeline**. Stage boundaries are lazy byte streams — the
 * upstream op hands back a pull-based `ReadableStream` sink and the downstream op consumes it directly,
 * so the byte source is opened once, nothing materializes between stages, and WHATWG backpressure spans
 * the whole job (a slow final sink throttles the first demuxer). Materializing is never this layer's
 * decision: input normalization owns random-access buffering when a container genuinely needs it, which
 * keeps this orchestrator capability-agnostic. One `AbortSignal` (parent + `.cancel()` + internal,
 * via {@link runCancellable}) threads into every stage; abort maps to a single typed
 * `MediaError('aborted')`.
 */

import { InputError, MediaError } from '../contracts/errors.ts';
import { runCancellable } from '../kernel/executor.ts';
import { toBlob, toStream } from '../sinks/sink.ts';
import type { MediaInput } from '../sources/source.ts';
import { type JobStage, compileMediaJobSafely } from './job-compile.ts';
import { stageProgress } from './job-progress.ts';
import type { JobEngine, MediaJob } from './job.ts';
import type { CallOptions, Cancellable, Output } from './types.ts';

/** Execute one fully validated declarative job through the engine's real flat operations. */
export function runMediaJob(
  engine: JobEngine,
  job: MediaJob,
  callOptions: CallOptions = {},
): Cancellable<Blob> {
  return runCancellable([callOptions.signal], async (scope) => {
    try {
      // Compile before the first abort checkpoint deliberately: malformed later stages must be rejected
      // without invoking an engine operation or normalizing/reading a one-shot input.
      const compiled = compileMediaJobSafely(job);
      throwIfAborted(scope.signal);
      let input: MediaInput = compiled.input;
      let finalBlob: Blob | undefined;
      let lastProgress = 0;
      const total = compiled.stages.length;

      for (let index = 0; index < total; index++) {
        throwIfAborted(scope.signal);
        const stage = compiled.stages[index];
        if (stage === undefined) {
          throw new InputError('declarative job compiled an empty stage');
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
          signal: scope.signal,
          ...(progress.onProgress !== undefined ? { onProgress: progress.onProgress } : {}),
        };
        const output = await scope.dispatch(
          dispatchStage(engine, input, stage, final, stageOptions),
        );
        throwIfAborted(scope.signal);
        lastProgress = progress.complete(lastProgress);
        if (final) finalBlob = expectFinalBlob(output);
        else input = expectPipeable(output);
      }

      if (finalBlob === undefined) {
        throw new InputError('declarative job produced no final Blob');
      }
      return finalBlob;
    } catch (error) {
      if (scope.signal.aborted) {
        throw new MediaError('aborted', 'operation aborted', error);
      }
      throw error;
    }
  });
}

/**
 * Dispatch one flat stage. Non-final stages take the lazy `stream` sink — the single-pipe boundary —
 * and the final stage keeps the operation's default `Blob` result.
 */
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
        final ? stage.opts : { ...stage.opts, sink: toStream() },
        callOptions,
      );
    case 'trim':
      return engine.trim(
        input,
        { ...stage.opts, sink: final ? toBlob() : toStream() },
        callOptions,
      );
    case 'remux':
      return engine.remux(
        input,
        { ...stage.opts, sink: final ? toBlob() : toStream() },
        callOptions,
      );
    case 'decrypt':
      return engine.decrypt(
        input,
        { ...stage.opts, sink: final ? toBlob() : toStream() },
        callOptions,
      );
    default:
      return stage;
  }
}

/**
 * An intermediate boundary must yield something the next operation can consume as input: the lazy byte
 * stream (the fused fast path) or an already-materialized `Blob` (an operation that had to buffer).
 */
function expectPipeable(output: Output): ReadableStream<Uint8Array> | Blob {
  if (output instanceof ReadableStream || output instanceof Blob) return output;
  throw new InputError('declarative job intermediate sink did not produce pipeable media');
}

function expectFinalBlob(output: Output): Blob {
  if (output instanceof Blob) return output;
  throw new InputError('declarative job final default sink did not produce a Blob');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new MediaError('aborted', 'operation aborted', signal.reason);
}
