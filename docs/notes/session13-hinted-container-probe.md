# Session 13 hinted-container probe fixed-cost design

Date: 2026-07-12  
Decision: ADR-267; Chromium/leaderboard closure pending

## Goal and root-cause hypothesis

Close the provisional `probe/vp9_alpha` fixed-cost deficit without recognizing that scenario or any
fixture. The selected public rotation is a 6,663-byte WebM: its entire finite Segment fits the WebM
driver's first 8 KiB metadata window, but the public `probe()` currently performs an unconditional 4 KiB
image-magic sniff before selecting the container. A correctly declared `video/webm` source therefore pays
one range/Blob read for image sniffing and a second suffix read before the container can parse the complete
source. The same redundant image read applies to every correctly declared `audio/*` or `video/*` container.

## Candidate approach and rejected alternative

Measure the existing generic `probe()` path against the product's container-targeted probe on diverse real
WebM/MP4/audio inputs in Chromium. If the gap is durable, route concrete audio/video MIME hints on known-size
seekable sources to their container first and defer image sniffing to a fallback only when the container probe
rejects. The subtype must be a nonempty RFC token; empty, whitespace-only, or malformed subtypes remain
ambiguous. A mislabeled image must still probe as an image, and a malformed non-image container must retain
its original typed error. Unknown-size URL sources, one-shot streams, generic/absent hints, and `image/*`
hints stay image-first so the sniff can learn live URL size and replay remains intact. This preserves MIME as
a hint rather than turning it into trusted truth. Merely increasing the global image-sniff window from 4 KiB
to 8 KiB is rejected: it still performs image work for known containers and doubles transferred sniff bytes
for every ordinary non-image source.

## Correctness, lifetime, and edge cases

Probe remains metadata-only: it creates no `VideoFrame`, `AudioData`, decoder, or packet stream, so B-frame
and VFR order, seek, backpressure, and close-exactly-once ownership are unchanged. The candidate must retain
exact duration, codec qualification, alpha declaration, color/config, attachment/multitrack enumeration,
source size, and container identity. It must preserve abort checks and source cancellation across both the
container-first success and fallback/error branches; one-shot streams must retain replay through the existing
prefix cache. Wrong MIME hints, unsupported pins, truncated/garbled EBML, image MIME, missing MIME, and a
container error followed by a failing image sniff all need explicit coverage. The fast path may cache neither
parsed metadata nor input-specific answers.

## Validation and benchmark plan

Use multiple public real WebM alpha variants plus ordinary WebM, MP4, and audio fixtures. Freeze complete
`MediaInfo` equality between generic and container-targeted controls, exact underlying range-call sequences,
and wrong-MIME image fallback behavior. Run warmup-three, alternating `n>=21` Chromium samples on the built
public bundle; report medians and sample arrays so an inside-noise result is rejected. If the browser A/B does
not show a general durable win, make no production change and record the negative result.

## Current evidence

The fail-first public API test observed the old real VP9-alpha route as `[0,4096)`, `[4096,8192)`, and
`[8192,65536)`. The accepted generic route now makes only `[0,8192)` and `[8192,65536)`, skips image sniff
entirely, and returns exactly the same public track truth. On the selected 6,663-byte public rotation, a
one-millisecond delay per independently owned range response produced these warmup-three/`n=21` medians:

| route | before | after | targeted control |
|---|---:|---:|---:|
| `probe/vp9_alpha` product shape | 2.631 ms | 1.368 ms | 1.368 ms |

The focused WebM/source/API matrix passes 127 tests. It includes the real wrong-MIME JPEG regression,
one-shot WebM replay, unknown-size URL size/effective-URL handoff, exact typed-error identity after image
fallback misses, abort-without-fallback, parameterized MIME, and malformed `video/`, `audio/   `, and
`video/foo bar` negatives. Biome and all three TypeScript project configs pass. The committed Chromium A/B
runner covers four public VP9-alpha variants plus the pinned real corpus alpha file. The external boundary
has since reopened and ADR-276 records the first completed current-bundle all-engine row; this earlier A/B
does not claim same-export leaderboard closure.
