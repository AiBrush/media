# aibrush-media — Documentation

**aibrush-media** is a unified, **capability-routed, in-browser media engine**. One flat API (`probe`,
`demux`, `decode`/`seek`, `transcode`, `mux`, `remux`, `trim`, `convert`, `audio-dsp`, `filters`,
`encryption`, `metadata`, `streaming`); behind it the engine routes every stage of every operation to the
best available substrate — **hardware WebCodecs → GPU → pure-TS → WASM (miss-only)** — and the developer
never names a backend. These docs are the **authoritative target spec**: each one states the *best* design
plus an explicit **delta / punch-list** against today's code. When code and doc disagree, the doc wins until
a decision is logged in [`../decisions/`](../decisions/README.md).

## The thesis (one sentence)

No single in-browser media engine spans all the substrates that win — hardware **WebCodecs**, hand-written
**TypeScript** containers, the **GPU** for pixel filters, and **WASM** for the codec/DSP tail — so a single
framework that **routes each operation to the best available substrate**, behind a flat API where the
developer never names a backend, can be best-in-aggregate.

## Core principles

1. **Intent, not mechanism.** You call `media.convert(...)`; the engine picks WebCodecs → GPU → pure-TS →
   WASM internally and only fails loudly (a typed `CapabilityError`) when nothing can do it.
2. **Pay for what you use.** A tiny eager kernel; every operation and backend lazy-loads on first use; heavy
   WASM downloads only on a hardware miss.
3. **Correctness is gated, not assumed.** Strict bit-exact / structural oracles on real fixtures + baked
   goldens — never a loose gate, never a fabricated result.
4. **Deployable by default.** No cross-origin isolation required on the common path; WASM is self-hosted (no
   CDN), loaded via `import.meta.url`.

## How to read these docs

Start here, then follow your operation into its family doc. Every doc uses the same six sections: *Purpose &
scope · Spec & references · Target design · Current state · Delta/punch-list · Open questions.*

### Architecture (the spine)

| Doc | What it answers |
|---|---|
| [`capability-router.md`](capability-router.md) | How a backend is chosen per stage: the tier ladder, `supports()` probing, caching, determinism, error-on-miss. |
| [`driver-contracts.md`](driver-contracts.md) | The `CodecDriver` / `ContainerDriver` / `FilterDriver` contracts, registration, and `DRIVER_API_VERSION` semver policy. |
| [`execution-runtime.md`](execution-runtime.md) | The pipeline/graph executor, web-streams backpressure, jobs/chains, cancellation, and frame lifetime (`close()` once). |
| [`worker-and-wasm-runtime.md`](worker-and-wasm-runtime.md) | Worker offload, the worker pool/protocol/transferables, and WASM instantiation/loading runtime. |
| [`codec-pipeline.md`](codec-pipeline.md) | The shared codec brain: encoder/decoder config selection, codec-string derivation, close-race safety. |
| [`public-api.md`](public-api.md) | The developer-facing API: `createMedia`, the operations, options shapes, sources & sinks. |
| [`sources.md`](sources.md) | Input model: URL/Range, `ReadableStream`, `Blob`/`File`, OPFS, live media, and range caching. |
| [`packaging-and-loading.md`](packaging-and-loading.md) | ESM + `.d.ts`, code-splitting, lazy `import()`, self-hosted WASM, exports map, CSP/COEP, budgets. |
| [`testing-and-validation.md`](testing-and-validation.md) | Oracle/golden strategy, the anti-cheat lessons, determinism mode, tier-split (Node vs browser) validation. |
| [`COVERAGE.md`](COVERAGE.md) | The coverage matrix: every `src/` area + benchmark family → exactly one doc (completeness oracle). |

### Operations (the benchmark families)

