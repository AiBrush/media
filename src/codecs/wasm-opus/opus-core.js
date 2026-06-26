/**
 * Vendored libopus-in-wasm glue — adapts the prebuilt `libopus-wasm` package (vendored here as
 * `./libopus-wasm.js` + `./generated/libopus.generated.mjs`) to the narrow {@link OpusWasmCore} contract
 * `opus.ts` / `wasm-opus-driver.ts` drive (ADR-088 ; the "vendor a prebuilt permissive core" path of
 * ADR-085, since libopus is C and this sandbox has no Emscripten/wasm sysroot). The wrapper is MIT and the
 * libopus it compiles is BSD (Xiph.Org); provenance is recorded in `fixtures/manifest.json` / BUILD.md.
 *
 * Shape note: `libopus-wasm` INLINES its wasm into the generated ESM (no separate `*_bg.wasm`), so the
 * wasm-bindgen-style `default init({ module_or_path })` the driver calls is a no-op here — it only
 * pre-instantiates libopus (so an instantiation failure surfaces as the honest `supports()→false` /
 * `capability-miss`, never a fake) and ignores the URL. Coder *creation* in `libopus-wasm` is async (it
 * lazy-loads the module), so {@link OpusWasmCore.createDecoder}/`createEncoder` are async here; the hot
 * `decode`/`encode` paths are synchronous (`decodeFloat`/`encodeFloat`), matching the driver's per-packet
 * / per-frame loop. The driver owns all framing, PTS, pre-skip trim, and `AudioData` lifetime.
 *
 * This is the build-emitted artifact `BUILD.md` describes; it is hand-written (not `wasm-pack`-generated)
 * because the core is a vendored prebuilt rather than a from-source Rust/Emscripten build.
 */

import { createDecoder, createEncoder, loadLibopus } from './libopus-wasm.js';

/** libopus `OPUS_APPLICATION_AUDIO` (2049) — general audio, the right default for music/transcode. */
const OPUS_APPLICATION_AUDIO = 2049;

/**
 * The wasm-bindgen `--target web` init signature the driver invokes with
 * `{ module_or_path: new URL('./opus_wasm_bg.wasm', import.meta.url) }`. The vendored core inlines its
 * wasm, so the URL is intentionally ignored; we pre-load libopus so a broken vendor fails here (the
 * driver maps the rejection to a typed capability miss) rather than at first `encode`/`decode`.
 * @param {{ module_or_path: URL } | URL} [_moduleOrPath]
 * @returns {Promise<unknown>}
 */
export default async function init(_moduleOrPath) {
  await loadLibopus();
  return undefined;
}

/**
 * Build the {@link OpusWasmCore} facade over `libopus-wasm`. One per session; the driver constructs one
 * decoder/encoder per stream and `free()`s it on teardown.
 * @returns {import('./opus.ts').OpusWasmCore}
 */
export function createOpusCore() {
  return {
    /**
     * @param {import('./opus.ts').OpusDecoderInit} init
     * @returns {Promise<import('./opus.ts').OpusWasmDecoder>}
     */
    async createDecoder(init) {
      const decoder = await createDecoder({
        sampleRate: init.sampleRate,
        channels: init.channels,
      });
      let freed = false;
      return {
        /**
         * @param {Uint8Array} packet
         * @param {number} samples per-channel sample count expected (the driver's TOC-derived size).
         * @returns {Float32Array} interleaved f32, length `samples × channels`.
         */
        decode(packet, samples) {
          // libopus-wasm sizes the output itself from the packet TOC; `frameSize` caps the per-call grid.
          const out = decoder.decodeFloat(packet, { frameSize: samples > 0 ? samples : undefined });
          return out;
        },
        free() {
          if (freed) return;
          freed = true;
          decoder.free?.();
        },
      };
    },

    /**
     * @param {import('./opus.ts').OpusEncoderInit} init
     * @returns {Promise<import('./opus.ts').OpusWasmEncoder>}
     */
    async createEncoder(init) {
      const encoder = await createEncoder({
        sampleRate: init.sampleRate,
        channels: init.channels,
        application: OPUS_APPLICATION_AUDIO,
        // 'auto' → let libopus pick a bitrate; a concrete bits/s pins it via OPUS_SET_BITRATE.
        ...(init.bitrate === 'auto' ? {} : { bitrate: init.bitrate }),
        frameSize: init.frameSamples,
      });
      let freed = false;
      return {
        /**
         * @param {Float32Array} frame interleaved f32, exactly `frameSamples × channels` values.
         * @returns {Uint8Array} one Opus packet.
         */
        encode(frame) {
          return encoder.encodeFloat(frame, { frameSize: init.frameSamples });
        },
        /**
         * The encoder's algorithmic delay in 48 kHz samples (`OPUS_GET_LOOKAHEAD`) for the OpusHead
         * pre-skip. libopus' default lookahead (≈312 @48 kHz) when the wrapper exposes no getter.
         * @returns {number}
         */
        preSkip() {
          const lookahead =
            typeof encoder.getLookahead === 'function' ? encoder.getLookahead() : 312;
          return Number.isInteger(lookahead) && lookahead >= 0 ? lookahead : 312;
        },
        free() {
          if (freed) return;
          freed = true;
          encoder.free?.();
        },
      };
    },
  };
}
