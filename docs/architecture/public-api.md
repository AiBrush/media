# Public API

> Shard **S05** — the developer surface of `aibrush-media`.
> Owned code: `src/api/create-media.ts`, `src/api/engine.ts`, `src/api/types.ts`, `src/api/preload.ts`,
> `src/api/runtime-detect.ts`, `src/api/track-select.ts`, `src/core.ts`, `src/image.ts`, `src/index.ts`,
> `src/version.ts`.
> This document is the **target spec** (the best design) plus an honest **delta** against today's code.

---

## 1. Purpose & scope

The public API is the *only* surface an application developer touches. It serves the **developer-surface**
"benchmark family": every one of the 13 measured scenario families (probe, demux, decode-seek, transcode,
remux, trim, mux, audio-dsp, metadata, encryption, streaming-output, robustness, performance) is entered
through a verb on this surface. The API is therefore the contract that all other shards must satisfy.

The surface is split into three entrypoints, each an ESM subpath (`src/index.ts:1`, `src/core.ts:1`,
`src/image.ts:1`):

- **`@aibrush/media`** — the *default entry*: a tiny eager kernel plus intent verbs. Backends are never
  named (`src/index.ts:4-6`). This is what 99% of apps import.
- **`@aibrush/media/core`** — the *driver-author / advanced-embedder* surface: engine internals, the
  driver contracts, the typed error model, the registry/router, the conformance harness, and
  `DRIVER_API_VERSION` (`src/core.ts:1-7`). Kept off the default entry so its weight never joins the
  eager closure.
- **`@aibrush/media/image`** — standalone still/animated image helpers on a subpath so the pure image
  parser stays out of the default-entry budget (`src/image.ts:1-7`).

The guiding principle is **intent, not mechanism**: the developer expresses *what* they want
(`probe`, `convert`, `trim`, `to: 'mp4'`, `codec: 'h264'`) and the engine routes each operation to the best
available substrate internally — hardware WebCodecs → GPU → WASM (miss-only). The developer never names a
*backend* (`src/index.ts:4-6`, `src/api/engine.ts:2-4`). "Codec" and "container" are legitimate *intent*
tokens (the format the developer wants out); "WebCodecs", "GPU", "WASM", `webcodecs-video` are *mechanism*
and must never appear on the surface (ADR-003, `measured-evidence.md`).

Two API styles ride the same engine (ADR-009/010):

1. **Flat verbs** — `probe`, `convert`, `remux`, `trim`, `demux`, `decode`, `seek`, `encode`, `mux`,
   `decrypt`, `h264AbrLadder`, `preload`, `load`, `run` (`src/api/create-media.ts:43-103`), each available
   both as a method on a `createMedia()` instance (`src/api/engine.ts:145-180`) and as a bare function
   backed by a lazily-created default instance (`src/api/create-media.ts:35-41`).
2. **Fluent chain** — `load(input).trim(...).resize(...).to('mp4').blob()` (`src/api/types.ts:239-257`),
   an immutable façade that compiles to the flat verbs (ADR-010).

---

## 2. Spec & references

There is no ISO/W3C RFC for "an intent-based media API"; the governing standards are the W3C/WHATWG specs
the surface *wraps*, plus the named OSS exemplar whose ergonomics we match-or-beat.

- **Intent-not-mechanism (design principle).** The surface exposes goals, not implementations. The
  canonical exemplars of this style are the `ffmpeg` CLI (`-c copy`, `-c:v h264`, `-vf scale=...` — the
  user names the *result*, not the decoder) and mediabunny's `Conversion`. `aibrush-media` goes further:
  even the *codec implementation tier* (hardware vs software vs WASM) is invisible.
- **W3C WebCodecs** — `VideoFrame`/`AudioData` lifetime (`close()` exactly once), `VideoDecoder`,
  `isConfigSupported` capability model. <https://www.w3.org/TR/webcodecs/>. `VideoFrame.close()`:
  <https://www.w3.org/TR/webcodecs/#dom-videoframe-close>. The public `decode`/`seek` return real
  `VideoFrame`/`AudioData` (`src/api/types.ts:295-298`, `src/api/engine.ts:160`), so the WebCodecs
  lifetime contract *is* our frame-lifetime contract.
