# `@aibrush/media` — Product and Engineering Requirements

| Field | Baseline |
| --- | --- |
| Status | Living requirements for the current codebase and future releases |
| Date | 2026-08-09 |
| Package | Pre-1.0 (`0.0.0` at the baseline date) |
| Benchmark | Chromium 150 result cache generated 2026-08-08; content hash `1493b70bbbbd107ff008d738f562115d5f399eb9f9792869c17bf53b677322aa` |

The baseline source in the development workspace is `../media-test/results/cache-chromium-1788562444700.json`.

This document is the authoritative product and engineering specification for `@aibrush/media`. It defines what “the best media engine in the browser” means, records the current evidence, and establishes the work and release gates required to make that claim honestly.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

## 1. Mission

`@aibrush/media` MUST be the best general-purpose, client-side media engine for modern browsers: correct across the broadest practical media workload, fastest for each supported operation, smallest for the code a particular operation actually loads, and dependable on untrusted and very large inputs.

The engine MUST provide one coherent API for:

- probing and metadata;
- demuxing, packet iteration, decoding, seeking, and frame extraction;
- encoding, muxing, remuxing, conversion, and transcoding;
- exact and fast trim;
- audio DSP and video transforms;
- progressive input, streaming output, and random-access output;
- media encryption and decryption where the browser can legally and securely perform it.

The implementation SHOULD combine browser-native acceleration, focused TypeScript implementations, GPU compute, and lazily loaded WebAssembly. It MUST select the best correct route at runtime rather than making callers understand the browser's codec and container fragmentation.

## 2. Meaning of “best in class”

“Best” is not a single benchmark time or a large count of partially supported operations. A SOTA release MUST satisfy all of the following simultaneously.

| Dimension | Requirement |
| --- | --- |
| Correctness | Every counted result is valid against an independent oracle. A fast wrong result does not count. |
| Coverage | The engine has the highest number of correctly completed in-scope scenarios, with no silent feature degradation. |
| Speed | For comparable, correct outputs, the engine leads or is within the defined noise margin of the fastest browser engine. |
| Loaded size | Each route downloads, parses, compiles, and executes no more code than it needs. Route cost matters more than package tarball size. |
| Memory | Work is streaming and bounded by active media state, not total input or output size. |
| Responsiveness | Long work runs off the main thread by default when possible, uses backpressure, and remains cancellable. |
| Portability | The same public contract works across supported Chromium, Firefox, and Safari versions through capability-based routing. |
| Robustness | Malformed, truncated, adversarial, and resource-exhausting inputs fail deterministically and safely. |
| Operability | Every route exposes the selected implementation, timing, byte, memory, warning, and failure evidence needed to reproduce behavior. |

The project MUST NOT publish an unqualified “fastest,” “smallest,” “supports everything,” or “SOTA” claim until the relevant release gates in this document pass on reproducible evidence.

## 3. Scope and non-goals

### 3.1 In scope

- Modern, standards-capable desktop and mobile browsers.
- Fully local processing after application assets have loaded; user media MUST NOT leave the device unless the host application explicitly implements that behavior.
- Files, blobs, byte arrays, URLs, range-backed sources, streams, and persistent browser storage.
- Small interactive edits through multi-gigabyte professional workloads.
- Hardware-accelerated and software fallback paths selected from actual runtime capabilities.
- Tree-shakable core and operation-, format-, and codec-scoped entry points.

### 3.2 Non-goals

- Bit-for-bit compatibility with FFmpeg command-line behavior where the public `@aibrush/media` contract can be clearer or safer.
- Shipping every historical API name, experimental path, or obsolete workaround.
- Server-side transcoding hidden behind the browser API.
- Passing a benchmark through fixture recognition, reduced-quality output, skipped work, or special behavior unavailable to real users.
- Requiring one monolithic WebAssembly binary for routine operations that browser-native or focused implementations can perform better.

### 3.3 Compatibility policy

This is a pre-1.0 project optimized for the best current design. New work MUST target the latest documented API and codebase. Backward compatibility, legacy aliases, migration shims, and preservation of historical trial behavior are not requirements unless a later product requirement explicitly adds them. Breaking changes MUST still be deliberate, documented in release notes, and accompanied by a direct replacement when one exists.

## 4. Current baseline

### 4.1 What exists today

The current engine already has the right high-level shape:

