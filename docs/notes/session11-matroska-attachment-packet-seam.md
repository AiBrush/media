# Matroska attachment preservation across the packet seam

**Goal.** Preserve the exact ordered `AttachedFile` elements of an MKV when callers use the public
`demux()` result as the input to `mux()`, including ordinary media-track selection, without exposing an
attachment as a timed Matroska Block. The Session 11 regression subject is the real licensed
`scenarios/metadata/write_mkv_tags/03.mkv`: H.264 + AAC plus opaque JSON and JPEG attachments, the latter
also projected by ffprobe and our probe surface as an attached-picture MJPEG stream.

**Approach.** Add an optional, immutable container-side-data bundle to `TrackInfo`. A Matroska demux shares
the same ordered bundle of complete opaque `AttachedFile` payloads on every declared track, so selecting
any ordinary media track naturally carries the container metadata through the existing packet descriptor.
Attachment projections additionally carry their exact ordinal. MKV muxers collect and exact-deduplicate
the shared bundle before authoring one Segment-level `Attachments` element, while projection descriptors
consume their source packet without creating a `TrackEntry` or Block. This is additive to driver API v1 and
does not change probe enumeration or the public media track count. A rejected alternative was placing the
bundle only on `Demuxer`: callers and existing packet-stream adapters commonly retain only `TrackInfo`, so
that shape would silently lose attachments at precisely the seam being repaired. Reconstructing attachments
from projected packets was also rejected because it loses filenames, MIME types, UIDs, unknown children,
duplicate children, and non-image payloads.

**Edge cases and failures.** The bundle preserves zero, one, or many payloads, declaration order, and
duplicate byte-identical files. Repeated copies of the same bundle on selected H.264, AAC, JSON, and JPEG
descriptors are merged exactly once; independent distinct bundles remain ordered by first selected track.
Attachments are accepted only for Matroska output: WebM raises a typed `CapabilityError` before emitting
bytes. Attachment-only input still fails because side data does not satisfy the requirement for a real
packet track. Fragmented MKV places attachments in the init Segment before Clusters. Buffered and streaming
muxers preserve backpressure; abort/error paths still cancel packet readers, attachment bytes have no host
resource lifetime, and no `VideoFrame`/`AudioData` ownership changes. Manual `addAttachment` input is
snapshotted immediately; an exact whole manual bundle and side-data bundle merge once, while partial matches
and intentional duplicates inside either bundle remain distinct. Metadata-only driver probes carry the same
bundle for TrackInfo consistency, but the public `MediaInfo` mapping drops it; attachment-free probes pay no
allocation, while attachment-bearing probes copy only the aggregate attachment payload once instead of
pinning the complete source file. The optional types add no eager runtime bytes and WebM code remains lazy.

**Validation and benchmark.** Fail-first product tests run the real four-stream MKV through public
`demux()` -> selected packet descriptors -> public `mux()` for buffered and fragmented MKV, compare every
opaque `AttachedFile` payload byte-for-byte and assert no attachment projection becomes a Block track.
Independent `ffprobe` must re-import H.264, AAC, JSON attachment, and attached MJPEG cover art with exact
payload hashes. WebM rejection, duplicate-bundle suppression, selection, cancellation, and the prepared and
Cluster-on-write mux paths are covered separately. The warmup-seven/nine-sample benchmark runs eight
distinct real WebM/MKV files (the four rotated MKVs plus AV1, VP9, tiny, and real-world WebM sources),
records wall and a separate sampled peak-RSS pass, and checksums every emitted byte.

The supplemental real-Chromium verifier runs the production build against the exact four-stream file and
checks native tag rewrite, same-container remux, full and selected demux-to-mux, prepared arrays, and
streaming packet inputs. Every route re-probes H.264, AAC, JSON, and attached MJPEG and retains attachment
payload SHA-256 values `94809623…` and `831953157…`. Run it with
`bun run verify:session11-webm-attachments-browser`. The clean-profile black-box row still reports one
video instead of two because that invocation does not preserve the public container-side-data fields; the
separate evidence and rejected-workaround record is in `session11-fair-harness-boundary-audit.md`.
