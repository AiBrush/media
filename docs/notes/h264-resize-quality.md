# H.264 resize quality: transparent defaults and no-op geometry

## Problem

The fresh Session 11 Chromium run found two independent quality losses in the H.264 1280×720
transcode cells:

1. A real downscale used the implicit 9.216 Mb/s H.264 budget and produced SSIM mean `0.968371` on
   rotated `03.mp4`, below the strict `0.98` decoded-pixel gate.
2. Rotated `01.mp4` was already 1280×720, but the explicit 1280×720 target still inserted a Canvas2D
   resize. At the doubled candidate bitrate it remained at SSIM `0.9735`, showing that the dominant loss
   was the avoidable YUV→RGB→YUV round trip rather than quantization.

The harness stayed a black box: only status, reason, metrics, selection metadata, and exported JSON were
read. No scenario, oracle, tolerance, runner, selection, parser, or adapter implementation was opened.

## Decision

- Implicit offline video rate control now starts at 20 aggregate bits per output pixel per second, still
  scaled by codec efficiency and floored at 300 kb/s. H.264 1280×720 therefore receives 18.432 Mb/s.
- Explicit bitrate and CRF/quantizer requests are unchanged.
- `videoFilterSpecs` omits a resize whose target dimensions equal the post-crop dimensions. A real crop,
  scale, rotate, flip, colour conversion, or tonemap is unaffected.

The optimization is semantic, not fixture-specific: an identity resize cannot change geometry and should
not consume a GPU/canvas pass or alter pixels. Frame timestamps, B-frame ordering, VFR retiming,
backpressure, cancellation, and close-once ownership stay on the existing codec seam.

## Evidence

| Rotated input | Product configuration | SSIM mean | Result | Encode rate |
|---|---:|---:|---:|---:|
| `03.mp4` | 9.216 Mb/s + real resize | 0.968371 | FAIL | — |
| `03.mp4` | 18.432 Mb/s + real resize | 0.981680 | PASS | 351–361 fps |
| `02.mp4` | 18.432 Mb/s + real resize | 0.986473 | PASS | 349–362 fps |
| `01.mp4` | 18.432 Mb/s + identity canvas resize | 0.9735 | FAIL | — |
| `01.mp4` | 18.432 Mb/s + identity resize omitted | 0.9943 | PASS | 545.99 fps |
| baked `h264_1080p_30s.mp4` | 18.432 Mb/s + real resize | 0.9993 | PASS | 347.21 fps |

The fail-first Node tests pin the 20-bpp default, codec scaling, explicit-rate preservation, and
post-crop identity rule. `scripts/bench-session11-video-quality-plan.ts` measures 100,000 mixed
rate/filter plans over nine fresh samples. The browser harness remains the authoritative real-pixel
validation and must continue rotating the corpus in full runs.
