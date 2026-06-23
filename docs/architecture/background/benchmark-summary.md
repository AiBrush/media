# Benchmark Summary — the evidence behind the architecture

Every `[data]` claim in these docs traces here. Source: a 558-feature browser-media benchmark across 7 frameworks, run on chromium 149 / Apple M1 Max (ANGLE Metal), suite 0.1.0. Full per-feature report (558 rows + per-feature detail + leaderboard) lives in `aibrush.lib/media-test/media-browser-test/docs/report/`.

## What was measured

558 distinct feature tests across 13 families (audio-dsp, decode-seek, demux, encryption, metadata, mux, performance, probe, remux, robustness, streaming-output, transcode, trim), each run against 7 engines: `mediabunny@1.48.0`, `platform@chrome-149` (raw browser APIs), `ffmpeg.wasm@0.12.15`, `mp4box@2.3.0`, `remotion-media-parser@4.0.479`, `web-demuxer@4.0.0`, `remotion-webcodecs@4.0.479`. Each feature names a winner via a correctness-first, then performance, decision ladder.

## Finding 1 — wins concentrate, and the winner per feature is predictable

| Framework | Wins | Share | Substrate it uses |
|---|---:|---:|---|
| mediabunny | 313 | 56.1% | WebCodecs + hand-written TS containers |
| ffmpeg.wasm | 129 | 23.1% | WASM / libav (software) |
| remotion-webcodecs | 38 | 6.8% | WebCodecs |
| remotion-media-parser | 26 | 4.7% | pure-JS parser |
| platform (chrome-149) | 23 | 4.1% | native WebCodecs |
| mp4box | 16 | 2.9% | pure-JS box parser |
| web-demuxer | 10 | 1.8% | WASM demux → WebCodecs |
| *NONE (no engine passed)* | 3 | 0.5% | — |

## Finding 2 — winners collapse to 3 substrates, and each engine is mono-substrate

| Substrate | Wins | Share | Shipped bundle cost |
|---|---:|---:|---|
| **WebCodecs** (hardware-leaning) | 374 | 67% | **zero** (browser-native) |
| **WASM / libav** | 139 | 25% | high (the bundle problem) |
| **pure-JS parsers** | 42 | 8% | tiny |
| native `<video>`/MediaRecorder | ~0 | — | ~never wins (probe path 600–7000× slower) |

Every winning engine used exactly one substrate. **"Best of the best" = the union of substrates no single engine spans.** → drives the [router + drivers] architecture.

## Finding 3 — the dominant winning config needs no isolation, no threads

- 313 wins (56%) ran with `coopCoep: not-required` **and** `wasmThreads: 0`.
- No winner anywhere used wasm threads (ffmpeg.wasm won its 129 in single-thread mode).
→ The high-value path is also the most deployable; COOP/COEP is only relevant to the optional fast-wasm tail.

## Finding 4 — the genuinely heavy (must-be-WASM) tail is ~5%, not 25%

Of the 139 WASM-tier wins, ~112 are container/demux/remux/probe/trim/PCM/mux glue a WebCodecs+TS engine reclaims natively; only ~15–20 features (~3–5% of 558) truly need native code: lossy audio **encoders** (Opus/AAC/MP3/Vorbis), software video **encoders** for codecs WebCodecs can't encode, **FLAC decode**, **true sample-rate resampling**, and a few colorimetry ops. → WASM is a lazy, per-codec **fallback tier**, not a monolith.

## Finding 5 — speed: hardware WebCodecs is 20–35× single-thread WASM

Examples: `transcode/av_downmix_stereo_to_mono` mediabunny 2,598 ms vs ffmpeg.wasm 88,342 ms (~34×); `transcode/bframe_reorder_h264_to_h264` ~23.9×. **The fastest path ships zero bytes** (WebCodecs is in the browser) → speed and small-bundle are aligned, not opposed, on the common path.

## Finding 6 — bundle spectrum (from the `performance/bundle-size` scenario)

mp4box ~41 kB · web-demuxer ~43 kB · remotion-media-parser ~73 kB · remotion-webcodecs ~94 kB · **mediabunny ~165 kB** · **ffmpeg.wasm = multi-MB WASM core, loaded up front**. We target mediabunny-class eager JS (~150–250 kB) and push the heavy codecs into lazy, miss-only WASM assets.

## Finding 7 — integrity (anti-cheat) roll-up

349 REAL · 206 WEAK-GATE · 3 SUSPECT · **0 CHEAT** · 0 INCONCLUSIVE. Lessons we carry into our own validation:

- **3 SUSPECT — do not emulate:** `remux/huge_h264_1080p_600s_mov_to_mp4` "won" by flipping 8 `ftyp` bytes and returning the input; two `performance/*` cases won on a hardcoded per-asset path / a degenerate empty metric.
- **206 WEAK-GATE:** passed on duration-only / SSIM-`exactFrames==0` / "didn't crash" gates — concentrated in transcode (47), trim (31), robustness (29). Treat as "fast + plausible," not "proven correct." → our oracles must be bit-exact / structural (see [`../11-testing-and-validation.md`](../11-testing-and-validation.md)).
- **542/555 winners were `cached`** (cache-seeded run): correctness verdicts are trustworthy; **performance margins (single-sample) must be re-measured** before being quoted.

## Finding 8 — the real browser ceiling (3 no-winner features, all transcode)

- `flac_to_opus_webm` — Chrome 149 WebCodecs has **no FLAC `AudioDecoder`** → needs a WASM FLAC decoder.
- `h264_8bit_to_hevc_10bit` — **no 10-bit HEVC encoder** available → out of scope or SW encoder.
- `h264_to_vp8_webm` — encode succeeded but **failed playback-smoke** → validate output playability.

## Design implications (how these findings map to decisions)

| Finding | Decision (see [`../02-decision-records.md`](../02-decision-records.md)) |
|---|---|
| 2 (3 substrates, mono-substrate engines) | ADR: router + pluggable drivers (ARCH-1) |
| 3 (no-isolation winners) | ADR: no COOP/COEP on the common path; threads opt-in |
| 4 (~5% heavy tail) | ADR: WASM is a lazy, per-codec fallback tier |
| 5 (WebCodecs 20–35× faster, 0 bytes) | ADR: WebCodecs-first capability ladder; worker-first to protect the main thread |
| 6 (bundle spectrum) | ADR: lazy per-op/per-driver loading; self-hosted miss-only WASM |
| 7 (WEAK-GATE/SUSPECT) | ADR: strict bit-exact/structural self-validation |
| 8 (no-winner gaps) | Browser capability matrix + fallback plan ([`../10-browser-capability-matrix.md`](../10-browser-capability-matrix.md)) |
