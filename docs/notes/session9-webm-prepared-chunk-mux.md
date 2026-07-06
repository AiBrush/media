# Session 9 - WebM/MKV Prepared Chunk Mux

## Goal

Close `mux/edge_bframes_decode_mux_mkv` without changing the oracle, codecs, timestamps, or container
legality. The fresh baseline was already using MP4 packet-info offsets and the first-party EBML writer, but
still lost narrowly to mediabunny on fixed overhead.

## Observation

The MP4-origin MKV path had the correct data: source byte slices, PTS, DTS, duration, keyframe flag, and
track codec-private config. It converted those facts into `AibrushPacket` wrappers with WebCodecs-shaped
`chunk.copyTo()` closures only so the core helper could immediately convert them back into WebM chunk
structs for `writeWebm()`. On a small B-frame fixture, that facade layer was a meaningful fraction of the
measured wall time.

## Design

Add `muxPreparedWebmChunkTracks()` to `@aibrush/media/core` for callers that already own complete prepared
chunk rows:

- `timestampUs` is the WebM `SimpleBlock` presentation timestamp.
- `dtsUs` preserves Matroska decode/storage order for B-frame sources.
- `durationUs`, `key`, `data`, and optional `alpha` carry the same facts the existing packet path used.
- Payload bytes are borrowed as `Uint8Array` views and are not copied by the helper.
- The helper still validates the WebM/MKV target, non-empty tracks, finite timing, and non-empty payloads.

The browser benchmark adapter uses this only for bounded MP4-origin WebM/MKV prepared outputs after
`mp4PacketInfoFromBytes(bytes, { includeOffsets: true })` has proven in-bounds packet byte offsets. Public
packet-array callers, fragmented/live output, stream targets, and generic mux remain on their established
routes.

## Proof

Local validation:

- `bun test src/api/codec-ops.test.ts`
- `bunx biome check src/api/flac-mkv-mux.ts src/api/codec-ops.test.ts src/core.ts`
- `bun run typecheck`
- `bun run build`
- media-browser-test `bun run typecheck`

Fresh Chromium proof:

- Result: `../media-test/media-browser-test/results/raw/chromium-2026-07-05T10-47-31-592Z.json`
- aibrush-media: PASS, median wall **27.075 ms**, samples `[31.425, 26.460, 27.075, 21.715, 31.745]`
- mediabunny: PASS, median wall **27.515 ms**, samples `[48.800, 27.515, 23.215, 29.300, 22.210]`
- Oracle: `decode(remux(x))==decode(x)`, 12 frame digests bit-exact

Regenerating `docs/perf/performance-deficits.md` removed `mux/edge_bframes_decode_mux_mkv`; active deficits
fell from **163** to **162**.
