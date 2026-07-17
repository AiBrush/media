# Packaging & Loading

> Shard S08 — cross-cutting build/delivery concern (owns a concern, not `src/*.ts`). Governs how the
> engine's bytes reach the browser: the ESM `exports` map, code-splitting, self-hosted lazy WASM, worker
> assets, and the CSP/COEP posture. This is the **target spec** plus an honest delta vs today's build.

## 1. Purpose & scope

**Concrete restatement of the task:** describe the best design for *how the compiled `@aibrush/media`
package is shaped and delivered to a browser* — which files the `package.json` `exports` map publishes, how
the direct esbuild pipeline code-splits the engine so the eager kernel stays tiny, how the per-codec WebAssembly cores and
the offload worker are loaded lazily and same-origin at runtime (never a CDN, never up-front), and what
Content-Security-Policy / cross-origin-isolation the common path requires — then list where today's build
diverges from that best design.

**"Delivery" is a cross-cutting concern, not one of the 13 media-test scenario families.** The benchmark
suite's families are `audio-dsp, decode-seek, demux, encryption, metadata, mux, performance, probe, remux,
robustness, streaming-output, transcode, trim` (`docs/architecture/COVERAGE.md` shard table). Packaging owns *none* of
them uniquely; instead it underpins the cold-start cost of **every** family (each scenario pays the first-op
load of the eager kernel + whichever lazy chunks its op reaches) and is validated by dedicated **build
oracles** rather than a scenario: `scripts/check-budgets.ts`, `scripts/verify-package-install.ts`, and
`src/dist-smoke.test.ts`. The binding numeric targets are the DoD bundle budgets: eager kernel ≤ ~50 kB,
typical first-op JS ≤ ~250 kB, probe-only pulls **zero** `.wasm`, WASM lazy + miss-only + same-origin
(`docs/measured-evidence.md`: BUILD_INSTRUCTIONS budgets; ADR-004).

Scope boundaries: the *routing decision* that triggers a lazy load lives in S01 (capability-router); the
*worker execution protocol* lives in S03; the *driver registration contract* lives in S04. This doc owns the
**delivery surface** those layers ride on.

## 2. Spec & references

Governing standards (every reference linked):

- **ESM package entry points / `exports` map / conditions** — Node.js Packages:
  <https://nodejs.org/api/packages.html#exports> and the `"type": "module"` / subpath-patterns section
  <https://nodejs.org/api/packages.html#subpath-patterns>.
- **Dynamic `import()`** (the code-split seam) — MDN:
  <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import>.
- **`import.meta.url`** (same-origin asset addressing) — MDN:
  <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import.meta>.
- **`WebAssembly.instantiateStreaming`** (streaming compile of a separate `.wasm`, the reason we do NOT
  base64-inline) — MDN
  <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/instantiateStreaming>;
  Web API spec <https://webassembly.github.io/spec/web-api/>.
- **Module Workers** (`new Worker(url, { type: 'module' })`) — MDN:
  <https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker>.
- **CSP `script-src` + `'wasm-unsafe-eval'`** (compiling WASM under CSP) — W3C CSP Level 3
  <https://www.w3.org/TR/CSP3/#directive-script-src>; MDN
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src>.
- **Cross-origin isolation (COOP/COEP) & `crossOriginIsolated`** (only for the threaded-WASM tail) — MDN
  <https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated>; web.dev
  <https://web.dev/articles/coop-coep>.
- **HTTP cache partitioning** (the empirical reason a CDN's cross-site cache benefit is gone, so
  self-hosting is strictly better) — <https://developer.chrome.com/blog/http-cache-partitioning> (ADR-005).

OSS exemplar — **mediabunny** (the engine that wins 56% of the benchmark on the exact aibrush thesis:
WebCodecs-first + pure-TS containers, zero WASM by default; `docs/measured-evidence.md` competitive-gaps):

- Main package — <https://www.npmjs.com/package/mediabunny>, repo <https://github.com/Vanilagy/mediabunny>.
  Pure TypeScript, zero dependencies, "extremely tree-shakable — you only include what you use"; measured
  eager JS ~165 kB, zero-WASM (`docs/measured-evidence.md` benchmark-summary).
- Optional heavy codec as a **separate package registered on demand** — `@mediabunny/mp3-encoder`:
  <https://mediabunny.dev/guide/extensions/mp3-encoder>, README
  <https://github.com/Vanilagy/mediabunny/blob/main/packages/mp3-encoder/README.md>. A single
  `registerMp3Encoder()` call registers a LAME-3.100 (SIMD) WASM encoder; the recommended pattern gates it on
  a native check (`if (!(await canEncodeAudio('mp3'))) registerMp3Encoder()`). Its worker **and** WASM are
  bundled into **one file** (base64-inlined) — "no CDN, no WASM path arguments" — ~130 kB gzipped.

**Where the SOTA design must match or beat mediabunny.** Match: pure-TS tree-shakable core, zero WASM on the
common (WebCodecs) path, ESM-only, no COOP/COEP required. **Beat on two axes:** (1) *zero-config miss-only
auto-load* — the developer never calls `registerMp3Encoder()`; the router loads the tail automatically on a
true hardware miss (§3), so the ergonomics of "it just works" hold without the consumer wiring extensions;
(2) *streaming-compiled, separate same-origin `.wasm`* rather than mediabunny's base64-inlined single file —
inlining costs ~+33% size and loses streaming compilation (`docs/measured-evidence.md`: doc-08 `inline:true` note), so
our default ships the `.wasm` as its own asset via `new URL('./x.wasm', import.meta.url)` and keeps the
inline form only as a strict-CSP escape hatch.

Bundle-size context for rivals (`docs/measured-evidence.md` benchmark-summary): mp4box ~41 kB, web-demuxer ~43 kB,
remotion-media-parser ~73 kB, remotion-webcodecs ~94 kB, mediabunny ~165 kB, ffmpeg.wasm = multi-MB WASM
loaded up front. aibrush targets mediabunny-class eager JS with the WASM strictly behind a miss.

## 3. Target design

### 3.1 Data model — the published surface

The package is **ESM-only** (`"type": "module"`, `package.json:5`; `format: 'esm'`, `scripts/build.mjs`) —
no CJS, because CJS would break `import()` code-splitting and the `new URL(..., import.meta.url)` same-origin
asset references. The public surface is a small, deliberate `exports` map
(`package.json:23-41`):

| Subpath | Emitted entry | Purpose |
|---|---|---|
| `.` | `dist/index.js` + `dist/index.d.ts` | eager kernel + bare-function sugar (tiny; no driver, no `.wasm`) |
| `./core` | `dist/core.js` | driver-author surface (`DRIVER_API_VERSION`, contracts, `fragmentMp4`) |
| `./image` | `dist/image.js` | standalone image helpers (kept off the eager entry) |
| `./drivers/*` | `dist/drivers/*.js` | explicit first-party driver imports for tree-shaking-conscious consumers |
| `./package.json` | `./package.json` | tooling access |

`"sideEffects": false` (`package.json:7`) is what authorizes the bundler to drop every subpath a consumer
never reaches — it is honest because registration is by explicit function call, never an import-time side
effect. `scripts/build.mjs` asks esbuild for one entry per public surface plus a **separate `worker` entry**,
producing `index/core/image/worker` + `drivers/<container>` chunks, all code-split, tree-shaken, minified,
and source-mapped. TypeScript 7 separately emits the declaration graph from `tsconfig.json`; the build
script changes its default `noEmit` mode to `false` for that invocation.

### 3.2 Seams — the three lazy boundaries

Delivery has exactly three runtime load seams, each a code-split boundary esbuild realizes from a literal
specifier:

1. **First-party driver bundle** — the eager engine reaches every default driver only through a single
   dynamic `import('../drivers/defaults.ts')` on a capability miss (`src/api/engine.ts:1054`), so no container
   parser is in the eager kernel closure. `defaults.ts` is itself a *manifest of lazy driver stubs*: each
   container's parse/mux code sits behind a further per-driver dynamic import
   (`src/drivers/defaults.ts:108,122,298,315,326,338,354,364,513,…`), so routing an MP4 op pulls the MP4
   chunk, not WebM/Ogg/AVI/FLAC.
2. **Per-codec WASM core** — each miss-only tail loads its core via a string-literal `import('./<id>-core.js')`
   (code-split) whose wasm bytes are addressed by `new URL('./<id>_wasm_bg.wasm', import.meta.url)`
   (`src/codecs/wasm-mp3/wasm-mp3-driver.ts:102,111`; identical shape for aac/av1/opus/vorbis/vpx). The URL is
   resolved through `resolveWasmAssetUrl` (`src/kernel/wasm-loader-runtime.ts:10-23`) so a consumer's
   `assetBaseUrl` override can relocate assets to a sibling same-origin directory; with no override the
   literal `import.meta.url` object is preserved exactly.
3. **Offload worker** — the heavy `convert`/`trim` worker is a *runtime asset URL*
   `new URL('./worker.js', import.meta.url)`, spawned as a module worker (`src/kernel/worker-host.ts:124,137`),
   reached only via a lazy `import('./worker-host.ts')` (`src/kernel/worker-host.ts:5,332`). The worker entry
   is an **entry-map key** (not an array element) precisely so it flattens to `dist/worker.js`, a sibling of
   the `worker-host` chunk that holds the `new URL` site, so the asset URL resolves (`scripts/build.mjs`).

### 3.3 Capability routing (WebCodecs → GPU → WASM, miss-only)

The developer never names a backend or a codec at any load site. The router (S01) tries hardware WebCodecs
first, then GPU, and **only on a true miss** does the packaging machinery pull the heavy WASM tail —
concretely: `registerDefaultDrivers` registers WebCodecs adapters eagerly (they `supports()`→`false` where
absent, e.g. Node) and the wasm tails as lazy stubs (`src/drivers/defaults.ts:83-100`); the tail's
`import('./<id>-core.js')` + `.wasm` fetch fires the first time an op routes past the hardware/GPU rungs. A
tail that has no vendored core returns `supports()`→`false` and the router raises a typed
`CapabilityError('capability-miss')` — it never fabricates support (`docs/measured-evidence.md` ADR-032). This is the
key beat over mediabunny: **auto-load on miss, no `registerX()` ceremony.**

The runtime profile is resolved without touching any `.wasm`: `resolveWasmRuntimeProfile`
(`src/kernel/wasm-runtime.ts:69-88`) returns the single-threaded `baseline` profile unless BOTH
`crossOriginIsolated` and `SharedArrayBuffer` are present, in which case the opt-in `isolated-simd-threads`
profile is used. The common path therefore needs no COOP/COEP; threads are opt-in only for the fast-WASM
tail (`enableThreads` defaults to `crossOriginIsolated`; ADR-006). `assetBaseUrl` is validated once by
`normalizeWasmAssetBaseUrl` (`src/kernel/wasm-runtime.ts:19-62`): same-origin HTTP(S) only, no credentials,
`file:` only in Node/file pages (ADR-005/237); the public knob is typed on `CreateMediaOptions`
(`src/api/types.ts:79`).

**CSP/COEP posture (the delivery contract):** compiling any WASM requires CSP `script-src 'wasm-unsafe-eval'`;
WASM threads (SharedArrayBuffer) additionally require COOP/COEP. Because 56% of benchmark wins — and *every*
win — ran with COOP/COEP not-required and zero WASM threads (`docs/measured-evidence.md` ADR-006), the shipped default
requires **only** `'wasm-unsafe-eval'` and no isolation headers; SIMD+threads is an opt-in tail.

### 3.4 Self-hosting + co-vendoring (why `vendor-wasm.ts` exists)

esbuild does **not** copy a `.wasm` referenced by a plain `new URL('./x.wasm', import.meta.url)` into
`dist/` — it is not a recognized asset import (`docs/measured-evidence.md` ADR-042). `scripts/vendor-wasm.ts` fills the
gap: it discovers each real tail (`*_wasm_bg.wasm` + `*-core.js` pair) and copies both into `dist/` flat, so
the `.wasm` sits next to its emitted `*-core.js` chunk and the `import.meta.url` resolution holds
(`scripts/vendor-wasm.ts:1-25,150-160,252-257`). It is **honest by construction**: a half-vendored tail (one
file of a Rust/Symphonia pair, no inlined carrier) fails loudly (`scripts/vendor-wasm.ts:144-149`); a
self-contained inlined tail (Opus/VPx — `*-core.js` glue + an inlined `*-wasm.js`/`.generated.mjs` carrier and
no separate `.wasm`) is recognized and skipped, never mistaken for a broken half-vendor
(`scripts/vendor-wasm.ts:119-143`). `vendor-wasm --check` (`scripts/vendor-wasm.ts:260-276`) is the CI oracle:
byte-for-byte identity of every vendored artifact in `dist/`.

### 3.5 Budget oracles (the "delivery" validation)

- `scripts/check-budgets.ts` walks the emitted `dist/` static-import graph: eager kernel closure ≤ `KERNEL_BUDGET`
  = 50 kB (`:25`), typical first-op closure ≤ `TYPICAL_APP_BUDGET` = 256 kB (`:32`), ≥ `MIN_JS_CHUNK_COUNT` = 8
  chunks (`:33`), a guard band `MIN_BUDGET_MARGIN` = 256 B (`:37`). It asserts the default driver bundle is
  **lazy** not static (`:397-404`), that no heavy codec/worker/op artifact leaks into the eager or first-op
  static closure — by filename **and** by source-map source (`:478-515`), and that WASM is same-origin via
  `new URL(...,import.meta.url)`, never a static import, and absent from the eager path (`:517-586`).
- `scripts/verify-package-install.ts` packs the workspace, installs the tarball into a fresh app, typechecks
  the `exports`-map imports, runs a package-name import, and measures a **tree-shaken probe-only** browser
  bundle staying under 50 kB with **zero** emitted `.wasm` (`:16,45-57`).
- `src/dist-smoke.test.ts` imports through the published `exports` map and asserts the built ESM + `.d.ts` a
  real consumer sees are correct, and that budget-sensitive heavy code (`fragmentMp4`) is on `/core`, **not**
  the eager entry (`:159-165`).

The full `gate` script chains build → vendor-wasm → dist-smoke → check-budgets → verify:package →
anti-cheat (`package.json:165`).

### 3.6 Edge cases

Packaging is a static/delivery concern; most frame-level edge cases belong to the execution runtime (S02) and
codec pipeline (S13). Honest one-liners:

- **B-frames / VFR / seek** — **N/A to packaging.** These are decode/mux-order and timestamp concerns handled
  inside the (lazily loaded) container + codec drivers; the delivery layer only decides *when* that code
  arrives, not *how* it reorders frames.
- **Frame lifetime (`close()` exactly once)** — **N/A directly**, but the packaging design is what makes it
  *safe*: the offload worker asset boundary ships a code-split worker across which **only encoded bytes**
  cross (input `ArrayBuffer` transferred in, encoded `ArrayBuffer` out) — no `VideoFrame`/`AudioData` ever
  crosses a thread, sidestepping the close-exactly-once-across-threads hazard (`docs/measured-evidence.md`
  ADR-087/ADR-010; `src/kernel/worker-host.ts:15-17`). Packaging the worker as a complete, self-contained
  code-split chunk is a precondition for that guarantee.
- **Cancel** — the op's `AbortSignal` governs, but a load in-flight is a gap: a `.wasm` fetch or a cold
  `import()` triggered by a miss is not itself abortable, and the driver caches its core promise before the
  op can be cancelled (`src/codecs/wasm-mp3/wasm-mp3-driver.ts:106-122`). Target: an abort during a cold load
  rejects the op with `MediaError('aborted')` without poisoning the module-level core cache (see delta #9).
- **Backpressure** — **N/A to packaging** (WHATWG Streams own it in S02/S07). The only delivery-adjacent lever
  is streaming compilation: shipping the `.wasm` as a separate asset lets `instantiateStreaming` compile as
  bytes arrive, which base64-inlining forfeits — hence the separate-asset default.

## 4. Current state

What exists today, with citations, and the smells.

**Build config (owned surface).** `package.json` `exports` map is correct and minimal (`:23-41`),
`sideEffects:false` set (`:7`), `files:["dist"]` (`:56`), `engines.node>=18` (`:20-22`).
`scripts/build.mjs` emits ESM-only, code-split, minified JavaScript with the worker as a flattened entry key
and node built-ins marked external. `tsconfig.json` owns the strict browser-library and declaration-emission
settings; `tsconfig.test.json` inherits them and adds the Bun environment for tests and repository scripts.
The root configuration enables `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`moduleResolution:"Bundler"`, and `allowImportingTsExtensions` — the `.ts`-specifier
imports (`import('../drivers/defaults.ts')`) are why `allowImportingTsExtensions` + Bundler resolution are
required.

**Load machinery (owned cross-cutting).** Lazy defaults import (`src/api/engine.ts:1049-1066`); the three
WASM loader helpers (`src/kernel/wasm-loader-runtime.ts:10-52`), the runtime-profile + asset-base normalizer
(`src/kernel/wasm-runtime.ts:19-88`), the worker asset-URL + spawn (`src/kernel/worker-host.ts:108-157`), and
the per-driver `new URL('./x.wasm', import.meta.url)` sites across `src/codecs/wasm-*`.

**Smells:**

- **`package.json` is a god-file of ~120 session-scoped bench scripts** (`:77-164`). `bench-session6/9/11/12/13-*`
  accumulate per session and never retire — a maintenance liability that dwarfs the meaningful scripts and
  obscures the real gate.
- **Duplicated node-builtin exclusion.** The top-level `browser` field maps `module/fs/path/crypto/os/url/…`
  to `false` (`package.json:44-55`) AND the esbuild configuration lists the same builtins in `external`
  (`scripts/build.mjs`).
  Two sources of truth for one fact → drift risk. Modern bundlers with `exports` present may also ignore the
  legacy top-level `browser` field.
- **Codec-name capability leak in the packaging layer.** `check-budgets.ts` hardcodes the codec set
  `aac|av1|mp3|opus|vorbis|vpx` in the leak-guard regexes (`:42,46,50,59,125`). A new wasm tail added under
  `src/codecs/wasm-*` is invisible to the leak guard until a human edits these regexes — a codec identity
  leaking into a build script that should be codec-agnostic.
- **Manual co-vendoring is a second build step with a drift window.** `vendor-wasm.ts` runs *after* esbuild
  and must be re-run whenever a core changes; the split (`build` vs `vendor-wasm` vs `vendor-wasm:check`,
  `package.json:70-73`) means `dist/` is only complete after two commands, and CI relies on the `--check`
  oracle to catch staleness rather than the build producing a complete artifact.
- **Module-global mutable state at the load seams.** `SHARED_POOLS` (`src/kernel/worker-host.ts:302`) is a
  process-wide mutable `Map` with a test-only `__resetSharedOffloadPools` hatch (`:326`); each wasm driver
  holds a module-global `corePromises` cache (`src/codecs/wasm-mp3/wasm-mp3-driver.ts:106`). These are
  *intentional* process-wide singletons (spawning one worker per op crashed a real run — `docs/measured-evidence.md`
  ADR-087), but they are module-global mutable caches and must be named as such.
- **Budget headroom is historically fragile.** The DoD targets are 50 kB / ~250 kB, but the harvest records
  repeated drift: eager kernel measured 54 kB then 57.73 kB, with ADR-092 temporarily raising ceilings to
  58 kB / 264 kB before recovery to 48.98 kB / 224.16 kB (`docs/measured-evidence.md` ADR-092, session12-eager-budget-recovery).
  The `TYPICAL_APP_BUDGET` comment openly calls itself "a tight ceiling over the current ~254 kB" with the
  real fix (per-driver lazy registration) still tracked (`check-budgets.ts:28-32`).
- **`worker` entry has no `exports` subpath.** esbuild emits `dist/worker.js` (`scripts/build.mjs`) but the
  `exports` map (`package.json:23-41`) publishes no `./worker` — intentional (it is a runtime asset, not a
  public import), but undocumented in the surface.

## 5. Delta / punch-list (ordered)

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

## 6. Open questions (seed `docs/decisions/`)

1. **Auto-load-on-miss vs explicit `registerX()`.** aibrush loads the WASM tail automatically on a hardware
   miss (§3.3); mediabunny requires an explicit `registerMp3Encoder()`. Decide whether to *also* expose an
   opt-out / explicit-register path for strict-CSP consumers who must forbid `'wasm-unsafe-eval'` and want a
   hard failure instead of a lazy fetch. (Decision: default auto-load; add an opt-out flag?)
2. **Per-codec subpath packages.** Should aibrush publish `@aibrush/media/drivers/*` (already present) *and/or*
   standalone per-codec packages mirroring `@mediabunny/mp3-encoder`, so a consumer can pin/preload one exact
   tail? Weigh publish-surface cost vs the tree-shaking/pinning benefit.
3. **Content-hashed `.wasm` filenames.** vendor-wasm preserves original flat names for `import.meta.url`
   resolution; hashing requires the loader to learn the hashed name (a generated manifest). Decide the
   mechanism (build-time codegen of the URL constant vs an asset-manifest lookup). (Ties to delta #10.)
4. **Legacy `browser` field vs `exports` conditions.** Is the top-level `browser` field
   (`package.json:44-55`) still load-bearing for any supported bundler once `exports` is authoritative, or is
   it dead weight/drift risk to drop? (Ties to delta #3.)
5. **`WebAssembly.instantiateStreaming` fallback.** When the server serves `.wasm` without
   `application/wasm`, `instantiateStreaming` rejects and glue must fall back to `arrayBuffer()`+`instantiate`.
   Confirm the vendored wasm-bindgen glue does this (or document the MIME requirement as a delivery
   precondition). `UNVERIFIED:` whether the vendored `*-core.js` glue implements the non-streaming fallback —
   needs a read of the generated glue.
6. **Vite re-bundling of the code-split worker.** The consumer-side rule (serve the prebuilt vendor RAW;
   never let Vite re-process `new Worker(new URL('./worker.js', import.meta.url))`) is encoded as a code
   comment (`src/kernel/worker-host.ts:113-119`) and an ADR (`docs/measured-evidence.md` ADR-087). Decide whether to
   ship a first-party `*-vendor-static` Vite plugin so consumers don't have to hand-configure raw serving.
