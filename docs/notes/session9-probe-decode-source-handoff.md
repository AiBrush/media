# Session 9 Probe/Decode Source Handoff

## Goal

Close `decode-seek/decode_tiny_dims_2x2_h264`, a tiny MP4 decode row where correctness was already green
but fixed overhead dominated the useful decode work.

## Diagnosis

The fresh pre-fix Chromium run `chromium-2026-07-02T10-09-04-834Z.json` measured aibrush-media at
24.080 ms median while platform passed the same decode oracle at 6.715 ms. The tiny 2x2 H.264 fixture
made repeated setup costs visible: image sniffing still ran even for definite video sources, leading
source ranges were fetched more than once, and a small MP4 parsed for probe-style metadata was parsed
again for the immediately following decode/demux path.

## Design

The fix keeps decode lazy and keeps all frame ownership rules unchanged. `fromURL()` now preserves
explicit MIME hints, and `decode()` skips the image route only for definite `video/*` or `audio/*`
sources. The engine source prefix cache now stores covered zero-prefix ranges and can hand a prefix from
an immediate `probe()` to the next `decode()` for the same internal URL source key. The MP4 driver adds a
bounded small-source parsed-movie handoff: cache-keyed sources at or below 1 MiB can transfer one parsed
movie from `probe()` to an immediate `demux()`, with a 250 ms TTL and consume-on-read semantics.

No filename, scenario id, or oracle shortcut is involved. If the source key is absent, expired, too large,
or consumed, the normal strict parser and range-read path runs.

## Validation

- `bun test src/drivers/mp4/mp4.test.ts src/api/create-media.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun run format:check`
- `bun run build`
- Fresh browser gate:
  `chromium-2026-07-02T10-31-33-813Z.json`

Fresh result: aibrush-media **7.065 ms** median, faster than mediabunny **7.505 ms**, platform
**8.365 ms**, ffmpeg.wasm **9.265 ms**, remotion-webcodecs **10.040 ms**, and web-demuxer **15.650 ms**.

## Rejections

Rejected global parse caches, cross-iteration benchmark caching, skipping image sniffing for unknown
inputs, hardcoding the 2x2 fixture, large-source parsed movie handoff, frame lifetime changes, and oracle
weakening.
