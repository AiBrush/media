/**
 * Host-side worker offload facade (doc 06 §4, ADR-019/ADR-086/ADR-087) — the seam `MediaEngineImpl`
 * reaches through a lazy `import('./worker-host.ts')`, so the eager kernel never statically carries
 * worker code (doc 08 §7). The 506-line god-file was split by concern (punch-list 5) into:
 *
 *  - {@link file://./worker-spawn.ts} — spawn + `ready{caps}` handshake + the DOM `Worker` adapter;
 *  - {@link file://./worker-offload-runtime.ts} — the scoped shared-pool registry ({@link OffloadRuntime});
 *  - {@link file://./worker-input.ts} — the single source→bytes reader + zero-copy transferable adopt;
 *  - {@link file://./worker-marshal.ts} — payload assembly, the byte round-trip, the ABR ladder fan-out.
 *
 * This module re-exports that surface unchanged for existing importers and owns only the one composition
 * the engine calls: {@link tryOffload}.
 */

import type { Source } from '../sources/source.ts';
import type { OffloadJobPayload } from './worker-main.ts';
import {
  type OffloadStreamOptions,
  type WithOptionalSink,
  capsSatisfy,
  offloadCapsNeed,
  offloadHeavyOp,
} from './worker-marshal.ts';
import {
  type OffloadPoolCache,
  type OffloadRuntime,
  ensureOffloadPool,
} from './worker-offload-runtime.ts';
import { type WorkerSpawn, spawnWorkerAt } from './worker-spawn.ts';

export {
  type DomWorkerLike,
  type SpawnedWorker,
  type WorkerSpawn,
  HANDSHAKE_TIMEOUT_MS,
  adaptWorker,
  createWorkerPool,
  ensureWorkerBridge,
} from './worker-spawn.ts';
export {
  type OffloadPoolCache,
  type OffloadRuntime,
  createOffloadRuntime,
  defaultOffloadRuntime,
  ensureOffloadPool,
} from './worker-offload-runtime.ts';
export { type OwnedSourceBytes, readSourceOwned, transferableInput } from './worker-input.ts';
export {
  type AbrRendition,
  type JobStreamRunner,
  type OffloadStreamOptions,
  type WithOptionalSink,
  buildOffloadPayload,
  abrLadderCapsSatisfy,
  capsSatisfy,
  offloadAbrLadder,
  offloadCapsNeed,
  offloadHeavyOp,
  runOffloadStream,
} from './worker-marshal.ts';

/** Injectable wiring for {@link tryOffload} — production passes nothing (real spawn, default runtime). */
export interface OffloadWiring {
  readonly spawn?: WorkerSpawn;
  /** An explicit worker script URL (`createMedia({ worker: { url } })`) when no `spawn` is injected. */
  readonly workerUrl?: string | URL;
  readonly runtime?: OffloadRuntime;
}

/**
 * The single host entry the engine's `convert`/`trim` offload branch calls (behind its own eager
 * `workerMode === 'offload'` gate): ensure the shared pool, gate the job on the caps it actually needs
 * (punch-list 6 — an audio-only convert offloads to an audio-capable worker; a video job downgrades when
 * the worker lacks video), and run it, returning the encoded **byte stream**. `undefined` means "run the
 * inline path" — the honest fallback, never a throw. No `VideoFrame`/`AudioData` crosses — only encoded
 * bytes; the caller materializes the returned stream into the sink on the main thread.
 */
export async function tryOffload<T extends WithOptionalSink>(
  cache: OffloadPoolCache,
  poolSize: number,
  src: Source,
  kind: OffloadJobPayload['kind'],
  publicOpts: T,
  opts: OffloadStreamOptions = {},
  wiring: OffloadWiring = {},
): Promise<ReadableStream<Uint8Array> | undefined> {
  const spawn =
    wiring.spawn ?? (wiring.workerUrl !== undefined ? spawnWorkerAt(wiring.workerUrl) : undefined);
  const pool = await ensureOffloadPool(cache, poolSize, spawn, wiring.runtime);
  if (pool === null) return undefined;
  if (!capsSatisfy(pool.caps, offloadCapsNeed(publicOpts))) return undefined;
  return offloadHeavyOp(pool, src, kind, publicOpts, opts);
}
