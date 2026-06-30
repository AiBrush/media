# 01 — Goals, Scope & Requirements

> Defines *what* aibrush-media must do and the quality bars it must hit. Later docs must not exceed this scope without an ADR in [`02-decision-records.md`](02-decision-records.md).

## 1. Vision

A single in-browser media engine that, behind a flat "express your intent" API, routes every operation to the best available substrate (WebCodecs → GPU → WASM → TS), so an app gets best-in-aggregate speed and the widest *practical* codec coverage without the developer ever choosing a backend. See [`README.md`](README.md) for the thesis and [`background/benchmark-summary.md`](background/benchmark-summary.md) for the evidence.

## 2. In-scope operations (the public op set)

| Op | Meaning |
|---|---|
| `probe` | Read container/track/codec/duration metadata without decoding. |
| `decode` | Container/codec → raw `VideoFrame` / `AudioData` (with seeking). |
| `encode` | Raw frames → encoded chunks. |
| `demux` | Container → encoded packets + track info. |
| `mux` | Encoded packets + layout → a container byte stream. |
| `remux` | Container → container, **stream-copy** (no re-encode). |
| `trim` | Time-range cut (keyframe-aligned copy or frame-accurate). |
| `convert` | The headline op: produce a target container/codecs; **auto-routes** copy-vs-re-encode, applies filters. Subsumes transcode. |
| `decrypt` | CENC (`cenc`/`cens`/`cbcs`), HLS full-segment AES-128, and HLS TS SAMPLE-AES decryption **given keys**. |

Filters (resize, crop, pad, rotate, flip, colorspace, tonemap; audio resample, remix/down-up-mix, gain, fade) are stages available to `convert` and the low-level graph.

## 3. Functional coverage targets (practical, not ffmpeg-complete)

**Containers:** MP4/MOV, WebM/MKV, Ogg, WAV, AAC/ADTS, MP3, FLAC, MPEG-TS (+ HLS playlists for demux/decrypt). Faststart, fragmented/CMAF, and streaming output for MP4/WebM.

**Video codecs:** H.264, HEVC/H.265, VP8, VP9, AV1 (decode/encode subject to the browser capability matrix — see [`10-browser-capability-matrix.md`](10-browser-capability-matrix.md)).

**Audio codecs:** AAC, Opus, MP3, FLAC, Vorbis, PCM (s16/s24/f32, LE/BE).

**Encryption:** CENC `cenc`/`cens`/`cbcs`, HLS AES-128, and HLS TS SAMPLE-AES — decrypt with caller-provided keys; clean rejection of unsupported schemes.

Coverage is "what real apps need." The long tail of obscure containers/codecs is explicitly a **non-goal** (§6).

## 4. Quality attributes (measurable bars)

| Attribute | Target / rule |
|---|---|
| **Performance** | Prefer hardware WebCodecs first (benchmark: 20–35× single-thread WASM). Decode/encode/filter never run on the main thread when heavy (worker-first). |
| **Eager bundle** | Kernel ≤ ~50 kB; total eager JS for a typical app mediabunny-class (~150–250 kB). The ~500 kB ceiling covers **JS glue only**. |
| **Lazy footprint** | Each op + driver loads on first use; heavy WASM downloads **only on a hardware miss**, as same-origin assets (no CDN). |
| **Main-thread jank** | Heavy ops emit no long tasks on the main thread (run in a worker). `longtasks` is a tracked metric. |
| **Correctness** | Self-validated by **bit-exact or structural** oracles; never ship a path that only passes a loose/smoke gate (see [`11-testing-and-validation.md`](11-testing-and-validation.md)). |
| **Determinism** | A `determinism:'force-software'` mode yields cross-machine-reproducible output (hardware decode is platform-specific). |
| **Deployability** | The common path requires **no COOP/COEP**. Cross-origin isolation is opt-in, only for the fast-WASM-threads tail. |
| **DX** | Developer expresses intent; never names WebCodecs/GPU/WASM. A capability miss is a typed, explained error — never a silent wrong result. |
| **Extensibility** | New backends are drivers behind a versioned contract; third parties can publish drivers (see [`05-driver-contracts.md`](05-driver-contracts.md)). |
| **Browser reach** | Evergreen Chromium (WebCodecs), Safari (16.4+/17 WebCodecs), Firefox (where WebCodecs ships); graceful capability errors where APIs are absent. |

## 5. Constraints

- **Browser-only**, ES modules, **TypeScript** (strict) → shipped as ESM JS + `.d.ts`.
- Modern Web Platform: WebCodecs, Web Streams, Web Workers, OffscreenCanvas/WebGPU/WebGL, WebCrypto, OPFS, `import.meta.url` asset resolution.
- WASM codec cores are compiled from C/Rust; we author only TS bindings around them.
- No build-time knowledge of which backend a runtime will pick (capability is detected at runtime) — so backend drivers must be dynamically importable.

## 6. Non-goals (explicit)

- **ffmpeg feature parity.** The exotic codec/container/filter long tail is out of scope; chasing it is exactly what makes ffmpeg.wasm multi-MB.
- **Smallest possible bundle.** mp4box wins that at ~41 kB; we trade some size for coverage and speed.
- **A player or UI.** No timeline, no controls; we feed/consume `<video>`/MSE/streams but render nothing.
- **DRM / EME license acquisition.** We decrypt with caller-provided keys (CENC/HLS); we do not negotiate licenses or implement a CDM.
- **Server-side execution.** Browser-first. (The declarative job spec is portable enough to run elsewhere later, but that is not a v1 goal.)
- **Guaranteed bit-identical hardware output across machines** — only the `force-software` mode promises that.

## 7. Personas

- **App developer** — "convert this upload to MP4 / trim it / read its metadata." Wants `media.convert/trim/probe`, zero backend knowledge.
- **Editor / tooling builder** — multi-stage pipelines; wants the graph (and, post-v1, the fluent chain).
- **Automation / batch** — serializable jobs; wants the declarative job spec, possibly off-thread.

## 8. Success criteria

1. Beats any *single* one of the 7 benchmarked engines **in aggregate** across the 558-feature set (by routing to each substrate's strength).
2. Covers the §3 practical matrix with **bit-exact/structural** correctness, not loose gates.
3. Common path ships ~mediabunny-class eager JS, no COOP/COEP, no main-thread jank.
4. A new codec/container is added by writing **one driver**, no core change.
