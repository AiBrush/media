# Session 13 — metadata-proved redundant track exclusion

Decision: ADR-283.

## Goal and attribution

The public `transcode/vp9_alpha_to_vp9_keepalpha` rotation selected a 5,487-byte, video-only WebM whose
single 200x200 VP9 track declares `AlphaMode=1` and carries actual alpha side data on all 60 packets. The
requested VP9 family, profile, dimensions, cadence, precision, and `alpha:'keep'` semantics already match.
However, the public operation also explicitly excludes audio. The semantic-copy pre-gate treated every
`audio:false` or `video:false` as a real mutation before reading metadata, so a redundant exclusion forced
the ordinary color decode/encode path even when the corresponding source track did not exist.

## Design

A false selector is only a request to omit that media type; it changes output iff a source track of that
type exists. The cheap pre-gate may therefore admit one false selector as a reason to obtain exact source
metadata. The post-probe predicate accepts only when the corresponding source-track count is exactly zero,
all remaining requested codec/geometry/rotation/precision/alpha/audio facts match, and every existing
single-track/non-media/encryption proof remains green. An actual track drop still declines. Both media
selectors false, a request with no source-dependent fact, empty metadata, non-media/projection tracks,
duplicate media tracks, or an unknown configuration remains ineligible.

This changes only the proof predicate. Replayable-source, abort, stream-copy, mux, packet, sink, and worker
behavior remain owned by the established ADR-263 route. One-shot streams still skip the metadata probe, so
the new pre-gate cannot consume them twice. No decoder, encoder, frame, or packet ownership changes.

## Edge cases and validation

The rule is symmetric for video-only and audio-only inputs. It does not infer absence from a codec family,
filename, size, hash, or target: the routed driver's exact `TrackInfo[]` must contain zero tracks of the
excluded type. VPx alpha still requires the existing positive declared-alpha proof; an undeclared stream
does not become eligible merely because `alpha:'keep'` was requested. B-frames, VFR, cancellation,
backpressure, and close-exactly-once behavior remain unchanged because successful requests use the native
packet rewrite and failed proofs use the untouched codec graph.

Tests cover the pre-gate, symmetric zero-track proof, real-track declines, both-false/empty/non-media
declines, custom-driver probe-to-copy versus probe-to-demux routing, abort-before-copy, one-shot no-probe,
and the selected real WebM. The real oracle pins the source digest and requires all 60 color payloads, all
60 alpha payloads, keys, PTS, DTS, duration, and track facts to survive a fresh container rewrite exactly.
The benchmark uses warmup three and 21 samples on that same selected corpus shape, with truth checked after
every measured rewrite.
