# Worker offload wiring + ABR pool (§3.E.16/17, ADR-019, doc 06 §4)

> Design note for connecting the (already-built, unit-tested) worker layer into production and adding
> the ABR worker pool. Drives `src/kernel/worker-main.ts`, `src/kernel/worker-pool.ts`, and the engine
> `#bridge` selection in `src/api/engine.ts`.

## Goal (concrete)

`MediaEngineImpl` must honor `CreateMediaOptions.worker` (`boolean | { pool?: number }`, default `true`):
when a real `Worker` exists and reports WebCodecs (`ready.webcodecs`), the **heavy decode→encode graph**
(the byte-producing core of `convert` and accurate `trim`) runs **off the main thread**; cheap ops
(`probe`/`demux`/stream-copy `remux`/keyframe `trim`/PCM transform) stay inline (the worker round-trip is
not worth it, doc 06 §4 / ADR-019). When `worker:false` or no `Worker`/no WebCodecs, **everything is
inline** — the honest fallback (Prime Directive 6 / ADR-025), with identical output.

## What crosses the worker boundary — and what does NOT

The inline convert graph is `Source → demux → decode → (GPU filter) → encode → mux →
ReadableStream<Uint8Array> → materialize(sink)`. The clean offload seam is the **byte-producing core**:

- **In (host → worker):** the input **bytes** (an `ArrayBuffer`, transferred / moved — zero-copy) plus a
  *serializable* options object (`Omit<ConvertOptions|TrimOptions, 'sink'>` — flat plain objects of
  primitives, structured-cloneable; ADR-010/011). A `Source` itself is **not** serializable (it carries
  `stream()`/`range()` closures), and demux needs a **seekable** source (`range()` for the `moov`), so a
  transferred single-use `ReadableStream` would not do — we transfer bytes and rebuild a `fromBytes`
  source (which has `range()`) inside the worker.
- **Out (worker → host):** the encoded output as a stream of **`Uint8Array`** chunks; each chunk's backing
  `ArrayBuffer` is **transferred** back (moved), exactly the `ReadableStream<Transferable>` the
  `WorkerStreamBridge` already produces, under its credit window (backpressure, doc 06 §10).
- **The sink stays on the host.** A `Sink` may hold an `HTMLMediaElement`/`WritableStream` (not
  transferable), so `materialize(sink, …)` runs on the main thread over the streamed-back bytes.

### Frame lifetime: frames never cross for convert/trim

Because the seam is the **byte** core, **no `VideoFrame`/`AudioData` ever crosses the boundary** on the
production convert/trim path — every frame is created, filtered, encoded, and `close()`d **entirely inside
the worker**, by the *same inline engine code* that runs frame lifetime today. Only encoded byte buffers
transfer back. This sidesteps the "close a transferred frame exactly once across threads" hazard for
production: frames don't transfer; bytes do. (The protocol's `chunk{frame}` transfer machinery — and its
close-exactly-once contract — remains exercised by the synthetic frame-stream tests in
`worker-offload.test.ts`; it is simply not on the convert/trim hot path.)

## How the JobRunner reconstructs the pipeline (no closures, no duplication)

The worker-side `JobRunner` (`worker-main.ts`, **pure + Node-tested**) is a **thin adapter**, not a
reimplementation: given the serializable job it rebuilds a `Source` from the transferred bytes via
`fromBytes`, rebuilds the public options, forces `sink: toStream()`, threads `determinism` + the
`AbortSignal`, and calls the **same public op** (`convert`/`trim`) on an injected inner engine. The boot
(`worker.ts`, **browser-only**, `self`-bound) constructs that inner engine as a real
`MediaEngineImpl({ worker: false })` (forced inline → no recursion back into a worker) and wires the
`JobRunner` into `runOffloadWorker(self, runner)`. So the **entire** decode→filter→encode→mux graph —
codec routing, GPU filters, determinism (`force-software` is literally the same code), and frame
close-once — is reused verbatim, now executing on the worker thread.

Splitting the pure reconstruction (`worker-main.ts`) from the `self`-bound boot (`worker.ts`) keeps
`worker-main.ts` 100% Node-coverable (validated against a fake inner engine — no closure ever crosses the
boundary, ADR-010), while `worker.ts` rides the `worker.ts` coverage exclusion and is browser-harness
validated. `worker.ts` is emitted as its **own** tsup entry → `dist/worker.js`, referenced only via
`new URL('./worker.js', import.meta.url)` (a runtime asset URL inside the lazily-imported `worker-host`
chunk — never a static import from the eager `index` closure), so the kernel byte budget is untouched.

## Bridge reuse + the per-job epoch guard (pool correctness)

