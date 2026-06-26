# The `wasm-opus` core (vendored prebuilt libopus-wasm, self-hosted, miss-only)

This driver (`wasm-opus-driver.ts`) decodes/encodes Opus via **libopus** (xiph/opus, **BSD-3**), compiled
to WebAssembly. libopus is C and this build sandbox has no usable wasm C toolchain to build it from source
(see "Status" below), so per **ADR-085** (vendor a prebuilt **permissive** core) + **ADR-088** the core is a
committed prebuilt: **`libopus-wasm@0.2.0`** (npm; **MIT** wrapper + **BSD** libopus), self-hosted in this
directory (we commit it and serve it same-origin — NOT a runtime CDN dependency). It is loaded lazily,
miss-only, behind WebCodecs.

The pure framing/format/validation logic (TOC parsing, the RFC 6716 frame-size table, encoder re-chunking,
planar↔interleaved f32, config validation, OpusHead) lives in `opus.ts` and is Node-validated
(`opus.test.ts`). The wasm core supplies **only** the lossy CELT/SILK entropy coding. Because
`libopus-wasm` runs in **Node**, the whole encode+decode chain is validated WITHOUT a browser (see
"Validation").

---

## Vendored files (committed)

| file | role | source / license |
|---|---|---|
| `libopus-wasm.js` | the prebuilt wrapper (`createEncoder`/`createDecoder` → `encodeFloat`/`decodeFloat`) | npm `libopus-wasm@0.2.0` `dist/index.js` |
| `generated/libopus.generated.mjs` | the **inlined-wasm** Emscripten module (libopus) | npm `libopus-wasm@0.2.0` `dist/generated/…` |
| `opus-core.js` | hand-written glue adapting the above to the {@link OpusWasmCore} contract (`opus.ts`) | this repo |
| `LICENSE.libopus-wasm`, `THIRD_PARTY_NOTICES.libopus-wasm.md` | provenance | the package |

**Provenance** (also in `fixtures/manifest.json` → `wasmCores`): `libopus-wasm@0.2.0`, wrapper **MIT**
(openclaw), libopus **BSD-3** (Xiph.Org, <https://github.com/xiph/opus>); package URL
`https://registry.npmjs.org/libopus-wasm/-/libopus-wasm-0.2.0.tgz`. sha256:

- `libopus-wasm.js` `8dbe83b16b1e41dda9eba4469c3aec24058a8ad852d1e399c2aa602d0d2d6b61`
- `generated/libopus.generated.mjs` `7f254556d782ac20a304068d4ecf7a1b9e6e94df5694f550e6d14c217d7e2028`

**Shape note (load-bearing):** `libopus-wasm` INLINES its wasm into the `.mjs` — there is **no separate
`opus_wasm_bg.wasm`**. The glue's wasm-bindgen-style `init({module_or_path})` (the driver's loader signature)
is a no-op that ignores the URL and only pre-instantiates libopus; coder *creation* is async (the contract's
`createDecoder`/`createEncoder` return Promises, `await`ed in the driver's async `start`), the hot
`encode`/`decode` are sync. The inlined wasm is a normal JS import chain (`opus-core.js` → `libopus-wasm.js`
→ `generated/*.mjs`), so `tsup` bundles it into the lazy `opus-core.js` code-split chunk; there is **no `new
URL('./*.wasm')` asset to co-vendor**, so `scripts/vendor-wasm.ts` recognizes this as a **self-contained
inlined tail** (its `selfContained` branch) and SKIPs it — correctly, not as a "broken" half-pair (the
Rust/Symphonia tails still require BOTH `*_wasm_bg.wasm` + `*-core.js`).

---

## Re-vendoring (e.g. a version bump)

`npm` is disabled here — use `bun`/`curl`:

```sh
V=0.2.0
curl -sL "https://registry.npmjs.org/libopus-wasm/-/libopus-wasm-${V}.tgz" -o /tmp/libopus-wasm.tgz
mkdir -p /tmp/lw && tar xzf /tmp/libopus-wasm.tgz -C /tmp/lw
D=src/codecs/wasm-opus
cp /tmp/lw/package/dist/index.js                         "$D/libopus-wasm.js"
cp /tmp/lw/package/dist/generated/libopus.generated.mjs  "$D/generated/libopus.generated.mjs"
cp /tmp/lw/package/LICENSE                                "$D/LICENSE.libopus-wasm"
cp /tmp/lw/package/THIRD_PARTY_NOTICES.md                "$D/THIRD_PARTY_NOTICES.libopus-wasm.md"
shasum -a 256 "$D/libopus-wasm.js" "$D/generated/libopus.generated.mjs"   # update the sha256 above
bunx vitest run src/codecs/wasm-opus                                      # must stay green
```

`opus-core.js` (the hand-written glue) is committed and version-independent unless `libopus-wasm`'s API
changes; if it does, re-reconcile `opus-core.js` + `opus-core.d.ts` to the new surface.

---

## Validation (Node — no browser needed; `libopus-wasm` runs in Node)

`bunx vitest run src/codecs/wasm-opus` exercises `wasm-opus-encode.test.ts`:
- **encode**: PCM → our encoder → real Ogg-Opus (the engine `OggMuxer`, carrying our OpusHead) → an
  **independent `ffmpeg`** libopus decode → SNR vs source (real `sfx` 48 kHz ≈ 45 dB; a broken encode ≈ 1 dB);
- **multi-rate** {8,12,16,24,48} kHz decodability; **decode** (§3.C.10): our decode of real `sfx-opus.ogg` /
  `bear-opus.webm` vs `ffmpeg` (≫ 60 dB — both are libopus); an encode→decode round-trip.

Browser (Playwright, ADR-025) additionally validates the live `AudioData`/`EncodedChunk` stream path.
Throughput: `bun run scripts/bench-opus.ts`. Budget: a probe-only app pulls **zero** Opus chunk; an Opus
convert on a WebCodecs miss pulls **only** the lazy `opus-core.js` chunk (the inlined `.mjs` rides inside it).

---

## Status: why prebuilt (not from-source) in this sandbox

emsdk/emcc 6.0.1 IS present (`source ~/emsdk/emsdk_env.sh`), so a from-source libopus build via Emscripten
is *possible* in principle (recipe in `docs/notes/wasm-codec-cores.md` §1: `emconfigure ./configure
--disable-shared --disable-intrinsics` on `xiph/opus` v1.5.2, then a tiny C shim + `emcc -sMODULARIZE
-sEXPORT_ES6 --no-entry`). The **prebuilt** was chosen (ADR-088) because it is **proven** — a 50.3 dB Node
round-trip + the full ffmpeg oracle pass against it — whereas an unproven heavy from-source build starves
the active swarm and adds no validated capability. The from-source Emscripten path remains the documented
alternative for cleaner BSD-only provenance if wanted later; the `OpusWasmCore` contract + the Node oracle
are unchanged by such a swap.
