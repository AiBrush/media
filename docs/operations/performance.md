# Performance Methodology

> **Shard S21 — Performance (methodology, cross-cutting).** This doc owns a *concern*, not a set of
> `src/*.ts` files. It is the binding measurement contract for every benchmark in `aibrush-media`:
> how a number is produced, why it is trustworthy, and what makes it inadmissible. It is the
> **target spec** (the best measurement design) **plus an honest delta** against today's ~87 hand-rolled
> bench scripts and the sibling 7-engine harness.

---

## 1. Purpose & scope

**Restated in fully concrete terms:** *"What is the `performance` benchmark family, and what is the
single, non-negotiable protocol by which aibrush-media turns a media operation into a trustworthy,
comparable, regression-gated performance number — one that survives being placed next to the seven
rival engines and cannot be gamed by dead-code elimination, a warm cache, a single lucky sample, a
degenerate `N/A→0` metric, or a peak-memory reading perturbed by the timing loop?"*

This family is the **measurement methodology itself**, not any one operation. Every other operations
doc (`decode-seek`, `transcode-*`, `mux`, `remux`, `trim`, `audio-dsp`, `streaming-output`, `probe`,
`demux`, `encryption`, `metadata`, `robustness`) produces numbers; **this doc defines what a valid
number is** and is the authority those docs defer to for the words *warmup*, *median*, *p95*,
*peak memory / RSS pass*, *checksum sink*, *`--check` gate*, *fresh multi-sample*, and *within-noise*.

Benchmark family served: **`performance`**. It is also the cross-cutting substrate under the other 12
families — a `transcode` throughput number and a `probe` probes/sec number are both produced by the
protocol specified here.

**The three laws (inherited from the harness, `../media-test/src/core/report.ts:11-27`):**

1. **No measurement → no claim.** A metric with no admissible sample is `N/A`, never `0` or "best".
2. **No green correctness oracle → no admissible benchmark.** A fast wrong answer is a regression, not
   a win. Correctness gates every number (`../media-test/src/core/report.ts:758-760`).
3. **Never compare across browsers or machines.** Every comparison is within one browser, on one
   corpus checksum (`../media-test/src/core/report.ts:287-294`).

