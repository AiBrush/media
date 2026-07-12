# Session 13 — VFR decoder surface lifetime attribution

## Goal and selected truth

The qualified Chromium `decode-seek/decode_vfr_timing` row passes its 12-frame exact pixel oracle but
measures 393.685 ms and 672,616,697 peak bytes, versus remotion-webcodecs at 382.330 ms and 107,579,095
bytes. The checksum-pinned `h264_vfr.mp4` is 2,279,109 bytes, 1280x720 H.264 High, and contains 111 video
access units with B-frame decode order and exact VFR presentation timestamps. The public benchmark delivers
60 frames (`wall * decodeFps = 60`) while full product/native validation retains all 111 PTS.

## Attribution

The product decoder already bounds `VideoDecoder.decodeQueueSize` at eight, bounds its driver-owned decoded
frame queue at eight, gives the readable a zero high-water mark, and stops packet submission while either
budget is full. Cancellation closes every unhanded frame; normal flush closes the decoder after its
presentation-ordered B-frame tail enters the bounded queue. The 565 MB gap therefore cannot be an unbounded
packet/source queue. At the selected geometry, the observed aibrush peak is approximately 11.2 MB per one
of 60 handed GPU-backed frames; web-demuxer shows the same class at 659.6 MB. A compact 4:2:0 CPU frame is
1,382,400 bytes, and 60 such frames total 82,944,000 bytes—close to the passing rival's complete 107.6 MB
process peak after normal page/codec overhead. This identifies consumer-retained native/GPU surfaces, not
the driver's still-owned queue, as the leading cause.

Earlier current-product browser evidence separates the work: a close-only public 60-frame drain is 17.5
ms, full RGBA readback is 226.1 ms, a fresh native full 111-frame decode is 24.2 ms, and a proved-decoder
reuse is 20.2 ms. The configuration barrier and packet pump are therefore not plausible explanations for
the qualified wall. RGBA readback and downstream retention dominate. Exported memory is process-level;
missing UA-specific memory or JS heap must not be substituted for it.

## General candidate and risks

A possible product policy is to detach public decode-only output from native surfaces: copy each decoded
frame's natural compact format and exact plane layout into owned CPU storage, construct a new `VideoFrame`
with identical timestamp, duration, coded/visible/display geometry, and color space, then close the native
frame before consumer handoff. Transcode, filters, encode, alpha composition, and seek must keep native/GPU
frames. The copy must be ordered and demand-paced, include async copy in terminal flush, close the source
frame on every success/error/cancel race, and close an unhanded detached frame exactly once. B-frame/VFR PTS
must never be sorted or rebased.

Before browser measurement, the candidate might have reduced retained surfaces to compact 4:2:0 storage and made
later RGBA reads cheaper, but it can regress close-only consumers by adding a GPU-to-CPU copy to every
frame. Natural format may be unavailable or unsupported for buffer construction, alpha/high-bit-depth
formats require exact handling, and a fallback must preserve the original frame rather than narrow decode
capability. A product-only browser A/B must prove all 111 timestamps, 12 exact RGBA digests, native and
detached close counts, max codec/driver queue depths, bounded cancellation, wall, positive peak, and
terminal retention before any default policy or ADR-285 is accepted.

## Product-only browser result and decision

The bounded standalone A/B ran twice against the existing stable distribution; both Chromium instances and
fixture servers closed in `finally`. Native VFR decode delivered and closed all 111 frames exactly once.
Its complete clock/geometry/color truth hash is
`e4816556012cc3ff8d0ddc1ac845c0128d37e1d2a8dfb440084a7d83f33e3ee3`, and its aggregate full-frame
RGBA digest is `7c762410b68bf702edd4f7b5d94ded3fa92d28d5bf417e57a89eccc50d288d74`.
The independent B-frame control delivered and closed all 182 frames, with clock/geometry/color hash
`f24d1b18314c76e4abf5efdbb798f7c52c8d70fd7a3b2de6f9f6fce5121c1e23` and full RGBA digest
`a687034f42104a77b0fbc9ca398ff0c9988193bbbe3c773a3da62e9f22bc5eb1`.

The native decoder reached the intended `decodeQueueSize` maximum of eight. An ordinary close-only consumer
held at most one handed native frame; warmup-three/`n=9` measured 87.425 ms median (MAD 0.530) for the full
111-frame VFR stream and 7.075 ms (MAD 0.070) for the 182-frame 320x240 B-frame control. Pausing after one
frame and then cancelling observed 18 native outputs, closed all 18 exactly once, held at most 17 native
frames (one handed plus the bounded decoder/driver tail), closed the decoder once, and never exceeded queue
size eight on either input. By contrast, deliberately retaining the complete public output kept 111 and 182
native frames live, respectively. This directly confirms that the large process peak follows caller-retained
surfaces after ownership transfer, not an unbounded driver queue or missing cancellation teardown.

Chromium's UA-specific memory API rejected every call with `SecurityError`; it was not reported as zero.
The available JS diagnostic on VFR rose from 4,310,048 bytes to 4,838,363 while 111 native frames were
retained and returned to 4,322,044 after close. Those values exclude native/GPU allocations and therefore
do not replace the qualified 672,616,697-byte process measurement.

Compact detachment is rejected before performance comparison. Chromium does not support explicit decoded
surface conversion to NV12, and rejects explicit I420 copy; passing the exposed non-RGB natural format as a
copy option is also forbidden. The required corrected natural copy (omitting the format option, then
reconstructing with the observed original format and exact layout/metadata) completed but changed the VFR
aggregate full-RGBA and/or metadata truth, so the strict oracle stopped the run before timing or memory
could legitimize it. No fallback, tolerance, or weakened pixel oracle is acceptable. Production queueing,
acceleration, frame ownership, and native output remain unchanged; ADR-285 is not created.
