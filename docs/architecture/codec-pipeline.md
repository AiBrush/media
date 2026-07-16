# Codec Pipeline (S13) — the transcode spine

> Target spec + honest delta. This document describes the **best** design for the codec-tier
> pipeline and then measures today's `src/api/codec-pipeline.ts` + `src/api/codec-routing.ts`
> against it. It is the contract a later code-cleanup task implements against, not a description
> of the current code.

## 1. Purpose & scope

The codec pipeline is the **pure translation layer** that turns a public request
(`ConvertOptions` / `EncodeOptions` — a `VideoTarget`/`AudioTarget` plus a demuxed source
`TrackInfo`) into the concrete artifacts the frozen codec drivers and muxers consume:

- a **WebCodecs codec string** (`avc1.PPCCLL`, `vp09.PP.LL.DD`, `av01.P.LLT.DD`, `hev1.…`,
  `mp4a.40.2`, `opus`, …) sized to the actual output geometry;
- a **`VideoEncoderConfig` / `AudioEncoderConfig`** with resolved dimensions, rate control,
  latency mode, and (VPx) alpha;
- a **`CodecQuery`** the capability router ranks across tiers;
- a **mux `TrackInfo`** built from the encoder's *published* decoder config;
- and the **live stream-composition primitives** that pair, drain, seek, and cancel encoded
  streams while closing every `VideoFrame`/`AudioData` exactly once.

It is the shared brain of the **transcode** benchmark family (video S11, audio+convert S12) and
is reached by every operation that re-encodes or re-containers coded media: `convert`, `encode`,
accurate `trim`, two-pass, and the VPx-alpha transcode fast paths. It owns codec-string
derivation and config selection; it does **not** own tier ranking (that is the capability router,
S01), container byte-layout (the muxers, S14/S23–S29), or pixel filters (S18).

`codec-routing.ts` is the sibling: a handful of **eager-kernel-safe** predicates
(`containerHasChunkMuxer`, `chooseOutputContainer`, `isPcmContainer`) that the engine kernel
needs before it decides whether an operation even reaches the (lazily imported) heavy pipeline
(`codec-routing.ts:1`).

## 2. Spec & references

Governing standards (every external reference linked):

- **W3C WebCodecs** — `VideoEncoder`/`AudioEncoder`/`VideoDecoder`/`AudioDecoder`,
  `*Config`, and `isConfigSupported()` (the capability-probe contract this pipeline synthesizes
  configs for): <https://www.w3.org/TR/webcodecs/>. The spec guarantees `VideoDecoder` emits
  frames in **presentation order** (the UA performs B-frame reorder), which is why this layer
  keeps no reorder buffer — see §3.
- **W3C WebCodecs Codec Registry** — the exact codec-string grammar for `avc1`/`hev1`/`vp08`/
  `vp09`/`av01`/`opus`/`mp4a`: <https://www.w3.org/TR/webcodecs-codec-registry/>.
- **RFC 6381** — the `codecs` MIME parameter (`avc1.PPCCLL` = profile/constraint/level bytes):
  <https://datatracker.ietf.org/doc/html/rfc6381>.
- **ITU-T H.264 (Rec. H.264) Annex A, Table A-1** — the `level_idc` / `MaxFS` / `MaxMBPS` table
  the H.264 level selector is transcribed from (`codec-pipeline.ts:234`):
  <https://www.itu.int/rec/T-REC-H.264>.
- **AV1 Bitstream & Decoding Spec, Annex A** — the AV1 `seq_level_idx` envelope
  (`codec-pipeline.ts:108`): <https://aomediacodec.github.io/av1-spec/>.
- **VP9 codec levels + MP4/ISO codec string** — the VP9 level table
  (`codec-pipeline.ts:81`) and `vp09.PP.LL.DD` grammar:
  <https://www.webmproject.org/vp9/levels/>, <https://www.webmproject.org/vp9/mp4/>.
