# CLAUDE.md — aibrush-media

You are building **aibrush-media**, a unified, capability-routed, in-browser media engine.

**Before doing anything, read [`BUILD_INSTRUCTIONS.md`](../BUILD_INSTRUCTIONS.md) and
[`docs/architecture/README.md`](../docs/architecture/README.md). They are binding.** The architecture docs
are the **target spec**; the decision log in [`docs/decisions/`](../docs/decisions/README.md) is the single
source of truth for locked decisions.

## Prime Directives (non-negotiable, every session)

1. **ULTRATHINK before every step.** Max reasoning effort. Restate the goal, enumerate the edge cases
   (**B-frames, VFR, seek, cancel, frame lifetime, backpressure**), weigh alternatives, write a one-paragraph
   design note, *then* code. Never type code you haven't reasoned through.
2. **NEVER STOP until done.** Don't ask permission between steps/phases — proceed. Drive each phase to an
   all-green gate and keep going. Blocked? Choose the SOTA option, **log a decision** in
   [`docs/decisions/README.md`](../docs/decisions/README.md), continue. The only stopping point is the
   Definition of Done in `BUILD_INSTRUCTIONS.md`.
3. **EVERY LINE IS SOTA.** Strict TypeScript, **zero `any`**, exhaustive types, typed errors only, no dead
   code, no leftover TODOs. Every `VideoFrame`/`AudioData` is `close()`d **exactly once**. If a line isn't
   best-in-class, rewrite it.
4. **NO FEATURE WITHOUT TESTS.** Each feature ships with **validation** (strict bit-exact/structural oracle
   on real fixtures + baked goldens — never a loose gate) **and a benchmark** (multi-sample, fresh). Code
   that isn't validated *and* benchmarked is not done and never goes to `main`.
5. **DOCS ARE LAW.** Conform exactly to the target spec in `docs/architecture/`, `docs/operations/`,
   `docs/drivers/`, `docs/codecs/`. If reality forces a change, update the doc **and** log the decision in
   the same commit.
6. **NEVER FAKE.** No hardcoded per-asset paths, no input→output passthrough as "work", no oracle that can't
   fail, no N/A→0 metric. Genuinely do the work or raise a typed `CapabilityError`.

## Operating rules

- **Capability ladder:** hardware **WebCodecs → GPU → pure-TS `native` → WASM (miss-only)**. Containers are
  hand-written TypeScript. The developer never names a backend; a true miss throws a typed `CapabilityError`
  naming what was tried. See [`docs/architecture/capability-router.md`](../docs/architecture/capability-router.md).
- **Deployable by default:** no COOP/COEP on the common path; WASM is self-hosted via `import.meta.url`
  (no CDN), downloaded only on a hardware miss. SIMD/threads (SharedArrayBuffer) are opt-in behind
  `crossOriginIsolated`.
- **Pay for what you use:** a tiny eager kernel; per-op/per-driver `import()`. Respect the packaging budgets
  in [`docs/architecture/packaging-and-loading.md`](../docs/architecture/packaging-and-loading.md).
- **Tier-split validation (see the decision log):** the CI/build sandbox is Node-only (no browser
  WebCodecs/WebGPU, no C→WASM toolchain). The pure-TS tier is validated exhaustively in Node; the
  WebCodecs/GPU tier and the full benchmark run on a target machine with a browser. Fabricating browser/WASM
  results to force green is forbidden — report a typed `CapabilityError` until the real substrate runs.
- **Keep `main` green:** every commit compiles, lints, and passes tests.
- Per feature: **ultrathink → write the failing validation test → implement to SOTA → pass it → add the
  benchmark → run the full gate (typecheck, lint, test, bench) → green commit.**

## Acceptance

Register in the benchmark harness at [`../media-test`](../../media-test) (13 scenario families across the 7
engines: mediabunny, ffmpeg.wasm, mp4box, web-demuxer, remotion-webcodecs, remotion-media-parser, platform)
and **win in aggregate**, on strict oracles, measured fresh. See
[`docs/operations/performance.md`](../docs/operations/performance.md) for the measurement methodology and
[`docs/architecture/testing-and-validation.md`](../docs/architecture/testing-and-validation.md) for the
oracle strategy.

**Default action when working in this repo: continue the build per `BUILD_INSTRUCTIONS.md` until the
Definition of Done is 100% green. Do not stop early.**
