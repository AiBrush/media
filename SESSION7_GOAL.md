# SESSION 7 — GOAL (the final session)

## The goal (binding)

**This is the last session.** Drive `aibrush-media` to **100% of the parent Definition of Done** @BUILD_INSTRUCTIONS.md §2) — **all code, all verification, all browsers in place** — and leave nothing for a Session 8. Concretely, Session 7 is done when:

1. **Cross-browser complete:** full 561-scenario runs on **Chromium, WebKit, and Firefox**, each at **0 FAIL / 0 ERROR**, every *buildable* cell PASS; any non-PASS is a signed-off entry in the per-browser Honest-NA register (a browser physically lacking a codec with no permissive SW fallback).
2. **Aggregate win re-confirmed:** a **fresh full multi-engine bake** (all 8 engines, multi-sample perf) shows aibrush **wins in aggregate vs each of the 7 reference engines** on all three browsers — with contested/uncontested + per-family + NA-ledger published, not a bare number.
3. **Verification hardened:** strict oracles green on the real corpus, bit-exact in force-software, anti-cheat green, coverage ≥90%, and **an independent (non-author) re-run on the published package** path is exercised (competitive-gaps §5).
4. **Packaging real:** npm-publishable ESM + `.d.ts` + exports map; `import.meta.url` wasm same-origin; a probe-only app pulls **zero** wasm; the **real installed/tree-shaken bundle** is measured (not the vendored `dist/`).
5. **`bun run gate` exits 0** and all docs/ADRs are in sync.

It supersedes nothing buildable: where Session 6 said "S7," this is it. **Do not stop until §2 of @BUILD_INSTRUCTIONS_SESSION7.md is fully green or every remaining gap is a signed-off register entry.**

## Where we start (verified, 2026-06-28, against the run artifacts)

- **Chromium: 555 / 561 PASS, 0 FAIL, 0 ERROR** (`results/raw/chromium-2026-06-28T00-57-29-541Z.json`). 6 non-PASS: 5 honest-NA (2× MP3 encode, HEVC-10bit-output, 2× massive >1 GB declines) + **1 genuine miss — `h264_two_pass_bitrate`** (R4 called it buildable; WebCodecs has no two-pass — build an approximate or register it).
- **WebKit: only 153/561 captured — and 14 FAIL + 8 ERROR + 3 NA_BROWSER already in that slice; 408 scenarios never ran.**
- **Firefox: only 51/561 captured — 2 FAIL; 510 never ran.**
- **Aggregate win NOT re-confirmed** since Session 5 — the latest runs are aibrush-only.
- **Budgets near ceiling:** eager **49.95 / 50.00 kB**, first-op **246.18 / 256.00 kB** — almost no headroom; optimization must not bust them.

## How we get there

- **Cross-browser is the heavy lift.** WebKit/Firefox have real FAIL/ERROR cells and a different WebCodecs surface (codecs they lack → must route to our WASM tail or register honest-NA). Fix every FAIL/ERROR at the root; build the SW fallback where a **permissive** core exists; register the rest per-browser with an ADR.
- **Then re-confirm the win** with a full multi-engine, multi-sample bake (real perf iters, not `--iters 1`).
- **Never fake** (parent §0.6): a declared-but-unbuilt cell FAILs the oracle. Every PASS is a real implementation on a strict oracle + a fresh benchmark.
- Work @BUILD_INSTRUCTIONS_SESSION7.md §4 phases in order; re-measure each browser at each gate.

## The decisions that are yours

1. **MP3 encode (2 cells, every browser).** No permissive encoder exists. Either approve an isolated/lazy/separately-licensed **LGPL LAME tail** (ADR + notice) to reach 100% coverage, or keep it **honest-NA**. *Default: honest-NA.*
2. **Cross-browser SW-codec investment.** Safari/Firefox lack some WebCodecs encoders/decoders (AV1, VP8/9, Opus, AAC vary). For each gap, do we **build the permissive SW fallback** (more cells PASS everywhere) or **register honest-NA per browser**? Recommend: build where a permissive core exists (Vorbis pattern), register the rest.
3. **Two-pass:** build an approximate two-pass (double-encode) or formally register it honest-NA (true two-pass needs encoder stats WebCodecs doesn't expose). *Recommend: register.*

## Definition of Done

See @BUILD_INSTRUCTIONS_SESSION7.md §2 (= parent §2, in full). One line: **Chromium + WebKit + Firefox each 0 FAIL/0 ERROR with every buildable cell PASS; aggregate win vs all 7 re-confirmed multi-sample on all three; verification + packaging + independent re-run done; `bun run gate` green; the Honest-NA register complete and signed off.**
