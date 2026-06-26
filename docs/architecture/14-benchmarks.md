# 14 — Benchmarks & Performance Measurement

> The **performance** side of the Definition of Done (BUILD_INSTRUCTIONS §6: "every op ships with a multi-sample benchmark — wall, throughput, peakMemory — measured fresh across several real corpus files, not one"). This doc records the **methodology** and the **committed baseline numbers** for the pure-TS tier. It operationalizes [`11`](11-testing-and-validation.md) §6 (the perf principle: multi-sample, re-measured fresh, no degenerate metrics) with concrete harnesses + a regression gate. The WebCodecs/GPU tier and the 558-feature harness aggregate are measured on the browser/target runtime (ADR-025) — they are not in these Node baselines.

## 1. The §6 methodology (how every number here is produced)

The pure-TS benchmark harnesses (`scripts/bench-dsp.ts`, `scripts/bench-containers.ts`, `scripts/bench-image.ts`, `scripts/bench-preload.ts`, `scripts/bench-chain.ts`) share one shape, deliberately built to defeat the loose/cached-single-sample measurement the source benchmark was caught doing ([`11`](11-testing-and-validation.md) §5, Finding 7):

1. **Multi-sample, real corpus — never one file.** Each op runs across real downloaded/derived fixtures from the §6.1 corpus; a run aborts if the required corpus for that op is missing. DSP runs every WAV in the corpus; containers run a diverse multi-container probe set, the MP4/MOV set for demux/remux/MP4-to-MKV packet remux/keyframe trim/accurate-trim frame-window/decrypt, a six-file H.264/AAC MP4 set for MP4-to-TS packet remux and the public `mux()` packet-descriptor path, the committed MPEG-TS fixture set for TS same-container remux/trim, an eight-source real Opus/Vorbis/FLAC audio set for Ogg mux authoring including WebM-laced Vorbis, and a bounded seven-family corrupt-input matrix for parser fuzz robustness. Image probe runs five real still/animated image fixtures spanning PNG, JPEG, WebP, GIF, and AVIF. The broader browser harness remains the coverage benchmark for full corpus breadth.
2. **Warmup, then the median of N timed iterations.** A warmup loop is discarded (JIT/allocation settling), then `N` iterations are timed with `Bun.nanoseconds()` and the **median** (not mean — robust to a stray GC/scheduler spike) is the wall. DSP: warmup 20, iters 200. Containers: warmup 3, iters 21 (each op does real I/O-scale work). Image probe: warmup 500, then the median of 7 batch means with 4,000 probes per batch.
3. **Memory is a separate pass from wall.** Peak RSS is sampled in its **own** loop after a forced `Bun.gc(true)` baseline, because sampling `process.memoryUsage()` inside the timed loop would perturb the wall. Reported as peak RSS growth (MB) over the op's iterations vs the gc'd baseline.
4. **A checksum sink defeats dead-code elimination.** Every iteration folds a real output value (a decoded sample, an output byte, a frame count, an image dimension/duration fact) into a `sink` accumulator that is printed at the end, so the optimizer cannot elide the work and produce a fake "infinitely fast" / `0`-cost metric (the `N/A→0` anti-pattern, [`11`](11-testing-and-validation.md) §5).
5. **Honest units.** Throughput is reported in the unit that is *physically meaningful* for the op: `×realtime` (audio-seconds processed per wall-second) for DSP; `MB/s` of the genuinely-processed bytes for the container byte ops; **`probes/sec`** for `probe` (a bounded header read, **not** a whole-file scan — reporting it as file-MB/s would be dishonest). Aggregates use the **geomean** across files (and report the **worst/min** alongside, so a single slow file is visible).
6. **A machine-readable baseline + a `--check` regression gate.** A no-arg run writes the baseline JSON under `fixtures/golden/bench/`; `--check` re-runs and **fails (exit 1)** if any op's aggregate throughput drops more than the tolerance below the committed baseline. Tolerance is **0.5** (a > 50% slowdown is a regression) — loose enough to absorb machine-to-machine variance, tight enough to catch an algorithmic regression. The baseline records `runtime` (e.g. `bun 1.3.x`), warmup/iteration or batch/sample settings, the per-file results, and the per-op aggregates.

