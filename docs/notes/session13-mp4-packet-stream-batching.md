# Session 13 — bounded MP4 packet-stream batching

## Design note (written before implementation)

**Goal.** Preserve the public MP4/MOV `ReadableStream<Packet>` contract and every native
`EncodedVideoChunk`/`EncodedAudioChunk` payload, size, PTS, DTS, duration, and key flag while removing the
one-host-`pull()`-per-packet scheduler floor exposed by long progressive files. The selected two-hour AVC
profile is exact: metadata-only `demux()+packetTable()` takes 32.0 ms, whereas draining the identical
553,501 rows through native packet streams takes 1,278.6 ms. **Approach.** Let one asynchronous pull fill a
small byte-budgeted queue from the already-validated current read window, stopping as soon as backpressure
is reached; retain the existing 8 MiB source-window cap, one native immutable chunk per emitted packet, and
the terminal close/release rules. A byte queuing strategy is preferable to a packet-count high-water mark:
4K access units can be orders of magnitude larger than audio packets, so a count bound is not a memory
bound. Rejected alternatives are changing the sealed WebCodecs-native packet seam, emitting metadata in
place of coded bytes, trusting `stss` without AVC payload truth, and prebuilding an unbounded packet array.
**Edge cases and failure modes.** B-frames/VFR retain decode-order iteration and exact PTS/DTS; a sample
larger than the queue budget is still emitted as the permitted one-item overshoot; non-monotonic chunk
layouts retain their ordinal read plan; zero-byte samples make forward progress; cancellation releases the
queue/source state and starts no later range read; abort is checked before every emitted packet and after
every asynchronous range miss; short/truncated reads raise the existing typed `demux-error`; EOF releases
the source exactly once. No `VideoFrame` or `AudioData` is created. **Test and benchmark plan.** A fail-first
pull observer requires substantially fewer host pulls than exact emitted packets, while the real B-frame/VFR
packet table remains field-identical. Existing cancel/abort/short-read/sibling-stream tests gate lifecycle.
The product-only browser benchmark compares packet-info, packet-table, and native packet drain on the real
26 MiB 4K and 1.14 GiB two-hour sources with warm multi-sample medians and exact checksums; the root agent
owns the later qualified all-engine browser rerun.

## Measured result and remaining floor

The implementation uses a zero-high-water-mark stream: a pending consumer pull may emit at most 256 KiB or
256 packets, and a batch never crosses its current validated source window. This is a manual byte/count
budget rather than an eager queue, so an idle stream performs no range read or native chunk construction.
An operation abort owns a listener that errors the stream immediately and discards its queued batch; cancel,
EOF, short-read, and sibling-stream ownership retain the ADR-260 release rules.

The headed Chromium product benchmark (`warmup=1`, `n=5`) produced:

| real input | bytes | packets | packet-table median | native drain median / MAD | producer pulls | packets/pull | sampled peak JS heap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4K H.264/AAC | 74,425,089 | 1,808 | 0.685 ms | 21.155 / 0.855 ms | 270 | 6.70 | 103,857,792 B |
| two-hour H.264/AAC | 1,144,400,182 | 553,501 | 33.945 ms | 1,052.745 / 3.170 ms | 5,522 | 100.24 | 157,151,825 B |

Every drain exactly matched its packet-table count and rolling hash (`1,238,307,765` and `2,889,335,330`).
The massive drain improved from the isolated pre-change 1,278.6 ms to 1,052.745 ms (17.7%), but the current
qualified rival remains 43.75 ms. This does **not** close the row: native immutable WebCodecs chunk
construction must still copy 1.14 GiB, and a stream consumer still performs 553,501 `read()`/`await` steps.
The metadata-only public seam already proves the same truth in 33.945 ms, but substituting it for native
packet payloads, weakening the packet contract, or recognizing a workload would be fake speed. The sampled
heap counter is useful only as positive retention evidence and is not comparable to the harness process
peak; the same-export memory rerun remains authoritative.

The first qualified same-export post-change rotation selected real `01.mp4`: aibrush-media improved the 4K
row from 126.400 to 70.320 ms (MAD 0.680), while mp4box passed at 38.865 ms (MAD 4.700). The optimization is
therefore retained as a general win, but the 4K row remains `BEHIND`; no product-only result supersedes it.

A 1 MiB candidate was rejected before browser measurement. On the real bear H.264 source it prefetched the
entire remaining video stream and requested terminal close, so an operation abort after the first delivered
packet could no longer purge queued native chunks; the next read resolved instead of rejecting with the
typed `aborted` error. Its worst-case live queued payload was also 786,432 bytes larger while the qualified
massive row already trailed the leanest passing rival by 818,622 bytes. The retained 256 KiB budget is the
largest tested candidate that keeps this lifecycle oracle green; no benchmark wall can overrule that gate.
