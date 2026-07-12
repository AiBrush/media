# Session 13 bounded WebM keyframe-prefix qualification

Date: 2026-07-12  
Decision: ADR-276; public same-export closure pending

## Goal and measured cause

Make WebM metadata probe return exact VP9/AV1 decoder configuration from the existing bounded 8 KiB
window when the first sequence-bearing video access unit begins in that window but its large EBML Block
continues beyond it. The selected real VP9-alpha source is 748,970 bytes. Its complete `Info` and `Tracks`
metadata ends at byte 418 and its first Cluster begins at byte 419, but the first alpha-bearing BlockGroup
ends near byte 14.9 KiB. The current parser rejects every incomplete Block before codec qualification, so
the otherwise-complete 8 KiB metadata result stays `vp09`/unknown and forces a second 64 KiB transport read.

## Chosen design and rejected alternatives

Retain only the available payload prefix of the first incomplete BlockGroup's Block as a qualification
candidate. VP9 qualification already parses and validates the frame marker, key-frame bit, sync code,
profile, depth, chroma, and geometry; AV1 qualification already requires a complete sequence-header OBU.
Therefore a partial key frame with enough header bytes qualifies, while an inter frame, short/truncated
header, incomplete OBU, or malformed payload remains unknown and the unchanged range ladder grows. Complete
BlockGroups keep the stronger existing no-`ReferenceBlock` keyframe proof. Increasing the first transport
window to 16 or 64 KiB was rejected because it allocates and transfers more bytes for every ordinary WebM.
Accepting an unvalidated family/default codec string was rejected because it would weaken output truth.

## Edge cases and ownership

Finite and unknown-size Segments, truncated files, malformed EBML/lacing, BlockGroups whose trailing
`ReferenceBlock` has not arrived, large VP9/AV1 key frames, alpha BlockAdditions, and non-sequence inter
frames must all remain safe. An unproven incomplete Block is only a candidate; the codec bitstream parser is
the proof. Duration, declared `AlphaMode`, color, geometry, attachments, and track enumeration continue to
come exclusively from complete container metadata. Probe creates no decoder, `VideoFrame`, `AudioData`, or
packet stream, so B-frame/VFR order, seek, backpressure, and close-exactly-once ownership do not change.
Cancellation checks remain before and after every range await; no source bytes or parsed answers are cached
by asset identity.

## Validation and benchmark plan

First add a real public VP9-alpha regression that requires exact equality with full-file `parseWebm()` truth
and one `[0,8192)` driver range; it fails before the change with an additional 64 KiB request. Add synthetic
structural guards for incomplete inter/truncated candidates only where real corruption is impractical, and
retain the diverse real WebM/Matroska suite for VP8/VP9/AV1, alpha, H.264, Opus, attachments, recorder VFR,
and malformed input. Extend the existing alternating warmup-three/`n=21` real-corpus benchmark with the
large-keyframe VP9-alpha shape, exact `TrackInfo` invariance, range counts, transferred bytes, and a
latency-injected former control. Final leadership still requires the root-owned public browser sweep.

## Fresh local evidence

The fail-first public VP9-alpha fixture read `[0,8192)` and then `[0,65536)` before the change. It now
returns exact full-file `TrackInfo` from `[0,8192)` alone, including `vp09.00.30.08`, declared alpha,
640×480, 30.0000003 fps, limited color range, and five-second duration. Flipping only the unproven VP9
candidate's frame-type bit leaves its decoder codec unknown, proving the incomplete BlockGroup itself does
not assert keyframe truth. The focused WebM, video-qualification, and writer suites pass 140 tests.

`bun run bench-session13-webm-keyframe-prefix` runs five real VP9/AV1/VP8 WebM shapes, warmup three and
alternating `n=21`, with one millisecond of transport latency. Every current path preserves exact full-file
track truth and uses one 8 KiB read. Medians are 1.292-1.330 ms. The sequence-unavailable control needs a
second range while returning the same truth and measures 2.597-2.662 ms; the selected public VP9-alpha
shape is 1.330 versus 2.654 ms and transfers 8,192 versus 65,966 bytes. This is product attribution, not
leaderboard closure; the root-owned same-export browser rerun remains required.
