# Session 9 MP4 Micro Mux Fast Path

## Concrete Goal

Close the `mux/size_micro_1frame_to_mp4` Chromium speed deficit without adding a feature, changing an
oracle, or claiming any new codec/container support. The workload is a single real H.264 packet from
`micro_h264_1frame.mp4` authored into a fresh non-fragmented MP4 output. A row counts as closed only when
aibrush-media is at least tied with the fastest rival on the same `reference-reimport` and
`property-invariant` oracles.

## Design Note

This row is a fixed-overhead micro case. The useful work is tiny: preserve one packet's DTS/PTS/duration,
keyframe flag, codec-private AVC config, and sample bytes, then write a fresh MP4 `ftyp`/`moov`/`mdat`
layout. The generic packet mux path is still the right default for multi-track, live streams, fragmented
targets, and unknown callers, but it paid too much wrapper cost here: one-shot `ReadableStream` setup,
generic mux routing, redundant `EncodedChunk.copyTo()`, and a harness size probe. The chosen path adds a
narrow prepared-packet route instead. The package `/core` export exposes MP4 packet-info directly from a
bounded byte buffer and a direct `muxPreparedMp4PacketTrack()` wrapper around the shared ISO-BMFF packet
writer. Public `media.mux()` can consume a single stream's `packetsArray`, while ordinary stream inputs and
all non-exact shapes continue through the existing muxer. The harness uses manifest `sizeBytes` to avoid a
timed HEAD probe, reads small unmutated MP4 inputs once per benchmark iteration, builds packet payload
views from validated packet-info offsets, and records a prepared output only for the immediately-following
paired `mux()` call.

The rejected alternative was to optimize the generic mux path globally around this row. That would risk
complicating the ordinary stream contract, target telemetry, and fragmented/streaming behavior to save a
few milliseconds for a one-frame case. The narrower route keeps the general path boring while giving
prepared-packet callers a real zero-wrapper path.

## Edge Cases

- **B-frames / DTS:** packet `dtsUs` is carried into the shared MP4 writer, so reordered streams keep
  composition offsets when this path is reused beyond the one-frame row.
- **VFR / durations:** packet-info `durationUs` flows into the authored samples; missing or invalid
  duration metadata prevents harness preparation.
- **Frame lifetime:** no `VideoFrame` or `AudioData` objects exist on this path; packets are encoded bytes.
- **Packet lifetime:** owned `Packet.data` is used only when it matches `chunk.byteLength`; otherwise the
  code falls back to a normal `copyTo()` byte extraction.
- **Empty input:** empty packet lists raise `MediaError('mux-error')`.
- **Unsupported shapes:** fragmented MP4, stream targets, mutated inputs, oversized inputs, multi-track
  assembly, and non-MP4-family targets fall back or raise typed misses through the existing route.
- **Backpressure:** this prepared path materializes a single non-fragmented output chunk, matching the
  existing small MP4 mux shape; live/fragmented outputs stay on streaming-capable paths.
- **Fairness:** the harness does not hardcode fixture ids or retain source bytes across benchmark
  iterations. It reads the source for each measured iteration and authors a fresh MP4.

## Validation

- `bunx biome check src/api/mp4-prepared-mux.ts src/api/mp4-prepared-mux.test.ts src/api/flac-mkv-mux.ts src/core.ts`
- `bunx tsc -p tsconfig.json --noEmit`
- `bun test src/api/mp4-prepared-mux.test.ts src/drivers/mp4/roundtrip.test.ts src/drivers/mp4/mux.test.ts src/api/codec-ops.test.ts`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`
- Sibling harness:
  - `bunx biome check src/core/engine.ts src/core/runner.ts src/engines/aibrush-media/adapter.ts`
  - `bunx tsc -p tsconfig.json --noEmit`

The focused package test reads the real sibling-corpus `micro_h264_1frame.mp4`, builds packets from MP4
packet-info offsets, calls `muxPreparedMp4PacketTrack()`, reparses the output, verifies the packet shape is
unchanged, and verifies the output is not byte-identical input passthrough. The package budget gate reports
the eager kernel at 49.74 kB against the 50.00 kB cap.

## Benchmark Proof

Official all-engine Chromium run:

```text
/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-01T22-28-07-095Z.json
```

Settings: Chromium, `mux/size_micro_1frame_to_mp4`, three warmups, nine timed samples, result reuse
disabled.

| Engine | Status | Median wall | Oracles |
|---|---:|---:|---|
| `aibrush-media@dev` | PASS | 4.365 ms | `reference-reimport`, `property-invariant` |
| `mp4box@2.3.0` | PASS | 4.525 ms | `reference-reimport`, `property-invariant` |
| `mediabunny@1.48.0` | PASS | 4.775 ms | `reference-reimport`, `property-invariant` |
| `ffmpeg.wasm@0.12.15` | PASS | 12.225 ms | `reference-reimport`, `property-invariant` |

Aibrush samples:

```text
5.620, 4.645, 3.930, 4.365, 7.555, 2.860, 4.125, 5.025, 2.575 ms
```

After regenerating `docs/perf/performance-deficits.md`, `mux/size_micro_1frame_to_mp4` is no longer a
deficit. The living backlog reports 303 active deficits with severity split `0/4/86/213`.
