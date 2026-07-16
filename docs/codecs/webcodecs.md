# WebCodecs Codec Tier (`webcodecs-video`, `webcodecs-audio`)

> Shard S30. Owned code: `src/codecs/webcodecs-video.ts`, `src/codecs/webcodecs-audio.ts`.
> This document is the **target spec** (the best design) plus an **honest delta** against today's code.
> Every factual claim traces to `path:line`, a cited external source, or `docs/measured-evidence.md` (`(measured-evidence.md)`).

## 1. Purpose & scope

The WebCodecs tier is the engine's **hardware-first** decode/encode backend: two codec-agnostic
`CodecDriver`s that wrap the browser-native `VideoDecoder`/`VideoEncoder` and `AudioDecoder`/`AudioEncoder`
as the contract's `TransformStream` seams. Both drivers declare `tier: 'hardware'`
(`webcodecs-video.ts:2064`, `webcodecs-audio.ts:641`) so the capability router ranks them first and only
falls to GPU/WASM on a miss.

- **`webcodecs-video`** drives H.264 (`avc1`/`avc3`), HEVC (`hvc1`/`hev1`), VP8, VP9 (`vp09`) and AV1
  (`av01`) by config — the driver never hard-codes a codec, it advertises RFC-6381 **prefixes**
  (`VIDEO_CODEC_PREFIXES`, `webcodecs-video.ts:261`).
- **`webcodecs-audio`** drives AAC (`mp4a.40.*`), Opus, MP3, FLAC and Vorbis by config
  (`AUDIO_CODEC_PREFIXES`, `webcodecs-audio.ts:184`) — subject to what the browser actually implements
  (`isConfigSupported` answers per-direction; e.g. no MP3/Vorbis **encode** anywhere, `(measured-evidence.md)`).

**Benchmark families served: `transcode` and `decode`.** These drivers are the codec engine inside every
decode→filter→encode transcode and every decode-seek row. They are the reason the substrate-win histogram
concentrates on WebCodecs — 67% of benchmark wins at zero bundle cost, measured **20–35× faster than
single-thread WASM** (`transcode/av_downmix_stereo_to_mono` mediabunny 2,598 ms vs ffmpeg.wasm 88,342 ms
≈34×; `bframe_reorder_h264_to_h264` ≈23.9×) `(measured-evidence.md)`. They deliberately do **not** own
remux/trim/mux: the `EncodedChunk` seam carries only PTS, so decode-order/DTS-sensitive work is a
container-layer concern (ADR-021, ADR-045, `(measured-evidence.md)`).

## 2. Spec & references

Governing standard — **W3C WebCodecs** and its per-codec registrations:

- WebCodecs (W3C Working Draft): <https://www.w3.org/TR/webcodecs/> — `VideoDecoder`/`VideoEncoder`,
  `AudioDecoder`/`AudioEncoder`, `VideoFrame`, `AudioData`, `EncodedVideoChunk`/`EncodedAudioChunk`,
  `isConfigSupported`, the `dequeue` event, `decodeQueueSize`/`encodeQueueSize`, and the presentation-order
  output guarantee.
- WebCodecs AVC (H.264) registration: <https://www.w3.org/TR/webcodecs-avc-codec-registration/> —
  `description` present ⇒ AVCC (`avcC`), absent ⇒ Annex-B; the per-frame `avc.quantizer` encode option.
- WebCodecs VP9 registration: <https://www.w3.org/TR/webcodecs-vp9-codec-registration/> — VP9 carries
  config in-band; the decoder makes no use of a `description` (mirrored by the exemplar, see below).
- Codec strings: RFC 6381 <https://www.rfc-editor.org/rfc/rfc6381>.
- MDN WebCodecs API (Worker note, secure context):
  <https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API>;
  `VideoDecoder.isConfigSupported` (normalized config, `TypeError` on invalid config):
  <https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/isConfigSupported_static>.
- Chrome WebCodecs best practices (Worker, `queueSize > 2` gating, transferable frames, prompt `close()`):
  <https://developer.chrome.com/docs/web-platform/best-practices/webcodecs>.

