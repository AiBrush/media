/**
 * Ambient type for the hand-written LAME glue (`./mp3-enc-core.js`). The `.wasm` and this glue are
 * committed artifacts (see `BUILD.md`); this declaration types the driver's string-literal
 * `import('./mp3-enc-core.js')` so it typechecks and code-splits.
 */

import type { Mp3EncWasmCore } from './mp3-enc.ts';

/**
 * What the glue's init accepts (mirroring the wasm-bindgen `--target web` `InitInput`): a URL/`Response` to
 * fetch, raw module bytes, or a pre-compiled `WebAssembly.Module` — the last lets Node tests instantiate
 * without fetch. The driver passes
 * `{ module_or_path: new URL('./mp3_enc_wasm_bg.wasm', import.meta.url) }` so the bundler emits the core
 * same-origin (no CDN, no COOP/COEP). There is deliberately no default: an absent argument throws rather
 * than guessing.
 */
export type Mp3EncInitInput = string | URL | Response | BufferSource | WebAssembly.Module;

/** Instantiate the vendored core at most once; resolves when its WASI reactor start has run. */
export default function initMp3EncCore(
  moduleOrPath?: { module_or_path: Mp3EncInitInput } | Mp3EncInitInput,
): Promise<unknown>;

/** Build the core contract over the instantiated module (call after {@link initMp3EncCore} resolves). */
export function createMp3EncCore(): Mp3EncWasmCore;
