# Session 9 - MP4 Streaming-Target Packet Mux

## Goal

Close `mux/mp4_streaming_target` on Chromium speed without changing the mux contract or oracles. The input is the real `h264_1080p_30s.mp4` fixture, the target is MP4, and the benchmark requests `{ target: 'stream' }`. A done cell must produce a real incrementally-written MP4 whose `reference-reimport` oracle sees the same 2308 packets and 1423 keyframes, whose duration invariant remains within tolerance, and whose fresh n>=5 median wall time is <= the fastest passing rival.

## Approach

The losing path was correct but too generic. It demuxed the MP4 into host packet streams and then muxed through wrapper/drain code, even though MP4 sample tables already expose the exact timing, size, keyframe, and byte-offset facts needed for packet-copy muxing.

The fix keeps the same parser and muxer truth but removes avoidable work:

- Raise the bounded MP4 packet-info offset ceiling from 16 MiB to 64 MiB so the 31.3 MiB source can expose validated payload offsets.
- Return all prepared MP4 tracks from the harness `prepareMuxTracks()` packet-table path, not only a video-only track.
- Add `muxPreparedMp4PacketTracks()` and `muxPreparedMp4PacketTracksStream()` on the advanced `/core` surface.
- Build the streaming output from the shared MP4 layout planner: emit structural boxes, stream packet payload views in bounded chunks, and write the final `moov` for progressive non-faststart output.
- Use the real `StreamTarget` sink so target write telemetry remains honest.

Rejected alternatives were returning the original MP4 bytes, matching mediabunny by doing less than the oracle validates, routing through a rival, or broadening offset parsing to huge/gigabyte public packet-info callers. The 64 MiB cap is a bounded medium-source optimization, not a new whole-file strategy for massive rows.

## Edge Cases

- **B-frames and open GOP:** packet DTS is preserved and MP4 `ctts` is rebuilt from the same timing model as `Mp4Muxer`.
- **VFR:** each packet duration is carried from the sample table; no constant-frame-rate assumption is introduced.
- **Multitrack:** video and audio tracks are both prepared and authored; zero-track or empty-track inputs still reject.
- **Offsets:** every shortcut requires a validated source `offset` plus `size` within the source length.
- **Backpressure:** output is written through the existing `writeToStreamTarget()` path, so sink promises still apply backpressure.
- **Cancellation:** the sink write receives the operation `AbortSignal`; unsupported or aborted writes remain typed failures.
- **Fragmentation and track selection:** explicit fragmentation, selection, malformed inputs, missing offsets, and oversized sources stay on existing generic or typed-miss paths.

## Validation

Focused Node validation:

```bash
bun test src/api/mp4-prepared-mux.test.ts src/drivers/mp4/mux.test.ts src/drivers/mp4/mp4.test.ts
```

Result: 92 pass.

The new regression test loads `h264_1080p_30s.mp4`, verifies two MP4 tracks, verifies 2308 packet rows, and asserts every row has an in-bounds source offset. Existing prepared MP4 tests also prove multi-track authoring and streaming output reparse to the same packet shape.

Type and format checks:

```bash
bun run typecheck
bunx biome check src/api/mp4-prepared-mux.ts src/api/mp4-prepared-mux.test.ts src/drivers/mp4/mux.ts src/drivers/mp4/prepared-stream.ts src/drivers/mp4/mp4-driver.ts src/core.ts
```

The benchmark harness typecheck also passes after the adapter change:

```bash
bun run typecheck
```

from `../media-test/media-browser-test`.

## Benchmark

Fresh Chromium n=5 run:

```bash
bash scripts/run.sh --browser chromium --engine aibrush-media@dev,mediabunny@1.48.0 --scenario mux/mp4_streaming_target --warmup 0 --iters 5 --no-reuse --timeout-ms 600000
```

Raw result:

- `results/raw/chromium-2026-07-04T09-51-25-542Z.json`
- aibrush-media: PASS, wall median **53.370 ms**, samples `[53.370, 56.625, 42.555, 55.375, 44.605]`
- mediabunny: PASS, wall median **59.570 ms**, samples `[59.570, 69.895, 51.510, 65.090, 53.590]`
- aibrush stream shape: `targetWrites=136`, `bytesOut=31,241,860`
- Oracles: `reference-reimport` PASS with 2308 packets / 1423 keyframes; `property-invariant` PASS with `deltaSec=0.021333333333334537 <= 0.041666666666666664`

Local split on the same real fixture after the offset change:

- Read source: about 7.16 ms
- `mp4PacketInfoFromBytes`: about 4.18 ms
- Packet wrapper views: about 1.08 ms
- Stream plan: about 8.03 ms
- Drain 136 chunks: about 6.89 ms
- Total emitted: 31,241,896 bytes

Deficit regeneration:

```bash
node docs/perf/gen-deficits.mjs docs/perf/stored-test-data-chromium-2026-07-01T08-33-45-588Z.json $(find ../media-test/media-browser-test/results/raw -maxdepth 1 -name 'chromium-*.json' -print | sort)
```

Result: `192 active deficits (0/0/10/182), 1 exempt`; `mux/mp4_streaming_target` is removed.
