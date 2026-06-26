import { defineConfig } from 'tsup';

/**
 * Library build (docs/architecture/08). Two ESM entries — the default `index` (tiny eager kernel +
 * bare-function sugar) and `core` (driver-author surface) — with code-splitting so every op/driver chunk
 * and every WASM core loads lazily on first use (ADR-004). The eager `index` chunk must therefore pull in
 * NO driver and NO `.wasm`: the engine reaches the first-party drivers only through a dynamic
 * `import('../drivers/defaults.ts')` (a literal specifier esbuild splits into its own chunk), and each
 * codec core sits behind a further lazy import inside that bundle. `splitting` is what realizes those
 * split points; `treeshake` + `sideEffects:false` drop everything a consumer does not reach.
 *
 * The shipped ESM is MINIFIED with sourcemaps — standard for a published library and purely a size
 * transform: esbuild minification does not touch the architecture, so dynamic `import()` code-split
 * boundaries and `new URL(..., import.meta.url)` asset references survive intact (asserted by the dist
 * smoke + budget checks). Minify is what keeps the eager kernel honestly under the raw-byte budget
 * (BUILD §2, doc 08 §7) — the bytes that ship are genuinely smaller, while the `.d.ts` and `*.map`
 * sourcemaps stay readable. No CJS is emitted: CJS would break `import()` code-splitting and the
 * `new URL(..., import.meta.url)` same-origin WASM/worker assets.
 *
 * Typed errors stamp their public `.name` strings explicitly in `src/contracts/errors.ts`; do NOT enable
 * esbuild `keepNames` here. Keeping every helper/class name injects name-preservation code throughout the
 * eager kernel and can push the default entry over the hard 50 kB DoD budget without adding behavior.
 */
export default defineConfig({
  // `worker` is a SEPARATE entry/chunk (doc 06 §4, ADR-019): the engine spawns it via a runtime
  // `new Worker(new URL('./worker.js', import.meta.url))` asset URL, never a static import, so the heavy
  // worker boot (which pulls the full engine inside the worker) stays out of the eager `index` kernel
  // closure and the kernel byte budget holds (check-budgets asserts this). An ENTRY MAP (not an array) is
  // used so the worker entry flattens to `dist/worker.js` — a sibling of the dynamically-imported
  // `worker-host` chunk that holds the `new URL('./worker.js', import.meta.url)` site, so the asset URL
  // resolves. (An array entry would preserve `src/kernel/` and emit `dist/kernel/worker.js`, breaking the
  // sibling resolution.)
  entry: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    image: 'src/image.ts',
    worker: 'src/kernel/worker.ts',
  },
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  // Vendored Emscripten codec glue (ogv.js VP8/VP9, etc.) carries the standard MODULARIZE boilerplate that
  // reads the wasm from disk under `ENVIRONMENT_IS_NODE` via `require('fs'|'path'|…)`. Our cores inline the
  // wasm (base64) and the browser takes the `ENVIRONMENT_IS_WEB` branch, so those Node-builtin requires are
  // DEAD code in the browser bundle — but esbuild still tries to resolve them and fails. Marking the Node
  // built-ins external leaves the (never-executed) requires intact without bundling them; the live web path
  // is unaffected and the Node test/oracle path still resolves them natively.
  external: [
    'fs',
    'path',
    'crypto',
    'os',
    'module',
    'url',
    'worker_threads',
    'node:fs',
    'node:path',
  ],
  dts: true,
  splitting: true,
  treeshake: true,
  minify: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
});
