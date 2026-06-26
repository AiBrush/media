# AGENTS.md — aibrush-media

You are building **aibrush-media**, a unified, capability-routed, in-browser media engine, from 0 → 100%.

**Before doing anything, read [`BUILD_INSTRUCTIONS3.md`](BUILD_INSTRUCTIONS3.md) and [`docs/architecture/`](docs/architecture/README.md). They are binding.**

## Prime Directives (non-negotiable, every session)

1. **ULTRATHINK before every step.** Max reasoning effort. Restate the goal, enumerate edge cases (B-frames, VFR, seek, cancel, frame lifetime, backpressure), weigh alternatives, write a one-paragraph design note, *then* code. Never type code you haven't reasoned through.
2. **NEVER STOP until done.** Don't ask permission between steps/phases — proceed. Drive each phase to an all-green gate and keep going. Blocked? Choose the SOTA option, record an ADR in `docs/architecture/02-decision-records.md`, continue. The only stopping point is the Definition of Done in `BUILD_INSTRUCTIONS3.md` §2.
3. **EVERY LINE IS SOTA.** Strict TypeScript, **zero `any`**, exhaustive types, typed errors only, no dead code, no leftover TODOs. Every `VideoFrame`/`AudioData` is `close()`d exactly once. If a line isn't best-in-class, rewrite it.
4. **NO FEATURE WITHOUT TESTS.** Each feature ships with **validation** (strict bit-exact/structural oracle on real fixtures + baked goldens — never a loose gate) **and a benchmark** (multi-sample, fresh). Code that isn't validated *and* benchmarked is not done and never goes to `main`.
5. **DOCS ARE LAW.** Conform exactly to `docs/architecture/`. If reality forces a change, update the doc **and** add an ADR in the same commit.
6. **NEVER FAKE.** No hardcoded per-asset paths, no input→output passthrough as "work", no oracle that can't fail, no N/A→0 metric. Genuinely do the work or raise a typed `CapabilityError`.

## Operating rules

- Work the phases in `BUILD_INSTRUCTIONS3.md` §8 in order; track with the task tools; keep `main` green (every commit compiles, lints, passes tests).
- Per feature: ultrathink → write the failing validation test → implement to SOTA → pass it → add the benchmark → run the full gate (typecheck, lint, test, bench) → green commit.
- Prefer **hardware WebCodecs → GPU → WASM (miss-only)**; containers in TS; self-hosted wasm via `import.meta.url` (no CDN); no COOP/COEP on the common path.
- Acceptance: register in the 558-feature benchmark harness (`../media-test/media-browser-test`) and **win in aggregate vs all 7 engines**, on strict oracles, measured fresh.

**Default action when working in this repo: continue the build per `BUILD_INSTRUCTIONS3.md` until the Definition of Done is 100% green. Do not stop early.**