**OSS exemplar — the `platform` engine adapter** (the suite's raw-browser baseline / oracle helper):

- `../media-test/src/engines/platform/adapter.ts` — honest `capabilities()`; documents the *best* path
  (hardware WebCodecs, streaming, transferable frames, `decodeQueueSize > 2` gating, prompt `close()`),
  and the sources it is built against (`adapter.ts:30-56`).
- `../media-test/src/engines/platform/decode.ts` — `VideoDecoder` driver: `isConfigSupported` gate
  (`decode.ts:119`), submit-in-decode-order then `flush()`, **sort collected frames by PTS after flush**
  (`decode.ts:222`), `codecUsesDescription()` dropping the `description` for VP8/VP9 (`decode.ts:77`),
  and the null-codec `.trim()` guard (`decode.ts:60`).
- `../media-test/src/engines/platform/transcode.ts` — shows the *limit* of a naive platform transcode:
  MediaRecorder is lossy/real-time/container-bound and **cannot** accept opaque encoded chunks
  (`transcode.ts:1-15`). This is precisely what our `VideoEncoder`-based driver must beat.

Repo canonical URL for the exemplar: the `media-test` sibling project (`../media-test`).

**Where the SOTA design must beat the exemplar.** The exemplar decodes to a bounded array, sorts by PTS
after flush, and holds every `VideoFrame` live until digest — fine for an 8-frame oracle, fatal for a
streaming transcode. Our design is a true **streaming** `TransformStream` with a pull-driven output queue,
explicit backpressure, and close-exactly-once ownership transfer, so an unbounded source never balloons GPU
memory. We also add what the exemplar lacks: a **control-queue barrier** that proves configuration
succeeded before any packet is submitted (`(measured-evidence.md)` ADR-203/ADR-287), an in-driver hardware→software
acceleration fallback (recover software WebCodecs before paying a WASM download), and a **warm decoder
pool** for the sequential seek path.

## 3. Target design

### 3.1 Data model & seams

A coder **is** a `TransformStream` — the stream is the lifecycle: configure on `start`, process on
`write`/`transform`, drain on writable `close`/`flush`, release on `cancel`/`abort`
(`webcodecs-audio.ts:9-12`). The seam types come straight from the driver contract:

- decode: `TransformStream<EncodedChunk, RawFrame>` where `EncodedChunk = EncodedVideoChunk |
  EncodedAudioChunk` and `RawFrame = VideoFrame | AudioData` (`contracts/driver.ts:68-70`).
- encode: `TransformStream<RawFrame, EncodedChunk>`.
- `supports(query, opts)` returns `CodecSupport { supported, hardwareAccelerated?, reason? }`
  (`contracts/driver.ts:155-159`) and **never throws** — a bad/absent config resolves `{supported:false}`.

`EncodedVideoChunk`/`EncodedAudioChunk` are sealed and expose only `timestamp` (= PTS), **no DTS**; the
container↔codec seam therefore uses the `Packet` view (`{chunk, dtsUs?, alpha?, ...}`,
`contracts/driver.ts:89-100`, ADR-045) so B-frame decode order and VPx alpha side-data survive the seam.
That view is a container-layer concern; the codec driver only ever sees the sealed chunk.

### 3.2 Capability routing (WebCodecs → GPU → WASM, miss-only)

The developer **never names a backend or codec**. The router hands each driver a config; the driver answers
`supports()` from `isConfigSupported`, and constructs a coder only when it can serve it. A true miss is a
typed `CapabilityError('capability-miss', …, {op, tried})` (`contracts/errors.ts:50-56`), which the router
uses to advance the ladder (GPU filters / WASM tail) and which the harness degrades to a clean **NA** rather
than a page crash.

- **Hardware-first, software-permitting probe.** `supports()` probes acceleration in
  `ACCELERATION_PROBE_ORDER = ['prefer-hardware', 'no-preference']` (`webcodecs-video.ts:320`). A
  software-only encoder (VP8/VP9/AV1, and H.264/HEVC on some browsers) reports `prefer-hardware:false` but
  `no-preference:true`; probing hardware-only would wrongly NA a large share of the transcode matrix
  (`supportsEncode`, `webcodecs-video.ts:855-897`; `supportsDecode`, `:804-853`). `combineSupport`
  (`:342-349`) reports `hardwareAccelerated` **only** when the winning probe pinned `prefer-hardware`
  (honest — a software win is reported un-accelerated).
- **`force-software` determinism** pins `prefer-software` and accepts a hardware-tier result **only** with an
  explicit `hardwareAccelerated:false` verdict (`videoAccelerationProbeOrder`, `:323-327`;
  `codecSupport` audio, `webcodecs-audio.ts:447`), so native-only H.264/HEVC configs correctly miss under
  reproducible mode `(measured-evidence.md)`.
- **Configuration is proven, not assumed.** WebCodecs checks support asynchronously on the control queue, so
  returning from `configure()` is not proof of support `(measured-evidence.md)` ADR-287. The target runs
  `configure()` then an **empty `flush()`** as a control-queue barrier before writable startup resolves; a
  stale hardware verdict or async rejection deletes the cached verdict and proves the exact
  `no-preference` config **before any packet is submitted** (`configureDecoder`, `webcodecs-video.ts:1103-1107`;
  `configureSoftwareFallback`, `:1124-1147`). Measured startup barrier: **0.7–3.7 ms** across four real
  inputs `(measured-evidence.md)`.
- **Exact-config verdict cache.** A bounded LRU keyed by a structural canonicalization of the decoder config —
  including `description` bytes, geometry, colour, and the effective VPx alpha option
  (`videoDecoderCapabilityKey`, `:492-499`; `createVideoDecoderAccelerationCache`, `:513-544`) — lets a repeat
  same-config decode configure synchronously and skip re-probing.
- **Async runtime failure = capability miss.** A native decoder that fails *after* an `isConfigSupported`
  approval (WebKit throwing `EncodingError: "Decoder failure"` on streams it claimed to accept) is mapped by
  `decoderErrorToCapabilityMiss` (`webcodecs-video.ts:240-251`, `webcodecs-audio.ts:162-176`) to a
  `CapabilityError`, so the router can degrade to a WASM tail. ADR-284 additionally retains a bounded packet
  prefix so VP8/VP9 decoders that fault on the *first coded packet* still fall back `(measured-evidence.md)`.

### 3.3 Edge cases

**B-frames.** *No live reorder.* WebCodecs guarantees `VideoDecoder` emits in presentation order — the UA
reorders (spec note quoted in `webcodecs-video.ts:16-18`, ADR-026 `(measured-evidence.md)`,
<https://www.w3.org/TR/webcodecs/>). Sorting in-driver would be redundant **and** break streaming (an
unbounded buffer), so the live decoder enqueues in arrival order. `reorderByTimestamp`/
`isPresentationOrdered` (`:600-618`) are pure utilities for captured-stream tools/tests **only** — never on
the live path. (The exemplar sorts by PTS after `flush()` at `decode.ts:222` precisely because it collects a
bounded array; that is the non-streaming shortcut we must not adopt.) Decode-order/DTS for lossless remux is
carried by `Packet.dtsUs` at the container seam, not here (ADR-021/ADR-045).

**VFR (variable frame rate).** The driver is timestamp-driven and never assumes CFR: it passes each frame's
`timestamp` and nullable `duration` straight through. Rate-control warmup timing degrades gracefully when
`duration` is null (falls back to `framerate`, else 33,333 µs) rather than assuming a cadence
(`rateControlWarmupTimestamps`, `:704-725`). VFR native decode surface memory is dominated by
caller-retained frames, not the driver (`(measured-evidence.md)`: a 111-frame VFR decode's JS heap rose only
4,310,048→4,838,363 bytes while frames were retained).

**Seek.** Served by the **warm decoder pool** (`createWarmVideoDecoderPool`, `:1994-2051`): at most one
configured `VideoDecoder`, keyed by exact decode config; a same-config borrow **reuses** it (skipping
construct+configure+hardware-init); a different-config borrow closes+rebuilds; a borrow that arrives while
one is active is **refused** (`undefined`, `:2032`) so a decoder never serves two concurrent streams; the
caller then builds a fresh `createVideoDecoder`. A clean early-stop (a seek that found its target and
cancelled the reader) **drains** the pooled decoder with `flush()` and releases it **warm**; any error/abort
**discards** it (`cancelBorrow`, `:1853-1875`; `settleOnce`, `:1781-1787`). Evidence: Goal-26 seek pooling
won `seek_av1` ~+17% `(measured-evidence.md)`.

**Cancel.** Threaded through `StageOptions.signal` (`contracts/driver.ts:46`). Abort closes the WebCodecs
object and any in-flight frame and errors the readable with `aborted` (video `fail`/`cancelDecode`,
`:1010-1036`; encoder `dispose`, `:1343-1348`; audio `teardown`, `webcodecs-audio.ts:481-488`). Reader
cancellation reaches the transform's `cancel(reason)` hook (`TransformerWithCancel`, `:161-163`); a
non-`Error` reason is a clean stop, an `Error` reason is a failure. Startup awaits race a
`startupCancellation` promise so an abort during the configure barrier rejects promptly
(`awaitDuringStartup`, `:982-983`).

**Frame lifetime (every `VideoFrame`/`AudioData` `close()`d exactly once).** This is the rule that keeps the
harness page alive:

- *Encoder input* — the encoder **consumes** each input frame: `encode()` then `close()` in a `finally`, so
  it closes once even if `encode()` throws or we abort (video `:1507-1510`; audio
  `submitClosableAudioCodecInput`, `webcodecs-audio.ts:376-397`). Warmup/compensation clones are closed in
  their own `finally` (`:1489-1491`, `:1508`).
- *Decoder output* — frames stay **driver-owned** in an explicit `frameQueue` until a `pull` hands one to the
  consumer; on hand-off ownership transfers (the consumer closes it), and `enqueueOrClose` closes the frame
  if it loses the close→enqueue race (`:185-202`, audio `:111-128`). Cancel/error closes every frame still in
  the queue plus the WebCodecs object (`closeQueuedFrames`, `:991-993`). Encoded chunks are byte copies with
  no `close()`, so `enqueueOrDrop` simply drops them (`:213-225`).

**Backpressure.** Decode/encode submission awaits the native `dequeue` event while the codec's
`*QueueSize` is at/above a high-water mark, so in-flight frames stay bounded (`queueIsBackpressured`,
`:149-154`; `drainBelowHighWater`, `:932-941`; audio `awaitAudioCodecQueueDrain`,
`webcodecs-audio.ts:319-343`). The video decoder additionally bounds its **decoded-output** queue with the
same mark via `waitForOutputRoom` (`:1055-1062`), so decoded frames never pile up in GPU memory while a slow
consumer drains. Below the mark, audio submits **synchronously** to preserve exact native order without a
promise continuation per packet (`submitAudioCodecInput`, `:352-368`). Chrome's own guidance is to gate on
`queueSize > 2` (`adapter.ts:103`); we use a wider window (see §5, delta #2).

## 4. Current state

Both files are correct and richly commented, but carry structural debt.

**God-file: `webcodecs-video.ts` is 2,113 lines** and mixes six concerns that should be layers: (a) pure
helpers (`normalizeHardwareAcceleration` `:54`, `shouldKeyframe` `:85`, `videoEncodeOptions` `:132`); (b) the
whole structural config-key canonicalizer (`capabilityValueKey` `:439-485`, `directArrayBufferBytes`
`:422-436`); (c) the LRU verdict cache (`:502-588`); (d) the fresh decoder (`createVideoDecoder`,
`:945-1279`); (e) the fresh encoder incl. the Apple-H264 chroma-phase workaround (`createVideoEncoder`,
`:1316-1536`); and (f) the entire **warm decoder pool** (`:1540-2051`).

**Near-duplicate state machines.** `createWarmBorrowStream` (`:1721-1986`) re-implements almost the exact
pull-driven frame-queue / output-backpressure / close-exactly-once / typed-cancellation state machine of
`createVideoDecoder` (`:945-1279`) — two ~300-line copies whose only real difference is decoder lifetime
(release-warm vs close). Any fix to the frame-lifetime logic must currently be made twice.

**Cross-file copy-paste.** `enqueueOrClose`, `enqueueOrDrop`, `Closable`, `EnqueueSink`,
`TransformerWithCancel`, and `decoderErrorToCapabilityMiss` are defined **verbatim** in both
`webcodecs-video.ts` and `webcodecs-audio.ts` (confirmed by grep; e.g. `webcodecs-video.ts:161-225,240-251`
vs `webcodecs-audio.ts:87-150,162-176`). S30 owns both files, so this is a within-shard dedup.

**Module-global mutable state.** `const videoDecoderAccelerationCache = createVideoDecoderAccelerationCache()`
(`:546`) is a process-wide singleton LRU. Its doc comment claims it is "shared with the router's positive
driver cache" (`:501`) but it is a private module global, not injected — two engine instances share one
cache and it cannot be reset per-engine or in a test without reaching into module state.

**Capability/platform leak in the driver body.** The encoder reads `navigator.platform` inline (`:1333`) and
embeds a vendor-specific, codec-specific quirk — Apple H.264 one-pixel horizontal chroma-phase compensation
via an `OffscreenCanvas` re-draw plus an `avcC` right-crop rewrite (`needsAppleH264HorizontalPhase
Compensation` `:68-77`; `createVideoEncoder` `:1419-1461`; `decoderConfigWithVisibleRightCrop` `:1284-1314`).
Correct behavior, but ~80 lines of platform+codec special-casing living in the generic WebCodecs driver.

**Video/audio asymmetry (design divergence between siblings).**
- Backpressure marks differ and both differ from the doc: video `HIGH_WATER_MARK = 16` (`:748`), audio
  `BACKPRESSURE_THRESHOLD = 128` (`webcodecs-audio.ts:63`), while ADR-026 / doc 09 state the mark is **8**
  `(measured-evidence.md)`.
- The audio decoder has **no control-queue (empty-`flush`) barrier** and no in-driver hardware→software
  fallback: `createDecoder` calls `dec.configure(...)` and immediately decodes (`webcodecs-audio.ts:505,516`),
  so an `isConfigSupported`-approved-but-actually-unsupported config only fails at the `error` callback after
  packets are submitted. Video proves it up front.
- The audio decoder forwards output straight to the readable (`enqueueOrClose`, no explicit output queue,
  `webcodecs-audio.ts:495-497`), relying on the `TransformStream`'s own readable HWM rather than the explicit
  bounded output queue the video decoder uses.
- The two backpressure implementations are unrelated code: video's `drainBelowHighWater` is typed to
  `VideoDecoder | VideoEncoder` (`:932-941`); audio's is the generic `CodecQueueEventTarget`-based
  `awaitAudioCodecQueueDrain` (`webcodecs-audio.ts:319-343`).

**Doc-vs-code drift on the encoder accel hint.** ADR-026 says video maps `auto → 'prefer-hardware'`
`(measured-evidence.md)`, but `createVideoEncoder` configures with `normalizeHardwareAcceleration(auto) =
'no-preference'` (`:57`, `:1400-1404`). This is an intentional evolution — forcing the accepted
`prefer-hardware` hint measured *slower* (2,298.9 vs 2,278.5 ms) so hardware-hint caching was rejected
`(measured-evidence.md)` — but the ADR/doc was not updated to match.

## 5. Delta / punch-list (ordered)

1. **Extract one shared decoder core; make the warm pool a lifetime policy over it.** Factor the pull-driven
   frame-queue + output-backpressure + close-exactly-once + typed-cancellation machine out of both
   `createVideoDecoder` (`:945-1279`) and `createWarmBorrowStream` (`:1721-1986`) into a single builder
   parameterized by an "on clean EOF" action (`close` vs `flush+release`) and an "on error" action
   (`close` vs `discard`).
   *Acceptance:* the existing Node frame-lifetime/backpressure/cancel tests for **both** the fresh decoder and
   the warm pool pass against the unified core unchanged; a coverage/dup check (or an AST/`jscpd` gate)
   asserts the two paths share the queue code (no second copy of `deliverQueuedFrame`/`finishReadableIfDrained`).

2. **Reconcile the backpressure policy into one documented constant.** Pick one high-water mark (or one
   per-media rationale grounded in a fresh benchmark), apply it to video (`:748`) and audio
   (`webcodecs-audio.ts:63`), and update ADR-026/doc 09 (currently "8") to match.
   *Acceptance:* a benchmark over ≥3 real transcode inputs shows the chosen mark is within noise of the best
   sampled mark; `queueIsBackpressured`/`shouldApplyBackpressure` unit tests assert the new value; the doc and
   the constant agree (grep gate).

3. **Deduplicate the cross-file helpers.** Move `enqueueOrClose`, `enqueueOrDrop`, `Closable`, `EnqueueSink`,
   `TransformerWithCancel`, and `decoderErrorToCapabilityMiss` into one shared module imported by both drivers
   (both files are S30-owned).
   *Acceptance:* each symbol is defined exactly once (grep shows a single `export function enqueueOrClose`);
   the existing Node unit tests for these helpers still pass importing from the shared module.

4. **Inject the acceleration verdict cache; remove the module global.** Replace the `videoDecoder
   AccelerationCache` singleton (`:546`) with a cache owned/passed by the engine (or router), so two engine
   instances are isolated and tests can supply a fresh cache.
   *Acceptance:* a test constructs two decoder factories with independent caches and asserts a verdict set in
   one is **not** visible in the other; no top-level `createVideoDecoderAccelerationCache()` call remains
   (grep gate).

5. **Give audio decode the control-queue barrier (config-proof before first packet).** Add an empty-`flush()`
   barrier after `configure()` in `webcodecs-audio.ts:createDecoder` so an approved-but-unsupported config
   fails as a `CapabilityError` before any `EncodedAudioChunk` is submitted, matching the video path.
   *Acceptance:* an injected fake `AudioDecoder` that accepts `configure` but rejects on the barrier flush
   makes the readable reject with `CapabilityError('capability-miss')` and emits **zero** `AudioData`; a
   passing-config case still decodes normally.

6. **Bound audio decoded-output explicitly (or document why the readable HWM suffices).** Either add the video
   decoder's `waitForOutputRoom` output-queue bound to audio, or add a doc note + test proving a fast
   `AudioDecoder` + slow consumer cannot accumulate unbounded `AudioData`.
   *Acceptance:* a Node test drives the audio decode path with a decoder that emits N frames ahead of a paused
   consumer and asserts buffered `AudioData` count stays ≤ the chosen bound and every frame is closed exactly
   once.

7. **Isolate the Apple-H264 chroma-phase quirk behind a seam; stop reading `navigator` in the driver body.**
   Move `needsAppleH264HorizontalPhaseCompensation` + the canvas re-draw + `avcC` crop rewrite behind an
   injectable "encoder input adaptor" whose platform input is passed in, not read from global `navigator`
   (`:1333`).
   *Acceptance:* `needsAppleH264HorizontalPhaseCompensation` unit tests still pin the width ≡ 2 (mod 4) + Apple
   platform rule; the encoder core has no reference to `navigator`; a test injects `platform:'MacIntel'` and
   asserts the compensated wire width (`config.width + 2`) and the rewritten crop, and `platform:'Win32'`
   asserts the zero-copy path.

8. **Update ADR-026/doc 09 for the encoder accel hint.** Record that the encoder configures `auto →
   'no-preference'` (not `'prefer-hardware'`), citing the session13 measurement, and add an ADR in
   `docs/decisions/`.
   *Acceptance:* the doc statement matches `normalizeHardwareAcceleration` (`:54-58`) and the encoder
   `configure` call (`:1400-1404`); the ADR cites the 2,298.9-vs-2,278.5 ms evidence.

9. **Consider splitting `webcodecs-video.ts` by concern** (config-key/cache, fresh coders, warm pool) once #1
   lands, to retire the 2,113-line god-file.
   *Acceptance:* no single S30 source file exceeds a stated size budget (e.g. 1,000 lines); public exports and
   the driver `id`s are unchanged (import-surface test green).

## 6. Open questions (seed `docs/decisions/`)

- **Q1 — one backpressure mark or two?** Is there a real, benchmarked reason for audio (128) to differ from
  video (16), or should both be one constant? The doc/ADR say 8; none of the three agree today. Decide and
  log with fresh evidence (delta #2).
- **Q2 — where should the acceleration verdict cache live?** Engine-scoped, router-owned, or a shared
  injectable? The comment already claims it is "shared with the router's positive driver cache" (`:501`) but
  the code keeps a private global — resolve the ownership and record it (delta #4).
- **Q3 — should audio decode gain the in-driver hardware→software fallback**, or is a clean capability-miss →
  router → WASM tail the correct layering for audio (which already configures `no-preference`)? Video does the
  in-driver recovery to avoid a premature WASM download; audio may not need it. Log the decision (relates to
  delta #5).
- **Q4 — does the Apple-H264 chroma-phase workaround belong in the WebCodecs driver at all**, or in a codec
  post-processing layer / the `h264-avcc-crop` module it already calls? Decide the home for vendor-specific
  pixel/`avcC` fix-ups (delta #7).
- **Q5 — latencyMode default ownership.** Implicit `latencyMode:'realtime'` cut the H.264 encoder wall
  28.9–46.6% at near-identical SSIM `(measured-evidence.md)`, but this driver passes the caller's `wireConfig` through
  and does not default it (`:1400-1404`). Confirm the planner (S11/S13) owns this and the codec driver must
  stay mechanism-only, or record an exception.
- **Q6 — VP8/VP9 `description` handling.** The exemplar explicitly drops the `description` for VP8/VP9
  (`decode.ts:77`) because a WebM `CodecPrivate` is not a WebCodecs description and corrupts the config. Our
  driver normalizes VPx **alpha** (`normalizeVideoDecoderConfig`, `:296-308`) but does not scrub a stray VPx
  `description`. UNVERIFIED: whether our upstream demuxers can ever hand a VPx `description` to this driver; if
  they can, add the same drop and a test. Log the decision.
