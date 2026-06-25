# 09 — Per-Operation Design

> The design of each operation family: its strategy ladder, the benchmark insight that justifies it, data flow, edge cases, and the validation oracle. Ladders summarized in [`04`](04-capability-router-and-ladder.md); contracts in [`05`](05-driver-contracts.md). `[data]` → [`background/benchmark-summary.md`](background/benchmark-summary.md).

**Template:** *Goal · Ladder · Why (benchmark) · Flow · Edge cases · Oracle.*

## Shipped drivers & operations (as-built status)

This table is the completeness ledger — every first-party driver and op, with its **registration status**. "✅ auto" = in [`../../src/drivers/defaults.ts`](../../src/drivers/defaults.ts), so the zero-config engine routes to it on a capability miss (ADR-004/006). All first-party drivers are now auto-registered (mpegts/hls/wasm-opus/audio-dsp-filter were wired in after their ADRs landed). A separate "built but not yet wired into the public ops" caveat still applies to the **streaming-output** target (the CMAF writer + `StreamTarget` sink — see §streaming-output / ADR-034); that is an *op-routing* gap, not a driver-registration one.

**Container drivers** (`ContainerDriver`, hand-written TS). **Container-output** = whether the container can be a `convert`/`remux`/`encode` *target*, and by which mechanism — a chunk-seam `Muxer` (`createMuxer`, ADR-028/037), driver-native `streamCopy` (remux/trim, ADR-021), or the raw-PCM `transformPcm` path (ADR-022). Verified against each driver's actual `createMuxer`/`transformPcm` (a ❌ row's `createMuxer` throws a typed `mux-error`):

