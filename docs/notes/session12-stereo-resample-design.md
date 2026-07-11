# Session 12 stereo polyphase resample design

The rational-rate polyphase resampler currently runs the complete output-frame, phase, boundary, and kernel
traversal once per planar channel. Stereo is the dominant conversion layout and both channels always use the
same phase schedule and coefficients. The optimized path will traverse each output picture once, accumulate
left and right samples side by side in the same coefficient order as the two independent scalar loops, and
write two planar outputs. Interior four-tap unrolling, zero-extension at edges, abort cadence, output length,
cached coefficient bank, and force-software determinism remain unchanged. Mono, 5.1, arbitrary channel
counts, and non-rational fallback ratios keep the existing general path until separately measured.

## Result

The specialization now advances the cached rational phase bank once per output frame and accumulates both
planar channels side by side. A dedicated focused test proves each output `Float64Array` is bit-identical to
resampling the corresponding channel through the unchanged mono path.

On one second of deterministic 48 kHz stereo converted to 44.1 kHz, 21 timed samples after three warmups
improved from 1.570 ms to 1.105 ms (1.42×), or 637× to 905× realtime. The benchmark checksum stayed exactly
`8.887679169`, all nineteen focused resampler tests passed, and no additional retained buffer was added.
