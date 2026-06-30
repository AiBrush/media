# BUILD INSTRUCTIONS — SESSION 8 (the true closer: finish cross-browser · reclaim every fixable decline · fill the permissive tail)

> **Audience:** Claude Code (lead + a fan-out of Opus subagents), finishing the `aibrush-media` build for real.
> **Inherits, does not replace:** [`BUILD_INSTRUCTIONS.md`](BUILD_INSTRUCTIONS.md) §0/§2/§4/§5/§6/§10/§11/§13 remain **fully binding**. Session 8's Definition of Done **is** the parent §2 — in full. It also inherits the signed-off registers ADR-105/109/110.
> **How to use:** max reasoning effort. Read this, then [`SESSION8_GOAL.md`](SESSION8_GOAL.md), then [`docs/architecture/`](docs/architecture/README.md) and the latest ADRs (105–112). Execute §4 to all-green. **Do not stop until §2 is met or every remaining gap is a signed-off §5 register entry.**

---

## 0. SESSION-8 PRIME DIRECTIVE (on top of parent §0)

**Close it honestly.** Session 7 left three real holes: Firefox never ran a clean full matrix, the aggregate multi-engine win was never re-confirmed, and external (independent + real-bundle) verification never happened. Session 8 reaches the **parent Definition of Done** (`BUILD_INSTRUCTIONS.md` §2): every public op + the full container/codec set working with WebCodecs→GPU→WASM routing; **Chromium + WebKit + Firefox each at 0 FAIL / 0 ERROR with every buildable cell PASS and a higher PASS count than the S7 baseline**; the **aggregate win vs all 7 engines re-confirmed** on a fresh multi-sample bake on all three browsers; verification (strict oracles, force-software bit-exactness, anti-cheat, coverage ≥90%) green; **packaging real** (npm ESM+types, same-origin lazy wasm, real installed-bundle measured) with an **independent non-author re-run**; `bun run gate` exits 0; docs + ADRs (113+) in sync. The **only** admissible non-PASS is a **per-browser §5 register entry** (a browser physically lacks a codec/evidence AND no permissive SW fallback exists — and even then we build the fallback first). **NEVER FAKE** (parent §0.6): a declared-but-unbuilt cell FAILs the oracle.

---

## 1. STARTING STATE — VERIFIED (2026-06-30, against the run artifacts + ADR register)

- **Rank #1 today** (stale leaderboard notwithstanding): re-aggregating the freshest chromium artifacts gives **100.0% conformance / 98.4% coverage / 555 PASS / 0 FAIL** vs mediabunny 100% / ~90.4%. Refresh with `bun scripts/aggregate.mjs`.
- **Chromium: 555/561 PASS, 0 FAIL, 0 ERROR** (`results/raw/chromium-2026-06-28T00-57-29-541Z.json`). 6 non-PASS, all signed off (ADR-105/109): 2× MP3 encode (`NA_BROWSER`), `h264_8bit_to_hevc_10bit`, `h264_two_pass_bitrate`, **+ 2 reclaimable safety declines** (`remux/massive_h264_1080p_2h_mp4_to_mkv`, `trim/massive_h264_copy_sustained`).
- **WebKit: COMPLETE — 428 PASS / 119 NA_BROWSER / 14 NA_ENGINE / 0 FAIL / 0 ERROR** (`results/raw/webkit-2026-06-28T12-57-31-810Z.json`, ADR-110). Re-examine the 119 `NA_BROWSER` for cells a new SW encoder / dav1d decode routing now flips.
- **Firefox: INCOMPLETE — no clean full 561-row post-revendor run exists** (ADR-110: "Firefox still needs a fresh full post-revendor run"). Known runtime declines/timeouts already classified; the full matrix is the work.
- **Aggregate multi-engine win NOT re-confirmed** since Session 5 — latest runs are aibrush-only.
- **Budgets razor-thin:** eager ~49.95 / 50.00 kB, first-op ~246 / 256 kB. Last green gate: ~142 files / ~2215 tests, coverage ~92% stmt / ~90% branch, anti-cheat green. **New code must lazy-split or the budget breaks.**
- **Already shipped (do not rebuild):** Opus encode (ADR-088), Vorbis encode (ADR-108), FLAC encode pure-TS (ADR-086), dav1d AV1 8-bit decode (ADR-093), VPx alpha decode/copy/transcode on Chromium (ADR-107), metadata-light probe (ADR-112), package verifier (ADR-111). `docs/competitive-gaps.md`'s codec matrix is a stale Session-2 snapshot — trust the ADRs.

