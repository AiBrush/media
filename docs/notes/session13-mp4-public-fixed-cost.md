# Session 13 — MP4/MOV public fixed-cost profile

## Goal and measured seam

Close the remaining public MP4 fixed-cost rows without changing packet, frame, or container truth. The first
candidate is explicit H.264+AAC MOV muxing from caller-prepared packet arrays. The MP4-family prepared writer
already accepts MOV and authors a fresh container, but the public mux runner only attempts that route for an
`mp4` target and the multitrack prepared selector independently declines MOV. The consequence is that MOV
arrays are converted into one `ReadableStream` per track, pulled one packet at a time, copied into the generic
muxer, and only then finalized. Product-only alternating measurements must first establish whether removing
that indirection is a durable win across diverse real H.264+AAC MP4 inputs; an existing Session-13 experiment
reported noisy MOV results, so code shape alone is not enough evidence.

## Design and alternatives

If measurement qualifies the route, the public runner will treat non-fragmented MOV as the same MP4-family
prepared candidate as non-fragmented MP4, and the prepared selector will accept complete multitrack MOV packet
arrays above a measured workload crossover. It will call the existing MOV-capable prepared writer, not add a
second mux implementation. Below the crossover, single-track input, live/readable input, fragmented output,
and any malformed or unsupported shape retain the generic route. The main rejected alternative is eagerly
collecting arbitrary multitrack readable streams: although it could remove generic muxer churn, it changes
cross-track backpressure and could deadlock coupled/live producers. A second rejected alternative is a MOV-only
writer fork, which would duplicate timing and box logic and risk divergence.

## Truth, lifecycle, and edge cases

Validation compares the prepared result with the retained generic control and independently reparses both.
Every track codec/config, packet payload byte, size, key flag, DTS, PTS, and duration must match across real
B-frame and VFR inputs. MOV branding and top-level box layout must remain structurally valid. Empty tracks,
unsupported containers, fragmented MOV, below-crossover arrays, abort-before-authoring, and stream-backed
inputs must continue to decline or fail through existing typed errors. The route creates no `VideoFrame` or
`AudioData`; encoded packet bytes remain caller-owned views until synchronous authoring completes. It performs
bounded allocations equivalent to the existing generic writer, checks cancellation while projecting packets,
and does not alter source reads, cancellation, backpressure, or frame close ownership.

## Benchmark and acceptance

The focused benchmark uses at least five untouched real MP4 corpus files with different packet counts,
B-frame/VFR timing, rotation, and audio presence. It alternates public prepared-array MOV mux against a generic
readable-stream control after warmup, records warm medians and checksums, and separately verifies output packet
truth. A product win is only mechanism evidence. The public row remains open until a current-bundle,
same-export, rotation-on, warm `n>=5` browser run beats every passing rival with qualified memory.

## Result

The first bounded-stream implementation reproduced the earlier rejected experiment on the 30-second source:
one run led `5.34` versus `6.16` ms, while a repeat regressed `5.46` versus `4.42` ms. It emitted 136 bounded
chunks rather than the generic writer's one full-output chunk, so the wall result was not durable even though
the explicit streaming memory shape was better. That variant was not accepted as the default Blob path.

ADR-268 then made a one-chunk exact-owned result adoptable by terminal collection without a second full-size
allocation. The accepted route uses the direct prepared writer only for a default/explicit Blob, while
`ReadableStream`, file, OPFS, element, and `StreamTarget` sinks retain the bounded prepared stream. Three
independent warm-five/`n=21` runs on the real 2,308-packet, 31.2 MiB H.264+AAC source measured the public Blob
route at `4.032`, `4.215`, and `4.367` ms versus the retained readable-packet generic control at `4.548`,
`4.624`, and `4.377` ms. The smallest margin is parity in Bun, so it is product mechanism evidence rather
than browser-row closure; the larger browser cost of one promise-backed pull per packet still requires a
fresh current-bundle public run. The 442-packet real input was durably `0.352–0.405` versus `0.446–0.515` ms,
and the 671-packet B-frame/VFR input was `1.147–1.317` versus `1.358–1.399` ms.

The long input also exposed a correctness difference before the route could ship: prepared authoring omitted
the generic muxer's leading empty edit when one source-timed track began after the global presentation origin.
The shared prepared projector now applies the same cross-track rule. A fail-first public generic-control test
changed from a 48-byte output-length mismatch to byte identity, and all six real benchmark inputs now produce
byte-identical direct, generic, buffered-public, and streamed-public MOV output. On the long explicit-stream
path, prepared output is 136 chunks with a 262,140-byte maximum, versus one 31,241,944-byte generic chunk.
Default Blob collection owns one exact full buffer under ADR-268 for either path, so the faster route adds no
second output allocation; streaming keeps its existing bounded peak. No output or packet buffer is retained
across calls.
