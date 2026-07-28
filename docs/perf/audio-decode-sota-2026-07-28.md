# Audio/decode state-of-the-art closure

Date: 2026-07-28
Scope: the 82 `audio-dsp` and `decode-seek` scenarios in the immutable sibling `media-test`
checkout
Product revision: `3822bc2c0c9be6c7c37aeb1dea0b8307f2fffb64` plus the working-tree changes
described below

This report separates product behavior, benchmark-adapter behavior, and benchmark-corpus
applicability. That distinction is material: both requested missing features work through the public
product API, but the immutable benchmark adapter rejects them before invoking the product. Several
performance rows likewise expose no repeatable wall distribution, and every `Partial 1/4` row is
missing three benchmark-owned frame-oracle assets. None of those external states is reported as an
engine win.

The broader family-by-family closure, including preserved wins and ties, is in
[`marathon-feature-ledger.md`](./marathon-feature-ledger.md). This report focuses on the audio/decode
requirements and the final independent profiles.

## Outcome

- Complete, lossless S16 little-/big-endian PCM conversion and WAV/AIFF serialization are present.
- Public decode supports deterministic explicit secondary-track selection without opening the
  unselected video track. Ambiguous same-type selection rejects before packet acquisition.
- WAV/AIFF PCM decode is pull-driven and bounded for sequential sources. S24 uses a direct packed
  24-bit-to-interleaved-F32 path, and S24-to-S16 authoring uses a fused narrowing path where applicable.
- Explicit WAV/AIFF/CAF decode hints now use a lightweight raw-PCM dispatcher. Generic image/HLS/video
  decode orchestration remains in a separate lazy chunk, while the selected raw driver and `AudioData`
  bridge load in parallel on the cold path.
- MP4 packet facts, immutable source indexes, seek results, and warm `VideoDecoder` instances are
  bounded and reused. Public seek avoids repeated full-container parsing and performs indexed anchor
  lookup.
- MP4-to-Matroska stream-copy does not decode or re-encode video. The final browser profile produced
  deterministic output and exact decoded pixels for the checked frames.
- MKV/WebM metadata probing reads an 8 KiB prefix once on the ordinary path; cue/cluster state is reused
  where available and missing-cue fallback remains general.
- VP9 alpha color and alpha copies now run concurrently, merge through an aligned 32-bit kernel where
  safe, and transfer ownership of the already-owned RGBA sidecar instead of cloning it.
- WAV extensible-format truncation now fails as a typed `MediaError` from bounded header validation,
  not as a raw `DataView` bounds exception.
- Independent randomized tests cover endian conversion, S24, malformed/valid WAV layouts, multitrack
  order/default variation, and repeated/random seek sequences.

The final post-gate, post-sync targeted immutable-harness artifact is
`../media-test/results/raw/chromium-2026-07-28T17-07-13-473Z.json`, run ID
`run-27c6defdb603cb8aeb50ecf4f807c3db5503e84191d444fa6554ad63095c6c71`, content hash
`f31bd5970d2c5218146f045631a906d9578389a9940e443ac5aac57beca3379b`, and raw SHA-256
`a8f9cd1dfa0f6bab2640b4dab22687a299ba1275c1449405b805e1ee6a91ccdb`. It completed all twelve
requested exhaustive rows with eleven `PASS`, one adapter-owned `NA_ENGINE`, and no `FAIL`, `ERROR`,
or corpus-asset gap. The three requested decode/seek rows all pass; MOV H.264 produced eight
digest-identical presentation-aligned frames.

The final forced-fresh whole-family artifacts are:

- audio: `../media-test/results/raw/chromium-2026-07-28T15-45-07-366Z.json`, 216/216 cells,
  run ID `run-c77e78062f9fd8830bfa72ddfd7e4df24c7bae5b6e07def6b695563c929598a3`,
  content hash `ed22e15d353ca6a43be01bd115692d44b3bf913bac238de3dc4c0fa04341febd`, raw SHA-256
  `41005700f8a3cc88f36d622189d8df51e4e219be557207264d41d57abe0c2df2`;
- decode/seek: `../media-test/results/raw/chromium-2026-07-28T15-50-52-797Z.json`, 276/276
  cells, run ID `run-35416b8c64fc7e9512085217051e62a827c4c56d368ce93f1d036fbef1650435`,
  content hash `77ec72e62363991b01e91299d19de5afe037192c4566c521b28a01a3503556f8`,
  raw SHA-256 `247d20aacb61b86a2d56b9891fc9127a91b3fadd8a9db5530e785f00ef5ed9d8`.