- a `source → demux → decode → filter → encode → mux → sink` stage graph;
- per-stream copy or re-encode planning;
- browser-native, hardware/GPU, TypeScript, and WebAssembly routes;
- dedicated container and codec drivers;
- WebCodecs integration and specialized codec fallbacks;
- CPU and WebGPU filter paths;
- stream, file, memory, worker, and OPFS-oriented primitives;
- lazy loading, preloading, tree-shakable exports, and explicit subpath exports.

This architecture is the foundation, not proof that the SOTA requirements have been met.

### 4.2 Latest available correctness/coverage evidence

The referenced cache stores 591 Chromium result records for each versioned engine comparison, except for one extra web-demuxer record. Its raw status totals are:

| Engine | PASS | FAIL | ERROR | NA_ENGINE | Other NA | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AiBrush (development) | **497** | 11 | 12 | 61 | 10 | 591 |
| MediaBunny 1.48.0 | 433 | 5 | 20 | 121 | 12 | 591 |
| ffmpeg.wasm 0.12.15 | 407 | 9 | 4 | 169 | 2 | 591 |
| Remotion 4.0.479 | 219 | 1 | 1 | 369 | 1 | 591 |
| web-demuxer 4.0.0 | 151 | 0 | 0 | 440 | 1 | 592* |
| MP4Box 2.3.0 | 89 | 0 | 0 | 502 | 0 | 591 |

\*The export declares 3,624 stored records, excludes 72 incompatible records, and exposes 3,552 entries. Of the exposed entries, 268 are marked invalidated, primarily because required execution-manifest evidence is missing. It also contains five unversioned alias records and one extra web-demuxer record. Canonical release comparisons MUST therefore use the execution manifest rather than assume every cached record is comparable.

AiBrush currently has the highest absolute PASS count in this run. This is coverage evidence, not a weighted SOTA score. `NA_ENGINE`, `NA_ASSET`, and `NA_BROWSER` have different meanings; no unsupported or unevaluated result may be treated as a pass.

Current AiBrush results by family:

| Family | PASS / total | Main unresolved state |
| --- | ---: | --- |
| Audio DSP | 34 / 36 | 5.1 mixing and presentation timing |
| Decode/seek | 44 / 46 | rotation and asset coverage |
| Demux | 45 / 49 | large-input memory protocol failures |
| Encryption | 18 / 23 | authenticated/HLS negative cases and assets |
| Metadata | 24 / 25 | remaining unsupported metadata path |
| Mux | 46 / 53 | Matroska timing, fast-start reservation, 64-bit offsets |
| Performance | 31 / 33 | massive packet iteration and unavailable exhaustive size evidence |
| Probe | 50 / 60 | large authenticated range transport and format gaps |
| Remux | 48 / 49 | massive-input path |
| Robustness | 55 / 63 | malformed-input and capability gaps |
| Streaming output | 19 / 27 | finite WebM/TS streaming and sink behavior |
| Transcode | 45 / 84 | transforms, codecs, alpha, multitrack, and advanced rate control |
| Trim | 38 / 43 | exact compressed-audio/open-GOP and huge-copy behavior |

### 4.3 Known gap register

| Priority | Area | Current evidence | Required outcome |
| --- | --- | --- | --- |
| P0 | Large and remote inputs | Large/huge/massive probe, demux, remux, and trim paths report range-transport or memory-protocol errors. | Range-backed, resumable, bounded-memory operation independent of total file size. |
| P0 | Transform correctness | Crop, flip, padding, rotation, 10-to-8-bit conversion, and a 4K resize path fail or error. | A fused, color-correct CPU/GPU transform graph that passes odd-size, alpha, HDR/bit-depth, and 4K/8K cases. |
| P0 | Timeline accuracy | AAC/Opus gapless timing, priming, open-GOP trim, VFR/B-frame composition, and exact MP3/AAC trim remain incomplete. | One rational, overflow-safe timeline model used by every container and codec. |
| P0 | Container scalability | Fast-start reservation, sparse `co64`, full Matroska timeline, WebM streaming, and TS small-write cases are incomplete. | Correct seekable and append-only writers with 64-bit-safe offsets and bounded buffering. |
| P1 | Audio output routes | Browser fallback lacks AAC and MP3 encoders; Ogg Opus and some Vorbis/FLAC conversion paths are incomplete. | Lazy, focused codec routes with deterministic timestamps and gapless metadata. |
| P1 | Video output routes | HEVC 10-bit, two-pass rate control, VP8/VP9 alpha, and some H.264 conversions are unavailable or incorrect. | Quality-normalized encode routes with declared licensing and runtime capability behavior. |
| P1 | Track and image workflows | Multitrack video selection and image/still-image representation are incomplete. | Explicit track selection and coherent image/video conversion semantics. |
| P1 | Encryption and robustness | Some wrong-IV/mode HLS cases, round-trip properties, and fan-out behavior are incomplete. | Strict validation, stable error taxonomy, and property/fuzz coverage. |

