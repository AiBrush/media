# SESSION 6 — GOAL

## The goal (binding)

Make `aibrush-media` **feature-complete on Chromium**: **every *buildable* capability in the 561-scenario benchmark is implemented, correctly routed, and PASSING** on a strict oracle — measured fresh in `../media-test/media-browser-test`. The only admissible non-PASS on Chromium is a cell in the **Honest-NA / Decision register** (@BUILD_INSTRUCTIONS_SESSION6.md §5): physically-blocked encode (no permissive encoder), or a correct-to-decline edge (e.g. the >1 GB bounded-materialization safety declines). Plus: **settle the encode-tail decision**, and **capture a WebKit + Firefox baseline run** so Session 7 starts from data.

This is the deliberate scope split you chose: **S6 = features (Chromium) + encode decision + cross-browser baseline · S7 = optimization + Safari/Firefox hardening.** It supersedes Session 5's unmet "100% on all three browsers in one session" — that was over-scoped; cross-browser *hardening* is now S7.

**Session 6 is NOT done until:** every buildable feature below PASSES on Chromium, the Honest-NA register is complete (each with an ADR + your sign-off), `bun run gate` exits 0, and a fresh WebKit + Firefox run is recorded with its NA_BROWSER exposure quantified.

## Where we start (measured, Chromium, 2026-06-27 14:17, built from HEAD + re-vendored)

**518 PASS / 0 FAIL / 36 NA_ENGINE / 7 NA_BROWSER (561)** = **100% conformance** (every attempted cell passes), **92.3% coverage**. Up **+104 PASS / −105 NA_ENGINE** from the 06-26 baseline (Session 5 flipped 105 cells NA→PASS, 0 regressions). Run file: `results/raw/chromium-2026-06-27T13-57-52-650Z.json`. Full backlog enumerated in @BUILD_INSTRUCTIONS_SESSION6.md §3 (R1–R6).

## How we get there

- **Genuinely build or correctly route every capability** — never declare an unbuilt one (it FAILs the oracle; NEVER FAKE, parent §0.6). Every flipped cell is backed by a real implementation passing a strict (bit-exact/structural) oracle on ≥5 real fixtures **and** a fresh benchmark.
- The 36 NA_ENGINE split: **~25 cleanly buildable** (fps/retime, metadata:write, webm/mkv-source trim, VP9 alpha, trim:compose, gapless-priming, HEVC frame-accurate trim) + **~5 encode rate-control/bit-depth** + **~6 register/decision cells** (massive bounded declines, exotic decrypt schemes). Several may be **adapter declare-and-verify**, not fresh builds (Session 5 already shipped the retiming plans and a Vorbis wasm decoder — verify reachability before building anew).
- Work @BUILD_INSTRUCTIONS_SESSION6.md §4 phases in order; fan out on disjoint files (§6); re-measure at each gate.

## The decisions that are yours

1. **Encode-tail (the 7 NA_BROWSER + the lossy-encode cells).** WebCodecs has no MP3/Vorbis encoder, and we ship none.
   - **Vorbis encode** — a permissive core **exists** (libvorbis, BSD via emcc). Buildable with **no license compromise**; flips ~4–5 cells. *Recommend: build it.*
   - **MP3 encode** — **no permissive encoder exists** (LAME/lamejs/Shine are LGPL). Reaching these 2 cells requires approving an **isolated, lazy, separately-licensed LGPL LAME tail** (ADR + notice). **Your call** — default until you decide: honest N/A.
2. **Exotic decrypt schemes** (clearkey, hls-sample-aes, cenc-cens — 3 `_na` cells). Decide: build them, or rule them out-of-scope and register as honest-NA. (Verify first whether the oracle accepts a *graceful* decline as PASS.)

## Definition of Done

See @BUILD_INSTRUCTIONS_SESSION6.md §2. One line: **all buildable features PASS on Chromium (≈543+/561), the Honest-NA register holds the documented rest, the encode-tail decision is made, `bun run gate` is green, every feature is validated + benchmarked + ADR'd, and a fresh WebKit + Firefox baseline is recorded.**
