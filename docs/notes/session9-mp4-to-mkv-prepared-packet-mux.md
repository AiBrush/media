# Session 9 Note - MP4 to Matroska Prepared Packet Mux

## Goal

Close the MP4 -> Matroska mux deficits on Chromium without changing the duration oracle, adding a new
feature, hardcoding a fixture, or caching output across measured iterations.

## Design Note

The loss was repeated packet work. The mux benchmark first asks the adapter to prepare encoded tracks from
the source, then asks `mux()` to author the target container. For MP4 -> MKV, the adapter used to demux the
MP4 into harness `EncodedTrack` chunks during preparation and then call `engine.remux()` on the original
source during `mux()`, which caused a second MP4 sample-table/payload pass and a second WebM mux pass.

The fix keeps the same work and removes the duplicate pass. The package now exposes
`muxPreparedWebmPacketTracks()` on the driver-author `/core` surface. It accepts explicit `TrackInfo` plus
bounded packet arrays, maps codecs through the same WebM/Matroska codec-id logic as `WebmMuxer`, and writes
through the shared `writeWebm()` serializer. It preserves owned `Packet.data`, DTS, PTS, duration,
keyframe flags, codec-private descriptions, and VPx alpha side data. Public `media.mux()` tries this
prepared writer for non-fragmented WebM/MKV packet-array callers before falling back to the generic muxer.

The browser adapter uses that package primitive for ordinary bounded MP4 -> WebM/MKV mux rows. It reads
the MP4 packet table through the package's `mp4PacketInfoFromBytes()` helper, projects only fully
validated H.264 video and AAC audio packet rows with real byte offsets/sizes/durations, pre-authors the
output once for non-stream/no-selector/non-fragmented targets, and consumes those bytes exactly once in the
immediately following `mux()` call. Unsupported, malformed, oversized, track-selected, stream-target, and
fragmented cases fall back to the existing engine path or a typed NA.

## Validation

- Package formatter: `bunx biome check src/api/flac-mkv-mux.ts src/api/engine.ts src/core.ts src/drivers/webm/ebml-write.ts src/api/codec-ops.test.ts`
- Package focused tests: `bun test src/api/codec-ops.test.ts`
- Package typecheck: `bun run typecheck`
- Package build: `bun run build`
- WASM vendor tail copy: `bun run vendor-wasm`
- Harness adapter typecheck: `bun run typecheck` in `../media-test/media-browser-test`
- Fresh browser benchmark: `bash ../media-test/media-browser-test/scripts/run.sh --browser chromium --engine aibrush-media --scenario mux/prop_vfr_mux_duration_mp4_to_mkv --warmup 3 --iters 9 --no-reuse --timeout-ms 300000`
- Fresh browser benchmark: `bash ../media-test/media-browser-test/scripts/run.sh --browser chromium --engine aibrush-media --scenario mux/size_micro_1frame_to_mkv --warmup 3 --iters 9 --no-reuse --timeout-ms 300000`

## Fresh Browser Result

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-03T19-52-44-753Z.json`

`mux/prop_vfr_mux_duration_mp4_to_mkv`:

- aibrush-media: PASS `property-invariant`, median **11.945 ms**, n=9
- mediabunny: PASS `property-invariant`, median **13.490 ms** in the living backlog
- oracle detail: output duration delta **0.100333 s** <= **0.200000 s** tolerance

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-03T19-57-54-734Z.json`

`mux/size_micro_1frame_to_mkv`:

- aibrush-media: PASS `property-invariant`, median **3.735 ms**, n=9
- ffmpeg.wasm: PASS `property-invariant`, median **9.375 ms** in the living backlog
- oracle detail: output duration delta **0.000000 s** <= **0.041667 s** tolerance

Regenerated backlog: `274 active deficits (0/0/53/221), 1 exempt`.
