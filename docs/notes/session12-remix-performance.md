# Session 12 fused 5.1-to-mono remix

The previous BS.775 5.1-to-mono path constructed two complete stereo planes and then averaged them into a
third mono plane. The new kernel evaluates the identical left/right expressions as local doubles and writes
their average directly to the mono output. It preserves the `L,R,C,LFE,Ls,Rs` layout, drops LFE, uses the
same `1/sqrt(2)` coefficients, and keeps the arithmetic grouping unchanged.

This removes two `Float64Array` allocations (16 temporary bytes per source frame) and one full signal walk.
On deterministic ten-second 48 kHz six-channel PCM, 51 timed samples after five warmups measured:

| Path | Before | After | Change |
|---|---:|---:|---:|
| 5.1→mono wall | 1.084 ms | 0.477 ms | 2.27× faster |
| input throughput | 2.66 Gsample/s | 6.04 Gsample/s | 2.27× higher |

The benchmark checksum is identical and the nine focused remix correctness tests pass. Stereo→mono and
5.1→stereo were left structurally unchanged; their small run-to-run improvement is not claimed as product
work.
