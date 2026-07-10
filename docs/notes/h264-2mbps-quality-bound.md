# H.264 2 Mb/s portrait/60 quality bound (ADR-193)

## Subject and contract

The exact rotated subject (`58dc001d…61391`) is H.264 High, 1080×1920, 60 fps, 626 genuinely distinct
frames, 10.433 s video, 5.72 Mb/s source. The requested output is H.264 at an explicit 2,000,000 b/s.
`mpdecimate` retains all 626 frames, so there is no lossless temporal deduplication opportunity.

## Measured alternatives

| Encoder/configuration | Output rate/size | Independent full-clip or 8-frame result |
|---|---:|---:|
| VideoToolbox High, correct 60 fps, 2 Mb/s | 2.038 Mb/s; 2,661,906 B | FFmpeg SSIM 0.954306; local RGB mean 0.921032 |
| VideoToolbox Main, 2 Mb/s | 2.038 Mb/s | FFmpeg SSIM 0.952113 (worse) |
| VideoToolbox `L1T2`, 2 Mb/s | 1.970 Mb/s | FFmpeg SSIM 0.917416 (worse) |
| VideoToolbox `L1T3`, 2 Mb/s | 1.992 Mb/s | FFmpeg SSIM 0.916516 (worse) |
| libx264 `medium`, requested 2 Mb/s | 1.849 Mb/s; 2,420,005 B | FFmpeg SSIM 0.960279; local RGB mean 0.926936 |
| VideoToolbox High, 4 Mb/s | ~4.04 Mb/s; 5,271,596 B | local RGB mean 0.952893 |

Variable, constant, and omitted `bitrateMode`; quality/default latency; and explicit hardware selection are
byte-identical on this Apple encoder. Omitting the 60 fps config hint creates a misleading improvement by
doubling actual output to ~4 Mb/s. Halving the configured bitrate while omitting fps restores ~2 Mb/s and
makes pixels worse. Software preference, blur/contrast preprocessing, CRF/quantizer substitution, and Main
profile also lose. The first-frame improvement from temporal layers reverses across the full clip.

The black-box cell remains an honest red: mean 0.902773/min 0.891974 versus a 0.95 gate. Achieving the gate
requires roughly twice the requested bitrate even before considering peak/min quality. A source passthrough,
framerate lie, frame drop, or bitrate inflation would be a fake pass. A 31 MB GPL FFmpeg/x264 single-thread
WASM tail is also not justified: native x264 still misses the independent RGB gate at the exact rate and the
WASM runtime would violate the fastest/leanest objective.
