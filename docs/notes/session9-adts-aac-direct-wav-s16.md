# Session 9 Note - ADTS AAC Direct WAV s16 Extraction

## Goal

Close `transcode/aac_to_pcm_wav_extract` without changing the scenario, oracle, fixture, or requested output.
The workload is raw ADTS AAC-LC input (`aac_adts.aac`, 163,811 bytes) converted to WAV `pcm-s16` with no
DSP, remix, resample, time slice, or metadata mutation.

## What Was Slow

The old ADTS PCM bridge used native `AudioDecoder` first on Chromium. That was correct, but for this small
decode-to-PCM job the fixed setup and callback cost dominated. The bridge then copied every decoded block
into canonical Float64 planar PCM, concatenated all chunks, and encoded the final WAV. Fresh pre-fix
Chromium timing was:

- aibrush-media: 52.865 ms median, PASS
- ffmpeg.wasm: 24.440 ms median, PASS
- Both passed `property-invariant` with `durationDeltaSec=0.0043333333333333`.

The rival was faster because libavformat/libavcodec decode and WAV s16 muxing stay inside one tight wasm
pipeline for this small elementary stream.

## Technique

Add a narrow ADTS driver path for no-DSP WAV s16 extraction:

- Parse the ADTS stream with the existing frame walker and carry each frame's exact decoded sample count.
- Try the vendored `wasm-aac` Symphonia core first only when the request is same-layout WAV s16 and either
  the runtime is wasm-only, determinism is force-software, or the input is at most 256 KiB.
- Decode each raw AAC access unit through the real wasm core.
- Write the canonical RIFF/WAVE header plus interleaved little-endian s16 samples directly.
- Use the same s16 rounding/clamping as `encodePcm`: `round(sample * 32768)` clamped to signed 16-bit.

The route steps aside for sample-rate changes, channel changes, gain, fade, dynamics, biquad/EQ, time
bounds, non-WAV targets, non-s16 targets, or unavailable wasm assets. Those cases keep the existing
canonical `decode -> applyPcmTransform -> writeWav` path.

## Edge Cases

- ADTS frames with non-1024 raw-block counts still size output from the parsed frame sample count.
- If decoded interleaved PCM is not divisible by the decoder channel count, the driver raises `MediaError`.
- If an explicit requested sample rate or channel count does not match the decoder's authoritative geometry,
  the direct writer declines so the transform path can honor the request.
- Aborts are checked before decode and before each frame.
- The wasm decoder is freed exactly once in `finally`.

## Proof

Focused unit validation:

```bash
bunx vitest run src/drivers/adts/adts.test.ts
```

Browser proof:

```bash
bash scripts/run.sh --browser chromium \
  --engine aibrush-media@dev,ffmpeg.wasm@0.12.15 \
  --scenario transcode/aac_to_pcm_wav_extract \
  --warmup 3 --iters 5 --no-reuse --timeout-ms 900000
```

Final fresh result after lazy-splitting the helper and caching the loaded module:
`/private/tmp/aibrush-harness-RmNgBu/results/raw/chromium-2026-07-04T16-21-53-844Z.json`.

- aibrush-media: 17.455 ms median, samples `[26.260, 17.235, 16.810, 17.455, 20.235]`, PASS
- ffmpeg.wasm: 23.760 ms median, samples `[20.865, 26.405, 21.240, 23.760, 27.520]`, PASS
- Both engines passed `property-invariant` with the same duration delta and one audio track.
- `bun run scripts/check-budgets.ts` stayed green: default/probe first-operation closure 254.75 kB against
  the 256.00 kB budget.

This closes the cell on fresh n=5 Chromium timing.