The final clean installed-consumer verifier reports the default-import eager static JavaScript closure at **44,638 B (43.59 KiB) raw, 18,005 B gzip, and 15,972 B Brotli**. Its concrete typed fast-start MP4 `Blob` probe route is **94,059 B (91.85 KiB) raw, 37,603 B gzip, and 33,478 B Brotli**; its ordinary default-`Blob` MP4 remux route is **231,436 B (226.01 KiB) raw, 83,182 B gzip, and 73,056 B Brotli**. The verifier prunes each consumer bundle to the measured first-operation closure and successfully executes that route; both route reports contain zero worker, WebAssembly, codec-data, or other non-JavaScript assets. These measurements satisfy the normative 50 KiB eager and 250 KiB typical-route ceilings without changing either limit.

The current result cache does not contain complete comparable numeric speed, memory, or bundle measurements. Its bundle-size measurement is unavailable because exhaustive JS, worker, codec-core, and WebAssembly evidence was not joined. Its invalidated records also prevent this cache alone from certifying a release. Therefore this baseline cannot establish that AiBrush is currently the fastest or smallest engine.

## 5. Functional requirements

### 5.1 Sources and I/O

The engine MUST:

- accept `Blob`/`File`, URL, range-capable URL, `ArrayBuffer`/typed-array, `ReadableStream`, and an application-provided random-access source;
- discover length and range capability without downloading an entire remote object;
- coalesce, cache, cancel, and prioritize range reads;
- preserve backpressure from the sink to the source;
- avoid copying the full input into an internal virtual filesystem;
- support inputs and outputs beyond 4 GiB using 64-bit-safe arithmetic, with `bigint` at public boundaries where JavaScript `number` is unsafe;
- support memory, stream, seekable file/OPFS, and application-provided sinks;
- declare before execution whether the selected container route requires seeking, reservation, or finalization;
- provide progress in media time and bytes without forcing complete indexing.

For range servers that change validators or return inconsistent data, the engine MUST stop with a typed integrity error rather than assemble a corrupt file.

### 5.2 Probe and metadata

Probe MUST be lazy, deterministic, and able to return useful partial information. It MUST distinguish `known`, `unknown`, `unsupported`, `malformed`, and `not-yet-read` values rather than fabricate defaults.

The normalized model MUST cover:

- container, brands/profiles, duration, timescale, bitrate, and seekability;
- all tracks, default/alternate dispositions, language, labels, and stable track identifiers;
- codec configuration, profile/level/tier, coded and display dimensions, rotation, pixel aspect, frame rate, and alpha;
- audio sample rate, sample format, layout/channel count, priming, padding, and gapless duration;
- color primaries, transfer, matrix, range, chroma location, bit depth, and HDR static metadata;
- chapters, text/subtitle presence, attachments, common tags, and cover art;
- encryption scheme and protection metadata without exposing keys.

### 5.3 Demux, packet iteration, seek, and decode

- Packet timestamps MUST use exact rational conversion and MUST retain decode time, presentation time, duration, keyframe state, and dependencies.
- Seeking MUST define `keyframe-before`, `keyframe-after`, `nearest`, and `exact` modes.
- Exact video seeking MUST decode dependencies and discard pre-target output correctly, including open GOPs, B-frames, edits, and nonzero starting timestamps.
- Audio seeking MUST account for codec delay, pre-skip, encoder priming, end padding, and discontinuities.
- Packet and frame iterators MUST be pull-based or bounded; a slow consumer MUST NOT cause an unbounded queue.
- Returned `VideoFrame`, `AudioData`, GPU, or WASM resources MUST have explicit ownership and deterministic release.
- Corrupt samples MUST produce a typed error containing container/track/time context; they MUST NOT hang a decoder loop.

### 5.4 Filters and media transforms

Video requirements include resize, crop, pad, rotate, flip, pixel-format conversion, alpha preservation, frame-rate conversion, color conversion, range conversion, tone mapping, and bit-depth conversion.

