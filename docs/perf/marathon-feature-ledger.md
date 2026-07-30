# Media marathon feature ledger

Date: 2026-07-29
Benchmark: sibling `../media-test` checkout, treated as immutable
Required benchmark protocol: Chromium, exhaustive candidates, `--warmup 1 --iters 5 --no-reuse`

This ledger separates product evidence from benchmark/corpus applicability. A `PASS` below means the
latest retained all-engine feature artifact has a passing aibrush aggregate for that scenario. An
`EXTERNAL` item is not converted into a product pass: it records the independent evidence showing why
the immutable harness cannot currently produce a valid verdict.

## Current verification state

- Final focused filter verification:
  `bun run test -- src/filters/gpu-video.test.ts src/filters/cpu-video.test.ts` — 159 tests passed.
- Focused capability verification:
  `bun run test -- src/api/job-runner.test.ts src/api/chain.test.ts src/drivers/mp4/ops.test.ts
  src/api/create-media.test.ts src/api/codec-pipeline.test.ts` — 5 files / 366 tests passed,
  covering public secondary-track decode, ambiguous-selection rejection, fragmented A/V trim,
  declarative-schema propagation, and fluent-chain propagation.
- Final type verification: `bun run typecheck` — passed.
- The exact final `bun run gate` passes 246 test files / 4,498 tests, 93.12% statement and line
  coverage, 90.01% branch coverage, 96.06% function coverage, both TypeScript projects, generator
  tests, a 772-file Biome check, build, WASM vendoring, 10/10 dist-smoke tests, clean package-install
  verification, eager-kernel budget 49.74 kB / 50.00 kB, typical-app budget 67.56 kB / 256 kB, and
  all 51 anti-cheat checks.
- Post-probe focused verification covers abort-aware source I/O and MP4 probing (71/71), prepared
  native packet fusion and provenance (38/38), MP4 language parsing/public propagation (42/42), the
  complete MP4 driver suite (758/758), and corpus/anti-cheat checks (24/24). Typecheck,
  `git diff --check`, build, WASM vendoring, and bundle budgets are green; current eager-kernel size
  is 49.74 kB / 50.00 kB and typical-app size is 67.56 kB / 256 kB.
- Exact `bun run sync-vendor` succeeded after the latest demux implementation. The generated provenance
  records source revision `a6a3cda5c3cf3100050740d876703d5576c65333` (dirty), deterministic
  source-tree digest `f504689911711f144fbba1522e800495c705d3c3b00a254acdb62d1d276a091c`, and hashes for all four
  bundled WASM artifacts. The benchmark worktree contains only that expected generated provenance
  modification.
- The benchmark result schema does not embed the generated source revision or tree digest. Sync
  immediately preceded the retained audio runs, but a copied result JSON is therefore not
  self-authenticating without its adjacent generated provenance file.
- Fresh exhaustive audio closure on the synced source:
  `chromium-2026-07-28T08-30-56-544Z.json` completed all 216 six-engine cells with 92 PASS,
  124 NA_ENGINE, and no FAIL or ERROR. Aibrush has the broadest audio coverage at 33 PASS /
  3 NA_ENGINE, ahead of FFmpeg.wasm at 29 / 7 and Mediabunny at 24 / 12.
- Fresh exhaustive probe closure on the final synced source:
  `chromium-2026-07-28T09-34-45-434Z.json` completed all 360 six-engine cells. Aibrush records
  50 PASS / 10 NA_ENGINE / 0 FAIL / 0 ERROR and passes all 144 applicable exhaustive children.
  Its 39 child NAs are exclusively the immutable adapter's whole-file declaration for contracts
  requiring range or progressive delivery.
- Fresh exhaustive demux closure on the final gated and synced source:
  `chromium-2026-07-28T11-01-09-472Z.json` completed all 294 six-engine cells. Aibrush records
  45 PASS / 4 NA_ENGINE / 0 FAIL / 0 ERROR and 133 PASS / 17 NA_ENGINE exhaustive children.
  Sixteen child NAs are the immutable first-packet scale declaration; the remaining MKV child has a
  non-media JSON track plus an MJPEG attachment that the adapter cannot project into its canonical
  audio/video packet representation.
- Fresh `bun scripts/bench-dsp.ts --check` passes against the committed eight-file, 200-iteration
  product baseline with checksum `439301100` and no operation regression. The general band-limited
  resampler sustains 1,174× realtime geomean and 923× realtime in the slowest corpus case; this is
  product evidence, not substituted for missing cross-engine harness measurements.
- The required all-engine transcode closure ran for more than 71 minutes, then the immutable result
  validator aborted at result 142 on a self-inconsistent candidate-evidence reduction. Its canonical
  141-result partial is
  `../media-test/results/raw/.partial/chromium-2026-07-27T21-53-21-169Z.partial.json`.
- A complete final all-engine matrix cannot reach a terminal artifact while that deterministic validator
  failure remains. Repeating an unchanged broad run would violate the required feature loop.

## Latest retained family closures

| Family | Latest all-engine artifact | Aibrush aggregate | Remaining applicability |
| --- | --- | ---: | --- |
| transcode (partial) | `.partial/chromium-2026-07-27T21-53-21-169Z.partial.json` | 15 PASS, 3 FAIL, 5 NA_ENGINE, 2 NA_ASSET | Immutable transform matcher, support declarations, and validator abort documented below |
| performance | `chromium-2026-07-27T04-38-47-186Z.json` | 31 PASS, 2 NA_ENGINE | Massive packet-table materialization; H.264-in-WebM is illegal |
| audio-dsp | `chromium-2026-07-28T08-30-56-544Z.json` | 33 PASS, 3 NA_ENGINE | Product-authored 5.1 mix matrix and endianness round trip are blocked by immutable adapter forwarding/declarations; image-to-audio is inapplicable to every engine |
| demux | `chromium-2026-07-28T11-01-09-472Z.json` | 45 PASS, 4 NA_ENGINE | Benchmark support rejects scale cells before execution because it requires a first-packet boundary |
| robustness | `chromium-2026-07-27T11-11-01-171Z.json` | 56 PASS, 7 NA_ENGINE | Reserve mode, pending image vocabulary, trim composition, FLAC seek equivalence |
| probe | `chromium-2026-07-28T09-34-45-434Z.json` | 50 PASS, 10 NA_ENGINE | Benchmark adapter declares whole-file delivery for the large/huge/massive probe cells |
| mux | `chromium-2026-07-27T12-07-50-559Z.json` | 46 PASS, 5 NA_ENGINE, 2 NA_ASSET | Full Matroska DTS/BlockDuration contract, reserve/co64 declarations, two pending rotation goldens |
| remux | `chromium-2026-07-27T13-51-31-235Z.json` | 47 PASS, 2 FAIL | Both FAILs are the shared browser reference artifact documented below |
| decode-seek | `chromium-2026-07-27T14-36-38-443Z.json` | 44 PASS, 1 NA_ENGINE, 1 NA_ASSET | Product secondary-track selection is now implemented; immutable adapter still pre-rejects it; pending rotated-frame golden |
| trim | `chromium-2026-07-27T15-49-22-173Z.json` | 39 PASS, 4 NA_ENGINE | Product fragmented MP4 trim is now implemented; immutable adapter still pre-rejects it; lossy-audio applicability is declaration-gated |
| metadata | `chromium-2026-07-27T16-22-27-231Z.json` | 24 PASS, 1 NA_ENGINE | Benchmark feature declaration for rotation decode |
| encryption | `chromium-2026-07-27T16-44-44-303Z.json` | 17 PASS, 4 NA_ENGINE, 3 NA_ASSET | Negative-scheme routing and missing/pending clear-reference corpus evidence |
| streaming-output | `chromium-2026-07-27T17-20-45-533Z.json` | 21 PASS, 6 NA_ENGINE | Exact write-size control, reserve mode, and finite-WebM stream-target declaration |

