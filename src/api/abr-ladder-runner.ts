/**
 * H.264 ABR ladder orchestration, lazy because it is a specialized multi-output operation.
 */

import type { StageOptions } from '../contracts/driver.ts';
import { InputError, MediaError } from '../contracts/errors.ts';
import type { OffloadPoolCache } from '../kernel/worker-host.ts';
import type { WorkerSelection } from '../kernel/worker-mode.ts';
import { toBlob } from '../sinks/sink.ts';
import type { MaterializeOptions } from '../sinks/sink.ts';
import type { MediaInput } from '../sources/source.ts';
import { materializeOutput, normalizeByteInput } from './op-support.ts';
import { readAllSource, throwIfAborted } from './source-io.ts';
import { H264_ABR_MAX_RETAINED_OUTPUT_BYTES, H264_ABR_MAX_SOURCE_BYTES } from './types.ts';
import type { CallOptions, ConvertOptions, H264AbrRung, Output } from './types.ts';

export interface AbrLadderRunnerContext {
  workerMode: WorkerSelection;
  poolCache: OffloadPoolCache;
  poolSize: number;
  stage: StageOptions;
  convert(input: Uint8Array, opts: ConvertOptions, options: CallOptions): Promise<Output>;
}

export async function runH264AbrLadder(
  context: AbrLadderRunnerContext,
  input: MediaInput,
  ladder: readonly H264AbrRung[],
  options: CallOptions,
  signal: AbortSignal,
): Promise<readonly Output[]> {
  const source = normalizeByteInput(input, 'h264AbrLadder');
  const { planH264AbrLadder } = await import('./video-stream-plan.ts');
  const planned = planH264AbrLadder(ladder, { width: undefined, height: undefined });
  assertAbrDeclaredSourceSize(source);

  if (context.workerMode === 'offload') {
    /* v8 ignore start -- worker pool requires a browser Worker; browser-harness validated. */
    const { abrLadderCapsSatisfy, ensureOffloadPool, offloadAbrLadder } = await import(
      '../kernel/worker-host.ts'
    );
    const pool = await ensureOffloadPool(context.poolCache, context.poolSize);
    const renditions = planned.map((rung) => ({ opts: withoutSink(rung.options) }));
    if (pool !== null && abrLadderCapsSatisfy(pool.caps, renditions)) {
      const operation = new AbortController();
      const unlinkCaller = linkAbrSignal(signal, operation);
      try {
        const streams = await offloadAbrLadder(pool, source, renditions, {
          ...context.stage,
          signal: operation.signal,
        });
        const budget = abrRetainedOutputBudget();
        const materializations = streams.map((stream) =>
          materializeOutput(
            toBlob(),
            boundAbrOutputStream(stream, budget),
            mp4MaterializeOptions(operation.signal),
          ),
        );
        try {
          const outputs = await Promise.all(materializations);
          assertAbrPublishedOutputBudget(outputs);
          return outputs;
        } catch (error) {
          if (!operation.signal.aborted) operation.abort(error);
          await Promise.allSettled(materializations);
          throw error;
        }
      } finally {
        unlinkCaller();
      }
    }
    /* v8 ignore stop */
  }

  const bytes = await readAllSource(source, signal, H264_ABR_MAX_SOURCE_BYTES);
  const outputs: Output[] = [];
  const budget = abrRetainedOutputBudget();
  for (const rung of planned) {
    throwIfAborted(signal);
    // Shared source bytes: `bytes` is not mutated by `convert` (it copies internally if needed),
    // so per-rung `slice()` would duplicate the entire source for no correctness benefit.
    // Reusing the same `Uint8Array` keeps the ABR fan-out within the retained-output budget and
    // preserves single-source demux/decoding at the byte level (REQUIREMENTS §5.5 fan-out).
    const output = await context.convert(bytes, rung.options, { ...options, signal });
    budget.charge(outputByteLength(output));
    outputs.push(output);
  }
  assertAbrPublishedOutputBudget(outputs);
  return outputs;
}

export interface AbrRetainedOutputBudget {
  readonly retainedBytes: number;
  readonly maximumBytes: number;
  charge(bytes: number): void;
}

/** Shared byte counter used across concurrently materializing rung streams. */
export function abrRetainedOutputBudget(
  maximumBytes = H264_ABR_MAX_RETAINED_OUTPUT_BYTES,
): AbrRetainedOutputBudget {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new InputError('ABR retained-output budget must be a positive safe integer');
  }
  let retainedBytes = 0;
  return {
    get retainedBytes(): number {
      return retainedBytes;
    },
    maximumBytes,
    charge(bytes): void {
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new MediaError('mux-error', 'ABR output reported an invalid byte length', { bytes });
      }
      if (bytes > maximumBytes - retainedBytes) {
        throw new MediaError(
          'mux-error',
          `H.264 ABR ladder exceeds the ${maximumBytes}-byte cumulative retained-output limit`,
          { retainedBytes, nextBytes: bytes, maximumBytes },
        );
      }
      retainedBytes += bytes;
    },
  };
}

/** Charge chunks before the Blob collector retains them; a failure cancels the producing rung stream. */
export function boundAbrOutputStream(
  stream: ReadableStream<Uint8Array>,
  budget: AbrRetainedOutputBudget,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller): void {
        budget.charge(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
  );
}

function assertAbrPublishedOutputBudget(outputs: readonly Output[]): void {
  let total = 0;
  for (const output of outputs) {
    const bytes = outputByteLength(output);
    if (bytes > H264_ABR_MAX_RETAINED_OUTPUT_BYTES - total) {
      throw new MediaError(
        'mux-error',
        `H.264 ABR ladder exceeds the ${H264_ABR_MAX_RETAINED_OUTPUT_BYTES}-byte cumulative retained-output limit`,
        {
          retainedBytes: total,
          nextBytes: bytes,
          maximumBytes: H264_ABR_MAX_RETAINED_OUTPUT_BYTES,
        },
      );
    }
    total += bytes;
  }
}

function outputByteLength(output: Output): number {
  if (output === undefined) return 0;
  if (output instanceof Blob) return output.size;
  throw new MediaError(
    'mux-error',
    'H.264 ABR ladder must materialize each rendition as a Blob before atomic publication',
  );
}

function assertAbrDeclaredSourceSize(source: { readonly size?: number }): void {
  if (source.size !== undefined && source.size > H264_ABR_MAX_SOURCE_BYTES) {
    throw new InputError(
      `H.264 ABR source exceeds the ${H264_ABR_MAX_SOURCE_BYTES}-byte operation limit`,
      { sourceBytes: source.size, maximumSourceBytes: H264_ABR_MAX_SOURCE_BYTES },
    );
  }
}

function linkAbrSignal(caller: AbortSignal, operation: AbortController): () => void {
  const onAbort = (): void => operation.abort(caller.reason);
  if (caller.aborted) operation.abort(caller.reason);
  else caller.addEventListener('abort', onAbort, { once: true });
  return () => caller.removeEventListener('abort', onAbort);
}

function withoutSink(opts: ConvertOptions): {
  readonly sink?: unknown;
  readonly [key: string]: unknown;
} {
  const { sink: _sink, ...rest } = opts;
  return { ...rest };
}

function mp4MaterializeOptions(signal: AbortSignal): MaterializeOptions {
  return { signal, mime: 'video/mp4' };
}