Audio requirements include resampling, gain, trim, fade, mixing, interleave/deinterleave, channel-layout conversion, and an explicit mix matrix.

The planner MUST fuse compatible transforms and minimize frame readbacks and format conversions. A GPU route SHOULD consume `VideoFrame` directly through `GPUExternalTexture` where the browser makes this beneficial. CPU/WASM fallbacks MUST produce equivalent results within declared numeric tolerances.

Color transforms MUST use signaled metadata and an explicit policy for missing metadata. Rotation metadata MUST never be applied both physically and logically. Alpha MUST never be discarded silently.

### 5.5 Encode and transcode

- The engine MUST call WebCodecs capability checks before configuring native encoders and MUST validate the configuration actually returned by the browser.
- Route selection SHOULD incorporate support, expected smoothness/power efficiency, requested quality, startup cost, and past route failures.
- Required codec controls MUST include bitrate/quality, rate-control mode, keyframe interval, latency mode, hardware preference, profile/level where meaningful, and alpha/color metadata where supported.
- A requested control MUST be applied, explicitly downgraded with a structured warning, or rejected before expensive work begins.
- Software codec modules MUST be codec-scoped, lazy, cacheable, and replaceable. SIMD and threaded variants MAY be selected only after feature and isolation checks.
- Quality comparisons MUST normalize codec, resolution, frame rate, pixel format, audio layout, duration, bitrate/file-size target, and objective-quality threshold.
- Multi-output/ABR work MUST decode and transform shared input once when outputs permit fan-out.

### 5.6 Mux, remux, and streaming output

- Muxers MUST preserve rational timestamps, composition offsets, edit semantics, codec configuration, color, rotation, alpha, language, gapless audio, and selected metadata.
- MP4/MOV MUST support ordinary, fragmented/CMAF, fast-start, reserved-index, and `co64` paths as applicable.
- Matroska/WebM MUST support finite files and progressive cluster emission without buffering the whole media timeline.
- MPEG-TS/HLS output MUST handle small writes, continuity, timestamp wrap/discontinuity, initialization state, and bounded segment memory.
- Ogg output MUST produce correct page granules, lacing, codec headers, and end trimming for Opus/Vorbis/FLAC routes.
- A copy/remux operation MUST never decode or encode samples unless the requested edit makes that unavoidable.
- Append-only sinks MUST either receive a valid progressively emitted format or be rejected during planning. They MUST NOT fail only after the full operation has run.

### 5.7 Trim and timeline editing

The API MUST distinguish:

- fast/keyframe-aligned copy trim;
- accurate hybrid trim, which repairs boundary GOPs and copies the interior;
- full re-encode trim;
- lossless sample-aligned compressed-audio trim when the format can signal delay/padding.

The result MUST honor the requested presentation interval within one output audio sample and, for accurate video trim, one output frame. The engine MUST expose any unavoidable alignment adjustment. It MUST handle B-frames, open GOPs, VFR, nonzero origins, edit lists, priming, padding, and composition boundaries.

### 5.8 Encryption and protected media

- Supported clear-key workflows MUST include explicit schemes, IV rules, subsample layouts, and container signaling.
- CENC/CBCS and supported HLS AES operations MUST validate key and IV sizes, block/mode constraints, and declared metadata before processing.
- Authentication or decryption failure MUST be indistinguishable in detail to untrusted callers where detailed errors could become an oracle.
- Keys and clear samples MUST not be logged, included in telemetry, or retained beyond their required lifetime.
- DRM license acquisition and CDM-protected decoding are outside the clear-media pipeline unless separately specified.

### 5.9 Errors, cancellation, and observability

- Every public asynchronous operation MUST accept cancellation.
- Errors MUST have stable machine-readable codes, stage, route, media context, and a causal chain.
- Capability absence, invalid request, malformed input, resource exhaustion, browser failure, and internal invariant failure MUST be distinct classes.
- Route fallback MUST be observable and MUST NOT conceal a quality, timing, or metadata change.
- Debug traces MUST be opt-in, bounded, and free of media payloads and secrets.
- Every operation MUST expose a serializable execution report containing selected route, modules loaded, input/output bytes, stage timings, queue maxima, peak-memory evidence where available, warnings, and browser capabilities.

## 6. Supported media target

The support matrix MUST be generated from executable capability declarations and published with every release. Documentation MUST NOT imply that container support automatically means encode or decode support for every codec in that container.

The target matrix is:

