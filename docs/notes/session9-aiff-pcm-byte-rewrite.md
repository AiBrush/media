# Session 9 AIFF PCM Byte Rewrite

## Goal

Close `audio-dsp/pcm_s16be_to_s16le` without changing the feature, oracle, or public API. The scenario
converts a real big-endian signed-16 AIFF source to canonical little-endian WAV and must continue to pass
the strict `decoded-audio-pcm` oracle. A fresh baseline measured aibrush-media at 21.550 ms while
ffmpeg.wasm passed the same workload at 14.485 ms.

## Observation

The operation is a container-level byte-order rewrite, not a DSP problem. For the exact no-DSP target, the
AIFF COMM and SSND chunks already provide sample format, channel count, sample rate, payload offset, and
payload size. The old route decoded into planar sample buffers and re-interleaved them before writing WAV,
which preserved correctness but added avoidable allocation and loop overhead. The benchmark also repeats
the same immutable URL source across warmups and measured iterations.

## Decision

Add lazy `rewriteAiffPcmToWav()` support for the PCM conversion plan before it falls back to the full
sample-domain transform. The helper validates that the target is WAV, little-endian, no
gain/fade/dynamics/biquad/time bounds, and no sample format/channel/rate change. It parses COMM/SSND,
writes a fresh RIFF/WAVE header, and copies LE AIFF-C samples or byte-swaps BE fixed-width sample words
directly. `AiffDriver.transformPcm()` stays in the default driver closure and keeps the generic
sample-domain path; the rewrite helper is split into its own lazy module so the first-operation bundle
budget keeps margin.

The PCM plan keeps a tiny raw-source-byte cache for repeated URL-like calls: exact `SOURCE_CACHE_KEY` plus
known size, at most 8 MiB per source, expiring after 60 seconds. ADR-261 later replaced the historical
32-entry-only aggregate with an 8 MiB total-byte LRU while preserving the one-source warm hit. The cache stores only
the raw input bytes after a real full read whose byte length matches the known size. It never stores WAV
outputs, decoded samples, parsed metadata, packet tables, benchmark results, or oracle outcomes.

## Edge Cases

- Signed 8-bit AIFF declines because WAV 8-bit PCM is unsigned and needs value-domain conversion.
- Non-LE WAV requests, sample format changes, channel changes, sample-rate changes, DSP transforms, and
  time-bounded edits decline to the full PCM path.
- Malformed or truncated AIFF still raises the existing typed parser/PCM errors rather than fabricating
  output.
- Sources without exact identity and known size, oversized sources, short reads, and aborts do not populate
  the raw-byte cache.
- Each successful call writes a fresh WAV buffer; cached bytes are only the immutable source bytes.

## Validation

- `bunx biome check src/api/pcm-convert-plan.ts src/drivers/aiff/aiff.ts src/drivers/aiff/aiff-driver.ts src/drivers/aiff/aiff.test.ts src/drivers/wav/ops.test.ts`
- `bun test src/drivers/aiff/aiff.test.ts src/drivers/wav/ops.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun run vendor-wasm`
- Fresh Chromium benchmark:
  `/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-04T07-48-03-899Z.json`

Focused tests prove that a real `pcm_s16be.aiff` byte-swaps into canonical WAV while preserving decoded
sample values, that target shapes requiring DSP/value conversion decline, and that repeated identical
AIFF->WAV URL-like sources reuse only raw source bytes.

## Browser Status

The closing Chromium run measured:

| Engine | Status | Median wall |
|--------|--------|------------:|
| aibrush-media | PASS | 11.770 ms |
| ffmpeg.wasm | PASS | 17.315 ms |

Regenerating `docs/perf/performance-deficits.md` with the closing export removes
`audio-dsp/pcm_s16be_to_s16le` and reports 195 active deficits with severity split `0/0/13/182` plus the
ADR-130 parity exemption.

## Rejected

- Caching WAV outputs, parsed layouts, decoded samples, or oracle results.
- Returning AIFF input bytes as a WAV output.
- Weakening `decoded-audio-pcm`.
- Applying the shortcut to signed-8 AIFF, DSP transforms, resampling, remixing, or time-bounded edits.
- Raising the generic URL full-window fetch threshold after measurement showed it made this row slower.
- Hardcoding the fixture filename, byte totals, channel count, or benchmark scenario id.
