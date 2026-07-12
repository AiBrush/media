# Session 13 ordinary-cadence AV1 transcode profile

## Goal and design note

Determine whether `transcode/vp9_to_av1_webm` and `transcode/hevc_to_av1_webm` still have a product-side
deficit after ADR-252, without inspecting the external harness implementation and without changing codec
truth to chase an old result. Both selected inputs are independently pinned real 1920x1080, 30 fps,
ten-second files with 300 video pictures. The profile runs the public `convert()` graph, instruments only
the browser's public `VideoDecoder`/`VideoEncoder` methods, and reports decoder/encoder submission cadence,
queue occupancy, flush completion, final mux/collection tail, and the accepted encoder configuration. The
validation pass independently demuxes every input/output packet, decodes and closes every frame, requires
all 300 presentation timestamps to match after the WebM writer's documented whole-millisecond clock
quantization, compares twelve evenly spaced luma samples with an SSIM oracle, and makes the output play. A
smaller project-corpus H.264 control prevents conclusions from depending on the two contested assets.
ADR-284 adds the independently pinned 14,077,804-byte rotated `03.webm` (SHA-256
`1e549042f6402c232cbdf2a5b4236d332054f26e163e121a748da93ecb85b421`), whose 4,482 profile-0 VP9
pictures reproduce the post-configure native runtime miss. The same public profile must prove exact packet
and decoded-frame count/timeline, sampled SSIM, first-key truth, playback, and warm wall after the bounded
one-shot replay switches to `wasm-vpx`.

## Correctness and lifecycle boundaries

- HEVC B-frames remain decoder-ordered by WebCodecs in presentation order; no reorder buffer is added.
- Exact input/output packet and decoded-frame timestamp arrays expose dropped, duplicated, or shifted VFR
  pictures. Input PTS are independently mapped through `round((PTS - firstPTS) / 1000) * 1000`, the
  documented WebM millisecond clock, before comparison. The first output packet must remain a key picture
  and the stream must contain 300 pictures.
- Every decoded `VideoFrame` is closed in `finally`, including copy failure. The timed public conversion
  retains the production close-once, abort, queue-eight backpressure, and downstream cancellation paths.
- Twelve sample indices are selected from the frame count, not from a filename, byte length, hash, or
  scenario. Luma is downsampled only after full RGBA copy; this diagnostic SSIM does not replace the public
  full oracle or weaken its threshold.
- The tracer observes host calls and restores every patched method after each conversion. It neither
  changes configs nor inserts work into the codec graph.
- The rotated runtime-miss case is not recognized by production code: only this validation script pins its
  digest and frame golden. Production eligibility depends on codec family, typed pre-output failure, and
  the general 256-packet/16-MiB replay budget.

## Alternatives and decision boundary

Candidate changes include a larger codec queue, rate-controller preroll, a different latency mode, a
different implicit bitrate, and output-frame buffering. The queue-16 and bitrate alternatives already
regressed ADR-252's VP9 row, and buffering decoded frames would trade wall time for unbounded GPU memory.
No candidate is acceptable unless the profile attributes a durable product cost and an independent output
oracle proves invariance. If current ADR-252 output is already faster than the old passing rivals, this lane
records the native-codec floor and rejects a speculative production change.

## Evidence status

The old same-export ledger reports 2,255.710 ms VP9 -> AV1 versus 1,913.135 ms and 2,275.900 ms HEVC ->
AV1 versus 1,885.705 ms. ADR-252 already measured the exact VP9 shape at 1,645.1 ms over five fresh product
samples with minimum SSIM 0.996395. The HEVC shape and fresh component attribution remain pending.

The ADR-284 selected-file headed run in Chrome 149 did not reproduce the historical runtime miss: native
`prefer-hardware` decoded all 4,482 frames and measured 6,636.0 ms median / 118.7 ms MAD (`warmup=1`, `n=5`).
The normalized input/output timestamp folds are both `96046486`, both decoded sides closed 4,482/4,482 frames,
minimum sampled SSIM is 0.999745, playback passes, and output SHA-256 is
`dc6c3d0a800a2e485cd33723bb3ca930f09b8b15bd62862edcc247e5caf7f97d`.

The deterministic fail-first integration registers a test-only top-rung decode driver that raises a typed
pre-output `CapabilityError`; production code contains neither that injection nor asset facts. Across one
warmup and five measured public conversions it records six misses, loads the actual split
`wasm-vpx-driver` + `vpx-core`, submits zero native decode calls after the injected miss, and encodes exactly
4,482 WASM frames per run. Exact normalized timeline fold (`96046486`), close counts (4,482/4,482), one key,
playback, and minimum sampled SSIM 0.999736 pass; the 22,091,035-byte output SHA-256 is
`41e677c3fb0bc6cc86299e749dc91c2520360b6c7bdfa2a53656d8ac1cd92894`. Its 6,966.4 ms median / 131.6 ms MAD
is replay-path diagnostics only, not rival leadership evidence. No positive browser memory sample was emitted.
