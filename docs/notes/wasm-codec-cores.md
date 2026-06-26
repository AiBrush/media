# Wave-2 WASM codec-core build playbook (§3.B/§3.C, doc 04 wasm tier, ADR-031/032)

> Reproducible build recipes for every wave-2 codec WASM core we must vendor into the miss-only tail
> (`src/codecs/wasm-<id>/`). Each core ships as a committed **artifact pair** that `scripts/vendor-wasm.ts`
> auto-discovers: `<id>_wasm_bg.wasm` + `<id>-core.js`, co-located in the driver dir, loaded same-origin
> via `new URL('./<id>_wasm_bg.wasm', import.meta.url)` (BUILD §7: no CDN, no COOP/COEP, lazy, miss-only).
> This is research + recipes only — **no heavy build was run here** (the other agents are CPU-bound). Light
> verification (shallow clones, license/feature inspection, toolchain version checks) is noted inline.

## The two build shapes (and which the repo already uses)

The repo's three vendored cores (`wasm-vorbis`, `wasm-mp3`, `wasm-aac`) are all **pure-Rust Symphonia
decoders** wrapped by `wasm-bindgen` and built with `wasm-pack build --target web` — see
`src/codecs/wasm-vorbis/BUILD.md` (the canonical reference). That path emits the exact glue the drivers
import (`*_bg.wasm` + `*.js`, renamed to `*-core.js`) with **zero hand-written JS**. But Symphonia is
**decode-only**, and every wave-2 target except AV1-decode is an **encoder** — so the pure-Rust well runs
dry and most cores must wrap a C library through Emscripten. The two shapes:

- **Shape R (Rust → wasm-pack).** A `#[wasm_bindgen]` `cdylib` crate depending on a wasm-buildable Rust
  codec crate. `wasm-pack build --target web --release` → `pkg/<name>_bg.wasm` + `pkg/<name>.js`; copy the
  pair into the driver dir (rename glue → `<id>-core.js`). Clean ES-module glue, no hand JS. Used by the
  three vendored decoders; **applies to rav1e (AV1 encode)** in wave-2.
- **Shape C (C lib → Emscripten).** `emconfigure ./configure …` (autotools) or a Meson cross-file →
  `lib<x>.a`, then a tiny C shim exporting the entry points + `emcc … -sMODULARIZE -sEXPORT_ES6
  -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH --no-entry -o <id>-core.js` → `<id>-core.js` + `<id>-core.wasm`;
  rename the wasm → `<id>_wasm_bg.wasm`. A hand-written `createXCore()` in (or re-exported by) the glue
  adapts Emscripten's `cwrap`/`ccall` to the TS core contract. Used by **libopus, libvpx, dav1d, LAME**.

The artifact contract is identical either way: `vendor-wasm.ts` (`discoverTails`) takes any
`src/codecs/wasm-*` dir holding **both** a `*_wasm_bg.wasm` and a `*-core.js` and copies the pair flat into
`dist/`; a half-pair fails loudly (never a silent half-vendor). Until a pair is vendored, the driver is
honest — `supports()` → `false`, a misrouted coder raises `CapabilityError('capability-miss')`.

## Toolchain present in this environment (verified)

| Tool | Version | Notes |
|---|---|---|
| emcc (emsdk `~/emsdk`) | **6.0.1** | `source ~/emsdk/emsdk_env.sh` first. Freshly installed. Enables Shape C. |
| rustc / cargo | 1.94.0 | |
| wasm-pack | 0.14.0 | Shape R driver |
| wasm-opt (Binaryen) | **124** | Current — supports `--enable-bulk-memory`, so the old "homebrew wasm-opt rejects `memory.copy`" gotcha (vorbis BUILD.md) **no longer applies**; a `wasm-opt -Oz --enable-bulk-memory` size pass is now usable. |
| wasm32-unknown-unknown | installed | Shape R target |
| **meson** | **MISSING** | **Blocks dav1d** (Meson build) until `pip install meson ninja`. |
| **nasm** | **MISSING** | Only needed for SIMD asm (libvpx `--disable-runtime-cpu-detect` and rav1e `--no-default-features` both avoid it). |

