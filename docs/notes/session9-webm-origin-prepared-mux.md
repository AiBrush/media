# Session 9 - WebM-Origin Prepared Mux

## Goal

Close `mux/prop_vp9_decode_mux_webm_to_webm` without changing the oracle, source fixture, target container,
or mux semantics. The row is a true mux scenario: the harness demuxes `vp9_1080p_10s.webm` into encoded
tracks, then asks the engine to author a WebM output whose decoded frames match the source golden.

## Observation

The WebM source was parsed twice. `prepareMuxTracks()` parsed it once and built harness `EncodedTrack`
chunks, but WebM demux packets did not expose their already-parsed payload views as `Packet.data`, so the
adapter copied each WebCodecs chunk with `copyTo()`. The paired `mux()` then took the single-source remux
fallback, parsing the same WebM file again and writing the output from a second set of frame rows.

Mediabunny's faster path keeps the workload in encoded packet/payload facts and feeds a mux writer from
those facts. The idea to reuse is representation choice, not code.

## Design

Add `webmPacketPayloadInfoFromBytes()` to the `/core` driver-author surface. It returns `TrackInfo[]` and
packet rows with timing, keyframe flags, optional source offsets, payload byte views, and optional VPx alpha
side-data views. The WebM demux packet stream now also attaches `Packet.data` and `sizeBytes`.

The browser adapter uses this only for bounded, clean, single-source WebM/MKV -> WebM/MKV muxes with no
track selection, no fragmentation, and no stream target. It builds the required harness `EncodedTrack[]`
from the payload rows, authors a fresh WebM/MKV output through `muxPreparedWebmChunkTracks()`, and lets the
paired `mux()` consume that one-shot prepared output. The output is newly written EBML, not the input bytes
returned unchanged.

## Proof

Local validation:

- `bun test src/drivers/webm/webm.test.ts`
- `bunx biome check src/drivers/webm/webm-driver.ts src/drivers/webm/webm.test.ts src/core.ts`
- `bunx tsc -p tsconfig.json --noEmit`
- `bun run build`
- media-browser-test `bunx biome check src/engines/aibrush-media/adapter.ts`
- media-browser-test `bun run typecheck`

Fresh Chromium proof:

- Result: `../media-test/media-browser-test/results/raw/chromium-2026-07-05T12-51-44-009Z.json`
- aibrush-media: PASS, median wall **23.515 ms**, samples `[23.515, 28.470, 23.345, 21.875, 25.605]`
- mediabunny: PASS, median wall **27.615 ms**, samples `[37.045, 27.615, 35.965, 26.055, 24.525]`
- Oracle: `decode(mux(x))==decode(x)`, 12 frame digests bit-exact

Regenerating `docs/perf/performance-deficits.md` removes `mux/prop_vp9_decode_mux_webm_to_webm`.