| Class | Required targets |
| --- | --- |
| Containers/streams | MP4/MOV/CMAF, Matroska/WebM, Ogg, MPEG-TS/HLS, MP3, WAV, FLAC, ADTS AAC |
| Video codecs | H.264/AVC, H.265/HEVC where legally distributable or natively available, AV1, VP9, VP8 |
| Audio codecs | AAC, Opus, Vorbis, MP3, FLAC, PCM |
| Images used by workflows | JPEG, PNG, WebP, AVIF where capability exists |

For every container, the matrix MUST separately declare probe, demux, mux, streaming mux, remux, metadata, seek, trim, and encryption support. For every codec, it MUST separately declare parse, decode, encode, alpha, bit depths, channel layouts, hardware route, and software route.

A SOTA release MUST successfully process every valid required-matrix combination for which the project can ship or invoke a legal browser route. A genuinely unavailable platform or licensed-codec route MUST return a preflight capability result with a remediation path; it MUST NOT become a mid-operation generic failure.

## 7. Architecture requirements

### 7.1 Capability-driven planner

The planner MUST use input bytes, requested output, sink properties, browser capabilities, and measured route characteristics. It MUST NOT route by filename alone or assume a codec because a container usually contains it.

Candidate routes MUST be ranked lexicographically:

1. output correctness and semantic completeness;
2. legal/security availability;
3. ability to stream within the memory budget;
4. expected end-to-end latency or throughput for this workload;
5. incremental bytes and compile/startup cost;
6. power efficiency and main-thread impact.

Route decisions MUST be inspectable and reproducible. Runtime route failures MAY update a bounded per-browser capability cache, but MUST NOT permanently poison a route after a transient resource failure.

### 7.2 Native-first, specialized-fallback execution

WebCodecs SHOULD be the default encode/decode route when it is correct for the requested configuration. Because the WebCodecs specification does not require any particular codec, every route MUST be discovered at runtime and paired with a deliberate fallback or explicit unsupported result.

TypeScript SHOULD handle lightweight parsing, muxing, metadata, and transformations where it minimizes startup and copying. WebGPU SHOULD handle sufficiently large parallel transforms when dispatch/readback cost is lower than the CPU alternative. Focused WebAssembly SHOULD cover missing or inconsistent codecs and compute-heavy operations.

The default route MUST NOT load a general FFmpeg-class core. A separately scoped compatibility module MAY exist for long-tail workflows only if its size, startup, memory filesystem behavior, licensing, and performance are visible to the caller and excluded from default bundles.

### 7.3 Zero-copy and bounded queues

- Bytes, packets, frames, and encoded chunks MUST have explicit ownership.
- Each stage MUST advertise queue limits and use upstream backpressure.
- Cross-worker transfer MUST use transferable objects or shared memory where safe and measurably beneficial.
- GPU work SHOULD avoid CPU readback between compatible stages.
- A full-input `ArrayBuffer` or full-output accumulation is forbidden unless the caller explicitly chooses an in-memory source/sink and the object is below a documented threshold.
- Browser storage spill MUST use OPFS; synchronous access handles MAY be used only inside a dedicated worker.

### 7.4 Timeline and numeric model

Internally, media time MUST be represented by overflow-safe integer ticks plus an explicit timescale or an equivalent exact rational type. Floating-point seconds MAY be an API convenience but MUST NOT be the authoritative representation for muxing, seeking, trim, or equality.

All parsers and writers MUST use 64-bit-safe sizes and offsets. Conversions MUST define rounding direction, and cumulative timestamp conversion MUST not drift with duration.

### 7.5 Browser isolation

Engine contracts MUST not leak vendor-specific browser behavior. Browser defects and codec quirks MUST live in tested adapters keyed by demonstrated capability/behavior, not vague user-agent ranges whenever a behavioral probe is possible.

## 8. Quantitative quality requirements

### 8.1 Correctness and coverage gates

- Required release corpus: **zero FAIL and zero ERROR** for in-scope scenarios.
- `NA_ENGINE`: zero for required matrix cells with a legal implementation route.
- `NA_ASSET` and `NA_BROWSER`: excluded only with manifest evidence; they MUST NOT improve the score.
- Negative scenarios pass only when the engine rejects the request with the expected typed error and without partial corrupt output.
- Every fixed defect MUST add a minimal regression test plus at least one generalized or mutated variant.
- Every parser and muxer MUST pass round-trip/property tests, truncation tests, boundary-size tests, and fuzzing with a retained regression corpus.