Aibrush finished those runs at 33 `PASS` / 3 `NA_ENGINE` for audio and 44 `PASS` /
1 adapter `NA_ENGINE` / 1 corpus `NA_ASSET` for decode/seek. Neither full matrix contains a
`FAIL` or `ERROR`, and the decode/seek status and coverage grade of all 46 aibrush scenarios are
identical to the retained pre-change baseline.

## Environment and method

| Dimension | Value |
| --- | --- |
| Hardware | Apple Mac mini, Apple M4, 16 GiB |
| OS | macOS 26.5.2 (25F84) |
| Browser | Playwright Chromium 149.0.7827.55; user agent Chromium 149.0.0.0 |
| GPU | ANGLE Metal, Apple M4 |
| Bun / Node | Bun 1.3.14 / Node 26.5.0 |
| Benchmark protocol | Chromium, exhaustive candidates, `--warmup 1 --iters 5 --no-reuse` |
| Independent browser profiles | fixed fixture byte length plus SHA-256; 2–3 warmups; 7 or 11 samples |
| Audio microprofiles | fixed fixture integrity; warmups and sample counts reported per profile |

Fixture fetch, fixture hashing, browser launch, and cryptographic correctness oracles are outside
timed samples. Browser profiles record median, median absolute deviation (MAD), p75, p95, minimum,
maximum, and heap delta where Chromium exposes it. For 7- and 11-sample profiles, p95 is necessarily
the maximum sample.

The immutable benchmark handles robustness cases as one correctness execution with `n=1`,
`warmup=0`, even when `--iters 5` is requested. The S24 transform and throughput rows pass their
multi-file correctness oracles but expose `READER_FORMAT_UNSUPPORTED` and
`AUDIO_SAMPLE_FRAME_NUMERATOR_UNAVAILABLE` instead of wall samples. Therefore benchmark UI duration
is reported only as diagnostic whole-cell time; it is not presented as a statistically rankable
latency sample.

## Trustworthy baseline and closure

The unchanged retained audio baseline is
`../media-test/results/raw/chromium-2026-07-28T08-30-56-544Z.json`: all 216 six-engine cells
completed, with aibrush at 33 `PASS` / 3 `NA_ENGINE` and no failure. The unchanged retained
decode/seek baseline is
`../media-test/results/raw/chromium-2026-07-27T14-36-38-443Z.json`: aibrush at 44 `PASS`,
one adapter `NA_ENGINE`, and one pending rotated-frame `NA_ASSET`.

The final full audio and decode/seek closures are the 216- and 276-cell artifacts identified above.
They reproduce the same aibrush correctness/coverage state with no failure while exercising every
candidate in exhaustive, forced-fresh mode. This is the preservation audit for prior wins and ties;
the reporter still cannot assign statistical ranks to rows whose required measurement dimensions are
unavailable.

The requirements document's older UI-duration baseline and the final full-run diagnostic are:

| Scenario | Requirements baseline | Final full diagnostic | Correct interpretation |
| --- | ---: | ---: | --- |
| S16 endian round trip | `NA_ENGINE` | `NA_ENGINE` | Product supports it; immutable feature declaration pre-rejects all four inputs |
| secondary-video selection | `NA_ENGINE` | `NA_ENGINE` | Product supports it; immutable adapter explicitly throws before product decode |
| truncated WAV probe | 54.02 ms | 30.700 ms | Correct typed rejection; each value is a non-rankable one-shot robustness time |
| empty audio transcode | 31.50 ms | 22.970 ms | Clean adapter rejection; product transcode is not called |
| S24-to-S16 | 210 ms | 204 ms | 3/3 correctness pass; neutral reader exposes no wall distribution |
| bit-flipped WAV decode | 43.33 ms | 31.160 ms | 256 validated frames; product cold path is lower, but one-shot variance still cannot establish a durable rank |
| MKV/H.264 decode | 3.29 s, `Partial 1/4` | 2.210 s, `Partial 1/4` | Baked file has 8/8 digest-identical frames; three frame oracles are absent |
| VP9 alpha decode | 1.36 s, `Partial 1/4` | 1.977 s, `Partial 1/4` | Baked alpha/timestamp oracle passes; three frame oracles are absent |