- **WHATWG Streams** — backpressure and cancellation. Decode/demux/mux surface real
  `ReadableStream`s (`src/api/types.ts:290-298`, `src/api/types.ts:310`); backpressure is the stream's own
  pull mechanism. <https://streams.spec.whatwg.org/>. Backpressure:
  <https://streams.spec.whatwg.org/#pull-source-backpressure>.
- **WHATWG DOM `AbortSignal`/`AbortController`** — the cancellation substrate under `CallOptions.signal`
  and `Cancellable.cancel()` (`src/api/types.ts:91-95`, `src/api/types.ts:344-345`).
  <https://dom.spec.whatwg.org/#aborting-ongoing-activities>.
- **ECMAScript Modules + `import.meta.url`** — self-hosted WASM URL resolution and the exports-map subpath
  split (`@aibrush/media`, `/core`, `/image`). <https://tc39.es/ecma262/#sec-meta-properties>,
  <https://html.spec.whatwg.org/multipage/webappapis.html#import-meta-url> (packaging detail owned by S08;
  referenced here because it shapes the three-entrypoint surface).

**OSS exemplar — mediabunny (top-level API).** Repo: <https://github.com/Vanilagy/mediabunny>. Docs:
<https://mediabunny.dev/>. Local copy studied: `mediabunny@1.48.0`
(`media-test/node_modules/mediabunny/dist/mediabunny.d.ts`).

What mediabunny does and how `aibrush-media` compares:

| Concern | mediabunny (`mediabunny.d.ts`) | `aibrush-media` (target) |
|---|---|---|
| Entry style | Class-based: `new Input(...)`, `new Output(...)`, `Conversion.init(opts).execute()` (`:918`,`:926`) | Verb-based: `convert(input, opts)`; fluent `load(...).convert()` (`create-media.ts:46`, `types.ts:239-257`) |
| Backend hiding | Hidden; custom codecs via `CustomVideoDecoder`/`registerDecoder` | Hidden **and** tier-hidden (HW/GPU/WASM invisible) — stronger (`index.ts:4-6`) |
| Capability query | `canEncode`, `canEncodeVideo`, `getEncodableCodecs`, `getFirstEncodableVideoCodec` (`:671`,`:696`,`:1817`,`:1860`) | **No public pre-flight query.** Miss surfaces as thrown `CapabilityError` (`errors.ts`, `engine.ts:198`). **Delta.** |
| Partial-failure model | Soft: `Conversion.isValid` + `discardedTracks[]` (`:909`,`:916`) | Hard: whole-op `CapabilityError`. **Delta / ADR needed.** |
| Cancellation | `Conversion.cancel()` → `ConversionCanceledError` (`:931`,`:995`) | `Cancellable.cancel()` + `CallOptions.signal` → `MediaError('aborted')` (`types.ts:91-95`,`:344-345`) |
| Progress | `onProgress(progress, processedTime)` (`:901`) | `CallOptions.onProgress(Progress)` (`types.ts:93`) |
| Codec as intent | `codec?: AudioCodec` in options (`:954`) | `VideoTarget.codec`/`AudioTarget.codec` (`types.ts:143`,`:165`) — same intent granularity |

The two design deltas worth stealing from mediabunny are the **public capability pre-flight** (`canEncode`)
and the **soft discarded-tracks result**; both are in the punch-list (§5).

---

## 3. Target design

### 3.1 Data model

The surface is a small set of flat, typed option/result records (ADR-011, `src/api/types.ts:1-4`). No
option object ever names a backend; each names only *intent* (container, codec, geometry, rate).

- **Inputs**: `MediaInput` (a union of `Source | bytes | Blob | URL | HTMLMediaElement | MediaStream`,
  surfaced from `src/sources/source.ts`, re-exported `src/index.ts:35-50`). One universal normalizer
  `engine.from(...)`/`engine.source(...)` (`src/api/engine.ts:269-285`) with an overload ladder that
  keeps a live `MediaStream` typed as `LiveMediaSource` and finite bytes as `Source`.
