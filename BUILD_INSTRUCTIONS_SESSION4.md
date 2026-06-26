# BUILD_INSTRUCTIONS — Session 4 (close every remaining gap to the DoD WIN)

> Companion to `BUILD_INSTRUCTIONS.md` (the original; **§2 is the binding Definition of Done**),
> `BUILD_INSTRUCTIONS_SESSION2.md` / `BUILD_INSTRUCTIONS_SESSION3.md` (prior plans), `CLAUDE.md`, and
> `docs/architecture/`. **Read all of them first.** This file is the **remaining-work plan** for Session 4
> and describes the **WHAT** (the end-state each item must reach + how to know it's done). It deliberately
> does **not** prescribe the **HOW** — you (Claude Code) ULTRATHINK each step at max reasoning effort and
> choose the SOTA mechanism. The remaining work is **breadth (encoders + software-decode fallbacks),
> off-main-thread execution, validation debt, and the cross-browser aggregate WIN** — i.e. everything that
> still leaves us at **#2 behind mediabunny** instead of #1.

## 0. Operating mode (MANDATORY — every step)

- **ULTRATHINK before every step**, at maximum reasoning effort. Restate the goal in concrete terms;
  enumerate edge cases (B-frames, VFR, open-GOP, seek, cancel, frame lifetime, backpressure, truncated
  input, gapless/pre-skip, multi-channel, 10-bit/HDR); weigh ≥2 approaches; write a one-paragraph design
  note; **then** code. Never type code you haven't reasoned through.
- **Drive this with the Workflow tool — fan out parallel opus agents (MAX reasoning effort) as much as
  possible.** A workflow per group (§3); one agent per **strictly disjoint** codec/driver/feature/file set.
  Pattern: understand → fan-out implement (disjoint files) → **adversarially verify** (independent skeptic
  agents per finding: does it leak a `VideoFrame`/`AudioData`? wrong on B-frames/VFR/10-bit? pass a mutated
  golden? round-trip drift?) → integrate (the LEADER runs the authoritative full gate + harness serially
  and re-vendors). Each agent must ULTRATHINK, write a **failing strict-oracle test first** on **≥5 real
  downloaded files** (independent oracle — ffprobe / ffmpeg / sips / afinfo / a reference decoder — that
  **can fail**), implement to SOTA, pass it, add a fresh multi-sample benchmark, and **self-verify**
  (typecheck filtered to its files + `vitest run <its files>`) before returning a structured summary.
  **Never** run a heavy multi-agent workflow *concurrently* with a browser harness run — the browser
  starves and the run hangs (Session-2/3 lesson). Run agents, THEN the harness; or vice-versa. Keep agents
  **WARM** (reassign the next backlog item on finish; never cold-start while backlog remains).
- **NEVER STOP until §2 is 100% green.** Blocked → pick the SOTA option, record an ADR
  (`docs/architecture/02-decision-records.md`, next is **ADR-084+**), continue. **EVERY LINE SOTA** (strict
  TS, zero `any`/non-null `!`, typed errors, exhaustive, no dead code, every `VideoFrame`/`AudioData`
  closed once). **NO FEATURE WITHOUT TESTS** (real downloaded corpus + can-fail oracle + fresh benchmark;
  one-file green is a fail). **DOCS ARE LAW** (every change → doc + ADR same commit). **NEVER FAKE** (no
  hardcoded per-asset paths, no input→output passthrough, no oracle that can't fail, honest NA — never an
  N/A silently scored as 0/best).
- **NEVER run git** (the user commits). Keep `main` green at every step.

## 1. Where Session 3 left off (VERIFIED state, fresh five-axis audit 2026-06-26 — build on this, do NOT redo)

`main` is **GREEN**: typecheck 0, `biome ci` 0, the full Vitest suite passes, build ok, **coverage ≥ 90% on
all four metrics**, budgets met. The breadth already landed and validated (do NOT re-implement):

- **Containers (12): MP4/MOV, WebM/MKV, Ogg, WAV, ADTS, MP3, FLAC, MPEG-TS, HLS(demux), + bonus AIFF/CAF/AVI.**
  demux + probe everywhere; mux for MP4 (+ faststart + **fragmented/CMAF**, `fragment.ts`), WebM (one-shot),
  Ogg, MPEG-TS (PAT/PMT/PES/PCR), and PCM-output for WAV/AIFF/CAF. DTS packet-seam (`Packet{chunk,dtsUs?}`)
  is in place; cross-container remux works.
- **Ops:** `probe`, `decode`(+seek), `encode`, `demux`, `mux`, `remux`, `trim` (keyframe-copy + frame-accurate
  via the codec seam, ADR-082), `convert` (auto-route copy-vs-re-encode + filters), `decrypt` (CENC
  `cenc`/`cbcs` + HLS AES-128). Plus `from()`/`fromX`, all `to*` sinks (blob/file/stream/**StreamTarget**/
  **OPFS**), **`preload`** (ADR-083), and the **fluent chain** (`load()`/`MediaChain`, ADR-010).
- **Filters (real, not stubs):** resize, crop, rotate, flip; **full colorspace gamut matrices** (CIE
  primaries → bt709/bt601/bt2020/srgb) and **HDR→SDR tonemap** (Reinhard + Hable, peak-normalized); audio
  resample / remix (BS.775) / gain / fade (PCM path).
- **Codec DECODE that works today:** every codec via **WebCodecs** (H.264, HEVC, VP8, VP9, AV1; AAC, Opus,
  MP3, FLAC, Vorbis); **below WebCodecs**: AAC/MP3/Vorbis decode via real vendored Symphonia WASM cores,
  **FLAC decode pure-TS bit-exact**, PCM (all of s16/s24/f32 + u8/s8/s32/f64, LE+BE).
- **Harness:** `aibrush-media` is **registered and runs** in the 558-feature harness
  (`../media-test/media-browser-test/src/engines/aibrush-media/adapter.ts`, the harness's OWN live file).
  Latest chromium leaderboard: **#2 of 8, behind `mediabunny`, 0 wins / 0 losses / 13 family ties**, 414
  PASS vs mediabunny 510 / ffmpeg.wasm 486. **We do not yet win, and webkit/firefox have not been run.**

**The gap to #1 is COVERAGE (NA→PASS) + off-thread execution + validation depth.** Everything in §3 is
exactly what is still red. The compass for "what buys the most" is the NA bucket ranking from §3.A.

## 2. Definition of Done (unchanged — `BUILD_INSTRUCTIONS.md` §2)

Every box green: all ops + the full codec/container set with WebCodecs→GPU→WASM→TS routing and graceful
`CapabilityError` on real gaps; strict-oracle validation on **≥ 5 real downloaded diverse files per op**
(baked goldens, bit-exact in `force-software`); **aggregate benchmark WIN vs each of the 7 reference
engines**, fresh + multi-sample + **cross-browser (Chromium, WebKit, Firefox)**; typecheck / lint / format
/ **coverage ≥ 90% (all 4 metrics)** / cross-browser green; budgets met (eager kernel ≤ ~50 kB, app
~150–250 kB, WASM lazy + miss-only + same-origin, no COOP/COEP on the common path); ESM + `.d.ts` +
exports map + code-split verified; README quickstart + runnable examples; docs synced (change → doc + ADR
same commit); CI green. Never "mostly done"; never fake.

## 3. Remaining work — the WHAT (priority order; the path to #1 is COVERAGE first, then DEPTH)

### A. MEASURE FIRST — fresh chromium baseline + ranked NA buckets (the compass; do this before any build)

Re-vendor and run a full fresh **chromium** 558-run, then `bun scripts/aggregate.mjs`, and **rank every NA
bucket by family and by codec/container pair** (which `transcode`/`mux`/`decode-seek`/`remux` scenarios are
NA, and what capability each needs). **End-state:** a written, current scoreboard + a priority list of "the
N capabilities that flip the most NA→PASS." Drive §3.B–H in that empirical order — **measure, never guess**
which encoder/decoder buys the most. (Expectation from the audit: **encoders** dominate the chromium NA
bucket via `transcode`/`mux`; **software decoders** dominate the future webkit/firefox NA buckets.)

### B. Software ENCODERS — the single biggest coverage AND functional lever (each is strictly disjoint → fan out)

Today **every encoder below WebCodecs throws `CapabilityError`**, so we cannot author MP3/FLAC/Ogg/ADTS at
all, and lossy encode is bounded by the browser's `VideoEncoder`/`AudioEncoder` with **no software
fallback** — the largest hole in §2's "full codec set … with WebCodecs→GPU→WASM routing." For **each** codec
below: implement a real encoder, register it in `src/drivers/defaults.ts` (miss-only, lazy, self-hosted via
`import.meta.url`, no CDN, no COOP/COEP on the common path), advertise it in the adapter
(`containersOut` / `MUX_FAITHFUL_TARGETS` / encode capability) **only after** an oracle proves it, and
record the core's **source + version + license** as an ADR. **WHAT to reason about per encoder:** the exact
bitstream/framing the muxer expects (e.g. ADTS AU vs raw, Ogg granule/pre-skip, mp4 `esds`/`hvcC`/`av1C`),
sample-format/channel-layout negotiation, deterministic `force-software` output, and `close()`-once frame
lifetime. **End-state per codec:** encodes correctly (strict oracle: re-decode-and-compare for lossy via
`ssim-psnr` with `exactFrames>0`, or **bit-exact MD5** for lossless) on **≥ 5 real downloaded files**, plus
a fresh multi-sample benchmark, plus the corresponding `*_to_*` `transcode`/`mux` harness scenarios flip
NA→PASS.

1. **FLAC encode (pure-TS, do FIRST — highest ROI, no toolchain).** Lossless integer codec → a pure-TS
   encoder is bit-exact and ~kilobytes (mirror the existing pure-TS FLAC *decoder*). Unlocks authoring
   `.flac` and FLAC-in-Ogg, validated by STREAMINFO-MD5 round-trip. End-state: `flac-driver` `createMuxer`
   no longer throws; `decode(encode(pcm)) == pcm` bit-exact on the IETF FLAC corpus + ≥5 real files.
2. **MP3 encode** (LAME-class WASM core). Unlocks `.mp3` authoring (browsers cannot encode MP3 either).
3. **Opus encode** — the `wasm-opus` driver **already implements encode**; it only needs the **libopus core
   vendored + registered** in `defaults.ts` (today it is a core-less scaffold, `supports()→false`). Lowest
   effort of the WASM encoders.
4. **Vorbis encode** (libvorbis/`vorbis-rs`-class core). Unlocks Vorbis-in-Ogg authoring.
5. **AAC encode below WebCodecs** (no pure-Rust AAC encoder exists; choose a core via ADR — e.g. exhale /
   fdk — weighing license + patent posture). Falls back when `AudioEncoder` lacks AAC.
6. **VP8 / VP9 encode** (libvpx core). The `wasm-vpx` driver currently throws on encode and its core is a
   scaffold — vendor + register libvpx, implement encode.
7. **AV1 encode** (pure-Rust **rav1e**-class core is the SOTA fit for the Rust+wasm-bindgen toolchain;
   dav1d is decode-only by design). Falls back when `VideoEncoder` lacks AV1.

### C. Software DECODE fallbacks — the cross-browser coverage lever (flips webkit/firefox NAs)

Five codecs are **WebCodecs-only** today because their WASM tails are **inert scaffolds** (`.d.ts` only, not
vendored, not registered) — so they NA on any browser lacking the codec (e.g. **VP9 on much of WebKit**,
HEVC on Firefox/Chrome-without-hardware), the exact case the fallback exists for. **Vendor + register** the
real cores and prove decode bit-exactly (`decoded-frames-bitexact`, force-software) on ≥5 real files; then
advertise so the previously-NA scenarios flip to PASS:

8. **AV1 decode — dav1d** (`wasm-av1`, scaffold today).
9. **VP8/VP9 decode — libvpx** (`wasm-vpx`, scaffold today).
10. **Opus decode — libopus** (the `wasm-opus` driver's decode is written; vendor+register the core, see B.3).
11. **H.264 / HEVC software decode** (openh264 / libde265-class). **Decide scope via ADR-084+:** weigh the
    coverage win (HEVC on Firefox/no-hw Chrome) against bundle/toolchain cost and the §6 non-goal of chasing
    the exotic tail. If in-scope, miss-only + lazy like the rest; if deferred, record the honest NA and why.

### D. Missing filters & container features (real gaps the harness will reward)

12. **`pad` filter — entirely unimplemented** (absent from `FilterSpec`, `VideoTarget`, `MediaChain`, the
    `videoFilterSpecs` planner, and both GPU/CPU drivers). Implement GPU + CPU pad with a typed
    color/edge/aspect option; plumb it through the contract → public types → chain → planner → adapter.
    End-state: pad validated structurally (output dims + border pixels exact) on ≥5 files; pad harness
    scenarios flip to PASS.
13. **Fragmented / CMAF WebM mux** — `ebml-write.ts` throws `CapabilityError('fragmented/CMAF webm mux is
    not supported')`; §3 requires streaming output for **MP4 and WebM**. Implement fragmented WebM
    (Cluster-per-fragment + `StreamTarget`), validated by reference-reimport + incremental-write settle.
14. **Lossy-seam audio fade / dynamics / biquad** — these work only on the PCM path and throw a
    `CapabilityError` when the target is AAC/Opus (no stream-stateful `AudioData` filter exists yet).
    Implement a stream-stateful `AudioData` filter stage so fade/gain/dynamics apply across the codec seam.
    End-state: `convert` to a lossy target with `fade` produces audibly/structurally correct output
    (envelope verified on decoded PCM) on ≥5 files; the honest-miss `CapabilityError` is gone.
15. **(Pursue only if §3.A ranks them) AVI mux** (`avi-driver` throws "not yet implemented") and **HLS/ABR
    output** (segmenter + master/media playlist writer + variant ladder — today HLS is demux-input only).
    HLS-output/ABR ladders are the roadmap's Phase-4 ecosystem item; gate the effort on whether the NA
    bucket rewards it, and ADR the decision either way.

### E. Worker offload + ABR pool — the perf DoD ("no main-thread long tasks")

The worker layer (`WorkerStreamBridge`, `worker-entry`, `worker-protocol`) is **fully written and
unit-tested but NOT wired into production**: `core.ts` exports only the synchronous `InlineBridge`, tsup
builds no worker chunk, and the engine spawns no worker — so **heavy ops run on the main thread** and the
"no main-thread long tasks" box is unmet.

16. **Wire the worker into production.** Build a worker-entry chunk (tsup), spawn it via
    `new Worker(new URL('./worker-entry.js', import.meta.url), {type:'module'})`, route heavy
    decode/encode/filter ops through `WorkerStreamBridge` with the existing credit/backpressure/transfer
    protocol; keep `force-software` deterministic across the boundary. **End-state:** the harness
    `performance` family shows **`longtasks` ≈ 0** on the main thread for heavy ops, measured fresh.
17. **ABR worker POOL.** The bridge is single-job and literally errors "use a pool (one job at a time)" —
    build the pool that fans independent jobs/renditions across N workers, plus **ABR rendition fan-out**
    (one source → a ladder of encodes). End-state: a multi-rendition convert runs concurrently across the
    pool; backpressure + `close()`-once audited under fan-out; a benchmark shows the pool speedup.

### F. Validation depth — satisfy the strict-oracle DoD (not just "passes in the harness")

The pure-TS ops are well-validated, but the **browser/WebCodecs/GPU tier and several oracles are thin**:

18. **Bake the tier-1 goldens that don't exist yet:** `golden-packets` (exact demux packet bytes/sizes/
    keyframes), `decoded-frames-bitexact` (sha256 of decoded RGBA in `force-software`), **decrypt
    cleartext-twins generated by an INDEPENDENT tool** (not our own encryptor — that is a round-trip, not an
    oracle), and `reference-reimport` goldens. Commit them; gate on them.
19. **Exercise `force-software` bit-exact for real** (today it is only unit-mapped to `prefer-software`);
    raise **decrypt and trim diversity to ≥ 5 real files** (decrypt is 1–2 today; keyframe-trim is 3;
    accurate-trim is FakeFrame-only — add real-media trim).
20. **Run the conformance suite against REAL drivers** (today only the noop driver is conformance-checked):
    feed every mp4/webm/ogg/wav/adts/mpegts/flac + webcodecs-* driver through
    `assertCodecDriverConforms`/`assertContainerDriverConforms`/`assertFilterDriverConforms`.
21. **Add the missing metamorphic/property tests:** `decode(mux(x)) == decode(x)` frame-equality,
    **resize-idempotence**, and real-media **trim-additivity**; and **wire a standalone anti-cheat self-check
    suite into the gate** (mutation-test each oracle; assert no input→output passthrough scores as
    convert/remux/trim). End-state: every op gated on its **strongest** applicable oracle across ≥5 real
    files, with anti-cheat green — zero WEAK-GATE-only passes.

### G. Telemetry-seeded tier thresholds (ADR-020) + a real threaded core (ADR-006 effect)

22. **Tier thresholds are hard-coded constants** with provenance metadata attached, not derived from
    telemetry, and the telemetry module is imported only by its own test. **Derive** the thresholds from the
    recorded multi-sample bench telemetry (the cost-crossover where a cheaper tier wins for tiny inputs) and
    consume the derived values in `router.ts`. End-state: thresholds provably computed from telemetry, with
    a test that fails if the constants drift from the data.
23. **Isolation profile is resolvable but never exercised:** `wasmInitForProfile` returns the **baseline**
    asset for both `baseline` and `isolated-simd-threads`, so no core actually uses SIMD/threads. Ship a
    **threaded SIMD `.wasm`** for at least one heavy core under `crossOriginIsolated` and prove a measured
    speedup vs baseline (opt-in only; the common path stays COOP/COEP-free).

### H. Packaging, budgets & docs — the remaining §2 boxes

24. **Top-level `README.md` quickstart + a runnable `examples/` directory** (convert / trim / probe / mux —
    the common tasks). Neither exists today.
25. **Strengthen the budget/bundle assertions:** `check-budgets.ts` checks only the kernel ≤ 50 kB. Add the
    **app ~150–250 kB** budget, assert **WASM is lazy + miss-only + same-origin** (zero static `.wasm`
    imports on the eager path), add a **"probe-only app pulls ZERO wasm" test**, and a **code-split chunk-count
    assertion**. Wire `test:dist` into CI (today CI skips it).
26. **Wire benchmarks into the gate with regression `--check`** against committed baselines, and adopt the
    orphaned `bench-containers` / `bench-streaming` into `package.json`; add benchmarks for the families
    that have none (transcode/decode-seek/mux/decrypt/metadata) where Node-measurable, or measure them via
    the harness `performance` family. End-state: a bench regression fails the gate.

### I. THE WIN — measurement gate (the external judge; run AFTER B–H land, in this exact order) + docs/CI

27. **Re-vendor** (`bun run build && bun run vendor-wasm`, then **WIPE** stale `vendor/*.{js,d.ts,wasm}` and
    copy fresh `dist/*.{js,d.ts,wasm}`; verify every relative import in `vendor/*.js` resolves). **Full fresh
    chromium run** of all 13 families (clear `results/.browser-cache/chromium` first) → `bun
    scripts/aggregate.mjs` → target the **largest remaining NA buckets** (close NA = the win). Then **webkit
    + firefox** full runs. **Iterate B–H until the aggregate WIN vs each of the 7 engines holds on every
    browser**, on strict oracles, measured fresh; record per-family results. **This is the finish line of
    §2.** Every change → doc update + ADR (`02-decision-records.md`, **ADR-084+**); keep `README` current;
    final `biome ci` + full `vitest run --coverage` + CI green.

## 4. Mechanics (env + harness — exact; carried from Session 3, verified)

- **bun 1.3.14** (NOT npm/npx). Gate: `bun run typecheck` (3 tsconfigs), `bunx biome ci .`, `bunx vitest run
  --coverage` (≥ 90% all four metrics), `bun run build`, `bun run test:dist`, `bun run check-budgets`.
- **Re-vendor for the harness:** `bun run build && bun run vendor-wasm`; then **wipe** the old
  `vendor/*.{js,d.ts,wasm}` and copy fresh `dist/*.{js,d.ts,wasm}` to
  `../media-test/media-browser-test/src/engines/aibrush-media/vendor/` (stale hashed `defaults-*.js` /
  `chunk-*.js` from a prior build will otherwise linger; verify every relative import in `vendor/*.js`
  resolves). The **adapter** (`…/aibrush-media/adapter.ts`) is the harness's OWN live file — edits there are
  NOT vendored; the engine code IS vendored.
- **Run the harness:** `cd ../media-test/media-browser-test && rm -rf results/.browser-cache/<browser> &&
  bash scripts/run.sh --engine aibrush-media --browser <chromium|webkit|firefox> [--feature <family>]`.
  **Always clear the browser profile before each run** (stale-session bug). Results land in
  `results/raw/<browser>-*.json` (`status` ∈ PASS / FAIL / NA_ENGINE / NA_BROWSER; per-oracle detail in
  `oracleOutcomes`); score with `bun scripts/aggregate.mjs`. The 13 families: transcode, robustness, mux,
  probe, remux, demux, decode-seek, trim, audio-dsp, performance, streaming-output, metadata, encryption
  (558 total). `ffprobe` / `ffmpeg` / `afinfo` / `sips` + a reference decoder are available as independent
  oracles. **Playwright + chromium/webkit/firefox are installed.**
- **HANG hygiene:** if a run stalls (0 new results for minutes — check `results/raw/.partial/`), kill the
  tree (`pkill -f "run.sh --engine"; pkill -f launch.mjs; pkill -f serve.sh; pkill -f "Chrome for Testing"`)
  and take the partial. **NEVER run agent workflows during a harness run** (CPU starvation → stall);
  serialize: agents THEN harness, or harness THEN agents.
- **The adapter's `capabilities()` / `containersIn` / `containersOut` / `MUX_FAITHFUL_TARGETS` / `features`**
  gate what is attempted vs NA. Declaring a capability the engine genuinely does is a cheap coverage lever —
  but **never advertise unverified output** (honesty). Closing NA buckets (via real new encoders/decoders +
  honest capability declaration) is the dominant path from #2 → #1.
- **WASM cores:** prefer small, well-maintained, **permissive-licensed** per-codec cores (Rust+`wasm-bindgen`
  or Emscripten), self-hosted via `import.meta.url`, **lazy + miss-only**, no CDN, no COOP/COEP on the common
  path. Record each core's source/version/license as an ADR. Candidate SOTA picks (decide via ADR): FLAC
  encode = pure-TS; AV1 encode = rav1e; VP8/9 = libvpx; Opus = libopus; Vorbis = libvorbis; MP3 = LAME;
  AAC = exhale/fdk (weigh patent posture); AV1/VP9 decode = dav1d/libvpx; HEVC/H.264 decode = de265/openh264.
- **Real fixtures** under `fixtures/media/` + `fixtures/media-derived/` (with provenance: url + sha256 +
  license + traits via `scripts/fetch-fixtures.ts`). **Download more diverse files (≥ 5 / feature)** wherever
  a new encoder/decoder/filter demands it — never overfit to one file; the corpus only grows.

## 5. Definition of Done for Session 4

Run the full §2 checklist. The headline: **a fresh, multi-sample, cross-browser (chromium + webkit +
firefox) 558-feature run where `aibrush-media` WINS in aggregate vs each of the 7 reference engines** — i.e.
the leaderboard flips from "#2, 0 wins / 13 ties" to **#1 with net family wins** — with the full software
encode + decode-fallback matrix in place, heavy ops off the main thread (`longtasks ≈ 0`), every op gated on
its strongest oracle across ≥ 5 real files (force-software bit-exact), typecheck / lint / format / coverage
≥ 90% / budgets / CI all green, README + examples shipped, docs + ADRs (ADR-084+) in sync. Begin with §3.A
(measure the baseline, rank the NA buckets), then fan out §3.B (encoders) and §3.C (decode fallbacks) — the
two biggest coverage levers — across parallel opus agents, then §3.D–H, then iterate §3.I until every box is
green. Do not stop until the WIN holds on all three browsers.
