/**
 * Ambient type for the **build-emitted** libopus-in-wasm glue (`./opus-core.js`), produced by
 * `wasm-pack build --target web` and renamed into this directory — see `BUILD.md`. The module is *not*
 * in source control (the `.wasm` is a vendored artifact), so this declaration lets the driver's
 * string-literal `import('./opus-core.js')` typecheck and code-split before the artifact exists; at
 * runtime the import resolves once vendored, and resolves to a load failure (→ honest `supported:false`)
 * until then. The shape is the minimal contract {@link import('./wasm-opus-driver.ts')} drives.
 */
export {}; // make this file a module so the relative `declare module` below is an augmentation

declare module './opus-core.js' {
  import type { OpusWasmCore } from './opus.ts';

  /**
   * The wasm-bindgen (`--target web`) init: instantiates the module, fetching the sibling `*_bg.wasm`.
   * The driver passes `{ module_or_path: new URL('./opus_wasm_bg.wasm', import.meta.url) }` so the
   * bundler emits the wasm same-origin alongside this chunk (no CDN, no COOP/COEP).
   */
  export default function init(moduleOrPath?: { module_or_path: URL } | URL): Promise<unknown>;

  /** Construct the {@link OpusWasmCore} facade (one libopus decoder/encoder factory) after `init`. */
  export function createOpusCore(): OpusWasmCore;
}
