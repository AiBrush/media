# aibrush-media — Architecture

The architecture base for **aibrush-media**, a unified, capability-routed, in-browser media engine. These documents are the authoritative source for *what* we are building and *why*, and they precede implementation. Code in this repo must conform to them; when reality forces a change, change the doc in the same PR.

> **Status:** **implementation in progress** (architecture base first ratified 2026-06-23; this README tracks reality). The docs remain the authoritative source for *what* and *why*; when reality forces a change, the doc + an ADR change in the same commit. Validation is **tier-split (ADR-025)** and labeled honestly throughout — *Node-validated* (pure-TS, runs in CI) vs *browser-validated* (WebCodecs/GPU, runs on the target runtime).
> **Provenance:** the design is grounded in a 558-feature browser-media benchmark (7 frameworks) — distilled in [`background/benchmark-summary.md`](background/benchmark-summary.md); full report lives in the sibling project `aibrush.lib/media-test/media-browser-test/docs/report/`.
>
> **Implemented so far** (full per-driver/op status + validation tier in [`09-operations.md`](09-operations.md) §"Shipped drivers & operations"):
> - **Containers (12, hand-written TS, Node-validated):** mp4·mov, webm·mkv, ogg, wav, aiff, caf, mp3, flac, adts, mpegts (ts·m2ts·mts), avi, hls (playlist). Probe + demux across all; **muxers** for mp4/webm/ogg/mpegts/flac (chunk-seam; FLAC via the pure-TS `flac-encode` codec driver, ADR-086) + wav/aiff/caf (PCM via `transformPcm`).
> - **Pure-TS ops (Node-validated):** `probe`, `demux`, `remux` + keyframe `trim` (stream-copy), `decrypt` (`cenc`/`cbcs`/`hls-aes128`), PCM `convert` (format/gain/fade/BS.775-mix/**resample**/dynamics/biquad), **FLAC decode** (STREAMINFO-MD5 bit-exact).
> - **WebCodecs/GPU codec tier (browser-validated):** `decode`/`encode`/`convert` re-encode/`seek` (hardware-first, close-race-safe); **ADTS AAC→WAV PCM extraction** via native `AudioDecoder` with `wasm-aac` fallback; **GPU video filters** (WebGPU + Canvas2D) for geometry + colorspace/tonemap, a **pure-TS CPU video filter** floor for no-GPU browsers, and an **`AudioData` audio filter** (resample/remix/gain).
> - **Streaming output building blocks:** fragmented/CMAF MP4 writer plus `StreamTarget` sink are wired into the public sink/remux/mux surface; the browser harness `target:writes` feature remains adapter-gated until it instruments real incremental writes.
> - **WASM tail:** real vendored Symphonia decoders for **Vorbis / AAC-LC / MP3** (Node-validated via a clean-process decode oracle) are auto-registered in the default lazy driver bundle and co-vendored by `scripts/vendor-wasm.ts`; **Opus / VP8·VP9 / AV1(dav1d)** remain honest recipe-scaffolds (pure-TS framing/config + a typed core contract, no core yet).
>
> **Not yet:** browser-harness `target:writes` instrumentation for true streamed-output scoring; the C-codec scaffolds' cores (Opus, VP8/VP9); software encoders for the lossy long tail; the 558-feature harness aggregate "win vs 7 engines" (the external acceptance gate). These are tracked as honest gaps, never claimed done.

## The thesis (one sentence)

No single in-browser media engine spans all the substrates that win — hardware **WebCodecs**, hand-written **TypeScript** containers, the **GPU** for pixel filters, and **WASM** for the codec/DSP tail — so a single framework that **routes each operation to the best available substrate**, behind a flat API where the developer never names a backend, can be best-in-aggregate. The benchmark's 56%-winner (mediabunny) already proves the WebCodecs+TS spine; we extend it with a lazy WASM tail and GPU filters.

## Core principles

