# MP4 AAC geometry from AudioSpecificConfig (ADR-190)

## Failure

Four fair-harness metadata cells exposed two variants of the same container bug:

- a real AAC-LC mono track carried a stale two-channel `AudioSampleEntry`, while ASC `11 88` declared
  AAC-LC, 48 kHz, `channelConfiguration=1`;
- a real implicit HE-AAC track carried a 24 kHz LC core, but ASC `13 08 56 e5 98` included the
  backward-compatible SBR sync extension (`0x2b7`) for a 48 kHz decoded presentation.

`ffprobe` on the exact selected SHA-256 files was the independent oracle. No scenario/oracle/adapter source
was opened.

## Implementation

`src/drivers/mp4/codec-strings.ts` now has a bounded typed bit reader for the relevant ISO/IEC 14496-3
AudioSpecificConfig syntax: extended AOT, indexed/explicit sampling frequency, channel configuration, GA
fixed fields, explicit AOT 5/29, and the backward-compatible SBR extension. `parse.ts` and
`simple-video-probe.ts` use ASC geometry for AAC. With SBR, the effective ASC rate wins but the outer entry
retains presentation channel geometry, because implicit PS can expose stereo from a mono core.

## Evidence

- 4 massive rotations: baked/`03` = 48 kHz mono; `01`/`02` = 44.1 kHz stereo.
- 4 tiny rotations: all = 48 kHz stereo, including the implicit-SBR `02.mp4` former failure.
- 118 focused MP4 tests green; the range-backed real-file test never streams the two-hour payload.
- `bench-session11-mp4-aac-metadata`: 8 rotations, n=9, median 3.733 ms, peak RSS +3.95 MiB.
- Black-box: all four formerly red metadata cells pass; the massive size-ladder cell passed all four
  selected rotations.

No per-asset mapping, rate doubling heuristic, or outer-entry trust remains.
