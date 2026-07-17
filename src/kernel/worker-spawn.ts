/**
 * Worker spawn + readiness handshake (doc 06 §4, ADR-019/ADR-025; split out of `worker-host.ts` per
 * punch-list 5). Owns exactly one concern: turn "maybe this environment can offload" into a live,
 * handshaken {@link WorkerStreamBridge} (or pool) — or `undefined`, the honest inline fallback. The
 * `spawn` seam is injectable so the handshake/downgrade policy is proven in Node over a channel; only
 * `defaultSpawn` (a real DOM `Worker`) is browser-only.
 */

import { MediaError } from '../contracts/errors.ts';
import { WorkerStreamBridge } from './worker-bridge.ts';
import { WorkerPool } from './worker-pool.ts';
import type {
  HostMessage,
  MessageLike,
  WorkerMediaCaps,
  WorkerMessage,
} from './worker-protocol.ts';

/** A spawned dedicated worker as the bridge needs it (a duplex message port that can also terminate). */
export interface SpawnedWorker extends MessageLike<WorkerMessage, HostMessage> {
  terminate(): void;
}

/** How {@link ensureWorkerBridge} obtains a worker — a real `Worker` in production, a fake in Node tests. */
export type WorkerSpawn = () => SpawnedWorker | undefined;

/** Default worker readiness handshake budget (ms): generous for a cold module-worker boot, still bounded. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Spawn a module `Worker` and await its readiness handshake, resolving to a host {@link WorkerStreamBridge}
 * carrying the worker's announced {@link WorkerMediaCaps} — or `undefined` (route inline, the honest
 * fallback). A spawn throw, a handshake timeout, or a worker with **no** capable media kind all downgrade
 * cleanly (the useless worker is terminated). A *partially* capable worker (e.g. audio-only) is kept: the
 * per-op gate (`tryOffload`) later matches each job's needed kinds against these caps (punch-list 6).
 */
export async function ensureWorkerBridge(
  spawn: WorkerSpawn = defaultSpawn,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
): Promise<WorkerStreamBridge | undefined> {
  let worker: SpawnedWorker | undefined;
  try {
    worker = spawn();
  } catch {
    return undefined; // spawn failed (no module-worker support / bad URL) → inline
  }
  if (worker === undefined) return undefined;
  const spawned = worker;
  const caps = await awaitReady(spawned, handshakeTimeoutMs);
  if (caps === undefined || (!caps.video && !caps.audio)) {
    spawned.terminate();
    return undefined; // no handshake / no substrate at all in the worker → inline (Prime Directive 6)
  }
  return new WorkerStreamBridge(spawned, () => spawned.terminate(), caps);
}

/**
 * Build a {@link WorkerPool} of `size` worker bridges for ABR fan-out, gated by ONE probe handshake
 * ({@link ensureWorkerBridge}) — or `undefined` (route inline). On success the probe is reused as the
 * pool's first worker (no wasted spawn) and the remaining `size-1` are bare-spawned: an identical worker
 * in the same environment shares the probe's substrate, so its caps speak for the pool (doc 06 §4).
 */
export async function createWorkerPool(
  size: number,
  spawn: WorkerSpawn = defaultSpawn,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
): Promise<WorkerPool | undefined> {
  const probe = await ensureWorkerBridge(spawn, handshakeTimeoutMs);
  if (probe === undefined) return undefined;
  let first = true;
  return new WorkerPool({
    size: Math.max(1, Math.floor(size)),
    ...(probe.caps !== undefined ? { caps: probe.caps } : {}),
    transport: () => {
      if (first) {
        first = false;
        return probe; // reuse the gate's already-handshaken worker as worker #1
      }
      // Additional workers: a bare spawn (the gate already proved this environment offloads). A failed bare
      // spawn is a hard error — but the gate succeeding means `Worker`+URL exist, so it does not happen.
      const worker = spawn();
      if (worker === undefined) {
        throw new MediaError('capability-miss', 'worker pool could not spawn an additional worker');
      }
      return new WorkerStreamBridge(worker, () => worker.terminate(), probe.caps);
    },
  });
}