- **Outputs**: `Output = Blob | File | ReadableStream<Uint8Array> | …` via a `Sink` (`src/api/types.ts:16-18`);
  every op accepts an optional `sink` (`ConvertOptions.sink` etc., `types.ts:189`), defaulting to
  `toBlob()` (`engine.ts:766`,`:802`).
- **Option records** — `ConvertOptions`, `RemuxOptions`, `TrimOptions`, `EncodeOptions`, `MuxSpec`,
  `DecryptOptions`, `VideoTarget`, `AudioTarget`, `H264AbrRung`, `CreateMediaOptions`, `CallOptions`
  (`types.ts:73-231`). The `Chain*Options` variants are `Omit<…, 'sink'>` because a chain's terminal owns
  materialization (`types.ts:233-236`).
- **Result records** — `MediaInfo`/`MediaInfoTrack` (probe, `types.ts:259-284`), `Demuxed`
  (live demux, `types.ts:286-292`), `MediaStreams` (decoded frame streams, `types.ts:294-298`),
  `PacketStreams`/`PacketStream` (mux input, `types.ts:300-331`).
- **Cancellability** — every async op returns `Cancellable<T> = Promise<T> & { cancel(): void }`
  (`types.ts:344-345`). `decode` alone returns `MediaStreams` synchronously (`engine.ts:687`) because its
  streams are the cancellation handle.
- **Tokens** — `Container`, `VideoCodec`, `AudioCodec`, `PcmCodec` are *closed unions of intent tokens*
  (`types.ts:105-140`); a codec token is the format the developer wants, never a driver id.

### 3.2 Seams

```
app → @aibrush/media verb  (create-media.ts)                 ← intent
        └─ MediaEngineImpl method  (engine.ts)               ← orchestration + typed errors
             ├─ normalize(input)      → Source               (sources/source.ts, S06)
             ├─ route container/codec → Router               (kernel/router.ts, S01)  ← WebCodecs→GPU→WASM
             ├─ per-op runner (lazy import)                  (mux-runner/trim-runner/… , S02/S11-16)
             └─ materialize(stream, sink) → Output           (sinks/*, S07)
```

The engine is the *only* place that touches the kernel; op-specific pipelines are reached by lazy
`import()` from the op method so the eager kernel stays tiny (e.g. `engine.ts:191-193`,`:328`,`:894`,`:901`).
The public API layer's whole job is: **normalize → route → run → materialize**, and convert a true routing
miss into a typed `CapabilityError` (`engine.ts:198-202`,`:771`,`:818`).

### 3.3 Capability routing (WebCodecs → GPU → WASM, miss-only)

Routing is delegated to the Router (S01); the API layer's obligations are exactly two:

1. **Never name a tier.** The verb and its options carry only intent; the engine hands a `CodecQuery`/
   `ContainerQuery`/`FilterSpec` to the Router (`engine.ts:919-924`, `preload.ts:217-239`) and takes back
   whatever driver wins. WASM cores are pulled *only on a hardware miss* and lazily (`preload.ts:318-359`
   imports a WASM core only at `level !== 'chunks'`; the default entry never statically imports one).
2. **Fail loudly on a true miss.** When no tier can serve the intent, the op throws a typed
   `CapabilityError` with `{ op, tried }` (`engine.ts:198-202`,`:771-774`,`:818-821`) — never a silent
   passthrough or a fake result (Prime Directive 6).

`preload(...specs)` warms the real router paths ahead of first use (`engine.ts:906-929`,
`preload.ts:76-106`), idempotently keyed so repeated warmups collapse (`preload.ts:82-96`,
`preloadKey` `:170-172`). Measured: `preload()` warms real router paths idempotently at ~20,900
warmups/sec geomean on the local Bun 1.3.14 baseline (ADR-083, `measured-evidence.md`).

### 3.4 Edge cases

