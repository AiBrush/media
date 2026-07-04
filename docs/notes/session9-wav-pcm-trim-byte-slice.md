# Session 9 note — WAV PCM trim byte slice

## Goal

Close the `trim/audio_wav_pcm_copy` speed deficit without changing the public trim contract or weakening
the oracle. The contested Chromium row trims the real `wav_s16.wav` fixture from 1.0 s to 4.0 s. Before
this note, aibrush-media passed correctness but paid a full WAV PCM decode to planar samples, sample slice,
and re-encode even when the request made no DSP or layout change.

## Design

For same-layout WAV trims, the correct work is a RIFF/WAVE rewrite plus a sample-frame byte window. The
implementation adds a lazy WAV slice helper and routes `WavDriver.transformPcm()` through it
only when the target is WAV, endianness is little-endian, no gain/fade/dynamics/biquad is requested, and any
explicit sample format/channel count/sample rate matches the source. The helper is dynamically imported
only for `timeBounds` requests so ordinary WAV probe/convert/decode paths do not add trim-only
frame-window logic to the default bundle.

The helper parses `fmt ` and `data`, computes the frame bounds with the same `Math.round(sec * sampleRate)`
rule used by `applyPcmTransform()`, clamps to the complete PCM frames physically present in the `data`
chunk, and writes a fresh canonical 44-byte WAV header around the selected interleaved bytes. It returns
`undefined` for same-layout mismatches so the existing sample-domain transform still handles real format,
rate, channel, endian, and DSP work. Malformed time ranges throw typed `InputError`s before output.

The final Chromium win needed fixed-cost trimming after the byte-slice itself:

- `WavDriver` now declares `validatesPcmTimeBounds` only because the byte planner mirrors the public trim
  range guards, including the one-second end slack.
- `MediaEngine.trim()` lets such PCM drivers handle keyframe trims before the generic duration probe, so
  WAV does not parse the header once for duration and again for slicing.
- Container routing tries trusted MIME/filename hints before reading magic bytes, which removes the
  redundant source-head range for hinted URL inputs while preserving the existing fallback to magic sniffing
  when hints miss.
- Stream sinks return the produced `ReadableStream` directly.
- Seekable WAV range slicing is kept for files larger than 1 MiB; the 960 KB leaderboard fixture uses one
  full read because two range requests were measurably slower.

## Validation

Focused tests prove:

- the raw helper copies the exact interleaved byte window into the output `data` chunk;
- explicit sample-format, endian, channel-count, or sample-rate mismatches decline the shortcut;
- malformed time ranges stay typed;
- the driver-level `transformPcm` route re-authors a fresh WAV and decodes to the exact source sample
  window;
- the existing public PCM trim corpus still compares every kept sample for WAV, AIFF, and CAF.

Commands run:

```sh
bun test src/api/create-media.test.ts src/drivers/wav/pcm.test.ts src/drivers/wav/wav.test.ts src/api/pcm-trim.test.ts
bun run typecheck
bun run build
```

Local sanity timing on the exact sibling harness fixture:

```json
{
  "fixture": "wav_s16.wav",
  "rangeSec": [1, 4],
  "fixtureBytes": 960044,
  "outputBytes": 576044,
  "n": 9,
  "medianMs": 0.276875
}
```

Fresh Chromium proof after copying the rebuilt package into a temp harness:

```json
{
  "result": "PASS",
  "scenario": "trim/audio_wav_pcm_copy",
  "export": "chromium-2026-07-04T15-13-01-262Z.json",
  "warmup": 3,
  "samples": 5,
  "oracle": "trim-boundaries",
  "aibrushMedianMs": 4.76,
  "mediabunnyMedianMs": 4.85,
  "ffmpegWasmMedianMs": 28.315
}
```

Regenerating `docs/perf/performance-deficits.md` with this overlay removes `trim/audio_wav_pcm_copy`,
dropping the board to 190 active deficits with severity split `0/0/8/182`.

## Risks

The range threshold is intentionally conservative. It avoids hurting small URL inputs, but a future large
WAV trim row may need a lower or adaptive threshold if request latency is much lower than this Chromium
harness run. The hinted-route optimization also means malformed but strongly mislabeled sources reach the
hinted driver before a magic-byte fallback; this matches previous router semantics because the same drivers
already preferred MIME/extension hints even when a `head` was present.
