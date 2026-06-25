/**
 * Worker bridge (docs/architecture/06 §4, ADR-019) — moves heavy stages off the main thread. The
 * main-thread API is a thin proxy; the engine runs the work behind a {@link WorkerBridge}. Heavy ops
 * default to a real Worker; cheap ops (probe) run inline on the main thread.
 *
 * Two shapes live here:
 *  - {@link InlineBridge} — the main-thread fast path (`worker:false`): runs a closure on the calling
 *    thread with no round-trip. Used for cheap ops and as the honest fallback when no Worker exists.
 *  - {@link WorkerStreamBridge} — the heavy-op offload: ships a serializable {@link OffloadJob} to a
 *    worker and streams the Transferable results back under a **credit window** (backpressure), mapping
 *    a worker-side typed error to its host-side {@link MediaError} subclass and propagating
 *    `AbortSignal` → a `Cancel` message (worker tears down, closes in-flight frames). A job is data, not
 *    a closure (ADR-010), so — unlike `run()` — it survives the thread boundary.
 */

import type { MediaErrorCode } from '../contracts/errors.ts';
import { MediaError } from '../contracts/errors.ts';
import { closeFrame } from './frames.ts';
import {
  type HostMessage,
  type MessageLike,
  type OffloadJob,
  type TerminableTransport,
  type WorkerMessage,
  collectTransferables,
  deserializeError,
} from './worker-protocol.ts';

/** A closure-based unit of work, on a worker or inline depending on the bridge (cheap-op path). */
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

/** Options for a single {@link WorkerStreamBridge.runStream} call. */
export interface RunStreamOptions {
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total?: number; stage: string }) => void;
  /** Wrap a non-typed worker error with this code (the op's own); typed errors pass through unchanged. */
  errorCode?: MediaErrorCode;
  /**
   * Backpressure window: how many result chunks may be in flight before the worker awaits more credit
   * (doc 06 §10). Keeps GPU frames from piling up. Defaults to {@link DEFAULT_CREDIT}.
   */
  credit?: number;
}

/** Default in-flight chunk window — small, so decoded frames never accumulate (doc 06 §3/§10). */
export const DEFAULT_CREDIT = 4;

/**
 * Host-side heavy-op offload over a {@link MessageLike} transport (a real `Worker`, or — in the Node
 * protocol tests — a `MessageChannel` port; the transport is mocked, the bridge logic is real). One
 * bridge owns one worker and serves one job at a time (a worker *pool* — ADR, doc 06 §4 — fans
 * independent jobs across several of these). The constructor takes the transport so the same logic is
 * driven by either a Worker or a channel port.
 */
export class WorkerStreamBridge implements TerminableTransport {
  readonly #port: MessageLike<WorkerMessage, HostMessage>;
  readonly #terminate: (() => void) | undefined;
  #busy = false;
  #terminated = false;

  constructor(port: MessageLike<WorkerMessage, HostMessage>, terminate?: () => void) {
    this.#port = port;
    this.#terminate = terminate;
  }

  /**
   * Run one heavy {@link OffloadJob}, returning a `ReadableStream` of the Transferable results the worker
   * produces (frames for a decode/filter stream, byte buffers for an encode/mux stream). The stream's
   * `pull` grants one credit per consumed chunk so the worker is throttled to the {@link RunStreamOptions.credit}
   * window (backpressure). `signal` abort posts a `Cancel` and errors the stream `aborted`; a worker
   * `error` message is rebuilt to its typed {@link MediaError} subclass and errors the stream. Every
   * received frame is owned by the readable's consumer (close-once, doc 06 §3); an undelivered frame
   * sitting in the internal queue at teardown is `close()`d here so nothing leaks.
   */
  runStream(job: OffloadJob, opts: RunStreamOptions = {}): ReadableStream<Transferable> {
    if (this.#terminated) {
      return errorStream(new MediaError('aborted', 'worker bridge terminated'));
    }
    if (this.#busy) {
      return errorStream(
        new MediaError('decode-error', 'worker bridge is busy (one job at a time; use a pool)'),
      );
    }
    const { signal } = opts;
    if (signal?.aborted) {
      return errorStream(new MediaError('aborted', 'operation aborted'));
    }
    this.#busy = true;
    const credit = opts.credit ?? DEFAULT_CREDIT;
    return this.#pump(job, credit, opts);
  }