- **WHATWG Streams** — `ReadableStream`/`TransformStream` backpressure and `highWaterMark`, the
  substrate for every live composition primitive: <https://streams.spec.whatwg.org/>.

OSS exemplar — **mediabunny** (`Vanilagy/mediabunny`, v1.48.0, the reference engine this project
must beat): <https://github.com/Vanilagy/mediabunny>.

- Conversion planner: `src/conversion.ts`
  (<https://github.com/Vanilagy/mediabunny/blob/main/src/conversion.ts>). Local vendored copy
  read for this doc: `../media-test/node_modules/mediabunny/dist/modules/src/conversion.js`. It
  decides per track whether to **stream-copy or transcode** (`needsTranscode = forceTranscode ||
  bitrate || keyFrameInterval || codec-change …`, `conversion.js:682`), then picks the first
  **encodable** codec via `getFirstEncodableVideoCodec(candidates, {width,height,bitrate})`
  (`conversion.js:746`) and derives the WebCodecs config with `buildVideoEncoderConfig`
  (`encode.d.ts:168`).
- Encoder config + capability probing: `src/encode.ts` (`canEncode`, `getEncodableCodecs`,
  `getFirstEncodable*Codec`): <https://github.com/Vanilagy/mediabunny/blob/main/src/encode.ts>.
- Audio fallback layout (`FALLBACK_NUMBER_OF_CHANNELS` / `FALLBACK_SAMPLE_RATE` when the exact
  layout is not encodable, `conversion.js:964`) — the analogue of this pipeline's
  `buildAudioEncoderConfig` source-fallback (`codec-pipeline.ts:1526`).

**Where the SOTA design must beat mediabunny.** mediabunny probes `canEncode`
(`VideoEncoder.isConfigSupported`) *inside* the conversion planner, fusing capability discovery
with config synthesis. The aibrush design deliberately **splits** them: config synthesis is a
pure, Node-testable function (no WebCodecs, no browser), and the capability probe lives in the
router (S01). That split is what lets this project (a) unit-test the codec-string/level math
against Table A-1 boundaries with a can-fail oracle in CI (ADR-025), and (b) route
`hardware WebCodecs → GPU → WASM` **miss-only** without the config layer naming a backend. The
delta (§5) exists precisely because today's code has leaked capability/runtime concerns back into
the pure layer, eroding that advantage.

## 3. Target design

### 3.1 Data model

The seam types are owned by the driver contract (S04, `src/contracts/driver.ts`) and consumed
here:

- `TrackInfo` — a demuxed or to-be-muxed track: `{ id, mediaType, codec, config?, fps?,
  durationSec?, gapless?, rotation?, encrypted? }` (`driver.ts:231`).
- `EncodedChunk = EncodedVideoChunk | EncodedAudioChunk` (`driver.ts:68`) — sealed WebCodecs host
  objects that carry **only** `timestamp` (= PTS); they have **no DTS** (ADR-045).
- `Packet = { chunk, alpha?, dtsUs? }` (`driver.ts:89`) — the engine's decode-order-preserving
  envelope: `dtsUs` carries the decode timestamp across the container↔codec seam, and `alpha`
  carries a Matroska VPx alpha side chunk. `dtsUs === undefined` means `DTS == PTS`.
- `CodecQuery = { mediaType, direction, config }` (`driver.ts:149`) — what the router ranks.
- `RawFrame = VideoFrame | AudioData` (`driver.ts:70`) — closed exactly once by whoever last owns
  it.

### 3.2 Seams (the target module boundary)

The best design is **three layers**, each independently testable:

1. **Pure config synthesis** (Node, no WebCodecs, no browser, no backend names). Public target +
   source facts → codec string + `EncoderConfig` + `CodecQuery` + mux `TrackInfo`. This is the
   `buildVideoEncoderConfig` / `buildAudioEncoderConfig` / `*CodecString*` / `*QueryFor` family.
   Everything here is total and unit-tested against the level tables with a can-fail oracle.
2. **Capability routing** (S01 router). Takes a `CodecQuery`, runs `isConfigSupported` across
   tiers **hardware WebCodecs → GPU → WASM (miss-only)**, and returns a driver or a typed
   `CapabilityError`. Browser-specific declines (WebKit/Firefox quirks) belong **here**, as tier
   de-ranking keyed by the query — never as string reasons baked into layer 1.
3. **Live composition** (browser-gated). `drainEncoderToMuxer`, `seekFrame`,
   `startAtSeekKeyframe`, `unwrapPackets`, `createDrainTaskGroup`, and the whole VPx-alpha
   split/merge/pair subsystem. These consume real `VideoFrame`/`Packet` streams under WHATWG
   backpressure and own the close-exactly-once contract.

The eager kernel imports **only** the cheap predicates in `codec-routing.ts`; layers 1–3 arrive
via the engine's lazy `import('./codec-pipeline.ts')` (`engine.ts:191`) so a probe-only app pulls
none of them (doc 08 budget).

### 3.3 Capability routing (miss-only)

The pipeline never names a backend. It emits a `CodecQuery`:

```ts
// codec-pipeline.ts:515
export function encodeQueryFor(config: EncoderConfig): CodecQuery {
  const mediaType: 'video' | 'audio' = 'width' in config && 'height' in config ? 'video' : 'audio';
  return { mediaType, direction: 'encode', config };
}
```

`decodeQueryFor` (`codec-pipeline.ts:499`) first normalizes a demuxer's bare token
(`vp9`/`av1`/`h264`) into a fully-qualified WebCodecs string via `normalizeDecoderCodec`
(`codec-pipeline.ts:480`), because `isConfigSupported` rejects bare tokens. The router then ranks
tiers and downloads a heavy WASM core **only on a hardware miss**. On a true miss the pipeline
raises a typed `CapabilityError('capability-miss', …, { op, tried, suggestion })`
(e.g. `codec-pipeline.ts:135`, `:587`, `:1231`) — it fails loudly, never silently degrades.

### 3.4 Edge-case treatment

- **B-frames.** `VideoDecoder` output is presentation-ordered by the UA (WebCodecs spec §
  VideoDecoder; ADR-026/ADR-283), so this layer adds **no PTS reorder buffer**. Decode order is
  preserved for remux/mux by the `Packet.dtsUs` side-channel: `toPacket` (`codec-pipeline.ts:1693`)
  wraps a bare encoder chunk (PTS-only; the muxer recovers DTS from arrival order + durations)
  while a demuxer `Packet` passes through verbatim carrying `dtsUs` so `ctts`/block composition
  survives losslessly (`drainEncoderToMuxer` doc, `codec-pipeline.ts:2510`). `unwrapPackets`
  (`codec-pipeline.ts:1703`) drops the DTS side-channel back to bare chunks for the decoder.
- **VFR (variable frame rate).** `frameRate` is **optional** throughout: it is only emitted into
  the config when known (`codec-pipeline.ts:1494`) and only forces a periodic GOP for *fragmented*
  output (`periodicVideoKeyFrameInterval`, `codec-pipeline.ts:1503`) — ordinary VOD lets the
  encoder place keyframes. Source bitrate evidence is computed from **DTS + packet duration span**,
  not a nominal fps, so VFR cadence and B-frame reorder stay part of the evidence rather than being
  flattened (`sourceVideoBitrateFromPacketTable`, `codec-pipeline.ts:663`).
- **Seek.** Two-stage: `startAtSeekKeyframe` (`codec-pipeline.ts:2593`) scans to the last keyframe
  at/before `targetUs` holding only the current GOP, then `seekFrame` (`codec-pipeline.ts:2665`)
  drops every decoded frame preceding the target — closing each **exactly once** — and returns the
  first frame at/after it, cancelling the reader so the decoder tears down. Seeking past the last
  PTS returns the closest available frame; an empty stream is a typed `InputError`.
- **Cancel.** `createDrainTaskGroup` (`codec-pipeline.ts:1665`) is a per-operation abort domain:
  the first sibling failure becomes the public error, aborts every sibling reader, waits for all
  teardown to settle, then rethrows. Parent `AbortSignal` cancellation enters the same domain;
  `dispose()` removes the listener. `drainEncoderToMuxer` (`codec-pipeline.ts:2526`) checks the
  signal around every `read`/`write` and cancels the locked producer before releasing it.
- **Frame lifetime (`close()` exactly once).** Every path owns its frames explicitly.
  `enqueueFrame` (`codec-pipeline.ts:2355`) closes a frame if `controller.enqueue` throws;
  `decodeVideoPacketsWithAlpha` (`codec-pipeline.ts:2401`) closes buffered alpha frames on
  teardown and closes each merged input pair once; `seekFrame` closes dropped and error-path
  candidates. Packets are not closable — the encoder already closed each input `RawFrame` (its
  contract), so the drains own only readers.
- **Backpressure.** Native WHATWG `TransformStream` backpressure carries the encode/decode graph;
  `unwrapPackets` and `decodeVideoPacketsWithAlpha` pin `{ highWaterMark: 0 }`
  (`codec-pipeline.ts:1736`, `:2506`) so no unbounded queue forms, and `writeDerivedFrame` awaits
  `writer.ready` before handing a frame to an encoder (`codec-pipeline.ts:2069`). The alpha-pairing
  buffer (`alphaByTimestamp`) is bounded by the encode reorder distance, not the stream length.

## 4. Current state

**`codec-routing.ts` (63 lines) — clean.** Three cheap, pure, eager-safe predicates:
`CODEC_MUX_CONTAINERS` delimited-token set (`codec-routing.ts:21`), `containerHasChunkMuxer`
(`:24`), `chooseOutputContainer` (`:34`, explicit `to` wins else same-container-if-muxable else
`mp4`), and `isPcmContainer` (`:58`). No mutable state, no leaks. This is the shape the rest of
the family should aspire to.

**`codec-pipeline.ts` (2693 lines) — a god-file.** It is correct and heavily tested, but it fuses
**seven distinct responsibilities** that the target design keeps separate:

1. Codec-string + level math: `VIDEO_CODEC_STRING` (`:61`), `VP9_LEVELS` (`:81`), `AV1_LEVELS`
   (`:108`), `H264_LEVELS` (`:234`), `vp9CodecStringForConfig` (`:147`), `av1CodecStringForConfig`
   (`:185`), `h264CodecStringForDimensions` (`:302`), and the avcC/hvcC description parsers
   `avcCodecStringFromDescription` (`:391`) / `hevcCodecStringFromDescription` (`:420`).
2. Encoder-config synthesis + rate control: `buildVideoEncoderConfig` (`:1431`),
   `buildAudioEncoderConfig` (`:1526`), `eagerVideoRateConfig` (`:1208`), `defaultVideoBitrate`
   (`:1115`), `videoLatencyMode` (`:1087`).
3. Router-query + mux-TrackInfo builders: `decodeQueryFor` (`:499`), `encodeQueryFor` (`:515`),
   `videoTrackInfoFromDecoderConfig` (`:1553`), `audioTrackInfoFromDecoderConfig` (`:1571`).
4. **Browser/runtime quirk classifiers (capability leak):** `webkitVideoTranscodeDeclineReason`
   (`:873`), `firefoxVideoTranscodeDeclineReason` (`:906`), `firefoxOpusAudioEncodeTarget` (`:931`),
   `firefoxAudioTranscodeDeclineReason` (`:942`), `firefoxOpusEncodeUsesWasm` (`:959`), plus
   `buildVideoEncoderConfigForRuntime` (`:969`) / `resolveAudioEncodeTargetForRuntime` (`:989`) /
   `audioEncodeNeedsSoftwareRuntime` (`:1006`), each doing `await import('./runtime-detect.ts')`
   (e.g. `:974`).
5. VPx-alpha pixel subsystem: `splitFrameForVpxAlpha` (`:1954`), `mergeAlphaFrames` (`:1982`),
   `splitRgbaForVpxAlpha` (`:1882`), and the RGBA sidecar helpers (`:1740`–`:1840`).
6. Live stream composition: `drainEncoderToMuxer` (`:2526`), `seekFrame` (`:2665`),
   `unwrapPackets` (`:1703`), `createDrainTaskGroup` (`:1665`), `encodeVideoFramesWithAlpha`
   (`:2050`), `transcodeVpxAlphaPackets` (`:2175`), `decodeVideoPacketsWithAlpha` (`:2401`).
7. Re-exports of neighbours' surfaces (`:36`–`:49`).

Named smells:

- **Layering violation / false purity claim.** The module header states "Everything here is
  *pure* … no WebCodecs" (`codec-pipeline.ts:5`), but the bottom half constructs real
  `new VideoFrame(...)` (`:1827`, `:1918`, `:1942`) and drives live streams. Two tiers the header
  itself says are separated live in one file.
- **Capability leak.** Layer-4 above hardcodes **browser names** (`WebKit`, `Firefox`) and
  **backend names** (`wasm-opus`, `wasm-mp3`, `webcodecs-video`) plus fixture-scoped budget prose
  ("exceeds the suite timeout on a 5 s 320x240 fixture", `:914`) inside what is supposed to be the
  pure config layer, and reaches into `runtime-detect.ts`. A backend/browser is being named in the
  wrong layer.
- **Overlapping codec-string resolvers.** `videoEncoderCodecString` (`:578`),
  `resolvedVideoEncoderCodecString` (`:1353`), and `h264CodecStringForSourceProfile` (`:319`) each
  resolve a codec string with subtly different preserve/override rules — three doors into the same
  room.
- **Monkey-patched frame expando.** RGBA pixels are smuggled alongside a `VideoFrame` via
  `Object.defineProperty(frame, '__aibrushRgbaPixels', …)` (`:1829`), wrapped in try/catch because
  "some host objects may reject expando properties" (`:1836`) — a fragile sidecar.
- **No module-global mutable state** — an honest positive. The tables (`VP9_LEVELS`, etc.) are
  frozen `const`; the only `Map`s (`alphaByTimestamp`) are per-call locals inside stream factories.
  There is no shared mutable cache to leak across operations.

## 5. Delta / punch-list (ordered; each item has an acceptance test)

1. **Split the god-file into the three target layers.** Extract `codec-strings.ts` (level tables +
   avcC/hvcC parsers), `encoder-config.ts` (build*Config + rate/latency), `codec-queries.ts`
   (`*QueryFor`, `requireEncoderConfig`), `mux-trackinfo.ts`, `vpx-alpha.ts`, and `codec-live.ts`
   (drains/seek/pairing). *Acceptance:* every resulting module is < ~600 lines; all existing
   `codec-pipeline.test.ts` / `codec-ops.test.ts` assertions pass unchanged against re-exports;
   a bundle-analysis test asserts a probe-only closure pulls **none** of `codec-live.ts` /
   `vpx-alpha.ts`.
2. **Remove the capability leak (layer 4 → router).** Move `webkitVideoTranscodeDeclineReason`,
   `firefoxVideoTranscodeDeclineReason`, `firefox*` classifiers, and the `*ForRuntime` wrappers out
   of the pure config module into the S01 router as query-keyed tier de-ranking. *Acceptance:*
   `grep -E 'isWebKitRuntime|isFirefoxRuntime|runtime-detect|WebKit|Firefox|wasm-opus'` over the
   pure config module returns **zero**; a router test feeds a Firefox+Opus+MP3-source query and
   asserts the same typed `capability-miss` with the identical message the current
   `firefoxAudioTranscodeDeclineReason` (`codec-pipeline.ts:942`) produces.
3. **Make the purity claim true (or fix the header).** After item 1, the pure layer must contain
   no `new VideoFrame(` / `new AudioData(` / `.close(`. *Acceptance:* a lint/grep test asserts the
   pure config modules reference none of those tokens; the header comment
   (`codec-pipeline.ts:5`) is updated to match reality.
4. **Consolidate the three codec-string resolvers into one.** Keep a single exported
   `resolveVideoEncoderCodecString(target, src, sourceCodecString)`; make
   `videoEncoderCodecString` (`:578`) and `h264CodecStringForSourceProfile` (`:319`) private
   helpers of it. *Acceptance:* the public surface exports exactly one video codec-string
   resolver; a table test pins the string for {explicit token, preserve-source, H.264
   Main/High-source, HEVC-Main10-request, VP9/AV1 level boundary} and passes bit-for-bit against
   today's outputs.
5. **Replace the `__aibrushRgbaPixels` expando** (`codec-pipeline.ts:1829`) with a `WeakMap<VideoFrame,
   RgbaFramePixels>` sidecar or an explicit wrapper type. *Acceptance:* no
   `Object.defineProperty(frame, …)` remains; a VPx-alpha round-trip test proves split→merge stays
   bit-exact and no longer depends on host-object expando acceptance (drop the try/catch at `:1836`).
6. **Pin the rate model behind named constants + a golden table.** `defaultVideoBitrate`
   (`codec-pipeline.ts:1115`) mixes a 20-bits/pixel/second planned budget, a per-codec efficiency
   table, a `sqrt(fps/30)` cadence scale (ADR-252), and an evidence-based path with a bare
   `3_750_000` floor (`:1171`). Extract each to a documented constant. *Acceptance:* a table-driven
   test pins the output bitrate for a matrix of {codec × resolution × fps × sourceBitrate} tuples,
   including the AV1 60fps cadence row (harvest: `sqrt(frameRate/30)` capped at H.264 budget) and
   the av1→vp9 source-bounded row (harvest line 395).
7. **Prove frame-lifetime is exactly-once under cancel/error, not just success.** Add a
   close-counting fake-`VideoFrame` oracle across `splitFrameForVpxAlpha`, `mergeAlphaFrames`,
   `encodeVideoFramesWithAlpha`, `decodeVideoPacketsWithAlpha`, `seekFrame`, and
   `drainEncoderToMuxer`. *Acceptance:* for success, mid-stream `cancel`, and an injected throw at
   each `await`, the oracle asserts `closeCount === createCount` and no double-close (extends the
   existing "closed exactly once" claim at `codec-pipeline.ts:2047`).
8. **Bound and unify backpressure on the alpha-pairing streams.** `encodeVideoFramesWithAlpha`
   (`codec-pipeline.ts:2133`) and `encodeVpxAlphaFrameStreams` (`:2269`) build their output
   `ReadableStream` with the **default** HWM, unlike `unwrapPackets`/`decodeVideoPacketsWithAlpha`
   which pin `{ highWaterMark: 0 }` (`:1736`, `:2506`). Audit and pin HWM consistently.
   *Acceptance:* a slow-consumer test drives each alpha stream and asserts `alphaByTimestamp` never
   exceeds the encoder reorder distance (a fixed small bound), not the clip length.
9. **Add explicit capability-miss tests for the encode-surface limits.** Two-pass is H.264-only
   (`codec-pipeline.ts:1230`), CRF/quantizer is gated by `webCodecsQuantizerSupported` (`:1077`),
   HEVC non-Main/Main10 and high-bit-depth are typed misses (`:602`, `:1336`). *Acceptance:* tests
   assert `av1` + `twoPass:true` throws `capability-miss` with the exact suggestion string
   ("target H.264 or add a validated two-pass allocator…", `:1237`), and `vp8` + `crf` throws with
   the exact CRF suggestion.
10. **Lock the VFR/B-frame bitrate-evidence path with a golden.** `sourceVideoBitrateFromPacketTable`
    (`codec-pipeline.ts:663`) must use the DTS+duration span, not PTS. *Acceptance:* a golden test
    feeds (a) a VFR packet table with non-uniform durations and (b) a reordered-DTS B-frame table,
    and asserts the computed bits/second matches a hand-derived value and is insensitive to PTS
    ordering.
11. **Guard the `chooseOutputContainer` default.** `chooseOutputContainer` (`codec-routing.ts:34`)
    falls back to `mp4`. *Acceptance:* a test asserts that a source whose container is **not**
    chunk-muxable (and no explicit `to`) returns `mp4`, and that a genuinely non-muxable target
    surfaces the container router's typed miss rather than silently producing a broken output.
12. **Keep the eager-kernel boundary a test, not a comment.** The split (item 1) must preserve the
    property asserted in prose at `codec-routing.ts:3`. *Acceptance:* a budget test fails if any of
    the heavy layer-1/2/3 modules become statically reachable from the eager kernel entry (today
    they arrive only via `engine.ts:191`'s `import('./codec-pipeline.ts')`).

## 6. Open questions (seed `docs/decisions/`)

1. **Where do browser quirks live?** Should WebKit/Firefox declines be *data* (a table keyed by
   `CodecQuery` + runtime) evaluated by the router, or *code*? The target design says router-owned
   data; today they are prose-bearing functions in the config module (`codec-pipeline.ts:873`,
   `:906`). Decide the mechanism and the home. → ADR.
2. **Two-pass beyond H.264.** WebCodecs exposes no first-pass statistics API (harvest line 289), so
   VP9/AV1 two-pass is currently a typed miss (`codec-pipeline.ts:1230`). Keep honest-NA, or
   generalize the fixed-QP analysis→quantizer-replay approach (ADR used for H.264) to VP9/AV1? → ADR.
3. **HEVC Main10 / high-bit-depth encode.** Main10 output is hardware-only with no permissive
   software tail (ADR-080; `codec-pipeline.ts:1336`, `:1383`). Remain a typed miss, or vendor a
   Main10 encoder tail? The requested `hev1.2.4.L120.B0` builds but classifies NA_BROWSER on
   Chromium (harvest line 168). → ADR.
4. **RGBA sidecar transport.** Expando on the frame (`:1829`) vs `WeakMap` vs a typed wrapper — pick
   the SOTA carrier for split/merge RGBA pixels and its ownership rules. → ADR.
5. **Implicit preserve-source default.** `sourceQualificationFactsAreUnchanged`
   (`codec-pipeline.ts:1396`) silently preserves the source codec string on an unchanged-geometry
   re-encode. Is silent same-codec preserve the right default, or should the caller name the codec
   explicitly for exotic source profiles? → ADR.
6. **The default quality budget.** Is 20 bits/pixel/second with a per-codec efficiency table
   (`codec-pipeline.ts:1130`) the right SOTA implicit target, versus an SSIM/VMAF-targeted CRF
   default? The generic-VP9 20 bpp/s path was the root cause of the av1→vp9 loss (harvest lines
   395/448); the 2 Mb/s SSIM bound needed ~2× requested bitrate (harvest ADR-193). → ADR.

---

*Provenance: all `path:line` citations verified against `src/api/codec-pipeline.ts` and
`src/api/codec-routing.ts` at read time. Measured numbers and browser quirks are cited to
`docs/measured-evidence.md`. The mediabunny exemplar was read from the vendored copy under
`../media-test/node_modules/mediabunny/dist/modules/src/`.*
