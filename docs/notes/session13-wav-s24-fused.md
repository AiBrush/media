# Session 13: fused WAV PCM decode egress

## Goal

Make raw WAV decode emit the exact interleaved `f32` samples consumed by browser `AudioData` without
first allocating canonical planar `Float64` planes. The driver seam remains chunked and general: any
supported little-endian WAV PCM format may use it, while the contested packed signed-24-bit path is the
primary measured beneficiary.

## Design

Add an optional typed interleaved-f32 chunk stream to the container contract. WAV decodes each bounded
wire chunk directly into one owned `Float32Array`; the engine transfers that array into `AudioData` and
continues to expose the same public frame stream. Range-capable sources retain at most 4,096 output frames
and reduce high-channel chunks so every wire request remains within the bounded 1 MiB window. WAV
transform-only DSP/rewrite dependencies are lazily isolated from the decode closure. The canonical planar
`Float64` seam remains authoritative for DSP and exact integer round-trips. A SIMD/WASM decoder was
rejected because the loop is memory-bound, native typed-array writes are already JIT optimized, and a
new runtime would add startup and package cost. Reusing/pooling transferred buffers was rejected because
the `AudioData` constructor detaches ownership and consumer frame lifetime is independent of the producer.

## Edge cases and ownership

Trailing partial PCM frames are dropped exactly as in the canonical decoder; signed 24-bit extrema are
sign-extended before division; extensible WAV resolves its effective PCM tag; mono and multichannel order
remain frame-major; empty payloads close without producing a frame; truncated range replies raise a typed
demux error. Each pull produces at most one PCM chunk and one `AudioData`, so backpressure stays bounded.
Consumer cancellation cancels the upstream PCM reader; abort is checked before and after asynchronous
range reads; constructor/enqueue failures cancel and unlock upstream. A successfully enqueued `AudioData`
is consumer-owned, while a frame rejected by enqueue is closed exactly once. Video ordering concerns
(B-frames, VFR, open GOP, seek) are inapplicable to raw PCM, and timestamps remain derived from the exact
cumulative audio-frame count.

## Validation and benchmark

The fail-first validation decodes the pinned WPT signed-24 WAV fixture through both the canonical planar
path and the fused path and compares every resulting Float32 bit. Focused stream tests cover cancellation,
constructor failure, transfer declaration, bounded reads, and frame ordering. The focused benchmark uses
the retained real Session-12 signed-24 WAV, reports warm multi-sample full-drain time and bytes/range-call
counts, and rejects any checksum mismatch against the canonical output.

The qualified local product run (two warmups, seven measured drains) decoded 1,315,328 stereo frames in a
3.012 ms fused median versus 9.433 ms for canonical planar-plus-interleave, a 3.13× speedup. Both paths made
nine bounded reads for exactly 7,904,256 bytes and produced checksum `2064061439`. Browser all-engine wall
and peak-memory evidence remains a separate public-harness gate; these product numbers establish the
optimization mechanism and output invariance, not feature closure by themselves.

The first passing public rotation (`02.wav`, export
`chromium-2026-07-11T22-39-40-613Z.json`) measures 14.255 ms median/MAD 3.985 for aibrush-media versus
27.705/1.825 for mediabunny, a durable wall lead. Its positive five-sample peak is still 32,392,187 bytes
versus 23,956,253, so the row remains open for lower-peak sequential source delivery. Rotation `01.wav`
continues the exact pre-existing retained-red digest failure seen in every earlier matching public export;
mediabunny emits the same non-golden digest on that rotation. It is recorded, not treated as timing or as a
new regression.

The memory follow-up rejected both apparent shortcuts. Output chunks larger than the documented 4,096
frames change the public frame-digest truth even when a separate `copyTo()` sample comparison matches, and
a reusable borrowed Float32 scratch increased measured peak while making wall slower/noisier. The retained
general fix is ADR-249 terminal cleanup in the async deferred-stream wrapper: on real `03.wav`, releasing
the completed public stream/input now drops externally retained backing from 8,238,493 to 334,237 bytes.
WAV now also revokes its own range capability and clears the final range/full-buffer window on EOF, error,
or cancellation, so retaining a completed low-level PCM stream cannot keep the source alive independently
of the public wrapper. The product benchmark retains such a completed stream over an exact-owned copy of
real `03.wav`; post-GC retained `ArrayBuffer` bytes are `0` under a 2 MiB regression bound. A pending-range
consumer-cancel test proves that a late reply is neither stored nor emitted. These improve lifecycle truth
but are not claimed as public memory closure until a fresh warm-wall `n>=5`, positive-memory, same-export
all-engine rotation remeasures the row.
