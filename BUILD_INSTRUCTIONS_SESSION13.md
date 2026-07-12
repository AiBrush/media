# BUILD INSTRUCTIONS — SESSION 13 (per-feature speed leadership: be the fastest engine on every feature, honestly)

> **Audience:** Codex/Claude, working at maximum reasoning effort on `aibrush-media` and the public fair-harness surface.
> **Inherits, does not replace:** [`BUILD_INSTRUCTIONS.md`](BUILD_INSTRUCTIONS.md) and the black-box, anti-overfit, rotation, frame-lifetime, real-corpus, documentation, typed-error, and non-stop rules from [`BUILD_INSTRUCTIONS_SESSION12.md`](BUILD_INSTRUCTIONS_SESSION12.md).
> **How to use:** Session 13 is a **speed-leadership** session. The product surface is functionally built; aggregate wins are already appearing. This session drives aibrush-media to be the **fastest correct engine on every individual benchmarked feature**, one feature at a time, through genuine engineering — never by fitting code to the harness.

---

## 0. SESSION-13 PRIME DIRECTIVE

### Binding user-directed priority (2026-07-11)

**For every feature the benchmark measures, aibrush-media must be the fastest engine that also passes.** Aggregate victory is not enough. Winning the "winner race" while losing individual rows (e.g. `probe/h264_4k_10s`, `probe/hevc_1080p_10s`, `probe/h264_vfr`) is an unfinished result. This priority overrides broad-rotation and evidence-first ordering wherever it conflicts, but never overrides correctness.

1. **Sweep feature by feature.** Walk the benchmark scenario by scenario. For each, compare aibrush-media's warm median wall (and peak memory) against every rival that passes that scenario: `mediabunny`, `ffmpeg.wasm`, `mp4box`, `remotion-media-parser`, `web-demuxer`. Record the leader and the gap.
2. **Where we are not #1, open a tracked todo.** Every feature where a rival is faster (or leaner) becomes an explicit, tracked work item in the task tool **and** a row in the committed speed ledger (§3.3). Drive each one to a durable lead, then mark it closed only with fresh qualified evidence.
3. **Correctness is the precondition, always.** A fastest-but-wrong row is a loss, not a win. Never trade a passing oracle, byte/sample truth, frame-exactly-once closure, backpressure, cancellation, or B-frame/VFR/seek correctness for speed. If an optimization would change output, it is out of bounds.
4. **NEVER OVERFIT.** Do not tune to the harness's exact assets, scenario names, rotation order, sizes, or thresholds. Do not special-case a fixture, precompute a known answer, short-circuit on a recognized input, cache a per-asset result, or detect "this is the benchmark." Every optimization must be a **general** improvement that makes the engine genuinely faster, leaner, more robust, and more future-proof on *any* real input of that shape. See §4.
5. **Try every legitimate idea.** For each behind feature, enumerate the full option space — algorithmic, allocation/GC, zero-copy, routing (hardware→native→WASM), worker/transfer, lazy parsing, SIMD, pooling, cold-vs-warm, memory — pick the SOTA path, and reason through it before typing. Record an ADR when behavior or a documented contract changes.
6. **Solid, stable, future-proof.** Speed must not come from brittleness. No reliance on undocumented browser quirks, no unbounded memory, no race-prone fast paths, no silent capability narrowing. A faster path that is less robust than the current one is rejected.

**Do not interpret an empty loss list as a win when coverage did not qualify.** A feature is "won" only under §3.2 qualified evidence: same-export, same-rotation, warm, `n>=5`, both engines passing, with a durable (non-noise) lead. `n=1`, cross-export, a single fast rotation, or a lead inside run-to-run noise is not a win.

### The fair harness remains a black box

Run its public commands and read only status/metric/reason output and exported JSON. **Never open or read its scenario, oracle, tolerance, runner, rotation/selection, output-parser, or adapter source.** Establish truth with `ffmpeg`, `ffprobe`, `openssl`, `mediainfo`, format specifications, public product calls, and independently baked goldens. Profile with your own instrumentation of *product* code, never by reading harness internals.

### Session-12 correctness closure still binds

Session 13 does not reopen or regress Session 12. The nine retained reds, the 57 `NA_ASSET` evidence rows, the two `NA_BROWSER` / two `NA_ENGINE` boundaries, and all held Session 11/12 fixes remain acceptance-active (see [`BUILD_INSTRUCTIONS_SESSION12.md`](BUILD_INSTRUCTIONS_SESSION12.md) §1.8, §3). No speed change may flip a PASS to FAIL, weaken a golden, or narrow a documented capability. Correctness first, then evidence completeness, then — this session's focus — per-feature speed.

---

## 1. VERIFIED HANDOFF STATE (2026-07-11)

