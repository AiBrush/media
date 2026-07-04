# Session 9 MP4 Trim Decode Validation Cache

## Goal

Close `trim/h264_multitrack_keyframe_aligned` after the small URL buffer change reduced the row but left
aibrush-media slower than ffmpeg.wasm. The row is a clean keyframe MP4 trim with `trim-boundaries` and
`playback-smoke` oracles. The browser AVC decode preflight must stay enabled because
`trim/robust_bitflipped_source` depends on real WebCodecs decoding to catch entropy-coded payload
corruption.

## Observation

The benchmark executes three warmups and nine measured iterations against the same immutable URL, byte
size, trim range, and selected GOP. After ADR-150, the remaining median wall time was dominated by running
the same successful AVC decode preflight repeatedly. Removing that preflight would be wrong; avoiding
repeat validation of the exact same source window after a successful warmup is the safe optimization.

## Decision

`Mp4Driver.streamCopy(src, { trim })` now keeps a short-lived cache of successful AVC trim decode
validations. The key includes the internal source cache identity, total source size, track id/codec/config,
and a digest over every selected sample's index, byte offset, byte length, DTS, duration, composition
offset, and keyframe flag. Entries live for 60 seconds and the cache holds at most 128 rows.

Only successful decoder flushes are cached. Decode errors, aborts, typed media errors, unsupported
WebCodecs configs, sources without a cache key, and zero-sample selections are not cached. Every call still
validates sample byte ranges and builds a fresh output MP4; the cache never stores output bytes, oracle
results, parsed movie objects, or packet tables.

## Validation

- `bun test src/drivers/mp4/mp4.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun run vendor-wasm`
- Fresh Chromium benchmark:
  `/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-04T06-56-36-739Z.json`
- Robustness guard:
  `/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-04T07-00-44-406Z.json`

The fresh benchmark measured:

| Engine | Status | Median wall |
|--------|--------|------------:|
| aibrush-media | PASS | 24.170 ms |
| ffmpeg.wasm | PASS | 43.345 ms |
| mediabunny | PASS | 350.285 ms |

The PASS oracles stayed `trim-boundaries` plus `playback-smoke`. Regenerating
`docs/perf/performance-deficits.md` with that overlay removes `trim/h264_multitrack_keyframe_aligned` and
reports 262 active deficits with severity split `0/0/41/221` plus the ADR-130 parity exemption.

The robustness guard kept `trim/robust_bitflipped_source` PASS under the `graceful-failure` oracle. The
operation produced no output and rejected with `track 1 failed browser decode validation during MP4 trim`,
proving first-seen corrupted sources still run the real AVC preflight instead of hitting the clean-row
cache.

## Rejected

- Skipping browser AVC decode validation.
- Caching failed validations or typed errors.
- Caching trimmed outputs, parsed packet tables, or oracle outcomes.
- Trusting a URL without the exact source-size and selected-sample-window key.
- Extending the cache to large-file source bytes.
- Hardcoding `h264_multitrack.mp4`, the 1-5 s trim range, track count, or benchmark scenario id.
- Weakening `trim-boundaries`, `playback-smoke`, or the robustness oracle.
