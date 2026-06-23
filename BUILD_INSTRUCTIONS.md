# BUILD INSTRUCTIONS — aibrush-media (0 → 100%)

> **Audience:** Claude Code, building this framework end to end.
> **Mission:** implement `aibrush-media` — a unified, capability-routed, in-browser media engine — from an empty repo to a **production-grade, fully tested, fully benchmarked, state-of-the-art** library that conforms exactly to [`docs/architecture/`](docs/architecture/README.md) and **wins the 558-feature benchmark in aggregate** against all 7 reference engines.
> **How to use:** run at **maximum reasoning effort**. Read this file fully, then [`docs/architecture/`](docs/architecture/README.md), then execute §8 phase by phase without stopping until §2 (Definition of Done) is 100% met.

---

## 0. PRIME DIRECTIVES (non-negotiable — these override everything)

These are hard constraints. Violating any one means the work is not acceptable.

1. **ULTRATHINK BEFORE EVERY STEP.** Before writing any module, test, or decision: restate the goal in concrete terms, enumerate the edge cases, weigh at least two approaches, choose the SOTA one, and write a one-paragraph design note (§4). Think hardest about **correctness** and **frame/memory lifetime**. Never type code you have not reasoned through.
2. **NEVER STOP UNTIL DONE.** Do not pause for permission between steps or phases. Drive each phase to **all-green exit criteria** before moving on, and keep going. If blocked by a genuinely missing decision, pick the SOTA option, record it as an ADR in [`docs/architecture/02-decision-records.md`](docs/architecture/02-decision-records.md), and continue. The **only** acceptable stopping point is §2 fully satisfied. (See §13.)
3. **EVERY SINGLE LINE IS SOTA.** Modern, idiomatic, strict TypeScript; zero `any`; zero dead code; zero `TODO`-and-move-on; exhaustive types; correct error handling; performance-aware; documented public surface. If a line is not best-in-class, rewrite it. (See §5.)
4. **NO FEATURE EXISTS WITHOUT TESTS — ON REAL, DOWNLOADED MEDIA.** Every feature ships with **(a) validation tests** against the strict oracle ladder (bit-exact / structural — never a loose gate) **and (b) a benchmark** (multi-sample), both run on a **diverse corpus of real video/audio files downloaded from the internet — never mock/synthetic, never a single file** (§6.1). Code without passing validation + a recorded benchmark is **not done** and must not be committed to `main`. (See §6.)
5. **THE ARCHITECTURE DOCS ARE LAW.** [`docs/architecture/`](docs/architecture/README.md) is the binding spec. Implement exactly the public API ([`07`](docs/architecture/07-public-api.md)), contracts ([`05`](docs/architecture/05-driver-contracts.md)), ladders ([`04`](docs/architecture/04-capability-router-and-ladder.md)), and per-op design ([`09`](docs/architecture/09-operations.md)). If reality forces a change, change the doc **and** add an ADR in the **same commit** — never silently diverge.
6. **INTEGRITY — NEVER FAKE.** No hardcoded per-asset paths, no input→output passthrough masquerading as work, no oracle that cannot fail, no metric that is silently N/A→0. The benchmark caught 3 such shortcuts (see [`background/benchmark-summary.md`](docs/architecture/background/benchmark-summary.md)); produce **zero**. Every implementation genuinely does the work or raises a typed `CapabilityError`.

---

## 1. SOURCE OF TRUTH & REFERENCE MAP

Read these before coding; consult them per concern. **Do not re-derive what they already specify.**

