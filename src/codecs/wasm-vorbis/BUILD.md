# Building the `wasm-vorbis` core (self-hosted, vendored, miss-only)

This driver (`wasm-vorbis-driver.ts`) decodes Vorbis via **Symphonia's pure-Rust `symphonia-codec-vorbis`
compiled to WebAssembly** — no C toolchain — loaded same-origin through `new URL('./vorbis_wasm_bg.wasm',
import.meta.url)` (BUILD §7: no CDN, no COOP/COEP, lazy + miss-only). The `.wasm` + JS glue are **vendored
into this directory** and committed; this file is the reproducible recipe that produced them.

Unlike libopus (which needs Emscripten/autotools — see `../wasm-opus/BUILD.md`, ADR-031), Symphonia is
pure Rust, so it builds with the toolchain present in this environment. **This recipe was run here and
succeeded.**

---

## Vendored artifacts (committed)

| File | What | Source |
|---|---|---|
| `vorbis_wasm_bg.wasm` (~157 kB) | the Symphonia Vorbis decoder | `wasm-pack build` output |
| `vorbis-core.js` (~11 kB) | wasm-bindgen `--target web` glue | renamed from `vorbis_wasm.js` |
| `vorbis-core.d.ts` | ambient type for the glue | hand-written, matches the generated `.d.ts` |
| `crate/` | the Rust source + `Cargo.toml`/`Cargo.lock` | the recipe; `crate/target` + `crate/pkg` are gitignored |

The pure framing/format glue (`vorbis.ts`) — Xiph header-lacing, Ogg page→packet de-lacing, planar f32,
config validation — is Node-validated and ships regardless; the wasm carries only the lossy MDCT decode.

---

## Recipe (verified in this environment)

Toolchain: `rustc` + `cargo` + `wasm-pack` + the `wasm32-unknown-unknown` target (all present here).

```sh
cd src/codecs/wasm-vorbis/crate
wasm-pack build --target web --release --out-dir pkg
# emits pkg/vorbis_wasm_bg.wasm + pkg/vorbis_wasm.js + pkg/vorbis_wasm.d.ts

# Vendor into the driver directory (rename the glue to the specifier the driver imports):
cp pkg/vorbis_wasm_bg.wasm ../vorbis_wasm_bg.wasm
cp pkg/vorbis_wasm.js      ../vorbis-core.js
```

### Two build notes (already encoded in `crate/Cargo.toml`)

1. **`wasm-opt` is disabled** (`[package.metadata.wasm-pack.profile.release] wasm-opt = false`). The
   homebrew `wasm-opt` in this environment predates the bulk-memory (`memory.copy`) ops modern LLVM emits
   and rejects the otherwise-valid module. The wasm-bindgen output is already correct and complete; Rust's
   `opt-level="s"` + fat-LTO + `strip` keep it lean (157 kB). To shrink further on a machine with a current
   Binaryen: `wasm-opt -Oz --enable-bulk-memory vorbis_wasm_bg.wasm -o vorbis_wasm_bg.wasm`.
2. **`panic = "abort"`** drops unwinding tables (smaller wasm; a Rust panic becomes a wasm trap, surfaced
   as a thrown error the driver wraps in a typed `MediaError`).

### The Rust surface (`crate/src/lib.rs`)

A `#[wasm_bindgen]` `VorbisWasm` whose generated JS class is exactly what `vorbis-core.d.ts` declares:

| JS | Rust / Symphonia | notes |
|---|---|---|
| `new VorbisWasm(extra_data, channels, sample_rate)` | `VorbisDecoder::try_new` | `extra_data` = Xiph-laced (`0x02`-led) or concatenated `ident‖setup` headers; geometry seeds the getters |
| `.decode(packet) → Float32Array` | `decode_ref` + `copy_to_vec_interleaved::<f32>` | interleaved f32 `frames × channels`; first block may be empty (overlap priming) |
| `.channels` / `.sampleRate` | from the decoded `AudioSpec` (reconciled) | authoritative once a block decodes |
| `.reset()` | `decoder.reset()` | at a seek/discontinuity |
| `.free()` | drop | wasm-bindgen-generated |

The driver owns all container/framing concerns: it feeds the codec-private `description` as `extra_data`,
hands the decoder each `EncodedAudioChunk`'s bytes, wraps the returned interleaved f32 in an `f32-planar`
`AudioData`, advances PTS, and closes frames. The wasm side is pure packet-in / samples-out.

---

## Validation (what the test suite already proves, Node)

`vorbis.test.ts` runs **the real wasm core in Node** (the `--target web` glue accepts a precompiled
`WebAssembly.Module`, so no fetch is needed): it demuxes the real `sound_5.oga`, builds the Xiph extra-data
from the 3 header packets, instantiates `VorbisWasm`, decodes every audio packet, and gates on Vorbis's
own self-consistency oracle — the decoder reports the identification header's channels + sample rate, every
sample is a finite f32 in ~[-1, 1], the clip is non-silent, and the **total decoded sample count lands
within one long block of the stream's final granule position** (the end-padding a container `decode` trims;
RFC 5215 §1.3.3). Landing within one block of the exact granulepos is impossible without truly running the
codec — a strong, un-fakeable check.

The browser-only part — the `createDecoder` `TransformStream` wrapping the core's output in WebCodecs
`AudioData`, and the driver's `import.meta.url` fetch path — is validated in the Playwright harness
(ADR-025), with `force-software` / Vorbis-WebCodecs-absent forcing this tier, decode SNR vs a reference,
and a fresh multi-sample throughput benchmark.

## Rebuilding from scratch

`crate/target` and `crate/pkg` are gitignored (the 153 MB Rust build cache regenerates). To rebuild: run
the recipe above; the committed `Cargo.lock` pins exact crate versions (`symphonia-codec-vorbis` 0.6,
`symphonia-core` 0.6, `wasm-bindgen` 0.2) for a reproducible artifact.
