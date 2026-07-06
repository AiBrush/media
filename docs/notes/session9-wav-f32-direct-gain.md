# Session 9 — WAV f32 Direct Gain

## Deficit

`audio-dsp/gain_half_f32` was the top active Chromium speed deficit after `mux/mp3_to_mp4_audio` closed.
The fresh pre-fix run `chromium-2026-07-05T11-14-17-615Z.json` showed:

- aibrush-media: PASS, median `35.630 ms`, samples `[40.875, 35.630, 35.595, 28.905, 36.465]`
- ffmpeg.wasm: PASS, median `16.425 ms`, samples `[18.375, 16.195, 20.220, 12.775, 16.425]`
- mediabunny: PASS, median `30.720 ms`, samples `[30.720, 35.990, 28.885, 35.785, 29.490]`

All engines passed the same oracle: `[invariant transcode output metadata] wav, 1 track(s) match requested output shape`.

## Cause

The public path was correct but too general for a same-layout f32 gain row. `WavDriver.transformPcm()`
decoded interleaved f32 WAV bytes into planar Float64 PCM, allocated another planar Float64 buffer for
`gain()`, then encoded back to f32. That route is still the right fallback for integer PCM, f64,
remix/resample, trim, fade, dynamics, EQ, endian conversion, and cross-container output, but it is wasted
work for clean f32 gain.

## Change

Add `tryGainWavF32ToF32Wav()` in `src/drivers/wav/f32-gain.ts` and expose the same primitive as
`wavF32GainToWavFromBytes()` from `@aibrush/media/core`. The helper:

- accepts only WAV output, little-endian f32 source/output, finite non-zero gain, unchanged rate/channels,
  and no trim/fade/dynamics/biquad work;
- parses the WAV chunks, drops trailing partial frames like `readWavPcm()`, and writes a fresh canonical
  RIFF/WAVE header;
- scales interleaved float32 samples directly with abort checks;
- returns `undefined` for unsupported shapes so the canonical PCM path remains the source of truth.

The browser harness adapter uses the core helper only for the matching clean transcode shape, avoiding
`createMedia().convert()` fixed overhead in the contested tiny row.

## Validation

- `bun test src/drivers/wav/wav.test.ts`
- `bunx biome check src/drivers/wav/f32-gain.ts src/drivers/wav/wav-driver.ts src/drivers/wav/wav.test.ts src/core.ts`
- `bun run typecheck`
- Sibling harness:
  - `bunx biome check src/engines/aibrush-media/adapter.ts`
  - `bunx tsc -p tsconfig.json --noEmit`

The focused WAV tests prove the direct output is byte-identical to
`writeWav(gain(readWavPcm(input), db), 'f32')`, prove the driver route uses the direct writer for real f32
WAV gain, and prove unsupported shapes decline.

## Proof

After rebuilding `dist` and refreshing the sibling vendored runtime, the fresh proof
`chromium-2026-07-05T11-23-45-644Z.json` closed the row:

- aibrush-media: PASS, median `10.235 ms`, samples `[23.380, 8.485, 8.920, 10.235, 12.860]`,
  throughput `488.520x realtime`, peak memory `33,172,658 B`
- ffmpeg.wasm: PASS, median `14.185 ms`, samples `[15.050, 11.600, 12.885, 14.555, 14.185]`,
  throughput `352.485x realtime`
- mediabunny: PASS, median `21.895 ms`

Regenerating `docs/perf/performance-deficits.md` with this overlay removes
`audio-dsp/gain_half_f32`.