| Concern | Spec |
|---|---|
| Why this design / evidence | [`docs/architecture/background/benchmark-summary.md`](docs/architecture/background/benchmark-summary.md) |
| Scope, op set, quality bars, non-goals | [`01-goals-and-requirements.md`](docs/architecture/01-goals-and-requirements.md) |
| All decisions (ADRs) | [`02-decision-records.md`](docs/architecture/02-decision-records.md) |
| Structure / layers / seams | [`03-system-architecture.md`](docs/architecture/03-system-architecture.md) |
| Router & ladders | [`04-capability-router-and-ladder.md`](docs/architecture/04-capability-router-and-ladder.md) |
| Driver contracts (canonical TS) | [`05-driver-contracts.md`](docs/architecture/05-driver-contracts.md) |
| Execution / runtime / frame lifetime | [`06-execution-and-runtime.md`](docs/architecture/06-execution-and-runtime.md) |
| Public API | [`07-public-api.md`](docs/architecture/07-public-api.md) |
| Packaging / loading / wasm | [`08-packaging-and-loading.md`](docs/architecture/08-packaging-and-loading.md) |
| Per-operation design | [`09-operations.md`](docs/architecture/09-operations.md) |
| Browser capability + gaps | [`10-browser-capability-matrix.md`](docs/architecture/10-browser-capability-matrix.md) |
| Testing & validation | [`11-testing-and-validation.md`](docs/architecture/11-testing-and-validation.md) |
| Roadmap / phases | [`12-roadmap.md`](docs/architecture/12-roadmap.md) |
| Glossary | [`13-glossary.md`](docs/architecture/13-glossary.md) |

**Acceptance battery:** the 558-feature benchmark harness in `../media-test/media-browser-test` (sibling project). Register `aibrush-media` as an engine and run it. It is the external judge of "did we build the best-of-the-best."

---

## 2. DEFINITION OF DONE (0 → 100%)

The build is **100% done** only when **every** box is checkable and green. This is the finish line; do not stop before it.

- [ ] Every public op in [`07`](docs/architecture/07-public-api.md) is implemented per [`09`](docs/architecture/09-operations.md): `probe, convert(=transcode), remux, trim, mux, demux, decode, encode, decrypt` — plus `from()`/`fromX`, `to*` sinks, `preload`.
- [ ] The full container set (MP4/MOV, WebM/MKV, Ogg, WAV, ADTS, MP3, MPEG-TS+HLS) and codec set (H.264, HEVC, VP8, VP9, AV1; AAC, Opus, MP3, FLAC, Vorbis, PCM) work, with WebCodecs→GPU→WASM routing and graceful `CapabilityError` on real gaps.
- [ ] **Validation:** every op passes its strict oracle ([`11`](docs/architecture/11-testing-and-validation.md)) across the **diverse, internet-sourced real-media corpus** (§6.1; ≥ 5 files/op, never mock, never a single file) with baked goldens, bit-exact in `force-software`. **Zero** WEAK-GATE-only passes; **zero** SUSPECT shortcuts (anti-cheat self-checks green).
- [ ] **Benchmark:** `aibrush-media` registered in the 558-feature harness, run fresh (multi-sample), and **wins in aggregate vs each of the 7 reference engines**; per-family results recorded; no regressions vs the recorded baseline.
- [ ] **Quality gates:** `typecheck` (strict, 0 errors, 0 `any`), `lint` (0 errors/warnings), `format` clean, **test coverage ≥ 90%** lines/branches on core + drivers, all unit/contract/integration/property/robustness tests green.
- [ ] **Cross-browser:** correctness + smoke pass in real Chromium, WebKit, Firefox (Playwright).
- [ ] **Budgets:** eager kernel ≤ ~50 kB; typical app eager JS ~150–250 kB; WASM is lazy + miss-only + same-origin (verified by a bundle-analysis test). No COOP/COEP required on the common path.
- [ ] **Packaging:** ships ESM + `.d.ts`; `exports` map + code-split chunks verified; `import.meta.url` wasm assets emitted same-origin; a probe-only app pulls zero wasm (asserted).
- [ ] **Docs in sync:** any divergence reconciled into `docs/architecture/` + ADRs; `README` quickstart + runnable examples for the common tasks.
- [ ] **CI green** on every gate above.

If any box is unchecked, you are not done. Return to §8 and finish it.

---

## 3. HOW TO WORK (the operating loop)

1. **Set max effort.** Begin every build session at maximum reasoning effort.
2. **Track with tasks.** Use the task tools to create one task per phase and one per feature/driver; mark `in_progress`/`completed` as you go. Keep the list authoritative.
3. **Work the phases in order** (§8). Within a phase, drive every task to green before the phase gate.
4. **Per-feature TDD loop (mandatory):**
   a. **Ultrathink** the feature (§4) — design note first.
   b. Write the **validation test** (against the strict oracle + real fixture + baked golden) — it must fail first.
   c. Implement the feature to SOTA (§5).
   d. Make the validation test pass; add the **benchmark** (multi-sample) and record numbers.
   e. Run the full gate (typecheck, lint, test, bench, affected harness families). All green.
   f. **Green commit** (small, focused, conventional message). Never commit red.
