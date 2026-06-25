# 14 — Benchmarks & Performance Measurement

> The **performance** side of the Definition of Done (BUILD_INSTRUCTIONS §6: "every op ships with a multi-sample benchmark — wall, throughput, peakMemory — measured fresh across several real corpus files, not one"). This doc records the **methodology** and the **committed baseline numbers** for the pure-TS tier. It operationalizes [`11`](11-testing-and-validation.md) §6 (the perf principle: multi-sample, re-measured fresh, no degenerate metrics) with concrete harnesses + a regression gate. The WebCodecs/GPU tier and the 558-feature harness aggregate are measured on the browser/target runtime (ADR-025) — they are not in these Node baselines.

## 1. The §6 methodology (how every number here is produced)

Both pure-TS benchmark harnesses (`scripts/bench-dsp.ts`, `scripts/bench-containers.ts`) share one shape, deliberately built to defeat the loose/cached-single-sample measurement the source benchmark was caught doing ([`11`](11-testing-and-validation.md) §5, Finding 7):

1. **Multi-sample, real corpus — never one file.** Each op runs across **≥ 5 real downloaded fixtures** (the §6.1 corpus); a run aborts if fewer than 5 are present. DSP runs every WAV in the corpus; containers run a diverse multi-container probe set + the MP4/MOV set for demux/remux/trim/decrypt.
2. **Warmup, then the median of N timed iterations.** A warmup loop is discarded (JIT/allocation settling), then `N` iterations are timed with `Bun.nanoseconds()` and the **median** (not mean — robust to a stray GC/scheduler spike) is the wall. DSP: warmup 20, iters 200. Containers: warmup 3, iters 21 (each op does real I/O-scale work).
3. **Memory is a separate pass from wall.** Peak RSS is sampled in its **own** loop after a forced `Bun.gc(true)` baseline, because sampling `process.memoryUsage()` inside the timed loop would perturb the wall. Reported as peak RSS growth (MB) over the op's iterations vs the gc'd baseline.
4. **A checksum sink defeats dead-code elimination.** Every iteration folds a real output value (a decoded sample, an output byte, a frame count) into a `sink` accumulator that is printed at the end, so the optimizer cannot elide the work and produce a fake "infinitely fast" / `0`-cost metric (the `N/A→0` anti-pattern, [`11`](11-testing-and-validation.md) §5).
5. **Honest units.** Throughput is reported in the unit that is *physically meaningful* for the op: `×realtime` (audio-seconds processed per wall-second) for DSP; `MB/s` of the genuinely-processed bytes for the container byte ops; **`probes/sec`** for `probe` (a bounded header read, **not** a whole-file scan — reporting it as file-MB/s would be dishonest). Aggregates use the **geomean** across files (and report the **worst/min** alongside, so a single slow file is visible).
6. **A machine-readable baseline + a `--check` regression gate.** A no-arg run writes the baseline JSON under `fixtures/golden/bench/`; `--check` re-runs and **fails (exit 1)** if any op's aggregate throughput drops more than the tolerance below the committed baseline. Tolerance is **0.5** (a > 50% slowdown is a regression) — loose enough to absorb machine-to-machine variance, tight enough to catch an algorithmic regression. The baseline records `runtime` (e.g. `bun 1.3.x`), `warmup`, `iters`, the per-file results, and the per-op aggregates.

## 2. Scripts & baselines

| Harness | Script | Committed baseline | npm alias |
|---|---|---|---|
| audio-dsp (pure-TS kernels) | `scripts/bench-dsp.ts` | `fixtures/golden/bench/audio-dsp.json` | `bun run bench-dsp` |
| containers / parse ops | `scripts/bench-containers.ts` | `fixtures/golden/bench/containers.json` | *(no alias yet — `bun run scripts/bench-containers.ts`)* |
| FLAC decode | `scripts/bench-flac.ts` | *(prints; no committed JSON baseline)* | `bun run bench-flac` |

Run `--check` (e.g. `bun run bench-dsp --check`) to gate against the committed baseline.

## 3. Recorded baseline — audio-dsp (`audio-dsp.json`)

