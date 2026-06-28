/**
 * Worker pool / ABR rendition fan-out (docs/architecture/06 §4, ADR-019) — the substrate for running
 * **K independent heavy jobs across N workers** concurrently (one job per worker; the pipeline is already
 * streamed, so a single job stays on a single worker). The motivating case is an **ABR ladder**: one
 * source → a ladder of `convert` renditions (1080p, 720p, 480p, …) encoded in parallel, each a self-
 * contained {@link OffloadJob}.
 *
 * Design:
 *  - The pool owns N {@link WorkerStreamBridge}s. Each bridge serves **one** job at a time (its busy-guard);
 *    the pool's free-worker queue guarantees a worker is never handed a second concurrent job, so the
 *    "bridge is busy" rejection can never escape.
 *  - `runMany(jobs)` is **work-stealing**: a worker pulls the next queued job the instant its current
 *    result stream finishes (or errors / is cancelled), so N workers stay saturated until the queue drains.
 *    Concurrency is exactly `min(N, K)`.
 *  - Each returned stream is the worker's Transferable result stream (encoded bytes for a `convert`/`trim`
 *    rendition). Because a transfer **detaches** the input `ArrayBuffer`, the ABR helper gives each
 *    rendition its **own copy** of the source bytes (a worker must own a transferable buffer) — unavoidable
 *    and explicit.
 *  - `abortAll()` cancels every in-flight job (the worker tears its pipeline down, closing frames) and
 *    discards the queue so a not-yet-started job never runs.
 *  - With no `Worker`, {@link inlineWorkerPool} runs jobs sequentially on a single {@link InlineBridge} —
 *    the honest fallback (Prime Directive 6), never a fake "parallel" claim.
 *
 * Frame lifetime: on the convert/trim offload path no `VideoFrame`/`AudioData` crosses the boundary (only
 * encoded bytes do — see `worker-main.ts`), so the pool moves byte buffers; any frame-shaped Transferable
 * (used only by the synthetic tests) is owned by the stream's consumer per the bridge's close-once rule.
 */

import { MediaError } from '../contracts/errors.ts';
import { InlineBridge, type RunStreamOptions, type WorkerStreamBridge } from './worker-bridge.ts';
import type { OffloadJob } from './worker-protocol.ts';

/** Spawn one host-side {@link WorkerStreamBridge} (a real `Worker` in production; a channel in tests). */
export type WorkerPoolTransport = () => WorkerStreamBridge;

/** Options for a {@link WorkerPool}. */
export interface WorkerPoolOptions {
  /** Number of worker bridges to spawn (≥ 1). Clamped defensively. */
  readonly size: number;
  /** How to spawn each bridge (injected so production uses a real `Worker`, tests a channel). */
  readonly transport: WorkerPoolTransport;
}

/**
 * One job awaiting a free worker. `attach` is called when the scheduler dispatches it onto a bridge; it
 * hands the bridge's result reader to the already-returned wrapper stream (which has been waiting in its
 * `pull`). `fail` rejects a queued job that is aborted before it ever dispatches.
 */
interface PendingJob {
  readonly job: OffloadJob;
  readonly opts: RunStreamOptions;
  readonly attach: (
    reader: ReadableStreamDefaultReader<Transferable>,
    ctrl: AbortController,
  ) => void;
  readonly fail: (e: Error) => void;
}

/**
 * A pool of N worker bridges that fans independent {@link OffloadJob}s across them with bounded
 * concurrency and per-worker serialization (work-stealing). One job per worker at a time.
 */
export class WorkerPool {
  readonly #bridges: WorkerStreamBridge[];
  /** Bridges not currently running a job (the free list the scheduler pops from). */
  readonly #idle: WorkerStreamBridge[];
  readonly #queue: PendingJob[] = [];
  /** In-flight controllers, one per running job, so {@link abortAll} can cancel each. */
  readonly #inFlight = new Set<AbortController>();
  #terminated = false;

  constructor(options: WorkerPoolOptions) {
    const size = Math.max(1, Math.floor(options.size));
    this.#bridges = Array.from({ length: size }, () => options.transport());
    this.#idle = [...this.#bridges];
  }

  /** The number of worker bridges in the pool. */
  get size(): number {
    return this.#bridges.length;
  }

