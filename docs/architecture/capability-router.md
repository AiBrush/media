# Capability Router & Tier Ladder

> Shard S01. Owned code: `src/kernel/router.ts`, `src/kernel/tier-thresholds.ts`,
> `src/kernel/tier-thresholds-telemetry.ts`.
> This document is the **target spec** (the best design) plus an **honest delta** against today's code.
> Every claim traces to `path:line` or a cited external source; unverifiable claims are marked `UNVERIFIED`.

## 1. Purpose & scope

The capability router is the **routing spine** of aibrush-media: the one component that, for every stage
of every operation, selects **exactly one** driver to execute it. It is not a benchmark family of its own —
it *serves all 13 families* (probe, demux, decode-seek, transcode, mux, remux, trim, audio-dsp,
video-filters, encryption, metadata, streaming-output, robustness, performance). Whenever a family's
pipeline needs to decode/encode a codec, demux/mux a container, or run a filter, it asks the router for the
backend, and the router answers with a driver — or fails loudly.

The router encodes one philosophy: **the developer never names a backend.** They express *intent* ("convert
this to Opus in WebM"); the router resolves *mechanism* (hardware WebCodecs, a GPU shader, a pure-TS kernel,
or a WASM tail) by walking a **tier ladder** best-first, probing each candidate's cheap `supports()`, and
returning the first that can do the work. On a true miss it throws a typed `CapabilityError` naming every
driver it tried (`src/kernel/router.ts:104`, `:131`, `:167`) — never a silent wrong result, never a
fabricated output.

Three selection surfaces exist, one per driver kind (`src/kernel/router.ts:67`, `:114`, `:141`):

- `pickCodec(q, opts)` — **async** (its probe wraps `VideoEncoder/Decoder.isConfigSupported`).
- `pickContainer(q, opts)` — **sync** (magic bytes / MIME / extension).
- `pickFilter(spec, opts)` — **sync** (substrate capability predicate).

The router also owns the **cost-aware tiny re-ranking** policy: below the ADR-020 thresholds
(`src/kernel/tier-thresholds.ts:26-33`) it re-ranks cheap in-process/native work ahead of GPU/WASM setup,
because setup cost dominates for tiny media (measured-evidence.md, ADR-020).

## 2. Spec & references

**Governing standard — W3C WebCodecs, the `isConfigSupported` capability model.**

- W3C WebCodecs specification: <https://www.w3.org/TR/webcodecs/> — and the editor's draft
  <https://w3c.github.io/webcodecs/>.
- Each of the four codec interfaces exposes a static probe:
  `static Promise<VideoEncoderSupport> VideoEncoder.isConfigSupported(VideoEncoderConfig config)` (and the
  Video**Decoder** / Audio**Encoder** / Audio**Decoder** analogues). The returned `*Support` dictionary has
  two members: `supported` (boolean) and `config` (the cloned config containing **only** members the User
  Agent recognized). Verified via WebFetch of the spec, 2026-07-16.
