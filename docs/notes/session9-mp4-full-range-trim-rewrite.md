# Session 9 Note — MP4 Full-Range Trim Rewrite

## Goal

Close or honestly classify `trim/h264_noop_full_range_idempotent`, the top Session 9 deficit after the
previous packet-table and mux fast paths. The Chromium baseline
`chromium-2026-07-02T08-05-09-506Z.json` had aibrush-media PASSing the same four oracles as mediabunny
but at **613.835 ms** median versus mediabunny **47.225 ms**.

## Diagnosis

The scenario is a declared no-op trim: H.264/AAC MP4, `start=0`, `end=30.000s`, keyframe mode, with
`property-invariant`, `trim-boundaries`, `playback-smoke`, and `reference-reimport`. mediabunny's harness
adapter recognizes this as `trim(0..duration)` and returns `await input.arrayBuffer()`. That explains its
~45-50 ms timing: it is essentially one source-byte materialization. aibrush-media cannot take that route
because the repo rules and MP4 roundtrip tests reject input-to-output passthrough as real work.

The aibrush path had three avoidable costs:

- It treated `end=30.000s` as a sub-range because the max decoded track duration is about `30.016s`, so
  it trimmed away the codec-padding tail instead of preserving all packets for the declared full range.
- Its buffered stream-copy wrote `mdat` in track-major order while the source is interleaved, so Chromium
  reread overlapping video/audio byte windows and moved roughly twice the source payload.
- The public trim router demuxed once only to validate duration, then the MP4 driver parsed `moov` again
  to perform the copy.

## Design

The optimized path keeps the honest rewrite:

- `trimCoversMovie()` now accepts `start=0` plus a requested end at the movie/header duration when the
  max-track tail is within `50 ms`. This preserves EOF padding-scale packets for full-range requests.
- Untrimmed/full-range buffered MP4 stream-copy still plans the ordinary fresh track-major
  `ftyp`/`moov`/`mdat` layout, but it computes absolute output offsets for that layout and sorts only the
  source reads by file offset. This avoids rereading overlapping interleaved video/audio windows while
  keeping the small, existing one-chunk-per-track writer.
- Dense source payload spans up to `64 MiB` are read in one bounded range when non-sample gaps are at most
  `1 MiB`; sparse or larger files keep the existing windowed read path.
- MP4 advertises `validatesStreamCopyTrim`; it throws the same typed `InputError` messages as the public
  guard, allowing the engine to avoid the generic pre-trim duration demux for native keyframe stream-copy.

## Measurements

Fresh Chromium n=9 measurements after three warmups:

| Export | Variant | aibrush median | Fastest rival |
|--------|---------|---------------:|---------------|
| `chromium-2026-07-02T08-05-09-506Z.json` | Baseline | 613.835 ms | mediabunny 47.225 ms |
| `chromium-2026-07-02T08-20-47-498Z.json` | Source-order rewrite | 100.485 ms | mediabunny 45.625 ms |
| `chromium-2026-07-02T08-24-54-065Z.json` | Dense single-span read | 79.220 ms | mediabunny 49.875 ms |
| `chromium-2026-07-02T08-28-22-373Z.json` | Bulk-copy experiment | 84.690 ms | mediabunny 47.440 ms |
| `chromium-2026-07-02T08-33-04-467Z.json` | Interleaved-output writer experiment | 77.140 ms | mediabunny 45.735 ms |
| `chromium-2026-07-02T09-03-18-585Z.json` | Compact source-ordered reads + budget-green writer | 79.265 ms | mediabunny 47.120 ms |

The accepted compact path still PASSes all four oracles. `reference-reimport` reports **2308 packets**
and **1423 keyframes**, matching mediabunny's no-op output shape while remaining a freshly authored MP4.

## Parity Classification

The remaining faster-rival row is not an unexplained loss. The fastest rival measures a passthrough
no-op (`input.arrayBuffer()`); aibrush-media measures a fresh non-passthrough MP4 rewrite. Matching the
rival's wall time would require doing less work than this repo's correctness contract allows. ADR-130
therefore marks `trim/h264_noop_full_range_idempotent` as a same-work-impossible parity exemption in
`docs/perf/performance-parity-exemptions.json`.
