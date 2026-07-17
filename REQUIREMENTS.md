# REQUIREMENTS — code-cleanup backlog for aibrush-media

> **What this is.** The single consolidated fix-list: every **Delta / punch-list** item from the 33 target-spec docs, gathered here verbatim so a code-cleanup task has one backlog to execute. Each item names the change, the code location (`path:line`), and an **Acceptance:** test that proves it done. Nothing here is invented — every item is lifted from its family doc (linked per section), which traces to code or a cited source. Measured-number provenance: [`docs/measured-evidence.md`](docs/measured-evidence.md); decisions/rationale: [`docs/decisions/`](docs/decisions/README.md); doc index: [`docs/architecture/README.md`](docs/architecture/README.md).

**Addressing.** Each requirement is `R-<shard>.<item>` — e.g. `R-S17.2` is item 2 of the Audio-DSP shard. Items **within each shard are already priority-ordered** by the shard's author (item 1 first). Full detail is in §4; the index table is §3.

## 0. Global invariants (acceptance conditions on *every* item)

A fix is not done unless it also keeps these true (see [`.claude/CLAUDE.md`](.claude/CLAUDE.md), [`BUILD_INSTRUCTIONS.md`](BUILD_INSTRUCTIONS.md)):

- **Strict TypeScript, zero `any`**, typed errors only, no dead code, no leftover TODOs.
- **Every `VideoFrame`/`AudioData` is `close()`d exactly once** — audited, not assumed.
- **No capability leak**: a backend/codec/tier named above the driver layer is itself a defect.
- **Intent, not mechanism**: the developer never names a backend; a true miss throws a typed `CapabilityError`.
- **No feature without a strict oracle + a fresh multi-sample benchmark**; never a loose gate or a fabricated number.
- **`main` stays green** (typecheck, lint, test) every commit; a forced design change updates its doc in the same commit.

## 1. Priority framework

| Tier | Meaning |
|---|---|
| **P0 — Soundness** | Correctness / safety / capability-leak / unbounded-growth (OOM) / fabrication-risk — a wrong or unsafe result. |
| **P1 — Competitive & structural** | Measured perf losses vs the 7 rival engines, god-file decomposition, native-fusion gaps, layering debt. |
| **P2 — Coverage & scope** | Golden/oracle coverage, large-file (>4 GiB) support decisions, reserved-rung tests, robustness hardening. |

## 2. Cross-cutting themes (do these as batches — each recurs across shards)

These are the highest-leverage patterns; the per-shard items in §4 are the concrete instances.

- **T1 · God-file decomposition — P1.** The four largest files carry most of the layering debt and must be split along the seams the docs define: `src/drivers/mp4/mp4-driver.ts` (4,528 LOC), `src/api/codec-pipeline.ts` (2,693), `src/api/engine.ts` (2,385), `src/drivers/webm/webm-driver.ts` (2,340). See **R-S23**, **R-S13**, **R-S05**, **R-S24**.
- **T2 · Unbounded / module-global mutable caches — P0.** Bound (LRU) or instance-scope every process-global mutable cache; long-lived engines otherwise grow without limit and leak cross-instance state. Instances: the router container/filter caches (**R-S01**), the DSP `POLYPHASE_CACHE` (**R-S17**), the WAV resample `FAST_BANK_CACHE` (**R-S27**), and the MP4 driver module globals (**R-S23**).
- **T3 · Capability leaks in the API layer — P0.** Remove every place a container/codec/tier is branched on above the driver layer; push the decision into a driver/the router. See **R-S05**, **R-S13**.
- **T4 · Frame lifetime (`close()` exactly once) — P0.** Audit every `VideoFrame`/`AudioData` path for a leak or double-close, with a counting-double test per op. See **R-S02**, **R-S10**, **R-S11**, **R-S30**.
- **T5 · Dead code / unused exports / dead seams — P1.** Delete or wire up: the `tier-thresholds` telemetry exports and the `ensureLoaded` router seam (**R-S01**), and any other zero-importer export a `knip`/`ts-prune` gate surfaces.
- **T6 · Large-file (>4 GiB) support decisions — P2.** For each, *either* implement 64-bit support *or* raise a typed `CapabilityError` that routes to a streaming/fragmented path — and test both branches: MP4 `co64`/64-bit `mdat` (**R-S23**), WAV `RF64`/`BW64` (**R-S27**), AVI OpenDML `indx`/`ix##` (**R-S29**).
- **T7 · Native packet fusion to close mux/remux perf losses — P1.** The WebM/MKV and Ogg write paths build per-packet host objects at the public boundary (measured 3–4× losses vs mediabunny); add `NativePacketChunk` fusion. See **R-S14**, **R-S15**.
- **T8 · Golden / oracle coverage & determinism ownership — P2.** Establish per-family golden floors, the coverage-map, and settle where the determinism (`force-software`) assertion lives. See **R-S33**, **R-S21**.

## 3. Index — 33 shards, 334 requirements

| Shard | Area | Reqs | Doc | Open Qs |
|---|---|--:|---|:--:|
| **S01** | Capability Router & Tier Ladder | 8 | [`capability-router.md`](docs/architecture/capability-router.md) | yes |
| **S02** | Execution & Runtime | 9 | [`execution-runtime.md`](docs/architecture/execution-runtime.md) | yes |
| **S03** | Worker & WASM Runtime | 9 | [`worker-and-wasm-runtime.md`](docs/architecture/worker-and-wasm-runtime.md) | yes |
| **S04** | Driver Contracts & Registry | 10 | [`driver-contracts.md`](docs/architecture/driver-contracts.md) | yes |
| **S05** | Public API | 12 | [`public-api.md`](docs/architecture/public-api.md) | yes |
| **S06** | Input Sources | 11 | [`sources.md`](docs/architecture/sources.md) | yes |
| **S08** | Packaging & Loading | 10 | [`packaging-and-loading.md`](docs/architecture/packaging-and-loading.md) | yes |
| **S13** | Codec Pipeline (shared brain) | 12 | [`codec-pipeline.md`](docs/architecture/codec-pipeline.md) | yes |
| **S33** | Testing & Validation | 10 | [`testing-and-validation.md`](docs/architecture/testing-and-validation.md) | yes |
| **S07** | Sinks & Streaming Output | 9 | [`streaming-output.md`](docs/operations/streaming-output.md) | yes |
| **S09** | Probe & Demux | 8 | [`probe-and-demux.md`](docs/operations/probe-and-demux.md) | yes |
| **S10** | Decode & Seek | 9 | [`decode-seek.md`](docs/operations/decode-seek.md) | yes |
| **S11** | Transcode — Video | 10 | [`transcode-video.md`](docs/operations/transcode-video.md) | yes |
| **S12** | Transcode — Audio & Convert | 11 | [`transcode-audio-convert.md`](docs/operations/transcode-audio-convert.md) | yes |
| **S14** | Mux | 10 | [`mux.md`](docs/operations/mux.md) | yes |
| **S15** | Remux | 10 | [`remux.md`](docs/operations/remux.md) | yes |
| **S16** | Trim | 10 | [`trim.md`](docs/operations/trim.md) | yes |
| **S17** | Audio DSP & PCM Convert | 10 | [`audio-dsp.md`](docs/operations/audio-dsp.md) | yes |
| **S18** | Video Filters | 11 | [`video-filters.md`](docs/operations/video-filters.md) | yes |
| **S19** | Encryption / Decrypt | 8 | [`encryption.md`](docs/operations/encryption.md) | yes |
| **S20** | Metadata | 10 | [`metadata.md`](docs/operations/metadata.md) | yes |
| **S21** | Performance Methodology | 11 | [`performance.md`](docs/operations/performance.md) | yes |
| **S22** | Robustness | 9 | [`robustness.md`](docs/operations/robustness.md) | yes |
| **S23** | MP4 / MOV Driver | 12 | [`mp4.md`](docs/drivers/mp4.md) | yes |
| **S24** | WebM / MKV Driver | 8 | [`webm-mkv.md`](docs/drivers/webm-mkv.md) | yes |
| **S25** | MPEG-TS & HLS Driver | 12 | [`mpegts-hls.md`](docs/drivers/mpegts-hls.md) | yes |
| **S26** | Ogg Driver | 10 | [`ogg.md`](docs/drivers/ogg.md) | yes |
| **S27** | WAV / AIFF / CAF Drivers | 13 | [`wav-aiff-caf.md`](docs/drivers/wav-aiff-caf.md) | yes |
| **S28** | MP3 / ADTS / FLAC Drivers | 10 | [`mp3-adts-flac.md`](docs/drivers/mp3-adts-flac.md) | yes |
| **S29** | AVI Driver | 12 | [`avi.md`](docs/drivers/avi.md) | yes |
| **S30** | WebCodecs Codec Tier | 9 | [`webcodecs.md`](docs/codecs/webcodecs.md) | yes |
| **S31** | WASM Codec Tail | 10 | [`wasm-tail.md`](docs/codecs/wasm-tail.md) | yes |
| **S32** | FLAC & Image Codecs | 11 | [`flac-and-image.md`](docs/codecs/flac-and-image.md) | yes |

## 4. The backlog (verbatim from each shard's Delta / punch-list)

> Each block is the shard doc's §5 as written (target design + change + `path:line` + **Acceptance:** test). Address an item as `R-<shard>.<its number>`. Open questions that gate some items are indexed in §5.

## A. Architecture & cross-cutting core

### S01 — Capability Router & Tier Ladder

Source: [`docs/architecture/capability-router.md`](docs/architecture/capability-router.md) · owned code + rationale in the doc.

#### 5.1 Evict a cached codec driver on an execution-time (async runtime) capability miss

Some browsers' `isConfigSupported` returns `true` for VP8/VP9, then throw a runtime `CapabilityError` on the
first coded packets (measured-evidence.md, ADR-284). Because `pickCodec` caches the top-rung positive after
`supports()` succeeds (`src/kernel/router.ts:94-100`), the **failing hardware driver stays cached** and every
later `pickCodec` for that exact config returns it again — defeating the WASM fallback the retained packet
prefix (ADR-284) was kept for.

- **Change:** add `Router` API to invalidate a single codec verdict (e.g. `evictCodec(q, opts)` or accept an
  eviction callback the executor calls on a runtime miss), and have the decode/transcode executor call it
  before re-routing to the next rung. Do **not** clear the whole cache (would lose unrelated hot verdicts).
- **Acceptance test:** register a fake `tier:'hardware'` codec whose `supports()` returns `true` but whose
  decoder `TransformStream` throws `CapabilityError('capability-miss')` on the first chunk, plus a
  `tier:'wasm'` fake that decodes. Assert (a) the engine re-routes to the wasm driver and produces output,
  and (b) a subsequent `pickCodec` for the **same config** no longer returns the failed hardware driver
  (verdict evicted). Reference `src/kernel/router.ts:94-100`, `:186-192`.

#### 5.2 Surface the `hardwareAccelerated` verdict from `pickCodec` (ADR-203 regression guard)

`pickCodec` computes `CodecSupport.hardwareAccelerated` (`src/kernel/router.ts:89`) then **discards it**,
returning only the `CodecDriver` (`:102`). The decode path must re-derive the acceleration rung, which caused
the ADR-203 ~4× regression (measured-evidence.md).

- **Change:** return `{ driver, support }` from `pickCodec` (or cache/expose the `CodecSupport` alongside the
  driver) so callers configure the *exact* accepted `hardwareAcceleration` rung with no second probe. Thread
  it through `src/api/engine.ts:919-921` / `:1103-1119`.
- **Acceptance test:** a fake hardware codec returns `{ supported: true, hardwareAccelerated: true }`; assert
  the object `pickCodec` returns carries `hardwareAccelerated === true` and that the decoder is configured
  `prefer-hardware` **without** a second `supports()`/`isConfigSupported` call (spy asserts probe count === 1
  per exact config). Reference `src/kernel/router.ts:87-102`, `src/contracts/driver.ts:155-159`.

#### 5.3 Kill the duplicated + dead tier-threshold exports; single source of truth

`TELEMETRY_SEEDED_TIER_THRESHOLDS` exists twice with re-hardcoded numbers
(`src/kernel/tier-thresholds.ts:35-41` and `src/kernel/tier-thresholds-telemetry.ts:19-42`), and
`TierThresholds`/`TelemetrySeededTierThresholds`/`ThresholdProvenance` have no non-test importers.

- **Change:** delete the copy in `tier-thresholds.ts` (`:18-41`). In `tier-thresholds-telemetry.ts`, **import
  the scalar consts** (`TINY_INPUT_BYTES`, …, `TINY_VIDEO_PIXEL_WORK`) and build the object from them so the
  numbers exist exactly once; keep the provenance there (out of the eager kernel). Then either wire the
  telemetry object into a real consumer (a threshold-refresh script / the perf methodology doc's oracle) or
  delete it if nothing consumes it — do not keep dead provenance.
- **Acceptance test:** a unit test asserts
  `TELEMETRY_SEEDED_TIER_THRESHOLDS.tinyVideoPixelWork === TINY_VIDEO_PIXEL_WORK` (single source of truth), and
  `knip`/`ts-prune` (or a repo "no unused export" gate) reports **zero** unused exports in both files.
  Reference `src/kernel/tier-thresholds.ts:35-41`, `src/kernel/tier-thresholds-telemetry.ts:19-42`.

#### 5.4 Resolve the dead `ensureLoaded` seam: wire it or delete it (and fix the docstring)

`EnsureLoaded` is defined and defaulted to `noop` but never supplied in production
(`src/kernel/router.ts:44`, `:63`; `src/api/engine.ts:210`), while the docstring claims the router lazily
loads modules (`src/kernel/router.ts:1-5`).

- **Change (pick one, record an ADR):**
  - *Option A (own the seam):* pass an `ensureLoaded` from the engine that lazily imports the candidate
    driver's chunk, moving miss-only loading **into** the router (the documented design), and simplify the
    engine's `pickCodecWithDefaultFallback` retry (`src/drivers/default-codec-registration.ts:47-64`).
  - *Option B (drop the seam):* delete `EnsureLoaded`/`ensureLoaded`/`noop` and the `await this.#ensureLoaded(d)`
    call, and correct the docstring to state the **engine** owns miss-only lazy loading via retry.
- **Acceptance test:** *Option A* — construct a `Router` with an `ensureLoaded` spy and assert it is invoked
  once per probed candidate, in ladder order, before that candidate's `supports()`. *Option B* — grep proves
  no `EnsureLoaded`/`ensureLoaded`/`noop` symbol remains in `router.ts` and the docstring no longer claims the
  router loads modules. Reference `src/kernel/router.ts:43-49`, `:87-90`.

#### 5.5 Bound the container and filter caches (LRU symmetry with codecs)

`#containerCache`/`#filterCache` are unbounded (`src/kernel/router.ts:58-59`) while `#codecCache` is LRU-64
(`:51`, `:186-192`).

- **Change:** apply the same bounded-LRU discipline (reuse `#rememberCodec`'s eviction logic generically) to
  the container and filter caches, or document a proof that their key spaces are finite and small.
- **Acceptance test:** insert `> bound` distinct container keys (distinct MIME strings) and assert
  `#containerCache` size stays `≤ bound` and the oldest key is evicted (Map insertion-order probe); repeat for
  the filter cache. Reference `src/kernel/router.ts:58-59`, `:127`, `:163`, `:186-192`.

#### 5.6 Bake a golden **rank-order** oracle for the tier ladder

The ladder is the routing spine's law but there is no single test that pins the full rank table as an oracle
(`codecTierRank`/`filterRank`, `src/kernel/router.ts:280-296`).

- **Change:** expose the rank tables (or route fakes through `pickCodec`/`pickFilter`) and assert the exact
  order in both regimes.
- **Acceptance test:** assert, non-tiny, `codecTierRank('hardware') < codecTierRank('gpu') <
  codecTierRank('native') < codecTierRank('wasm')`; assert the **tiny inversion**
  `codecTierRank('native', true) < codecTierRank('gpu', true)`; assert `filterRank` gives
  `webgpu < webgl < canvas2d < native < wasm` (non-tiny) and `native < canvas2d < webgpu < webgl < wasm`
  (tiny). Reference `src/kernel/router.ts:280-296`.

#### 5.7 Regression-test the byte-exact cache key vs mediabunny's `JSON.stringify` memo

Our key handles what mediabunny's `JSON.stringify(encoderConfig)` cannot (§2). Lock it in.

- **Change:** none (behavior exists); add tests.
- **Acceptance test:** (a) two `VideoDecoderConfig`s with the same `codec` string but **different `description`
  bytes** (avcC X vs Y) produce **distinct** cache keys and may resolve to different drivers; (b) a config
  carrying a getter/`Proxy` trap or a cycle returns `undefined` from `codecCacheKey` and is re-probed (never
  throws out of `pickCodec`). Reference `src/kernel/router.ts:302-365`, `:317-325`.

#### 5.8 Test container first-match caching + `clearCache` on `use()`

Containers cache the first matching driver unconditionally (`src/kernel/router.ts:127`), which is safe **only
because** containers have no tier and `clearCache` fires on registration (`src/api/engine.ts:265`, `:1056`,
`:1775`). Make that invariant explicit and tested.

- **Change:** add a doc comment asserting the invariant; add the test.
- **Acceptance test:** register a low-priority container, route a query (populating the cache), then `use()` a
  higher-priority container matching the same MIME; assert the new route wins (proving `clearCache` at
  `src/api/engine.ts:265` invalidated the stale entry). Reference `src/kernel/router.ts:114-138`, `:180-184`.

### S02 — Execution & Runtime

Source: [`docs/architecture/execution-runtime.md`](docs/architecture/execution-runtime.md) · owned code + rationale in the doc.

Ordered for the coder. Each item = the change + a concrete acceptance test.

1. **Implement the `Planner` seam and run one heterogeneous graph (eliminate `Blob` intermediates).**
   Build a `Planner` that compiles a `MediaJob`/chain into a single `StageGraph`
   (`src/kernel/planner.ts:48-50`) and have `runMediaJob` execute it through the executor in one pipe instead
   of the per-op `toBlob()` loop (`src/api/job-runner.ts:198-204`, `:381-404`).
   *Acceptance:* a `trim → resize → mp4` job opens the byte **source exactly once** (assert one source
   `open`/`stream` call via a counting fake), invokes decode/encode **once total**, and the output SHA-256
   equals the two-stage golden; a metamorphic oracle asserts fused-graph output ≡ current staged output
   byte-for-byte on the documented fixtures.

2. **Split `job-runner.ts` (1076 lines) into four modules.** `job-schema.ts` (validators
   `src/api/job-runner.ts:452-1072`), `job-compile.ts` (`compileMediaJob` `:227-370`, `firstVideoTransformRank`
   `:800-811`), `job-progress.ts` (`stageProgress` `:406-450`), `job-run.ts` (`runMediaJob` `:137-225`).
   *Acceptance:* every new file < ~350 lines, no import cycle (assert with a cycle checker), and the existing
   `job-runner.test.ts` (67 tests) stays green with unchanged coverage.

3. **Collapse the duplicate chain builder.** Make `src/api/chain.ts:27-73` the single fluent-chain builder
   and have `engine.load()` delegate to it (lazily if the eager budget requires), deleting the inline Proxy
   at `src/api/engine.ts:287-324`.
   *Acceptance:* grep finds exactly one fluent-chain `Proxy` in `src/api`; `chain.test.ts` and the
   `engine.load(...).trim().blob()` integration test both pass; eager-bundle size does not regress past the
   documented ceiling.

4. **Unify frame close into one canonical helper.** Delete the local `closeFrame` in
   `src/api/live-convert.ts:407` and import `src/kernel/frames.ts:21`; settle the error-swallowing policy in
   one place (the kernel helper — decide catch-or-throw and document it).
   *Acceptance:* grep finds exactly **one** `function closeFrame`/`const closeFrame` definition under `src`;
   the live-media "all N late frames closed exactly once" oracle (measured-evidence.md_) still passes; a unit test
   pins the chosen double-close behavior.

5. **Wire `closeFrames` (or remove it).** `src/kernel/frames.ts:26-28` is exported-but-unused. Either use it
   on a real teardown path (drain the in-flight queue of a cancelled composed graph) or delete the export.
   *Acceptance:* either a cancellation test asserts `closeFrames` drained ≥1 in-flight frame on abort, or the
   symbol no longer appears in `core.ts` exports; no exported-unused symbol remains.

6. **Host the batched zero-HWM packet drain in this family.** Provide the executor-level primitive for the
   256 KiB / 256-packet zero-high-water-mark batch (measured-evidence.md_ ADR-278) so huge tables amortize `read()`
   steps without breaking abort.
   *Acceptance:* draining a 553,501-packet table performs ≤ `ceil(N/256)` `read()` steps (assert the pull
   count), **and** a `cancel()` after a delivered batch aborts before the next batch (assert zero packets
   delivered post-abort). Reference the `{ highWaterMark: 0 }` seam `src/kernel/executor.ts:45-80`.

7. **Flesh out `PlanRequest` into a real normalized request.** `src/kernel/planner.ts:34-45` carries only
   `op`; add the input descriptor, per-stream targets, sink, and signal so `plan()` can decide `copyOnly`.
   *Acceptance:* a same-codec remux `plan(request)` returns `copyOnly:true` with **zero** decode/encode
   stages; a codec-changing convert returns `copyOnly:false` with a decode+encode pair; unit-tested against
   both.

8. **Unify the `Cancellable` + linked-signal plumbing.** Extract one helper (in the executor family) for
   "promise with `.cancel()` linked to parent + terminal + internal `AbortController`, tracking the active
   op" and use it in all three runners (`src/api/chain.ts:54-73`, `src/api/chain-runner.ts:219-230`,
   `src/api/job-runner.ts:143-161`).
   *Acceptance:* one shared helper is imported by all three; the cancel-during-dispatch race
   (`src/api/job-runner.ts:196-197`) is covered by one shared test that all three runners exercise; each
   runner's own cancellation test still passes.

9. **Assert the backend-agnostic invariant as a test.** Encode "the execution layer names no backend/codec"
   as a lint/test.
   *Acceptance:* a test greps the seven owned files for `/webcodecs|wasm|\bgpu\b|dav1d|libvpx|libopus/i` and
   asserts **zero** matches, so a future capability leak into this layer fails CI.

### S03 — Worker & WASM Runtime

Source: [`docs/architecture/worker-and-wasm-runtime.md`](docs/architecture/worker-and-wasm-runtime.md) · owned code + rationale in the doc.

Ordered by severity. Each item: the change + a concrete acceptance test referencing `path:line`.

1. **Fix the no-op `removeEventListener` in the DOM `Worker` adapter (listener leak + latent
   double-close).** `adaptWorker.removeEventListener` is `void [type, listener]`
   (`worker-host.ts:150-153`) and `addEventListener` wraps the listener in a fresh anonymous closure
   each call (`:148-149`), so on a real DOM `Worker` no listener is ever removed. Because a pool reuses
   one bridge across jobs and lives for the page (`SHARED_POOLS`, never terminated), each job's
   `#pump` listener (`worker-bridge.ts:159`) accumulates, and a prior job's stale listener will
   `closeFrame` the *current* job's chunk (`worker-bridge.ts:196-198`) — a double-close the moment a
   real `VideoFrame` path ships (masked today only because `ArrayBuffer.closeFrame` is a no-op). Fix:
   keep a `Map<listener, wrapper>` in the adapter so `removeEventListener` detaches the exact wrapper.
   **Acceptance:** a test driving ≥2 sequential jobs through one `WorkerStreamBridge` over an
   `EventTarget`-backed adapter asserts the adapter's attached-`message`-listener count returns to its
   pre-job baseline after each job settles (net-zero), and that a stale-epoch `chunk` carrying a
   `{ close }` frame calls `close` **exactly once** (spy asserts a single call).

2. **Reconcile `selectWorkerMode` JSDoc with its opt-in body.** The leading JSDoc
   (`worker-mode.ts:28-30`) says unset/`true`/`{pool}` "default to offload"; the body returns `'inline'`
   for `undefined` (`:40`). Correct the doc to the opt-in reality (measured-evidence.md_ ADR-087: unset/`false` →
   inline, the safe default). **Acceptance:** a unit test asserts `selectWorkerMode(undefined, true) ===
   'inline'` and `selectWorkerMode(true, true) === 'offload'`, and the JSDoc no longer states
   unset→offload (grep the file for the corrected wording).

3. **Make the `isolated-simd-threads` profile load a distinct asset — or stop claiming it.**
   `wasmInitForProfile` returns identical `module_or_path` for `baseline` and `isolated-simd-threads`
   (`wasm-loader-runtime.ts:45-51`), so threads/SIMD are resolved but never used (measured-evidence.md_ADR-006
   debt). Choose one: (a) select a sibling threaded core URL (e.g. `*.threads.wasm`) for the isolated
   profile; or (b) until a threaded core is vendored, route the isolated verdict through
   `requireIsolatedWasmProfile`/decline so no code advertises threads it can't run (defensible — no
   benchmark winner ever used WASM threads, measured-evidence.md_). **Acceptance:** option (a) — a test asserts
   `wasmInitForProfile(url, {kind:'isolated-simd-threads', …}).module_or_path.href !==
   wasmInitForProfile(url, {kind:'baseline', …}).module_or_path.href`; option (b) — a test asserts no
   registered core resolves to `isolated-simd-threads` (the engine never advertises a threaded
   capability it lacks).

