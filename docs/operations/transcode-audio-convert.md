# Transcode — Audio & Convert

> Shard **S12**. Owned code: `src/api/audio-stream-plan.ts`, `codec-convert-runner.ts`,
> `convert-stream-copy.ts`, `pcm-convert-plan.ts`, `flac-convert-plan.ts`, `wav-frame-encode.ts`,
> `gapless-native-suppression.ts`, `live-convert.ts` (all under `src/api/`).
> This document is the **target spec** (the best design) plus an **honest delta** versus today's code.
> Every claim traces to `path:line` or a cited external source. Unverifiable claims are marked `UNVERIFIED`.

## 1. Purpose & scope

This family covers **audio re-encoding** and the **`convert()` orchestration** that decides, for a whole-file
job, whether to (a) losslessly stream-copy, (b) run a PCM-native sample-domain transform, (c) author FLAC
losslessly, (d) decode → filter → encode → mux through the codec seam, or (e) run a one-shot live
`MediaStream` conversion. It also owns raw-frame WAV `encode()`.

Benchmark families served (per `docs/architecture/COVERAGE.md`): **transcode (audio)** and **convert**. Representative
scenarios from `../media-test`: `transcode/aac_to_opus_webm`, `transcode/opus_to_aac_mp4`,
`transcode/wav_to_flac`, `transcode/aac_to_pcm_wav_extract`, `audio-dsp/edge_gapless_aac_decode`,
`convert` container swaps (Opus→MKV, FLAC→MKV), and PCM conversions (`pcm_s16be_to_s16le`,
`meta_idempotent_resample_same_rate`) shared with the audio-dsp shard S17.

Boundaries with sibling shards:
- **S13 (codec-pipeline)** owns the shared codec-seam helpers (`buildAudioEncoderConfig`,
  `decodedAudioStreamWithGapless`, `drainEncoderToMuxer`, `resolveAudioEncodeTargetForRuntime`). S12
  *consumes* them; the delta below argues the audio-specific ones should migrate here.
- **S17 (audio-dsp)** owns the actual sample math (`transformPcm`, resampler, remix, biquad, dynamics).
  S12 only *plans* the ordered `FilterSpec[]` (in `audio-stream-plan.ts`) and routes to `transformPcm`.
- **S16 (trim)** owns seek and edit-list/preroll trimming; S12 reuses `trim-streams.ts` for gapless.
- **S14 (mux)** / container drivers own the muxers this family drains into.

## 2. Spec & references

Governing standards:

- **W3C WebCodecs — `AudioEncoder` / `AudioEncoderConfig`.**
  <https://www.w3.org/TR/webcodecs/#audio-encoder-interface>. Verified: `AudioEncoderConfig` members
  `codec`, `sampleRate`, `numberOfChannels`, optional `bitrate`, optional `bitrateMode`
  (`"constant" | "variable"`); `AudioEncoder.isConfigSupported(config)` returns an `AudioEncoderSupport`
  echoing only recognized members; `configure()`/`encode(AudioData)`/`flush()`/`close()`; each
  `EncodedAudioChunk` is delivered with `EncodedAudioChunkMetadata` whose `decoderConfig` authors MAY use
  to decode the chunk. `close()` "immediately aborts all pending work and releases system resources".
- **WHATWG Streams — backpressure.** <https://streams.spec.whatwg.org/>. The decode→filter→encode→mux
  graph is `ReadableStream`/`TransformStream` piping; a slow muxer applies backpressure upstream to the
  decoder through the encoder's `desiredSize`.
- **ISO/IEC 14496-12 (ISO-BMFF) edit lists** for MP4 encoder-delay/priming (the `elst` presentation
  offset). <https://www.iso.org/standard/83102.html>. Consumed as `gapless.basis === 'mp4-edit-list'`.
