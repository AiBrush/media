# Building the `wasm-opus` core (self-hosted, vendored, miss-only)

This driver (`src/codecs/wasm-opus/wasm-opus-driver.ts`) decodes/encodes Opus via **libopus compiled to
WebAssembly**, loaded same-origin through `new URL('./opus_wasm_bg.wasm', import.meta.url)` (BUILD §7 —
no CDN, no COOP/COEP, lazy + miss-only). The `.wasm` + its JS glue are a **vendored build artifact**: this
file is the recipe that produces them. Until they are vendored, the driver is honest — `supports()`
returns `false` and a (mis)routed coder raises a typed `CapabilityError` (`capability-miss`).

The pure framing/format/validation logic (TOC parsing, the RFC 6716 frame-size table, encoder
re-chunking, planar↔interleaved f32, config validation) lives in `opus.ts` and is already validated in
Node (`opus.test.ts`). The wasm core supplies **only** the lossy CELT/SILK entropy coding.

---

## Status in this environment (why it is not vendored here)

This build sandbox has `rustc` 1.94, `cargo`, `wasm-pack` 0.14, the `wasm32-unknown-unknown` target, and
`clang` — but **no Emscripten (`emcc`)** and **no autotools (`autoreconf`)**. Two facts were measured, not
assumed (see ADR-026):

1. **Pure Rust → wasm works end-to-end.** A `wasm-bindgen` crate built with `wasm-pack build --target web`
   emitted exactly `*_bg.wasm` + `*.js` glue + `.d.ts` — the shape this driver's loader expects.
2. **libopus cannot be built here.** Adding `audiopus` (the maintained libopus binding) and building for
   `wasm32-unknown-unknown` fails in `audiopus_sys`'s C build: `autogen.sh: ... autoreconf: command not
   found` — and even past that, linking a `wasm32` libopus needs a C/wasm sysroot (Emscripten), which is
   absent. There is **no production pure-Rust Opus** (Symphonia exposes no `opus` feature), so neither a
   C nor a pure-Rust path completes in this sandbox.

Per the task's hard bound, the toolchain chase was stopped; the recipe below is the deliverable, verified
to the point `wasm-pack` runs. Vendor the artifact on a machine that has **Emscripten** (the libopus path)
and commit the two files into this directory.

---

## Recipe A — libopus via Emscripten (recommended: full decode **and** encode, reference quality)

Requires `emcc` (Emscripten ≥ 3.1) + `make`/`autoconf`/`automake`/`libtool`.

```sh
# 1. Build libopus to a wasm static archive (no SIMD/threads → common path, no COOP/COEP).
git clone --depth 1 https://github.com/xiph/opus.git && cd opus
./autogen.sh
emconfigure ./configure --disable-shared --disable-doc --disable-extra-programs \
  --disable-intrinsics CFLAGS="-O3"
emmake make -j

# 2. Compile a tiny C shim (opus_shim.c) exporting the 6 entry points the core contract needs
#    (see "The core contract" below) and link it against .libs/libopus.a:
emcc -O3 opus_shim.c .libs/libopus.a -I include \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8"]' \
  -s ALLOW_MEMORY_GROWTH=1 -s STANDALONE_WASM=0 \
  -o opus-core.js