/**
 * Resolve the worker's announced {@link WorkerMediaCaps} from its first `ready`, or `undefined` on
 * timeout. The first `ready` is authoritative; the listener is removed either way (via the adapter's
 * exact-wrapper registry, so nothing accumulates on a page-lifetime worker).
 */
function awaitReady(
  worker: SpawnedWorker,
  timeoutMs: number,
): Promise<WorkerMediaCaps | undefined> {
  return new Promise<WorkerMediaCaps | undefined>((resolve) => {
    let settled = false;
    const onMessage = (ev: { data: WorkerMessage }): void => {
      if (ev.data.t !== 'ready') return;
      finish(ev.data.caps);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const finish = (caps: WorkerMediaCaps | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      resolve(caps);
    };
    worker.addEventListener('message', onMessage);
  });
}

/** The DOM-`Worker`-shaped surface {@link adaptWorker} adapts (a real `Worker`, or an `EventTarget`-backed
 * stand-in in Node tests — the adapter's listener bookkeeping is Node-proven, not browser-only). */
export interface DomWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: Event) => void): void;
  removeEventListener(type: 'message', listener: (ev: Event) => void): void;
  terminate(): void;
}

/**
 * Adapt a DOM `Worker` to the {@link SpawnedWorker} port shape the bridge consumes. The adapter keeps an
 * **exact-wrapper registry** (punch-list 1): each bridge listener is wrapped once to unwrap `MessageEvent`
 * → `{data}`, and `removeEventListener` detaches that *same* wrapper — DOM identity semantics. Without it
 * a pool-reused, page-lifetime worker accumulates one stale `#pump` listener per job, and a prior job's
 * settled listener would `closeFrame` the *current* job's transferred chunk — a double-close the moment a
 * real `VideoFrame` crosses. Re-adding an already-registered listener is a no-op (DOM dedup semantics).
 */
export function adaptWorker(worker: DomWorkerLike): SpawnedWorker {
  const wrappers = new Map<(ev: { data: WorkerMessage }) => void, (ev: Event) => void>();
  return {
    postMessage: (m, transfer) =>
      transfer && transfer.length > 0
        ? worker.postMessage(m, transfer as Transferable[])
        : worker.postMessage(m),
    addEventListener: (type, listener) => {
      if (wrappers.has(listener)) return;
      const wrapper = (ev: Event): void => listener({ data: (ev as MessageEvent).data });
      wrappers.set(listener, wrapper);
      worker.addEventListener(type, wrapper);
    },
    removeEventListener: (type, listener) => {
      const wrapper = wrappers.get(listener);
      if (wrapper === undefined) return;
      wrappers.delete(listener);
      worker.removeEventListener(type, wrapper);
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * Build the production worker URL — a *runtime asset reference*, never a static import (esbuild emits
 * `worker.js` as its own chunk and rewrites this to the hashed asset path; the eager kernel never pulls
 * it). Kept in a helper (NOT inlined into `new Worker(...)`) deliberately: a re-bundler that statically
 * recognizes the `new Worker(new URL(...))` pattern (Vite) would try to RE-BUNDLE our prebuilt code-split
 * worker and fail ("UMD/IIFE not supported for code-splitting"); hiding the pattern makes the consuming
 * app serve the vendored worker + chunks raw (ADR-087 §3.E, the `*-vendor-static` plugin pattern).
 */
/* v8 ignore start -- a bundled-browser runtime asset URL + a real DOM Worker construction; Node has no
   module Worker to spawn. The handshake/downgrade LOGIC above and the adapter are Node-tested. */
function workerMainUrl(): URL | undefined {
  try {
    return new URL('./worker.js', import.meta.url);
  } catch {
    return undefined;
  }
}

/** Default real-`Worker` spawn (browser/bundled). Returns `undefined` when `Worker`/the URL is absent. */
function defaultSpawn(): SpawnedWorker | undefined {
  if (typeof Worker !== 'function') return undefined;
  const url = workerMainUrl();
  if (url === undefined) return undefined;
  return adaptWorker(new Worker(url, { type: 'module' }));
}
/* v8 ignore stop */
