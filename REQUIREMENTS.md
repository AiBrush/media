# Optimize `aibrush-media` to State-of-the-Art Browser Media Performance

## Objective

Improve the `aibrush-media` browser media engine so that it becomes genuinely state-of-the-art in correctness, format coverage, latency, throughput, memory efficiency, and scalability.

The supplied benchmark subset contains 82 scenarios from:

* `audio-dsp`
* `decode-seek`

Current `aibrush-media@dev` results in this subset:

* 29 benchmark wins
* 21 ties
* 27 measurable latency losses
* 2 competitive feature/coverage losses
* 18 scenarios with only `Partial 1/4` coverage

Do not treat this as an exercise in making isolated benchmark rows turn green. Diagnose and improve the underlying architecture so that the gains apply to arbitrary real-world media.

## Non-negotiable rules

1. Do not special-case benchmark scenario names, filenames, hashes, durations, dimensions, codecs, timestamps, or fixture contents.
2. Do not weaken assertions, correctness tolerances, output validation, or benchmark methodology.
3. Do not modify the benchmark harness merely to improve reported results.
4. Do not trade correctness, media fidelity, timestamp accuracy, robustness, or browser compatibility for lower latency.
5. Preserve existing `aibrush-media` wins and ties.
6. Prefer reusable architectural improvements over isolated micro-optimizations.
7. Study competing implementations, but do not blindly copy them. Understand why their design is faster and implement a better solution appropriate for `aibrush-media`.
8. Respect licenses and do not copy incompatible source code.
9. Measure cold-start and warm-path performance separately.
10. Treat allocations, memory copies, initialization time, peak memory, main-thread blocking, and bundle-loading costs as first-class performance metrics.

## Benchmark baseline

### A. Missing competitive functionality

| Scenario                                     | `aibrush-media` | Benchmark leader                     |
| -------------------------------------------- | --------------- | ------------------------------------ |
| `audio-dsp/meta_roundtrip_endianness_s16`    | `NA_ENGINE`     | `ffmpeg.wasm@0.12.15` — Pass, 4.84 s |
| `decode-seek/decode_multitrack_select_video` | `NA_ENGINE`     | `mediabunny@1.48.0` — Pass, 1.65 s   |

Implement complete, general-purpose support for both features.

For multitrack media, support deterministic track discovery and selection without decoding unnecessary tracks. Preserve correct timestamps, codec configuration, metadata, and track identity.

For PCM endianness round-tripping, support correct S16 LE/BE conversion and container serialization without lossy intermediate conversion.

### B. Severe latency gaps

These are the highest-priority latency regressions.

| Scenario                                    | `aibrush-media`     | Leader                         | Gap         |
| ------------------------------------------- | ------------------- | ------------------------------ | ----------- |
| `audio-dsp/fuzz_wav_header_truncated_probe` | 54.02 ms            | Remotion 10.04 ms              | 438% slower |
| `audio-dsp/edge_empty_audio_transcode`      | 31.50 ms            | Remotion 8.24 ms               | 282% slower |
| `audio-dsp/pcm_s24_to_s16`                  | 210 ms              | Remotion 77 ms                 | 173% slower |
| `audio-dsp/fuzz_wav_bitflip_decode`         | 43.33 ms            | MediaBunny 23.08 ms            | 88% slower  |
| `decode-seek/decode_mkv_h264`               | 3.29 s, Partial 1/4 | MediaBunny 2.21 s, Partial 1/4 | 49% slower  |

Investigate whether these losses come from:

* unnecessary engine or codec initialization;
* loading large modules before validating input;
* full-file reads for header-only operations;
* exception-heavy malformed-input handling;
* repeated buffer creation;
* redundant PCM conversion passes;
* scalar JavaScript loops;
* non-contiguous memory access;
* decoder recreation;
* redundant demuxing;
* avoidable worker communication;
* unnecessary frame or sample materialization.

Malformed, empty, and truncated inputs must terminate through a cheap validation path. They must not initialize a full transcoding pipeline when the format can already be accepted or rejected from bounded header data.