- **RFC 7845 — Opus in Ogg (pre-skip / gapless).**
  <https://datatracker.ietf.org/doc/html/rfc7845#section-4.2>. Opus always runs at 48 kHz internally and
  publishes its own pre-skip, which is why source gapless facts must be dropped for an Opus re-encode
  (see `outputGaplessForAudioEncoder`). Opus TOC → frame duration derivation is RFC 6716
  (<https://datatracker.ietf.org/doc/html/rfc6716#section-3.1>), harvested as ADR-070/079 (`measured-evidence.md`).
- **`ffmpeg -c copy`** is the conceptual model for the stream-copy shortcut (no decode/re-encode).
  <https://ffmpeg.org/ffmpeg.html#Stream-copy>.

OSS exemplar:

- **mediabunny — `Conversion` / audio track processing.**
  <https://github.com/Vanilagy/mediabunny/blob/main/src/conversion.ts>. Verified behaviors we match or
  should beat: a passthrough fast path in `_processAudioTrack()` gated on
  `!forceTranscode && !bitrate && numberOfChannels === originalNumberOfChannels &&
  sampleRate === originalSampleRate && !needsTrimming && !needsPadding && audioCodecs.includes(sourceCodec)
  && (!codec || codec === sourceCodec) && !process && sampleFormat === undefined`, backed by
  `EncodedAudioPacketSource` (copy packets, no decode); otherwise decode via `AudioSampleSink` and re-encode
  through an `AudioSampleSource`/`AudioEncodingConfig`; explicit track **discard** via `discardedTracks` with
  reasons `'unknown_source_codec' | 'undecodable_source_codec' | 'no_encodable_target_codec'`; and fallbacks
  `FALLBACK_SAMPLE_RATE = 48000`, `FALLBACK_NUMBER_OF_CHANNELS = 2` for non-PCM codecs.
  Our stream-copy gate lives in `convert-stream-copy.ts`/`semantic-stream-copy.ts`; our copy-in-convert
  gate is `canCopyAudioTrackToContainer` (`codec-pipeline.ts:799`).

## 3. Target design

### 3.1 Data model & routing ladder

`convert()` is a **capability-routed cascade**. The developer never names a backend; each rung either
produces an `Output` or declines (`undefined`) and falls through. The order (best/cheapest first):

1. **Semantic / pure stream-copy** (`convert-stream-copy.ts:18` → `semantic-stream-copy.ts`). If the target
   container's driver exposes `streamCopy` and the request is a pure container change (`isPureStreamCopy`)
   or a probe proves a no-op re-encode (`isSemanticStreamCopy`), copy packets — no decode. This is the
   `-c copy` / mediabunny `EncodedAudioPacketSource` analog. A re-readable `Blob` source can be reused
   directly (`reuseBlob`, `convert-stream-copy.ts:46`).
2. **FLAC authoring** (`flac-convert-plan.ts:67`), for `to:'flac'` with a lossless-eligible audio target.
   A FLAC source re-encodes through its own `transformPcm`; a raw-PCM source (WAV/AIFF/CAF) is decoded to
   canonical PCM and FLAC-encoded at its on-wire depth. Pure-TS FLAC encoder (ADR-024/086, `measured-evidence.md`),
   never the WebCodecs seam.
3. **PCM-native transform** (`pcm-convert-plan.ts:305`), for a raw-PCM target (WAV/AIFF/CAF) with a
   PCM/no-codec audio target. Runs the source container's `transformPcm` (or a `decodePcm` bridge for a
   compressed source → WAV). No WebCodecs `AudioEncoder` exists for PCM (ADR-022), so this path is
   mandatory, not an optimization.
4. **Codec seam** (`codec-convert-runner.ts:135`), the general decode → (filter) → encode → mux graph
   through WebCodecs (hardware) → WASM (miss-only) audio codecs, muxed by a container chunk-muxer.
5. **Live** (`live-convert.ts:86`), a one-shot `MediaStream` decode → filter → encode → mux under one abort
   domain, for `convert(MediaStream, …)`.

`encode()` (raw `AudioData` frames → file) has a dedicated PCM-WAV rung: `wav-frame-encode.ts:35`, because
PCM is not an `EncodedAudioChunk` and cannot go through `AudioEncoder`.

### 3.2 Capability routing: WebCodecs → GPU → WASM (miss-only)

Audio has **no GPU tier** (say-so: DSP is CPU/WASM; the GPU tier is video-filter-only, S18). So the audio
ladder collapses to **hardware WebCodecs `AudioEncoder`/`AudioDecoder` → WASM codec tail on a true miss**.
The encoder config is synthesized by `buildAudioEncoderConfig` (`codec-pipeline.ts:1526`) and offered to the
router via `encodeQueryFor`; the router (S01) probes `AudioEncoder.isConfigSupported` and picks the tier.
On a genuine miss the caller gets a typed `CapabilityError` — e.g. MP3 encode has no permissive encoder and
stays an honest NA (ADR-105, `measured-evidence.md`); Vorbis encode is served by a permissive libvorbis WASM tail
(ADR-108). **Target rule: the audio *plan* is backend-agnostic; only the router names tiers.** Today this
is violated (see §4/§5): the Firefox-specific "Opus encode → wasm-opus, ADTS-AAC decode → wasm-aac" routing
is decided inside `resolveAudioEncodeTargetForRuntime` (`codec-pipeline.ts:989`), which even lists
`'wasm-opus'`/`'wasm-mp3'` in the `CapabilityError.tried` array — a backend name leaking into a planning
layer (ADR-110, `measured-evidence.md`).