  /**
   * Run one job, returning its Transferable result stream **immediately** (even while the job is queued
   * behind busy workers). The handle is a lazy wrapper: its first `pull` blocks until the scheduler
   * dispatches the job onto a free worker, then forwards the worker's chunks. This decoupling is what lets
   * a caller `await runMany(...)` to get K stream handles up front and drain them in parallel — *draining*
   * is what drives the queue, so there is no dispatch ↔ drain deadlock. The worker rejoins the free list
   * when its stream settles (close/error/cancel), dispatching the next queued job. The job is registered
   * with {@link abortAll} and honors a per-call {@link RunStreamOptions.signal}.
   */
  run(job: OffloadJob, opts: RunStreamOptions = {}): ReadableStream<Transferable> {
    return this.#deferredResultStream(job, opts);
  }

  /**
   * Alias of {@link run} with the {@link WorkerStreamBridge.runStream} name + signature, so a pool and a
   * single bridge are **structurally interchangeable** as a job-stream runner (the engine's `offloadHeavyOp`
   * accepts either: a pool of N for `{pool:N}`/concurrent ops, a single-worker pool otherwise). Unlike a
   * lone bridge, the pool never rejects a concurrent second job with "busy" — it queues it behind the N
   * workers, so concurrent `convert`/`trim` calls fan across the pool instead of colliding.
   */
  runStream(job: OffloadJob, opts: RunStreamOptions = {}): ReadableStream<Transferable> {
    return this.#deferredResultStream(job, opts);
  }

  /**
   * Run K jobs concurrently across the pool, returning K result streams **in input order** — each a lazy
   * handle the caller drains in parallel (draining drives dispatch). This is the ABR fan-out entry: pass
   * the rendition ladder, get a stream per rendition.
   */
  runMany(
    jobs: readonly OffloadJob[],
    opts: RunStreamOptions = {},
  ): ReadableStream<Transferable>[] {
    return jobs.map((job) => this.run(job, opts));
  }