The table deliberately does not convert one-shot UI changes into speed verdicts. Product-only profiles
below identify the work that a product change can actually affect.

## Root causes

| Gap | Root cause | Ownership |
| --- | --- | --- |
| Endianness row | Adapter feature declaration omits `audio-dsp:endianness-roundtrip` | Benchmark adapter |
| Multitrack row | Adapter resolves the requested track, then throws `AIBRUSH_DECODE_TRACK_SELECTION_UNSUPPORTED` for every non-primary request | Benchmark adapter |
| Empty audio | Adapter rejects before calling product; displayed time is module/worker/oracle setup | Benchmark adapter |
| Corrupt/truncated WAV | Most displayed time is worker/module wrapper setup; one genuine product defect allowed truncated extensible `fmt` to reach an unsafe `DataView` read | Mixed; product defect fixed |
| S24 transform | Canonical planar Float64 materialization and a second encode pass were unnecessary for pure narrowing; whole-file sequential buffering inflated peak memory | Product architecture; fixed |
| S24 benchmark latency | Correctness reader cannot measure the output format and throughput reader cannot form a frame numerator | Benchmark measurement |
| Seek group | Adapter materializes a complete packet-info table before calling public seek; direct product seek uses two ranges and indexed lookup | Benchmark adapter after product indexing fixes |
| Large decode | Full-output work scales with every requested frame; bounded consumers should stop after their prefix. Native decode dominates, not demux setup | Product now bounded; native codec cost remains |
| MKV/WebM startup | Former small prefix could require a second larger read; cue-less files need a safe scan fallback | Product architecture; ordinary prefix path fixed |
| VP9 alpha | Sequential plane copies, scalar byte merge, and an avoidable RGBA sidecar clone | Product architecture; fixed |
| Decode/remux | Decode-anchored benchmark includes media-element/oracle seeks; product remux itself is packet-level stream-copy | Mixed |
| `Partial 1/4` | Each listed scenario has one committed baked frame oracle and three inputs whose committed frame evidence is missing or pending | Benchmark corpus |

On the canonical H.264 seek fixture, the immutable adapter's packet-table prepass takes 39.120 ms,
seven ranges, and 31,205,329 bytes before product seek begins. Direct product seek plus frame decode
takes 9.735 ms; including equivalent raster/hash work takes 18.725 ms versus 20.875 ms for the
MediaBunny adapter in the same page. Both land at exactly 14,000,000 µs with the same digest. Deleting
packet evidence to lower the aibrush adapter score would weaken semantics and was not done.

The product's in-memory packet classification itself takes 0.525 ms median (3 warmups, 11 samples,
2,308 rows) on the same 31,258,790-byte file. The remaining prepass time is therefore source
materialization and range transport across two adapter-created source objects, not parser CPU. A
four-way parallel classification experiment produced no measurable official improvement and was
fully reverted.

## Architectural changes and modules