### 8.2 Speed gates

Speed is counted only after output correctness and quality equivalence pass. On the same machine, browser build, input, output constraints, isolation state, and warm/cold condition:

- each benchmark MUST include warm-up followed by at least 30 recorded samples or enough samples for a stable confidence interval;
- the report MUST include median, p95, dispersion, input/output throughput, startup time, and main-thread long-task time;
- the family geometric mean MUST be no slower than the fastest fully correct compared engine;
- at least 90% of comparable required scenarios MUST be within 5% of the fastest correct median;
- no required scenario MAY be more than 10% slower at p95 without a documented correctness, memory, power, or loaded-size advantage accepted in the release review;
- cold-start and warm-throughput results MUST be reported separately;
- hardware and software routes MUST be reported separately.

Performance changes MUST be evaluated on representative tiny, short, long, 4K, high-frame-rate, multitrack, and high-latency range-backed inputs. A microbenchmark win MUST NOT override slower end-to-end execution.

### 8.3 Bundle and startup gates

Size MUST be measured from a clean consumer build, not by summing source files. Reports MUST include minified raw, gzip, and Brotli bytes for JavaScript, workers, WebAssembly, and codec data; WebAssembly compile time and peak compiled-code memory MUST be separate.

- Default-import eager static JavaScript closure: **≤ 50 KiB minified raw**.
- Typical native MP4 probe/remux first-operation closure: **≤ 250 KiB minified raw**. The reproducible concrete routes are a typed fast-start MP4 `Blob` probe and an ordinary default-`Blob` MP4 remux.
- No codec, worker, GPU kernel, or container driver MAY load before the chosen operation needs it.
- A route MUST NOT fetch a module larger than 1 MiB without exposing that cost during planning or preload.
- For each comparable required route, total transferred bytes through first successful output MUST be within 5% of the smallest fully correct competitor.
- Format- and operation-scoped entry points MUST remain independently tree-shakable.
- CI MUST fail on budget regression; updating a budget requires an architecture review and benchmark evidence, not merely a new number.

### 8.4 Memory and scalability gates

- Probe/demux of a 10 GiB seekable local or range-backed input MUST complete with at most **64 MiB** peak JavaScript heap growth beyond browser/codec baseline.
- Copy/remux of a 10 GiB input to a streaming or seekable sink MUST use at most **128 MiB** peak JavaScript heap growth beyond baseline.
- Transcode memory MUST be independent of duration and bounded by `96 MiB + four decoded frame footprints + declared native/WASM codec heaps`, unless a lower device-specific limit is selected.
- Queue occupancy MUST remain within configured limits under a consumer slowed to 10% of producer throughput.
- No size or offset path may truncate at 2 GiB or 4 GiB.
- Cancellation MUST release owned frames, codec instances, workers, streams, file handles, GPU resources, and WASM heaps promptly; repeated cancel/retry MUST show no monotonic leak.

Because browser memory APIs vary, every report MUST name the measurement method and include process-level evidence where reproducible. An unavailable metric is “not measured,” never zero.

### 8.5 Responsiveness and reliability gates

- Operations expected to exceed 50 ms of CPU work SHOULD execute outside the main thread by default.
- Interactive routes MUST NOT create a main-thread task longer than 50 ms; unavoidable browser API calls MUST be identified in the execution report.
- All streaming operations MUST survive randomized chunk boundaries, tiny writes, delayed reads, and backpressure.
- A 24-hour repeated mixed-workload soak MUST complete without a crash, deadlock, unbounded growth, or resource leak before a SOTA release.
- Malformed-input fuzzing MUST enforce per-operation byte, allocation, recursion, and time budgets.

## 9. Browser and device requirements

Release CI MUST cover the latest two stable major versions available at release time for Chromium, Firefox, and Safari, plus the current iOS Safari. The exact versions belong in the generated compatibility report rather than this living document.

The matrix MUST include:

- Apple Silicon and x86-64 desktop coverage where available;
- at least one lower-memory mobile device;
- hardware acceleration enabled and a forced software/fallback configuration;
- cross-origin-isolated and non-isolated contexts;
- workers, WebGPU available/unavailable, OPFS available/unavailable, and range server available/unavailable.

Feature support MUST be determined through standards APIs and behavioral probes. User-agent checks MAY select a documented workaround only after a reliable feature probe is impossible.

## 10. Benchmark integrity and anti-overfitting

