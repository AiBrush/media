# Session 9 — VPx Alpha Packet-Plane Transcode

## Deficit

`transcode/vp9_alpha_to_vp8_keepalpha` was the top active Chromium speed deficit after
`audio-dsp/gain_half_f32` closed. The fresh pre-fix run
`chromium-2026-07-05T12-01-57-888Z.json` showed:

- aibrush-media: PASS, median `1123.805 ms`, samples
  `[1099.275, 1123.805, 1165.110, 1088.430, 1158.460]`
- mediabunny: PASS, median `539.565 ms`, samples
  `[537.670, 546.120, 561.390, 539.565, 537.900]`

Both engines passed the same oracles:

- `alpha-plane`: alpha plane present on `12/12` frames
- `playback-smoke`: browser playback succeeded

## Cause

The general alpha path was correct but wasteful for an unfiltered VPx-alpha transcode. The WebM demuxer
already exposes each packet as color chunk plus optional alpha side chunk, but the old route decoded color
and alpha, merged them into RGBA `VideoFrame`s, then immediately copied and split those RGBA frames back into
color and grayscale alpha frames for two VP8 encoders.

That merged RGBA representation is still required for public alpha decode and for any pixel/timing transform,
but this row only changes the codec from VP9 to VP8 while keeping the alpha plane.

## Change

Add a guarded packet-plane VPx-alpha transcode route:

- eligible only when the source track has `alpha === true`;
- target video requests `alpha:'keep'`;
- no width/height/crop/rotate/flip/colorspace/tonemap/fps transform is present;
- target encoder config is still built and routed normally;
- color and alpha elementary streams are decoded with decoder `alpha:'discard'`;
- both streams are re-encoded with the existing WebCodecs encoder driver;
- encoded color and alpha chunks are paired by timestamp and muxed as WebM/Matroska `BlockAdditions`.

Every unsupported or transformed shape falls back to the existing decoded-frame path.

## Validation

- `bunx biome check src/codecs/webcodecs-video.ts src/codecs/webcodecs-video-alpha.test.ts src/api/codec-pipeline.ts src/api/codec-pipeline.test.ts src/api/engine.ts`
- `bun test src/codecs/webcodecs-video-alpha.test.ts src/api/codec-pipeline.test.ts`
- `bunx tsc -p tsconfig.json --noEmit`
- `bun run build`

The unit tests pin decoder alpha override normalization and the pure eligibility predicate. The live
packet-plane route is validated in the browser harness because it depends on real WebCodecs host objects.

## Proof

After rebuilding `dist` and refreshing the sibling vendored runtime, the fresh proof
`chromium-2026-07-05T12-10-27-354Z.json` closed the row:

- aibrush-media: PASS, median `437.885 ms`, samples
  `[423.890, 445.615, 434.810, 447.700, 437.885]`, throughput `11.419x realtime`, peak memory `0 B`
- mediabunny: PASS, median `539.610 ms`, samples
  `[533.435, 527.220, 541.865, 539.610, 558.290]`, throughput `9.266x realtime`, peak memory `0 B`

Both outputs passed `alpha-plane` on all 12 frames and `playback-smoke`. Regenerating
`docs/perf/performance-deficits.md` with this overlay removes `transcode/vp9_alpha_to_vp8_keepalpha`.
