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
  entry: ['src/index.ts', 'src/core.ts', 'src/image.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  dts: true,
  splitting: true,
  treeshake: true,
  minify: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
});
