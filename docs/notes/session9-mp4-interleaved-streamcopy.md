# Session 9 - MP4 Interleaved Stream-Copy

## Goal

Close `mux/mp4_faststart_reserve`, the current top Session 9 Chromium wall-time deficit, without changing
the mux scenario, oracles, or declared streaming-target behavior. The benchmark prepares H.264/AAC tracks
from `h264_1080p_30s.mp4`, then asks the adapter for an MP4 stream-target output with `fastStart:'reserve'`.
Because the current harness reserve oracle validates final layout rather than sparse patch telemetry, the
engine still must write a real MP4 through the stream target and pass `reference-reimport`,
`property-invariant`, and `mp4-box-layout`.

## Root Cause

The adapter's reserve path falls back to public same-container `engine.remux()` for the single-source
MP4/MOV case. That reaches `Mp4Driver.streamCopy(src, { streaming:true, faststart:true })`.

The old streaming stream-copy writer emitted an `mdat` payload in track-major order: all video samples,
then all audio samples. The real source is interleaved, so the lazy payload reader scanned nearly the whole
source once for video and again for audio. On the 31,258,790 byte workhorse, a local probe measured
62,358,041 source bytes read for the streaming path, versus 31,258,774 bytes for the buffered path.

## Decision

Keep the output as a fresh authored MP4, but let progressive streaming copy preserve the source's
interleaved payload order when the sample offsets are monotonic within each track. The writer now accepts an
optional typed `sampleChunks` layout per track. When present, `write.ts` emits multi-entry `stsc` and `stco`
tables instead of the historical one-chunk-per-track table, and places sample payloads at the requested
`mdat` offsets. Without `sampleChunks`, `writeMp4()` keeps the old one-chunk-per-track layout byte shape.

`Mp4Driver.streamCopy()` now builds a source-order interleaved plan for untrimmed progressive multi-track
streaming output. It sorts validated samples by source byte offset, rejects the optimization if that order
would reorder samples inside a track, and otherwise emits `ftyp`, `moov`, `mdat`, then coalesced source
windows once. Trimmed output, fragmented output, single-track output, and unusual non-monotonic files keep
the existing paths.

This is not a passthrough. The output receives a freshly authored `moov`; the sample tables are regenerated
for the new chunk layout, and the payload bytes are copied as media samples only.

## Edge Cases

- B-frames: per-track decode order is preserved; `ctts` values are unchanged because sample order within
  each track is unchanged.
- VFR: per-sample durations and composition offsets remain in the existing track sample arrays.
- Sparse or corrupt sample tables: byte ranges are still validated before stream-copy exposes payloads.
- Non-monotonic per-track source order: falls back to the conservative track-major writer.
- Backpressure and cancellation: the output remains a `ReadableStream`; payload reads still check the
  operation signal before and after each coalesced source read.
- Memory: the streaming path still emits bounded chunks and does not materialize the whole output.

## Validation

Focused package validation:

```bash
bun test src/drivers/mp4/roundtrip.test.ts src/drivers/mp4/write.test.ts
bun run typecheck
```

Both pass after the change. The roundtrip test now asserts that multi-track progressive streaming reads less
than 1.25x the source size, catching the previous duplicate source scan.

Local probe on the real 30s fixture after the change:

- streaming stream-copy: 7 output chunks, 31,258,515 bytes out, 7 source reads, 31,258,774 bytes read.
- buffered stream-copy: 1 output chunk, 31,241,875 bytes out, 4 source reads, 31,258,774 bytes read.

Fresh Chromium proof:

```bash
bash scripts/run.sh --browser chromium --engine aibrush-media@dev,mediabunny@1.48.0 \
  --scenario mux/mp4_faststart_reserve --warmup 3 --iters 5 --no-reuse --timeout-ms 900000
```

Raw export: `/private/tmp/aibrush-harness-RmNgBu/results/raw/chromium-2026-07-04T15-36-24-157Z.json`.

- aibrush-media@dev: PASS, median wall **57.800 ms** over 5 samples
  (`59.405`, `51.080`, `57.800`, `57.800`, `50.450`), `targetWrites=136`,
  `bytesOut=31,241,860`.
- mediabunny@1.48.0: PASS, median wall **66.875 ms** over 5 samples
  (`74.370`, `67.940`, `66.875`, `66.055`, `61.075`), `targetWrites=122`,
  `bytesOut=31,316,671`.
- Both passed `reference-reimport` with **2308** packets and **1423** keyframes.
- Both passed the duration invariant with `deltaSec=0.021333333333334537 <= 0.041666666666666664`.
- aibrush `mp4-box-layout`: `ftyp@0, moov@32, mdat@10383`.
- mediabunny `mp4-box-layout`: `ftyp@0, moov@28, free@10906, mdat@85186`.

After adding this overlay, `docs/perf/gen-deficits.mjs` reports **189 active deficits**
with severity split `0/0/7/182`, and `mux/mp4_faststart_reserve` is no longer listed.

Package gate follow-up:

- The writer-coverage additions lifted global branch coverage over the 90% threshold.
- To keep the first-operation package budget green, MP4 CENC sample-decrypt helpers now load lazily from
  the decrypt path only (ADR-158).
- `bun run scripts/check-budgets.ts` after build + wasm vendoring reports the typical app closure at
  **254.31 kB** against the **256.00 kB** budget, and the eager kernel at **47.73 kB** against **50.00 kB**.

## Rejected

- Returning the input MP4 bytes or changing only `ftyp`/layout flags.
- Weakening `reference-reimport`, `property-invariant`, or `mp4-box-layout`.
- Buffering the whole stream-target output and flushing it as fake streaming.
- Hardcoding `h264_1080p_30s.mp4`, packet counts, byte offsets, chunk counts, or benchmark timings.
- Applying interleaving when source byte order would reorder samples inside a track.
- Copying competitor source code.