### 3.3 Seams

- **Filter planning** (`audio-stream-plan.ts:148`, `audioFilterSpecs`): pure `AudioTarget → FilterSpec[]`,
  order **gain → fade → remix → resample → biquad → dynamics**, each emitted only when non-no-op. This
  mirrors the PCM path (`transformPcm`) exactly, so a lossy-codec convert is bit-exactly equivalent to the
  PCM-native transform *up to the encoder*. Fade frames resolve against the **source** rate because fade
  precedes resample (`audio-stream-plan.ts:158`). Node-unit-testable (pure), no WebCodecs.
- **Encoder-config planning** (`buildAudioEncoderConfig`, `codec-pipeline.ts:1526`): `AudioTarget +
  source layout → AudioEncoderConfig`. `sampleRate = target.sampleRate ?? src.sampleRate`,
  `numberOfChannels = target.channels ?? src.channels`, optional `bitrate`. **Should live in S12**
  (`audio-encode-plan.ts`), symmetric with the filter planner.
- **Drain seam** (`drainEncoderToMuxer`, `codec-pipeline.ts:2526`): reads `EncodedChunk`/`Packet` from the
  encoder and writes to the muxer, allocating the mux track lazily from the encoder's published
  `AudioDecoderConfig` (`audioTrackInfoFromDecoderConfig`) so the muxer writes the exact codec box.
- **Runner context bags** (`CodecConvertRunnerContext` `codec-convert-runner.ts:47`;
  `LiveFramePipelineDependencies` `live-convert.ts:33`): the engine threads its private seams in so the
  cold routines never reach into engine state. Good pattern; the bags are oversized (§5).

### 3.4 Edge cases

- **B-frames — N/A.** Audio has no bidirectional prediction; PTS==DTS. (Container-level DTS/ctts concerns
  belong to remux S15 / mux S14.)
- **VFR — N/A in the video sense**, but the audio analog is **discontinuous / non-contiguous sample
  clocks**. Raw-frame WAV encode enforces a contiguous clock: `assertContinuousTimestamp`
  (`wav-frame-encode.ts:289`) requires each `AudioData.timestamp` to equal
  `base + round(totalFrames / sampleRate * 1e6)` within a 1 µs tolerance
  (`TIMESTAMP_ROUNDING_TOLERANCE_US`, `wav-frame-encode.ts:14`), and rejects layout changes mid-stream
  (`assertFrameGeometry`, `:276`). Gapless priming/padding trimming (edit-list, Opus pre-skip) is the
  intentional, spec-driven discontinuity, handled by `decodedAudioStreamWithGapless` (`codec-pipeline.ts:1616`).
- **Seek — N/A for whole-file transcode/convert** (S16 owns seek). The one bounded partial decode here is
  the gapless native-suppression preflight: `collectNegativeTimestampPrefix`
  (`gapless-native-suppression.ts:53`) reads at most `MP4_GAPLESS_PREFLIGHT_MAX_PACKETS = 8` negative-PTS
  packets (`:5`) and decodes only that prefix through an independent decoder instance.
- **Cancel — first-class.** Every rung is `AbortSignal`-scoped. `codec-convert-runner.ts` cancels all open
  streams on any task failure (`allOrCancelStreams`, `:419`) and always `demuxer.close()`s (`:411`).
  `live-convert.ts` runs one shared `AbortController`, aborts on any failure, cancels both frame relays
  (`convertLiveMediaStream`, `:86`; `cancelRelays`, `:100`), and exposes `.cancel()` (`:159`).
  `wav-frame-encode.ts` races the reader against abort (`readAudioFrame`, `:326`) and cancels the reader on
  failure (`:143`). `gapless-native-suppression.ts` re-throws only `aborted`, else returns 0 (`:159`).
