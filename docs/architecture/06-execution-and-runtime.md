# 06 — Execution & Runtime

> How a planned pipeline actually runs: the graph executor, web-streams data flow, the worker-first runtime, frame lifetime, cancellation, progress, and errors. Structure → [`03`](03-system-architecture.md); driver streams → [`05`](05-driver-contracts.md). Decisions: ADR-015 (ARCH), ADR-019 (worker), ADR-006 (threads).

## 1. The executor: a graph of `TransformStream`s

The Planner emits a stage graph; the Executor wires each stage's driver-provided `TransformStream` together with `pipeThrough`/`pipeTo`. The web-streams runtime then drives the whole pipeline with **automatic backpressure** — a slow encoder naturally throttles the demuxer, so memory stays bounded (this is what the benchmark's `streaming-output` family rewards).

```ts
// convert(mov h264 -> mp4 h264, resize 720p), conceptually:
const demux  = await mp4.demux(source)
const vIn    = demux.packets(videoTrackId)                      // ReadableStream<EncodedChunk>
const out =
  vIn
    .pipeThrough(webcodecsVideo.createDecoder(decCfg, opt))     // -> VideoFrame
    .pipeThrough(gpuFilter.createFilter(resize720, opt))        // -> VideoFrame
    .pipeThrough(webcodecsVideo.createEncoder(encCfg, opt))     // -> EncodedChunk
// muxer consumes encoded video + (copied) audio, produces bytes:
await pumpIntoMuxer(out, copiedAudio, mp4.createMuxer({ faststart: true }))
```

Single-stage ops are degenerate graphs: `probe` is demux-header-only; `remux` is demux → mux with the packet stream copied (no codec stages).

## 2. Why web streams (not arrays / callbacks)

- **Bounded memory** on huge inputs — never buffer a whole file; the `demux/size_massive_*` and `streaming-output/*` cases depend on this.
- **Backpressure** is built in and composes across stages.
- **Cancellation** is built in (`signal` + stream `cancel`).
- **Transferable** across the worker boundary (a `ReadableStream` can be transferred), and composes with `fetch().body` and OPFS writers.

## 3. Frame lifetime — the rule that prevents leaks

WebCodecs `VideoFrame` and `AudioData` (and `ImageBitmap`) are **ref-counted handles to GPU/native memory** and **must be explicitly `close()`d**; the GC will not reclaim them in time. Mismanaging this is the #1 source of decoder stalls and OOM.

