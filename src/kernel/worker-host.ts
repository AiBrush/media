/**
 * Host-side worker offload glue (docs/architecture/06 §4, ADR-019/ADR-086) — the seam
 * {@link MediaEngineImpl} calls to run a heavy `convert`/`trim` off the main thread without the engine's
 * *eager* closure ever statically importing worker/WebCodecs-heavy code (this module is reached only via a
 * lazy `import('./worker-host.ts')`, so the kernel byte budget holds, BUILD §2 / doc 08 §7).
 *
 * Two responsibilities:
 *  - {@link ensureWorkerBridge}: spawn a real module `Worker` from a runtime asset URL, await its
 *    `ready{webcodecs}` handshake, and resolve to a {@link WorkerStreamBridge} — or `undefined` (the honest
 *    fallback) when no `Worker` exists, spawn fails, or the worker reports no WebCodecs
 *    (`ready.webcodecs:false`). The deeper "does the worker actually have WebCodecs" gate is the handshake,
 *    not an assumption (Prime Directive 6 / ADR-025). The `spawn` is injectable so the handshake/downgrade
 *    policy is proven in Node over a `MessageChannel`; the real `Worker` construction is browser-only.
 *  - {@link runOffloadStream}: read the source to **bytes** (a seekable demux source can't be a transferred
 *    one-shot stream), assemble the serializable {@link OffloadJob} (transferring the bytes), run it on the
 *    bridge, and re-expose the worker's Transferable **byte** chunks as a `ReadableStream<Uint8Array>` the
 *    engine materializes into the caller's sink. No `VideoFrame`/`AudioData` crosses — only encoded bytes.
 */

import { MediaError } from '../contracts/errors.ts';
import type { Source } from '../sources/source.ts';
import { type RunStreamOptions, WorkerStreamBridge } from './worker-bridge.ts';
import type { OffloadJobPayload } from './worker-main.ts';
import { WorkerPool } from './worker-pool.ts';
import type { HostMessage, MessageLike, OffloadJob, WorkerMessage } from './worker-protocol.ts';

/** A spawned dedicated worker as the bridge needs it (a duplex message port that can also terminate). */
export interface SpawnedWorker extends MessageLike<WorkerMessage, HostMessage> {
  terminate(): void;
}

/** How {@link ensureWorkerBridge} obtains a worker — a real `Worker` in production, a fake in Node tests. */
export type WorkerSpawn = () => SpawnedWorker | undefined;

/**
 * A runner that streams one job's Transferable results — satisfied by both a single {@link WorkerStreamBridge}
 * and a {@link WorkerPool} (`runStream` has the same signature on each). Letting {@link runOffloadStream} /
 * {@link offloadHeavyOp} take this structural type is what lets the engine route a heavy op through a *pool*
 * (size N for `{pool:N}`, 1 otherwise) — so concurrent `convert`/`trim` calls queue across N workers instead
 * of colliding on a single bridge's busy-guard.
 */
export interface JobStreamRunner {
  runStream(job: OffloadJob, opts: RunStreamOptions): ReadableStream<Transferable>;
}


