# 03 — System Architecture

> The structural backbone: layers, C4 views, components, and the data-flow seams. Router internals → [`04`](04-capability-router-and-ladder.md); contracts → [`05`](05-driver-contracts.md); runtime/streaming → [`06`](06-execution-and-runtime.md). Decisions referenced as ADR-NNN ([`02`](02-decision-records.md)).

## 1. The layered model

```
+-------------------------------------------------------------+
| PUBLIC API (07)   createMedia() · convert/probe/trim/...    |  intent only
|                   from()/fromX sources · to* sinks · preload|
+----------------------------|--------------------------------+
                             v
+-------------------------------------------------------------+
| KERNEL  (the only eager code, <= ~50 kB)                    |
|  Normalizer  -> Planner -> Router -> Executor -> Worker-bridge|
|  Registry (capability registry; drivers register lazily)    |
+----------------|--------------------------------|-----------+
                 v (lazy import per op/driver)     v
+-----------------------------+   +---------------------------+
| DRIVERS (05)                |   | SOURCES / SINKS (07/13)   |
|  CodecDriver[]              |   |  ByteSource, FrameSink,   |
|  ContainerDriver[]          |   |  element/OPFS/stream      |
|  FilterDriver[]             |   +---------------------------+
+--------------|--------------+
               v (each driver targets one substrate)
+-------------------------------------------------------------+
| SUBSTRATES (browser-provided / shipped)                     |
|  WebCodecs | WebGPU/WebGL/Canvas | WASM codecs | TS containers|
+-------------------------------------------------------------+
```

**Rule:** dependencies point downward only. The kernel knows the *driver contracts*, never a concrete backend; drivers know one substrate; the public API knows only the kernel. This is what makes backends swappable and the API opaque (ADR-001, ADR-003).

## 2. C4 — Context (level 1)

```
        [ App developer's web app ]
                   |  calls
                   v
        ( aibrush-media engine )
          |        |        |        |        |
          v        v        v        v        v
      WebCodecs  WebGPU/  WebCrypto  OPFS /   <video>/<audio>/
      (codecs)   WebGL    (decrypt)  Streams  MediaStream (I/O)
          |
          v
      WASM codec cores (lazy, same-origin assets)
```

The engine is a **library** embedded in the app's page; it consumes browser platform APIs and (lazily) its own WASM assets. It renders nothing and owns no UI.

## 3. C4 — Containers (level 2): what actually ships & loads

| Container | Form | Loaded |
|---|---|---|
| **Kernel** | ESM JS | eager (app's main bundle) |
| **Op modules** (`convert`, `probe`, …) | ESM chunks | lazy, on first call (code-split) |
| **Driver modules** (webcodecs, mp4, gpu-filters, wasm-flac, …) | ESM chunks | lazy, when the router selects them |
| **WASM cores** (flac, opus, soxr, …) | `.wasm` assets | lazy, on a hardware miss, same-origin via `import.meta.url` (ADR-005) |
| **Worker** | ESM worker script | lazy, on first heavy op (ADR-019) |

See [`08-packaging-and-loading.md`](08-packaging-and-loading.md).

## 4. C4 — Components (level 3): inside the kernel

| Component | Responsibility |
|---|---|
| **Normalizer** | Turn any input (`from()`/polymorphic) into a `ByteSource`/frame source; turn sink requests into writers (ADR-013). |
| **Planner** | Turn an op call (or job spec) into a **stage graph**: source → demux → decode → filter → encode → mux → sink. For `convert`, decide copy-vs-re-encode per stream (ADR-012). |
| **Router** | For each stage, pick a driver by walking the capability ladder (probe → first-supported), cache the verdict, lazy-import the driver ([`04`](04-capability-router-and-ladder.md)). |
| **Registry** | Holds registered drivers by kind; populated as driver modules are imported. |
| **Executor** | Run the stage graph as composed `TransformStream`s with backpressure ([`06`](06-execution-and-runtime.md)). |
| **Worker-bridge** | Move heavy stages off-main-thread; marshal transferables (ArrayBuffers, `VideoFrame`s) (ADR-019). |
| **Error mapper** | Surface typed `MediaError`/`CapabilityError`/`InputError` (ADR-017). |

## 5. The data-flow seams

Two standardized boundaries make stages swappable (this is *why* the substrates compose):

```
 bytes ──demux──▶ EncodedChunk ──decode──▶ RawFrame ──filter──▶ RawFrame ──encode──▶ EncodedChunk ──mux──▶ bytes
                  (EncodedVideoChunk|       (VideoFrame|                              (EncodedVideoChunk|
                   EncodedAudioChunk)        AudioData)                                EncodedAudioChunk)
```

- **Encoded packets** join containers ↔ codecs. A demuxer emits WebCodecs `EncodedVideoChunk`/`EncodedAudioChunk`, which a decoder consumes **directly** — no adapter.
- **Raw frames** (`VideoFrame`/`AudioData`) join codecs ↔ filters ↔ encoders.

Because both seams are WebCodecs-native types, any single stage's driver can change substrate without touching its neighbors.

## 6. Example assembled pipelines

- **`probe(mp4)`** → Normalizer → ContainerDriver(mp4).demux (header only) → TrackInfo. (No codecs; main thread; fast.)
- **`remux(mp4 → mkv)`** → demux(mp4) → [stream-copy packets] → mux(mkv). (No decode/encode.)
- **`convert(mov h264 → mp4 h264, resize 720p)`** → demux → decode(WebCodecs hw) → filter(GPU resize) → encode(WebCodecs hw) → mux(mp4). (Worker; hardware first.)
- **`convert(flac → opus/webm)`** → demux(flac) → decode(**WASM flac**, browser lacks it [data: Finding 8]) → encode(WebCodecs/wasm opus) → mux(webm).

## 7. Architecture evolution (ADR-015)

Phase 1 may ship as an **ARCH-3 monolith** (kernel that directly owns TS containers + WebCodecs + GPU filters, WASM behind a flag) to reach an MVP faster; it is refactored into the full **ARCH-1** router+registry once a second/third driver appears. The **public API and seams do not change** across that refactor — only the internal wiring. See [`12-roadmap.md`](12-roadmap.md).