**B-frames.** The public API is deliberately B-frame-agnostic; reorder is a pipeline/driver concern
(S10/S11/S13). The surface's *only* B-frame obligation is to **not lose decode order**: a demuxed
`Packet` carries optional `dtsUs`, and `mux` accepts *both* DTS-bearing `Packet`s (verbatim remux) and
PTS-only `EncodedChunk`s (encoder output) on the same `PacketStream.packets` slot
(`types.ts:300-317`). `seek` decodes from the keyframe at/before the target so B-frame reference chains
resolve (`engine.ts:826-884`). No public type assumes IPPP.

**VFR (variable frame rate).** The surface never assumes constant frame rate. `MediaInfoTrack.fps` is a
*descriptive nominal* value only (`types.ts:272`); `VideoTarget.fps` is an optional *target* rate
(`types.ts:148`). Per-frame timing lives on packet PTS (carried through demux→mux verbatim), so a VFR
input remuxes/copies without being coerced to CFR. When a target `fps` is omitted, the pipeline preserves
source cadence. (Encoder-side VFR handling is S11.)

**Seek.** `seek(input, timeUs) → Cancellable<VideoFrame>` returns the single frame at/just-after `timeUs`
(`types.ts:159-160`, `engine.ts:806-890`). It validates `timeUs` finite and ≥ 0 (`engine.ts:808-810`),
rejects encrypted tracks with a typed error (`engine.ts:823-825`), decodes from the keyframe at/before the
target, drops-and-closes every pre-target frame, and returns the first at/after (caller-owned)
(`engine.ts:826-884`). A per-instance warm `VideoDecoder` pool reuses one configured decoder across
successive same-config seeks (`engine.ts:230-237`,`:848-851`).

**Cancel.** Two equivalent handles: `CallOptions.signal` (an inbound `AbortSignal`, `types.ts:92`) and the
returned `Cancellable.cancel()` (`types.ts:344-345`). `#withCancel` bridges both onto one internal
`AbortController`, mirrors a pre-aborted or future caller abort, and detaches its listener on settle so no
listener leaks (`engine.ts:1729-1765`). `cancel()` aborts with a typed `MediaError('aborted', …)`
(`engine.ts:1763`). For the synchronous `decode`, `bridgeSignal` wires the caller signal into the stream
controller (`engine.ts:694`,`:1829-1833`).

**Frame lifetime (`close()` exactly once).** The contract: *a frame emitted into a caller-owned stream is
owned and closed by the consumer* (`engine.ts:690-692`). The engine closes every frame it *drops*:
`deferredStream` closes an in-flight frame on cancel or on an enqueue failure and runs the deferred-stream
cleanup on a cancelled-before-start inner stream (`engine.ts:1895-1934`,`:1952-1956`); `seek` closes all
pre-target frames (`engine.ts:826-829`); `encode` cancels every input stream it will not consume so their
frames are released exactly once (`engine.ts:782-800`,`allOrCancel`/`cancelStream` `:1964-1982`). Worker
offload never crosses a `VideoFrame`/`AudioData` boundary — only encoded byte buffers transfer back — so
the close-exactly-once invariant is never split across threads (ADR-019, `measured-evidence.md`).

**Backpressure.** `deferredStream` builds each public frame stream with `{ highWaterMark: 0 }` and a
pull-driven `pull()` (`engine.ts:1887-1945`): the decoder produces a frame only when the consumer pulls,
so a slow sink naturally throttles the decoder — no unbounded frame queue, no manual credit accounting on
the surface. Byte outputs use the sink's own `WritableStream` backpressure (S07). The `>1 GB` bounded-
materialization decline (a typed error rather than OOM) is enforced below the surface (ADR-102,
`measured-evidence.md`).

### 3.5 Instance vs. default

`createMedia(opts)` returns a fresh, isolated `MediaEngine` (multi-instance, SSR-safe; each carries its
own registry, router, worker-pool cache, and warm-decoder pool — `engine.ts:205-256`). The bare functions
are sugar over one lazily-created shared instance (`create-media.ts:35-41`). The **target** rule: the
shared instance must be resettable/disposable (see §5) so servers and test suites can tear it down; today
it is a bare module-global (§4).

