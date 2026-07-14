# Session 13 probe leadership evidence

Date: 2026-07-13  
Status: complete — all 13 strict rows have repeatable fresh-sample leadership and the full gate is green

## Goal and design note

Make the public engine repeatably fastest on the thirteen requested probe rows without recognizing
scenario names, fixture paths, hashes, or known sizes. The first profile separates startup/routing from
format work and records every source interval: fixed-header formats should read only the bytes needed to
prove their scalar metadata; chunked RIFF/AIFF should walk declared chunk headers and skip payloads by
offset; terminal-timeline formats should use bounded head/tail recovery; and MP4 should avoid materializing
sample-table bodies that probe does not expose. Lowering constants alone is rejected where it would turn a
legal large tag/chunk into a full-read fallback. Caches remain exact-source-only, aborts are checked across
every asynchronous read, typed parser errors are preserved, and no decoded frames or audio blocks are
created. Consequently B-frame/VFR ordering, seek state, frame lifetime, close-exactly-once ownership, and
decode backpressure remain unchanged; tests still cover cancellation and one-shot/range-less fallbacks.

## Fresh pre-change end-to-end baseline

Command shape: current versioned browser harness, Chromium 149, `--no-reuse --exhaustive`, three
warmups and nine measured iterations per file. All thirteen strict golden-metadata oracles passed. The
aggregate is the sum of the per-file medians, matching the harness leaderboard metric.

| scenario | files | aggregate median (ms) | notable per-file median (ms) |
|---|---:|---:|---:|
| `probe/wav_s16` | 4 | 12.560 | 3.365 baked |
| `probe/wav_s24` | 4 | 13.910 | 5.390 `03.wav` |
| `probe/wav_f32` | 4 | 11.920 | 3.115 `02.wav` |
| `probe/pcm_s16be` | 4 | 22.035 | 5.915 baked |
| `probe/realworld_mdn_trex_mp3` | 4 | 14.130 | 5.850 baked |
| `probe/mp3_cbr_notoc` | 4 | 13.255 | 4.200 baked |
| `probe/flac_seektable` | 4 | 11.750 | 3.065 `01.flac` |
| `probe/flac_noseektable` | 4 | 12.010 | 3.300 `01.flac` |
| `probe/aac_adts` | 4 | 16.730 | 7.225 baked |
| `probe/opus` | 4 | 11.930 | 3.185 `01.ogg` |
| `probe/recorder_headerless` | 1 | 8.885 | 8.885 baked |
| `probe/longform_1h_audio` | 4 | 19.675 | 9.950 baked |
| `probe/micro_h264_1frame` | 1 | 3.070 | 3.070 baked |

Raw result: `../media-test/results/raw/chromium-2026-07-13T20-30-05-143Z.json`.

## Complete-path read profile before changes

The harness creates a fresh known-size URL source for every operation, while one adapter/engine instance
survives its warmups and samples. The adapter uses `probeContainer` for MP4/WebM/FLAC/Ogg and public
`probe` for WAV/AIFF/MP3/ADTS. Module and capability registration therefore happen during warmup; the
measured recurring work is source creation, exact routing, range fetch/array-buffer materialization,
parsing, normalization, and source cancellation.

Direct interval tracing over every exhaustive input found:

- ordinary WAV: one `[0,4096)` read; `wav_s24/03.wav` additionally extends to `[4096,65536)` because a
  declared non-audio chunk separates `fmt ` from `data`;
- AIFF: one `[0,65536)` read for every input because probe falls through to the demux head path;
- MP3: one `[0,16384)` read for every input;
- FLAC: one `[0,4096)` read even though native STREAMINFO needs 42 bytes without an ID3 prefix;
- ADTS: exact full-file walks (147 to 299,647 bytes) because exact duration requires every frame header;
- Ogg/Opus: exact full-file reads for these 3,737 to 145,910-byte sources;
- headerless WebM: `[0,8192)` followed by `[8192,200011)`, preserving the inferred terminal timeline;
- long-form MP4 rotations: one `[0,131072)` read; the baked M4A extends through byte 675,950 for its
  large fast-start `moov`;
