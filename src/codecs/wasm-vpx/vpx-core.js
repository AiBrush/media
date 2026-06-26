/**
 * Vendored libvpx-in-wasm glue — adapts the prebuilt **ogv.js** per-codec video decoders (vendored here as
 * `./ogv-vp8-wasm.js` + `./ogv-vp9-wasm.js`, with their wasm base64-embedded in `./vpx-vp8-data-wasm.js` /
 * `./vpx-vp9-data-wasm.js`) to the {@link VpxWasmCore} contract the AV1-sibling VP8/VP9 driver drives
 * (`./vpx.ts`, `./wasm-vpx-driver.ts`). This is the ADR-085 "vendor a prebuilt PERMISSIVE core" path:
 * libvpx itself is **BSD-3** (WebM Project), the ogv.js wrappers are **MIT**, so the cores are self-hosted
 * (committed + served same-origin, NOT a runtime CDN dep). Provenance: `provenance.json` / `BUILD.md`.
 *
 * Self-contained: each ogv module's wasm is base64-embedded in a sibling `*-data-wasm.js` and fed to the
 * Emscripten module via `instantiateWasm`, so there is NO separate `*.wasm` asset to co-vendor — `tsup`
 * bundles the whole tail into the lazy `vpx-core.js` chunk and `scripts/vendor-wasm.ts` recognizes it as a
 * self-contained inlined tail (its `selfContained` branch) and skips co-vendoring (ADR-090).
 *
 * Shape: ogv's `OGVDecoderVideoVPxW({...}) → Promise<module>` is an Emscripten MODULARIZE factory; the
 * `module` exposes `init(cb)`, `processFrame(data, cb)` (sets `module.frameBuffer = { y, u, v }` with
 * **strided** planes), and `videoFormat`. Decoder *creation* is async (the wasm instantiates lazily), so
 * {@link VpxWasmCore.createDecoder} is async (the driver `await`s it in its async `start`); the hot
 * `decode` is synchronous. The glue **de-strides** ogv's planes into the tightly-packed I420 the
 * `VpxDecodedFrame` contract requires. The driver owns demux → access units, PTS, and `VideoFrame`
 * construct/close. Validated BIT-EXACT vs ffmpeg's libvpx in Node (`wasm-vpx-decode.test.ts`).
 */

import vp8Factory from './ogv-vp8-wasm.cjs';
import vp9Factory from './ogv-vp9-wasm.cjs';
import { wasmBytes as vp8Wasm } from './vpx-vp8-data-wasm.js';
import { wasmBytes as vp9Wasm } from './vpx-vp9-data-wasm.js';

/**
 * The wasm-bindgen-style init the driver calls. The vendored cores embed their wasm (each ogv module is
 * instantiated from its base64 bytes via `instantiateWasm`), so the `module_or_path` URL is intentionally
 * ignored — this is a no-op that lets the driver's loader contract hold. A per-decoder instantiation
 * failure later surfaces as the driver's honest miss.
 * @param {{ module_or_path: URL } | URL} [_moduleOrPath]
 * @returns {Promise<unknown>}
 */
export default function init(_moduleOrPath) {
  return Promise.resolve(undefined);
}

/** Instantiate an ogv decoder module from its embedded wasm bytes (no fetch). */
function instantiate(factory, wasm) {
  return factory({
    // Feed the embedded wasm directly; Emscripten calls back with the instance.
    instantiateWasm(imports, callback) {
      WebAssembly.instantiate(wasm, imports).then((result) => callback(result.instance));
      return {};
    },
  });
}

/** Tightly pack one strided plane (`plane.bytes` + `plane.stride`) into `width × height` bytes. */
function packPlane(plane, width, height) {
  const src = plane.bytes
    ? new Uint8Array(plane.bytes.buffer ?? plane.bytes, plane.bytes.byteOffset ?? 0, plane.bytes.byteLength ?? plane.bytes.length)
    : new Uint8Array(plane);
  const stride = plane.stride ?? width;
  if (stride === width) return src.subarray(0, width * height).slice();
  const out = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) out.set(src.subarray(row * stride, row * stride + width), row * width);
  return out;
}

/**
 * Build a tightly-packed I420 buffer (Y, then U, then V) from an ogv `frameBuffer` at the given luma dims.
 * 4:2:0 → chroma is half-resolution each way. 8-bit only (this build).
 */
function toI420(frameBuffer, width, height) {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const y = packPlane(frameBuffer.y, width, height);
  const u = packPlane(frameBuffer.u, cw, ch);
  const v = packPlane(frameBuffer.v, cw, ch);
  const out = new Uint8Array(width * height + 2 * cw * ch);
  out.set(y, 0);
  out.set(u, width * height);
  out.set(v, width * height + cw * ch);
  return out;
}

