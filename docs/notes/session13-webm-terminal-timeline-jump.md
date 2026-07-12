# Session 13 WebM terminal-timeline range jump

Date: 2026-07-12  
Decision: ADR-279; public same-export closure pending

## Goal and measured cause

Create a durable margin on the small no-`DefaultDuration` VP9-alpha rotation without weakening its exact
30 fps truth. The real 95,093-byte source has complete `Info`, `Tracks`, declared alpha, and geometry by byte
258. Its one Cluster carries all 81 video Blocks and there is no track `DefaultDuration`, so exact cadence
cannot be known until the terminal Block. The current bounded ladder correctly reaches a full parse, but it
first grows 8 KiB to 64 KiB and only then to the known full size. Through the public exact-range cache this
is three transport calls: `[0,8192)`, `[8192,65536)`, and `[65536,95093)`.

## Chosen design and rejected alternatives

After each metadata-only parse, separately prove that all finite `Tracks` and `Attachments` declarations
are complete and every video track has geometry. If those declarations are complete but declared duration
or a video frame rate is missing, a known-size source jumps directly to one full-file range and runs the
unchanged cluster-timing parser. The public cache still fetches only the missing suffix, so total transferred
bytes do not increase. Sources with incomplete declarations or missing VP9/AV1 sequence qualification retain
the existing bounded ladder. Estimating fps from the first few Blocks was rejected because VFR and cadence
changes require terminal truth. Treating declared movie duration divided by a prefix packet count as fps was
rejected for the same reason. Increasing every initial window or accepting an approximate rate was rejected.

## Edge cases and lifecycle

VFR, multiple Clusters, B-frame presentation order, missing duration, mixed audio/video tracks, complete or
truncated finite Tracks/Attachments, unknown-size Segments, malformed EBML, large first keyframes, and
range-less streams keep exact behavior. The jump is only a read schedule: `parseWebm(scanClusters:true)`
remains the sole fallback that derives terminal duration and cadence. Abort is checked before and after the
full range. The source cache remains bounded and owns only exact bytes; a short full read is parsed under the
existing truncation/error rules. Probe creates no frame/decoder ownership and no packet backpressure change.

## Validation and benchmark plan

Add a fail-first real VP9-alpha test requiring exact full-stream `TrackInfo` and two driver reads rather than
the former three. Cover public suffix reuse, declared-`DefaultDuration` bounded behavior, incomplete Tracks,
unknown-size/range-less fallback, and cancellation. Benchmark at least five real WebM shapes with warmup
three and alternating `n=21`, injecting transport latency and requiring exact output equality. Report read
intervals and bytes. Final durable leadership remains the root-owned browser sweep.

## Fresh evidence

The fail-first selected-source test observed 8 KiB, 64 KiB, and full-file driver requests. It now observes
only 8 KiB and the complete source; through the public cache those become disjoint `[0,8192)` and
`[8192,95093)` reads. Exact full-stream `TrackInfo` and public `MediaInfo` remain equal. Short terminal reads
reject typed instead of returning a partial 30.37037-fps cadence, and cancellation after the second range
resolves rejects `aborted` before parsing.

`bun run bench-session13-webm-terminal-timeline` covers five real WebM shapes with warmup three, alternating
`n=21`, and one millisecond of range latency. The selected source measures 2.710 ms with two reads versus
4.042 ms with redundant intermediate transport; a real headerless recorder measures 2.755 versus 4.052 ms.
Three declared-timeline VP9/AV1 controls stay on one 8 KiB read. Every route returns identical serialized
`MediaInfo`. Same-export browser closure remains root-owned and pending.
