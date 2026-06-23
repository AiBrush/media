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

| Runs in a Worker (default on) | Runs on main thread (default) |
|---|---|
| decode, encode, filter, mux, convert (the whole heavy graph) | probe / metadata (cheap; worker round-trip not worth it) |

- **Worker bridge:** the main-thread API is a thin proxy; the engine instance (router + drivers + executor) lives in the worker. Heavy data crosses as **Transferables** (`ArrayBuffer`, `ReadableStream`, `VideoFrame` are transferable) to avoid copies.
- **WebCodecs, OffscreenCanvas, WebGPU, WebGL all work in workers** — so the entire decode→filter→encode path runs off-main-thread, including GPU filters via `OffscreenCanvas`.
- A **worker pool** is used for independent parallel jobs (e.g. an ABR ladder fan-out); a single job stays on one worker (the pipeline is already streamed).
- **Cheap-op fast path:** `probe` and tiny ops run on the main thread to avoid the ~ms worker hop; this is configurable.

## 5. Threading & isolation (ADR-006)

- The common path is **single-thread WASM where WASM is used at all**, and needs **no COOP/COEP**.
- An **opt-in** `enableThreads` (default = `crossOriginIsolated`) lets the WASM tail use SIMD + threads via `SharedArrayBuffer` for ~order-of-magnitude speedups on the exotic codecs — only when the page is cross-origin isolated.
- Hardware WebCodecs needs none of this; it is already the fast path with zero isolation.

## 6. The declarative job as the worker/serialization boundary (ADR-010)

The main thread sends the worker a **serializable job spec** (`{ input, ops[], output }`), not function closures. This is what makes the boundary clean (no functions to marshal), the job loggable/replayable, and — later — portable to other runtimes. The flat task API and (post-v1) fluent chain both compile to this job before crossing into the worker.

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