These are family closure artifacts, not the required final matrix. Transcode is explicitly a canonical
partial because the immutable validator terminated the run before it could write a normal raw artifact.

## External verdict evidence

### Audio closure: coverage lead and the rankable performance boundary

The required six-engine audio command ran on the immediately synced source:

`bash scripts/run.sh --browser chromium --feature audio-dsp --pillar all --warmup 1 --iters 5
--exhaustive --no-reuse --random-seed audio-final-20260728-v4`

It completed all 216 cells with no FAIL or ERROR. Per-engine coverage was:

- aibrush-media: 33 PASS, 3 NA_ENGINE;
- FFmpeg.wasm: 29 PASS, 7 NA_ENGINE;
- Mediabunny: 24 PASS, 12 NA_ENGINE;
- Remotion: 6 PASS, 30 NA_ENGINE;
- MP4Box and web-demuxer: 0 PASS, 36 NA_ENGINE each.

Only eight file-level scenario rows expose the requested one warmup plus five measured wall samples
for both aibrush and an implementing rival: the four AIFF and four CAF probe variants. The normalized
reporter classifies the run's cohorts as `NOT_COMPARABLE` because required cohort dimensions and
engine-record fields are incomplete (normalized report content hash
`3436f4cfefa817395d2998131b2b5b68ef9c587f7aa57ce3734b03f42dc58e5e`). The following is
therefore a manual exact-input-hash wall-time comparison, not a reporter-certified leaderboard.
Using median wall time, median absolute deviation, and declaring a lead only when the median gap
exceeds the sum of both deviations, aibrush records **8 leads, 0 ties, and 0 losses** within that
evidence cut:

| Probe candidate | Aibrush median ± MAD | Best rival median ± MAD | Verdict |
| --- | ---: | ---: | --- |
| AIFF `01` | 0.370 ± 0.005 ms | FFmpeg.wasm 1.290 ± 0.190 ms | LEAD |
| AIFF `02` | 0.400 ± 0.030 ms | FFmpeg.wasm 1.175 ± 0.040 ms | LEAD |
| AIFF `03` | 0.480 ± 0.040 ms | FFmpeg.wasm 1.270 ± 0.080 ms | LEAD |
| AIFF baked | 0.390 ± 0.025 ms | FFmpeg.wasm 1.765 ± 0.300 ms | LEAD |
| CAF `01` | 0.380 ± 0.020 ms | FFmpeg.wasm 1.060 ± 0.030 ms | LEAD |
| CAF `02` | 0.400 ± 0.050 ms | FFmpeg.wasm 2.105 ± 0.305 ms | LEAD |
| CAF `03` | 0.410 ± 0.015 ms | FFmpeg.wasm 1.235 ± 0.070 ms | LEAD |
| CAF baked | 0.670 ± 0.230 ms | FFmpeg.wasm 2.105 ± 0.320 ms | LEAD |

The remaining audio transforms pass correctness but cannot support an honest cross-engine speed rank
from this artifact. Of the 93 passing aibrush inputs, 80 have no wall result: 50 because the neutral
result reader does not support the output format, 23 because of memory-protocol errors, and seven
because a sample-frame numerator is unavailable. Empty, corrupt, and fuzz rows expose only a single
correctness execution rather than five measured samples. UI cell duration and those one-sample values
are not substituted for the required benchmark distribution.

For transparency, the five comparable one-shot robustness/boundary rows in this closure are:

| One-shot row | Aibrush | Best passing rival |
| --- | ---: | ---: |
| truncated AIFF probe | 31.905 ms | FFmpeg.wasm 82.170 ms |
| empty audio transcode | 33.580 ms | Remotion 7.630 ms |
| truncated WAV probe | 28.100 ms | Remotion 11.510 ms |
| corrupt WAV `fmt` transcode | 26.530 ms | Mediabunny 20.565 ms |
| bit-flipped WAV decode | 33.340 ms | Mediabunny 24.880 ms |

These are real cold/boundary latency observations, but each has `n=1`, `warmup=0`, and
`benchmarkLoop=false`; they cannot support a statistical speed rank. The product retains the
lightweight WAV probe split: generic fresh-process Bun probes fell from about 9–10 ms before the split
to 4.6–5.0 ms after it, while the full 11.6 kB WAV driver stays lazy for non-probe operations.
Browser experiments that changed generic byte/image precedence or co-located WAV registration did not
produce a repeatable Chromium improvement and were reverted. No malformed-input shortcut, fixture
signature, or benchmark-only preload was retained.

For the UI concern that motivated the audio pass, the final closure's non-rankable whole-cell
`durationMs` fallback shows aibrush fastest on 25 of its 33 passing rows, rather than losing most rows.
That count is diagnostic only: it mixes operation, adapter/oracle work, and failed memory-sampler waits.
A fresh four-scenario repeat (`chromium-2026-07-28T08-25-20-430Z.json`) reversed the apparent
big-endian encode, explicit-matrix downmix, and long-form probe gaps: aibrush recorded 4,280 ms versus
FFmpeg.wasm 5,151 ms, 1,200 ms versus Mediabunny 1,445 ms, and 4,519 ms versus Mediabunny 5,141 ms,
respectively. Product-only exact-fixture medians are 0.749 ms for the s16-to-s16be rewrite and
1.198 ms for the 480,000-frame 5.1-to-stereo matrix transform. The remaining s24 decode fallback is
dominated by 4,096 sequential harness SHA-256 operations; the product's 4,096-frame s24 conversion is
approximately 0.01 ms. No speculative hot-loop change was retained from those fallback durations.

The three aibrush NAs are not product execution failures:

- `upmix_stereo_to_5_1`: the public product implements `AudioTarget.mixMatrix` /
  `PcmTransform.mixMatrix`, but the immutable adapter rejects the authored matrix and does not forward it;
- `meta_roundtrip_endianness_s16`: the product implements the endianness round trip, but the immutable
  support declaration omits the feature token;
- `negative_image_into_audio_transcode`: image-to-audio is inapplicable and unsupported by every engine.

Across exhaustive input variants, aibrush passes 93/102, ahead of FFmpeg.wasm at 89/102 and
Mediabunny at 63/102. The nine aibrush NAs are exactly four endian-round-trip adapter declarations,
four universally inapplicable image-to-audio variants, and the one authored 5.1-matrix adapter gap.

### Demux closure: feature-by-feature 2026-07-29 pass

