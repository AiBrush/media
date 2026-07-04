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
bun test src/drivers/wav/pcm.test.ts src/drivers/wav/wav.test.ts src/api/pcm-trim.test.ts
bun run typecheck
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

This local Bun timing is not the Session 9 closure proof. The official speed gate is still a fresh
multi-sample Chromium export where aibrush-media's median wall time is less than or equal to the fastest
same-oracle rival. Because the rebuilt package could not yet be copied into the sibling browser harness
under the current approval limit, `docs/perf/performance-deficits.md` intentionally still lists
`trim/audio_wav_pcm_copy`.

## Risks

The current `transformPcm` contract still reads the whole source before slicing. For the 960 KB benchmark
fixture, removing decode/re-encode is the dominant win; if fresh Chromium still loses, the next escalation
is a driver-native WAV trim route that reads only the header plus selected `data` byte span for seekable
sources. That would need a separate ADR because it changes the source-read strategy rather than only the
PCM authoring strategy.
