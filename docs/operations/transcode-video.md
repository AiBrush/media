# Transcode — Video (S11)

> Target spec for the **video** side of the `transcode` benchmark family. This is the **best** design
> plus an honest delta versus today's code. Every code claim traces to `path:line`; every external
> claim to a spec/exemplar URL. Measured facts are cited to `(measured-evidence.md)`.
>
> Owned code (all under `src/api/`): `video-stream-plan.ts`, `video-frame-convert.ts`,
> `video-two-pass.ts`, `video-two-pass-runner.ts`, `vpx-alpha-pixels.ts`.

## 1. Purpose & scope

This shard owns everything between *decoded video frames* and *encoded video chunks* on a re-encode:
the **filter-chain plan**, the **CFR retiming** of a VFR source, the **rate-control decision**
(default / bitrate / CRF-quantizer / two-pass), **bit-depth** planning, the **H.264 ABR fan-out**
plan, the **8-bit pixel down-convert** stage, the **VPx alpha-plane** builder, and the **replay-backed
two-pass** orchestration. It does **not** own the WebCodecs adapters (S30), the GPU/CPU pixel filters
themselves (S18), the container muxers (S14/S23/S24), or decode/seek (S10) — it *plans* work those
layers execute.

It serves the `transcode` benchmark family, video half
(`../media-test/src/scenarios/transcode/index.ts`): the codec matrix
(`h264_to_hevc_mp4`, `h264_to_vp9_webm`, `av1_to_h264_mp4`, `av1_to_vp9_webm`, …), the transform rows
(`h264_resize_720p`, `h264_rotate_90_dimswap`, `h264_crop_center`, `h264_pad_letterbox_4x3_to_16x9`,
`h264_colorspace_709_to_2020`), the frame-rate rows (`h264_fps_30_to_15`, `h264_vfr_to_cfr_30`,
`h264_fps_30_to_60`, `extreme_fps_240`), the rate-control rows (`h264_bitrate_2mbps`,
`h264_crf_quality_mode`, `h264_two_pass_bitrate`), the depth rows (`h264_8bit_to_hevc_10bit`,
`h264_10bit_to_h264_8bit`), the alpha rows (`vp9_alpha_to_vp9_keepalpha`, `vp9_alpha_to_vp8_keepalpha`),
the B-frame rows (`bframe_reorder_h264_to_h264`, `bframe_reorder_h264_to_vp9`), and the ABR ladder
(`fanout_h264_abr_ladder`). The oracle for these rows is perceptual: `ssim-psnr` (default floors
`ssimMin 0.99 / psnrMinDb 40`, relaxed per-row — two-pass uses `ssimMin 0.95 / psnrMinDb 34`
`transcode/index.ts:772`) plus `playback-smoke` and, for rate-control rows, `transcode-output-metadata`
(`transcode/index.ts:45`).

**Non-goal for this shard:** stream-copy paths. Remux/trim never re-encode and route through
driver-native container copy, not this seam, because `EncodedVideoChunk` carries only a presentation
timestamp and *no DTS* — the frame seam cannot preserve decode order / B-frame composition (`ctts`)
(ADR-021, `measured-evidence.md`). Everything here assumes a genuine decode → (retime) → (filter) → encode.

## 2. Spec & references

Governing standards:

- **W3C WebCodecs** — `VideoEncoder`, `VideoEncoderConfig` (`codec`, `bitrate`, `bitrateMode`,
  `latencyMode`, `framerate`, `alpha`, `scalabilityMode`) and `VideoEncoderEncodeOptions.keyFrame`:
  <https://www.w3.org/TR/webcodecs/>. `bitrateMode: "quantizer"` and the per-frame codec-specific
  quantizer are the mechanism our CRF and two-pass paths ride on — see the explainer:
  <https://gist.github.com/Djuffin/3722232679b977058be787be0dff4254>.
- **WebCodecs codec registrations** (the per-codec `EncodeOptions`/quantizer fields and codec strings):
  AVC <https://www.w3.org/TR/webcodecs-avc-codec-registration/>,
  VP9 <https://www.w3.org/TR/webcodecs-vp9-codec-registration/>,
  AV1 <https://www.w3.org/TR/webcodecs-av1-codec-registration/>,
  HEVC <https://www.w3.org/TR/webcodecs-hevc-codec-registration/>.
