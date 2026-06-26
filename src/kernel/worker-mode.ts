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
 * exists; the deeper "WebCodecs runs *inside* the worker" check is answered by the worker's
 * `ready.webcodecs` handshake (the host downgrades to the inline bridge when a freshly-spawned worker
 * reports `webcodecs:false`). Never assumes isolation that isn't there.
 */
export function workerOffloadAvailable(): boolean {
  return typeof Worker === 'function';
}

/**
 * Resolve whether the heavy graph should run off the main thread, from the public `worker` option
 * ({@link CreateMediaOptions.worker}) and whether a `Worker` constructor exists. `worker:false` is an
 * explicit opt-out (always inline); `true`/`{pool}`/unset default to offload **only when a `Worker`
 * actually exists** — no `Worker` ⇒ inline, the honest fallback (a missing platform capability is never
 * faked). The deeper "WebCodecs inside the worker" gate is the spawned worker's `ready.webcodecs`
 * handshake, applied by the engine after this static decision.
 */
export function selectWorkerMode(
  worker: boolean | { pool?: number } | undefined,
  workerExists: boolean,
): WorkerSelection {
  // Offload is OPT-IN: run on a Worker ONLY when the caller explicitly passes `worker:true` or
  // `worker:{pool}`. An unset or `false` `worker` runs INLINE — the safe, predictable default (no surprise
  // Worker spawn for every heavy op) and the honest fallback when no `Worker` constructor exists. The
  // offload path stays available + validated behind the explicit opt-in.
  if (worker === undefined || worker === false) return 'inline';
  if (!workerExists) return 'inline';
  return 'offload';
}

/**
 * The number of worker bridges to spawn for the ABR pool, from the `worker` option. An explicit
 * `{pool:N}` requests N (floored to an integer, clamped to ≥ 1 so a `0`/negative never yields a
 * worker-less pool); `true`/`false`/unset/`{}` default to a single worker (no fan-out — one job streams
 * on one worker; the pipeline is already streamed, doc 06 §4). Pure + total.
 */
export function resolvePoolSize(worker: boolean | { pool?: number } | undefined): number {
  if (typeof worker === 'object' && worker.pool !== undefined) {
    return Math.max(1, Math.floor(worker.pool));
  }
  return 1;
}
