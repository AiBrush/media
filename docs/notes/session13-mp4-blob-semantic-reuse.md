# Session 13 design note — copy-free MP4 semantic no-op Blob output

The qualified `transcode/h264_rotate_normalize` rotation selected an ordinary same-brand MP4 whose
authoritative `tkhd` is already the canonical identity matrix with matching 1280x720 display dimensions.
ADR-263 correctly proves the requested H.264 codec, coded geometry, and `rotate: 0` semantics from source
metadata, but the established route then demuxes every packet and authors a new 4.36 MiB MP4. That work
cannot improve output truth: it merely moves unchanged compressed payloads into a newly allocated file.

The general optimization is limited to raw Blob/File input, the default Blob sink, an exact same-brand
MP4/MOV target, no faststart/fragment request, and an ADR-263 semantic match. A complete top-level range
scan rejects fragments, indexes, auxiliary/item offsets, UUIDs, mixed media placement, malformed boxes,
external chunk references, and unsafe `moov` descendants. The MP4 demuxer then performs ADR-251's full
sample-storage validation. Only after both proofs may the engine return a fresh target-MIME Blob composed
over the immutable source Blob. The route changes no serialized byte, so B-frame DTS/PTS/CTTS, VFR sample
durations, edit/movie/media clocks, color and codec configuration, unrelated tracks, and every compressed
sample are invariant by construction. Non-zero rotation, resize/fps/rate/filter/track changes, cross-brand
targets, explicit sinks, URL/one-shot/normalized sources, fragmented/indexed/auxiliary layouts, malformed
input, and aborted calls retain the established path. No filename, byte length, digest, fixture, scenario,
or benchmark threshold participates in eligibility.
