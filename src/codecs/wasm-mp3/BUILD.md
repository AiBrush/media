# Building the `wasm-mp3` core (self-hosted, vendored, miss-only)

This driver (`src/codecs/wasm-mp3/wasm-mp3-driver.ts`) **decodes** MP3 (MPEG-1/2/2.5 Layer III) via
**Symphonia compiled to WebAssembly**, loaded same-origin through `new URL('./mp3_wasm_bg.wasm',
import.meta.url)` (BUILD §7 — no CDN, no COOP/COEP, lazy + miss-only). Unlike a scaffold, the `.wasm` + JS
glue are **already built and vendored into this directory** (`mp3_wasm_bg.wasm` + `mp3-core.js`); this file
is the recipe that reproduces them.

The pure frame-header / ID3 / Xing-LAME / format logic lives in `mp3.ts` and is validated in Node
(`mp3.test.ts`), which **also instantiates the vendored wasm core from bytes and decodes the real
`sound_5.mp3` + `bear-vbr-toc.mp3`** — so the codec itself is exercised end-to-end in CI, not only in a
browser. The wasm core supplies the lossy Layer-III decode (Huffman / IMDCT / synthesis filterbank).

**Scope: decode only.** This fallback fills the WebCodecs **MP3 decode** gap (some WebKit/Firefox builds
ship no MP3 `AudioDecoder`). MP3 *encode* is out of scope — Symphonia is decode-only and libmp3lame is C —
so `createEncoder` raises a typed `CapabilityError` rather than faking one (ADR-017, directive 6).

---

## Status in this environment: BUILT (pure Rust → wasm, no C toolchain)

Symphonia's MP3 decoder is **pure Rust**, so it compiles to `wasm32-unknown-unknown` via `wasm-pack build
--target web` with no Emscripten/C sysroot — the same path the Vorbis/AAC siblings use. Confirmed here:
`rustc` 1.94 + `wasm-pack` 0.14 emitted `mp3_wasm_bg.wasm` (~144 KB) + `mp3_wasm.js` glue + `.d.ts`, which
are vendored as `mp3_wasm_bg.wasm` + `mp3-core.js`. The Node test decodes both real fixtures cleanly
(195 frames of `sound_5.mp3`, 385 of `bear-vbr-toc.mp3`), each frame yielding exactly its header-declared
sample count (576 for the MPEG-2 clip).

---

## Recipe — Rust + `wasm-bindgen` (the vendored path)

The crate is in `crate/` (`crate/src/lib.rs` + `crate/Cargo.toml`). To rebuild + re-vendor:

```sh
cd src/codecs/wasm-mp3/crate
wasm-pack build --target web --out-dir pkg --release
cp pkg/mp3_wasm_bg.wasm ../mp3_wasm_bg.wasm   # the URL the driver resolves (new URL('./mp3_wasm_bg.wasm', …))
cp pkg/mp3_wasm.js      ../mp3-core.js        # the specifier the driver imports (import('./mp3-core.js'))
```

`crate/Cargo.toml` pins `symphonia-core = "0.6"` + `symphonia-bundle-mp3 = "0.6"` (the MPEG-audio bundle —
MP1/2/3 are in `symphonia-bundle-mp3`, *not* a `symphonia-codec-mpa` crate) and disables the wasm-pack
`wasm-opt` post-pass (the homebrew `wasm-opt` here predates the bulk-memory ops LLVM emits and rejects the
valid module — same finding as the Vorbis sibling). `opt-level="s"` + LTO + `strip` keep the artifact lean.

> `crate/target` and `crate/pkg` are git-ignored (`crate/.gitignore`); only `crate/{Cargo.toml,Cargo.lock,
> src/lib.rs}` + the vendored `../mp3_wasm_bg.wasm` + `../mp3-core.js` are committed, matching the Vorbis/AAC
> siblings.

---

## The core contract (what the glue exposes)

`mp3.ts` defines the precise TypeScript surface; the generated `Mp3Wasm` class satisfies it. Summary:

| JS export | Symphonia call(s) | notes |
|---|---|---|
| `default(init)` | instantiate module, fetch `mp3_wasm_bg.wasm` | wasm-bindgen `--target web` init signature; also accepts a `WebAssembly.Module` (so it runs in Node) |
| `new Mp3Wasm(channels, sampleRate)` | `MpaDecoder::try_new(CODEC_ID_MP3)` | **no `extra_data`** — MP3 is self-describing; the hints seed `channels`/`sampleRate` |
| `decoder.decode(frame)` → interleaved `Float32Array` | `decode_ref` + `copy_to_vec_interleaved::<f32>` | one MP3 frame → one block (1152 / 576 samples × channels) |
| `decoder.channels` / `decoder.sampleRate` | from the decoded buffer spec | reconciled on each `decode` (the decoded spec wins) |
| `decoder.reset()` | `AudioDecoder::reset` | clears the bit reservoir at a seek |
| `decoder.free()` | drop | idempotent |

The driver owns all framing/timing: it copies each MP3 frame out of the `EncodedAudioChunk`, feeds frames
**in order** (MP3's bit reservoir is held inside the single decoder instance), advances PTS in
output-rate samples, and constructs/closes every `AudioData`. The wasm side is pure frame-in / samples-out.

---

## After vendoring — validation

1. **Node (already wired, `mp3.test.ts`):** instantiate the core from bytes and decode the real
   `sound_5.mp3` (CBR) + `bear-vbr-toc.mp3` (VBR/Xing-LAME); gate on MP3's un-fakeable invariant — every
   frame decodes to exactly its header sample count (1152 MPEG-1, 576 MPEG-2/2.5), the channel count/rate
   match, and the PCM is finite, in-range, non-silent. Cross-check total decoded samples against
   (frames walked × samplesPerFrame).
2. **Browser (Playwright, ADR-025):** with WebCodecs MP3 disabled / `force-software`, decode the same
   corpus to `AudioData` and compare against a WebCodecs MP3 reference where available (SNR / near-bit-exact
   after the LAME encoder-delay trim); assert each emitted `AudioData` is `close()`d exactly once and an
   abort mid-stream frees the decoder (no leak).
3. **Lazy budget:** a probe-only app pulls **zero** MP3 wasm; an MP3 decode on a WebCodecs miss pulls
   **only** this chunk, same-origin.
