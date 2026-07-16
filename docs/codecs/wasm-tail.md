# WASM Codec Tail (S31)

> Target spec + honest delta for the seven self-hosted per-codec WebAssembly drivers that back the
> capability ladder's **last rung**. Owned code: `src/codecs/wasm-aac/*`, `wasm-av1/*`, `wasm-mp3/*`,
> `wasm-opus/*`, `wasm-vorbis/*`, `wasm-vorbis-enc/*`, `wasm-vpx/*`. Read-only siblings cited but never
> edited: each dir's `BUILD.md`, `provenance.json`, and `wasm-opus/THIRD_PARTY_NOTICES.libopus-wasm.md`.

## 1. Purpose & scope

This family is the **WASM tail**: a set of small, permissively-licensed, per-codec WebAssembly cores that
run *only when the browser's hardware/native WebCodecs path misses a codec*. It exists to close real
capability holes — Chrome/Safari ship no Vorbis `AudioDecoder`; some WebKit/Firefox builds lack MP3 or AAC;
Chromium-without-proprietary-codecs lacks AAC; some WebKit builds lack a VP9 `VideoDecoder`; and no browser
universally exposes an Opus/Vorbis `AudioEncoder`. Each core is a **separate lazy chunk**, never a monolith.

Seven drivers, all `tier:'wasm'` (`wasm-aac-driver.ts:345`, `wasm-av1-driver.ts:372`,
`wasm-mp3-driver.ts:342`, `wasm-opus-driver.ts:459`, `wasm-vorbis-driver.ts:341`,
`wasm-vorbis-enc-driver.ts:279`, `wasm-vpx-driver.ts:395`):

| Driver id | Codec(s) | Direction | Core | Source of truth |
|-----------|----------|-----------|------|-----------------|
| `wasm-aac` | AAC-LC mono/stereo | decode only | Symphonia `symphonia-codec-aac` (pure-Rust) | `wasm-aac/aac.ts:26-40`, `measured-evidence.md` ADR-039 |
| `wasm-mp3` | MP3 (L3) | decode only | Symphonia `symphonia-bundle-mp3` (pure-Rust) | `wasm-mp3-driver.ts:6-8`, `measured-evidence.md` ADR-105 |
| `wasm-vorbis` | Vorbis | decode only | Symphonia `symphonia-codec-vorbis` (pure-Rust) | `wasm-vorbis-driver.ts:6-11`, `measured-evidence.md` ADR-036 |
| `wasm-vorbis-enc` | Vorbis | encode only | libvorbis/libvorbisenc + libogg (Emscripten, BSD) | `wasm-vorbis-enc-driver.ts:1-4`, `measured-evidence.md` ADR-108 |
| `wasm-opus` | Opus | decode **and** encode | libopus `libopus-wasm` (prebuilt, BSD/MIT wrapper) | `wasm-opus/provenance.json`, `measured-evidence.md` ADR-088 |
| `wasm-av1` | AV1 8-bit 4:2:0 | decode only | dav1d via `dav1d.js` (prebuilt, BSD-3/CC0) | `wasm-av1/provenance.json`, `measured-evidence.md` ADR-093 |
| `wasm-vpx` | VP8, VP9 8-bit 4:2:0 | decode only | libvpx via ogv.js (prebuilt, BSD-3/MIT) | `wasm-vpx/provenance.json`, `measured-evidence.md` ADR-094 |

**Benchmark families served:** `transcode` (as the decode/encode leg when WebCodecs misses a codec, e.g.
`flac_to_opus_webm`, `mp3_to_opus_webm`, `vp9_to_av1`) and `decode` (miss-only, e.g. Vorbis decode which
no browser provides). Encoders in scope: **Opus** (`wasm-opus`) and **Vorbis** (`wasm-vorbis-enc`). AAC,
MP3, AV1, VP8/VP9 encode are all honest `CapabilityError` misses (see §3, §4). Out of scope for this shard:
the WebCodecs adapters themselves (S30), FLAC/image codecs (S32), container drivers (S23–S29), and the
capability router/registry that ranks these drivers (S01/S04) — this doc covers only what happens *inside*
a wasm codec driver once the router has selected it.

## 2. Spec & references

**Governing standards (each with its owned-code anchor):**

- **W3C WebCodecs** — the `EncodedAudioChunk`/`AudioData`/`EncodedVideoChunk`/`VideoFrame` seam every driver
  bridges, and the µs-timestamp convention. <https://www.w3.org/TR/webcodecs/>. Anchored at
  `wasm-opus-driver.ts:200`, `wasm-aac-driver.ts:73-75`.