### C. Decode and long-file latency gaps

| Scenario                                           | `aibrush-media`     | Benchmark leader                          | Gap                     |
| -------------------------------------------------- | ------------------- | ----------------------------------------- | ----------------------- |
| `decode-seek/decode_extreme_fps_240`               | 1.76 s              | MediaBunny 1.29 s                         | 36% slower              |
| `decode-seek/decode_h264_10bit`                    | 2.20 s              | MediaBunny 2.00 s                         | 10% slower              |
| `decode-seek/decode_open_gop_first_frame`          | 2.13 s              | MediaBunny 1.68 s                         | 27% slower              |
| `decode-seek/decode_size_huge_h264_600s`           | 4.09 s, Partial 1/4 | MediaBunny 3.83 s; web-demuxer also ties  | 7% slower than fastest  |
| `decode-seek/decode_size_large_h264_120s`          | 4.75 s, Partial 1/4 | MediaBunny 3.48 s; web-demuxer also ties  | 36% slower than fastest |
| `decode-seek/decode_size_large_vp9_120s`           | 3.75 s, Partial 1/4 | MediaBunny 3.46 s                         | 8% slower               |
| `decode-seek/decode_size_tiny_vp9_360p`            | 1.44 s, Partial 1/4 | MediaBunny 1.23 s                         | 17% slower              |
| `decode-seek/decode_vp9`                           | 2.34 s, Partial 1/4 | MediaBunny 2.19 s                         | 7% slower               |
| `decode-seek/decode_vp9_alpha`                     | 1.36 s, Partial 1/4 | MediaBunny 1.28 s                         | 6% slower               |
| `decode-seek/meta_decode_remux_eq_decode_anchored` | 19.55 s             | FFmpeg.wasm 14.07 s; MediaBunny also ties | 39% slower than fastest |

Study MediaBunny’s implementation and data flow for:

* incremental demuxing;
* bounded sample reads;
* codec configuration reuse;
* MKV/WebM cue and cluster indexing;
* VP9 initialization;
* open-GOP first-frame handling;
* large-file processing;
* avoiding scans unrelated to the requested frame range.

Study FFmpeg.wasm’s winning decode/remux path for:

* packet-level remuxing;
* timestamp rescaling;
* stream-copy behavior;
* avoiding unnecessary decoded-frame materialization;
* reuse of parsed stream metadata.

Implement a streaming architecture wherever possible. Operations that need only metadata, selected samples, or compressed packets must not load or process the complete media file.

Consider:

* zero-copy or copy-minimized `ArrayBuffer`/typed-array views;
* transferable buffers across workers;
* persistent parser and decoder state;
* bounded read-ahead;
* lazy codec initialization;
* reusable codec configuration;
* cached container indexes;
* capability-driven native WebCodecs paths;
* optimized fallback paths where WebCodecs is unavailable;
* WASM SIMD for suitable conversion loops;
* backpressure rather than unbounded frame queues.

### D. Seek-path latency gaps

MediaBunny wins every material seek regression in this subset and is the principal implementation to study.

| Scenario                     | `aibrush-media` | MediaBunny | Gap        |
| ---------------------------- | --------------- | ---------- | ---------- |
| `seek_backward_then_forward` | 55.82 ms        | 39.78 ms   | 40% slower |
| `seek_bframes_midgop`        | 63.16 ms        | 58.23 ms   | 8% slower  |
| `seek_h264_keyframe`         | 28.24 ms        | 20.19 ms   | 40% slower |
| `seek_h264_nonkeyframe`      | 43.07 ms        | 33.81 ms   | 27% slower |
| `seek_mkv_h264_keyframe`     | 13.22 ms        | 12.29 ms   | 8% slower  |
| `seek_negative`              | 28.74 ms        | 20.29 ms   | 42% slower |
| `seek_past_eof`              | 50.20 ms        | 41.04 ms   | 22% slower |
| `seek_repeated_same_target`  | 57.66 ms        | 41.85 ms   | 38% slower |
| `seek_vfr_arbitrary`         | 26.05 ms        | 23.94 ms   | 9% slower  |
| `seek_zero`                  | 28.53 ms        | 20.31 ms   | 40% slower |

