# The `wasm-mp3-enc` core (vendored prebuilt LAME, self-hosted, miss-only)

This driver (`wasm-mp3-enc-driver.ts`) **encodes** MP3 via **LAME 3.100** (LGPL-2.0-or-later), compiled to
WebAssembly. No browser ships an `AudioEncoder` for MP3 — WebCodecs registers MP3 for decode only — so an
MP3 encode target is a guaranteed native miss everywhere, and this tail is the only route. It is
self-hosted (committed here and served same-origin — NOT a runtime CDN dependency) and loaded lazily,
miss-only, behind WebCodecs.

The pure format/validation logic (the MPEG output-rate and per-version bitrate tables, config
normalisation, the `enc_init` parameter block, planar handling, and the frame splitter) lives in
`mp3-enc.ts` and is Node-validated (`mp3-enc.test.ts`). The wasm core supplies **only** the lossy Layer-III
encode. Because the core runs in **Node**, the whole encode→decode chain is validated WITHOUT a browser
(see "Validation").

MP3 *decode* is a different tail — `src/codecs/wasm-mp3` (Symphonia). This one is encode-only and
`createDecoder` raises a typed `CapabilityError`.

---

## Vendored files (committed)

| file | role | source / license |
|---|---|---|
| `mp3_enc_wasm_bg.wasm` | the prebuilt LAME 3.100 core (132,999 B) | npm `wasm-media-encoders@0.7.0` `wasm/mp3.wasm` — **LGPL-2.0-or-later** |
| `mp3-enc-core.js` + `mp3-enc-core.d.ts` | hand-written loader/ABI glue → the {@link Mp3EncWasmCore} contract in `mp3-enc.ts` | this repo (MIT) |
| `LICENSE.lame` | LAME 3.100's verbatim `COPYING` (GNU **Library** GPL v2) | the LAME distribution |
| `LICENSE.wasm-media-encoders` | the MIT wrapper licence | the npm package |
| `THIRD_PARTY_NOTICES.mp3-enc.md`, `provenance.json` | provenance + sha256 inventory | this repo |

**Provenance.** npm `wasm-media-encoders@0.7.0`
(<https://registry.npmjs.org/wasm-media-encoders/-/wasm-media-encoders-0.7.0.tgz>, tarball sha256
`1ffcadae8dd439253148dfc5e73dd1a0be89b61ba342886707d8b39123f26adc`); wrapper **MIT** (arseneyr), the
compiled encoder is **LAME 3.100** (<https://lame.sourceforge.io/>, source tarball sha256
`ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`), **LGPL-2.0-or-later**. Vendored
artifact sha256:

- `mp3_enc_wasm_bg.wasm` `85e81719250b9a667b1258143f689dda70e3e57a7e7c29ab0b4cef65c8f6eb9a` (132,999 B)
- `LICENSE.wasm-media-encoders` `7f766c19bc26ca14d9dad1bf102211f12b0a5c139f66e1132a9867fcfa04bdf0`
- `LICENSE.lame` `bfe4a52dc4645385f356a8e83cc54216a293e3b6f1cb4f79f5fc0277abf937fd`

**LGPL note (load-bearing).** LAME is redistributed **unmodified**, byte for byte, as a standalone `.wasm`
module this package loads at runtime — the WebAssembly analogue of LAME's own "link to LAME as a separate
library" guidance. None of the npm package's JavaScript ships; `mp3-enc-core.js` is our own MIT loader. A
user can substitute their own LAME build by replacing the `.wasm`, or by handing `initMp3EncCore` a
`WebAssembly.Module`, raw bytes, or a URL — any core exporting the ABI below works.

**Shape note (load-bearing).** This is a **standard external-pair tail** — `mp3_enc_wasm_bg.wasm` +
`mp3-enc-core.js`, exactly like `wasm-mp3`/`wasm-aac`/`wasm-vorbis`/`wasm-av1` — so `scripts/vendor-wasm.ts`
co-vendors both halves into `dist/` and the driver resolves the core through
`new URL('./mp3_enc_wasm_bg.wasm', import.meta.url)`: same-origin, no COOP/COEP.

