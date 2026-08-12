/** Lazy stream-link and cancellable-task primitives used by operation runners, not the eager core API. */

export interface LazyPipeThroughOptions<U> {
  /** Called if a downstream enqueue loses a cancellation/error race and the produced value owns resources. */
  closeValue?: (value: U) => void;
}

/** Defer construction of a transform until the downstream reader first pulls. */
export function lazyPipeThrough<T, U>(
  source: ReadableStream<T>,
  createStage: () => TransformStream<T, U>,
  opts: LazyPipeThroughOptions<U> = {},
): ReadableStream<U> {
  let reader: ReadableStreamDefaultReader<U> | undefined;
  let cancelPromise: Promise<void> | undefined;

  const ensureReader = (): ReadableStreamDefaultReader<U> => {
    if (reader !== undefined) return reader;
    reader = source.pipeThrough(createStage()).getReader();
    return reader;
  };

  return new ReadableStream<U>(
    {
      async pull(controller): Promise<void> {
        const active = ensureReader();
        const { done, value } = await active.read();
        if (done) {
          controller.close();
          return;
        }
        try {
          controller.enqueue(value);
        } catch (error) {
          opts.closeValue?.(value);
          throw error;
        }
      },
      cancel(reason): Promise<void> {
        // Before the first pull there is no pipe/reader to own upstream cancellation, so cancel the
        // source itself. Once `ensureReader()` runs, ownership moves synchronously to the pipe reader.
        // Memoizing the operation makes that hand-off exact-once even when cancellation races a pull.
        cancelPromise ??= (
          reader === undefined ? source.cancel(reason) : reader.cancel(reason)
        ).catch(() => {});
        return cancelPromise;
      },
    },
    { highWaterMark: 0 },
  );
}

/** A promise that also exposes cooperative `.cancel()` — the runtime's op-handle shape (ADR-012). */
export type CancellableTask<T> = Promise<T> & { cancel(): void };

export interface CancellableScope {
  /** The one linked signal every inner operation must receive. */
  readonly signal: AbortSignal;
  /** Track one inner cancellable operation so linked abort reaches its handle. */
  dispatch<U>(op: CancellableTask<U>): Promise<U>;
}

/** Link parent signals, an internal controller, and the active inner cancellable operation. */
export function runCancellable<T>(
  parents: readonly (AbortSignal | undefined)[],
  run: (scope: CancellableScope) => Promise<T>,
): CancellableTask<T> {
  const controller = new AbortController();
  const links: { readonly signal: AbortSignal; readonly onAbort: () => void }[] = [];
  let active: { cancel(): void } | undefined;
  let cancelled: { cancel(): void } | undefined;
  const cancelActive = (): void => {
    const current = active;
    if (current === undefined || current === cancelled) return;
    cancelled = current;
    try {
      current.cancel();
    } catch {
      // The linked abort remains the primary cancellation fact; a throwing cancel hook cannot mask it.
    }
  };
  const abortWith = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const parent of parents) {
    if (parent === undefined) continue;
    if (parent.aborted) {
      abortWith(parent.reason);
      break;
    }
    const onAbort = (): void => abortWith(parent.reason);
    parent.addEventListener('abort', onAbort, { once: true });
    links.push({ signal: parent, onAbort });
  }
  controller.signal.addEventListener('abort', cancelActive);
  const scope: CancellableScope = {
    signal: controller.signal,
    dispatch<U>(op: CancellableTask<U>): Promise<U> {
      cancelled = undefined;
      active = op;
      if (controller.signal.aborted) cancelActive();
      return Promise.resolve(op);
    },
  };
  const promise = (async (): Promise<T> => {
    try {
      return await run(scope);
    } finally {
      controller.signal.removeEventListener('abort', cancelActive);
      for (const link of links) link.signal.removeEventListener('abort', link.onAbort);
    }
  })() as CancellableTask<T>;
  promise.cancel = (): void => {
    abortWith(undefined);
    cancelActive();
  };
  return promise;
}
