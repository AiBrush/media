# Session 8 Metadata-Write Breadth

## Goal

Add pure-TypeScript tag rewrite support for the three raw PCM container families that currently decline
`remux(input, { to, tags })`: WAV, AIFF/AIFF-C, and CAF. Inputs are complete container byte streams and a
flat `Record<string, string>` tag map; outputs are rewritten byte streams for the same container family.
The audio payload seam must not move: WAV `data`, AIFF `SSND` samples, and CAF `data` samples remain
byte-identical outside the newly-authored metadata chunks.

## Approach

Implement one lazy metadata helper for RIFF/IFF-style PCM containers and route `engine.#writeMetadataTags`
to it for `wav`, `aiff`, and `caf`. WAV writes a standards-readable `LIST/INFO` chunk plus a minimal `bext`
chunk for Broadcast-WAVE-aware readers; AIFF writes conventional text chunks (`NAME`, `AUTH`, `ANNO`,
`(c) `) and preserves all non-tag chunks; CAF writes or replaces a canonical `info` chunk carrying
key/value pairs. The rejected alternative is to reserialize through the PCM transform writers: that would
produce valid audio but would rewrite headers and payload placement unnecessarily, weakening the
"bytes elsewhere unchanged" oracle and hiding container-specific tag placement bugs.

## Edge Cases

Existing metadata chunks must be replaced deterministically rather than duplicated. Odd-sized chunks need
the correct RIFF/IFF word padding, CAF chunk sizes are signed 64-bit big-endian values, and CAF `data`
may be the final chunk with a `-1` size. Unknown chunks, PCM layout chunks, and payload bytes must keep
their original order and bytes. Tags with empty keys are ignored through the shared normalizer; NUL bytes
raise the same typed metadata error as the existing writers. These paths touch byte containers only, so
B-frames, VFR, frame lifetime, backpressure, and cancel races are non-applicable except that the engine
checks the abort signal before dispatch and never constructs WebCodecs frames.

## Failure Modes

Malformed or mismatched container headers raise `InputError('unsupported-input')`; truncated chunks or
unrepresentable metadata chunk sizes raise `MediaError('mux-error')`. Unsupported target tokens still
fall through to the existing `CapabilityError`. The helpers never return input bytes unchanged when tags
are present and never synthesize audio data.

## Test Plan

Extend the existing metadata-write suite with the real WAV corpus (`speech.wav`, `sin_440Hz_-6dBFS_1s.wav`,
`sfx-pcm-u8.wav`, `sfx-pcm-s16.wav`, `sfx-pcm-s24.wav`, `sfx-pcm-s32.wav`, `sfx-pcm-f32.wav`) plus the
stereo WAV benchmark case, and the real AIFF/CAF derived corpus under
`fixtures/media-derived/aiff-caf/` (`sfx.*` variants plus `stereo.aiff`/`stereo.caf`). For each file,
write the shared tag set, read the tags back with the new parser, reparse container metadata, and assert
payload bytes are byte-identical. Add branch/error tests for malformed headers and NUL validation. Extend
the metadata benchmark with WAV/AIFF/CAF rows so the new writers are measured fresh across multiple real
files; the local Session 8 run measured `write_wav_info_bext` across 8 files at 0.254 ms median /
1952.84 MB/s, `write_aiff_tags` across 5 files at 0.252 ms / 1232.63 MB/s, and `write_caf_info` across
5 files at 0.053 ms / 5512.02 MB/s, checksum `142218504`.