- micro MP4: one full 5,546-byte GET.

The simulated one-millisecond transport benchmark independently reproduces the WebM relationship: the
headerless case takes two reads and the whole source, while declared-timeline WebM finishes from 8 KiB.
The next changes therefore target transferred bytes and sequential round trips first, with exact metadata
equality and typed failure/cancellation regression coverage written before implementation.

## Change ledger

The fresh unchanged-vendor Mediabunny control used the same three warmups and nine measured iterations.
Its passing aggregates were: WAV s16 14.180 ms, WAV s24 12.100 ms, WAV f32 13.970 ms, MDN MP3
10.470 ms, CBR MP3 11.030 ms, ADTS 13.225 ms, Opus 13.715 ms, recorder WebM 4.560 ms,
long-form audio 24.765 ms, and micro H.264 2.630 ms. Raw result:
`../media-test/results/raw/chromium-2026-07-13T20-42-51-994Z.json`.

### AIFF bounded probe

- Before: every exhaustive input read `[0,65536)` through the generic demux fallback.
- Design: add a native driver probe that parses the mandatory leading FORM/COMM metadata from a
  64-byte window, retains the established bounded fallback for unusual legal chunk layouts, and checks
  cancellation on both sides of I/O.
- Regression oracle: exact equality with full demux metadata for all four exhaustive harness inputs;
  exact `[0,64)` read proof; no stream creation; abort-before-I/O proof.
- Local gates: focused validation 76/76 passing; repository typecheck passing. Post-change browser evidence
  is pending the next synchronized build.

### WAV sparse RIFF probe

- Before: ordinary inputs read `[0,4096)`; the padded 24-bit input read `[0,65536)`.
- Design: use one 128-byte head window, walk declared RIFF chunk offsets without materializing payloads,
  and cap sparse windows before the existing 64 KiB fallback. This applies to arbitrary legal chunk names
  and sizes, not particular assets.
- Regression oracle: exact full-demux metadata on exhaustive WAV inputs, exact range proof for ordinary
  and 12 KiB-padded headers, large synthetic JUNK traversal, abort behavior, and packet-info URL range
  assertions.
- Local gates: focused validation 106/106 passing and repository typecheck passing before final formatting
  review; post-change browser evidence is pending the next synchronized build.

The follow-up remote policy keeps that 128-byte window for byte/blob sources but uses one 16 KiB URL/
element window. This is the measured latency/overfetch tradeoff: the padded real input now proves its
`data` header in one request, while ordinary remote WAVs retain the same single-request count. A failing
real-fixture range oracle preceded the change; the strengthened WAV suite is 107/107 passing, including
exact local sparse reads and the exact remote `[0,16384)` read.

Fresh synchronized Chromium evidence (three warmups, nine measured samples per exhaustive file) remained
strictly passing: WAV s16 12.610 ms, WAV s24 13.500 ms, WAV f32 14.185 ms, and AIFF s16be 22.580 ms.
Raw result: `../media-test/results/raw/chromium-2026-07-13T20-58-50-112Z.json`. WAV s16 now beats the
fresh Mediabunny control (14.180 ms), and AIFF is already below the originally reported winning time;
WAV s24 still loses to the fresh 12.100 ms control because its padded input still crosses two async
range boundaries. The 128-byte transfer reduction alone is therefore insufficient; the next WAV change
must amortize remote metadata preludes without adding a request to ordinary files.

### Long-form M4A scalar-table compaction

- Before profile: the baked file read `[0,131072)` and then extended through byte 675,950. Its `moov`
  contains one 675,024-byte variable `stsz`; probe reads only that box's version, default size, and count.
  The three rotated real inputs already finish in one 128 KiB request.
- Design: traverse declared faststart box extents, compact every proved audio `trak` through its scalar
  `stsd`/`stts`/`stsz` header, scan the remaining 61-byte `moov` tail to prove no hidden track or `mvex`,
  and pass the owned compact structure through the existing audio truth parser. All unproved layouts
  retain the full parser.
