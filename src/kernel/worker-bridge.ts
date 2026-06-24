/**
 * Worker bridge (docs/architecture/06 §4, ADR-019) — moves heavy stages off the main thread. The
 * main-thread API is a thin proxy; the engine runs the work behind a {@link WorkerBridge}. Heavy ops
 * default to a real Worker (Phase 1); cheap ops (probe) run inline on the main thread.
 *
 * {@link InlineBridge} is the main-thread fast path (`worker: false`): it runs the task on the calling
 * thread with no round-trip. The serializing Worker-backed bridge is added in Phase 1/3 behind this
 * same interface.
 */

export interface WorkerBridge {
  /** Run a unit of work, on a worker or inline depending on the bridge. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Release any worker resources. Idempotent. */
  terminate(): Promise<void>;
}

/** Runs work synchronously on the calling thread (no worker hop). */
export class InlineBridge implements WorkerBridge {
  run<T>(task: () => Promise<T>): Promise<T> {
    return task();
  }

  terminate(): Promise<void> {
    return Promise.resolve();
  }
}