- The router never calls these directly. It calls each driver's `supports()`
  (`src/contracts/driver.ts:175-176`: "*Cheap, honest capability check (wraps `isConfigSupported`); returns
  `false`, never throws later*"). This keeps the WebCodecs API name **inside the codec-driver layer** — the
  router speaks only in `CodecSupport { supported, hardwareAccelerated?, reason? }`
  (`src/contracts/driver.ts:155-159`). No WebCodecs symbol leaks into the kernel.
- Hardware acceleration hint: the WebCodecs `hardwareAcceleration` config value is one of `no-preference` /
  `prefer-hardware` / `prefer-software` (spec §"Hardware Acceleration"; exact enum values are
  `UNVERIFIED` from the fetched excerpt but are the well-known spec values). Our determinism model
  (`Determinism = 'auto' | 'force-software'`, `src/contracts/driver.ts:30`) maps to these at the codec-driver
  layer (S30), not in the router.

**OSS exemplar — mediabunny `canEncode` / `getEncodableCodecs`.**

- Repo: <https://github.com/Vanilagy/mediabunny>. Capability helpers live in
  <https://github.com/Vanilagy/mediabunny/blob/main/src/encode.ts>. Guide:
  <https://mediabunny.dev/guide/supported-formats-and-codecs>.
- Verified signatures (WebFetch of `src/encode.ts`, 2026-07-16):
  `canEncode(codec) => Promise<boolean>`, `canEncodeVideo(codec, options?) => Promise<boolean>`,
  `canEncodeAudio(...)`, `getEncodableCodecs() => Promise<MediaCodec[]>`,
  `getEncodableVideoCodecs(checkedCodecs?, options?)`, `getFirstEncodableVideoCodec(checkedCodecs, options?)
  => Promise<VideoCodec | null>`. Each builds an encoder config and calls
  `await VideoEncoder.isConfigSupported(encoderConfig)` / `await AudioEncoder.isConfigSupported(...)`.
- **Memoization**: mediabunny caches results in two **module-level** Maps,
  `export const canEncodeVideoMemo = new Map<string, Promise<boolean>>()` and `canEncodeAudioMemo`, keyed by
  `const key = JSON.stringify(encoderConfig)` (verified, `src/encode.ts`).
- **Where our design must match/beat it** (drives §5):
  1. mediabunny picks a **codec** from a caller list; our router picks a **driver/substrate** for a *fixed*
     codec+config, and adds a **WASM fallback tail** mediabunny has no analogue for — miss-only. This is the
     core win: mediabunny returns `null` when WebCodecs can't encode; we drop to a WASM tail before giving up.
  2. mediabunny's memo is a **process-global** Map that survives across every mediabunny instance and test;
     ours is **instance-scoped** (`#codecCache` on the `Router` object, `src/kernel/router.ts:57`), bounded
     to 64 entries with LRU eviction (`src/kernel/router.ts:51`, `:186-192`), and invalidated on driver
     registration (`clearCache`, `:180-184`).
  3. mediabunny keys on `JSON.stringify(encoderConfig)`, which mis-serializes a `BufferSource` `description`
     (avcC/DecoderConfig extradata) and throws on `bigint`. Our `exactRecordIdentity`
     (`src/kernel/router.ts:302-365`) hashes `BufferSource` **byte-exactly** and *skips caching* (re-probes)
     for cyclic/cross-realm/hostile shapes rather than mis-keying them.

## 3. Target design

### 3.1 Data model

The router is a small, dependency-injected class (`src/kernel/router.ts:54-61`):

```ts
// src/kernel/router.ts:46-49
export interface RouterDeps {
  registry: RegistryView;
  ensureLoaded?: EnsureLoaded;
}
```

It reads drivers from a `RegistryView` (`src/kernel/registry.ts:22-28`) — three insertion-ordered snapshots
(`codecs()`, `containers()`, `filters()`). It owns three caches (codec/container/filter,
`src/kernel/router.ts:57-59`). Per-selection knobs are `StageSelectOptions` (`src/kernel/router.ts:36-41`):
`determinism`, an internal `cost: RouteCost`, and a hidden `pinDriver`. **`cost` is an internal re-ranking
input, never a public backend knob** (`src/kernel/router.ts:35`); `pinDriver` is a hidden escape hatch
(ADR-014), scoped to one driver kind (`src/kernel/router.ts:200-217`).

The tier vocabulary is fixed in the contract (`src/contracts/driver.ts:26`):
`type Tier = 'hardware' | 'gpu' | 'native' | 'wasm'`, and for filters the substrate ladder
(`src/contracts/driver.ts:529`): `webgpu → webgl → canvas2d → native → wasm`.

### 3.2 The tier ladder (the routing law)

**Codecs** (`codecTierRank`, `src/kernel/router.ts:280-284`):

| Regime | Order (best → worst) |
| --- | --- |
| Normal (not tiny) | hardware (0) → **gpu (1)** → **native (2)** → wasm (3) |
| Tiny (below thresholds) | hardware (0) → **native (1)** → **gpu (2)** → wasm (3) |

The **only** difference in the tiny regime is that in-process `native` and `gpu` swap: for tiny media the
per-op GPU/WASM *setup* cost dominates the work, so a pure-TS kernel wins. WASM is **always last** — it is
downloaded and built **only on a hardware/native miss** (the miss-only rule; each WASM driver's own header
states "*the router only calls this after WebCodecs … has already missed*", e.g.
`src/codecs/wasm-vpx/wasm-vpx-driver.ts:166`).

**Filters** (`filterRank`, `src/kernel/router.ts:286-296`):

| Regime | Order |
| --- | --- |
| Normal | webgpu (0) → webgl (1) → canvas2d (2) → native (3) → wasm (4) |
| Tiny | native (0) → canvas2d (1) → webgpu (2) → webgl (3) → wasm (4) |

`.slice().sort(...)` is used so registration order is preserved among equal ranks (ES2019 sort is stable;
`src/kernel/router.ts:84-85`, `:155-156`). **This is the routing spine's single source of truth for
"hardware WebCodecs → GPU → WASM"** — with two nuances the slogan hides: (a) a pure-TS `native` rung sits
between GPU and WASM, and (b) tiny work inverts native↔GPU.

**Containers have no tier** (`src/kernel/router.ts:113`): registration order *is* the ladder; the first
driver whose sync `supports()` matches wins.

### 3.3 Capability routing walk (WebCodecs → GPU → WASM, miss-only)

`pickCodec` (`src/kernel/router.ts:67-111`) is the canonical walk:

1. Resolve `determinism` (default `'auto'`) and whether the op is `tiny` (`src/kernel/router.ts:68-69`).
2. Compute an exact cache key from the config (`codecCacheKey`, `:302-311`). On a hit, refresh LRU order and
   return (`:73-79`).
3. Build the candidate list: filter by `pinDriver`, drop `gpu` tier under `force-software`, then **stable-sort
   by `codecTierRank`** (`:81-85`).
4. Walk candidates best-first. For each: `await ensureLoaded(d)` (lazy-import hook), then
   `await d.supports(q, { determinism })`. Accept the first whose verdict passes `supportsDeterminism`
   (`:87-90`, `:220-229`).
5. **Cache only the top rung** (`d === candidates[0]`) and only if the caller's config dict stayed
   byte-for-byte identical across the async probe (`:94-100`). A lower-tier positive is valid *for this op*
   but is **re-probed next time**, so a temporarily-unavailable hardware/native rung can recover (ADR-207,
   measured-evidence.md).
6. Exhausted → `throw new CapabilityError('capability-miss', …, { op, tried })` (`:104-110`).

**Miss-only WASM download.** The Router itself is substrate-agnostic — it only ranks and probes. The
*heavy-WASM-only-on-miss* guarantee is produced by two facts working together: WASM drivers rank last
(§3.2), and the engine registers/loads the first-party driver bundle **lazily, on the first miss**
(`src/api/engine.ts:1108-1118` → `pickCodecWithDefaultFallback`, `src/drivers/default-codec-registration.ts:47-64`;
containers `:948-963`; filters `:1143-1149`). A definite native-audio query even registers *only* the one
native driver first and retries before pulling the full defaults+WASM bundle
(`src/drivers/default-codec-registration.ts:24-34`).

### 3.4 Edge cases

- **B-frames / reordering.** *Out of the router's scope by construction.* The router selects a driver from a
  codec `config`; it never inspects packet order. DTS/composition-offset handling lives on the `Packet` seam
  (`src/contracts/driver.ts:89-100`) and in container drivers. One coupling remains (see §3.4 seek/cancel):
  the router must not permanently cache a driver that only *later* fails on reordered/open-GOP packets.
- **VFR (variable frame rate).** *Not a routing input.* Frame rate never enters the codec cache key
  (`codecCacheKey`, `src/kernel/router.ts:302-311` keys the whole `config`, and `TrackInfo.fps` is derived
  metadata, `src/contracts/driver.ts:245-246`). The tiny-cost `videoPixelWork` estimate
  (`src/kernel/tier-thresholds.ts:33`) uses a 30 fps *planning cadence* only as a reference boundary, not a
  real cadence — so VFR content routes identically to CFR.
- **Seek.** The router treats a seek-decode like any decode: it picks the codec driver for the config. The
  perf-critical coupling is the **hardware-acceleration verdict** the probe already computed
  (`CodecSupport.hardwareAccelerated`, `src/contracts/driver.ts:157`): ADR-203 measured a **~4×** decode
  regression (VP9 476 ms vs 118 ms, tiny H.264 265 ms vs 106 ms) when the decoder discarded that verdict and
  configured `no-preference` (measured-evidence.md, ADR-203). **Target design: `pickCodec` must surface the
  `hardwareAccelerated` verdict it observed** so the seek decoder configures the exact accepted rung without
  a second probe. Today it discards it (delta §5.2).
- **Cancel.** Not the router's concern *directly* — selection is synchronous-ish and cheap. But an
  `AbortSignal` flows on `StageOptions` (`src/contracts/driver.ts:46`) to the driver the router returns; the
  driver `close()`s in-flight frames on abort (`src/contracts/driver.ts:167-171`). The router holds no frames.
- **Frame lifetime (`close()` exactly once).** **The router never touches a `VideoFrame`/`AudioData`.** It
  routes *before* any frame exists and returns a `TransformStream` factory (`createDecoder`/`createEncoder`,
  `src/contracts/driver.ts:177-178`). Frame ownership/closing is entirely the executor's + driver's
  responsibility (S02/S30). This is the correct seam: keeping routing frame-free means a routing bug can
  never leak a frame.
- **Backpressure.** Not applicable to routing — the router emits no stream. Backpressure lives on the
  `TransformStream` seams the selected drivers expose (S02). One capacity concern *does* belong here: the
  caches must be **bounded** so a long-lived engine cannot grow them without limit (delta §5.5).

### 3.5 Determinism & `force-software`

`force-software` demands cross-machine-reproducible output, so hardware/GPU output (M1-specific ANGLE, etc.)
is disallowed (ADR-007, measured-evidence.md). The router (a) drops `gpu`-tier codecs and GPU filter substrates from
the candidate set (`src/kernel/router.ts:83`, `:154`), and (b) requires an **explicit non-hardware verdict**:
a `tier:'hardware'` WebCodecs driver keeps its rank but must return `hardwareAccelerated: false` to be
accepted (`supportsDeterminism`, `src/kernel/router.ts:220-229`). Without (b), a driver that keeps
`tier:'hardware'` for ranking but configures `prefer-software` at execution would be wrongly accepted for a
native-only config (measured-evidence.md, session12 force-software). Measured: 1.640 µs per uncached forced-software
selection, 0.744 µs per cached selection (measured-evidence.md, bench-session12-deterministic-routing).

## 4. Current state

**`src/kernel/router.ts` (379 lines).** A single well-factored `Router` class plus pure module-private
helpers. Strengths worth preserving:

- Instance-scoped caches, not module globals (`:57-59`) — strictly better than mediabunny's process-global
  memo (§2).
- Exact structural cache key with a byte-exact `BufferSource` path and hostile-shape rejection
  (`exactRecordIdentity`/`exactValueIdentity`/`exactBytesKey`, `:302-365`). This is genuinely SOTA and should
  be held up as the reference for any other cache in the repo.
- Top-rung-only positive caching for recovery (`:94-100`, ADR-207) and pin-scope-by-kind (`:200-217`).
- Loud typed misses naming `tried` drivers (`:104-110`, `:131-137`, `:167-176`).

Smells / debt:

- **Dead lazy-load seam.** `EnsureLoaded` (`:44`) defaults to `noop` (`:63`, `:376-378`) and the *only*
  production `new Router` passes no `ensureLoaded` (`src/api/engine.ts:210`). So `await this.#ensureLoaded(d)`
  (`:88`) always awaits a no-op. Yet the class docstring claims the router "*lazily loads the chosen driver's
  module*" (`:1-5`). Reality: lazy loading is a **retry-in-engine** pattern (`src/api/engine.ts:1108-1118`,
  `:948-963`), *not* a router responsibility. Docstring over-claims; the seam is unused.