4. **Avoid the redundant full-input copy in `runOffloadStream`.** `bytes.buffer.slice(byteOffset,
   byteOffset+byteLength)` (`worker-host.ts:417-420`) always copies the whole input before transfer, but
   `readAllSource`'s stream branch already returns an exact-length `new Uint8Array(total)`
   (`:494`), so `bytes.buffer` is already the exact transferable — this doubles peak memory and does an
   O(n) copy for nothing on the common streamed path (the `src.range` branch, `:472-475`, genuinely may
   return a subview and still needs the slice). Fix: adopt `bytes.buffer` directly when
   `bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength`, else slice.
   **Acceptance:** a test with a stream-only source asserts the posted job's `payload.input ===
   bytes.buffer` (zero-copy adopt) and a range source still transfers an exact-length copy; peak
   allocation for an 8 MiB input is ~8 MiB not ~16 MiB (mirrors the measured-evidence.md_ terminal-collector
   adopt-vs-copy measurement, 0.0099 ms vs 0.506 ms on 8 MiB).

5. **Split `worker-host.ts` (506 lines, six concerns) and delete the duplicated source reader.** Extract
   `worker-spawn.ts` (spawn + `awaitReady` + `ensureWorkerBridge`, `worker-host.ts:54-183`),
   `offload-pool-cache.ts` (`SHARED_POOLS` + `ensureOffloadPool`, `:278-328`), and `offload-marshal.ts`
   (`buildOffloadPayload` + `runOffloadStream` + `asBytes`, `:219-467`); replace `readAllSource`
   (`:469-502`) with the engine's single source-reader (S06). **Acceptance:** `readAllSource` deleted, a
   test proves the shared reader yields byte-identical output vs the old function on the same fixture;
   each new module < ~150 lines; the existing `worker-host` tests stay green (behavior unchanged).

6. **Make the readiness handshake backend-neutral and per-op accurate.** `ReadyMessage.webcodecs`
   (`worker-protocol.ts:103`) and `hasWebCodecs()` (`worker-entry.ts:156-158`) hardwire one backend and
   probe only video, so an audio-only convert offloaded to a worker with audio-but-no-video WebCodecs is
   mis-gated. Carry `ready.caps: { video: boolean; audio: boolean }` and gate the downgrade on the caps
   the job needs (`ensureWorkerBridge`, `worker-host.ts:66`). **Acceptance:** a test where the worker
   reports `{ video:false, audio:true }` — an audio-only job proceeds on the worker while a video job
   downgrades to inline; a video+audio job requires both true.

7. **Derive the transfer list from typed payload fields, not a heuristic deep-walk.** `collectTransferables`
   stops at `depth > 4` (`worker-protocol.ts:229`) and `isFrameLike` matches any `{close, width}`
   (`:273-287`), so a nested transferable is silently copied and a plain options object could be
   wrongly transferred. Replace the walk with an extractor over the declared transferable fields of the
   typed `OffloadJobPayload` (today just `payload.input`). **Acceptance:** a test asserts an ArrayBuffer
   nested at depth 5 in a payload is still transferred (or that the typed extractor lists exactly
   `payload.input`), and that a `{ close(){}, width:2 }` options field is **not** transferred.

8. **Scope the shared-pool lifetime instead of a module global.** `SHARED_POOLS` (`worker-host.ts:302`)
   is a process-global mutable `Map` never terminated, with a public test backdoor
   `__resetSharedOffloadPools()` (`:326`). Keep the spawn-storm fix (ADR-087) but own the registry on an
   explicit runtime context so lifetime is scoped and tests need no backdoor. **Acceptance:** a test
   asserts two engines at the same pool size share **one** worker spawn (spawn counter === 1) and that
   disposing the owning runtime terminates the shared pool (no worker survives), replacing
   `__resetSharedOffloadPools`.

9. **Prove the runtime is transparent to B-frames / VFR / seek (validation gate, not a code fix).** The
   worker rebuilds a seekable source (`worker-main.ts:225-231`) and forces `worker:false` inner
   (`worker.ts:63`) so the inline graph runs unchanged off-thread. **Acceptance:** an offloaded `convert`
   of a B-frame-reorder fixture **and** a VFR fixture each produce a **byte-identical** result (same
   SHA-256) to the inline `convert` of the same fixture — the oracle that the runtime added nothing and
   dropped nothing.

### S04 — Driver Contracts & Registry

Source: [`docs/architecture/driver-contracts.md`](docs/architecture/driver-contracts.md) · owned code + rationale in the doc.

Ordered; each item has a concrete acceptance test. Items 1–4 are correctness; 5–10 are structure/typing.

1. **Fix selective-spec id vs driver id.** Make `SelectiveContainerSpec.id` equal the id of the driver its
   `load()` registers, or split the spec into a `specId` (for `matches`) and the real `driverId` (for pin
   resolution) and resolve pins against the real id. Ref `default-container-registration.ts:23-29, 80-90`;
   `mp4-mux-driver.ts:32`; `webm-mux-driver.ts:27`.
   *Acceptance:* a unit test iterates `SELECTIVE_CONTAINERS`, calls each `load()`, and asserts the
   registered driver's `id` equals the value used for pin matching; and `pickContainer({direction:'mux'},
   {pinDriver:'mp4-mux'})` after selective registration resolves the mux driver (currently a miss).

2. **Defend the registry against id-collision capability loss.** With two modules per container family
   (full demux+mux vs mux-only) and first-wins-by-id, the surviving surface depends on op order. Either
   (a) never reuse an id across distinct capability surfaces, or (b) make `#add` merge/replace when a
   later driver of the same id is strictly more capable. Ref `registry.ts:96-98`.
   *Acceptance:* register mux-only `mp4-mux`, then attempt to register full-capability `mp4`, then assert
   an MP4 **demux** resolves to a demux-capable driver (today it can be silently dropped by first-wins).

3. **Make `CapabilityError`/`InputError` codes intrinsic and details typed.** `CapabilityError` should fix
   `code = 'capability-miss'` and take `(message, detail: CapabilityErrorDetail)`; `InputError` should fix
   `'unsupported-input'`. Replace `MediaError.detail: unknown` on the capability path with the typed
   detail. Ref `errors.ts:36-63`.
   *Acceptance:* `new CapabilityError('the message', {op, tried})` typechecks and `err.code ===
   'capability-miss'`; passing any other code no longer compiles; a grep proves no call site passes a
   redundant `'capability-miss'` literal.

4. **Type `CapabilityErrorDetail.op` as a discriminated `OperationDescriptor` and forbid empty `tried`
   when work was attempted.** Replace `op: unknown` with a union
   (`{kind:'codec', query:CodecQuery} | {kind:'container', query:ContainerQuery} | {kind:'filter', spec} |
   {kind:'route', id:string}`), and remove the doubly-nested `{op:{op:'mux'}}` shapes. Ref `errors.ts:39`;
   `defaults.ts:993, 1002, 1126, 1261`; `router.ts:83`.
   *Acceptance:* a test constructs each thrown `CapabilityError` in owned code and asserts `detail.op`
   matches the union and `detail.tried.length > 0` whenever the message claims a probe happened.

5. **Assert the lazy flag table against the real modules (kill the drift).** For every `LazyContainerSpec`
   boolean flag (`probe`, `packetInfo`, `streamCopy`, `decrypt`, `transformPcm`, `decodePcm*`,
   `validates*`), assert the loaded module actually exposes that method; drivers that omit a claimed method
   should fail a **build/conformance** check, not a runtime `missingLazyMethod`. Ref `defaults.ts:270-290,
   388-505, 732-737`.
   *Acceptance:* a conformance test loads every lazy spec, and for each `flag: true` asserts
   `typeof loaded[flag] === 'function'` (and for each *false/omitted* flag that the proxy does not
   advertise it); the test fails if any real driver's surface disagrees with its spec flags.

6. **Fix the version window and add a discoverable minor/capabilities handshake.** `supportedApiVersions`
   must not accept `apiVersion: 0` while `DRIVER_API_VERSION === 1`; the window should be `[current]`
   until a real `current-1 ≥ 1` exists. Add either a `DRIVER_API_MINOR` or a `capabilities: readonly
   string[]` field on `DriverBase` so additive optional methods are advertised, not duck-typed. Ref
   `registry.ts:31-39`; `driver.ts:21, 137-142`.
   *Acceptance:* `isApiVersionSupported(0) === false`; a driver advertising `capabilities: ['streamCopy']`
   without implementing `streamCopy` is refused at registration with `driver-incompatible`.

7. **Move image ops into the contract as a first-class kind.** Either add a fourth registerable kind or
   declare `addImageOps`/`imageOps()` in `src/contracts/driver.ts` so the canonical contract owns the full
   registry surface; delete the structural cast. Ref `registry.ts:45, 63-65`; `defaults.ts:96`;
   `driver.ts:544-549`.
   *Acceptance:* `defaults.ts` registers image ops through a typed contract method with no `as` cast, and
   `RegistryView.imageOps()` / the write method are both declared in the contract file.

8. **Extract the FLAC driver, image sniff, and byte-IO out of `defaults.ts`.** Move `lazyFlacContainerDriver`
   /`flacPacketStream` into `src/drivers/flac/`; move `sniffImageFormat`+helpers into the image codec
   module; move `readByteStream`/`readFlacBytes` into a shared source util. `defaults.ts` should contain
   only registration wiring + lazy proxy factories. Ref `defaults.ts:130-244, 542-686`.
   *Acceptance:* `defaults.ts` drops below ~500 lines and imports zero `EncodedAudioChunk` construction;
   FLAC demux tests import from `src/drivers/flac/`, not `drivers/defaults.ts`; all existing tests pass.

9. **De-duplicate the two lazy muxers.** Fold `LazyFlacMuxer` and `LazyContainerMuxer` into one
   parameterized lazy muxer (single-track vs multi-track is a config, not a class). Ref
   `defaults.ts:965-1184`.
   *Acceptance:* one muxer class remains; the FLAC single-stream constraint is expressed as a
   `validateTrack`/`maxTracks: 1` option; mux golden tests for FLAC and every container still pass.

10. **Relocate browser/UA capability detection to the tier layer, and remove the module global.** Move
    `webgpuAvailable`/`canvas2dAvailable`/`chromiumCanvasTonemapAvailable`/UA regexes into S01's
    capability/tier module, and replace the `imageOpsPromise` module global with per-registry state. Ref
    `defaults.ts:130, 906-963`.
    *Acceptance:* `defaults.ts` contains no `navigator.userAgent` regex and no module-level mutable `let`;
    two `createMedia()` engines in one process each resolve image ops independently (a test that creates
    two engines and asserts no shared promise identity leaks between them).

### S05 — Public API

Source: [`docs/architecture/public-api.md`](docs/architecture/public-api.md) · owned code + rationale in the doc.

Ordered for a coding agent. Each item names the change, the `path:line`, and a concrete acceptance test.

1. **Split the `engine.ts` god-file (2385 lines) into a thin dispatcher + module helpers.**
   Move the tail helpers (`deferredStream` `engine.ts:1868`, `cancelStream` `:1964`, `allOrCancel` `:1972`,
   `cacheProbeRanges` `:2085`, `readAllSource` `:2170`, `assertTrimRange` `:2294`, MIME/route helpers) into
   `src/kernel/` (streams/lifetime) and `src/api/*-runner.ts` modules. `engine.ts` should keep only the
   interface, the class shell, and per-op methods that `normalize → route → run → materialize`.
   *Acceptance:* a size guard asserts `engine.ts` ≤ 600 lines and exports **only** `MediaEngine` +
   `MediaEngineImpl`; `grep -c 'export ' src/api/engine.ts` returns 2; all of `create-media.test.ts`,
   `engine`-touching tests, and the eager-kernel bundle-budget test stay green (budget unchanged, since
   the moved code was already behind lazy imports).

2. **Remove the capability leak `WEBCODECS_VIDEO_DRIVER_ID` from the engine.**
   Replace the string-id match at `engine.ts:848-849` (and the const at `:131`) with a capability flag on
   the `CodecDriver` contract (e.g. `driver.supportsWarmDecoderReuse === true`), so the engine pools by
   *capability*, not by a named backend.
   *Acceptance:* `grep -nE "'webcodecs|'wasm-|'gpu|DRIVER_ID" src/api/engine.ts` returns nothing; a unit
   test registers a *fake* non-webcodecs driver that advertises the reuse capability and asserts the seek
   path pools it (borrows a warm decoder), proving the decision is capability-driven.

3. **De-duplicate `CONTAINER_MIME`.** Extract one shared constant (e.g. `src/api/container-mime.ts`) and
   import it from both `engine.ts:110` and `preload.ts:9`.
   *Acceptance:* `grep -rn "CONTAINER_MIME: Record" src/` finds exactly one definition; a test imports the
   const from both modules and asserts referential identity (`a === b`).

4. **Add `MediaEngine.dispose(): Promise<void>` (and `[Symbol.asyncDispose]`).** Tear down `#poolCache`
   (`engine.ts:228`), `#videoDecoderPool` (`:237`), and `#preloadTasks` (`:211`); make post-dispose ops
   throw a typed `MediaError` or transparently re-initialize (decide in the ADR).
   *Acceptance:* a test spies on worker spawn + `VideoDecoder` construction, runs a `convert` and a `seek`
   to populate both pools, calls `await engine.dispose()`, and asserts the worker is terminated and no
   `VideoDecoder` remains live; `using engine = createMedia()` compiles and disposes at scope exit.

5. **Make the bare-function default instance resettable/disposable.** Add `resetDefaultMedia()` (or route
   the bare functions through an `AsyncLocalStorage`/per-context accessor) so the module-global at
   `create-media.ts:35` cannot silently share a worker pool across SSR requests or leak between tests.
   *Acceptance:* a test calls `preload()` (populating the default instance), calls `resetDefaultMedia()`,
   then asserts the next bare call constructs a *fresh* instance (spy on `createMedia`); an SSR-style test
   proves two sequential "requests" do not share `#poolCache`.

6. **Inject the real version into `src/version.ts:2`.** Replace the `'0.0.0'` literal with the build-time
   package version.
   *Acceptance:* a test asserts `VERSION === <package.json>.version` and that it is not `'0.0.0'` in a
   published build.

7. **Add a public capability pre-flight (mediabunny parity).** Expose an intent-level query such as
   `canConvert(opts): Promise<boolean>` / `getSupportedContainers()` mirroring mediabunny's `canEncode`/
   `getEncodableCodecs` (`mediabunny.d.ts:671`,`:1817`) — *without* naming a tier. Back it by the same
   Router used at `engine.ts:919-924`.
   *Acceptance:* a test asserts `canConvert({ to:'mp4', video:{codec:'h264'} })` resolves `true` where
   `convert` would succeed and `false` (never throw) where `convert` would raise `CapabilityError`, with
   zero WASM download on the negative path.

8. **Decide the partial-failure model (soft `discardedTracks` vs. hard `CapabilityError`).** mediabunny
   returns `isValid` + `discardedTracks[]` (`mediabunny.d.ts:909`,`:916`); today a single unsupported track
   fails the whole op (`engine.ts:198`,`:771`). Either adopt an opt-in
   `ConvertOptions.onTrackDiscarded`/result diagnostics or ratify strict-by-default in an ADR.
   *Acceptance (if adopted):* a 3-track input with 1 unsupported track still produces valid output for the
   2 supported tracks and reports the discarded one; *(if rejected):* the ADR records the rationale and a
   test asserts the whole-op `CapabilityError` names the offending track in `tried`.

9. **Fix the stale `engine.ts:5-9` header docstring.** Rewrite it to describe the current implemented
   surface (all core ops live; capability misses are honest typed errors), dropping the "Phase 0 only"
   language.
   *Acceptance:* `grep -n "Phase 0\|Phase-1 pipelines" src/api/engine.ts` returns nothing; a reviewer
   confirms the header matches the implemented methods.

10. **Harden `track-select.ts` diagnostics.** Include the raw selector in the first error
    (`track-select.ts:22`) and make a nonzero single-source suffix (`video:0@1`) raise a typed
    `InputError` naming the selector instead of the silent `continue` at `:57` — or document the drop
    explicitly in the selector contract.
    *Acceptance:* `selectTrackInfos([...], ['garbage'])` throws an `InputError` whose message contains
    `'garbage'`; `selectTrackInfos([...], ['video:0@1'])` on the single-source path throws (or is covered
    by an explicit documented-behavior test), not a silent empty→`'no track'`.

11. **Fold the module-global `probeRangeCacheModule` (`engine.ts:184`) into a `memoizeAsync` module ref**
    (the pattern already at `engine.ts:1820`) so there is no bare mutable module `let`.
    *Acceptance:* `grep -nE "^let " src/api/engine.ts` returns nothing; behavior of the probe-range cache
    path is unchanged (its existing tests stay green).

12. **Trim the `@aibrush/media/core` surface to a versioned minimum (`core.ts:9-205`).** Audit every
    re-export against "does a third-party driver author actually need this symbol as a stable boundary?"
    Demote incidental internals to deep imports.
    *Acceptance:* a `public-surface.test.ts`-style snapshot pins the exact `/core` export set; a diff
    against it fails CI, forcing an ADR + `DRIVER_API_VERSION` bump for any change (the versioning promise
    at `core.ts:5-7` becomes enforced, not aspirational).

---

### S06 — Input Sources

Source: [`docs/architecture/sources.md`](docs/architecture/sources.md) · owned code + rationale in the doc.

Each item: the change, the `path:line`, and the oracle that proves it.

1. **Surface whether ranges were honored.** Add a learned `rangesHonored?: boolean` fact (set `false`
   the first time a `Range` request returns `200`, `source.ts:473`). Higher layers use it to skip
   range-based seek planning on a non-compliant server (RFC 9110 §14; `measured-evidence.md`).
   *Acceptance:* mock a server that answers `200` to `Range`; assert `range(4, 8)` still returns the
   correct 4 bytes **and** the source reports `rangesHonored === false`; a compliant `206` server
   reports `true`.

2. **Thread `AbortSignal` through `range()`.** Extend `Source.range(start, end, signal?)` and
   `ByteSource.range` (`source.ts:67`, `contracts/driver.ts:187`); bind it into `fetchRange`
   (`source.ts:442`) via `fetch(href, { signal, … })`; pass the caller signal from `peekSourceHead`
   (`source.ts:227`) and from the probe-cache range (`probe-range-cache.ts:183`).
   *Acceptance:* behind a never-resolving `fetch` mock, call `fromURL(u).range(0, 16, signal)` then
   `signal.abort()`; assert the promise rejects with `MediaError('aborted')` **and** the `fetch` init
   received an already/soon-aborted signal (spy on `init.signal`).

3. **Replace the spread+redefine wrapper with a forwarding wrapper.** In `probe-range-cache.ts`, stop
   cloning `{ ...src }` (`:181`) + `preserveLiveSourceFacts` (`:141`); delegate via a wrapper that
   forwards *every* own key, symbol, and getter of the wrapped `Source`, overriding only `range`.
   *Acceptance:* wrap a `fromURL` source, then on the **original** learn a redirect and a size via a
   range read; assert `wrapped[SOURCE_URL_KEY]` equals the redirected URL, `wrapped.size` equals the
   learned size, `wrapped[SOURCE_CACHE_KEY] === src[SOURCE_CACHE_KEY]`, and `wrapped.readAll` is the
   original's — all without listing fields by hand.

4. **De-duplicate the header parsers.** Extract `parseContentLength`/`parseContentRangeTotal` into one
   internal module (e.g. `sources/http-range.ts`); import from both `source.ts` (`:491`/`:499`) and
   `url-size.ts` (`:27`/`:34`).
   *Acceptance:* `grep` finds exactly one definition of each; a unit test drives the shared parser over
   `bytes 0-0/1234` → 1234, `bytes 0-0/*` → undefined, `` (missing) → undefined, `abc` → undefined.

5. **One canonical whole-read helper; delete per-driver `readAll`.** Add
   `readAllBytes(src, signal?)` in the sources layer preferring `src.readAll?` → `src.range(0, size)`
   → `drain(src.stream())` (mirroring `cache.ts:207`); replace the 10+ driver-local `readAll`
   duplicates (caf/wav/ogg/adts/aiff/webm/flac/mp3/mpegts/avi).
   *Acceptance:* a source exposing `readAll` is drained via that fast path (spy shows `stream()` never
   called); a pure stream is drained via the generic path; both yield identical bytes + checksum.

6. **Implement `readAll` for `bytes`/`blob`/`opfs`.** Only `url`/`element` have it today
   (`source.ts:288`, `:329`). `fromBytes` returns its owned buffer in one call; `fromBlob`/`fromOPFS`
   via `blob.arrayBuffer()`. Backs the measured whole-read win (`measured-evidence.md`, one plain full read beat
   multi-pull concatenation).
   *Acceptance:* `fromBlob(b).readAll()` returns exactly `b`'s bytes and never constructs a
   `getReader()` (spy); checksum matches a `drain(stream())` baseline.

7. **Move the live decode path out of `src/sources`.** Relocate `probeLiveMediaStream`/`liveTrackInfo`/
   `decodeLiveMediaStream` (which import `../api/types.ts`, `live-media.ts:3`) into an `api/live-*.ts`
   module, leaving only the `LiveMediaSource` brand + `fromMediaStream`/guards in `src/sources`.
   *Acceptance:* a dependency-lint rule forbids `src/sources/**` importing `src/api/**`; the rule
   passes; existing live tests still green.

8. **Make "range never short-reads before EOF" a contract, not an inference.** The probe cache infers
   EOF from `start === 0 && bytes.byteLength < requestedEnd` (`probe-range-cache.ts:196`, `:209`).
   Document the invariant on `Source.range` and assert it across all constructors.
   *Acceptance:* a conformance test calls each constructor's `range(a, b)` with `b > size` and asserts
   the length equals `size - a`; a separate test proves a *mid-file* short read is **not** treated as
   EOF (only `start === 0` learns size).

9. **Give the per-engine probe cache to the engine as an instance field.** Replace the module-global
   `cachesByOwner` WeakMap (`probe-range-cache.ts:30`) with per-engine ownership (the engine passes its
   own `WeakMap<Source, ProbeRangeCacheState>`), removing module-level mutable state.
   *Acceptance:* two engines probing the same `Source` object keep independent cache state; disposing an
   engine drops its cache with no module-level residue (assert via a fresh cache map per engine).

10. **Decide the home of read coalescing / read-ahead.** The 256 KiB read-ahead + 8 MiB-window / 256
    KiB gap-bridge coalescing (ADR-052; `measured-evidence.md`) lives in the drivers today
    (`mp4-driver.ts`, etc.). Evaluate hoisting a *policy-free* coalescing decorator into the sources
    layer so every driver inherits it (as `CachingSource` already coalesces, `cache.ts:250`).
    *Acceptance:* an ADR is logged with the chosen owner; if hoisted, a demux over a URL source issues
    the coalesced window count the ledger expects (e.g. 256 KiB coalescing → the recorded window/byte
    totals) with no per-driver read loop.

11. **Bind `fetchStream` to a signal.** `fetchStream` (`source.ts:392`) fires `fetch(href)` with no
    signal, so aborting the returned stream before the first chunk cannot cancel the initial request.
    Thread the consumer's signal into the `fetch`.
    *Acceptance:* abort during `pull()` before the first chunk arrives → the stream errors aborted and
    the `fetch` init carried the signal (spy).

### S08 — Packaging & Loading

Source: [`docs/architecture/packaging-and-loading.md`](docs/architecture/packaging-and-loading.md) · owned code + rationale in the doc.

1. **Fold WASM co-vendoring into the build; kill the drift window.** Replace the standalone
   `scripts/vendor-wasm.ts` post-step with an esbuild `onEnd` plugin that emits each tail's `.wasm`
   next to its `*-core.js` chunk as part of the single `build`.
   *Acceptance:* after `bun run build` **alone** (no separate `vendor-wasm`), `scripts/vendor-wasm.ts --check`
   (`vendor-wasm.ts:260-276`) reports every pair already present and copies zero files; remove `vendor-wasm`
   from `gate` (`package.json:165`) and prove the gate stays green.

2. **Per-driver lazy registration to restore the ~250 kB first-op target with real margin (ADR-092 fix).**
   Today the first-op default closure statically pulls the shared registration + mux/plan machinery for all
   kinds via `defaults.ts` even for a probe-only consumer (`src/drivers/defaults.ts:83-100`,
   `src/api/engine.ts:1054`).
   *Acceptance:* a probe of an MP4 pulls only the MP4 chunk; extend `assertNoHeavyLazySourceLeaks`
   (`check-budgets.ts:496`) to assert the first-op MP4 closure's source maps contain **no** `webm-driver`/
   `ogg-driver`/`avi-driver` sources, and lower `TYPICAL_APP_BUDGET` (`check-budgets.ts:32`) below 250 kB with
   `margin ≥ MIN_BUDGET_MARGIN`.

3. **De-duplicate the node-builtin exclusion to one source of truth.** The `browser` field (`package.json:44-55`)
   and esbuild `external` (`scripts/build.mjs`) encode the same list twice.
   *Acceptance:* both derive from one exported array (or drop the legacy `browser` field entirely, since
   `exports`-based ESM + esbuild `external` already covers browsers); `verify-package-install.ts` bundle report
   emits zero node-builtin `require`s and typechecks green (`verify-package-install.ts:45-57`).

4. **Remove the codec-name capability leak from `check-budgets.ts`.** Derive the guarded codec set from the
   registered wasm tails (single source of truth) instead of the hardcoded `aac|av1|mp3|opus|vorbis|vpx`
   regexes (`check-budgets.ts:42,46,50,59,125`).
   *Acceptance:* a synthetic `src/codecs/wasm-foo/` tail leaking into the eager closure is caught by the guard
   **without** editing any regex (add a fixture-driven test asserting the guard set is computed, not literal).

5. **Publish or explicitly document the `worker` asset.** `dist/worker.js` (`scripts/build.mjs`) has no
   `exports` entry (`package.json:23-41`).
   *Acceptance:* `src/dist-smoke.test.ts` asserts `dist/worker.js` exists AND that `@aibrush/media/worker` is
   either a resolvable subpath or a documented-private asset (mirror the `fragmentMp4` on-`/core` assertion at
   `dist-smoke.test.ts:159-165`).

6. **Prune/parameterize the ~120 session-scoped bench scripts** (`package.json:77-164`).
   *Acceptance:* replace `bench-session*-*` with one parameterized `bench <name>` runner; assert
   `package.json` `scripts` count drops below 40 and the `gate` chain (`package.json:165`) is byte-unchanged.

7. **Keep streaming-compiled separate `.wasm` as the default; confine `inline:true` to a strict-CSP hatch.**
   Inlining costs ~+33% and forfeits streaming compile (`docs/measured-evidence.md` doc-08 note).
   *Acceptance:* `check-budgets.ts:517` asserts every emitted `.wasm` is a separate same-origin asset
   referenced only by `new URL(...,import.meta.url)` (`check-budgets.ts:296`) and that **no** `.wasm` is
   base64-inlined into a JS chunk on the default build; a loader golden documents the wasm-bindgen glue takes
   the `instantiateStreaming` path.

8. **Retire the historical budget drift: pin the DoD 50 kB eager ceiling with an honest guard band.**
   `KERNEL_BUDGET` = 50 kB is set (`check-budgets.ts:25`) but the guard band is only 256 B
   (`check-budgets.ts:37`).
   *Acceptance:* raise `MIN_BUDGET_MARGIN` to ≥ 1 kB, keep the gate green, and add a regression note that
   ADR-092's temporary 58 kB / 264 kB ceilings are retired.

9. **Define cancel-during-cold-load semantics at the lazy seam.** An abort mid-`import()` or mid-`.wasm`
   fetch currently races the module-level core-promise cache (`wasm-mp3-driver.ts:106-122`).
   *Acceptance:* a test aborts an op during `loadMp3Core` (`wasm-mp3-driver.ts:95`) and asserts the op rejects
   with `MediaError('aborted')` and the aborted attempt is **not** left cached under a failed/aborted state
   (a subsequent op re-attempts the load). Cross-references S02 (execution-runtime) cancel semantics.

10. **Add Subresource-Integrity / content-hashing for same-origin `.wasm`+`worker` assets.** Today
    `vendor-wasm.ts` copies the `.wasm` with its **original flat filename** (`vendor-wasm.ts:252-257`) while
    esbuild content-hashes JS chunks — so a core update cannot bust the HTTP cache and cannot carry an integrity
    hash under strict CSP.
    *Acceptance:* emitted `.wasm` filenames carry a content hash and (optionally) the loader passes an
    `integrity`; `check-budgets.ts` WASM-reference assertion (`:547-559`) still matches every emitted asset to
    a `new URL(...)` site.

### S13 — Codec Pipeline (shared brain)

Source: [`docs/architecture/codec-pipeline.md`](docs/architecture/codec-pipeline.md) · owned code + rationale in the doc.

1. **Split the god-file into the three target layers.** Extract `codec-strings.ts` (level tables +
   avcC/hvcC parsers), `encoder-config.ts` (build*Config + rate/latency), `codec-queries.ts`
   (`*QueryFor`, `requireEncoderConfig`), `mux-trackinfo.ts`, `vpx-alpha.ts`, and `codec-live.ts`
   (drains/seek/pairing). *Acceptance:* every resulting module is < ~600 lines; all existing
   `codec-pipeline.test.ts` / `codec-ops.test.ts` assertions pass unchanged against re-exports;
   a bundle-analysis test asserts a probe-only closure pulls **none** of `codec-live.ts` /
   `vpx-alpha.ts`.