| Doc | Family |
|---|---|
| [`../operations/probe-and-demux.md`](../operations/probe-and-demux.md) | probe, demux |
| [`../operations/decode-seek.md`](../operations/decode-seek.md) | decode-seek |
| [`../operations/transcode-video.md`](../operations/transcode-video.md) | transcode (video) |
| [`../operations/transcode-audio-convert.md`](../operations/transcode-audio-convert.md) | transcode (audio), convert |
| [`../operations/mux.md`](../operations/mux.md) | mux |
| [`../operations/remux.md`](../operations/remux.md) | remux |
| [`../operations/trim.md`](../operations/trim.md) | trim |
| [`../operations/audio-dsp.md`](../operations/audio-dsp.md) | audio-dsp, pcm convert |
| [`../operations/video-filters.md`](../operations/video-filters.md) | video filters (within transcode) |
| [`../operations/encryption.md`](../operations/encryption.md) | encryption / decrypt |
| [`../operations/metadata.md`](../operations/metadata.md) | metadata |
| [`../operations/streaming-output.md`](../operations/streaming-output.md) | streaming-output (sinks) |
| [`../operations/robustness.md`](../operations/robustness.md) | robustness |
| [`../operations/performance.md`](../operations/performance.md) | performance (methodology) |

### Container drivers

| Doc | Formats |
|---|---|
| [`../drivers/mp4.md`](../drivers/mp4.md) | MP4 / MOV (ISO-BMFF, QTFF) |
| [`../drivers/webm-mkv.md`](../drivers/webm-mkv.md) | WebM / Matroska (EBML) |
| [`../drivers/mpegts-hls.md`](../drivers/mpegts-hls.md) | MPEG-TS + HLS |
| [`../drivers/ogg.md`](../drivers/ogg.md) | Ogg (Opus/Vorbis) |
| [`../drivers/wav-aiff-caf.md`](../drivers/wav-aiff-caf.md) | WAV / AIFF / CAF (PCM) |
| [`../drivers/mp3-adts-flac.md`](../drivers/mp3-adts-flac.md) | MP3 / ADTS / FLAC (elementary) |
| [`../drivers/avi.md`](../drivers/avi.md) | AVI (RIFF / OpenDML) |

### Codec drivers

| Doc | Tier |
|---|---|
| [`../codecs/webcodecs.md`](../codecs/webcodecs.md) | Hardware/native WebCodecs (video + audio) |
| [`../codecs/wasm-tail.md`](../codecs/wasm-tail.md) | Miss-only WASM tail (AAC/MP3/Vorbis/AV1/VP8-9/Opus) |
| [`../codecs/flac-and-image.md`](../codecs/flac-and-image.md) | Pure-TS FLAC + image probe/decode |

### Decisions & terms

- [`../../REQUIREMENTS.md`](../../REQUIREMENTS.md) — the consolidated **fix backlog**: all 334 delta/punch-list items from the family docs in one place, with cross-cutting themes and priorities.
- [`../decisions/README.md`](../decisions/README.md) — the decision log (ADRs): the single source of truth for locked decisions.
- [`../measured-evidence.md`](../measured-evidence.md) — the evidence appendix: every measured number, browser quirk, known bug, and fixture-provenance fact the family docs cite.
- [`../glossary.md`](../glossary.md) — terms (substrate, tier, driver, seam, packet, faststart, CENC, VFR, backpressure, …).

## Layering (one glance)

```
Public API  (createMedia → ops)              docs/architecture/public-api.md
   │  intent
Kernel      Normalizer → Planner → Router →   capability-router.md · execution-runtime.md
            Executor → Worker-bridge + Registry   worker-and-wasm-runtime.md · driver-contracts.md
   │  picks a driver per stage (never names it upward)
Drivers     Codec / Container / Filter        docs/drivers/* · docs/codecs/* · docs/operations/*
   │
Substrates  WebCodecs → GPU → pure-TS → WASM (miss-only)
```

## Status

The shard docs are the **target spec**; each carries a delta/punch-list a later code-cleanup task implements
against. `src/` is unchanged by the documentation rebuild. Completeness is proven by
[`COVERAGE.md`](COVERAGE.md); decisions live in [`../decisions/`](../decisions/README.md).