- Regression oracle: exact equality with full-source metadata on the 29.7 MB one-hour fixture; exact
  reads `[0,131072)` and `[675889,675950)`; two-track non-elision; cancellation after the tail read.
- Local gates: focused real-fixture validation passing, complete MP4 driver suite 40/40 passing before
  the two additional structural tests, repository typecheck passing, and focused formatting passing.
  Fresh browser evidence is pending the next synchronized build.

### Rejected full-source plain-GET transport policy

ADTS and the exhaustive Opus inputs each request the exact known full source once. A complete-path
Chromium A/B therefore compared the existing HTTP `Range` request with a plain GET while keeping source
creation, `probeContainer`, cache wrapping, parsing, normalization, and exact metadata truth identical.
After five warmups and 31 alternated samples, Range remained faster: ADTS was 0.500 ms versus 0.600 ms
for GET, and Opus was 0.400 ms versus 0.500 ms. This rules out transport method as the current loss and
preserves partial-content semantics; no source policy change was made. The corresponding pure ADTS walk
profile over the 163,811-byte exhaustive input measured a 0.00495 ms median, and the complete in-memory
driver probe measured 0.00532 ms, so frame-header parsing is also immaterial beside harness URL/source
fixed cost.

The next synchronized WAV/M4A browser run was discarded: Chromium closed its target page after only two
of four cells, before a result file could be finalized. No partial sample from that run is used here.

### Small remote WebM single-window metadata

- Before: recorder-origin and other terminal-timeline WebM read `[0,8192)` and then extended through the
  full source. Exact parsing was below one millisecond; the second sequential transport boundary was the
  dominant cost.
- Design: known-size URL/media-element WebM at or below the measured 256 KiB crossover uses one exact
  whole-source metadata window. The existing metadata-only pass still runs first, so declared-timeline
  files expose exactly the same front metadata; only the established `needs-terminal-scan` result scans
  Clusters. Local and larger remote inputs keep the bounded prefix ladder.
- Regression oracle: exact full-parse truth on the real recorder file, exact one-read behavior on terminal
  and declared timelines, large-remote bounded-prefix proof, and cancellation immediately after the one
  remote read. The strengthened complete WebM suite is 62/62 passing and repository typecheck is green.
- Benchmark: three warmups and 21 alternated samples at one-millisecond read latency measured recorder
  WebM at 1.288 ms versus 2.461 ms and another terminal-timeline file at 1.342 ms versus 2.540 ms. Small
  declared controls retained exact truth with only 0.057–0.064 ms differences; a 1.94 MB control kept its
  existing 8 KiB read.

### Adaptive MP3 metadata head

- Before: every known-size MP3 fetched `[0,16384)` even though all eight exhaustive inputs prove the
  first frame, next-frame lock, Xing/Info count, and optional LAME gapless tuple within 2 KiB.
- Design: start with `[0,2048)`. A declared large ID3v2 tag jumps directly to its audio boundary for a
  2 KiB then 16 KiB bounded attempt; an ordinary miss extends the prefix to the established 16 KiB; only
  unproved input retains the full-source fallback. An absolute parser offset preserves CBR byte-duration
  arithmetic after the sparse tag jump.
- Regression oracle: exact `TrackInfo` for all eight real exhaustive MDN/CBR inputs with exact one-read
  ledgers; synthetic 4 KiB ID3 truth equal to the former 16 KiB result; cancellation after the targeted
  read; unchanged full-frame packet tests. The complete MP3 suite is 34/34 passing and repository
  typecheck is green.

### FLAC mandatory-prefix compaction design

