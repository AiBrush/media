# Session 11 — MP4 packet-drain host floor

## Goal and measured boundary

After ADR-202, the public MP4 `packets()` path drains 2,045,145 packets across all eight real
huge/massive rotations in 3,452 ms on Bun. A focused real `massive/01.mp4` CPU profile (438,577 packets)
attributes roughly 276 ms per drain to native `ReadableStream` pull/reader scheduling, 93 ms to packet
emission including 64 ms of required sample `Uint8Array` views, 84 ms to file-window I/O/allocation,
23 ms to `buildSamples`, 10.5 ms to a second range-validation scan, 5.5 ms to window-item allocation and
sorting, and 9 ms to the deliberately minimal fake `Encoded*Chunk`. A browser must additionally copy each
access unit into the real immutable host chunk.

The goal of this follow-up is limited: remove only driver work already proven redundant after demux and
avoid sorting sample offsets that ISO-BMFF already presents monotonically, while preserving one observable
packet per stream read, exact bytes/timing/key flags, default backpressure, cancellation, and bounded
memory. Packet-info and H.264 picture classification are separate and unchanged.

## Chosen experiment

`Mp4Driver.demux()` validates every progressive sample directly from `stsz/stsc/stco|co64` and every
fragmented sample from the exact merged array before it exposes the demuxer. Its private `packetStream`
receives only those same immutable tables/arrays, so scanning every range again when a caller opens the
stream cannot discover a new malformed offset. Remove that second scan only from this private trusted
call path; exported packet-table helpers and every stream-copy/decrypt/mux path retain their independent
validation.

For packet reads, first prove whether sample offsets are nondecreasing in decode order. When they are,
build only the bounded read-window descriptors plus each window's final ordinal. The sequential pull cursor
advances through those O(window-count) descriptors without allocating one `{sample, ordinal}` object or one
window reference per packet and without sorting. Equal/overlapping offsets preserve ordinal order and the
same `max(end)` merge rule. Any decreasing offset falls back to the existing stable sort planner, so valid
non-monotonic layouts retain exact behavior rather than being rejected or reordered.

## Rejected strategies

- Enqueuing a resident burst beyond `controller.desiredSize` would reduce native pull calls but violate
  the stream's one-packet backpressure boundary and construct packets after a slow consumer stopped.
- Raising the high-water mark still invokes pull once per refill; overfilling it changes cancellation and
  memory observability. Neither is an identical public contract.
- Omitting or lazily faking `Encoded*Chunk` changes the required packet seam. Real host construction is a
  lower bound when the caller asks for packet chunks.
- Materializing payload arrays, caching a whole large file, or routing by fixture/scenario is forbidden.
- `stss` is not complete picture truth for non-IDR I/SI frames and is unrelated to this path.

## Edge cases and proof plan

Real B-frame, VFR, progressive, hybrid-fragmented, and fully fragmented files must retain byte-exact
packet order, PTS/DTS/duration, and key flags. Synthetic structural cases pin decreasing, equal,
overlapping, zero-size, sparse/unplaced, unsafe/outside-`mdat`, and short-read layouts. Abort before a
resident pull, abort during a miss, and cancellation after one packet must emit no later packet/read.
The retained optimization must beat the warmup-two/median-seven 382.048 ms focused baseline on
`huge/02.mov + massive/01.mp4` without increasing RSS or changing the checksum; otherwise it is reverted.

## Result and lower bound

Fail-first instrumentation observed one `Array.prototype.sort` call when opening an ordinary monotonic
B-frame packet stream. It now observes zero; a real-file mutation that swaps two populated `stco` entries
still observes exactly one fallback sort and drains byte size, PTS, DTS, duration, and key flags in decode
order. Existing malformed/unplaced, outside-`mdat`, zero-size, short-read, abort, cancellation, VFR/edit,
hybrid-fragmented, and writer-overlap tests remain fail-closed.

The focused benchmark retains exactly 480,852 packets, 812 packet-window reads/promises, and checksum
1,670,818,688. Two independent warmup-two/median-seven runs measure 352.963 ms and 349.595 ms versus the
382.048 ms baseline, a 7.6–8.5% reduction. The eight-rotation 4.86 GiB run retains 2,045,145 packets,
2,878 reads/promises, and checksum 4,067,077,818; its 3,451.076 ms median is indistinguishable from the
3,452.371 ms baseline because 8.70 GiB of repeated file-window I/O dominates and individual samples vary
by hundreds of milliseconds. A controlled CPU-profile run on `massive/01.mp4` moved its measured drain
from 365.644 ms to 262.731 ms, while removing the redundant validation and general sort frames from the hot
path.

The remaining local lower bound is not another safe planner shortcut: native `ReadableStream` pull/reader
scheduling is the largest sampled stack, followed by required sample views/packet objects and file-window
I/O. Bun uses a minimal fake `Encoded*Chunk`; a browser additionally copies each access unit into an
immutable host chunk. Reducing native pull count requires enqueuing beyond `desiredSize`, and avoiding host
construction would change the packet seam, so both are deliberately left intact. Browser closure remains a
fresh lead-owned black-box measurement.
