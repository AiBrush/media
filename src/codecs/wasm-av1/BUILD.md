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

**VENDORED (prebuilt permissive core, ADR-093).** A from-source dav1d build here needs **Meson** (absent —
`docs/notes/wasm-codec-cores.md`), so per **ADR-085** the core is a committed **prebuilt**: **`dav1d.js`
v0.1.1** (npm) — dav1d itself **BSD-3** (VideoLAN), the dav1d.js wrapper **CC0** (public domain). It ships a
**separate 376 kB `.wasm`** (the standard pair, not inlined) with named C exports (`djs_decode_obu` …) and
**stubbed pthreads** (single-thread, no COOP/COEP). Vendored files (committed):

| file | role | source / license |
|---|---|---|
| `dav1d-wasm.js` | the prebuilt dav1d.js wrapper (`create({wasmData}) → decodeFrameAsYUV`) | npm `dav1d.js@0.1.1` `dav1d.js` |
| `dav1d_wasm_bg.wasm` | compiled dav1d | npm `dav1d.js@0.1.1` `dav1d.wasm` (**dav1d BSD-3**) |
| `dav1d-core.js` | hand-written glue adapting the wrapper to the {@link Dav1dWasmCore} contract | this repo |
| `LICENSE.dav1d-js` | the CC0 wrapper license | the package |

**Provenance** (also `provenance.json`): package `https://registry.npmjs.org/dav1d.js/-/dav1d.js-0.1.1.tgz`.
sha256 — `dav1d-wasm.js` `18841e6ed40b28d5104d0690442a5fc93b15716008709f5c434768624534da67`;
`dav1d_wasm_bg.wasm` `db43216c275e6eb82662125a0aec794fd4a30153a1e60915558fe53113365487`.

**Capability boundary (NEVER-FAKE):** this dav1d.js build's YUV output is **8-bit 4:2:0 only** — a 10-bit
stream (`bear-av1-10bit.mp4`) decodes to ZERO frames, so the glue's `supports()` **declines** 10-bit /
non-4:2:0 / monochrome and the driver surfaces a clean `capability-miss`. 8-bit decode is **bit-exact vs
ffmpeg** (verified in Node on `av1.mp4`'s 10 frames — `wasm-av1-decode.test.ts`).

**Re-vendor** (`npm` is disabled — use `bun`/`curl`):
```sh
V=0.1.1
curl -sL "https://registry.npmjs.org/dav1d.js/-/dav1d.js-${V}.tgz" -o /tmp/dav1d.tgz
mkdir -p /tmp/dav1d && tar xzf /tmp/dav1d.tgz -C /tmp/dav1d
D=src/codecs/wasm-av1
cp /tmp/dav1d/package/dav1d.js   "$D/dav1d-wasm.js"
cp /tmp/dav1d/package/dav1d.wasm "$D/dav1d_wasm_bg.wasm"
cp /tmp/dav1d/package/COPYING    "$D/LICENSE.dav1d-js"
shasum -a 256 "$D/dav1d-wasm.js" "$D/dav1d_wasm_bg.wasm"   # update provenance.json + above
bunx vitest run src/codecs/wasm-av1                        # must stay green
```

`vendor-wasm.ts` discovers the `dav1d_wasm_bg.wasm` + `dav1d-core.js` pair (standard both-files path); the
glue statically imports `./dav1d-wasm.js`, which `tsup` bundles into the lazy `dav1d-core.js` chunk.

---

## Alternative: from-source dav1d via Emscripten + Meson (documented; needs Meson)

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