### 1.1 Rival roster and current signal

The benchmark harness compares aibrush-media against five engines. Pinned versions at handoff:

- `mediabunny@1.48.0`
- `ffmpeg.wasm@0.12.15`
- `mp4box@2.3.0`
- `remotion-media-parser@4.0.479`
- `web-demuxer@4.0.0`
- `aibrush-media@dev`

The running conformance matrix shows aibrush-media leading the aggregate winner race but **losing or only tying specific rows**. Observed at handoff (illustrative, not a substitute for a fresh measured sweep):

- `probe/h264_4k_10s` — aibrush `18.86 ms` vs `remotion-media-parser` `12.77 ms` (rival leads).
- `probe/hevc_1080p_10s` — aibrush `3.44 ms` vs `mediabunny` `3.41 ms` (razor-thin loss; treat as BEHIND, not parity).
- `probe/h264_vfr` — aibrush `33.11 ms` vs `remotion-media-parser` `29.6 ms` (rival leads).
- aibrush already leads `probe/h264_1080p_30s`, `probe/realworld_mdn_flower_mp4`, `probe/h264_bframes_1080p`.

These are a starting hint only. The authoritative behind-list comes from the §3.1 fresh qualified sweep, not from a mid-run screenshot. Many rivals `FAIL`/`ERROR` on rows aibrush passes — a rival that does not pass a scenario is not a valid speed comparator for it (§3.2).

### 1.2 What "faster" must include

The user's target is faster **and** more solid, stable, and future-proof. This session optimizes three coupled axes, in priority order:

1. **Correctness preserved** — non-negotiable gate on every change.
2. **Warm median wall time** — the primary leaderboard metric; be strictly fastest.
3. **Positive-sample peak memory and robustness** — be lean and stable; do not win wall by leaking, unbounding, or de-robustifying.

A change that improves (2) but harms (1) or (3) is rejected.

### 1.3 Inherited hot-path work not to regress

Prior sessions already landed fast paths: prepared-mux, direct PCM/alpha ops, exact Router caching, lazy audio/video containers, WebCodecs acceleration selection, fused BS.775 5.1→mono, fused stereo polyphase resample, bounded packed evidence, and the eager/typical budget guard bands. Build on these; never undo one to chase a single row.

---

## 2. DEFINITION OF DONE

Session 13 is done only when every item is simultaneously true:

- [ ] A fresh, qualified all-engine sweep (§3.2) covers **every** benchmarked feature aibrush-media passes, on the same export and rotation, warm, `n>=5`.
- [ ] The committed speed ledger (§3.3) has a row per feature with our time, the best passing rival and its time, the ratio, root cause, the optimization applied, and the closing evidence.
- [ ] On every contested feature (a feature where at least one rival also passes), aibrush-media has the **strictly lowest** warm median wall time by a durable, non-noise margin — zero non-exempt wall losses, zero unresolved ties.
- [ ] On every contested feature, aibrush-media's positive-sample peak memory is `<=` the leanest passing rival, or the exceedance is documented and justified as an intentional, robust trade with an ADR.
- [ ] Every "behind" feature discovered in the sweep was closed by a **general** optimization — proven not to change output bytes/sample truth, benchmarked fresh against the specific rival that led, and shown to hold across the scenario's rotations. No fixture special-casing, no harness detection, no per-asset shortcut.
- [ ] Any performance-parity exemption is real, minimal, and recorded in `docs/perf/performance-parity-exemptions.json` with an independent physical/technical justification (e.g. a browser platform floor), not used to hide an unoptimized path.
- [ ] No Session-12 correctness regression: the completed-rotation correctness board, the nine retained reds' status, force-software determinism, and close-exactly-once frame ownership are all un-regressed. Zero PASS→FAIL.
- [ ] Each optimization ships with focused validation proving output invariance, a fresh multi-sample benchmark, lifecycle/backpressure/cancellation coverage proportional to risk, and docs/ADR (next available ADR is currently **245+**; verify before assigning).
- [ ] `bun run gate` exits 0; coverage `>=90%`; format/lint/typecheck/test/anti-cheat/package verification pass; eager and typical budgets retain margin (a speed win that blows a budget is not accepted).
- [ ] Chromium, WebKit, and Firefox smoke/correctness are un-regressed; the anti-overfit audit (§4.4) passes with zero findings.
- [ ] Session 13 design notes, ADRs, the regenerated deficit/scorecard artifacts, and the final per-feature speed scorecard are committed together with the code they justify.

---

## 3. METHODOLOGY — THE PER-FEATURE SPEED SWEEP

### 3.1 Enumerate every feature and its passing field

