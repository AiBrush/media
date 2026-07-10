# BUILD INSTRUCTIONS — SESSION 11 (finish the *fair* harness: 0 functional reds, then fastest/leanest — no overfitting)

> **Audience:** Claude Code (lead + read-only research fan-out; disjoint-driver correctness fixes MAY fan out in worktrees, §7 — the shared transcode/mux hot path stays sequential).
> **Inherits, does not replace:** [`BUILD_INSTRUCTIONS.md`](BUILD_INSTRUCTIONS.md) §0/§2/§3/§4/§5/§6/§10/§11/§13 remain **fully binding** (ULTRATHINK; every line SOTA; no feature without a strict validation **and** a fresh multi-sample benchmark on the real corpus; docs-as-law; **never fake**). Session-10's fair-harness facts (§1 below) also carry forward.
> **How to use:** max effort. Execute §6 to all-green. **Session 10 landed a large win; this session closes the finite tail it left — a set of genuine correctness/quality reds (2 of them regressions Session 10 itself introduced) and a fixed-overhead speed tail — with correctness first, then speed/memory, zero overfitting, every oracle intact.**

---

## 0. SESSION-11 PRIME DIRECTIVE (on top of parent §0)

Session 10 took `aibrush-media` from "times out on nearly every transform + OOMs" to a large win on the fair harness (`../media-test/media-browser-test`, multi-file rotation + exhaustive scoring + independent output-parsing). **This is the new baseline — and it is not finished.** A finite, well-scoped tail remains: **~18 functional reds** (incl. **2 encryption graceful-failure regressions Session 10 introduced**, i.e. PASS→FAIL) and a **fixed-overhead speed tail** (0 catastrophic · 2 severe · 1 moderate · 19 minor · 1 lone timeout). **Drive the worklist to empty on both axes — 0 FAIL / 0 ERROR / 0 timeout / 0 OOM across *every* rotated file, then wall + peakMemory ≤ the fastest/leanest rival on every contested cell — with no oracle weakened and nothing faked.** A green that holds for only one file in a scenario's rotation is **overfitting = a FAIL** (parent §6.1/§6.5). Never stop (§9).

**THE HARNESS IS A BLACK BOX — non-negotiable (§4.7).** You **run** the benchmark and **read its result output** (per-cell status, metric, failure reason) and the results JSON it exports; you **never open, read, or reason from its internal grading code** — not the scenario definitions, oracles, tolerances, runner, file-selection, output-structure parser, or the per-engine adapters. Reading how the test grades invites building code that fits the *test* instead of the *real world* — the exact overfitting Session 10's fairness upgrade exists to eliminate. Fix `aibrush-media` against **real-world correctness** — independent tools (`ffmpeg`/`ffprobe`/`openssl`/`mediainfo`), the format specs, and our **own** independently-baked corpus goldens — then re-run the harness only to confirm the red cleared. If a result's reason string is too terse, reproduce the *operation itself* (the op + input trait, both named in the result) in our own tests against an independent oracle; do **not** read the scenario source to learn what it wants.

---

## 1. STARTING STATE — VERIFIED (2026-07-08 base; Session-10 landed the win — RE-MEASURE first, §6.A)