## 2. Scripts & baselines

| Harness | Script | Committed baseline | npm alias |
|---|---|---|---|
| audio-dsp (pure-TS kernels) | `scripts/bench-dsp.ts` | `fixtures/golden/bench/audio-dsp.json` | `bun run bench-dsp` |
| image-probe (pure image headers) | `scripts/bench-image.ts` | `fixtures/golden/bench/image.json` | `bun run bench-image` |
| containers / parse ops | `scripts/bench-containers.ts` | `fixtures/golden/bench/containers.json` | *(no alias yet — `bun run scripts/bench-containers.ts`)* |
| preload warmup | `scripts/bench-preload.ts` | `fixtures/golden/bench/preload.json` | `bun run bench-preload` |
| fluent chain façade | `scripts/bench-chain.ts` | `fixtures/golden/bench/chain.json` | `bun run bench-chain` |
| colorspace kernel | `scripts/bench-colorspace.ts` | `fixtures/golden/bench/colorspace.json` | `bun run bench-colorspace` |
| FLAC decode | `scripts/bench-flac.ts` | *(prints; no committed JSON baseline)* | `bun run bench-flac` |

Run `--check` (e.g. `bun run bench-dsp --check` or `bun run bench-image --check`) to gate against the committed baseline.

## 3. Recorded baseline — audio-dsp (`audio-dsp.json`)

Pure-TS, single-thread, median of 200 iters (warmup 20), across **8 real WAV corpus files** (`bun 1.3.x`). Per-op aggregate, `×realtime` = audio-seconds processed per wall-second (higher is faster; "Nx faster than playback"):

| Op | geomean ×realtime | worst ×realtime | max peak mem |
|---|---|---|---|
| `remix mono → stereo` | ~85,800× | ~62,300× | ~0.1 MB |
| `remix stereo → mono` (BS.775) | ~33,700× | ~28,100× | ~0 MB |
| `decode s8 → planar` | ~10,400× | ~3,210× | ~0.1 MB |
| `decode s16 → planar` | ~9,000× | ~3,300× | ~2.7 MB |
| `biquad highpass` | ~5,350× | ~2,530× | ~0.1 MB |
| `dynamics rms→limit` | ~4,850× | ~2,470× | ~2.2 MB |
| `gain (-6 dB)` | ~2,850× | ~1,350× | ~0 MB |
| `convert → f32` | ~2,040× | ~1,020× | ~0 MB |
| `encode planar → s16` | ~1,660× | ~950× | ~0.5 MB |
| `convert → s8` | ~1,180× | ~401× | ~0.5 MB |
| `resample (rate change)` | ~270× | ~146× | ~2.1 MB |

The format/gain/mix/dynamics/biquad kernels run **thousands of × realtime** (kilobytes-of-TS math, Finding 4), including the signed-8 `pcm-s8` decode/convert rows added for ADR-075. **Resample**, the heaviest (the band-limited windowed-sinc, ADR-022), is still comfortably real-time at ~270× geomean / ~146× worst in this fresh run — confirming it ships in-tier without a WASM soxr. Peak memory is single-digit MB throughout (bounded, no leak).

## 4. Recorded baseline — containers / parse (`containers.json`)