- **WHATWG Streams** — `TransformStream` is the coder lifecycle and the backpressure mechanism.
  <https://streams.spec.whatwg.org/>. Anchored at `wasm-vorbis-driver.ts:253` (every `createDecoder`
  returns a `TransformStream`).
- **RFC 6716 — Definition of the Opus Audio Codec** (TOC byte, frame sizes, 48 kHz internal rate).
  <https://www.rfc-editor.org/rfc/rfc6716>. Implemented in `wasm-opus/opus.ts:36-147`.
- **RFC 7845 — Ogg Encapsulation for Opus** (OpusHead, pre-skip). <https://www.rfc-editor.org/rfc/rfc7845>.
  Implemented in `wasm-opus/opus.ts:478-515` (`buildOpusHead`).
- **RFC 6386 — VP8 Data Format and Decoding Guide** (frame tag §9.1). <https://www.rfc-editor.org/rfc/rfc6386>.
  Implemented in `wasm-vpx/vpx.ts:106-164`.
- **VP9 Bitstream & Decoding Process Specification v0.6** (uncompressed header §6.2, superframe index Annex B).
  <https://www.webmproject.org/vp9/> · PDF:
  <https://storage.googleapis.com/downloads.webmproject.org/docs/vp9/vp9-bitstream-specification-v0.6-20160331-draft.pdf>.
  Implemented in `wasm-vpx/vpx.ts:166-295`.
- **AV1 Bitstream & Decoding Process Specification** and **AV1 Codec ISO Media File Format Binding** (the
  `av01.P.LLT.DD…` codec string). <https://aomediacodec.github.io/av1-spec/> ·
  <https://aomediacodec.github.io/av1-isobmff/>. Codec-string parse in `wasm-av1/av1.ts:113-138`.
- **ISO/IEC 14496-3 — MPEG-4 Audio** (AudioSpecificConfig, AAC-LC = 1024 samples/frame, AOT table).
  <https://www.iso.org/standard/76383.html>. Implemented in `wasm-aac/aac.ts:26-40, 172-209`.
- **ISO/IEC 13818-7 — MPEG-2 AAC / ADTS** (7/9-byte ADTS header). <https://www.iso.org/standard/43345.html>.
  Implemented in `wasm-aac/aac.ts:60-125`.
- **Xiph Vorbis I specification** (identification/setup headers, laced extradata).
  <https://xiph.org/vorbis/doc/Vorbis_I_spec.html>. Implemented in `wasm-vorbis/vorbis.ts`.
- **RFC 6381 — The 'codecs' and 'profiles' Parameters** (all codec-string parsing).
  <https://www.rfc-editor.org/rfc/rfc6381>.

**Core provenance / OSS implementations vendored:** Symphonia <https://github.com/pdeljanov/Symphonia>;
dav1d <https://code.videolan.org/videolan/dav1d> (via `dav1d.js` npm, `wasm-av1/provenance.json`); libvpx
<https://chromium.googlesource.com/webm/libvpx> (via ogv.js <https://github.com/brion/ogv.js>,
`wasm-vpx/provenance.json`); libopus <https://github.com/xiph/opus> (via `libopus-wasm`,
`wasm-opus/provenance.json`); libvorbis/libogg <https://github.com/xiph/vorbis> +
<https://github.com/xiph/ogg> (`wasm-vorbis-enc/BUILD.md`).

**OSS exemplar to study & beat — ffmpeg.wasm** <https://github.com/ffmpegwasm/ffmpeg.wasm> (`@ffmpeg/core`).
ffmpeg.wasm is the reference "everything in WASM" engine: a **single monolithic multi-MB Emscripten build**
of the whole FFmpeg tree, driven by CLI-string `exec()` over a virtual MEMFS (`writeFile`/`readFile`),
running in one Worker; its multi-thread build (`-mt`) requires **COOP/COEP** cross-origin isolation. It wins
the long tail of exotic codecs precisely because it ships *all* of them at once. The SOTA design here
deliberately inverts that: **per-codec, permissively-licensed, lazy, miss-only WASM with no COOP/COEP on the
common path** (`measured-evidence.md`: "Of ffmpeg.wasm's 139 WASM-tier wins, ~112 are container/demux/remux/probe/…
a WebCodecs+TS engine reclaims natively; only ~15–20 features truly need native code"; and the ladder note
"small permissive per-codec modules (never monolithic ffmpeg), self-hosted via import.meta.url"). Where we
match ffmpeg.wasm: correct decode of each codec on real fixtures (Node-validated against ffmpeg,
`measured-evidence.md` line 689). Where we must beat it: **bytes shipped** (a probe-only or hardware-hit app pulls
zero WASM) and **no isolation requirement**. Where ffmpeg.wasm still wins (and we honestly decline):
threaded SW *video encode*, AV1/x264 SW encode, and the exotic-codec long tail (`measured-evidence.md` line 515).