- **Frame lifetime — every `AudioData`/`VideoFrame` `close()`d exactly once.**
  - WAV frame encode: each frame is `close()`d once in the per-frame block, capturing a close error without
    double-close (`wav-frame-encode.ts:128`); a late frame delivered after abort is closed exactly once
    (`readAudioFrame` late-close, `:342`).
  - Gapless preflight: every probe frame is closed in a `finally` after counting
    (`decodedPrefixSamples`, `gapless-native-suppression.ts:116`).
  - Live relay: on enqueue failure the pulled frame is closed once (`closeFrame`, `live-convert.ts:407`,
    called at `:392`); on cancel the reader drains and releases (`relayFrames`, `:350`).
  - Codec-seam decode/filter/encode close discipline is delegated to S13 helpers
    (`lazyPipeThrough` with `closeValue: context.closeIfClosable`, `codec-convert-runner.ts:307`).
- **Backpressure — native to the stream graph.** The gapless prefix stream and live relay both use
  `highWaterMark: 0` (`gapless-native-suppression.ts:92`, `live-convert.ts:402`) so a frame is only pulled
  when the consumer asks, and the drain reads one chunk at a time. The heavy decode→encode graph is the
  only work offloaded to a worker (`offloadStream`, `codec-convert-runner.ts:175`); it transfers *bytes*,
  never `AudioData` across the boundary (ADR-019/087, `measured-evidence.md`), sidestepping cross-thread
  close-once hazards.

## 4. Current state

What exists today, with citations and the smells to fix.

**Filter planning — clean.** `audio-stream-plan.ts` is a pure module, correctly split out of
`codec-pipeline.ts` so its audio-dsp type imports stay out of the eager kernel closure
(`audio-stream-plan.ts:1`-`16`). `audioTargetCanBypassFilterPlanner` (`:36`) lets codec/bitrate-only
transcodes skip planning. `audioFilterSpecs` (`:148`) emits the canonical order. No smells.

**`convert()` route ordering** lives in `engine.ts`: FLAC (`engine.ts:579`) → PCM-native (`:594`) →
codec seam (`#convertViaCodec`, dispatched at `:615` → `codec-convert-runner.ts:135`); live is a separate
top branch (`engine.ts:528`); raw-frame WAV encode at `engine.ts:753`. The audio encode/decode methods
`#encodeAudioStream` (`engine.ts:1681`) and `#decodeAudioTrackPackets` (`engine.ts:1316`) are engine-private
and bound into the runner context.

**Codec-seam runner** (`codec-convert-runner.ts`): `runCodecConvert` (`:135`) attempts stream-copy first
(`:151`), guards the muxer (`:168`), tries worker offload (`:175`), then builds the live graph. The audio
branch (`:333`) either copies packets when `opts.audio === undefined` and
`canCopyAudioTrackToContainer` accepts (`copyAudioPackets`, `:212`; `drainEncoderToMuxer`, `:337`), or
decodes → filters → encodes (`:339`-`:390`). **Smell (duplication/layering):** the PCM/FLAC decode-bridge
selection is three near-identical inline branches (`:345`-`:378`), each doing a separate dynamic
`import('../dsp/audio-data.ts')` and choosing `decodePcmInterleavedStream` / `decodePcmAudioStream` /
`decodePcmAudio`. This belongs in a single `decodePcmBridge` helper.

**Stream-copy gate** (`convert-stream-copy.ts:18`): correctly operation-lazy; distinguishes pure vs semantic
copy and honors `streamCopyTargets` (`:30`) and streaming vs buffered sinks (`:59`). Clean.

**PCM-native** (`pcm-convert-plan.ts`): `convertPcmNative` (`:305`) and `pcm()` (`:372`) route to
`transformPcm`/`decodePcm`. **Smell (module-global mutable state):** a process-global LRU/TTL cache of
rewrite source bytes — `pcmRewriteSourceCache` (`Map`, `:49`) and `pcmRewriteSourceCacheBytes` (mutable
`let`, `:50`), with fixed constants (`:39`-`:42`). This singleton is shared across all engine instances and
never reset on engine disposal; it is hidden module state that complicates isolation and testing. **Smell
(codec-token duplication):** `wavPcmPacketCopy` (`:450`) and the transform-options assembly depend on
injected `deps.pcmSampleFormat`/`deps.pcmEndian` (engine-owned), while `wav-frame-encode.ts` has its own
independent `pcmWireTarget` mapping (`wav-frame-encode.ts:173`-`216`) of the same `pcm-*` tokens — two
sources of truth for PCM-token → `(SampleFormat, Endianness)`.