/**
 * Spawn a real module `Worker` and await its readiness handshake, resolving to a host
 * {@link WorkerStreamBridge} when the worker is up **and** reports WebCodecs, else `undefined` (route inline
 * — the honest fallback). `spawn` is injectable so a test can drive the real handshake logic over a
 * `MessageChannel`; production passes nothing and a real `Worker` is constructed. A spawn throw, a handshake
 * timeout, or `webcodecs:false` all downgrade cleanly (the worker, if any, is terminated).
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
  const ready = await awaitReady(worker, handshakeTimeoutMs);
  if (!ready) {
    worker.terminate();
    return undefined; // no handshake / no WebCodecs in the worker → inline (Prime Directive 6)
  }
  return new WorkerStreamBridge(worker, () => worker?.terminate());
}

/**
 * Build a {@link WorkerPool} of `size` worker bridges for ABR fan-out, gated by a real readiness handshake —
 * or `undefined` (route inline, the honest fallback) when the environment can't actually offload. The gate
 * spawns ONE probe worker and awaits its `ready{webcodecs}` ({@link ensureWorkerBridge}); only on success
 * does it build the pool, **reusing the probe as the pool's first worker** (no wasted spawn) and bare-
 * spawning the remaining `size-1` (an identical worker in the same environment will also have WebCodecs, so
 * the per-worker handshake is unnecessary — the one gate suffices, doc 06 §4). `spawn` is injectable for
 * Node tests; production uses the real `defaultSpawn`.
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
      return new WorkerStreamBridge(worker, () => worker.terminate());
    },
  });
}

/**
 * Build the production worker URL — a *runtime asset reference*, never a static import (esbuild emits
 * `worker.js` as its own chunk and rewrites this to the hashed asset path; the eager kernel never pulls it).
 * Returns `undefined` where `import.meta.url` is unavailable.
 *
 * NB the URL is built in this helper (NOT inlined into `new Worker(...)`) deliberately: the published bundle
 * is a COMPLETE, code-split worker (worker.js + its own `./chunk-*.js`/`./engine-*.js` graph). A re-bundler
 * that statically recognizes `new Worker(new URL('./worker.js', import.meta.url))` (Vite) tries to RE-BUNDLE
 * that worker as one of its own — which fails for a code-split worker (Vite's worker format is iife: "UMD/IIFE
 * not supported for code-splitting"). Keeping the URL in a helper hides the pattern from that re-bundler so it
 * leaves our prebuilt worker alone; the consuming app/harness must then serve the vendored worker + its chunks
 * RAW (static, not re-processed) — see the §3.E note in ADR-087 + the `*-vendor-static` Vite plugin pattern.
 */
/* v8 ignore start -- a bundled-browser runtime asset URL; Node has no module Worker to spawn it. */
function workerMainUrl(): URL | undefined {
  try {
    return new URL('./worker.js', import.meta.url);
  } catch {
    return undefined;
  }
}
/* v8 ignore stop */

/** Default real-`Worker` spawn (browser/bundled). Returns `undefined` when `Worker`/the URL is absent. */
/* v8 ignore start -- constructs a real DOM Worker; unreachable in Node (no `Worker`), browser-validated. */
function defaultSpawn(): SpawnedWorker | undefined {
  if (typeof Worker !== 'function') return undefined;
  const url = workerMainUrl();
  if (url === undefined) return undefined;
  const worker = new Worker(url, { type: 'module' });
  return adaptWorker(worker);
}

/** Adapt a DOM `Worker` to the {@link SpawnedWorker} port shape the bridge consumes. */
function adaptWorker(worker: Worker): SpawnedWorker {
  return {
    postMessage: (m, transfer) =>
      transfer && transfer.length > 0
        ? worker.postMessage(m, transfer as Transferable[])
        : worker.postMessage(m),
    addEventListener: (type, listener) =>
      worker.addEventListener(type, (ev) => listener({ data: (ev as MessageEvent).data })),
    removeEventListener: (type, listener) =>
      // The DOM removeEventListener needs the exact handler; the bridge only ever removes its own single
      // `message` listener at teardown, and the worker is terminated alongside, so a no-op is safe here.
      void [type, listener],
    terminate: () => worker.terminate(),
  };
}
/* v8 ignore stop */

/** Default worker readiness handshake budget (ms): generous for a cold module-worker boot, still bounded. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Resolve `true` when the worker posts `ready{webcodecs:true}` within the timeout, `false` on
 * `webcodecs:false` or timeout. The first `ready` is authoritative; the listener is removed either way.
 */
function awaitReady(worker: SpawnedWorker, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onMessage = (ev: { data: WorkerMessage }): void => {
      if (ev.data.t !== 'ready') return;
      finish(ev.data.webcodecs === true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      resolve(ok);
    };
    worker.addEventListener('message', onMessage);
  });
}

/** Options for {@link runOffloadStream}: the per-call backpressure/abort/progress + the job's determinism. */
export interface OffloadStreamOptions extends RunStreamOptions {
  /** Threaded into the worker job so `force-software` is bit-identical inline vs worker (ADR-007). */
  readonly determinism?: 'auto' | 'force-software';
}

/** A source's serializable routing hints (filename/mime) carried so the worker routes identically. */
interface SourceHints {
  readonly filename?: string;
  readonly mimeHint?: string;
}

