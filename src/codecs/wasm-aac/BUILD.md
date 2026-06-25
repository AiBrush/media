# Building the `wasm-aac` core (self-hosted, vendored, miss-only)

This driver (`wasm-aac-driver.ts`) decodes **AAC-LC** via Symphonia's pure-Rust `symphonia-codec-aac`
compiled to WebAssembly — no C toolchain — loaded same-origin through `new URL('./aac_wasm_bg.wasm',
import.meta.url)` (BUILD §7: no CDN, no COOP/COEP, lazy + miss-only). The `.wasm` + JS glue are **vendored
into this directory** and committed; this file is the reproducible recipe that produced them.

Like wasm-vorbis (ADR-036) and unlike libopus (ADR-031), Symphonia is pure Rust, so it builds with the
toolchain present in this environment. **This recipe was run here and succeeded.**

---

## Vendored artifacts (committed)

| File | What | Source |
|---|---|---|
| `aac_wasm_bg.wasm` (~145 kB) | the Symphonia AAC-LC decoder | `wasm-pack build` output |
| `aac-core.js` (~10 kB) | wasm-bindgen `--target web` glue | renamed from `aac_wasm.js` |
| `aac-core.d.ts` | ambient type for the glue | hand-written, matches the generated `.d.ts` |
| `decode-fixture.mjs` | the real-decode validation harness (runs in a clean Node child) | hand-written |
| `crate/` | the Rust source + `Cargo.toml`/`Cargo.lock` | the recipe; `crate/target` + `crate/pkg` are gitignored |

The pure ADTS-framing / ASC / format glue (`aac.ts`) is Node-validated; the wasm carries the lossy
MDCT/Huffman decode.

---

## Recipe (verified in this environment)

```sh
cd src/codecs/wasm-aac/crate
wasm-pack build --target web --release --out-dir pkg
# emits pkg/aac_wasm_bg.wasm + pkg/aac_wasm.js + pkg/aac_wasm.d.ts

cp pkg/aac_wasm_bg.wasm ../aac_wasm_bg.wasm
cp pkg/aac_wasm.js      ../aac-core.js   # rename to the specifier the driver imports
```

### Build notes (encoded in `crate/Cargo.toml`)

- **`wasm-opt = false`** — the environment's Binaryen predates the bulk-memory ops modern LLVM emits and
  rejects the valid module. The wasm-bindgen output is already correct; Rust `opt-level="s"` + LTO + strip
  keep it ~145 kB. To shrink further on a current Binaryen: `wasm-opt -Oz --enable-bulk-memory …`.
- **`panic = "abort"`** drops unwinding tables; a Rust panic becomes a wasm trap surfaced as a thrown
  error the driver wraps in a typed `MediaError`.

### Two AAC-specific correctness points (in `crate/src/lib.rs`)

1. **Positioned channel layout.** Symphonia's AAC decoder indexes channels by *position*
   (`CHANNEL_LAYOUT_MONO = FRONT_CENTER`, `CHANNEL_LAYOUT_STEREO = FRONT_LEFT|FRONT_RIGHT`). Passing a
   `Channels::Discrete(n)` layout compiles but **panics** in the channel-element setup. The crate therefore
   builds channels via `symphonia_common::mpeg::audio::get_mpeg4_audio_channels_by_config_index` — the
   exact mapping Symphonia's own ADTS reader uses.
2. **Raw payload in.** `AacDecoder::decode_ref` wants the **raw AAC frame** (no ADTS header). For MP4 the
   demuxer already yields raw packets + the ASC (`esds` → the WebCodecs `description`); for an ADTS source
   `aac.ts::parseAdtsFrame` strips the 7/9-byte header first. When no ASC is present (ADTS), the decoder
   synthesizes a default AAC-LC ASC from the `channels`/`sample_rate` passed to the constructor.

### The Rust surface (`crate/src/lib.rs`)

A `#[wasm_bindgen]` `AacWasm` matching `aac-core.d.ts`: `new AacWasm(extra_data, channels, sample_rate)`
→ `AacDecoder::try_new`; `.decode(rawPacket) → Float32Array` (interleaved f32, 1024×channels for AAC-LC);
`.channels` / `.sampleRate` getters; `.reset()`; `.free()`.

> **Heap-object-table caution.** Read the `.channels`/`.sampleRate` getters **once** after construction and
> reuse the values — calling them repeatedly *interleaved with* `decode` round-trips corrupts the
> wasm-bindgen glue's heap-object table on Node (symptom: a "null pointer passed to rust" trap). Both the
> driver and `decode-fixture.mjs` cache the geometry once. (Bun tolerates the interleaving; Node does not.)

---

## Validation (what the test suite proves)

`aac.test.ts` runs two layers:

- **Pure helpers in the Vitest worker** — ADTS frame parsing, the MPEG-4 sample-rate table, ASC field
  parsing (incl. the explicit-rate `freqIndex==15` path), planar f32, config validation, and the driver's
  identity + honest `supports()`/`CapabilityError` behavior (`aac.ts` 98.7% lines).
- **The REAL codec, in a clean Node child process** (`decode-fixture.mjs`) — instantiates the vendored
  `.wasm`, de-frames the real `sfx.adts` (ADTS/AAC-LC), decodes every frame, and gates on AAC-LC's
  exact-frame oracle: the decoder reports the header's AAC-LC profile + rate + channels, **every decoded
  frame is exactly 1024 samples/channel** (so total = decodedFrames × 1024), every sample is a finite f32
  in ~[-1, 1], and the clip is non-silent. The child process is used because Vitest's V8-coverage
  instrumentation corrupts the wasm-bindgen heap-object table when the module is driven inside the worker;
  the codec runs correctly in plain Node and Bun (verified), so the decode is validated there on real bytes
  — not stubbed.

The browser-only part — the `createDecoder` `TransformStream` wrapping the core's output in WebCodecs
`AudioData`, and the driver's `import.meta.url` fetch path — is validated in the Playwright harness
(ADR-025), with `force-software` / AAC-WebCodecs-absent forcing this tier, decode SNR vs a reference, and a
fresh multi-sample throughput benchmark.

## Scope + rebuilding

Scope is **AAC-LC mono/stereo** (Symphonia rejects SBR/HE-AAC/>2-channel as "too complex" — a typed
`CapabilityError`). `crate/target` + `crate/pkg` are gitignored; the committed `Cargo.lock` pins
`symphonia-codec-aac` 0.6, `symphonia-core` 0.6, `symphonia-common` 0.6, `wasm-bindgen` 0.2 for a
reproducible artifact.