| Area | Relevant modules | Change |
| --- | --- | --- |
| PCM and endian fidelity | `src/dsp/pcm.ts`, `src/drivers/wav/aiff-rewrite.ts`, `src/drivers/aiff/aiff-wav-rewrite.ts`, `src/api/pcm-convert-plan.ts` | LE/BE-aware exact reads/writes, direct fixed-width byte swaps, canonical ties-to-even narrowing, no lossy float seam for copy rewrites |
| Pull-driven PCM | `src/drivers/wav/wav-driver.ts`, `src/drivers/aiff/aiff-driver.ts`, `src/drivers/wav/pcm-range-slice.ts` | Sequential cursors, bounded payload chunks, backpressure, cancellation/unlock, retained-buffer release |
| Raw-PCM decode startup | `src/api/decode-runner.ts`, `src/api/general-decode-runner.ts`, `src/dsp/audio-data.ts` | MIME/extension dispatch for WAV/AIFF/CAF; generic orchestration stays lazy; raw driver and frame bridge preload concurrently |
| Malformed WAV | `src/drivers/wav/wav-probe.ts`, `src/drivers/wav/pcm.ts` | Extensible `fmt` validates the 26 readable bytes used by the parser before field access |
| Track selection | `src/api/track-select.ts`, `src/api/codec-pipeline.ts` | Explicit selector whitelist, stable media-type ordinal, one selected stream per type, unopened-track proof |
| MP4 packet/index reuse | `src/drivers/mp4/samples.ts`, `src/drivers/mp4/packet-info-batches.test.ts`, `src/api/mp4-packet-info-url-cache.ts` | Compressed timing/sample tables, bounded packet-row production, semantic source key, TTL/LRU/row caps |
| Seek | `src/api/seek-runner.ts`, `src/api/codec-pipeline-seek-prep.test.ts`, `src/codecs/webcodecs-video.ts` | Cached immutable packet facts, binary anchor lookup, boundary normalization, bounded decoding, safe warm decoder pool |
| WebM/MKV | `src/api/webm-packet-info-remux.ts`, `src/api/streaming-webm-remux.ts`, WebM driver/parser modules | One ordinary 8 KiB metadata read, bounded cluster state, cue-aware seek with general missing-cue fallback |
| Remux | `src/api/remux-runner.ts`, `src/api/native-packet-mux.ts`, `src/api/mp4-prepared-mux.ts` | Prepared compressed packet streams, metadata reuse, stream-copy without decoded-frame materialization |
| VP9 alpha | `src/api/vpx-alpha.ts`, `src/api/vpx-alpha-pixels.ts` | Concurrent color/alpha copies, aligned 32-bit merge plus portable fallback, owned sidecar adoption |
| Diagnostics | `scripts/bench-session14-wav-negative-browser.mjs`, `scripts/bench-session14-vp9-alpha-decode-browser.mjs`, `scripts/bench-session14-decode-breakdown-browser.mjs`, `scripts/bench-session13-video-decoder-startup-browser.mjs` | Integrity-pinned cold/warm stage profiles with exact output truth |

Caches are bounded and semantic rather than filename-based. The MP4 URL fact cache excludes mutable or
unknown identities, failures, and aborted work; it has a 60-second absolute lifetime, eight-entry LRU
capacity, and 262,144 aggregate-row cap. The lower source range cache has a strict 8 MiB retained-byte
ceiling. Decoder/frame queues obey backpressure and close every owned frame on success, error, abort,
and cancellation.

## Independent performance evidence

### Malformed and empty WAV paths

The browser profiler performs a first call in the imported engine page, then 11 fresh-engine and
11 warm-engine samples. Values are median ± MAD, with p95 in parentheses:

| Operation | First invocation | Fresh engine | Warm engine |
| --- | ---: | ---: | ---: |
| empty WAV transcode | 11.615 ms | 0.315 ± 0.025 ms (0.470) | 0.245 ± 0.015 ms (0.350) |
| truncated extensible WAV probe | 0.400 ms | 0.070 ± 0.005 ms (0.080) | 0.035 ± 0.005 ms (0.065) |
| corrupt `fmt` transcode | 0.165 ms | 0.050 ± 0.005 ms (0.065) | 0.060 ± 0.010 ms (0.230) |
| bit-flipped WAV decode, 256-sample consumer cap | 3.790 ms | 0.235 ms (0.280) | 0.160 ms (0.230) |
| truncated AIFF probe | 4.580 ms | 0.080 ± 0.010 ms (0.095) | 0.035 ± 0.005 ms (0.050) |

The exact bounded bit-flip profile consumed and closed one 4,096-frame block before cancelling at the
same 256-sample consumer cap as the immutable scenario. The empty path produced the same exact
44-byte canonical empty RIFF on every applicable run. This establishes that the benchmark's
roughly 20–50 ms one-shot cells are dominated by the worker/adapter/oracle boundary rather than a
product WAV hot path.

### S24 conversion, streaming, and memory

The 7,904,256-byte, 1,315,328-frame S24 fixture is integrity-pinned.

| Path | Median ± MAD | p75 / p95 | Correctness |
| --- | ---: | ---: | --- |
| canonical planar decode + encode | 9.294 ms | not retained / not retained | reference |
| fused S24-to-S16 narrowing | 2.774 ms | 3.166 / 3.193 ms | checksum `2064061439`, exact reference bytes |
| sequential fused decode | 3.429 ± 0.116 ms | not retained | 9 ranges, complete payload, zero retained bytes |
| browser range decode | 18.095 ± 0.130 ms | 18.165 / 20.320 ms | 322 exact chunks, checksum `658366885` |
| browser sequential decode | 16.985 ± 0.085 ms | 17.100 / 17.195 ms | same chunks and checksum |