## 3. Target design

### 3.1 Data model & the one seam

Every driver is a pure **codec adapter** across the WebCodecs seam and nothing else. It owns exactly one
transformation and never touches containers, sources, sinks, or the router:

- **Decode:** `TransformStream<EncodedChunk, RawFrame>` = `EncodedAudioChunk|EncodedVideoChunk` →
  `AudioData|VideoFrame`.
- **Encode:** `TransformStream<RawFrame, EncodedChunk>` = `AudioData` → `EncodedAudioChunk`.

The stream **is** the lifecycle (the pattern is identical across all seven, e.g.
`wasm-opus-driver.ts:310-345`): `start()` loads the core + arms the abort listener; `transform()` decodes
one unit synchronously; `flush()` drains and tears down; teardown `free()`s the native decoder and closes
any still-owned frames.

Below the seam sits a **narrow, synchronous wasm-core contract** defined in the pure `*.ts` helper file,
e.g. `OpusWasmCore`/`OpusWasmDecoder`/`OpusWasmEncoder` (`wasm-opus/opus.ts:435-476`), `VpxWasmCore`
(`wasm-vpx/vpx.ts:547-567`), `Dav1dWasmCore` (`wasm-av1/av1.ts:257-280`), `AacWasmCore`
(`wasm-aac/aac.ts:327-346`). This split is the key seam: **all bit-exact integer/spec logic** (ADTS/ASC
parsing, Opus TOC, VP8/VP9 header + superframe index, plane-layout arithmetic, config normalization,
planar↔interleaved conversion, OpusHead/Vorbis-extradata construction) lives in the `*.ts` file and is
**Node-validated without a browser or the wasm binary**; only the lossy entropy/transform decode crosses
into the `.wasm`. This is why the drivers can be typechecked and unit-tested before an artifact is vendored.

### 3.2 Capability routing (WebCodecs → GPU → WASM, miss-only)

The developer never names a backend. Routing is entirely the router's job (S01); the tail participates in
exactly three honest ways:

1. **`tier:'wasm'`** on every driver ranks it **last**, behind hardware/native WebCodecs and any GPU rung
   (`wasm-vpx-driver.ts:395`). The router only *probes* these drivers after WebCodecs has already missed.
2. **`supports()` never throws and never fabricates** (`wasm-opus-driver.ts:183-204`): it returns
   `{supported:false, reason}` for the wrong codec, the wrong direction, an out-of-envelope config (e.g.
   AV1 10-bit, VP9 4:4:4, HE-AAC), a missing WebCodecs seam, or a **core that fails to load**. Only a
   genuine, in-envelope, loadable match returns `{supported:true, hardwareAccelerated:false}`.
3. **A true miss is a typed `CapabilityError`** with `{op, tried, suggestion}` (`wasm-aac-driver.ts:140-146`),
   never a silent wrong answer and never a fake frame (directive 6 / ADR-017).

**Lazy, self-hosted, miss-only loading** is the load-bearing invariant. Two-stage:

- **Glue probe** (cheap, `supports()`): `import('./x-core.js')` code-splits the JS glue into its own chunk
  and answers "is the core vendored?" — e.g. `hasOpusCoreGlue()` (`wasm-opus-driver.ts:118-124`),
  `probeAv1Core()` (`wasm-av1-driver.ts:75-85`).
- **Core instantiate** (heavy, `createDecoder`/`createEncoder` only): `loadXCore()` calls the glue's
  `default(...)` init, which fetches the sibling `*_bg.wasm` addressed by
  `resolveWasmAssetUrl('./x_bg.wasm', new URL('./x_bg.wasm', import.meta.url), assetBaseUrl)`
  (`wasm-opus-driver.ts:132-159`). Same-origin (`import.meta.url`, no CDN — ADR-005/237), no COOP/COEP on
  the baseline profile (`wasm-loader-runtime.ts:41-52`). The result is memoized per
  `profile.kind|moduleUrl.href` so one instantiation serves a whole session (`wasm-mp3-driver.ts:105-124`).

### 3.3 Edge cases