All 49 current `demux/*` definitions were enumerated from the sibling acceptance harness and run
individually against all six scored engines in fresh Chromium, with exhaustive inputs, one warmup, five
measured iterations, and no reuse. The per-cell artifacts are listed below. The product gate then passed
251 test files / 4,538 tests, 90.00% branch coverage, typecheck, the 782-file Biome check, production
build, generator checks, 11 dist-smoke tests, package install/exports/TypeScript checks, and all 51
anti-cheat checks. The eager kernel is 49.72 kB / 50.00 kB and the typical-app closure is
67.59 kB / 256 kB.

The retained product changes are general-purpose:

- finite immutable Blob sources now share an owned, bounded start-at-zero byte handoff across `demux`,
  `packetInfo`, and `packetInfoBatches`; every operation still reparses and receives a defensive byte
  copy, while mutable, unknown-size, non-Blob, expired, aborted, and oversized ranges bypass retention;
- MPEG-TS exposes an exact payload-free packet-info table, and a live demuxer exposes the same facts
  without replaying packet streams;
- the H.264 TS parser scans each PES once for IDR and access-unit boundaries and reuses proven
  one-access-unit-per-PES payloads while preserving the general cross-PES fallback and DTS repair;
- known-empty demux input throws a typed `InputError` before source I/O or driver routing, with
  already-aborted callers retaining abort precedence;
- focused lifecycle, cancellation, source-mutation isolation, malformed-boundary, and cache-boundary
  regressions cover the new paths.

The TS optimization moved the aibrush aggregate median for `demux/h264_ts` from 25.535 ms in
`chromium-2026-07-29T16-07-17-025Z.json` to 6.965 ms in
`chromium-2026-07-29T16-21-58-641Z.json`; the final closure measured 7.465 ms. It preserves exact
packet count, byte size, PTS, DTS, keyframe classification, global decode ordering, and the
cross-PES fallback.

After the gate, `bun run sync-vendor` refreshed the generated aibrush vendor at source revision
`6ac6ab3f82614d83ed52dd57fb5d18c8854039f5 (dirty)`. The required closure command was:

`bash scripts/run.sh --browser chromium --base-url http://127.0.0.1:52009 --feature demux
--pillar all --exhaustive --no-reuse --warmup 1 --iters 5 --random-seed 20260729`

The completed artifact is `chromium-2026-07-29T17-56-19-540Z.json`. It accounts for all 294/294
parent cells: 221 PASS, 72 NA_ENGINE, and one external FFmpeg.wasm FAIL. Its raw SHA-256 is
`307629ced874caa2871bff3281f925668c697bcb59a61fd0455648df5b3be5bf`; embedded content hash is
`29c2cb39deac8b9dca6714f918fd01330cc1b84237eb0f753121f2c599cd449b`; run ID is
`run-c22aad57a5b6ade917a84d8ee0e39844c0d6a72e426ab34de797681b9d03b76e`; manifest digest is
`6e5b246a08548e1edb5b12280c01cf781a5d06b95af1050dc7e3436ed56423`; and corpus checksum is
`b9dbeb1115c2d5c27bcb68c641b0fcd58453376d4a889d00c0323bd7786249a9`.

Per-engine parent coverage is unchanged in shape from the prior closure:

- aibrush-media: 45 PASS, 4 NA_ENGINE;
- Mediabunny: 47 PASS, 2 NA_ENGINE;
- FFmpeg.wasm: 44 PASS, 4 NA_ENGINE, 1 FAIL;
- Remotion: 40 PASS, 9 NA_ENGINE;
- web-demuxer: 27 PASS, 22 NA_ENGINE;
- MP4Box: 18 PASS, 31 NA_ENGINE.

Across the 150 exhaustive children per engine, aibrush records 133 PASS and 17 NA_ENGINE. Sixteen NAs
are the declared `AIBRUSH_DEMUX_SCALE_PACKET_BOUNDARY_UNAVAILABLE` result for the four scale scenarios:
the product materializes a complete packet table and does not expose the first-packet boundary that the
scale timing contract requires. The seventeenth is hidden `demux/h264_in_mkv` candidate `03.mkv`,
whose JSON track and MJPEG attachment cannot be projected into the canonical audio/video result.
Aibrush has zero demux FAIL or ERROR children or parents.

The sole closure failure is not an aibrush result. On `demux/h264_1080p_5s` candidate `01.mov`,
FFmpeg.wasm passes all 472 exact golden packet rows, including DTS after a track-local origin shift, but
reports the contradictory nominal CFR value 20.49 fps. The authoritative packet timeline is VFR at
30.000589 fps with a 29.844510–30.272758 fps observed envelope, so `golden-metadata` correctly fails
that rival output. A fresh isolated rerun reproduced the same 3/4 aggregate failure in
`chromium-2026-07-29T18-18-34-625Z.json` (raw SHA-256
`3654f6dc8129cda44d2e2fed92f453601373e4b31f0123df864850a382f53b9b`). The harness, competitor
adapter, golden, oracle, and support rules are immutable for this work, and changing aibrush cannot
alter a rival cell. This is retained as `EXTERNAL`; it is not relabelled as PASS or NA_ENGINE.
Consequently, the immutable all-engine artifact does not satisfy a literal zero-FAIL closure.

The suite does not provide the cohort dimensions needed for a reporter-certified cross-engine
leaderboard. A same-scenario, same-input-SHA diagnostic using the suite's descriptive 3% band gives:

| Rival | Matched PASS rows | Aibrush leads | Within 3% | Aibrush losses | Geomean rival / aibrush |
| --- | ---: | ---: | ---: | ---: | ---: |
| FFmpeg.wasm | 132 | 129 | 2 | 1 | 3.025× |
| Remotion | 110 | 106 | 0 | 4 | 6.856× |
| web-demuxer | 79 | 78 | 0 | 1 | 5.883× |
| Mediabunny | 128 | 66 | 1 | 61 | 1.068× |
| MP4Box | 50 | 2 | 1 | 47 | 0.509× |
| Fastest rival per row | 133 | 60 | 4 | 69 | 0.922× |

These counts are diagnostic, not statistical win claims. The remaining losses are concentrated in
MP4Box's narrower ISO parser and Mediabunny's compact audio parsers. Aibrush returns richer public
packet and decoder-configuration evidence, after which the immutable adapter rebuilds and copies its
own representation. Removing packet facts, configuration, track metadata, or validation would weaken
the product result or optimize only the harness, so those shortcuts were not retained.

The final closure medians below are median-of-exhaustive-file medians. The rival column includes only
PASS engines with the same passing input-SHA set as aibrush; it is descriptive, not a sole-winner claim.