The fused narrowing median is 70.2% below the canonical two-pass reference. Sequential peak
ArrayBuffer footprint fell from 18,463,056 to 10,558,688 bytes (42.8%) and returns to zero retained
bytes on completion. Chromium does not attribute transferred `AudioData` backing stores to
`usedJSHeapSize`, so the Node ArrayBuffer high-water measurement is the defensible memory metric.

### Identity, long-form probe, and S24 encode

The three additional user-reported audio rows were profiled through their product-owned seams:

| Operation | Input | Samples | Median ± MAD | p95 | Work bound |
| --- | ---: | ---: | ---: | ---: | --- |
| same-rate S16 WAV public conversion | 960,044 bytes | 101 | 0.056 ± 0.013 ms | 0.081 ms | verified canonical multipart identity; 44-byte JS output allocation before Blob ownership |
| F32 WAV to packed S24 WAV | 1,920,058 bytes | 21 | 1.023 ± 0.037 ms | 1.311 ms | one contiguous fused conversion; exact output size/checksum fold |
| one-hour WAV probe | 317,520,044 bytes | 21 | 0.0188 ± 0.0039 ms | 0.0322 ms | exactly one 16 KiB range read; reports exactly 3,600 s |

The full harness shows roughly four to five seconds for the same-rate, long-form, and S24 throughput
aggregates because each has four exhaustive candidates and their measurement protocol spends roughly
one second per candidate waiting for unavailable memory or neutral-reader evidence. These direct
profiles rule out additional PCM work as the cause.

### Decoder startup, reuse, and bounded output

The decoder profile uses 3 warmups and 11 measured runs. All truth counters, timestamps, RGBA hashes,
and close counts are checked before reporting.

| Case | Fresh configure | Fresh native decode | Reused native decode | Public bounded decode | Bounded decode + RGBA |
| --- | ---: | ---: | ---: | ---: | ---: |
| H.264, 30 frames at 1 fps | 0.800 ± 0.100 ms, p95 0.900 | 7.800 ± 0.100, p95 8.600 | 3.900 ± 0.100, p95 4.200 | 8.700 ± 0.200, p95 9.300 | 25.200 ± 0.800, p95 27.300 |
| H.264, first 240/480 frames | 1.000 ± 0.000, p95 1.100 | 59.600 ± 0.300, p95 64.600 | 56.400 ± 0.500, p95 63.800 | 33.400 ± 0.200, p95 34.300 | 151.100 ± 1.800, p95 160.300 |
| H.264 VFR, first 60/111 | 1.100 ± 0.100, p95 1.400 | 23.500 ± 0.300, p95 24.300 | 20.000 ± 0.200, p95 23.700 | 16.800 ± 0.200, p95 17.700 | 192.200 ± 2.100, p95 196.800 |
| VP9 120 s, first 60/3,600 | 4.800 ± 0.600, p95 6.200 | full stream 3,521.3 ± 9.0, p95 3,563.5 | full stream 3,499.0 ± 8.9, p95 3,527.6 | 72.600 ± 1.400, p95 74.300 | 388.000 ± 3.100, p95 409.200 |

The VP9 row makes the scalability result explicit: stopping after 60 requested frames takes 72.6 ms;
draining all 3,600 frames takes 3.52 s. The implementation preserves that cancellation boundary
instead of eagerly materializing the full file's decoded frames.

The final public-stage breakdown uses 2 warmups and 7 samples:

| Case | Demux + 60 packets | Public 60-frame decode | Decode + RGBA | Median JS heap delta |
| --- | ---: | ---: | ---: | ---: |
| 4.37 MB MKV/H.264 | 0.610 ± 0.030 ms, p95 0.655 | 15.085 ± 0.130, p95 15.540 | 199.505 ± 2.825, p95 202.485 | decode 0.66 MB; RGBA 202.9 MB |
| 89.57 MB MP4/H.264 | 1.925 ± 0.055 ms, p95 2.040 | 28.065 ± 0.150, p95 28.345 | 375.730 ± 4.410, p95 380.140 | decode 0.92 MB; RGBA 348.5 MB |

Negative demux heap deltas were omitted because an exposed GC ran before each sample and can collect
earlier allocations. The large positive RGBA values represent explicitly materialized pixel arrays;
plain `VideoFrame` delivery remains under 1 MiB of reported JS heap delta.