1. **Intent, not mechanism.** The developer calls `media.convert(...)` / `media.probe(...)`; the engine picks WebCodecs → GPU → WASM internally and only fails loudly (`CapabilityError`) when nothing can do it.
2. **Pay for what you use.** A tiny eager kernel; every operation and backend lazy-loads on first use; heavy WASM downloads only on a hardware miss.
3. **Correctness is gated, not assumed.** We self-validate with bit-exact / structural oracles and never copy the benchmark's loose-gate or shortcut "wins."
4. **Deployable by default.** No cross-origin isolation required for the common path; WASM is self-hosted (no CDN).

## How to read these docs

| Order | Document | What it answers |
|---|---|---|
| 1 | [`01-goals-and-requirements.md`](01-goals-and-requirements.md) | Scope, the operation set, quality attributes, non-goals, target browsers. |
| 2 | [`02-decision-records.md`](02-decision-records.md) | Every locked architectural decision (ADRs) with context + consequences. **Single source of truth for decisions.** |
| 3 | [`03-system-architecture.md`](03-system-architecture.md) | The layered model (API → kernel/router → drivers → substrates); C4 context/container/component views. |
| 4 | [`04-capability-router-and-ladder.md`](04-capability-router-and-ladder.md) | How a backend is chosen per stage: the strategy ladders, capability probing, caching, determinism, error-on-miss. |
| 5 | [`05-driver-contracts.md`](05-driver-contracts.md) | The canonical TypeScript contracts (`CodecDriver`/`ContainerDriver`/`FilterDriver`) + registration + `DRIVER_API_VERSION` semver policy. |
| 6 | [`06-execution-and-runtime.md`](06-execution-and-runtime.md) | The pipeline/graph executor, web-streams data flow, worker-first runtime, threading, lifecycle, cancellation/progress, error model. |
| 7 | [`07-public-api.md`](07-public-api.md) | The developer-facing API: `createMedia`, the ops, options shapes, `from()`/`fromX` sources, sinks, `preload`. |
| 8 | [`08-packaging-and-loading.md`](08-packaging-and-loading.md) | TS→ESM+`.d.ts`, code-splitting, lazy `import()`, self-hosted WASM via `import.meta.url`, exports map, CSP/COEP, budgets. |
| 9 | [`09-operations.md`](09-operations.md) | Per-operation design (probe, demux, decode/seek, encode, mux, remux, trim, convert, audio-dsp, filters, encryption, streaming, robustness) — benchmark-grounded ladders and data flow. |
| 10 | [`10-browser-capability-matrix.md`](10-browser-capability-matrix.md) | WebCodecs/GPU support reality, the known gaps (FLAC decode, HEVC-10-bit, VP8 playback), and the fallback plan. |
| 11 | [`11-testing-and-validation.md`](11-testing-and-validation.md) | Oracle/golden strategy, the anti-cheat lessons, determinism mode, performance measurement. |
| 12 | [`12-roadmap.md`](12-roadmap.md) | Phases and milestones (MVP → lazy WASM tail → isolation profile). |
| 13 | [`13-glossary.md`](13-glossary.md) | Terms (substrate, tier, driver, seam, packet, faststart, CENC, …). |
| 14 | [`14-benchmarks.md`](14-benchmarks.md) | Benchmark methodology (warmup + median + separate RSS pass + checksum sink + `--check` gate) and the committed pure-TS baseline numbers (audio-dsp ×realtime, image probes/sec, container ops MB/s). |
| — | [`background/benchmark-summary.md`](background/benchmark-summary.md) | The 558-feature evidence that justifies every `[data]` claim. |

## Status legend (used in the decision records)

`[DECIDED]` locked · `[PROPOSED]` recommended default, not yet ratified · `[OPEN]` not yet decided. As of this writing the design is **fully decided**; remaining gaps are implementation and external validation status, not deferred architecture decisions.

## Companion documents (sibling project, the "options" phase that produced these decisions)

- `aibrush.lib/media-test/media-browser-test/docs/unified-media-framework-feasibility-2026-06-23.md` — feasibility analysis (why one framework can win).
- `aibrush.lib/media-test/media-browser-test/docs/unified-media-framework-architecture-options-2026-06-23.md` — the options + decision register these docs are derived from.
