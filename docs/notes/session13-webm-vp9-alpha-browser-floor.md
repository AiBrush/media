# Session 13 VP9-alpha small-source browser floor

Date: 2026-07-12  
Decision: no production change; ADR-281 remains unused

## Qualified observation

The fresh combined ADR-276/279 export selected real rotated `03.webm` (5,487 bytes). Aibrush passed at
3.880 ms (MAD 0.590), ahead of mediabunny at 4.695 ms (MAD 0.825), but the 0.815 ms raw lead is below the
1.415 ms combined noise and therefore remains parity rather than a durable win.

## Product attribution

The public product path performs exactly one bounded source read, `[0,5487)`, and returns exact metadata:
WebM, 2.4 seconds, VP9, 25 fps, 200×200, declared alpha, and decoder configuration `vp09.00.11.08` at the
driver seam. There is no intermediate image sniff, suffix fetch, terminal scan, packet table, decoder, or
full-media overread to remove. Warm 1,000-sample Bun profiling over fresh sources measures the complete
public route at 0.0228 ms median and the direct `WebmDriver.probe` call at 0.0179 ms; direct metadata parsing
alone is about 0.0272 ms median over 200 samples. The roughly five-microsecond public routing difference is
three orders of magnitude smaller than the browser row and cannot honestly create a durable millisecond
margin.

## Correctness and rejected changes

Probe allocates no `VideoFrame`, `AudioData`, decoder, or packet stream, so B-frame/VFR order, backpressure,
seek, and close-exactly-once ownership are absent from this floor. Cancellation remains checked around the
single read, and the exact-source cache keeps its bounded snapshot semantics. Removing that cache's small
owned copy, trusting MIME without container validation, caching parsed answers, adding a fixture-size fast
path, weakening alpha/config/duration/cadence truth, or increasing/decreasing the 8 KiB policy would be
speculative: none targets a measured product cost of useful magnitude. No code or ADR is warranted. The row
needs additional same-export browser samples/rotations to distinguish a real lead from shared browser I/O and
scheduler noise.