### Seek

The same fixed 3-warmup/11-sample browser profile reports:

| Seek | Landed timestamp | Closed frames | Median ± MAD | p95 | Range |
| --- | ---: | ---: | ---: | ---: | ---: |
| VFR target 4,250,000 µs | 4,433,333 µs, first frame at/after target | 14 | 16.600 ± 0.100 ms | 16.900 ms | 16.200–16.900 |
| zero in 31.26 MB H.264 | 0 µs | 14 | 6.800 ± 0.300 ms | 7.500 ms | 6.300–7.500 |

Separate public integration tests drive 72 forward, backward, repeated, zero, negative, and
past-end targets through one decoder pool. They assert one index build, exact selected timestamps,
and exactly-once close behavior. The indexed boundary logic is shared; no target-specific fast path
exists.

The immutable adapter was also run five times independently across all ten material seek scenarios
with `--warmup 1 --iters 5 --exhaustive --no-reuse`, giving 25 raw samples per engine/scenario.
Artifacts end in `15-27-53-732Z`, `15-28-18-598Z`, `15-28-42-103Z`, `15-29-08-696Z`, and
`15-29-32-462Z`. Pooled median/p95 results are:

| Seek | Aibrush median / p95 | MediaBunny median / p95 | Median gap |
| --- | ---: | ---: | ---: |
| backward then forward | 47.442 / 50.192 ms | 21.095 / 22.112 ms | +124.9% |
| B-frames mid-GOP | 74.400 / 79.115 ms | 59.635 / 61.035 ms | +24.8% |
| H.264 keyframe | 47.505 / 51.310 ms | 21.475 / 22.885 ms | +121.2% |
| H.264 non-keyframe | 62.350 / 65.960 ms | 35.125 / 35.745 ms | +77.5% |
| MKV/H.264 keyframe | 16.250 / 19.125 ms | 13.520 / 14.575 ms | +20.2% |
| negative | 47.555 / 51.135 ms | 21.425 / 23.665 ms | +122.0% |
| past EOF | 68.255 / 72.070 ms | 41.520 / 42.755 ms | +64.4% |
| repeated target | 47.832 / 49.832 ms | 21.330 / 21.823 ms | +124.2% |
| VFR arbitrary | 29.595 / 39.860 ms | 24.325 / 25.630 ms | +21.7% |
| zero | 48.105 / 51.485 ms | 21.320 / 22.550 ms | +125.6% |

These repeated results prove that the official group is still a loss, while the decomposition above
proves that the dominant fixed cost is the adapter-required full packet-evidence pass. Cross-operation
reuse cannot be added safely for arbitrary mutable HTTP URLs without an immutable source identity,
which the adapter does not provide.

### VP9 alpha

The final 12-frame profile uses 3 warmups and 11 samples:

| Stage | Median ± MAD | p75 / p95 | Median heap delta |
| --- | ---: | ---: | ---: |
| decode + alpha merge | 41.410 ± 0.245 ms | 42.885 / 43.180 | 0.73 MB |
| decode + merge + caller RGBA copy | 49.765 ± 0.595 ms | 50.230 / 52.070 | 15.49 MB |

The pre-change diagnostic medians were 41.845 and 50.050 ms, inside run-to-run variance; no latency
win is claimed. Retained heap fell from approximately 16.70 to 15.49 MB (7.3%). Every run preserves
all 12 exact RGBA hashes and clocks, alpha extrema 0/255, RGBA frame format, and exactly-once closure.
An experimental I420A route changed exact RGB output and was reverted.

### Remux and WebM prefix work

Packet-level MP4-to-Matroska remux of a 31,258,790-byte H.264 input takes
14.170 ± 0.110 ms (p75 14.445, p95 14.760, range 13.840–14.760) with a 33.01 MB median JS heap
delta. All seven outputs are byte-deterministic at 31,248,806 bytes and SHA-256
`66cc5edbd8f34cf847daa2c12d78a081cd1d5ebacef7305cbe46b04ba620f338`. The first eight
decoded RGBA frames are hash-identical to the source. Matroska's millisecond timecode scale quantizes
timestamps by at most 333 µs and omits per-frame duration in the decoded browser surface; this is
recorded rather than hidden behind an exact-clock assertion.

