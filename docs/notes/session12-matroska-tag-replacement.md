# Session 12 Matroska tag replacement

## Goal and truth before change

`writeMkvTags(bytes, tags)` is the random-access Matroska/WebM metadata step behind
`remux(..., { tags })`. Its input is one completed byte container and its output must contain exactly the
requested flat tag set. The old implementation appended another top-level `Tags` element, so prior global
and track-targeted `SimpleTag` values remained observable, repeated writes grew the file forever, and reader
order decided which conflicting value appeared. This is a container-structure defect; timed packets must
remain packet-copy data.

## Chosen design

Preflight the complete top-level `Segment` element walk before allocating output. Record every finite child
span and replace stale `Tags` spans with same-length EBML `Void` elements regardless of their `Targets` or
nested `SimpleTag` shape. Place at most one canonical `Tags` element into the first old Tags/available Void
span that can contain it plus exact Void padding. If no existing span fits, append it once at Segment end.
This offset-stable plan leaves Clusters, Cues, attachments, and all their Segment-relative positions fixed.
Any `SeekHead` entry for Tags is repointed to the canonical span, or voided when tags are cleared; a nested
SeekHead CRC is refreshed. Preserve every other span byte-for-byte and allocate the result once. A finite
Segment keeps its original size-VINT width when possible and widens only when an appended tag requires it;
an unknown-size Segment keeps its exact all-ones size field. Segment-level CRC-32, when present in its
required first-child position, is recomputed over the rewritten parent data with IEEE CRC-32 and
little-endian storage. An empty normalized request authors no `Tags` element.

The rejected alternative was key-by-key mutation inside existing `Tag` trees. A flat public record cannot
faithfully preserve or address arbitrary `Targets`, nested tags, duplicate names, languages, and defaults;
mutating some of those trees would retain stale values and make a second rewrite dependent on source order.
Whole-element replacement gives deterministic, idempotent semantics while leaving unrelated Segment
metadata opaque.

## Edge cases, ownership, and failures

Multiple `Tags` elements, multiple `Tag`/`Targets` trees, nested `SimpleTag`s, `Void`, cues, attachments, and
many Clusters retain their positions and order outside same-size replacement spans. A larger generation can
grow the Segment once; repeating that generation reuses its canonical Tags span exactly and does not grow.
Known-size Segment growth across a VINT boundary is legal and bounded. Unknown-size Segments are supported
when their child boundaries are finite and unambiguous. A truncated ID/size, a declared child past the
Segment boundary, an unsafe size magnitude, a malformed Tags `Seek`, a misplaced/malformed CRC-32, or an
unknown-size child raises `InputError('unsupported-input')` before output allocation; the writer never
guesses a schema boundary through encoded Block payload. B-frames, synthesized
Matroska DTS, VFR PTS, codec-private bytes, alpha side data, attachments, and packet bytes are copied without
interpretation. This synchronous byte rewrite creates no `VideoFrame`, `AudioData`, reader, or writable
resource; the enclosing remux runner remains responsible for stream collection, cancellation, backpressure,
and its post-rewrite abort check. Peak memory is one output plus the small canonical tag element and an
O(number-of-level-one-elements) span table.

## Validation and benchmark plan

The fail-first metamorphic matrix uses five checksum-pinned W3C/Chromium WebM files plus the existing real
attachment-bearing Matroska regression. An independent test-side EBML walker injects duplicate targeted tag
trees and verifies the output has exactly one canonical tag tree, then rewrites it again and requires exact
byte identity and a fixed size. Product packet re-import compares track config, PTS, synthesized DTS,
duration, key flags, alpha/discard-padding, every payload byte, and every attachment payload before/after.
Malformed finite sizes, unknown-size Segment support, ambiguous unknown-size children, CRC refresh, and
empty-tag clearing are typed branch gates. The warm multi-sample benchmark processes the five licensed real
fixtures, performs two replacement generations per sample, reparses every result, enforces the idempotent
size/byte bound, consumes a checksum, and records wall throughput plus separately sampled positive process
heap/RSS and retained-memory bounds.

## Result

The append implementation failed all nine fail-first cases: every repeat added another `Tags` element,
empty rewrites left stale trees, ambiguous unknown-size children were accepted, and Segment CRC became
stale. The offset-stable implementation passes 9/9 new replacement cases and the combined focused metadata
matrix passes 54/54. Across five licensed sources it preserves the exact packet/config/timing fingerprint;
the attachment regression separately preserves every opaque `AttachedFile` payload and projected stream.

`bun scripts/bench-session12-matroska-tags.ts --check` is green with three warmups and 15 fresh samples.
The confirmation median is 0.210 ms for three generations across five fixtures (590,465 rewritten bytes,
2,806.74 MB/s), with deterministic output SHA-256
`f6130829b5d88aba0d68cd30006ae7d47cefd5d0b435f65595be499126e8298b`. The separately retained-output
memory pass records positive 12,650,222-byte process-heap and 12,959,744-byte RSS deltas; after release and
forced collection, retained process heap is 77,352 bytes and retained RSS is 13,041,664 bytes, both below
the explicit 32 MiB bound.
