# Session 9 Note - Accurate MP4 trim packet-info preroll

## Goal

Close `trim/large_h264_frame_accurate_throughput` without adding a feature, changing the scenario, or
weakening `trim-boundaries` / `playback-smoke`.

The contested row cuts `large_h264_1080p_120s.mp4` from 60 s to 66 s in frame-accurate mode. The stored
deficit showed a 2.6x loss, but a fresh pre-fix n=5 Chromium proof showed the real current gap was smaller:

- `chromium-2026-07-05T00-00-51-411Z.json`
- mediabunny: PASS, **658.985 ms** median, samples
  `[658.985, 666.290, 648.430, 663.155, 640.075]`
- aibrush-media: PASS, **742.650 ms** median, samples
  `[742.650, 727.985, 754.305, 752.385, 742.570]`

## Design

The accurate-trim codec seam was correct but not source-bounded enough for a deep cut:

- video found the safe preroll keyframe by reading the live packet stream from sample zero;
- audio decoded from the stream head and discarded roughly 60 seconds of AAC;
- the default 1080p trim encode target was 27.9936 Mbps, while the source video track is about 5.84 Mbps.

The fix keeps the same public trim semantics and uses MP4 packet-info offsets only as an input planner:

- Plan video packet rows from the last keyframe at or before `start` through the next keyframe at or after
  `end`.
- Read only those validated byte ranges through coalesced `Source.range()` windows.
- Construct real `EncodedVideoChunk`s with original PTS, duration, and key/delta type, then let the decoder
  and `trimTimedFrameStream` do the normal frame-window work.
- Plan audio packet rows overlapping `[start,end)`, read their validated byte ranges, construct real
  `EncodedAudioChunk`s, rebase PTS/DTS to the first kept packet, and mux them directly.
- Strip source `gapless` metadata from packet-copied AAC subclips, because whole-source edit-list facts do
  not describe the partial output.
- Estimate source video bitrate from packet-info rows and encode accurate trims at `min(geometryTarget,
  sourceBitrate * 1.5)`, falling back to the old geometry target when no estimate is available.

The optimized route is guarded by `EncodedVideoChunk`/`EncodedAudioChunk`, `Source.range()`, complete
packet-info offsets, finite timestamps/durations, and a selected track index. If any proof is missing, the
engine uses the previous stream-scanned preroll / decode-audio path.

## Proof

Final Chromium proof:

```sh
bash scripts/run.sh --browser chromium --engine aibrush-media,mediabunny --scenario trim/large_h264_frame_accurate_throughput --warmup 3 --iters 5 --no-reuse --timeout-ms 900000
```

Result: `../media-test/media-browser-test/results/raw/chromium-2026-07-05T00-22-20-233Z.json`

| Engine | Status | Median wall | Samples | Throughput |
|--------|--------|------------:|---------|-----------:|
| aibrush-media | PASS | **580.175 ms** | 580.175, 572.070, 580.855, 570.680, 581.615 | **206.834x** |
| mediabunny | PASS | 653.210 ms | 650.775, 630.100, 654.005, 655.675, 653.210 | 183.708x |

Both engines passed:

- `trim-boundaries`
  - aibrush-media: `outDurationSec=6.016`, `durationDeltaSec=0.016`
  - mediabunny: `outDurationSec=6.08`, `durationDeltaSec=0.08`
- `playback-smoke`

Focused checks:

```sh
bun test src/api/trim-accurate.test.ts
bunx biome check src/api/engine.ts src/api/trim-streams.ts src/api/trim-accurate.test.ts
bunx tsc --noEmit
bun run build
bun run vendor-wasm
bun run check-budgets
```

Budget proof after the change:

- eager kernel: **48.53 kB / 50.00 kB**
- default/probe first-operation closure: **255.22 kB / 256.00 kB**

Regenerating the backlog with the final overlay removes `trim/large_h264_frame_accurate_throughput` and
leaves **168** active deficits plus **1** ADR-backed parity exemption.

## Rejected

- Returning original source bytes for a partial trim.
- Routing by scenario id, filename, trim window, byte count, timing, or oracle result.
- Copying mediabunny implementation code.
- Weakening `trim-boundaries` or `playback-smoke`.
- Caching completed outputs, decoded frames, packet rows, or oracle facts.
- Trusting packet-info rows that lack finite offsets, sizes, PTS/DTS, or durations.
- Preserving whole-source AAC gapless metadata on a packet-copied subclip.