**Re-measure procedure (binding — the harness vendors our `dist/`, so a stale `dist` = a dishonest number):**
1. `bun run build && bun run vendor-wasm` (in `/media`).
2. `rm -rf ../media-test/media-browser-test/src/engines/aibrush-media/vendor/* && cp -R dist/. ../media-test/media-browser-test/src/engines/aibrush-media/vendor/`
3. `cd ../media-test/media-browser-test && bash scripts/run.sh --engine 'aibrush-media@dev' --browser <chromium|webkit|firefox> --no-reuse` (per-browser; **serialize — one browser at a time, swarm idle**). For the **final aggregate bake** drop `--engine` (all 8 engines) and use **full perf iters** (no `--iters 1`) — multi-sample is required for a real win claim. Refresh `results/leaderboard.md` with `bun scripts/aggregate.mjs` and the contested/uncontested + per-family + NA-ledger via `scripts/compare.mjs`/`compare.sh`.

---

## 2. DEFINITION OF DONE — SESSION 8 (= parent §2, in full)

Not done until **every** box is green:

- [ ] **Chromium 0 FAIL / 0 ERROR, every buildable cell PASS** — incl. the 2 reclaimed massive cells; the only non-PASS are §5 register entries.
- [ ] **WebKit 0 FAIL / 0 ERROR, every buildable cell PASS, PASS count up vs 428** — full 561-row run; per-browser NA registered.
- [ ] **Firefox 0 FAIL / 0 ERROR, every buildable cell PASS** — **first clean full 561-row run**; per-browser NA registered.
- [ ] **Aggregate win re-confirmed:** fresh **full 8-engine, multi-sample** bake on all three browsers → aibrush **wins in aggregate vs each of the 7**; contested/uncontested + per-family + NA-ledger published; no regressions vs the recorded baseline; `leaderboard.md` refreshed.
- [ ] **The 2 reclaimable Chromium declines closed** on bounded strict oracles (streaming Clusters mux + lazy source-range copy-trim) — not by raising caps.
- [ ] **Permissive SW encode/decode tail** (libvpx VP8/VP9 encode + VP9 two-pass, AV1 SW encode, AV1 dav1d decode routing) shipped, lazy/miss-only/same-origin, strict-oracle validated + benchmarked — or signed-off where un-buildable.
- [ ] **Breadth** (MP4 faststart/forward-moov, metadata-write breadth, AVI mux, WAV mux, first-class fps) shipped + validated + benchmarked.
- [ ] **Real decrypt** (`cens` pattern + HLS sample-AES) bit-exact vs cleartext twin.
- [ ] **Verification:** every op strict (bit-exact/structural) oracle on the ≥5-file real corpus, **bit-exact in force-software**; 0 WEAK-GATE-only passes; anti-cheat green; coverage ≥90% lines+branches.
- [ ] **Packaging:** ESM + `.d.ts` + `exports` map + code-split chunks; `import.meta.url` wasm **same-origin**; probe-only app pulls **zero** wasm (asserted); **real installed/tree-shaken bundle measured** (not vendored `dist/`).
- [ ] **Independent verification:** harness re-run by a **non-author path** on the **published package** (clean install), results published + diffable.
- [ ] **Budgets:** eager ≤50 kB, first-op ≤256 kB — **kept with margin** as features land (lazy-split every new driver).
- [ ] **Quality gates:** typecheck 0 / 0 `any`; biome clean; `bun run gate` exits 0; CI green.
- [ ] **Docs:** every feature → design note (`docs/notes/<feature>.md`) + ADR (113+); §5 register complete + **signed off**; README quickstart + runnable examples; ADR numbering reconciled.

---

## 3. THE REQUIREMENTS (grouped by work-type; mapped to the four chosen tracks)

### R1 — Reclaim the 2 Chromium massive declines *(track: finish the win; lead)*
- **Streaming Clusters-on-write MKV/WebM mux** (`src/drivers/webm/ebml-write.ts` currently buffers the whole segment) → emit `Cluster`s incrementally so `remux/massive_h264_1080p_2h_mp4_to_mkv` completes within a bounded memory envelope on a strict oracle. Also unblocks `target:writes` true streamed-output scoring + large remux/trim. **ADR-113.**
- **Bounded lazy source-range copy-trim** for `trim/massive_h264_copy_sustained` (extend the ADR-101/052 source-range pattern to sustained >1 GB) with a strict bounded trim/playback oracle. **ADR-114.**
- **GATE:** both cells PASS on bounded strict oracles + benchmark; Chromium buildable=PASS; no budget regression.

