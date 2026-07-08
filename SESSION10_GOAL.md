# SESSION 10 — GOAL (win the *fair* harness: SOTA correctness **and** speed, no overfitting)

## Scope (binding)

The harness (`../media-test/media-browser-test`) was made materially fairer (2026-07-08): each scenario now **rotates multiple real files** with **exhaustive scoring** (sum/max/median; **no FAIL averaged into a PASS**) and **parses our output independently** so no engine grades itself. Overfit passes collapsed. We were #1-correctness on the *old* harness (557/0/0); on the *fair* one the transcode path **times out at 120 s on nearly every transform** and **OOMs** on large inputs, plus genuine quality/enumeration/edge bugs.

**Win the fair harness in aggregate on BOTH axes — correctness (0 FAIL, 0 ERROR, 0 timeout, 0 OOM) and speed/memory — across EVERY rotated file, with no oracle weakened and nothing faked.**

## The harness is a BLACK BOX (non-negotiable)

**Run the tests and read their results; NEVER inspect how the tests work internally.** Do not open the scenario, oracle, runner, selection, output-parser, or adapter code — reading how the test grades is how overfitting starts. Fix `aibrush-media` against **real-world** truth (ffmpeg/ffprobe/openssl/mediainfo, the format specs, and our own independently-baked goldens), then re-run the harness only to confirm the red cleared. Binds every spawned agent.

## The work (one cell at a time; correctness before speed)

1. **Re-measure first** — the reds list is a seed, not truth. Extend `docs/perf/gen-deficits.mjs` to gate on **functional reds** (FAIL/ERROR/timeout/OOM), not just wall-time.
2. **Kill the catastrophic failures** (Root-cause A = non-streaming / whole-file / unbounded-memory, run N× by rotation → timeout + OOM): make `convert`/transcode a **bounded streaming pipeline** + bound the muxer; fix large-file track enumeration + ADTS duration.
3. **Fix the genuine bugs** (B): rotate-normalize + `.mov` decode SSIM, B-frame reorder empty-output, gapless/longform empty-output, cbcs decrypt, HLS AES-128, TS→MP4 mixed-framing.
4. **Sweep speed & memory to zero deficits** on the rotated corpus (continue Session 9).

Every fix must pass **all** rotated files for its scenario; our own goldens/tests rotate the corpus too. A one-file pass is overfitting = FAIL.

## Definition of Done

Full detail: @BUILD_INSTRUCTIONS_SESSION10.md

- **0 functional reds** across the full rotation; **#1 aggregate** on conformance-then-coverage **and** on fresh multi-sample (n≥5) wall + peakMemory ≤ the fastest/leanest rival on every contested cell.
- No overfitting; no PASS→FAIL anywhere (chromium + WebKit 428/0/0); frame/memory discipline + force-software determinism intact.
- `bun run gate` exits 0; coverage ≥90%; budgets green with margin; anti-cheat green. ADRs from **181+**; `docs/notes/` design notes.

One line: **genuinely SOTA on the fair harness — 0 functional reds, fastest/leanest on every contested cell, across every rotated file — validated against the real world, never the test internals.**
