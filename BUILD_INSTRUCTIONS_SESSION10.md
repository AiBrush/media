# BUILD INSTRUCTIONS — SESSION 10 (win on the *fair* harness: SOTA correctness **and** speed, no overfitting)

> **Audience:** Claude Code (lead + read-only research fan-out; disjoint-driver correctness fixes MAY fan out in worktrees, §7 — the shared transcode/mux hot path stays sequential).
> **Inherits, does not replace:** [`BUILD_INSTRUCTIONS.md`](BUILD_INSTRUCTIONS.md) §0/§2/§3/§4/§5/§6/§10/§11/§13 remain **fully binding** (ULTRATHINK; every line SOTA; no feature without a strict validation **and** a fresh multi-sample benchmark on the real corpus; docs-as-law; **never fake**).
> **How to use:** max effort. Execute §6 to all-green. **The benchmark harness just got materially fairer and harder; this session makes `aibrush-media` genuinely SOTA under it — correctness first, then speed/memory — with zero overfitting and every oracle intact.**

---

## 0. SESSION-10 PRIME DIRECTIVE (on top of parent §0)

The harness at `../media-test/media-browser-test` was upgraded (2026-07-08, commit `49169be`) to **rotate multiple real files per scenario with exhaustive scoring** and to **independently parse our output structure** so **no engine grades itself**. Overfit passes have collapsed and large/long real files now expose failures the single-fixture harness hid. **Make us win the fair harness in aggregate on *both* axes — correctness (0 FAIL, 0 ERROR, 0 timeout, 0 OOM) and speed/memory — across *every* rotated file, with no oracle weakened and nothing faked.** A green that holds for only one file in a scenario's rotation is **overfitting, i.e. a FAIL** (parent §6.1/§6.5). Drive the worklist to empty; never stop (§9).

**THE HARNESS IS A BLACK BOX — this is non-negotiable (§4.7).** You **run** the benchmark and **read its result output** (per-cell status, metric, and failure reason); you **never open, read, or reason from its internal grading code** — not the scenario definitions, oracles, tolerances, runner, file-selection, or the output-structure parser, and not the per-engine adapters. Reading how the test grades invites building code that fits the *test* instead of the *real world*, which is exactly the overfitting this session exists to eliminate. Fix `aibrush-media` against **real-world correctness** — independent tools (`ffmpeg`/`ffprobe`/`openssl`/`mediainfo`), the format specs, and our **own** independently-baked corpus goldens — then re-run the harness only to confirm the red cleared. If a result's reason string is too terse to act on, reproduce the *operation itself* (the op + input trait, both named in the result) in our own tests against an independent oracle; do **not** go read the scenario source to learn what it wants.

---

## 1. STARTING STATE — VERIFIED (2026-07-08)

