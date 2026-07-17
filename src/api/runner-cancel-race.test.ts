import { describe, expect, it, vi } from 'vitest';
import { MediaError } from '../contracts/errors.ts';
import type { MediaInput } from '../sources/source.ts';
import { runMediaChain } from './chain-runner.ts';
import { createMediaChain } from './chain.ts';
import type { ChainEngine } from './chain.ts';
import { runMediaJob } from './job-runner.ts';
import type { JobEngine } from './job.ts';
import type { Cancellable, Output } from './types.ts';

/**
 * The cancel-during-dispatch race (execution-runtime §5 item 8): a hook aborts synchronously while the
 * engine operation is still returning its handle — before the abort listener can see a tracked op. All
 * three orchestrators share one `runCancellable` implementation, so one scenario must hold for each:
 * the freshly returned handle is still cancelled, exactly once, and the run rejects instead of hanging.
 */

interface RaceHost {
  readonly engine: ChainEngine & JobEngine;
  readonly parent: AbortController;
  readonly cancel: ReturnType<typeof vi.fn>;
}

function raceHost(): RaceHost {
  const parent = new AbortController();
  let rejectActive: (reason: unknown) => void = () => undefined;
  const cancel = vi.fn(() => rejectActive(new MediaError('aborted', 'race op cancelled')));
  const dispatch = (): Cancellable<Output> => {
    // Abort synchronously mid-dispatch: the runner has no handle yet, so only the explicit
    // race-close inside the shared scope can reach this op.
    parent.abort();
    const pending = new Promise<Output>((_resolve, reject) => {
      rejectActive = reject;
    }) as Cancellable<Output>;
    pending.cancel = cancel;
    return pending;
  };
  const engine: ChainEngine & JobEngine = {
    convert: dispatch,
    trim: dispatch,
    remux: dispatch,
    decrypt: dispatch,
  };
  return { engine, parent, cancel };
}

const input: MediaInput = new Uint8Array([1, 2, 3]);

describe('shared cancel-during-dispatch race', () => {
  it('job runner: the mid-dispatch abort still cancels the returned handle exactly once', async () => {
    const { engine, parent, cancel } = raceHost();
    const error = await runMediaJob(
      engine,
      { input, ops: [], output: { container: 'mp4' } },
      { signal: parent.signal },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('aborted');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('chain runner: the mid-dispatch abort still cancels the returned handle exactly once', async () => {
    const { engine, parent, cancel } = raceHost();
    const error = await runMediaChain(
      engine,
      input,
      [{ method: 'convert', args: [{ to: 'mp4' }] }],
      'blob',
      [{ signal: parent.signal }],
      new AbortController().signal,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('aborted');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('fluent builder: the mid-dispatch abort still cancels the returned handle exactly once', async () => {
    const { engine, parent, cancel } = raceHost();
    const error = await createMediaChain(engine, input)
      .convert({ to: 'mp4' })
      .blob({ signal: parent.signal })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('aborted');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