| Driver | `formats` | Ops it backs (optional methods) | Container-output | Registered |
|---|---|---|---|---|
| `mp4` | `mp4`, `mov` | probe/demux · `streamCopy` (remux + keyframe-trim, ADR-021) · `decrypt` (`cenc`/`cbcs`/`hls-aes128`, ADR-023) · `createMuxer` → `Mp4Muxer` (ADR-028) | ✅ chunk `Muxer` (`Mp4Muxer`) + `streamCopy` | ✅ auto |
| `webm` | `webm`, `mkv` | probe/demux · `createMuxer` → `WebmMuxer` (ADR-037) | ✅ chunk `Muxer` (`WebmMuxer`) | ✅ auto |
| `wav` | `wav` | probe/demux · `transformPcm` (gain/remix/**resample**, ADR-022) | ✅ PCM via `transformPcm` (no chunk `Muxer`) | ✅ auto |
| `aiff` | `aiff` | probe/demux · `transformPcm` (`writeAiff`, ADR-022) | ✅ PCM via `transformPcm` (no chunk `Muxer`) | ✅ auto |
| `caf` | `caf` | probe/demux · `transformPcm` (`writeCaf`, ADR-022) | ✅ PCM via `transformPcm` (no chunk `Muxer`) | ✅ auto |
| `ogg` | `ogg` | probe/demux · `createMuxer` → `OggMuxer` (ADR-037) | ✅ chunk `Muxer` (`OggMuxer`, page-laced) | ✅ auto |
| `mp3` | `mp3` | probe/demux | ❌ no mux (decode/transcode only) | ✅ auto |
| `flac` | `flac` | probe/demux · `decodePcm` (FLAC→WAV pure-TS decode, ADR-024) | ❌ no mux (FLAC encode = WASM tail) | ✅ auto |
| `adts` | `adts` | probe/demux | ❌ no mux (AAC encode needs the codec layer) | ✅ auto |
| `mpegts` | `ts`, `m2ts`, `mts` | probe/demux | ❌ no mux (TS mux not yet implemented) | ✅ auto |
| `avi` | `avi` | probe/demux | ❌ no mux (AVI mux not yet implemented) | ✅ auto |
| `hls` | playlist (`.m3u8`) | playlist parse / segment demux | ❌ n/a (playlist, not a muxable container) | ✅ auto |

> **Container-output legend.** ✅ = can be an output target now (via the noted mechanism); ⏳ = in flight; ❌ = not an output target yet (the `createMuxer` is a typed `mux-error` gap, never a half-working muxer — directive 6). **"Registered" vs "container-output" are independent axes:** all 12 container drivers are now auto-registered in `defaults.ts`; `mp3`/`flac`/`adts`/`mpegts`/`avi` are registered (probe/demux work) but are not yet output targets.

**Codec drivers** (`CodecDriver`). The WebCodecs pair is the `tier:'hardware'` head; the `tier:'wasm'` tail is **miss-only** (built only when WebCodecs lacks the codec). **The wasm tail is deliberately NOT in the default bundle (ADR-041)** — its self-hosted `.wasm` cores must be co-vendored alongside `dist` for the `import.meta.url` lazy load. The co-vendoring **script** now exists (`scripts/vendor-wasm.ts`, ADR-042); until the bundle wiring flips them on, the real cores are node-validated and reachable via an explicit `media.use(Wasm*Module)`:

| Driver | tier | Codecs / direction | Registered |
|---|---|---|---|
| `webcodecs-video` | `hardware` | H.264/HEVC/VP8/VP9/AV1 decode+encode by config (ADR-026) | ✅ auto |
| `webcodecs-audio` | `hardware` | AAC/Opus/MP3/FLAC/Vorbis decode+encode by config (ADR-026) | ✅ auto |
| `wasm-vorbis` | `wasm` | Vorbis **decode-only**, miss-only — Symphonia pure-Rust core **vendored + real** (ADR-036); encode → `CapabilityError` | ⚠️ node-validated; not in default bundle (ADR-041) |
| `wasm-aac` | `wasm` | AAC-LC mono/stereo **decode-only**, miss-only — Symphonia pure-Rust core **vendored + real** (ADR-039); SBR/HE/>2ch + encode → `CapabilityError` | ⚠️ node-validated; not in default bundle (ADR-041) |
| `wasm-mp3` | `wasm` | MP3 **decode-only**, miss-only — Symphonia pure-Rust core **vendored + real**; encode → `CapabilityError` | ⚠️ node-validated; not in default bundle (ADR-041) |
| `wasm-opus` | `wasm` | Opus decode+encode, miss-only — pure-TS framing ships, **C core is a recipe-scaffold** (`supports()→false` until built, ADR-031) | ⚠️ scaffold; not in default bundle (ADR-041) |
| `wasm-vpx` | `wasm` | VP8/VP9 **decode-only**, miss-only — pure-TS framing ships, **libvpx C core is a recipe-scaffold** (ADR-035) | ⚠️ scaffold; not in default bundle (ADR-041) |

**Filter drivers** (`FilterDriver`):

| Driver | substrate | `FilterSpec`s | Registered |
|---|---|---|---|
| `webgpu-video-filter` | `webgpu` | video resize/crop/rotate/flip (ADR-027) + colorspace/tonemap (ADR-032) | ✅ auto |
| `canvas2d-video-filter` | `canvas2d` | same geometric ops; colorspace only to the display space (ADR-027/032) | ✅ auto |
| `cpu-video-filter` | `wasm`* | **all six** video ops in pure-TS over `VideoFrame.copyTo` (geometry + genuine colorspace/tonemap, any gamut), the universal no-GPU floor (ADR-038) | ✅ auto |
| `audio-dsp-filter` | `wasm`* | audio resample/remix/gain over `AudioData` (ADR-033) | ✅ auto |

\* `substrate:'wasm'` is the least-wrong existing `FilterSubstrate` value for a pure-TS CPU filter (it must rank below the GPU substrates); a `'native'`/`'cpu'` `FilterSubstrate` is the proper future fit (a contract change, ADR-033/038).

**Operations** (public verbs, doc 07): `probe` · `demux` · `remux` (mp4 stream-copy, ADR-021) · `trim` (keyframe-aligned copy; frame-accurate = the decode/encode seam) · `decrypt` (`cenc`/`cbcs`/`hls-aes128`, ADR-023) · `convert`/`transcode` (auto-routes PCM-native ADR-022 → stream-copy ADR-021 → codec seam) · `decode` (lazy frame streams, ADR-030; FLAC via `decodePcm`; Vorbis/AAC/MP3 via the node-validated wasm tail, ADR-036/039) · `encode` (ADR-029/030) · `mux` (chunk `Muxer` for MP4/WebM/Ogg, ADR-028/037; PCM via `transformPcm` for WAV/AIFF/CAF) · `seek` (frame-accurate, ADR-026; close-race-safe, ADR-040). **Tier split (ADR-025):** the pure-TS ops are Node-validated — probe/demux/remux/keyframe-trim/decrypt/PCM-convert/FLAC-decode, plus the MP4/WebM/Ogg muxer timing+layout; the **WebCodecs/GPU codec-seam** ops (lossy `decode`/`encode`, `convert` re-encode, `seek`, GPU filters) run on the browser and are validated there; the **wasm-tail decodes** (Vorbis/AAC/MP3, real vendored cores) are Node-validated via a clean-process decode oracle but are **not in the default bundle** until browser `.wasm` co-vendoring lands (ADR-041).

---

## probe / metadata
- **Goal:** read container/track/codec/duration/tags without decoding.
- **Ladder:** TS header reader (range/bytes). No fallback needed; **never `<video>`**.
- **Why [data]:** mediabunny won 32/51 probe via a cheap `getDurationFromMetadata` header read; `platform` (HTMLMediaElement `loadedmetadata`) was 600–7000× slower. remotion-media-parser/mp4box also win here with pure-JS header parsing.
- **Flow:** `range(0, N)` the head → parse boxes (`ftyp/moov/mvhd/stsd`), EBML (WebM/MKV), `OggS` (Ogg), `fLaC` (FLAC), `RIFF…WAVE` (WAV) / `RIFF…AVI ` (AVI), `FORM…AIFF`/`AIFC` (AIFF), `caff` (CAF), MP3 frame-sync / ID3, ADTS sync, MPEG-TS `0x47` packet sync, HLS `#EXTM3U` playlist → `MediaInfo`. Read only what's needed (moov may be at the tail → one extra range read). All 12 container drivers are Node-validated against the real corpus (golden-metadata + ffprobe-truth goldens).
- **Edge cases:** moov-at-end MP4, headerless `MediaRecorder` WebM, VFR, rotation matrix, garbled ID3/ilst tags, multitrack, CENC (read clear metadata without touching encrypted mdat).
- **Oracle:** `golden-metadata` — exact container/codec/dims + ±1-frame duration.

## demux
- **Goal:** container → per-track encoded packet streams + `TrackInfo`.
- **Ladder:** TS streaming demuxer → WASM demuxer (exotic containers).
- **Why [data]:** mediabunny 19/43, ffmpeg.wasm 10 (mostly where it was simply present); pure-TS wins on latency/bundle/no-COOP.
- **Flow:** stream bytes → parse container → emit `EncodedVideoChunk`/`EncodedAudioChunk` per track (lazy, per-track `ReadableStream`).
- **Edge cases:** B-frame DTS↔PTS, VFR timing, multitrack selection, MPEG-TS PTS wraparound, HLS segment sequences, AAC-ADTS/MP3 frame sync; **graceful** on truncated/zeroed/header-destroyed/zero-length.
- **Oracle:** `golden-packets` — exact packet count, sizes, keyframe flags, 0µs PTS drift.

## decode + seek
- **Goal:** encoded packets → `VideoFrame`/`AudioData`; seek to a time.
- **Ladder:** WebCodecs **hardware** → WebCodecs **software** → WASM decoder.
- **Why [data]:** the WebCodecs trio (platform/mediabunny/web-demuxer) own decode-seek; hardware is fastest. Bit-exact decode wins are **GPU/platform-specific** (M1 ANGLE) → use `force-software` for cross-machine determinism.
- **Flow (seek):** find the keyframe at/just-before the target → `decoder.decode()` from there → discard frames before the target PTS → emit. Honor backpressure ([`06`](06-execution-and-runtime.md) §3).
- **Edge cases:** open-GOP, B-frame reorder, **VFR seek lands on the true PTS**, 10-bit (High10), VP9 alpha, 4K, 1×1/2×2 tiny dims, extreme fps (1, 240).
- **Oracle:** `decoded-frames-bitexact` (sha256 vs golden) where deterministic; else `ssim-psnr` with `exactFrames>0` (we reject `exactFrames==0`-only passes, ADR-018).
- **As built (ADR-026/030):** `WebcodecsVideoDriver`/`WebCodecsAudioDriver` (`tier:'hardware'`, codec-agnostic by config) are the decode tier; each coder is a `TransformStream` (configure on `start`, decode per `transform`, `flush()` on close). **No live B-frame reorder buffer** — `VideoDecoder` emits in presentation order per the W3C spec (the UA reorders), so the driver enqueues in arrival order; the pure `reorderByTimestamp`/`isPresentationOrdered` helpers are for *captured*-stream tests/tooling only. Hardware-first under determinism (`auto → 'prefer-hardware'` video / `'no-preference'` audio; `force-software → 'prefer-software'`). Backpressure awaits `dequeue` while `*QueueSize ≥ 8`. **`decode()`** returns the `{ video, audio }` frame streams *lazily* (the demux + codec routing runs on first pull; an undecodable track yields an empty stream, not an error). **`seek()`** scans packets for the last keyframe at/before the target (`startAtSeekKeyframe`), decodes from it, and `seekFrame` drops+`close()`s every earlier frame, returning the first at/after the target (caller-owned); seeking past EOF returns the closest (last) frame. Decoder output is owned by the readable consumer (closed once by it). Browser-validated (ADR-025); the pure helpers are Node-tested.

## encode
- **Goal:** raw frames → encoded chunks.
- **Ladder:** WebCodecs **hardware** → WebCodecs **software** → WASM encoder (codecs WebCodecs can't encode).
- **Why [data]:** remotion-webcodecs/mediabunny win on `encodeFps`; ffmpeg.wasm libx264/libopus is the fallback where WebCodecs lacks an encoder, but ~20–35× slower.
- **Flow:** configure encoder (codec/bitrate/crf/keyframe interval) → feed frames → emit chunks + a decoder config (`description`) for the muxer.
- **Edge cases:** gapless priming (AAC/Opus), fps up/down-conversion, CRF/two-pass/bitrate modes, forced keyframe interval, alpha (VP8/VP9), HDR.
- **Oracle:** re-decode the output and compare `ssim-psnr` (+ `playback-smoke`); structural `reference-reimport`.
- **As built (ADR-026/029/030):** the encoder is a `TransformStream<RawFrame, EncodedChunk>` that **consumes** each input frame — `encode()` then `close()` in a `finally`, so the frame closes exactly once even on throw/abort (doc 06 §3). The public-token→codec-string + `*EncoderConfig` mapping is pure (`codec-pipeline.ts`: `buildVideoEncoderConfig`/`buildAudioEncoderConfig`, default profiles e.g. `avc1.42E01E`, `mp4a.40.2`; an omitted codec preserves the source string). **Encoder→muxer config bridge (ADR-029):** the encoder publishes its `DecoderConfig` (codec string + `description`) on the first chunk's metadata; the additive, contract-untouched `VideoEncoderStageOptions.onDecoderConfig` / `AudioEncoderStageOptions.onConfig` sink hands it to the engine, which allocates the muxer track lazily on the first chunk (`drainEncoderToMuxer`). `keyFrameInterval` rides the same options object (GOP via `shouldKeyframe`). **`encode({})`** validates shape before muxing: no streams, or a stream with no matching target → `InputError` (after cancelling the unconsumed stream so no frame leaks); a non-chunk-muxable target (WAV) → `CapabilityError` (ADR-030). Browser-validated (ADR-025); the config/drain helpers are Node-tested with fake chunks.

## mux
- **Goal:** encoded packets + layout → a container byte stream.
- **Ladder:** TS muxer (MP4/WebM/Ogg/WAV/ADTS/TS) → WASM (containers not worth hand-writing).
- **Why [data]:** mediabunny dominates mux **46/52** — pure-TS muxers, `StreamTarget`, faststart, fragmented.
- **Flow:** `addTrack` per stream → `write` packets (preserving PTS/duration and B-frame `ctts`) → `finalize` (write `moov`/index). faststart = moov before mdat; fragmented = CMAF segments.
- **Edge cases:** B-frame composition offsets, multitrack, faststart-reserve vs in-memory, **illegal codec-in-container must reject** (e.g. H.264→WAV, VP9→ADTS), zero-track empty input → clean reject.
- **Oracle:** `reference-reimport` (re-demux output → exact tracks/packets/duration) + `mp4-box-layout` (moov/mdat order).
- **As built (ADR-028):** the `EncodedChunk`-seam `Muxer` is `Mp4Muxer` (`src/drivers/mp4/mux.ts`) over the validated `writeMp4` — MP4/MOV only (the other containers expose a typed mux miss; WAV output goes through `transformPcm`, ADR-022). It buffers each track's chunks in decode = arrival order and serializes the whole file on `finalize` (`output` is a one-chunk `ReadableStream`). **Codec boxes (`mapCodec`):** AVC/AAC synthesize `avcC`/`esds` from `description`; HEVC/AV1/VP9/Opus/FLAC carry `description` **verbatim** as `hvcC`/`av1C`/`vpcC`/`dOps`/`dfLa` (`codecPrivate`); an unknown codec is a typed `CapabilityError`. **Timing (`buildMuxSamples`, pure):** DTS = cumulative sum of decode-order durations; `ctts = (PTS − base) − DTS` computed in **µs first** (so a non-reordered stream is exactly `ctts==0` at any timescale, B-frame streams carry the true offset — version-1 `ctts` for negatives); PTS rebased to t=0; missing durations recovered from presentation gaps. Single-shot misuse and `fragmented:true` are typed errors. Only `write()`'s `EncodedChunk.copyTo` is browser-guarded; the timing + serialization are Node-validated via `addChunkStruct`.

## remux
- **Goal:** container → container, **stream-copy** (no re-encode).
- **Ladder:** demux(TS) → copy packets → mux(TS); WASM only for exotic containers.
- **Why [data]:** mediabunny 25 / ffmpeg.wasm 22 — close; pure-TS wins latency + no-COOP, ffmpeg wins where libav's container breadth helps.
- **Flow:** `demux` → pass `EncodedChunk`s straight into `mux` (no codec stages) → faststart optional.
- **Edge cases:** codec/container compatibility (codec must be legal in the target), rotation/metadata survival, headerless/truncated → graceful.
- **Oracle:** `reference-reimport`. **Anti-cheat note:** a real remux re-lays-out the container; do **not** ship the SUSPECT shortcut of flipping `ftyp` bytes and returning the input (ADR-018).

## trim
- **Goal:** cut a time range.
- **Ladder:** keyframe-aligned **packet-copy** (fast, lossless) or **frame-accurate** (decode the boundary GOP, re-encode the head, copy the rest).
- **Why [data]:** mediabunny 31/42 — pure-TS packet-copy; ffmpeg.wasm for some audio copy paths.
- **Flow (accurate):** locate GOP containing `start` → decode to `start` → re-encode `[start, next-keyframe)` → copy from there to `end`.
- **Edge cases:** B-frames, open-GOP, VFR, FLAC `STREAMINFO`/seektable repair, start/end past EOF, inverted/zero-length range, bitflipped/truncated source → graceful.
- **Oracle:** `trim-boundaries` (duration within tolerance) + boundary-frame digests for `accurate` (we prefer the stronger gate, ADR-018).

## convert (the headline op)
- **Goal:** produce a target container/codecs, applying filters; **auto-route** copy-vs-re-encode per stream.
- **Ladder:** per stage — demux(TS) → decode(WebCodecs hw→sw→WASM) → filter(GPU→WASM) → encode(WebCodecs hw→sw→WASM) → mux(TS).
- **Why [data]:** mediabunny 50/84 transcode via WebCodecs decode/encode + streaming mux; ffmpeg.wasm 19 where codecs/filters are browser-missing; remotion-webcodecs 9.
- **Auto-route:** if a stream already matches the requested codec/params → **stream-copy** (remux path); else re-encode. The developer doesn't choose (ADR-012).
- **Edge cases:** resize/crop/pad/rotate/flip, fps & bitrate/CRF/two-pass, colorspace 709↔2020, HDR→SDR tonemap, audio downmix/resample, container change, VP9 alpha keep, 10-bit; the 3 no-winner cases (FLAC source, HEVC-10-bit out, VP8 playback-smoke) [data: Finding 8].
- **Oracle:** `ssim-psnr` **with `exactFrames>0`** + mandatory `playback-smoke` (the benchmark's `h264_to_vp8` produced output that failed playback — we treat that as a fail). Strengthen to bit-exact for lossless/copy paths.
- **As built (ADR-026/027/028, routing in `engine.ts`):** `convert` tries paths in cost order. **(1) PCM-native** (ADR-022/024): `→ wav` with a PCM/no-codec audio target routes to the container's `transformPcm` (WAV) or `decodePcm` (FLAC) — no codec seam. **(2) Lossless stream-copy** (ADR-021/012): a pure container change with no re-encode (`isPureStreamCopy` — no dropped track, no filter/codec/dims/fps/bitrate/rate/channel change) routes to `streamCopy` when the source container supports the target. **(3) Codec seam:** otherwise demux → per-track decode (WebCodecs hw→sw) → optional GPU filter chain (video — `videoFilterSpecs` orders **crop→resize→rotate→flip**, ADR-027) → encode → `Mp4Muxer` (ADR-028). The output container must be chunk-muxable (MP4/MOV) or it is a typed `CapabilityError`. The auto-route decision is the developer's only invisible choice (ADR-012). The pure routing/config/filter-planning helpers (`codec-pipeline.ts`) are Node-tested; the live decode→filter→encode→mux is browser-validated (ADR-025).

## audio-dsp
- **Goal:** PCM format/endianness conversion, gain, fade, channel up/down-mix, resample, lossy encode.
- **Ladder:** TS for format/gain/mix/fade **and resample** (pure-TS band-limited windowed-sinc) → WASM for lossy encode. (A WASM **soxr** / WebAudio `OfflineAudioContext` resampler remains a possible future alternative, but is **not** needed — the TS resampler ships in-tier.)
- **Why [data]:** ffmpeg.wasm won audio-dsp 25/36 — but ~most are PCM format/endianness/gain/mix/fade, which are kilobytes of TS; **resample** is a few hundred more lines of exact TS (windowed-sinc), so only **lossy encode** genuinely needs WASM (Finding 4). We reclaim the cheap majority *and* resample in TS.
- **Flow:** parse PCM → transform samples (TS) → re-serialize. For raw-PCM containers (WAV) the engine takes the **PCM-native path** (ADR-022): `ContainerDriver.transformPcm` runs the TS kernels (`src/dsp`) in order **gain → remix → resample** and re-serializes, preserving the source sample-format — no codec seam, no browser. `convert(→ wav)` channel mix / format / **sample-rate** all ship here; only lossy encode raises `CapabilityError` until the WASM tail.
- **Edge cases:** s16/s24/f32, LE/BE, BS.775 downmix coefficients, upmix, variable channel count, empty audio, 5.1; resample of any ratio (44100↔48000, arbitrary target), equal-rate identity copy, zero-extended edges.
- **Oracle:** `decoded-audio-pcm` (sample-exact) for the lossless conversions (format/gain/mix); for **resample** — a band-limited (lossy) filter — `property-invariant` (frame-count/channels) plus a round-trip SNR floor; we push toward PCM-exact where the math is deterministic.
- **FLAC decode** is **pure TS** (ADR-024, `codecs/flac`), not the WASM tail: lossless integer Rice + fixed/LPC + decorrelation, exposed via `ContainerDriver.decodePcm` (FLAC → WAV). Validated **bit-exact** on the IETF FLAC conformance corpus via each file's STREAMINFO MD5 (the `flac --test` oracle). **Resample** is likewise pure-TS now (ADR-022); only lossy **encode** stays WASM-tail.
- **As built — the full pure-TS DSP kernel set (`src/dsp`, Node-validated):** beyond format-convert / `gain` / `remix` (BS.775) / `resample` (windowed-sinc), the kernels also include **`fade`** (`fadeIn`/`fadeOut`/`crossfade`, with `FadeShape` curves), **`dynamics`** (`limit`/`normalizePeak`/`normalizeRms`, `LimitMode`), and **`biquad`** (RBJ-cookbook `designBiquad`/`biquad` parametric EQ + `magnitudeResponse`/`polesInsideUnitCircle` stability checks) — all pure, deterministic, sample-tested in Node. **Wiring status:** `gain`/`remix`/`resample` are reachable via the public ops (container `transformPcm` for raw-PCM, and the `audio-dsp-filter` `AudioData` seam, ADR-033); **`fade`/`dynamics`/`biquad` are validated kernels but are not yet exposed through a public verb or filter spec** (no `FilterSpec` variant / `convert` option routes to them yet) — flagged so the doc does not over-claim reach.

## filters (video)
- **Goal:** pixel transforms — resize, crop, pad, rotate, flip, colorspace, tonemap.
- **Ladder:** WebGPU → Canvas2D → WASM (libavfilter). (The **WebGL rung is omitted**, ADR-027 — Canvas2D `drawImage` is GPU-accelerated and exact for the geometric ops, so it is the single fallback.)
- **Why:** GPU shaders run these faster than software libavfilter **and ship zero bundle** — reclaiming a chunk of ffmpeg's "coverage" for free (Finding 5/6). Geometric ops (flip/rotate90/crop) can be exact.
- **Flow:** `VideoFrame` → upload to GPU texture (or `OffscreenCanvas`) → shader → new `VideoFrame` (close the input).
- **Edge cases:** odd dimensions, fit modes (contain/cover/fill), 90/270 dim-swap, BT.709↔2020 matrices, PQ/HLG→SDR tonemap, alpha preservation.
- **Oracle:** `ssim` vs reference; exact digest for pure geometric transforms.
- **As built (ADR-027):** two `FilterDriver`s register — `webgpuVideoFilterDriver` (`substrate:'webgpu'`, primary) and `canvas2dVideoFilterDriver` (`substrate:'canvas2d'`, fallback); the **WebGL rung is omitted** (Canvas2D `drawImage` is GPU-accelerated and exact for the geometric ops). WebGPU samples one full-screen quad whose geometry is driven entirely by per-frame uniforms (`posScale`/`posOffset`/`uvScale`/`uvOffset`/`rot0`/`rot1`), so a single pipeline serves resize/crop/rotate/flip. Each filter is a `TransformStream<VideoFrame, VideoFrame>`; the renderer is built once on `start`, reused per frame, disposed on `flush`/abort. **Close-once:** each input `VideoFrame` is `close()`d in a `finally` right after the draw; a new output frame carries the source `timestamp`+`duration`. The geometry (`geometry.ts`: `Blit`/`Affine`, all dims integer ≥ 1, deterministic rounding) and uniform packing (`gpu-uniforms.ts`, std140, 48 bytes) are pure/Node-tested; the GPU/Canvas render is browser-validated (ADR-025). **Colorspace + tonemap are implemented (ADR-032)** via a second WGSL color pipeline that applies, per pixel, *decode-transfer → 3×3 linear-RGB gamut matrix → (tonemap operator) → encode-transfer*. The color science is pure/Node-tested in `gpu-uniforms.ts`: gamut matrices built from CIE xy primaries + D65 (reproducing the published constants bit-exactly — sRGB/709≡identity, the 709/2020 luma rows, 2020↔709), the sRGB / BT.709-2020 (BT.1886) / PQ (ST 2084) / HLG (BT.2100) transfer pairs (monotonic, black→0, peak→1, round-trip ≤1e-6), an extended-Reinhard tonemap normalized to the source peak (black→0, peak→1, monotonic, Hable available), and the `parseColorSpace`/`planColor` spec→pipeline selector. `supports()` is honest per substrate: WebGPU does colorspace + tonemap for all targets; Canvas2D does colorspace only to the display space (srgb/bt709) and declines wider-gamut + all tonemap (→ router falls through). The source colorspace / HDR transfer is read from the live `VideoFrame.colorSpace`. The pixel render is browser-validated (ADR-025).
- **As built (ADR-038) — the CPU fallback (`cpu-video-filter`, the universal no-GPU floor):** a third `FilterDriver` (`substrate:'wasm'`, ranked below the GPU rungs) that runs **all six** video ops in **pure TS** over `VideoFrame.copyTo(buf, {format:'RGBA', …})`, reusing the *same* validated math — geometry from `geometry.ts` and colour science from `gpu-uniforms.ts` (`eotf`/`oetf`/`applyMat3`/tonemap, the functions the WGSL shader mirrors). Because `copyTo`→`'RGBA'` returns the frame's pixels in the frame's **own** colour space (UA does only YUV→RGB, not display tone-management), the CPU path performs a **genuine** colorspace conversion to *any* target gamut and a **genuine** PQ/HLG→SDR tonemap — strictly more capable than Canvas2D for colour. So on a browser without WebGPU, wide-gamut colorspace + tonemap are no longer a miss — they route to this CPU driver. Close-once holds across the async `copyTo` (the source is fully read into the buffer before the await resolves, then `close()`d once in a `finally`); the output frame carries the source timing + an honest output `colorSpace`. The pure per-pixel transforms (`applyColorPlanToRgba`/`geometryToRgba` over a plain `RgbaImage`, no browser types) are **Node-validated to GPU parity** (≤1 LSB vs the independently-recomputed primitives — a falsifiable oracle); only the `copyTo`/`VideoFrame` glue is browser-only.

## encryption / decrypt
- **Goal:** CENC (`cenc`/CTR, `cbcs`) and HLS AES-128 sample decryption given keys; clean rejection of unsupported schemes.
- **Ladder:** WebCrypto AES-CTR/CBC + TS ISO-BMFF box parse (`tenc/senc/saiz/saio`) → for HLS, AES-128-CBC over TS segments.
- **Why [data]:** ffmpeg.wasm won `cenc-ctr`, mediabunny won `cbcs` (subsample pattern); both via real crypto, not canned output.
- **Flow:** parse protection boxes → derive per-sample IV/subsample map → `crypto.subtle.decrypt` → emit cleartext packets → optional remux. **`cenc`/AES-CTR, `cbcs`/AES-CBC-pattern, and `hls-aes128` are implemented driver-native** (ADR-023): `ContainerDriver.decrypt` parses `enca`/`tenc`/`senc`, decrypts samples (whole-sample for audio, subsample-aware for video), and re-serializes cleartext. `cbcs` applies AES-CBC over the protected ranges with the `tenc` crypt:skip block pattern (a per-protected-subsample CBC chain over the crypt blocks; skip blocks + trailing partial blocks stay clear; per-sample or `default_constant_IV`). `hls-aes128` (full-segment AES-128-CBC + PKCS#7, key+IV from `keys`) decrypts an MP4 segment as a unit (`src/crypto/hls-aes.ts` decrypts a raw TS/segment payload directly). A scheme that contradicts the container's `schm` rejects as a typed mismatch.
- **Edge cases:** subsample patterns (cbcs), per-sample IVs, zeroed/bitflipped/ truncated protection → graceful; **reject** unsupported schemes (`cens`, `sample-aes`, `clearkey`) with a clear error, not a crash.
- **Oracle:** `decrypt-bitexact` — decoded frames sha256-match a cleartext golden. Browser-free, we use the **stronger** sample-level gate: an encrypt→decrypt round-trip on real media recovers the sample bytes **bit-exact**, for `cenc` (AES-CTR), `cbcs` (AES-CBC pattern — 1:9, full 1:0, and a 5:5 cycle; whole-sample + subsample on real video bytes), and `hls-aes128` (a `node:crypto`-encrypted segment, an independent oracle) (+ anti-cheat: cipher≠clear, wrong-key≠clear; + NIST AES-CTR **and** AES-CBC vectors on the crypto core).

## streaming-output
- **Goal:** produce output incrementally with bounded memory (live/streaming targets).
- **Ladder:** TS muxer with a `StreamTarget` (incremental writes) → faststart in-memory/reserve → fragmented CMAF.
- **Why [data]:** mediabunny 18/27 — `StreamTarget` incremental writes, TS continuity, headerless WebM live. (These were among the few **freshly-measured** wins, so the perf is trustworthy.)
- **Flow:** mux writes chunks to a `WritableStream`/OPFS as they're produced; never hold the whole output.
- **Edge cases:** TTFB targets, faststart variants, fragment boundaries, TS continuity counters, headerless WebM, massive inputs.
- **Oracle:** `reference-reimport` + duration-materialized property.
- **As built (ADR-034):** the two halves of the streaming target ship as standalone, Node-validated units. (1) **CMAF / fragmented-MP4 writer** — `src/drivers/mp4/fragment.ts`, a generator `fragmentMp4(tracks, opts)` that yields an **init segment** (`ftyp` + a fragmented `moov`: empty `trak` sample tables + `mvex`/`trex` per track) then one **media segment** (`moof`(`mfhd`+`traf`: `tfhd`/`tfdt`/`trun`) + `mdat`) per fragment, so peak memory is bounded to one fragment. Per-track `tfdt` `baseMediaDecodeTime` is the running DTS (monotonic across segments); `trun` carries each sample's duration/size/flags/composition-offset (version-1 signed for B-frames); `default-base-is-moof` (`tfhd` flag `0x020000`), with `trun` data-offsets patched to the `mdat` payload. A video track also splits at every keyframe (`planFragmentRuns`) so each segment is independently decodable (the CMAF rule). Pure TS — reuses the `write.ts` box-writer style in its own file, edits nothing shared. (2) **`StreamTarget` sink** — `src/sinks/stream-target.ts`, writing each produced chunk incrementally to a caller-owned `WritableStream<Uint8Array>` (native backpressure via the executor's `runToSink`) or a `(chunk, position) => void | Promise` callback (position-aware for random-access OPFS), with typed-error mapping + `signal` cancellation. **Status — built + tested, not yet wired into the public ops.** The `Mp4Muxer` still rejects `fragmented:true` with a typed `CapabilityError` (mux.ts) and no driver/engine path calls `fragmentMp4` yet; `stream-target` is **not yet** a member of the engine's `Sink` union (`sink.ts`) and there is no `toStreamTarget` `to*` export wired through `materialize`. So the `fragmented`/CMAF + `StreamTarget` ops are not reachable through `convert`/`remux`/`encode` until that wiring lands — the writer + sink are the validated building blocks ahead of it (flagged, never over-claimed). The fragment writer's round-trip is Node-validated (`fragment.test.ts`: re-scan `moof`/`traf`/`trun`/`tfdt`+`mdat` reconstructs the exact sample list); the sink's backpressure/cancellation/error-mapping are Node-tested (`stream-target.test.ts`).

## robustness / negative
- **Goal:** never crash, never emit wrong output, on garbled/truncated/zeroed/bitflipped/empty inputs; correctly report unsupported.
- **Ladder:** the same op ladders, but the contract is **clean failure** — throw a typed `MediaError`/`InputError`, emit no output.
- **Why [data]:** mediabunny 31/60; image probes (jpeg/png/webp) are honest `NA` (out of scope).
- **Edge cases:** header-destroyed, tail-truncated, mid-file zeroed spans, bit-flips, zero-length, mislabeled container, 1×1 dims.
- **Oracle:** `graceful-failure` — **strengthened**: it is not enough to "not crash"; the engine must either produce a *correct* partial result or reject. Producing plausible-but-wrong output is a fail (ADR-018).