The clustering of these regressions strongly suggests shared fixed overhead rather than ten independent problems.

Profile the complete seek lifecycle:

1. target normalization;
2. boundary handling;
3. track lookup;
4. timestamp-to-timescale conversion;
5. keyframe lookup;
6. byte-offset or cluster lookup;
7. decoder flush/reset;
8. decoder configuration;
9. compressed sample loading;
10. decoding from the anchor frame;
11. frame selection;
12. cleanup and result transfer.

Implement a reusable seek index containing, where applicable:

* presentation and decode timestamps;
* keyframe flags;
* sample or cluster byte offsets;
* sample duration;
* dependency information;
* composition offsets;
* track timescale;
* container-specific cue information.

Use binary search or a more appropriate indexed lookup instead of repeated linear scans.

Avoid decoder destruction and recreation when a safe flush/reset/reconfigure path is possible. Cache immutable demux metadata and indexes per source. Repeated seeks must not reparse the same container structures.

Handle negative seeks, zero seeks, past-EOF seeks, and repeated identical targets using efficient generic boundary logic. Do not introduce benchmark-specific branches.

### E. Additional audio latency gaps

| Scenario                                   | `aibrush-media` | Leader              | Gap        |
| ------------------------------------------ | --------------- | ------------------- | ---------- |
| `audio-dsp/fuzz_wav_fmt_corrupt_transcode` | 25.40 ms        | MediaBunny 19.82 ms | 28% slower |
| `audio-dsp/throughput_decode_s24`          | 179 ms          | MediaBunny 138 ms   | 30% slower |

Review the S24 pipeline as one shared system rather than optimizing the benchmarks independently.

Potential improvements include:

* direct packed-24-bit reads;
* fewer sign-extension operations;
* vectorized conversion;
* loop unrolling only when profiling justifies it;
* block-based processing;
* eliminating intermediate arrays;
* reusing destination buffers;
* combining decode and destination-format conversion where safe;
* WASM SIMD or browser-optimized typed-array kernels.

Validate correctness at minimum for:

* positive and negative full-scale values;
* zero;
* minimum signed S24;
* clipping boundaries;
* endian variants;
* interleaved multichannel audio;
* non-aligned input lengths;
* chunk boundaries.

## Partial-coverage initiative

`aibrush-media` reports `Partial 1/4` on all of the following:

* `decode_av1`
* `decode_bframes_reorder`
* `decode_h264_4k`
* `decode_h264_first_frames`
* `decode_hevc`
* `decode_image_jpeg`
* `decode_image_png`
* `decode_image_webp`
* `decode_mkv_h264`
* `decode_mov_h264`
* `decode_size_huge_h264_600s`
* `decode_size_large_h264_120s`
* `decode_size_large_vp9_120s`
* `decode_size_tiny_h264_360p`
* `decode_size_tiny_vp9_360p`
* `decode_vp8`
* `decode_vp9`
* `decode_vp9_alpha`

Several competitors have the same partial coverage, but the goal is not merely to match them.

Determine exactly why three of four files are not covered in each scenario:

* actual codec or profile incompatibility;
* unsupported container combination;
* browser WebCodecs capability;
* incorrect codec-string construction;
* missing decoder configuration metadata;
* alpha-plane handling;
* bit-depth handling;
* benchmark asset availability;
* environmental limitation;
* engine logic.

Where technically possible, raise coverage from 1/4 to 4/4. When browser-native support is unavailable, determine whether a lazy-loaded fallback can provide coverage without imposing its startup or bundle cost on users who do not need it.

Do not report an environmental limitation as an engine fix. Clearly distinguish engine limitations from browser, operating-system, hardware, and asset limitations.

## Required workflow

### 1. Establish a trustworthy baseline

Run the unchanged benchmark before modifying code.

Record:

* browser and exact version;
* operating system;
* hardware;
* cold versus warm execution;
* median;
* p75 and p95;
* minimum and maximum;
* peak memory where measurable;
* initialization time;
* number of benchmark iterations.