The acceptance bar (Definition of Done): an **aggregate benchmark win vs each of the 7 reference
engines, measured fresh and multi-sample** — the original suite's cached single-sample margins are
explicitly *not trusted or reused* (measured-evidence.md_: "the original benchmark's performance margins were
cached single-sample measurements and are not trusted or reused; aibrush-media re-measures fresh
(multi-sample) instead").

---

## 2. Spec & references

Performance measurement in the browser rests on four W3C timing/memory specs plus the WebCodecs
capability model; the OSS exemplar is the in-repo 7-engine harness, complemented by two canonical
JS micro-benchmark libraries for statistics discipline.

**Governing standards (every reference linked):**

- **W3C High Resolution Time, Level 3** — the monotonic `performance.now()` clock that every wall
  measurement snapshots. Requires monotonicity and sub-millisecond resolution (subject to
  cross-origin-isolation clamping). <https://www.w3.org/TR/hr-time-3/>
  Used at `../media-test/src/core/measure.ts:150-158` (`nowMs()` with a `Date.now()` fallback).
- **W3C Long Tasks API** — `PerformanceObserver({type:'longtask'})`; the 50 ms main-thread-block
  threshold is the spec definition, mirrored at `../media-test/src/core/measure.ts:31`.
  <https://w3c.github.io/longtasks/> (TR: <https://www.w3.org/TR/longtasks-1/>)
- **W3C Performance Timeline, Level 2** — `PerformanceObserver`, `buffered:true`, `takeRecords()`;
  the drain/detach lifecycle at `../media-test/src/core/measure.ts:106-147`.
  <https://www.w3.org/TR/performance-timeline/>
- **WICG Measure Memory API** — `performance.measureUserAgentSpecificMemory()`, the only
  cross-engine-correct heap probe; Chromium-only, needs cross-origin isolation, rate-limited to
  roughly one resolution per ~20 s (anti-fingerprinting). Fallback ladder at
  `../media-test/src/core/measure.ts:174-234`.
  <https://wicg.github.io/performance-measure-memory/> ·
  guide: <https://web.dev/articles/monitor-total-page-memory-usage>
- **W3C WebCodecs — `isConfigSupported`** — the capability model the router probes before any codec
  work; performance routing (WebCodecs → GPU → WASM) is decided by capability, never by a developer
  naming a backend. <https://www.w3.org/TR/webcodecs/#dom-videoencoder-isconfigsupported>
- **Node/Bun `process.memoryUsage().rss`** — the resident-set probe for the pure-TS/off-DOM bench
  scripts; `Bun.gc(true)` forces a baseline before sampling.
  <https://nodejs.org/api/process.html#processmemoryusagerss>

**OSS exemplar (primary):** the **7-engine benchmark harness** at `../media-test`, whose measurement
core this doc must match or beat:

- `../media-test/src/core/bench.ts` — the protocol: `bench()` (warmup-discard + measured iters),
  `summarize()` (median / p95 nearest-rank / MAD), `compareBench()` (direction-aware within-noise
  verdict), `combineMetricAcrossFiles()` (sum cost / max memory / median rate).
- `../media-test/src/core/measure.ts` — `Meter` (wall + long-tasks), bounded peak-memory probe,
  `CountingSource`/`CountingTarget` I/O attribution.
- `../media-test/src/core/report.ts` — correctness-gated, browser-grouped comparison; per-case winner
  (coverage-first, then metric); geomean perf index vs the winner.
- `../media-test/src/core/runner.ts` — `runBench()` (fresh input per iteration, one op → all metrics).
- Rival engines under test (the 7): `ffmpeg-wasm`, `mediabunny`, `mp4box`, `remotion`,
  `remotion-media-parser`, `remotion-webcodecs`, `web-demuxer`
  (`../media-test/src/engines/`), with `platform` as the golden/reference decoder and `aibrush-media`
  as the candidate.

**OSS exemplars (statistics discipline, to match/beat):**

- **mitata** — warmup + many samples + robust central tendency + GC-aware; a good bar for sample
  count and outlier handling. <https://github.com/evanwashere/mitata>
- **tinybench** — `tinylibs` micro-benchmark: warmup, iterations, statistical summary (mean/p75/p99).
  <https://github.com/tinylibs/tinybench>

---

## 3. Target design

### 3.1 The measurement contract (one protocol, one implementation)

Every performance number in the repo — pure-TS kernel (`bench-dsp`, `bench-image`, …) or in-browser
op (the harness `runBench`) — MUST be produced by the **same six-step protocol**. Today two
independent implementations exist (the harness `bench()`/`Meter` and ~87 copy-pasted node scripts);
the target is **one shared `bench/` module** they both call.

The protocol (canonical reference implementation: `scripts/bench-dsp.ts`):

1. **Fresh, real, multi-file input.** ≥ 5 real corpus files per op, never one, never synthetic
   (`scripts/bench-dsp.ts:296-305`). The in-browser harness rebuilds the input *per iteration* so
   caches and read counters are clean (`../media-test/src/core/runner.ts:1651-1657`).
2. **Warmup, discarded.** Prime JIT / caches / GPU / codec sessions with N unmeasured runs whose
   samples are thrown away (`scripts/bench-dsp.ts:57`, `../media-test/src/core/bench.ts:113-115`).
3. **Measured samples, multi-sample.** M timed iterations; each yields one sample
   (`scripts/bench-dsp.ts:59-64`, `../media-test/src/core/bench.ts:118-122`). Cached single-sample
   numbers are forbidden (measured-evidence.md_).
4. **Median + spread, never mean.** Report the **median** as the headline and **p95 (nearest-rank)**
   + **MAD** as spread (`../media-test/src/core/bench.ts:132-151`). Median resists the GC/scheduler
   outlier that a mean would bake in.
5. **Separate RSS pass.** Memory is measured in a **second pass** so sampling `rss` never perturbs the
   timed loop; baseline after a forced GC, peak-minus-baseline growth
   (`scripts/bench-dsp.ts:67-81`). In-browser: the bounded `measureUserAgentSpecificMemory` probe runs
   in `Meter.end()` *after* the wall snapshot (`../media-test/src/core/measure.ts:59-73`).
6. **Checksum sink + `--check` gate.** A live output value is folded into a `sink` every iteration so
   the optimizer cannot elide the work (`scripts/bench-dsp.ts:45,57,61,76,324`); a committed baseline
   plus a `--check` mode fails CI on a >50% aggregate-throughput regression
   (`scripts/bench-dsp.ts:43,278-292,326-336`).

**Physically-meaningful units, per family (never file-MB/s).** Throughput is reported in the unit that
maps to real work: **×realtime** for DSP/transcode (audio-seconds ÷ wall-seconds,
`scripts/bench-dsp.ts:107`), **MB/s** for byte-shovel ops (mux/remux/decrypt), **probes/sec** /
**packets/sec** / **plans/sec** for header/parse ops (measured-evidence.md_, doc `14-benchmarks`). File-MB/s is
banned because it is dishonest for a bounded header read that never touches the payload.

### 3.2 Data model

The sample and summary shapes are the harness's (single source of truth):

- **`MetricSample`** — one measured op's raw fields (`wallMs`, `peakMemoryBytes`, `throughputRealtime`,
  `decodeFps`/`encodeFps`, `opsPerSec`/`packetsPerSec`/`framesPerSec`, `seekMs`,
  `timeToFirstByteMs`/`timeToFirstFrameMs`, `bytesOut`, `sourceReads`/`targetWrites`, `longtaskMs`).
  Derivation from a `MeasureContext` at `../media-test/src/core/measure.ts:59-104`.
