# Session 8 WAV Mux

## Goal

Replace the typed `WavDriver.createMuxer()` gap with a real chunk-seam muxer for one legal class of input:
raw PCM audio packets whose bytes are already the target WAV sample payload. The muxer accepts one audio
track with PCM `TrackInfo` (`pcm-u8`, `pcm-s16`, `pcm-s24`, `pcm-s32`, `pcm-f32`, `pcm-f64` and legal
little-endian aliases), writes a canonical RIFF/WAVE `fmt ` + `data` container, and rejects compressed
or multi-track inputs with typed errors.

## Approach

Author a small `WavMuxer` next to the WAV driver. It buffers packet byte payloads in arrival order,
derives sample geometry from `TrackInfo.config`, validates packet boundaries against bytes-per-frame,
and serializes on `finalize()` using the existing `writeWav` PCM writer after decoding the input payload
to canonical planar PCM. The rejected alternative is to concatenate bytes by hand into `data`; that is
faster but would duplicate sample-format validation and make mux output drift from the already validated
PCM writer. This path stays intentionally narrow: WAV carries raw PCM, not H.264/AAC/Opus, so foreign
compressed packets still raise `CapabilityError`.

## Edge Cases

Reject zero tracks, multiple tracks, video tracks, compressed audio codecs, big-endian WAV targets, packet
sizes that do not land on whole sample frames, write/finalize calls after finalization, and fragmented
WAV requests. Packet timestamps are accepted for seam compatibility but WAV has no per-packet timing
table, so duration is derived from the final sample count. B-frames, VFR, and video frame lifetime are
non-applicable; backpressure is the muxer output stream, which emits exactly once after finalize.

## Failure Modes

Unsupported codecs and fragmented output raise `CapabilityError('capability-miss')`. Misuse or malformed
PCM packets raise `MediaError('mux-error')`. The muxer never guesses channel count, sample rate, or sample
format from bytes alone, and it never writes a WAV with mislabeled sample data.

## Test Plan

Flip the existing `wav.test.ts` createMuxer assertion from a typed miss to a working muxer. Build packet
streams from the real WAV corpus by extracting each file's exact `data` payload, feed those bytes through
the muxer as structural fake `EncodedAudioChunk`s, and assert `readWavPcm(mux(x))` has the same PCM frames
as the source plus exact sample payload bytes for identity formats. Add negative tests for compressed
codecs, misaligned packet sizes, multiple tracks, and fragmented output. Add a benchmark row over the same
real WAV corpus.
