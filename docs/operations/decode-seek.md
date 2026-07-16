# Decode & Seek

> Shard **S10** — benchmark family **`decode-seek`**.
> Owned code: [`src/api/replayable-video-decoder.ts`](../../src/api/replayable-video-decoder.ts),
> [`src/codecs/h264-avcc-crop.ts`](../../src/codecs/h264-avcc-crop.ts).
> This document is the **target spec** (the best design) plus an **honest delta** versus today's code.

## 1. Purpose & scope

The `decode-seek` family covers two operations that share one substrate — pulling **decoded
`VideoFrame`s** out of an encoded elementary stream, and **jumping to a target time** and landing on
the correct frame. The benchmark family exercises both
(`../media-test/src/scenarios/decode-seek/index.ts`):

- **`decodeFrames`** — pull frames and compare pixels to a golden with SSIM/PSNR tolerance. It spans
  the codec matrix (H.264/HEVC/VP8/VP9/AV1), the container matrix (mp4/mov/mkv/webm),
  **B-frame reorder** (output must be in presentation order), **VFR** timing, display-matrix rotation,
  non-default track selection, bit depth (8/10), and the SIZE ladder (tiny→small→medium→large→huge,
  ranked on `decodeFps`, higher-better, with `timeToFirstFrame` context).
