# Building the `wasm-vpx` core (self-hosted, vendored, miss-only)

This driver (`src/codecs/wasm-vpx/wasm-vpx-driver.ts`) **decodes** VP8/VP9 via **libvpx compiled to
WebAssembly**, loaded same-origin through `new URL('./vpx.wasm', import.meta.url)` (BUILD §7 — no CDN, no
COOP/COEP, lazy + miss-only). The `.wasm` + its JS glue are a **vendored build artifact**: this file is the
recipe that produces them. Until they are vendored, the driver is honest — `supports()` returns `false` and
a (mis)routed decoder raises a typed `CapabilityError` (`capability-miss`).

The pure framing/format/validation logic (VP8 frame tag, the VP9 uncompressed-header prefix + superframe
index, `vp8`/`vp09.…` codec-string parsing, IVF framing, I420/P10/P12 plane-layout math, config validation)
lives in `vpx.ts` and is already validated in Node (`vpx.test.ts`). The wasm core supplies **only** the
lossy transform / loop-filter / entropy decode.

**Scope: decode only.** This fallback exists to fill the WebCodecs **VP9 decode** gap (some Safari/WebKit
builds ship no VP9 `VideoDecoder`); VP8 rides along on the same libvpx core. VP9 *encode* is out of scope —
a pure-software VP9 encoder is far too slow to be a credible browser path, so `createEncoder` raises a
typed `CapabilityError` rather than faking one (ADR-017, directive 6).

---

## Status in this environment (why it is not vendored here) — measured, not assumed