Fresh exhaustive results on 2026-07-14 kept both FLAC rows strictly correct, but the no-SEEKTABLE row
was a noisy 13.290 ms aggregate versus Mediabunny's 12.270 ms. Range attribution confirms that the
default lazy FLAC probe already avoids audio frames, yet still transfers a fixed 4 KiB prefix for the
42-byte mandatory `fLaC` + STREAMINFO structure. The next change reduces the ordinary seekable read to
64 bytes and treats a declared ID3v2 prelude as structure: decode its synchsafe length from the first
ten bytes and jump directly to exactly 42 bytes at the declared FLAC offset. This is content-structural,
not fixture-specific, and avoids allocating or transferring arbitrarily large tag bodies. A short or
misdeclared range continues through the typed STREAMINFO parser and therefore cannot manufacture
metadata. Range-less streams retain their sequential fallback; cancellation is checked after every
await; no packet, seek, B-frame/VFR, backpressure, or frame-lifetime path changes. The fail-first oracle
requires `[0,64)` for ordinary FLAC and `[0,64)`, then `[id3End,id3End+42)` for a synthetic 16 KiB ID3v2
prefix while proving the exact same duration, channels, sample rate, and sample depth.

### Small complete WebM transport design

The first single-window WebM change removed a sequential request but the fresh 5-warmup/15-sample
Chromium recorder median remained 6.375 ms, so cluster parsing was re-profiled separately from HTTP.
The exact one-request browser A/B used a fresh URL for each sample, disabled HTTP caching, alternated
orders, and compared identical public `MediaInfo` on the real 200,011-byte recorder input. After five
warmups and 31 samples, a plain full GET measured 1.200 ms median versus 1.800 ms for the exact full
Range request. The change therefore keeps the same structurally qualified small known-size remote WebM
crossover but reads that already-required complete object through `stream()`/GET. It neither broadens
which sources are materialized nor changes terminal scanning, VFR cadence, missing-duration recovery,
metadata, errors, or resource lifetime. Short bodies are rejected against the declared snapshot size;
abort listeners cancel the active reader and every await is followed by a typed abort check. Large
WebM remains on bounded ranges, and local byte/blob sources retain their existing range behavior.

The first implementation used the generic `ReadableStream` GET seam. It remained strict-green (69/69
WebM tests) and improved the real 31-sample recorder median only from 6.375 to 6.040 ms because multiple
body pulls plus final concatenation copied the already-complete response. The measured browser A/B's
1.200 ms GET result used `Response.arrayBuffer()` directly. The production follow-up therefore adds an
optional abortable owned whole-read capability to URL-backed `ByteSource`; small complete WebM uses it to
materialize one exact response buffer, while all ordinary streaming consumers and every bounded range
policy remain unchanged. Tests require that direct seam, exact size validation, and abort-after-read.

### Fresh same-cohort audio comparison

The first post-change matched run used Chromium 149, one shared non-headless browser cohort, result reuse
disabled, exhaustive four-file rotations, three warmups, and nine fresh samples per file. All 16 executed
cells passed their strict oracles. Raw result:
`../media-test/results/raw/chromium-2026-07-14T05-09-24-330Z.json`.

| scenario | aibrush-media (ms) | Mediabunny (ms) | matched result |
|---|---:|---:|---|
| `probe/wav_s16` | 16.865 | 10.455 | loss; aibrush baked-file MAD 2.135 ms |
| `probe/wav_s24` | 16.540 | 14.420 | loss; aibrush baked-file MAD 2.220 ms |
| `probe/wav_f32` | 17.635 | 14.140 | loss; aibrush baked-file MAD 4.575 ms |
| `probe/realworld_mdn_trex_mp3` | **13.695** | 14.475 | win |
| `probe/mp3_cbr_notoc` | **13.215** | 16.950 | win |
| `probe/flac_seektable` | **13.160** | 13.325 | narrow win; repeat required |
| `probe/flac_noseektable` | **11.585** | 14.155 | win |
| `probe/aac_adts` | **15.800** | 22.330 | win |

The WAV aggregates are not yet actionable because their first exhaustive rotation was the outlier in every
aibrush row: the other three f32 medians were 2.060–2.395 ms versus Mediabunny's 3.400–3.565 ms, while the
baked f32 median was 10.860 ms with 4.575 ms MAD. WAV s16 showed a smaller recurring 0.5–0.7 ms gap on the
three real rotations, while s24 split those rotations. A stronger 5-warmup/15-sample three-engine cohort is
therefore required before changing the shared WAV policy; differences below each row's variability remain
noise, not evidence for another format branch.

