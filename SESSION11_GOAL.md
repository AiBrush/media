# SESSION 11 — GOAL (finish the fair harness: 0 functional reds, then fastest/leanest everywhere)

## Scope (binding)

Session 10 landed a large win on the *fair* harness (`../media-test/media-browser-test`: rotation + exhaustive scoring + independent output-parsing). The catastrophic transcode timeouts and the OOM are **gone**; active speed deficits collapsed (289 → 22, fresh 2026-07-08 base). What remains is a **finite tail**: ~18 genuine correctness/quality reds — including **2 encryption regressions Session 10 introduced** — plus a fixed-overhead speed tail (0 catastrophic · 2 severe · 1 moderate · 19 minor · 1 timeout). This is **not** the Session-10 non-streaming crisis; it is Root-cause **B** (real bugs) + per-op cost.

**Finish the harness on BOTH axes — 0 FAIL / ERROR / timeout / OOM on EVERY rotated file, and fastest/leanest on every contested cell — no oracle weakened, nothing faked.**

## The harness is a BLACK BOX (non-negotiable)

**Run the tests; read only their result output (status/metric/reason + the exported JSON). NEVER open the scenario, oracle, tolerance, runner, selection, output-parser, or adapter code** (reading how it grades is how overfitting starts). Fix `aibrush-media` against **real-world** truth (ffmpeg/ffprobe/openssl/mediainfo, the specs, our baked goldens), then re-run to confirm the red cleared. Binds every agent.

## The work (correctness before speed)

1. **Re-measure first** — the reds list is a single-sample, partial seed. Fresh full chromium run (rotation on) → regenerate `docs/perf/gen-deficits.mjs` before trusting a number.
2. **Restore the 2 encryption graceful regressions first** (`cenc_ctr` protection-zeroed / senc-bitflip PASS→FAIL — now emit output from mutated input) **without breaking decrypt**; then close **HLS-AES128**.
3. **Fix the remaining reds** — cbcs/cens decrypt, `.mov` decode SSIM, HEVC-MKV & longform mux, probe track-enum/duration, gapless AAC, resize/fps quality. **Verify corpus/golden vs genuine bug first** for the smells.
4. **Sweep speed to zero** (severe → moderate → minor tail) — only after reds are zero.

Every fix passes **all** rotated files for its scenario; our own goldens rotate the corpus too. A one-file pass is overfitting = FAIL. Never weaken an oracle to move a number.

## Definition of Done

Full detail: @BUILD_INSTRUCTIONS_SESSION11.md

- **0 functional reds** across full rotation; **#1 aggregate** on conformance-then-coverage **and** on fresh multi-sample (n≥5) wall + peakMemory ≤ the fastest/leanest rival on every contested cell.
- No overfitting; no PASS→FAIL (chromium + WebKit 428/0/0); frame/memory + force-software determinism intact.
- `bun run gate` exits 0; coverage ≥90%; budgets green with margin; anti-cheat green. ADRs **187+**; `docs/notes/`.

One line: **hold the Session-10 win and finish — 0 functional reds (regressions restored first), fastest/leanest on every contested cell and rotated file — validated against the real world, never the test internals.**
