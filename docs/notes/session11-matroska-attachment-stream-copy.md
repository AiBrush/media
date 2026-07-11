# Matroska attachment stream-copy preservation

## Session 11 design note

**Goal.** Same-container Matroska stream copy must retain every declared `AttachedFile` in declaration
order, with its filename, media type, 64-bit `FileUID`, optional fields, and `FileData` bytes unchanged.
Attachments remain top-level `Segment/Attachments` children; they are never converted into Block tracks.
The exact regression subject is the real attachment-bearing corpus file
`scenarios/metadata/write_mkv_tags/03.mkv`, which declares an `application/json` attachment followed by a
JPEG cover attachment alongside H.264 and AAC tracks.

**Approach.** The parser retains each complete `AttachedFile` payload as a source-backed byte view and
also keeps the existing probe projection that exposes JSON as `other` and valid JPEG cover art as MJPEG.
The stream-copy muxer forwards those ordered payloads to the writer, which emits one Matroska
`Attachments` element between `Tracks` and `Cluster`. Re-wrapping the unchanged child payload preserves
all present child elements, their order, exact 64-bit UID bytes, and unknown/optional extension fields
without converting UIDs through JavaScript `number`. This follows RFC 9559 sections 5.1.6 and 8, which
mark `FileMediaType`, `FileData`, and `FileUID` as stream-copy facts. Rejected alternatives were treating
attachments as encoded packets (invalid Matroska structure), rebuilding only the four currently known
fields (would discard optional/future elements and risk unsafe-integer UID loss), and returning the source
file unchanged (not a remux and incompatible with trim/tag rewrites).

**Edge cases and failures.** Zero or many attachments preserve declaration order; JSON, fonts, and unknown
media types remain opaque; JPEG probing affects only the public stream projection, never preservation.
Full remux and keyframe trim retain attachments, while media packet selection, B-frame/VFR ordering,
codec delay, alpha side data, backpressure, abort, and frame lifetime remain unchanged. The writer rejects
attachments in a WebM (`DocType=webm`) target rather than authoring a file outside the WebM subset. A
source still needs at least one valid media packet because attachments alone do not satisfy the mux
packet contract.

**Validation and benchmark.** A strict real-corpus test compares the source and remuxed attachment count,
order, names, media types, UID payload bytes, complete `AttachedFile` payload SHA-256 digests, and
`FileData` SHA-256 digests. Product re-probe must retain four declared streams and the JPEG dimensions;
fresh `ffprobe` must independently report H.264, AAC, JSON attachment, and attached MJPEG cover art.
A multi-sample benchmark measures full stream copy of the same real file after warmup, consumes every
output byte into a checksum, and reports median wall time plus RSS delta. The 2026-07-11 local run
(`warmup=3`, `n=9`) measured a 8.986 ms median for the 924,924-byte input and 923,988-byte genuine
re-layout, with a 1.77 MiB RSS delta and stable full-output checksum.