- **`BenchSummary`** — `{ n, warmup, metric, median, p95, mad, unit, samples, aggregate? }`
  (`../media-test/src/core/bench.ts:132-151`). `n` is the count of **admissible (finite)** samples,
  not the requested iteration count — a dropped `NaN`/null sample is honestly reflected.
- **Metric direction** is single-sourced: only `throughputRealtime`, `decodeFps`, `encodeFps`,
  `opsPerSec`, `packetsPerSec`, `framesPerSec` are higher-is-better; everything else (wall, memory, I/O
  counts, bytesOut, latency, longtasks) is lower-is-better
  (`../media-test/src/core/bench.ts:72-79`).
- **Cross-file aggregation is direction-aware and physical**: rates → **median**, `peakMemory` →
  **max** (worst peak, not a sum), additive cost (wall, I/O, bytes, latency) → **sum**
  (`../media-test/src/core/bench.ts:205-211`). Summing rates is meaningless; averaging a peak hides
  the worst case.

### 3.3 Seams (the layering the coder must preserve)

```
corpus (≥5 real files) ─▶ input builder (fresh per iter)
        │
        ▼
   op executor  ──▶ result { output? demux? frames? seek? }   ← the thing being measured
        │
        ▼
   Meter (wall + longtask)  ┊  RSS pass (separate)  ┊  checksum sink (anti-DCE)
        │
        ▼
   MetricSample × M  ─▶ summarize (median / p95 / MAD)  ─▶ BenchSummary
        │
        ▼
   correctness oracle (gate)  ─▶ report (browser-grouped, coverage-first winner, geomean index)
        │
        ▼
   baseline JSON  ◀─▶  --check (regression gate)  ┊  deficit tracker (24h freshness)
```

The **capability router is upstream of measurement and invisible to it**: the bench harness times
whatever the router picked (WebCodecs → GPU → WASM, miss-only), and never names a backend. A metric row
therefore compares *engines*, not *backends* — the backend is an implementation detail the number
already reflects. **Capability leak to guard against:** a bench script that special-cases a codec/backend
name (e.g. branching on "if wasm-av1") to fabricate a favorable path is a fake metric (§6.5).

### 3.4 Capability routing (WebCodecs → GPU → WASM, miss-only)

Performance routing is decided by `isConfigSupported` capability probing, not by the developer. The
router's **tier thresholds** (the only `src/*.ts` this shard references) decide when an input is "tiny"
enough to skip heavy setup:

- `TINY_INPUT_BYTES = 64·1024`, `TINY_VIDEO_PIXELS = 64·64`, `TINY_MEDIA_SECONDS = 1`,
  `TINY_AUDIO_FRAMES = 48_000`, and the compound `TINY_VIDEO_PIXEL_WORK = (64·64 + 64·64)·30`
  (`src/kernel/tier-thresholds.ts:26-33`).