- **Correctness was #1 on the *old* single-file harness** (557 PASS / 0 FAIL / 0 ERROR / 7 honest-NA, chromium; WebKit 428/0/0). **That standing no longer holds on the fair harness** — treat it as unverified until re-measured (§6.A).
- **Speed was near-last** (Session 9 closed most wall-time deficits via lazy parsing + fast paths; commits `ead5675…6e94077`). The deficit worklist tooling exists: `docs/perf/gen-deficits.mjs` + `docs/perf/performance-deficits.md` + `docs/perf/performance-parity-exemptions.json`. **Reuse and extend it** — do not rebuild it.
- **The fair-harness upgrade** (`../media-test/media-browser-test`, commit `49169be`) — stated here so you never need to read its code (§4.7) — behaves as: per-scenario **multi-file rotation** (deterministic real-file selection per run); **exhaustive scoring** — metrics combine **sum** (additive cost) / **max** (peakMemory) / **median** (rates), and **a FAIL is never averaged into a PASS**; **independent parsing of our output structure** so we cannot pass by self-grading; **coverage-first ranking**. To operate it: run its provided corpus-download and golden-bake commands (do not read their source), then run the suite and read the exported results JSON. These behaviours are facts you may rely on — do not open the harness to re-confirm them.
- **Op timeout = `DEFAULT_OP_TIMEOUT_MS` 120 000 ms** (per op *and* per oracle; some scenarios raise it, e.g. `ladder_large…` 310 s). A **timeout or OOM is an ERROR — a functional failure strictly worse than a speed deficit** — and is the #1 priority to clear.
- **The reds the latest fair run surfaced** (seed list — CONFIRM/expand by re-measuring, §6.A; do **not** assume it is complete or that every entry still repros):
  - **Catastrophic (functional):** transcode times out at 120 s on nearly every transform (`h264_resize_720p`, `_4k_to_1080p`, `crop_center`, `flip_vertical`, `rotate_180`, `colorspace_709_to_2020`, `hdr10_to_sdr_tonemap`, `ladder_tiny_vp9_360p_to_h264_180p`, `op-sweep-transcode-webm`, `selfcheck_…tie`); `ladder_large_h264_1080p_120s_resize_720p` 310 s timeout; `ladder_large_vp9_1080p_120s_to_h264_720p` **OOM** ("Array buffer allocation failed").
  - **Quality FAIL:** `h264_rotate_normalize` SSIM 0.946 (gate 0.98); `multitrack_select_default_audio` SSIM 0.950; `decode_mov_h264` SSIM 0.854 (4 rivals pass — genuine); `meta_pts_monotonic_after_reorder` "no decoded frames" (B-frame reorder yields nothing).
  - **Large-file / enumeration:** `huge_h264_1080p_600s` drops a track (AAC reported `other`/`''`); `aac_adts` ADTS duration off by 2.9 s (19.99 vs 17.14).
  - **Empty-output:** `edge_gapless_aac_decode` "no tracks"; `size_longform_audio_to_mp4` "no coded samples".
  - **Edge container/decrypt:** `cenc_cbcs_decrypt` "no decryptable samples"; `hls_aes128` "not an MPEG-TS stream"; `prop_ts_to_mp4_duration_materialized` "cannot mix ADTS-framed and raw samples".
- **Highest ADR in use: 180.** Assign new ADRs from **181+** (verify against [`docs/architecture/02-decision-records.md`](docs/architecture/02-decision-records.md); never reuse a number).
- **Budgets razor-thin** (eager ~50 kB, first-op ~256 kB). Streaming/bounded rewrites and new indices/caches must be **lazy-split** (ADR-103 pattern) so both budgets stay green with margin.

---

## 2. DEFINITION OF DONE (scoped to Session 10)

Not done until **every** box is green, measured **fresh on the fair harness** (multi-file rotation on, chromium — the leaderboard browser):