| Scenario | Cell artifact | Aibrush closure | Median | Fastest coverage-equal rival |
| --- | --- | ---: | ---: | --- |
| `demux/aac_adts` | `chromium-2026-07-29T16-38-03-314Z.json` | PASS 4/4 | 1.372 ms | Mediabunny 1.585 ms |
| `demux/aac_audio_only` | `chromium-2026-07-29T16-38-39-736Z.json` | PASS 1/1 | 2.365 ms | MP4Box 1.710 ms |
| `demux/av1_720p_5s` | `chromium-2026-07-29T16-05-54-110Z.json` | PASS 4/4 | 7.270 ms | FFmpeg.wasm 16.593 ms |
| `demux/empty_audio_zero_packets` | `chromium-2026-07-29T17-25-49-396Z.json` | PASS 1/1 | 0.310 ms | Mediabunny 0.020 ms |
| `demux/flac_noseektable` | `chromium-2026-07-29T16-51-54-392Z.json` | PASS 4/4 | 0.408 ms | Mediabunny 0.287 ms |
| `demux/flac_seektable` | `chromium-2026-07-29T16-42-25-626Z.json` | PASS 4/4 | 0.410 ms | Mediabunny 0.193 ms |
| `demux/fragmented_cmaf` | `chromium-2026-07-29T16-56-42-217Z.json` | PASS 1/1 | 6.125 ms | MP4Box 3.225 ms |
| `demux/gapless_aac` | `chromium-2026-07-29T16-58-39-276Z.json` | PASS 1/1 | 0.370 ms | Mediabunny 0.280 ms |
| `demux/graceful_mp4_header_destroyed` | `chromium-2026-07-29T17-30-00-806Z.json` | PASS 4/4 | 95.493 ms | MP4Box 48.477 ms |
| `demux/graceful_truncated_h264` | `chromium-2026-07-29T17-29-45-442Z.json` | PASS 1/1 | 40.275 ms | MP4Box 8.395 ms |
| `demux/graceful_webm_header_destroyed` | `chromium-2026-07-29T17-30-29-072Z.json` | PASS 4/4 | 66.333 ms | Mediabunny 66.592 ms |
| `demux/graceful_zero_length` | `chromium-2026-07-29T17-29-16-612Z.json` | PASS 1/1 | 76.375 ms | Remotion 8.345 ms |
| `demux/h264_1080p_30s` | `chromium-2026-07-29T15-55-43-426Z.json` | PASS 4/4 | 26.353 ms | Mediabunny 11.560 ms |
| `demux/h264_1080p_5s` | `chromium-2026-07-29T16-03-09-439Z.json` | PASS 4/4 | 17.218 ms | MP4Box 9.158 ms |
| `demux/h264_4k_10s` | `chromium-2026-07-29T16-46-36-203Z.json` | PASS 4/4 | 103.628 ms | MP4Box 46.340 ms |
| `demux/h264_bframes_1080p` | `chromium-2026-07-29T16-00-50-464Z.json` | PASS 4/4 | 26.760 ms | MP4Box 9.790 ms |
| `demux/h264_in_mkv` | `chromium-2026-07-29T16-06-38-536Z.json` | PASS 3/4 | 2.605 ms | Mediabunny 5.860 ms |
| `demux/h264_multitrack` | `chromium-2026-07-29T16-02-29-238Z.json` | PASS 4/4 | 12.710 ms | MP4Box 5.700 ms |
| `demux/h264_rotated90` | `chromium-2026-07-29T16-48-41-683Z.json` | PASS 4/4 | 12.870 ms | MP4Box 4.445 ms |
| `demux/h264_ts` | `chromium-2026-07-29T16-21-58-641Z.json` | PASS 4/4 | 7.465 ms | Mediabunny 14.075 ms |
| `demux/h264_vfr` | `chromium-2026-07-29T16-01-39-841Z.json` | PASS 4/4 | 36.318 ms | MP4Box 22.472 ms |
| `demux/hevc_1080p_10s` | `chromium-2026-07-29T16-43-59-735Z.json` | PASS 1/1 | 40.910 ms | MP4Box 8.880 ms |
| `demux/hls_aes128` | `chromium-2026-07-29T16-51-37-641Z.json` | PASS 1/1 | 14.655 ms | FFmpeg.wasm 67.610 ms |
| `demux/hls_vod` | `chromium-2026-07-29T16-49-52-324Z.json` | PASS 1/1 | 11.960 ms | Mediabunny 40.290 ms |
| `demux/metamorphic_flac_seektable_invariance` | `chromium-2026-07-29T17-30-54-116Z.json` | PASS 1/1 | 2.725 ms | Mediabunny 2.455 ms |
| `demux/mislabeled_h264` | `chromium-2026-07-29T16-57-54-212Z.json` | PASS 1/1 | 0.425 ms | Mediabunny 0.990 ms |
| `demux/mp3_cbr_notoc` | `chromium-2026-07-29T16-54-40-056Z.json` | PASS 4/4 | 2.055 ms | FFmpeg.wasm 2.658 ms |
| `demux/mp3_xing` | `chromium-2026-07-29T16-53-49-313Z.json` | PASS 4/4 | 1.840 ms | Mediabunny 2.397 ms |
| `demux/opus` | `chromium-2026-07-29T16-42-06-683Z.json` | PASS 4/4 | 0.307 ms | Mediabunny 0.535 ms |
| `demux/pcm_s16_caf` | `chromium-2026-07-29T16-59-40-510Z.json` | PASS 1/1 | 0.620 ms | FFmpeg.wasm 2.410 ms |
| `demux/pcm_s16be` | `chromium-2026-07-29T16-56-08-821Z.json` | PASS 4/4 | 0.797 ms | FFmpeg.wasm 0.987 ms |
| `demux/realworld_mdn_flower_mp4` | `chromium-2026-07-29T16-00-11-789Z.json` | PASS 3/3 | 7.580 ms | Mediabunny 3.295 ms |
| `demux/realworld_mdn_flower_webm` | `chromium-2026-07-29T16-04-46-102Z.json` | PASS 4/4 | 2.512 ms | FFmpeg.wasm 3.667 ms |
| `demux/realworld_mdn_trex_mp3` | `chromium-2026-07-29T16-54-21-730Z.json` | PASS 4/4 | 1.478 ms | Mediabunny 1.798 ms |
| `demux/size_huge_huge_h264_1080p_600s` | `chromium-2026-07-29T17-10-13-251Z.json` | NA_ENGINE 0/4 | — | — |
| `demux/size_large_large_h264_1080p_120s` | `chromium-2026-07-29T17-01-59-633Z.json` | NA_ENGINE 0/4 | — | — |
| `demux/size_large_large_vp9_1080p_120s` | `chromium-2026-07-29T17-05-51-121Z.json` | NA_ENGINE 0/4 | — | — |
| `demux/size_massive_massive_h264_1080p_2h` | `chromium-2026-07-29T17-14-36-268Z.json` | NA_ENGINE 0/4 | — | — |
| `demux/size_micro_micro_audio_short` | `chromium-2026-07-29T17-00-23-206Z.json` | PASS 4/4 | 4.760 ms | MP4Box 3.043 ms |
| `demux/size_micro_micro_h264_1frame` | `chromium-2026-07-29T17-00-04-176Z.json` | PASS 1/1 | 0.230 ms | Mediabunny 0.060 ms |
| `demux/size_tiny_tiny_h264_360p_2s` | `chromium-2026-07-29T17-01-07-706Z.json` | PASS 4/4 | 2.953 ms | MP4Box 1.828 ms |
| `demux/size_tiny_tiny_vp9_360p_2s` | `chromium-2026-07-29T17-01-25-850Z.json` | PASS 4/4 | 0.588 ms | Mediabunny 2.660 ms |
| `demux/ts_discontinuity` | `chromium-2026-07-29T16-59-03-533Z.json` | PASS 1/1 | 1.205 ms | Mediabunny 3.540 ms |
| `demux/vp8_720p_10s` | `chromium-2026-07-29T16-05-17-085Z.json` | PASS 4/4 | 2.240 ms | FFmpeg.wasm 3.862 ms |
| `demux/vp9_1080p_10s` | `chromium-2026-07-29T16-03-53-300Z.json` | PASS 4/4 | 13.787 ms | Mediabunny 20.965 ms |
| `demux/vp9_alpha` | `chromium-2026-07-29T16-49-21-376Z.json` | PASS 1/1 | 0.465 ms | Mediabunny 1.560 ms |
| `demux/wav_f32` | `chromium-2026-07-29T16-55-36-297Z.json` | PASS 4/4 | 0.495 ms | Mediabunny 0.255 ms |
| `demux/wav_s16` | `chromium-2026-07-29T16-55-04-756Z.json` | PASS 4/4 | 0.478 ms | Mediabunny 1.270 ms |
| `demux/wav_s24` | `chromium-2026-07-29T16-55-19-382Z.json` | PASS 4/4 | 0.538 ms | Mediabunny 0.845 ms |

