# 02 — Architecture Decision Records (ADRs)

> The **single source of truth for decisions.** Other docs reference ADR-NNN rather than re-arguing. Status: all `Accepted` except ADR-020 (`Deferred`). Evidence tags `[data]` point to [`background/benchmark-summary.md`](background/benchmark-summary.md).

Format per ADR: **Context** (why) · **Decision** (what) · **Consequences** (results + rejected alternatives).

---

### ADR-001 — A single capability-routed engine
**Context:** Each benchmarked engine is mono-substrate; no one engine spans the substrates that win, yet "best-of-the-best = union of substrates" [data: Findings 1–2]. **Decision:** Build one engine that routes each operation to the best available substrate, rather than another mono-substrate library. **Consequences:** A router + pluggable backends become the core (ADR-015). Rejected: extend a single substrate (would inherit that substrate's losses, e.g. mediabunny loses audio-dsp + browser-missing codecs).

### ADR-002 — Substrate set and default priority
**Context:** Winners collapse to WebCodecs (67%), WASM (25%), pure-JS/TS (8%); native `<video>` ~never wins [data: Finding 2]. **Decision:** Support four substrates with this default ranking for codec/filter work: **hardware WebCodecs → GPU (filters) → native/sw WebCodecs → WASM**; containers are hand-written **TS**; native media elements are last-resort (never for probe). **Consequences:** Encodes the benchmark's per-family winners as defaults (see [`09-operations.md`](09-operations.md)). Fastest path ships zero bytes [data: Finding 5].

### ADR-003 — Backend opacity (the developer never names a backend)
**Context:** Product directive D1; the value of the engine is hiding mechanism. **Decision:** The public API expresses intent (`convert`, `probe`, …); the engine walks a capability **ladder** internally and picks the first available tier (see [`04-capability-router-and-ladder.md`](04-capability-router-and-ladder.md)). **Consequences:** No `useWebCodecs()`/`useWasm()` in the API. A hidden override exists for tests (ADR-014).

### ADR-004 — Lazy loading model
**Context:** Directives D3/D4 — bundle is not a hard constraint, but load only what's called. **Decision:** A tiny eager **kernel** (≤ ~50 kB) + **per-operation and per-driver dynamic `import()`**. JS is tree-shaken (unused ops dropped from the build) and code-split (used-but-deferred ops fetched on first call). **Consequences:** A probe-only app pulls only kernel + probe + the matching parser. The ~500 kB budget covers JS glue only. Drivers must be dynamically importable because backend choice is a runtime decision (ADR-003).

### ADR-005 — WASM delivery: self-hosted, no CDN
**Context:** Browsers partition the HTTP cache by top-level site, so cross-site CDN cache-sharing (a CDN's one real benefit) is gone; its costs remain. **Decision:** WASM/worker binaries ship in the npm package and are emitted as **same-origin hashed assets** by the consumer's bundler via `new URL('./x.wasm', import.meta.url)` + `WebAssembly.instantiateStreaming`, fetched **only on a hardware miss**. **Consequences:** No CDN, no manual copy step, version-pinned, offline-safe, fastest compile. Escape hatches (not defaults): `inline:true` (base64 a *small* module into its lazy chunk), a prebuilt self-contained `dist/` for `<script>` users, an `assetBaseUrl` override. Either way, compiling WASM needs CSP `wasm-unsafe-eval`; threads need COOP/COEP (ADR-006).

### ADR-006 — No COOP/COEP on the common path; threads opt-in
**Context:** 56% of wins (and every win) ran with `coopCoep: not-required` and `wasmThreads: 0` [data: Finding 3]. **Decision:** The default build requires no cross-origin isolation. WASM SIMD+threads (`SharedArrayBuffer`) are an **opt-in** profile, used only to speed the exotic WASM tail when the host is `crossOriginIsolated`. **Consequences:** Maximum deployability by default; the exotic tail is correct-but-slower without isolation, fast with it. `enableThreads` defaults to `crossOriginIsolated`.

### ADR-007 — Determinism mode
**Context:** Hardware decode is GPU/platform-specific; "bit-exact" wins here are M1-specific [data: Finding 7]. **Decision:** `determinism: 'auto' | 'force-software'`, default `'auto'` (hardware allowed). `'force-software'` drops hardware/GPU tiers for cross-machine-reproducible output. **Consequences:** Golden/regression tests run in `force-software`; production uses `auto` for speed.

### ADR-008 — Implementation language: TypeScript
**Context:** A type-heavy public API + driver contracts; consumed by other developers. **Decision:** Author in **TypeScript (strict)**; ship **ESM JS + `.d.ts`**; only codec cores are C/Rust→WASM with TS bindings. **Consequences:** Compile-time safety across the substrate seams; consumers get autocomplete/types. Public API uses options objects (ADR-011) since JS/TS has no named arguments.

### ADR-009 — Public surface: `createMedia()` instance + bare-function sugar
**Context:** Need zero-config DX (D1) without globals, but also a one-liner entry. **Decision:** Primary surface is the `createMedia()` instance; bare named-function sugar (`import { probe, convert }`) is also shipped, backed by a default instance. The capability/plugin builder is **not** the bundle mechanism (lazy loading is, ADR-004) — it's kept only as an optional hook to inject custom/third-party drivers. **Consequences:** Multi-instance/SSR-safe; simple apps still get one-liners.

### ADR-010 — Call style
**Context:** Different users want simple calls, composition, or serializable jobs. **Decision:** v1 ships **flat task functions** (primary), a **low-level graph** (escape hatch), and a **declarative job spec** (the worker/serialization boundary). The **fluent chain** is **post-v1 additive sugar**, built as a façade over the declarative job (one execution path). **Consequences:** Small, focused v1 surface; fluent added later non-breakingly. See [`07-public-api.md`](07-public-api.md).

### ADR-011 — Options are flat typed objects
**Context:** Discoverability, typing, extensibility. **Decision:** Operation options are flat typed objects (e.g. `{ video: { codec } }`), not a string DSL (`'h264/aac@mp4'`). **Consequences:** Autocomplete + compile-time checks; extensible without breaking callers.

### ADR-012 — Naming
**Context:** Verb must express intent, not mechanism (ADR-003), and align with prior art (mediabunny `Conversion`, remotion `convertMedia`). **Decision:** Primary verbs **`convert`** (produce output; auto-routes copy-vs-re-encode) and **`probe`** (read). `remux` stays the explicit copy-only op; `transcode` is an accepted alias of `convert`. Rejected `inspect`/`metadata` (`probe` is the established term). **Consequences:** `convert` chooses remux vs re-encode internally — the developer doesn't pick.

### ADR-013 — Data handling
**Context:** Callers have bytes, Blobs, URLs, streams, or DOM elements; probe must stay fast. **Decision:** Operations accept media **directly** (polymorphic). A universal `from(input, opts?)` normalizer ships over canonical `fromBytes/fromBlob/fromURL/fromElement/fromStream/fromOPFS`; web-streams are used internally for bounded memory. `<video>`/`<audio>` input defaults to **bytes** mode (read `currentSrc`); probe never uses `loadedmetadata` (600–7000× slower) [data]. Bare-string `from('…')` resolves to URL by precedence (`http(s)|blob|data|file`), else `fetch` relative; OPFS needs `fromOPFS()`; else `InputError`. Sinks: `toBlob/toFile/toStream/toElement/toOPFS`; element output = Blob URL (whole-file) or MSE (streaming target); stream sinks are lazy. **Consequences:** "Just pass what you have" DX; large files never fully buffer.

### ADR-014 — Hidden `{ strategy }` override
**Context:** Power users / tests sometimes need to force a tier. **Decision:** A hidden `{ strategy }` option (e.g. `force-software`, pin a driver) exists but is **not** in the primary signatures. **Consequences:** Escape hatch without polluting the opaque API.

### ADR-015 — Architecture style
**Context:** Need clean kernel/backend separation, streaming, no main-thread jank. **Decision:** Core = **ARCH-1** layered capability router + drivers (drivers lazily imported *by the router*, not registered by the developer). Runtime = **ARCH-4** worker-first for heavy ops + main-thread fast path for cheap probes. Internal executor = a small **ARCH-2** dataflow graph for multi-stage jobs. **ARCH-3** monolith is the acceptable Phase-1 MVP; refactor into ARCH-1 once a 2nd/3rd driver lands — public DX unchanged. **Consequences:** See [`03-system-architecture.md`](03-system-architecture.md), [`06-execution-and-runtime.md`](06-execution-and-runtime.md).

### ADR-016 — Driver-interface contracts + semver
**Context:** Drivers are the unit of extension; third parties will publish them. **Decision:** Three contracts — `CodecDriver`, `ContainerDriver`, `FilterDriver` — plus a `DRIVER_API_VERSION` integer-major versioning policy decoupled from the library's public semver, checked at registration. **Consequences:** Adding a codec = one driver; canonical TS in [`05-driver-contracts.md`](05-driver-contracts.md).

### ADR-017 — Capability miss is a typed error, never a silent degrade
**Context:** Opaque routing must not hide "I couldn't do this." **Decision:** When no eligible driver exists for op+codec+env, throw a typed `CapabilityError` carrying `{ op, tried[], suggestion? }`. **Consequences:** Predictable failures (e.g. FLAC decode where unsupported, [data: Finding 8]); never a wrong-but-quiet output.

### ADR-018 — Strict self-validation
**Context:** 206 WEAK-GATE + 3 SUSPECT benchmark "wins" passed loose/shortcut gates [data: Finding 7]. **Decision:** Gate our own correctness with **bit-exact or structural** oracles; never adopt a path that only passes a duration-only / SSIM-`exactFrames==0` / "didn't crash" gate, and never copy a hardcoded per-asset shortcut. **Consequences:** Test strategy in [`11-testing-and-validation.md`](11-testing-and-validation.md).

### ADR-019 — Worker default per op weight
**Context:** Heavy ops cause main-thread jank (`longtasks`); tiny probes don't justify worker round-trips. **Decision:** Worker default = **on for heavy ops** (decode/encode/convert/filter/mux), **off for probe/metadata** (main-thread fast path). **Consequences:** Smooth UI at scale; cheap ops stay low-latency. Configurable.

### ADR-020 — Cost-aware tier thresholds — **Deferred**
**Context:** For tiny inputs, a worker/WASM spin-up can cost more than it saves. **Decision (deferred):** Add input-size thresholds that let the router pick a cheaper tier for small jobs — but the exact cutoffs require real measurements. **Status:** Deferred to post-Phase-1 telemetry. **Consequences:** Until then, the router uses the static ladder; no premature thresholds.
