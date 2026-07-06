# Session 9 Note - Large MP4 prepared offset mux

## Problem

`mux/size_large_1080p_to_mp4` was the top active backlog row after `mux/h264_aac_to_ts` closed. The fresh
baseline `chromium-2026-07-05T10-18-21-130Z.json` measured aibrush-media at **605.625 ms** median and
mediabunny at **233.885 ms** median on the same passing workload.

The source is `large_h264_1080p_120s.mp4`, **89,573,913 B**. The prepared MP4 mux path was already correct,
but the benchmark adapter refused to prepare sources over 64 MiB and the default MP4 packet-info path also
omitted packet byte offsets above 64 MiB. That kept the row on the generic packet-stream mux path even
though same-source MP4 -> MP4 only needs sample-table timing plus packet payload views.

## Design

`mp4PacketInfoFromBytes(bytes, { includeOffsets: true, signal })` is now an explicit byte-owned offset
mode. The default byte helper still uses the driver `packetInfo()` cap, so ordinary callers do not
accidentally opt into large payload offset materialization. The explicit mode parses the already-owned
buffer with `readMovie()` and returns `mp4PacketInfoTable(movie, bytes.byteLength)`.

The browser harness adapter opts into `includeOffsets: true` only after it has loaded a bounded MP4 source
for prepared MP4-origin mux routes, and the preparation cap is now 128 MiB. The one-shot prepared output is
stored only between `prepareMuxTracks()` and the immediately following `mux()` call, then cleared.

## Edge Cases

- B-frames: preserve DTS/PTS from MP4 sample tables.
- VFR: preserve packet durations from `stts`.
- Large sources: explicit byte ownership is required; URL packet-info remains payload-free by default.
- Abort: both default and explicit byte packet-info modes honor `AbortSignal`.
- Invalid offsets: packet conversion still requires finite in-bounds offsets and sizes before preparing.
- Fragmented, selected-track, stream-target, or unsupported-container shapes: stay on existing fallback or
  typed miss paths.

## Validation

- `bun test src/api/mp4-prepared-mux.test.ts`
- `bunx biome check src/api/mp4-prepared-mux.ts src/api/mp4-prepared-mux.test.ts src/drivers/mp4/mp4-driver.ts`
- `bun run typecheck`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`
- Browser harness typecheck in `../media-test/media-browser-test`
- Fresh Chromium proof:
  `bash scripts/run.sh --browser chromium --engine aibrush-media,mediabunny --scenario mux/size_large_1080p_to_mp4 --warmup 3 --iters 5 --no-reuse --timeout-ms 900000`

Fresh proof `chromium-2026-07-05T10-27-46-344Z.json` closed the row: aibrush-media **PASS** at
**149.975 ms** median over `[157.995, 149.975, 222.405, 137.760, 141.775]`; mediabunny **PASS** at
**263.725 ms** median over `[254.310, 268.285, 268.330, 261.145, 263.725]`. Both outputs reparsed as
**9226 packets / 5686 keyframes** and preserved `deltaSec=0.021333333333330984` under the `0.125`
tolerance. Regenerating the backlog removed the row and reduced active deficits from **164** to **163**.

Peak memory is intentionally higher on this route because the caller owns the 90 MB source bytes:
aibrush-media reported **386,845,048 B** median peak memory versus mediabunny **117,616,226 B**. The speed
win is honest because throughput and memory are still reported, and the default packet-info path remains
payload-free unless a caller explicitly owns bytes.

## Rejected

- Raising the global MP4 packet-info offset cap.
- Fetching whole large URL sources from packet-info by default.
- Returning input bytes unchanged.
- Hardcoding fixture names, byte counts, scenario ids, or oracle facts.
- Copying mediabunny implementation code.
- Weakening the reimport or duration oracle.
- Caching prepared output beyond the single prepare/mux pair.