- **`seek`** — jump to `options.tUs` and assert the landed frame via the `seek-accuracy` oracle
  (keyframe seeks land exactly; non-keyframe seeks land within tolerance). It covers the
  codec/container matrix plus the OP edges: seek-past-EOF, negative seek, backward seek, seek-to-0,
  repeated idempotent seek. Ranked on `seekMs` (ms/seek, lower-better — the family's headline metric).

**What the two owned files contribute to this family:**

1. `replayable-video-decoder.ts` is the family's **runtime capability-miss replay seam** (ADR-284): a
   bounded, one-shot-safe wrapper that lets a hardware/native VP8/VP9 decoder fail *after* it accepted
   the config but *before* it emitted its first frame, then restarts a WASM decoder from the exact
   packet prefix — the `WebCodecs → WASM (miss-only)` transition for decode, done without reopening the
   demuxer or copying bytes.
2. `h264-avcc-crop.ts` is a pure `avcC` SPS-crop rewriter that restores the true **visible width** of a
   coded surface an encoder padded for macroblock alignment. It keeps the produced H.264 stream
   *decodable and seekable at the right dimensions* — the correctness precondition for every downstream
   `decodeFrames`/`seek` on that output.

The **decoder itself** (`webcodecs-video.ts`, S30) and the **seek engine** (`api/engine.ts`, S05) live
in sibling shards; this doc cites them as context but does not own them.

## 2. Spec & references

Governing standards:

- **W3C WebCodecs — `VideoDecoder`.** <https://www.w3.org/TR/webcodecs/>
  - **Presentation-order output:** `decode()` emits "decoded outputs … *in presentation order*"; the
    NOTE states the UA reorders when the codec produces frames in a different (decode) order. This is
    the whole B-frame reorder contract — the consumer never sees decode order.
  - **Keyframe (sync) requirement for seek:** after `configure()`, `flush()`, or `reset()` "the next
    chunk passed to `decode()` **MUST** describe a key chunk"; a non-key first chunk throws
    `DataError`. This is *why* a seek must decode from the preceding sync sample.
  - **Backpressure:** `readonly attribute unsigned long decodeQueueSize` plus the `dequeue` event
    ("fired when `decodeQueueSize` has decreased") are the pacing primitives.
  - **Frame lifetime:** "Authors are encouraged to call `close()` on output `VideoFrame`s immediately
    when frames are no longer needed. The underlying media resources are owned by the `VideoDecoder`
    and failing to release them can cause decoding to stall."
  - `dequeue` event reference: <https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/dequeue_event>
- **WHATWG Streams** — backpressure / `highWaterMark` / `ReadableStream.cancel`.
  <https://streams.spec.whatwg.org/>
- **ISO/IEC 14496-15** — the `AVCDecoderConfigurationRecord` (`avcC`) byte layout this crop rewriter
  parses. <https://www.iso.org/standard/83336.html>
- **ITU-T H.264 / ISO/IEC 14496-10** — SPS `frame_cropping_flag` and
  `frame_crop_{left,right,top,bottom}_offset`, `ChromaArrayType`-derived `CropUnitX`, RBSP trailing
  bits, and Annex-B emulation-prevention (`0x000003`). <https://www.itu.int/rec/T-REC-H.264>

OSS exemplar — **remotion-webcodecs** (`@remotion/webcodecs`):

- Repo tree: <https://github.com/remotion-dev/remotion/tree/main/packages/webcodecs/src>
- `create-video-decoder.ts` — creates the `VideoDecoder`, wraps `output(frame)`/`error(error)`, applies
  backpressure through an `ioSynchronizer` (`waitForQueueSize`), and — notably — **`close()`s the frame
  in the output-callback `catch`** so a consumer error cannot leak the surface.
  <https://raw.githubusercontent.com/remotion-dev/remotion/main/packages/webcodecs/src/create-video-decoder.ts>
- `sort-video-frames.ts` — a `videoFrameSorter` that keeps a **small bounded queue** (reported as 5
  frames) and re-sorts by `timestamp` before releasing, i.e. remotion adds a *defensive* live reorder
  buffer on top of the UA's presentation-order guarantee.
  <https://raw.githubusercontent.com/remotion-dev/remotion/main/packages/webcodecs/src/sort-video-frames.ts>

**Where the SOTA design should match or beat the exemplar.** Remotion's `videoFrameSorter` is a hedge
against UA reorder bugs; aibrush deliberately does **not** carry a live reorder buffer (ADR-026,
`measured-evidence.md`) because a redundant reorder is either a no-op or unbounded, and the spec already
guarantees presentation order. We match remotion's per-frame `close()`-on-consumer-error discipline
(ADR-040, `measured-evidence.md`) and beat its backpressure by awaiting the native `dequeue` event instead of
polling (`measured-evidence.md` records the historical `setTimeout(0)` polling regression). We must *at least
tie* remotion on the two contested rows it wins today — `decode_extreme_fps_240` (remotion 2.79× faster,
`measured-evidence.md`) and `decode_vfr_timing` peak memory (remotion 107 MB vs our 672 MB, `measured-evidence.md`).

## 3. Target design

### 3.1 Data model & seams

- **Encoded input:** a pull-driven `ReadableStream<EncodedChunk>` (the container demuxer's packet
  stream, one shard up in S09). `EncodedChunk`/`EncodedVideoChunk` carries **only a presentation
  timestamp — never a DTS** (ADR-021/ADR-045, `measured-evidence.md`); decode order and B-frame composition are
  the container's/UA's job, which is why remux and keyframe-trim never route through the codec seam.
- **Decoder seam:** a `TransformStream<EncodedChunk, VideoFrame>`. The concrete decoder is produced by a
  factory the router hands in; **no layer above the codec adapter names a backend** (WebCodecs vs
  wasm-vpx). The replay wrapper's whole contract is expressed in factory terms:

  ```ts
  // src/api/replayable-video-decoder.ts:23-24
  type DecoderFactory = () => TransformStream<EncodedChunk, VideoFrame>;
  type AsyncDecoderFactory = () => Promise<TransformStream<EncodedChunk, VideoFrame>>;
  ```

  The async fallback factory is heavy (it downloads the WASM core) and is therefore **only awaited on a
  real miss** — never on the happy path.
- **Output:** a `ReadableStream<VideoFrame>` at `highWaterMark: 0`
  (`replayable-video-decoder.ts:306`) — strictly pull-driven, one frame in flight, so a slow consumer
  (a seek that stops the instant it lands) throttles the decoder rather than buffering surfaces.

### 3.2 Capability routing (WebCodecs → GPU → WASM, miss-only)

Decode routing is **hardware WebCodecs first, WASM only on a miss**, and the developer never selects it:

1. The router probes `VideoDecoder.isConfigSupported` per acceleration rung
   (`prefer-hardware` then `no-preference`) and caches the UA-accepted rung in a bounded LRU, running
   `configure()` + an empty `flush()` as a control-queue barrier before the first packet (ADR-203,
   `measured-evidence.md`; barrier cost measured 0.7–3.7 ms). Video maps `auto → prefer-hardware`; audio maps
   `auto → no-preference` (ADR-026).
2. **The gap this shard closes:** `isConfigSupported` can return `true` and then the decoder throws a
   *runtime* `CapabilityError` on the first coded packets — observed for some browser VP8/VP9 decoders
   (ADR-284, `measured-evidence.md`). A static probe cannot catch this. `decodeVideoWithRuntimeFallback`
   therefore retains a bounded packet prefix until the first native frame, and on a *typed, pre-first-
   frame* miss it swaps to the WASM decoder and replays the exact prefix.
3. There is **no software H.264/HEVC tail** (`measured-evidence.md`): an exact host miss for those codecs is a
   terminal typed `CapabilityError`, not a fallback. Only VPx (and, per the delta, AV1) have a WASM
   decode tail, so only they are eligible for replay. The caller enforces this at
   `codec-convert-runner.ts:278-280` (`/^vp(?:8|9|09)/` and not already pinned to `wasm-vpx`).

The replay is **failure-typed, not error-swallowing**: only a value matching the `CapabilityError`
shape — checked cross-realm/cross-ESM-chunk so the boundary survives independently bundled modules —
is eligible (`replayable-video-decoder.ts:28-39, 246-256`). Any other decode error, or a miss after the
first frame, is terminal because already-emitted frames cannot honestly be retracted.

### 3.3 Edge cases

- **B-frames / decode-order vs presentation-order.** The UA guarantees presentation-order output
  (ADR-026, `measured-evidence.md`); the replay seam adds **no reorder** — it forwards frames in the exact order
  the decoder emits and the tests pin it (`replayable-video-decoder.test.ts:78-79`: chunks `[9,41,89] →`
  frames `[9,41,89]`). No live reorder buffer is created (contrast remotion's `sort-video-frames.ts`).
  For **seek**, the target frame is reached by decoding forward from the preceding sync (key) sample —
  mandated by the WebCodecs key-chunk-after-configure rule — and discarding pre-target output.
- **VFR (variable frame rate).** Timing is carried per chunk (`EncodedChunk.timestamp`), so the seam is
  frame-rate-agnostic; replayed chunks preserve their exact original timestamps
  (`replayable-video-decoder.test.ts:118-` "replays the same immutable chunk references without a
  payload copy"). VFR seek must land on the **true PTS** of the target sample, not an assumed cadence
  (the family's `vfr-seek-lands-on-true-pts` invariant). The known VFR pain is *memory*, not timing:
  `decode_vfr_timing` passed the 12-frame oracle but peaked 672 MB vs a 107 MB rival, attributed to
  consumer-retained GPU-backed surfaces (~11.2 MB/frame), not driver queues (`measured-evidence.md`).
- **Seek.** Keyframe seeks must land **exactly**; non-keyframe seeks within tolerance
  (scenario `seek-accuracy`). Seek is the sharpest `cancel` case: the consumer `cancel()`s the instant
  it finds its target frame, so the decode graph must tear down without leaking the in-flight surface
  (ADR-040). H.264 seek output must keep a **Level-3.0 floor** or the platform `<video>` seek/decode
  path rejects tiny MP4s (ADR-084, `measured-evidence.md`). Seek pooling (`WarmVideoDecoderPool` in `engine.seek`,
  S05) won `seek_av1`/`seek_mkv` but `seek_negative` stays ~25% behind because it is moov-parse-bound,
  not decoder-bound (`measured-evidence.md`).
- **Cancel.** Every teardown path cancels the active reader **and** the source, once, and coalesces
  concurrent cancels into a single promise (`replayable-video-decoder.ts:212-225`,
  `teardownPromise` guard). The subtle case: a decoder-readable failure `cancel`s its *input* before the
  outer reader observes the failure; during the narrow pre-commit window the sole source reader is kept
  alive so the outer catch can replay it, and cancelled otherwise (`replayable-video-decoder.ts:148-166`,
  the `preserve` computation at `:153-156`).
- **Frame lifetime (`close()` exactly once).** The wrapper never double-closes and never leaks:
  - Frames the primary path emits before commit are handed through un-closed and closed exactly once by
    the consumer (`replayable-video-decoder.test.ts:82,113-115`).
  - If the stream has gone `terminal` when a stray frame surfaces, it is closed here
    (`replayable-video-decoder.ts:281-284`).
  - If `controller.enqueue` throws (consumer closed the readable), the frame is closed before rethrow
    (`replayable-video-decoder.ts:294-300`).
  - On abort, the controller errors and teardown cancels both readers
    (`replayable-video-decoder.ts:262-272`).
  This mirrors remotion's output-callback `frame.close()` on consumer error and ADR-040's
  `enqueueOrClose` guard.
- **Backpressure.** All internal streams use `highWaterMark: 0`
  (`replayable-video-decoder.ts:165, 200, 306`) so exactly one frame is pulled at a time; the decoder's
  own queue is the budget, paced by the `dequeue` event at the codec adapter (`webcodecs-video.ts:146`,
  `HIGH_WATER_MARK` at `webcodecs-video.ts:748`; ADR-026). Polling `decodeQueueSize` with `setTimeout`
  is a documented regression to never reintroduce (`measured-evidence.md`).

### 3.4 `avcC` visible-width crop (decode/seek correctness of produced H.264)

When an encoder pads the coded surface to a macroblock multiple (Apple's H.264 encoder pads an odd
visible width by 2 px), the out-of-band `avcC` must advertise the true visible picture via the SPS
crop, or every downstream decode/seek shows padding. `addH264AvcCVisibleRightCrop`
(`h264-avcc-crop.ts:15`) is a pure, asset-agnostic rewrite that changes **only**
`frame_crop_right_offset`: it strips emulation-prevention (`:142-155`), reads to the RBSP stop bit
(`:171-178`), walks every SPS syntax element up to the crop flag (`:53-105`) — including the High-profile
chroma/scaling-list path (`:59-72`) — adds `cropPixels / CropUnitX` to the right offset with
`CropUnitX` derived from `chroma_format_idc` (`:107-113`), rejects a crop that erases the picture
(`:115-116`), regenerates RBSP trailing bits, and re-applies emulation prevention (`:129, 157-169`).
`codedWidth` is then set to the visible width in the decoder config
(`webcodecs-video.ts:1305-1313`). The unit tests prove `856→854` (existing crop incremented) and
`864→862` (crop flag added) with PPS/extension bytes byte-identical (`h264-avcc-crop.test.ts:27-50`).

B-frames/VFR/seek/backpressure **do not apply** to this pure function — it is a synchronous byte
transform with no frames, streams, or timing.

## 4. Current state

### `src/api/replayable-video-decoder.ts` (bounded runtime-miss replay)

- Contract & caps documented in the module header (`:1-11`); one exported entry
  `decodeVideoWithRuntimeFallback(source, createPrimary, createFallback, options)` (`:45-50`).
- Retention caps: `MAX_REPLAY_PACKETS = 256` (`:16`), `MAX_REPLAY_BYTES = 16 MiB` (`:17`); crossing
  either cap commits the primary path without selecting WASM (`retainForReplay`/`dropReplay`
  `:118-133`).
- Commit point: the first primary frame drops the replay buffer and makes any later failure terminal
  (`:290-293`).
- Typed-miss guard is cross-realm/cross-ESM-chunk (`isCapabilityError` `:28-39`), gating
  `switchToFallback` (`:227-258`) via the `readOutput` catch (`:241-257`).
- Fallback input replays the retained prefix, then continues from the **same locked source reader** with
  no demuxer reopen and no byte copy (`fallbackInput` `:168-202`).
- Single-owner source reader with coalesced cancel/teardown (`:78-101, 103-116, 212-225`).
- Frame-lifetime guards: terminal-drop (`:281-284`), enqueue-failure close (`:294-300`), abort
  (`:262-272`).
- **Layering note (good):** zero backend/codec names appear in this file; it speaks only in
  factories and streams. The *policy* that only VP8/VP9 are eligible lives correctly one layer up at
  `codec-convert-runner.ts:278-299` (regex gate + `pinDriver: 'wasm-vpx'` fallback route).

### `src/codecs/h264-avcc-crop.ts` (pure `avcC` SPS crop)

- One exported function `addH264AvcCVisibleRightCrop` (`:15-42`); everything else is a private
  `BitReader` (`:207-250`) and bit/Exp-Golomb helpers (`:180-205`). Pure, no module-global mutable
  state, no I/O — a clean leaf.
- Correctly handles High-profile SPS extras (`HIGH_PROFILES` `:12`, chroma/scaling-list `:59-72`),
  chroma-derived `CropUnitX` (`:107-113`), and RBSP/emulation round-trips (`:118-169`).

### Smells / honest current-state observations

- **The seam is wired for exactly one codec.** `codec-convert-runner.ts:278-280` restricts replay to
  `/^vp(?:8|9|09)/`; AV1 (dav1d tail exists, `measured-evidence.md`) can hit the same accept-then-runtime-miss
  pattern but is not covered.
- **Fallback-target liveness is unproven in-repo.** The route targets `pinDriver: 'wasm-vpx'`
  (`codec-convert-runner.ts:291`); `wasm-vpx` *is* registered today (`drivers/defaults.ts:1240-1283`),
  but an older competitive-gaps note claimed the VPx fallback had no vendored core and was unregistered
  (`measured-evidence.md`). This contradiction must be resolved by an executed fail-first replay test — a real
  Chrome-149 run did **not** reproduce the native VPx miss and needed an injected `CapabilityError`
  (`measured-evidence.md`), so the fallback path is currently only test-exercised, never field-exercised.
- **No god-files, no module-global mutable caches** in either owned file. The one magic constant is the
  caller's hard `alignedWidth - visibleWidth !== 2` gate (`webcodecs-video.ts:1289`), which encodes an
  Apple-specific 2-px assumption in an otherwise general helper.
- **Family correctness FAILs recorded** (browser harness, `measured-evidence.md`): `decode_mov_h264` SSIM 0.854
  (a genuine `.mov` H.264 decode bug — 4 rivals pass) and `meta_pts_monotonic_after_reorder` yielded
  **no decoded frames after B-frame reorder**. Neither is in the owned files, but both live in this
  family and must be tracked.

## 5. Delta / punch-list

Ordered, each with a concrete acceptance oracle.

1. **Prove the VPx miss→WASM replay end-to-end with a real golden, not just a unit stub.**
   Today `replayable-video-decoder.test.ts` injects a synthetic `CapabilityError`; add an integration
   test that forces a VP9 primary runtime miss and asserts the `wasm-vpx` fallback yields the **exact
   golden frame digest** (bit/structural), and that `WasmVpxDriver.supports()` is `true` (vendored core
   present, ADR-032). *Accept:* fallback frames digest-match golden **and** the vendor pair check passes;
   fail loudly if `wasm-vpx` cannot load. Refs: `codec-convert-runner.ts:288-297`,
   `drivers/defaults.ts:1240-1283`, `replayable-video-decoder.ts:227-258`.

2. **Generalize the runtime-miss regex to every codec that has a WASM decode tail.**
   Replace `/^vp(?:8|9|09)/` (`codec-convert-runner.ts:280`) with a router-derived predicate that
   includes AV1 (`wasm-av1`) and *excludes* H.264/HEVC (no software tail — must stay terminal).
   *Accept:* parametrized test — an injected AV1 primary miss replays through `wasm-av1` and digest-
   matches golden; an injected H.264 miss surfaces a **terminal typed `CapabilityError`** with no
   fallback factory ever invoked. Refs: `codec-convert-runner.ts:278-299`, `measured-evidence.md` (no
   H.264/HEVC tail; dav1d AV1 tail).

3. **Cap decode-seek surface memory to at least tie the leanest rival.**
   `decode_vfr_timing` peaks 672 MB vs 107 MB (`measured-evidence.md`). The seam is already single-frame-in-flight
   (`replayable-video-decoder.ts:306`), so the peak is consumer-retained GPU surfaces. Add a documented
   single-owner frame contract and evaluate compact detachment — noting Chromium rejects explicit
   I420/NV12 `copyTo` and non-RGB natural-format `copyTo` (`measured-evidence.md`), so detachment must be RGBA (or
   a documented can't-beat with the ~11.2 MB/frame attribution). *Accept:* a fresh memory benchmark on
   `decode_vfr_timing` asserts peak RSS within tolerance of the leanest rival, **or** an ADR records the
   measured can't-beat with the surface attribution.

4. **Land the B-frame decode correctness bug.**
   `meta_pts_monotonic_after_reorder` yields **no decoded frames after B-frame reorder** and
   `decode_mov_h264` SSIM 0.854 (`measured-evidence.md`). *Accept:* both rows pass the frame-count and
   SSIM/PSNR oracle in the browser harness (frames emitted, monotonic presentation PTS, SSIM ≥ gate),
   proving the UA presentation-order path plus `.mov` avcC handling is correct end-to-end.

5. **Guarantee no `VideoFrame` leaks on the seek cancel-mid-decode race.**
   The ADR-040 enqueue-vs-close race is the seek killer. Add a leak test that starts a decode, cancels
   the output reader between the decoder's check and enqueue, and asserts **every produced frame is
   `close()`d exactly once** (reuse the `TestFrame.closeCount>1` throw pattern from
   `replayable-video-decoder.test.ts:16-19`). *Accept:* zero surfaces with `closeCount !== 1`; teardown
   promise resolves once. Refs: `replayable-video-decoder.ts:281-300, 212-225`; `measured-evidence.md` (ADR-040).

6. **Assert the `dequeue`-driven backpressure has no polling regression.**
   The historical `setTimeout(0)` `decodeQueueSize` poll cost hundreds of macrotasks (`measured-evidence.md`).
   *Accept:* a decode of N packets performs O(N) pulls with **zero** `setTimeout`-based queue polling
   (spy/counter), and in-flight decode requests never exceed `HIGH_WATER_MARK`
   (`webcodecs-video.ts:748`). Refs: `webcodecs-video.ts:146, 748`; `replayable-video-decoder.ts:306`.

7. **Decide and encode the reorder-buffer stance explicitly.**
   We trust the spec's presentation-order guarantee (ADR-026) and add no sorter; remotion hedges with a
   bounded `videoFrameSorter`. Keep the no-buffer default but add a *capability-flagged* bounded reorder
   only if a target UA is proven to violate presentation order. *Accept:* the existing order-preserving
   test (`replayable-video-decoder.test.ts:78-79`) stays green; a new browser B-frame golden proves the
   UA already yields presentation order (so the buffer is unnecessary) — logged as an ADR.

8. **Make the `avcC` crop delta data-driven instead of hard-coding `=== 2`.**
   `webcodecs-video.ts:1289` throws unless `alignedWidth - visibleWidth === 2`, baking Apple's 2-px pad
   into a general helper (which itself accepts any positive `cropPixels`, `h264-avcc-crop.ts:15-16`).
   Derive the crop delta from the encoder's coded-vs-visible width and validate divisibility by
   `CropUnitX` at the boundary. *Accept:* a property test over a range of aligned widths (delta divisible
   by `CropUnitX`) yields `parseH264SpsDimensions === visibleWidth`, and an odd delta on 4:2:0 rejects
   with the chroma-crop-unit error (already `h264-avcc-crop.test.ts:54`).

9. **Preserve the H.264 seek-compat Level floor on produced output.**
   Chromium accepts sub-L3.0 tiny H.264 encodes but the resulting MP4 fails the platform `<video>`
   seek/decode path (ADR-084, `measured-evidence.md`). *Accept:* a seek test on a tiny encoded MP4 drives the
   real platform seek/decode (not just a structural box check) and lands the target frame; assert the
   emitted codec string carries `level_idc = 0x1e` (e.g. `avc1.42E01E`). Owned by S30/S23 — tracked here
   because it is a `decode-seek` acceptance gate.

## 6. Open questions

Each seeds a record under `docs/decisions/`.

1. **Should runtime-miss replay cover AV1 (and any future WASM-tailed codec) generically?** Decide the
   router-derived eligibility predicate vs the current hard-coded VPx regex (delta #2), and confirm
   H.264/HEVC stay terminal.
2. **Is the VPx WASM fallback a live path or dead scaffold?** Reconcile the "unregistered/no core"
   competitive-gaps note against `defaults.ts:1240-1283` registering `wasm-vpx`; require an executed
   fail-first replay golden before claiming the miss path works (delta #1).
3. **Decode-seek surface memory — optimize or document can't-beat?** Given Chromium's `copyTo`
   restrictions, decide between RGBA compact detachment and an honest ADR-recorded can't-beat with the
   ~11.2 MB/GPU-frame attribution (delta #3).
4. **Reorder buffer: trust the spec forever, or ship a capability-flagged hedge like remotion?**
   Decide whether any shipping UA warrants a bounded `videoFrameSorter`, or ADR that ADR-026's
   no-buffer stance is permanent (delta #7).
5. **Seek decoder pooling vs ADR-203's rejection.** ADR-203 rejected a decoder pool (scarce hardware
   codecs, +memory, ~2–5 ms) but goal-26 added `WarmVideoDecoderPool` for `seek`. Decide the scope
   boundary (pool for `seek` only?) and address `seek_negative` being moov-parse-bound (needs lazy moov
   parse, not decoder pooling) (`measured-evidence.md`).
6. **`avcC` crop generality.** Should the 2-px assumption become a fully data-driven coded-vs-visible
   delta with a validated `CropUnitX`, and is right-only crop sufficient, or must top/bottom/left crop
   also be rewritable for non-Apple aligners (delta #8)?

---

*Cross-references: capability routing (S01), execution runtime & backpressure (S02), codec pipeline
(S13), WebCodecs adapter (S30), WASM tails (S31), MP4 driver (S23), public seek API (S05). Rescued
measured numbers and ADRs cited as `measured-evidence.md`.*