  /** Terminate the worker. Idempotent; a real `Worker` is killed, a channel port simply stops. */
  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#terminate?.();
  }

  /**
   * The result pump: a **self-buffered, pull-driven** `ReadableStream` whose lifecycle *is* the credit
   * window. The stream uses a zero-high-water-mark strategy so `pull` fires exactly once per consumer
   * read (no eager internal buffer slack); the bridge holds undelivered frames in its own `queue` so the
   * backpressure bound is exact **and** every received-but-undelivered frame can be `close()`d on
   * teardown (the stream's internal buffer would silently drop — and leak — them).
   *
   * Credit invariant: the worker starts with `credit` permits and may have at most `credit` frames sent
   * that the host has not yet handed to its consumer; the host returns exactly one permit each time the
   * consumer takes a frame, so `queue.length ≤ credit` always (doc 06 §10). `start` posts the job
   * (transferring inputs); `pull` delivers a queued frame (or records pending demand) and replenishes one
   * credit; `cancel`/abort/error posts `Cancel`, drains the queue closed (close-once, doc 06 §3), and
   * settles the stream; a worker `error` is rebuilt to its typed {@link MediaError} subclass.
   */
  #pump(job: OffloadJob, credit: number, opts: RunStreamOptions): ReadableStream<Transferable> {
    const port = this.#port;
    const { signal } = opts;
    let controller!: ReadableStreamDefaultController<Transferable>;
    let settled = false;
    /** Frames received from the worker but not yet delivered to the consumer (host-owned until taken). */
    const queue: Transferable[] = [];
    /** The consumer has an outstanding `pull` waiting for the next frame (HWM=0 ⇒ at most one). */
    let demand = false;
    /** The worker sent `done`; close the stream once the buffered tail has drained to the consumer. */
    let producerDone = false;
    // biome-ignore lint/style/useConst: forward-declared so cleanup() (below) and the later-assigned message handler can reference each other across the close/drain cycle.
    let onMessage!: (ev: { data: WorkerMessage }) => void;
    let onAbort: (() => void) | undefined;

    const cleanup = (): void => {
      port.removeEventListener('message', onMessage);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      this.#busy = false;
    };
    const drainQueue = (): void => {
      // Close any frame the consumer never took (cancel/error path) — exactly once each (doc 06 §3).
      while (queue.length > 0) closeFrame(queue.shift());
    };
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      drainQueue();
      cleanup();
      controller.error(e);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.close();
    };
    /** Deliver one queued frame to a waiting consumer and return a freed credit to the worker. */
    const deliverOne = (): void => {
      const frame = queue.shift();
      if (frame === undefined) return;
      demand = false;
      controller.enqueue(frame);
      // Permit the next frame only while the producer is still running; after `done` there is no more.
      if (!settled && !producerDone) post(port, { t: 'credit', n: 1 });
      // The producer is done and this was the last buffered frame → close after the consumer drained it.
      if (producerDone && queue.length === 0) finish();
    };

    onMessage = ({ data }): void => {
      if (settled) {
        // Already torn down (cancel/error/done) but a chunk was in transit when we settled: the host owns
        // that transferred frame, so close it here — dropping it would leak (doc 06 §3, close-once).
        if (data.t === 'chunk') closeFrame(data.frame);
        return;
      }
      switch (data.t) {
        case 'chunk':
          // The host is now the frame's sole owner (transferred). Buffer it; deliver immediately if the
          // consumer is waiting, else it waits in `queue` (and is closed there should we tear down).
          queue.push(data.frame);
          if (demand) deliverOne();
          break;
        case 'progress':
          opts.onProgress?.({
            done: data.done,
            ...(data.total !== undefined ? { total: data.total } : {}),
            stage: data.stage,
          });
          break;
        case 'done':
          // No more frames will arrive. Close now if the buffer is already empty, else mark done and let
          // the consumer's pulls drain the tail (the last `deliverOne` then closes the stream).
          producerDone = true;
          if (queue.length === 0) finish();
          else if (demand) deliverOne();
          break;
        case 'error':
          fail(deserializeError(data.error, opts.errorCode));
          break;
        case 'ready':
          // A late `ready` (worker re-announce) is benign for an in-flight job; ignore.
          break;
        default:
          break;
      }
    };

    return new ReadableStream<Transferable>(
      {
        start: (c): void => {
          controller = c;
          port.addEventListener('message', onMessage);
          if (signal) {
            onAbort = (): void => {
              // Tell the worker to stop (it closes its in-flight frames), then error + drain locally.
              post(port, { t: 'cancel' });
              fail(new MediaError('aborted', 'operation aborted'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
          }
          // Post the job, transferring the input byte buffers (moved, not copied — doc 06 §4). The
          // initial `credit` is the backpressure window the worker may fill before awaiting more.
          const transfer = collectTransferables(job.payload);
          post(port, { t: 'job', job, credit }, transfer);
        },
        pull: (): void => {
          if (settled) return;
          // Consumer wants the next frame: hand over a buffered one (freeing a worker credit), else record
          // the demand so the next arriving chunk is delivered straight through.
          if (queue.length > 0) deliverOne();
          else demand = true;
        },
        cancel: (reason): void => {
          if (settled) return;
          settled = true;
          post(port, { t: 'cancel' });
          drainQueue();
          cleanup();
          void reason;
        },
      },
      new CountQueuingStrategy({ highWaterMark: 0 }),
    );
  }
}

/**
 * Decide whether heavy ops can actually be offloaded to a Worker in this environment — the honest gate
 * for the inline fallback (Prime Directive 6 / ADR-025). Returns `true` only when the `Worker`
 * constructor exists; the deeper "WebCodecs runs *inside* the worker" check is answered by the worker's
 * `ready.webcodecs` handshake (the host downgrades to {@link InlineBridge} when a freshly-spawned worker
 * reports `webcodecs:false`). Never assumes isolation that isn't there.
 */
export function workerOffloadAvailable(): boolean {
  return typeof Worker === 'function';
}

// ── Internals ───────────────────────────────────────────────────────────────────────────────────

/** Post a host message; the `transfer` list moves the input Transferables (frames/buffers) by reference. */
function post(
  port: MessageLike<WorkerMessage, HostMessage>,
  msg: HostMessage,
  transfer?: readonly Transferable[],
): void {
  if (transfer && transfer.length > 0) port.postMessage(msg, transfer);
  else port.postMessage(msg);
}

/** A readable that immediately errors — the uniform shape for a pre-rejected `runStream` (busy/aborted). */
function errorStream(e: Error): ReadableStream<Transferable> {
  return new ReadableStream<Transferable>({
    start(c): void {
      c.error(e);
    },
  });
}