That URL shape was briefly replaced with an inlined base64 carrier on the theory that a bundler could
relocate the chunk away from its sibling asset. **Measurement disproved it**, so the separate file is back:
the reference resolves and fetches `200` under the Vite dev server on the **main thread** and inside a
`type:'module'` **Worker**, and a production **Rollup** build recognises the pattern, emits the core as a
hashed asset (`mp3_enc_wasm_bg-<hash>.wasm`) and rewrites the reference to it. Inlining cost ~47 KB of
base64 overhead, forfeited streaming compilation and cross-route caching, and made this the only Rust-core
tail with a different shape. The one real failure mode is a **missing** artifact — running `vendor-wasm`
before `build` (which wipes `dist/`) leaves the core un-vendored — and `check-budgets` now asserts that
every `new URL('./x.wasm', import.meta.url)` resolves to an emitted asset, so that mistake fails the gate
instead of the browser.

---

## The core's ABI

The `.wasm` is a freestanding **WASI reactor**, not an Emscripten bundle, so it ships no generated loader —
`mp3-enc-core.js` is the whole runtime seam. Anything replacing the core must match this surface.

**Imports** (the least-privilege set REQUIREMENTS §12 asks for — two functions, no filesystem, no clock):

| import | our binding |
|---|---|
| `env.emscripten_notify_memory_growth(index)` | no-op; every typed-array view is derived from the live `memory.buffer` at point of use |
| `wasi_snapshot_preview1.proc_exit(code)` | throws (a core that exits is a fault, never a silent stop) |

**Exports:**

| export | contract |
|---|---|
| `memory` | the core's linear memory |
| `_initialize()` | WASI reactor start; MUST be called once after instantiation, before anything else |
| `version() -> ptr` | NUL-terminated C string, `wasm-media-encoders-0.7.0` |
| `mime_type() -> ptr` | NUL-terminated C string, `audio/mpeg` — the check that the MP3 wasm (not the sibling Ogg one) loaded |
| `malloc(n) -> ptr` / `free(ptr)` | for the parameter block only |
| `enc_init(paramsPtr) -> ref` | `0` means LAME rejected the parameters |
| `enc_get_pcm(ref, n) -> ptr` | pointer to `channels` int32 pointers, each to an `n`-element f32 **planar** input buffer; may grow memory, so views must be taken after it returns |
| `enc_encode(ref, n) -> len` | bytes produced (`0` is normal — LAME buffers a frame at a time); `< 0` is an error |
| `enc_get_out_buf(ref) -> ptr` | the output run's bytes; valid only until the next call |
| `enc_flush(ref) -> len` | drains the bit reservoir; a second flush returns `0` |
| `enc_free(ref)` | releases one encoder; several `ref`s may live on one instance concurrently |

**`enc_init` parameter block — 20 bytes, little-endian** (built by `buildMp3EncoderParams`, golden-tested):

| offset | type | field |
|---|---|---|
| 0 | int32 | `channels` (1 or 2) |
| 4 | int32 | `sampleRate` (input PCM rate) |
| 8 | int32 | `cbrBitrateKbps` (`0` ⇒ use VBR) |
| 12 | **float32** | `vbrQuality` (0.0 best … 9.999 worst; `-1` ⇒ use the CBR value) |
| 16 | int32 | `outputSampleRate` (`0` ⇒ let LAME choose) |

### Measured legality (why `mp3-enc.ts` clamps before calling)

The core silently substitutes values it cannot honour, which would make the `AudioDecoderConfig` we publish
to the muxer a lie. Two behaviours were measured directly against this `.wasm` and are encoded in
`mp3-enc.ts`:

1. **`outputSampleRate = 0` lets LAME resample.** 56 kbps at 44100 Hz comes back as a **24000 Hz** stream.
   We therefore always pin `outputSampleRate` to the requested `sampleRate`.
2. **Out-of-table bitrates are clamped, not rejected.** With the rate pinned, the bitrates the core returns
   verbatim are:

   | output rate | MPEG | constant bitrates honoured (kbps) |
   |---|---|---|
   | 32000 / 44100 / 48000 | 1 | 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320 |
   | 16000 / 22050 / 24000 | 2 | 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160 |
   | 8000 / 11025 / 12000 | 2.5 | 8, 16, 24, 32, 40, 48, 56, 64 |

   Anything else is clamped to the nearest end (320 kbps at 22050 Hz becomes 160). `snapMp3BitrateKbps`
   snaps the caller's `bitrate` hint to the nearest legal value first, so header and config agree.