- **Unbounded container/filter caches.** `#codecCache` is LRU-bounded to 64 (`:51`, `:186-192`), but
  `#containerCache` (`:58`) and `#filterCache` (`:59`) have **no bound** — a long-lived engine fed distinct
  MIME/extension/spec keys grows them without limit.
- **The `gpu` codec rung and `webgl` filter substrate are reserved but unimplemented.** `codecTierRank`
  ranks `gpu` (`:281-283`) and `filterRank` ranks `webgl` (`:290`, `:294`), but a grep of `src/codecs/` and
  `src/filters/` shows **no registered codec declares `tier:'gpu'`** and **no filter declares
  `substrate:'webgl'`** (codecs are only `hardware`/`native`/`wasm`; filters only `webgpu`/`canvas2d`/`native`).
  Verified 2026-07-16. Not a bug — reserved rungs the ladder already accommodates — but untested paths.

**`src/kernel/tier-thresholds.ts` (42 lines).** Scalar ADR-020 thresholds
(`TINY_INPUT_BYTES=64 KiB`, `TINY_VIDEO_PIXELS=64×64`, `TINY_MEDIA_SECONDS=1`, `TINY_AUDIO_FRAMES=48_000`,
`TINY_VIDEO_PIXEL_WORK=(64·64+64·64)·30`, `:26-33`). The router imports **only** these scalars (good — keeps
provenance out of the eager kernel).