1. Run the public benchmark and export JSON for all engines on identical rotations. Enumerate every scenario/feature the harness measures. Do not read harness source to get the list — derive it from exported results and public status output.
2. For each feature, list which engines **pass** it. Only passing engines are valid speed comparators (§3.2). Record rivals that `FAIL`/`ERROR`/`N/A` as non-comparators for that row, with their reason.
3. Bucket features by family (probe, demux, decode-seek, transcode, mux, remux, trim, audio-dsp, metadata, streaming-output, robustness, performance) so shared root causes are fixed once and reused across the family.

### 3.2 Qualified comparison rules (what counts as a real win/loss)

A feature is **WON** only when all hold:

- Same public export, same rotation set, warmup `>=1`, `n>=5`, no result reuse, fresh browser cache/profile.
- aibrush-media **passes** the feature (correct oracle), and so does the rival being compared.
- aibrush-media's **median** warm wall is strictly the lowest among all passing engines, by a margin larger than the observed run-to-run noise for that row (gather more samples if the gap is inside noise; a 3.44-vs-3.41 style result is **BEHIND/PARITY**, never a win).
- Positive-sample peak memory is `<=` the leanest passing rival, or exempted per §2.

Anything short of this is **BEHIND** (a rival leads), **PARITY** (inside noise — keep optimizing until a durable lead), or **UNCONTESTED** (no rival passes — no target, but record it).

### 3.3 The speed ledger (committed, source of truth)

Maintain `docs/perf/session13-speed-ledger.md` (create it) plus tracked tasks. One row per feature:

| feature | family | our median ms | best passing rival | rival ms | ratio | status | root cause | optimization idea(s) | closing evidence |

- `status ∈ {LEAD, BEHIND, PARITY, UNCONTESTED, EXEMPT}`.
- Open a task-tool item for every `BEHIND`/`PARITY` row; set it in-progress when you start, closed only when it flips to `LEAD` with §3.2 evidence.
- Never delete a row because a different rotation looked faster; supersede it only with a fresh qualified measurement.

### 3.4 Root-cause before optimize

For each behind feature, first **measure why**, using your own product instrumentation and standard profiling — never harness internals. Attribute the gap to a concrete cause (cold module init, redundant full parse, extra allocation/copy, worker round-trip, missing hardware route, over-eager decode, TextDecoder churn, GC pressure, etc.). Only then choose the fix. No blind micro-tuning.

---

## 4. ANTI-OVERFIT DOCTRINE (the core rule of this session)

### 4.1 Legitimate optimization — must be general and truth-preserving

Every accepted change must make the engine faster/leaner/more robust for **any** real input of that shape, and must provably not alter output. Examples of legitimate work:

- **Algorithmic:** parse only the boxes/atoms actually required for the operation; single-pass parsing; lazy `moov`/`cues`/index resolution; short-circuit a *general* early-exit (e.g. probe needs only shape, so stop after the structure is known — for all inputs, not a recognized one); avoid decoding when the operation is copy/probe/remux.
- **Zero-copy & allocation:** typed-array `subarray` views instead of `slice`/copy; buffer/pool reuse; avoid intermediate full-signal planes; reuse decoders/encoders/parsers across samples; cut redundant hashing and re-parsing.
- **Encoding/decoding churn:** hoist and reuse `TextDecoder`/`TextEncoder`; precompute immutable lookup tables; avoid per-call object churn; minimize GC pressure on the hot loop.
- **Routing ladder:** prefer hardware WebCodecs → GPU → WASM (miss-only); avoid unnecessary WASM warmup on the hot path; keep the worker warm; avoid worker round-trips for tiny tasks; use transferables to avoid structured-clone copies.
- **Parallelism & streaming:** overlap independent stages; stream with real backpressure; drop payloads once sizes are known; keep memory bounded.
- **Cold-start (if it shows in warm runs):** streaming WASM compile, code-splitting, lazy module graphs — only where it genuinely affects the measured warm path.

### 4.2 Forbidden — overfitting and fake speed

Any of these is an automatic reject and, if found, must be removed and recorded:

- Detecting a specific asset, size, hash, filename, scenario name, rotation index, or "this is the benchmark," and taking a different path.
- Caching or hardcoding a per-asset answer, precomputed result, or memoized output keyed on recognizing the input.
- Skipping real work (parse/decode/mux) for a recognized input while doing it for others.
- Passthrough, padding, fabricated metadata, spoofed container/codec, or a weakened oracle to shave time.
- Narrowing a documented capability, dropping robustness (bounds checks, error typing, cancellation, backpressure) to win wall.
- Tuning constants to the harness's exact thresholds rather than to the general workload.

### 4.3 Proof obligation per optimization