### Transcode closure: immutable result-schema validator abort

The required command was run exactly:

`bash scripts/run.sh --browser chromium --feature transcode --pillar all --exhaustive --no-reuse
--random-seed marathon-transcode-closure-20260727-v1 --warmup 1 --iters 5`

After more than 71 minutes and 141 committed results, the benchmark terminated itself with:

`$.results[141].exhaustive[3].status [EXHAUSTIVE_CANDIDATE_EVIDENCE_RESULT_MISMATCH]:
oracle correctness plus candidate evidence reduce to PASS, not NA_ENGINE`

The preserved partial contains 45 PASS, 90 NA_ENGINE, 3 FAIL, 2 NA_ASSET, and 1 NA_BROWSER overall.
Aibrush had reached 15 PASS, 5 NA_ENGINE, 3 FAIL, and 2 NA_ASSET. Its passing coverage includes H.264
B-frame reorder, bitrate and CRF controls, 4K→1080p, H.264→AV1/MKV/MOV/VP9, VP9→AV1/VP8,
HEVC→VP9, malformed input, mismatch handling, and the full four-candidate
VP9-1080p-120s→H.264-720p ladder.

The exception is raised by the immutable benchmark's own schema/reducer after an oracle PASS. Product
code cannot change an already contradictory `NA_ENGINE` candidate record into a validator-consistent
record, and an unchanged retry would deterministically consume the same work and abort at the same seam.

### Rotate 180: interval matcher selects the previous source frame

The immutable transform evaluator extends each source interval by the 1,000 µs tolerance and uses the
first matching source frame. At an exact frame boundary, candidate frame `N` therefore matches source
frame `N-1`. A two-frame synthetic proof imported the evaluator without modifying it:

- candidate PTS `[0, 33333]`: perfect rotated pixels produce FAIL, mean error `0.3125`, max `1`;
- changing only the second candidate PTS to `34334`: the same pixels produce PASS with zero error.

The product must not jitter correct timestamps to evade this matcher. Independent pixel evidence also
shows that plain per-plane I420 reversal is the correct 180-degree transform:

- lossless H.264 round trip, plain reversal: normalized RGBA mean error `0.002304`, max `0.0667`;
- experimental chroma phase shift: mean `0.002715`, max `0.1804`.

The phase shift was removed. The retained implementation reverses Y, U, and V planes independently and
preserves source timing.

Relevant targeted benchmark artifacts:

- `chromium-2026-07-27T18-42-46-388Z.json`
- `chromium-2026-07-27T18-44-57-846Z.json`
- `chromium-2026-07-27T21-52-44-305Z.json` (final synced implementation; playback passes, only the
  effect-property matcher rejects the pixels)

### Effect-aware transform matcher affects crop, flip, rotate, and depth conversion

The same immutable matcher expands every source-frame interval by its 1,000 µs tolerance, then selects
the first match. Presentation-aligned SSIM independently passes while the property oracle pairs an exact
boundary candidate with the preceding source frame:

- crop-center: SSIM 0.9878–0.9943 across the exhaustive candidates, zero timestamp residual;
- 10-bit→8-bit: SSIM 0.999990, zero timestamp residual;
- horizontal and vertical flip: SSIM and playback pass every candidate;
- rotate 90/180/270: playback passes and failures are isolated to the property matcher's maximum pixel
  error at frame boundaries.

The affected focused artifact is `chromium-2026-07-27T23-15-25-030Z.json`; the closure partial independently
contains crop, rotate-270, and 10-bit→8-bit as its only three aibrush failures. Jittering correct product PTS
would be benchmark-specific gaming and is not admissible.

### Contain/letterbox: genuine half-pixel centering defect fixed

For a 1080×1920 source contained in 1280×720, the scaled picture is 405 pixels wide and leaves 875 bar
pixels. The prior product floored the placement to `x=437`, making one bar a full pixel wider. The retained
geometry splits the remainder exactly at `x=437.5` on Canvas2D and WebGPU; the CPU fallback now applies
fractional edge coverage symmetrically rather than indexing a typed array at a fractional coordinate.

Fresh exhaustive aibrush evidence:

- before, `chromium-2026-07-27T23-15-25-030Z.json`: portrait SSIM mean `0.956973` (FAIL);
- final synced build, `chromium-2026-07-27T23-30-42-806Z.json`: portrait SSIM mean `0.996129`,
  minimum `0.994739`, PSNR `43.9 dB`, zero timestamp residual, and playback PASS.

The scenario aggregate remains FAIL only because the immutable contract (a) applies a non-scaling pad
property to the portrait input and errors that the target cannot contain the complete 1080×1920 plane,
(b) frame-mispairs the landscape transform property despite SSIM `0.988764`, and (c) requires alpha
preservation after explicitly selecting H.264, which has no alpha plane.

### Secondary-track decode: product surface closed, immutable adapter stale

The public product now accepts `DecodeOptions.trackSelect` using the established `video:N` /
`audio:N` grammar. Explicit selectors are a whitelist and the one-stream-per-type `MediaStreams`
contract rejects more than one distinct selected track of a type. A custom two-video-track integration
test selects `video:1`, proves that demux packet track ID `20` is opened, emits the secondary frame,
and leaves the primary unopened. A two-video selector rejects with `InputError` before any packet
acquisition. The focused five-file verification above is green.

The immutable adapter probes and resolves the requested track, then still hardcodes that decode exposes
only the primary track and raises `AIBRUSH_DECODE_TRACK_SELECTION_UNSUPPORTED` before calling the
product for a non-primary selection. The retained `decode-seek` `NA_ENGINE` therefore cannot be rerun
into a verdict without changing benchmark-owned forwarding code; it is not recorded as a product pass.

### Fragmented MP4 trim: product and immutable oracle closed, adapter stale

`TrimOptions.fragmented` now reaches keyframe-copy, whole-source, generic stream-copy, and accurate
codec-mux paths, and the option survives fluent-chain and declarative-job validation. Fragmented MP4
input sample runs are recovered before trimming, public second bounds are rounded to native ticks, and
trimmed media durations replace stale initialization durations.

