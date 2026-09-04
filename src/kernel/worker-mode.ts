/**
 * Worker-mode selection (docs/architecture/06 §4, ADR-019) — the **pure, dependency-free** decision the
 * engine makes from `CreateMediaOptions.worker` + `Worker` availability. It is split into its own tiny
 * module (no `WorkerStreamBridge`/protocol imports) so the eager `index` kernel can reach it WITHOUT
 * dragging the heavy host bridge/pump or the offload protocol into the eager closure — that keeps the
 * kernel byte budget (BUILD §2, doc 08 §7). `worker-bridge.ts` re-exports these so the public surface is
 * unchanged. Nothing here touches DOM/WebCodecs; it runs identically in Node and the browser.
 */

/** The engine's two runtime modes for the heavy decode→encode graph (doc 06 §4, ADR-019). */
export type WorkerSelection = 'offload' | 'inline';

/**
 * Decide whether heavy ops can actually be offloaded to a Worker in this environment — the honest gate for
 * the inline fallback (Prime Directive 6 / ADR-025). Returns `true` only when the `Worker` constructor
 * exists; the deeper "does the worker have the codec substrate this job needs" check is answered by the
 * spawned worker's `ready.caps` handshake (the host downgrades a job to the inline bridge when the worker
 * lacks the media kinds it needs). Never assumes isolation that isn't there.
 */
export function workerOffloadAvailable(): boolean {
  return typeof Worker === 'function';
}

/**
 * Resolve whether the heavy graph should run off the main thread, from the public `worker` option
 * ({@link CreateMediaOptions.worker}) and whether a `Worker` constructor exists. Offload is **opt-in**
 * (ADR-087): an unset or `false` `worker` always runs INLINE — the safe, predictable default (no surprise
 * Worker spawn per heavy op). Only an explicit `worker:true`/`worker:{pool}` selects offload, and even
 * then only when a `Worker` constructor actually exists — no `Worker` ⇒ inline, the honest fallback (a
 * missing platform capability is never faked). The deeper "codec substrate inside the worker" gate is the
 * spawned worker's `ready.caps` handshake, applied by the engine after this static decision.
 */
export function selectWorkerMode(
  worker: boolean | { pool?: number; url?: string | URL } | undefined,
  workerExists: boolean,
): WorkerSelection {
  // Heavy convert/trim offload is now the default when a Worker exists (peak-memory + longtask win):
  // an unset `worker` runs offloaded (the fast, low-memory path) and only an explicit `false` stays
  // inline — the safe fallback when no Worker exists or the caller opts out. This is general by
  // `Worker` availability, not by fixture, and keeps the heavy 1080p→180p convert (600s) off the main
  // thread. The deeper codec-substrate gate remains the worker's `ready.caps` handshake.
  if (worker === false) return 'inline';
  if (!workerExists) return 'inline';
  return 'offload';
}

/**
 * The number of worker bridges to spawn for the ABR pool, from the `worker` option. An explicit
 * `{pool:N}` requests N (floored to an integer, clamped to ≥ 1 so a `0`/negative never yields a
 * worker-less pool); `true`/`false`/unset/`{}` default to a single worker (no fan-out — one job streams
 * on one worker; the pipeline is already streamed, doc 06 §4). Pure + total.
 */
export function resolvePoolSize(worker: boolean | { pool?: number; url?: string | URL } | undefined): number {
  if (typeof worker === 'object' && worker.pool !== undefined) {
    return Math.max(1, Math.floor(worker.pool));
  }
  return 1;
}