A sample rate outside the nine MPEG rates has no legal MP3 representation at all and is rejected as a typed
`MediaError` rather than resampled behind the caller's back.

---

## Re-vendoring (e.g. a version bump)

`npm` is disabled here — use `curl`:

```sh
V=0.7.0
curl -sL "https://registry.npmjs.org/wasm-media-encoders/-/wasm-media-encoders-${V}.tgz" -o /tmp/wme.tgz
shasum -a 256 /tmp/wme.tgz          # record in provenance.json
mkdir -p /tmp/wme && tar xzf /tmp/wme.tgz -C /tmp/wme
D=src/codecs/wasm-mp3-enc
cp /tmp/wme/package/wasm/mp3.wasm "$D/mp3_enc_wasm_bg.wasm"   # ONLY the wasm; no upstream JS is used
cp /tmp/wme/package/LICENSE       "$D/LICENSE.wasm-media-encoders"
shasum -a 256 "$D/mp3_enc_wasm_bg.wasm" "$D/LICENSE.wasm-media-encoders"   # update provenance.json + above
bunx vitest run src/codecs/wasm-mp3-enc                       # must stay green
```

The version assertion in `mp3-enc.test.ts` pins `version()`, so a bump fails loudly until provenance is
refreshed. If the ABI changes, re-reconcile `mp3-enc-core.js` + `mp3-enc-core.d.ts` against the table above.
`mp3_enc_wasm_bg.wasm` is a committed binary artifact and is Biome-ignored (`**/*_wasm_bg.wasm`); the
hand-written seam is `mp3-enc-core.js`, `mp3-enc.ts`, and `wasm-mp3-enc-driver.ts`. Always run
`bun run build` **before** `bun run vendor-wasm` — the build wipes `dist/`, so the reverse order leaves the
core un-vendored.

---

## Validation (Node — no browser needed)

`bunx vitest run src/codecs/wasm-mp3-enc` runs two layers:

- **pure** — the legality tables, config normalisation, the golden 20-byte parameter block, planar
  validation, timing, and the frame splitter (fuzzed across randomised run boundaries down to one byte at
  a time, plus resync and truncated-tail cases);
- **real encode + independent decode** — the vendored core encodes synthetic tones across a
  {8000, 16000, 22050, 32000, 44100, 48000} Hz × {mono, stereo} CBR matrix and the real WAV fixtures, then
  every emitted chunk is checked for a valid MPEG sync word and a header whose rate/layer/bitrate/channel
  mode match the request, the frame count is checked against the input duration and the byte count against
  the requested bitrate, and the bitstream is **decoded back by the independent `wasm-mp3` Symphonia core**
  (sample count, finiteness, non-silence). Reference numbers at 128 kbps CBR:
  `stereo-48000.wav` (48 kHz stereo, 48000 frames, 192,000 B as PCM-16) → 16,512 B in 43 frames, zero
  un-framed trailing bytes, decoding back to 49,536 samples (source + 1.33 frames of LAME lead-in) at
  48 kHz stereo.

Browser tests additionally validate the live `AudioData`/`EncodedAudioChunk` stream path (WebCodecs types
are absent in Node). Budget: a probe-only app pulls **zero** MP3-encode chunk; an MP3 encode on a WebCodecs
miss pulls only the lazy `wasm-mp3-enc-driver` + `mp3-enc-core` chunks and the `.wasm` itself.

**Measured in headed Chromium** against the `media-test` dev server (COOP `same-origin` + COEP
`require-corp`, so `crossOriginIsolated === true`): the core instantiates both on the main thread and
inside a `type:'module'` **Worker** (`mime_type()` → `audio/mpeg`, `version()` →
`wasm-media-encoders-0.7.0`). End to end through the public API,
`convert(…, { to:'mp4', audio:{ codec:'mp3', bitrate:192000 } })`: `wav_s16.wav` 960,044 B → 122,369 B MP4
in 103 ms, and `aac_adts.aac` 163,811 B → 243,589 B MP4 in 141 ms — both probing back as one `mp4a.6b`
audio track, 48 kHz stereo (5.04 s / 10.056 s).

