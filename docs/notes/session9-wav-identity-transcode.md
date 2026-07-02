# Session 9 - WAV Identity Transcode

## Goal

Close `audio-dsp/meta_idempotent_resample_same_rate` on Chromium without changing the oracle, hardcoding
the fixture, or pretending a real resample/remix request is an identity operation.

## Baseline

The fresh pre-fix run `chromium-2026-07-02T13-33-23-345Z.json` showed:

- aibrush-media: **22.170 ms** median, PASS.
- mediabunny: **4.465 ms** median, PASS.
- ffmpeg.wasm: **24.965 ms** median, PASS.

The useful work is tiny: the requested target is still WAV `pcm-s16`, same sample rate, same two-channel
layout, and the oracle compares decoded PCM digest to the source. We were parsing the WAV, decoding all
interleaved PCM into planar samples, writing it back, then paying generic transcode source/probe/Blob
overhead.

## Design

The package now treats explicit same-rate/same-channel/same-format WAV PCM targets as a validated identity
rewrite. The WAV helper parses RIFF/WAVE, checks optional requested format/endian/channel/rate constraints,
and writes a fresh canonical header with copied payload bytes. If any requested value differs, or if any
DSP operation is present, the helper returns `undefined` and the normal PCM transform path handles the real
work.

The lazy PCM convert path can also use that rewrite directly for hinted, sized WAV sources and return the
requested sink without building a temporary stream. In the browser harness adapter, neutral WAV identity
transcodes prepare canonical bytes from the runner's per-iteration `MediaInput.arrayBuffer()` and call the
engine PCM helper before the generic pre-transcode probe guard. The branch is source-metadata guarded, not
scenario-id guarded.

## Edge Cases

- Explicit sample-rate or channel mismatches fall back to real resample/remix.
- Gain, fade, dynamics, biquad, trim, and endian conversion still use the PCM transform path.
- Non-canonical WAV is re-authored with a fresh canonical header; arbitrary input bytes are not returned as
  output.
- Mutated/malformed/non-WAV inputs do not use the prepared branch.
- No cross-iteration byte cache is introduced; benchmark iterations still build fresh `MediaInput` objects.

## Validation

Focused package tests cover explicit identity WAV re-authoring over an input with a `JUNK` chunk and public
`media.convert()` bit-exact PCM identity. Existing gain/fade/resample tests continue to exercise the sample
transform path. The sibling browser harness typecheck passes after the adapter route.

Fresh closeout export `chromium-2026-07-02T13-55-04-311Z.json`:

- aibrush-media: **8.010 ms** median, PASS.
- mediabunny: **9.635 ms** median, PASS.
- ffmpeg.wasm: **35.770 ms** median, PASS.

Regenerated backlog: **286 active deficits**, severity `0/0/71/215`, plus the existing ADR-130 parity
exemption.
