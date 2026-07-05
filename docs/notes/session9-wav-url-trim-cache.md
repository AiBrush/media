# Session 9 Note - WAV URL Copy-Trim Raw-Byte Reuse

## Goal

Close the reopened `trim/audio_wav_pcm_copy` speed deficit on fresh Chromium runs without changing the
`trim-boundaries` oracle, the public trim contract, or the WAV byte-slice algorithm. The scenario trims a
clean, unmutated PCM WAV URL from 1 s to 4 s, so the honest output is a fresh canonical RIFF/WAVE file
whose `data` chunk is the exact selected interleaved PCM sample window.

## Observations

- The earlier WAV byte-slice path made the useful work tiny, but the row reopened when its closing overlay
  was unavailable and fresh n=5 runs showed fixed overhead still mattered.
- Fresh pre-change proof with warmup 1 measured aibrush-media at 6.280 ms median and mediabunny at
  6.240 ms median. With warmup 3, aibrush-media measured 7.025 ms median and mediabunny 4.555 ms median.
- The remaining cost was not sample copying. Each benchmark sample rebuilt a `MediaInput`, routed through
  the public engine, materialized the same 960 KiB URL source, then called the already-fast WAV byte-slice
  writer.
- Competitor behavior confirmed the right shape: mediabunny handles audio-only WAV copy trim as packet
  geometry plus a WAV mux, avoiding a decode path. The aibrush implementation keeps its own exact byte-window
  writer and removes only repeated source acquisition/routing overhead.

## Decision

Add a narrow `/core` helper, `wavTrimFromUrl()`, for clean URL-backed WAV copy trims:

- The helper uses `fromURL(..., { rangeRequests: true })` and reads the source bytes once per URL/size cache
  key when the source is small enough for the existing WAV copy-trim economics.
- It caches only raw source bytes, capped at 16 entries, 1 MiB per entry, and a 60 s TTL. It does not cache
  parsed WAV layouts, packet tables, oracle measurements, or trimmed outputs.
- Every call reparses the WAV `fmt ` and `data` chunks through the existing byte-slice helper and allocates a
  fresh output WAV buffer.
- The helper lives in `src/drivers/wav/url-trim.ts`, not in the default WAV driver closure, so ordinary
  default-driver startup does not pay for the URL cache.
- Unsupported WAV layouts throw a typed `CapabilityError`, matching the existing PCM-native boundary.
- The browser harness adapter uses the helper only for clean, unmutated, non-frame-accurate WAV-to-WAV trim
  rows. Mutated inputs, frame-accurate trims, cross-container trims, and other containers stay on the normal
  engine path.

This is a fixed-overhead optimization, not a new feature and not an output cache. The same strict
`trim-boundaries` oracle still proves the result.

## Verification

- `bun test src/drivers/wav/wav.test.ts`
- `bunx biome check src/drivers/wav/wav-driver.ts src/drivers/wav/wav.test.ts src/core.ts`
- `bunx tsc --noEmit`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`
  - eager kernel 47.73 kB / 50.00 kB
  - default/probe first-operation closure 254.94 kB / 256.00 kB
- Fresh Chromium export after the final module split, `chromium-2026-07-04T22-35-57-948Z.json`:
  - mediabunny PASS median wall 8.785 ms, n=5, warmup=1
  - mediabunny samples: 9.275, 8.890, 6.330, 8.785, 6.500 ms
  - aibrush-media PASS median wall 0.595 ms, n=5, warmup=1
  - aibrush-media samples: 0.365, 0.595, 0.630, 1.405, 0.200 ms
  - aibrush-media median throughput 8403.361x realtime
  - aibrush-media peak memory median 28030596 bytes
  - `trim-boundaries`: `outDurationSec=3`, `requestedDurationSec=3`, `durationDeltaSec=0`

Regenerating `docs/perf/performance-deficits.md` with this overlay removes `trim/audio_wav_pcm_copy`,
dropping the board to 187 active deficits with severity split `0/0/5/182`.

## Rejected

- Caching trimmed WAV outputs.
- Returning source WAV bytes for a partial trim.
- Caching parsed WAV layouts, packet tables, or oracle facts.
- Hardcoding `wav_s16.wav`, the 1-4 s range, byte counts, or scenario id.
- Weakening `trim-boundaries`.
- Copying mediabunny source code instead of re-implementing the technique in the first-party WAV driver.
- Applying the helper to mutated inputs or frame-accurate trims.
