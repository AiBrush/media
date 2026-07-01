# Session 9 FLAC keyframe trim fast path

## Goal

Close the FLAC copy-trim speed deficits without changing the scenarios, oracle, or public semantics.
The stored Chromium export showed `trim/audio_flac_seektable_copy` at 167.4 ms against `ffmpeg.wasm` at
6.9 ms, and `trim/audio_flac_noseektable_copy` at 157.1 ms against `ffmpeg.wasm` at 10.3 ms. Correctness
was already green, but the public keyframe/copy route reused the accurate FLAC sample-domain path:
decode all samples, slice PCM, re-encode FLAC, and repair STREAMINFO MD5. For a keyframe/copy row, the
same work is to preserve whole native FLAC frames that overlap the requested time span and rewrite the
stream metadata that depends on the selected frame set.

## Edge Cases

- FLAC frame sync bytes can appear inside payload bytes; frame selection must parse and CRC-check headers
  rather than scan only for `0xff`.
- Fixed and variable blocking strategies use different frame/sample numbering, and the trim window must be
  computed in decoded samples.
- SEEKTABLE offsets become stale after trimming, so selected outputs should not copy source seek metadata.
- STREAMINFO total samples, min/max block size, min/max frame size, sample rate, channels, and bits/sample
  must remain internally consistent.
- STREAMINFO MD5 is only preserved for a full-stream selection; partial trims use the legal all-zero
  "unknown MD5" value because recomputing the digest would require PCM decode.
- Negative, empty, inverted, start-past-duration, and end-past-duration ranges remain typed errors.
- `mode:'accurate'` still needs the ADR-096 decode/slice/re-author path for exact sample cuts.
- No `VideoFrame` or `AudioData` objects are created, so frame lifetime and close-once rules are unchanged.

## Decision

Add a native `FlacDriver.streamCopy(src, { trim })` path for same-container FLAC keyframe trims. The driver
reads the source bytes once after routing, parses metadata block layout and STREAMINFO, scans validated
native frame headers, and selects whole frames overlapping `[start,end)`. It then writes a minimal FLAC file:
`fLaC`, a rewritten STREAMINFO block, and the selected source frame byte ranges copied verbatim. Public
`trim()` dispatches FLAC default/keyframe copy trims to this driver path before running the generic duration
probe, while `mode:'accurate'` continues to use FLAC PCM transform.

The implementation is structure-based, not fixture-based. The same code handles seektable and no-seektable
inputs because a SEEKTABLE is only an index; decoded frame layout is derived from frame headers.

## Validation

- `bun test src/drivers/flac/flac.test.ts`
- `bun test src/api/trim-robustness.test.ts src/drivers/flac/flac.test.ts`
- `bunx tsc -p tsconfig.json --noEmit`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`
- focused Chromium aibrush seektable:
  `bash scripts/run.sh --engine aibrush-media@dev --browser chromium --scenario trim/audio_flac_seektable_copy --no-reuse --warmup 3 --iters 9 --timeout-ms 900000`
- focused Chromium ffmpeg seektable:
  `bash scripts/run.sh --engine ffmpeg-wasm --browser chromium --scenario trim/audio_flac_seektable_copy --no-reuse --warmup 3 --iters 9 --timeout-ms 900000`
- focused Chromium aibrush no-seektable:
  `bash scripts/run.sh --engine aibrush-media@dev --browser chromium --scenario trim/audio_flac_noseektable_copy --no-reuse --warmup 3 --iters 9 --timeout-ms 900000`
- focused Chromium ffmpeg no-seektable:
  `bash scripts/run.sh --engine ffmpeg-wasm --browser chromium --scenario trim/audio_flac_noseektable_copy --no-reuse --warmup 3 --iters 9 --timeout-ms 900000`

Root tests assert the public route performs only the routing head read plus one full source read, validates
trim ranges, writes a minimal metadata section, preserves sample rate/channel/bits-per-sample facts,
recomputes STREAMINFO sample and size fields, zeros partial MD5, and copies selected native frame bytes
exactly.

## Benchmark

Fresh Chromium 149 focused runs, `n=9` after three warmups:

| Scenario | Engine | Status | Median wall | Samples |
| --- | --- | --- | ---: | --- |
| `trim/audio_flac_seektable_copy` | aibrush-media | PASS | 6.295 ms | 5.235, 5.255, 9.185, 6.295, 7.065, 4.935, 6.520, 5.920, 6.835 ms |
| `trim/audio_flac_seektable_copy` | ffmpeg.wasm | PASS | 9.155 ms | 7.485, 9.155, 11.280, 8.700, 6.190, 13.235, 12.285, 8.380, 10.310 ms |
| `trim/audio_flac_noseektable_copy` | aibrush-media | PASS | 10.530 ms | 6.915, 12.000, 12.650, 12.260, 9.480, 12.045, 8.025, 10.530, 9.265 ms |
| `trim/audio_flac_noseektable_copy` | ffmpeg.wasm | PASS | 11.175 ms | 13.560, 4.930, 9.840, 11.645, 12.920, 6.915, 9.240, 11.175, 11.835 ms |

Regenerating `docs/perf/performance-deficits.md` with these overlays removes both FLAC copy-trim rows and
reports 311 active deficits overall (`0/14/86/211` by severity).
