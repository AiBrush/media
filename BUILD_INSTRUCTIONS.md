# BUILD_INSTRUCTIONS.md — aibrush-media

This is the binding build contract. Read it with [`docs/architecture/README.md`](docs/architecture/README.md)
(the target spec) and [`.claude/CLAUDE.md`](.claude/CLAUDE.md) (the prime directives).

## 1. What we're building

A single **capability-routed in-browser media engine**: one flat API over `probe`, `demux`, `decode`/`seek`,
`transcode`, `mux`, `remux`, `trim`, `convert`, `audio-dsp`, `filters`, `encryption`, `metadata`, and
`streaming`, routing each stage to the best substrate (**hardware WebCodecs → GPU → pure-TS → WASM,
miss-only**) behind an API where the developer never names a backend. The full design lives in the shard docs
under `docs/`; this file governs *how we build to them*.

## 2. Definition of Done

A feature — and ultimately the engine — is **done** only when all of the following are green, measured fresh:

1. **Typecheck** — strict TypeScript, **zero `any`**, no unused exports, `noUncheckedIndexedAccess` clean.
2. **Lint** — no dead code, no leftover TODOs, no capability leak (a backend/codec named above the driver
   layer is a defect).
3. **Validation** — every feature has a **strict** oracle: bit-exact (checksum/MD5/byte-equal) or structural,
   on **real fixtures** plus **baked goldens**. Never a loose gate (duration-only, `SSIM exactFrames==0`,
   "didn't crash", or hardcoded per-asset shortcuts — these are the anti-cheat traps the decision log records).
   See [`docs/architecture/testing-and-validation.md`](docs/architecture/testing-and-validation.md).
4. **Benchmark** — a multi-sample, fresh benchmark exists (warmup + median + separate RSS pass + checksum
   sink + `--check` gate). See [`docs/operations/performance.md`](docs/operations/performance.md).
5. **Frame discipline** — every `VideoFrame`/`AudioData` is `close()`d exactly once (audited, not assumed).
6. **Packaging budgets** — eager kernel and first-op app bundle stay within their ceilings
   ([`docs/architecture/packaging-and-loading.md`](docs/architecture/packaging-and-loading.md)); heavy WASM
   loads only on a hardware miss.
7. **Acceptance** — registered in the benchmark harness (§4) and **winning in aggregate vs the 7 engines** on
   strict oracles.
8. **Docs are law** — the shard doc for the touched family matches reality; any forced change updates the doc
   **and** logs a decision in [`docs/decisions/README.md`](docs/decisions/README.md) in the same commit.

**Tier-split honesty (from the decision log):** the CI sandbox is Node-only. The pure-TS tier is fully
Node-validated in CI; the WebCodecs/GPU/WASM tier is browser-validated on a target machine. Label every result
by tier and **never fabricate** a browser/WASM number to force green — raise a typed `CapabilityError` until
the real substrate runs.

## 3. The per-feature loop

For every feature, in order:

1. **ULTRATHINK** — restate the goal; enumerate edge cases (B-frames, VFR, seek, cancel, frame lifetime,
   backpressure); write a one-paragraph design note grounded in the family's shard doc.
2. **Write the failing validation test** (the strict oracle) first.
3. **Implement to SOTA** against the shard-doc target design and its delta/punch-list.
4. **Pass the test.**
5. **Add the benchmark.**
6. **Run the full gate** (typecheck, lint, test, bench).
7. **Green commit** — `main` stays green at every commit.

Blocked mid-feature? Choose the SOTA option, **log the decision**, and continue — do not stall and do not ask
permission between steps.

## 4. The acceptance harness

The benchmark/acceptance harness is the sibling project [`../media-test`](../media-test). It defines **13
scenario families** — `audio-dsp, decode-seek, demux, encryption, metadata, mux, performance, probe, remux,
robustness, streaming-output, transcode, trim` (in `../media-test/src/scenarios/`) — and adapters for **7
engines**: `aibrush-media`, `mediabunny`, `ffmpeg-wasm`, `mp4box`, `web-demuxer`, `remotion-webcodecs`,
`remotion-media-parser`, `platform` (in `../media-test/src/engines/`). The suite is versioned and may add
cells, so completion always uses its **current full suite**, not a historical count. Run it per its own
`README.md`; oracles live in `../media-test/src/core/oracles.ts`.

## 5. Working the codebase

- Work the family shard docs; each carries an **ordered delta/punch-list** with an acceptance test per item —
  that is the implementation backlog. All 334 items are consolidated, with cross-cutting themes and priorities,
  in [`REQUIREMENTS.md`](REQUIREMENTS.md) — start there.
- Keep the layering: **Public API → Kernel (Normalizer→Planner→Router→Executor→Worker-bridge+Registry) →
  Drivers → Substrates.** No backend name leaks upward; the router alone chooses.
- The known structural debt to burn down (from the shard deltas): the god-files
  (`src/drivers/mp4/mp4-driver.ts`, `src/api/codec-pipeline.ts`, `src/api/engine.ts`), module-global mutable
  caches, capability leaks in the API layer, and any frame not `close()`d exactly once.

**Default action: continue the build until the Definition of Done is 100% green. Do not stop early.**
