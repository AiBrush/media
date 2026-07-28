/**
 * H.264 ABR ladder orchestration, lazy because it is a specialized multi-output operation.
 */

import type { StageOptions } from '../contracts/driver.ts';
import type { OffloadPoolCache } from '../kernel/worker-host.ts';
import type { WorkerSelection } from '../kernel/worker-mode.ts';
import { toBlob } from '../sinks/sink.ts';
import type { MaterializeOptions } from '../sinks/sink.ts';
import type { MediaInput } from '../sources/source.ts';
import { materializeOutput, normalizeByteInput } from './op-support.ts';
import { readAllSource, throwIfAborted } from './source-io.ts';
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

  if (context.workerMode === 'offload') {
    /* v8 ignore start -- worker pool requires a browser Worker; browser-harness validated. */
    const { ensureOffloadPool, offloadAbrLadder } = await import('../kernel/worker-host.ts');
    const pool = await ensureOffloadPool(context.poolCache, context.poolSize);
    if (pool !== null) {
      const streams = await offloadAbrLadder(
        pool,
        source,
        planned.map((rung) => ({ opts: withoutSink(rung.options) })),
        context.stage,
      );
      return Promise.all(
        streams.map((stream) => materializeOutput(toBlob(), stream, mp4MaterializeOptions(signal))),
      );
    }
    /* v8 ignore stop */
  }

  const bytes = await readAllSource(source, signal);
  const outputs: Output[] = [];
  for (const rung of planned) {
    throwIfAborted(signal);
    outputs.push(await context.convert(bytes.slice(), rung.options, { ...options, signal }));
  }
  return outputs;
}

function withoutSink(opts: ConvertOptions): {
  readonly sink?: unknown;
  readonly [key: string]: unknown;
} {
  const { sink, ...rest } = opts;
  return sink === undefined ? { ...rest } : { ...rest, sink };
}

function mp4MaterializeOptions(signal: AbortSignal): MaterializeOptions {
  return { signal, mime: 'video/mp4' };
}
