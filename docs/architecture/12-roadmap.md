# 12 — Roadmap & Phases

> A build sequence where each phase is shippable and acceptance-gated against the strict benchmark oracles ([`11`](11-testing-and-validation.md)). The **public API and data-flow seams are fixed from Phase 1** (ADR-010/013/015); internal wiring evolves underneath.

## Phase 0 — Scaffolding

**Deliverables**
- Repo + `package.json` (ESM, `sideEffects:false`, `exports` map), `tsconfig` (strict), bundler config, CI (Playwright across Chromium/WebKit/Firefox).
- The driver contracts from [`05`](05-driver-contracts.md) landed as real `.ts` (`CodecDriver`/`ContainerDriver`/`FilterDriver`, `MediaError`, `DRIVER_API_VERSION`).
- Kernel skeleton: Normalizer, Planner, Router, Registry, Executor, Worker-bridge interfaces (no real backends yet).
- The conformance test harness (so every future driver is held to the contract).

**Exit:** `createMedia()` instantiates; a no-op driver passes the conformance harness; CI green.

## Phase 1 — MVP (ARCH-3 monolith, WebCodecs + TS + GPU, no WASM)

The smallest end-to-end slice that proves the thesis on the common path.

**Deliverables**
- **Containers (TS):** MP4/MOV demux + mux + probe; faststart.
- **Codecs (WebCodecs):** H.264 decode/encode (hardware-first), AAC decode/encode.
- **Filters (GPU):** resize/crop/rotate/flip via WebGPU→WebGL→Canvas2D.
- **Ops:** `probe`, `remux`, `trim` (keyframe + accurate), `convert` (h264/aac → mp4, with resize) with **auto-route** copy-vs-re-encode.
- **Runtime:** worker-first for heavy ops; main-thread probe; `from()`/`fromX` + `to*` sinks; cancellation/progress.
- **Validation:** strict oracles for the above (golden-packets, golden-metadata, reference-reimport, decoded-frames-bitexact in force-software, playback-smoke) + the §5 anti-cheat self-checks.

**Exit:** the MVP op set passes strict oracles in CI; the engine registers in the benchmark harness and **wins its covered features**; eager bundle ~mediabunny-class; no main-thread long tasks; no COOP/COEP.

## Phase 2 — The lazy WASM tail + ARCH-1 refactor

Reclaim the ~5% heavy tail and the rest of the matrix; turn the monolith into the router+registry.

**Deliverables**
- **Refactor to ARCH-1:** drivers register lazily via the router (public DX unchanged).
- **More containers (TS):** WebM/MKV, Ogg, WAV, ADTS, MP3, MPEG-TS (+ HLS demux).
- **More codecs:** VP9, AV1, HEVC (WebCodecs where present), with **WASM fallback drivers** loaded only on a hardware miss (ADR-005) — libopus, libvpx. **FLAC decode is pure TS, not WASM** (ADR-024): it is lossless/integer, so the TS decoder is bit-exact (validated via STREAMINFO-MD5 on the IETF FLAC conformance corpus) and ~kilobytes — no toolchain needed. Per ADR-025, the WebCodecs/WASM-tier codecs are validated on the browser/target runtime, the pure-TS tier in Node CI.
- **audio-dsp:** PCM format/endianness/gain/mix/fade in TS; **resample** via WebAudio/WASM soxr; lossy encode via WASM.
- **decrypt:** CENC (`cenc`/`cbcs`) + HLS AES-128 via WebCrypto + TS box parse.
- **streaming-output:** `StreamTarget` incremental writes, fragmented CMAF.

**Exit:** broad benchmark coverage on strict oracles; lazy WASM verified (probe-only app pulls no WASM; FLAC convert pulls only the FLAC core, miss-only); `DRIVER_API_VERSION` v1 contract frozen and documented for third parties.

## Phase 3 — Performance, isolation & ergonomics

**Deliverables**
- **Isolation profile (opt-in):** WASM SIMD+threads under `crossOriginIsolated` to speed the exotic tail (ADR-006).
- **Cost-aware tier thresholds (ADR-020):** seed from Phase-1/2 telemetry — pick cheaper tiers for tiny inputs.
- **Fluent chain (ADR-010):** ship the post-v1 sugar as a façade over the declarative job.
- **Perf hardening:** worker pool for ABR fan-out; frame-lifetime/backpressure audits; multi-sample perf regression gates.

**Exit:** measured (multi-sample) wins vs each single benchmark engine in aggregate; fluent chain GA; telemetry-tuned routing.

## Phase 4 — Breadth & ecosystem

**Deliverables**
- More filters (full colorspace matrices, HDR→SDR tonemap), more container options, ABR ladders.
- Third-party driver ecosystem (publishing guide, the `DRIVER_API_VERSION` compat shims).
- Docs/site, examples, migration guides.

**Exit:** practical-coverage parity with the §3 matrix in [`01-goals-and-requirements.md`](01-goals-and-requirements.md); stable third-party driver API.

## Cross-cutting (every phase)

- **Acceptance = strict-oracle pass + aggregate benchmark win**, not loose gates (ADR-018, [`11`](11-testing-and-validation.md)).
- **The seams don't move.** Internal refactors (ARCH-3→ARCH-1, adding tiers) never change the public API or the packet/frame seams.
- **Re-measure performance.** Never quote the original (cached, single-sample) benchmark margins as ours.

## Open / deferred

- **ADR-020** cost-aware thresholds — deferred to Phase-3 telemetry (the one remaining open decision).