## Summary matrix

| Core | Dir | Op | Upstream @ pin | License | Shape | Feasible here? | Est. wasm |
|---|---|---|---|---|---|---|---|
| **libopus** | `wasm-opus` (TS ✅, core ✗) | enc+dec | `xiph/opus` @ **v1.5.2** | BSD-3 ✓ | C/emcc | **YES** (emcc now present) | ~400–500 kB |
| **libvpx** | `wasm-vpx` (TS dec ✅, core ✗) | VP8+VP9 enc+dec | `webmproject/libvpx` @ **v1.14.1** | BSD-3 ✓ | C/emcc | **YES** (no nasm needed) | ~1–2 MB (drop unused) |
| **dav1d** | `wasm-av1` (TS ✅, core ✗) | AV1 dec | `videolan/dav1d` @ **1.4.x** | BSD-2 ✓ | C/emcc + **Meson** | **BLOCKED** until meson installed | ~400–700 kB (8-bit only) |
| **rav1e** | `wasm-av1`/new (task #9) | AV1 enc | `xiph/rav1e` @ **v0.8.0** | BSD-2 ✓ | **Rust/wasm-pack** | **YES** (`--no-default-features`) | ~1.5–3 MB |
| **MP3 enc** | `wasm-mp3` (TS dec ✅ Symphonia) | enc | LAME `3.100` / Shine | **LGPL** ⚠ | C/emcc | buildable but **LICENSE BLOCKER** | LAME ~250 kB / Shine ~80 kB |
| **libvorbis** | `wasm-vorbis` (dec ✅ Symphonia) | Vorbis enc | `xiph/vorbis` @ **v1.3.7** + libogg `v1.3.5` | BSD-3 ✓ | C/emcc | **YES** | ~300–500 kB |

Hard blockers up front: **(1) MP3 encode has no permissive option** — LAME is LGPL-2.1, Shine is LGPL-2.0
(verified its `COPYING` = GNU *Library* GPL v2); there is no pure-Rust/no-C MP3 encoder (Symphonia and
puremp3 are decode-only). **(2) dav1d needs Meson**, absent here. Everything else builds in this sandbox.

---

## 1. libopus — encode + decode (HIGHEST priority; TS already written)

**Upstream:** https://github.com/xiph/opus — pin **`v1.5.2`** (fixes 1.5 build issues + an AVX2 crash; 1.6.x
exists but 1.5.2 is the conservative pin). **License:** BSD-3-Clause (permissive ✓; the GPL bit is only
`mpglib`/`--enable-custom-modes` decode helpers we don't use). **Shape:** C/Emscripten. The TS wrapper
(`src/codecs/wasm-opus/opus.ts`) and Node tests are **already written** — only the core is missing — so
this is first up at integration. The existing `wasm-opus/BUILD.md` "Recipe A" is the seed; emcc 6.0.1 is
now present, so it is buildable here (it was blocked before only by the missing emcc).

### Build (Shape C)

```sh
source ~/emsdk/emsdk_env.sh
# 1. libopus → wasm static archive. No SIMD/threads (common path; no COOP/COEP).
git clone --depth 1 --branch v1.5.2 https://github.com/xiph/opus.git && cd opus
./autogen.sh
emconfigure ./configure --disable-shared --disable-doc --disable-extra-programs \
  --disable-intrinsics CFLAGS="-O3"
emmake make -j

# 2. Tiny C shim (opus_shim.c) exporting the 6 entry points the contract needs, linked vs .libs/libopus.a:
emcc -O3 opus_shim.c .libs/libopus.a -I include \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web \
  -sEXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8","cwrap","ccall"]' \
  -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 --no-entry \
  -o opus-core.js
mv opus-core.wasm src/codecs/wasm-opus/opus_wasm_bg.wasm   # match the URL the driver resolves
cp  opus-core.js  src/codecs/wasm-opus/opus-core.js
# Optional size pass (Binaryen 124 supports bulk-memory): wasm-opt -Oz --enable-bulk-memory ...
```

The glue must expose the **`--target web`-style** surface the driver imports: `export default function
init(...)` (instantiate + fetch `opus_wasm_bg.wasm`) and a named `export function createOpusCore()`. Since
this is hand-written glue (not wasm-bindgen), wrap Emscripten's module in a small `createOpusCore()` that
returns the `OpusWasmCore` shape from `opus.ts`.

### Wrapper API surface (must satisfy `opus.ts` — verified against the file)

`OpusWasmCore { createDecoder(init) → OpusWasmDecoder; createEncoder(init) → OpusWasmEncoder }`, where
`OpusWasmDecoder { decode(packet: Uint8Array, samples: number) → Float32Array (interleaved, samples×ch);
free() }` and `OpusWasmEncoder { encode(frame: Float32Array) → Uint8Array; free() }`. The C shim's 6
exports map 1:1:

| Contract method | libopus call(s) |
|---|---|
| `createDecoder({sampleRate, channels, preSkip})` | `opus_decoder_create` (rate ∈ {8,12,16,24,48}k, 1–2 ch) |
| `decoder.decode(packet, samples)` | `opus_decode_float` (out len = `samples×channels`) |
| `decoder.free()` | `opus_decoder_destroy` (idempotent) |
| `createEncoder({sampleRate, channels, bitrate, frameMs, frameSamples})` | `opus_encoder_create` + `OPUS_SET_BITRATE` (`'auto'`→`OPUS_AUTO`) |
| `encoder.encode(frame)` | `opus_encode_float` (`frame.length === frameSamples×channels`, driver-guaranteed) |
| `encoder.free()` | `opus_encoder_destroy` (idempotent) |

The driver owns ALL framing (TOC-sized decode buffers, `FrameAccumulator` re-chunking to exact
`frameSamples`, PTS, `AudioData` construct/close). The wasm side is pure samples-in/packet-out.

**Expected wasm:** ~400–500 kB (full enc+dec, `-O3`, no intrinsics). **Blocker:** none now (emcc present).
A pure-Rust fallback does not exist (Symphonia has no Opus; `audiopus` still needs a C libopus + sysroot).

---

## 2. libvpx — VP8 + VP9 encode + decode

**Upstream:** https://github.com/webmproject/libvpx — pin **`v1.14.1`** (latest stable line). **License:**
BSD-3-Clause (verified ✓). **Shape:** C/Emscripten (autotools). The `wasm-vpx` dir has a decode TS contract
(`VpxWasmCore { createDecoder } / VpxWasmDecoder { decode(packet) → VpxDecodedFrame[]; free }`); the
encode surface must be **added** to `vpx.ts` to match the brief's VP8/VP9 encode goal.

### Build (Shape C)

```sh
source ~/emsdk/emsdk_env.sh
git clone --depth 1 --branch v1.14.1 https://github.com/webmproject/libvpx.git && cd libvpx
# `generic-gnu` = the wasm target; `--disable-runtime-cpu-detect` → pure-C paths (NO nasm needed).
emconfigure ./configure --target=generic-gnu \
  --disable-runtime-cpu-detect --disable-examples --disable-docs --disable-tools \
  --disable-unit-tests --disable-install-bins --disable-install-libs \
  --enable-vp8 --enable-vp9 --enable-vp8-encoder --enable-vp8-decoder \
  --enable-vp9-encoder --enable-vp9-decoder --extra-cflags="-O3 -flto"
emmake make -j         # → libvpx.a (slow: builds all selected enc+dec)

# Link the shim against libvpx.a (+ libyuv if you want CSP conversion in-core; else do it in TS):
emcc -O3 -flto vpx_shim.c libvpx.a -I . -I vpx \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32","cwrap","ccall"]' \
  -sFILESYSTEM=0 -sMALLOC=emmalloc --no-entry -o vpx-core.js
mv vpx-core.wasm src/codecs/wasm-vpx/vpx_wasm_bg.wasm
cp vpx-core.js   src/codecs/wasm-vpx/vpx-core.js
```

### wasm-compat gotchas
- **No nasm/SIMD on the common path:** `--disable-runtime-cpu-detect` + `generic-gnu` uses the portable C
  routines — slower but builds without nasm and runs without WASM-SIMD/COOP-COEP. (A SIMD build would need
  `nasm` + `-msimd128` + a crossOriginIsolated page; defer to the §3.G.23 threaded-SIMD opt-in.)
- **No pthreads** (`--enable-multithread` + `-sUSE_PTHREADS` needs COOP/COEP) — single-threaded.
- **Build size/time:** libvpx rebuilds every enc+dec each run; drop whichever of VP8/VP9 enc/dec a given
  artifact doesn't need to cut both. A reported "Toolchain is unable to link executables" on tip-of-tree
  Emscripten is avoided by pinning a release tag (v1.14.1) rather than `main`.

### Wrapper API surface
- Decode (existing `VpxWasmCore`): `createDecoder(VpxDecoderInit)` → `VpxWasmDecoder.decode(packet) →
  VpxDecodedFrame[]` (`vpx_codec_dec_init` with the VP8/VP9 iface, `vpx_codec_decode`, `vpx_codec_get_frame`
  loop → I420 planes + dims), `free()` → `vpx_codec_destroy`.
- Encode (**to add**, mirror the Opus encoder shape): `createEncoder({width,height,fps,bitrate,...})` →
  `VpxWasmEncoder.encode(frame: I420/RGBA) → EncodedChunk-bytes[]` over `vpx_codec_enc_init` +
  `vpx_codec_enc_config_default` + `vpx_codec_encode` + `vpx_codec_get_cx_data` (keyframe flag from
  `VPX_FRAME_IS_KEY`), `free()`.

**Expected wasm:** ~1–2 MB depending on how many of {VP8,VP9}×{enc,dec} are kept (VP9 encoder dominates).
**Blocker:** none (nasm not required for the C path); only the encode TS contract needs writing.

---

## 3. dav1d — AV1 decode

**Upstream:** https://github.com/videolan/dav1d (mirror of code.videolan.org) — pin a **1.4.x** tag.
**License:** BSD-2-Clause (verified ✓). **Shape:** C/Emscripten but **Meson-built** (no autotools) → needs
a Meson **cross file**, and **meson is absent here**. The `wasm-av1` dir already has the decode contract
(`Dav1dWasmCore { createDecoder } / Dav1dWasmDecoder { decode(packet) → Av1DecodedFrame[]; free }`).
Reference port: Kagami/dav1d.js (BSD core + CC0 wrapper) — adapt its cross file + build script.

### Build (Shape C via Meson cross file) — **requires `pip install meson ninja` first**

```sh
source ~/emsdk/emsdk_env.sh
pip install meson ninja          # PREREQUISITE (missing in this sandbox)
git clone --depth 1 --branch 1.4.3 https://github.com/videolan/dav1d.git && cd dav1d
# dav1d-wasm-cross.txt: [binaries] c='emcc'  ar='emar'  [host_machine] cpu_family='wasm32' ...
meson setup build --cross-file=dav1d-wasm-cross.txt \
  -Dbuild_asm=false -Dbuild_tests=false -Dbuild_tools=false \
  -Dbitdepths='["8"]' -Ddefault_library=static -Dfake_atomics=true --buildtype release
ninja -C build                    # → build/src/libdav1d.a
emcc -O3 dav1d_shim.c build/src/libdav1d.a -I include -I build/include \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","cwrap","ccall"]' -sFILESYSTEM=0 --no-entry \
  -o dav1d-core.js
mv dav1d-core.wasm src/codecs/wasm-av1/dav1d_wasm_bg.wasm
cp dav1d-core.js   src/codecs/wasm-av1/dav1d-core.js
```

### wasm-compat gotchas
- **`-Dbuild_asm=false`** — drop the x86/aarch64 asm (doesn't apply to wasm; also avoids nasm).
- **`-Dfake_atomics=true`** — the LLVM-wasm backend emits real atomic ops for single-threaded code that
  Emscripten then refuses to validate; fake-atomics rewrites them to non-atomic (single-thread safe). This
  is the canonical dav1d-on-wasm fix.
- **`-Dbitdepths='["8"]'`** — 8-bit only halves the binary; add `"16"` only if 10-bit AV1 decode is needed.
- **No threads** (single-threaded; `fake_atomics` presupposes it).

### Wrapper API surface (existing `Dav1dWasmCore`)
`createDecoder(Av1DecoderInit)` → `Dav1dWasmDecoder.decode(packet) → Av1DecodedFrame[]` over
`dav1d_open`, `dav1d_send_data` + `dav1d_get_picture` (drain loop; one OBU packet may yield 0..n frames),
exposing I420/I010 planes + dims + bit depth; `free()` → `dav1d_close`.

**Expected wasm:** ~400–700 kB (8-bit, no asm). **Blocker:** **Meson not installed** — `pip install meson
ninja` unblocks it; otherwise honest-NA AV1 decode (WebCodecs AV1 covers the hardware/native path anyway).

---

## 4. rav1e — AV1 encode (pure-Rust; Shape R — task #9)

**Upstream:** https://github.com/xiph/rav1e — pin **`v0.8.0`**. **License:** BSD-2-Clause (verified ✓).
**Shape:** **R (Rust → wasm-pack)** — the only fully pure-Rust wave-2 encoder, so it fits the established
vorbis/mp3/aac vendoring pattern with zero hand JS. **This is feasible here**, contrary to the common
"rav1e can't do wasm" claim, because of `maybe-rayon` (verified in v0.8.0 `Cargo.toml`).

### Why it builds on wasm32 (verified from the pinned Cargo.toml)
```
default   = ["binaries", "asm", "threading", "signal_support", "git_version"]
asm       = ["nasm-rs", "cc"]          # x86/aarch64 only — N/A on wasm
threading = ["rayon/threads"]
rayon     = { package = "maybe-rayon", version = "0.1", default-features = false }
```
- `asm` pulls nasm/cc → would fail on wasm32; **drop it** (`--no-default-features`). The asm is
  architecture-specific anyway, so rav1e falls back to pure-Rust routines.
- `threading` pulls real `rayon` threads → `std::thread::spawn` **panics/traps** on
  wasm32-unknown-unknown. But rayon is aliased to **`maybe-rayon`**, which compiles to a **single-threaded
  shim** when `threading` is off. So `--no-default-features` gives a working single-thread wasm encoder.
- Also drop `binaries` (CLI deps) and `git_version` (needs git at build).

### Build (Shape R)

```sh
# A thin cdylib wrapper crate (lives in src/codecs/wasm-av1/encoder-crate/ or a new wasm-rav1e/):
#   Cargo.toml: [lib] crate-type=["cdylib"];  deps: wasm-bindgen="0.2",
#               rav1e = { version = "0.8", default-features = false }
#   src/lib.rs: #[wasm_bindgen] struct Rav1eWasmEncoder wrapping rav1e::api::{Config,Context},
#               + #[wasm_bindgen] fn create_rav1e_core() -> ... matching the (to-add) encoder contract.
#   [profile.release]: opt-level="s", lto=true, codegen-units=1, panic="abort", strip=true
#   [package.metadata.wasm-pack.profile.release]: wasm-opt = false   # then size-pass with Binaryen 124
cd src/codecs/wasm-av1/encoder-crate
wasm-pack build --target web --release --out-dir pkg
cp pkg/rav1e_wasm_bg.wasm ../rav1e_wasm_bg.wasm   # (or wasm-av1 dir; keep <id>_wasm_bg.wasm naming)
cp pkg/rav1e_wasm.js      ../rav1e-core.js
```

### Wrapper API surface (encode; mirror Opus-encoder shape, new contract)
`createEncoder({width,height,fps,bitDepth,speed,bitrate|quantizer})` → `Rav1eWasmEncoder` over
`rav1e::Config` → `Context`; `encode(frame: I420/I010-planes)` feeds `ctx.send_frame(Frame)` and drains
`ctx.receive_packet()` → AV1 OBU bytes + keyframe flag (`Packet::frame_type == FrameType::KEY`); `flush()`
calls `ctx.flush()` then drains the tail; `free()` drops the context. The driver owns frame planing + PTS.

**wasm-compat gotchas:** `--no-default-features` (drops asm/nasm + rayon-threads + binaries). Single-thread
→ slower than native rav1e but correct. `panic="abort"` (trap → typed `MediaError`).

**Expected wasm:** ~1.5–3 MB (rav1e is large). **Blocker:** none; slowest of the cores at encode time
(acceptable for a miss-only software tail — WebCodecs/hardware AV1 encode is the fast path when present).

---

## 5. MP3 encode — LAME vs Shine (LICENSE BLOCKER)

**The honest finding:** there is **no permissive MP3 encoder**. Both C options are copyleft, and no
pure-Rust/no-C MP3 *encoder* exists (Symphonia — which already powers our `wasm-mp3` **decode** core, MIT —
and puremp3 are decode-only; `mp3lame-encoder` is just a LAME binding).

| Encoder | Upstream | License (verified) | Quality | wasm size | Notes |
|---|---|---|---|---|---|
| **LAME** | https://lame.sourceforge.io (`lame-3.100`) | **LGPL-2.1+** ⚠ (decoder part is GPL — unused) | reference / best | ~250 kB | autotools → emcc, like libopus |
| **Shine** | https://github.com/toots/shine | **LGPL-2.0** ⚠ (its `COPYING` = GNU *Library* GPL v2) | poor (loses blind tests) | ~80 kB | fixed-point, fast on ARM; tiny |

Both are **LGPL** → distributing the wasm imposes the LGPL burden: ship the corresponding source (or
object files for relink) and allow the user to relink a modified core. That is satisfiable for a wasm
artifact (vendor the upstream source under the driver dir + a LICENSE note, the libav.js precedent), but it
is a **policy decision for the lead** — our other cores are all BSD/MIT. CLAUDE.md §licensing wants
permissive; MP3-encode cannot meet that with a C lib.

**Recommendation:** treat MP3 **encode** as an **honest capability-miss** by default (the WebCodecs/native
path and our Symphonia **decode** core stay; MP3 is a legacy *output* format with low demand), and only add
LAME-via-emcc behind an explicit opt-in + an ADR accepting the LGPL source-distribution obligation. If a
small permissive encoder is wanted regardless of quality, Shine is still LGPL, so it does not escape the
problem — the choice is "LGPL or NA," not "LAME vs permissive."

### If the lead accepts LGPL (LAME path, Shape C)
```sh
source ~/emsdk/emsdk_env.sh
git clone --depth 1 https://github.com/rbrito/lame.git && cd lame   # or the sourceforge 3.100 tarball
emconfigure ./configure --disable-shared --disable-frontend --disable-decoder --enable-nasm=no CFLAGS="-O3"
emmake make -j                                  # → libmp3lame/.libs/libmp3lame.a
emcc -O3 mp3_enc_shim.c libmp3lame/.libs/libmp3lame.a -I include \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8","cwrap","ccall"]' -sFILESYSTEM=0 --no-entry \
  -o mp3enc-core.js
# NOTE: the existing wasm-mp3 dir holds the Symphonia DECODE pair (mp3_wasm_bg.wasm/mp3-core.js). Do NOT
# clobber it — vendor encode as a sibling (e.g. wasm-mp3enc/) so both pairs coexist for vendor-wasm.ts.
```
Shim surface (Opus-encoder-shaped): `createEncoder({sampleRate,channels,bitrate|vbrQuality})` →
`encode(frame: Float32Array)` over `lame_init` + `lame_set_*` + `lame_encode_buffer_ieee_float`, `flush()`
→ `lame_encode_flush`, `free()` → `lame_close`.

---

## 6. libvorbis + libogg — Vorbis encode

**Upstream:** https://github.com/xiph/vorbis (`v1.3.7`) + https://github.com/xiph/ogg (`v1.3.5`).
**License:** BSD-3-Clause for libvorbis/libvorbisenc/libogg (format is public domain) — verified ✓.
**Shape:** C/Emscripten (autotools); official `emscripten-ports/Vorbis` exists as a reference. The
`wasm-vorbis` dir holds the Symphonia **decode** pair; Vorbis **encode** needs libvorbisenc (Symphonia
can't encode), vendored as a sibling so both coexist.

### Build (Shape C — libogg first, then libvorbis)

```sh
source ~/emsdk/emsdk_env.sh
PREFIX=$PWD/wasm-sysroot
# libogg
git clone --depth 1 --branch v1.3.5 https://github.com/xiph/ogg.git && cd ogg
./autogen.sh && emconfigure ./configure --disable-shared --prefix=$PREFIX CFLAGS="-O3"
emmake make -j && emmake make install && cd ..
# libvorbis (+ libvorbisenc) against the wasm libogg
git clone --depth 1 --branch v1.3.7 https://github.com/xiph/vorbis.git && cd vorbis
./autogen.sh && emconfigure ./configure --disable-shared --disable-examples --disable-docs \
  --prefix=$PREFIX --with-ogg=$PREFIX CFLAGS="-O3"
emmake make -j && emmake make install && cd ..
# shim: link vorbis_enc_shim.c against libvorbisenc.a + libvorbis.a + libogg.a
emcc -O3 vorbis_enc_shim.c $PREFIX/lib/libvorbisenc.a $PREFIX/lib/libvorbis.a $PREFIX/lib/libogg.a \
  -I $PREFIX/include -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8","cwrap","ccall"]' -sFILESYSTEM=0 --no-entry \
  -o vorbisenc-core.js
mv vorbisenc-core.wasm src/codecs/wasm-vorbis-enc/vorbisenc_wasm_bg.wasm   # sibling dir; don't clobber decode
cp vorbisenc-core.js   src/codecs/wasm-vorbis-enc/vorbisenc-core.js
```

### wasm-compat gotchas
- No asm/threads in libvorbis — clean autotools build, no special flags beyond `emconfigure`.
- **Header triplet:** vorbis encode produces the id/comment/setup headers the WebM/Ogg muxer needs as
  `CodecPrivate`/`description` — surface them from the shim (vorbis encode emits them via
  `vorbis_analysis_headerout` before the first audio packet).
- Build the dev source needs autoconf/automake/libtool/pkg-config (`./autogen.sh`).

### Wrapper API surface (encode; new contract, Opus-encoder-shaped)
`createEncoder({sampleRate,channels,quality|bitrate})` → returns the 3 setup headers + a `VorbisWasmEncoder`
over `vorbis_info` + `vorbis_analysis_init` + `vorbis_encode_init_vbr`; `encode(frame: Float32Array
planar)` feeds `vorbis_analysis_buffer`/`vorbis_analysis` and drains `vorbis_bitrate_flushpacket` → packet
bytes; `flush()` signals end-of-stream (`vorbis_analysis_wrote(0)`); `free()` clears the DSP/block state.

**Expected wasm:** ~300–500 kB (libvorbis + libvorbisenc + libogg). **Blocker:** none.

---

## Cross-cutting build conventions (all Shape-C cores)

- **emcc flags (common path):** `-O3 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web
  -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 --no-entry`, plus the minimal `-sEXPORTED_RUNTIME_METHODS` the
  shim uses (`HEAPF32`/`HEAPU8`/`cwrap`/`ccall`). **No** `-sUSE_PTHREADS`, **no** `-pthread`, **no**
  `-msimd128` on the common path (those need crossOriginIsolated / COOP-COEP — out of scope until §3.G.23).
- **`-sENVIRONMENT=web`** keeps the glue from probing Node-only globals; the drivers load it via
  `import.meta.url` (BUILD §7). The Node tests instantiate a precompiled `WebAssembly.Module` directly (the
  `--target web`/ES6 glue accepts one), so no fetch/server is needed in Vitest — mirror `vorbis.test.ts`.
- **Naming is load-bearing:** the wasm MUST end `_wasm_bg.wasm` and the glue MUST end `-core.js`, both in
  `src/codecs/wasm-<id>/`, or `vendor-wasm.ts` (`discoverTails`) won't pick up the pair (and `--check`
  fails in CI). Encode cores that would collide with an existing decode pair go in a **sibling** dir.
- **Size pass:** Binaryen is now v124 here, so `wasm-opt -Oz --enable-bulk-memory <id>_wasm_bg.wasm -o
  <id>_wasm_bg.wasm` is safe (the old too-old-wasm-opt gotcha from the vorbis recipe is gone). Keep
  `[package.metadata.wasm-pack.profile.release] wasm-opt = false` for Shape-R crates and run the pass
  manually, or let wasm-pack run it now that Binaryen is current.
- **Honesty:** vendor BOTH halves or neither; a missing core keeps `supports()=false` +
  `CapabilityError`. Validate post-vendor in the Playwright harness (force-software / WebCodecs-absent),
  SNR/sample-count oracle vs the WebCodecs reference, plus a fresh multi-sample throughput bench (ADR-025),
  exactly as the opus/vorbis BUILD.md sections specify.

## Integration order (recommendation)

1. **libopus** (TS + tests ready, BSD, emcc present) — immediate.
2. **rav1e** (pure-Rust, BSD, Shape R) and **libvpx** (BSD, no nasm) — parallel; both clean here.
3. **libvorbis encode** (BSD) — straightforward autotools.
4. **dav1d** — after `pip install meson ninja`.
5. **MP3 encode** — only on an explicit lead decision + ADR accepting LGPL; else honest-NA.

Sources: [xiph/opus releases](https://github.com/xiph/opus/releases) ·
[webmproject/libvpx CHANGELOG](https://chromium.googlesource.com/webm/libvpx/+/master/CHANGELOG) ·
[web.dev: Emscripten + libvpx](https://web.dev/articles/emscripten-npm) ·
[Kagami/dav1d.js](https://github.com/Kagami/dav1d.js) ·
[videolan/dav1d meson.build](https://github.com/videolan/dav1d/blob/master/meson.build) ·
[xiph/rav1e Cargo.toml (v0.8.0, inspected)](https://github.com/xiph/rav1e) ·
[rav1e wasm32-wasi issue #2153](https://github.com/xiph/rav1e/issues/2153) ·
[LAME license](https://lame.sourceforge.io/license.txt) · [toots/shine COPYING (LGPL-2.0, inspected)](https://github.com/toots/shine) ·
[xiph/vorbis README](https://github.com/xiph/vorbis/blob/master/README.md) ·
[emscripten-ports/Vorbis](https://github.com/emscripten-ports/Vorbis) ·
[Symphonia (decode-only)](https://github.com/pdeljanov/Symphonia) ·
[webmproject/libvpx LICENSE (BSD-3, inspected)](https://github.com/webmproject/libvpx).
