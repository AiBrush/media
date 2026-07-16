# Worker & WASM Runtime

> Shard **S03** — cross-cutting substrate. This is the **target spec** (the best design) plus an
> honest delta vs today's code. It owns the worker offload seam and the WASM execution-profile
> resolver: `src/kernel/worker.ts`, `worker-bridge.ts`, `worker-entry.ts`, `worker-host.ts`,
> `worker-main.ts`, `worker-mode.ts`, `worker-pool.ts`, `worker-protocol.ts`, `wasm-runtime.ts`,
> `wasm-loader-runtime.ts`.

## 1. Purpose & scope

This family is the **off-main-thread execution substrate** for the engine: the machinery that (a)
runs the heavy decode→filter→encode→mux graph on a dedicated `Worker` so the page's main thread stays
responsive, and (b) resolves the **WebAssembly execution profile** (baseline single-thread vs isolated
SIMD+threads) that a WASM codec core is instantiated under. It is deliberately a *transport and
lifetime* layer, not a media layer: it moves **serializable jobs** off-thread, streams **byte results**
back under backpressure, maps typed errors across the boundary, and answers one WASM question — "may
this page use `SharedArrayBuffer`-backed threads?" — without ever touching a `.wasm` byte itself.

It serves no single benchmark family; it is **cross-cutting**. Every heavy transcode/convert/trim row
(families `transcode`, `trim`, `streaming-output`) can route through the worker offload, and every WASM
codec tail (families `transcode`, `audio-dsp`, `decode-seek` on a hardware miss) is instantiated through
the profile this shard resolves. Its acceptance is indirect: the offload must be **byte-identical** to
the inline path (so no oracle regresses) while proving `main-thread long-tasks ≈ 0` in a browser
(measured-evidence.md_: only the heavy decode→encode graph — convert and accurate trim — offloads; probe/demux/
stream-copy remux/keyframe trim/PCM/decrypt/seek stay inline because the round-trip is not worth it).

Explicit **non-goals** of this layer: it does not reorder B-frames, does not resolve VFR timing, does
not perform seeks, and does not choose a codec/container — those live in the pipeline (S02), decode
(S10), transcode (S11/S12), and router (S01) shards, and run *inside* the worker via the inner engine
(see §3). This shard is the substrate they run on, and must be transparent to all of them.

## 2. Spec & references

Governing standards (every reference linked):

- **Web Workers** — WHATWG HTML Living Standard, §10 Web Workers (dedicated worker, module worker,
  `WorkerGlobalScope`, `DedicatedWorkerGlobalScope.postMessage`):
  <https://html.spec.whatwg.org/multipage/workers.html>
- **Transferable objects & structured clone** — WHATWG HTML Living Standard, "Transferable objects"
  and "StructuredSerializeWithTransfer" (defines which objects can be *moved* not copied, and that a
  structured clone drops the prototype/subclass — the reason typed errors cross as data):
  <https://html.spec.whatwg.org/multipage/structured-data.html#transferable-objects>
- **WebAssembly instantiation** — W3C WebAssembly JS API (`WebAssembly.instantiate`) and Web API
  (`WebAssembly.instantiateStreaming`, streaming compile):
  <https://webassembly.github.io/spec/js-api/> and <https://webassembly.github.io/spec/web-api/>
- **SharedArrayBuffer & cross-origin isolation** — the COOP/COEP requirement that gates WASM threads:
  <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer>
  and <https://web.dev/articles/coop-coep>
- **WHATWG Streams** — backpressure, `ReadableStream`, `CountQueuingStrategy` (the credit window is
  built on a `highWaterMark:0` readable): <https://streams.spec.whatwg.org/>
- **AbortSignal / AbortController** — WHATWG DOM (cancel plumbing across the boundary):
  <https://dom.spec.whatwg.org/#interface-abortcontroller>
- **WebCodecs** — W3C (the in-worker substrate the handshake probes; WebCodecs is usable in a Worker):
  <https://www.w3.org/TR/webcodecs/>