- These scalars are **telemetry-seeded from committed fresh baselines**, with provenance kept out of
  the router's eager closure (`src/kernel/tier-thresholds-telemetry.ts:19-42`;
  `src/kernel/tier-thresholds.ts:35-41`).

**Methodology consequence:** because routing is capability-driven and WASM is downloaded **only on a
hardware miss**, a benchmark must warm the *actual chosen path* (step 2) or it will charge the
one-time WASM fetch/compile to the first measured sample. On a true miss the op fails loudly with a
typed `CapabilityError` and yields **no sample** (→ `N/A`), never a fabricated `0`.

### 3.5 Edge cases (each addressed explicitly)

- **B-frames.** *Applies indirectly.* Decode-reorder means fewer frames are emitted before `flush()`;
  a `decodeFps` measurement that stops early undercounts. The measured op MUST drain to flush and count
  actual emitted frames, and warmup MUST prime the reorder buffer so the first measured sample is not
  paying the reorder-window startup. (Reference: harness counts `opResult.frames.frames.length`,
  `../media-test/src/core/runner.ts:1677-1680`.)
- **VFR (variable frame rate).** *Applies, and is a live methodology bug (see delta #4).* For VFR,
  frame count ≠ `fps × duration`. The harness's `estimatedFrameCount` fallback multiplies golden
  `fps × durationSec` (`../media-test/src/core/runner.ts:1713-1719`) — **wrong for VFR**, inflating or
  deflating `framesPerSec`/`encodeFps`. `throughputRealtime` (mediaSec ÷ wall) stays correct because it
  uses duration, not frame count. Target: for VFR, use the *actual* processed-frame count, never the
  fps×duration estimate.
- **Seek.** *Applies.* `seekMs = wall / seeks` is a **mean per seek** over the window
  (`../media-test/src/core/measure.ts:98`). The keyframe index MUST be warmed (step 2) so the first
  seek isn't charged with index construction, and the seek set must be representative (not all to
  frame 0). Guard `seeks > 0` before dividing (already done, `measure.ts:98`).
- **Cancel.** *Mostly out of scope for the number; in scope as an inadmissibility rule.* A cancelled op
  produces **no admissible sample** — partial work returned fast is not a win. Cancel latency itself is
  a `robustness`/correctness concern (typed `aborted`), not a headline perf metric. A bench MUST NOT
  count a short-circuited/aborted run as a fast completion.
- **Frame lifetime (`close()` exactly once).** *Critical for the RSS pass.* Every `VideoFrame`/
  `AudioData` the measured op or the checksum sink touches MUST be `close()`d exactly once. Retained
  native surfaces inflate the process peak and corrupt the memory metric (measured-evidence.md_: retaining the
  complete public output kept 111 VFR / 182 B-frame native frames live and drove the large process
  peak, while the JS heap barely moved). The sink reads a *scalar* from the frame, then closes it — it
  never retains the frame to defeat DCE.
- **Backpressure.** *Applies.* The measured op MUST run to completion draining its sink; a benchmark
  that lets output buffer unboundedly reports fake throughput and a fake-low wall while the real cost
  is deferred. Streaming benchmarks measure the *drained* pipeline (WritableStream/callback), and the
  RSS pass catches unbounded buffering as a peak-memory blow-up rather than a throughput "win"
  (measured-evidence.md_: streaming MB/s numbers were the trusted freshly-measured, fully-drained ones).

---

## 4. Current state

**Two parallel measurement implementations exist; neither is shared, and the regression gate is not
wired in.**

**A. The in-browser harness (the exemplar, sibling repo — well-factored):**

- `../media-test/src/core/bench.ts` — clean, pure, single-source-of-truth protocol and statistics.
  `DEFAULT_BENCH = { warmup: 1, iters: 1, noiseBandPct: 3 }` (`bench.ts:25`) is honest but **thin**: a
  default of one warmup + one measured sample is barely "multi-sample" — it depends entirely on the
  caller (`runner`/CLI) raising `iters`. `MIN_NOISE_BAND_PCT = 3` floors every claim (`bench.ts:28`).
