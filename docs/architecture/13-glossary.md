# 13 — Glossary

Terms used across the architecture docs.

## Engine concepts

- **Substrate** — an execution mechanism a stage can run on: hardware **WebCodecs**, the **GPU** (WebGPU/WebGL/Canvas), **native** browser/CPU code (software WebCodecs or pure-TS CPU filters), **WASM** (codec/filter tails), or hand-written **TS** containers.
- **Tier** — a substrate's rank for a stage: `hardware` > `gpu` > `native` (software WebCodecs) > `wasm`. The router tries best-first.
- **Driver** — an adapter implementing one stage on one substrate (e.g. a WebCodecs H.264 codec driver, an MP4 container driver, a WASM FLAC decoder). The unit of extension. See [`05`](05-driver-contracts.md).
- **Capability ladder** — the ordered list of strategies the router walks for a stage, picking the first the environment supports. See [`04`](04-capability-router-and-ladder.md).
- **Capability probe** — the cheap check a driver answers to say "can I do this here?" (codecs wrap `isConfigSupported`; containers use magic bytes; filters check `navigator.gpu`).
- **Seam** — a standardized boundary where stages connect: **encoded packets** (containers↔codecs) and **raw frames** (codecs↔filters). Both use WebCodecs-native types so substrates compose.
- **Kernel** — the small eager core: Normalizer, Planner, Router, Registry, Executor, Worker-bridge.
- **Planner** — turns an op call/job into a stage graph and decides copy-vs-re-encode.
- **Router** — picks a driver per stage via the ladder; lazy-imports it.
- **Registry** — holds registered drivers by kind.
- **Executor** — runs the stage graph as composed `TransformStream`s with backpressure.

## Operations

- **probe** — read metadata without decoding.
- **demux / mux** — container → packets / packets → container.
- **remux** — container → container by stream-copy (no re-encode).
- **decode / encode** — packets ↔ raw frames.
- **trim** — cut a time range (keyframe-copy or frame-accurate).
- **convert** (= **transcode**) — produce target container/codecs; auto-routes copy-vs-re-encode; applies filters.
- **decrypt** — remove CENC/HLS encryption given keys.

## Browser platform

- **WebCodecs** — browser API for low-level `VideoDecoder/Encoder`, `AudioDecoder/Encoder`; hardware-accelerated when available.
- **VideoFrame / AudioData** — WebCodecs raw-media handles; **ref-counted**, must be `close()`d ([`06`](06-execution-and-runtime.md) §3).
- **EncodedVideoChunk / EncodedAudioChunk** — WebCodecs encoded units (a "packet" at the codec seam).
- **`isConfigSupported`** — WebCodecs static method that authoritatively reports codec/config support; the source of truth for routing.
- **WebGPU / WebGL / Canvas2D / OffscreenCanvas** — GPU substrates for pixel filters; OffscreenCanvas runs in workers.
- **Web Streams** (`ReadableStream`/`WritableStream`/`TransformStream`) — the streaming/backpressure primitive the pipeline is built on.
- **Worker / Worker pool** — off-main-thread execution for heavy ops.
- **WebCrypto** (`crypto.subtle`) — AES decrypt for CENC/HLS.
- **OPFS** — Origin Private File System; large output without holding it in memory.
- **MSE** (Media Source Extensions) — `SourceBuffer` append for progressive playback into a `<video>`.
- **`import.meta.url`** — module URL; with `new URL('./x.wasm', import.meta.url)` lets bundlers emit the WASM/worker as a same-origin asset (ADR-005).
- **`WebAssembly.instantiateStreaming`** — fastest WASM compile path (compile while fetching).
- **COOP/COEP / cross-origin isolation / SharedArrayBuffer** — headers/state required for WASM threads; opt-in only (ADR-006).

## Containers, codecs, media

- **Container** — file format wrapping coded streams: MP4/MOV, WebM/MKV, Ogg, WAV, ADTS, MP3, MPEG-TS.
- **`ftyp` / `moov` / `mdat`** — MP4 boxes: brand, metadata/index, media data. **faststart** = `moov` before `mdat` (streamable). **fragmented / CMAF** = segmented MP4 (`moof`+`mdat`).
- **EBML** — the element format underlying WebM/MKV.
- **`STREAMINFO`** — FLAC header block (sample count/rate); must be repaired after a FLAC trim.
- **ADTS** — raw AAC stream framing.
- **Codec** — compression for a stream: video (H.264/AVC, HEVC/H.265, VP8, VP9, AV1), audio (AAC, Opus, MP3, FLAC, Vorbis, PCM).
- **GOP / keyframe / open-GOP** — Group Of Pictures starting at a keyframe (I-frame); open-GOP frames reference across the boundary.
- **B-frame** — bidirectionally-predicted frame; causes **PTS≠DTS** reordering the muxer/decoder must handle (`ctts`/composition offsets).
- **PTS / DTS** — presentation vs decode timestamps.
- **VFR / CFR** — variable vs constant frame rate.
- **CENC / `cenc`(CTR) / `cens`(CTR-pattern) / `cbcs`** — Common Encryption schemes (AES-CTR full-sample, AES-CTR pattern, AES-CBC subsample-pattern). **HLS AES-128** — segment-level AES-CBC. **HLS SAMPLE-AES** — codec sample-payload AES for HLS segments.
- **Subsample / `senc`/`saiz`/`saio`/`tenc`** — CENC boxes describing per-sample IVs and clear/encrypted byte ranges.

## Validation

- **Oracle** — an automated correctness check for an operation's output.
- **Golden** — a committed reference (frame digests, packet manifest, metadata, cleartext twin) an oracle compares against.
- **Bit-exact** — output matches the golden byte/hash-for-byte (strongest).
- **SSIM / PSNR** — perceptual similarity metrics; `exactFrames` = how many frames matched exactly.
- **`playback-smoke`** — output actually plays in a `<video>` (necessary, never sufficient).
- **WEAK-GATE** — a pass resting on a loose oracle (duration-only / SSIM-`exactFrames==0` / smoke) — "fast + plausible," not proven correct.
- **SUSPECT** — a pass from a shortcut that doesn't generalize (hardcoded per-asset path, input→output byte-flip, degenerate metric).
- **determinism / `force-software`** — mode that drops hardware/GPU tiers for cross-machine-reproducible output.

## Build / packaging

- **Tree-shaking** — dropping unused exports from the build (enabled by `sideEffects:false`).
- **Code-splitting** — emitting separate chunks at `import()` boundaries, fetched on demand.
- **`DRIVER_API_VERSION`** — the driver-contract's own integer-major version, separate from the library's public semver (ADR-016).
- **Eager kernel / lazy chunk** — the small always-loaded core vs the per-op/per-driver modules fetched on first use.
