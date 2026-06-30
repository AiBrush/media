# Session 8 design note — AVI mux

## Goal

Replace the `AviDriver.createMuxer()` typed miss with a genuine RIFF `AVI ` writer for explicit packet-stream
muxing, without changing AVI probe/demux semantics or any Chrome-positive codec paths. The output must be a
normal AVI layout: `RIFF('AVI ')` with `LIST('hdrl')`, `avih`, one `LIST('strl')` per stream (`strh` +
`strf`), `LIST('movi')` packet chunks, and `idx1`; when a `movi` segment grows beyond the OpenDML threshold,
additional payload goes to `RIFF('AVIX')` `movi` segments.

## Edge Cases Considered

- **Stream numbering:** public `mux()` can assemble tracks from arbitrary sources, so source `TrackInfo.id`
  cannot be reused blindly. The muxer allocates fresh 0-based stream numbers and returns them from
  `addTrack()`.
- **Timing:** AVI stores stream scale/rate headers, not per-packet timestamps. Video timing is derived from
  `TrackInfo.fps`, config framerate, or declared duration; PCM audio timing is byte/block exact; compressed
  audio uses packet durations when present or declared track duration as the anchor.
- **Zero-length chunks:** the real MPEG-4/MP3 AVI fixture contains zero-length video chunks. These are legal
  AVI placeholders, so the muxer preserves them instead of treating them as missing data.
- **PCM frame lifetime:** AVI carries packet bytes only, so there are no `VideoFrame`/`AudioData` resources
  to close. `EncodedChunk.copyTo()` is used only in `write()`; the pure `addChunkStruct()` path powers Node
  validation.
- **Backpressure/output:** the muxer is single-shot like MP4/WebM buffer-all muxers: it emits one
  `Uint8Array` on `finalize()`. OpenDML segmentation avoids per-RIFF `movi` overflow, but does not pretend
  to be an incremental streaming writer.
- **Unsupported shapes:** fragmented output, unsupported codecs, missing config, >99 streams, unknown track
  writes, and block-misaligned PCM reject with typed errors before malformed bytes are emitted.

## Decision

Implement `AviMuxer` in `src/drivers/avi/avi-mux.ts`, separate from the parser, and wire
`AviDriver.createMuxer()` to it. The writer maps supported codec tokens to AVI FourCC/WAVEFORMATEX fields,
derives stream headers after packets are buffered, writes an OpenDML `dmlh`, serializes `movi` chunks in
arrival order, writes `idx1` for the primary segment, and emits extra `AVIX` RIFFs when the segment byte
limit is crossed. `codec-routing.ts` includes `avi` in the explicit packet-muxable set so
`media.mux(..., { container:'avi' })` reaches the driver.

## Validation

The test oracle uses committed real AVI payloads only: full MJPEG+PCM, full MPEG-4+MP3, video-only MJPEG,
audio-only PCM, audio-only MP3, and a low-threshold AVIX split. Each output is reparsed with the existing
independent `parseAvi()` reader and every selected packet payload is compared byte-for-byte. The tests also
check `idx1`, public `media.mux()`, zero-length chunks, OpenDML `AVIX`, and typed rejection paths.

## Benchmark

`scripts/bench-containers.ts` now includes `mux (->avi)` over five real-packet cases. Fresh local baseline:
geomean 226.0 MB/s, worst 123.6 MB/s, max peak RSS 0.16 MB.
