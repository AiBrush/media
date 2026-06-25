/**
 * Worker-side offload runtime (docs/architecture/06 §4/§6, ADR-019) — the counterpart to the host
 * {@link WorkerStreamBridge}. Inside the worker it: receives an {@link OffloadJob}, runs the heavy
 * pipeline (the decode→filter→encode→mux graph) to a `ReadableStream` of Transferable results, and pumps
 * those back to the host under the host's **credit window** (backpressure), forwarding progress. Each
 * result frame is **transferred** to the host (ownership moves — the worker must not `close()` it after a
 * successful post), and on `Cancel`/teardown every frame still on the worker side is `close()`d exactly
 * once (doc 06 §3). A thrown error is serialized to its typed form on the wire.
 *
 * The heavy pipeline itself is supplied as a {@link JobRunner} so this runtime stays driver-agnostic
 * (the engine wires the real WebCodecs/GPU graph into it); that keeps the worker module free of any
 * specific driver and lets the protocol be validated in Node with a synthetic runner.
 */

import { closeFrame } from './frames.ts';
import {
  type HostMessage,
  type MessageLike,
  type OffloadJob,
  type WorkerMessage,
  serializeError,
} from './worker-protocol.ts';

/** A progress sink the worker pipeline calls; forwarded to the host as a `progress` message. */
export type ProgressSink = (p: { done: number; total?: number; stage: string }) => void;

/**
 * Builds the heavy-op result stream for a job. Returns a `ReadableStream` of Transferable results
 * (`VideoFrame`/`AudioData` for a frame stream, `ArrayBuffer` for an encoded/muxed byte stream). It must
 * honor `signal` (abort tears the pipeline down, releasing WebCodecs/WASM and closing in-flight frames)
 * and may report progress. The engine provides the real runner (composing the frozen drivers); a test
 * provides a synthetic one.
 */
export type JobRunner = (
  job: OffloadJob,
  ctx: { signal: AbortSignal; progress: ProgressSink },
) => ReadableStream<Transferable>;

/**
 * Drive one worker scope: announce readiness, then for each `Job` run {@link JobRunner} and pump its
 * results to the host with credit-based backpressure and abortable cancellation. Returns a disposer that
 * detaches the listener (for tests; a real worker lives for the page). One job at a time per worker — the
 * host bridge enforces that, and a pool spreads concurrency.
 *
 * Frame lifetime: a chunk is **transferred** (the worker relinquishes ownership on a successful post); if
 * the post itself throws, the worker `close()`s that frame to avoid a leak. On cancel/error the
 * in-flight + not-yet-sent frames are drained closed. Exactly one close per frame, here or on the host.
 */
export function runOffloadWorker(
  scope: MessageLike<HostMessage, WorkerMessage> & { webcodecs?: boolean },
  runJob: JobRunner,
): () => void {
  let active: AbortController | undefined;
  /** Credit granted by the host but not yet spent producing a chunk (backpressure window). */
  let credit = 0;
  /** Resolves the producer's wait when fresh credit arrives. */
  let creditWaiter: (() => void) | undefined;

  const onMessage = ({ data }: { data: HostMessage }): void => {
    switch (data.t) {
      case 'job':
        credit = data.credit;
        void runOne(data.job);
        break;
      case 'credit':
        credit += data.n;
        creditWaiter?.();
        creditWaiter = undefined;
        break;
      case 'cancel':
        active?.abort(new DOMException('aborted', 'AbortError'));
        creditWaiter?.();
        creditWaiter = undefined;
        break;
      default:
        break;
    }
  };

  const awaitCredit = (signal: AbortSignal): Promise<void> => {
    if (credit > 0 || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      creditWaiter = resolve;
    });
  };

  const runOne = async (job: OffloadJob): Promise<void> => {
    const controller = new AbortController();
    active = controller;
    const { signal } = controller;
    const progress: ProgressSink = (p) => {
      scope.postMessage({
        t: 'progress',
        done: p.done,
        ...(p.total !== undefined ? { total: p.total } : {}),
        stage: p.stage,
      });
    };
    let reader: ReadableStreamDefaultReader<Transferable> | undefined;
    let seq = 0;
    try {
      const stream = runJob(job, { signal, progress });
      reader = stream.getReader();
      for (;;) {
        await awaitCredit(signal);
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        credit -= 1;
        // Transfer the frame to the host: ownership moves, so the worker must NOT close it after this.
        // If the post throws (detached/closed), close it here so it never leaks.
        try {
          scope.postMessage({ t: 'chunk', seq: seq++, frame: value }, [value]);
        } catch (postErr) {
          closeFrame(value);
          throw postErr;
        }
      }
      if (signal.aborted) {
        scope.postMessage({ t: 'error', error: serializeError(abortError()) });
      } else {
        scope.postMessage({ t: 'done' });
      }
    } catch (e) {
      scope.postMessage({ t: 'error', error: serializeError(e) });
    } finally {
      // Drain anything the pipeline still holds: cancel the reader (drivers close their in-flight frames)
      // and clear our credit waiter. Exactly-once close is owned by the driver's cancel + the host.
      if (reader) await reader.cancel(abortError()).catch(() => {});
      creditWaiter = undefined;
      if (active === controller) active = undefined;
    }
  };

  scope.addEventListener('message', onMessage);
  // Announce readiness + whether the worker substrate (WebCodecs) is actually present — the honest gate
  // (the host downgrades to InlineBridge when this is false).
  scope.postMessage({ t: 'ready', webcodecs: scope.webcodecs ?? hasWebCodecs() });
  return () => scope.removeEventListener('message', onMessage);
}

/** True when WebCodecs is available in this worker scope (the real off-main-thread substrate, doc 06 §4). */
function hasWebCodecs(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined';
}

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}
