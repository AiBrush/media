# Session 9 AIFF s24be to WAV s16 Direct Rewrite

## Goal

Close `audio-dsp/pcm_s24be_to_s16le` without changing the feature, oracle, or public API. The scenario
converts a real big-endian signed-24 AIFF PCM source to canonical little-endian signed-16 WAV and must keep
passing the same strict property oracle. The fresh baseline measured aibrush-media at 29.925 ms median
while ffmpeg.wasm passed the same workload at 20.015 ms.

## Observation

This row is a no-DSP wrapper/sample-format conversion. The AIFF COMM and SSND chunks already carry the
channel count, sample rate, byte order, sample width, payload offset, and payload size. The generic route
was spending most of the timed budget on operation/probe overhead and sample-domain plumbing even though
the target is just a fresh WAV header plus deterministic signed-24 to signed-16 narrowing.

## Decision

Extend the AIFF PCM to WAV rewrite helper so ADR-152's byte-order rewrite also accepts exactly
`s24 -> s16` when the target is little-endian WAV, sample rate and channel count match, and no gain, fade,
resample, remix, dynamics, biquad, or time slice is requested. The helper parses the real AIFF layout,
writes a fresh RIFF/WAVE header, then reads each 24-bit sample in source endian order, sign-extends it,
rounds `sample / 256`, clamps to `[-32768, 32767]`, and writes little-endian `s16`. Equal-format AIFF to
WAV conversions keep the existing copy-or-byte-swap path; signed-8 AIFF still declines because legal WAV
8-bit PCM is unsigned.

Expose the same helper from `@aibrush/media/core` as `aiffPcmToWavFromBytes(bytes, opts)` for bounded
driver-author and harness callers. The browser harness adapter uses it only for clean AIFF to WAV
audio-only requests with neutral PCM options, and it does not cache outputs, layouts, decoded samples,
or oracle facts.

## Edge Cases

- Signed-8 AIFF still declines to the canonical PCM path.
- Target endian other than little-endian, mismatched sample rate/channels, resample/remix/gain/fade/EQ,
  dynamics, time bounds, video targets, and multi-output jobs stay on the ordinary route or typed errors.
- Truncated or malformed AIFF is still parsed by the existing AIFF parser and raises typed parser/PCM
  errors.
- Every successful call authors a fresh WAV buffer; the helper never returns the input bytes.

## Validation

- `bun test src/drivers/aiff/aiff.test.ts`
- `bunx biome check src/core.ts src/drivers/aiff/aiff-wav-rewrite.ts src/drivers/aiff/aiff.test.ts`
- `bunx tsc --noEmit`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`
- Browser harness `bun run typecheck`
- Browser harness `bunx biome check src/engines/aibrush-media/adapter.ts`
- Fresh Chromium benchmark:
  `/Users/tarekbadr/Home/software/projects/aibrush/aibrush.lib/media-test/media-browser-test/results/raw/chromium-2026-07-04T23-50-22-771Z.json`

Focused unit coverage proves that a real `pcm_s24be.aiff` narrowed by `rewriteAiffPcmToWav(..., 's16',
'le', ...)` is byte-identical to the existing canonical PCM writer's `writeWav(..., 's16')` output.

## Browser Status

The closing Chromium run measured:

| Engine | Status | Median wall |
|--------|--------|------------:|
| aibrush-media | PASS | 14.340 ms |
| ffmpeg.wasm | PASS | 15.290 ms |

Both engines passed the same `property-invariant` oracle: WAV output, one audio track,
`durationDeltaSec=0`, and tolerance `0.041666666666666664`.

## Rejected

- Caching WAV outputs, decoded samples, parsed layouts, benchmark timings, or oracle results.
- Returning unchanged AIFF bytes with a WAV label or header.
- Truncating samples instead of matching the existing PCM writer's rounded narrowing.
- Weakening the oracle or routing by scenario id, fixture filename, byte size, channel count, or timing.
- Applying the route to DSP, resample, remix, time-bounded, video, multi-output, signed-8, or mismatched
  metadata requests.
