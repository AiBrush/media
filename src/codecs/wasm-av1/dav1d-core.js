/**
 * Vendored dav1d-in-wasm glue — adapts the prebuilt `dav1d.js` decoder (vendored here as
 * `./dav1d-wasm.js` + the sibling `./dav1d_wasm_bg.wasm`) to the {@link Dav1dWasmCore} contract the AV1
 * driver drives (`./av1.ts`, `./wasm-av1-driver.ts`). This is the ADR-085 "vendor a prebuilt PERMISSIVE
 * core" path: dav1d itself is **BSD-3** (VideoLAN), the dav1d.js wrapper is **CC0** (public domain), so the
 * core is self-hosted (committed + served same-origin, NOT a runtime CDN dependency). Provenance +
 * re-vendor steps are in `BUILD.md` / `provenance.json`.
 *
 * Shape: `dav1d.js` exports `create({ wasmData | wasmURL }) → Promise<Dav1d>`, where a `Dav1d` instance IS
 * one stateful decoder (`decodeFrameAsYUV(obu) → { width, height, data }`, one display frame per coded OBU
 * / temporal unit). The driver's loader calls `default init({ module_or_path })` (we fetch the sibling
 * `.wasm` bytes from that URL — Node `fs` or browser `fetch` — and memoize them) then `createDav1dCore()`.
 * Decoder *creation* is async (dav1d.js instantiates the wasm per decoder), so {@link
 * Dav1dWasmCore.createDecoder} is async (the driver `await`s it in its async `start`); the hot `decode`
 * is synchronous. The driver owns all framing (demux → access units), PTS reorder, and `VideoFrame`
 * construct/close. This glue is pure samples-in / frames-out.
 *
 * Reorder: dav1d may release 0 frames for a coded OBU until enough future input arrives — dav1d.js signals
 * that by throwing `"error in djs_decode"`; we map it to an empty array (not an error), per the contract.
 */

import dav1d from './dav1d-wasm.js';

/** The dav1d "no display frame for this OBU yet" sentinel (a reordered/hidden frame). */
const NO_FRAME = 'error in djs_decode';

/** Memoized sibling-wasm bytes (one fetch per session); the URL the driver passes is the source. */
let wasmBytesPromise;

/**
 * Load the sibling `dav1d_wasm_bg.wasm` bytes from the URL the driver resolves with
 * `new URL('./dav1d_wasm_bg.wasm', import.meta.url)`. Browser → `fetch`; Node → `fs` (so the Node oracle
 * + Vitest can instantiate without a server). Memoized; a load failure rejects → the driver's honest miss.
 * @param {{ module_or_path: URL } | URL} [moduleOrPath]
 * @returns {Promise<Uint8Array>}
 */
function loadWasmBytes(moduleOrPath) {
  wasmBytesPromise ??= (async () => {
    const url = moduleOrPath instanceof URL ? moduleOrPath : moduleOrPath?.module_or_path;
    if (!(url instanceof URL)) throw new Error('dav1d-core: init needs a module_or_path URL');
    const isNode =
      typeof globalThis.process !== 'undefined' && globalThis.process.versions?.node !== undefined;
    if (url.protocol === 'file:' || isNode) {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      return new Uint8Array(await readFile(fileURLToPath(url)));
    }
    const res = await fetch(url);
    return new Uint8Array(await res.arrayBuffer());
  })();
  return wasmBytesPromise;
}

/**
 * The wasm-bindgen-style init the driver calls; here it only fetches + memoizes the sibling `.wasm` bytes
 * (dav1d.js does the actual instantiation per decoder). A fetch failure surfaces as the driver's honest
 * `supports()→false` / `CapabilityError`, never a fake.
 * @param {{ module_or_path: URL } | URL} [moduleOrPath]
 * @returns {Promise<unknown>}
 */
export default async function init(moduleOrPath) {
  await loadWasmBytes(moduleOrPath);
  return undefined;
}

/**
 * I420/I010 packed size for `width × height` at `bitDepth` (the dav1d YUV output layout): Y plane + two
 * half-resolution chroma planes, `bitDepth>8` → 2 bytes/sample. Used to infer the decoded bit depth from
 * the returned buffer length when the stream's depth is otherwise unknown.
 * @param {number} width @param {number} height @param {number} bitDepth
 */
function i420Size(width, height, bitDepth) {
  const bytes = bitDepth > 8 ? 2 : 1;
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  return (width * height + 2 * cw * ch) * bytes;
}

/**
 * Build the {@link Dav1dWasmCore} facade. One per session; `createDecoder` makes one stateful dav1d
 * instance per stream (dav1d.js has no core/decoder split — each `create` is a full decoder).
 * @returns {import('./av1.ts').Dav1dWasmCore}
 */
export function createDav1dCore() {
  return {
    /**
     * Honest capability gate for THIS vendored core. `dav1d.js@0.1.1`'s YUV output is **8-bit only** —
     * verified: a 10-bit AV1 stream (`bear-av1-10bit.mp4`) decodes to ZERO frames through `djs_decode_obu`
     * (the build predates its 10-bit YUV path). So we honestly DECLINE 10-bit (and any non-4:2:0 /
     * monochrome the 8-bit I420 path can't represent), and the driver surfaces a clean `capability-miss`
     * (→ WebCodecs / another browser) rather than emitting empty/garbage frames (NEVER-FAKE). 8-bit 4:2:0
     * Main — the bulk of AV1 + the cross-browser ROI — is decoded bit-exactly (proven vs ffmpeg).
     * @param {import('./av1.ts').Av1DecoderInit} init
     */
    supports(init) {
      return init.bitDepth === 8 && init.chromaSubsampling === '420' && !init.monochrome;
    },

    /**
     * @param {import('./av1.ts').Av1DecoderInit} initCfg
     * @returns {Promise<import('./av1.ts').Dav1dWasmDecoder>}
     */
    async createDecoder(_initCfg) {
      const wasmData = await loadWasmBytes();
      const d = await dav1d.create({ wasmData });
      let freed = false;
      return {
        /**
         * @param {Uint8Array} packet one coded AV1 access unit (temporal unit).
         * @returns {import('./av1.ts').Av1DecodedFrame[]} 0 or 1 displayed frames (reorder → 0).
         */
        decode(packet) {
          let frame;
          try {
            frame = d.decodeFrameAsYUV(packet);
          } catch (err) {
            // dav1d held this OBU back (reorder/hidden frame) → no display frame yet, not an error.
            if (err instanceof Error && err.message === NO_FRAME) return [];
            throw err;
          }
          // This core's YUV output is 8-bit I420 (10-bit is gated out by `supports`); a sanity guard keeps
          // it honest if an unexpected larger buffer ever appears (treat as 10-bit rather than mislabel).
          const bitDepth =
            frame.data.byteLength >= i420Size(frame.width, frame.height, 10) ? 10 : 8;
          return [{ width: frame.width, height: frame.height, bitDepth, data: frame.data }];
        },
        free() {
          if (freed) return;
          freed = true;
          // dav1d.js exposes no public destroy; release the native decoder via the raw FFI export.
          const ffi = /** @type {any} */ (d).FFI;
          const ref = /** @type {any} */ (d).ref;
          if (ffi && typeof ffi.djs_free === 'function' && ref) ffi.djs_free(ref);
        },
      };
    },
  };
}