Smells:

- **Dead export + duplication.** `TierThresholds` (`:18-24`) and `TELEMETRY_SEEDED_TIER_THRESHOLDS` (`:35-41`)
  are exported but have **zero non-test importers** (grep, 2026-07-16). Worse, `TELEMETRY_SEEDED_TIER_THRESHOLDS`
  is defined **a second time** in `tier-thresholds-telemetry.ts:19-42` with the **same numbers re-hardcoded**
  (`64 * 1024`, `64 * 64`, `(64 * 64 + 64 * 64) * 30`) rather than importing the scalar consts — two copies
  that can silently drift.

**`src/kernel/tier-thresholds-telemetry.ts` (42 lines).** `ThresholdProvenance` (`:3-7`),
`TelemetrySeededTierThresholds` (`:9-11`), and the second `TELEMETRY_SEEDED_TIER_THRESHOLDS` (`:19-42`) with
committed telemetry provenance (three `fixtures/golden/bench/*.json` baselines). **All three symbols have
zero importers outside this file** (grep, 2026-07-16) — the entire file is currently dead code carrying
provenance for numbers nothing reads.

**No god-file, no module-global mutable state in the owned files.** The caches are instance fields (good).
The layering smell is the *opposite* of a god-file: an under-used seam (`ensureLoaded`) and two dead
provenance exports.