2. **Remove the capability leak (layer 4 → router).** Move `webkitVideoTranscodeDeclineReason`,
   `firefoxVideoTranscodeDeclineReason`, `firefox*` classifiers, and the `*ForRuntime` wrappers out
   of the pure config module into the S01 router as query-keyed tier de-ranking. *Acceptance:*
   `grep -E 'isWebKitRuntime|isFirefoxRuntime|runtime-detect|WebKit|Firefox|wasm-opus'` over the
   pure config module returns **zero**; a router test feeds a Firefox+Opus+MP3-source query and
   asserts the same typed `capability-miss` with the identical message the current
   `firefoxAudioTranscodeDeclineReason` (`codec-pipeline.ts:942`) produces.
3. **Make the purity claim true (or fix the header).** After item 1, the pure layer must contain
   no `new VideoFrame(` / `new AudioData(` / `.close(`. *Acceptance:* a lint/grep test asserts the
   pure config modules reference none of those tokens; the header comment
   (`codec-pipeline.ts:5`) is updated to match reality.
4. **Consolidate the three codec-string resolvers into one.** Keep a single exported
   `resolveVideoEncoderCodecString(target, src, sourceCodecString)`; make
   `videoEncoderCodecString` (`:578`) and `h264CodecStringForSourceProfile` (`:319`) private
   helpers of it. *Acceptance:* the public surface exports exactly one video codec-string
   resolver; a table test pins the string for {explicit token, preserve-source, H.264
   Main/High-source, HEVC-Main10-request, VP9/AV1 level boundary} and passes bit-for-bit against
   today's outputs.
5. **Replace the `__aibrushRgbaPixels` expando** (`codec-pipeline.ts:1829`) with a `WeakMap<VideoFrame,
   RgbaFramePixels>` sidecar or an explicit wrapper type. *Acceptance:* no
   `Object.defineProperty(frame, …)` remains; a VPx-alpha round-trip test proves split→merge stays
   bit-exact and no longer depends on host-object expando acceptance (drop the try/catch at `:1836`).
6. **Pin the rate model behind named constants + a golden table.** `defaultVideoBitrate`
   (`codec-pipeline.ts:1115`) mixes a 20-bits/pixel/second planned budget, a per-codec efficiency
   table, a `sqrt(fps/30)` cadence scale (ADR-252), and an evidence-based path with a bare
   `3_750_000` floor (`:1171`). Extract each to a documented constant. *Acceptance:* a table-driven
   test pins the output bitrate for a matrix of {codec × resolution × fps × sourceBitrate} tuples,
   including the AV1 60fps cadence row (harvest: `sqrt(frameRate/30)` capped at H.264 budget) and
   the av1→vp9 source-bounded row (harvest line 395).
7. **Prove frame-lifetime is exactly-once under cancel/error, not just success.** Add a
   close-counting fake-`VideoFrame` oracle across `splitFrameForVpxAlpha`, `mergeAlphaFrames`,
   `encodeVideoFramesWithAlpha`, `decodeVideoPacketsWithAlpha`, `seekFrame`, and
   `drainEncoderToMuxer`. *Acceptance:* for success, mid-stream `cancel`, and an injected throw at
   each `await`, the oracle asserts `closeCount === createCount` and no double-close (extends the
   existing "closed exactly once" claim at `codec-pipeline.ts:2047`).
8. **Bound and unify backpressure on the alpha-pairing streams.** `encodeVideoFramesWithAlpha`
   (`codec-pipeline.ts:2133`) and `encodeVpxAlphaFrameStreams` (`:2269`) build their output
   `ReadableStream` with the **default** HWM, unlike `unwrapPackets`/`decodeVideoPacketsWithAlpha`
   which pin `{ highWaterMark: 0 }` (`:1736`, `:2506`). Audit and pin HWM consistently.
   *Acceptance:* a slow-consumer test drives each alpha stream and asserts `alphaByTimestamp` never
   exceeds the encoder reorder distance (a fixed small bound), not the clip length.
9. **Add explicit capability-miss tests for the encode-surface limits.** Two-pass is H.264-only
   (`codec-pipeline.ts:1230`), CRF/quantizer is gated by `webCodecsQuantizerSupported` (`:1077`),
   HEVC non-Main/Main10 and high-bit-depth are typed misses (`:602`, `:1336`). *Acceptance:* tests
   assert `av1` + `twoPass:true` throws `capability-miss` with the exact suggestion string
   ("target H.264 or add a validated two-pass allocator…", `:1237`), and `vp8` + `crf` throws with
   the exact CRF suggestion.
10. **Lock the VFR/B-frame bitrate-evidence path with a golden.** `sourceVideoBitrateFromPacketTable`
    (`codec-pipeline.ts:663`) must use the DTS+duration span, not PTS. *Acceptance:* a golden test
    feeds (a) a VFR packet table with non-uniform durations and (b) a reordered-DTS B-frame table,
    and asserts the computed bits/second matches a hand-derived value and is insensitive to PTS
    ordering.
11. **Guard the `chooseOutputContainer` default.** `chooseOutputContainer` (`codec-routing.ts:34`)
    falls back to `mp4`. *Acceptance:* a test asserts that a source whose container is **not**
    chunk-muxable (and no explicit `to`) returns `mp4`, and that a genuinely non-muxable target
    surfaces the container router's typed miss rather than silently producing a broken output.
12. **Keep the eager-kernel boundary a test, not a comment.** The split (item 1) must preserve the
    property asserted in prose at `codec-routing.ts:3`. *Acceptance:* a budget test fails if any of
    the heavy layer-1/2/3 modules become statically reachable from the eager kernel entry (today
    they arrive only via `engine.ts:191`'s `import('./codec-pipeline.ts')`).

### S33 — Testing & Validation

Source: [`docs/architecture/testing-and-validation.md`](docs/architecture/testing-and-validation.md) · owned code + rationale in the doc.

Ordered by leverage. Each item names the change, the `path:line`, and a concrete acceptance test /
oracle that proves it.

1. **Build the browser-mode frame-flow facet (close-once, flush, cancel).** Add
   `assertCodecDriverFrameFlow(driver, frames)` and `assertFilterDriverFrameFlow(...)` beside the Node
   facets in `harness.ts` (declared but absent, `src/conformance/harness.ts:8-11`). Pump N real
   `VideoFrame`/`AudioData` through the driver `TransformStream`.
   *Acceptance:* wrap each input frame's `close()` with a counter; after the stream drains, assert
   **every input frame closed exactly once** (a fresh `Map<frame, count>` where every value === 1); a
   mutation arm using a driver that double-closes or leaks a frame throws `ConformanceError`. Repeat with
   an `AbortSignal` aborted mid-stream and assert all in-flight frames are still closed exactly once.
2. **Assert one-frame backpressure in the harness.** Today the codec/filter factory check stops at
   `isTransformStreamLike` (`src/conformance/harness.ts:42-49,95,239`). Extend it to verify the readable
   side's high-water mark is bounded.
   *Acceptance:* obtain a writer on `createDecoder(...).writable`; write one frame, do not read; assert
   `writer.desiredSize <= 0` (a second write would block). A driver whose readable strategy sets
   `highWaterMark > 1` fails.
3. **Add a determinism-conformance facet.** Add `assertDeterminismReproducible` proving `force-software`
   (a) drops hardware/GPU/WebGPU/WebGL/canvas2d tiers from selection and (b) yields cross-machine
   identical bytes. This encodes ADR-007 and the router fix (measured-evidence.md_ line: "accept a hardware-tier
   result only with an explicit `hardwareAccelerated:false` verdict").
   *Acceptance:* decode a fixture twice under `determinism:'force-software'` on the same code path →
   identical sha256; and assert the router, given `force-software`, returns no driver whose tier is in
   `['hardware','gpu']` / substrate in `['webgpu','webgl','canvas2d']`. A driver that returns a
   hardware-tier result under `force-software` without `hardwareAccelerated:false` fails.
4. **Normalize `hls-sample-aes.ts` to the sibling-encryptor pattern.** Add a file-header docstring;
   import `AES_BLOCK` from `../crypto/aes.ts` instead of redefining it (`src/test-support/hls-sample-aes.ts:3`);
   and make it a *genuine* inverse-of-SUT oracle by either mirroring the decrypt path's offsets (as
   `cbcs-encrypt.ts:8-11` does) or wiring an external twin.
   *Acceptance:* a test asserts the SAMPLE-AES ciphertext produced here for a fixed key/IV and the RFC 8216
   clear-lead geometry (H.264 clear-lead 32 / crypt 16 / skip 144; AAC clear-lead 16,
   `src/test-support/hls-sample-aes.ts:10-12`) is **byte-identical** to a Bento4/openssl-authored
   SAMPLE-AES twin, and our decryptor recovers the clear PCM byte-exact — proving it is not a self-mirror.
5. **Unify the garbage-probe matrix in the full harness.** `assertCodecDriverConforms` probes one
   `video/decode` garbage query (`src/conformance/harness.ts:88-92`) while the Node facet uses the richer
   `nodeCodecProbes()` (`:251-271`). Have the full check reuse `nodeCodecProbes()` so both paths test
   `supports()` totality over decode+encode+audio+garbage identically.
   *Acceptance:* a driver that throws on the `audio/encode` or empty-codec probe fails
   `assertCodecDriverConforms`, not only `assertCodecDriverNodeFacets`.
6. **Give `dsp-goldens.ts` an independent cross-check.** It currently hashes our own `encodePcm` output
   with no foreign corroboration (`src/test-support/dsp-goldens.ts:25-45`). Add an `ffmpegCrossChecked`
   field baked by comparing the exact-arithmetic conversions (`identity`, `to_f32`, `to_s24`,
   `remix_stereo_s16`) against ffmpeg `-f f32le`/`s24le` output at bake time; keep `gain` excluded
   (`:6-9`).
   *Acceptance:* the bake refuses to commit unless our bytes equal ffmpeg's for the lossless conversions;
   the committed golden records `ffmpegCrossChecked: true` and a later drift from ffmpeg fails the test.
7. **Remove module-global mutable state in `corpus.ts`.** `manifestCache`
   (`src/test-support/corpus.ts:46`) is a hidden singleton. Replace with an explicit
   `createCorpus()` returning bound loaders, or an injectable cache, so tests cannot leak state.
   *Acceptance:* a test that creates two independent corpus instances, changes the manifest on disk
   between them, and reads via a fresh instance observes the change; the shared-singleton path is gone.
8. **Pin DTS as well as PTS in `golden-packets`.** `GoldenPacketRow` has `ptsUs` but no `dtsUs`
   (`src/test-support/packet-goldens.ts:37-44`), so B-frame decode order is unvalidated. Add `dtsUs` to
   the row, the serialization (`:83-90`), and the ffprobe cross-check.
   *Acceptance:* for a B-frame MP4 fixture (built via `moovBox` with a non-trivial `ctts`,
   `src/test-support/mp4-builder.ts:108`), the golden pins both `ptsUs` and `dtsUs`; a demuxer that drops
   the composition offset (PTS == DTS) fails against the ffprobe-corroborated table.
9. **Add a golden coverage-map (anti-rot for oracles).** Mirror `real-drivers.test.ts:327-355` for
   fixtures: every fixture carrying a golden-eligible trait must have a committed golden.
   *Acceptance:* `fixturesByTrait('lossless-audio')` (via `src/test-support/corpus.ts:86`) is a subset of
   the fixtures with a committed `fixtures/golden/decoded/<id>.json`; adding a lossless fixture without a
   golden fails the map.
10. **Make typed `CapabilityError` the sole NA signal.** The exemplar's message-regex NA classifier lets
    a real bug that emits a miss-shaped sentence become NA instead of FAIL (measured-evidence.md_,
    competitive-gaps). Our conformance suite must assert every honest miss is a typed `CapabilityError`
    (`src/contracts/errors.ts:50`), never a string or a plain `MediaError`, so the adapter can classify
    NA on the *type* alone.
    *Acceptance:* the anti-cheat mutation suite asserts a missing-key decrypt and a force-software image
    decline both reject with `instanceof CapabilityError`; a path that returns wrong output instead of
    throwing fails (`src/conformance/anti-cheat.test.ts:240` is the seed).

## B. Operations (benchmark families)

### S07 — Sinks & Streaming Output

Source: [`docs/operations/streaming-output.md`](docs/operations/streaming-output.md) · owned code + rationale in the doc.

Ordered, each with a concrete acceptance test / oracle.

1. **Wire `OpfsTarget` into the `Sink` union and delete the redundant basic `opfs` path — or make
   `opfs` delegate to it.** Add `OpfsTarget` to `Sink` (`src/sinks/sink.ts:10`), add a
   `case 'opfs-target':` to the materializer `switch` calling `writeToOpfsTarget`
   (`src/sinks/materialize.ts:17`), and re-export `toOpfsTarget` from `src/index.ts` next to
   `toStreamTarget` (`src/index.ts:64`). Re-point the basic `opfs` case (`materialize.ts:29`) at the
   same `writeToOpfsTarget` so there is one OPFS drain.
   *Acceptance:* `grep -rn 'toOpfsTarget|writeToOpfsTarget' src/` shows a call site outside
   `opfs-target.ts`/tests; a test constructs `toOpfsTarget('/a/b/out.mp4', { keepExistingData: true,
   position: N })`, runs it through `materialize`, and the mocked `FileSystemWritableFileStream` records
   `createWritable({ keepExistingData: true })` and `seek(N)` (asserting `opfs-target.ts:186`–`187`
   actually run via the public path); a coverage check fails if `opfs-target.ts` has zero non-test
   importers.

2. **Make the streaming `position` the producer's intended byte offset, not a running counter.** Change
   the drain so the muxer supplies each chunk's target `position` (a `{ data, position }` pair,
   mirroring mediabunny's `StreamTargetChunk`) instead of deriving it from `position += value.byteLength`
   (`src/sinks/stream-target-materialize.ts:93`). For the `WritableStream` arm, use a seekable write
   (OPFS `seek`) when the destination is random-access, and keep `pipeTo` for append-only.
   *Acceptance:* a test whose producer emits chunks with non-monotonic positions (write region B, then
   re-write region A) is delivered to a fake destination in the producer's order with correct offsets;
   the current append-only code fails this test (the byte at A would land at the wrong offset), the new
   code passes. Append-only producers still see `position == Σ previous lengths`.

3. **Remove the driver leak from `streaming-webm-remux.ts`.** Obtain the streaming muxer through the
   driver/registry contract (a `container.streamingMux(...)` capability) rather than
   `import { WebmStreamingMuxer } from '../drivers/webm/ebml-write.ts'`
   (`src/api/streaming-webm-remux.ts:12`); move the `opts.to → 'matroska'|'webm'` decision
   (`streaming-webm-remux.ts:298`, `streaming-webm-remux.ts:431`) behind that contract.
   *Acceptance:* `grep -n "from '../drivers/" src/api/streaming-webm-remux.ts` returns nothing; the
   remux still passes its existing golden tests (`src/api/streaming-webm-remux.test.ts`) and the
   `streaming-output` WebM-live oracle (`webm-live-layout`) stays green; a second streaming container
   (e.g. fragmented MP4) can be added without editing this file.

4. **Enforce the bounded-memory invariant instead of only documenting it.** When a `StreamTarget`/
   `OpfsTarget` is paired with a non-streaming (faststart, non-fragmented) muxer, either auto-select a
   streaming muxer or raise a typed `CapabilityError` — never silently buffer the whole file behind a
   streaming descriptor.
   *Acceptance:* the `peakMemory` metric for a `target:'stream'` case stays within one-fragment bounds
   (does not scale with output size) in `../media-test/src/scenarios/streaming-output/` at two sizes;
   a case that requests `target:'stream'` with an explicitly non-fragmented MP4 either succeeds with
   bounded `peakMemory` or fails with a `capability-miss`, asserted by an oracle — it must not pass with
   `peakMemory ≈ bytesOut`.

5. **Expose a first-byte / write hook so TTFB and `targetWrites` are measurable through the public
   sink.** The callback arm already receives `(chunk, position)` per write
   (`src/sinks/stream-target-materialize.ts:92`); guarantee the first invocation happens at the first
   produced chunk (not at finalize) and document it as the TTFB signal the harness reads.
   *Acceptance:* `../media-test/src/scenarios/streaming-output/ttfb.ts` reports
   `mp4_ttfb_streaming_target.timeToFirstByte` markedly below `mp4_ttfb_buffer_target.timeToFirstByte`
   on the same asset, and a unit test asserts the `StreamTargetWriter` fires before the source stream
   completes; both cases still pass the reference-reimport correctness oracle (a fast-but-wrong output
   cannot win the crown, per `ttfb.ts:1`).

6. **Harmonize the "OPFS unavailable" error type.** The basic path throws
   `InputError('unsupported-input')` (`src/sinks/materialize.ts:57`) while the streaming path throws
   `CapabilityError('capability-miss')` (`src/sinks/opfs-target.ts:167`). OPFS-absent is a capability
   miss, not bad input.
   *Acceptance:* a test running any OPFS sink in an environment without `navigator.storage.getDirectory`
   asserts the thrown error `instanceof CapabilityError` with code `capability-miss`; both paths agree.

7. **Add `chunked`/`chunkSize` write-coalescing to `StreamTarget`.** Mirror mediabunny's
   `StreamTargetOptions` so a caller can trade a bounded amount of memory for fewer `targetWrites`
   (default off; default `chunkSize` 16 MiB when on), coalescing in the drain
   (`src/sinks/stream-target-materialize.ts:77`/`:113`).
   *Acceptance:* with `chunked: true, chunkSize: 2**20`, a streaming-output case's `targetWrites`
   drops sharply versus unchunked while `bytesOut` and the byte-validity oracle are unchanged, and
   `peakMemory` stays ≤ `chunkSize + one fragment`.

8. **Record the module-global element-session state as an ADR (or scope it).** The two `WeakMap`s
   (`src/sinks/element-materialize.ts:49`–`:50`) are module-global mutable singletons. Either document
   the "one active session per element" invariant in an ADR or move ownership onto an engine-scoped
   registry so two `Engine` instances cannot cross-abort each other's element sessions.
   *Acceptance:* a test attaching two sessions to the *same* element asserts the first is aborted with
   `MediaError('aborted', 'element sink was replaced by a newer attachment')`
   (`element-materialize.ts:58`); a test with two independent engines on *different* elements asserts no
   cross-abort.

9. **Unify the descriptor/seam split convention.** Pick one pattern (two-file descriptor+seam, or
   one-file pure-core+guarded-seam) and apply it to both `stream-target*` and `opfs-target`.
   *Acceptance:* both streaming sinks follow the same file layout; the packaging budget test
   (default-entry closure size) is unchanged, proving the seam is still lazily loaded.

### S09 — Probe & Demux

Source: [`docs/operations/probe-and-demux.md`](docs/operations/probe-and-demux.md) · owned code + rationale in the doc.

1. **Consolidate all container sniffers behind one registry with a declared head contract.** Move
   `matchesMp4`/`matchesWebm`/`matchesMpegTs`/`matchesAvi`/FLAC (`defaults.ts:107`,`:121`,`:522`,`:704`,
   `:557`) and the six audio predicates (`audio-container-sniff.ts:41`–`82`) behind a single exported
   table of `{ driverId, minHeadBytes, matches(q) }`, and have the engine read `max(minHeadBytes)` rather
   than a magic `64 * 1024` (`engine.ts:182`). *Acceptance:* a magic-byte fixture table
   (`RIFF…WAVE`, `ID3`, MPEG sync, `OggS`, ADTS sync, `FORM…AIFF`, `caff`, `…ftyp`, EBML `1A45DFA3`)
   asserts **exactly one** driver matches each entry; a test enumerates every registered
   `ContainerDriver` and asserts its `supports` is sourced from the single sniff module (no inline
   matcher survives).

2. **Disambiguate ID3-prefixed MP3 vs ADTS by content, not registration order.** `matchesMp3` must not
   claim on `ID3` alone (`audio-container-sniff.ts:51`); it should skip the leading ID3v2 tag (reuse the
   `adtsHeadOffset` synchsafe walk, `:88`) and require an **MPEG audio** frame sync at the post-tag
   offset, symmetric to `matchesAdts`. *Acceptance:* a fixture = ID3v2 header + raw ADTS AAC sync frames,
   `mime` unset, `extension` `'aac'` **or** unset, resolves to the **ADTS** driver; the mirror fixture
   (ID3v2 + MPEG-1 Layer-3 frames) resolves to **MP3**; assert via `router.pickContainer(q)` returning the
   expected `driver.id`. (Today both predicates return `true` and `defaults.ts:314`-before-`:337` order
   wins for MP3 — `UNVERIFIED`: the end-to-end mis-route needs a run to confirm the router's first-match
   pick; the double-match is CONFIRMED from code.)

3. **Kill the provenance shadow schema — make it exhaustive at compile time.** Replace the eleven runtime
   key arrays in `packet-provenance.ts:20`–`84` with keys derived from the `TrackInfo`/`DecoderConfig`
   contract (or add a `satisfies`-backed exhaustiveness guard) so a new `TrackInfo` field cannot silently
   disable fusion. *Acceptance:* a test constructs a `TrackInfo` populated in **every** optional field
   (extend the existing `native-packet-mux.test.ts:24`–`83` fixture) and asserts an identity clone is
   still claimable for each field mutated in isolation; a type-level check fails to compile if a
   `TrackInfo` key is added without being routed into exactly one comparator group.

4. **Encapsulate the provenance WeakMap behind a typed façade (or carry an explicit token).** No module
   should read the raw `sources` `WeakMap` (`packet-provenance.ts:18`) directly; expose only
   `register`/`lookup` (already the public functions `:253`,`:260`) and consider attaching the provenance
   capability to the demux result (`Demuxed`, `types.ts:286`) as a non-enumerable token instead of a
   global side channel. *Acceptance:* a test asserts (a) a locked stream declines (`:264`), (b) a
   semantically changed `TrackInfo` declines (already `native-packet-mux.test.ts:92`–`140`), and (c)
   grep proves no source file outside `packet-provenance.ts` references the `WeakMap` symbol.

5. **Close the massive-file demux drain gap.** `demux/size_massive_massive_h264_1080p_2h` loses 33.159×
   (1349 ms vs 40.685) because the public drain constructs immutable native chunks for 1.14 GiB while the
   consumer performs 553 501 `read()`/`await` steps (measured-evidence.md). Push consumers toward payload-free
   `packetInfo()`/`packetTable()` (`driver.ts:307`,`:425`) for metadata-only work, and keep the
   256 KiB/256-packet batching (ADR-278). *Acceptance:* `performance/size-ladder-iterate-packets-massive`
   preserves all 553 501 payload-free packet sizes matching ffprobe (`golden-packets`), and the metadata
   path resolves in ≤ ~35 ms (the metadata-only demux+`packetTable` measured 32.0 ms, measured-evidence.md);
   `demux/…_2h` full-drain regression-gated to not exceed its current median.

6. **Guarantee a metadata-only `probe()` hook on every container driver.** The `probe?`/`packetInfo?`
   hooks are optional (`driver.ts:420`,`:425`) and drivers that omit them fall back to a full `demux()`
   (`engine.ts:390`). *Acceptance:* a conformance test enumerates all registered container drivers and
   asserts each implements `probe`; `probe/edge_longform` (1 h AAC M4A) resolves in < 200 ms (ADR-112:
   178 ms) via the hook, proven by a range-read counter, **not** a whole-file read.

7. **Populate `dtsUs` in first-party video fusion.** `NativePacketChunk.dtsUs` (`packet-provenance.ts:9`)
   must be set from the container's decode timeline for reordered video (the MP4 `claim` at
   `mp4-driver.ts:2934`), while audio keeps it omitted (`adts-driver.ts:745`). *Acceptance:* a B-frame
   MP4 fused-mux round-trip reports `maxDtsDrift = 0` and one keyframe (cf. the VFR mux bench: 626
   packets, zero PTS/DTS differences, ADR-191, measured-evidence.md), and the demuxed vs re-demuxed packet tables
   are byte-identical under `golden-packets`.

8. **Enumerate `nonMedia` tracks with parity.** Probe must surface a declared non-media trak (e.g.
   QuickTime `tmcd`) as `MediaInfoTrack.type: 'other'` (`types.ts:266`, `driver.ts:243`) so the probe
   track count/order matches ffprobe `nb_streams`, but such a track must never emit a packet in `demux()`.
   *Acceptance:* `golden-metadata` on a timecode-trak fixture matches ffprobe's stream count/order, and
   `golden-packets` on the same asset shows zero packets for the `tmcd` track.

### S10 — Decode & Seek

Source: [`docs/operations/decode-seek.md`](docs/operations/decode-seek.md) · owned code + rationale in the doc.

Ordered, each with a concrete acceptance oracle.

1. **Prove the VPx miss→WASM replay end-to-end with a real golden, not just a unit stub.**
   Today `replayable-video-decoder.test.ts` injects a synthetic `CapabilityError`; add an integration
   test that forces a VP9 primary runtime miss and asserts the `wasm-vpx` fallback yields the **exact
   golden frame digest** (bit/structural), and that `WasmVpxDriver.supports()` is `true` (vendored core
   present, ADR-032). *Accept:* fallback frames digest-match golden **and** the vendor pair check passes;
   fail loudly if `wasm-vpx` cannot load. Refs: `codec-convert-runner.ts:288-297`,
   `drivers/defaults.ts:1240-1283`, `replayable-video-decoder.ts:227-258`.

2. **Generalize the runtime-miss regex to every codec that has a WASM decode tail.**
   Replace `/^vp(?:8|9|09)/` (`codec-convert-runner.ts:280`) with a router-derived predicate that
   includes AV1 (`wasm-av1`) and *excludes* H.264/HEVC (no software tail — must stay terminal).
   *Accept:* parametrized test — an injected AV1 primary miss replays through `wasm-av1` and digest-
   matches golden; an injected H.264 miss surfaces a **terminal typed `CapabilityError`** with no
   fallback factory ever invoked. Refs: `codec-convert-runner.ts:278-299`, `measured-evidence.md` (no
   H.264/HEVC tail; dav1d AV1 tail).

