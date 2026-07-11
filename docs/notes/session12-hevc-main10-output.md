# Session 12 HEVC Main10 output

The product now converts an explicit `{ codec: 'hevc', bitDepth: 10 }` target into the qualified WebCodecs
codec `hev1.2.4.L120.B0`. Preserved Main10 strings are also accepted; other HEVC profiles remain typed misses.
Runtime routing still asks `VideoEncoder.isConfigSupported` for the exact config, so this does not turn a
platform absence into a claim.

For an 8-bit source, the planner returns `encoder-widen` with no pixel stage. Every 8-bit value is exactly
representable in ten bits, and the Main10 encoder owns the representation change. This avoids a full-frame
Canvas/GPU copy, preserves opaque-frame acceleration, and does not pretend to recover precision absent from
the source. Existing 10→8 output continues through the explicit canvas-backed downconversion path.

Focused validation covers explicit and preserved Main10 config, rejection of other HEVC profiles, exact
8→10 planning, and the existing 10→8 and same-depth cases. The warm 51-sample planning benchmark reports
about 1.63 million Main10 config builds per second. A live Main10-capable browser remains responsible for the
codec throughput and decoder-config/mux interop proof.
