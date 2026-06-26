# Building the `wasm-av1` core (dav1d, self-hosted, miss-only)

This driver (`src/codecs/wasm-av1/wasm-av1-driver.ts`) is the AV1 software decode fallback for the
WebCodecs miss path. It expects **dav1d compiled to WebAssembly**, loaded same-origin through:

```ts
new URL('./dav1d_wasm_bg.wasm', import.meta.url)
```

The `.wasm` and its JS glue are vendored build artifacts:

- `dav1d_wasm_bg.wasm`
- `dav1d-core.js`

Until both files are present, the driver is deliberately honest: `supports()` returns `false`, the driver
is not auto-registered in `src/drivers/defaults.ts`, and a misrouted decoder raises a typed
`CapabilityError`.

## Status in this environment

Re-verified in this workspace on 2026-06-26:

- `cargo` exists.
- `wasm-pack` exists.
- `emcc` does **not** exist.
- No `dav1d`, `rav1d`, `dav1d-core.js`, or `dav1d_wasm_bg.wasm` artifact is present in this repo or the
  local Cargo registry cache.

dav1d is a C decoder, so a production dav1d WASM core cannot be built in this sandbox without Emscripten
or an already-vendored core artifact. Per the project rules, this file records the blocked vendor step
instead of committing an unaudited prebuilt binary or faking decoded frames.

## Recipe A — dav1d via Emscripten (recommended)

Requires Emscripten (`emcc` / `emconfigure` / `emmake`), Meson, Ninja, and a pinned dav1d source checkout.
Build the common-path single-thread artifact first; SIMD/threads can be an opt-in profile later and must
not require COOP/COEP by default.

```sh
git clone --depth 1 --branch <pinned-dav1d-tag> https://code.videolan.org/videolan/dav1d.git
cd dav1d

emcmake meson setup build-wasm \
  --buildtype=release \
  -Denable_tools=false \
  -Denable_tests=false \
  -Ddefault_library=static
emmake ninja -C build-wasm
```

Then compile a tiny C shim that exposes the core contract below and links against the static dav1d build:

```sh
emcc -O3 dav1d_shim.c build-wasm/src/libdav1d.a \
  -I include -I build-wasm/include \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -s ALLOW_MEMORY_GROWTH=1 -s STANDALONE_WASM=0 \
  -o dav1d-core.js

mv dav1d-core.wasm dav1d_wasm_bg.wasm
```

The JS glue must export the wasm-bindgen-style surface the driver imports:

| JS export | Meaning |
|---|---|
| `default({ module_or_path })` | instantiate the sibling `dav1d_wasm_bg.wasm` |
| `createDav1dCore()` | return a `Dav1dWasmCore` facade |
| `core.supports(init)` | optional profile/bit-depth/subsampling predicate |
| `core.createDecoder(init)` | create one stateful dav1d decoder |
| `decoder.decode(packet)` | feed one AV1 access unit and return displayed frames |
| `decoder.flush()` | drain delayed display frames on stream close |
| `decoder.free()` | release native decoder state |

Returned frames must be tightly packed 4:2:0 planes (`Y`, then `U`, then `V`) matching
`planeLayoutI420(width, height, bitDepth)` in `av1.ts`. If the dav1d build cannot convert non-4:2:0
profiles into one of `I420` / `I420P10` / `I420P12`, `core.supports(init)` must return `false` for those
configs so the router surfaces a typed miss.

## After vendoring — validation and benchmark

1. Place `dav1d_wasm_bg.wasm` and `dav1d-core.js` in this directory.
2. Keep the driver out of defaults until the bundle owner runs `bun run build && bun run vendor-wasm` and
   verifies the pair is co-vendored into `dist/`.
3. Add browser validation over at least five real AV1 files covering:
   - 8-bit Main profile,
   - 10-bit Main profile,
   - at least one reordered/B-frame or show-existing-frame stream,
   - VFR timestamps,
   - tiny and ordinary dimensions.
4. Use `force-software` for the strict bitexact path. Compare decoded frame hashes against baked goldens
   from the verified corpus, or against an independent dav1d CLI oracle baked into committed goldens.
5. Add abort/backpressure lifetime tests that close every emitted `VideoFrame` once and prove abort frees
   the decoder and any not-yet-enqueued frame.
6. Add a fresh multi-sample decode benchmark (`wall`, decoded Mpixels/s, peak memory, longtasks) across
   the same AV1 corpus. A missing sample is `N/A`, never `0`.
