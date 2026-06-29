# BUILD INSTRUCTIONS — SESSION 7 (the FINAL session: all code · all verification · all browsers)

> **Audience:** Claude Code (lead + a fan-out of Opus subagents), finishing the `aibrush-media` build.
> **Inherits, does not replace:** [`BUILD_INSTRUCTIONS.md`](BUILD_INSTRUCTIONS.md) §0/§2/§4/§5/§6/§10/§11/§13 remain **fully binding**. Session 7's Definition of Done **is** the parent §2 — in full.
> **How to use:** max reasoning effort. Read this, then [`SESSION7_GOAL.md`](SESSION7_GOAL.md), then [`docs/architecture/`](docs/architecture/README.md). Execute §4 to all-green. **This is the last session — do not stop until §2 is met or every remaining gap is a signed-off §5 register entry.**

---

## 0. SESSION-7 PRIME DIRECTIVE (on top of parent §0)

**Finish it.** Reach the **parent Definition of Done** (`BUILD_INSTRUCTIONS.md` §2): every public op + the full container/codec set working with WebCodecs→GPU→WASM routing; **Chromium + WebKit + Firefox each at 0 FAIL / 0 ERROR with every buildable cell PASS**; the **aggregate win vs all 7 engines re-confirmed** on a fresh multi-sample bake; verification (strict oracles, force-software bit-exactness, anti-cheat, coverage ≥90%) green; **packaging real** (npm ESM+types, same-origin lazy wasm, real installed-bundle measured) with an **independent non-author re-run**; `bun run gate` exits 0; docs in sync. The **only** admissible non-PASS is a **per-browser §5 register entry** (browser physically lacks a codec AND no permissive SW fallback exists — and even then we build the fallback first). **NEVER FAKE** (parent §0.6): a declared-but-unbuilt cell FAILs the oracle. No Session 8.

---

## 1. STARTING STATE — VERIFIED (2026-06-28, against the run artifacts)

- **Chromium: 555 / 561 PASS, 0 FAIL, 0 ERROR** (`results/raw/chromium-2026-06-28T00-57-29-541Z.json`; 37 cells flipped NA→PASS in S6, 0 regressions). 6 non-PASS = 5 honest-NA (2× MP3 encode `NA_BROWSER`; `h264_8bit_to_hevc_10bit` HEVC-10bit-output; `massive…mp4_to_mkv` + `massive_h264_copy_sustained` >1 GB declines) **+ 1 genuine miss: `h264_two_pass_bitrate`** (still `NA_ENGINE`, not registered).
- **WebKit: PARTIAL — 153/561 captured, 124 PASS / 14 FAIL / 8 ERROR / 4 NA_ENGINE / 3 NA_BROWSER; 408 never ran** (stopped at `transcode/ladder_tiny_h264_360p_resize_180p`).
- **Firefox: PARTIAL — 51/561 captured, 40 PASS / 2 FAIL / 8 NA_ENGINE / 1 NA_BROWSER; 510 never ran** (stopped at `robustness/fuzz_adts_aac_bitflip_probe`).
- **Aggregate win NOT re-confirmed** since Session 5 — latest runs are aibrush-only.
- **Budgets razor-thin:** eager **49.95 / 50.00 kB**, first-op **246.18 / 256.00 kB**. Gate last green: 142 files / 2215 tests, coverage 92.24% stmt / 90.01% branch, anti-cheat 45/45.

**Re-measure procedure (binding — the harness vendors our `dist/`, so a stale `dist` = a dishonest number):**
1. `bun run build && bun run vendor-wasm` (in `/media`).
2. `rm -rf ../media-test/media-browser-test/src/engines/aibrush-media/vendor/* && cp -R dist/. ../media-test/media-browser-test/src/engines/aibrush-media/vendor/`
3. `cd ../media-test/media-browser-test && bash scripts/run.sh --engine 'aibrush-media@dev' --browser <chromium|webkit|firefox> --no-reuse` (per-browser; serialize — one browser at a time). For the **final aggregate bake** drop `--engine` (all 8 engines) and use **full perf iters** (no `--iters 1`) — multi-sample is required for a real win claim.

---

## 2. DEFINITION OF DONE — SESSION 7 (= parent §2, in full)

Not done until **every** box is green:

