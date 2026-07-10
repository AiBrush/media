# MP4 monotonic encoder/VFR timing (ADR-191)

## Failure

Chromium encoded all 626 portrait-source frames in monotonic PTS order, but retained a nominal 16,667 µs
duration across small VFR cadence corrections. The muxer cumulatively added those rounded durations and
encoded the difference from PTS as `ctts`. By frame 17 the parsed PTS was already 11 µs behind DTS; late in
the file FFmpeg emitted repeated `Invalid timestamps` warnings where DTS exceeded PTS by 1–2 ticks.

This was fabricated reorder, not B-frames: callback PTS never decreased and there was one keyframe.

## Fix

For monotonic arrival/PTS order, `buildMuxSamples` derives each non-final `stts` duration from the exact gap
to the next PTS. The final sample uses its declared duration. Therefore cumulative DTS telescopes to PTS and
every CTO is zero. Non-monotonic encoded output and explicit `Packet.dtsUs` remux retain their existing
decode-order models, including genuine negative B-frame CTOs.

## Evidence

- fail-first timing vector: PTS `0, 16667, 50000`, nominal durations all `16667`; expected
  `stts=[1500,3000,1500]`, `ctts=[0,0,0]` at 90 kHz;
- 99 focused MP4 tests green;
- browser result: 626 packets, one keyframe, zero PTS/DTS differences, monotonic PTS;
- FFmpeg decodes with no timestamp warnings; pixels and full-clip SSIM stay exactly unchanged;
- `bench-session11-mp4-vfr-mux`: 500×626 packets, n=9, median 8.739 ms, peak RSS +0.69 MiB.