### R2 — Firefox full run + cross-browser PASS-maximization *(track: finish the win; THE heavy lift)*
- **Make the matrix resilient, run full Firefox to 561 rows**, fix **every FAIL/ERROR at the root** (codec-string normalization, container behavior, missing-fallback — never loosened oracles). Re-run WebKit after every relevant fix.
- **Flip decode-side `NA_BROWSER` via the WASM tail.** Route source decode through our shipped SW decoders so AV1 (dav1d), VP8/VP9 (libvpx), AAC/MP3/Vorbis (Symphonia/libvorbis) cells PASS on WebKit/Firefox instead of `NA_BROWSER` (e.g. `av1_to_h264_mp4`, AV1 decode-seek/demux). **Verify AV1 decode actually routes to dav1d on WebKit/Firefox** (ADR-111 declares the dav1d envelope; confirm the browser route selects it). **ADR-117.**
- **Re-examine WebKit's 119 `NA_BROWSER` + 14 `NA_ENGINE`** against the new SW encoders (R3) and filter paths; flip every cell a permissive path now reaches. Keep genuine browser limits (MKV `<video>` playback-smoke, committed-golden RGBA, AAC gapless) registered (§5).
- **GATE:** Firefox + WebKit each 0 FAIL/0 ERROR, every buildable cell PASS, **PASS count up** vs S7; per-browser NA registered with ADRs.

### R3 — Permissive software encode/decode tail *(track: software encoders)*
- **libvpx VP8/VP9 encode** (`src/codecs/wasm-vpx/` is decode-only — `wasm-vpx-driver.ts:142`): add an encode driver `src/codecs/wasm-vpx-enc/` (BSD libvpx, emcc), lazy/miss-only/same-origin. Closes cross-browser VP8/VP9 encode cells and the **Firefox VP9 budget timeouts** (ADR-110) with a tuned `cpu-used`/deadline route. **ADR-115.**
- **Real VP9 two-pass** on libvpx (it exposes first-pass stats) → close `h264_two_pass_bitrate` honestly for the VP9 target (H.264 two-pass stays §5 honest-NA). **ADR-115.**
- **AV1 software encode** (`src/codecs/wasm-av1/` is dav1d decode-only — `wasm-av1-driver.ts:139`): add `src/codecs/wasm-av1-enc/` (rav1e BSD via `wasm-bindgen`, or SVT-AV1). Closes WebKit/Firefox AV1 encode + M1/M2 no-HW-AV1. **ADR-116.**
- **AV1 dav1d decode routing** on browsers lacking WebCodecs AV1 (wire + verify, see R2). **ADR-117.**
- **Optional decode breadth where a core allows:** VP9 10-bit / 4:4:4 and AV1 10-bit decode (current cores are 8-bit/4:2:0 only — `wasm-vpx-driver.ts:176`, ADR-111). Build only if the vendored core supports it; else register §5.
- **Each core:** record source URL + SHA-256 + license in `BUILD.md`/`THIRD_PARTY_NOTICES`; Node-validate bit-exact/structural vs an independent tool (ffmpeg) on ≥5 real fixtures; benchmark; auto-register behind a **lazy default proxy** so eager/first-op budgets stay green.
- **GATE:** every flippable encode/decode cell is PASS on a strict oracle + fresh bench, or a signed-off §5 entry; budgets green with margin.

### R4 — Container & feature breadth *(track: container & feature breadth)*
- **MP4 faststart / forward-moov** for non-fragmented output (`src/drivers/mp4/write.ts` writes moov-at-tail; `fragment.ts` is CMAF-only) — positioned sparse forward-moov; closes `faststart:reserve`-class cells. **ADR-118.**
- **Metadata-write breadth** (`src/api/engine.ts:1199` declines unsupported targets): add tag writers where a real model exists (WAV `INFO`/`bext`, AIFF, CAF) beyond the current MP4/MKV/MP3/FLAC/OGG. **ADR-119.**
- **AVI mux** (`src/drivers/avi/avi-driver.ts:155` throws "not yet implemented") — idx1/OpenDML index + interleave. **WAV mux** (P2). **ADR-120.**
- **First-class `fps`-resample/retime** — declare the feature over the existing retiming plans (S5/`codec-pipeline.ts`). **ADR-122.**
- **GATE:** each feature passes its strict oracle (structural/metadata-exact, bit-exact in force-software where applicable) + benchmark; the corresponding harness cells PASS.