Pure-TS, single-thread, median of 21 iters (warmup 3): `probe` across **9 real files** (one+ per family: MP4/MOV, WebM, MP3, Ogg, WAV, FLAC, ADTS); `demux`/MP4 `remux`/MP4-to-MKV packet remux/MP4 keyframe `trim`/accurate-trim frame-window/`decrypt` across the **7-file MP4/MOV** set; MP4-to-TS packet remux and public `mux()` across **6 H.264/AAC-or-video-only MP4 files**; MPEG-TS same-container `remux`/`trim` across the committed local TS fixture set; Ogg muxing across **8 real audio packet sources** (Opus/Vorbis already in Ogg, WebM-laced Vorbis, plus native FLAC frames); and fuzz robustness across **7 real fixture heads** (MP4, WAV, Ogg, FLAC, WebM, AIFF, AVI) with deterministic corrupt matrices. `demux` is the parse + sample-gather work the public `demux` does *before* the browser-only `EncodedChunk` wrapping (labelled honestly as the parse+gather unit, not the chunk emit); `trim accurate frame-window` is the browser accurate-trim decoded-frame selection/rebase core driven by real MP4 sample timestamp traces, not fabricated decode throughput:

| Op | median wall | throughput (geomean) | worst | max peak mem |
|---|---|---|---|---|
| `probe` (header read) | ~0.037 ms | ~26,900 probes/s | — | ~5.5 MB |
| `demux (table+gather)` | ~0.014 ms | ~261 MB/s | ~12.3 MB/s | ~0.03 MB |
| `remux (→mp4)` | ~0.21 ms | ~44.5 MB/s | ~10.0 MB/s | ~0.4 MB |
| `remux (→mkv)` | ~0.048 ms | ~84.6 MB/s | ~11.1 MB/s | ~0.6 MB |
| `trim (keyframe 25–75%)` | ~0.17 ms | ~39.7 MB/s | ~8.7 MB/s | ~0.55 MB |
| `trim accurate frame-window` | ~0.009 ms | ~18.7 MB/s | ~5.7 MB/s | ~0.16 MB |
| `decrypt (cenc)` | ~0.32 ms | ~16.9 MB/s | ~7.1 MB/s | ~0.3 MB |
| `remux (→ts)` | ~0.56 ms | ~306 MB/s | ~109 MB/s | ~1.0 MB |
| `mux (public →ts)` | ~1.06 ms | ~146 MB/s | ~58.3 MB/s | ~2.9 MB |
| `remux (ts→ts)` | ~1.63 ms | ~280 MB/s | ~262 MB/s | ~0.16 MB |
| `trim (ts keyframe 25–75%)` | ~2.13 ms | ~168 MB/s | ~154 MB/s | ~0 MB |
| `mux (→ogg)` | ~6.00 ms | ~23.3 MB/s | ~10.2 MB/s | ~1.7 MB |
| `fuzz robustness` | ~0.40 ms | ~1,390 MB/s | ~144 MB/s | ~0.4 MB |

`probe` is a sub-millisecond bounded header read (~26,900/s) — the cheap-header-read win the design is built on (Finding, [`09`](09-operations.md) §probe), **never** an `HTMLMediaElement` `loadedmetadata` load. The stream-copy ops (`remux`/`trim`, including MPEG-TS same-container packet-copy), public mux, Ogg authoring, and `decrypt` (CENC AES-CTR via WebCrypto) process real bytes on a single thread with bounded memory. The MP4-to-MKV row drives real MP4 packet tables and gathered sample bytes into `WebmMuxer.addChunkStruct`, including edit-list-adjusted PTS/DTS for B-frame sources (ADR-071). The MP4-to-TS direct row drives the same real packet tables into `MpegTsMuxer.addChunkStruct`, including signed-preroll rebase for edit-list/B-frame sources (ADR-072). The accurate-trim frame-window row drives the shipped frame filter/rebase core over real MP4 sample timestamp traces across AV1, H.264, HEVC, tiny, VFR-ish, and ordinary fixtures; live decode/encode throughput stays in the browser harness because Node has no WebCodecs frames (ADR-082). The public `mux (public →ts)` row builds `PacketStreams` descriptors from those same real sample tables, routes through `media.mux()`, and validates the MPEG-TS output with `parseTs` so the public API cannot benchmark a malformed stream (ADR-081). The Ogg mux row re-authors real Opus/Vorbis/FLAC packets through `OggMuxer`, including packet-derived Opus granules (ADR-070) and WebM-laced Vorbis duration anchoring (ADR-079); the `decrypt` op mints a fresh CENC-encrypted twin (the test-support encryptor) and times the real AES-CTR decrypt — not canned output (anti-cheat, [`11`](11-testing-and-validation.md) §5). The `fuzz robustness` row replays bounded corrupt-input matrices over seven real fixture families and asserts the typed-error contract before counting throughput, so parser hardening (ADR-073) is benchmarked rather than only unit-tested.

