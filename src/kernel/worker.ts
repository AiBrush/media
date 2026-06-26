/**
 * Worker bootstrap (docs/architecture/06 §4/§6, ADR-019/ADR-086) — the module a real dedicated `Worker`
 * boots from (`new Worker(new URL('./worker.js', import.meta.url), {type:'module'})`, spawned by
 * {@link file://./worker-host.ts}). It is the **only browser-only surface** of the offload: it binds the
 * worker's `self` scope to {@link runOffloadWorker} with the production {@link JobRunner} from the pure,
 * Node-tested {@link file://./worker-main.ts}, then auto-boots on load.
 *
 * Why it is its own tiny module (not folded into `worker-main.ts`): the reconstruction logic in
 * `worker-main.ts` is pure and Node-validated; the `self`-bound boot + the real `MediaEngineImpl`
 * construction can only run in a worker, so isolating it here keeps `worker-main.ts` 100%-coverable in Node
 * while this file rides the `worker.ts` coverage exclusion (vitest.config glob) and is validated in the
 * browser harness. It is a **separate tsup entry/chunk** referenced only via the runtime asset URL above —
 * never a static import from the eager `index` closure — so the kernel byte budget (BUILD §2, doc 08 §7) is
 * untouched (the engine reaches it lazily, only when `worker` is enabled and a `Worker` exists).
 *
 * Recursion guard: the inner engine each job runs on is constructed `worker:false` (it is *already* inside a
 * worker — it must run the pipeline inline and never re-spawn a worker, ADR-019). The heavy engine module is
 * pulled in via a dynamic `import('../api/engine.ts')` so it lands in the *worker* chunk only.
 */

import type { Determinism } from '../contracts/driver.ts';
import { runOffloadWorker } from './worker-entry.ts';
import { type InnerEngine, type InnerEngineFactory, makeJobRunner } from './worker-main.ts';
import type { HostMessage, MessageLike, WorkerMessage } from './worker-protocol.ts';

/**
 * Boot a worker scope with the production {@link JobRunner}: each job builds (lazily, once) a real inner
 * {@link InnerEngine} forced inline (`worker:false`) and reconstructs the heavy `convert`/`trim` pipeline on
 * it ({@link makeJobRunner}). Returns the {@link runOffloadWorker} disposer (used by a focused browser
 * test; a real worker lives for the page). The engine module loads via a dynamic import so the eager kernel
 * never statically pulls it.
 */
export function startWorkerMain(
  scope: MessageLike<HostMessage, WorkerMessage> & { webcodecs?: boolean },
): () => void {
  let enginePromise: Promise<typeof import('../api/engine.ts')> | undefined;
  const makeInner: InnerEngineFactory = (determinism) =>
    deferredInnerEngine(determinism, () => {
      enginePromise ??= import('../api/engine.ts');
      return enginePromise;
    });
  return runOffloadWorker(scope, makeJobRunner(makeInner));
}

/**
 * An {@link InnerEngine} that lazily constructs the real {@link MediaEngineImpl} on first use. The op is
 * awaited through the dynamic import so the engine module loads inside the worker (off the eager path).
 * Forced `worker:false` guarantees the inner engine runs the pipeline inline — the offload stops here, it
 * never re-spawns a worker.
 */
function deferredInnerEngine(
  determinism: Determinism,
  loadEngine: () => Promise<typeof import('../api/engine.ts')>,
): InnerEngine {
  const real = async (): Promise<InnerEngine> => {
    const { MediaEngineImpl } = await loadEngine();
    return new MediaEngineImpl({ worker: false, determinism }) as unknown as InnerEngine;
  };
  return {
    convert: async (input, opts, o) => (await real()).convert(input, opts, o),
    trim: async (input, opts, o) => (await real()).trim(input, opts, o),
  };
}

/**
 * Wire this module as a real dedicated worker when executed in a worker scope (the production boot). Guarded
 * so importing the module in Node (a test) does not bind to a non-existent worker global: a dedicated worker
 * exposes `postMessage`/`addEventListener` on its global and has no `document`. The browser/worker bundle
 * runs this on load.
 */
export function bootWorkerMain(): void {
  const scope = globalThis as unknown as {
    postMessage?: unknown;
    addEventListener?: unknown;
    document?: unknown;
  };
  const inWorker =
    typeof scope.postMessage === 'function' &&
    typeof scope.addEventListener === 'function' &&
    typeof scope.document === 'undefined';
  if (!inWorker) return;
  startWorkerMain(globalThis as unknown as MessageLike<HostMessage, WorkerMessage>);
}

bootWorkerMain();