Each speed change ships with: (a) focused validation that output bytes/sample/frame truth are **identical** before/after; (b) a fresh multi-sample benchmark showing the win against the specific rival that led, on real corpus; (c) lifecycle/backpressure/cancellation coverage where the path touches frames/streams; (d) an ADR if any documented behavior/contract shifts; (e) full gate green.

### 4.4 Anti-overfit audit

Before close-out, run an explicit audit (extend `scripts/anti-cheat.ts` as needed): grep the diff and hot paths for asset/scenario/size/hash branching, per-input memoization, and recognized-input short-circuits. The audit must pass with zero findings. Record it.

---

## 5. EXECUTION PHASES

### 13.A — Establish the qualified baseline sweep

Run all engines on identical rotations, same export, warm, `n>=5`, fresh cache/profile. Build the full feature list, the passing field per feature, and the initial speed ledger (§3.3). Classify every feature LEAD/BEHIND/PARITY/UNCONTESTED.

**Gate:** complete qualified baseline; ledger committed; a tracked task open for every BEHIND/PARITY feature.

### 13.B — Root-cause the behind features by family

For each family with behind rows, profile product code and attribute each gap to a concrete cause (§3.4). Group shared causes so one fix lifts a whole family. Write a one-paragraph design note per cause covering timing, frame ownership, backpressure, cancellation, and memory.

**Gate:** every BEHIND/PARITY feature has a measured root cause and a chosen SOTA fix, with the design note written before code.

### 13.C — Optimize, feature by feature, highest-leverage first

Order by (rival gap × feature frequency across families). For each: write/keep fail-first output-invariance validation, implement the general optimization, prove byte/sample/frame identity, add a fresh benchmark against the leading rival, run the relevant tests + strict typecheck, update ADR/docs. Re-measure the row under §3.2; flip to LEAD only on a durable lead. Never move to the next feature by weakening this one's correctness.

**Gate:** each targeted feature flips to LEAD with qualified evidence; no correctness or budget regression; anti-overfit audit clean for the change.

### 13.D — Memory and robustness pass

For every contested feature, verify positive-sample peak memory `<=` leanest passing rival, or record a justified exemption. Confirm bounded memory, backpressure, cancellation, and force-software determinism on every optimized path. Ensure no fast path is race-prone or quirk-dependent.

**Gate:** memory `<=` leanest rival on every contested feature (or justified exemption); robustness invariants green.

### 13.E — Full-field re-sweep and regression check

Re-run the complete qualified sweep. Confirm every contested feature is LEAD, zero non-exempt wall/memory losses, and no PASS→FAIL anywhere. Regenerate the deficit/scorecard artifacts. Re-run Chromium full plus WebKit/Firefox smoke/correctness.

```sh
node docs/perf/gen-deficits.mjs \
  docs/perf/stored-test-data-chromium-2026-07-01T08-33-45-588Z.json \
  ../media-test/results/raw/chromium-*.json
```

**Gate:** every contested feature LEAD on fresh qualified evidence; zero regressions; `activeLossCount` zero with real contested coverage.

### 13.F — Close-out

Run `bun run gate`, coverage, package/budget/anti-cheat, the §4.4 anti-overfit audit, Chromium full, WebKit, and Firefox. Record the final per-feature speed scorecard (our time, best rival, ratio, margin) and the all-engine aggregate. Commit design notes, ADRs, ledger, and artifacts with the code they justify.

**Gate:** §2 is fully green. Only then declare Session 13 complete.

---

## 6. CLEAN-MACHINE COMMAND ENVIRONMENT

- Bun is installed at `/Users/tarek/.bun/bin/bun`.
- Node/npm are under `/opt/homebrew/bin`.
- Use `PATH=/Users/tarek/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin` for product scripts and add `/usr/sbin:/sbin` for browser runs.
- Browser runs are headed. Use the harness's public `scripts/run.sh --help` and public command surface only; do not inspect its implementation.
- After every production build, re-vendor the current `dist/` into `../media-test/src/engines/aibrush-media/vendor/` before measuring, and invalidate the Chromium module cache/profile so a stale bundle cannot be measured as fast.
- Always measure warm, rotation on, `n>=5`, same export. A single cold `n=1` number is a lie for this session.

---

## 7. NON-STOP AND ANTI-OVERFIT

Work from correctness to robustness to speed, feature by feature, until every contested feature is a durable, honest LEAD. A different-rotation pass, an old cached bundle, a fixture-detecting shortcut, an `n=1` timing, a within-noise "win," or a memory leak masquerading as speed is not proof. Never weaken a golden/oracle, special-case an asset, fabricate metadata, spoof a container, or narrow a capability to win. Being #1 by a hair is not being #1 — build a real margin. Done means the final scorecard shows aibrush-media strictly fastest and correct on every contested feature, achieved by general, future-proof engineering — not by fitting the tests.