Use multiple iterations. Do not make decisions from a single run.

### 2. Profile before optimizing

Produce profiles for at least:

* truncated WAV probe;
* empty audio transcode;
* S24-to-S16 conversion;
* MKV/H.264 decode;
* large H.264 decode;
* decode/remux equivalence;
* H.264 keyframe seek;
* repeated-target seek;
* seek to zero.

Identify time spent in:

* module loading;
* parser construction;
* data copying;
* allocation and garbage collection;
* container parsing;
* index construction;
* codec initialization;
* decoder flush/reset;
* actual decoding;
* post-processing;
* worker communication.

Do not guess about the bottleneck when profiling can answer it.

### 3. Study benchmark leaders

Inspect the relevant architecture and implementation of:

* `mediabunny@1.48.0`
* `remotion@4.0.479`
* `ffmpeg.wasm@0.12.15`
* `web-demuxer@4.0.0`

For every studied implementation, document:

* the relevant module or source path;
* its processing strategy;
* what work it avoids;
* its memory model;
* its indexing strategy;
* its initialization model;
* whether its advantage is architectural or benchmark-specific;
* what `aibrush-media` should adopt, improve, or deliberately avoid.

### 4. Implement architectural improvements

Prioritize in this order:

1. Missing endianness and multitrack functionality.
2. Shared malformed/empty-input fast path.
3. S24 conversion and decode pipeline.
4. Cached demux and keyframe indexes.
5. Decoder reuse and reduced seek setup overhead.
6. Incremental large-file and MKV/WebM processing.
7. Zero-copy or copy-minimized remux flow.
8. Broader codec and file coverage.

### 5. Add independent validation

Add tests beyond the supplied benchmark:

* randomized valid and malformed WAV headers;
* property-based PCM endian round trips;
* randomized S24 samples;
* multitrack files with varying default and non-default tracks;
* repeated random seek sequences;
* VFR timestamps;
* open and closed GOP files;
* files with multiple B-frame patterns;
* long media with sparse indexes;
* MKV/WebM files with and without cues;
* negative and out-of-range targets;
* repeated identical targets;
* different chunk and range-read sizes.

These tests must prove that improvements are general and not fixture-specific.

## Acceptance criteria

The work is complete only when all of the following are satisfied:

1. `meta_roundtrip_endianness_s16` is supported and correct.
2. `decode_multitrack_select_video` is supported and correct.
3. Every current `aibrush-media` win remains a win or statistically equivalent tie.
4. Every current tie remains a tie or becomes a win.
5. Each of the 27 latency losses reaches at least the benchmark’s official tie range.
6. The stretch goal is a measurable win over the current leader, not merely parity.
7. The three severe audio regressions match or beat Remotion.
8. The seek subsystem matches or beats MediaBunny across the complete seek group, not just one scenario.
9. The decode/remux pipeline matches or beats the FFmpeg.wasm/MediaBunny leader group.
10. Partial coverage increases wherever the limitation is inside `aibrush-media`.
11. No benchmark-specific asset checks or scenario-specific shortcuts are introduced.
12. Correctness, output fidelity, timestamp behavior, memory safety, and API behavior do not regress.

For noisy measurements, consider a result a genuine improvement only when it is repeatable across runs. Target a median at least 5% faster than the previous leader when feasible, while also reporting p95 and variance.

## Required final report

At completion, provide:

1. Root causes discovered.
2. Files and modules changed.
3. Architectural changes made.
4. Competing implementation studied for each gap.
5. Before-and-after benchmark table.
6. Median, p95, and variability for important scenarios.
7. Memory and allocation changes.
8. Coverage improvements.
9. Tests added.
10. Remaining gaps and their technical causes.
11. Any browser or platform limitations that prevent full support.
12. Confirmation that the benchmark harness and fixtures were not special-cased.

Do not stop after obtaining one or two green benchmark rows. Continue until the shared architectural bottlenecks have been addressed and the overall engine is faster, broader, and more efficient for real-world browser media workloads.