5. **Keep `main` green at all times.** Every commit compiles, lints, and passes tests. Use feature branches/worktrees for risky work; merge only when green.
6. **Re-run the benchmark harness** at each phase gate; never trust the *old cached* benchmark numbers — measure ours fresh, multi-sample.
7. **Orchestrate where it helps** (§10): fan out independent drivers/test-families with the Workflow tool; keep the kernel and shared seams sequential.

---

## 4. THE ULTRATHINK PROTOCOL (concrete)

Before implementing any module/driver/op, write a short **design note** (in the PR description or `docs/notes/<feature>.md`):

- **Goal** — restated in concrete terms (inputs, outputs, the exact seam types).
- **Approach** — the chosen mechanism + one rejected alternative and why.
- **Edge cases** — enumerate them (B-frames, VFR, open-GOP, truncated/garbled input, tiny/huge dims, frame lifetime, backpressure, cancellation).
- **Failure modes** — what raises which typed error; what must never silently degrade.
- **Test plan** — the strict oracle to gate on, the **§6.1 real-media corpus files** (multiple, diverse) + goldens, the benchmark metric.

Then implement. For every non-trivial line, ask: *is this correct under reorder/seek/cancel? does it leak a `VideoFrame`/`AudioData`? is there a faster SOTA way?* If unsure, reason it out before typing.

---

## 5. SOTA CODE STANDARDS (every line)

