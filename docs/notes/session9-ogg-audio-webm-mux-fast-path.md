# Session 9 Note — Ogg Audio to WebM Prepared Mux Fast Path

## Goal

Close `mux/opus_to_webm_audio` on Chromium without changing the property oracle, adding a fixture shortcut,
or caching work across measured iterations.

## Design Note

The loss was fixed overhead, not a missing muxer. aibrush-media already authored a correct WebM and passed
the same `property-invariant` oracle as mediabunny and ffmpeg.wasm, but the measured mux operation entered
public Ogg demux, constructed browser `EncodedAudioChunk` objects, copied those chunks back into harness
packet payloads, then went through public `engine.mux()` dispatch/materialization for a bounded
single-audio packet copy. The SOTA route is to keep the exact same bytes and timing while removing those
wrappers: expose the package's pure Ogg de-lacer as `oggPacketInfoFromBytes(bytes)`, build the harness
track from validated packet offsets, then call the shared `writeWebm()` serializer through
`muxPreparedWebmAudioPacketTrack()`. The adapter path is bounded, consume-once, and guarded to clean
single-input Ogg audio -> WebM/MKV non-stream outputs; malformed, unknown-size, oversized, stream-target,
and unsupported cases fall back to the existing engine paths.

## Validation

- Package formatter: `bunx biome check src/drivers/ogg/ogg-driver.ts src/drivers/ogg/ogg.test.ts src/api/flac-mkv-mux.ts src/api/codec-ops.test.ts src/core.ts`
- Package focused tests: `bun run test -- src/drivers/ogg/ogg.test.ts src/api/codec-ops.test.ts src/drivers/webm/ebml-write.test.ts`
- Package typecheck: `bun run typecheck`
- Package build and budgets: `bun run build`, `bun run vendor-wasm`, `bun run check-budgets`
- Harness adapter checks: `bunx biome check src/engines/aibrush-media/adapter.ts`, `bunx tsc -p tsconfig.json --noEmit`

## Fresh Browser Result

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-01T23-24-54-554Z.json`

`mux/opus_to_webm_audio`:

- aibrush-media: PASS `property-invariant`, median **5.765 ms**, n=9
- mediabunny: PASS `property-invariant`, median **7.540 ms**, n=9
- ffmpeg.wasm: PASS `property-invariant`, median **15.805 ms**, n=9

Regenerated backlog: `299 active deficits (0/0/86/213), 0 exempt`.
