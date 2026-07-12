# Session 13 baseline and inherited gate repair

## Goal

Establish a truth-preserving Session 13 baseline before optimizing any contested feature, while restoring
the strict typecheck gate that is red at the handoff commit. The gate failure is confined to the declared
return type of the abort-aware WAV `AudioData` reader; the browser library types now distinguish a default
reader result whose done branch has an optional `value` from the older generic result shape.

## Design

The WAV repair changes only the helper's static return type to a local structural default-reader result
that accepts both the DOM declaration (done-value present as `undefined`) and Bun's standards-compatible
declaration (done-value omitted). The runtime
algorithm remains unchanged: the abort promise races the pending read, a late non-done frame is closed
exactly once, the listener is removed in `finally`, and the caller closes every normally delivered frame
after copying it. Replacing the race with reader cancellation was rejected because cancellation can lose
the explicit late-frame ownership proof; casting was rejected because it would hide the library-type
mismatch, and importing a Bun-only namespace into browser production code was rejected. There are no
B-frames or VFR on this audio-only path. Backpressure remains one outstanding read,
memory remains one `AudioData` plus its copied PCM bytes, and cancellation retains the same ownership.

For MP4/MOV probe, the initial hypothesis is deliberately not yet an implementation decision. The observed
Session 13 losses are metadata-only and create no frames. Candidate general causes are duplicate bounded
prefix reads, repeated top-level or `moov` walks, and allocation in the metadata parser when the guarded
small-video path declines. Any accepted optimization must preserve exact edit-list duration, VFR cadence,
B-frame-independent metadata, rotation, HEVC/AVC codec strings, fragmented fallback timing, typed malformed
input failures, bounded range I/O, and abort checks. Per-source parsed-result caching, asset recognition,
fixture-size tuning, and relaxed metadata oracles are rejected.

## Probe range-cache decision

Product-only instrumentation on real faststart and tail-`moov` MP4s isolated the shared fixed cost: the
existing repeated-probe cache retains only ranges beginning at byte zero, so every warm tail-metadata probe
reissues the same structural range requests. The selected implementation moves repeated-probe caching out
of the nearly-full eager engine closure into a lazy source module. It caches only byte intervals actually
requested from the exact same immutable `Source` snapshot, with a one-MiB aggregate cap, eight-interval cap,
60-second lazy expiry, and deterministic least-recently-used eviction. Each retained interval is copied into
an exact-sized owned buffer, and every hit returns an isolated copy; contained older intervals are replaced
by a larger fetched interval without double-counting. Distinct source objects
remain isolated even when their URL/cache key is equal. One-shot streams are unaffected because they expose
no range seam. B-frame/VFR packet order, seek, frame ownership, streaming backpressure, cancellation, and
container parsing do not change: the cache sits below parsing and retains immutable encoded bytes only.

A two-interval head/tail special case was rejected as less general for files with multiple metadata
islands. Parsed `MediaInfo` caching, filename/hash detection, cross-source URL caching, borrowed subarray
retention, unbounded LRU state,
and fixture-size thresholds are forbidden. The existing one-MiB/60-second values remain general resource
budgets rather than benchmark-tuned constants.

The higher-sample sweep isolated two remaining parser costs after interval reuse. First, a cache-keyed MP4
under one MiB still ran the full demux parser and an `mdat` ownership scan during `probe()` only to speculate
that demux might immediately follow. Probe will now keep the exact already-read `moov` payload for the
250 ms handoff, while demux alone expands sample tables and validates `mdat` ownership. Second, metadata
mode will summarize `stts` runs as scalar sample-count/duration facts rather than allocate one object per
VFR run; full and packet-info parses keep their exact arrays. AAC edit/gapless timing, `stsz` fallback,
fragment timing, rotation, codec configuration, and average fps remain byte/number-identical. Dropping the
handoff entirely and approximating VFR from the first run were rejected as regressions.

## Validation plan

- Run the focused WAV frame-encode lifecycle tests, including abort during a pending read and exact frame
  closure, followed by strict typecheck.
- Run the public all-engine benchmark only through its documented command surface. Qualified evidence must
  be same-export, rotation-on, warmup at least one, and at least five measured samples.
- Profile only product code. Probe output before and after must be structurally identical across the real
  MP4/MOV corpus, including AVC, HEVC, VFR, B-frame, rotation, fragmented, audio-only, and malformed inputs.
- Record warm wall and positive-sample memory against the fastest passing rival; do not promote provisional
  handoff numbers to `LEAD`/`BEHIND` closure evidence.

The same handoff typecheck also exposed four stale Matroska benchmark fingerprint properties that are not
members of `TrackInfo` and therefore have always serialized as absent. Removing those undefined object
members preserves the benchmark's runtime JSON and digest exactly; track identity, codec, duration,
gapless/colour facts, config description, and every packet byte/timestamp remain fingerprinted. Reading
geometry from a guessed config union or casting the track was rejected because either would change the
established checksum or conceal an invalid assumption.