Against the benchmark's exact `fragmented_cmaf.mp4` input and `2.021354`–`4.021354` second window, the
product produced 735,134 bytes from a 1,458,236-byte source. The output box order was `ftyp`, `moov`,
`moof`, `mdat`, `moof`, `mdat`; public probe duration was 2.016 seconds (video 2.000, audio 2.016).
The immutable benchmark oracle was imported read-only and returned
`TRIM_FRAGMENT_STRUCTURE_VALID`: two fragments, two tracks, 155 samples, 1,191-byte initialization
segment, CMAF brand present, and zero-based decode time.

The immutable trim adapter nevertheless rejects `fragmented` before the framework call with
`AIBRUSH_FRAGMENTED_TRIM_UNSUPPORTED` and the now-false assertion that `TrimOptions` cannot request
fragmented output. The retained matrix cell remains `NA_ENGINE`, not a claimed benchmark pass.

### Ogg Opus trim: product packet/granule path exists, support declaration pre-rejects it

The product's Ogg driver declares `validatesStreamCopyTrim`, derives Opus packet durations from TOC
bytes, preserves or resets `OpusHead` pre-skip as the selected window requires, and re-authors terminal
granules. Dedicated tests shorten real Ogg/Opus, verify the output duration, verify byte-exact retained
packets on cross-container copy, and prove non-leading selection resets pre-skip to zero.

The immutable support layer rejects `trim/audio_opus_ogg_copy` before execution under
`AIBRUSH_AUDIO_PRESENTATION_TIMING_UNSUPPORTED`, using a single blanket assertion for AAC, MP3, and
Opus. No benchmark PASS is inferred from the product tests; the evidence only establishes that the
declared absence is stale enough to require adapter/oracle execution before retaining the `NA_ENGINE`.

### Fan-out adapter aliases its own top-level and first-variant bytes

`chromium-2026-07-27T23-14-16-430Z.json` executes all four aibrush ABR candidates successfully, then the
immutable adapter constructs `{ ...variants[0], variants }`. This guarantees that
`result.output.bytes === result.output.variants[0].bytes`, and the benchmark ownership validator rejects all
four candidates with `aliases the buffer already owned by result.output.bytes`. The alias is created after
the product returns; no product buffer-ownership change can prevent it.

### Rotate-normalize contract double-applies presentation rotation

The focused transform artifact `chromium-2026-07-27T23-15-25-030Z.json` also shows that the normalize
scenario requests `rotate: 0`, while its immutable transform contract hardcodes a 90° pixel rotation for
every exhaustive input. Unrotated variants are independently identical to the intended presentation
(SSIM 1.0, zero residual) but the property oracle expects swapped dimensions. For the already rotated
baked asset, the candidate correctly bakes to 720×1280 while the oracle rotates the browser-presented
source a second time and expects 1280×720.

### MP4 to Matroska remux: media-element seek artifact shared by every implementation

For `scenarios/remux/prop_bframes_decode_remux_mp4_mkv/01.mp4`
(`f9bac3dfa3d73a9011439b9bd2d267bf7d3385d6960de40863afe142cfe1b00f`):

- aibrush, FFmpeg.wasm, and Mediabunny all produce the exact same candidate hash at reported frame 42,
  `70f2d9e3…bbfa`, versus the browser source hash `cb95d6fe…83bf`;
- aibrush and an independent native-FFmpeg Matroska remux have identical canonical video packet
  schedules: 321/321 payload hashes, PTS, DTS, durations, sizes, and flags; canonical schedule SHA-256
  is `36e8a1c8b4c094d5818f9f3057381e40c12eea6b0a3a16bc5f457e59792ee1d4`;
- native FFmpeg decode of source MP4, aibrush MKV, and FFmpeg MKV is frame-bit-exact; only the reported
  sample-aspect-ratio metadata spelling differs (`0/1` versus `1/1`).

The immutable oracle forces source and candidate through repeated `HTMLVideoElement.currentTime` seeks
at shared sample instants, then compares by synthetic loop index. The identical result from all three
independent muxers plus the full coded-unit and software-decode equality rules out a product corruption.

### Performance massive-file instability

`chromium-2026-07-27T04-38-47-186Z.json` passes all four
`performance/size-ladder-extract-metadata-massive` candidates. A later run,
`chromium-2026-07-27T05-51-00-142Z.json`, failed corpus fetches for two candidates and reported
`Array buffer allocation failed` for the baked candidate after prior multi-engine work. This is retained
as a run-order/browser-memory instability, not used as a product regression.

### Performance ranking: immutable adapter evidence work dominates two headline paths

Read-only profiling against the exact final product build and the canonical 31,258,790-byte
`h264_1080p_30s.mp4` isolates the retained packet/remux ranking deficits outside product work:

- `mp4PacketInfoFromBytes` produces all 2,308 correct rows in 0.369 ms median; the URL helper takes
  0.527 ms median.
- Calling the exact aibrush benchmark adapter's demux method takes 159–162 ms. Its isolated payload
  copy plus synchronous SHA-256 stage takes 158.7 ms median and hashes all 2,308 packet payloads.
- The public product streams MP4 to Matroska in 3.37 ms median. The exact adapter path takes 2.08 s
  median because its buffer materialization feeds every output byte through two separate BigInt/FNV
  rolling-hash recorders. One recorder alone takes 1.039 s median for the 31 MB output.

These adapter stages are inside the timed operation but are not performed by the product. Omitting
packet offsets to suppress semantic evidence or ignoring the requested stream sink would improve the
score by deleting observable work, so neither workaround is admissible. The benchmark checkout is
immutable, therefore this is retained as an external measurement blocker rather than converted into a
product optimization claim.

All retained `peakMemory` primary measurements for aibrush and implementing rivals are
`UNAVAILABLE` because the benchmark memory sampler failed or timed out. The artifacts therefore do not
support an honest comparative memory ranking.

### Audio hot paths: bounded CAF probe and exact range-backed resampling

CAF now has an abort-aware sparse probe for seekable, known-size sources. It validates signed 64-bit
chunk sizes, skips irrelevant payloads by declared offset, accepts only a final `data = -1` chunk, and
uses the same malformed-input rules as the sequential fallback. The focused suite passes 46/46,
including paired seekable/sequential adversarial chunk tables.

Large seekable s16 WAV rate-only transforms now use a pull-driven resampler. It preserves the existing
Kaiser/polyphase coefficients, phase schedule, rounding, sample count, and output bytes while retaining
only one output window and its required input support. On the real 158,034,226-byte stereo fixture,
five-run medians were:

| path | wall | peak ArrayBuffers | peak RSS |
|---|---:|---:|---:|
| contiguous | 308.17 ms | 215,371,122 B | 232,521,728 B |
| range-backed | 349.37 ms | 30,927,908 B | 53,755,904 B |

The range-backed path used 29 reads, no read exceeded 5,780,400 bytes, and both paths produced
57,336,672 bytes with SHA-256
`dcaf9cdba8d8b04455dde8bd303c2e76b99d46c74da3f20755b471cd0db653ca`. This is an approximately
86% ArrayBuffer and 77% RSS peak reduction for a 13% Bun wall-time cost. It is a driver-window bound,
not a whole-process promise when a caller retains the complete input or a sink materializes all output.
The focused CAF/WAV verification passes 186/186 tests.

The pure-TypeScript DSP regression gate remains green across eight real corpus files with checksum
`439301100`; the current rate-change geomean is 1,174× realtime and the worst file is 923× realtime.

