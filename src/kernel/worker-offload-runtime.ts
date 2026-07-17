/**
 * Offload pool runtime (ADR-087, punch-list 5/8; split out of `worker-host.ts`) — owns the shared
 * worker-pool registry on an **explicit, disposable runtime object** instead of a bare module global with
 * a test-only reset backdoor. The spawn-storm fix is preserved: within one runtime, N engines at the same
 * pool size share ONE spawned+handshaken pool (a harness that creates a fresh engine per op must not
 * spawn a Worker per op — that re-loads the per-codec WASM cores each time and crashed the first
 * real-Worker baseline). Lifetime is now scoped: `dispose()` terminates every pool the runtime owns, and
 * tests construct their own runtime — no process-global mutation, no backdoor.
 */

import type { WorkerPool } from './worker-pool.ts';
import { type WorkerSpawn, createWorkerPool } from './worker-spawn.ts';

/**
 * An owned registry of shared offload pools, keyed by pool size. One runtime ≈ one page: production uses
 * the process-default runtime ({@link defaultOffloadRuntime}, the composition root the engine reaches when
 * no runtime is threaded in); an embedder or test owns its lifetime explicitly via
 * {@link createOffloadRuntime} + {@link OffloadRuntime.dispose}.
 */
export interface OffloadRuntime {
  /** True once {@link dispose} ran; a disposed runtime resolves every `ensurePool` to `null` (inline). */
  readonly disposed: boolean;
  /**
   * Resolve the shared pool for `poolSize`, spawning + handshaking it at most once per size for this
   * runtime's lifetime. `null` means "run inline" — the honest fallback (no `Worker`, spawn failed, or
   * the probe worker announced no capable media kind). Any spawn/handshake failure is an inline verdict,
   * never a thrown op (Prime Directive 6).
   */
  ensurePool(poolSize: number, spawn?: WorkerSpawn): Promise<WorkerPool | null>;
  /** Terminate every pool this runtime owns (idempotent). Later `ensurePool` calls resolve `null`. */
  dispose(): Promise<void>;
}

/** Build an owned offload runtime (an isolated pool registry with an explicit, disposable lifetime). */
export function createOffloadRuntime(): OffloadRuntime {
  const pools = new Map<number, Promise<WorkerPool | null>>();
  let disposed = false;
  return {
    get disposed(): boolean {
      return disposed;
    },
    ensurePool(poolSize: number, spawn?: WorkerSpawn): Promise<WorkerPool | null> {
      if (disposed) return Promise.resolve(null);
      let shared = pools.get(poolSize);
      if (shared === undefined) {
        shared = spawnOffloadPool(poolSize, spawn);
        pools.set(poolSize, shared);
      }
      return shared;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const pending = [...pools.values()];
      pools.clear();
      for (const promised of pending) {
        const pool = await promised.catch(() => null);
        if (pool !== null) await pool.terminate();
      }
    },
  };
}

/** Spawn the pool (engine-resolved size) and gate it on the probe worker's `ready{caps}` handshake. */
async function spawnOffloadPool(poolSize: number, spawn?: WorkerSpawn): Promise<WorkerPool | null> {
  try {
    const pool = spawn ? await createWorkerPool(poolSize, spawn) : await createWorkerPool(poolSize);
    return pool ?? null;
  } catch {
    // Any spawn/handshake failure is an honest inline fallback — never a thrown op (Prime Directive 6).
    return null;
  }
}

/**
 * The page-lifetime default runtime the engine reaches when none is threaded in (the ADR-087 cross-engine
 * sharing point). It is created lazily and **replaced by a fresh one after disposal** — disposing at page
 * teardown must not permanently wedge a long-lived process into the inline path.
 */
let processRuntime: OffloadRuntime | undefined;

/** The process-default {@link OffloadRuntime} (lazily created; fresh again after a `dispose()`). */
export function defaultOffloadRuntime(): OffloadRuntime {
  if (processRuntime === undefined || processRuntime.disposed) {
    processRuntime = createOffloadRuntime();
  }
  return processRuntime;
}

/**
 * The engine's per-instance pool cache, held by `MediaEngineImpl` and threaded here by reference so
 * repeat ops on one engine never re-await the runtime lookup. `pool` holds the settled verdict — a
 * {@link WorkerPool} when offload is live, `null` for "run inline". The heavy spawn logic stays in this
 * lazily-imported chunk; the engine carries only this tiny field (doc 08 §7).
 */
export interface OffloadPoolCache {
  pool?: WorkerPool | null;
  promise?: Promise<WorkerPool | null>;
}

/**
 * Resolve the heavy-op worker pool for an engine: memoized per engine (`cache`), shared across engines by
 * the owning runtime (per pool size). `poolSize` is the engine's resolved size (1 for `worker:true`, N
 * for `{pool:N}`). The caller has already gated on `workerMode === 'offload'`.
 */
export async function ensureOffloadPool(
  cache: OffloadPoolCache,
  poolSize: number,
  spawn?: WorkerSpawn,
  runtime: OffloadRuntime = defaultOffloadRuntime(),
): Promise<WorkerPool | null> {
  if (cache.pool !== undefined) return cache.pool;
  cache.promise ??= runtime.ensurePool(poolSize, spawn);
  cache.pool = await cache.promise;
  return cache.pool;
}