- `../media-test/src/core/measure.ts` — `Meter`, bounded peak-memory probe
  (`PEAK_MEMORY_TIMEOUT_MS = 1500`, `measure.ts:211`), longtask observer, I/O counters. The
  `measureUserAgentSpecificMemory` rate-limit workaround (`measure.ts:202-234`) is a real,
  well-documented browser quirk.
- `../media-test/src/core/report.ts` — correctness-gated, browser-grouped, coverage-first winner,
  geomean perf index (`report.ts:873-898`), verbatim caveats (`report.ts:287-294`).
- `../media-test/src/core/runner.ts` — `runBench` (`runner.ts:1637-1711`), one op → all metrics,
  fresh input per iteration, `DEFAULT_BENCH_TIMEOUT_MS = 300_000` (`runner.ts:672`).

**B. The in-repo pure-TS bench scripts (the smell — ~87 copies):**

- The canonical, best-documented one is `scripts/bench-dsp.ts`: `WARMUP = 20`, `ITERS = 200`
  (`bench-dsp.ts:40-41`), `REGRESSION_TOLERANCE = 0.5` (`bench-dsp.ts:43`), separate RSS pass with
  `Bun.gc(true)` (`bench-dsp.ts:67-81`), checksum sink (`bench-dsp.ts:45,57,61,76`), `--check` gate
  writing/comparing `fixtures/golden/bench/audio-dsp.json` (`bench-dsp.ts:308,326-340`).
- **God-of-copy-paste / massive duplication.** There are **87 `bench-*.ts` scripts**; **78** define
  their own `median()`, **30** re-implement `peakRss`, **32** re-declare a DCE `sink`, and only **25**
  implement a `--check` gate. There is **no shared bench harness module** in `scripts/` — every script
  re-derives the protocol, so warmup counts, iteration counts, tolerance, and units drift
  script-to-script (e.g. `bench-dsp` uses 20/200; `bench-session12-*` notes record 2–5 warmups /
  7–21 samples, measured-evidence.md_). This is the single biggest layering/DRY defect in the perf surface.
- **The regression gate is not enforced.** The `gate` npm script
  (`package.json:165`) runs typecheck, lint, the two generator tests, vitest+coverage, build,
  vendor-wasm, dist-smoke, `check-budgets`, `verify:package`, and `verify:integrity` (anti-cheat) — but
  runs **none of the 80 `bench-* --check` regression gates**. Perf regressions are caught only when a
  human runs the right script by hand, and 62 of 87 scripts have no `--check` at all.

**C. Supporting integrity & tracking (good, keep):**

- `scripts/anti-cheat.ts` — the §6.5 fake-metric gate: oracles must be able to fail; no
  input→output passthrough as work; no per-asset hardcoding; **no degenerate metrics** (a metric with
  no sample is `N/A`, and every committed bench-golden metric with a sample must be finite + physically
  plausible: no 0 peakMemory, no 0/∞/NaN/negative throughput) (`anti-cheat.ts:1-23`). Wired as
  `verify:integrity` (`package.json:164`).
- `docs/perf/gen-deficits.mjs` — the deficit worklist generator: compares only results from the **same
  export that selected the same rotated asset**, `DEFAULT_FRESH_HOURS = 24`, `MIN_SAMPLES = 5`
  (`gen-deficits.mjs:3-13`); has its own test (`package.json:67`).
- `scripts/check-budgets.ts` — bundle/packaging budgets (`KERNEL_BUDGET = 50 kB`,
  `TYPICAL_APP_BUDGET = 256 kB`, `check-budgets.ts:28-45`), the perf-adjacent `bundleSize`/`loadInit`
  contract.
- `src/kernel/tier-thresholds.ts` / `tier-thresholds-telemetry.ts` — telemetry-seeded routing
  thresholds (the only product code this shard references).

**Layering smells, named:**
1. **Duplicated protocol, no owner** — 78× `median`, 32× `sink`, 30× `peakRss`, no shared module (B).
2. **Regression gate exists but is unenforced** — `--check` not in `gate`; 62/87 scripts lack it (B).
3. **Thin default** — harness `DEFAULT_BENCH` is 1 warmup / 1 iter, one machine slip from single-sample
   (`bench.ts:25`).
