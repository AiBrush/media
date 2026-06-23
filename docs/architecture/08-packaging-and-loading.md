# 08 — Packaging, Build & Loading

> How the framework is built and how it reaches the browser, making ADR-004 (lazy loading) and ADR-005 (self-hosted WASM) real. Language: ADR-008.

## 1. Build outputs

Author in **TypeScript (strict)**; emit:

- **ESM JavaScript** (`module: esnext` / `bundler` — never downlevel to CJS, it would break `import()` and `import.meta.url`).
- **`.d.ts`** type declarations (the public DX depends on them).
- **`.wasm`** assets (codec cores), copied into the package as-is.
- A **worker** entry (ESM).
- Optionally a **prebuilt self-contained `dist/`** (IIFE/ESM bundle + co-located assets) for no-bundler `<script>` users.

`tsconfig` essentials: `strict: true`, `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`, `declaration: true`, `verbatimModuleSyntax: true`, `lib: ["ES2022","DOM","DOM.Iterable","WebWorker"]`.

## 2. `package.json` shape

```jsonc
{
  "name": "@aibrush/media",
  "type": "module",
  "sideEffects": false,                 // enables aggressive tree-shaking
  "exports": {
    ".":            { "types": "./dist/index.d.ts", "import": "./dist/index.js" },     // kernel + sugar
    "./core":       { "types": "./dist/core.d.ts",  "import": "./dist/core.js" },      // MediaEngine + driver hooks
    "./drivers/*":  { "import": "./dist/drivers/*.js" },                               // optional explicit driver import
    "./package.json": "./package.json"
  },
  "files": ["dist"]
}
```

- The **default export** is the tiny kernel + bare-function sugar (ADR-009).
- Op modules and driver modules live behind **dynamic `import()`** inside the kernel, so a consumer's bundler code-splits them automatically — only used chunks are emitted/downloaded (ADR-004).
- `./drivers/*` exists only for the optional "inject a custom/third-party driver" hook; normal usage never imports a driver directly (the router does, lazily).

## 3. Code-splitting model

```
index.js  (eager kernel: normalizer, planner, router, registry, executor stubs)  <= ~50 kB
  └─ import('./ops/convert.js')        // on first media.convert(...)
  └─ import('./ops/probe.js')          // on first media.probe(...)
        └─ import('./drivers/mp4.js')         // when router selects it
        └─ import('./drivers/webcodecs.js')   // 0-byte runtime; glue only
        └─ import('./drivers/wasm-flac.js')   // only on a hardware miss
              └─ new URL('./flac.wasm', import.meta.url)   // same-origin asset
```

Each `import('…')` with a **static string specifier** is a code-split point every modern bundler understands. Authoring rule: driver/op specifiers are always literals (never computed), so the bundler can statically create the chunks.

## 4. WASM assets (ADR-005)

The canonical pattern inside a lazily-imported driver chunk:

```ts
const url = new URL('./flac.wasm', import.meta.url)
const { instance } = await WebAssembly.instantiateStreaming(fetch(url), imports)
```

- The consumer's bundler (Vite, webpack 5, Rollup, esbuild, Parcel) recognizes `new URL('…', import.meta.url)`, **copies the `.wasm` into the app's `dist/` as a hashed asset, and rewrites the URL** — same-origin, no CDN, no manual copy step.
- Loaded with `instantiateStreaming` (fastest compile), and **only on a hardware miss** (never in `supports()`).
- **Escape hatches** (not defaults): `inline: true` build flag base64s a *small* module into its lazy chunk (single-file/strict-CSP only; +~33%, no streaming compile); `assetBaseUrl` overrides the asset root for custom paths/CDN.

## 5. Worker bundling

```ts
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
```

Same `import.meta.url` mechanism — the worker entry is emitted as a same-origin asset and spun up lazily on the first heavy op (ADR-019). The worker itself imports op/driver chunks the same lazy way.

## 6. Bundler compatibility

| Bundler | `import()` split | `new URL(import.meta.url)` asset | Notes |
|---|---|---|---|
| Vite / Rollup | yes | yes | first-class; recommended |
| webpack 5 | yes | yes (`asset/resource`) | works out of the box |
| esbuild | yes | yes | mark `.wasm` as `file`/`copy` loader if needed |
| Parcel | yes | yes | works |
| no bundler (`<script>`) | n/a | use the prebuilt `dist/` with co-located assets | the only case where a CDN is a *consumer* choice |

## 7. Budgets (ADR-004)

| Bucket | Target | Counts toward 500 kB JS budget? |
|---|---|---|
| eager kernel | ≤ ~50 kB | yes |
| typical app (kernel + a couple of ops + WebCodecs/TS drivers) | ~150–250 kB | yes |
| GPU-filter driver | small JS | yes |
| WASM codec cores (flac/opus/soxr/…) | per-codec, lazy | **no** — separate, miss-only assets |

The ~500 kB ceiling is for **JS glue only**; WASM lives outside it and downloads only when used.

## 8. CSP / COEP (applies regardless of inline vs file)

- Compiling any WASM requires CSP `script-src 'wasm-unsafe-eval'`.
- WASM **threads** (`SharedArrayBuffer`) require **COOP/COEP** cross-origin isolation — opt-in only (ADR-006); the common path needs neither beyond `wasm-unsafe-eval`.
- Same-origin assets avoid the CORS/CRP allowlisting a cross-origin CDN would require.

## 9. Versioning & release

- **Library public version** follows semver normally.
- **`DRIVER_API_VERSION`** ([`05`](05-driver-contracts.md)) is a *separate* integer-major that gates third-party drivers; it changes only on driver-contract breaks, not on every library release.
- WASM core versions are pinned to the package version (hashed assets), so JS and WASM never skew.