Because the pool **reuses** one `WorkerStreamBridge`'s transport across successive jobs, an in-transit
`chunk`/`done`/`error` from a cancelled or finished job N can arrive over the async port *after* job N+1's
listener is attached. Every host→worker message is stamped with a monotonic **`epoch`** (incremented per
`runStream`); the host ignores any worker message whose `epoch` ≠ the current job's (closing a stale
transferred frame so it can't leak), and the worker ignores `credit`/`cancel` for a stale epoch. This
makes a reused bridge incapable of cross-talk between jobs — without it, a fast cancel→re-dispatch could
mis-deliver one rendition's bytes into another's stream.

## Op routing

| Op | Path | Why |
|---|---|---|
| `convert` (codec seam: decode→encode) | **OFFLOAD** | heavy; the decode→encode graph is the `longtasks` source |
| `trim` mode `'accurate'` (decode→encode) | **OFFLOAD** | same heavy graph as convert (bytes in, bytes out) |
| `convert` pure stream-copy / `remux` / keyframe `trim` | inline | lossless byte copy — cheap, already pure-TS/Node |
| `convert` → WAV PCM-native (`transformPcm`) | inline | TS audio-dsp; no WebCodecs; runs in Node already |
| `probe` / `demux` | inline | cheap header/metadata (doc 06 §4 fast path) |
| `encode(frames,…)` / `mux(streams,…)` / `decode` | inline | the caller owns the live frame/packet streams (not a serializable job); they offload by using `convert` |
| `decrypt` / `seek` | inline | crypto is pure-TS (ADR-023); seek returns a single live frame to the caller |

## The ABR pool (`worker-pool.ts`)

`WorkerPool` holds **N** `WorkerStreamBridge`s (each runs **one** job at a time — the bridge busy-guard).
`runMany(jobs)` fans **K** independent jobs across the N workers with a free-worker queue (work-stealing):
concurrency = `min(N, K)`, and a worker pulls the next queued job the moment its current stream completes.
Each `run(job)` returns a **lazy result-stream handle immediately** (even while queued): its first `pull`
blocks until the scheduler dispatches the job onto a free worker. That decoupling is what lets a caller
take K handles up front and drain them in parallel — *draining* is what drives dispatch, so there is no
dispatch ↔ drain deadlock. The pool also exposes `runStream(job, opts)` with the **same signature as a
single bridge** (`JobStreamRunner`), so `offloadHeavyOp` accepts either a pool or a lone bridge, and a
pool — unlike a single bridge — never rejects a concurrent second `convert`/`trim` with "busy" (it queues
it across the N workers).

The engine resolves its offload runtime to a **`WorkerPool`** (size `resolvePoolSize(worker)` — 1 for
`worker:true`, N for `{pool:N}`), built once via the handshake-gated `createWorkerPool` (spawn one probe →
await `ready{webcodecs}` → build the pool, reusing the probe as worker #1). So a single heavy `convert`
runs on a 1-worker pool, and concurrent calls / ABR ladders fan across N. The ABR ladder
(`offloadAbrLadder`) is **one source → a ladder of `convert` renditions** (1080p, 720p, 480p, …) encoded
concurrently. Because a transfer *detaches* the input `ArrayBuffer`, each rendition gets its **own copy**
of the input bytes (read once, per-job `slice()`); this copy is unavoidable (each worker must own a
transferable buffer) and explicit. The pool degrades to a single `InlineBridge` (sequential) when no
`Worker` exists — honest, never fake.

## Edge cases

- **Cancellation:** `AbortSignal` → the bridge posts `{t:'cancel'}`; the worker aborts its inner engine
  op (which tears the inline pipeline down, releasing WebCodecs and closing in-flight frames), and the
  host stream errors `aborted`. In the pool, aborting one job frees its worker for the queue; an
  `abortAll()` cancels every in-flight + queued job.
- **Backpressure:** unchanged — the credit window bounds posted-but-unconsumed output chunks; a slow host
  consumer throttles the worker's mux output (doc 06 §10).
- **No WebCodecs in the worker:** the `ready.webcodecs:false` handshake → the host terminates the worker
  and routes inline (the same typed `CapabilityError` the inline path would raise still surfaces if a
  codec is genuinely missing).
- **Determinism:** the job carries `determinism`; the worker's inner engine is constructed with it, so
  `force-software` is bit-identical inline vs worker (same code path).
- **Empty/garbled input:** rebuilt as a `fromBytes` source and demuxed by the same driver → the same
  typed `InputError`/`CapabilityError`, serialized across the wire to its subclass.

## What the leader must verify in the browser harness

The real "main-thread `longtasks` ≈ 0 during a heavy convert" proof is a **browser** `performance`
measurement (PerformanceObserver `longtask`) the leader runs — Node cannot observe main-thread long tasks
for a real WebCodecs encode. Node coverage here proves the **wiring**: bridge selection, the pool's
concurrency/backpressure/close-once/fallback, and the JobRunner reconstruction (with a fake inner engine),
all green with `typecheck`/`build`/`check-budgets`.