Ordinary WebM metadata now uses one 8 KiB read: 3.876 ms with a simulated 3 ms source delay versus
7.558 ms for the former 4 KiB plus 64 KiB sequence. A keyframe-visible prefix takes one read; a
deliberately missing sequence header takes two bounded reads and preserves fallback correctness.
Large AV1 metadata remains an 8 KiB operation rather than a full-file read.

## Competitor study

No competitor source was copied. The implementation ideas below were re-derived against this
project's contracts and licenses.

| Implementation | Paths inspected | Strategy / memory / initialization | Adopt, improve, or avoid |
| --- | --- | --- | --- |
| MediaBunny 1.48.0, MPL-2.0 | `src/wave/wave-demuxer.ts`, `src/media-sink.ts`, `src/isobmff/isobmff-demuxer.ts`, `src/matroska/matroska-demuxer.ts` | Lazy WAV ranges; bounded key-packet queue; decoder reuse within iterators; retained compressed MP4 timing/sample-to-chunk/key tables; binary timestamp search; Matroska cue and cluster-position caches with fallback | Adopt indexed/bounded reads and safe decoder reuse. Improve with semantic bounded caches, sequential-source cancellation, and a general cue-less path. Avoid its scalar S24-to-S32 wrapper and VP9 I420A route because the latter changed exact RGB here. |
| Remotion 4.0.479, Remotion License | `@remotion/media-parser/dist/containers/wav/*`, `parse-media-section.js`, `@remotion/webcodecs/dist/get-wave-audio-decoder.js`, `create-audio-decoder.js` | Sequential WAV parser, roughly 25 chunks/s, discards consumed bytes; native compressed decoder and custom WAV PCM decoder | Adopt incremental parsing. Improve with frame-sized backpressure and direct packed-S24 conversion. Avoid allocating a new `Uint32Array` for each packed-S24 expansion and avoid arbitrary small-chunk ignore rules. |
| FFmpeg.wasm 0.12.15 / core 0.12.10, MIT wrapper / GPL-2.0+ core | `@ffmpeg/ffmpeg/dist/esm/classes.js`, `worker.js`, benchmark adapter remux command | Persistent worker/core; transferred inputs into MEMFS; packet stream-copy via `-c copy`; process state reset between execs | Adopt packet-copy semantics and metadata/timestamp reuse. Avoid whole-file MEMFS duplication and unconditional large WASM startup for browser-native paths. |
| web-demuxer 4.0.0, MIT | `dist/web-demuxer.js` | Persistent FFmpeg worker, URL/File WORKERFS, synchronous range requests, pull-driven packet stream at high-water mark 1; demux context is recycled per operation | Adopt pull/backpressure and transferable packets. Improve with asynchronous source I/O and reusable immutable indexes/decoders. Avoid synchronous XHR and fresh decode setup per operation. |

MediaBunny's seek advantage is architectural inside its own adapter, but the current aibrush benchmark
gap is principally adapter-specific: the aibrush adapter adds a complete packet-table pass that the
public product API does not require. FFmpeg's remux advantage likewise comes from stream-copy, which
the product now performs without accepting FFmpeg.wasm's whole-file worker/MEMFS memory model.

## Coverage audit

All 18 named `Partial 1/4` scenarios were inspected. For each scenario and for every implementing
engine, the baked candidate has committed frame evidence and the other three candidates report:

`NA_ASSET: decodeFrames oracle unavailable: committed frame evidence is missing or pending`

The final MKV baked candidate passes 8/8 presentation-aligned frames with digest identity, SSIM 1,
infinite PSNR, full presentation coverage, and zero timestamp residual. VP9 alpha's baked candidate
passes its alpha/timestamp oracle. Because the other candidates are not judgeable, product changes
cannot turn those 54 missing-oracle children into valid passes. Coverage remains `Partial 1/4`; this is
not an engine limitation and no lazy decoder fallback would change it.

The engine-internal coverage improvements are instead:

- S16 LE/BE and WAV/AIFF round trips through public conversion;
- non-primary video selection through public decode;
- typed extensible-WAV truncation handling;
- exact VP9 alpha merge with lower retained heap;
- bounded sequential S24 WAV and S16/S24 AIFF decode;
- general cue-present and cue-absent WebM/MKV behavior.

## Independent tests added