This build sandbox has `rustc` 1.94, `cargo`, `wasm-pack` 0.14, the `wasm32-unknown-unknown` target,
`clang`, and `cmake` — but **no Emscripten (`emcc`)** and no C/wasm sysroot. Three facts were measured (cf.
the Opus sibling's ADR-026, which reached the identical conclusion for libopus):

1. **Pure Rust → wasm works end-to-end.** A `wasm-bindgen` crate built with `wasm-pack build --target web`
   emitted exactly `*_bg.wasm` + `*.js` glue + `.d.ts` — the shape this driver's loader expects — and the
   same crate builds clean for `wasm32-unknown-unknown`. The glue path is proven.
2. **There is no pure-Rust VP8/VP9 decoder.** The registry has no `vp8` / `vp9` / `vpx-decode` / `vp9-dec`
   crate (all resolve to "could not be found"); `dav1d`/`rav1d` are **AV1**, not VPX. So a zero-C
   `wasm-bindgen` build (which *would* work, per fact 1) has nothing to wrap.
3. **libvpx (the C bindings) cannot be built here.** `cargo build --target wasm32-unknown-unknown` with
   `vpx-sys` (the libvpx binding) fails in its build script (exit 101): it demands a
   `PKG_CONFIG_SYSROOT_DIR` / cross-compile sysroot for the C library — which requires Emscripten (absent).
   `libvpx-sys` is the same C dependency.

Per the task's hard bound, the toolchain chase was stopped at this measured wall; the recipe below is the
deliverable, verified to the point `wasm-pack` runs and the pure-Rust wasm build succeeds. Vendor the
artifact on a machine that has **Emscripten** (the libvpx path) and commit the two files into this
directory.

---

## Recipe A — libvpx via Emscripten (recommended: reference-quality VP8 **and** VP9 decode)

Requires `emcc` (Emscripten ≥ 3.1) + `make`/`cmake`/`yasm`/`nasm` (libvpx's asm; or `--disable-runtime-cpu-detect`
+ generic C).

```sh
# 1. Build libvpx to a wasm static archive (decode only; no SIMD/threads → common path, no COOP/COEP).
git clone --depth 1 https://chromium.googlesource.com/webm/libvpx && cd libvpx
emconfigure ./configure \
  --target=generic-gnu \
  --disable-multithread --disable-runtime-cpu-detect \
  --enable-vp8 --enable-vp9 --disable-vp8-encoder --disable-vp9-encoder \
  --enable-decode --disable-encode \
  --disable-examples --disable-tools --disable-docs --disable-unit-tests \
  --extra-cflags="-O3"
emmake make -j

# 2. Compile a tiny C shim (vpx_shim.c) exporting the entry points the core contract needs
#    (see "The core contract" below) and link it against libvpx.a:
emcc -O3 vpx_shim.c libvpx.a -I . \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -s ALLOW_MEMORY_GROWTH=1 -s STANDALONE_WASM=0 \
  -o vpx-core.js
# → emits vpx-core.js (glue) + vpx-core.wasm
mv vpx-core.wasm vpx.wasm           # match the URL the driver resolves (new URL('./vpx.wasm', …))
```

Then write a thin hand-rolled `createVpxCore()` in the glue (or a sibling `vpx-core-shim.js` the glue
re-exports) that wraps the Emscripten module's `cwrap`/`ccall` calls in the `VpxWasmCore` / `VpxWasmDecoder`
shape from `vpx.ts`. The driver imports the **`--target web`-style** surface: `export default function
init(...)` (instantiate, fetching `vpx.wasm`) + named `export function createVpxCore()`.

## Recipe B — Rust + `wasm-bindgen` (clean `--target web` glue; needs a wasm-buildable libvpx)

Use this once libvpx is available offline as a **prebuilt wasm static lib** (point `vpx-sys` at it via
`VPX_LIB_DIR`/`VPX_STATIC`/`VPX_NO_PKG_CONFIG` so no C build runs at compile time), **or** once a pure-Rust
VP8/VP9 decoder exists. It yields the exact glue this driver was written against, with **zero hand-written
JS**:

```sh
cargo new --lib vpx-wasm && cd vpx-wasm
# Cargo.toml: crate-type = ["cdylib"]; deps: wasm-bindgen = "0.2", vpx-sys = "0.1"
#   + point vpx-sys at a prebuilt wasm libvpx (VPX_LIB_DIR / VPX_STATIC=1) so no C build runs.
# src/lib.rs: #[wasm_bindgen] struct VpxWasmDecoder wrapping vpx_codec_dec_init + vpx_codec_decode +
#   vpx_codec_get_frame (copy each img planes → tightly-packed I420/P10/P12 per planeLayoutI420),
#   and a #[wasm_bindgen] fn create_vpx_core() -> ... matching vpx.ts's VpxWasmCore.
wasm-pack build --target web --out-dir pkg --release
cp pkg/vpx_wasm_bg.wasm ../src/codecs/wasm-vpx/vpx.wasm        # rename to the URL the driver resolves
cp pkg/vpx_wasm.js      ../src/codecs/wasm-vpx/vpx-core.js     # rename to the specifier the driver imports
```

> `wasm-pack build --target web` was confirmed working in this sandbox (it emitted `*_bg.wasm` + glue from
> a `wasm-bindgen` crate, and the crate builds clean for `wasm32-unknown-unknown`); only the libvpx C
> dependency is missing here.

---

## The core contract (what the glue must expose)

`vpx.ts` defines the precise TypeScript surface; the wasm glue must satisfy it. Summary:

| JS export | libvpx call(s) | notes |
|---|---|---|
| `default(init)` | instantiate module, fetch `vpx.wasm` | wasm-bindgen `--target web` init signature |
| `createVpxCore()` → `VpxWasmCore` | — | factory; one per session |
| `core.createDecoder({codec, profile, bitDepth, codedWidth?, codedHeight?})` | `vpx_codec_dec_init` (VP8 or VP9 iface) | codec ∈ {vp8, vp9} |
| `decoder.decode(packet)` → `VpxDecodedFrame[]` | `vpx_codec_decode` + `vpx_codec_get_frame` (drained) | returns **displayable** frames only, in order; 0 for a hidden alt-ref, several for a superframe |
| `decoder.free()` | `vpx_codec_destroy` | idempotent |

Each returned `VpxDecodedFrame` carries `{ width, height, bitDepth, data }` where `data` is one contiguous
buffer of tightly-packed 4:2:0 planes (Y then U then V) laid out exactly as `planeLayoutI420(width, height,
bitDepth)` describes — `vpx_image_t` is usually padded per-plane, so the shim must **copy row-by-row to the
tight stride** before returning. The driver wraps that buffer directly in a `VideoFrame` `BufferInit`.

The driver owns all framing/timing: it copies packet bytes out of the `EncodedVideoChunk`, parses the
superframe index (`parseSuperframeIndex`) to space multi-frame-packet timestamps, derives each frame's
`timestamp`/`duration` from the chunk, and constructs/closes every `VideoFrame`. The wasm side is pure
packet-in / planar-frame-out — no JS framing or timing logic.

---

## After vendoring — validation (on a browser machine, ADR-025)

1. Place `vpx.wasm` + `vpx-core.js` in this directory; `loadVpxCore()` then resolves non-null and
   `supports({codec:'vp09.00.10.08', direction:'decode'})` returns `true`.
2. Add a browser (Playwright) test that, with WebCodecs VP9 disabled / `force-software`, decodes the real
   VP8/VP9 corpus (`vp8.webm`, `vp9.webm`, a VP9-profile-2 10-bit clip, a `.ivf` raw fixture iterated via
   `iterateIvfFrames`) to `VideoFrame`s and compares against the WebCodecs reference: **bit-exact** I420
   plane sha256 where a WebCodecs VP9 decoder is available as the oracle, else frame-hash structural +
   `ssim-psnr` with `exactFrames>0`. Exercise a **superframe** clip (alt-ref present) and assert the
   displayed-frame count + monotonic PTS, and a **non-shown** alt-ref packet yields no `VideoFrame`.
3. Assert **frame lifetime**: every emitted `VideoFrame` is `close()`d exactly once by the consumer; an
   abort mid-stream closes the in-flight frame and frees the native decoder (no leak).
4. Add a fresh multi-sample throughput benchmark (decode Mpixels/s across several corpus files) like
   `scripts/bench-flac.ts`.
5. Assert the lazy-load budget: a probe-only app pulls **zero** VPX wasm; a VP9 decode on a WebCodecs miss
   pulls **only** this chunk, same-origin.