The Worker result is the reason this tail is inlined. With the core as a sibling `mp3_enc_wasm_bg.wasm`
resolved through `new URL(..., import.meta.url)`, the same call returned `null` inside the harness's worker
context — surfacing as `[AIBRUSH_FRAMEWORK_CAPABILITY_MISS] wasm-mp3-enc core is not available` — even
though it succeeded when the built `dist/index.js` was imported directly on the page. Vite pre-bundling is
already ruled out (`optimizeDeps: { exclude: ['@aibrush/media'] }` in `media-test/vite.config.mjs`); the
asset URL itself is what does not survive. The separate-file tails (`wasm-aac`, `wasm-av1`, `wasm-mp3`
decode, `wasm-vorbis` decode) are all miss-only and have never actually loaded in that harness, so they sit
on the same untested path.

---

## Destination timing (how the gapless window is established)

MP3 is a lapped transform, so a decode of what this tail emits is **longer** than the program it was
handed: LAME primes its analysis window ahead of the first sample, the decoder's synthesis filterbank adds
its own latency, and the last MPEG frame is padded out to whole-frame geometry. Nothing trims that unless
the muxer is told to, so the driver publishes an `AudioEncoderOutputTiming` on flush and the engine turns
it into `TrackInfo.gapless` (`outputGaplessForAudioEncoder`) — an MP4 `elst`, or the Xing/LAME tag in a raw
`.mp3`.

Two of the three numbers are counted, not assumed: `submittedSamples` is what the transform stage was fed,
and `codedSamples` is the emitted frame count times the frame's PCM geometry. The third — the lead-in — has
no counter, so:

1. **It cannot be read out of the bitstream.** The vendored core writes **no Xing/LAME info frame**: its
   first byte run is an ordinary audio frame. A `lame` CLI stream carries one because the CLI rewinds and
   rewrites frame 0 after the encode; this core has no such seam and the ABI exposes no delay accessor.
   `mp3-enc.test.ts` asserts the absence across the whole CBR matrix, so a core that starts emitting one
   fails loudly rather than silently double-counting a frame.
2. **So it is measured, not quoted.** `MP3_ENCODER_LEAD_IN_SAMPLES` is fixed by encoding broadband noise,
   decoding it back with the independent `wasm-mp3` Symphonia core, and taking the lag that maximises the
   normalised cross-correlation against the input. The search runs to four frames — a wrong constant shows
   up as a different peak, not as a clamp.

The measured lag is **1105 samples** at 48/44.1/22.05/11.025 kHz, mono and stereo, CBR and VBR — i.e. it
does **not** follow the 1152 ↔ 576 frame geometry, because neither component is frame-sized: it is LAME's
`ENCDELAY` (576) plus the Layer III synthesis delay (`MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES`, 528+1). That
identity is asserted too, which is what lets the MP3 muxer recover LAME's own 576 for the tag's 12-bit
`encoder delay` field by removing the synthesis delay, exactly as the shipped Xing/LAME **parser** adds it
back. Terminal padding is then whatever the coded capacity has left over:
`trailing = coded − 1105 − submitted`, asserted non-negative and 12-bit-representable down to a one-sample
input.

Worked example (the harness's `wav_to_mp3_mp4`): 240,000 frames at 48 kHz → 210 MPEG-1 frames = 241,920
coded samples; `1105 + 240,000 + 815 = 241,920`, and the MP4 carries `elst` `media_time = 1105`,
`segment_duration = 5.000 s`.

---

## From-source alternative

A source build requires Emscripten (or any wasm32-wasi toolchain). Build LAME 3.100 static
(`emconfigure ./configure --disable-shared --disable-frontend --disable-decoder`), then link a small C shim
exporting the ABI above with `--no-entry -mexec-model=reactor`, then drop the result in as
`mp3_enc_wasm_bg.wasm`. Any replacement must satisfy the `Mp3EncWasmCore` contract and pass the Node
validation described above unchanged.