**Rules enforced by the executor and required of drivers:**
- Each frame is `close()`d exactly once, by the **last stage that consumes it**. A filter that outputs a new frame closes its input; a sink that renders/encodes closes what it consumed.
- Decoders honor backpressure: do not outrun the encoder/sink (the stream's desired-size signals when to pause `decode()`), or decoded frames pile up in GPU memory.
- On `abort`/error, every in-flight frame is `close()`d in the stream's `cancel`/`abort` handler.
- Cloning a frame for fan-out (e.g. preview + encode) uses `frame.clone()` and tracks both closes.

## 4. Worker-first runtime (ARCH-4, ADR-019)

Heavy stages must not block the main thread (the `longtasks` metric decided many benchmark wins).

| Runs in a Worker (opt-in: `worker:true`/`{pool}`) | Runs on main thread (default) |
|---|---|
| decode, encode, filter, mux, convert (the whole heavy graph) | probe / metadata (cheap); and everything when offload is not opted in |

- **Worker bridge:** the main-thread API is a thin proxy; the engine instance (router + drivers + executor) lives in the worker. Heavy data crosses as **Transferables** (`ArrayBuffer`, `ReadableStream`, `VideoFrame` are transferable) to avoid copies.
- **WebCodecs, OffscreenCanvas, WebGPU, WebGL all work in workers** — so the entire decode→filter→encode path runs off-main-thread, including GPU filters via `OffscreenCanvas`.
- A **worker pool** is used for independent parallel jobs (e.g. an ABR ladder fan-out); a single job stays on one worker (the pipeline is already streamed).
- **Cheap-op fast path:** `probe` and tiny ops run on the main thread to avoid the ~ms worker hop; this is configurable.

**As implemented (ADR-087).** The engine offloads a heavy `convert`/`trim` by **serializing the op, not the pipeline**: the host ships an `OffloadJob` carrying the input bytes (transferred) + the flat public options minus `sink`; the worker (`worker.ts` → `worker-main.ts:makeJobRunner`) reconstructs a `fromBytes` source and runs the **same op on a real inner `MediaEngineImpl` forced `worker:false`**, forcing the sink to a stream and **streaming only the encoded bytes back** — for convert/trim **no `VideoFrame`/`AudioData` ever crosses the boundary** (each frame lives and dies inside the inner engine's already-validated pipeline; only bytes are Transferables on this path). Offload is **opt-in**: the engine selects the mode once (`selectWorkerMode`, in the dependency-free `worker-mode.ts`) — `worker:true`/`{pool}` ⇒ offload, an **unset or `false` `worker` ⇒ inline** (the safe default: no surprise Worker spawn per heavy op) — and only when opted in lazily spawns a `WorkerPool` of `resolvePoolSize(worker)` workers (`createWorkerPool`), **gated on a probe worker's `ready{webcodecs}` handshake**; any spawn/handshake failure (incl. no `Worker`, as in Node) downgrades to the inline path with no behaviour change. Because the pool **reuses** one bridge across successive jobs, every protocol message is tagged with a monotonic **job `epoch`**: the host/worker ignore any message from a stale epoch (closing a stale chunk's frame so nothing leaks), and an aborted job ends silently — so a reused bridge can never cross-talk between jobs. The eager kernel reaches only the tiny pure selectors; the worker boot is a separate `dist/worker.js` chunk referenced via `new URL('./worker.js', import.meta.url)`, and the spawn/pool/glue is a lazy `import('worker-host.ts')` chunk (kernel byte budget preserved).

## 5. Threading & isolation (ADR-006)

- The common path is **single-thread WASM where WASM is used at all**, and needs **no COOP/COEP**.
- An **opt-in** `enableThreads` (default = `crossOriginIsolated`) lets the WASM tail use SIMD + threads via `SharedArrayBuffer` for ~order-of-magnitude speedups on the exotic codecs — only when the page is cross-origin isolated.
- The runtime profile is resolved before a WASM core is instantiated: `baseline` never exposes `SharedArrayBuffer`, while `isolated-simd-threads` is selected only when both `crossOriginIsolated === true` and `SharedArrayBuffer` exists. A threaded-only core must raise a typed `CapabilityError` when those conditions are absent; first-party baseline cores simply stay correct-but-slower.
- Hardware WebCodecs needs none of this; it is already the fast path with zero isolation.

## 6. The declarative job as the worker/serialization boundary (ADR-010)

The main thread sends the worker a **serializable job spec** (`{ input, ops[], output }`), not function closures. This is what makes the boundary clean (no functions to marshal), the job loggable/replayable, and — later — portable to other runtimes. The flat task API is the canonical execution path today; the fluent chain delegates to those same flat ops and can compile to this job boundary when the serialized runner becomes primary.

## 7. Cancellation

`AbortSignal` threads through every stage's `StageOptions`. Aborting:
1. cancels the source `ReadableStream`,
2. propagates `cancel`/`abort` down the pipe,
3. each driver releases its WebCodecs/WASM resources and `close()`s in-flight frames,
4. the op promise rejects with `MediaError{ code: 'aborted' }`.

A `media.convert(...)` returns a handle exposing `.cancel()` in addition to accepting `{ signal }`.

## 8. Progress

`onProgress` is invoked with `{ done, total?, stage }`. Progress is derived from demuxed/encoded timestamps against the known duration (from probe), so it is monotonic and meaningful even while streaming. Workers post progress messages to the main-thread proxy.

## 9. Error propagation

Driver/stream errors become typed `MediaError`s (`decode-error`/…); the executor maps stream rejections, attaches the failing `stage`, tears down the pipeline (closing frames), and rejects the op. Capability misses are raised earlier by the router (ADR-017) before any stream starts. Nothing degrades silently (ADR-018).

## 10. Backpressure & memory budget (summary)

- The encoder/sink is the pace-setter; the decoder pauses when downstream is full.
- A bounded queue of in-flight frames (small, e.g. a few) keeps GPU memory flat regardless of input length.
- Large byte I/O uses streams + OPFS so a 2-hour file never materializes in memory.
