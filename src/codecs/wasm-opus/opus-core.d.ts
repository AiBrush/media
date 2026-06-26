/**
 * Ambient type for the libopus-in-wasm glue (`./opus-core.js`) — see `BUILD.md` (ADR-085/088). It is the
 * hand-written glue that adapts the vendored prebuilt `libopus-wasm` (MIT wrapper + BSD libopus, committed
 * here as `./libopus-wasm.js` + `./generated/libopus.generated.mjs`) to the {@link OpusWasmCore} contract,
 * exposing a wasm-bindgen-compatible surface: a `default init(...)` + a named `createOpusCore()`. The
 * prebuilt core inlines its wasm into the `.mjs`, so `init`'s `module_or_path` URL is vestigial (a no-op
 * that only pre-instantiates libopus). This `.d.ts` lets the driver's string-literal
 * `import('./opus-core.js')` typecheck + code-split; if the glue/core are absent the import fails → honest
 * `supported:false`. The shape is the minimal contract {@link import('./wasm-opus-driver.ts')} drives.
 */
export {}; // make this file a module so the relative `declare module` below is an augmentation

declare module './opus-core.js' {
  import type { OpusWasmCore } from './opus.ts';

  /**
   * Pre-instantiate the libopus core. The driver passes `{ module_or_path: new URL('./opus_wasm_bg.wasm',
   * import.meta.url) }` (the standard loader signature); the prebuilt inlines its wasm, so the URL is
   * ignored and this only loads libopus (memoized) — a load failure surfaces as the driver's honest miss.
   */
  export default function init(moduleOrPath?: { module_or_path: URL } | URL): Promise<unknown>;

  /** Construct the {@link OpusWasmCore} facade (one libopus decoder/encoder factory) after `init`. */
  export function createOpusCore(): OpusWasmCore;
}
