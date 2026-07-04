# Session 9 MP4 small URL trim buffer

## Goal

Reduce the current top Session 9 speed loss, `trim/h264_multitrack_keyframe_aligned`, without changing the
trim oracle, public semantics, or browser AVC corruption validation. The stored backlog has aibrush-media
at 123.3 ms and ffmpeg.wasm at 27.8 ms on the same PASS workload. The input is a known-size 4.5 MB
faststart MP4 with one H.264 video track and two AAC tracks, trimmed from 1 s to 5 s in keyframe mode.

## Constraints

- MP4 keyframe trim must remain a fresh byte rewrite, not an input passthrough.
- The browser AVC decode preflight stays enabled where WebCodecs supports the source config, preserving
  `trim/robust_bitflipped_source`.
- Large, huge, and massive MP4 trims must keep ADR-114 bounded selected-source-window behavior.
- The optimization must be based on source shape and size, never on scenario id, filename, track count, or
  oracle result.

## Decision

For `Mp4Driver.streamCopy(src, { trim })`, URL and media-element sources with a known size at or below
8 MiB now build their random-access reader from one full-source range read. `readMovie()`, optional browser
AVC validation, and final selected-payload copy then read from that in-memory buffer by `subarray()`.

Sources above 8 MiB, sources without known size, and non-URL/non-element range sources continue through
the existing sparse random-access layer. This keeps the large-file proof intact while avoiding repeated
HTTP range overhead on small clean trim rows.

## Validation

- `bun test src/drivers/mp4/roundtrip.test.ts`
- `bun run typecheck`
- `bunx biome check src/drivers/mp4/mp4-driver.ts src/drivers/mp4/roundtrip.test.ts`

Focused coverage now includes:

- production `buffered:true` selected-range trim still reads only metadata plus selected sample windows for
  a generic range source;
- small URL-like keyframe trim performs exactly one full-source read and emits a real trimmed MP4 that
  reparses with fewer samples than the source.

## Browser Status

Fresh Chromium timing after this bounded-buffer change, before the follow-up validation-cache change,
measured aibrush-media at 75.010 ms median over nine samples after three warmups:

`/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-04T06-45-10-014Z.json`

That was a large improvement from the stored 123.3 ms row, but it was still slower than ffmpeg.wasm at
33.915 ms on the same PASS workload. The remaining repeated WebCodecs AVC validation overhead is closed
by ADR-151, not by this buffer change alone.

## Rejected

- Skipping AVC decode validation to win clean rows.
- Applying one-read materialization to large or unknown-size MP4s.
- Hardcoding `h264_multitrack.mp4`, the trim range, or expected packet counts.
- Returning original input bytes for a partial trim.
- Weakening `trim-boundaries` or `playback-smoke`.
- Caching trimmed outputs.