- **B-frames / decode reorder.** *Applies to AV1 only.* dav1d may emit displayed frames out of coded order,
  so the AV1 driver keeps a **presentation-ordered timestamp queue**: each input chunk's PTS is pushed into
  a sorted queue (`pushDisplayTimestamp`, `wasm-av1/av1.ts:151-154`) and each displayed frame is paired with
  the lowest queued PTS (`shiftDisplayTimestamp`, `av1.ts:157-159`; drained in `enqueueDecodedFrames`,
  `wasm-av1-driver.ts:246-265`). VP8/VP9 have **no presentation reorder** — hidden alt-ref frames produce
  zero displayed output and are handled inside libvpx, so the VPX driver uses the chunk's own timestamp
  directly (`wasm-vpx-driver.ts:343-369`). Opus/AAC/MP3/Vorbis have no inter-packet reorder at all.
- **VFR (variable frame rate).** Handled by carrying real per-chunk `timestamp`/`duration` through to each
  emitted `VideoFrame` rather than assuming a fixed cadence: the video tails read `chunk.timestamp` and
  `chunk.duration` (`wasm-vpx-driver.ts:352-360`, `wasm-av1-driver.ts:332-335`). **Target rule:** a `null`
  chunk duration must be preserved as "no duration" on the `VideoFrame` (never invented) so the muxer
  re-derives spacing from the next chunk — the VPX `duration===null` branch does this
  (`wasm-vpx-driver.ts:255`). Audio tails today synthesize a *contiguous* clock from a sample counter
  (§4, delta D4) — the target is that they honor the first chunk's PTS so VFR gaps and non-zero start
  offsets survive.
- **Seek.** Seek is realized as a **fresh `TransformStream` per seek segment**; the pipeline (S10) builds a
  new decoder starting at a keyframe. Every core interface therefore also exposes `reset()`
  (`wasm-mp3/mp3.ts` `Mp3WasmDecoder.reset`, `wasm-vorbis/vorbis.ts` `VorbisWasmDecoder.reset`,
  `aac-core.d.ts` `AacWasm.reset`) to clear the **bit reservoir / overlap-add / decoder history** at an
  in-stream discontinuity without a full teardown. **Target rule:** in-stream seek that reuses a decoder
  calls `reset()` at the discontinuity; today no driver calls it (§4, delta D5).
- **Cancel.** Each driver arms an `AbortSignal` listener in `start()` that runs `teardown()` and errors the
  controller (`wasm-vorbis-driver.ts:266-270`); `start()` also fast-fails if the signal is already aborted
  (`wasm-opus-driver.ts:294`). **Target rule:** teardown must also fire on a bare stream cancel that does
  *not* abort the signal — the transformer needs a `cancel(reason)` method (§4, delta D6) so `free()` and
  frame `close()` are guaranteed even when only the readable is cancelled.
- **Frame lifetime (`close()` exactly once).** The contract:
  - *Decoder output* frames (`AudioData`/`VideoFrame`) are enqueued to the readable and **owned by the
    consumer**; the driver never closes an emitted frame (`wasm-mp3-driver.ts:294`).
  - *Encoder input* `AudioData` is closed by the driver in a `finally` right after its planes are copied, so
    it is released even if encode throws or aborts mid-`transform` (`wasm-opus-driver.ts:418-428`,
    `wasm-vorbis-enc-driver.ts:245-259`).
  - *Video decoder frames constructed-but-not-yet-enqueued* are held in a `pendingFrames` set and closed on
    teardown/error so they can't leak on an abort race (`wasm-av1-driver.ts:281-292`,
    `wasm-vpx-driver.ts:288-297`). The AV1 driver additionally closes a frame whose `enqueue` throws
    (`wasm-av1-driver.ts:259-263`) — the VPX driver does **not** (a leak, §4 delta D3).
- **Backpressure.** All decode `transform`s are **synchronous** (the wasm decode call returns immediately),
  so backpressure is entirely `TransformStream`-native: when the readable queue is full the stream stops
  pulling and `transform` is not invoked. There is no queue to poll — unlike the WebCodecs adapters, which
  must pace `decodeQueueSize`/`dequeue` (`measured-evidence.md` line 513). The Opus/Vorbis encoders enqueue multiple
  packets per `transform` via a drain loop (`wasm-opus-driver.ts:379-394`); that is bounded by the
  `FrameAccumulator` (one packet per buffered frame) and buffered by the stream's queue, so it stays correct
  under backpressure without manual gating.

## 4. Current state