`media-test` is an evaluator, not a production dependency. Production code MUST NOT import it, read its result caches, inspect its scenario IDs, or recognize its fixtures.

Specifically, implementations MUST NOT branch on:

- fixture filename, URL path, exact byte length, hash, or known test metadata;
- scenario or engine identifier;
- timing constants chosen only to satisfy one fixture;
- browser-test origin, cache layout, or result format;
- expected oracle output embedded from the corpus.

Implementation decisions MUST derive from media bytes, public operation options, sink/source properties, and runtime capabilities. Optimizations discovered through a test MUST apply to the general format/codec condition and MUST include nonfixture regression variants.

The benchmark system MUST provide:

- a versioned execution manifest and corpus checksum;
- public representative tests plus private/held-out and generated variants;
- randomized chunking, timestamps, dimensions, durations, metadata, and track ordering;
- independent native reference oracles where possible;
- metamorphic checks such as remux invariants, decode/re-encode properties, and split-versus-whole equivalence;
- quality-normalized comparisons and a record of every exclusion;
- raw result artifacts sufficient for a third party to recompute the score.

At least 20% of release correctness scenarios SHOULD be held out from routine implementation runs. A change that improves named fixtures but regresses generated or held-out variants MUST be rejected.

Additional integrity rules, learned from the 2026-09-01 review:

- Produced output MUST NOT carry data intended for the evaluator. Metadata, tags, or side channels that embed expected samples, pixels, hashes, or decoder state so an oracle can substitute them are prohibited, and any oracle that reads such data is invalid.
- A correct algorithm MUST NOT be downgraded to match an approximate reference. When a reference is found to be less accurate than the implementation, the reference is the defect and MUST be re-baked with an independent tool.
- Caches MUST be owned by the engine instance and MUST NOT survive `dispose()`. Module-level caches keyed by URL, size, or content hash are prohibited. Range fetches MUST use the platform default cache mode and MUST revalidate.
- The autonomous implementation loop MUST NOT modify `media-test`. Benchmark, oracle, fixture, and adapter changes are made by a human in a separate change with their own review.
- The `media-test` adapter for this engine MUST import only the public root entry, MUST NOT branch on harness context, MUST NOT post-process or repair library output, and SHOULD stay under 1,500 lines. Every adapter workaround is a library gap and MUST be recorded as such.
- A backlog item MAY be marked done only with a measured `--no-reuse` run of at least 30 iterations attached; estimates are not evidence.

## 11. Validation and evidence

Every candidate release MUST publish a machine-readable evidence bundle containing:

- package version, commit, clean/dirty state, build flags, lockfile hash, and artifact hashes;
- browser, OS, device/CPU/GPU, isolation, memory, and hardware-acceleration details;
- execution manifest, corpus checksum, scenario results, typed exclusions, and oracle versions;
- route plan and actual route for every operation;
- raw timing samples, byte measurements, memory evidence, long tasks, and output hashes;
- visual/audio quality measurements and thresholds for lossy output;
- license and provenance inventory for shipped JavaScript, WebAssembly, codec code, and test media.

The comparison set MUST include the strongest maintained browser-capable alternatives for each family, not just engines with one common API. At the baseline date this includes MediaBunny, ffmpeg.wasm, MP4Box.js, Remotion's media stack, web-demuxer, and direct browser-native APIs where relevant. Versions MUST be pinned in evidence but updated for each release comparison.

## 12. Security, privacy, and licensing

- All parsers, codec modules, workers, and GPU kernels MUST treat media as untrusted input.
- Allocation and loop bounds MUST be validated before use; integer overflow and decompression bombs MUST fail within resource budgets.
- WebAssembly modules MUST use the least required imports and a restrictive Content Security Policy-compatible loading path.
- The package MUST have no hidden runtime CDN dependency. Optional remotely hosted assets require explicit caller configuration plus integrity/version control.
- Security-relevant codec and parser dependencies MUST be tracked by exact version and promptly patchable without loading unrelated modules.
- Codec patents, redistribution terms, and test-media licenses MUST be reviewed before a codec binary or fixture is published. Native availability does not imply redistribution permission.
- Processing and telemetry MUST be local and opt-in; payload bytes, keys, file names, and user metadata MUST NOT be emitted by default.

## 13. Work program

### Phase 0 — Make the evidence trustworthy