- **Correctness (new baseline):** Session 10 closed the catastrophic transcode timeouts and the OOM and fixed 13 functional reds. **2 reds regressed (PASS→FAIL) and 1 new red surfaced.** The current worklist is **18 functional reds** (`docs/perf/_deficit-data.json`, refreshed from base `chromium-…08-48` + overlays `…16-14`, `…16-23`, `…17-47`). **Caveat: that base run is single-sample and partial** — 11.A must do a **fresh full chromium run** and regenerate `docs/perf/gen-deficits.mjs` before trusting any number; treat every entry below as a **seed to confirm/expand**, not ground truth, and don't assume each still repros.
- **Speed (new baseline):** the Session-9/10 push collapsed active speed deficits (289 → 133 on the stable basis → **22** on the fresh 2026-07-08 base). Tiers now **0 catastrophic · 2 severe · 1 moderate · 19 minor**. The catastrophic transcode timeouts + the OOM are **gone**; **only 1 timeout remains** (`performance/op-sweep-transcode-webm`). The worklist tooling exists — `docs/perf/gen-deficits.mjs` + `docs/perf/performance-deficits.md` + `docs/perf/performance-parity-exemptions.json`. **Reuse and extend it; do not rebuild it.**
- **The 18 functional reds this run surfaced** (seed list — CONFIRM/expand in 11.A; grouped by root cause):
  - **P0 — the 2 regressions to restore FIRST:** `encryption/cenc_ctr_protection_zeroed_graceful` and `encryption/cenc_ctr_senc_bitflip_graceful` both flipped **PASS→FAIL** — they now **produce output from malformed/mutated input** instead of a clean throw/reject. Restore graceful failure **without breaking the working decrypt path**.
  - **HLS-AES128 (one pipeline gap):** `demux/hls_aes128` (golden-packets: **470 packets size mismatch**, NEW) + `probe/hls_aes128` (ERROR "not an MPEG-TS stream"). TS/HLS detection + packet sizing.
  - **Encryption decrypt:** `encryption/cenc_cbcs_decrypt` (property-invariant: **23/24 frame digests differ**) + `encryption/cenc_cens_decrypt` (playback-smoke: output doesn't advance).
  - **Transcode quality:** `transcode/h264_resize_720p` + `transcode/selfcheck_h264_resize_720p_tie` (ssim-psnr **SSIM 0.968 / min 0.962** just under the 0.97 / 0.98 gate — **encoder-quality tuning that still passes the oracle on EVERY rotated file**, never an oracle-weakening move); `transcode/extreme_fps_1` (out dur **23.0s vs 22.507s**, Δ0.493 > 0.15).
  - **Decode / mux:** `decode-seek/decode_mov_h264` (ssim-psnr **SSIM min 0.854 / mean 0.935**, 4 rivals pass → **genuine `.mov` decode bug**); `mux/edge_hevc_decode_mux_mkv` (property-invariant: `decode(mux(x))` → **zero intrinsic size**); `mux/size_longform_audio_to_mp4` (ERROR "track 1 has no samples to stream-copy").
  - **Probe enumeration / duration:** `probe/huge_h264_1080p_600s` (golden-metadata: **2 tracks vs 3** — the AAC track is dropped/misclassified `audio/aac` → `other/''`); `audio-dsp/edge_gapless_aac_decode` (property-invariant: **gapless sample count wrong** — 48128 vs 2654203); `remux/h264_ts_ts_to_mp4` (reference-reimport: dur **10.010s vs 10.129s**, Δ0.119 > 0.10).
  - **The 1 lone timeout (functional red — clears before speed):** `performance/op-sweep-transcode-webm` (timeout > 120000 ms on `h264_1080p_30s.mp4`). On the shared transcode/webm hot path → sequential (§7).
  - **VERIFY corpus/golden vs genuine engine bug BEFORE touching engine code** (these smell like media-rotation/golden mismatches — confirm against ffprobe truth; **if it's a corpus/golden defect, fix it in the harness corpus, not `aibrush-media`**): `probe/h264_1080p_5s` (golden-metadata: measured **9.467s vs golden 6.467s** on a rotated `01.mov`); `transcode/h264_crop_center` (ERROR "crop rect 240,135 1440×810 outside 1080×1920 source" — a **landscape crop rect applied to a portrait rotated file**; adapt crop geometry to the actual input dims and/or fail gracefully).
- **The speed tail** (all PASS-but-slower; `docs/perf/performance-deficits.md`): **Severe** `performance/size-ladder-iterate-packets-huge` (19.5× vs remotion-webcodecs — still materializing packet payloads on a huge file) + `streaming-output/prop_webm_headerless_duration_materialized` (10.2× vs mediabunny); **Moderate** `demux/flac_noseektable` (3.6× vs remotion-webcodecs); **Minor tail** 19 cells < 3× (e.g. `metadata/meta_consistent_mp4_to_mkv` 2.76×, `streaming-output/mp4_fragmented_cmaf` 2.12×, vp9 decode/demux) — mostly **fixed per-op overhead** (init / WASM / WebCodecs config / worker spin-up / un-reused buffers).
- **Highest ADR in use: 186.** Assign new ADRs from **187+** (verify against [`docs/architecture/02-decision-records.md`](docs/architecture/02-decision-records.md); never reuse a number).
- **Budgets razor-thin** (eager ~50 kB, first-op ~256 kB). Any new index/cache/decoder path must be **lazy-split** (ADR-103 pattern) so both budgets stay green with margin.

---

## 2. DEFINITION OF DONE (scoped to Session 11)

Not done until **every** box is green, measured **fresh on the fair harness** (multi-file rotation on, chromium — the leaderboard browser):

- [ ] **Real worklist re-measured & gating:** a fresh full chromium run regenerates `docs/perf/gen-deficits.mjs` (it already emits **functional reds** — FAIL/ERROR/timeout/OOM — and **exits non-zero while any red remains**). Regenerate it every round; it is the living worklist.
- [ ] **Zero functional reds across the full rotation:** every scenario is **PASS on the strongest applicable oracle for every rotated file** — **0 FAIL, 0 ERROR, 0 timeout, 0 OOM** (the harness's independent structural check on our output passes). **Both encryption graceful-failure regressions restored to PASS.** No honest-NA that a rival passes (parent §6.1) — except the three license/API-blocked NAs in §8.
- [ ] **#1 in aggregate, both axes:** we lead **conformance-then-coverage** *and* our fresh **multi-sample (n≥5, warmup)** median **wall + peakMemory ≤ the fastest/leanest rival** on every contested oracle-passing cell (rotation on). Any residual perf cell is **parity-exempt only** with an ADR proving a same-work-impossible tie (§4), never an unexplained loss.
- [ ] **No overfitting:** every fix passes across **all** rotated files for its scenario; **our own** validation goldens/tests rotate the §6.1 corpus too (a pass that holds for one file id **fails**, parent §6.5). Anti-cheat self-checks green (mutation, no passthrough, N/A≠0). Any corpus/golden defect (§1 "VERIFY" smells) is fixed in the **harness corpus**, never worked around in engine code.
- [ ] **No regressions, no leaks, deterministic:** no PASS→FAIL anywhere (chromium **and** WebKit 428/0/0 un-regressed); every `VideoFrame`/`AudioData`/`ImageBitmap` `close()`d exactly once; `force-software` bit-exactness intact; typed errors only.
- [ ] **`bun run gate` exits 0**; coverage ≥90%; budgets green **with margin**; anti-cheat green.
- [ ] **Docs-as-law:** an ADR (187+) per non-trivial technique **and** any forced doc change in the same commit; `docs/notes/<topic>.md` design notes; the worklist regenerated to 0 reds; a fresh aggregate recorded showing us **#1 on the fair harness**.

One line: **0 functional reds (both regressions restored) + fastest/leanest on every contested cell, across every rotated file, with correctness un-regressed, no overfitting, and `bun run gate` green.**

---

## 3. ROOT-CAUSE TAXONOMY (classify each red before touching code — parent §4 design note first)

**Unlike Session 10, this round is *not* the catastrophic non-streaming crisis.** Root-cause **A** (whole-file / unbounded-memory timeouts + OOM) is essentially cleared — only 1 timeout remains (`op-sweep-transcode-webm`), and it is a hot-path cell, not a structural regression. This session is dominated by **Root-cause B** (genuine correctness/quality) plus a **fixed-overhead speed tail (B′)**. Diagnose each red into one, confirm the exact code path, then fix to SOTA.

### B — Genuine correctness / quality bugs (the bulk of the worklist)

- **Symptom:** a clean throw is missing on mutated input (the 2 graceful-failure **regressions**); wrong decrypt pixels (cbcs 23/24 digests, cens no-advance); wrong decoded pixels (`.mov` SSIM 0.854); empty/zero output (`decode(mux(x))` zero intrinsic size on HEVC-MKV; longform "no samples to stream-copy"); a dropped/mis-typed track (`huge` AAC → other); wrong sample count / duration (gapless AAC; TS→MP4 reimport; extreme-fps duration drift); a container-detection or packet-sizing gap (HLS-AES128 demux+probe); post-scale encoder quality below the SSIM floor (resize_720p).
- **Fix program:** ultrathink the exact defect (CTR keystream vs subsample coverage; cbcs pattern; TS sync/packet framing + AES-128 IV; QTFF `.mov` sample-description/decode path; HEVC `hvcC` → MKV `CodecPrivate`; ADTS↔raw AAC gapless priming; the post-resize encoder config that still clears the perceptual oracle). Write the **failing validation test on the rotated corpus** first, fix to SOTA, prove across **all** files. **Restore the 2 regressions without regressing the working decrypt path** — the graceful-failure and the happy-path must both hold. **Never** trade a strict pass for a looser one, and **never weaken the SSIM gate** — tune the encoder until it clears the oracle on every rotated file.
- **Corpus/golden-first sub-rule:** for `probe/h264_1080p_5s` (9.47 vs 6.47) and `transcode/h264_crop_center` (landscape rect on portrait file), **first confirm against `ffprobe` truth** whether the golden/geometry is wrong. If the corpus/golden is defective, fix it in the **harness corpus** (re-bake) — do **not** distort engine code to match a wrong golden. If the engine is genuinely wrong, fix the engine.

### B′ — High fixed per-operation overhead (the minor speed tail)

- **Symptom:** on tiny inputs we are still 1–3× slower even though the real work is microseconds — micro mux/probe/demux/one-frame decode rows where init / WASM instantiation / WebCodecs config / worker spin-up / un-reused buffers dominate. Also the 2 **severe** rows (`size-ladder-iterate-packets-huge`, `prop_webm_headerless_duration_materialized`) and the **moderate** `flac_noseektable` — enumerate timeline facts **without materializing payload bytes** (a residual whole-body read = a real loss).
- **Fix program:** profile the ~ms floor on a trivial op; amortize init (reuse the worker/pool, cache the WASM instance and WebCodecs config, reuse buffers) and route the packet-enumeration cells through payload-free timeline facts. Batch the small wins; each must stay oracle-passing on every rotated file.

> **The 1 timeout** (`op-sweep-transcode-webm`) is a functional red on the shared transcode/webm path — clear it in the correctness phases (§6.C), sequential (§7), before optimizing any passing cell.

---

## 4. FAIR-COMPARISON & ANTI-OVERFIT RULES (honesty guardrails — read before claiming any win)

Hard constraints (parent §0.6, §6.5, §11):

1. **Same oracle, all files.** A cell counts as won only when our output PASSes the **strongest applicable** oracle for **every** rotated file. One-file passes are overfitting = FAIL.
2. **Never weaken, delete, or dodge an oracle** to win, and never tune to the fixture. The harness parses our output independently, and you never touch the harness anyway (§4.7). **Our own** validation oracle/golden files (in this repo) must be byte-identical pre/post session (assert in close-out) — **except** a golden the §1 "VERIFY" step proves genuinely wrong, which is re-baked **stricter/correct** with an ADR + `ffprobe` justification, never looser.
3. **A functional red outranks a speed win.** Clear every FAIL/ERROR/timeout/OOM (incl. the 2 regressions + the 1 timeout) before optimizing a passing cell. Never manufacture a "win" by declining work a rival does; honest-NA only for the §8 blockers.
4. **Respect the harness's combine rules.** Metrics combine sum/max/median and a FAIL is never averaged into a PASS — make **every** file pass and be fast; do not exploit averaging.
5. **Fresh, multi-sample, apples-to-apples.** Re-measure `n≥5` with warmup on **chromium**, same fixtures, same harness build, rotation on. A single-sample or single-file number is a **seed, not proof** (parent §6.3) — the §1 base run is `n=1`.
6. **Learn technique, don't copy code.** Read a rival *library's* published source/docs (§7) to understand *why* they win, then re-implement as our own SOTA TypeScript behind the frozen contracts. Never copy/vendor their code or route our op through them (parent §0.6).
7. **The harness is a BLACK BOX.** Run it; read only its result output (status/metric/reason) and the results JSON it exports. **Never open or reason from its scenario, oracle, tolerance, runner, selection, output-parser, or adapter source.** Validate every fix against **real-world** truth instead: independent tools (`ffmpeg`/`ffprobe`/`openssl`/`mediainfo`), the format spec, and our own independently-baked goldens. (Binds every agent you spawn, §7.)

---

## 5. THE PER-CELL LOOP (parent §3 TDD, with the fair harness as judge)

1. **Ultrathink** (§3 design note): classify B/B′ (or the lone A-timeout), name the exact code path, state the target (PASS all rotated files; then wall/peakMemory ≤ fastest rival) and the invariant that must not break (decrypt happy-path, frame lifetime, determinism, budgets). For a regression, name **what Session-10 change removed the clean throw** and how to restore it without touching the working decrypt.
2. **Reproduce** on the fair harness: build ours (`tsup && bun run vendor-wasm`), re-vendor `dist/` into the harness's vendored engine copy, run chromium with rotation on, regenerate the worklist — confirm the cell is red **on the rotated files**. (Procedure: `[[aibrush-media-build-env]]` + [`BUILD_INSTRUCTIONS_SESSION8.md`](BUILD_INSTRUCTIONS_SESSION8.md) §1.)
3. **Write the failing test first** against the strongest oracle on the rotated corpus (add the exposing real file to `fixtures/manifest.json` if missing). For the "VERIFY" smells, first assert `ffprobe` truth to decide corpus-vs-engine.
4. **Implement** the SOTA fix (§3). Keep frame/memory discipline, typed errors, force-software determinism, lazy-split budgets.
5. **Prove it:** re-build → re-vendor → re-run chromium **multi-sample (n≥5), all rotated files** → regenerate the worklist. The cell must PASS every file's oracle **and** (for perf) show wall/peakMemory ≤ fastest rival. Record the fresh benchmark.
6. **Guard the board:** same run shows **no PASS→FAIL** anywhere (chromium + WebKit) and no new red — a shared-hot-path change can regress a sibling (this is exactly how the 2 encryption regressions slipped in); the generator catches it.
7. **Green commit** (small, one cell/cluster, conventional message). Never commit red. Next top-of-list cell.

> **Clusters:** several reds share one path — the 2 `cenc_ctr` graceful regressions share the CTR decrypt/validation seam; `demux/hls_aes128` + `probe/hls_aes128` share the TS/HLS detection path; the 2 `resize_720p` rows share one encoder config. Fix the path, re-measure, mark the cluster cleared — but still validate **each** cell across **all** its files.

---

## 6. PHASES (each to a green gate)

- **11.A — Re-measure & regenerate the real worklist (lead, sequential).** Run the harness's provided corpus-download and golden-bake commands (run them; do not read their source, §4.7). Full fresh chromium run, rotation on; export the results JSON. Regenerate `docs/perf/gen-deficits.mjs` (it already gates on functional reds + wall/memory deficits and `exit(1)`s while any red remains) and rewrite the backlog. Confirm which of the 18 seed reds still repro and whether any new red appeared. **GATE:** true current standing captured (multi-sample where feasible); worklist regenerated; generator gates on functional reds.
- **11.B — Restore the 2 encryption graceful regressions + close HLS-AES128 (Root-cause B; P0).** Restore `cenc_ctr_protection_zeroed_graceful` + `cenc_ctr_senc_bitflip_graceful` to a clean throw/reject on mutated input **without breaking the working decrypt path** (add a happy-path regression test alongside each graceful test). Fix `demux/hls_aes128` (packet sizing) + `probe/hls_aes128` (TS/HLS detection) as one pipeline. Each: failing test on rotated corpus → SOTA fix → PASS all files. **GATE:** 4 cells green; decrypt happy-path un-regressed; board un-regressed.
- **11.C — Remaining decrypt/decode/mux/probe correctness (Root-cause B + the 1 timeout; disjoint drivers MAY fan out in worktrees, §7 — the transcode/mux/webm hot path stays sequential).** cbcs + cens decrypt; `.mov` decode SSIM; HEVC-MKV `decode(mux(x))` + longform stream-copy mux; probe `huge` track-enum + gapless AAC + TS→MP4 reimport duration; resize_720p + extreme_fps encoder/duration quality; the `op-sweep-transcode-webm` timeout. **First run the "VERIFY" step** for `probe/h264_1080p_5s` and `transcode/h264_crop_center` — fix the corpus/golden if defective, else the engine. **GATE:** every §1 functional red green across all rotated files; anti-cheat green; oracle/golden files byte-identical (except any §4.2-justified re-bake).
- **11.D — Speed & memory sweep to zero (Root-cause B′; sequential on shared paths).** Drive the severe rows (`size-ladder-iterate-packets-huge`, `prop_webm_headerless_duration_materialized`) to payload-free enumeration, the moderate `flac_noseektable`, then batch the 19-cell minor tail by amortizing fixed per-op overhead — each to ratio ≤ 1.0 (or ADR-documented parity-exempt, §4). **GATE:** `gen-deficits.mjs` reports 0 reds and 0 non-exempt losses.
- **11.E — Close-out (lead).** Fresh full fair re-measure; confirm **#1 aggregate on both axes**, chromium reds all green, WebKit 428/0/0 un-regressed, oracle/golden files byte-identical (except justified re-bakes); `bun run gate` → 0; ADRs (187+) + `docs/notes/`; regenerate the worklist to 0; record the aggregate scorecard. **GATE:** §2 fully green. **DONE.**

---

## 7. ORCHESTRATION (parent §10)

- **Read-only research MAY fan out** to study a rival **library's** own source/docs (e.g. the published `mediabunny`/`mp4box`/`web-demuxer`/`@remotion/*` packages) for *technique* only (§4.6) — **not** the harness's scenario/oracle/runner/adapter code, which is off-limits to every agent (§4.7).
- **Disjoint-driver correctness fixes (11.B/11.C) MAY fan out** — one agent per independent driver (CENC-CTR graceful, cbcs/cens decrypt, HLS/TS source, `.mov` QTFF decode, HEVC-MKV mux, gapless AAC, probe track-enum) **in separate worktrees**, each with its own failing test + fix + all-files proof; the lead integrates and re-runs the board. **Set each spawned agent to this session's model and max effort.**
- **The shared transcode/mux/webm hot path stays sequential** — the `resize_720p`/`extreme_fps` encoder config, the `op-sweep-transcode-webm` timeout, the longform stream-copy mux, and the 11.D packet-enumeration speed work touch `codec-pipeline.ts`/`video-stream-plan.ts`/mux and cannot be safely or measurably parallelized. Never fan out edits to shared core files without worktrees, and never merge an unverified agent result (parent §10). (The 2 encryption regressions are a live reminder that a shared-path edit can silently redden a sibling — re-run the full board after every integration.)

---

## 8. EXPLICITLY OUT OF SCOPE / HONEST-NA (do not fake to manufacture a comparison)

- **Honest-NA stays NA:** MP3 encode (LGPL, no permissive encoder), HEVC Main10 output (no permissive 10-bit target), H.264 two-pass (WebCodecs exposes no first-pass API). Keep the typed `CapabilityError`; do not fabricate output. (`edge_hevc_decode_mux_mkv` is HEVC Main *decode+mux*, not Main10 output — it is in scope.)
- **No weakening/removing oracles; no reducing real work below the oracle; no chasing a rival's *unmeasured* metric** (`peakMemory:0` = unmeasured, not zero — §4).
- **No cross-browser-specific chasing.** Measure and win on **chromium** (the leaderboard browser); do not regress WebKit (428/0/0). Pure-TS wins carry over for free.

---

## 9. NON-STOP (parent §13)

Drive each red to a re-measured, all-files green; don't stop between; blocked → SOTA fix + ADR (187+) + continue. **Done only when the worklist reports 0 reds, the fair-harness board is un-regressed (chromium reds green + WebKit 428/0/0), and `bun run gate` exits 0.** Then report the fair-harness scorecard (aggregate rank + per-family correctness/speed/memory, fresh multi-sample, rotation on) as the standing new #1.