All seven cores are **vendored and real today** (the older doc-comments calling AV1/VPX "scaffolds" are
stale — see D8). Files on disk confirm: `wasm-av1/dav1d_wasm_bg.wasm` (376 KB) + `dav1d-core.js`,
`wasm-vpx/vpx-vp8-data-wasm.js` + `vpx-vp9-data-wasm.js` + `vpx-core.js`, `wasm-aac/aac_wasm_bg.wasm`,
`wasm-mp3/mp3_wasm_bg.wasm`, `wasm-vorbis/vorbis_wasm_bg.wasm`, `wasm-opus/opus-core.js` + generated libopus,
`wasm-vorbis-enc/vorbis-enc-wasm.js`. All seven are registered as **lazy codec proxies** in
`src/drivers/defaults.ts:1186-1248`, each `tier:'wasm'` with a cheap `matches` pre-filter.

**Envelopes enforced (honest declines):**
- `wasm-aac`: AAC-LC mono/stereo only; explicit HE-AAC/SBR (`mp4a.40.5`) and PS (`.29`) declined up front
  because Symphonia rejects them at construction (`wasm-aac/aac.ts:32-40, 262-292`; `measured-evidence.md` ADR-039).
- `wasm-av1`: 8-bit, 4:2:0, non-monochrome only (`wasm-av1-driver.ts:186-199`); 10-bit decodes to zero
  frames on this dav1d.js build so it is declined (`wasm-av1/provenance.json`; `measured-evidence.md` ADR-093).
- `wasm-vpx`: 8-bit 4:2:0 only (`wasm-vpx-driver.ts:190-202`; `measured-evidence.md` ADR-094).
- `wasm-opus`: mono/stereo, decode rates ∈ {8,12,16,24,48} kHz (`wasm-opus/opus.ts:23,357-373`).
- `wasm-vorbis`/`-enc`: 1–8 channels (`wasm-vorbis-enc/vorbis-enc.ts:76-81`).

**Layering smells / debts I see in the owned code:**

- **~7× duplicated driver boilerplate (the dominant smell).** `buildAudioData`, `samplesToMicros`,
  `chunkBytes`, `asAudioChunk`, `unsupported`, `errMessage`, `hasWebCodecsAudioSeam`, and the entire
  `corePromises`/`coreGluePromise`/`loadXCore`/`teardown` skeleton are copy-pasted across `wasm-aac`,
  `wasm-mp3`, `wasm-vorbis`, `wasm-opus` (e.g. `buildAudioData` is byte-identical at
  `wasm-aac-driver.ts:200-218`, `wasm-mp3-driver.ts:196-214`, `wasm-vorbis-driver.ts:197-215`,
  `wasm-opus-driver.ts:255-273`). There is no shared `wasm-audio-decode-stream` / `wasm-codec-loader`
  helper. This is the layering violation that makes the next two bugs *diverge* between drivers.
- **Module-global mutable cache.** Every driver holds module-level `const corePromises = new Map(...)` +
  `let coreGluePromise` (`wasm-opus-driver.ts:115-116`), reset only by a test-only
  `resetXCoreForTest()` (`wasm-opus-driver.ts:162-165`). It is process-global, shared across every
  `createMedia()` instance, and mutated on first load. Keying on `profile.kind|moduleUrl.href` makes this
  acceptable for the decode tails — **except `wasm-vorbis-enc`, which keys on `profile.kind` alone**
  (`wasm-vorbis-enc-driver.ts:73`), so a second engine with a different `assetBaseUrl` would collide.
- **`wasm-vorbis-enc` is the odd one out of the loader contract.** It does **not** import
  `resolveWasmAssetUrl`/`wasmInitForProfile`, does not accept an `assetBaseUrl`, and calls `mod.default()`
  with **no init URL** (`wasm-vorbis-enc-driver.ts:69-87`); `createEncoder` calls
  `loadVorbisEncCore(o?.wasmRuntime)` with no base URL (`wasm-vorbis-enc-driver.ts:225`). Consequence: this
  tail cannot be relocated via `assetBaseUrl` (breaks the ADR-237 same-origin-base-url story). It "works"
  only because the core is a single-file base64 Emscripten build with the wasm embedded.
- **`wasm-vpx` resolves a `./vpx.wasm` asset that does not exist.** `loadVpxCore` computes
  `resolveWasmAssetUrl('./vpx.wasm', new URL('./vpx.wasm', import.meta.url), assetBaseUrl)` and passes it to
  `wasmInitForProfile` (`wasm-vpx-driver.ts:113-125`), but there is **no `vpx.wasm` file** — the ogv.js core
  is base64-embedded in `vpx-vp8-data-wasm.js`/`vpx-vp9-data-wasm.js` (`wasm-vpx/provenance.json`:
  "no separate *.wasm asset"). The glue ignores `module_or_path`. So the URL (and any `assetBaseUrl`
  override) is vestigial and the driver/`vpx-core.d.ts` doc-comments ("fetching the sibling `vpx.wasm`") are
  misleading.