That stronger cohort is
`../media-test/results/raw/chromium-2026-07-14T05-26-57-295Z.json`. All aibrush and Mediabunny cells
passed. Remotion passed s16 at 16.720 ms, failed three of four s24 inputs, and did not support f32. The
matched passing aggregates were aibrush/Mediabunny: s16 15.585/14.540 ms, s24 15.895/14.065 ms, and f32
17.605/14.490 ms. In every aibrush row the first baked median remained 6.160–6.700 ms, while the following
three rotations were 3.030–3.915 ms; for s16 aibrush beat Mediabunny on all three of those later rotations.
Read-only HTTP response checks proved that baked and rotated assets both receive the same no-store 206,
16,384-byte response, ruling out a server Range-policy difference.

The recurring product overhead was inside the canonical sparse-walker control flow: after the one remote
range completed, `fmt `, its body, and `data` were each revisited through an async `readAt()` even though all
three byte views were already in the first owned window. The general fast path now parses a canonical
complete RIFF prelude synchronously immediately after that single await. A non-canonical prelude reuses the
same initial bytes in the existing declared-offset sparse walker, so large JUNK/LIST/PAD, malformed sizes,
short reads, cancellation, and bounded fallback behavior are unchanged. The exact real corpus/range oracles
and source tests pass 157/157; repository typecheck passes. A synchronized repeat of the same 5/15 cohort is
the acceptance comparison for this change.

### Unknown-size MIME routing and exact WAV transport

The remaining WAV gap was outside the RIFF parser. The versioned harness supplies concrete audio MIME but
its fresh URL source has not learned size yet, so public `probe()` performed image sniffing first. Exact
transport correlation measured two requests per canonical WAV probe: `[0,4096)` for image magic followed
by `[4096,16384)` for the hinted driver. A fail-first engine test now requires an unknown-size seekable
concrete-MIME source to invoke no image sniff and exactly one container range while retaining typed
wrong-MIME image fallback. ADR-311 routes that general source shape directly to the hinted container; the
first 206 learns size and exact-source prefix caching preserves fallback bytes.

After the change the exact baked-WAV profile issued only `bytes=0-127` and measured 3.930 ms over 15
samples. Fresh exhaustive same-cohort Chromium evidence (three warmups, nine measured samples per each of
four files) is `../media-test/results/raw/chromium-2026-07-14T06-41-40-048Z.json`: aibrush/Mediabunny
aggregates were 13.540/15.835 ms for s16, 13.120/16.555 ms for s24, and 13.450/17.560 ms for f32. Every
cell passed its strict oracle.

### Unknown-size remote WebM crossover window

The harness recorder source also begins with unknown size, so the known-small ADR-307/309 route could not
activate. Exact pre-change correlation measured `[0,8192)` followed by `[8192,200011)` and an 8.140 ms
15-sample median. A fail-first real-fixture oracle reproduced two driver reads and required one bounded
`[0,262144)` request instead. ADR-312 starts only unknown-size remote WebM at that crossover: small servers
clamp to EOF; large sources stay bounded and continue the existing ladder only when grammar requires it.
The strengthened 65-test WebM suite proves exact terminal metadata, large-source boundedness, and
cancellation after I/O; typecheck and build pass.

The exact post-change transport profile issued one `bytes=0-262143` request and measured 4.900 ms over 15
samples. Two independent fresh non-headless cohorts (five warmups, 15 measured) both passed strict truth:
`../media-test/results/raw/chromium-2026-07-14T06-57-03-553Z.json` measured aibrush 4.210 ms,
MediaBunny 5.755 ms, and ffmpeg.wasm 6.985 ms; `../media-test/results/raw/chromium-2026-07-14T06-58-59-080Z.json`
measured aibrush 4.065 ms versus MediaBunny 5.220 ms.

