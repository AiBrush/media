# Session 13 MP4/MOV faststart one-pass `moov`

## Contested row

The qualified public partial export `chromium-2026-07-11T23-02-02-666Z` kept
`mux/h264_aac_to_mov` correct for both engines but measured aibrush-media at a 21.160 ms warm median
(MAD 1.260) and mediabunny at 13.920 ms (MAD 0.825), over five samples and 1,118 packets. The 1.52x wall
gap was therefore a real feature loss, not an oracle failure or a within-noise tie.

## Root cause and design

`writeMp4()` emitted a fixed-width `stco` table, but faststart still serialized the complete `moov` twice:
first with zero offsets solely to learn its byte length, then again with final offsets. A direct alternating
warm `n=101` product measurement over the real VFR/B-frame H.264+AAC corpus input measured faststart at
1.383375 ms versus 0.888334 ms for otherwise identical non-faststart authoring: a 0.495041 ms writer-only
penalty and 1.557x ratio that reproduced the public loss shape.

Faststart now serializes one writer-owned zero-offset `moov`, derives `mdat` start from that exact byte length,
and patches only the fixed-width `stco` entries. The patcher walks the generated ISO-BMFF hierarchy
structurally (`moov/trak/mdia/minf/stbl/stco`), validates every box boundary, requires exactly one child at
each required level, verifies track order, entry count, table length, 32-bit range, and total patched count,
and raises a typed `MediaError('mux-error', ...)` if an internal invariant is broken. It neither scans for
sentinel byte patterns nor recognizes input assets. Non-faststart layout is unchanged.

The same design applies to arbitrary supported MP4/MOV tracks and chunk counts. It preserves decode-order
sample payload placement, signed composition offsets for B-frames, VFR `stts` timing, edit lists, rotation,
empty tracks, codec descriptions, brands, and output byte ownership. It adds no buffering beyond the existing
owned `moov`, performs no decode, and creates no `VideoFrame` or `AudioData`. Stream cancellation,
backpressure, and close-exactly-once frame lifetime are therefore unchanged at the surrounding prepared mux
and sink seams.

## Output-invariance oracle

Retained pre-change outputs are byte-identical after the change:

| Proof | Output bytes | Retained SHA-256 |
| --- | ---: | --- |
| VFR/B-frame H.264+AAC `obs-remux-variable-aac.mp4` to MOV | 4,772,852 | `78444151c8fa8563cc17f3045f0a6b94977eabfa110015ec7f884ef0b1d42243` |
| rotated `bear-rotate-90.mp4` to MP4 | 62,959 | `fe5e8b5f9d17b6fe2bb44ccb2210e75c04c1d5a29abca92df9faa0def939bf90` |
| `movie_5.mp4` to MOV | 31,352 | `957f4009ab8cd5bae5bc36fa30f1d49a968afbe98b21adaa68789a03aebe783b` |
| explicit multi-chunk video + empty audio + edit + rotation + signed `ctts` | 1,124 | `d7b012e0c8867939d447dce74122ed5e4e9768a17bc9c62e0eaf56609b979228` |

The real-media tests also reparse each output and compare track type, codec, rotation, packet count, packet
size, duration, keyframe truth, and composition-offset truth to one clock-rounding microsecond.

After the change, the same alternating writer benchmark measured faststart at 0.894417 ms and non-faststart
at 0.903084 ms, with checksum 964,116,104. The prior double-serialization penalty is gone. This is product
evidence for the mechanism; the browser leaderboard row remains open until a fresh same-export,
rotation-on, warm `n>=5` all-engine sweep proves a durable strict lead and qualified peak memory no worse
than the leanest passing rival.

## Rejected work

An array-only MOV routing specialization was implemented and measured, then fully reverted. One early run
suggested only about 0.5%, while repeated warmed runs were unstable and the final alternating run regressed
(1.941 ms specialized versus 1.547 ms generic). This decision is separate from ADR-256's measured large
multitrack faststart-MP4 array route. Also rejected: input-name/digest/dimension/packet-count recognition,
per-asset caches, layout-specific sentinels, copying or changing packet payloads, weakening the reparse oracle,
changing `ctts`/edit timing, padding output, or claiming closure from a Bun writer microbenchmark.