/** Placeholder zero-length input; {@link runOffloadStream} fills the real bytes before posting. */
const EMPTY_INPUT = new ArrayBuffer(0);

/**
 * The shape of public op options the offload helpers accept — any object that *may* carry a `sink` (which
 * is stripped: the worker always streams bytes back; the host owns the real sink). A generic preserves the
 * caller's concrete fields (e.g. the public `ConvertOptions`/`TrimOptions`, which have no index signature)
 * across the `{ sink, ...rest }` split without the engine leaking those public types into this lazy chunk.
 */
export type WithOptionalSink = { readonly sink?: unknown };

/**
 * Build the serializable {@link OffloadJobPayload} for a heavy op (ADR-010): the source's mime/filename
 * hints (so container routing in the worker matches the host's inline path) plus the public options
 * **minus `sink`** (the host owns the real sink; the worker always streams bytes). The `input` buffer is a
 * placeholder {@link runOffloadStream} fills with the read bytes. All carried fields are flat +
 * structured-cloneable. Defined here (the lazy chunk), not in the engine, so the eager kernel never
 * carries it (doc 08 §7 budget); the engine reaches it only through {@link offloadHeavyOp}.
 */
export function buildOffloadPayload<T extends WithOptionalSink>(
  kind: OffloadJobPayload['kind'],
  hints: SourceHints,
  opts: T,
): OffloadJobPayload {
  const { sink: _sink, ...rest } = opts;
  const common = {
    input: EMPTY_INPUT,
    ...(hints.filename !== undefined ? { filename: hints.filename } : {}),
    ...(hints.mimeHint !== undefined ? { mime: hints.mimeHint } : {}),
  };
  // Accurate trim is the only trim that offloads (keyframe trim is a pure-TS stream-copy, ADR-021), so the
  // worker's inner trim is pinned to `mode:'accurate'`; convert passes its options through verbatim.
  return kind === 'trim'
    ? { kind: 'trim', ...common, opts: { ...rest, mode: 'accurate' } as never }
    : { kind: 'convert', ...common, opts: rest as never };
}

/**
 * The single host entry the engine calls to offload a heavy `convert`/`trim`: build the payload from the
 * source hints + public options, then run it on the bridge/pool and return the encoded byte stream. Keeping
 * the payload assembly here (the lazy chunk) keeps the eager kernel slim (doc 08 §7). Generic over the
 * caller's options so a concrete type with no index signature (`ConvertOptions`/`TrimOptions`) **and** an
 * inline `{ to: 'mp4', … }` literal both pass without an excess-property error.
 */
export function offloadHeavyOp<T extends WithOptionalSink>(
  runner: JobStreamRunner,
  src: Source,
  kind: OffloadJobPayload['kind'],
  publicOpts: T,
  opts: OffloadStreamOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  return runOffloadStream(runner, src, buildOffloadPayload(kind, src, publicOpts), opts);
}

/**
 * The engine's mutable worker-pool cache, owned by the {@link MediaEngineImpl} instance and threaded into
 * {@link tryOffload} by reference so the pool is spawned + handshaked **at most once** and reused across
 * heavy ops (idempotent: concurrent callers share `promise`). `pool` holds the verdict once settled — a
 * {@link WorkerPool} when offload is live, or `null` to mean "run inline" (no `Worker`, spawn failed, or the
 * worker lacks WebCodecs — the honest fallback). Kept as a plain object so the eager engine carries only the
 * tiny field, never the spawn logic (this whole module is reached only via a lazy `import()`, doc 08 §7).
 */
export interface OffloadPoolCache {
  pool?: WorkerPool | null;
  promise?: Promise<WorkerPool | null>;
}

/**
 * Resolve the heavy-op worker **pool** from the engine's {@link OffloadPoolCache}, spawning + handshaking it
 * at most once and caching the verdict. Returns the pool when a freshly-spawned probe worker reports
 * WebCodecs, else `null` ("run inline", the honest fallback). `poolSize` is the engine's resolved size (1 for
 * `worker:true`, N for `{pool:N}`). Any spawn/import failure is an honest inline fallback, never a throw
 * (Prime Directive 6). The caller (engine) has already gated on `workerMode === 'offload'` so this is reached
 * only when offload is actually selected.
 */