3. **Cap decode-seek surface memory to at least tie the leanest rival.**
   `decode_vfr_timing` peaks 672 MB vs 107 MB (`measured-evidence.md`). The seam is already single-frame-in-flight
   (`replayable-video-decoder.ts:306`), so the peak is consumer-retained GPU surfaces. Add a documented
   single-owner frame contract and evaluate compact detachment — noting Chromium rejects explicit
   I420/NV12 `copyTo` and non-RGB natural-format `copyTo` (`measured-evidence.md`), so detachment must be RGBA (or
   a documented can't-beat with the ~11.2 MB/frame attribution). *Accept:* a fresh memory benchmark on
   `decode_vfr_timing` asserts peak RSS within tolerance of the leanest rival, **or** an ADR records the
   measured can't-beat with the surface attribution.

4. **Land the B-frame decode correctness bug.**
   `meta_pts_monotonic_after_reorder` yields **no decoded frames after B-frame reorder** and
   `decode_mov_h264` SSIM 0.854 (`measured-evidence.md`). *Accept:* both rows pass the frame-count and
   SSIM/PSNR oracle in the browser harness (frames emitted, monotonic presentation PTS, SSIM ≥ gate),
   proving the UA presentation-order path plus `.mov` avcC handling is correct end-to-end.

5. **Guarantee no `VideoFrame` leaks on the seek cancel-mid-decode race.**
   The ADR-040 enqueue-vs-close race is the seek killer. Add a leak test that starts a decode, cancels
   the output reader between the decoder's check and enqueue, and asserts **every produced frame is
   `close()`d exactly once** (reuse the `TestFrame.closeCount>1` throw pattern from
   `replayable-video-decoder.test.ts:16-19`). *Accept:* zero surfaces with `closeCount !== 1`; teardown
   promise resolves once. Refs: `replayable-video-decoder.ts:281-300, 212-225`; `measured-evidence.md` (ADR-040).

6. **Assert the `dequeue`-driven backpressure has no polling regression.**
   The historical `setTimeout(0)` `decodeQueueSize` poll cost hundreds of macrotasks (`measured-evidence.md`).
   *Accept:* a decode of N packets performs O(N) pulls with **zero** `setTimeout`-based queue polling
   (spy/counter), and in-flight decode requests never exceed `HIGH_WATER_MARK`
   (`webcodecs-video.ts:748`). Refs: `webcodecs-video.ts:146, 748`; `replayable-video-decoder.ts:306`.

7. **Decide and encode the reorder-buffer stance explicitly.**
   We trust the spec's presentation-order guarantee (ADR-026) and add no sorter; remotion hedges with a
   bounded `videoFrameSorter`. Keep the no-buffer default but add a *capability-flagged* bounded reorder
   only if a target UA is proven to violate presentation order. *Accept:* the existing order-preserving
   test (`replayable-video-decoder.test.ts:78-79`) stays green; a new browser B-frame golden proves the
   UA already yields presentation order (so the buffer is unnecessary) — logged as an ADR.

8. **Make the `avcC` crop delta data-driven instead of hard-coding `=== 2`.**
   `webcodecs-video.ts:1289` throws unless `alignedWidth - visibleWidth === 2`, baking Apple's 2-px pad
   into a general helper (which itself accepts any positive `cropPixels`, `h264-avcc-crop.ts:15-16`).
   Derive the crop delta from the encoder's coded-vs-visible width and validate divisibility by
   `CropUnitX` at the boundary. *Accept:* a property test over a range of aligned widths (delta divisible
   by `CropUnitX`) yields `parseH264SpsDimensions === visibleWidth`, and an odd delta on 4:2:0 rejects
   with the chroma-crop-unit error (already `h264-avcc-crop.test.ts:54`).

9. **Preserve the H.264 seek-compat Level floor on produced output.**
   Chromium accepts sub-L3.0 tiny H.264 encodes but the resulting MP4 fails the platform `<video>`
   seek/decode path (ADR-084, `measured-evidence.md`). *Accept:* a seek test on a tiny encoded MP4 drives the
   real platform seek/decode (not just a structural box check) and lands the target frame; assert the
   emitted codec string carries `level_idc = 0x1e` (e.g. `avc1.42E01E`). Owned by S30/S23 — tracked here
   because it is a `decode-seek` acceptance gate.

### S11 — Transcode — Video

Source: [`docs/operations/transcode-video.md`](docs/operations/transcode-video.md) · owned code + rationale in the doc.

Ordered by leverage. Each item names the change, the `path:line`, and a concrete acceptance oracle.

1. **Make `planVideoRateControl` the single source of truth, or delete it.** Wire the encode path to
   consume `VideoRateControlPlan` (`video-stream-plan.ts:585`) instead of re-deriving rate control in
   `eagerVideoRateConfig` + `video-two-pass-runner.ts:353`; if not wired, remove the union and function.
   *Acceptance:* a Node test asserts, over a matrix of `{bitrate}`, `{crf}`, `{twoPass,bitrate}`, and
   `{}`, that the rate config actually handed to the encoder equals `planVideoRateControl(target,codec)`
   — and `grep` finds a **non-test** consumer of `planVideoRateControl`. Today both fail.

2. **Split the 910-line `video-stream-plan.ts` into single-concern modules:** `video-filter-plan.ts`
   (`videoFilterSpecs`, `videoFilterRouteCost`, `videoTargetPixelBoundaryBitDepth`), `video-cfr-retime.ts`
   (`planCfrFrameRetiming`, `retimeTimedFrameStream`, `retimeVideoFrameStream` + the `FrameTiming` types),
   `video-rate-plan.ts` (`planVideoRateControl`), `video-bit-depth-plan.ts`
   (`planVideoBitDepthConversion`), `video-abr-ladder.ts` (`planH264AbrLadder`).
   *Acceptance:* each new file exports one concern and is < 250 lines; `tsc`/biome green; no import
   cycle (`madge --circular src/api` clean); the existing `video-stream-plan.test.ts` assertions pass
   unchanged against the new module paths.

3. **Unify VFR→CFR so the pure oracle tests the shipping code.** Derive `retimeTimedFrameStream` from
   the same interval/clamp primitives as `planCfrFrameRetiming` (`video-stream-plan.ts:294` vs `:429`).
   *Acceptance:* a property test feeds ≥ 1,000 randomized strictly-increasing VFR timestamp sequences
   (including the 22.507 s @ 1 fps tail, `:331`, and a 30 fps→1 fps downsample) through both
   `planCfrFrameRetiming` and a `collect()` of `retimeTimedFrameStream`, asserting identical
   `(timestamp, duration, sourceIndex, duplicate)` tuples and `Σ(durations) == sourceDuration`.

4. **Remove codec-string sniffing from the runner.** `implicitRateControlWarmupFrames`
   (`video-two-pass-runner.ts:51`) and the two-pass gate (`:210`) must take a resolved `VideoCodec`
   token (or a capability descriptor), not raw string prefixes; move the `30.5`/`8`/`3` constants next
   to the codec they describe.
   *Acceptance:* `grep -nE "avc1\.|avc3\.|av01\.|startsWith" src/api/video-two-pass-runner.ts` returns
   zero hits; a unit test drives `{h264, av1@60, av1@30, vp9}` tokens and reproduces today's warmup
   counts (`8`/`3`/`8`/`undefined`).

5. **Route the 8-bit down-convert GPU-first; Canvas2D miss-only.** Put a WebGPU limited-range RGBA
   convert in front of `canvasBackedVideoFrameStream` (`video-frame-convert.ts:42`); reach Canvas2D only
   on a GPU miss, and never set `imageSmoothingQuality: 'high'`.
   *Acceptance:* on a GPU-capable harness context the down-convert path selects GPU (assert via a
   route-cost/telemetry probe); a grep proves no `'high'` smoothing on this path; the
   `h264_resize_4k_to_1080p` bench wall drops toward the mediabunny reference (~1.09 s vs the current
   ~11× loss, `measured-evidence.md`), with `ssim-psnr` still ≥ row floor.

6. **Hoist the duplicated dynamic imports in `video-two-pass-runner.ts`** (`:189/:300`, `:195/:313`,
   `:247/:370`) into one lazy loader shared by `analyzeH264TwoPass` and `encodeVideoStream`.
   *Acceptance:* an import-count spy shows each of `codec-pipeline`, `video-stream-plan`,
   `video-frame-convert` imported at most once per convert call; behavior unchanged (two-pass proof
   golden `e768d3f0…814d` still matches, `measured-evidence.md`).

7. **Guard VFR encoder→mux DTS/PTS drift.** The two-pass/CFR outputs feeding the muxer must not produce
   parsed `PTS < DTS` (the 626-frame VFR fixture pushed PTS 11 µs behind DTS by frame 17, ADR-191,
   `measured-evidence.md`).
   *Acceptance:* reuse `bench-session11-mp4-vfr-mux`'s oracle — reprobe the produced MP4 and assert
   zero `PTS<DTS` violations and one keyframe across the 626-frame VFR output.

8. **Add a two-pass budget-accuracy oracle.** `planH264TwoPass` computes `predictedBytes`
   (`video-two-pass.ts:249`) but nothing asserts the *actual* second-pass output lands near
   `targetBytes`.
   *Acceptance:* a browser proof on `transcode/h264_two_pass_bitrate` asserts actual video-payload bytes
   within ±10 % of `plan.targetBytes` **and** `ssim ≥ 0.95` (`transcode/index.ts:774`), matching the
   810,678-byte / 2 Mbps golden (`measured-evidence.md`).

9. **Make non-H.264 two-pass an explicit typed decision, not a silent single-pass.** Today
   `analyzeH264TwoPass` typed-misses non-AVC (`video-two-pass-runner.ts:213`); either land a real
   VP9/AV1 QP-schedule path (they support quantizer mode, `video-stream-plan.ts:639`) or keep the miss.
   *Acceptance:* `convert({video:{codec:'vp9', bitrate, twoPass:true}})` raises
   `CapabilityError('capability-miss')` with `op:'encode'`, `tried:['webcodecs-video']` — assert the
   typed error object, never a silently-downgraded single-pass output.

10. **Move VPx alpha-plane extraction off the per-pixel JS loop** (`vpx-alpha-pixels.ts:108`) to a
    wasm/GPU copy while preserving the bit-exact plane.
    *Acceptance:* the alpha-plane golden hash is unchanged (neutral-0x80 chroma, `:71`) and the
    `vp9_alpha_to_vp9_keepalpha` bench stays ≤ the current 17.49 ms win over mediabunny's 164.9 ms
    (`measured-evidence.md`).

### S12 — Transcode — Audio & Convert

Source: [`docs/operations/transcode-audio-convert.md`](docs/operations/transcode-audio-convert.md) · owned code + rationale in the doc.

Ordered, each with a concrete acceptance test / oracle. Reference `path:line`.

1. **Extract an `audio-encode-plan.ts` (S12) that owns audio encoder-config + output-gapless planning.**
   Move `buildAudioEncoderConfig` (`codec-pipeline.ts:1526`) and `outputGaplessForAudioEncoder`
   (`codec-pipeline.ts:1591`) into a new pure module symmetric with `audio-stream-plan.ts`, leaving
   codec-pipeline free of audio-specific encoder logic.
   *Acceptance:* a Node unit test imports `audio-encode-plan.ts` and asserts, with no WebCodecs, that
   `buildAudioEncoderConfig({codec:'opus'}, {sampleRate:44100, channels:2}, 'mp4a.40.2')` yields
   `{codec:'opus', sampleRate:48000, numberOfChannels:2}` (see item 2) and that
   `grep -n "buildAudioEncoderConfig\|outputGaplessForAudioEncoder" src/api/codec-pipeline.ts` returns no
   *definitions* (only imports). Byte-budget test: eager kernel stays under cap (`measured-evidence.md`: 50.00 kB).

2. **Normalize Opus encode to 48 kHz and publish encoder pre-skip; never trust a non-48k Opus config.**
   `buildAudioEncoderConfig` currently uses `target.sampleRate ?? src.sampleRate` (`codec-pipeline.ts:1526`),
   so an Opus target inherits e.g. 44.1 kHz. RFC 7845 §4.2 requires Opus at 48 kHz internally, and
   `outputGaplessForAudioEncoder` already drops source gapless for Opus (`codec-pipeline.ts:1595`).
   Force `sampleRate = 48000` for `audioCodecToken(codec) === 'opus'` unless the caller explicitly set a
   different rate (then either resample-to-48k in the filter chain or raise a typed error).
   *Acceptance:* unit test asserts the Opus branch pins 48000; harness `transcode/aac_to_opus_webm` passes
   its strict oracle (`measured-evidence.md`: byte-identical 128,350-byte WebM, 502 Opus packets, 481,296 sample
   frames, sampleDelta scenario), and a mono-44.1k-Opus convert does not emit a 44.1k `dOps`.

3. **Push runtime (Firefox) codec quirks out of the plan and into the router (S01) — fix the capability leak.**
   `resolveAudioEncodeTargetForRuntime` (`codec-pipeline.ts:989`) and `audioEncodeNeedsSoftwareRuntime`
   (`:1006`) name backends (`'wasm-opus'`, `'wasm-mp3'`, `'webcodecs-audio'`) in a planning layer and in the
   `CapabilityError.tried` array. The plan should be backend-agnostic; the router should apply the
   Firefox "Opus→software, ADTS-AAC decode→wasm-aac" rule (ADR-110, `measured-evidence.md`) via tier scoring.
   *Acceptance:* `grep -n "wasm-opus\|wasm-mp3\|webcodecs-audio\|isFirefoxRuntime" src/api/*.ts` shows no
   backend token inside `audio-encode-plan.ts`/`codec-convert-runner.ts`; a router test with a stubbed
   Firefox runtime routes an Opus encode to the software tier and an ADTS-AAC decode to `wasm-aac`, and a
   stubbed Chromium runtime routes both to WebCodecs — asserted through the public `strategy`-free API.

4. **Single-source the PCM codec-token → `(SampleFormat, Endianness)` mapping.**
   `wav-frame-encode.ts:173` (`pcmWireTarget`) and the engine-injected `deps.pcmSampleFormat`/`pcmEndian`
   used in `pcm-convert-plan.ts` (`:356`, `:455`) encode the same 15-token table twice. Move the canonical
   map to `src/dsp/pcm.ts` (S17) and have both callers import it.
   *Acceptance:* a table-driven test enumerates every `pcm-*` token in the `AudioTarget['codec']` union and
   asserts `wav-frame-encode`'s wire target and `pcm-convert-plan`'s resolved format/endian agree for all
   of them; deleting the duplicate in `wav-frame-encode.ts` keeps `wav-frame-encode.test.ts` green.

5. **Extract `decodePcmBridge(container, src, track, stage)` from the runner's three inline branches.**
   `codec-convert-runner.ts:345`-`378` repeats `decodePcmInterleavedStream` / `decodePcmAudioStream` /
   `decodePcmAudio` selection with three separate `import('../dsp/audio-data.ts')` calls.
   *Acceptance:* one helper with one dynamic import; a unit test with a fake `ContainerDriver` exposing each
   capability in turn proves the helper selects the interleaved path first, then the chunked path, then the
   single-shot path, and returns `undefined` when none exist so the caller decodes via the codec.

6. **Retire the module-global `pcmRewriteSourceCache` singleton (or move it to the Source cache, S06).**
   `pcm-convert-plan.ts:49`-`50` holds process-global mutable state shared across every engine instance,
   never cleared on engine disposal.
   *Acceptance:* construct two independent engines, run a WAV-identity convert on each, and spy on
   `src.range` — the second engine must still issue its own read (no cross-engine cache hit); disposing an
   engine must free its cache (heap assertion). If moved to S06, the cache key is the `SOURCE_CACHE_KEY`
   and the TTL/byte caps (`:39`-`:42`) live with the source layer.

7. **Shrink the runner/live dependency bags into named sub-seams.**
   `CodecConvertRunnerContext` (`codec-convert-runner.ts:47`-`132`, ~20 callbacks) and
   `LiveFramePipelineDependencies` (`live-convert.ts:33`-`70`) are god-bags coupling the cold routines to
   engine internals.
   *Acceptance:* refactor into composed seams (e.g. `RouteSeam`, `AudioSeam`, `VideoSeam`, `MuxSeam`); a
   type-level test asserts each sub-seam has ≤ 6 members and the runner depends only on the sub-seams it
   uses. No behavioral regression: full `codec-ops`/`create-media` suites stay green.

8. **Add a strict double-trim gapless oracle for AAC-in-MP4 with an edit-list priming.**
   `nativeSuppressedMp4EditSamples` (`gapless-native-suppression.ts:134`) guards against Chromium natively
   suppressing priming (ADR-213). Bake a golden that decodes a real editlist-priming AAC-in-MP4 and asserts
   the decoded sample count equals `sourceSamples − priming` **exactly once**.
   *Acceptance:* harness `audio-dsp/edge_gapless_aac_decode` oracle: `decodedSamples = 44673`,
   `rawAacFrameSamples = 46080`, `primingSamples = 1024`, `sampleDelta = 0` (`measured-evidence.md`); plus a
   Chromium-vs-Firefox cross-check that both land on the same decoded sample count (Firefox reproduced the
   deficit at 49,152 samples in the source note — the oracle must be browser-invariant).

9. **Document + test the raw-frame WAV contiguity contract (the audio "VFR" boundary).**
   `assertContinuousTimestamp` (`wav-frame-encode.ts:289`, tolerance 1 µs at `:14`) rejects any gappy audio
   clock. Make it explicit that `encode()`-to-WAV expects a contiguous decoded clock, not arbitrary live
   audio, and decide whether the 1 µs tolerance is right for real decoders that drift (see open questions).
   *Acceptance:* a test feeds two `AudioData` frames with a 2 µs gap and asserts an `InputError`
   (`unsupported-input`) with the "contiguous AudioData timestamps" message; a contiguous stream produces
   the golden checksum (`measured-evidence.md`: bench-session12-wav-frame-encode output checksum 2910552623).

10. **Verify the copy-in-convert passthrough matches mediabunny's `canPassThrough` conditions.**
    `codec-convert-runner.ts:212` copies audio packets only when `opts.audio === undefined` and
    `canCopyAudioTrackToContainer` (`codec-pipeline.ts:799`) accepts. mediabunny additionally gates on
    "no bitrate, same channels, same sampleRate, no trim/pad" (§2).
    *Acceptance:* an audio-only convert (compatible container, no target changes) constructs **zero**
    `AudioData` (assert via an `AudioData` construction counter/spy) and produces a byte-stable output;
    a convert that requests a `bitrate` or layout change does **not** take the copy path.

11. **FLAC direct path: bound the whole-file read.**
    `readAllSource` (`flac-convert-plan.ts:136`) buffers the entire source for the WAV-s16 fast path. For a
    large WAV this is a full-file allocation.
    *Acceptance:* a memory oracle asserting peak ArrayBuffer for a large WAV→FLAC stays within one source
    allocation (cf. ADR-277 range-less WAV decode, `measured-evidence.md`), or a size threshold above which the
    fast path defers to the streaming `authorFlacStream` path (`:105`-`111`).

### S14 — Mux

Source: [`docs/operations/mux.md`](docs/operations/mux.md) · owned code + rationale in the doc.

#### 5.1 Extract one shared packet-normalization + stream-drain module

`chunkStructFrom`, `packetBytes`, `encodedChunkBytes`, `isPacket`, `isObject`, `isReadableStream(Like)`,
`assertNotAborted`, `streamFromBytes`, and the `packetValues`/`packetChunks` drain loops are duplicated
across `mux-packet-streams.ts` (`:97-133`), `mp4-prepared-mux.ts` (`:245-298`),
`mpegts-prepared-mux.ts` (`:133-228`), and `flac-mkv-mux.ts` (`:388-460`, `:713-769`). Consolidate into
`src/api/mux-packet-normalize.ts`.
**Acceptance:** `grep -rc 'function encodedChunkBytes' src/api` returns exactly 1; a unit test feeds a
`Packet` whose `data` aliases `chunk` and asserts `packetBytes` returns the *same* buffer (zero copy,
`mp4-prepared-mux.ts:284-288`), and a bare `EncodedChunk` and asserts the `copyTo` path allocates once;
typecheck + full mux suite stay green with byte-identical golden outputs.

#### 5.2 Rename & split the `flac-mkv-mux.ts` god-file

Move `muxSingleTrackMp4`/`muxPreparedMp4PacketStreams` (`flac-mkv-mux.ts:79-153`) into
`mp4-prepared-mux.ts`; move `muxSingleTrackOggAudio` (`:176-188`) into an `ogg-prepared-mux` wrapper;
keep WebM/MKV/FLAC-in-MKV in a `webm-prepared-mux.ts`. No file named for FLAC+MKV should export MP4 or
Ogg muxers.
**Acceptance:** each prepared module imports/exports exactly one container family; `runMux` imports MP4
wrappers from `mp4-prepared-mux.ts`, not `flac-mkv-mux.ts`; eager-kernel + default/probe bundle sizes
stay within their caps (`docs/measured-evidence.md` records 49.66 kB / 50.00 kB for the FLAC-MKV fast path); all
`mux/*` goldens byte-identical.

#### 5.3 Replace `runMux` nested ternaries with a declarative route table

`mux-runner.ts:49-97` decides the route with `target === 'mp4' || target === 'mov'` literals in five
places. Replace with `const MUX_ROUTES: Record<Container, MuxRoute>` where `MuxRoute` names
`{ native?, prepared, streamOnly? }`, and iterate.
**Acceptance:** `runMux` contains no bare container string-equality for routing; a test enumerates every
token in `CODEC_MUX_CONTAINERS` (`src/api/codec-routing.ts:21`) and asserts each resolves to a concrete
route (or a typed `CapabilityError` with `op:'mux'` and `tried:[token]`), proving the table is total.

#### 5.4 Give prepared muxers incremental (streaming) output

Prepared/native paths emit the whole container as one `streamFromBytes` chunk
(`flac-mkv-mux.ts:762`, `native-packet-mux.ts:59-64`) and fully buffer packets
(`packetValues`/`packetChunks`). For a `'stream'` sink this defeats backpressure and pins peak RSS to
output size. Add incremental cluster/fragment emission (mediabunny's append-only guarantee: byte offset
of each write == bytes previously written) for `'stream'` sinks; keep the single exact-owned buffer only
for the buffered-Blob path (ADR-268).
**Acceptance:** muxing N=100k packets into a `'stream'` sink yields > 1 output chunk and peak RSS grows
sub-linearly vs. N; the buffered Blob path still produces exactly one `ArrayBuffer`; goldens unchanged.

#### 5.5 Extend native zero-copy fusion to WebM/MKV and Ogg

`muxNativeFirstPartyPacketStreams` covers only MP4/MOV (`native-packet-mux.ts:22`). The WebM/Ogg swap
rows still construct per-packet host objects at the public boundary — `docs/measured-evidence.md` records
`mux/swap_audio_video_with_opus_to_mkv` at 202.4 ms vs. mediabunny 53.1 ms (3.6×) and
`mux/video_plus_audio_to_mp4` at 228.7 ms vs. 49.8 ms (4.2×), attributed to that copy. Add native
`NativePacketChunk` fusion for the WebM/MKV and Ogg writers.
**Acceptance:** the MKV/Ogg fusion path constructs **zero** `Encoded*Chunk` objects (assert via a
provenance-claim spy), a fresh multi-sample benchmark beats the recorded 202.4 ms with oracle PASS
(packets/frames/colour/HDR preserved), and DTS/alpha survive byte-exact.

#### 5.6 Prove the faststart one-pass `moov` (no double serialize)

`docs/measured-evidence.md` records `mux/h264_aac_to_mov` as a 1.52× loss from "faststart serializing the
complete `moov` twice." The current writer serializes `moov` once with zero offsets then **patches
offsets in place** (`src/drivers/mp4/write.ts:944-950`), which should be one pass. Confirm and lock it.
**Acceptance:** an instrumented run counts exactly **one** `moov(...)` serialization for a faststart mux;
`mux/h264_aac_to_mov` bench median beats mediabunny fresh; output byte-identical to the two-pass golden.

#### 5.7 VFR monotonic-DTS guard at the mux seam (ADR-191)

A muxer must not derive DTS from summed *nominal* durations (fabricates PTS<DTS reorder,
`docs/measured-evidence.md`: 626 VFR frames). Add an assertion at the packet→sample-table conversion that DTS is
monotonic and never exceeds the packet's PTS unless a real reorder (`dtsUs < ptsUs`) was supplied.
**Acceptance:** the ADR-191 oracle — mux 626 VFR frames with nominal 16667µs duration + cadence
corrections — parses back with **zero** PTS/DTS inversions and one keyframe (the recorded fix result).

#### 5.8 Standardize the mux `CapabilityError`/`MediaError` shape

`mux-runner.ts:43-48` throws `CapabilityError('capability-miss', ..., { op:'mux', tried:[target] })`
while the prepared muxers throw `{ op:{ op:'mux', container }, tried:[...] }`
(`mp4-prepared-mux.ts:88-97`, `mpegts-prepared-mux.ts:33-51`, `flac-mkv-mux.ts:194-215`). Pick the
structured `op` object form everywhere.
**Acceptance:** a test drives every mux rejection (no muxer, wrong container, fragmented-unsupported,
zero tracks, illegal codec) and asserts each error's `op` is a structured `{ op:'mux', container?, codec?
}` with a non-empty `tried[]`.

#### 5.9 Relocate demux-side helpers out of `mp4-prepared-mux.ts`

`mp4PacketInfoFromBytes`/`mp4PacketInfoFromUrl` (`mp4-prepared-mux.ts:192-229`) probe packet-info; they
belong to S09 (probe/demux), not a mux module.
**Acceptance:** `mp4-prepared-mux.ts` imports no `readMovie`/`mp4PacketInfoTable`; the probe helpers live
under demux ownership and their tests move with them; mux bundle shrinks or is unchanged.

#### 5.10 Assert DTS-ordered interleave from the concurrent generic drain

The generic path drains all tracks concurrently into a shared muxer (`mux-runner.ts:116-122`); writes
arrive interleaved and the muxer must order by DTS (MP4 sample tables per track; WebM Clusters in
decode order; TS PES by PTS/DTS). Add a golden proving correct cross-track interleave.
**Acceptance:** muxing two tracks with interleaved DTS produces a spec-valid layout (WebM Cluster block
order / MP4 `stco`+`ctts`) that a reference demux reads back with `maxPtsDrift == 0` and correct
per-track packet counts.

### S15 — Remux

Source: [`docs/operations/remux.md`](docs/operations/remux.md) · owned code + rationale in the doc.

1. **Kill the container-token capability leak in the runner.** Replace the literal `opts.to === 'webm' |
   'mkv' | 'ts'` and `opts.to === 'mp4' | 'mov'` branches (`remux-runner.ts:107, 259, 266`) with
   capability queries the driver advertises (extend the pattern of `streamCopyTargets`/`streamCopy` on
   `ContainerDriver`, e.g. an optional `remuxFastPaths` or per-target flag).
   *Acceptance:* a fake `ContainerDriver` that advertises a native cross-format copy to a brand-new
   container token is routed correctly through `runRemux` with **zero edits** to `remux-runner.ts`; a grep
   asserts no target container string literal remains in the routing tree.

2. **Remove the `CONTAINER_MIME` map; source MIME from the driver/registry.** Delete
   `remux-runner.ts:17-35` and have `mimeOptions` (`421-424`) look up the output mime from the resolved
   target driver.
   *Acceptance:* for each supported target container, a test asserts `(output as Blob).type` equals the
   driver-declared mime; a grep proves no second hardcoded container→mime table exists in `src/api/`.

3. **Extract `runRemux`'s decision tree into a pure `planRemuxRoute`.** Return a discriminated union
   `{ kind: 'metadata-direct' | 'mp4-blob-direct' | 'mp4-bytes-direct' | 'stream-copy' | 'ts-packet-info'
   | 'webm-streaming' | 'seam' }` computed from `(container.formats, container.streamCopy?, opts,
   metadata)`; `runRemux` becomes a thin dispatcher. This dissolves the five overlapping booleans
   (`remux-runner.ts:91-229`).
   *Acceptance:* a table-driven Node test enumerates `(formats, opts)` → expected `kind` for ≥15 cases
   (same-family, cross-family, tags-only, trackSelect subset vs full, fragmented, >1 GiB); the planner is
   tested with no I/O and `runRemux` has no remaining nested `if` deeper than one level.

4. **De-duplicate codec-string parsing out of `semantic-stream-copy.ts`.** `videoFamily`/`audioFamily`/
   `videoBitDepth` (`203-243`) must delegate to the single canonical codec-string parser (the codec-strings
   driver module) instead of re-implementing the `avc1`/`hev1`/`vp09`/`av01` regexes.
   *Acceptance:* a property test feeds identical strings (`avc1.6e0033`, `hev1.2.4.L120`,
   `vp09.02.10.10`, `av01.0.04M.10`) to both `semantic-stream-copy` and the codec-strings module and
   asserts identical `family` + `bitDepth`; a grep proves only one codec-string regex table remains.

5. **Generalize the MP4→TS packet-info path off the `'mp4'` literal.** Parametrize
   `tryRemuxPacketInfoToMpegTs` on `container.formats`/`container.packetInfo` capability and use
   `src.mimeHint` instead of the literal `'video/mp4'` (`mpegts-packet-info-remux.ts:60, 125`) so MOV→TS
   uses the same fast path.
   *Acceptance:* a MOV→TS remux of a real AVCC+AAC `.mov` routes through the packet-info path (assert via a
   spy that `container.packetInfo` was called and no generic `demux()` seam ran) and produces a valid TS.

6. **Prove/implement bitstream framing transforms (exemplar parity with `h264_mp4toannexb` /
   `aac_adtstoasc`).** The MP4→TS path `subarray`-copies packet payload verbatim
   (`mpegts-packet-info-remux.ts:97-104`), but MP4 stores H.264 as AVCC length-prefixed NAL units and raw
   AAC AUs, whereas MPEG-TS requires **Annex B start codes** and **ADTS headers**. Verify `ts-write`
   performs both transforms; if it does not, the output is invalid. (The inverse — per-PID ADTS deframing
   into raw AUs — is already fixed for TS→MP4, ADR-184, `measured-evidence.md`; the MP4→TS direction needs the same
   rigor.)
   *Acceptance:* a golden test remuxes a real AVCC+raw-AAC MP4 to TS and a structural oracle (ffprobe /
   NAL scanner) asserts (a) H.264 NAL units are Annex-B start-code framed, (b) each AAC AU carries a 7-byte
   ADTS header, and (c) the output is **not** a byte-passthrough of the MP4 payload (checksum differs).

7. **Single shared bounded-materialization ceiling.** Fold `REMUX_BUFFER_ALL_MAX_OUTPUT_BYTES`
   (`remux-runner.ts:15`) into one engine-wide `MAX_BUFFERED_OUTPUT_BYTES` policy referenced by
   remux/mux/trim, aligned with the harness ADR-053/ADR-102 decline.
   *Acceptance:* a source above the ceiling (non-webm target) raises
   `CapabilityError('capability-miss', … 'over buffer limit')` and allocates no whole-output buffer (assert
   peak RSS delta ≪ source size); the same constant is imported by ≥2 other runners.

8. **Nail the anti-passthrough invariant (ADR-155).** The MP4 blob/byte-direct fast paths already run a
   validation demux (`remux-runner.ts:119-123, 143-147`); make the guarantee a first-class test: a same-
   container no-op remux must return either a genuine re-layout or the exact bytes *only after* structural
   - sample-range validation, never a raw passthrough.
   *Acceptance:* (a) a bit-flip inside `mdat` makes the validation `demux()` throw (no output emitted);
   (b) an `ftyp`-only-flipped input is rejected as a cheat by the anti-cheat oracle; (c) a legitimate
   MOV→MP4 brand rewrite passes only after sample-range validation.

9. **Fold the redundant `metadata !== undefined` re-guard.** `remux-runner.ts:109` re-checks a condition
   already implied by `directMp4MetadataCandidate`; carry `metadata` non-optionally on the route union
   (item 3) so TS narrowing is structural.
   *Acceptance:* no `if (<candidate> && metadata !== undefined)` double-guard remains; typecheck passes
   with the tightened union.

10. **Bound the trackSelect+metadata buffering path.** The full-source materialize-then-validate route
    (`remux-runner.ts:181-223`) defeats streaming for large `trackSelect` inputs.
    *Acceptance:* a `>ceiling` source with `trackSelect` raises a typed decline rather than buffering the
    whole input; a genuine subset selection produces output whose structural oracle shows the dropped
    track's packets are **absent** and the kept track's coded bytes are **byte-identical** to source.

### S16 — Trim

Source: [`docs/operations/trim.md`](docs/operations/trim.md) · owned code + rationale in the doc.

1. **Collapse the `runTrim` ladder into a declarative route table.** Replace the nine inline branches
   (`src/api/trim-runner.ts:109`–`:192`) with an ordered `{ guard, execute }` strategy list and one
   shared tail. **Acceptance:** a table test enumerates every route and asserts (a) exactly one guard
   fires per `(container, mode, capabilityFlags)` tuple, and (b) `materialize`/`toBlob`/`mimeOptions`
   appears once in the module (grep count == 1). Existing `trim-accurate.test.ts` / `trim-robustness.test.ts`
   stay green.
2. **Turn `AUDIO_PACKET_TRIM_CONTAINERS` into a driver capability flag.** Add
   `ContainerDriver.supportsAudioPacketTrim?: boolean` and route on it, deleting the module Set
   (`src/api/trim-runner.ts:26`). **Acceptance:** registering a fake container driver with the flag
   set routes through `trimAudioPacketsViaSeam` **without editing the runner**; a grep proves zero
   container string-literals in `runTrim`'s routing predicates.
3. **Replace the `formats[0]` target guess with an explicit container decision.**
   (`src/api/trim-runner.ts:107`.) Same-container trim must target the *source* container even when a
   driver lists another format first. **Acceptance:** a fake driver whose `formats[0]` differs from
   the sniffed source container still trims to the source container; assert output MIME == source
   container MIME.
4. **Make `accurate` audio sample-exact.** Route the accurate audio cut through a boundary-splitting
   transform built from `restampAudioDataRange`/`trimAudioGaplessFrameStream`
   (`src/api/trim-streams.ts:528`, `:424`) instead of whole-packet copy
   (`src/api/trim-runner.ts:358`) / whole-frame drop (`:377`). **Acceptance:** a 48 kHz fixture with
   a cut landing mid-packet yields `outputSampleCount == round((end - start) * sampleRate)` with a
   **0-sample** delta (today it can be off by up to one packet). Add the oracle to `trim-accurate.test.ts`.
5. **De-duplicate `trimPacketCopyTrack` / `trimAudioPacketInfoTrack`** (`src/api/trim-streams.ts:86`–`:100`).
   **Acceptance:** one exported function; both call sites reference it; no test change.
6. **Hoist `trimVideoEncodeTarget` into the shared implicit-bitrate policy** (ADR-084/123) so trim
   and convert cannot diverge (`src/api/trim-streams.ts:309`). **Acceptance:** a single bitrate
   function is called by both entrypoints; a test asserts identical `VideoTarget` for identical
   `(width, height, fps, sourceBitrate)` across trim and convert.
7. **Promote `packetInfoTable()` onto the `Demuxer` contract** and delete the
   `DemuxerWithPacketInfoTable` cast (`src/api/trim-runner.ts:50`, `:299`). **Acceptance:** `tsc`
   passes with the cast removed; a demuxer without the method falls back to `startAtSeekKeyframe`
   (assert the fallback fires via a spy).
8. **Author an MP4 `elst` edit list for keyframe video trim** so the pre-`start` GOP is
   decoded-but-hidden, giving a frame-exact playback start with no re-encode (the §3 target).
   **Acceptance:** a keyframe trim whose `start` lands mid-GOP produces an MP4 whose first *presented*
   frame is at `start` (probe the `elst` `media_time`/`segment_duration`), while byte-identical coded
   samples prove no re-encode occurred. Log ADR first (edit-list vs re-encode fidelity trade).
9. **Centralize `CONTAINER_MIME`** with the engine `mimeOpts` map (`src/api/trim-runner.ts:30`).
   **Acceptance:** one MIME source of truth; a test iterating all containers asserts trim and convert
   emit identical MIME per container.
10. **Lock the VFR trailing-duration clamp and cancel frame-safety with dedicated oracles.**
    **Acceptance (VFR):** a VFR fixture whose last kept frame's declared duration overruns `endUs`
    yields a muxed final-sample duration == `endUs - lastFrameTs` exactly (pins
    `src/api/trim-streams.ts:394`). **Acceptance (cancel):** an abort injected after the first decoded
    frame in `trimViaCodec` leaves **zero** un-closed `VideoFrame`/`AudioData` (frame-leak counter
    oracle) and calls `demuxer.close()` exactly once (`src/api/trim-runner.ts:398`–`:404`).

### S17 — Audio DSP & PCM Convert

Source: [`docs/operations/audio-dsp.md`](docs/operations/audio-dsp.md) · owned code + rationale in the doc.

1. **Fix the s24 decode perf loss.** Give `decodePcm` (Float64) the same raw-byte s24 (and s16/s32) fast
   path already in `decodePcmToInterleavedF32` (`src/dsp/pcm.ts:189`), replacing the per-sample
   `DataView.getUint8×3` in `readSample` (`src/dsp/pcm.ts:78`) — or route both through one shared
   byte-level reader.
   **Acceptance:** re-run `audio-dsp/throughput_decode_s24` on `rotated:03.wav`; assert aibrush median
   ≤ mediabunny (currently 58.3 ms vs 27.7 ms, `measured-evidence.md`) and peak memory within the rival's;
   `pcm-corpus.test.ts` + `golden.test.ts` stay bit-exact.

2. **Bound `POLYPHASE_CACHE`.** Replace the unbounded module-global `Map` (`src/dsp/resample.ts:112`)
   with a bounded LRU (small `N`, e.g. 8–16 rate pairs) *or* make it engine-instance-scoped so it is not
   shared global process state.
   **Acceptance:** a unit test builds >N distinct rate pairs and asserts `cache.size ≤ N` (eviction
   happens); the longform 44.1k→16k resample still returns checksum 439301100 (`measured-evidence.md`, ADR-058)
   proving warm-path correctness is unchanged.

3. **Fix the misleading resample-reject message.** In `applyPcmTransform` (`src/drivers/pcm-transform.ts:207`)
   the `resample:'reject'` path must not claim resample "needs the WASM/WebAudio tail." Reword to state
   the real cause (stream-copy policy disallows a rate change), keeping the `capability-miss` code and
   `op`/`tried`.
   **Acceptance:** a unit test asserts the thrown `CapabilityError.message` does not contain "WASM" or
   "WebAudio" and does name the disallowed rate change; the copy-path routing test still rejects.

4. **De-duplicate `clonePlanar` / audio construction.** Hoist one `clonePlanar`, `mapSamples`, and a
   `buildAudio({sampleRate,channels,frames,planar})` helper into `pcm.ts`; delete the three copies
   (`src/dsp/mix.ts:22`, `src/dsp/fade.ts:46`, `src/dsp/dynamics.ts:76`) and the inline slices
   (`src/dsp/resample.ts:360`).
   **Acceptance:** `grep -c "function clonePlanar" src/dsp/*.ts` returns 1 (in `pcm.ts`); the full
   `src/dsp/*.test.ts` suite stays green with no behavioral change.

5. **Decide & make explicit the integer-rounding policy.** The benchmark oracle notes state
   round-**half-to-even** at the LSB for `gain_minus6db_s16` / `pcm_f32_to_s16`
   (`../media-test/src/scenarios/audio-dsp/index.ts`), but `writeSample` uses `Math.round` (half-away-
   from-zero for positives, toward +∞) (`src/dsp/pcm.ts:110-130`). These differ on exact halves. Either
   switch `writeSample` to round-half-to-even, or bake goldens under the documented policy and record the
   choice.
   **Acceptance:** a table-driven unit test asserts the rounding of exact-half inputs (e.g. ±0.5 LSB) for
   u8/s8/s16/s24/s32 matches the chosen policy; `pcm_f32_to_s16` golden regenerated to match; ADR logged.

6. **Add optional dither for integer downconversion (beat `aformat`).** ffmpeg offers
   triangular/rectangular/high-pass dither on narrowing; today `writeSample` is plain round (no dither,
   `src/dsp/pcm.ts:101`). Add an opt-in TPDF dither at the s24→s16 / f32→s16 boundary, off by default
   (goldens require deterministic output).
   **Acceptance:** with dither off, `golden.test.ts` is unchanged (bit-exact); with dither on (fixed
   seed), a unit test asserts the quantization-noise spectrum is whitened (no correlated distortion at a
   test-tone harmonic) and output is deterministic for the seed.

7. **Generalize `remix` toward a channel matrix (beat `rematrix`).** Today `remix` is a hardcoded switch
   of 5 pairs (`src/dsp/mix.ts:91`); ffmpeg rematrixes arbitrary layouts. Introduce a coefficient-matrix
   remixer (BS.775 for the standard down/upmixes, identity/duplicate for trivial cases) so e.g. 5.1→mono,
   quad, or 7.1 are first-class; keep the typed `CapabilityError` for genuinely undefined layouts.
   **Acceptance:** new cells `downmix_5_1_to_mono` and one unsupported layout: the first matches a
   BS.775-derived golden; the second raises `CapabilityError('capability-miss', …)`; existing 5 pairs
   stay bit-exact.

8. **Split `filters/audio-dsp.ts` pure-dispatch from stream-wiring.** Move `applyAudioFilter` /
   `createStatefulStage` (`src/filters/audio-dsp.ts:77,98`) into a `src/dsp`-side pure module and keep
   only the `TransformStream` wiring + driver registration in `filters/`.
   **Acceptance:** the pure dispatch has Node unit tests with no `v8 ignore` blocks; `filters/audio-dsp.ts`
   shrinks to stream+registration; the eager-bundle budget guard (≤50 kB kernel, `measured-evidence.md`) is not
   regressed.

9. **True-peak / LUFS follow-up (beat `loudnorm`).** `normalizeRms` is a cheap RMS proxy and `limit` is
   sample-peak, not inter-sample (ISP) — documented at `src/dsp/dynamics.ts:11,17`. Add an oversampled
   true-peak limiter (reuse the resampler for 4× analysis) and a K-weighted LUFS normalize, opt-in.
   **Acceptance:** a unit test on a signal whose reconstructed peak exceeds its sample peak asserts the
   true-peak limiter holds the 4×-oversampled peak ≤ ceiling (the sample-peak limiter does not);
   ADR logged.

10. **Guard resample abort latency & irrational-ratio fallback.** The fallback path
    (`src/dsp/resample.ts:308`) is O(outFrames·tapCount) and used when `phaseCount > 4096` or `inRate`
    non-integer; ensure the abort check (`src/dsp/resample.ts:321`) bounds latency there too.
    **Acceptance:** a test resamples a coprime pair (e.g. 44100→44101, forcing the fallback) under an
    `AbortSignal` aborted mid-run and asserts it throws `MediaError('aborted')` within one
    `ABORT_CHECK_INTERVAL` window; output for a completed run matches a golden.

### S18 — Video Filters

Source: [`docs/operations/video-filters.md`](docs/operations/video-filters.md) · owned code + rationale in the doc.

Ordered by impact. Each item states the change and a concrete acceptance oracle.

1. **Fix the geometry color round-trip (top defect).** Make geometric ops transfer-and-range correct:
   preserve the source transfer (a BT.709 source stays BT.709, not `iec61966-2-1`) and limited range, ideally
   by resampling in native YUV planes or in linear light with a range-preserving re-encode, rather than
   letting the `OffscreenCanvas` re-encode to full-range sRGB (`src/filters/gpu-video.ts:272-313`,
   `:606-653`; tag site `src/filters/video-color-space.ts:79-86`).
   *Acceptance:* an in-browser oracle rotates/resizes a limited-range BT.709 fixture and asserts **Y-SSIM ≥
   0.98** vs the ffmpeg reference (today `transcode/h264_rotate_normalize` = 0.946); plus a tag assertion that
   a geometry-only output is **not** retagged to `iec61966-2-1` and keeps `fullRange:false` when the source is
   limited range.

2. **Collapse the triplicated spec-classification + plan resolution into one module.** Extract a single
   substrate-independent plan module owning `isGeometricVideoSpec`/`isColorVideoSpec`, `planDraw`/`planColor`,
   and the `DrawRecipe` type; delete the copies in `cpu-video.ts:334, 359-407` and `gpu-video.ts:73-87,
   151-183`.
   *Acceptance:* `grep` finds exactly one definition of each predicate/planner; a test asserts the CPU and GPU
   recipe for the same `(spec, srcW, srcH)` are `deepStrictEqual`.

3. **Eliminate the second source of truth for color math.** Generate the `COLOR_WGSL` constant block
   (`src/filters/gpu-video.ts:409-420`) from the TS constants in `gpu-uniforms.ts:266-283`, or add a guard
   test that parses each `const X : f32 = N;` out of the shader string and asserts equality with the TS value
   to full precision.
   *Acceptance:* a Node test extracts every WGSL `f32` constant and asserts `===` the TS constant; a browser
   GPU-vs-CPU parity test on PQ/HLG/BT.2020 fixtures asserts SSIM ≥ threshold.

4. **De-duplicate and de-UA-sniff capability detection.** One shared `capabilities` module; express the
   Firefox WebGPU decline (measured SSIM 0.9694 < 0.97, ADR-110) and the Chromium HDR `copyTo` quirk
   (ADR-214) as named capability/quirk flags, not `/Firefox/`/`/Chrome|Chromium|CriOS|Edg/` regexes in
   `supports()` (`src/filters/gpu-video.ts:104-123`, `src/filters/cpu-video.ts:433-441`).
   *Acceptance:* exactly one definition of `chromiumCanvasTonemapAvailable`; a test asserts no `navigator.
   userAgent` read inside any `FilterDriver.supports()`; router still declines WebGPU under the Firefox-SSIM
   quirk flag.

5. **Close queued output frames on readable cancel (frame-lifetime leak).** Add a readable `cancel` /
   drain-and-close path so `VideoFrame`s already enqueued but never read are `close()`d when the consumer
   cancels (`src/filters/gpu-video.ts:727-763`, `src/filters/cpu-video.ts:526-549`).
   *Acceptance:* a test enqueues N outputs, cancels the readable, and asserts `VideoFrame.close()` was called
   exactly N times (spy count == enqueued count), zero leaks.

6. **Resize in linear light (match zscale/zimg).** Change `resizeBlitToRgba` (`src/filters/cpu-video.ts:284-299`)
   and the GPU sampling so downscales resample after EOTF (linear), then re-encode — reducing ringing/aliasing
   the way zimg does.
   *Acceptance:* a downscale oracle on a high-contrast edge fixture asserts lower energy error than the current
   gamma-space resample and SSIM parity with a `zscale=...:t=linear` reference (exact threshold `UNVERIFIED`
   pending a baked golden).

7. **Give the CPU path a real cross-substrate parity oracle.** Add a browser harness that renders the same
   `(spec, fixture)` on WebGPU, Canvas2D, and CPU and compares pixels — replacing self-parity
   (`src/filters/cpu-video.ts:29-31, 250-277`).
   *Acceptance:* pairwise SSIM ≥ threshold across the three substrates on the geometry + colorspace fixtures
   (threshold `UNVERIFIED` pending goldens).

8. **Make tonemap operator/target configurable, or delete the dead operator.** Either extend the `tonemap`
   `FilterSpec` (`src/contracts/driver.ts:512`) with an operator/peak and make `planTonemap`
   (`src/filters/gpu-uniforms.ts:466-474`) able to select Hable, or remove `tonemapHable`
   (`gpu-uniforms.ts:363-373`) + WGSL `hable` (`gpu-video.ts:474-485`).
   *Acceptance:* a plan test proves both reinhard and hable are reachable from a spec; **or** the Hable code is
   gone and coverage stays green with no orphaned tested-but-unreachable branch.

9. **Split the `gpu-video.ts` god-file (868 lines).** Extract `wgsl/geometry.wgsl.ts`, `wgsl/color.wgsl.ts`,
   `canvas2d-renderer.ts`, `webgpu-renderer.ts`, `filter-stream.ts`, `capabilities.ts` from
   `src/filters/gpu-video.ts:104-865`.
   *Acceptance:* no single filter source file exceeds ~300 lines; the public exports (`webgpuVideoFilterDriver`,
   `canvas2dVideoFilterDriver`, `GpuVideoFilterModule`) are unchanged (import-surface test green).

10. **Add an explicit identity/no-op geometry passthrough recipe.** A resize/pad/rotate-0 whose output equals
    the source dims still round-trips through RGBA today (`exactBlitToRgba`, `src/filters/cpu-video.ts:236-248`;
    GPU still draws) — the identity round-trip is the SSIM 0.9735→0.9943 case (ADR-189, measured-evidence.md).
    Introduce a `{ kind: 'identity' }` recipe that the stream passes the input frame through unchanged
    (close-once preserved).
    *Acceptance:* a plan test that resize/pad/rotate-0 equal to source dims yields `identity` and the stream
    enqueues the source frame with no draw; measured output SSIM == 1.0.

11. **Document/benchmark `OUTPUT_CANVAS_POOL_SIZE` and the Canvas2D smoothing knob.** Tie the ring depth
    (`src/filters/gpu-video.ts:228`) and `imageSmoothingQuality` (`:289`) to measurements rather than magic
    values.
    *Acceptance:* a benchmark shows ring depth > 1 hides snapshot latency (throughput ≥ single-canvas
    baseline) and records the per-UA smoothing choice; regression fails if throughput drops below the recorded
    floor.

### S19 — Encryption / Decrypt

Source: [`docs/operations/encryption.md`](docs/operations/encryption.md) · owned code + rationale in the doc.

1. **Unify MP4 CENC on the whole-file engine; delete `decryptCencTrack`.** Route *all* `cenc`/`cens`/
   `cbcs` through `decryptCencFile` (`cenc.ts:1319`) and remove `decryptCencTrack`/
   `decryptAndVerifyCencTrack` (`mp4-driver.ts:3149`/`3290`), keeping the pipelined decode-verify (Delta 7).
   *Acceptance:* `encryption/cbcs_decrypt` and `cenc_ctr_decrypt` pass via the single engine; a new test
   asserts the **flat** (non-fragmented) path output is **byte-identical** to the openssl/Bento4 twin
   (extend `cbcs.test.ts:958`); `grep -R decryptCencTrack src` returns nothing.
2. **Thread `AbortSignal` into the CENC engine.** Add `signal?: AbortSignal` to `DecryptFileOptions`
   (`cenc.ts:685`) and check it between samples in `forEachSampleBounded` (`cenc.ts:338`); on abort,
   zero the written region of `out` before throwing `MediaError('aborted')`.
   *Acceptance:* a test aborts after N of M samples and asserts (i) a typed `MediaError('aborted')`,
   (ii) no clear bytes leak (the touched `out` range is zeroed), mirroring
   `assertHlsSegmentClearNotAborted` (`hls-full-segment-decrypt.ts:120`).
3. **Route MP4 `hls-aes128` through the shared helper.** Replace `decryptHlsSegmentMp4`
   (`mp4-driver.ts:3362`) with `decryptHlsAes128ContainerSegment(src, o, { driverId:'mp4',
   containerLabel:'MP4', validate })` (`hls-full-segment-decrypt.ts:149`), matching ADTS/MPEG-TS.
   *Acceptance:* MP4 `hls-aes128` with a pre-aborted signal throws `MediaError('aborted')`; a spy proves
   `key`/`iv` are `fill(0)`-zeroed; the passing twin's byte output is unchanged.
4. **Lift `CONTAINER_MIME` out of the API layer.** Move the container→MIME map (`decrypt-runner.ts:9`)
   into the driver/registry (a driver already owns `formats`); the runner asks the driver for its output
   MIME. *Acceptance:* `decrypt-runner.ts` contains no literal MIME table; decrypt-to-Blob still stamps
   `video/mp4` / `video/mp2t` / `audio/aac` correctly; `grep CONTAINER_MIME src/api` is empty.
5. **Make typed `CapabilityError` the *sole* NA signal (no message-regex).** (measured-evidence.md_.) The harness
   must classify NA on `CapabilityError`, not on a message-matching regex, so a real capability sentence
   can't silently become NA instead of FAIL. *Acceptance:* a decrypt throwing `CapabilityError` ⇒ NA; a
   decrypt throwing `MediaError('demux-error')` ⇒ FAIL; a harness test asserts both classifications.
6. **Resolve fMP4 SAMPLE-AES / SAMPLE-AES-CTR: implement with real vectors, or keep a typed non-claim.**
   (measured-evidence.md_: only `cenc/cens/cbcs`, `hls-aes128`, TS `hls-sample-aes` are implemented.)
   *Acceptance (interim):* `decrypt({scheme:'hls-sample-aes'})` on an **fMP4** segment throws a typed
   `CapabilityError` (never a wrong result). *Acceptance (if implemented):* recover an independently
   AES-CBC-encrypted fMP4 twin **byte-exact** through `media.decrypt`.
7. **Pipeline the fragmented decrypt→decode-verify.** The flat path already overlaps via the ordered
   gate (`mp4-driver.ts:3219`); the fragmented path decrypts the whole file, re-reads it, then
   decode-verifies serially (`mp4-driver.ts:4430`–`4468`). Feed each recovered access unit to the
   validation decoder through the existing `SampleDecryptedCallback` (`cenc.ts:583`).
   *Acceptance:* a benchmark shows fragmented-CENC wall ≈ `max(decrypt, decode)` (not the sum);
   `cenc-graceful-rotation.test.ts` still rejects the structurally-valid IV mutation.
8. **Add a WebCrypto-miss conformance test.** `subtle()` (`aes.ts:40`) throws `CapabilityError` when
   `crypto.subtle` is absent, but no test exercises it. *Acceptance:* with `globalThis.crypto.subtle`
   stubbed `undefined`, every scheme's `decrypt` throws `CapabilityError('capability-miss', … op:'decrypt')`
   — proving there is **no** silent JS-cipher fallback (contrast hls.js `aes-decryptor.ts`).

### S20 — Metadata

Source: [`docs/operations/metadata.md`](docs/operations/metadata.md) · owned code + rationale in the doc.

1. **Add the symmetric read dispatcher.** Create `readMetadataTags(bytes, container)` in
   `metadata-rewrite.ts` that lazy-`import()`s the one `read*` and raises
   `CapabilityError('capability-miss')` for unknown containers, mirroring the write dispatch
   (`metadata-rewrite.ts:12`). **Acceptance:** unit test asserting `readMetadataTags(bytes, c)` equals
   the direct `read*(bytes)` for every `c ∈ {mp4,mov,webm,mkv,mp3,flac,ogg,wav,aiff,caf}`, and that an
   unsupported container throws `CapabilityError` with `code==='capability-miss'` and `detail.tried`.
2. **Kill ID3 `PRIV` write-only output OR make it read.** Either stop emitting `PRIV`
   (`id3.ts:120`) and rely on `TXXX`, or teach `readMp3Id3Tags` to decode `PRIV`. **Acceptance:**
   `readMp3Id3Tags(writeMp3Id3Tags(mp3, {custom:'v'}))` returns exactly one `custom→'v'`, and a
   byte-count assertion proves no unreadable frame is emitted (SHA-256 golden via
   `src/util/digest.ts:7`).
3. **Make WAV `bext` round-trip or drop it.** Either parse `bext` in `readWavTags`
   (`pcm-tags.ts:272`) into `description`/`artist`/`date`, or stop writing it (`pcm-tags.ts:260`).
   **Acceptance:** `readWavTags(writeWavTags(wav, tags))` recovers every field the writer persisted (no
   silently-dropped chunk), asserted field-by-field.
4. **Normalize CAF keys through the Vorbis dialect.** Route `cafInfoBody`/`readCafInfoBody`
   (`pcm-tags.ts:355`,`:373`) through `vorbisKeyFor`/`publicKeyFromVorbis` like the other containers.
   **Acceptance:** a cross-container test asserting the *same* public key surface out of
   `readCafTags`/`readWavTags`/`readMkvTags`/`readMp4Tags` for identical input tags.
5. **Strip trailing ID3v1/APE before writing ID3v2.** Extend `writeMp3Id3Tags` (`id3.ts:148`) to detect
   and remove a trailing 128-byte `TAG` and APEv2 footer so re-read is unambiguous. **Acceptance:** feed
   an MP3 with a stale ID3v1 `TAG`; assert `readMp3Id3Tags(output)` reflects only the new tags and the
   `TAG` bytes are gone (offset assertion + digest).
6. **Extract a shared byte/EBML utility layer; remove metadata→driver imports.** Move `ascii`,
   `readU32le/be`, `writeU32le/be`, `u32le`, `fourcc(Bytes)`, `concatBytes`, `readVint`, `flacOffset`,
   and one canonical CRC-32 into a shared util the metadata modules and drivers both import; delete the
   local copies (`id3.ts:34`, `ogg-vorbis-comment.ts:39`,`:46`,`:308`, `pcm-tags.ts:68`,
   `remux-metadata.ts:336`) and the upward imports (`vorbis-comment.ts:2`, `matroska-tags.ts:2`).
   **Acceptance:** `grep` proves no `from '../drivers/` import remains under `src/metadata/`; all tag
   round-trip tests stay green; the eager bundle does not grow (`(measured-evidence.md)` budget guard).
7. **Split `pcm-tags.ts` by container.** Break WAV / AIFF / CAF into three modules (or push each into
   its S27 driver), each lazy-imported by the read/write dispatchers. **Acceptance:** three files,
   unchanged public behavior, and dispatch imports exactly one per container; existing WAV/AIFF/CAF
   digests unchanged (write_wav_info_bext 0.254 ms, write_aiff_tags 0.252 ms, write_caf_info 0.053 ms
   remain the perf baseline `(measured-evidence.md)`).
8. **Adopt the typed `MediaTags` model (cover art + numerics + `date` + `raw`).** Introduce the
   mediabunny-shaped structured type ([MetadataTags](https://mediabunny.dev/api/MetadataTags)) as the
   canonical model, up-converting the flat `Record<string,string>` (`tag-map.ts:3`) at the boundary; add
   cover-art encode/decode (`APIC`/`covr`/`METADATA_BLOCK_PICTURE`/Matroska attached image) and typed
   `trackNumber`/`discNumber`/`date`. **Acceptance:** a fixture with JPEG cover art round-trips through
   MP4 `covr` and FLAC `METADATA_BLOCK_PICTURE` with the image bytes bit-identical (SHA-256 via
   `src/util/digest.ts:7`), and `trackNumber` survives as a number, not a stringified `parseInt`
   (`mp4-tags.ts:354`).
9. **Two-region (head+tail) splice for non-MP4 backpressure.** For FLAC/Ogg/WAV/AIFF/CAF, splice the
   rewritten header region against a `Blob`-sliced/streamed untouched media tail instead of collecting
   the whole output into one `Uint8Array` (`remux-metadata.ts:126`). **Acceptance:** a large-file tag
   write shows peak RSS bounded to header size + delta (not whole-file), measured like the MP4 Blob path
   (Blob-direct RSS +0.41 MiB vs full-remux `(measured-evidence.md)`); output digest unchanged.
10. **Preserve-and-prove the untouched byte oracle for every writer.** Bake, for each container, a
    strict "bytes-elsewhere-unchanged" oracle: rewrite tags, then assert every non-tag region is
    byte-identical to source (the whole-file digest changes only within the tag structure). This
    hardens the `(measured-evidence.md)` "bytes elsewhere unchanged" intent (session8-metadata-write) and guards
    the MP4 `tkhd` rotation matrix and Matroska `Colour` from accidental disturbance. **Acceptance:**
    per-container region-diff test proving only the tag structure (and, for MP4, `moov` size + shifted
    `stco`/`co64`) differs; all other bytes SHA-256-equal.

### S21 — Performance Methodology

Source: [`docs/operations/performance.md`](docs/operations/performance.md) · owned code + rationale in the doc.

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

### S22 — Robustness

Source: [`docs/operations/robustness.md`](docs/operations/robustness.md) · owned code + rationale in the doc.

Each item: the change, the `path:line` anchor, and a concrete acceptance oracle.

1. **Wire the corrupt matrix past parsers — decode / mux / remux / decrypt.** Extend
   `parser-robustness.test.ts:38` with a second table that feeds `corruptMatrix` (family per source) to a
   WebCodecs‑backed `decodeFrames`, a muxer, `remux-runner`, and `decrypt-runner`.
   *Acceptance:* for every table, `escapes(runMatrix(...))` is empty (`corrupt.ts:765`), **and** for the
   decode path a frame‑lifetime counter asserts `closed === produced` (every `VideoFrame`/`AudioData`
   `close()`d exactly once) even when decode errors mid‑stream. A leaked/double‑closed frame fails the test.

2. **Add a memory/allocation ceiling to the watchdog (make class (e) real).** Give `runCase`
   (`corrupt.ts:716`) a bounded‑allocation guard (Node: `process.memoryUsage().heapUsed`/`arrayBuffers`
   delta or `--max-old-space-size` child; browser: `performance.measureUserAgentSpecificMemory` where
   available) and classify an over‑budget case as `crash`/`hang`. Add a `memory-bomb` column: an
   `oversize-field` whose declared size, if honored, would allocate `> ceiling`.
   *Acceptance:* the new case is caught as a non‑`ok` outcome **without** OOM‑ing the process; a parser that
   pre‑allocates `declaredSize` bytes before validating it fails, one that validates against `bytes.length`
   first passes. Softens the docstring claim at `corrupt.ts:10` into an enforced check.

3. **Thread `AbortSignal` and test the `aborted` path.** Add an optional `signal` to `runCase`
   (`corrupt.ts:716`) and a fuzz case that aborts a streaming malformed parse mid‑flight.
   *Acceptance:* the rejection is a `MediaError` with `code === 'aborted'` (`errors.ts:17`), classified
   `typed` (not `crash`/`hang`), and the parser stops reading within one budget tick.

4. **Positive‑rejection expectation for structurally‑impossible inputs (kill the un‑failable `ok`).** Extend
   the oracle (`escapes`/a new `expectReject` set, `corrupt.ts:765`) so that for classes `empty`,
   `wrong-magic`, and magic‑overwriting `bitflip-magic`, an `ok` outcome is an **escape**, not a pass.
   *Acceptance:* a deliberately‑lax stub parser that `return`s on foreign magic **fails** the test; the real
   parsers (which reject foreign magic, e.g. `wav/pcm.ts:83`) pass. Proves the oracle *can* fail (integrity
   rule, `corrupt.ts:7`) and closes the 29 WEAK‑GATE robustness cells (`measured-evidence.md` line 80).

5. **Reject malformed containers in the TS tier before any WASM import.** Add a fuzz assertion that a
   corrupt/foreign‑magic input to the public `probe`/`createMedia` path throws `InputError`/`demux-error`
   **without** dynamically importing any `src/codecs/wasm-*` chunk.
   *Acceptance:* spy on dynamic `import()` (or `wasm-loader-runtime`) during a `wrong-magic` run
   (`corrupt.ts:407`); assert zero `wasm-*` imports occurred and the throw is a typed `MediaError`. Enforces
   the routing rule §3.3‑1.

6. **Make WebCodecs decode failure on *malformed* input a `decode-error`, not `capability-miss`.** Today
   `decoderErrorToCapabilityMiss` (`webcodecs-video.ts:240`) maps **every** decoder `DOMException` to
   `CapabilityError('capability-miss')`. For a payload the decoder's own `isConfigSupported` *approved* and
   that then fails on corrupt bytes, that is a **corruption** (`decode-error`/`InputError`), not "this
   browser can't decode this codec." Split the classifier by whether the config was approved.
   *Acceptance:* a zeroed‑span H.264 stream whose config `isConfigSupported` approved throws
   `code === 'decode-error'`; a genuinely‑unsupported profile throws `code === 'capability-miss'`. Both stay
   `MediaError` (graceful‑failure still passes), but the harness can now score corruption as FAIL‑if‑output
   vs. NA correctly. (Log the trade‑off — see OQ‑1.)

7. **Add malformed *encode/mux* input coverage (the write direction).** The matrix only corrupts *read*
   bytes; extend it to reject malformed mux/encode requests: zero coded samples, mismatched dimensions, a
   codec‑config field bit‑flipped.
   *Acceptance:* each throws a typed `mux-error`/`encode-error`/`InputError` and **authors no output**
   (assert the sink received zero bytes) — matching the harness negative cases (`zero-sample mux` in
   `../media-test/src/scenarios/robustness/index.ts`) in the fast Node test.

8. **Enforce an explicit recursion/nesting bound in the real parsers.** `nestedBomb` (DEPTH=800,
   `corrupt.ts:566`) must hit an *engine* depth guard, not a JS stack overflow.
   *Acceptance:* feeding `nestedBomb` to each container driver throws a typed `demux-error` (assert
   `errorName === 'MediaError'` and message names the depth limit) — never `RangeError: Maximum call stack
   size exceeded` — within `CASE_TIME_BUDGET_MS` (`corrupt.ts:706`).

9. **Persist the minimal repro on an escape.** `hexPreview` (`corrupt.ts:757`) is logged but not saved.
   *Acceptance:* on any `escape`, write the exact bytes to a deterministic artifact keyed by the case
   `label` (the seed is deterministic, `corrupt.ts:368`), so a CI failure is reproducible offline by
   replaying that file. Assert the artifact round‑trips to the same `escapes` verdict.

## C. Container drivers

### S23 — MP4 / MOV Driver

Source: [`docs/drivers/mp4.md`](docs/drivers/mp4.md) · owned code + rationale in the doc.

Ordered for a coding agent. Each item names the change, the `path:line`, and a concrete acceptance
oracle. Behavior-preserving refactors (items 1, 4–8) must keep the existing MP4 test suite green and
produce **byte-identical** output on the corpus.

1. **Decompose `mp4-driver.ts` (4,528 lines).** Split into the modules named in §4.1, leaving a thin
   `ContainerDriver` wiring file. *Acceptance:* no owned file over ~800 lines; every extracted module
   has its own unit test; `parse(write(x)) === x` and all existing `roundtrip.test.ts` /
   `mp4.test.ts` / `demux-resident-ranges.test.ts` pass with byte-identical goldens; typecheck + lint
   green; zero `any`.

2. **Remove or engine-scope the two module-global `Map` caches.** `movieParseHandoff`
   (`mp4-driver.ts:168`) and `trimDecodeValidationCache` (`:169`) must not be process-global mutable
   state. Thread the parse-handoff token through the `demux()`/`StageOptions` so a probe→demux handoff
   is explicit, and make the trim-validation memo engine-scoped (or drop it). *Acceptance:* a test
   that runs two independent `createMedia()` engines over the same URL asserts no cache entry from
   engine A is observable to engine B (probe engine B still issues its own range reads); `grep -nE
   'new (Map|Set)\(' src/drivers/mp4/mp4-driver.ts` at module scope returns 0.

3. **Close the capability leak: stop constructing `VideoDecoder` in the driver.** Replace the inline
   decoders (`mp4-driver.ts:2402`, `:2512`) and `isConfigSupported` (`:2322`) with a
   `decodeValidate` capability injected via `StageOptions`/executor, resolved by the router
   (WebCodecs → GPU → WASM, miss-only). *Acceptance:* `grep -rn 'new VideoDecoder\|VideoDecoder\.'
   src/drivers/mp4` returns 0; a corrupt-ciphertext CENC fixture still rejects at the codec seam (a
   test flips one `senc` IV byte and asserts the decrypt throws before emitting output); a Node run
   with no `VideoDecoder` still takes the crypto-only path and passes the bit-exact twin.

4. **Unify box-header parsing on `reader.ts:139`.** Delete `topBoxHeader`/`probeBoxAt`
   (`simple-video-probe.ts:60`, `:105`), `readTopLevelBox` (`compatible-mov-rewrite.ts:44`), and
   `topBoxHeader`/`declaredProbeBoxAt` (`mp4-driver.ts:512`, `:727`); route all header reads through
   `readBoxHeader` (adding a random-access variant if a box header can straddle a read window).
   *Acceptance:* one box-header implementation remains; the fuzz corpus (`test-support/fuzz/corrupt.ts`)
   of truncated / `size===1` / `size===0` / oversized boxes passes through the single parser without a
   crash and with identical probe output on the clean corpus.

5. **Collapse the two fragment (trun/tfhd) parsers into one.** Have `parse.ts` aggregate timing
   (`parseTraf`, `:357`) and per-sample recovery (`appendTrafSamples`,
   `fragment-samples.ts:128`) share one `trun`/`tfhd` reader and one set of flag constants.
   *Acceptance:* on the fragmented corpus, `sum(fragmentSamplesToDemuxSamples(...).durationUs)` equals
   the `FragmentTiming.mediaTicks` the aggregate path reports for every track; `hybrid-fragmented` and
   `fragmented-probe` tests stay green.

6. **Deduplicate the AVC key-picture classifier.** Route `classifyAvcSample` (`mp4-driver.ts:1616`)
   through `h264AccessUnitRangeIsKeyPicture` (`h264-access-unit.ts:34`). *Acceptance:* the
   packet-truth fixture still reports exactly 1,941 video key pictures (1,680 declared sync + 261
   non-IDR intra) on the 725 MiB/two-hour rotation (measured-evidence.md_).

7. **Lift codec bitstream reframing out of `mux.ts`.** Move Annex-B→AVCC (`mux.ts:179-517`) and
   ADTS→raw-AAC (`mux.ts:518-707`) behind a codec-owned transmux seam; the container muxer accepts
   already-elementary samples + `description`. *Acceptance:* `mux.ts` no longer imports/implements NAL
   or ADTS parsing; `mux-avc-passthrough.test.ts` and the ADTS→MP4 mux fixture
   (`mux/audio_only_aac_to_mp4`, 6.240 ms vs ffmpeg 10.140 ms, measured-evidence.md_) round-trip
   byte-identically.

8. **Consolidate scalar helpers.** One shared `toUs` (drop `samples.ts:56`, `fragment-samples.ts:300`,
   `mp4-driver.ts:2278` duplicates) and one big-endian byte-write helper set. *Acceptance:* `grep -rn
   'function toUs' src/drivers/mp4` returns 1; typecheck green.

9. **Reconcile the two `supports()` predicates.** `matchesMp4` (`mp4-sniff.ts:7`) and `supportsMux`
   (`mp4-mux-driver.ts:17`) must agree on the MIME/extension universe (mux-vs-demux direction gating
   aside). *Acceptance:* a table-driven test asserts `application/mp4` and `audio/x-m4a` are treated
   consistently by both; the container-selection matrix (`container-integrity.test.ts`) stays green.

10. **Support >4 GiB non-fragmented output (or fail loudly and route to CMAF).** `writeMp4`
    (`write.ts:991`) + `assertSingleBufferSize` (`write.ts:602`) cap at 4 GiB with a 32-bit `stco`.
    Either emit `co64` + a 64-bit `mdat` largesize when `mdatPayloadLen > 0xffffffff`, or raise a
    typed `CapabilityError` steering the caller to `fragmented: true`. *Acceptance:* a synthetic layout
    *plan* (no real bytes) whose payload exceeds 4 GiB asserts `co64` selection and a 16-byte `mdat`
    header (or the typed error); sub-4 GiB layouts stay `stco` and byte-identical.

11. **Prove the demuxer releases its source lease on terminal/cancel.** The revocable `sourceCell`
    (`mp4-driver.ts:3000`, `:2994` comment) and packet-stream `release()` (`:2792-2800`) are the
    memory contract. *Acceptance:* a heap-snapshot test (per measured-evidence.md_, JSC may defer `WeakRef`
    clearing so use a self-describing V8 snapshot checking zero strong inbound retainers) asserts that
    after a full drain **and** after an early `cancel()`, the full-source `RandomAccess` and its
    window buffers have zero strong retainers.

12. **Golden the packet-info table against ffprobe truth on the massive rung.** `mp4PacketInfoTable`
    (`mp4-driver.ts:2647`) must preserve all 553,501 payload-free packet sizes of the two-hour MP4
    (measured-evidence.md_, `performance/size-ladder-iterate-packets-massive`). *Acceptance:* the table matches
    independent `ffprobe -show_packets` sizes row-for-row; the header-only path
    (`readMoviePacketInfo`, `:1059`) and the offset path (`readMovie`, `:965`) agree on counts.

### S24 — WebM / MKV Driver

Source: [`docs/drivers/webm-mkv.md`](docs/drivers/webm-mkv.md) · owned code + rationale in the doc.

Ordered, each with a concrete acceptance test (oracle).

1. **Add a `Cues`/`SeekHead` seek index for range-based partial demux/seek.** Parse `Cues`
   (`0x1C53BB6B`) → `CuePoint`/`CueTrackPositions`, and follow `SeekHead` (`0x114D9B74`) so metadata
   after Clusters is reachable. Then `demux`/`seek` should range-read only the Cluster(s) covering the
   requested window instead of `readAll` (`webm-driver.ts:2303`). *Acceptance:* on a Cues-bearing
   1080p/120 s MKV, a seek to t=60 s issues a bounded range request (assert total bytes read ≪ file
   size) and returns the keyframe-aligned frame identical to the full-read path; `seek_mkv`/`seek_av1`
   medians beat mediabunny (currently 21.5 vs 20.1 / 24.5 vs 22.5 `(measured-evidence.md)`). Add a
   Clusters-first (SeekHead-referenced Tracks) fixture that probe currently cannot parse and assert it
   now probes correctly.

2. **Extract shared EBML/Matroska constants + primitives into one module.** Collapse the two ID tables
   (`webm-driver.ts:50-115`, `ebml-write.ts:31-93`), the two `BitReader`s (`h264-sps.ts:170`,
   `video-codec-qualification.ts:237`), and the Opus constants (`webm-driver.ts:119-124`,
   `ebml-write.ts:100-101`) into `src/drivers/webm/matroska-ids.ts` + a shared bit-reader. *Acceptance:*
   a test importing the shared table asserts `read`/`write` reference the *same* object for every
   element ID used on both sides (grep-guard: no second `0x1A45DFA3` literal in the tree); existing
   `ebml-write.test.ts`/`webm.test.ts` stay green.

3. **Fix the B-frame `endMs` overshoot.** `remux/h264_bframes_1080p_mp4_to_mkv` reimports 10.134 s vs a
   10.0 s golden `(measured-evidence.md)`. The end time must be `max(PTS + duration)` over the true presentation
   timeline, not a decode-order artifact (`buildBlockTimeline` end computation,
   `ebml-write.ts:457-482`). *Acceptance:* a Node oracle feeds a synthetic reorder-depth-2 stream
   (PTS/DTS diverging) and asserts the emitted `Info/Duration` equals the last-PTS + last-duration to
   the millisecond; the `h264_bframes` remux reimport reports 10.0 s within tolerance.

4. **Split the two god-files.** Carve `webm-driver.ts` into `parse.ts` / `blocks.ts` (lacing+DTS) /
   `source-io.ts` (the prefix ladder) / `trim.ts` / `driver.ts`, and `ebml-write.ts` into
   `ebml-primitives.ts` / `timeline.ts` / `muxer.ts` / `streaming-muxer.ts`. Deduplicate the
   triplicated `presentationTimeline`/`dtsUs` logic (`webm-driver.ts:1387,1434,2217`) into one
   `assignDecodeTimestamps(frames, reorderDepth)`. *Acceptance:* each new file ≤ ~400 lines; a single
   `packet-timeline.test.ts` covers the one shared DTS function; full gate (typecheck/lint/test) green
   with no behavior change (byte-identical mux output on the corpus).

5. **Make `WebmMuxer({ fragmented: true })` bounded-memory.** Today it buffers all chunks then calls
   `fragmentWebm` (`ebml-write.ts:1779-1782`); route it through `WebmStreamingMuxer`
   (`ebml-write.ts:1413`) so peak output is one Cluster. *Acceptance:* a streaming-output test muxes
   an N-fragment WebM through a `StreamTarget` and asserts peak retained bytes ≈ one Cluster (not the
   whole file), while output re-parses byte-for-byte against the buffered path.

6. **Bound packet-byte retention on the whole-file demux.** Packet `data` views pin the entire source
   buffer (`webm-driver.ts:716`); `aac_to_opus_webm` peaks 32.4 MB vs a 25.4 MB rival `(measured-evidence.md)`.
   Copy packet bytes at emission (or slice per-Cluster) so a consumed packet releases the file buffer.
   *Acceptance:* a benchmark asserts post-GC RSS for the transcode row drops below the leanest rival's
   peak; demux output stays byte-identical.

7. **Close the read↔write codec-map asymmetry.** `mapCodec` reads ac-3/eac-3/dts/truehd/mp2
   (`webm-driver.ts:150-186`) that `toCodecId` cannot write (`ebml-write.ts:308-335`). Either add the
   inverse write mappings (pass-through mux) or make `toCodecId` raise a *specific* typed
   `CapabilityError` naming the unsupported MKV codec at `probe` time, not silently. *Acceptance:* a
   round-trip test demuxes an AC-3-in-MKV and asserts `mux` either reproduces `A_AC3` or raises
   `capability-miss` with `codec: 'ac-3'` — never a generic failure.

8. **Optionally lace small audio packets on write.** Match FFmpeg/mediabunny block layout for many
   tiny Opus/AAC frames (EBML or fixed lacing) to shrink overhead. *Acceptance:* a laced-source
   round-trip reproduces the source's frames-per-block within one, and total Cluster overhead drops
   measurably vs the one-block-per-packet path; decode parity unchanged.

### S25 — MPEG-TS & HLS Driver

Source: [`docs/drivers/mpegts-hls.md`](docs/drivers/mpegts-hls.md) · owned code + rationale in the doc.

1. **Extract codec framing out of `ts-parse.ts` into shared codec modules.** Move `h264HasIdr`,
   `h264AnnexBNalStarts`, `deframeH264PesUnits`, `parseH264SpsDimensions`, `BitReader`, `stripEmulation`
   (`ts-parse.ts:359-479, 734-868`) and `hevcHasIrap` (482-491) into a codec-owned Annex-B helper reused
   by mp4/webm/mpegts; move `AdtsDeframer` + `parseAdtsHeaderAt` + `audioSpecificConfig`
   (`ts-parse.ts:875-1107`) into the shared ADTS module used by the `adts` driver (S28). `ts-parse.ts`
   *imports* them. **Acceptance:** `ts-parse.ts` drops below ~500 lines and contains no `BitReader`/NAL/
   ADTS-header definitions (grep asserts zero); the demux golden-packets oracle for `demux/h264_ts.ts` and
   `demux/aac_adts` stays byte-identical (same packet count, `maxPtsDrift=0`), and the ADTS de-framer
   micro-benchmark holds ≥540 MB/s on the 30 s fixture (`measured-evidence.md` ADR-184 regression guard).

2. **Unify the AAC sample-rate table.** Delete `AAC_SAMPLE_RATES` (`ts-parse.ts:871-873`); import the one
   table both sides use (`MPEG4_SAMPLE_RATES`, already imported by `ts-write.ts:1`). **Acceptance:** one
   definition remains (grep); parse of every ADTS `sampling_frequency_index` 0–12 yields the identical Hz
   value as before on a table-driven unit test; index 13–15 still returns `undefined` (reserved).

3. **Add `MpegTsDriver.packetInfo()` (payload-free) and `MpegTsDriver.probe()`.** Implement the optional
   contract methods (`contracts/driver.ts:416-424`) so a metadata/packet-info request does not copy AU
   payloads. `packetInfo` returns rows of `{ptsUs, dtsUs, sizeBytes, key}` from the parse without slicing
   payload bytes; `probe` returns `TrackInfo[]` only. **Acceptance:** `demux/hls_vod` and `demux/h264_ts.ts`
   packet-info paths allocate zero AU payload copies (instrument the parse), the golden packet table
   (470-row shape, `maxPtsDrift=0`) is unchanged, and `demux/hls_vod` median beats the stored 63.850 ms
   deficit toward mediabunny's 43.345 ms (`measured-evidence.md`).

4. **Stream the parse instead of `readAll`.** Replace whole-source buffering (`mpegts-driver.ts:47-73`,
   `parse` 319-321) with an incremental packet-fed parser so demux emits packets as PIDs complete and peak
   memory is bounded by the in-flight PES, not the segment size. Preserve the "no index ⇒ full scan for
   duration" contract by finishing the pass before reporting `durationSec`. **Acceptance:** a
   backpressure test that reads one packet then stalls shows resident memory well below full-segment size
   on a multi-MB TS; the abort test cancels mid-stream and the range read is interrupted (closes the §3
   `readAll` gap); demux packet table unchanged.

5. **Bound HLS segment stitching memory / stream it.** `resolveHlsSource` concatenates every decrypted
   segment into one `Uint8Array` (`hls-source.ts:150, 504-514`) — unbounded for a long VOD. Emit a
   streaming `Source` (segment-at-a-time `ReadableStream`) with only the fMP4 init prepended once, or cap
   the eager path to a bounded window. **Acceptance:** stitching a synthetic N-segment VOD holds peak
   memory near one segment (+ init), not N segments; `hls_vod`/`hls_aes128` demux goldens and the
   probe-first-segment path (`resolveHlsProbeSource`, `hls-source.ts:160-187`) stay byte-identical.

6. **Lift the writer codec allow-list out of the container layer.** `SupportedCodec='h264'|'aac'`
   (`ts-write.ts:28, 845-858`) should not encode the codec set. Either extend the writer to the
   `stream_type`s the parser already maps (`ts-parse.ts:38-49`) — at minimum HEVC (`stream_type 0x24`,
   Annex-B) — or move the "TS carries only H.264/AAC today" decision into an explicit capability table the
   router reads, so a TS→TS HEVC copy raises a *routed* `CapabilityError` rather than an ad-hoc
   `normalizeCodec` throw. **Acceptance:** an HEVC-in-TS `streamCopy` either round-trips (parse ⇒ write ⇒
   re-parse to identical AUs) or fails with a `capability-miss` carrying `{op:'stream-copy:mpegts',
   tried:['mpegts'], codec:'hevc'}`; unit test asserts the typed detail, never a bare `MediaError`.

7. **Parse HEVC coded dimensions for probe.** `configForStream` publishes `0×0` for HEVC
   (`ts-parse.ts:1115-1125`). Add HEVC SPS dimension parsing (reuse the extracted Annex-B/BitReader from
   item 1). **Acceptance:** probing an HEVC TS fixture reports non-zero `codedWidth`/`codedHeight` matching
   ffprobe; a mid-GOP TS range with no leading SPS still degrades to `0×0` (not a throw), matching the
   H.264 mid-GOP behavior (`ts-parse.ts:1117-1124`).

8. **De-frame non-AAC TS audio (AC-3/E-AC-3/MP3), or emit an honest partial.** Today each is one AU per PES
   with `sampleRate:0` (`ts-parse.ts:1139-1143`). Add frame-boundary parsing for at least AC-3 (syncframe)
   and MP3 (frame header) to produce per-frame AUs + a real config, or mark the config a typed capability
   gap the router surfaces. **Acceptance:** an AC-3 TS demux yields per-syncframe packets with a non-zero
   `sampleRate`, or a `probe` on it returns a config flagged as an explicit gap (no silent `sampleRate:0`).

9. **Deduplicate byte helpers.** Collapse the four `concat`/whole-drain implementations
   (`mpegts-driver.ts:65-73`, `ts-parse.ts:301-310`, `ts-write.ts:975-987`, `hls-source.ts:278-291,
   504-514`) into one shared util. **Acceptance:** a single `concat`/`drain` definition remains (grep);
   all existing TS/HLS tests pass unchanged.

10. **Add a sparse PCR/IDR seek index for large TS (target improvement).** Build an optional index mapping
    IDR PTS → byte offset during the scan so a future range-based seek can skip to a GOP without buffering
    the whole file. **Acceptance:** on a multi-GOP TS the index lists every IDR with the byte offset of its
    first transport packet; a keyframe-trim using the index selects the same start AU as today's
    `selectTrimmedUnits` (`mpegts-driver.ts:159-198`) — regression-identical output bytes.

11. **Surface `#EXT-X-DISCONTINUITY` to the stitch/parse boundary.** The parser records `discontinuity`
    per segment (`m3u8-parse.ts:59, 434`) but the resolver ignores it when concatenating (a PID/timeline
    reset across a discontinuity can break the single-TS assumption). Either reject a discontinuity-bearing
    VOD with a typed miss or handle the PTS reset via the parser's 2^33 unwrap contract
    (`ts-parse.ts:504-514`). **Acceptance:** a two-part playlist with `#EXT-X-DISCONTINUITY` between
    segments of different PID layout either resolves to correct per-part timelines or fails with a typed
    `InputError` naming the discontinuity — never silently mis-stitches.

12. **Split the two god-files along the §3 layers once items 1–2 land.** `ts-parse.ts` → `ts-transport.ts`
    (framing/PSI/PES) + thin re-exports; `ts-write.ts` → `ts-psi-write.ts` (PAT/PMT/CRC) + `ts-packetize.ts`
    (PES/PCR/packetizer). **Acceptance:** no owned file exceeds ~500 lines; the public exports
    (`parseTs`, `MpegTsMuxer`, `writeMpegTsPacketTracks`, `deframeH264PesUnits`, `AdtsDeframer`) keep the
    same import paths so S14/S15 consumers (`api/mpegts-prepared-mux.ts`, `api/mpegts-packet-info-remux.ts`)
    compile unchanged; full gate green.

### S26 — Ogg Driver

Source: [`docs/drivers/ogg.md`](docs/drivers/ogg.md) · owned code + rationale in the doc.

1. **Exact Vorbis per-packet durations (replace even-split).** Parse the Vorbis setup header for the
   mode→blockflag map and the two blocksizes; for each audio packet compute
   `duration = (prevBlocksize + currBlocksize) / 4`, threading the previous blocksize (mediabunny
   `extractSampleMetadata`). Keep the priming packet in the count. Reference `ogg-driver.ts:514-540`.
   *Acceptance:* a strict oracle on `sound_5.oga` (the existing Vorbis fixture, see
   `ogg.test.ts:784`) asserts **per-packet** `durationUs` equals ffmpeg/ffprobe's `pkt_duration` for every
   audio packet (not just the running sum), and the final accumulated granule equals the terminal page
   granule exactly. The current even-split test at `ogg.test.ts:784` must be upgraded from "approximation"
   to bit-exact per packet.

2. **Opus end-trim on the demux path.** Clamp the last Opus packet's effective duration so the accumulated
   granule equals the terminal page `granule_position` (RFC 7845 end-trim), matching what `parseOgg` already
   reports as duration. Reference `ogg-driver.ts:499-511` (accumulation) vs `parseOgg` `:613-624`.
   *Acceptance:* on an end-trimmed Opus fixture, `sum(oggAudioPackets.durationUs)` equals
   `round(parseOgg.durationSec * 1e6)` within ±1 µs; assert the last packet's duration is shorter than its
   raw TOC duration when the granule demands it.

3. **Move cross-container remux out of the Ogg driver.** Delete the WebM/Matroska authoring from
   `ogg-driver.ts` (`writeOggWebmPacketCopy` :753, `resetOpusPreSkip` :732, `selectOggTrimPackets` :697,
   and the `import('../webm/ebml-write.ts')` :780). Ogg's `streamCopy` should return native Ogg
   (full-copy or Ogg-native trim via `writeOggPacketCopyTrim` :846) and hand cross-container targets to the
   generic packet-mux/remux seam (S14/S15), which already owns `packetInfoTable`→muxer wiring.
   *Acceptance:* `grep -R "webm" src/drivers/ogg/` returns nothing; the cross-container tests
   (`ogg.test.ts:335,389,428,472,495`) still pass by routing through the shared remux runner, proving the
   generic seam covers Ogg→WebM/MKV including Opus pre-skip reset and FLAC→WebM rejection.

4. **Granule-bisection seek (random-access demux).** Add a seek path that binary-searches byte offsets,
   resyncs on `OggS`, reads `granule_position`, and returns the packet index whose granule ≤ target sample,
   without `readAll`. Reference the whole-file reads at `ogg-driver.ts:948,1050`.
   *Acceptance:* on a large (>1 MB) Opus/Vorbis fixture, `seek(tSec)` reads O(log n) ranges (assert the
   `ByteSource.range` call count is bounded, not O(file)) and returns a packet whose PTS ≤ `tSec` and whose
   successor's PTS > `tSec`; decoded output from the seek point matches decoding from file start then
   skipping.

5. **Streaming (bounded-memory) demux.** Replace `readAll` in `demux`/`packetInfo` with an incremental page
   reader that de-laces page-by-page as ranges arrive, so peak memory is O(one page + one continued packet),
   not O(file). Reference `ogg-driver.ts:948,1050`.
   *Acceptance:* demuxing an N-MB file with a `ByteSource` that counts bytes held live asserts peak retained
   bytes < a small constant (e.g. ≤ 256 KiB) independent of N; packet output is byte-identical to the
   whole-file path.

6. **True streaming mux sink.** `OggMuxer.finalize` currently serializes the whole stream in one
   `controller.enqueue` (`ogg-write.ts:629`). Emit pages incrementally as packets arrive so the muxer is a
   real streaming sink (S07). *Acceptance:* muxing K packets enqueues ≥ 2 chunks before `finalize` and the
   concatenation is byte-identical to today's single-buffer output (round-trip via `parseOgg` + independent
   CRC scan, as in `ogg-write.test.ts:325`).

7. **Random `bitstream_serial_number`.** `writeOgg` hardcodes `DEFAULT_SERIAL = 0x00000001`
   (`ogg-write.ts:29,481`). RFC 3533 §4 wants a serial chosen to be unique so streams can be chained/muxed.
   *Acceptance:* two independent `createMuxer()` outputs of the same input have **different** serials
   (assert the 32-bit serial at page-header offset 14 differs), and both still round-trip through `parseOgg`.

8. **De-duplicate the Opus TOC table + helpers into one module.** Hoist `OPUS_FRAME_SAMPLES`
   (`ogg-driver.ts:265` / `ogg-write.ts:32`), `opusPacketSamples` (`ogg-driver.ts:293` /
   `ogg-write.ts:416`), and `concatBytes` (`ogg-driver.ts:38` / `ogg-write.ts:78`) into a shared
   `ogg-common.ts`. *Acceptance:* `grep -c "OPUS_FRAME_SAMPLES = \[" src/drivers/ogg/*.ts` == 1; existing
   Opus timing tests (`ogg.test.ts:753`, `ogg-write.test.ts:378`) still pass unchanged.

9. **Type the `packetInfoTable` extension in the contract.** Remove the `as` cast at
   `ogg-driver.ts:1058-1060` by adding an optional `packetInfoTable?(): readonly PacketInfoMetadata[]` to the
   `Demuxer` interface (`src/contracts/driver.ts:304`) — a doc-only note here; the change lands in S04.
   *Acceptance:* the driver compiles with `zero any` and no `as` cast around `packetInfoTable`; a type test
   asserts `Demuxer['packetInfoTable']` is the declared optional method.

10. **Split the god-file into layers.** Extract source I/O (`readHead`/`readTail`/`readAll`/`readOggChunk`
    :903-979) toward the sources layer (S06) or a small `ogg-source.ts`, and page primitives into
    `ogg-page.ts`, leaving `ogg-driver.ts` as the `ContainerDriver` wiring. *Acceptance:* `ogg-driver.ts`
    drops below ~400 lines and imports its primitives; the full Ogg test suite
    (`ogg.test.ts`, `ogg-write.test.ts`) passes with no behavior change.

### S27 — WAV / AIFF / CAF Drivers

Source: [`docs/drivers/wav-aiff-caf.md`](docs/drivers/wav-aiff-caf.md) · owned code + rationale in the doc.

1. **Give CAF a bounded probe + packet table.**
   Add `CafDriver.probe` reading only enough head to locate `desc` (+`data` header), and `CafDriver.packetInfo` emitting a byte-offset table like AIFF. Today `demux` reads the whole file (`src/drivers/caf/caf-driver.ts:61`).
   *Acceptance:* a probe on a large CAF issues a bounded range (assert bytes read ≪ file size), and the `demux`/CAF packet-table oracle matches ffprobe frame count/first-PTS-zero on `sfx-*.caf` fixtures. A `-1`-sized trailing `data` chunk still probes correct duration (`src/drivers/caf/caf.ts:131`).

2. **Streaming decode for AIFF and CAF.**
   Implement `decodePcmAudioStream` + `decodePcmInterleavedStream` for AIFF (`aiff-driver.ts`) and CAF (`caf-driver.ts`) mirroring `wav-driver.ts:992`/`:1026` (range-backed 1 MiB window + range-less sequential cursor), so they stop materializing the whole file in `decodePcmAudio` (`src/drivers/aiff/aiff-driver.ts:315`, `src/drivers/caf/caf-driver.ts:102`).
   *Acceptance:* range-less AIFF/CAF decode returns identical frames/checksum to the whole-file path with a bounded median peak (assert ≤ one source allocation, per ADR-277); each emitted chunk ≤ 4096 frames.

3. **Make AIFF/CAF `transformPcm` respect backpressure.**
   Replace the single-`start()`-enqueue (`src/drivers/aiff/aiff-driver.ts:308`, `src/drivers/caf/caf-driver.ts:95`) with the pull-driven `highWaterMark: 0` stream used by WAV (`src/drivers/wav/wav-driver.ts:797`).
   *Acceptance:* a slow consumer causes ≥2 `pull`s and no eager full-output allocation before the first pull (assert enqueue count / RSS ceiling).

4. **Thread `signal` through every `readAll`.**
   AIFF (`src/drivers/aiff/aiff-driver.ts:64`) and CAF (`src/drivers/caf/caf-driver.ts:35`) `readAll` ignore the abort signal and never cancel the source reader mid-drain; adopt WAV's abort-aware drain (`src/drivers/wav/wav-driver.ts:410`).
   *Acceptance:* aborting a large AIFF/CAF `transformPcm` rejects with `MediaError('aborted')` promptly and the source `ReadableStreamDefaultReader.cancel()` is observed.

5. **Add PCM-native trim to AIFF (finish) and CAF (new); set `validatesPcmTrim`.**
   AIFF has `trySliceAiffPcm` but the driver never sets `validatesPcmTrim`; CAF has no slice path. Wire both `timeBounds` byte-slice paths through `transformPcm` and set `validatesPcmTrim: true` (contract `src/contracts/driver.ts:460`) as WAV does (`src/drivers/wav/wav-driver.ts:836`).
   *Acceptance:* `trim/audio_aiff_pcm_copy` and a new `trim/audio_caf_pcm_copy` produce frame-exact byte slices (`round(sec*rate)` frame math, `src/drivers/wav/pcm-slice.ts:51`) and the engine skips its generic duration demux.

6. **Unify the two RIFF/WAVE parsers.**
   Collapse `wav-driver.ts` `parseWavHeader`/`parseFormat`/format maps (`:120`–`:164`) into the `pcm.ts` `parseWavPcmData`/`parseFmt`/`sampleFormat` family (`:31`–`:110`) (or vice-versa), exposing one parser that returns both the packet-info layout and the copy-plan.
   *Acceptance:* a property test over the WAV corpus asserts both entry points yield identical `{codec, channels, sampleRate, dataOffset, dataSize}`; deleting one parser leaves the suite green.

7. **Reconcile packet-table granularity across the family.**
   Pick one policy — the recommendation is a **byte-target** rounded down to whole frames (matches `aiffdec.c` `MAX_SIZE=4096`) — and apply it to WAV (today 4096 **frames**, `src/drivers/wav/wav-driver.ts:84`/`:299`), AIFF (`:36`/`:125`), and CAF (new). Fix the AIFF comment that over-claims a match to all of "FFmpeg's PCM demuxers" (`src/drivers/aiff/aiff-driver.ts:121`).
   *Acceptance:* one shared `packetFrames(blockAlign)` helper; goldens updated so mono s16 = 2048 frames/packet, stereo s16 = 1024, mono s24 = 1365 (4095 bytes), consistent for all three containers. If the `demux/wav_s24` golden (4096-frame rows, `measured-evidence.md`) must stay, document the exception explicitly.

8. **De-duplicate `writePlainAiffHeader` and the AIFF header writers.**
   `aiff/aiff-slice.ts:69` and `wav/aiff-rewrite.ts:43` are byte-identical; export one from `aiff/aiff.ts`.
   *Acceptance:* one 54-byte writer; a byte-parity test against `writeAiff`'s COMM/SSND framing; both call sites import it.

9. **Consolidate `readAll`/`readHead`/`byteStream` onto the `ByteSource` seam.**
   Five copies (`wav-driver.ts:397`/`:410`, `aiff-driver.ts:55`/`:64`, `caf-driver.ts:35`, `pcm-range-slice.ts:17`, `url-trim.ts:25`) → one abort-aware helper that prefers `src.readAll?()` (`src/contracts/driver.ts:189`) when present.
   *Acceptance:* a single helper module; drivers import it; the unused `readAll` contract hook is exercised by at least one source implementation.

10. **Move URL fast-path helpers + caches out of the driver layer.**
    Relocate `wavPacketInfoFromUrl`/`aiffPacketInfoFromUrl`/`wavTrimFromUrl` and their module-global caches (`wav-driver.ts:95`/`:360`, `aiff-driver.ts:53`/`:193`, `url-trim.ts:23`/`:98`) behind a source/probe-cache seam (S06), so the driver never imports `sources/source.ts` directly. Align the cache budget with ADR-261 (8 MiB total-byte LRU, raw input bytes only).
    *Acceptance:* `grep -L "sources/source" src/drivers/{wav,aiff,caf}/*.ts` shows the driver files no longer import `fromURL`; cache behavior tests move with the code; `demux/wav_s24` cached-prefix win (0.210 ms, `measured-evidence.md`) is preserved.

11. **Split the `wav-driver.ts` god-file.**
    Extract `wav-probe.ts` (sparse/bounded probe, `:171`–`:252`, `:837`), `wav-pcm-stream.ts` (range + sequential readers and chunk streams, `:471`–`:799`), and `wav-packet-info.ts` (`:293`–`:395`), leaving `wav-driver.ts` as a thin `ContainerDriver` object.
    *Acceptance:* `wav-driver.ts` ≤ ~300 lines; each extracted module has its own unit test; the eager kernel/closure byte budgets stay within their ceilings (`measured-evidence.md`, eager ≤ 50 KiB, first-op closure ≤ 256 KiB).

12. **RF64 / BW64 (> 4 GiB) support decision.**
    Both WAV parsers read a `u32` `data` size and clamp to file length (`src/drivers/wav/pcm.ts:100`, `wav-driver.ts:155`); an RF64 `ds64` chunk with a 64-bit size is unhandled, so a > 4 GiB WAV reports truncated/`0xFFFFFFFF` duration. Add `ds64` parsing or emit a typed `InputError`.
    *Acceptance:* an RF64 fixture either probes the correct duration (ffmpeg parity) or fails with `InputError('unsupported-input', 'RF64 …')` — never a silently wrong duration.

13. **RIFX / big-endian WAV decision.**
    `pcmCodec` emits LE tokens only and the parser assumes LE (`src/drivers/wav/wav-driver.ts:97`, `pcm.ts:81`); a `RIFX` file would be misidentified as "not a RIFF/WAVE file". Decide: parse `RIFX` (BE) or raise a typed miss.
    *Acceptance:* a `RIFX` fixture parses correctly or raises `InputError`/`CapabilityError` — asserted, not misparsed.

### S28 — MP3 / ADTS / FLAC Drivers

Source: [`docs/drivers/mp3-adts-flac.md`](docs/drivers/mp3-adts-flac.md) · owned code + rationale in the doc.

Ordered by leverage (shared seam first, then per-driver correctness, then streaming).

1. **Extract one `FrameHeaderParser` per codec; delete the duplicates.**
   Collapse the three MP3 parsers (`mp3-driver.ts:73`, `mp3-mux.ts:201`, `codecs/wasm-mp3/mp3.ts:145`) to
   one, and the two FLAC block-size decoders (`flac-driver.ts:660`, `flac-sniff.ts:281`) to one; share the
   `SAMPLE_RATES`/`BITRATES_*` and `FLAC_BLOCK_SIZE_TABLE` constants.
   **Acceptance:** a test imports the single parser and asserts byte-identical header fields on the real
   `sound_5.mp3` / `sfx.flac` fixtures; `grep -c "BITRATES_MPEG1_L3\|FLAC_BLOCK_SIZE_TABLE ="` across
   `src/drivers/{mp3,flac}` returns 1 each. All existing golden tests (`mp3.test.ts`, `flac.test.ts`) stay
   green.

2. **Fix the ADTS capability leak — lazy-load `wasm-aac`.**
   Replace the top-level `import { loadAacCore }` (`adts-driver.ts:12`) with a `import()` reached only on a
   native miss (mirror `loadAdtsPcmDirectModule` `:79`).
   **Acceptance:** a bundler/static-analysis test asserts `src/drivers/adts/adts-driver.ts` has **no static
   import** of any `src/codecs/wasm-aac/*`; the eager-kernel/default-closure size budget
   (`docs/measured-evidence.md`: ≤50 KiB eager, ≤256 KiB closure) is re-measured and does not regress; ADTS→WAV
   decode on `sfx.adts` still passes via the lazy path.

3. **Give ADTS a `decodePcmAudio` and stop returning WAV from the container.**
   Add `AdtsDriver.decodePcmAudio → PcmAudio` (like `flac-driver.ts:767`); keep `decodePcm` as a thin WAV
   author in the sink layer so the ADTS chunk drops `import { writeWav }` (`adts-driver.ts:37`).
   **Acceptance:** `AdtsDriver.decodePcmAudio(sfx.adts)` returns `PcmAudio` whose interleaved bytes hash
   equal to the current `decodePcm` WAV payload (minus the 44-byte header); `grep writeWav
   src/drivers/adts/adts-driver.ts` returns nothing.

4. **De-duplicate the ADTS direct-WAV gate.**
   Keep exactly one `ADTS_DIRECT_WASM_S16_MAX_BYTES` and one `payload()`; fold `mayUseAdtsDirectWasmS16Wav`
   (`adts-driver.ts:372`) into `canUseAdtsWasmDirectS16Wav` (`adts-pcm-direct.ts:24`).
   **Acceptance:** a unit test drives the single predicate across `{wasm-only, force-software,
   size≤256KiB, size>256KiB, container≠wav, DSP present}` and asserts the exact route chosen for each;
   `sfx.adts` extraction bytes are unchanged (byte-equal to the committed golden).

5. **MP3 framer must resync mid-stream like ADTS.**
   Replace the whole-buffer `enumerateMp3Packets` (`mp3-driver.ts:229`) with the shared incremental walker
   so a mid-stream ID3/APE block or a bit error recovers the trailing frames instead of truncating at
   `:240`.
   **Acceptance:** a crafted fixture = `[valid frames][8 junk bytes][valid frames]` yields a packet count
   equal to the sum of both runs (fails today, which stops at the junk), matching how the ADTS walker
   resyncs (`adts-frames.ts:342`).

6. **Thread the FLAC encoder's incremental MD5 to the muxer; delete the re-decode.**
   `flac-codec.ts` streams the PCM — have it hash MD5 incrementally (its comment already claims this,
   `:231`) and hand the digest to the muxer (via `onConfig`/a finalize hook) so `backfillStreamInfoMd5`
   (`flac-driver.ts:518`) no longer calls `decodeFlac` on the whole output.
   **Acceptance:** with a spy on `decodeFlac`, `media.encode(pcm → flac)` produces a stream whose
   STREAMINFO MD5 round-trips (`decodeFlac(out).md5` equals `md5(interleavedPcmBytes)`) **without**
   `decodeFlac` being called during finalize (it is called once today). The remux path (non-zero supplied
   MD5) is untouched.

7. **Unify `readAll`, `ascii`, and the `ElementaryFrame` type.**
   One `readAll(src)` and one `ascii()` helper shared across the shard; one `ElementaryFrame` replacing
   `Mp3Packet`/`AdtsPacket`/`FlacFrame`.
   **Acceptance:** `grep -rc "async function readAll" src/drivers/{mp3,adts,flac}` == 0 (moved to a shared
   module); all three drivers' `packetInfo`/`demux` golden tables (`toEqual` in the `*.test.ts`) stay
   byte-identical.

8. **Stream the muxers instead of materializing the whole file.**
   Emit each frame to the output `Target` as it is written; for MP3, write the Xing frame with a
   placeholder frame/byte count and backpatch on `finalize` (mediabunny's approach); for FLAC, backpatch
   STREAMINFO total-samples/min-max at the front.
   **Acceptance:** muxing a 10-minute source measures **peak RSS bounded** (e.g. < 4 MiB over a
   single-frame baseline) via the benchmark harness memory probe, while the output bytes remain
   byte-identical to today's single-`enqueue` result on `mux/mp3_to_mp3` and `mux/flac_to_mkv_audio`
   (`docs/measured-evidence.md` medians 3.900 ms / 2.725 ms as the perf floor to hold).

9. **`highWaterMark:0` on the MP3/FLAC packet streams.**
   Match ADTS (`adts-driver.ts:743`).
   **Acceptance:** a slow consumer reading one packet at a time causes exactly one `pull` per `read`
   (assert `pull` call count == packets consumed), demonstrating no eager buffering.

10. **Split each god-file along the seam.**
    Move ADTS PCM-decode routing, the trim URL cache, and the decrypt bridge out of `adts-driver.ts`;
    move FLAC muxing/STREAMINFO packing and PCM-authoring out of `flac-driver.ts`, leaving each
    `*-driver.ts` as the thin `ContainerDriver` object over the shared framer + a codec seam.
    **Acceptance:** `adts-driver.ts` and `flac-driver.ts` each drop below ~350 lines; the module-global
    `adtsTrimUrlByteCache`/`adtsPcmDirectModule` (`adts-driver.ts:75-77`) live in a single owned cache
    module with an explicit `clear()` used by tests; full shard test + bench gate stays green.

### S29 — AVI Driver

Source: [`docs/drivers/avi.md`](docs/drivers/avi.md) · owned code + rationale in the doc.

Ordered for a coding agent. Each item names the change, the `path:line`, and a concrete acceptance
oracle. Behavior-preserving refactors (items 1, 4) must keep `avi.test.ts` green and produce
**byte-identical** mux output on the fixtures.

1. **Decompose the `avi-mux.ts` god-file (762 lines).** Extract `riff-write.ts` (the
   `riffChunk`/`listChunk`/`riffFile`/`writeFourCC` primitives, `avi-mux.ts:111-165`), `avi-codec-map.ts`
   (shared with the parser, see item 4), `avi-timing.ts` (`videoTiming`/`audioTiming`/
   `compressedAudioTiming`, `avi-mux.ts:313-383`), and `avi-layout.ts` (header + movi + idx1 builders),
   leaving a thin `avi-mux.ts` that only wires the `Muxer`. *Acceptance:* no owned non-test file over
   ~350 lines; each extracted module has its own unit test; `writeAviFromTracks` produces
   byte-identical output to `git HEAD` on all five `avi.test.ts` mux cases (MJPEG+PCM, MPEG-4+MP3,
   video-only, audio-only PCM, audio-only MP3); typecheck + lint green; zero `any`.

2. **Read the index for real keyframe flags; keep the index-free `movi` walk.** Replace the
   `defaultKeyframe` first-frame heuristic (`avi-parse.ts:317-322,363-366`) with `AVIIF_KEYFRAME` read
   from `idx1` (or OpenDML index length sign bit, per ffmpeg `read_odml_index`) **when a sane index is
   present**, falling back to the heuristic only when it is missing/inconsistent. *Acceptance:* a
   golden test on a real MPEG-4/XVID AVI asserts the set of keyframe chunk indices equals
   `ffprobe -show_frames`' `key_frame=1` set (not just `{0}`); on an AVI with the `idx1` chunk stripped,
   the walk still demuxes and the heuristic set is reported (a "degraded, documented" flag); the
   existing MJPEG all-key behavior is unchanged.

3. **Add `probe()` (bounded, header-only) and `packetInfo()` (payload-free) to `AviDriver`.**
   `AviDriver` (`avi-driver.ts:133-156`) has neither, forcing a whole-file `readAll` for a probe
   (`avi-driver.ts:33-51`). Add `probe(src)` that reads only enough for `hdrl` (via `src.range` when
   available), deriving duration from `avih.dwTotalFrames`/`strh.dwLength` without walking `movi`; add
   `packetInfo(src)` that walks `movi` headers only (offsets + sizes + PTS + keyframe), never
   materializing payload. *Acceptance:* `probe()` on the two fixtures returns tracks/dims/fps/duration
   equal to today's demux-backed probe within `FRAME_TOLERANCE_SEC` (mjpeg 1.000 s, mpeg4 1.083 s —
   measured-evidence.md_) while issuing a bounded read (assert bytes read ≪ file size on a `range`-capable
   source); `packetInfo().packets` row count/sizes equal the `movi` chunk table with **zero** payload
   subarrays retained.

4. **Unify the codec↔4CC/format-tag map into one bidirectional module.** Merge `videoCodec`/
   `audioCodec` (`avi-parse.ts:77-117`) and `videoFourCC`/`audioFormat` (`avi-mux.ts:171-277`) into one
   `avi-codec-map.ts` with a single source-of-truth table. *Acceptance:* a table-driven round-trip test
   asserts `fourCCToCodec(codecToFourCC(c)) === c` for every muxable codec and that every 4CC the
   reader recognizes has a defined inverse (or an explicit "read-only" marker); the anti-cheat tests
   (`avi.test.ts:1242,1262`, 4CC/format-tag mutation flips the reported codec) stay green.

5. **Fix backpressure + frame-pinning in the packet stream.** Construct the packet `ReadableStream`
   with `{ highWaterMark: 0 }` (today default, `avi-driver.ts:85`) and, for a `range`-capable source,
   window the `movi` read and copy small payloads out instead of subarray-viewing the whole-file
   backing (`avi-parse.ts:357`). *Acceptance:* a heap/retention test asserts that after pulling and
   dropping one packet from a large synthetic AVI, the full-file buffer has zero strong retainers;
   `pull` is invoked exactly once per consumer `read()` (assert via an instrumented reader), not
   eagerly.

6. **Thread `AbortSignal` through the whole-file read.** `readAll` (`avi-driver.ts:33-51`) and `parse`
   (`avi-driver.ts:129-131`) must `throwIfAborted` in both the `range` and `stream` loops. *Acceptance:*
   a test aborts mid-read of a chunked stream source and asserts `demux()` rejects with
   `MediaError('aborted', …)` before parsing, and that no further reads occur after abort.

7. **Emit a conformant OpenDML index (`indx` super-index + `ix##` field indexes), or fail loudly.**
   The muxer writes only `idx1`+`odml/dmlh` for multi-segment output (`avi-mux.ts:502-506,608-612`).
   Either author the `indx` super-index in each `strl` plus per-segment `ix##` (matching ffmpeg
   `avienc.c`), or raise a typed `CapabilityError` when a mux would exceed one RIFF and the caller has
   not opted into a documented "idx1-only, linear-seek" mode. *Acceptance:* ffmpeg (or another AVI 2.0
   reader) can seek into an `AVIX` segment of the muxer's >threshold output and reports the correct
   frame; a sub-threshold single-RIFF mux is byte-identical to today.

8. **Cross-validate the authored `idx1` against a third-party reader.** Because our demux ignores
   `idx1`, add an oracle that proves `buildIdx1` offsets (`avi-mux.ts:569-580`) are correct.
   *Acceptance:* `ffprobe`/`ffmpeg` seeking by the authored `idx1` lands on the byte-exact chunk for
   every entry on the five mux fixtures; a unit test recomputes each `dwChunkOffset` from the emitted
   layout and asserts it points at the chunk's FourCC relative to the documented base.

9. **Collapse the mux double-copy; prefer `Packet.data`.** `write()` should read `packet.data`
   (`driver.ts:92-93`) when present instead of `copyChunkBytes` (`avi-mux.ts:93-97,707-716`), and
   `addChunkStruct` should store the already-owned bytes without a second `slice()`
   (`avi-mux.ts:726`). *Acceptance:* a packet whose `data` view is a distinct owned buffer is stored
   with **one** copy (assert via a spy/`copyTo` counter = 0 when `data` is present); mux output stays
   byte-identical on the fixtures; the mux micro-benchmark geomean does not regress below the 226 MB/s
   baseline (measured-evidence.md_).

10. **Type the chunk introspection.** Replace the `EncodedChunkMeta` `unknown` cast
    (`avi-mux.ts:88-109`) with the real `EncodedVideoChunk`/`EncodedAudioChunk` `type`/`duration`
    fields (browser-gated like the demux seam). *Acceptance:* `grep -n 'unknown' src/drivers/avi/avi-mux.ts`
    returns 0 for the chunk-meta shape; typecheck green; keyframe/duration behavior unchanged on the
    mux tests.

11. **Author compressed-audio codec-private (AAC `AudioSpecificConfig`) or reject.** `buildAudioStrf`
    writes `cbSize = 0` with no extradata (`avi-mux.ts:482-492`) while accepting AAC
    (`avi-mux.ts:270-272`). Either append the ASC after `cbSize`, or raise a typed `CapabilityError`
    for AAC-in-AVI until it can be authored conformantly. *Acceptance:* an AAC AVI mux either produces
    a `strf` whose trailing bytes equal the source ASC (byte-compared) and decodes in ffmpeg, or throws
    `CapabilityError` with `op.codec === 'aac'`; PCM/MP3 mux is unchanged.

12. **Commit a runnable AVI case to the `media-test` corpus.** AVI has no manifest asset/golden
    (`demux/index.ts:43-44`), so it never runs in the 558/563-cell suite. Register a `demux` and a
    `mux` scenario over `mjpeg_pcm_160p.avi`/`mpeg4_mp3_160p.avi` with ffprobe-derived goldens (mjpeg
    dur 1.000 s, mpeg4 dur 1.083 s — measured-evidence.md_). *Acceptance:* the AVI rows appear in the harness,
    pass their strict oracle, and the driver wins/ties the demux+mux aggregate vs the reference
    engines; the local mux bench (`scripts/bench-containers.ts`) remains ≥226 MB/s geomean.

## D. Codec drivers

### S30 — WebCodecs Codec Tier

Source: [`docs/codecs/webcodecs.md`](docs/codecs/webcodecs.md) · owned code + rationale in the doc.

1. **Extract one shared decoder core; make the warm pool a lifetime policy over it.** Factor the pull-driven
   frame-queue + output-backpressure + close-exactly-once + typed-cancellation machine out of both
   `createVideoDecoder` (`:945-1279`) and `createWarmBorrowStream` (`:1721-1986`) into a single builder
   parameterized by an "on clean EOF" action (`close` vs `flush+release`) and an "on error" action
   (`close` vs `discard`).
   *Acceptance:* the existing Node frame-lifetime/backpressure/cancel tests for **both** the fresh decoder and
   the warm pool pass against the unified core unchanged; a coverage/dup check (or an AST/`jscpd` gate)
   asserts the two paths share the queue code (no second copy of `deliverQueuedFrame`/`finishReadableIfDrained`).

2. **Reconcile the backpressure policy into one documented constant.** Pick one high-water mark (or one
   per-media rationale grounded in a fresh benchmark), apply it to video (`:748`) and audio
   (`webcodecs-audio.ts:63`), and update ADR-026/doc 09 (currently "8") to match.
   *Acceptance:* a benchmark over ≥3 real transcode inputs shows the chosen mark is within noise of the best
   sampled mark; `queueIsBackpressured`/`shouldApplyBackpressure` unit tests assert the new value; the doc and
   the constant agree (grep gate).

3. **Deduplicate the cross-file helpers.** Move `enqueueOrClose`, `enqueueOrDrop`, `Closable`, `EnqueueSink`,
   `TransformerWithCancel`, and `decoderErrorToCapabilityMiss` into one shared module imported by both drivers
   (both files are S30-owned).
   *Acceptance:* each symbol is defined exactly once (grep shows a single `export function enqueueOrClose`);
   the existing Node unit tests for these helpers still pass importing from the shared module.

4. **Inject the acceleration verdict cache; remove the module global.** Replace the `videoDecoder
   AccelerationCache` singleton (`:546`) with a cache owned/passed by the engine (or router), so two engine
   instances are isolated and tests can supply a fresh cache.
   *Acceptance:* a test constructs two decoder factories with independent caches and asserts a verdict set in
   one is **not** visible in the other; no top-level `createVideoDecoderAccelerationCache()` call remains
   (grep gate).

5. **Give audio decode the control-queue barrier (config-proof before first packet).** Add an empty-`flush()`
   barrier after `configure()` in `webcodecs-audio.ts:createDecoder` so an approved-but-unsupported config
   fails as a `CapabilityError` before any `EncodedAudioChunk` is submitted, matching the video path.
   *Acceptance:* an injected fake `AudioDecoder` that accepts `configure` but rejects on the barrier flush
   makes the readable reject with `CapabilityError('capability-miss')` and emits **zero** `AudioData`; a
   passing-config case still decodes normally.

6. **Bound audio decoded-output explicitly (or document why the readable HWM suffices).** Either add the video
   decoder's `waitForOutputRoom` output-queue bound to audio, or add a doc note + test proving a fast
   `AudioDecoder` + slow consumer cannot accumulate unbounded `AudioData`.
   *Acceptance:* a Node test drives the audio decode path with a decoder that emits N frames ahead of a paused
   consumer and asserts buffered `AudioData` count stays ≤ the chosen bound and every frame is closed exactly
   once.

7. **Isolate the Apple-H264 chroma-phase quirk behind a seam; stop reading `navigator` in the driver body.**
   Move `needsAppleH264HorizontalPhaseCompensation` + the canvas re-draw + `avcC` crop rewrite behind an
   injectable "encoder input adaptor" whose platform input is passed in, not read from global `navigator`
   (`:1333`).
   *Acceptance:* `needsAppleH264HorizontalPhaseCompensation` unit tests still pin the width ≡ 2 (mod 4) + Apple
   platform rule; the encoder core has no reference to `navigator`; a test injects `platform:'MacIntel'` and
   asserts the compensated wire width (`config.width + 2`) and the rewritten crop, and `platform:'Win32'`
   asserts the zero-copy path.

8. **Update ADR-026/doc 09 for the encoder accel hint.** Record that the encoder configures `auto →
   'no-preference'` (not `'prefer-hardware'`), citing the session13 measurement, and add an ADR in
   `docs/decisions/`.
   *Acceptance:* the doc statement matches `normalizeHardwareAcceleration` (`:54-58`) and the encoder
   `configure` call (`:1400-1404`); the ADR cites the 2,298.9-vs-2,278.5 ms evidence.

9. **Consider splitting `webcodecs-video.ts` by concern** (config-key/cache, fresh coders, warm pool) once #1
   lands, to retire the 2,113-line god-file.
   *Acceptance:* no single S30 source file exceeds a stated size budget (e.g. 1,000 lines); public exports and
   the driver `id`s are unchanged (import-surface test green).

### S31 — WASM Codec Tail

Source: [`docs/codecs/wasm-tail.md`](docs/codecs/wasm-tail.md) · owned code + rationale in the doc.

Ordered by risk-to-correctness, then by leverage. Each item names the change, the `path:line`, and a
falsifiable acceptance test.

**D1 — Cache decoder geometry once in `wasm-mp3` and `wasm-vorbis` (heap-corruption bug).**
Read `dec.channels`/`dec.sampleRate` **once** in `start()` after `createDecoder(...)`, cache them in locals
(mirror `wasm-aac-driver.ts:247-251, 269-270`), and use the cached values in every `transform`
(`wasm-mp3-driver.ts:283, 290-291`; `wasm-vorbis-driver.ts:283, 290-291`).
*Acceptance:* a Node oracle decodes a ≥500-frame MP3 and Vorbis fixture through the driver and asserts the
concatenated PCM is bit-exact to the golden ffmpeg decode (`measured-evidence.md` line 689 method); a regression test
asserts the geometry getters are invoked exactly once per stream (spy/counter), not once per packet.

**D2 — Make the `wasm-vpx` glue probe cheap (don't ship 450 KB to answer `supports()`).**
Split `vpx-core.js` so `hasVpxCoreGlue()` no longer transitively imports `vpx-vp8-data-wasm.js`/
`vpx-vp9-data-wasm.js` (`vpx-core.js:25-26`) — move the base64 blobs behind a dynamic `import()` reached only
from `createDecoder`'s `loadVpxCore` (`wasm-vpx-driver.ts:93-98, 108-135`).
*Acceptance:* a bundle/network test loads the driver, calls `supports()` for a VP9 query, and asserts the
`vpx-*-data-wasm` chunk was **not** fetched; then calls `createDecoder` and asserts it **is** fetched
(mirror the existing bundle-analysis test in `measured-evidence.md` line 81).

**D3 — Close the enqueue-error `VideoFrame` leak in `wasm-vpx`.**
In `enqueueFrames` (`wasm-vpx-driver.ts:362-367`) replace the `try/finally` with the AV1 pattern: on a
successful `enqueue`, delete from `pending`; on throw, delete from `pending`, call `frame.close()`, and
rethrow (mirror `wasm-av1-driver.ts:256-264`).
*Acceptance:* a unit test injects a controller whose `enqueue` throws on the 2nd frame of a superframe and
asserts every constructed `VideoFrame`'s `close()` was called exactly once (spy), with none left in
`pending` and none leaked.

**D4 — Honor input chunk PTS in the audio decode tails (seek/VFR correctness).**
Seed `emittedSamples`/the output timestamp from the **first** decoded chunk's `chunk.timestamp` (converted to
samples) instead of a hard 0, in AAC/MP3/Opus/Vorbis (`wasm-mp3-driver.ts:244, 291-293`;
`wasm-opus-driver.ts:301, 336-338`; and the AAC/Vorbis equivalents). Keep the contiguous sample counter for
subsequent packets.
*Acceptance:* decode a fixture starting at a non-zero container PTS (e.g. a mid-stream trim segment) and
assert the first emitted `AudioData.timestamp` equals the source chunk's timestamp (±0 µs), not 0; regression
proves a from-0 decode is unchanged.

**D5 — Wire `reset()` for in-stream seek, or delete it from the contract.**
Either (a) have the pipeline-driven in-stream seek call `decoder.reset()` at a discontinuity (MP3 bit
reservoir, Vorbis/AAC overlap history) — interface already present (`wasm-mp3/mp3.ts` `reset`,
`wasm-vorbis/vorbis.ts` `reset`, `aac-core.d.ts` `reset`) — or (b) remove `reset()` and document
"seek = fresh stream" as the only supported model.
*Acceptance:* if (a), a test seeds a decoder, seeks (calls the discontinuity path), and asserts the
post-reset first-frame PCM matches a fresh-decoder decode of the same keyframe; if (b), the interface no
longer declares `reset()` and a comment states the fresh-stream contract.

**D6 — Add a transformer `cancel(reason)` to every coder so teardown runs on bare stream cancel.**
Add `cancel()` alongside `start`/`transform`/`flush` in each `TransformStream` initializer (e.g.
`wasm-opus-driver.ts:396-448`) that runs the existing `teardown()` (frees the native decoder/encoder, closes
`pendingFrames`).
*Acceptance:* build a decoder, pump one chunk, then `reader.cancel()` **without** aborting the signal; assert
the native `free()` was called once and every pending `VideoFrame`/`AudioData` `close()`d — today `free()`
is skipped because only the signal path calls teardown.

**D7 — Fix `wasm-vorbis-enc` loader to match the tail contract.**
Give `loadVorbisEncCore` a `assetBaseUrl` parameter, resolve the core URL through `resolveWasmAssetUrl` +
`wasmInitForProfile`, key `corePromises` on `profile.kind|moduleUrl.href` (not `profile.kind` alone,
`wasm-vorbis-enc-driver.ts:73`), and pass `o?.wasmAssetBaseUrl` from `createEncoder`
(`wasm-vorbis-enc-driver.ts:225`). If the core is genuinely self-contained base64 with no fetchable asset,
delete the misleading URL machinery instead and document it.
*Acceptance:* two engines constructed with different `assetBaseUrl` values each load their own core (no cache
collision); a same-origin-base-url test proves the encoder honors `assetBaseUrl` or a comment documents why
it cannot.

**D8 — Remove the vestigial `./vpx.wasm` URL and update stale doc-comments.**
Delete the `resolveWasmAssetUrl('./vpx.wasm', …)` machinery in `loadVpxCore` (`wasm-vpx-driver.ts:113-125`)
or replace it with the real embedded-core load path; correct `vpx-core.d.ts` and the driver header comment
(`wasm-vpx-driver.ts:16-18`) to say "base64-embedded, self-contained". Refresh the `wasm-av1` header
(`wasm-av1-driver.ts:6-10`) to drop "scaffold until vendored" now that dav1d is vendored.
*Acceptance:* `grep vpx.wasm src/codecs/wasm-vpx` returns nothing; a doc-lint/test asserts no owned
doc-comment references a non-existent asset; AV1 header no longer says "scaffold".

**D9 — Extract the shared audio-decode / core-loader helper (kill the 7× duplication).**
Factor `buildAudioData`, `samplesToMicros`, `chunkBytes`, `asAudioChunk`, `deinterleaveF32` glue,
`hasWebCodecsAudioSeam`, and the `corePromises`/`coreGluePromise`/`loadXCore`/`teardown` skeleton into one
`src/codecs/wasm-shared/` module the four audio decoders and the two encoders consume. This is the change
that prevents D1/D3 from ever diverging again.
*Acceptance:* the four audio decode drivers import one shared `buildAudioData`/loader; a test asserts the
per-driver files no longer redefine these symbols (AST/grep), and the full decode conformance matrix stays
green (bit-exact goldens for AAC/MP3/Vorbis/Opus).

**D10 — Delete the dead `decodeMany` contract surface (or use it).**
Remove `decodeMany` from `AacWasmCore`/`AacWasm` (`wasm-aac/aac.ts:341`, `aac-core.d.ts`) unless a batched
decode path is wired to it. *Acceptance:* `grep decodeMany src/codecs` shows only a definition that is
actually called, or none.

### S32 — FLAC & Image Codecs

Source: [`docs/codecs/flac-and-image.md`](docs/codecs/flac-and-image.md) · owned code + rationale in the doc.

Ordered; each item names the change, the `path:line`, and a concrete acceptance oracle.

1. **Hoist the `ImageOps`/`ImageRegistry` contract out of the codecs layer; fix the stale docstring.** Today `src/kernel/registry.ts:11` imports these types from `src/codecs/image/image-driver.ts`, and `Registry` implements `ImageRegistry` (`registry.ts:45`), so the kernel depends on a codec module. Move the `ImageOps`/`ImageRegistry` *interfaces* into the driver-contracts layer (S04, `src/contracts/`), have `image-driver.ts:34-50,63-65` import them, and rewrite the `image-driver.ts:9-15,78-99` docstring to reflect that the kernel `Registry` *does* own an image slot. **Acceptance:** `grep -r "codecs/image" src/kernel` returns nothing; `registry.test.ts` (addImageOps idempotency) stays green; `defaults.ts:96` drops the optional `addImageOps?` cast and calls the now-mandatory slot directly.

2. **Make the LPC predictor bit-exact for full 32-bit streams.** `restoreLpc` sums `coef*sample` in a float64 (`decode.ts:166-171`); a 15-bit coefficient × 33-bit side-channel sample over up to 32 taps can exceed 2^53 and silently lose bits — the code's own comment admits exactness only "for ≤24-bit content" (`decode.ts:8-11`). Accumulate in a mantissa-safe way (BigInt for the wide case, or a split hi/lo accumulator) so the predictor is exact for `bitsPerSample === 32`. **Acceptance:** add a 32-bit / high-order-LPC FLAC fixture (or synthesize one) and assert `md5(interleavedPcmBytes(decodeFlac(bytes))) === hex(md5)` (the same STREAMINFO-MD5 oracle as `decode.test.ts:20-25`); a deliberately overflow-inducing crafted subframe must decode bit-exactly, not drift.

3. **Reject an illegal negative LPC shift with a typed error.** `restoreLpc` reads the quantization shift as signed 5-bit (`decode.ts:194`) and applies `Math.floor(sum / 2**shift)` (`decode.ts:169`); RFC 9639 §9.2.8 requires shift ≥ 0, and a negative value would silently mis-scale (turning a right shift into a left shift) instead of rejecting a malformed/fuzzed stream. Throw `MediaError('decode-error', ...)` when `shift < 0`. **Acceptance:** a crafted subframe with a negative shift raises `MediaError` (mirror the lost-frame-sync test at `decode.test.ts:39-46`); the IETF corpus still passes MD5 (`decode.test.ts:19-26`).

4. **Close the in-flight `decoder.decode()` frame on abort.** `raceAbort` (`decode.ts:173-190`) rejects as soon as the signal aborts, abandoning the underlying `decoder.decode()` promise; if that promise later resolves to `{ image }`, the `VideoFrame` is never `close()`d (the `finally`'s `decoder.close()` at `decode.ts:113` may not release an already-vended frame). Attach a continuation that `close()`s any late-resolving image. **Acceptance (browser/fake-`ImageDecoder` harness):** abort mid-decode with a stub whose `decode()` resolves *after* the abort; assert the late `VideoFrame.close()` is called exactly once and no frame leaks (track live-frame count).

5. **Add a bounded/streaming FLAC decode for longform decode-seek/trim.** `decodeFlac` allocates the whole PCM up front (`decode.ts:347-348`), so a one-hour 96 kHz file materializes hundreds of MB. Add a generator that yields one decoded frame's planes at a time (bounded to O(blockSize·channels)), reusing `decodeFrame` (`decode.ts:307-343`). **Acceptance:** decoding a synthesized long FLAC keeps peak allocation O(blockSize·channels), not O(totalSamples), measured by a heap/`ArrayBuffer`-peak probe (cf. the WAV memory-lifecycle method in `measured-evidence.md`); per-frame MD5 accumulation still reproduces the STREAMINFO digest.

6. **Split frame-span enumeration from frame decoding.** `enumerateFlacFrameSpans` fully decodes every subframe just to measure byte spans (`decode.ts:371-388`) — correct for goldens, wasteful for the demux/`packetInfo` hot path. Keep the decode-validating enumerator (rename it `enumerateFlacFrameSpansValidating` for `test-support/packet-goldens.ts`) and add a header-only walk that parses + CRC-checks the frame header and re-syncs to the next `0x3ffe`/CRC-valid boundary without decoding PCM. **Acceptance:** the header-only walk on `flac-blocksize-16.flac` yields byte-identical spans to the validating enumerator (harvest: 19,294 packets) with no subframe decode; a benchmark shows it at the fused-parser scale (~10^-3 ms, `measured-evidence.md`), not the decode-bound cost.

7. **Add LPC subframes to the encoder (compression-ratio ceiling).** The encoder is FIXED-only (`encode.ts:46-47,479-495`); ADR-086 flags LPC as the future ratio win, and the decoder already restores LPC (`decode.ts:159-171`). Add Levinson-Durbin windowed LPC analysis, quantized coefficients, and a `writeSubframe` LPC arm, keeping the cost-only planning model (`encode.ts:349-495`). **Acceptance:** on the `wav_s16` corpus the compressed size beats the FIXED-only baseline while `decodeFlac`→STREAMINFO-MD5 still round-trips bit-exactly (`encode.test.ts`), and an independent `flac -t`/`ffmpeg` decode confirms the output.

8. **Expose random-access frame seek for animated images.** `decodeImageFrames` always iterates `0..frameCount` (`decode.ts:95-111`) even though `ImageDecoder.decode({frameIndex})` is random-access (`decode.ts:97-100`). Accept an optional `{ startIndex, endIndex }` in `DecodeImageOptions` (`decode.ts:28-31`) so a seek decodes only the requested range with correct cumulative timestamps. **Acceptance (browser harness):** decoding frame 20 of a 36-frame GIF issues exactly one `decode({frameIndex:20})` and returns a frame whose `timestamp` equals the summed prior header delays; zero prior frames decoded.

9. **Close any queued `VideoFrame` when the `ReadableStream` is cancelled.** `decodeImage`'s `pull` transfers ownership via `controller.enqueue(value)` (`decode.ts:137`); with `highWaterMark: 0` this is normally demand-paced, but a `cancel()` that races a resolved-but-unread enqueue would drop that `VideoFrame` without `close()`. Add a queuing strategy / cancel hook that drains and closes any queued frame. **Acceptance:** cancel immediately after a `read()` resolves with a fake decoder that had a frame queued; assert no leaked frame (live-frame count returns to zero). If proven unreachable under HWM 0, replace the fix with a test that *documents* the invariant.

10. **Pin the `bitDepth`/`colorType` exactness boundary per format.** WebP unconditionally reports `bitDepth: 8` (`probe.ts:440,451,497,503`) and `colorType` is a fixed `'lossy'`/`'lossless'`/`'rgb'`/`'rgba'` guess, whereas PNG (`probe.ts:326-327`), JPEG precision (`probe.ts:397,407`), GIF GCT depth (`probe.ts:215`), and AVIF `av1C` (`probe.ts:617-621`) read real header values. Document, per format, which fields are exact vs assumed, and assert the exact ones. **Acceptance:** a per-format probe test asserts `bitDepth` against ffprobe/real-file truth for ≥1 fixture each; formats where depth is assumed (WebP) carry an explicit `UNVERIFIED`-style code comment and an open decision (§6).

11. **Stop exporting the `at()`/`chan()` hot-loop helpers; dedup `interleavedPcmBytes`.** `at`/`chan` are `export`ed only for a coverage test (`decode.ts:110-119`, `decode.test.ts:49-58`), and `interleavedPcmBytes` exists twice (`decode.ts:393`, `encode.ts:848`). Make `at`/`chan` module-private (exercise both arms via a crafted corpus fixture through `decodeFlac`) and keep a single `interleavedPcmBytes` (one shared helper, imported by both). **Acceptance:** `grep "export function at\|export function chan" src/codecs/flac/decode.ts` is empty; only one `interleavedPcmBytes` definition remains; branch coverage stays ≥ the repo gate and all MD5 round-trip tests pass.

## 5. Open decisions that gate some fixes

Several items above can't be finished until a design question is decided. Each shard's **§6 Open questions** lists them; resolve and record in [`docs/decisions/`](docs/decisions/README.md). Shards carrying open questions:

- **S01** Capability Router & Tier Ladder — [capability-router.md §6](docs/architecture/capability-router.md#6-open-questions)
- **S02** Execution & Runtime — [execution-runtime.md §6](docs/architecture/execution-runtime.md#6-open-questions)
- **S03** Worker & WASM Runtime — [worker-and-wasm-runtime.md §6](docs/architecture/worker-and-wasm-runtime.md#6-open-questions)
- **S04** Driver Contracts & Registry — [driver-contracts.md §6](docs/architecture/driver-contracts.md#6-open-questions)
- **S05** Public API — [public-api.md §6](docs/architecture/public-api.md#6-open-questions)
- **S06** Input Sources — [sources.md §6](docs/architecture/sources.md#6-open-questions)
- **S08** Packaging & Loading — [packaging-and-loading.md §6](docs/architecture/packaging-and-loading.md#6-open-questions)
- **S13** Codec Pipeline (shared brain) — [codec-pipeline.md §6](docs/architecture/codec-pipeline.md#6-open-questions)
- **S33** Testing & Validation — [testing-and-validation.md §6](docs/architecture/testing-and-validation.md#6-open-questions)
- **S07** Sinks & Streaming Output — [streaming-output.md §6](docs/operations/streaming-output.md#6-open-questions)
- **S09** Probe & Demux — [probe-and-demux.md §6](docs/operations/probe-and-demux.md#6-open-questions)
- **S10** Decode & Seek — [decode-seek.md §6](docs/operations/decode-seek.md#6-open-questions)
- **S11** Transcode — Video — [transcode-video.md §6](docs/operations/transcode-video.md#6-open-questions)
- **S12** Transcode — Audio & Convert — [transcode-audio-convert.md §6](docs/operations/transcode-audio-convert.md#6-open-questions)
- **S14** Mux — [mux.md §6](docs/operations/mux.md#6-open-questions)
- **S15** Remux — [remux.md §6](docs/operations/remux.md#6-open-questions)
- **S16** Trim — [trim.md §6](docs/operations/trim.md#6-open-questions)
- **S17** Audio DSP & PCM Convert — [audio-dsp.md §6](docs/operations/audio-dsp.md#6-open-questions)
- **S18** Video Filters — [video-filters.md §6](docs/operations/video-filters.md#6-open-questions)
- **S19** Encryption / Decrypt — [encryption.md §6](docs/operations/encryption.md#6-open-questions)
- **S20** Metadata — [metadata.md §6](docs/operations/metadata.md#6-open-questions)
- **S21** Performance Methodology — [performance.md §6](docs/operations/performance.md#6-open-questions)
- **S22** Robustness — [robustness.md §6](docs/operations/robustness.md#6-open-questions)
- **S23** MP4 / MOV Driver — [mp4.md §6](docs/drivers/mp4.md#6-open-questions)
- **S24** WebM / MKV Driver — [webm-mkv.md §6](docs/drivers/webm-mkv.md#6-open-questions)
- **S25** MPEG-TS & HLS Driver — [mpegts-hls.md §6](docs/drivers/mpegts-hls.md#6-open-questions)
- **S26** Ogg Driver — [ogg.md §6](docs/drivers/ogg.md#6-open-questions)
- **S27** WAV / AIFF / CAF Drivers — [wav-aiff-caf.md §6](docs/drivers/wav-aiff-caf.md#6-open-questions)
- **S28** MP3 / ADTS / FLAC Drivers — [mp3-adts-flac.md §6](docs/drivers/mp3-adts-flac.md#6-open-questions)
- **S29** AVI Driver — [avi.md §6](docs/drivers/avi.md#6-open-questions)
- **S30** WebCodecs Codec Tier — [webcodecs.md §6](docs/codecs/webcodecs.md#6-open-questions)
- **S31** WASM Codec Tail — [wasm-tail.md §6](docs/codecs/wasm-tail.md#6-open-questions)
- **S32** FLAC & Image Codecs — [flac-and-image.md §6](docs/codecs/flac-and-image.md#6-open-questions)

---
*Generated from the 33 target-spec docs' Delta/punch-lists (334 requirements). Regenerate after editing any doc's §5 so this stays the single source of truth for the fix backlog.*