# → emits opus-core.js (glue) + opus-core.wasm
mv opus-core.wasm opus_wasm_bg.wasm   # match the URL the driver resolves
```

Then write a thin hand-rolled `createOpusCore()` in the glue (or a sibling `opus-core-shim.js` the glue
re-exports) that wraps the Emscripten module's `cwrap`/`ccall` calls in the `OpusWasmCore` /
`OpusWasmDecoder` / `OpusWasmEncoder` shape from `opus.ts`. The driver imports the **`--target web`-style**
surface: `export default function init(...)` (instantiate, fetching `opus_wasm_bg.wasm`) + named
`export function createOpusCore()`.

## Recipe B — Rust + `wasm-bindgen` (clean `--target web` glue; needs a wasm-buildable Opus crate)

Use this once a wasm-friendly Opus crate is available offline/in-cache (e.g. `audiopus` **with a
prebuilt** wasm libopus via `OPUS_LIB_DIR`/`OPUS_STATIC`, or a future pure-Rust Opus). It yields the exact
glue this driver was written against, with **zero hand-written JS**:

```sh
cargo new --lib opus-wasm && cd opus-wasm
# Cargo.toml: crate-type = ["cdylib"]; deps: wasm-bindgen = "0.2", audiopus = "0.2"
#   + point audiopus_sys at a prebuilt wasm libopus (OPUS_LIB_DIR) so no C build runs at compile time.
# src/lib.rs: #[wasm_bindgen] structs OpusWasmDecoder/OpusWasmEncoder wrapping audiopus::{Decoder,Encoder},
#   and a #[wasm_bindgen] fn create_opus_core() -> ... matching opus.ts's OpusWasmCore.
wasm-pack build --target web --out-dir pkg --release
cp pkg/opus_wasm_bg.wasm  ../src/codecs/wasm-opus/opus_wasm_bg.wasm
cp pkg/opus_wasm.js       ../src/codecs/wasm-opus/opus-core.js   # rename to the specifier the driver imports
```

> `wasm-pack build --target web` was confirmed working in this sandbox (it emitted `*_bg.wasm` + glue from
> a `wasm-bindgen` crate); only the libopus C dependency is missing here.

---

## The core contract (what the glue must expose)

`opus.ts` defines the precise TypeScript surface; the wasm glue must satisfy it. Summary:

| JS export | libopus call(s) | notes |
|---|---|---|
| `default(init)` | instantiate module, fetch `opus_wasm_bg.wasm` | wasm-bindgen `--target web` init signature |
| `createOpusCore()` → `OpusWasmCore` | — | factory; one per session |
| `core.createDecoder({sampleRate, channels, preSkip})` | `opus_decoder_create` | output rate ∈ {8,12,16,24,48}k; 1–2 ch |
| `decoder.decode(packet, samples)` → interleaved `Float32Array` | `opus_decode_float` | `samples` = per-channel count; length = `samples×channels` |
| `decoder.free()` | `opus_decoder_destroy` | idempotent |
| `core.createEncoder({sampleRate, channels, bitrate, frameMs, frameSamples})` | `opus_encoder_create` + `OPUS_SET_BITRATE` | `bitrate:'auto'` → `OPUS_AUTO` |
| `encoder.encode(frame)` → `Uint8Array` | `opus_encode_float` | `frame.length === frameSamples×channels` (the driver guarantees it) |
| `encoder.free()` | `opus_encoder_destroy` | idempotent |

The driver owns all framing: it re-chunks `AudioData` into exact `frameSamples` frames (`FrameAccumulator`)
before `encode`, sizes the decode buffer from the packet TOC (`decodedSamplesAtRate`), advances PTS, and
constructs/closes every `AudioData`. The wasm side is pure sample-in/packet-out — no JS framing logic.

---

## After vendoring — validation (on a browser machine, ADR-025)

1. Place `opus_wasm_bg.wasm` + `opus-core.js` in this directory; `loadOpusCore()` then resolves non-null
   and `supports({codec:'opus'})` returns `true`.
2. Add a browser (Playwright) test that, with WebCodecs Opus disabled / `force-software`, round-trips the
   real Opus corpus (`movie_5.webm`, `2x2-green.webm`, `sound_5.oga`, …): **decode** an Opus packet stream
   to `AudioData` and compare against the WebCodecs reference (SNR/near-bit-exact for decode); **encode**
   PCM → Opus → decode and gate on SNR + exact sample count (after pre-skip/pad trim).
3. Add a fresh multi-sample throughput benchmark (decode/encode Msamples/s) like `scripts/bench-flac.ts`.
4. Assert the lazy-load budget: a probe-only app pulls **zero** Opus wasm; an Opus convert on a WebCodecs
   miss pulls **only** this chunk, same-origin.