> **Numbers are machine-relative.** These were recorded on one machine (`bun 1.3.x`); the **shape** (relative op costs, real-time-or-better, bounded memory) is the durable claim, and the `--check` gate compares like-for-like on the same machine. Absolute MB/s × realtime will differ on other hardware — re-run to record a fresh baseline (BUILD §6: measured fresh, never reused stale, Finding 7).

## 5. Recorded baseline — preload (`preload.json`)

Pure-TS/loader warmup, single-thread, median of 21 iters (warmup 3), units are **warmups/sec** because
preload processes no media payload bytes. The benchmark covers the four distinct warmup shapes the public
op now owns (ADR-083): default probe driver-bundle import + common container probes, ready-level
convert warmup for H.264/AAC/MP4, the MP3 predicted-WASM compile/load path after same-session warmup, and
repeat idempotence after an identical spec has already completed.

| Op | median wall | throughput | max peak mem |
|---|---:|---:|---:|
| `preload default probe` | ~0.058 ms | ~17,100 warmups/s | ~1.5 MB |
| `preload ready h264/aac/mp4` | ~0.060 ms | ~16,700 warmups/s | ~1.4 MB |
| `preload compile mp3 wasm path` | ~0.035 ms | ~28,700 warmups/s | ~0.3 MB |
| `preload idempotent repeat` | ~0.043 ms | ~23,100 warmups/s | ~0.1 MB |

Aggregate: **~20,900 warmups/sec geomean**, **~16,700 warmups/sec worst**, **~1.5 MB max peak RSS
growth** on the local Bun 1.3.14 run. The checksum folds each measured warmup result so the loop cannot
time an empty function. The MP3 row is deliberately labeled as a same-session path: the benchmark warmup
phase performs the first compile/load; timed samples track the memoized repeated preload cost that an app
pays after startup. Cold browser first-call latency remains a browser/runtime measurement, not a Node fake.

## 6. Recorded baseline — fluent chain (`chain.json`)

Pure-TS API façade, single-thread, median of 51 iters (warmup 5), units are **chains/sec** because the
benchmark measures the fluent wrapper itself: method recording, lazy runner import, option compilation,
terminal sink injection, cancellation plumbing, typed empty-chain reject, and Blob boundaries between
multiple flat operations. A fake engine returns real `Blob`/`File`/`ReadableStream` objects so the chain
work cannot collapse to a no-op; codec/container throughput remains owned by the flat-op/browser benches.

| Op | median wall | throughput | max peak mem |
|---|---:|---:|---:|
| `chain convert blob` | ~0.018 ms | ~56,600 chains/s | ~0.4 MB |
| `chain trim+resize+convert blob` | ~0.011 ms | ~89,600 chains/s | ~0.4 MB |
| `chain file+stream terminals` | ~0.022 ms | ~44,900 chains/s | ~0.7 MB |
| `chain empty typed reject` | ~0.006 ms | ~165,500 chains/s | ~0.03 MB |

Aggregate: **~78,400 chains/sec geomean**, **~44,900 chains/sec worst**, **~0.7 MB max peak RSS
growth** on the local Bun 1.3.14 run. The checksum folds every fake engine result and stream byte count,
so the benchmark times real wrapper work rather than an optimized-away promise.