**FLAC authoring** (`flac-convert-plan.ts:67`): FLAC-source re-encode (`:80`), direct WAV-s16 fast path
(`canTryDirectWavS16Flac`, `:114`; author at `:88`-`100`), and raw-PCM decode→FLAC (`:102`-`111`). Clean;
`sourcePcmFormat` (`:171`) reads on-wire depth from the demux track. `readAllSource` (`:136`) buffers the
whole source for the direct path — acceptable for the fast path, but a whole-file read.

**Raw-frame WAV encode** (`wav-frame-encode.ts:35`): thorough validation, exact close-once discipline, and a
`writePcm` raw seam that never fabricates coded chunks. `pcmWireTarget` (`:173`) is exhaustive over the
`pcm-*` codec union and returns a typed miss for coded codecs. Clean except the duplication noted above.

**Gapless native suppression** (`gapless-native-suppression.ts`): `nativeSuppressedMp4EditSamples` (`:134`)
implements the ADR-213 bounded preflight — decode only the negative-PTS prefix through an independent
decoder, compare exact decoded sample count to the packet-duration expectation, and never interpret ≤ 1
sample/packet rounding drift as suppression (`:166`). Wired only from `decodedAudioStreamWithGapless`
(`codec-pipeline.ts:1633`) for `basis === 'mp4-edit-list'`. Clean and well-guarded.

**Live** (`live-convert.ts`): `convertLiveMediaStream` (`:86`) is a careful lifecycle coordinator;
`validateLiveConvertOptions` (`:167`) fails loudly before any encoder/muxer is built (requires explicit
`to`, explicit codec, positive geometry, and rejects two-pass for live at `:199`); `runLiveFramePipeline`
(`:222`) mirrors the cold runner. Clean; the dependency bag is large.

**God-file / layering context.** The audio-transcode *concern* is spread across five files:
`audio-stream-plan.ts` (filters, S12), `codec-pipeline.ts` (`buildAudioEncoderConfig`,
`decodedAudioStreamWithGapless`, `resolveAudioEncodeTargetForRuntime`, `drainEncoderToMuxer` — S13, a
~2600-line god-file, 103,935 bytes), `engine.ts` (`#encodeAudioStream`/`#decodeAudioTrackPackets` — S05,
98,989 bytes), and `codec-convert-runner.ts` (orchestration, S12). No single module owns "audio encode".

## 5. Delta / punch-list

Ordered, each with a concrete acceptance test / oracle. Reference `path:line`.

1. **Extract an `audio-encode-plan.ts` (S12) that owns audio encoder-config + output-gapless planning.**
   Move `buildAudioEncoderConfig` (`codec-pipeline.ts:1526`) and `outputGaplessForAudioEncoder`
   (`codec-pipeline.ts:1591`) into a new pure module symmetric with `audio-stream-plan.ts`, leaving
   codec-pipeline free of audio-specific encoder logic.
   *Acceptance:* a Node unit test imports `audio-encode-plan.ts` and asserts, with no WebCodecs, that
   `buildAudioEncoderConfig({codec:'opus'}, {sampleRate:44100, channels:2}, 'mp4a.40.2')` yields
   `{codec:'opus', sampleRate:48000, numberOfChannels:2}` (see item 2) and that
   `grep -n "buildAudioEncoderConfig\|outputGaplessForAudioEncoder" src/api/codec-pipeline.ts` returns no
   *definitions* (only imports). Byte-budget test: eager kernel stays under cap (`measured-evidence.md`: 50.00 kB).

2. **Normalize Opus encode to 48 kHz and publish encoder pre-skip; never trust a non-48k Opus config.**
   `buildAudioEncoderConfig` currently uses `target.sampleRate ?? src.sampleRate` (`codec-pipeline.ts:1526`),
   so an Opus target inherits e.g. 44.1 kHz. RFC 7845 §4.2 requires Opus at 48 kHz internally, and
   `outputGaplessForAudioEncoder` already drops source gapless for Opus (`codec-pipeline.ts:1595`).
   Force `sampleRate = 48000` for `audioCodecToken(codec) === 'opus'` unless the caller explicitly set a
   different rate (then either resample-to-48k in the filter chain or raise a typed error).
   *Acceptance:* unit test asserts the Opus branch pins 48000; harness `transcode/aac_to_opus_webm` passes
   its strict oracle (`measured-evidence.md`: byte-identical 128,350-byte WebM, 502 Opus packets, 481,296 sample
   frames, sampleDelta scenario), and a mono-44.1k-Opus convert does not emit a 44.1k `dOps`.