### R5 — Real decrypt: `cens` + HLS sample-AES *(track: DRM & advanced)*
- Implement CENC **`cens`** (AES-CTR pattern encryption) and **HLS sample-AES** (key-provided) in the existing decrypt path (`cenc.ts`/`hls-aes.ts`), gated on a **strict cleartext-twin oracle** (decrypt(x) == cleartext, openssl as the independent twin per `cenc-ctr-conformance` notes). ClearKey *static* keys already ship; **live license-server acquisition is an explicit non-goal** → registered, not built. **ADR-121.**
- **GATE:** both schemes decrypt bit-exact vs the cleartext twin on real vectors; the unsupported-scheme path still emits typed errors the graceful-failure oracle accepts.

### R6 — Aggregate win re-confirmation *(track: finish the win)*
- Fresh **full 8-engine** bake, **multi-sample perf** (real `--warmup`/`--iters`), on **all three browsers**; `compare.sh` → `report.md`; refresh `leaderboard.md`.
- Confirm aibrush **wins in aggregate vs each of the 7** (conformance → coverage → contested-win tiebreak). Record per-family + NA-ledger + contested/uncontested split (never cite uncontested-only or single-sample margins).
- **GATE:** win vs each of 7 on all three browsers, recorded + diffable.

### R7 — Packaging, budgets & independent verification *(track: finish the win)*
- **Real bundle:** measure the installed/tree-shaken size via the public API on the **published package** (not vendored `dist/`); probe-only app pulls **zero** wasm (assert).
- **Independent re-run:** drive the harness against the published package on a clean install (non-author path); publish results.
- **Budgets:** keep eager ≤50 kB and first-op ≤256 kB **with margin** via the lazy-split pattern as new drivers land. **Docs:** README quickstart + runnable examples for probe/convert/remux/trim/mux/decrypt.
- **GATE:** package installs + runs via public API; real bundle measured; independent re-run done; budgets green with margin.

### R8 — Honest-NA disposition + decisions (§5; cross-cutting)
- Settle the **decisions in SESSION8_GOAL "The decisions that are yours"** (MP3-encode LGPL call; AV1 encoder choice; HEVC-10bit/H.264-two-pass register; EME scope; genuine browser limits). Every non-PASS cell on every browser ends as a signed-off §5 register entry with an ADR.
- **GATE:** §5 register complete + signed off; `verify:integrity` (anti-cheat) green.

---

## 4. PHASES (each to a green gate; do not stop between)

- **8.0 — Reclaim the Chromium massive declines (lead):** R1. **GATE:** both massive cells PASS on bounded oracles; Chromium buildable=PASS.
- **8.1 — Permissive SW encode/decode cores (fan-out; worktrees for core builds):** R3 — one agent per core (`wasm-vpx-enc`, `wasm-av1-enc`), one for dav1d-route wiring. **GATE:** cores vendored, Node-validated bit-exact/structural vs ffmpeg, lazy-registered, budgets green.
- **8.2 — Firefox full run + cross-browser fixes (lead serialized runs + fan-out fixes):** R2 — resilient matrix; Firefox to 561 rows; fix every FAIL/ERROR at root; flip decode-side NA via the WASM tail; re-measure each browser. **GATE:** Firefox + WebKit 0 FAIL/0 ERROR, every buildable PASS, PASS count up.
- **8.3 — Breadth (fan-out, disjoint files):** R4. **GATE:** features PASS + bench; harness cells PASS.
- **8.4 — Real decrypt (single agent):** R5. **GATE:** `cens` + sample-AES bit-exact vs cleartext twin.
- **8.5 — Optimization & budgets (fan-out):** R7 budgets. **GATE:** budgets green with margin; bundle-analysis test passes.
- **8.6 — Packaging & independent verification (lead):** R7. **GATE:** published-package path + independent re-run + real-bundle green.
- **8.7 — FINAL aggregate bake + sign-off (lead):** R6 (full 8-engine, multi-sample, all 3 browsers) + R8 disposition; `bun run gate` → 0; §5 register complete + signed off; docs/ADRs in sync. **GATE:** parent §2 fully green. **DONE.**

---

## 5. HONEST-NA / DECISION REGISTER (the only admissible non-PASS — per browser, each ADR'd + signed off)

