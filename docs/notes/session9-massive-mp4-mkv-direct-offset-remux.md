# Session 9 Note - Massive MP4 to MKV Direct Offset Remux

## Goal

Close `remux/massive_h264_1080p_2h_mp4_to_mkv` on Chromium without changing the strict
`reference-reimport` oracle, adding a new feature, raising memory caps, hardcoding the fixture, or caching
outputs across measured iterations.

## Design Note

The large MP4 -> MKV remux loss was not a correctness problem; it was per-packet overhead multiplied by a
very long sample table. The generic streaming WebM path parsed the MP4 sample tables correctly and wrote
bounded Clusters, but it still opened packet streams, constructed host `EncodedChunk` wrappers, and awaited
per-packet async work for **553,501** packets. The public MP4 `packetInfo()` hook could not simply be reused
for the massive file, because that hook intentionally omits source byte offsets above the small
prepared-caller threshold so unrelated packet-info callers do not pay a heavy offset-table cost.

The fix keeps those responsibilities separate. Public `packetInfo()` stays lightweight for huge files, while
the remux path can use the complete packet-info rows exposed by a demuxer that has already parsed the MP4
sample tables for remux. When selected rows carry byte offsets and the source supports `range()`, the
streaming WebM remuxer range-reads bounded coalesced source windows, slices packet payload bytes directly,
orders rows by DTS, and feeds `WebmStreamingMuxer` with packet structs. If offsets or range reads are absent,
the ordinary packet seam remains the fallback.

The WebM writer also removes hot-loop overhead in the common no-alpha `SimpleBlock` path: EBML IDs, size
VINTs, track numbers, timecodes, flags, and payload bytes are written directly into the pre-sized writer
instead of allocating small arrays per packet. The direct packet-info pump starts the streaming muxer once
and only awaits actual range-window loads or Cluster flushes, not one resolved promise per packet.

## Validation

- Focused formatter/lint:
  `bunx biome check src/api/streaming-webm-remux.ts src/api/streaming-webm-remux.test.ts src/drivers/webm/ebml-write.ts src/drivers/webm/ebml-write.test.ts`
- Focused tests:
  `bun test src/api/streaming-webm-remux.test.ts src/drivers/webm/ebml-write.test.ts`
- Build:
  `bun run build`
- Vendor:
  `bun run vendor-wasm`
- Fresh browser benchmark:
  `bash scripts/run.sh --browser chromium --engine aibrush-media@dev,ffmpeg.wasm@0.12.15 --scenario remux/massive_h264_1080p_2h_mp4_to_mkv --warmup 1 --iters 5 --no-reuse --timeout-ms 600000`

## Fresh Browser Result

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-04T08-42-16-312Z.json`

- aibrush-media: PASS `reference-reimport`, median **2529.135 ms**, n=5
- ffmpeg.wasm: PASS `reference-reimport`, median **5082.570 ms**, n=5
- oracle detail: both reimported **553,501** packets across **2** media tracks

Regenerated backlog: `193 active deficits (0/0/11/182), 1 exempt`. The massive MP4 -> MKV remux row is no
longer active.