3. **Push runtime (Firefox) codec quirks out of the plan and into the router (S01) — fix the capability leak.**
   `resolveAudioEncodeTargetForRuntime` (`codec-pipeline.ts:989`) and `audioEncodeNeedsSoftwareRuntime`
   (`:1006`) name backends (`'wasm-opus'`, `'wasm-mp3'`, `'webcodecs-audio'`) in a planning layer and in the
   `CapabilityError.tried` array. The plan should be backend-agnostic; the router should apply the
   Firefox "Opus→software, ADTS-AAC decode→wasm-aac" rule (ADR-110, `measured-evidence.md`) via tier scoring.
   *Acceptance:* `grep -n "wasm-opus\|wasm-mp3\|webcodecs-audio\|isFirefoxRuntime" src/api/*.ts` shows no
   backend token inside `audio-encode-plan.ts`/`codec-convert-runner.ts`; a router test with a stubbed
   Firefox runtime routes an Opus encode to the software tier and an ADTS-AAC decode to `wasm-aac`, and a
   stubbed Chromium runtime routes both to WebCodecs — asserted through the public `strategy`-free API.

4. **Single-source the PCM codec-token → `(SampleFormat, Endianness)` mapping.**
   `wav-frame-encode.ts:173` (`pcmWireTarget`) and the engine-injected `deps.pcmSampleFormat`/`pcmEndian`
   used in `pcm-convert-plan.ts` (`:356`, `:455`) encode the same 15-token table twice. Move the canonical
   map to `src/dsp/pcm.ts` (S17) and have both callers import it.
   *Acceptance:* a table-driven test enumerates every `pcm-*` token in the `AudioTarget['codec']` union and
   asserts `wav-frame-encode`'s wire target and `pcm-convert-plan`'s resolved format/endian agree for all
   of them; deleting the duplicate in `wav-frame-encode.ts` keeps `wav-frame-encode.test.ts` green.

5. **Extract `decodePcmBridge(container, src, track, stage)` from the runner's three inline branches.**
   `codec-convert-runner.ts:345`-`378` repeats `decodePcmInterleavedStream` / `decodePcmAudioStream` /
   `decodePcmAudio` selection with three separate `import('../dsp/audio-data.ts')` calls.
   *Acceptance:* one helper with one dynamic import; a unit test with a fake `ContainerDriver` exposing each
   capability in turn proves the helper selects the interleaved path first, then the chunked path, then the
   single-shot path, and returns `undefined` when none exist so the caller decodes via the codec.

6. **Retire the module-global `pcmRewriteSourceCache` singleton (or move it to the Source cache, S06).**
   `pcm-convert-plan.ts:49`-`50` holds process-global mutable state shared across every engine instance,
   never cleared on engine disposal.
   *Acceptance:* construct two independent engines, run a WAV-identity convert on each, and spy on
   `src.range` — the second engine must still issue its own read (no cross-engine cache hit); disposing an
   engine must free its cache (heap assertion). If moved to S06, the cache key is the `SOURCE_CACHE_KEY`
   and the TTL/byte caps (`:39`-`:42`) live with the source layer.

7. **Shrink the runner/live dependency bags into named sub-seams.**
   `CodecConvertRunnerContext` (`codec-convert-runner.ts:47`-`132`, ~20 callbacks) and
   `LiveFramePipelineDependencies` (`live-convert.ts:33`-`70`) are god-bags coupling the cold routines to
   engine internals.
   *Acceptance:* refactor into composed seams (e.g. `RouteSeam`, `AudioSeam`, `VideoSeam`, `MuxSeam`); a
   type-level test asserts each sub-seam has ≤ 6 members and the runner depends only on the sub-seams it
   uses. No behavioral regression: full `codec-ops`/`create-media` suites stay green.