- [ ] **Real worklist exists and gates:** a re-measured backlog (extend `docs/perf/gen-deficits.mjs` to also emit **functional reds** — FAIL/ERROR/timeout/OOM — not only wall-time deficits, and to **exit non-zero while any red remains**). Regenerate it every round; it is the living worklist.
- [ ] **Zero functional reds across the full rotation:** every scenario is **PASS on the strongest applicable oracle for every rotated file** — **0 FAIL, 0 ERROR, 0 timeout, 0 OOM** (the harness's independent structural check on our output passes). No honest-NA that a rival passes (parent §6.1: a rival passing a bucket means it is a real gap, not a safe decline) — except the three license/API-blocked NAs in §8.
- [ ] **#1 in aggregate, both axes:** on the fair harness we lead **conformance-then-coverage** *and* our fresh **multi-sample (n≥5)** median **wall + peakMemory ≤ the fastest/leanest rival** on every contested oracle-passing cell (Session-9 bar, now measured on rotated files). Any residual perf cell is **parity-exempt only** with an ADR proving a same-work-impossible tie (§4), never an unexplained loss.
- [ ] **No overfitting:** every fix passes across **all** rotated files for its scenario; **our own** validation goldens/tests rotate the §6.1 corpus too (a pass that holds for one file id **fails**, parent §6.5). Anti-cheat self-checks green (mutation, no passthrough, N/A≠0).
- [ ] **No regressions, no leaks, deterministic:** no PASS→FAIL anywhere (chromium **and** WebKit 428/0/0 un-regressed); every `VideoFrame`/`AudioData`/`ImageBitmap` `close()`d exactly once on the new streaming paths; `force-software` bit-exactness intact; typed errors only.
- [ ] **`bun run gate` exits 0**; coverage ≥90%; budgets green **with margin**; anti-cheat green.
- [ ] **Docs-as-law:** an ADR (181+) per non-trivial technique **and** any forced doc change in the same commit; `docs/notes/<topic>.md` design notes; the worklist regenerated to 0 reds; a fresh aggregate recorded showing us **#1 on the fair harness**.

One line: **0 functional reds + fastest/leanest on every contested cell, across every rotated file, with correctness un-regressed, no overfitting, and `bun run gate` green.**

---

## 3. ROOT-CAUSE TAXONOMY (classify each red before touching code — parent §4 design note first)

The fairness upgrade did not *create* bugs; it **stopped hiding** two structural shapes. Diagnose each red into one, confirm the exact code path, then fix to SOTA.

### A — Non-streaming / whole-file / unbounded-memory (the timeouts + OOM + big-file drops)

- **Symptom:** time and memory scale with file size/duration; the op exceeds 120 s or throws `Array buffer allocation failed` on the large/long rotated files; a track is dropped or mis-typed on `huge`/`longform` inputs. Rotation runs the pipeline once per file, so any O(file) or fully-buffered path is now hit repeatedly and blows the budget.
- **Fix program (verify per cell — do not assume):** make **`convert`/transcode a bounded streaming pipeline** — decode → (GPU/CPU) filter → encode with **backpressured, bounded in-flight frames**; never materialize all frames or the whole output. **Bound the muxer** (fragmented/streaming append; the CMAF/fragment path already exists — route large outputs through it) so samples are not all held. Pick the **fastest encoder config that still passes the SSIM/PSNR oracle on every rotated file** (e.g. `latencyMode` and keyframe cadence are speed levers *only if* the perceptual oracle still passes — an oracle-preserving tradeoff, never an oracle-weakening one). Keep the plain (non-alpha) path in the decoder's native pixel format — avoid per-frame RGBA round-trips unless a colour/tonemap op requires them. Fix large-file **track enumeration** (probe/demux) so AAC/every track is classified from its real sample entry, and **duration estimation** (ADTS) from the true framing, both O(index) not O(scan).

### B — Genuine correctness / quality bugs (the SSIM gaps, empty-output, edge containers)

- **Symptom:** wrong pixels (SSIM below floor on rotate-normalize / `.mov` decode), **empty output** (no tracks / no coded samples / no decoded frames after B-frame reorder), wrong duration, or a decrypt/container edge that a rotated real file trips (cbcs, HLS AES-128, TS→MP4 mixed framing).
- **Fix program:** ultrathink the exact defect (rotation geometry + the encoder's post-rotate quality; B-frame reorder/emit ordering; gapless/priming edge; ADTS↔raw AAC framing at the MP4 mux seam; cbcs subsample pattern; HLS TS detection). Write the failing validation test **on the rotated corpus** first, fix to SOTA, prove across all files. **Never** trade a strict pass for a looser one to make a number move.

> **A rarer third shape:** genuine algorithmic slowness in a hot loop — fix with SOTA algorithm/data-structure work, never by doing less than the oracle validates.

---

## 4. FAIR-COMPARISON & ANTI-OVERFIT RULES (honesty guardrails — read before claiming any win)

Hard constraints (parent §0.6, §6.5, §11):

1. **Same oracle, all files.** A cell counts as won only when our output PASSes the **strongest applicable** oracle for **every** rotated file. One-file passes are overfitting = FAIL.
2. **Never weaken, delete, or dodge an oracle** to win, and never tune to the fixture. The harness parses our output independently, so you cannot pass by self-grading — and you never touch the harness anyway (§4.7). **Our own** validation oracle/golden files (in this repo) must be byte-identical pre/post session (assert in close-out); if one is genuinely wrong, fix it *stricter* with an ADR + justification, never looser.
3. **A functional red outranks a speed win.** Clear every timeout/OOM/FAIL/ERROR before optimizing a passing cell. Never manufacture a "win" by declining work a rival does (that is a coverage loss on the fair harness); honest-NA only for the §8 blockers.
4. **Respect the harness's combine rules.** Metrics combine sum/max/median and a FAIL is never averaged into a PASS — do not exploit averaging; make **every** file pass and be fast.
5. **Fresh, multi-sample, apples-to-apples.** Re-measure `n≥5` with warmup on **chromium**, same fixtures, same harness build, rotation on. Never accept a single-sample or single-file number as proof (parent §6.3).
6. **Learn technique, don't copy code.** Read a rival *library's* published source/docs (§7) to understand *why* they win, then re-implement as our own SOTA TypeScript behind the frozen contracts. Never copy/vendor their code or route our op through them (parent §0.6).
7. **The harness is a BLACK BOX.** Run it; read only its result output (status/metric/reason) and the results JSON it exports. **Never open or reason from its scenario, oracle, tolerance, runner, selection, output-parser, or adapter source** — reading how the test grades is how overfitting starts. Validate every fix against **real-world** truth instead: independent tools (`ffmpeg`/`ffprobe`/`openssl`/`mediainfo`), the format spec, and our own independently-baked goldens. The product must be correct *in the world*; the harness merely confirms it. (This binds every agent you spawn, §7.)

---

## 5. THE PER-CELL LOOP (parent §3 TDD, with the fair harness as judge)

1. **Ultrathink** (§3 design note): classify A/B/algorithmic, name the exact code path, state the target (PASS all rotated files; then wall/peakMemory ≤ fastest rival) and the invariant that must not break (frame lifetime, determinism, budgets).
2. **Reproduce** on the fair harness: build ours (`tsup && bun run vendor-wasm`), re-vendor `dist/` into the harness's vendored engine copy, run chromium with rotation on (`../media-test/media-browser-test/scripts/run.sh chromium` / export), regenerate the worklist — confirm the cell is red **on the rotated files**. (Procedure: `[[aibrush-media-build-env]]` + [`BUILD_INSTRUCTIONS_SESSION8.md`](BUILD_INSTRUCTIONS_SESSION8.md) §1.)
3. **Write the failing test first** against the strongest oracle on the rotated corpus (add the exposing real file to `fixtures/manifest.json` if missing).
4. **Implement** the SOTA fix (§3). Keep frame/memory discipline, typed errors, force-software determinism, lazy-split budgets.
5. **Prove it:** re-build → re-vendor → re-run chromium **multi-sample (n≥5), all rotated files** → regenerate the worklist. The cell must PASS every file's oracle **and** (for perf) show wall/peakMemory ≤ fastest rival. Record the fresh benchmark.
6. **Guard the board:** same run shows **no PASS→FAIL** anywhere (chromium + WebKit) and no new red — a shared-hot-path change can regress a sibling; the generator catches it.
7. **Green commit** (small, one cell/cluster, conventional message). Never commit red. Next top-of-list cell.

> **Clusters:** many reds share one path (every transcode timeout is the same convert pipeline; every `massive/huge` probe the same scan). Fix the path, re-measure, mark the cluster cleared — but still validate **each** cell across **all** its files.

---

## 6. PHASES (each to a green gate)

- **10.A — Re-measure & seed the real worklist (lead, sequential).** Run the harness's provided corpus-download and golden-bake commands (run them; do not read their source, §4.7). Full fresh chromium run, rotation on; export the results JSON. Extend **our** `docs/perf/gen-deficits.mjs` (it reads the exported results — allowed) to emit **functional reds + wall/memory deficits** and to **exit(1) while any red remains**; write the backlog. **GATE:** true current standing captured; generator gates on functional reds too.
- **10.B — Kill the catastrophic functional failures (Root-cause A; shared hot path → sequential).** Make `convert`/transcode streaming + bounded-memory so every transform (incl. `ladder_large…`, `…vp9…720s`) completes within budget and PASSes SSIM/PSNR on all rotated files; fix large-file track enumeration + ADTS duration. **GATE:** 0 timeouts, 0 OOM, big-file cells PASS; board un-regressed.
- **10.C — Correctness / quality FAILs (Root-cause B; disjoint drivers MAY fan out in worktrees, §7).** rotate-normalize + `.mov` decode SSIM; B-frame reorder emit; gapless-AAC + longform empty-output; cbcs decrypt; HLS AES-128; TS→MP4 mixed-framing mux. Each: failing test on rotated corpus → SOTA fix → PASS all files. **GATE:** every §1 quality/empty/edge red green; anti-cheat green.
- **10.D — Speed & memory sweep to zero (Root-cause B/algorithmic; sequential on shared paths).** Continue Session 9 on the rotated corpus: drive every remaining wall/peakMemory deficit to ratio ≤ 1.0 (or ADR-documented parity-exempt, §4). **GATE:** `gen-deficits.mjs` reports 0 reds.
- **10.E — Close-out (lead).** Fresh full fair re-measure; confirm **#1 aggregate on both axes**, chromium reds all green, WebKit 428/0/0 un-regressed, oracle/golden files byte-identical; `bun run gate` → 0; ADRs (181+) + `docs/notes/`; regenerate the worklist to 0; record the aggregate scorecard. **GATE:** §2 fully green. **DONE.**

---

## 7. ORCHESTRATION (parent §10)

- **Read-only research MAY fan out** to study a rival **library's** own source/docs (e.g. the published `mediabunny`/`mp4box`/`web-demuxer`/`@remotion/*` packages) for *technique* only (§4.6) — **not** the harness's scenario/oracle/runner/adapter code, which is off-limits to every agent (§4.7).
- **Disjoint-driver correctness fixes (10.C) MAY fan out** — one agent per independent driver (ADTS, cbcs decrypt, HLS source, mpegts mux, .mov decode) **in separate worktrees**, each with its own failing test + fix + all-files proof; the lead integrates and re-runs the board. **Set each spawned agent to this session's model and max effort.**
- **The shared transcode/mux hot path (10.B, 10.D) stays sequential** — those edits touch `codec-pipeline.ts`/`video-stream-plan.ts`/mux and cannot be safely or measurably parallelized. Never fan out edits to shared core files without worktrees, and never merge an unverified agent result (parent §10).

---

## 8. EXPLICITLY OUT OF SCOPE / HONEST-NA (do not fake to manufacture a comparison)

- **Honest-NA stays NA:** MP3 encode (LGPL, no permissive encoder), HEVC Main10 output (no permissive 10-bit target), H.264 two-pass (WebCodecs exposes no first-pass API). Keep the typed `CapabilityError`; do not fabricate output.
- **No weakening/removing oracles; no reducing real work below the oracle; no chasing a rival's *unmeasured* metric** (`peakMemory:0` = unmeasured, not zero — §4).
- **No cross-browser-specific chasing.** Measure and win on **chromium** (the leaderboard browser); do not regress WebKit (428/0/0). Pure-TS wins carry over for free.

---

## 9. NON-STOP (parent §13)

Drive each red to a re-measured, all-files green; don't stop between; blocked → SOTA fix + ADR (181+) + continue. **Done only when the worklist reports 0 reds, the fair-harness board is un-regressed (chromium reds green + WebKit 428/0/0), and `bun run gate` exits 0.** Then report the fair-harness scorecard (aggregate rank + per-family correctness/speed/memory, fresh multi-sample, rotation on) as the standing new #1.
