# Session 9 FLAC-to-MKV Mux Fast Path

## Concrete Goal

Close the `mux/flac_to_mkv_audio` Chromium speed deficit without adding a feature, changing an oracle, or
claiming support beyond the existing public packet mux contract. The row starts after the browser harness
has prepared a real encoded FLAC audio track from the source fixture, so the timed package work is to author
Matroska around caller-supplied FLAC packets faster than the fastest fresh rival while preserving the same
compressed frames and metadata.

## Design Note

The narrow SOTA move is to remove fixed overhead that is irrelevant once the caller has already supplied a
single native-FLAC audio packet stream. The generic public `mux()` path must handle multi-track assembly,
slot validation, codec/container legality, WebM versus Matroska, fragmented output, B-frame DTS ordering,
and arbitrary muxers. This row needs only one non-fragmented Matroska audio track with monotonic FLAC frame
packets and FLAC setup metadata. `muxFlacMkv()` therefore detects exactly that shape, drains the caller
stream once, copies each `EncodedChunk` into an owned `ChunkStruct`, preserves `CodecPrivate` from the track
config, and calls the shared `writeWebm()` serializer directly with one `A_FLAC` track. It avoids the
generic packet-mux drain and `WebmMuxer` class lifecycle while keeping the same EBML writer and typed error
surface.

## Edge Cases

- **Not the exact row:** any video stream, multiple tracks, non-FLAC codec, WebM target, or fragmented MKV
  returns `undefined` to the existing generic mux route.
- **Frame lifetime:** the helper never retains live WebCodecs objects; it owns one byte copy per chunk after
  `copyTo()`.
- **Abort:** the helper checks `AbortSignal` before each read and raises `MediaError('aborted')`.
- **Empty input:** a zero-packet stream raises `MediaError('mux-error')` instead of authoring an empty file.
- **CodecPrivate:** FLAC metadata bytes remain in the Matroska `CodecPrivate` field, and the parser exposes
  them again as the decoded track description.
- **Backpressure:** the path materializes one final output chunk, matching the existing non-fragmented
  `WebmMuxer` shape; streaming and fragmented targets stay on the generic/live writer paths.

## Validation

- `bun test src/api/codec-ops.test.ts`
- `bunx tsc -p tsconfig.json --noEmit`
- `bunx biome check src/api/flac-mkv-mux.ts src/api/engine.ts src/api/codec-ops.test.ts src/drivers/webm/webm-driver.ts`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`

The focused API test demuxes the real `sfx.flac` fixture, calls public `media().mux()` with a FLAC packet
stream, reparses the output as Matroska, and asserts the FLAC track plus codec-private metadata survive.
The budget check reports the eager kernel at 49.66 kB against the 50.00 kB cap.

## Benchmark Status

Local package sanity check, measured after three warmups over a prepared real `sfx.flac` packet stream,
reported 15 samples with median 0.199 ms for public `mux()` plus Blob materialization. That result is only
a package-level signal, not the official Session 9 speed gate.

The official Chromium n>=5 harness run is blocked until the fresh package `dist/` can be copied into:

```text
/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/src/engines/aibrush-media/vendor/
```

The attempted copy was rejected by the approval system because the usage limit had been reached. The row is
not closed in `docs/perf/performance-deficits.md` until the harness loads the new lazy helper, runs the
focused cell, and `docs/perf/gen-deficits.mjs` is regenerated from that export.
