/**
 * Ambient type for the build-emitted dav1d-in-wasm glue (`./dav1d-core.js`), produced by the recipe in
 * `BUILD.md` and intentionally absent until the dav1d core is vendored. The driver may import this small
 * JS glue during `supports()` to discover whether the core is present, but it only calls the default init
 * (which fetches `dav1d_wasm_bg.wasm`) from `createDecoder()` so the heavy WASM asset stays lazy.
 */
export {};

declare module './dav1d-core.js' {
  import type { Dav1dWasmCore } from './av1.ts';

  /**
   * Instantiate the sibling dav1d WASM module. The driver passes
   * `{ module_or_path: new URL('./dav1d_wasm_bg.wasm', import.meta.url) }` so bundlers emit the asset
   * same-origin next to this glue chunk.
   */
  export default function init(moduleOrPath?: { module_or_path: URL } | URL): Promise<unknown>;

  /** Construct the typed dav1d facade after `init`. */
  export function createDav1dCore(): Dav1dWasmCore;
}