Pure-TS, single-thread, median of 200 iters (warmup 20), across **7 real WAV corpus files** (`bun 1.3.x`). Per-op aggregate, `×realtime` = audio-seconds processed per wall-second (higher is faster; "Nx faster than playback"):

| Op | geomean ×realtime | worst ×realtime | max peak mem |
|---|---|---|---|
| `remix mono → stereo` | ~39,400× | ~17,200× | ~2.1 MB |
| `remix stereo → mono` (BS.775) | ~33,700× | ~26,900× | ~0 MB |
| `decode s16 → planar` | ~11,500× | ~7,400× | ~2.7 MB |
| `gain (-6 dB)` | ~3,160× | ~2,550× | ~0 MB |
| `convert → f32` | ~2,460× | ~2,000× | ~0 MB |
| `encode planar → s16` | ~1,800× | ~1,140× | ~0.5 MB |
| `resample (rate change)` | ~49× | ~20× | ~0.4 MB |

The format/gain/mix kernels run **thousands of × realtime** (kilobytes-of-TS math, Finding 4); **resample**, the heaviest (the band-limited windowed-sinc, ADR-022), is still comfortably real-time at ~49× geomean / ~20× worst — confirming it ships in-tier without a WASM soxr. Peak memory is single-digit MB throughout (bounded, no leak).

## 4. Recorded baseline — containers / parse (`containers.json`)

Pure-TS, single-thread, median of 21 iters (warmup 3): `probe` across **9 real files** (one+ per family: MP4/MOV, WebM, MP3, Ogg, WAV, FLAC, ADTS); `demux`/`remux`/`trim`/`decrypt` across the **7-file MP4/MOV** set. `demux` is the parse + sample-gather work the public `demux` does *before* the browser-only `EncodedChunk` wrapping (labelled honestly as the parse+gather unit, not the chunk emit):

| Op | median wall | throughput (geomean) | worst | max peak mem |
|---|---|---|---|---|
| `probe` (header read) | ~0.02 ms | ~2,400 probes/s | — | ~2.0 MB |
| `demux (table+gather)` | ~0.016 ms | ~195 MB/s | ~9 MB/s | ~0.2 MB |
| `remux (→mp4)` | ~0.21 ms | ~41 MB/s | ~10 MB/s | ~1.2 MB |
| `trim (keyframe 25–75%)` | ~0.21 ms | ~35 MB/s | ~8.5 MB/s | ~1.6 MB |
| `decrypt (cenc)` | ~0.33 ms | ~15 MB/s | ~6 MB/s | ~0.3 MB |

`probe` is a sub-millisecond bounded header read (~2,400/s) — the cheap-header-read win the design is built on (Finding, [`09`](09-operations.md) §probe), **never** an `HTMLMediaElement` `loadedmetadata` load. The stream-copy ops (`remux`/`trim`) and `decrypt` (CENC AES-CTR via WebCrypto) process tens of MB/s on a single thread with bounded memory. The `decrypt` op mints a fresh CENC-encrypted twin (the test-support encryptor) and times the real AES-CTR decrypt — not a canned output (anti-cheat, [`11`](11-testing-and-validation.md) §5).

> **Numbers are machine-relative.** These were recorded on one machine (`bun 1.3.x`); the **shape** (relative op costs, real-time-or-better, bounded memory) is the durable claim, and the `--check` gate compares like-for-like on the same machine. Absolute MB/s × realtime will differ on other hardware — re-run to record a fresh baseline (BUILD §6: measured fresh, never reused stale, Finding 7).

## 5. What is *not* in these baselines (and why)

- **The WebCodecs/GPU tier** (lossy `decode`/`encode`, GPU filters, the `EncodedChunk`-seam `mux`) — these require a browser, so their perf is measured on the target runtime against the 558-feature harness, re-measured fresh (ADR-025, [`11`](11-testing-and-validation.md) §7). Fabricating a Node number for them is forbidden (directive 6).
- **The WASM tail** (`wasm-vorbis` decode ships vendored; `wasm-opus`/`wasm-vpx` are recipe-scaffolds, ADR-031/035) — benchmarked where/when their cores run, not faked here.
- **The aggregate "win vs 7 engines"** — that is the external harness's job ([`11`](11-testing-and-validation.md) §7); this doc covers the in-repo per-op baselines that gate `main`.