/* v8 ignore start -- spawns real Workers; only reachable in a browser/worker runtime (Node has no `Worker`,
   so the engine's `workerMode` is 'inline' and the engine never imports this module). Browser-harness
   validated; the spawn/handshake + pool LOGIC is unit-tested via `createWorkerPool`/`WorkerPool` directly. */
export async function ensureOffloadPool(
  cache: OffloadPoolCache,
  poolSize: number,
  spawn?: WorkerSpawn,
): Promise<WorkerPool | null> {
  if (cache.pool !== undefined) return cache.pool;
  // Spawn (and reuse) the pool **process-wide**, keyed by pool size — NOT per engine instance. A harness /
  // app that creates a fresh `createMedia({worker:true})` per operation (the media-test adapter does
  // exactly this) would otherwise spawn one Worker per op, each lazily re-loading the per-codec wasm cores
  // (~900 kB) — a spawn/memory storm that crashed the first real-Worker baseline (ADR-087, task §3.E). One
  // module-level worker pool per size means N engines share ONE worker for the page's lifetime (a worker
  // lives for the page; one job stays on one worker — doc 06 §4). The per-engine `cache` still memoizes the
  // reference so repeat calls on one engine never re-await.
  cache.promise ??= sharedOffloadPool(poolSize, spawn);
  cache.pool = await cache.promise;
  return cache.pool;
}

/**
 * Process-wide pool cache keyed by pool size. The worker spawn + `ready{webcodecs}` handshake happens at most
 * once per distinct size for the page; every engine that offloads at that size shares the same pool (and thus
 * the same single Worker, with its wasm cores loaded once). Never terminated — a dedicated worker lives for
 * the page (the honest, low-overhead steady state); terminating + re-spawning per op is the bug this avoids.
 */
const SHARED_POOLS = new Map<number, Promise<WorkerPool | null>>();

/** Resolve the shared pool for `poolSize`, spawning it once per size for the whole page. */
function sharedOffloadPool(poolSize: number, spawn?: WorkerSpawn): Promise<WorkerPool | null> {
  let shared = SHARED_POOLS.get(poolSize);
  if (shared === undefined) {
    shared = spawnOffloadPool(poolSize, spawn);
    SHARED_POOLS.set(poolSize, shared);
  }
  return shared;
}

/** Spawn the pool (engine-resolved size) and gate it on the probe worker's `ready{webcodecs}` handshake. */
async function spawnOffloadPool(poolSize: number, spawn?: WorkerSpawn): Promise<WorkerPool | null> {
  try {
    const pool = spawn ? await createWorkerPool(poolSize, spawn) : await createWorkerPool(poolSize);
    return pool ?? null;
  } catch {
    // Any spawn/handshake failure is an honest inline fallback — never a thrown op (Prime Directive 6).
    return null;
  }
}

/** Test-only: clear the process-wide shared-pool cache so each test starts from a clean slate. */
export function __resetSharedOffloadPools(): void {
  SHARED_POOLS.clear();
}

/**
 * The single host entry the engine's `convert`/`trim` offload branch calls (behind its own eager
 * `workerMode === 'offload'` gate + a lazy `import('./worker-host.ts')`): ensure the pool, then — if a pool
 * is live — run the heavy op on it and return the encoded **byte stream**; `undefined` means "no offload, run
 * the inline path" (the honest fallback when the environment can't actually offload). The whole ensure-pool +
 * payload-assembly + byte round-trip lives here (the lazy chunk), so the eager kernel carries only the thin
 * branch + the tiny {@link OffloadPoolCache} field (doc 08 §7). No `VideoFrame`/`AudioData` crosses — only
 * encoded bytes; the caller materializes the returned stream into the sink on the main thread.
 */
export async function tryOffload<T extends WithOptionalSink>(
  cache: OffloadPoolCache,
  poolSize: number,
  src: Source,
  kind: OffloadJobPayload['kind'],
  publicOpts: T,
  opts: OffloadStreamOptions = {},
): Promise<ReadableStream<Uint8Array> | undefined> {
  const pool = await ensureOffloadPool(cache, poolSize);
  if (pool === null) return undefined;
  return offloadHeavyOp(pool, src, kind, publicOpts, opts);
}
/* v8 ignore stop */