## Fresh all-engine acceptance matrix

The synchronized non-headless Chromium 149 matrix is
`../media-test/results/raw/chromium-2026-07-14T07-04-59-806Z.json`: result reuse disabled, exhaustive
current file rotations, three warmups, nine measured samples per file, all six engines currently
registered by the versioned harness, and 78/78 cells completed. It produced 51 strict passes, 25 honest
unsupported results, and two competitor errors; every aibrush cell passed all of its file oracles. The
table uses the acceptance aggregate (sum of exhaustive per-file medians) and compares the fastest passing
competitor in that same cohort.

| scenario | aibrush (ms) | fastest passing competitor (ms) | matrix result |
|---|---:|---:|---|
| `probe/wav_s16` | **12.295** | MediaBunny 13.800 | win |
| `probe/wav_s24` | **12.870** | MediaBunny 15.500 | win |
| `probe/wav_f32` | 14.160 | MediaBunny **13.460** | noisy loss; repeated below |
| `probe/pcm_s16be` | **23.740** | ffmpeg.wasm 28.975 | win |
| `probe/realworld_mdn_trex_mp3` | **11.545** | MediaBunny 14.045 | win |
| `probe/mp3_cbr_notoc` | **12.125** | MediaBunny 13.540 | win |
| `probe/flac_seektable` | **11.710** | MediaBunny 12.895 | win |
| `probe/flac_noseektable` | 13.945 | MediaBunny **12.630** | noisy loss; repeated below |
| `probe/aac_adts` | **12.120** | MediaBunny 17.215 | win |
| `probe/opus` | **12.680** | MediaBunny 13.780 | win |
| `probe/recorder_headerless` | **3.765** | MediaBunny 6.410 | win |
| `probe/longform_1h_audio` | **21.375** | MediaBunny 31.070 | win |
| `probe/micro_h264_1frame` | **3.155** | MP4Box 3.160 | unresolvable margin; repeated below |

The f32 and FLAC reversals contradicted earlier matched wins and their per-file MADs reached 1.9 ms, while
the micro-H.264 margin was only 0.005 ms. No code was changed on that evidence. A fresh isolated five-
warmup/15-sample repeat, `../media-test/results/raw/chromium-2026-07-14T07-49-57-182Z.json`, resolved
f32 at **12.925/13.620 ms** (aibrush/MediaBunny) and micro H.264 at **3.290/3.885/3.960 ms**
(aibrush/MediaBunny/MP4Box), all strict-pass. FLAC-no-SEEKTABLE was still only 13.015/13.125 ms, so a
larger five-warmup/31-sample cohort was required. That final confidence run is
`../media-test/results/raw/chromium-2026-07-14T07-58-35-311Z.json`: aibrush **12.350 ms** versus
MediaBunny **14.850 ms**, with aibrush faster on each of the four exhaustive files. Thus every one of the
13 requested scenarios has a fresh, multi-sample, strict-pass lead against every current passing engine;
small contradictory samples were treated as noise rather than used to justify another production branch.

## Final packaging correction

The canonical gate exposed two unrelated startup-closure regressions after the probe wins were established.
Moving the codec conversion coordinator behind its already-selected operation boundary reduced the eager
emitted closure from 51.58 to 48.88 KiB. Replacing static default MP4/WebM registration with exact-signature
lazy proxies reduced the typical default closure from 263.32 to 53.75 KiB. These changes are general loading
corrections, not probe-algorithm changes: direct drivers are unchanged, proxy surfaces and support truth are
tested, real MP4/WebM probes delegate through the proxies, and demuxers are closed in the regression test.
ADRs 313 and 314 record the cold boundaries and their lifetime/error invariants. A final fresh browser
cohort is required after the complete quality gate so the acceptance record corresponds to this exact tree.