/** The video-format descriptor ogv's decoder needs before `processFrame`, from the coded luma dims. */
function videoFormatFor(width, height) {
  return {
    width,
    height,
    chromaWidth: Math.ceil(width / 2),
    chromaHeight: Math.ceil(height / 2),
    cropLeft: 0,
    cropTop: 0,
    cropWidth: width,
    cropHeight: height,
    displayWidth: width,
    displayHeight: height,
    fps: 0,
  };
}

/**
 * Parse the coded dimensions from a VP8 keyframe (RFC 6386 §9.1): after the 3-byte uncompressed frame tag
 * (P=0 marks a keyframe) + the 3-byte start code `9d 01 2a`, the next 4 bytes are width(14)|height(14) LE
 * (the top 2 bits of each are the horiz/vert scale, ignored). Returns `undefined` for a non-keyframe.
 * @param {Uint8Array} packet
 */
function vp8KeyframeDims(packet) {
  if (packet.length < 10) return undefined;
  const tag = (packet[0] ?? 0) | ((packet[1] ?? 0) << 8) | ((packet[2] ?? 0) << 16);
  if ((tag & 1) !== 0) return undefined; // key_frame bit (inverted): 0 = keyframe
  if (packet[3] !== 0x9d || packet[4] !== 0x01 || packet[5] !== 0x2a) return undefined; // start code
  const width = (((packet[7] ?? 0) << 8) | (packet[6] ?? 0)) & 0x3fff;
  const height = (((packet[9] ?? 0) << 8) | (packet[8] ?? 0)) & 0x3fff;
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Build the {@link VpxWasmCore} facade over the ogv.js VP8/VP9 decoders. One per session; `createDecoder`
 * instantiates the right ogv module per stream (one full wasm instance per decoder).
 * @returns {import('./vpx.ts').VpxWasmCore}
 */
export function createVpxCore() {
  return {
    /**
     * @param {import('./vpx.ts').VpxDecoderInit} init
     * @returns {Promise<import('./vpx.ts').VpxWasmDecoder>}
     */
    async createDecoder(init) {
      const isVp9 = init.codec === 'vp9';
      const module = await instantiate(isVp9 ? vp9Factory : vp8Factory, isVp9 ? vp9Wasm : vp8Wasm);
      module.init(() => {});
      // The coded dims: the config hint when present, else parsed from the (VP8) keyframe at decode time.
      let width = init.codedWidth ?? 0;
      let height = init.codedHeight ?? 0;
      let formatSet = false;
      let freed = false;
      return {
        /**
         * @param {Uint8Array} packet one coded VP8/VP9 frame (a VP9 superframe may hold several).
         * @returns {import('./vpx.ts').VpxDecodedFrame[]} the displayable frames (0 for a hidden alt-ref).
         */
        decode(packet) {
          // ogv needs `videoFormat` before the first decode; derive it once from the hint or VP8 keyframe.
          if (!formatSet) {
            if (width <= 0 || height <= 0) {
              const dims = isVp9 ? undefined : vp8KeyframeDims(packet);
              if (dims) {
                width = dims.width;
                height = dims.height;
              }
            }
            if (width > 0 && height > 0) {
              module.videoFormat = videoFormatFor(width, height);
              formatSet = true;
            }
          }
          if (!formatSet) {
            throw new Error('vpx-core: unknown coded dimensions (no config hint and no VP8 keyframe)');
          }
          /** @type {import('./vpx.ts').VpxDecodedFrame[]} */
          const frames = [];
          let chromaError;
          module.processFrame(packet, (success) => {
            if (success && module.frameBuffer) {
              const fb = module.frameBuffer;
              const fmt = module.videoFormat ?? {};
              const w = fmt.cropWidth ?? width;
              const h = fmt.cropHeight ?? height;
              // Honest 4:2:0 gate (NEVER-FAKE): the frameBuffer's TRUE chroma layout is in the plane strides,
              // not `videoFormat`. A 4:2:0 stream has the U plane at ~half the luma stride; a 4:4:4 stream
              // (e.g. bear-vp9-alpha) has U stride == Y stride. The `VpxDecodedFrame` contract is packed I420,
              // so decline anything but 4:2:0 — the driver maps it to a clean capability-miss (→ WebCodecs)
              // rather than silently cropping full-res chroma into a 4:2:0 buffer (garbage colour).
              const yStride = fb.y?.stride ?? w;
              const uStride = fb.u?.stride ?? w >> 1;
              if (uStride > (yStride >> 1) + (yStride & 1)) {
                chromaError = new Error('vpx-core: non-4:2:0 chroma subsampling is not supported');
                return;
              }
              frames.push({ width: w, height: h, bitDepth: 8, data: toI420(fb, w, h) });
            }
          });
          if (chromaError) throw chromaError;
          return frames;
        },
        free() {
          if (freed) return;
          freed = true;
          // ogv Emscripten modules expose `close()` to release native state (idempotent here via `freed`).
          if (typeof module.close === 'function') module.close();
        },
      };
    },
  };
}
