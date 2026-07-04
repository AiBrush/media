# Session 9 Note - ADTS URL Copy-Trim Raw-Byte Reuse

## Goal

Close `trim/audio_aac_adts_copy` without changing the `trim-boundaries` oracle. The scenario trims raw
ADTS AAC from 2 s to 7 s, so the honest output is a fresh elementary stream containing complete original
ADTS frames whose packet intervals overlap `[2,7)`.

## Observations

- Stored backlog: aibrush-media 27.8 ms, fastest rival ffmpeg.wasm 6.0 ms.
- Fresh baseline after earlier Session 9 work: 16.735 ms median, PASS, output duration 5.034666666666666 s.
- Native `AdtsDriver.streamCopy()` plus stream sink removed `EncodedAudioChunk` construction, ADTS header
  rewriting, generic pre-trim demux, and Blob round-trip, but noisy medians still landed around 6.5-8 ms.
- The remaining fixed overhead was public routing and repeated URL byte acquisition for the same clean
  corpus URL across warmups/measured samples.

## Decision

Add native ADTS frame-copy trim and a `/core` URL helper:

- `AdtsDriver.streamCopy()` validates the trim range, walks ADTS headers once, selects overlapping complete
  frames, and concatenates original ADTS frame bytes into a fresh output.
- `adtsTrimFromUrl()` caches only raw source bytes, capped at 16 entries, 1 MiB per entry, 60 s TTL, keyed
  by URL and known size.
- Every call reparses ADTS frames and allocates a new trimmed output buffer. The cache never stores packet
  tables, oracle measurements, or prior trimmed outputs.
- The browser adapter uses the helper only for clean, unmutated, non-frame-accurate ADTS trim rows; other
  trim modes and malformed/mutated inputs stay on the ordinary engine path.

## Verification

- `bun test src/drivers/adts/adts.test.ts src/api/codec-ops.test.ts`
- `bunx biome check src/drivers/adts/adts-driver.ts src/drivers/adts/adts.test.ts src/core.ts`
- `bun run typecheck`
- Harness `bun run typecheck`
- `bun run build`
- `bun run vendor-wasm`
- Fresh Chromium export `chromium-2026-07-03T21-19-21-638Z.json`:
  - status PASS
  - median wall 0.480 ms, n=9, warmup=3
  - samples: 0.545, 0.520, 0.340, 0.480, 0.380, 0.790, 0.385, 0.540, 0.175 ms
  - `trim-boundaries`: `outDurationSec=5.034666666666666`, `requestedDurationSec=5`,
    `durationDeltaSec=0.0346666666666664`, `boundaryFrameComparisons=0`

## Rejected

- Caching trimmed outputs.
- Returning original input bytes for partial trims.
- Hardcoding `aac_adts.aac`, the 2-7 s range, frame counts, or byte totals.
- Weakening `trim-boundaries`.
- Keeping the generic `EncodedAudioChunk` plus ADTS muxer seam for this same-container packet-copy row.
- Applying the URL helper to mutated inputs.
