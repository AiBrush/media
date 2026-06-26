# SESSION 5 — GOAL

## The goal (binding)

Drive `aibrush-media` to **100% of the 558-feature benchmark suite PASSING** — **every cell PASS: zero N/A, zero FAIL, zero ERROR** — on **Chromium, WebKit, and Firefox**, measured fresh in `../media-test/media-browser-test`. This is a strict superset of "win in aggregate": at 100% PASS we are #1 on every axis (100% conformance AND 100% coverage) and no engine can beat us.

**Session 5 is NOT done until the suite is 100% green on all three browsers** and `bun run gate` exits 0. Beating mediabunny's 91.4% coverage is necessary but **not** sufficient — the bar is the whole suite.

## Where we start (measured, chromium, 2026-06-26)

**436 PASS / 1 FAIL / 1 ERROR / 113 NA_ENGINE / 10 NA_BROWSER (561)** = 99.54% conformance, 78.07% coverage, rank #2. **125 cells are not PASS** — every one is a Session-5 requirement, enumerated in @BUILD_INSTRUCTIONS_SESSION5.md §3 (R0–R7).

## How we get there

- **Genuinely build or correctly wire every capability** — never declare an unbuilt one (it FAILs the oracle; NEVER FAKE, parent §0.6). Every flipped cell is backed by a real implementation passing a strict (bit-exact/structural) oracle on ≥5 real fixtures + a benchmark.
- The 125 split ~roughly in half: **adapter declaration/routing of capabilities we already have** (R1–R3, ~57 cells) and **genuine feature builds** (R4–R7, ~66 cells), plus **2 regressions to fix at the root** (R0).
- Work the phases in @BUILD_INSTRUCTIONS_SESSION5.md §4 in order, fan-out on disjoint files (§6), re-measure at each gate.

## The one decision that's yours

**MP3 encode** (`wav_to_mp3_mp4`, `aac_to_mp3_mp4` — 2 cells) has **no permissive (MIT/BSD/Apache/zlib) encoder in existence** — only LGPL LAME/lamejs/Shine. Reaching a literal 100% requires approving an **isolated, lazy, separately-licensed LGPL LAME tail** (with an ADR + license notice). Until you decide, those 2 cells stay an honest N/A (typed `CapabilityError`) — the single gap to 100% that I will not close without your sign-off. Everything else is buildable with no license compromise.

## Definition of Done

See @BUILD_INSTRUCTIONS_SESSION5.md §2. In one line: **561/561 PASS on Chromium + WebKit + Firefox, all quality gates green, every feature validated + benchmarked + ADR'd, docs in sync.**