---

## 4. Current state

Owned code as it stands on 2026-07-16:

- **`src/index.ts`** (default entry, 86 lines) — re-exports the verbs from `create-media.ts:9-26`, public
  types (`export type * from './api/types.ts'`, `:31`), sources/sinks helpers, and the typed error model
  (`:82-83`). Deliberately does **not** re-export `fragmentMp4` (heavy MP4 box-writer, ~19 kB) to protect
  the eager kernel budget (`:75-79`). Clean.
- **`src/core.ts`** (driver-author entry, 206 lines) — a large but intentional barrel of kernel internals,
  worker surface, advanced container writers, and the conformance harness (`core.ts:9-205`). This is an
  *escape hatch*, so its breadth is acceptable; its risk is that it re-exports so many internal symbols
  (`Router`, `Registry`, `WorkerPool`, `makeJobRunner`, prepared-mux helpers) that the "stable versioned
  boundary" claim (`core.ts:5-7`) is hard to hold — every symbol here is a compatibility obligation.
- **`src/image.ts`** (22 lines) — clean subpath barrel (`image.ts:9-21`).
- **`src/version.ts`** — `VERSION = '0.0.0'` (`version.ts:2`): a hardcoded placeholder, not the real
  package version. **Smell.**
- **`src/api/create-media.ts`** (104 lines) — `createMedia()` plus 15 bare-function wrappers. `shared()`
  memoizes a **module-global mutable** default instance `let defaultInstance` (`create-media.ts:35-41`).
  There is no `reset`/`dispose`, so once created it lives for the process. **Smell (SSR/test hazard).**
- **`src/api/types.ts`** (346 lines) — the option/result records. Well-factored, heavily doc-commented, no
  backend names. Clean, and the model the rest of this doc treats as canonical.
- **`src/api/engine.ts`** (2385 lines) — **the god-file.** It holds the `MediaEngine` interface
  (`:145-180`), the `MediaEngineImpl` class with all 15+ op methods (`:205-929`), *and* a large tail of
  module helpers (`deferredStream` `:1868`, `cancelStream` `:1964`, `allOrCancel` `:1972`, `cacheProbeRanges`
  `:2085`, `readAllSource` `:2170`, `assertTrimRange` `:2294`, MIME/route helpers). Specific smells:
  - **Capability leak into the orchestration layer.** `WEBCODECS_VIDEO_DRIVER_ID = 'webcodecs-video'` is a
    literal backend id compiled into the engine and compared to pick the warm-decoder pool
    (`engine.ts:131`,`:848-849`). The "developer never names a backend" rule holds for the *public surface*
    but is violated one layer in: the engine names a specific driver implementation to make a routing
    decision. That decision belongs behind a capability flag on the `CodecDriver` contract, not a string
    match in the API layer.
  - **Duplicated `CONTAINER_MIME` table** — defined once in `engine.ts:110-128` and again, byte-for-byte,
    in `preload.ts:9-27`. Two sources of truth for the same container→MIME map.
  - **Module-global mutable cache** — `let probeRangeCacheModule` (`engine.ts:184`) is a mutable module
    variable shared across every engine instance.
  - **God-file exports** — `deferredStream` and `assertTrimRange` are `export`ed from `engine.ts`
    (`:1868`,`:2294`) and imported by tests; a stream utility and a validation helper leaking out of the
    engine module is a layering smell.
  - **Stale header docstring** — `engine.ts:5-9` still claims "Phase 0 implements `probe`/`demux`… codec/
    filter/crypto ops … raise a typed `CapabilityError` until their Phase-1 pipelines … land," but
    `convert`/`encode`/`seek`/`trim`/`mux`/`decrypt` are all implemented (`:524`,`:749`,`:806`,`:680`,
    `:892`,`:899`). The comment misdescribes the file.
  - **No lifecycle teardown** — the `MediaEngine` interface (`:145-180`) has no `dispose()`/`close()`.
    The instance owns a worker-pool cache `#poolCache` (`:228`), a warm `#videoDecoderPool` (`:237`), and a
    `#preloadTasks` map (`:211`) with no public way to release them.