### Probe hot paths: seam-safe sparse reads and immutable-blob result reuse

The final required six-engine probe command ran after the settled product was synced:

`bash scripts/run.sh --browser chromium --feature probe --pillar all --exhaustive --no-reuse
--warmup 1 --iters 5 --random-seed marathon-probe-closure-20260728-v6`

The completed artifact has raw content hash
`e9bf2984a00c074dd091e1e1c6f16de6980b53dc64ff9976f61f1be5ebe9e16b`, run ID
`run-65e2e789ae85c7880c688be0f08e122225b818ac8a40bd86318f7196498959cd`, and 1,098
exhaustive child rows. Per-engine parent and child coverage is:

| Engine | Parent PASS / NA / FAIL | Child PASS / NA / FAIL |
| --- | ---: | ---: |
| aibrush-media | 50 / 10 / 0 | 144 / 39 / 0 |
| Mediabunny | 56 / 3 / 1 | 168 / 14 / 1 |
| FFmpeg.wasm | 47 / 13 / 0 | 138 / 45 / 0 |
| MP4Box | 17 / 43 / 0 | 49 / 134 / 0 |
| Remotion | 42 / 18 / 0 | 114 / 69 / 0 |
| web-demuxer | 30 / 30 / 0 | 85 / 98 / 0 |

Aibrush passes every applicable child. All 39 of its NAs carry
`PROBE_BOUNDED_READ_MODE_UNAVAILABLE`: the product's public probes are independently verified to use
bounded reads on the selected large, huge, and massive MP4/WebM assets, but the immutable benchmark
adapter advertises only `whole-file` delivery and rejects those cells before product execution.

The canonical reporter produces content hash
`b16fff918e42d799b55707aa77dd651a1097de4549e3a3c3edb791d2a7a492bd`: 360 observations,
360 cohorts, zero comparable cohorts, zero winners, and zero ties. Every cohort is
`NOT_COMPARABLE` because required cohort dimensions are incomplete, unequal, or contain an engine
record conflict. Consequently the following exact scenario-plus-input-SHA calculations are diagnostics,
not reporter-certified rankings. Using median wall time and declaring a lead only when the median gap
exceeds the sum of both MADs, the rankable (`n >= 3`) Aibrush results are:

| Rival | Aibrush lead / tie / loss | Geomean rival / Aibrush |
| --- | ---: | ---: |
| FFmpeg.wasm | 137 / 0 / 0 | 315.678× |
| Mediabunny | 80 / 7 / 51 | 1.124× |
| MP4Box | 43 / 1 / 4 | 3.647× |
| Remotion | 113 / 0 / 0 | 16.101× |
| web-demuxer | 81 / 0 / 3 | 23.584× |

The Mediabunny losses are concentrated in sub-millisecond audio-container probes where the immutable
Aibrush adapter adds a roughly 0.13–0.16 ms wrapper/enrichment floor after the product cache hit.
Removing requested enrichment or adding fixture-specific shortcuts would be benchmark overfitting and
was not retained. The only failing child in the artifact belongs to Mediabunny's huge VP9 `02.webm`;
its measured peak-memory delta is 107,833,270 bytes against a 100,663,296-byte budget.

The MPEG-TS driver now has a seekable sparse probe with independent head and tail parser state. It
discovers PAT/PMT declarations, walks complete PES timing on exact 90 kHz ticks, derives duration from
dominant cadence, and accepts a sparse result only when declarations and timing remain internally
consistent. PMT changes, timestamp resets, discontinuity markers, ambiguous wraparound, incomplete
configuration, or insufficient samples observed in the sampled windows fall back to the exact
sequential parser. Its
32/64/128 KiB starting edge windows can grow conservatively to 1 MiB and do not depend on fixture
names, sizes, PIDs, or expected durations.

The sparse result is deliberately an endpoint estimate for one sampled CFR epoch: an otherwise legal
reset or VFR phase wholly inside the omitted middle cannot be proved from head/tail bytes. Exact demux
and every conflict visible in either sampled window remain on the full sequential path; the sparse
probe does not claim a proof about unsampled packets.

The final targeted six-engine MPEG-TS artifact,
`chromium-2026-07-28T06-47-17-371Z.json`, records four statistically qualified leads over Mediabunny:

| MPEG-TS candidate | Aibrush median ± MAD | Mediabunny median ± MAD | Verdict |
|---|---:|---:|---|
| `01` | 1.150 ± 0.050 ms | 1.685 ± 0.015 ms | LEAD |
| `02` | 1.470 ± 0.030 ms | 3.595 ± 0.080 ms | LEAD |
| `03` | 2.620 ± 0.110 ms | 5.745 ± 0.085 ms | LEAD |
| baked | 2.260 ± 0.030 ms | 6.945 ± 0.115 ms | LEAD |

Direct range instrumentation, outside the benchmark adapter, confirms the work reduction rather than
only a wall-clock result:

| MPEG-TS candidate | Sparse bytes / file | Sparse / full bytes | Sparse / full parser wall |
|---|---:|---:|---:|
| `01` | 65,668 / 291,588 B | 22.52% | 0.277 / 0.814 ms |
| `02` | 131,148 / 801,632 B | 16.36% | 0.429 / 2.042 ms |
| `03` | 262,296 / 1,882,820 B | 13.93% | 0.770 / 5.013 ms |
| baked | 262,296 / 4,633,636 B | 5.66% | 0.669 / 9.721 ms |

The MP4 probe now has two general bounded paths. Canonical audio-only fast-start/init metadata is
accepted after one bounded parse even when the MIME hint is the generic `video/mp4`. Fragmented files
use a sparse top-level walker that reads exact `moov`, `sidx`, and `moof` boxes while skipping `mdat`
and `free` bulk payloads beyond any bytes already present in the initial prefix, with conservative exact
fallback for malformed or semantically incomplete box
graphs. On the real corpus this read 294,912 / 764,465 bytes for the small A/V fragment,
196,794 / 2,207,270 for CENC-CTR, 231,037 / 1,129,913 for CENC-CBCS, and
163,988 / 1,458,236 for CMAF. The targeted artifact
`chromium-2026-07-28T06-15-24-843Z.json` records all eight CENC candidate comparisons and the CMAF
comparison as Aibrush leads.

Repeated probes of finite Blob inputs now reuse an engine-local, success-only result snapshot. Admission
requires a finite `blob:` URL plus explicit size as the caller's assertion of one immutable snapshot,
and a complete semantic
key covering effective URL, MIME, filename, generic-versus-targeted operation, determinism, and pinned
driver. Unknown options, progress callbacks, HLS candidates, ordinary URLs, mutable/unknown-size
sources without a fresh asserted identity, failures, and aborted operations never enter the cache.
Mutable Blob/MediaSource callers must omit the identity or mint a new URL when the bytes change; the
engine cannot independently prove that contract. Results are defensively cloned.
The absolute lifetime is 250 ms with eight-entry LRU capacity; the matching range-prefix handoff is
bounded to 1 MiB per entry and 8 MiB total. Expiry is enforced both by timers and hit-time deadlines,
and disposal or driver-registry mutation invalidates old entries and prevents in-flight repopulation.

