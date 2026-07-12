# Session 13 terminal collector fixed-cost pass

## Goal and design

Remove the redundant full-output copy when an internal writer hands terminal Blob/File collection one
exact-owned, full `ArrayBuffer` chunk. The optimization is format- and size-independent. A single subview
still copies so unrelated backing bytes cannot be retained; a `SharedArrayBuffer` view still copies so the
materialized result cannot observe later mutation. Multi-chunk streams retain their ordinary concatenation,
and stream, OPFS, element, and caller-owned streaming sinks keep their existing backpressure paths.

No media frame is involved at this seam: B-frame/VFR packet order and payload bytes have already been
authored, and `VideoFrame`/`AudioData` close-exactly-once ownership remains upstream. Abort and error paths
still cancel the reader before concatenation. The qualifying stream transfers its byte-chunk ownership to
the collector only after EOF.

## Validation and benchmark

`src/kernel/executor.test.ts` proves buffer identity for a sole exact-owned ordinary buffer and exhaustive
value plus backing-storage separation for subview and shared-buffer controls. Existing multi-chunk,
progress, cancellation, and typed-error tests remain unchanged.

`bun run bench-session13-collect-single-chunk` uses a deterministic 8 MiB payload, warmup 3, and 21 fresh
samples per path. Product collection measures 0.009958 ms median/MAD 0.002209 with zero collector-output
allocation; the former always-copy control measures 0.505875 ms/MAD 0.071334 with an 8 MiB allocation.
Both outputs are compared byte-for-byte against all 8,388,608 input bytes. Public feature closure still
requires current same-export browser wall and positive peak-memory evidence against every passing rival.