  /**
   * Abort every in-flight job (the worker tears its pipeline down, closing in-flight frames) and discard
   * the queue so a not-yet-dispatched job never starts (its stream errors `aborted` on first read). The
   * pool stays usable for new `run` calls afterwards (the bridges are not terminated).
   */
  abortAll(): void {
    for (const ctrl of [...this.#inFlight]) {
      ctrl.abort(new MediaError('aborted', 'worker pool job aborted'));
    }
    const queued = this.#queue.splice(0);
    for (const pending of queued) {
      pending.fail(new MediaError('aborted', 'worker pool job aborted before dispatch'));
    }
  }

  /** Terminate every worker (idempotent). In-flight + queued jobs are aborted/rejected first. */
  async terminate(): Promise<void> {
    if (this.#terminated) return;
    this.#terminated = true;
    this.abortAll();
    for (const bridge of this.#bridges) bridge.terminate();
    // Let any abort propagation settle before returning (mirrors WorkerBridge.terminate being async).
    await Promise.resolve();
  }

  /**
   * Build the lazy result-stream handle for a job and enqueue the job. The handle's `pull` awaits the
   * `attach` the scheduler calls on dispatch (it resolves a one-shot "dispatched" promise carrying the
   * worker's reader + the per-job controller), then forwards chunks; cancelling the handle aborts the job.
   */
  #deferredResultStream(job: OffloadJob, opts: RunStreamOptions): ReadableStream<Transferable> {
    if (this.#terminated) {
      return errorStream(new MediaError('aborted', 'worker pool terminated'));
    }
    let dispatched:
      | { reader: ReadableStreamDefaultReader<Transferable>; ctrl: AbortController }
      | undefined;
    let dispatchError: Error | undefined;
    let resolveDispatch: (() => void) | undefined;
    const dispatchReady = new Promise<void>((resolve) => {
      resolveDispatch = resolve;
    });
    const pending: PendingJob = {
      job,
      opts,
      attach: (reader, ctrl) => {
        dispatched = { reader, ctrl };
        resolveDispatch?.();
      },
      fail: (e) => {
        dispatchError = e;
        resolveDispatch?.();
      },
    };
    this.#queue.push(pending);
    // Schedule on a microtask so the caller holds the stream before the (synchronous) bridge starts.
    queueMicrotask(() => this.#pump());

    return new ReadableStream<Transferable>(
      {
        async pull(controller): Promise<void> {
          if (dispatched === undefined && dispatchError === undefined) await dispatchReady;
          if (dispatchError !== undefined) {
            controller.error(dispatchError);
            return;
          }
          // `dispatched` is set once `dispatchReady` resolves without a `dispatchError`.
          const reader = (dispatched as NonNullable<typeof dispatched>).reader;
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        },
        async cancel(reason): Promise<void> {
          if (dispatched !== undefined) {
            dispatched.ctrl.abort(reason);
            await dispatched.reader.cancel(reason).catch(() => {});
          }
        },
      },
      new CountQueuingStrategy({ highWaterMark: 0 }),
    );
  }

  /** Dispatch queued jobs to idle workers until one of the two runs dry. */
  #pump(): void {
    while (this.#queue.length > 0 && this.#idle.length > 0) {
      const bridge = this.#idle.pop();
      const pending = this.#queue.shift();
      if (bridge === undefined || pending === undefined) break;
      this.#dispatch(bridge, pending);
    }
  }

  /**
   * Start one job on a specific bridge: wire a per-job AbortController (so `abortAll`/the caller's signal
   * tears it down), run the bridge stream, and hand a **completion-observing reader** to the waiting
   * handle. When that reader settles (close/error/cancel) the bridge rejoins the free list and the next
   * queued job dispatches. The observing wrapper forwards each chunk by reference (ownership still moves
   * straight to the consumer — no re-buffering, no double close).
   */
  #dispatch(bridge: WorkerStreamBridge, pending: PendingJob): void {
    const ctrl = new AbortController();
    this.#inFlight.add(ctrl);
    const callerSignal = pending.opts.signal;
    if (callerSignal) {
      if (callerSignal.aborted) ctrl.abort(callerSignal.reason);
      else {
        callerSignal.addEventListener('abort', () => ctrl.abort(callerSignal.reason), {
          once: true,
        });
      }
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#inFlight.delete(ctrl);
      if (!this.#terminated) {
        this.#idle.push(bridge);
        this.#pump();
      }
    };

    const workerStream = bridge.runStream(pending.job, { ...pending.opts, signal: ctrl.signal });
    pending.attach(observeCompletion(workerStream, release).getReader(), ctrl);
  }
}

/**
 * Wrap a result stream so `onSettled` fires exactly once when it closes, errors, or is cancelled — the
 * signal the pool uses to return a worker to the free list. A transparent pass-through `TransformStream`
 * would re-buffer transferred frames (and risk a second close); instead a thin {@link ReadableStream}
 * adapter forwards each chunk by reference (ownership still moves straight to the consumer) and hooks the
 * three terminal transitions. Backpressure is preserved (HWM 0 ⇒ one `pull` per consumer read).
 */
function observeCompletion(
  stream: ReadableStream<Transferable>,
  onSettled: () => void,
): ReadableStream<Transferable> {
  const reader = stream.getReader();
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    onSettled();
  };
  return new ReadableStream<Transferable>(
    {
      async pull(controller): Promise<void> {
        try {
          const { done, value } = await reader.read();
          if (done) {
            settle();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (e) {
          settle();
          controller.error(e);
        }
      },
      async cancel(reason): Promise<void> {
        settle();
        await reader.cancel(reason).catch(() => {});
      },
    },
    new CountQueuingStrategy({ highWaterMark: 0 }),
  );
}

/** A readable that immediately errors — the uniform shape for a pre-rejected pool result (terminated). */
function errorStream(e: Error): ReadableStream<Transferable> {
  return new ReadableStream<Transferable>({
    start(c): void {
      c.error(e);
    },
  });
}

// ── inline fallback (no Worker) ──────────────────────────────────────────────────────────────────────

/**
 * A sequential, no-Worker pool over a single {@link InlineBridge} — the honest fallback when
 * `workerOffloadAvailable()` is false. It runs caller-supplied inline tasks (closures) one after another
 * on the calling thread (no fan-out is possible without workers; claiming parallelism would be a fake).
 * The ABR ladder still completes — just serially — so the public op never fails for lack of a Worker.
 */
export interface InlineWorkerPool {
  /** The backing bridge (an {@link InlineBridge}); exposed so callers can assert the fallback path. */
  readonly bridge: InlineBridge;
  /** Run K inline tasks sequentially, resolving with their results in order. */
  run<T>(tasks: ReadonlyArray<() => Promise<T>>): Promise<T[]>;
}

/** Build the sequential inline fallback pool. */
export function inlineWorkerPool(): InlineWorkerPool {
  const bridge = new InlineBridge();
  return {
    bridge,
    async run<T>(tasks: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
      const out: T[] = [];
      for (const task of tasks) out.push(await bridge.run(task));
      return out;
    },
  };
}