The first complete gate caught a concurrent-first-write defect in the generic lazy mux proxy: parallel
audio/video drains could both resume from the shared driver import and construct different underlying
muxers. Three pre-existing strict WebM packet-manifest oracles rejected the lost first video packet. The
proxy now memoizes the complete underlying-muxer construction, not only the driver import; all concurrent
writes share one track map and output pump. The focused 26-test proxy/gapless suite is strict-green, including
byte-hashed packet payloads and exact timestamps on the real multi-track rotations.

## Post-packaging all-engine confirmation

The first fresh cohort after cold-loading MP4/WebM and codec conversion is
`../media-test/results/raw/chromium-2026-07-14T08-50-05-734Z.json`: non-headless Chromium 149, no page
reuse, exhaustive fixtures, three warmups, nine measured samples, all six current engines, and all 78
engine/scenario cells. The harness reported 51 strict passes, 25 supported-feature `NA` cells, and two
competitor errors. Every aibrush cell passed its strict oracle.

| Scenario | aibrush median (ms) | Next passing engine (ms) | Result |
| --- | ---: | ---: | --- |
| `probe/wav_s16` | 14.725 | MediaBunny 14.825 | lead |
| `probe/wav_s24` | 13.750 | MediaBunny 16.935 | lead |
| `probe/wav_f32` | 12.110 | MediaBunny 13.760 | lead |
| `probe/pcm_s16be` | 20.735 | ffmpeg.wasm 30.845 | lead |
| `probe/realworld_mdn_trex_mp3` | 15.290 | MediaBunny 15.610 | lead |
| `probe/mp3_cbr_notoc` | 12.950 | MediaBunny 13.745 | lead |
| `probe/flac_seektable` | 13.845 | MediaBunny 15.215 | lead |
| `probe/flac_noseektable` | 15.325 | MediaBunny 15.645 | lead |
| `probe/aac_adts` | 16.365 | MediaBunny 18.415 | lead |
| `probe/opus` | 13.980 | MediaBunny 14.540 | lead |
| `probe/recorder_headerless` | 4.440 | MediaBunny 5.735 | lead |
| `probe/longform_1h_audio` | 21.465 | MediaBunny 41.405 | lead |
| `probe/micro_h264_1frame` | 4.515 | MediaBunny 3.790 | noisy loss |

The sole short-cohort loss was isolated rather than accepted or optimized speculatively. A five-warmup,
31-sample confidence cohort across the six closest rows is
`../media-test/results/raw/chromium-2026-07-14T09-35-13-510Z.json`. It measured aibrush/MediaBunny at
14.965/15.910 ms (`wav_s16`), 14.645/16.230 ms (MDN MP3), 15.075/16.575 ms (CBR MP3),
14.395/15.095 ms (FLAC without SEEKTABLE), and 14.800/15.295 ms (Opus). Micro H.264 measured
3.810/3.850/4.295 ms for aibrush/MediaBunny/MP4Box. The 0.040 ms micro lead was smaller than dispersion,
so the complete transport, adapter, runner, and parser path was profiled before making another change.

## Tiny known-source Range transport

The 5,546-byte faststart MP4 parser itself took approximately 0.004 ms and was not the bottleneck. In a
self-contained browser layer benchmark, raw driver, public targeted probe, and adapter layers all rounded
to 0.30 ms. Against the exact versioned harness server, 31 alternated fresh samples exposed the shared URL
transport: plain GET was 3.825 ms, exact Range was 2.045 ms, and high-priority exact Range was 1.680 ms.
The source layer had converted every known full window at or below 16 KiB to plain GET, losing the caller's
bounded high-priority transport semantics.

The pre-change source regression required Range on tiny full-window reads and failed in exactly the two
URL/byte-mode cases. Removing that generic conversion made every non-empty `range()` call retain Range and
high priority; the existing HTTP 200 fallback continues to support servers that ignore Range. Focused source,
MP4, and lazy-default tests then passed 117/117. No parser, MIME, filename, size, hash, benchmark id, fixture,
metadata oracle, cancellation path, or resource-lifetime rule selects the optimization. ADR-315 records the
transport invariant.