One focused source-cache assertion was also stale: the real VP9-alpha WebM's first 4 KiB is sufficient
for image/container sniffing but not for the driver's complete track/attachment proof, so the metadata
reader legitimately grows to its next bounded 64 KiB prefix. The corrected assertion requires exactly
those two reads and still forbids a stream/full-file fallback. Treating the partial 4 KiB parse as complete
would risk dropping a later track, attachment, alpha fact, or duration and is therefore not an optimization.

The first repository-wide Biome pass also exposed three inherited purely mechanical formatting failures:
one committed benchmark JSON sample array and import ordering in the worker host/protocol. Biome's own
formatter was applied to only those three files. Runtime bytes, worker messages, WASM profile selection,
cancellation, frame ownership, and benchmark values are unchanged; the repair exists solely so the binding
full lint gate evaluates the Session 13 changes rather than stopping on pre-existing formatting drift.

## Active provisional baseline correctness

The rotation-on, warm `n=5`, all-engine baseline launched from the pre-optimization bundle remains a
discovery artifact rather than closing evidence for the current working tree. It was preserved as a partial
export at 1,892 of 3,941 result cells after `web-demuxer@4.0.0` stopped completing
`audio-dsp/resample_48k_to_16k`; continuing to hold the shared old bundle would have blocked all current-tree
browser verification. Its aibrush cohort contains 209 passes and the following five explicit correctness
losses. The final current-bundle sweep must start fresh with no successful-result reuse and a bounded cell
timeout. Each loss must either
pass on the final bundle or remain covered by the binding retained-red/exemption evidence; a faster failing
row is never admitted to the speed ledger as a win.

| scenario | selected input | exact failure |
|---|---|---|
| `mux/edge_hevc_decode_mux_mkv` | baked `hevc_1080p_10s.mp4` | platform decode of the muxed output reports zero intrinsic size |
| `transcode/h264_to_av1_mp4` | rotated `03.mp4`, SHA `58dc001d183f…` | mean SSIM `0.9663` is below the `0.97` gate |
| `performance/convert-longtasks` | rotated `02.mp4`, SHA `d01b447edad8…` | mean SSIM `0.9645` is below the `0.97` gate |
| `performance/metamorphic-transcode-idempotent-source-res` | rotated `03.mp4`, SHA `58dc001d183f…` | mean SSIM `0.9800` is below the `0.99` gate |
| `performance/size-ladder-iterate-packets-massive` | baked `massive_h264_1080p_2h.mp4` | count and PTS agree for all 553,501 rows, but 214,646 packet sizes mismatch |

The massive packet failure is being closed with an all-fields real-fixture regression over count, size,
PTS, DTS, duration, and key-picture truth. The idempotent source-resolution failure is eligible for a
compressed-domain path only when a source probe proves the requested codec, dimensions, rotation, rate,
and every other transform semantic are already satisfied; otherwise normal decode/filter/encode remains
mandatory. Neither repair may recognize a fixture, filename, hash, candidate count, or oracle threshold.

## Current-bundle harness handoff blocker

At 04:17 CEST on 2026-07-12 the fully verified current distribution was ready for the sibling black-box
harness, but the required cross-workspace `rsync` approval was rejected solely because the execution
environment's escalation-credit window is exhausted until 04:48. No alternate copy path is attempted: that
would circumvent the workspace boundary. In-repository work continues, and the first action after the
external reset is to vendor this exact gate-green `dist/`, invalidate no benchmark truth, and run fresh
no-reuse same-export rows through the harness's public command surface. This is infrastructure status only,
not a feature exemption, performance claim, or substitute for browser wall/memory evidence.

The exact approved-boundary command was retried at 04:47:59 and 04:48:13 after rebuilding the stabilized
distribution with ADR-267 through ADR-272. The execution service still reported the same usage-limit reset
message, so the sibling vendor remains unchanged and no browser result is attributed to the current bundle.
The command will be retried only after allowing the external reset state to settle; no indirect copy or
alternate write mechanism is used.

At 05:09 CEST the exact `rsync -a --delete dist/ ../media-test/src/engines/aibrush-media/vendor/`
boundary operation succeeded after the final gate below. The focused current-bundle all-engine Chromium
sweep then started fresh with rotation enabled, three warmups, seven measured samples, and result reuse
disabled. Only its completed exported JSON may replace provisional ledger evidence; partial snapshots are
progress artifacts and cannot close a row.

## Current integration gate

The exact `bun run gate` is green on the stabilized current tree: 207 Vitest files / 3,774 tests, 93.08%
statements and 90.11% branches, strict production/test/script TypeScript, repository-wide Biome, distribution
smoke, separate self-hosted WASM assets, package install/export/declaration verification, and all 50
anti-cheat checks. The eager kernel is 49.75 kB against 50.00 kB (0.25 kB guard), and the typical first-op
closure is 250.87 kB against 256.00 kB. The large multitrack byte oracle uses a zero-allocation exhaustive
first-difference loop rather than Vitest's recursive typed-array matcher, preserving bit-exactness without a
4 GiB matcher heap blow-up. None of these gate results replace the required fresh browser speed/memory
sweep.