Browser instrumentation against the exact MP3 benchmark lifecycle proves that this is a real result
hit, not merely prefix reuse: after one miss, 101 probes through fresh `Source` wrappers create zero
product `AbortController`s and perform zero Blob fetches; a call after 275 ms creates exactly one of
each. In that diagnostic browser session, 31 batches of 100 calls divided to per-hit medians of
0.00115–0.00205 ms; individual calls were mostly below Chromium's 0.005 ms timer quantum. The
benchmark's displayed MP3 times remain
0.135–0.160 ms because its immutable adapter repeatedly scans all browser resource entries for loaded
WASM provenance after every MP3 call. MP3 loads no WASM, so the adapter never marks that scan complete:

| MP3 candidate | Full adapter artifact | Direct product hit | Diagnostic-session provenance scan |
|---|---:|---:|---:|
| baked/Xing | 0.155 ms | 0.00115 ms | 0.165 ms |
| `01` | 0.145 ms | 0.00140 ms | 0.255 ms |
| `02` | 0.160 ms | 0.00200 ms | 0.260 ms |
| `03` | 0.135 ms | 0.00205 ms | 0.295 ms |

The adapter's MP3 metadata enrichment and structural check are only 0.00055–0.00080 ms and
0.00030–0.00040 ms respectively. Loading irrelevant WASM or weakening provenance to improve the UI
score would be benchmark-specific gaming, so the adapter-owned floor is retained as external evidence.
The direct component split is browser/session diagnostic evidence rather than a self-authenticating
benchmark artifact; the retained artifact supplies only the full-adapter column.

The three fragmented long-form audio candidates in the same targeted probe round have a different
adapter-owned floor: after the product returns, the adapter materializes 154,727–175,004 MP4 fragment
packet records for structural enrichment. Its neutral parser takes 1.617–2.710 ms, matching the
artifact's scale and accounting for approximately 57–102% of its 2.335–2.825 ms cells, while direct
warm product probe hits take 0.003–0.005 ms. The
unfragmented baked candidate avoids that mandatory adapter walk and is an observed Aibrush lead.
Suppressing fragment structure in the product result would delete requested semantic evidence and is
therefore not an admissible optimization.

### Packet-table compatibility and bounded row production

The additive `packetInfoBatches()` surface exposes a single-use, pull-driven packet-row iterator while
the compatibility `packetInfo()` path collects the same authoritative producer. MP4 preserves
track-major ordering, timing, edits, fragments, offsets, and exact AVC picture classification; early
return, explicit cancel, and caller abort release the source lease. URL reads use a strict 8 MiB retained
LRU ceiling and no longer reuse unsafe module-global URL snapshots.

On the 759,842,422-byte massive MP4 (535,606 rows), the authoritative result has session-9 row checksum
`1,449,825,390`. A warm compatibility collection took 152.44 ms and approximately 285.5 MiB RSS,
whereas lazy setup took 14.79 ms and the first 2,048 rows took 3.98 ms with approximately 66.8 MiB RSS
including parsed primitive tables and cache state. The API bounds row-object materialization and retained
transport windows; it does not claim total O(batch) memory because primitive sample tables are parsed up
front and exact unknown-AVC classification may visit payloads across the file. Focused MP4/cache/public
API verification passes 222/222 tests under Vitest.

The interval/LRU cache implementation is now a lazy runtime split: `cacheSource()` remains synchronous
and source-shaped, while the 8 MiB bounded cache machinery loads only when first used. This keeps the
eager kernel at 49.28 KiB without weakening range reuse, abort propagation, or concurrent replay.

### Decode-seek ranking deficit is an immutable adapter prepass

On the canonical seek fixture, direct aibrush product seek plus frame decode took 9.735 ms; raster and
digest work brought the comparable product path to 18.725 ms, versus 20.875 ms for the Mediabunny
adapter in the same page. The immutable aibrush adapter first materializes the complete packet table,
costing 39.120 ms, seven ranges, and 31,205,329 bytes before the direct seek that itself needs two ranges
and 2,428,077 bytes. Both land at exactly 14,000,000 µs with digest
`4afe70dc…36f7`. Removing packet truth to improve the score would be benchmark-specific gaming; the
remaining displayed loss is retained as adapter-owned.

## Benchmark-owned pre-execution declarations

The following remaining cells are rejected in
`../media-test/src/engines/aibrush-media/support.ts` before aibrush product code runs. Because the
benchmark is immutable for this marathon, product changes alone cannot turn them into observed coverage:

- demux scale first-packet timing;
- large/huge/massive bounded probe delivery;
- full Matroska numeric DTS plus VFR `BlockDuration`;
- WebM/Ogg Opus presentation-window equivalence, despite the product's packet, granule, and pre-skip
  trim implementation;
- reserve fast-start and sparse co64 feature declarations;
- exact streaming write-chunk-size control;
- finite WebM callback target;
- still-image-to-video transcode;
- MP3 encode despite the product's registered encoder;
- AAC→PCM/WAV equivalence despite the product's PCM authoring path;
- authored 5.1 audio mix matrices despite the product's public `mixMatrix` surface;
- PCM endianness round trip despite the product implementation;
- Ogg Opus continuation, WebM Opus presentation, and MP4 AAC priming contracts;
- non-primary decode selection, despite the product's public `DecodeOptions.trackSelect`;
- fragmented MP4 trim, despite the product's public `TrimOptions.fragmented` and passing imported
  fragment-structure oracle;
- two-pass H.264 and 10-bit HEVC feature tokens despite product implementations;
- alpha-quality cells whose requested output codec cannot carry alpha;
- several scenario-specific historical quality/corpus exclusions.

The MKV-to-MOV `03.mkv` candidate additionally contains a projected MJPEG cover attachment. All
implementing rivals and aibrush currently report `NA_ENGINE`; the immutable aibrush support declaration
hard-rejects MJPEG before the product muxer can be exercised.

## Final closure checklist

- [x] Invoke the exact `bun run gate` alias on the current product source: 246 files / 4,498 tests, coverage,
  typecheck, Biome, build, packaging, budgets, and integrity all green.
- [x] Exact `bun run sync-vendor` in `../media-test`.
- [x] Complete aibrush-only and six-engine exhaustive audio closure with the required warmup,
  five measured iterations, and no engine reuse; retain coverage and statistically rankable timing
  evidence without using UI cell durations as benchmark samples.
- [x] Complete the six-engine exhaustive demux closure after the bounded packet-fact cache change;
  retain exact artifact identity, coverage, before/after timing evidence, and the canonical reporter's
  non-comparability verdict.
- [x] Targeted exhaustive rotate-180 run with `--warmup 1 --iters 5 --no-reuse`; external matcher verdict
  retained without timestamp gaming.
- [x] Targeted exhaustive contain/letterbox before/after proof on the final synced product.
- [x] Attempt all-engine exhaustive transcode closure; preserve and reconcile its 141-result partial after
  the immutable schema validator abort.
- [ ] Complete all-engine exhaustive matrix (blocked by the same deterministic schema-validator failure).
- [x] Reconcile this ledger against every terminal family artifact, focused artifact, and canonical partial
  that the immutable benchmark could produce.
- [ ] Commit the coherent product/docs change set locally, excluding user-owned `REQUIREMENTS.md`,
  `package.json`, and `.claude/worktrees/`.
