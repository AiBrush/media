# MP4 keyframe-copy trim: decode pre-roll versus presentation duration

Lossless H.264 trimming cannot begin decoding at an arbitrary requested frame: the preceding sync
sample and dependent pictures must remain in the file. The previous implementation correctly kept
that GOP, but rebased it to presentation time zero. A requested six-second interval could therefore
probe as eight or 8.976 seconds, and audio selected at the requested start was shifted against video
selected at the earlier keyframe.

## Container-native correction

Each trimmed track now carries a single-rate ISO-BMFF edit:

- selected compressed samples and their `stts`/`ctts` timing remain byte-for-byte lossless;
- `media_time` skips from the first selected decode timestamp to the requested source start;
- `segment_duration` is the requested end-minus-start interval, clamped only if a corrupt/short
  timeline does not cover it;
- audio keeps its overlapping first packet and uses the same edit mapping, preserving A/V alignment;
- progressive and fragmented outputs serialize the same edit contract.

Probe treats a fully contained, non-AAC edit as a presentation trim and reports its segment duration.
AAC priming/padding edits remain the separate gapless contract and retain their established media
duration, so the committed ffprobe metadata goldens do not regress. Fragmented init segments now
carry `edts/elst`; fragment timing still supplies their real decode duration.

## Validation

A deterministic 12-second/three-GOP regression fixture trims source seconds 2–8 while retaining the
keyframe at second 0. Both progressive and fragmented outputs retain eight seconds of compressed
decode samples, parse an edit of `media_time=2s` and `segment_duration=6s`, and probe as exactly six
seconds. Existing MP4 golden metadata, fragmented probe, mux, and round-trip suites remain exact.

