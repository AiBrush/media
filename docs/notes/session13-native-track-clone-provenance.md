# Session 13 exact TrackInfo clone provenance

Date: 2026-07-12  
Decision: ADR-287

## Goal and attribution

Close the remaining `mux/video_plus_audio_to_mp4` boundary when a universal caller preserves the untouched
first-party packet streams but value-copies their public `TrackInfo` descriptors. The selected public pair is
the real `h264_1080p_30s.mp4` plus `aac_adts.aac`. A public-API-only shape benchmark produces the same
30,918,082-byte MP4 and SHA-256 `6517ad7b53b1…` for every control. Before this change, exact descriptor
identity takes 4.962 ms and constructs zero host chunks; shallow and structured descriptor clones take
8.550/7.163 ms and construct 1,370 `Encoded*Chunk` objects. Wrapping the streams likewise constructs 1,370
objects. Because complete packet arrays already have a prepared route, the unresolved shape is an identity
boundary, not a missing MP4 writer.

## Design

Keep the stream as the authority. The existing module-private `WeakMap` must still contain the exact,
unlocked, unpulled `ReadableStream`; external, wrapped, teed, array, locked, or partially consumed streams
cannot acquire provenance. Replace only the redundant object-identity test for the accompanying descriptor
with an exhaustive semantic equality proof. Both descriptors must be plain records with exactly the known
`TrackInfo` keys. Every scalar and nested config, dimensions/rates, color, gapless, alpha, rotation,
container projection/side-data payload, and codec-description byte must agree; buffer content and buffer/view
type must be identical. Extra or unknown keys decline. The prepared writer receives the provider-owned
descriptor, never the caller copy. All tracks preflight before any provider claim, preserving ADR-282's
transactional failure and sibling-abort rules.

An alternative that exposes a public brand or trusts a caller-supplied symbol was rejected as forgeable.
Propagating provenance through an arbitrary wrapper stream was also rejected: a wrapper is a real semantic
boundary with independent cancellation/backpressure behavior, and the engine cannot prove its upstream
without consuming it.

## Edge cases, failure, and ownership

B-frame decode order, VFR durations, leading edits, audio clocks, rotation, alpha, gapless facts, and codec
private bytes remain the unchanged provider/prepared-writer truth. A one-field or one-byte difference takes
the existing generic packet path; it is never ignored. Locked/pulled/wrapped/external streams decline before
any sibling is claimed. Claim failure still aborts and settles every sibling. Abort during MP4 window reads
or ADTS materialization remains typed and releases source state. No decoded frames are introduced; packet
views stay owned through the synchronous prepared write and are released on success, error, or abort.

## Validation and benchmark

Fail-first validation showed an exact shallow clone was rejected. Focused unit coverage now accepts shallow
and `structuredClone()` descriptors while rejecting changed rotation, alpha, cadence, dimensions, color,
gapless totals, attachment/projection facts, one codec-description byte, and an unknown future key. Real
H.264 B-frame and VFR plus ADTS integrations compare the clone-fused output byte-for-byte with a deliberately
wrapped generic control and prove the fused route constructs zero additional host chunks. Existing locked,
mixed, sibling-failure, short-read, and abort controls stay green.

After the change, the final public-shape repeat measures 5.798 ms for identity, 5.986 ms for a shallow clone,
and 5.274 ms for a structured clone, all with zero host chunks and the identical SHA-256. The wrapped-stream
negative control remains generic at 13.694 ms and 1,370 host chunks. These are product attribution numbers;
fresh same-export browser wall and positive memory remain required before the ledger row can close.