8. **Add a strict double-trim gapless oracle for AAC-in-MP4 with an edit-list priming.**
   `nativeSuppressedMp4EditSamples` (`gapless-native-suppression.ts:134`) guards against Chromium natively
   suppressing priming (ADR-213). Bake a golden that decodes a real editlist-priming AAC-in-MP4 and asserts
   the decoded sample count equals `sourceSamples − priming` **exactly once**.
   *Acceptance:* harness `audio-dsp/edge_gapless_aac_decode` oracle: `decodedSamples = 44673`,
   `rawAacFrameSamples = 46080`, `primingSamples = 1024`, `sampleDelta = 0` (`measured-evidence.md`); plus a
   Chromium-vs-Firefox cross-check that both land on the same decoded sample count (Firefox reproduced the
   deficit at 49,152 samples in the source note — the oracle must be browser-invariant).

9. **Document + test the raw-frame WAV contiguity contract (the audio "VFR" boundary).**
   `assertContinuousTimestamp` (`wav-frame-encode.ts:289`, tolerance 1 µs at `:14`) rejects any gappy audio
   clock. Make it explicit that `encode()`-to-WAV expects a contiguous decoded clock, not arbitrary live
   audio, and decide whether the 1 µs tolerance is right for real decoders that drift (see open questions).
   *Acceptance:* a test feeds two `AudioData` frames with a 2 µs gap and asserts an `InputError`
   (`unsupported-input`) with the "contiguous AudioData timestamps" message; a contiguous stream produces
   the golden checksum (`measured-evidence.md`: bench-session12-wav-frame-encode output checksum 2910552623).

10. **Verify the copy-in-convert passthrough matches mediabunny's `canPassThrough` conditions.**
    `codec-convert-runner.ts:212` copies audio packets only when `opts.audio === undefined` and
    `canCopyAudioTrackToContainer` (`codec-pipeline.ts:799`) accepts. mediabunny additionally gates on
    "no bitrate, same channels, same sampleRate, no trim/pad" (§2).
    *Acceptance:* an audio-only convert (compatible container, no target changes) constructs **zero**
    `AudioData` (assert via an `AudioData` construction counter/spy) and produces a byte-stable output;
    a convert that requests a `bitrate` or layout change does **not** take the copy path.

11. **FLAC direct path: bound the whole-file read.**
    `readAllSource` (`flac-convert-plan.ts:136`) buffers the entire source for the WAV-s16 fast path. For a
    large WAV this is a full-file allocation.
    *Acceptance:* a memory oracle asserting peak ArrayBuffer for a large WAV→FLAC stays within one source
    allocation (cf. ADR-277 range-less WAV decode, `measured-evidence.md`), or a size threshold above which the
    fast path defers to the streaming `authorFlacStream` path (`:105`-`111`).

## 6. Open questions (seed `docs/decisions/`)

1. **Where does the canonical PCM codec-token ↔ `(SampleFormat, Endianness)` map live** — `src/dsp/pcm.ts`
   (S17) as the single owner, with S12 importing it? (Blocks delta 4.) Decision to log.
2. **Should the PCM rewrite-source cache be an engine-scoped field or part of the S06 Source cache?** The
   current module singleton (`pcm-convert-plan.ts:49`) has no owner and no disposal. (Blocks delta 6.)
3. **Should runtime codec quirks (Firefox Opus→software, Firefox ADTS-AAC decode→wasm-aac) be a first-class
   router input (S01 tier scoring)** rather than a plan-layer decline (ADR-110)? Where does the
   `runtime-detect` signal enter the router? (Blocks delta 3.)
4. **Is 48 kHz Opus normalization silent or an explicit rejection** when the caller asks for a non-48k Opus
   `sampleRate`? Silent-normalize (resample in the filter chain) vs typed `InputError`. (Blocks delta 2.)
5. **Is the 1 µs WAV-encode contiguity tolerance (`wav-frame-encode.ts:14`) correct** for real browser
   decoders whose per-frame timestamps can drift by more than a microsecond, or should raw-frame WAV encode
   tolerate/repair small gaps instead of rejecting? (Blocks delta 9.)
6. **MP3 and Vorbis encode policy.** MP3 stays an honest `CapabilityError` (no permissive encoder, ADR-105);
   Vorbis authors via a permissive libvorbis WASM tail (ADR-108). Should the doc-visible capability matrix
   state MP3 encode as permanently NA-unless-LGPL-opt-in, and is Vorbis-in-Ogg the only supported Vorbis
   output container?
7. **Should `audioTargetCanBypassFilterPlanner` (`audio-stream-plan.ts:36`) also short-circuit the
   `audio-encode-plan` load** so a codec/bitrate-only transcode touches neither the filter nor the encode
   planner beyond `buildAudioEncoderConfig`? Byte-budget tradeoff to log.