## 7. Recorded baseline — colorspace kernel (`colorspace.json`)

Pure-TS color-kernel coverage, single-thread, median of 21 iters (warmup 3), over RGBA stress buffers
derived from **5 real image corpus fixtures** (PNG, JPEG, WebP, GIF, AVIF). This benchmark gates the shared
matrix/transfer apply code (`gpu-uniforms.ts` + `cpu-video.ts`) that the CPU fallback and the WebGPU shader
mirror; it is not a browser decoded-pixel or GPU throughput claim.

| Op | median wall | throughput | max peak mem |
|---|---:|---:|---:|
| `colorspace rgba 709->2020` | ~13.27 ms | ~7.6 MP/s | ~3.4 MB |
| `colorspace rgba 2020->709` | ~12.52 ms | ~8.0 MP/s | ~0.8 MB |
| `colorspace rgba 601->2020` | ~12.86 ms | ~7.8 MP/s | ~0.2 MB |
| `colorspace rgba 2020->601` | ~13.68 ms | ~7.4 MP/s | ~0.3 MB |

Aggregate: **~7.7 MP/s geomean**, **~7.4 MP/s worst**, **~3.4 MB max peak RSS growth** on the local
Bun 1.3.14 run. The checksum folds sampled output bytes and dimensions, so the loop cannot time an
optimized-away no-op. Live `VideoFrame.copyTo` and WebGPU filter throughput remain browser-harness
measurements under ADR-025.

## 8. Recorded baseline — image-probe (`image.json`)

Pure-TS, single-thread, median of 7 batch means (4,000 probes/batch, warmup 500), across **5 real still/animated image files** (`bun 1.3.14`). The primary unit is `probes/sec` because image probe is a bounded header parse, not whole-file pixel decode:

| Fixture | Truth exercised | median wall | probes/sec | peak mem |
|---|---|---|---|---|
| `test.png` | PNG 100×100, 1 frame | ~0.31 µs | ~3,181,000/s | ~0.75 MB |
| `test.jpeg` | JPEG 239×178, 1 frame | ~0.10 µs | ~9,549,000/s | ~0.17 MB |
| `test.webp` | WebP 274×367, 1 frame | ~0.24 µs | ~4,249,000/s | ~0.22 MB |
| `anim2.gif` | GIF 480×360, 36 frames, 0.820 s header duration | ~3.77 µs | ~265,000/s | ~0.48 MB |
| `test.avif` | AVIF 100×100, 1 frame | ~1.64 µs | ~608,000/s | ~0.42 MB |

Aggregate: **~1,835,000 probes/sec geomean**, **~265,000 probes/sec worst**, **~0.75 MB max peak RSS growth**. The checksum folds dimensions, frame count, and parsed duration, so a regression that drops exact GIF/APNG/WebP timing cannot benchmark as "work done." The `--check` gate compares aggregate probes/sec against the committed baseline with the same 50% tolerance as the other local perf gates.

## 9. What is *not* in these baselines (and why)

- **The WebCodecs/GPU tier** (lossy `decode`/`encode`, GPU filters, and browser-produced host chunks from live encode/decode) — these require a browser, so their perf is measured on the target runtime against the 558-feature harness, re-measured fresh (ADR-025, [`11`](11-testing-and-validation.md) §7). The public `mux()` packet-descriptor control flow is benchmarked above with real packet bytes; fabricating browser decode/encode numbers in Node remains forbidden (directive 6).
- **The WASM tail** (`wasm-vorbis` decode ships vendored; `wasm-opus`/`wasm-vpx`/`wasm-av1` are recipe-scaffolds, ADR-031/035/078) — benchmarked where/when their cores run, not faked here.
- **The aggregate "win vs 7 engines"** — that is the external harness's job ([`11`](11-testing-and-validation.md) §7); this doc covers the in-repo per-op baselines that gate `main`.
