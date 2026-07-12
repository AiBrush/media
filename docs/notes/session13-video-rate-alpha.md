# Session 13 video rate-control and VPx alpha evidence

## Goal and design note

Close real transcode quality and speed gaps without recognizing benchmark inputs or weakening output truth.
The failing quality was localized to native encoder startup, not to lost/reordered frames: decoded packet
counts, PTS, cadence, keyframes, duration, and mean quality were already correct. The general repair seeds
implicit native rate control using disposable pre-timeline clones, forces the first retained frame key, and
drops only the exact warmup PTS set. Ordinary implicit AV1 also uses the browser's realtime latency policy;
high-cadence implicit AV1 instead keeps quality latency and receives sublinear bitrate headroom. Separately,
same-codec implicit VPx alpha conversion preserves independent coded alpha packets exactly while genuinely
re-encoding color. Explicit controls, filtering, cross-codec work, unsafe timelines, and unsupported codec
shapes stay on their previous strict paths.

## Policy boundaries

- Implicit H.264 uses three rate-controller warmup clones.
- Implicit AV1 uses eight warmup clones only when proved cadence is greater than 30.5 fps.
- Implicit AV1 at or below 30.5 fps uses `latencyMode:'realtime'`; high cadence uses `quality`.
- The `30.5` tolerance deliberately absorbs rational-clock noise around nominal 30 fps, including
  `30.0000003`. It is not an asset-derived threshold.
- Explicit bitrate, bitrate mode, CRF, and two-pass requests never receive implicit realtime or warmup
  policy. Their caller-selected rate semantics remain authoritative.
- AV1 bitrate efficiency remains `0.6` through ordinary cadence. Above 30.5 fps its implicit bitrate scales
  by `sqrt(frameRate / 30)`, capped at the H.264-equivalent budget.
- Exact alpha copying is limited to unfiltered, same-family and profile-compatible VP8/VP9 color re-encode
  with wholly implicit controls. Qualified `TrackInfo.config.codec` supplies the proved codec/profile;
  level changes remain compatible while profile changes do not. Cross-codec, filtered,
  explicit-rate, CRF, and two-pass work still encode both planes.

## Timeline, ownership, cancellation, and backpressure

Warmup PTS are unique integers immediately before the first real PTS and are inserted into the suppression
set before `VideoEncoder.encode()`. If the source starts too near `Number.MIN_SAFE_INTEGER`, warmup declines
rather than colliding with or shifting the real timeline. Callback metadata still crosses the encoder-to-mux
bridge even for a suppressed chunk. The first real frame is forced key, so retained B-frames cannot reference
discarded warmup pictures. The real decode-order callback stream, VFR PTS gaps, frame count, DTS/CTTS mux
planning, seeking, and duration are otherwise untouched.

Each disposable clone closes in `finally` after its encode call. Each source `VideoFrame` retains the existing
consume-and-close-exactly-once contract. Encode failure, abort, flush failure, and downstream cancellation
clear the pending warmup timestamp set and close/cancel through the existing stage teardown. Successfully
enqueued encoded chunks remain downstream-owned. No extra source-frame prefetch is introduced. The existing
`encodeQueueSize >= 8` dequeue wait remains the backpressure boundary; a trial at 16 regressed the relevant
fresh median from about 2059.6 to 2149.6 ms and was removed.

The alpha path consumes color packets through the normal decoder/encoder backpressure graph. It copies only
the already independent alpha access-unit bytes and timestamps into the output packet seam. Color input and
output digests must differ, so an input-to-output passthrough cannot satisfy its proof.

## Quality and structural evidence

| Proof | Structural truth | Independent decoded truth |
| --- | --- | --- |
| H.264 startup repair | 675 frames, 22.5 s, 30 fps | minimum SSIM 0.971876 → 0.978309 |
| High-cadence AV1 repair | 626 frames, 10.433333 s, 60 fps | minimum SSIM 0.984279 |
| Non-harness ordinary-cadence AV1, `bear-1280x720.mp4` | 82 output frames | mean/minimum SSIM 0.987050/0.983496 |
| Non-harness high-cadence VFR AV1, `obs-remux-variable-aac.mp4` | all 377 output packets retained | SSIM 1.0 on static visual content |
| VP9 alpha public shape | 150 alpha packets, 6,069 bytes, exact PTS | color mean/minimum SSIM 0.998909/0.996343 |
| Non-harness VP9 alpha, `bear-vp9-alpha.webm` | 82 alpha packets, 1,496 bytes, exact PTS | color payload digest changes |

The 150-packet alpha payload SHA-256 is
`1c594ca7ce81be399b6a4bc7359dd8c62701efb6a933a93ab814c6f65483fb11`; color payload changes from
738,941 to 1,886,028 bytes and changes digest. The non-harness 82-packet alpha payload SHA-256 is
`a2d47bf68cb3593440880af7ba38f373d301f31374f5cd7210d585abefd15391`; its color digest also changes.

## Fresh product performance evidence

All medians below use the public product API in headless Chromium after one warmup, with five measured
samples unless stated otherwise. The repeatable command is `bun run bench-session13-video-rate-alpha`.

| Shape | Current median | Comparison |
| --- | ---: | --- |
| Exact ordinary VP9→AV1 shape | 1645.1 ms | prior local quality-mode 2059.6 ms; passing rival 1913.135 ms |
| Non-harness ordinary AV1 | 385.7 ms | prior quality-mode 590.2 ms |
| Non-harness high-cadence VFR AV1 | 667.2 ms | 377 packets; current policy |
| Exact VP9-alpha shape | 266.7 ms | public baseline 1197.965 ms |
| Non-harness VP9-alpha | 157.1 ms | exact alpha, changed color |

The repeatable non-harness run also reported median retained JS heaps of 31,392,732 bytes for ordinary AV1,
63,321,710 bytes for high-cadence VFR AV1, and 14,570,421 bytes for VP9 alpha. These retained-heap samples are
diagnostic product evidence, not a substitute for the qualified harness peak-memory comparison.

## Rejected alternatives and remaining public gate

- A global AV1 efficiency increase to `0.8`: it spent more bits but slowed the contested ordinary row.
- H.264 bitrate increases and constant-rate mode: neither repaired the weak first pictures.
- Encoder high-water mark 16: it increased wall time and weakened bounded backpressure.
- Copying VP9 color, fixture-specific caching, or detecting filename/hash/geometry/duration/packet count.
- Applying realtime or copied alpha under explicit quality/rate controls, filters, or cross-codec conversion.
- Treating a local microbenchmark, a single timing sample, or aggregate leadership as feature closure.

The implementation evidence is green locally. Public row closure remains open until the root session runs a
fresh same-export, rotation-on, warm `n>=5` all-engine sweep and confirms both strict wall leadership and
memory no worse than the leanest passing rival without a PASS→FAIL regression.
