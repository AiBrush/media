# Session 9 MP4 Faststart Metadata Prefetch

## Goal

Close the Chromium `metadata/read_h264_1080p_30s` and related `probe/h264_1080p_30s` speed losses without
changing the `golden-metadata` oracle, packet semantics, or MP4 payload handling.

## Observation

After the full-range trim parity exemption, the regenerated deficit list promoted `metadata/read_h264_1080p_30s`
to the top active row. A fresh pre-fix run, `chromium-2026-07-02T09-50-23-501Z.json`, measured
aibrush-media at 7.275 ms median while mediabunny passed the same oracle at 3.920 ms.

The fixture is a faststart MP4:

- `ftyp` at offset 0, size 32
- `moov` at offset 32, size 27273
- `free` at offset 27305, size 8
- `mdat` at offset 27313, size 31231477

The old faststart metadata path read 64 bytes to discover the top-level boxes, then issued a second exact range
read for `moov`. On small metadata-only workloads that extra round trip was visible in the wall-time median even
though the implementation avoided scanning `mdat`.

## Design

Use a bounded 32 KiB first read for the MP4 metadata fast path. When a complete top-level `moov` box is inside
that prefix, parse the in-memory slice directly. When the `moov` starts in the prefix but extends past it, fall
back to the exact `moov` range read. When no `moov` is visible in the prefix, fall through to the existing
metadata scanner.

The optimization is deliberately limited to metadata and probe work. Packet iteration, demuxing, remuxing, and
trim payload reads still use their existing sparse reads and table-driven byte ranges.

## Validation

- `bun test src/drivers/mp4/mp4.test.ts` passed.
- `bun run build` passed.
- Fresh Chromium run `chromium-2026-07-02T09-54-53-147Z.json`: `metadata/read_h264_1080p_30s` passed with
  aibrush-media at 2.800 ms median, ahead of mediabunny at 7.285 ms.
- Fresh Chromium run `chromium-2026-07-02T09-57-50-258Z.json`: `probe/h264_1080p_30s` passed with
  aibrush-media at 3.190 ms median, ahead of mediabunny at 3.995 ms.
- Regenerated `docs/perf/performance-deficits.md` and `docs/perf/_deficit-data.json`: 295 active losses,
  296 raw losses, 1 ADR-backed exemption.