- **TypeScript strict**: `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. **No `any`** (use `unknown` + narrowing). No non-null `!` without a proven invariant. Exhaustive `switch` with `never` defaults.
- **Public API** exactly matches [`07`](docs/architecture/07-public-api.md); fully typed; every exported symbol has a TSDoc comment. Options are flat typed objects (ADR-011).
- **Errors**: only the typed `MediaError`/`CapabilityError`/`InputError` model ([`05`](docs/architecture/05-driver-contracts.md)). Never throw strings, never swallow errors, never `catch` and continue silently.
- **Frame & memory discipline** ([`06`](docs/architecture/06-execution-and-runtime.md) §3): every `VideoFrame`/`AudioData`/`ImageBitmap` is `close()`d exactly once by its last consumer; honor backpressure; release WASM/WebCodecs resources on cancel/abort. Treat a leak as a build-breaking bug.
- **Streaming first**: pipelines are composed `TransformStream`s; never fully buffer a file that can stream.
- **No dead code, no TODOs left behind, no commented-out code, no console spam.** Logging goes through the `onLog` hook.
- **Determinism**: code paths must support `force-software` reproducibly (ADR-007).
- **Lint/format**: zero warnings; a single formatter; consistent naming (`camelCase` API, `PascalCase` types, files kebab-case).
- **Small modules**: one driver = one file; the kernel stays tiny (budget in §2). Dynamic-import specifiers are always string literals (so bundlers code-split — [`08`](docs/architecture/08-packaging-and-loading.md)).
- **Comments** explain *why*, not *what*; match the density of surrounding code.

---

## 6. TEST & BENCHMARK MANDATE (the heart of this build)

> Tests are not an afterthought — they are how we *know* the framework is SOTA. **A feature is "done" only when it is validated AND benchmarked.**

### 6.1 The test media corpus — REAL media, downloaded, diverse (never mock)

- **Real files only, fetched from the internet.** The subject media for every validation and benchmark test is a **real video/audio file downloaded from a public source** — never synthetic, mock, hand-crafted, or a single canned asset. Download **many**.
- **Diversity is mandatory (no overfitting to one file).** Each oracle/op runs across **a set of ≥ 5 distinct real files** covering the relevant traits. The corpus spans, at minimum:
  - *containers:* MP4/MOV, WebM/MKV, Ogg, WAV, MP3, FLAC, ADTS/AAC, MPEG-TS/HLS;
  - *video:* H.264 (baseline/main/high; with & without B-frames; open-GOP), HEVC (8/10-bit), VP8, VP9 (+ alpha), AV1;
  - *audio:* AAC, Opus, MP3, FLAC, Vorbis, PCM (s16/s24/f32, LE/BE);
  - *resolutions:* 1×1/tiny, 360p, 720p, 1080p, 4K; *fps:* 1, 24, 25, 30, 60, 240, and VFR;
  - *durations:* sub-second, seconds, minutes, and ≥ one long (≥ 10 min) for streaming/memory;
  - *traits:* rotation metadata, multitrack, HDR, alpha, gapless audio, faststart vs not, fragmented/CMAF, headerless recorder output, CENC/HLS-encrypted samples.
- **Sourcing & licensing:** use openly-licensed / public-domain / official sample media and standards-body test vectors. Record each file's **source URL, license, and `sha256`**. Never download content you lack the rights to.
- **Reproducible, not flaky.** A one-time `scripts/fetch-fixtures.ts` downloads the pinned URLs, **verifies `sha256`**, and caches them under `fixtures/media/` (git-ignored; cached in CI). Tests **never touch the network at run time** — they read the verified local cache; a missing/mismatched file **fails setup loudly**. Commit only `fixtures/manifest.json` (url + sha256 + license + traits) and the small **baked goldens**, not the large media.
- **Goldens are derived from the verified corpus:** frame sha256 digests, golden packet manifests, golden metadata, cleartext twins for decrypt — baked once (in `force-software` where determinism is required), checksum-pinned, committed.
- **The corpus only grows.** When a bug is found, add the real file that exposed it (+ a manifest entry); a new codec/trait requires new real files **before** the feature is "done."

### 6.2 Validation (correctness)

- Gate on the **strongest applicable oracle** ([`11`](docs/architecture/11-testing-and-validation.md) §1): bit-exact / cryptographic > structural / metadata-exact > perceptual (`ssim-psnr` only with `exactFrames>0`) > smoke (necessary, never sufficient). **Never** accept a WEAK-GATE-only pass.
- Gate against **goldens baked from the §6.1 corpus**; **no synthetic/mock subject media, ever**. Each oracle runs across the **diverse multi-file matrix** (≥ 5 real files of the relevant traits) — a pass that holds for only one file is a **fail** (overfitting).
- Run bit-exact gates in **`force-software`** for cross-machine reproducibility; hardware paths are tolerance-banded + `playback-smoke`.
- **Contract conformance harness**: every driver of a kind passes the *same* suite, so all codec/container/filter drivers meet identical seam/lifecycle/error behavior.
- **Property / metamorphic tests**: `decode(mux(x))==decode(x)`, duration preserved across containers, resize-idempotence, trim additivity, double-remux stability.
- **Robustness/fuzz**: garbled/truncated/zeroed/bitflipped/empty inputs reject cleanly — **no crash, no wrong output**.

### 6.3 Benchmark (performance)

- Every op has a **multi-sample** benchmark (`n>1`, warmup): `wall`, `throughputRealtime`, `peakMemory`, `longtasks`, decode/encode fps as relevant — **measured across several real §6.1 corpus files, not one**. Record results; gate against a baseline to catch regressions.
- **Re-measure fresh** — never reuse the original benchmark's cached, single-sample numbers (they are not ours; [`background/benchmark-summary.md`](docs/architecture/background/benchmark-summary.md) Finding 7).
- Verify the architecture's perf claims hold (hardware WebCodecs ≫ single-thread wasm; worker keeps `longtasks` near zero on the main thread).

### 6.4 Acceptance against the 558-feature harness

- Register `aibrush-media` in `../media-test/media-browser-test`, run all 13 families, and **win in aggregate** vs each of the 7 engines. Record per-family wins. This is the headline acceptance gate at each phase and at DoD.

### 6.5 Anti-cheat self-checks (CI gates on *our* code)

- Mutation-test each oracle (feed wrong output → it must reject).
- Assert no input→output passthrough passes as `convert`/`remux`/`trim`.
- Run every test across the **§6.1 multi-file corpus matrix** (a path that works for only one file id **fails** — that is overfitting, not a feature).
- Missing perf samples are **N/A**, never `0`/best.

### 6.6 Tooling

- **Unit/integration:** Vitest (or equivalent SOTA) for logic; **real-browser** correctness via Playwright (Chromium/WebKit/Firefox) since WebCodecs/GPU cannot be mocked.
- **Coverage ≥ 90%** lines/branches on core + drivers, enforced in CI.
- **CI** runs typecheck, lint, format-check, unit, browser, benchmark (with thresholds), and bundle-budget checks on every push.

---

## 7. TECH STACK & TOOLING (decide; do not dither)

Use these unless a clearly superior SOTA option exists — if you change one, record an ADR.

- **Language/build:** TypeScript (strict) → ESM + `.d.ts`. Bundler/library build: `tsup`/Rollup/Vite (per [`08`](docs/architecture/08-packaging-and-loading.md)); never emit CJS.
- **Tests:** Vitest + Playwright; `@vitest/coverage`.
- **Lint/format:** ESLint (typescript-eslint, strict-type-checked) + Prettier, **or** Biome — one toolchain, zero warnings.
- **WASM codec cores:** prefer **small, well-maintained, per-codec** modules (FLAC, libopus, libvpx, dav1d, soxr, libmp3lame, libvorbis) built via Emscripten or Rust+`wasm-bindgen` — **never a monolithic ffmpeg**. Each is wrapped in one `CodecDriver` and lazy-loaded miss-only ([`05`](docs/architecture/05-driver-contracts.md), [`08`](docs/architecture/08-packaging-and-loading.md)). Record the source/version of each core as an ADR.
- **GPU filters:** WebGPU compute/render with WebGL2 and Canvas2D fallbacks; OffscreenCanvas in the worker.
- **Repo hygiene:** conventional commits; CHANGELOG; semver for the library; `DRIVER_API_VERSION` separately ([`05`](docs/architecture/05-driver-contracts.md) §5).

---

## 8. THE BUILD PLAN (phases — execute in order, each to a green gate)

Follow [`12-roadmap.md`](docs/architecture/12-roadmap.md). Each phase below lists deliverables and a **GATE** (exit criteria). Do not advance until the GATE is green; do not stop at a phase boundary — proceed to the next.

### Phase 0 — Scaffolding

Repo init; `package.json` (ESM, `sideEffects:false`, `exports` map), `tsconfig` (strict), bundler config, lint/format, Vitest + Playwright, CI. Land the contracts from [`05`](docs/architecture/05-driver-contracts.md) as real `.ts` (`CodecDriver`/`ContainerDriver`/`FilterDriver`, `MediaError`, `DRIVER_API_VERSION`). Kernel skeleton (Normalizer, Planner, Router, Registry, Executor, Worker-bridge) + the **driver conformance harness**. Stand up the **real-media corpus pipeline** (§6.1): `scripts/fetch-fixtures.ts` (download pinned URLs → verify `sha256` → cache under `fixtures/media/`, git-ignored), `fixtures/manifest.json` (url + sha256 + license + traits), and the golden-baking pipeline — seeded with a first diverse batch of real downloaded files.
**GATE:** `createMedia()` instantiates; a no-op driver passes conformance; the fixture fetcher downloads + checksum-verifies the seed corpus; typecheck/lint/test/CI green.

### Phase 1 — MVP (WebCodecs + TS + GPU, no WASM)

TS MP4/MOV demux+mux+probe (faststart); WebCodecs H.264 + AAC decode/encode (hardware-first); GPU resize/crop/rotate/flip; ops `probe`/`remux`/`trim`(keyframe+accurate)/`convert`(auto-route) ; worker-first runtime; `from()`/`fromX` + `to*`; cancellation/progress. Strict oracles + benchmarks + anti-cheat checks for all of it.
**GATE:** MVP op set passes strict oracles (bit-exact in force-software) + benchmarks; engine wins its covered features in the harness; budgets met; no main-thread long tasks; no COOP/COEP; CI green.

### Phase 2 — Lazy WASM tail + ARCH-1 refactor

Refactor monolith → router+registry (public DX unchanged). Add containers (WebM/MKV, Ogg, WAV, ADTS, MP3, MPEG-TS+HLS). Add codecs (VP9, AV1, HEVC via WebCodecs) + **WASM fallback drivers, miss-only** (incl. required WASM **FLAC decode**, libopus, libvpx). audio-dsp (TS format/gain/mix/fade; WASM/WebAudio resample). `decrypt` (CENC `cenc`/`cbcs`, HLS AES-128). streaming-output (`StreamTarget`, CMAF).
**GATE:** broad harness coverage on strict oracles; lazy-wasm verified (probe-only ⇒ 0 wasm; FLAC convert ⇒ only FLAC core, miss-only); `DRIVER_API_VERSION` v1 frozen; CI green.

### Phase 3 — Performance, isolation & ergonomics

Opt-in WASM SIMD+threads under `crossOriginIsolated`; cost-aware tier thresholds (ADR-020) from telemetry; fluent chain sugar (façade over the declarative job); worker-pool ABR fan-out; frame-lifetime/backpressure audits; multi-sample perf-regression gates.
**GATE:** measured (multi-sample) aggregate win vs each engine; fluent chain GA; telemetry-tuned routing; CI green.

### Phase 4 — Breadth & ecosystem

More filters (full colorspace, HDR→SDR tonemap), more container options, ABR ladders; third-party driver publishing guide + compat shims; docs site, examples, migration guide.
**GATE:** practical-coverage parity with [`01`](docs/architecture/01-goals-and-requirements.md) §3; stable third-party driver API; **§2 Definition of Done fully green**.

---

## 9. BUILD ORDER & DEPENDENCIES

Sequential (shared foundations): contracts → kernel (registry/router/executor/worker-bridge) → first container driver (MP4) → first codec driver (WebCodecs H.264) → executor wiring → `probe`/`remux` → `decode`/`encode` → `convert`/`trim`. Then **parallelizable**: additional drivers (one per codec/container/filter), additional op edge-cases, additional fixtures/goldens, benchmark families — each behind the frozen contracts.

---

## 10. ORCHESTRATION (use the Workflow tool where it helps)

Building has sequential roots but a wide parallel middle. Once the contracts + conformance harness are frozen:

- **Fan out** independent work with the Workflow tool: one agent per **driver** (implement + conformance test + benchmark), one agent per **benchmark family**, one agent per **fixture/golden set**. Each returns a structured result; you integrate.
- **Adversarially verify** correctness findings (a second agent tries to break each driver: leak a frame? wrong on B-frames/VFR? passes a mutated golden?). Only merge drivers that survive.
- **Keep sequential:** the kernel, the seams, anything touching shared types. Never fan out work that mutates the same core files in parallel without worktrees.
- Re-read each agent's result; you own the green `main`.

---

## 11. GUARDRAILS (do / don't)

- **Don't** weaken an oracle to make a test pass. Fix the code.
- **Don't** add `any`, `@ts-ignore`, or skip a type. Model it.
- **Don't** leave a `VideoFrame`/`AudioData` unclosed. Ever.
- **Don't** change the public API or the packet/frame seams without an ADR.
- **Don't** inline heavy wasm or load it eagerly; miss-only, same-origin, lazy.
- **Don't** require COOP/COEP on the common path.
- **Don't** commit red, untested, or unbenchmarked code to `main`.
- **Don't** stop at "mostly works." DoD or keep going.
- **Do** prefer hardware WebCodecs first, GPU for pixels, WASM only on a miss.
- **Do** keep `main` green, commits small, and the task list current.

---

## 12. RESUMABILITY & PROGRESS

The build is large and may span sessions — make it **resumable and never half-done**:

- The **task list** + **phase gates** are the resume points. On resuming, read the task list, run the full gate, and continue the first not-green item.
- `main` is always green; every merged feature is validated + benchmarked. There is no "WIP that doesn't compile."
- Decisions are ADRs; numbers are recorded benchmarks; nothing important lives only in memory.

---

## 13. THE NON-STOP PROTOCOL (explicit)

- **Do not end your turn** while the current phase's GATE is not green and §2 is not met.
- **Do not ask for permission** to proceed between steps or phases. Proceed.
- **If blocked** by a missing decision: choose the SOTA option, record an ADR, continue. Do not wait.
- **If a test fails:** fix the code (or the oracle if it's genuinely wrong, with justification), never delete/loosen it to go green.
- **The finish line is §2.** Keep building, testing, and benchmarking until every box is checked. Then run the full 558-feature harness one final time, confirm the aggregate win, and report the results.

**Now: set max effort, read [`docs/architecture/`](docs/architecture/README.md), create the Phase-0 tasks, and begin. Do not stop until aibrush-media is 100% done.**