- **`wasm-vpx` probe pulls the heavy embedded wasm.** `vpx-core.js` **statically** imports the base64 blobs
  (`import { wasmBytes as vp8Wasm } from './vpx-vp8-data-wasm.js'` — `vpx-core.js:25-26`), which are 147 KB
  (VP8) + 307 KB (VP9). So `hasVpxCoreGlue()` (`import('./vpx-core.js')`, `wasm-vpx-driver.ts:93-98`) — run
  during `supports()` — downloads ~450 KB just to answer "is the core present?". This defeats the
  "glue probe is cheap, wasm stays lazy" contract that AAC/MP3/Vorbis/Opus/AV1 uphold (their `_bg.wasm` is
  fetched only by `default()` in `loadXCore`).
- **Geometry getters read every packet in MP3/Vorbis (latent heap-corruption per ADR-039).** `measured-evidence.md`
  ADR-039: "the wasm-bindgen geometry getters must be read once and cached (re-reading interleaved with
  decode corrupts the glue's heap-object table on Node)." `wasm-aac` obeys this — it caches
  `decChannels`/`decSampleRate` once in `start()` (`wasm-aac-driver.ts:247-251, 269-270`) with an explicit
  comment. But `wasm-mp3` reads `dec.channels`/`dec.sampleRate` on **every** `transform`
  (`wasm-mp3-driver.ts:283, 290-291`) and `wasm-vorbis` does the same (`wasm-vorbis-driver.ts:283, 290-291`)
  — the exact pattern the ADR warns corrupts the Symphonia wasm-bindgen heap-object table.
