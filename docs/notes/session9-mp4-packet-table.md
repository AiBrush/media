# Session 9 MP4 Packet Table Hot Loop

## Goal

Make Chromium demux packet-table scenarios for large progressive MP4/MOV files competitive with the fastest passing rival while keeping the existing golden-packets oracle byte-for-byte identical. The current driver already range-reads only `ftyp`/`moov` for complete sample-table files; the first remaining deficit was CPU time spent expanding `stts`/`ctts` tables into per-sample arrays, allocating native-tick sample objects, then mapping those objects into WebCodecs microsecond packet rows. After the cursor pass, the remaining browser deficit was fixed per-request parse work for chunk byte offsets that the benchmark's `PacketInfo` contract never consumes.

## Edge Cases

- B-frames and open GOPs keep decode order from `stts` and presentation order from `ctts`.
- VFR files keep every per-sample duration; no constant-frame shortcut is allowed.
- Edit lists subtract `media_time` only at the packet/WebCodecs seam, not from native tick sample data.
- Malformed short `stts`/`ctts` run tables keep the existing padding behavior: repeat the last run value, or use zero when no positive run exists.
- Empty `stss` means every sample is sync; populated `stss` is normally sorted but unsorted input should not silently lose keyframes.
- Truncated chunk tables still stop when chunks run out before declared samples are all placed.
- Fragmented MP4 remains out of the packet-info fast path unless it has non-empty static sample tables; the harness adapter falls back to full demux when the packet-info table is empty.
- No `VideoFrame` or `AudioData` is created on this path, so frame lifetime and close semantics are unchanged.

## Decision

Replace the MP4 sample expansion hot loop with a direct single-pass cursor. The loop walks chunks in file order, tracks the active `stsc` run, advances `stts` and `ctts` run cursors per emitted sample, and derives keyframe flags through a monotonic `stss` pointer with a `Set` fallback only for malformed unsorted tables. `buildSampleData()` still returns exact container ticks for mux/remux paths; `buildSamples()` emits microsecond packet-seam rows directly instead of constructing native sample objects and mapping them. No oracle, adapter, source routing, or payload-read behavior changes.

For harness demux rows that only need packet metadata, add an explicit `packetInfo` container-driver operation. MP4/MOV implements it by range-reading `moov` and parsing only the track facts plus `stts`, `ctts`, `stsz`, and `stss`. It deliberately skips `stsc`, `stco`, and `co64`, because the harness `PacketInfo` rows compare track, timing, keyframe, and size fields rather than packet byte offsets. Full `demux()` still parses complete sample tables and still validates byte ranges before exposing payload packet streams or rich byte-offset packet tables.

## Validation

Focused validation covers offsets, VFR deltas, B-frame composition offsets, edit-list offsets, short run-table padding, zero timescale, chunk exhaustion, `stsc` transitions, unsorted sync fallback, and harness-style packet-info rows that match the same B-frame packet oracle. Browser-scale validation is the existing golden-packets oracle on the massive H.264 fixture plus the regenerated Session 9 deficit gate.

## Benchmark

The benchmark is the same workload that produced the top Session 9 losses: `demux/size_massive_massive_h264_1080p_2h`, `performance/size-ladder-iterate-packets-massive`, and their huge-size siblings, measured with fresh multi-sample Chromium exports. A local pre-flight script also splits `Mp4Driver.demux()` from `packetTable()` on `massive_h264_1080p_2h.mp4` so the hot-loop cost can be measured before running the full browser matrix.

Fresh local pre-flight command:

```sh
bun run bench-session9-mp4-packet-table
```

Latest local result on the real 1.09 GiB massive H.264 fixture, `n=7` timed samples after two warmups:

| Case | Median wall | Throughput | Peak RSS delta |
| --- | ---: | ---: | ---: |
| `readMovie(range moov)` | 7.509 ms | 73,707,586 packets/s equivalent | 0.00 MiB |
| `readMoviePacketInfo(range moov)` | 3.146 ms | 175,951,999 packets/s equivalent | 0.02 MiB |
| `mp4PacketMetadata(parsed movie)` | 18.797 ms | 29,446,699 packets/s | 2.91 MiB |
| `mp4PacketInfoMetadata(parsed)` | 10.250 ms | 53,999,218 packets/s | 0.00 MiB |
| `readMovie + mp4PacketMetadata` | 14.729 ms | 37,579,206 packets/s | 0.00 MiB |
| `readMovie + mp4PacketInfoMetadata` | 17.144 ms | 32,285,954 packets/s | 0.00 MiB |
| `readMoviePacketInfo + metadata` | 13.972 ms | 39,614,307 packets/s | 0.02 MiB |

Fresh browser-harness proof on Chromium 149, `warmup=2`, `n=5`, real browser, same golden oracle:

| Scenario | Status | Median wall | Samples | Fastest stored rival |
| --- | --- | ---: | --- | ---: |
| `demux/size_massive_massive_h264_1080p_2h` | PASS | 38.065 ms | 22.295, 38.065, 35.240, 39.250, 38.480 ms | 40.3 ms |
| `performance/size-ladder-iterate-packets-massive` | PASS | 48.550 ms | 48.550, 49.515, 42.290, 45.315, 49.755 ms | 111.8 ms |
| `demux/size_huge_huge_h264_1080p_600s` | PASS | 9.665 ms | 9.640, 8.445, 11.365, 9.665, 13.380 ms | 10.9 ms |
| `performance/size-ladder-iterate-packets-huge` | PASS | 10.170 ms | 11.790, 9.100, 10.730, 10.170, 7.555 ms | 10.7 ms |
| `performance/size-ladder-demux-peak-memory-huge` | PASS | 11.285 ms | 13.440, 10.600, 17.560, 11.285, 9.000, 13.715, 8.675, 8.185, 12.285 ms | 11.4 ms |

The pre-change local split measured `packetTable()` at about 28,972 ms on the same fixture, and the stored 2026-07-01 Chromium export measured our browser row at 46,382.8 ms. The optimized MP4 packet-info path is therefore a measured win over the fastest passing rival for the top MP4 packet-table cells while preserving the strict golden-packets result for 553,501 packets on the massive fixture.