4. **VFR frame-count estimate** — `fps × duration` fallback is wrong for VFR (`runner.ts:1713-1719`).
5. **Unit drift** — no enforced per-family unit contract; each script chooses (×realtime vs MB/s vs …).

---

## 5. Delta / punch-list (ordered, each with an acceptance test)

1. **Extract one shared `scripts/bench/harness.ts` (or `src/bench/`) and delete the 78 copies of
   `median`.** Export `timeNs(fn, {warmup, iters})`, `peakRssBytes(fn)`, `summarize()`
   (median/p95/MAD), a `sink` accumulator, and a `runCheckGate(baseline, fresh, tolerance)`.
   *Acceptance:* a test asserts `grep -c "function median" scripts/*.ts === 1` (the harness), and
   `bench-dsp`/`bench-image`/`bench-flac` import it; their emitted baseline JSON for a fixed fixture is
   **byte-identical** before and after the refactor (structural oracle on `fixtures/golden/bench/*.json`).

2. **Wire a single `bench:check` aggregate into `gate`.** Add `"bench:check"` that runs every script's
   `--check` and fails on the first regression; append it to `package.json:165`.
   *Acceptance:* introduce a deliberate 2× slowdown in one DSP kernel → `bun run gate` exits non-zero
   naming the regressed op; revert → green. A test asserts every `scripts/bench-*.ts` with a committed
   `fixtures/golden/bench/*.json` baseline is reachable from `bench:check`.

3. **Give every benchmark a `--check` gate + committed baseline (raise 25/87 → 87/87).** Any
   `bench-*.ts` without a baseline+`--check` is incomplete per Prime Directive #4.
   *Acceptance:* a meta-test enumerates `scripts/bench-*.ts` and fails for any that neither writes a
   `fixtures/golden/bench/*.json` baseline nor honors `--check` (mirror `bench-dsp.ts:308,326-340`).

4. **Fix the VFR frame-count metric.** Replace the `fps × duration` estimate
   (`../media-test/src/core/runner.ts:1713-1719`) with the **actual** processed-frame count for the
   op; only fall back to the estimate for CFR content where the golden marks constant rate.
   *Acceptance:* a VFR fixture (harvest: 111-frame VFR native decode) reports `framesPerSec` computed
   from 111, not from `fps × duration`; assert `|reported − 111/wallSec| < 1%` and that a CFR control is
   unchanged.

5. **Raise the honest multi-sample floor.** Change the effective run default so a real perf cell uses
   **≥ 5 measured samples after ≥ 1 warmup** (the deficit generator already requires `MIN_SAMPLES = 5`,
   `gen-deficits.mjs:13`); keep `DEFAULT_BENCH` for unit tests but make the CLI/runner default
   `warmup ≥ 3, iters ≥ 5` for scored runs.
   *Acceptance:* a scored `runBench` result carries `BenchSummary.n ≥ 5`; a run configured with
   `iters < 5` is rejected (or flagged non-scoring) by the report's admissibility check.

6. **Enforce a per-family unit contract.** Centralize the family→unit map (×realtime for DSP/transcode,
   MB/s for byte ops, probes/packets/plans-per-sec for parse) and forbid `file-MB/s`.
   *Acceptance:* a test asserts each family's emitted throughput unit matches the contract and that no
   script reports `file-MB/s`; a bounded probe (reads < 1% of the file) never reports a file-size-based
   throughput.

7. **Assert frame-lifetime hygiene inside the bench path.** The checksum sink must read a scalar and
   `close()` the frame exactly once; wrap the measured op so a leaked/double-closed frame fails.
   *Acceptance:* a counting `VideoFrame` double proves `close()` is called exactly once per decoded
   frame across a full bench run (0 leaks, 0 double-closes); the RSS pass over the same op shows JS-heap
   growth bounded (harvest baseline: 4.31 MB → 4.84 MB while 111 native frames were transiently live).

8. **Anti-DCE robustness: prove the sink actually blocks elision.** Add a test that mutates a kernel to
   a no-op and asserts the bench *throughput does not become implausibly infinite* (the sink forces the
   result to be observed).
   *Acceptance:* replacing a DSP op body with `return 0` makes the checksum change **and** trips a
   plausibility bound (throughput not > physical memory-bandwidth ceiling), matching
   `anti-cheat.ts:17-19` "no degenerate metrics".