- **`VideoFrame` leak on enqueue error in VPX.** `enqueueFrames` does `pending.add(frame)` then
  `try { enqueue } finally { pending.delete }` (`wasm-vpx-driver.ts:362-367`) — if `enqueue` throws, the
  frame is removed from `pending` (so teardown won't close it) and **never closed**. AV1 handles the same
  race correctly (`wasm-av1-driver.ts:259-263`: delete, `frame.close()`, rethrow).
- **Audio decoder output ignores input chunk PTS.** AAC/MP3/Opus/Vorbis synthesize the output timestamp from
  a running `emittedSamples` counter that starts at 0 (`wasm-mp3-driver.ts:244, 291-293`;
  `wasm-opus-driver.ts:301, 336-338`), discarding `chunk.timestamp`. After a seek/trim (first chunk at a
  non-zero PTS) or across a VFR gap the output timeline is wrong; the video tails, by contrast, carry the
  chunk timestamp. Inconsistent and a real correctness hazard for the `decode-seek`/`trim` families.
- **Stale doc-comments.** `wasm-av1-driver.ts:6-10` still says "an honest scaffold until `dav1d-core.js` +
  `dav1d_wasm_bg.wasm` are vendored"; both are vendored. `wasm-vpx-driver.ts:16-18` and `vpx-core.d.ts`
  describe a `new URL('./vpx.wasm', import.meta.url)` fetch that does not happen.
- **`decodeMany` dead surface.** `AacWasmCore`/`AacWasm` expose `decodeMany(packets, offsets)`
  (`wasm-aac/aac.ts:341`, `aac-core.d.ts`) but no driver calls it — dead contract surface.

No true "god-file" exists in this shard (largest owned files: `wasm-vpx/vpx.ts` 568 lines, `wasm-opus/opus.ts`
516 lines, both cohesive). The real structural problem is the **absence** of a shared module the seven
drivers should factor into — the opposite of a god-file.

## 5. Delta / punch-list

Ordered by risk-to-correctness, then by leverage. Each item names the change, the `path:line`, and a
falsifiable acceptance test.

**D1 — Cache decoder geometry once in `wasm-mp3` and `wasm-vorbis` (heap-corruption bug).**
Read `dec.channels`/`dec.sampleRate` **once** in `start()` after `createDecoder(...)`, cache them in locals
(mirror `wasm-aac-driver.ts:247-251, 269-270`), and use the cached values in every `transform`
(`wasm-mp3-driver.ts:283, 290-291`; `wasm-vorbis-driver.ts:283, 290-291`).
*Acceptance:* a Node oracle decodes a ≥500-frame MP3 and Vorbis fixture through the driver and asserts the
concatenated PCM is bit-exact to the golden ffmpeg decode (`measured-evidence.md` line 689 method); a regression test
asserts the geometry getters are invoked exactly once per stream (spy/counter), not once per packet.

**D2 — Make the `wasm-vpx` glue probe cheap (don't ship 450 KB to answer `supports()`).**
Split `vpx-core.js` so `hasVpxCoreGlue()` no longer transitively imports `vpx-vp8-data-wasm.js`/
`vpx-vp9-data-wasm.js` (`vpx-core.js:25-26`) — move the base64 blobs behind a dynamic `import()` reached only
from `createDecoder`'s `loadVpxCore` (`wasm-vpx-driver.ts:93-98, 108-135`).
*Acceptance:* a bundle/network test loads the driver, calls `supports()` for a VP9 query, and asserts the
`vpx-*-data-wasm` chunk was **not** fetched; then calls `createDecoder` and asserts it **is** fetched
(mirror the existing bundle-analysis test in `measured-evidence.md` line 81).

**D3 — Close the enqueue-error `VideoFrame` leak in `wasm-vpx`.**
In `enqueueFrames` (`wasm-vpx-driver.ts:362-367`) replace the `try/finally` with the AV1 pattern: on a
successful `enqueue`, delete from `pending`; on throw, delete from `pending`, call `frame.close()`, and
rethrow (mirror `wasm-av1-driver.ts:256-264`).
*Acceptance:* a unit test injects a controller whose `enqueue` throws on the 2nd frame of a superframe and
asserts every constructed `VideoFrame`'s `close()` was called exactly once (spy), with none left in
`pending` and none leaked.

**D4 — Honor input chunk PTS in the audio decode tails (seek/VFR correctness).**
Seed `emittedSamples`/the output timestamp from the **first** decoded chunk's `chunk.timestamp` (converted to
samples) instead of a hard 0, in AAC/MP3/Opus/Vorbis (`wasm-mp3-driver.ts:244, 291-293`;
`wasm-opus-driver.ts:301, 336-338`; and the AAC/Vorbis equivalents). Keep the contiguous sample counter for
subsequent packets.
*Acceptance:* decode a fixture starting at a non-zero container PTS (e.g. a mid-stream trim segment) and
assert the first emitted `AudioData.timestamp` equals the source chunk's timestamp (±0 µs), not 0; regression
proves a from-0 decode is unchanged.

**D5 — Wire `reset()` for in-stream seek, or delete it from the contract.**
Either (a) have the pipeline-driven in-stream seek call `decoder.reset()` at a discontinuity (MP3 bit
reservoir, Vorbis/AAC overlap history) — interface already present (`wasm-mp3/mp3.ts` `reset`,
`wasm-vorbis/vorbis.ts` `reset`, `aac-core.d.ts` `reset`) — or (b) remove `reset()` and document
"seek = fresh stream" as the only supported model.
*Acceptance:* if (a), a test seeds a decoder, seeks (calls the discontinuity path), and asserts the
post-reset first-frame PCM matches a fresh-decoder decode of the same keyframe; if (b), the interface no
longer declares `reset()` and a comment states the fresh-stream contract.

**D6 — Add a transformer `cancel(reason)` to every coder so teardown runs on bare stream cancel.**
Add `cancel()` alongside `start`/`transform`/`flush` in each `TransformStream` initializer (e.g.
`wasm-opus-driver.ts:396-448`) that runs the existing `teardown()` (frees the native decoder/encoder, closes
`pendingFrames`).
*Acceptance:* build a decoder, pump one chunk, then `reader.cancel()` **without** aborting the signal; assert
the native `free()` was called once and every pending `VideoFrame`/`AudioData` `close()`d — today `free()`
is skipped because only the signal path calls teardown.

**D7 — Fix `wasm-vorbis-enc` loader to match the tail contract.**
Give `loadVorbisEncCore` a `assetBaseUrl` parameter, resolve the core URL through `resolveWasmAssetUrl` +
`wasmInitForProfile`, key `corePromises` on `profile.kind|moduleUrl.href` (not `profile.kind` alone,
`wasm-vorbis-enc-driver.ts:73`), and pass `o?.wasmAssetBaseUrl` from `createEncoder`
(`wasm-vorbis-enc-driver.ts:225`). If the core is genuinely self-contained base64 with no fetchable asset,
delete the misleading URL machinery instead and document it.
*Acceptance:* two engines constructed with different `assetBaseUrl` values each load their own core (no cache
collision); a same-origin-base-url test proves the encoder honors `assetBaseUrl` or a comment documents why
it cannot.

**D8 — Remove the vestigial `./vpx.wasm` URL and update stale doc-comments.**
Delete the `resolveWasmAssetUrl('./vpx.wasm', …)` machinery in `loadVpxCore` (`wasm-vpx-driver.ts:113-125`)
or replace it with the real embedded-core load path; correct `vpx-core.d.ts` and the driver header comment
(`wasm-vpx-driver.ts:16-18`) to say "base64-embedded, self-contained". Refresh the `wasm-av1` header
(`wasm-av1-driver.ts:6-10`) to drop "scaffold until vendored" now that dav1d is vendored.
*Acceptance:* `grep vpx.wasm src/codecs/wasm-vpx` returns nothing; a doc-lint/test asserts no owned
doc-comment references a non-existent asset; AV1 header no longer says "scaffold".

**D9 — Extract the shared audio-decode / core-loader helper (kill the 7× duplication).**
Factor `buildAudioData`, `samplesToMicros`, `chunkBytes`, `asAudioChunk`, `deinterleaveF32` glue,
`hasWebCodecsAudioSeam`, and the `corePromises`/`coreGluePromise`/`loadXCore`/`teardown` skeleton into one
`src/codecs/wasm-shared/` module the four audio decoders and the two encoders consume. This is the change
that prevents D1/D3 from ever diverging again.
*Acceptance:* the four audio decode drivers import one shared `buildAudioData`/loader; a test asserts the
per-driver files no longer redefine these symbols (AST/grep), and the full decode conformance matrix stays
green (bit-exact goldens for AAC/MP3/Vorbis/Opus).

**D10 — Delete the dead `decodeMany` contract surface (or use it).**
Remove `decodeMany` from `AacWasmCore`/`AacWasm` (`wasm-aac/aac.ts:341`, `aac-core.d.ts`) unless a batched
decode path is wired to it. *Acceptance:* `grep decodeMany src/codecs` shows only a definition that is
actually called, or none.

## 6. Open questions

Each seeds a decision record in `docs/decisions/`.

- **OQ-1 (→ D4/D5): what is the canonical audio-decode timestamp model?** Should the wasm audio tails
  synthesize a contiguous clock from a sample counter, or always honor the input chunk PTS? This interacts
  with gapless (OpusHead pre-skip, `measured-evidence.md` ADR-293), trim preroll (S16), and VFR gaps. Decide one model
  for **all** decode tails and make the video/audio tails consistent.
- **OQ-2 (→ D6): what is the authoritative teardown trigger — the `AbortSignal` or the stream's own
  `cancel`?** Confirm whether the executor (S02) *always* aborts `o.signal` on any stream cancel. If yes,
  D6 is defense-in-depth; if no, D6 is a correctness fix. Log the executor's cancel↔signal contract.
- **OQ-3 (→ D7/D8): unify the wasm loader across all seven cores, or bless two shapes?** Today there are
  effectively two loading models — wasm-bindgen `--target web` with a fetched sibling `_bg.wasm`
  (AAC/MP3/Vorbis/Opus/AV1) and base64-embedded single-file Emscripten (VPX/Vorbis-enc). Decide whether the
  self-contained cores must still route through `resolveWasmAssetUrl` for a uniform `assetBaseUrl` story, or
  whether "embedded core ⇒ no relocatable asset" is an accepted, documented exception.
- **OQ-4: does the ADR-039 geometry-getter heap-corruption apply to MP3/Vorbis Symphonia cores, or only
  AAC?** D1 caches defensively regardless, but confirm empirically (Node) whether repeated getter reads
  corrupt the MP3/Vorbis wasm-bindgen heap-object table as they do for AAC, and record the finding so future
  cores follow the rule.
- **OQ-5: is `wasm-vorbis-enc`'s 1–8 channel envelope (`vorbis-enc.ts:76-81`) actually validated?** The
  decode tails cap at mono/stereo (Opus/AAC) or match Symphonia; the Vorbis encoder advertises up to 8
  channels. Confirm the libvorbis core + the `interleaveF32` path are validated for >2 channels, or narrow
  the envelope to what has a golden.
- **OQ-6: which of the honest encode misses (AAC, MP3, AV1, VP8/VP9) will ever gain a tail, and under what
  license gate?** MP3 encode is blocked only by LGPL LAME/Shine (`measured-evidence.md` ADR-105/313); AV1/VP8/VP9 SW
  encode is a performance/scope decline (`measured-evidence.md` ADR-225). Record the per-codec decision (permanent
  N/A vs. future opt-in tail) so the router's "no unshipped encoder is named" invariant stays truthful.