- [ ] **Chromium 0 FAIL / 0 ERROR, every buildable cell PASS** — the only non-PASS are §5 register entries (target ≥ 559/561 net of MP3).
- [ ] **WebKit 0 FAIL / 0 ERROR, every buildable cell PASS** — full 561-row run; per-browser NA registered.
- [ ] **Firefox 0 FAIL / 0 ERROR, every buildable cell PASS** — full 561-row run; per-browser NA registered.
- [ ] **Aggregate win re-confirmed:** fresh **full 8-engine, multi-sample** bake on all three browsers → aibrush **wins in aggregate vs each of the 7**; contested/uncontested + per-family + NA-ledger published; no regressions vs the recorded baseline.
- [ ] **Verification:** every op strict (bit-exact/structural) oracle on the ≥5-file real corpus, **bit-exact in force-software**; 0 WEAK-GATE-only passes; anti-cheat green; coverage ≥90% lines+branches.
- [ ] **Packaging:** ships ESM + `.d.ts` + `exports` map + code-split chunks; `import.meta.url` wasm emitted **same-origin**; a probe-only app pulls **zero** wasm (asserted); the **real installed/tree-shaken bundle** is measured (not vendored `dist/`).
- [ ] **Independent verification:** the harness is re-run by a **non-author path** on the **published package** (clean install), results published + diffable (competitive-gaps §5 #3).
- [ ] **Budgets:** eager ≤50 kB, typical-app first-op ≤256 kB (keep margin), wasm lazy + miss-only + same-origin (bundle-analysis test).
- [ ] **Quality gates:** typecheck 0 / 0 `any`; biome clean; `bun run gate` exits 0; CI green on every gate.
- [ ] **Docs:** every feature → design note + ADR; §5 register complete + **signed off**; README quickstart + runnable examples for the common tasks; ADR numbering reconciled.

---

## 3. THE REQUIREMENTS (grouped by work-type)

### R1 — Close the Chromium tail (small; lead)
- **`h264_two_pass_bitrate`** — build an approximate two-pass (encode-to-stats then re-encode at adjusted bitrate via two WebCodecs passes) **or** register honest-NA (true two-pass needs encoder stats WebCodecs doesn't expose). Decide + act; don't leave it ambiguous.
- **Reconcile §5:** `massive_h264_copy_sustained` (`trim:massive-lazy-read`) — either build the lazy-stream sustained copy-trim (source-range pattern, ADR-101/052) or register it with the other >1 GB declines. Confirm each of the 5 register cells has an ADR.
- **GATE:** Chromium every buildable cell PASS; §5 register exact and complete.

### R2 — Cross-browser correctness (THE heavy lift)
- **Run full WebKit + Firefox to completion.** Both partial runs stopped early — first make the run resilient (a FAIL/ERROR/timeout must not abort the matrix) and/or fix the crashers, then capture all 561 rows each.
- **Fix every FAIL + ERROR at the root** (WebKit ≥14 FAIL + ≥8 ERROR; Firefox ≥2 FAIL). Expect codec-string normalization, container-behavior, and missing-fallback differences — not loosened oracles.
- **Flip NA_BROWSER via our WASM tail where it's decode-side.** Safari/Firefox lack various WebCodecs codecs; we already ship **dav1d (AV1), libvpx (VP8/9), Vorbis, AAC, MP3** decoders — route the source track through the WASM decoder so e.g. `av1_to_h264_mp4` PASSes on WebKit instead of NA_BROWSER. **Encode-side** gaps (AV1/VP8 encode) need a permissive SW encoder (only Vorbis built) → R6 build-or-register.
- **GATE:** WebKit 0 FAIL/0 ERROR, Firefox 0 FAIL/0 ERROR, every buildable cell PASS on each; per-browser NA registered.

### R3 — Aggregate win re-confirmation
- Fresh **full 8-engine** bake, **multi-sample perf** (real `--warmup`/`--iters`), on **all three browsers**; `compare.sh` → `report.md`.
- Confirm aibrush **wins in aggregate vs each of the 7** (conformance → coverage → contested-win tiebreak). Record per-family + NA-ledger + contested/uncontested split (don't cite uncontested-only or single-sample margins).
- **GATE:** win vs each of 7 on all three browsers, recorded + diffable.

### R4 — Optimization & budgets
- **Perf:** contested cells ≥ winner (multi-sample fresh); longtasks ≈ 0 on the convert/decode paths.
- **Budgets:** reclaim headroom (eager at 49.95/50.00, first-op 246/256) via the lazy-split pattern (`codec-routing.ts`/ADR-103) — keep both green **with margin** as features settle.
- **GATE:** perf competitive; budgets green with margin; bundle-analysis test passes.

### R5 — Packaging & independent verification
- **Publish path:** ESM + `.d.ts` + `exports` map + code-split verified; `import.meta.url` wasm same-origin; probe-only app pulls **zero** wasm (assert).
- **Real bundle:** measure the installed/tree-shaken size via the public API (not vendored `dist/`).
- **Independent re-run:** drive the harness against the **published package** on a clean install (non-author path); publish results.
- **Docs:** README quickstart + runnable examples for probe/convert/remux/trim/mux/decrypt.
- **GATE:** package installs + runs via public API; real bundle measured; independent re-run done.

### R6 — Encode-tail final disposition + decisions (§5)
- **MP3 encode (2)** — your LGPL-LAME call, or honest-NA. **AV1/VP8 encode (cross-browser)** — build a permissive SW encoder (rav1e BSD / libvpx) to flip WebKit/Firefox encode cells, or register per-browser honest-NA. **HEVC-10bit-output / two-pass** — register if not built.
- **GATE:** every encode gap is either PASS or a signed-off §5 entry.

---

## 4. PHASES (each to a green gate; do not stop between)

- **7.0 — Close Chromium tail (lead):** R1. **GATE:** Chromium buildable=PASS, §5 reconciled.
- **7.1 — Cross-browser full runs + triage (lead serialized):** make the matrix resilient; run WebKit + Firefox to 561 rows each; produce the FAIL/ERROR/NA triage list. **GATE:** complete runs on both browsers.
- **7.2 — Cross-browser fixes (fan-out, disjoint files):** R2 — fix every FAIL/ERROR at root; route decode-side NA_BROWSER through the WASM tail; re-measure each browser. **GATE:** WebKit + Firefox 0 FAIL/0 ERROR, every buildable PASS.
- **7.3 — Optimization & budgets (fan-out):** R4. **GATE:** perf competitive, budgets green with margin.
- **7.4 — Packaging & independent verification:** R5. **GATE:** published-package path + independent re-run green.
- **7.5 — FINAL aggregate bake + sign-off:** R3 (full 8-engine, multi-sample, all 3 browsers) + R6 disposition; `bun run gate` → 0; §5 register complete + signed off; docs in sync. **GATE:** parent §2 fully green. **DONE.**

---

## 5. HONEST-NA / DECISION REGISTER (the only admissible non-PASS — per browser, each ADR'd + signed off)

- **MP3 encode (2, all browsers)** — no permissive encoder; needs an isolated/lazy/separately-licensed LGPL LAME tail to close. **Your call.** Default: N/A.
- **HEVC 10-bit encode output (1)** — HW-only no-winner (doc-10 §3).
- **Massive >1 GB (1–2)** — bounded-materialization safety (ADR-102); a typed decline > OOM. (Resolve `massive_h264_copy_sustained` in R1: build lazy-read or register.)
- **Two-pass (1)** — if not built in R1, register (WebCodecs exposes no two-pass stats).
- **Per-browser codec gaps (WebKit/Firefox)** — only after the WASM-tail route and any permissive SW encoder are exhausted. Each gets a per-browser ADR. **Target: this list is small and every entry is genuinely impossible-without-license/HW.**

---

## 6. ORCHESTRATION (disjoint files — no parallel edits to one file)

Lead owns: harness **adapter.ts** (declarations/routing), **all builds/vendor/re-measure** (serialized; **browser runs one at a time, swarm idle**). Agents own disjoint files, assigned by failure cluster: per-codec drivers (`src/codecs/*`), `webcodecs-video.ts`, `mp4/write.ts`, `src/drivers/webm/`, `codec-pipeline.ts`, packaging/bundle scripts, examples/README. Per fix: **reproduce on the target browser → root-cause → SOTA fix → strict oracle green → bench → hand the lead the adapter change → adversarial verify on that browser.** Re-measure a browser only when the swarm is idle.

---

## 7. NON-STOP (parent §13) — the finish line

Drive every phase to green; don't stop at boundaries; blocked → SOTA + ADR + continue, **except** the MP3-encode LGPL call (§5, yours). **Session 7 is complete when parent §2 is fully green OR every remaining gap is a signed-off §5 register entry — whichever is the honest ceiling. No Session 8.** Then run the full 8-engine bake once more on all three browsers, confirm the win, and report the final scorecard.

**Now: read [`SESSION7_GOAL.md`](SESSION7_GOAL.md), create the Session-7 tasks (one per R-group), and begin Phase 7.0. Do not stop until §2 is met.**