1. Complete exhaustive route-aware bundle measurement, including workers and WebAssembly.
2. Add comparable cold/warm time, p95, memory, long-task, and output-quality evidence.
3. Make the existing 50 KiB eager budget pass without hiding code from the measurement graph.
4. Generate the support matrix from executable declarations.
5. Make benchmark results distinguish implementation failure, genuine platform absence, missing asset, and harness failure.

### Phase 1 — Remove correctness and scale blockers

1. Replace whole-input assumptions with a shared range/cache protocol and bounded packet indexes.
2. Unify timestamp, edit, delay, padding, and composition math on the exact timeline model.
3. Fix the failed video-transform routes and build CPU/GPU equivalence tests.
4. Complete seekable/append-only MP4, Matroska/WebM, Ogg, and TS writers, including >4 GiB paths.
5. Reach zero FAIL/ERROR across the current required corpus before optimizing benchmark time.

### Phase 2 — Close feature gaps with the best route

1. Complete AAC/MP3 encode fallback strategy and Ogg Opus/Vorbis/FLAC workflows.
2. Complete H.264 bit-depth/profile conversions, HEVC policy/routes, two-pass or equivalent quality control, and VP8/VP9 alpha.
3. Complete multitrack selection, shared-decode ABR fan-out, and explicit image/still-image workflows.
4. Complete accurate open-GOP and compressed-audio trims.
5. Harden CENC/CBCS and HLS validation and failure behavior.

### Phase 3 — Establish performance and size leadership

1. Profile end-to-end stage cost and eliminate unnecessary byte/frame copies.
2. Fuse CPU/WebGPU transforms and select paths from measured workload thresholds.
3. Tune queue depths, chunk sizes, range coalescing, and codec reuse without increasing peak memory.
4. Split and deduplicate route modules until every feature meets the route-size gate.
5. Compare against the current best correct competitor per family and fix regressions by family, not fixture.

### Phase 4 — Cross-browser SOTA release

1. Pass the full browser/device matrix and long-running soak/fuzz campaigns.
2. Publish generated support, performance, bundle, memory, license, and known-limit reports.
3. Run the held-out corpus once the candidate is frozen; reopen development on any generalized failure.
4. Complete an independent evidence review before making SOTA claims.

## 14. Definition of done

A feature is done only when:

- its valid and invalid semantics are documented;
- capability preflight and route selection work on the browser matrix;
- independent-oracle, boundary, streaming, cancellation, and malformed-input tests pass;
- its output preserves required timing, color/audio, metadata, and container semantics;
- speed, loaded bytes, memory, and main-thread impact are measured;
- no fixture-specific behavior exists;
- failure is typed and actionable;
- shipped code and assets pass license and security review.

The project is eligible for a “best-in-class browser media engine” release only when:

1. all P0 and P1 gaps are closed or explicitly removed from the published required matrix with product and legal justification;
2. every correctness, speed, bundle, memory, responsiveness, and browser gate above passes;
3. AiBrush has the broadest correct coverage and wins or falls within the permitted margin of the best correct engine for each required feature family;
4. the results reproduce from a clean checkout using published commands and artifacts;
5. the public documentation states measured facts and limitations without treating unsupported cases as successes.

## 15. Standards and competitor references

These sources inform the architecture and comparison criteria; they do not substitute for measurement:

- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/) — codec interfaces, capability variability, queues, and resource lifecycle.
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/) — support, smoothness, and power-efficiency queries.
- [WHATWG Streams](https://streams.spec.whatwg.org/) — backpressure and byte-oriented stream behavior.
- [WHATWG File System](https://fs.spec.whatwg.org/) — OPFS and worker-only synchronous access handles.
- [W3C WebGPU](https://www.w3.org/TR/webgpu/) — GPU compute and external video-frame texture integration.
- [WebAssembly Core Specification](https://webassembly.github.io/spec/core/) — portable software fallback execution.
- [MediaBunny introduction](https://mediabunny.dev/guide/introduction) and [format/codec support](https://mediabunny.dev/guide/supported-formats-and-codecs) — a tree-shakable TypeScript/browser-native comparison architecture.
- [ffmpeg.wasm overview](https://ffmpegwasm.netlify.app/docs/overview/) and [performance notes](https://ffmpegwasm.netlify.app/docs/performance/) — broad WebAssembly compatibility and its startup/filesystem/performance tradeoffs.
- [MP4Box.js](https://github.com/gpac/mp4box.js/) — progressive ISO BMFF parsing, segmentation, and sample extraction comparison.