- **MP3 encode (2, all browsers)** — no permissive encoder; needs an isolated/lazy/separately-licensed LGPL LAME tail to close. **Your call.** *Default: honest-NA.*
- **HEVC Main10 output (1)** — no permissive HEVC Main10 encoder + WebCodecs exposes no portable 10-bit target. **Honest-NA.**
- **H.264 two-pass (1)** — WebCodecs/openh264 expose no usable first-pass stats. **Honest-NA.** (VP9 two-pass is built in R3 — different cell.)
- **EME live license acquisition** — explicit non-goal (no player/DRM). **Out-of-scope, registered.** (`cens`/sample-AES *decrypt* is built in R5.)
- **Per-browser codec/evidence gaps** — only after the WASM-tail route and any permissive SW encoder are exhausted: WebKit MKV `<video>` playback-smoke, WebKit/Firefox committed-golden RGBA readback, WebKit AAC gapless sample-count evidence, and any AV1/VP-encode cell whose permissive core is un-buildable in this toolchain. Each gets a per-browser ADR. **Target: this list shrinks vs S7; every entry is genuinely impossible-without-license/HW/evidence.**

---

## 6. ORCHESTRATION (disjoint files — no parallel edits to one file; parent §10)

Lead owns: harness **`adapter.ts`** (declarations/routing), **all builds / vendor / re-measure** (serialized; **browser runs one at a time, swarm idle**), the kernel + shared seams. Agents own disjoint files, assigned by core/feature/failure-cluster: `src/codecs/wasm-vpx-enc/`, `src/codecs/wasm-av1-enc/`, `src/drivers/webm/ebml-write.ts` (streaming Clusters), `src/drivers/mp4/write.ts` (faststart), `src/drivers/avi/`, `src/drivers/wav/`, the metadata tag writers, `src/api/decrypt*`+`cenc.ts`/`hls-aes.ts`, packaging/bundle scripts, examples/README. **Core builds run in worktree isolation.** Per fix: **reproduce on the target browser → root-cause → SOTA fix → strict oracle green → fresh bench → hand the lead the adapter change → adversarial verify on that browser.** Re-measure a browser only when the swarm is idle. Beware the shared working tree (`concurrent-writers-shared-tree`): gate your owned file in isolation.

---

## 7. ADR PLAN (next number is ADR-113; lead confirms final numbering)

- **ADR-113** — Streaming Clusters-on-write MKV/WebM mux (bounded large-output; reclaims massive remux; unblocks `target:writes`).
- **ADR-114** — Bounded lazy source-range sustained copy-trim (reclaims `massive_h264_copy_sustained`).
- **ADR-115** — libvpx VP8/VP9 encode tail + real VP9 two-pass (lazy, miss-only, BSD core).
- **ADR-116** — AV1 software encode tail (rav1e/SVT-AV1; permissive; lazy, miss-only).
- **ADR-117** — Cross-browser AV1 dav1d decode routing + WebKit/Firefox decode-side PASS-flips.
- **ADR-118** — MP4 faststart / forward-moov for non-fragmented output.
- **ADR-119** — Metadata-write breadth (WAV/AIFF/CAF tag writers).
- **ADR-120** — AVI mux (idx1/OpenDML) + WAV mux.
- **ADR-121** — CENC `cens` pattern + HLS sample-AES decrypt (key-provided); live-acquisition non-goal.
- **ADR-122** — First-class `fps`-resample/retime feature declaration.
- **ADR-123** — Session-8 final aggregate bake + per-browser cross-browser sign-off (supersedes/extends ADR-105/109/110).
- **ADR-124** — Independent verification + real installed-bundle measurement.

Every ADR follows the house format (`### ADR-NNN — Title`, with **Context / Decision / Consequences / Rejected**) and cites the fresh artifact(s) that prove it.

---

## 8. NON-STOP (parent §13) — the finish line

Drive every phase to green; don't stop at boundaries; blocked → SOTA + ADR + continue, **except** the leader decisions in SESSION8_GOAL (MP3-encode LGPL call; AV1-encoder choice; EME scope). **Session 8 is complete when parent §2 is fully green OR every remaining gap is a signed-off §5 register entry — whichever is the honest ceiling.** Then run the full 8-engine bake once more on all three browsers, confirm the aggregate win, refresh `leaderboard.md`, and report the final per-browser scorecard.

**Now: read [`SESSION8_GOAL.md`](SESSION8_GOAL.md), create the Session-8 tasks (one per R-group), and begin Phase 8.0. Do not stop until §2 is met.**