The authoritative post-change focused cohort is
`../media-test/results/raw/chromium-2026-07-14T10-23-15-110Z.json`: non-headless Chromium 149, no reuse,
exhaustive, five warmups and 31 measured samples. All three engines strict-passed; medians were aibrush
3.820 ms, MediaBunny 3.915 ms, and MP4Box 4.140 ms. Together with the independent 15-sample and pre-change
31-sample wins, this establishes repeatable micro-H.264 leadership while keeping the change on the shared
source transport rather than the fixture parser.

## Exact-tree final acceptance

The canonical repository gate passed after the shared source change: 212 test files and 3,925 tests,
statements 92.90%, branches exactly 90.00%, complete typecheck/lint/format/generator/build/dist/package/
integrity checks, eager closure 48.66 KiB, and typical default-operation closure 53.83 KiB. The first final
browser attempt was deliberately excluded from acceptance after its 30-minute whole-run ceiling stopped it
at 47/78 cells. Its partial data was not reused.

The complete exact-tree all-engine cohort is
`../media-test/results/raw/chromium-2026-07-14T11-04-36-180Z.json`: non-headless Chromium 149, all six
current engines, all 13 requested rows, exhaustive fixtures, no reuse, a new randomized order, three warmups,
nine measured samples per fixture, and 78/78 cells. It closed with 51 strict passes, 25 honest `NA` cells,
and the same two competitor errors. All 13 aibrush rows strict-passed every admissible file.

| Scenario | aibrush aggregate (ms) | Fastest other strict pass (ms) | Short-cohort result |
| --- | ---: | ---: | --- |
| `probe/wav_s16` | 15.015 | MediaBunny 16.055 | lead |
| `probe/wav_s24` | 14.770 | MediaBunny 15.815 | lead |
| `probe/wav_f32` | 14.595 | MediaBunny 14.060 | noisy inverse |
| `probe/pcm_s16be` | 19.540 | ffmpeg.wasm 28.705 | lead |
| `probe/realworld_mdn_trex_mp3` | 14.135 | MediaBunny 15.235 | lead |
| `probe/mp3_cbr_notoc` | 15.275 | MediaBunny 15.385 | lead |
| `probe/flac_seektable` | 14.340 | MediaBunny 15.515 | lead |
| `probe/flac_noseektable` | 14.020 | MediaBunny 13.205 | noisy inverse |
| `probe/aac_adts` | 16.265 | MediaBunny 16.825 | lead |
| `probe/opus` | 14.150 | MediaBunny 15.145 | lead |
| `probe/recorder_headerless` | 4.790 | MediaBunny 5.230 | lead |
| `probe/longform_1h_audio` | 20.700 | MediaBunny 27.275 | lead |
| `probe/micro_h264_1frame` | 3.880 | MediaBunny 3.465 | noisy inverse |

The three inversions contradicted prior cohorts and were within observed browser dispersion, so no production
change followed them. The final close-row confidence cohort is
`../media-test/results/raw/chromium-2026-07-14T11-49-39-277Z.json`: a fresh randomized run, exhaustive,
no reuse, five warmups and 31 measured samples per fixture, with aibrush, MediaBunny, Remotion, and MP4Box.
All nine executable cells strict-passed and three unsupported cells were honest `NA`s:

| Scenario | aibrush aggregate (ms) | Other strict-pass aggregates (ms) | Result |
| --- | ---: | --- | --- |
| `probe/wav_f32` | 14.810 | MediaBunny 16.410 | lead |
| `probe/flac_noseektable` | 14.520 | MediaBunny 15.040; Remotion 16.485 | lead |
| `probe/micro_h264_1frame` | 3.665 | MediaBunny 3.725; MP4Box 3.850; Remotion 4.255 | lead |

Thus the exact final tree has a repeatable fresh multi-sample lead on every requested row. Every passing
competitor from the complete matrix is either beaten directly in that matrix or in the higher-confidence
same-tree follow-up; the farther competitors remain behind by substantially larger margins in the complete
matrix. No cached measurement, partial run, unsupported cell, or failed oracle contributes to the result.
