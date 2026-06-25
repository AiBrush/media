/**
 * Ambient type for the **build-emitted** libvpx-in-wasm glue (`./vpx-core.js`), produced by
 * `wasm-pack build --target web` (or an Emscripten `--target web`-style shim) and renamed into this
 * directory — see `BUILD.md`. The module is *not* in source control (the `.wasm` is a vendored artifact),
 * so this declaration lets the driver's string-literal `import('./vpx-core.js')` typecheck and code-split
 * before the artifact exists; at runtime the import resolves once vendored, and resolves to a load failure
 * (→ honest `supported:false`) until then. The shape is the minimal contract
 * {@link import('./wasm-vpx-driver.ts')} drives.
 */
export {}; // make this file a module so the relative `declare module` below is an augmentation

declare module './vpx-core.js' {
  import type { VpxWasmCore } from './vpx.ts';

  /**
   * The wasm-bindgen (`--target web`) init: instantiates the module, fetching the sibling `vpx.wasm`. The
   * driver passes `{ module_or_path: new URL('./vpx.wasm', import.meta.url) }` so the bundler emits the
   * wasm same-origin alongside this chunk (no CDN, no COOP/COEP).
   */
  export default function init(moduleOrPath?: { module_or_path: URL } | URL): Promise<unknown>;

  /** Construct the {@link VpxWasmCore} facade (one libvpx decoder factory) after `init`. */
  export function createVpxCore(): VpxWasmCore;
}