- **Codec QP semantics** — H.264/HEVC QP range `[0,51]`, VP8/VP9/AV1 quantizer range `[0,63]`
  (ISO/IEC 14496-10; ISO/IEC 23008-2; VP9 <https://www.webmproject.org/vp9/>;
  AV1 <https://aomediacodec.github.io/av1-spec/>). Encoded in `crfBounds` (`video-stream-plan.ts:616`).
- **WHATWG Streams** — backpressure and cancellation for the retiming/encode `ReadableStream`s:
  <https://streams.spec.whatwg.org/>.

OSS exemplars studied:

- **mediabunny** `Conversion` / `VideoEncodingConfig`
  (<https://mediabunny.dev/guide/converting-media-files>, <https://github.com/Vanilagy/mediabunny>).
  Verified: its `VideoEncodingConfig` exposes `bitrate` (number *or* `Quality` preset),
  `bitrateMode: 'constant' | 'variable'`, `latencyMode: 'quality' | 'realtime'`, and a
  seconds-valued `keyFrameInterval` (default 2 s). It does **not** expose a `'quantizer'` bitrate mode
  and has **no** two-pass — for QP control a caller must drop to raw WebCodecs
  (verified via mediabunny docs, July 2026). aibrush's differentiators over it: quantizer-mode CRF
  (`video-stream-plan.ts:679`) and a *synthesized* two-pass (`video-two-pass.ts`).
- **remotion-webcodecs** `convertMedia()`
  (<https://www.remotion.dev/docs/webcodecs/convert-media>, <https://github.com/remotion-dev/remotion>).
  Verified: exposes `codec` + `bitrate` ("bits per second or a subjective quality") + `keyFrameInterval`;
  keeps the source frame rate when unspecified ("which may be variable"). `UNVERIFIED`: whether remotion
  performs any explicit VFR→CFR resampling — its docs only say it preserves the (possibly variable)
  input rate; our `retimeVideoFrameStream` is an *explicit* PTS-interval resampler
  (`video-stream-plan.ts:404`).

Where the SOTA design must beat them: neither exemplar offers quantizer-CRF or two-pass; we do both.
But mediabunny/remotion beat us today on raw encode wall on resize/rescale rows — the 4K→1080p resize
is a genuine ~11× loss traced to a Canvas2D `imageSmoothingQuality: 'high'` (bicubic) path that
starves the hardware queues, where mediabunny uses the browser default and a WebGPU resize is the fix
(`measured-evidence.md`; see §5).

## 3. Target design

### 3.1 Data model & seams

The pipeline is a chain of **pure plans** consumed by **browser-only executors**. The plans are plain
objects, fully Node-testable; the executors touch `VideoFrame`/`VideoEncoder` and are validated in the
browser harness.

| Plan (pure) | Produces | Executor (browser) |
|---|---|---|
| `videoFilterSpecs(target, src)` → `FilterSpec[]` (`video-stream-plan.ts:37`) | ordered GPU spec chain **crop → resize → pad → rotate → flip → colorspace → tonemap** | S18 GPU/CPU filters |
| `planCfrFrameRetiming(frames, {fps})` (`:333`) / `retimeVideoFrameStream` (`:566`) | CFR grid mapping / a restamped `VideoFrame` stream | the stream itself |
| `planVideoRateControl(target, codec)` (`:644`) | discriminated `VideoRateControlPlan` (`:585`) | *(see §4 — currently unconsumed)* |
| `planVideoBitDepthConversion(request)` (`:794`) | `none` / `downconvert` / `encoder-widen` (`:718`) | `canvasBackedVideoFrameStream` (`video-frame-convert.ts:42`) |
| `planH264TwoPass(firstPass, bitrate, dur)` (`video-two-pass.ts:201`) | per-picture QP schedule `quantizerForTimestamp` | `installH264TwoPassQuantizer` (`video-two-pass-runner.ts:70`) |
| `planH264AbrLadder(ladder, source)` (`video-stream-plan.ts:876`) | per-rung `VideoEncoderConfig` | worker pool fan-out (`engine.ts:649`) |
| `vpxAlphaI420From*` (`vpx-alpha-pixels.ts:75`,`:93`) | I420 plane carrying alpha in Y | libvpx alpha-track encode |

The single seam that fixes the encoder is `VideoEncoderConfig`, built once by
`buildVideoEncoderConfig` (`codec-pipeline.ts:1431`) from `outputDimensions` + rate config +
`videoLatencyMode`. Per-frame encode knobs ride `VideoEncoderStageOptions`
(`webcodecs-video.ts:651`): `keyFrameInterval`, constant `quantizer`, `rateControlWarmupFrames`,
`quantizerAt(frame)`, and `onDecoderConfig` (the encoder-published `VideoDecoderConfig` the muxer needs).

### 3.2 Capability routing (WebCodecs → GPU → WASM, miss-only)

The developer never names a backend. `buildVideoEncoderConfigForRuntime`
(`codec-pipeline.ts:969`, called at `video-two-pass-runner.ts:190`) resolves the codec string and the
router picks **hardware WebCodecs first**; a true miss raises a typed `CapabilityError`
(`video-two-pass-runner.ts:213`, `:329`; `video-stream-plan.ts:808`,`:840`). The three routing points
this shard drives:

1. **Encode** — WebCodecs `VideoEncoder`. On a codec/profile miss the router falls to a wasm encoder
   tail (S31: libvpx/AV1); today two-pass is H.264-only and *typed-misses* other codecs
   (`video-two-pass-runner.ts:209`).
2. **8-bit pixel down-convert** — the SOTA path is a WebGPU limited-range RGBA convert; the shipped
   `canvasBackedVideoFrameStream` (`video-frame-convert.ts:42`) is a **Canvas2D fallback** that must be
   reached only on a GPU miss (§5 item 5). It raises `CapabilityError` when no canvas surface exists at
   all (`:14`).
3. **VPx alpha** — the alpha plane is CPU-built from decoded RGBA/planar frames
   (`vpx-alpha-pixels.ts:93`) and encoded as a second libvpx track; there is no hardware alpha encode
   in WebCodecs, so this is a legitimate miss-only CPU/wasm path.

Codec identity must be a token, not a string prefix, at this layer — see §4/§5 for where that leaks.

### 3.3 Edge cases

**B-frames.** Two facets. *Input:* `VideoDecoder` emits frames in **presentation order** (the UA
reorders B-frames per the WebCodecs spec), so this shard never runs a reorder buffer — the two-pass
replay reads its QP schedule with an O(1) presentation-order cursor and a binary-search fallback for
out-of-order callers (`video-two-pass.ts:295`, `:270`), and `installH264TwoPassQuantizer` guards
against a duplicated PTS on replay (`video-two-pass-runner.ts:79`). *Output:* if the encoder emits
B-frames, DTS≠PTS and the muxer reconstructs `ctts`; because the encode seam has no DTS, B-frame order
is the muxer's job (ADR-021, `measured-evidence.md`), and the known VFR pitfall — cumulative rounded durations
pushing parsed PTS behind DTS by a tick late in a 626-frame VFR file — is a mux concern to guard
(ADR-191, `measured-evidence.md`; §5 item 7).

**VFR.** First-class. `planCfrFrameRetiming` and `retimeTimedFrameStream` retime on **source PTS
intervals, not source-index ratios**, so each frame is held for its true displayed duration; the final
grid frame is clamped to the source end so `Σ(durations)` equals the source duration exactly — a
22.507 s source at 1 fps keeps a short tail rather than over-running (`video-stream-plan.ts:331`,
`:371`, `:450`). Two-pass tolerates VFR by carrying each picture's real `durationUs`
(`video-two-pass.ts:115`) and weighting the budget by `duration^(1-0.6)` (`:231`). VFR *passthrough*
(no `target.fps`) emits no retimer and keeps native timestamps.

**Seek.** Not applicable — transcode consumes the whole stream start-to-finish. The two-pass "replay"
is a *fresh demux pass over a replayable source* (`analyzeH264TwoPass` re-demuxes,
`video-two-pass-runner.ts:167`, `:271`), not a keyframe seek; it therefore forbids single-use
`ReadableStream` sources with a typed miss (`:148`).

**Cancel.** An `AbortSignal` is threaded through `stageOptions(signal, options)` into every stage
(`video-two-pass-runner.ts:37`, `:240`). On abort/error the first-pass tear-down cancels the
first-pass, filtered, and decoded streams and closes the demuxer in a `finally`
(`video-two-pass-runner.ts:273`); the warmup encode loop checks `signal.aborted` per clone
(`webcodecs-video.ts:1470`). Cancellation surfaces as a typed `'aborted'` error and two-pass returns
`'aborted'` cleanly (`measured-evidence.md`).

**Frame lifetime (`close()` exactly once).** The retimer closes each **source** frame exactly once in
`processFrameInterval`'s `finally` after all its output duplicates are enqueued
(`video-stream-plan.ts:468`); output frames are **fresh** objects (`restamp` must return a new frame or
it throws, `:458`); on pull error, cancel, and read-error paths it closes pending outputs and the held
`previous` frame (`:541`, `:552`). `canvasBackedVideoFrameStream` closes the input frame in `finally`
(`video-frame-convert.ts:83`) and closes the output only if hand-off failed (`:80`). Together these
give exactly-once closure on both success and failure.

**Backpressure.** The retimer stream uses `highWaterMark: 0` and is fully pull-driven
(`video-stream-plan.ts:561`); the encoder awaits `drainBelowHighWater` at `HIGH_WATER_MARK = 16`
before every `encode()` and every warmup clone (`webcodecs-video.ts:938`, `:1462`,
`MAX_RATE_CONTROL_WARMUP_FRAMES = 16` `:687`). This bounds in-flight `VideoFrame`s regardless of source
size.

### 3.4 Rate control (the interesting part)

- **default** — no bitrate/CRF: the encoder picks. For H.264 with no explicit rate control the config
  selects `latencyMode: 'realtime'` (`codec-pipeline.ts:1095`), measured **28.9 %** faster on a real
  H.264 encode (2,259.5 → 1,606.2 ms) at identical config with SSIM dropping only 0.000362, and up to
  **46.6 %** on a 900-frame 1080p/30 control (`measured-evidence.md`). AV1/VP9 pick realtime only at ordinary
  cadence (`≤ 30.5 fps`, `:1106`). The implicit bitrate is `20` bits/pixel/second scaled by a
  per-codec efficiency factor (`h264 1, hevc 0.7, vp8 1.1, vp9 0.8, av1 0.6`,
  `codec-pipeline.ts:1130`), bounded by trustworthy source bitrate when a packet table proves it
  (`:1170`, `sourceVideoBitrateFromPacketTable:663` — DTS-based so B-frame/VFR cadence stays evidence).
- **bitrate** — `{mode:'bitrate', bitrate, bitrateMode}` (`video-stream-plan.ts:700`), default
  `'variable'`; H.264 ABR under-allocates its first pictures so implicit-average targets are primed with
  3 (or 8 above 30.5 fps) disposable warmup frames (`video-two-pass-runner.ts:51`).
- **CRF** — mapped to WebCodecs `bitrateMode: 'quantizer'` with the CRF value as the codec quantizer
  when the codec supports it (h264/hevc/vp9/av1; **vp8 does not**, `video-stream-plan.ts:639`,`:679`).
  Bounds validated per codec (`:616`).
- **two-pass** — the SOTA piece. WebCodecs exposes **no first-pass statistics API**, so a true
  rate-distortion two-pass is impossible (`measured-evidence.md`, ADR-105). Instead: pass one encodes at a
  **fixed QP 28** (`video-two-pass.ts:9`) as a complexity probe, reducing each picture to
  `{timestamp, bytes, keyFrame}` — nine bytes per picture packed as `Float64Array` PTS + `Uint8Array`
  QP (`:250`, `:289`). `planH264TwoPass` weights each picture by
  `duration^0.4 · bytes^0.6 · (keyFrame?1.15:1)` (`:231`), converts the per-picture byte budget to a QP
  via the six-QP-per-doubling model `2^((28−q)/6)` (`:166`,`:244`), smooths with a ±4 adjacent-QP slew
  (`:129`), and calibrates a global integer offset to hit the aggregate byte budget (`:184`). Pass two
  re-demuxes the replayable source and drives WebCodecs in quantizer mode via `quantizerAt`
  (`video-two-pass-runner.ts:78`). Proof golden: `transcode/h264_two_pass_bitrate` median 2,802.3 ms,
  deterministic SHA-256 `e768d3f0…814d`, `avc1.64001F` 1280×720, 810,678 payload bytes (`measured-evidence.md`).

## 4. Current state

What exists today, with the layering smells called out honestly.

- **`video-stream-plan.ts` is a 910-line god-file** bundling **five** unrelated concerns behind one
  filename: filter-spec building (`:37`), CFR retiming — *both* a pure planner (`:333`) *and* a
  streaming retimer (`:404`), rate-control planning (`:644`), bit-depth planning (`:794`), and ABR
  ladder planning (`:876`). Its own header comment describes it as "the pure builder that turns a
  `VideoTarget` into the ordered GPU `FilterSpec` chain" (`:1`) — which is only the first ~100 lines.
  The name and the doc-comment under-describe the file by 4/5.
- **`planVideoRateControl` is a parallel, unconsumed rate-control model.** Its discriminated union
  `VideoRateControlPlan` — including the `two-pass-bitrate` branch (`video-stream-plan.ts:607`) and its
  `firstPassQuantizer: 28` — is referenced **only** by the module itself and `codec-pipeline.test.ts`;
  no production caller consumes it (verified: `grep` finds no non-test importer). The *actual* encode
  path re-derives rate control three separate ways: `eagerVideoRateConfig` in `codec-pipeline.ts`
  (bitrate/default), `target.crf` passed straight as `quantizer` (`video-two-pass-runner.ts:353`), and
  the two-pass QP schedule (`video-two-pass.ts`). So the "planner" and the runtime it plans for have
  **drifted apart** and can silently disagree.
- **Two implementations of VFR→CFR that can drift.** `planCfrFrameRetiming` (pure, `:333`) is
  **test-only** — no production caller (verified). The engine consumes the *separate* streaming
  `retimeVideoFrameStream` (`engine.ts:1530`). They share some helpers (`cfrTimestampAt`,
  `cfrDurationAt`) but each has its own interval/clamp logic (`:294` vs `:429`), so the "pure oracle"
  does not actually test the code that ships.
- **Codec-identity leaks into the API orchestration layer.** `implicitRateControlWarmupFrames`
  string-sniffs `'avc1.'`/`'avc3.'`/`'av01.'` prefixes and hardcodes the `30.5` magic threshold and the
  `8`/`3` warmup counts (`video-two-pass-runner.ts:59`–`:67`); `analyzeH264TwoPass` gates two-pass by
  the same `avc1.`/`avc3.` string test (`:210`). Codec identity should arrive as a resolved
  `VideoCodec` token (`videoCodecToken`, `codec-pipeline.ts:529`), not be re-derived by
  `String.startsWith` in an api-layer runner.
- **Repeated lazy imports of the same module in one runner.** `video-two-pass-runner.ts` dynamically
  imports `codec-pipeline.ts` (`:189`, `:300`), `video-stream-plan.ts` (`:195`, `:313`), and
  `video-frame-convert.ts` (`:247`, `:370`) — each module `await import()`-ed twice, once per function,
  instead of a single hoisted loader. Heavy coupling (10+ symbols pulled from `codec-pipeline`) plus
  duplicated import sites.
- **The 8-bit down-convert path is a Canvas2D fallback masquerading as the primary path.**
  `canvasBackedVideoFrameStream` (`video-frame-convert.ts:42`) is RGBA8-only and CPU-bound; the
  historical `imageSmoothingQuality: 'high'` on this class of path caused a **12×** slowdown by starving
  the hardware queues (`measured-evidence.md`). It has no GPU-first sibling wired in front of it here.
- **`vpx-alpha-pixels.ts` is a per-pixel JS loop.** `vpxAlphaI420FromPackedRgba` copies alpha byte by
  byte in a `for x` inner loop (`:108`–`:116`). Correct and bit-exact (neutral 0x80 chroma, `:71`), but
  O(w·h) on the main thread on the alpha hot path.
- **Two-pass is H.264-only and undeclared as a feature.** `analyzeH264TwoPass` typed-misses any
  non-AVC target (`:213`), and the package does not declare a `'two-pass'` feature, so the public
  harness reports the row `NA_ENGINE` even though the standalone proof validates it (`measured-evidence.md`,
  ADR-105).

No module-global *mutable* singleton cache lives in this shard (the canvas in
`canvasBackedVideoFrameStream` is per-stream closure state, `video-frame-convert.ts:43`) — the smells
here are god-file, parallel/dead planners, and capability leaks, not shared mutable state.

## 5. Delta / punch-list

Ordered by leverage. Each item names the change, the `path:line`, and a concrete acceptance oracle.

1. **Make `planVideoRateControl` the single source of truth, or delete it.** Wire the encode path to
   consume `VideoRateControlPlan` (`video-stream-plan.ts:585`) instead of re-deriving rate control in
   `eagerVideoRateConfig` + `video-two-pass-runner.ts:353`; if not wired, remove the union and function.
   *Acceptance:* a Node test asserts, over a matrix of `{bitrate}`, `{crf}`, `{twoPass,bitrate}`, and
   `{}`, that the rate config actually handed to the encoder equals `planVideoRateControl(target,codec)`
   — and `grep` finds a **non-test** consumer of `planVideoRateControl`. Today both fail.

2. **Split the 910-line `video-stream-plan.ts` into single-concern modules:** `video-filter-plan.ts`
   (`videoFilterSpecs`, `videoFilterRouteCost`, `videoTargetPixelBoundaryBitDepth`), `video-cfr-retime.ts`
   (`planCfrFrameRetiming`, `retimeTimedFrameStream`, `retimeVideoFrameStream` + the `FrameTiming` types),
   `video-rate-plan.ts` (`planVideoRateControl`), `video-bit-depth-plan.ts`
   (`planVideoBitDepthConversion`), `video-abr-ladder.ts` (`planH264AbrLadder`).
   *Acceptance:* each new file exports one concern and is < 250 lines; `tsc`/biome green; no import
   cycle (`madge --circular src/api` clean); the existing `video-stream-plan.test.ts` assertions pass
   unchanged against the new module paths.

3. **Unify VFR→CFR so the pure oracle tests the shipping code.** Derive `retimeTimedFrameStream` from
   the same interval/clamp primitives as `planCfrFrameRetiming` (`video-stream-plan.ts:294` vs `:429`).
   *Acceptance:* a property test feeds ≥ 1,000 randomized strictly-increasing VFR timestamp sequences
   (including the 22.507 s @ 1 fps tail, `:331`, and a 30 fps→1 fps downsample) through both
   `planCfrFrameRetiming` and a `collect()` of `retimeTimedFrameStream`, asserting identical
   `(timestamp, duration, sourceIndex, duplicate)` tuples and `Σ(durations) == sourceDuration`.

4. **Remove codec-string sniffing from the runner.** `implicitRateControlWarmupFrames`
   (`video-two-pass-runner.ts:51`) and the two-pass gate (`:210`) must take a resolved `VideoCodec`
   token (or a capability descriptor), not raw string prefixes; move the `30.5`/`8`/`3` constants next
   to the codec they describe.
   *Acceptance:* `grep -nE "avc1\.|avc3\.|av01\.|startsWith" src/api/video-two-pass-runner.ts` returns
   zero hits; a unit test drives `{h264, av1@60, av1@30, vp9}` tokens and reproduces today's warmup
   counts (`8`/`3`/`8`/`undefined`).

5. **Route the 8-bit down-convert GPU-first; Canvas2D miss-only.** Put a WebGPU limited-range RGBA
   convert in front of `canvasBackedVideoFrameStream` (`video-frame-convert.ts:42`); reach Canvas2D only
   on a GPU miss, and never set `imageSmoothingQuality: 'high'`.
   *Acceptance:* on a GPU-capable harness context the down-convert path selects GPU (assert via a
   route-cost/telemetry probe); a grep proves no `'high'` smoothing on this path; the
   `h264_resize_4k_to_1080p` bench wall drops toward the mediabunny reference (~1.09 s vs the current
   ~11× loss, `measured-evidence.md`), with `ssim-psnr` still ≥ row floor.

6. **Hoist the duplicated dynamic imports in `video-two-pass-runner.ts`** (`:189/:300`, `:195/:313`,
   `:247/:370`) into one lazy loader shared by `analyzeH264TwoPass` and `encodeVideoStream`.
   *Acceptance:* an import-count spy shows each of `codec-pipeline`, `video-stream-plan`,
   `video-frame-convert` imported at most once per convert call; behavior unchanged (two-pass proof
   golden `e768d3f0…814d` still matches, `measured-evidence.md`).

7. **Guard VFR encoder→mux DTS/PTS drift.** The two-pass/CFR outputs feeding the muxer must not produce
   parsed `PTS < DTS` (the 626-frame VFR fixture pushed PTS 11 µs behind DTS by frame 17, ADR-191,
   `measured-evidence.md`).
   *Acceptance:* reuse `bench-session11-mp4-vfr-mux`'s oracle — reprobe the produced MP4 and assert
   zero `PTS<DTS` violations and one keyframe across the 626-frame VFR output.

8. **Add a two-pass budget-accuracy oracle.** `planH264TwoPass` computes `predictedBytes`
   (`video-two-pass.ts:249`) but nothing asserts the *actual* second-pass output lands near
   `targetBytes`.
   *Acceptance:* a browser proof on `transcode/h264_two_pass_bitrate` asserts actual video-payload bytes
   within ±10 % of `plan.targetBytes` **and** `ssim ≥ 0.95` (`transcode/index.ts:774`), matching the
   810,678-byte / 2 Mbps golden (`measured-evidence.md`).

9. **Make non-H.264 two-pass an explicit typed decision, not a silent single-pass.** Today
   `analyzeH264TwoPass` typed-misses non-AVC (`video-two-pass-runner.ts:213`); either land a real
   VP9/AV1 QP-schedule path (they support quantizer mode, `video-stream-plan.ts:639`) or keep the miss.
   *Acceptance:* `convert({video:{codec:'vp9', bitrate, twoPass:true}})` raises
   `CapabilityError('capability-miss')` with `op:'encode'`, `tried:['webcodecs-video']` — assert the
   typed error object, never a silently-downgraded single-pass output.

10. **Move VPx alpha-plane extraction off the per-pixel JS loop** (`vpx-alpha-pixels.ts:108`) to a
    wasm/GPU copy while preserving the bit-exact plane.
    *Acceptance:* the alpha-plane golden hash is unchanged (neutral-0x80 chroma, `:71`) and the
    `vp9_alpha_to_vp9_keepalpha` bench stays ≤ the current 17.49 ms win over mediabunny's 164.9 ms
    (`measured-evidence.md`).

## 6. Open questions

Each seeds a decision in `docs/decisions/`.

1. **Single rate-control planner?** Should `planVideoRateControl` (`video-stream-plan.ts:644`) or
   `eagerVideoRateConfig` (`codec-pipeline.ts:1208`) be the one source of truth, and which layer owns
   the two-pass/CRF/bitrate decision? (Blocks §5 item 1.) Log as an ADR.
2. **Declare `two-pass` (and depth `10bit-output`) as harness features?** The engine validates two-pass
   standalone but the public harness reports `NA_ENGINE` because the feature is undeclared
   (`measured-evidence.md`, ADR-105). Declare it and drop the NA boundary, or keep the sanctioned exemption?
3. **HEVC Main10 output** currently builds the exact `hev1.2.4.L120.B0` codec string but is
   `NA_BROWSER` (no portable 10-bit HEVC WebCodecs encode, `measured-evidence.md`). Adopt a wasm HEVC-10 encoder
   tail, or keep honest-NA?
4. **Are the `20` bits/pixel/second default and the efficiency table** (`codec-pipeline.ts:1130`)
   heuristics we trust, or should they be codec-registry/measured-driven? The VP9 over-allocation
   (~33 Mb/s at 1080p) was a real `av1_to_vp9_webm` loss before it was bounded by source bitrate
   (`measured-evidence.md`).
5. **CFR clamp policy.** The last-frame telescoping (`video-stream-plan.ts:381`) optimizes for
   *exact duration*. Should exact-*cadence* callers (fixed 1/fps everywhere) get an opt-in, or is
   exact-duration always correct for the harness duration tolerances?
6. **Should the pure `planCfrFrameRetiming` remain** once §5 item 3 unifies it with the streaming
   retimer, or does the streaming API subsume it entirely (deleting the parallel implementation)?