OSS exemplar — **ffmpeg.wasm** (<https://github.com/ffmpegwasm/ffmpeg.wasm>):

- Worker model: "we offload those task[s] to web worker (`ffmpeg.worker`) by default" — a **single
  primary worker**; the multi-thread core (`@ffmpeg/core-mt`) "spawn[s] more web workers … inside
  `ffmpeg.worker`" via Emscripten pthreads
  (`apps/website/docs/overview.md`, fetched 2026-07-16).
- Core loading: a **monolithic** core (`@ffmpeg/core` single-thread / `@ffmpeg/core-mt` multi-thread)
  "download[ed] … from CDN and initialized … in WorkerGlobalScope" (same doc). The worker source is
  `packages/ffmpeg/src/worker.ts` and the main-thread `FFmpeg` class (`load`/`exec`/`terminate`) is
  `packages/ffmpeg/src/classes.ts`.
- Communication: "all function calls in ffmpeg.wasm are asynchronous" — a `postMessage` request/reply
  protocol; `exec` runs a whole command, and `log`/`progress` come back as callbacks.

**Where the SOTA design must beat the exemplar** (this drives §5): ffmpeg.wasm loads a **multi-MB core
up front from a CDN**, runs a **whole command file-in/file-out** (no streaming backpressure), and needs
**COOP/COEP** for its threaded core. aibrush-media must instead (1) keep **WebCodecs first** so the
worker mostly moves *bytes around a hardware pipeline*, not a WASM codec; (2) load **per-codec permissive
cores lazily, miss-only, same-origin** via `import.meta.url` (no CDN); (3) **stream** results back under a
credit window; and (4) require **no COOP/COEP on the common path**. Where it must *match* ffmpeg.wasm:
its single-thread reality — measured-evidence.md_ records that **no benchmark winner anywhere used WASM threads**
(ffmpeg.wasm won all 129 of its wins single-threaded; 56% of all wins ran `coopCoep:not-required` and
`wasmThreads:0`). The threaded profile is therefore an opt-in tail, not the spine.

## 3. Target design

### 3.1 Data model & seams

The offload is **data, never a closure** (ADR-010): a heavy op is serialized to an `OffloadJob` — a
discriminated op (`'decode' | 'encode' | 'convert' | 'transcode' | 'trim' | 'filter' | 'mux' |
'remux'`), a structured-cloneable `payload`, and the input byte buffers listed for transfer
(`worker-protocol.ts:51`). The wire has exactly three host→worker messages (`job` / `credit` / `cancel`,
`worker-protocol.ts:98`) and five worker→host (`ready` / `chunk` / `progress` / `done` / `error`,
`worker-protocol.ts:145`), every one stamped with a monotonic **`JobEpoch`** (`worker-protocol.ts:73`)
so a transport reused across jobs by the pool can never cross-talk.

Seams, top to bottom:

- **`worker-mode.ts`** — the pure, dependency-free decision (`selectWorkerMode`, `resolvePoolSize`,
  `workerOffloadAvailable`, `worker-mode.ts:20`,`:32`,`:51`). It is split out so the eager kernel reads
  the mode without dragging the heavy bridge into its byte budget.
- **`worker-bridge.ts`** — host-side transport: `InlineBridge` (run a closure on the calling thread,
  `worker-bridge.ts:38`) and `WorkerStreamBridge` (ship an `OffloadJob`, stream results under a credit
  window, `worker-bridge.ts:71`). One bridge = one worker = one job at a time.
- **`worker-pool.ts`** — `WorkerPool` fans K independent jobs across N bridges with work-stealing
  (`worker-pool.ts:63`), the ABR ladder substrate; `inlineWorkerPool` is the honest no-Worker fallback
  (`worker-pool.ts:319`).
- **`worker-host.ts`** — the lazy integration chunk the engine calls: spawn + `ready{webcodecs}`
  handshake + downgrade (`ensureWorkerBridge`, `worker-host.ts:54`), pool build
  (`createWorkerPool`, `:82`), the process-wide shared-pool cache (`SHARED_POOLS`, `:302`), payload
  marshaling (`buildOffloadPayload`, `:219`), and the source→bytes→job→bytes round-trip
  (`runOffloadStream`, `:409`).
- **`worker.ts`** — the browser-only boot: the module a real `Worker` loads, which binds `self` to the
  runtime and constructs the real `MediaEngineImpl` forced `worker:false` (`worker.ts:63`, so the inner
  engine never re-spawns a worker).
- **`worker-entry.ts`** — the worker-side pump: receive a job, run the `JobRunner`, transfer each chunk
  under credit, serialize a thrown error (`runOffloadWorker`, `worker-entry.ts:49`).
- **`worker-main.ts`** — the pure, Node-testable reconstruction: rebuild a seekable source from bytes,
  force `sink: toStream()`, call the **same public op** on the inner engine (`makeJobRunner`,
  `worker-main.ts:133`).
- **`wasm-runtime.ts` / `wasm-loader-runtime.ts`** — the WASM profile resolver and asset-URL builder
  (`resolveWasmRuntimeProfile`, `wasm-runtime.ts:69`; `wasmInitForProfile`, `wasm-loader-runtime.ts:41`).

### 3.2 Capability routing (WebCodecs → GPU → WASM, miss-only) as it touches this layer

The developer never names a backend; they pass `worker:true|false|{pool:N}` and the engine decides the
*thread*, while the router (S01) decides the *tier*. Two honest gates apply here:

1. **Can we offload at all?** `selectWorkerMode` returns `'offload'` **only** when the caller opted in
   *and* a `Worker` constructor exists (`worker-mode.ts:40`); otherwise `'inline'`. A missing `Worker`
   is never faked — it is the honest inline fallback (Prime Directive 6).
2. **Does the worker actually have the substrate?** The freshly-spawned worker posts
   `ready{webcodecs}` (`worker-entry.ts:151`) and the host downgrades to the inline path on
   `webcodecs:false`, spawn throw, or handshake timeout (`ensureWorkerBridge`, `worker-host.ts:66`).
   This is the "WebCodecs runs *inside* the worker" check the static mode decision cannot answer.

WASM is **not** loaded by this layer. On a hardware miss the pipeline (inside the worker or inline)
lazily `import()`s a per-codec core via `import.meta.url`; this shard only answers the profile question:
`resolveWasmRuntimeProfile` returns `isolated-simd-threads` **only** when `crossOriginIsolated` *and*
`SharedArrayBuffer` are both present *and* threads were requested, else a `baseline` profile carrying a
`reason` (`wasm-runtime.ts:69-88`). `enableThreads` defaults to `crossOriginIsolated`
(`wasm-runtime.ts:71`) so the common, non-isolated path is single-threaded and needs no COOP/COEP —
matching the measured reality that no winner used threads.

**The best design keeps the profile honest**: an `isolated-simd-threads` verdict must instantiate a
*distinct threaded core asset*; if none is vendored it must not be claimed (see §5, item 3). A true
capability miss (a threaded-only core with no isolation) raises a typed `CapabilityError`, never a silent
downgrade to a wrong result (`requireIsolatedWasmProfile`, `wasm-loader-runtime.ts:26`).

### 3.3 Edge cases (explicit)

**Frame lifetime — every `VideoFrame`/`AudioData` `close()`d exactly once.** This is the central
invariant. On the production convert/trim path **no frame ever crosses the boundary** — the inner
engine's inline pipeline creates, uses, and closes every frame on the worker thread; only encoded
`ArrayBuffer` chunks transfer back (`worker-main.ts:191`, and measured-evidence.md_ ADR-087). The protocol
*supports* transferring a real frame (`ChunkMessage.frame: Transferable`, `worker-protocol.ts:115`), and
the bridge implements a full close-once machine for it: a transferred chunk makes the host the sole
owner (`worker-bridge.ts:207`); an undelivered frame sitting in the internal `queue` at teardown is
drained closed (`drainQueue` → `closeFrame`, `worker-bridge.ts:163`); a chunk arriving after the stream
has settled, or for a **stale epoch**, is closed rather than dropped (`worker-bridge.ts:196-204`); and on
the worker side a chunk whose `postMessage` throws is closed locally before re-throw
(`worker-entry.ts:122-126`). The target design closes the one hole this machine has today: because the
production DOM `Worker` adapter's `removeEventListener` is a **no-op** (`worker-host.ts:150`), a prior
job's listener stays attached on a reused bridge and would double-close the *current* job's frame — safe
today only because production transfers `ArrayBuffer`s (whose `closeFrame` is a no-op) but a latent
double-close the moment a real frame path ships (§5, item 1).

**Backpressure.** A **credit window** bounds in-flight chunks: the host grants `credit` permits (default
`DEFAULT_CREDIT = 4`, `worker-bridge.ts:62`), the worker may send at most that many chunks before
awaiting a `credit` replenishment (`worker-entry.ts:88`,`:122`), and the host returns exactly one permit
per chunk the consumer takes (`deliverOne`, `worker-bridge.ts:180-190`). The readable uses
`highWaterMark:0` (`worker-bridge.ts:272`) so `pull` fires once per consumer read and decoded frames
never pile up — the invariant is `queue.length ≤ credit`. Backpressure is preserved end-to-end because
`worker-main.ts`'s result stream is lazy: its first `pull` defers the inner op's first byte until the
host actually reads (`worker-main.ts:174-179`).

**Cancel.** A caller `AbortSignal` abort posts `{t:'cancel'}` and immediately errors the host stream
`aborted` (`worker-bridge.ts:244-249`); the worker aborts its `AbortController` **only if the epoch
matches** (`worker-entry.ts:75-82`) so a stale cancel from a finished job on a reused bridge can't abort
the job now running. On abort the worker stays silent — it emits neither `done` nor `error`
(`worker-entry.ts:128-135`) — because the host already settled locally; the reader is cancelled in
`finally` so drivers release WebCodecs/WASM and close in-flight frames (`worker-entry.ts:142`). The pool
threads a per-job `AbortController` so `abortAll()` tears every rendition down (`worker-pool.ts:124`).

**Seek.** Not performed by this layer, but the layer *enables* it: the worker cannot receive a `Source`
(its `stream()`/`range()` are closures that don't survive structured clone, measured-evidence.md_ ADR-019), so
the host reads the input to **bytes** and the worker rebuilds a **seekable** `fromBytes` source
(`worker-main.ts:225-231`) precisely so the inner demux can seek to the `moov`. The seek logic is S10's.

**B-frames.** N/A at this layer — DTS/PTS reorder is the inner pipeline's concern (S11); the worker is a
transparent byte transport and must produce byte-identical output to the inline path on a B-frame
fixture (the validation gate, §5 item 9).

**VFR (variable frame rate).** N/A at this layer for the same reason — per-frame timestamp handling
lives in the pipeline; the runtime neither inspects nor rewrites frame timing. Progress is derived from
timestamps by the pipeline and merely forwarded as a `progress` message (`worker-entry.ts:99-107`).

## 4. Current state

What exists today, with citations, and the smells.

- **Mode selection is opt-in and pure.** `selectWorkerMode(undefined|false, …) → 'inline'`,
  `worker:true|{pool}` + a `Worker` → `'offload'` (`worker-mode.ts:40-42`); `resolvePoolSize` clamps
  `{pool:N}` to ≥1, else 1 (`worker-mode.ts:51-56`). **Smell:** the leading JSDoc on `selectWorkerMode`
  claims "`true`/`{pool}`/**unset** default to offload" (`worker-mode.ts:28-30`), which contradicts the
  body (unset → inline, `:40`) and the correct inline comment (`:36-39`). Doc/code drift.
- **Protocol is clean and DOM-free.** `worker-protocol.ts` imports only `contracts/errors` and
  `contracts/driver` and touches plain objects, so it loads in Node and a real Worker alike. Typed
  errors cross as data (`SerializedError` + `serializeError`/`deserializeError`,
  `worker-protocol.ts:160`,`:168`,`:186`) so `instanceof CapabilityError`/`.code` survive the boundary;
  `safeDetail` drops non-cloneable detail (`worker-protocol.ts:204`). `collectTransferables` deep-walks a
  payload (`worker-protocol.ts:225`). **Smells:** (a) the walk silently stops at `depth > 4`
  (`worker-protocol.ts:229`) — a deeper transferable is silently copied or throws at post; (b)
  `isFrameLike` matches any `{close, width}` structurally (`worker-protocol.ts:273-287`) — could
  mis-transfer a plain options object; (c) `ReadyMessage.webcodecs` (`worker-protocol.ts:103`) names one
  backend on the wire (capability leak, see below).
- **Bridge + pump implement the credit window and close-once.** `WorkerStreamBridge`
  (`worker-bridge.ts:71`) with `#epoch` (`:82`), busy-guard (`:102`), stale/settled frame-close
  (`:196-204`), `drainQueue` (`:163`), `deliverOne` credit (`:180`). Correct and well-reasoned.
- **Worker-side pump is correct.** `runOffloadWorker` (`worker-entry.ts:49`) with epoch-gated
  credit/cancel (`:70`,`:78`), transfer-or-close (`:122-126`), silent-on-abort (`:128-135`). **Smell:**
  `hasWebCodecs()` probes only `VideoDecoder`/`VideoEncoder` (`worker-entry.ts:156-158`) — ignores
  audio-only (`AudioDecoder`/`AudioEncoder`) and GPU; the honest gate is video-centric.
- **`worker-host.ts` is a 506-line god-file** mixing six concerns: spawn/handshake/downgrade
  (`ensureWorkerBridge`, `worker-host.ts:54`), pool build (`createWorkerPool`, `:82`), the **process-wide
  mutable singleton** `SHARED_POOLS = new Map<number, …>()` (`:302`) with a test-only backdoor
  `__resetSharedOffloadPools()` (`:326`), payload marshaling (`buildOffloadPayload`, `:219`), a
  **duplicated source reader** `readAllSource` ("mirrors the engine's own reader", `:469-502`), and ABR
  orchestration (`offloadAbrLadder`, `:372`). **Smells:** the adapter's no-op `removeEventListener`
  (`:150-153`); a redundant full-input copy in `runOffloadStream` (`:417-420`, see §5 item 5); the
  module-global `SHARED_POOLS` (justified by ADR-087's spawn-storm fix but still module-global mutable
  state with a public reset).
- **Inner reconstruction is a thin adapter, not a reimplementation.** `worker-main.ts` validates the
  untrusted payload (`decodeOffloadPayload`, `worker-main.ts:105`), rebuilds a seekable source
  (`sourceFromPayload`, `:225`), forces `sink: toStream()` and calls the same `convert`/`trim`
  (`runInnerOp`, `:203-222`), narrowing the result to a byte stream (`asByteStream`, `:238`). Clean.
- **WASM profile resolver is honest but its loader is a stub.** `resolveWasmRuntimeProfile`
  (`wasm-runtime.ts:69`) and `normalizeWasmAssetBaseUrl` (`:19`, same-origin/no-credentials/trailing-slash
  rules) are correct. **Smell:** `wasmInitForProfile` returns the **same** `{ module_or_path: moduleUrl }`
  for *both* `baseline` and `isolated-simd-threads` (`wasm-loader-runtime.ts:45-51`) — so a resolved
  threaded profile loads the baseline asset and **no core actually uses SIMD/threads** (measured-evidence.md_
  flags this as ADR-006/ADR-020 debt to close).
- **Boot is guarded and lazy.** `worker.ts` auto-boots only in a real worker scope (`bootWorkerMain`,
  `worker.ts:77-91`) and reaches the heavy engine via a dynamic `import('../api/engine.ts')`
  (`worker.ts:41-46`) so the eager kernel never statically pulls it.

## 5. Delta / punch-list

Ordered by severity. Each item: the change + a concrete acceptance test referencing `path:line`.

1. **Fix the no-op `removeEventListener` in the DOM `Worker` adapter (listener leak + latent
   double-close).** `adaptWorker.removeEventListener` is `void [type, listener]`
   (`worker-host.ts:150-153`) and `addEventListener` wraps the listener in a fresh anonymous closure
   each call (`:148-149`), so on a real DOM `Worker` no listener is ever removed. Because a pool reuses
   one bridge across jobs and lives for the page (`SHARED_POOLS`, never terminated), each job's
   `#pump` listener (`worker-bridge.ts:159`) accumulates, and a prior job's stale listener will
   `closeFrame` the *current* job's chunk (`worker-bridge.ts:196-198`) — a double-close the moment a
   real `VideoFrame` path ships (masked today only because `ArrayBuffer.closeFrame` is a no-op). Fix:
   keep a `Map<listener, wrapper>` in the adapter so `removeEventListener` detaches the exact wrapper.
   **Acceptance:** a test driving ≥2 sequential jobs through one `WorkerStreamBridge` over an
   `EventTarget`-backed adapter asserts the adapter's attached-`message`-listener count returns to its
   pre-job baseline after each job settles (net-zero), and that a stale-epoch `chunk` carrying a
   `{ close }` frame calls `close` **exactly once** (spy asserts a single call).

2. **Reconcile `selectWorkerMode` JSDoc with its opt-in body.** The leading JSDoc
   (`worker-mode.ts:28-30`) says unset/`true`/`{pool}` "default to offload"; the body returns `'inline'`
   for `undefined` (`:40`). Correct the doc to the opt-in reality (measured-evidence.md_ ADR-087: unset/`false` →
   inline, the safe default). **Acceptance:** a unit test asserts `selectWorkerMode(undefined, true) ===
   'inline'` and `selectWorkerMode(true, true) === 'offload'`, and the JSDoc no longer states
   unset→offload (grep the file for the corrected wording).

3. **Make the `isolated-simd-threads` profile load a distinct asset — or stop claiming it.**
   `wasmInitForProfile` returns identical `module_or_path` for `baseline` and `isolated-simd-threads`
   (`wasm-loader-runtime.ts:45-51`), so threads/SIMD are resolved but never used (measured-evidence.md_ ADR-006
   debt). Choose one: (a) select a sibling threaded core URL (e.g. `*.threads.wasm`) for the isolated
   profile; or (b) until a threaded core is vendored, route the isolated verdict through
   `requireIsolatedWasmProfile`/decline so no code advertises threads it can't run (defensible — no
   benchmark winner ever used WASM threads, measured-evidence.md_). **Acceptance:** option (a) — a test asserts
   `wasmInitForProfile(url, {kind:'isolated-simd-threads', …}).module_or_path.href !==
   wasmInitForProfile(url, {kind:'baseline', …}).module_or_path.href`; option (b) — a test asserts no
   registered core resolves to `isolated-simd-threads` (the engine never advertises a threaded
   capability it lacks).

4. **Avoid the redundant full-input copy in `runOffloadStream`.** `bytes.buffer.slice(byteOffset,
   byteOffset+byteLength)` (`worker-host.ts:417-420`) always copies the whole input before transfer, but
   `readAllSource`'s stream branch already returns an exact-length `new Uint8Array(total)`
   (`:494`), so `bytes.buffer` is already the exact transferable — this doubles peak memory and does an
   O(n) copy for nothing on the common streamed path (the `src.range` branch, `:472-475`, genuinely may
   return a subview and still needs the slice). Fix: adopt `bytes.buffer` directly when
   `bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength`, else slice.
   **Acceptance:** a test with a stream-only source asserts the posted job's `payload.input ===
   bytes.buffer` (zero-copy adopt) and a range source still transfers an exact-length copy; peak
   allocation for an 8 MiB input is ~8 MiB not ~16 MiB (mirrors the measured-evidence.md_ terminal-collector
   adopt-vs-copy measurement, 0.0099 ms vs 0.506 ms on 8 MiB).

5. **Split `worker-host.ts` (506 lines, six concerns) and delete the duplicated source reader.** Extract
   `worker-spawn.ts` (spawn + `awaitReady` + `ensureWorkerBridge`, `worker-host.ts:54-183`),
   `offload-pool-cache.ts` (`SHARED_POOLS` + `ensureOffloadPool`, `:278-328`), and `offload-marshal.ts`
   (`buildOffloadPayload` + `runOffloadStream` + `asBytes`, `:219-467`); replace `readAllSource`
   (`:469-502`) with the engine's single source-reader (S06). **Acceptance:** `readAllSource` deleted, a
   test proves the shared reader yields byte-identical output vs the old function on the same fixture;
   each new module < ~150 lines; the existing `worker-host` tests stay green (behavior unchanged).

6. **Make the readiness handshake backend-neutral and per-op accurate.** `ReadyMessage.webcodecs`
   (`worker-protocol.ts:103`) and `hasWebCodecs()` (`worker-entry.ts:156-158`) hardwire one backend and
   probe only video, so an audio-only convert offloaded to a worker with audio-but-no-video WebCodecs is
   mis-gated. Carry `ready.caps: { video: boolean; audio: boolean }` and gate the downgrade on the caps
   the job needs (`ensureWorkerBridge`, `worker-host.ts:66`). **Acceptance:** a test where the worker
   reports `{ video:false, audio:true }` — an audio-only job proceeds on the worker while a video job
   downgrades to inline; a video+audio job requires both true.

7. **Derive the transfer list from typed payload fields, not a heuristic deep-walk.** `collectTransferables`
   stops at `depth > 4` (`worker-protocol.ts:229`) and `isFrameLike` matches any `{close, width}`
   (`:273-287`), so a nested transferable is silently copied and a plain options object could be
   wrongly transferred. Replace the walk with an extractor over the declared transferable fields of the
   typed `OffloadJobPayload` (today just `payload.input`). **Acceptance:** a test asserts an ArrayBuffer
   nested at depth 5 in a payload is still transferred (or that the typed extractor lists exactly
   `payload.input`), and that a `{ close(){}, width:2 }` options field is **not** transferred.

8. **Scope the shared-pool lifetime instead of a module global.** `SHARED_POOLS` (`worker-host.ts:302`)
   is a process-global mutable `Map` never terminated, with a public test backdoor
   `__resetSharedOffloadPools()` (`:326`). Keep the spawn-storm fix (ADR-087) but own the registry on an
   explicit runtime context so lifetime is scoped and tests need no backdoor. **Acceptance:** a test
   asserts two engines at the same pool size share **one** worker spawn (spawn counter === 1) and that
   disposing the owning runtime terminates the shared pool (no worker survives), replacing
   `__resetSharedOffloadPools`.

9. **Prove the runtime is transparent to B-frames / VFR / seek (validation gate, not a code fix).** The
   worker rebuilds a seekable source (`worker-main.ts:225-231`) and forces `worker:false` inner
   (`worker.ts:63`) so the inline graph runs unchanged off-thread. **Acceptance:** an offloaded `convert`
   of a B-frame-reorder fixture **and** a VFR fixture each produce a **byte-identical** result (same
   SHA-256) to the inline `convert` of the same fixture — the oracle that the runtime added nothing and
   dropped nothing.

## 6. Open questions

Each seeds a decision to log in `docs/decisions/`.

1. **Threaded WASM: distinct asset, or decline until vendored?** No benchmark winner used WASM threads
   (measured-evidence.md_) and no threaded core is vendored, yet `resolveWasmRuntimeProfile` can return
   `isolated-simd-threads`. Decide whether to wire a distinct `*.threads.wasm` asset (item 3a) or make
   the profile a typed `CapabilityError` until a real threaded core lands (item 3b). Recommendation lean:
   3b, since the fast path is hardware WebCodecs and threads are an unproven tail.

2. **Shared-pool ownership: process-global vs runtime-scoped.** `SHARED_POOLS` fixes the per-op spawn
   storm (ADR-087) but is a module global with a test reset. Decide whether the SOTA registry lives on an
   explicit engine-shared runtime object (scoped lifetime, no backdoor) and how a page disposes it.

3. **Handshake capability descriptor.** Should the wire carry a generic `caps { video, audio, gpu }`
   instead of a single `webcodecs` boolean, and should the downgrade be per-op (a video job vs an
   audio-only job)? This is required for correct audio-only offload (item 6).

4. **Is the cross-thread frame path a permanent feature or dead surface?** The protocol and bridge fully
   implement transferring `VideoFrame`/`AudioData` with close-once, but production convert/trim only ever
   transfers `ArrayBuffer`s (measured-evidence.md_ ADR-087); the frame machinery is exercised only by synthetic
   tests. Decide whether to keep it as a first-class future capability (e.g. off-thread decode-to-frames)
   — in which case item 1 becomes load-bearing — or delete it to shrink the surface.

5. **GOP-parallel single-op encode.** Today one job stays on one worker; fan-out is only across
   *independent* jobs (ABR ladder, `worker-pool.ts:63`). Decide whether a single heavy `convert` should
   ever be GOP-split across workers for throughput, and whether that is worth the reorder/merge
   complexity given WebCodecs is already hardware-fast.

6. **Depth-4 transferable walk vs typed extraction.** Formalize the transfer contract (item 7): does the
   payload declare its transferable fields, or does the runtime keep a bounded heuristic walk? A typed
   contract removes both the silent-depth-cap and the `isFrameLike` false-positive risks.

---

### External references

- WHATWG HTML — Web Workers: <https://html.spec.whatwg.org/multipage/workers.html>
- WHATWG HTML — Transferable objects / structured clone:
  <https://html.spec.whatwg.org/multipage/structured-data.html#transferable-objects>
- W3C WebAssembly JS API: <https://webassembly.github.io/spec/js-api/>
- W3C WebAssembly Web API (streaming): <https://webassembly.github.io/spec/web-api/>
- MDN — `SharedArrayBuffer`:
  <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer>
- web.dev — cross-origin isolation (COOP/COEP): <https://web.dev/articles/coop-coep>
- WHATWG Streams (backpressure): <https://streams.spec.whatwg.org/>
- WHATWG DOM — `AbortController`: <https://dom.spec.whatwg.org/#interface-abortcontroller>
- W3C WebCodecs: <https://www.w3.org/TR/webcodecs/>
- OSS exemplar — ffmpeg.wasm: <https://github.com/ffmpegwasm/ffmpeg.wasm>
  (`apps/website/docs/overview.md`, `packages/ffmpeg/src/worker.ts`, `packages/ffmpeg/src/classes.ts`)

> **UNVERIFIED:** the precise ffmpeg.wasm main↔worker message-type registry (an `id`-keyed
> promise/callback table in `packages/ffmpeg/src/worker.ts`/`classes.ts`) was not fetched directly (only
> `apps/website/docs/overview.md` was retrieved, which confirms the single `ffmpeg.worker`, the
> `@ffmpeg/core` vs `@ffmpeg/core-mt` split, CDN core loading, and async calls). The COOP/COEP
> requirement for the `-mt` core is the documented Emscripten-pthreads/`SharedArrayBuffer` requirement
> (see the web.dev and MDN links), not a line quoted from that overview.
