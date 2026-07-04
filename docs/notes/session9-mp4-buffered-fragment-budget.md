# Session 9 - MP4 Buffered Fragment Budget

## Concrete Goal

Close `streaming-output/buffer_massive_h264_mp4` on Chromium speed without changing the oracle, adding a
new feature, or pretending a buffered target is a true low-latency stream. The workload reads the real
massive H.264/AAC MP4 source, writes a buffered MP4-family output through the browser harness path, and
must pass `reference-reimport` with **553,501** packets and **2** media tracks. A done cell needs a fresh
multi-sample aibrush median at or below the fastest same-oracle passing rival.

## Design Note

The original correctness-preserving implementation used the same lazy fragmented MP4 cadence for
`buffered:true` as for `StreamTarget` output: around 900 samples per media segment, with a hard video cap
near 3,600 samples. That cadence is good for time-to-first-byte and backpressure, but it is wasteful for a
buffer target that will be materialized as one final byte array anyway. The dominant cost on the massive
row was repeated `moof`/`trun` planning, segment allocation, and per-fragment browser-side glue, not source
range scanning or oracle work. The fix keeps the streaming cadence for `streaming:true`, but lets
`fragmented:true` plus `buffered:true` use a 32x media-segment sample budget. This keeps source reads lazy
and bounded, preserves the real fragmented MP4 writer, and reduces fixed per-segment overhead where
latency-facing incremental writes are not part of the contract.

## Edge Cases

- **B-frames and VFR:** each segment still carries DTS, duration, composition offset, keyframe flags, and
  `tfdt` through the existing `SampleData` and `fragmentMp4` machinery.
- **StreamTarget latency:** `streaming:true` keeps the original 900-sample budget so live/incremental rows
  do not inherit huge fragments.
- **Memory:** buffered rows already materialize the final output; this change enlarges transient media
  segments only for the explicit buffered fragmented path and leaves progressive buffered stream-copy
  unchanged.
- **Cancellation:** `AbortSignal` checks remain before each fragment's sample reads and before segment
  enqueue.
- **Frame lifetime:** this is packet/sample byte-copy only; no `VideoFrame` or `AudioData` ownership is
  introduced.
- **Malformed sample tables:** sample ranges are still validated by the existing MP4 reader and lazy
  sample-data construction before payload reads.

## Verification

- `bun test src/drivers/mp4/roundtrip.test.ts`
- `bunx biome check src/drivers/mp4/mp4-driver.ts src/drivers/mp4/roundtrip.test.ts`
- `bun run build`
- `bun run vendor-wasm`

Fresh Chromium harness proof:

- aibrush-media:
  `/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-04T16-55-56-242Z.json`
  measured **4848.775 ms** median over five samples after one warmup:
  `[4832.925, 4797.755, 4848.775, 4875.230, 4855.090]` ms.
- ffmpeg.wasm:
  `/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-04T16-38-14-173Z.json`
  measured **5041.060 ms** median over five samples:
  `[5087.835, 4732.340, 4574.030, 5645.530, 5041.060]` ms.
- The aibrush run passed `reference-reimport`: **553,501** packets, **2** media tracks,
  `durationDeltaSec=0.021333333333132032 <= 0.1`.
- Throughput median was **1484.911x realtime**; output was **1,144,819,183 bytes**; target writes stayed
  **1** for the buffered final materialization.

## Rejected

- Returning the input bytes or using an input-to-output passthrough.
- Weakening `reference-reimport` or changing the massive fixture workload.
- Applying the larger budget to `StreamTarget` output, where time-to-first-byte and backpressure are part
  of the user-visible behavior.
- Fully progressive non-fragmented buffering for this row; the browser experiment closed the page before a
  stable proof and would have changed the harness path more broadly.
- Hardcoding scenario ids, fixture names, packet counts, byte counts, or benchmark timings into routing.
- Copying competitor source code.