## 5. Delta / punch-list (ordered)

### 5.1 Evict a cached codec driver on an execution-time (async runtime) capability miss

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

### 5.2 Surface the `hardwareAccelerated` verdict from `pickCodec` (ADR-203 regression guard)

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

### 5.3 Kill the duplicated + dead tier-threshold exports; single source of truth

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

### 5.4 Resolve the dead `ensureLoaded` seam: wire it or delete it (and fix the docstring)

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

### 5.5 Bound the container and filter caches (LRU symmetry with codecs)

`#containerCache`/`#filterCache` are unbounded (`src/kernel/router.ts:58-59`) while `#codecCache` is LRU-64
(`:51`, `:186-192`).

- **Change:** apply the same bounded-LRU discipline (reuse `#rememberCodec`'s eviction logic generically) to
  the container and filter caches, or document a proof that their key spaces are finite and small.
- **Acceptance test:** insert `> bound` distinct container keys (distinct MIME strings) and assert
  `#containerCache` size stays `≤ bound` and the oldest key is evicted (Map insertion-order probe); repeat for
  the filter cache. Reference `src/kernel/router.ts:58-59`, `:127`, `:163`, `:186-192`.

### 5.6 Bake a golden **rank-order** oracle for the tier ladder

The ladder is the routing spine's law but there is no single test that pins the full rank table as an oracle
(`codecTierRank`/`filterRank`, `src/kernel/router.ts:280-296`).

- **Change:** expose the rank tables (or route fakes through `pickCodec`/`pickFilter`) and assert the exact
  order in both regimes.
- **Acceptance test:** assert, non-tiny, `codecTierRank('hardware') < codecTierRank('gpu') <
  codecTierRank('native') < codecTierRank('wasm')`; assert the **tiny inversion**
  `codecTierRank('native', true) < codecTierRank('gpu', true)`; assert `filterRank` gives
  `webgpu < webgl < canvas2d < native < wasm` (non-tiny) and `native < canvas2d < webgpu < webgl < wasm`
  (tiny). Reference `src/kernel/router.ts:280-296`.

### 5.7 Regression-test the byte-exact cache key vs mediabunny's `JSON.stringify` memo

Our key handles what mediabunny's `JSON.stringify(encoderConfig)` cannot (§2). Lock it in.

- **Change:** none (behavior exists); add tests.
- **Acceptance test:** (a) two `VideoDecoderConfig`s with the same `codec` string but **different `description`
  bytes** (avcC X vs Y) produce **distinct** cache keys and may resolve to different drivers; (b) a config
  carrying a getter/`Proxy` trap or a cycle returns `undefined` from `codecCacheKey` and is re-probed (never
  throws out of `pickCodec`). Reference `src/kernel/router.ts:302-365`, `:317-325`.

### 5.8 Test container first-match caching + `clearCache` on `use()`

Containers cache the first matching driver unconditionally (`src/kernel/router.ts:127`), which is safe **only
because** containers have no tier and `clearCache` fires on registration (`src/api/engine.ts:265`, `:1056`,
`:1775`). Make that invariant explicit and tested.

- **Change:** add a doc comment asserting the invariant; add the test.
- **Acceptance test:** register a low-priority container, route a query (populating the cache), then `use()` a
  higher-priority container matching the same MIME; assert the new route wins (proving `clearCache` at
  `src/api/engine.ts:265` invalidated the stale entry). Reference `src/kernel/router.ts:114-138`, `:180-184`.

## 6. Open questions (seed `docs/decisions/`)

1. **Should the router own miss-only lazy loading (`ensureLoaded`), or keep it as an engine retry?** Decide
   between §5.4 Option A (router owns the documented seam) and Option B (delete the seam, engine owns it).
   Whichever wins, the docstring and the design doc must agree. Log as a decision.
2. **What is the return contract of `pickCodec`?** Returning `{ driver, support }` (§5.2) is a breaking change
   to every caller (`src/api/engine.ts:1109`, `:1115`; `src/drivers/default-codec-registration.ts:57`, `:63`).
   Decide: change the return type, or add a separate `probeCodec` that yields the full `CodecSupport`. Log the
   ADR-203 rationale.
3. **Runtime-miss retained-prefix budget.** §5.1's re-route depends on how many bytes/packets the executor
   retains for a WASM replay after an async runtime miss (ADR-284 says "bounded prefix" but not the number).
   That budget is owned by the decode executor (S02/S10), but the router's eviction contract must reference
   it. Decide and record the exact prefix bound.
4. **Are the `gpu` codec tier and `webgl` filter substrate live rungs or reserved?** No registered driver uses
   either today (§4). Decide: ship a GPU/WebGL driver that exercises the rung, or mark the rungs explicitly
   "reserved" in the glossary and add a test-only fake to cover the ranking branch. Log the decision so the
   rank branches (`src/kernel/router.ts:281-283`, `:290`, `:294`) aren't mistaken for dead code.
5. **Should container drivers gain an explicit priority for overlapping formats?** Today two drivers both
   claiming, say, `mp4` resolve by registration order (`src/kernel/router.ts:113`, `:122-130`). If a
   third-party `use()`d driver must *override* a default, is registration order sufficient, or is an explicit
   priority field needed? Decide before third-party container overrides are supported.
6. **Where should the tiny-cost policy live?** The rank + tiny predicates sit in `router.ts`
   (`src/kernel/router.ts:235-296`) while the thresholds sit in `tier-thresholds.ts`. Decide whether to
   co-locate the rank functions with the thresholds (policy in one file, mechanism in the router) — a
   layering call to record.
