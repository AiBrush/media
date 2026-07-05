# Session 9 note: direct WAV s16 -> FLAC verbatim authoring

## Goal

Close `transcode/wav_to_flac`, where fresh Chromium proof before the change showed aibrush-media passing
at **118.230 ms** median while ffmpeg.wasm passed at **48.035 ms** on the same `property-invariant` oracle.
The workload is `wav_s16.wav`: 5 seconds of stereo 48 kHz PCM s16 in a canonical WAV envelope, converted to
native FLAC with `audio.codec='flac'`.

## Design

The old route decoded WAV into canonical `Float64Array` PCM planes, quantized those floats back into signed
integer FLAC planes, then ran the pure-TS LPC/Rice FLAC encoder. That path is correct and remains required
for non-s16 sources and any DSP-shaped request, but it is avoidable for no-DSP WAV s16. The new route parses
the existing RIFF/WAVE `fmt` and `data` chunks, validates FLAC-compatible s16 layout, computes STREAMINFO
MD5 over the original little-endian interleaved PCM payload, and writes fixed-block native FLAC frames with
VERBATIM subframes. Samples are transposed from WAV interleaved little-endian into FLAC planar big-endian
subframe payloads while writing the output. Frame CRC-8/CRC-16 are table-driven and validated by the
existing independent `ffmpeg`/`ffprobe` authoring suite.

Eligibility is deliberately narrow: actual WAV driver, no channel or sample-rate change, no gain/fade/
dynamics/biquad, no requested PCM depth other than source s16, and no single-use stream that would make a
fallback impossible after probing. Unsupported WAV layouts fall back to the canonical PCM path. Malformed
s16 geometry still raises typed errors.

## Proof

Focused validation:

- `bun test src/api/flac-convert-plan.test.ts src/drivers/flac/flac-author.test.ts`
- `bunx biome check src/api/flac-convert-plan.ts src/api/flac-convert-plan.test.ts src/drivers/wav/flac-s16.ts`
- `bunx tsc --noEmit`
- `bun run build`
- `bun run vendor-wasm`
- `bun run check-budgets`
- browser harness `bun run typecheck`

Fresh Chromium proof:
`../media-test/media-browser-test/results/raw/chromium-2026-07-05T00-38-57-872Z.json`

- aibrush-media PASS: **28.805 ms** median, samples `[27.880, 27.660, 31.015, 28.805, 31.985]`,
  throughput median **173.581x**, peakMemory median **29,959,494 B**.
- ffmpeg.wasm PASS: **48.410 ms** median, samples `[48.935, 48.410, 47.875, 44.570, 48.500]`,
  throughput median **103.284x**.
- Both pass `property-invariant` with `durationDeltaSec=0`, `durationToleranceSec=0.041666666666666664`,
  and `audioTracks=1`.

The generated FLAC is larger than the compressing LPC/Rice output by design, but it remains a genuine FLAC
stream, decodes bit-exactly to the source PCM, and passes the existing ffmpeg/ffprobe oracle. This row is
wall-time gated; output-size compression is not part of the identical oracle for `transcode/wav_to_flac`.