- `src/dsp/pcm.test.ts`: 192 seeded S16/S24 LE/BE cases across 1–8 channels, unaligned views,
  partial trailing frames, and direct/canonical equality.
- `src/drivers/wav/wav.test.ts`: 128 seeded valid WAV layouts with metadata preludes plus
  192 truncation/header mutations and typed bounds assertions.
- `src/api/track-select.test.ts`: 128 randomized interleaved multitrack orderings with varying declared
  defaults; exact identity, metadata, and ordinal selection.
- `src/codecs/webcodecs-video.test.ts`: 72 mixed seek targets through one pool, one index build, and one
  final close.
- `src/api/codec-pipeline.test.ts` and VP9 alpha pixel tests: unaligned and randomized merge equality,
  exact hashes, close behavior, and no unnecessary track acquisition.

The final five-file focused closure passes 443 tests. The exact current-tree `bun run gate` passes
247 files / 4,506 tests with 93.13% statement/line, 90.02% branch, and 96.06% function coverage,
both TypeScript projects, a 776-file Biome check, both performance-ledger generators, build, WASM
vendoring, 10/10 dist-smoke tests, clean package-install verification, bundle budgets, and all
51 anti-cheat checks.

## Remaining gaps and acceptance status

| Requirement | Status | Evidence / blocker |
| --- | --- | --- |
| 1. Endianness supported and correct | Product complete; benchmark blocked | Exact independent round trips pass; immutable declaration pre-rejects |
| 2. Multitrack selection supported and correct | Product complete; benchmark blocked | Public integration opens only requested track ID 20; immutable adapter throws |
| 3–4. Preserve wins and ties | No observed correctness regression | Latest full family closures have no new aibrush failure; canonical reporter cannot certify statistical cohorts because dimensions/metrics are missing |
| 5. All 27 latency losses in official tie range | Not demonstrable | Many rows expose no wall distribution; robustness is forced to `n=1`; normalized reporter returns `NOT_COMPARABLE` |
| 6. Stretch wins | Product-level wins exist, not promoted to official rank | Fused S24, bounded decode, prefix probe, and direct seek evidence above |
| 7. Severe audio matches Remotion | Product hot paths do; official rank unavailable | Sub-millisecond malformed paths and 2.774 ms fused S24; wrapper/reader prevents a rankable comparison |
| 8. Complete seek group matches MediaBunny | Official criterion not met; adapter blocker proven | Five runs / 25 samples per cell reproduce all ten official losses; direct same-page canonical seek is 18.725 vs 20.875 ms, while immutable packet evidence dominates every aibrush cell |
| 9. Decode/remux matches leader group | Product remux is 14.170 ms and pixel-exact; official row not certified | Benchmark decode-anchored media-element/oracle work remains outside product remux |
| 10. Raise internal partial coverage | Complete where engine-owned | All remaining partial children are missing benchmark frame evidence |
| 11. No fixture/scenario shortcuts | Complete | No scenario IDs, fixture names, hashes, dimensions, durations, or timestamps occur in product decision code |
| 12. No correctness/API/memory regression | Complete | Exact hashes, timestamps, typed errors, ownership, cancellation, bounded memory, public API tests, and full gate |

The honest closure is therefore: the shared product bottlenecks and both missing public capabilities
are addressed, while acceptance items requiring new adapter declarations, new benchmark frame assets,
or a statistically valid reporter cohort remain externally unobservable. Changing the benchmark,
removing requested packet truth, jittering timestamps, or recognizing fixture identities would make
the displayed rows look better but would violate the requirements and was not done.

## Integrity confirmation

- No benchmark scenario name, fixture name, hash, duration, dimension, codec/timestamp tuple, or fixture
  content signature is consulted by product runtime code.
- The sibling benchmark source and fixtures were not edited. The only benchmark source-tree change is
  the explicitly permitted generated `src/engines/aibrush-media/vendor-provenance.generated.ts`; raw
  result artifacts are benchmark outputs.
- The product uses general source/container/codec capabilities, bounded semantic cache keys, and public
  options. All optimization diagnostics pin fixture integrity only inside `scripts/bench-*`, outside
  shipped product code.
- Correctness tolerances and benchmark methodology were not weakened. The stricter independent checks
  include exact bytes/hashes and explicit timestamp quantization reporting.
- Incompatible source was not copied. The competitor licenses and paths studied are documented above.