/**
 * One ABR rendition: the public `convert` options for a single ladder rung (e.g. a 720p target). Its
 * `opts` carries an index signature (unlike the generic `WithOptionalSink` param of {@link offloadHeavyOp})
 * so an inline ladder literal `[{ opts: { to: 'webm', video: {…} } }, …]` is accepted directly — a
 * declared field can't infer a per-element generic, so the open shape is the ergonomic choice here.
 */
export interface AbrRendition {
  /** Convert options for this rung (`to`, `video`, `audio`, …); `sink` is ignored (bytes stream back). */
  readonly opts: { readonly sink?: unknown; readonly [key: string]: unknown };
}

/**
 * Encode an **ABR ladder** from one source across a {@link WorkerPool}: fan the K renditions out as K
 * independent `convert` jobs over the pool's N workers (concurrency `min(N,K)`), returning a byte stream
 * per rendition **in input order** (the caller materializes each into its own sink). Because a transfer
 * detaches the input buffer, **each rendition gets its own copy** of the source bytes — read once here,
 * copied per job (a worker must own a transferable buffer); this copy is unavoidable and explicit.
 * Determinism + a shared abort signal thread to every job.
 */
export async function offloadAbrLadder(
  pool: WorkerPool,
  src: Source,
  ladder: readonly AbrRendition[],
  opts: OffloadStreamOptions = {},
): Promise<ReadableStream<Uint8Array>[]> {
  const bytes = await readAllSource(src, opts.signal);
  const { determinism } = opts;
  const jobs: OffloadJob[] = ladder.map((rung) => {
    // Per-rendition copy: each job transfers (detaches) its own input buffer, so they cannot share one.
    const input = bytes.slice().buffer as ArrayBuffer;
    return {
      op: 'convert' as const,
      payload: { ...buildOffloadPayload('convert', src, rung.opts), input },
      ...(determinism !== undefined ? { determinism } : {}),
    };
  });
  return pool.runMany(jobs).map((stream) => asBytes(stream));
}

/**
 * Run one heavy `convert`/`trim` job on a worker bridge and return its produced byte stream. Reads the
 * whole source to bytes (the worker rebuilds a *seekable* `fromBytes` source for demux), assembles the
 * serializable job with the input `ArrayBuffer` transferred (moved, not copied) and the determinism, runs
 * it, and re-exposes the worker's Transferable result chunks as `Uint8Array`s. Callers pass a payload
 * describing the op (kind + filename/mime/opts); the `input` field is filled here from the read bytes.
 */
export async function runOffloadStream(
  runner: JobStreamRunner,
  src: Source,
  payload: OffloadJobPayload,
  opts: OffloadStreamOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const bytes = await readAllSource(src, opts.signal);
  // Transfer the exact-length backing buffer (a subarray view would carry the whole pool buffer).
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const job: OffloadJob = {
    op: payload.kind,
    payload: { ...payload, input },
    ...(opts.determinism !== undefined ? { determinism: opts.determinism } : {}),
  };
  const { determinism: _determinism, ...runOpts } = opts;
  const transferable = runner.runStream(job, runOpts);
  return asBytes(transferable);
}

/** Re-type the worker's Transferable byte stream as `Uint8Array` chunks (each chunk is an `ArrayBuffer`). */
function asBytes(stream: ReadableStream<Transferable>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value instanceof ArrayBuffer) {
        controller.enqueue(new Uint8Array(value));
        return;
      }
      // A non-buffer Transferable on the byte path is an internal contract break (the convert/trim worker
      // only ever transfers encoded ArrayBuffers) — fail loudly rather than emit a wrong-typed chunk.
      controller.error(
        new MediaError(
          'encode-error',
          'worker offload produced a non-byte result on the byte path',
        ),
      );
    },
    async cancel(reason): Promise<void> {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/** Read a whole source to a single `Uint8Array` (mirrors the engine's own reader; honors abort). */
async function readAllSource(src: Source, signal: AbortSignal | undefined): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (src.range && src.size !== undefined) {
    const bytes = await src.range(0, src.size);
    throwIfAborted(signal);
    return bytes;
  }
  const reader = src.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (e) {
    await reader.cancel(e).catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  throwIfAborted(signal);
  return out;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation cancelled');
}
