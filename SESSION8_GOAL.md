# SESSION 8 — GOAL (the true closer)

## The goal (binding)

S7 called itself final but didn't close: **Firefox never ran a clean full 561-row matrix** (ADR-110), the **aggregate win wasn't re-confirmed since S5**, and **independent + real-bundle verification** are open. S8 reaches the parent DoD (@BUILD_INSTRUCTIONS.md §2) for real, reclaims every *fixable* honest-NA, and builds the remaining **permissive** tail. Done when:

1. **Cross-browser complete** — fresh full 561-row runs on Chromium/WebKit/Firefox, each 0 FAIL/0 ERROR, every buildable cell PASS, PASS up vs S7. Non-PASS = signed-off §5 entry only.
2. **2 reclaimable Chromium declines closed** — `massive…mp4_to_mkv` via streaming Clusters-on-write MKV/WebM mux; `massive_h264_copy_sustained` via bounded lazy source-range copy-trim. Bounded oracles, not raised caps.
3. **Permissive SW tail** *(encoders)* — libvpx VP8/9 encode (+ real VP9 two-pass), AV1 SW encode (rav1e/SVT-AV1), AV1 dav1d decode routing where WebCodecs lacks AV1. Lazy/miss-only, validated + benchmarked; un-buildable → signed-off.
4. **Breadth** — MP4 faststart/forward-moov, metadata-write (WAV/AIFF/CAF), AVI+WAV mux, first-class fps.
5. **Real decrypt** — CENC `cens` + HLS sample-AES (key-provided, cleartext-twin oracle).
6. **Aggregate win re-confirmed** — full 8-engine multi-sample bake, all 3 browsers; `leaderboard.md` refreshed.
7. **External verification** — independent non-author re-run on the published package; real installed bundle measured; budgets green with margin.
8. **`bun run gate` green**, coverage ≥90%, anti-cheat green, docs + ADRs (113+) in sync.

**Never fake** (parent §0.6): a declared-but-unbuilt cell FAILs the oracle.

## Where we start (verified 2026-06-30)

- **#1 today:** 100% conf / 98.4% cov / 555 PASS / 0 FAIL (Chromium); `leaderboard.md` stale (re-aggregate).
- **WebKit complete:** 428 PASS / 119 NA_BROWSER / 14 NA_ENGINE / 0 FAIL/0 ERROR (ADR-110). **Firefox incomplete**; aggregate win + independent re-run open.
- **Shipped, don't rebuild:** Opus/Vorbis/FLAC encode, dav1d AV1 decode, VPx alpha (highest ADR=112). `competitive-gaps.md` codec matrix is a stale S2 snapshot.
- **Budgets razor-thin** (eager 49.95/50, first-op 246/256) → lazy-split every new driver.

## Decisions that are yours

1. **MP3 encode** — LGPL LAME tail or honest-NA. *Default: honest-NA.*
2. **AV1 encoder** — rav1e (Rust/BSD) vs SVT-AV1 vs honest-NA. *Recommend: rav1e.*
3. **HEVC Main10 / H.264 two-pass** — stay honest-NA; build VP9 two-pass on libvpx instead.
4. **EME** — build `cens`+sample-AES decrypt; live key acquisition stays a non-goal.
5. **Genuine browser limits** (MKV `<video>` smoke, committed-golden RGBA, AAC gapless) — keep NA_BROWSER.

## Definition of Done

Full DoD = @BUILD_INSTRUCTIONS_SESSION8.md §2 (= parent §2): all 8 boxes green, every non-PASS a signed-off §5 entry (ADR-113+), `bun run gate` exits 0.