- **`src/api/preload.ts`** (368 lines) — clean, self-contained warmup planner over a `PreloadHost` seam
  (`preload.ts:48-57`), except for the duplicated MIME table (above).
- **`src/api/runtime-detect.ts`** (34 lines) — UA/vendor heuristics `isWebKitRuntime`/`isFirefoxRuntime`
  (`runtime-detect.ts:11-33`). Pure and injectable (the `isLikely*` variants take the UA string), but note
  these are *browser-detection* helpers; per intent-not-mechanism, capability decisions should key off
  feature detection, not the browser brand. Currently only informs quirk handling, not routing.
- **`src/api/track-select.ts`** (69 lines) — `parseTrackSelector`/`selectTrackInfos` for `audio:0`/`video:1`
  selectors (`track-select.ts:19-69`). Correct and lazily loaded, with two minor rough edges:
  the `'bad selector'` throw omits the offending string (`:22`), and a nonzero single-source suffix
  (`video:0@1`) is silently `continue`-skipped (`:57`) rather than diagnosed.

---

## 5. Delta / punch-list

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

## 6. Open questions

Each becomes a decision record under `docs/decisions/`.

1. **Partial-failure model.** Adopt mediabunny's soft `isValid`/`discardedTracks` result, or ratify strict
   whole-op `CapabilityError` as a deliberate design choice? (Blocks delta §5.8.) Strict is simpler and
   matches Prime Directive 6 ("fail loudly"); soft is friendlier for multi-track inputs. Decide and log.

2. **Public capability pre-flight shape.** If we add `canConvert`/`getEncodableCodecs` (delta §5.7), does
   the query touch the network/WASM at all, or must it answer purely from static capability tables + a
   WebCodecs `isConfigSupported` probe (no download)? The miss-only WASM rule argues for zero download on a
   negative answer — confirm and log.

3. **Engine lifecycle & post-dispose semantics.** After `dispose()` (delta §5.4), should a subsequent op
   on the same instance throw `MediaError('disposed')` or transparently re-initialize the pools? mediabunny
   throws `InputDisposedError` (`mediabunny.d.ts` `InputDisposedError`). Pick one and log.

4. **Default-instance identity across contexts.** Should the bare functions bind to one process-global
   instance (current), an `AsyncLocalStorage` per request, or be discouraged in favor of explicit
   `createMedia()` in server code? (Relates to delta §5.5 and the SSR-safety claim in
   `create-media.ts:1-3`.) Log the SSR guidance.

5. **Browser-brand detection vs. feature detection.** `runtime-detect.ts` keys on UA/vendor
   (`runtime-detect.ts:11-33`). Which decisions may legitimately use brand (known-quirk workarounds) and
   which must use feature/`isConfigSupported` detection (capability routing)? Draw the line and log it, so
   brand detection never leaks into tier selection.

6. **`decode()` synchronous-return contract.** `decode` returns `MediaStreams` synchronously and defers all
   work to first pull (`engine.ts:687`). This is elegant for backpressure but means input-shape errors
   surface late (on first read) rather than at call time. Is the eager `normalizeInput` validation at
   `engine.ts:688` sufficient, or should `decode` also eagerly reject a structurally-impossible request?
   Log the chosen contract.

7. **UNVERIFIED — benchmark leadership of the developer surface.** No `measured-evidence.md` figure isolates the
   *API-layer* overhead (verb dispatch + normalize + route) as a standalone benchmarked family versus the 7
   engines; the rescued numbers measure per-operation families, not the surface itself. Open question: add a
   micro-benchmark for pure dispatch/normalize/route overhead so the developer-surface family has its own
   fresh, strict oracle. (Related measured points exist — e.g. `createMedia({…})` ~1.881 µs/engine and
   exact pinned route 0.787 µs/pick, `measured-evidence.md` session12-runtime-controls — but they are not a
   surface-level aggregate.)
