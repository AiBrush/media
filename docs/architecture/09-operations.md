# 09 — Per-Operation Design

> The design of each operation family: its strategy ladder, the benchmark insight that justifies it, data flow, edge cases, and the validation oracle. Ladders summarized in [`04`](04-capability-router-and-ladder.md); contracts in [`05`](05-driver-contracts.md). `[data]` → [`background/benchmark-summary.md`](background/benchmark-summary.md).

**Template:** *Goal · Ladder · Why (benchmark) · Flow · Edge cases · Oracle.*

---

## probe / metadata
- **Goal:** read container/track/codec/duration/tags without decoding.
- **Ladder:** TS header reader (range/bytes). No fallback needed; **never `<video>`**.
- **Why [data]:** mediabunny won 32/51 probe via a cheap `getDurationFromMetadata` header read; `platform` (HTMLMediaElement `loadedmetadata`) was 600–7000× slower. remotion-media-parser/mp4box also win here with pure-JS header parsing.
- **Flow:** `range(0, N)` the head → parse boxes (`ftyp/moov/mvhd/stsd`), EBML (WebM/MKV), `fLaC`/`OggS`/`RIFF`/MP3-frame/ADTS → `MediaInfo`. Read only what's needed (moov may be at the tail → one extra range read).
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

## encode
- **Goal:** raw frames → encoded chunks.
- **Ladder:** WebCodecs **hardware** → WebCodecs **software** → WASM encoder (codecs WebCodecs can't encode).
- **Why [data]:** remotion-webcodecs/mediabunny win on `encodeFps`; ffmpeg.wasm libx264/libopus is the fallback where WebCodecs lacks an encoder, but ~20–35× slower.
- **Flow:** configure encoder (codec/bitrate/crf/keyframe interval) → feed frames → emit chunks + a decoder config (`description`) for the muxer.
- **Edge cases:** gapless priming (AAC/Opus), fps up/down-conversion, CRF/two-pass/bitrate modes, forced keyframe interval, alpha (VP8/VP9), HDR.
- **Oracle:** re-decode the output and compare `ssim-psnr` (+ `playback-smoke`); structural `reference-reimport`.

## mux
- **Goal:** encoded packets + layout → a container byte stream.
- **Ladder:** TS muxer (MP4/WebM/Ogg/WAV/ADTS/TS) → WASM (containers not worth hand-writing).
- **Why [data]:** mediabunny dominates mux **46/52** — pure-TS muxers, `StreamTarget`, faststart, fragmented.
- **Flow:** `addTrack` per stream → `write` packets (preserving PTS/duration and B-frame `ctts`) → `finalize` (write `moov`/index). faststart = moov before mdat; fragmented = CMAF segments.
- **Edge cases:** B-frame composition offsets, multitrack, faststart-reserve vs in-memory, **illegal codec-in-container must reject** (e.g. H.264→WAV, VP9→ADTS), zero-track empty input → clean reject.
- **Oracle:** `reference-reimport` (re-demux output → exact tracks/packets/duration) + `mp4-box-layout` (moov/mdat order).

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

## audio-dsp
- **Goal:** PCM format/endianness conversion, gain, fade, channel up/down-mix, resample, lossy encode.
- **Ladder:** TS / AudioWorklet for format/gain/mix/fade (cheap) → WebAudio `OfflineAudioContext` or WASM **soxr** for resample → WASM for lossy encode.
- **Why [data]:** ffmpeg.wasm won audio-dsp 25/36 — but ~most are PCM format/endianness/gain/mix/fade, which are kilobytes of TS; only true **resample** and **lossy encode** genuinely need WASM (Finding 4). We reclaim the cheap majority in TS.
- **Flow:** decode/parse PCM → transform samples (TS) or run resampler → encode/mux.
- **Edge cases:** s16/s24/f32, LE/BE, BS.775 downmix coefficients, upmix, variable channel count, empty audio, 5.1.
- **Oracle:** `decoded-audio-pcm` (sample-exact) for lossless conversions; `property-invariant` (channels/duration) for lossy — we push toward PCM-exact where math is deterministic.

## filters (video)
- **Goal:** pixel transforms — resize, crop, pad, rotate, flip, colorspace, tonemap.
- **Ladder:** WebGPU → WebGL → Canvas2D → WASM (libavfilter).
- **Why:** GPU shaders run these faster than software libavfilter **and ship zero bundle** — reclaiming a chunk of ffmpeg's "coverage" for free (Finding 5/6). Geometric ops (flip/rotate90/crop) can be exact.
- **Flow:** `VideoFrame` → upload to GPU texture (or `OffscreenCanvas`) → shader → new `VideoFrame` (close the input).
- **Edge cases:** odd dimensions, fit modes (contain/cover/fill), 90/270 dim-swap, BT.709↔2020 matrices, PQ/HLG→SDR tonemap, alpha preservation.
- **Oracle:** `ssim` vs reference; exact digest for pure geometric transforms.

## encryption / decrypt
- **Goal:** CENC (`cenc`/CTR, `cbcs`) and HLS AES-128 sample decryption given keys; clean rejection of unsupported schemes.
- **Ladder:** WebCrypto AES-CTR/CBC + TS ISO-BMFF box parse (`tenc/senc/saiz/saio`) → for HLS, AES-128-CBC over TS segments.
- **Why [data]:** ffmpeg.wasm won `cenc-ctr`, mediabunny won `cbcs` (subsample pattern); both via real crypto, not canned output.
- **Flow:** parse protection boxes → derive per-sample IV/subsample map → `crypto.subtle.decrypt` → emit cleartext packets → optional remux.
- **Edge cases:** subsample patterns (cbcs), per-sample IVs, zeroed/bitflipped/ truncated protection → graceful; **reject** unsupported schemes (`cens`, `sample-aes`, `clearkey`) with a clear error, not a crash.
- **Oracle:** `decrypt-bitexact` — decoded frames sha256-match a cleartext golden.

## streaming-output
- **Goal:** produce output incrementally with bounded memory (live/streaming targets).
- **Ladder:** TS muxer with a `StreamTarget` (incremental writes) → faststart in-memory/reserve → fragmented CMAF.
- **Why [data]:** mediabunny 18/27 — `StreamTarget` incremental writes, TS continuity, headerless WebM live. (These were among the few **freshly-measured** wins, so the perf is trustworthy.)
- **Flow:** mux writes chunks to a `WritableStream`/OPFS as they're produced; never hold the whole output.
- **Edge cases:** TTFB targets, faststart variants, fragment boundaries, TS continuity counters, headerless WebM, massive inputs.
- **Oracle:** `reference-reimport` + duration-materialized property.

## robustness / negative
- **Goal:** never crash, never emit wrong output, on garbled/truncated/zeroed/bitflipped/empty inputs; correctly report unsupported.
- **Ladder:** the same op ladders, but the contract is **clean failure** — throw a typed `MediaError`/`InputError`, emit no output.
- **Why [data]:** mediabunny 31/60; image probes (jpeg/png/webp) are honest `NA` (out of scope).
- **Edge cases:** header-destroyed, tail-truncated, mid-file zeroed spans, bit-flips, zero-length, mislabeled container, 1×1 dims.
- **Oracle:** `graceful-failure` — **strengthened**: it is not enough to "not crash"; the engine must either produce a *correct* partial result or reject. Producing plausible-but-wrong output is a fail (ADR-018).