9. **Bound and document the RSS pass on the browser side.** The `measureUserAgentSpecificMemory`
   rate-limit (~20 s) and the 1500 ms probe cap (`measure.ts:211`) mean peak-memory is frequently
   `null` in non-isolated realms; make "memory unavailable" a first-class, non-scoring state, never a 0.
   *Acceptance:* in a realm without cross-origin isolation, the memory metric is reported as
   unavailable (`null`), the cell still scores on wall/throughput, and no `0`-byte peak appears
   (mirror `measure.ts:196-234`).

10. **Freshness gate on scored numbers.** Reuse the deficit generator's 24 h window
    (`gen-deficits.mjs:12`) so a leaderboard claim built from a >24 h-old export is flagged stale, and
    forbid mixing corpus checksums (`report.ts:322-328`).
    *Acceptance:* feeding a >24 h export to the deficit/report path emits a "stale — re-measure fresh"
    caveat; merging two distinct `corpusChecksum`s emits the distinct-corpora caveat and blocks a
    cross-corpus comparison.

11. **Codify "no cancelled/aborted run as a sample."** The bench loop must discard a run that returned
    a typed `aborted`/`CapabilityError` rather than recording its (short) wall.
    *Acceptance:* an op forced to abort mid-run contributes **zero** samples to the summary (`n`
    unchanged), and the cell resolves to `N/A`/`FAIL`, never a fast wall.

---

## 6. Open questions (each seeds a decision record)

1. **Where does the shared harness live — `scripts/bench/` or `src/bench/`?** A `src/bench/` module
   ships in the package (usable by downstream apps) but must not bloat the eager kernel
   (`check-budgets.ts:28`, 50 kB); `scripts/bench/` keeps it dev-only. *Decide:* dev-only shared
   module, or a tree-shakeable public `aibrush-media/bench` entry. (Delta #1.)

2. **What is the scored `iters`/`warmup` floor, and is it per-family?** DSP uses 20/200
   (`bench-dsp.ts:40-41`); the deficit generator wants ≥5 samples (`gen-deficits.mjs:13`); the harness
   default is 1/1 (`bench.ts:25`). Micro-ops (plans/sec in the millions) want thousands of iters;
   multi-hour demux wants 5. *Decide:* a family-indexed `{warmup, iters}` policy table. (Delta #5.)

3. **Is the >50% `--check` tolerance right for every family?** `REGRESSION_TOLERANCE = 0.5`
   (`bench-dsp.ts:43`) absorbs machine variance but lets a 49% real regression through; codec-bound
   in-browser cells vary more than pure-TS. *Decide:* per-family tolerance, or a two-tier warn/fail.

4. **Peak-memory truth in the common (non-isolated) path.** `measureUserAgentSpecificMemory` needs
   cross-origin isolation, which the default build deliberately avoids (no COOP/COEP). Do we run a
   dedicated cross-origin-isolated memory pass, accept `null` on the common path, or add a Node/Bun RSS
   twin for every browser op? (`measure.ts:174-234`.) *Decide and record.*

5. **VFR frame-count source of truth.** Delta #4 needs an authoritative per-op processed-frame count;
   should that come from the op's own emitted-frame counter, or from a golden VFR frame table? *Decide.*

6. **Aggregate-win definition across the 7 engines.** Coverage-first then geomean-of-winner-ratios
   (`report.ts:622-723,873-898`) is the current ranking. Is "aggregate win" = most per-case wins, best
   geomean perf index, or highest conformance-then-coverage? The DoD says "aggregate win vs each of 7"
   — pin the exact scalar. *Decide and record as the canonical leaderboard rule.*

7. **UNVERIFIED: is there any browser-side equivalent of the pure-TS `--check` baseline gate?** The 25
   `--check` scripts are all Node/Bun pure-TS; I found no committed regression baseline for the
   in-browser `runBench` numbers (they live in rotating exports consumed by `gen-deficits.mjs`).
   *Open question:* should in-browser cells also carry a committed per-cell baseline, or is the 24 h
   fresh-export deficit tracker the intended (looser) browser-side gate?
