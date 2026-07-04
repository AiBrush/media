# Session 9 Note - WAV s16 Direct Longform Resample

## Goal

Close `audio-dsp/edge_longform_audio_resample_16k`, the top active Chromium speed deficit after the
GB-scale MP4 rows were fixed. The workload is a one-hour mono RIFF/WAVE `pcm-s16` source at 44.1 kHz,
transcoded to WAV `pcm-s16` at 16 kHz. The oracle is `property-invariant`: one WAV audio track with the
requested output shape and preserved duration. No oracle, fixture, or feature change is allowed.

## Pre-fix shape

The generic WAV PCM transform was correct but mismatched to the structural longform workload:

- Read the whole WAV into memory.
- Decode s16 interleaved payload to canonical planar Float64.
- Run the public high-quality windowed-sinc resampler.
- Encode the output samples back to s16.
- Write a canonical WAV wrapper.

For 44.1 kHz -> 16 kHz, the canonical public resampler uses the long 80 dB kernel from `src/dsp/resample.ts`.
On the one-hour file this means 57.6 million output frames and a large Float64 working set before writing the
final 115.2 MB s16 payload.

Fresh proof before the change:

- aibrush-media: `chromium-2026-07-04T17-07-41-510Z.json`, PASS, median **12415.135 ms** over five samples,
  samples `[12695.695, 19101.220, 12415.135, 11731.250, 11732.885]`.
- ffmpeg.wasm target: `chromium-2026-07-04T17-09-44-086Z.json`, PASS, median **3998.530 ms** over five
  samples, samples `[3978.895, 3997.910, 4016.235, 3998.530, 4003.880]`.

## Decision

Add a narrow `WavDriver.transformPcm` fast path for no-DSP `s16` -> `s16` sample-rate-only transforms:

- Eligibility: WAV output, source `pcm-s16`, target/preserved `s16`, little-endian output, unchanged channel
  count, target sample rate present and different, no time bounds, gain, fade, dynamics, or biquad.
- Kernel: cached rational polyphase FIR, 6 Kaiser-windowed sinc zero crossings, beta 8.6, per-phase DC
  normalization, zero-extended edges, exact `round(inputFrames * outRate / inRate)` output length.
- Hot loop: aligned native-little-endian `Int16Array` input/output views, mono-specialized unrolled interior
  MAC, generic interleaved multichannel fallback, abort checks every 4096 output frames.
- Output: fresh canonical 44-byte RIFF/WAVE header plus a real resampled s16 payload.
- Loading: the direct FIR helper stays behind a dynamic import after the cheaper same-layout WAV copy path
  misses, preserving the tight default-driver first-operation JS budget for ordinary WAV work.

This is not a replacement for the public `resample()` contract. Non-s16, non-WAV, remix, trim, gain/fade,
dynamics, biquad, unsupported endian/alignment/native-endian, invalid rates, or excessive phase counts all
fall back before output to the canonical PCM path.

## Validation

Focused tests:

- `tryResampleWavS16ToS16Wav` authors canonical 16 kHz WAV output from a 44.1 kHz sine and preserves a strong
  low-frequency tone.
- The direct path applies a real low-pass filter to an above-output-Nyquist 12 kHz source tone.
- The interleaved stereo path preserves two distinct channels and reuses the cached kernel bank.
- `WavDriver.transformPcm` routes sample-rate-only s16 WAV transforms through the direct writer, verified by
  byte-equality with the helper output on a source carrying a `JUNK` chunk.
- Unsupported containers, formats, endianness, rate shapes, channel changes, malformed WAV headers,
  misaligned source views, abort signals, non-s16, and multi-stage requests decline or throw on the direct
  route before output.

Commands run:

```bash
bun test src/drivers/wav/wav.test.ts src/drivers/wav/ops.test.ts
bunx tsc --noEmit
bunx biome check src/drivers/wav/s16-resample.ts src/drivers/wav/wav-driver.ts src/drivers/wav/wav.test.ts src/drivers/wav/ops.test.ts
bun run build
bun run vendor-wasm
bun run check-budgets
```

## Fresh Chromium Proof

After `dist/` was rebuilt, vendored wasm assets were refreshed, and the sibling browser harness
`src/engines/aibrush-media/vendor/` bundle was updated from `dist/`, the fresh n=5 Chromium run passed:

- aibrush-media: `chromium-2026-07-04T17-22-40-041Z.json`
- Status: PASS
- Oracle: `property-invariant`
- Measurements: `durationDeltaSec=0`, `durationToleranceSec=0.041666666666666664`, `audioTracks=1`
- Wall median: **3610.680 ms**
- Samples: `[3633.375, 4907.800, 3534.105, 3524.500, 3610.680]`
- Peak memory: **462,048,953 bytes**

The fresh target remains ffmpeg.wasm at **3998.530 ms** median from
`chromium-2026-07-04T17-09-44-086Z.json`, so the row is closed on the same oracle-passing workload.

## Rejected

- Weakening `property-invariant`.
- Returning silence, a synthetic header, or the original WAV bytes with a rewritten sample-rate field.
- Routing by scenario id, fixture name, byte size, output hash, or timing result.
- Replacing the public high-quality Float64 resampler for all callers.
- Using native-endian typed arrays without an explicit little-endian guard and alignment check.
- Copying competitor code.
