# Session 13 MP4 metadata-write design note

## Goal

Make a same-family `remux(..., { to: 'mp4' | 'mov', tags })` perform exactly one container rewrite when
the source is an ordinary, self-contained MP4/MOV. The output must re-import every requested tag while
preserving every encoded sample byte, codec configuration, track order, key flag, DTS, PTS, duration,
movie/media/edit clock, display transform, colour, pixel aspect, and clean aperture. The route must remain
operation-lazy and must not recognize a filename, digest, size, rotation, packet count, or tag value.

## Measured root cause and chosen approach

The MP4 driver advertises both `mp4` and `mov`, so the existing single-format metadata shortcut declines a
same-MP4 request. Public remux first parses every sample table, gathers every sample, authors a fresh
faststart movie, and then the metadata writer allocates another full movie to replace `moov/udta/meta/ilst`.
On the real 5,339,207-byte rotated source, warmup-three/`n=21` local public samples measure 3.098 ms median,
while the already-shipped direct tag writer measures 0.558 ms. The selected implementation materializes a
replayable MP4-family source once, asks a strict structural classifier whether direct relocation is safe,
and either rewrites its metadata directly or replays the exact bytes through the unchanged remux path.

The rejected alternative is to trust only the multi-format driver or MIME hint and always rewrite directly.
That would mishandle a caller-mislabeled QuickTime source, mixed pre/post-`moov` media, fragmented files,
absolute auxiliary/item offsets, or malformed top-level tails. A second rejected alternative is to optimize
only `ilst` construction; local profiling shows metadata atom authoring is sub-millisecond and cannot remove
the duplicate full sample projection and output copy.

## Eligibility and edge cases

Direct rewrite requires a complete top-level walk, exactly one `ftyp`, exactly one `moov`, at least one
`mdat`, and all media payloads wholly before or wholly after `moov`. Every `stco`/`co64` entry must be
structurally complete and point into a declared `mdat`; when `moov` grows, only the all-after shape receives
the uniform delta. Fragmented/indexed/absolute-offset structures (`moof`, `mvex`, `sidx`, `mfra`, `saio`,
`iloc`, compressed `cmov`) decline to the ordinary remux. Brand class must match exactly: non-`qt  ` ISO-BMFF
may go directly only to MP4, while `qt  ` may go directly only to MOV. Both cross-brand directions retain a
real remux. Unknown top-level boxes and existing non-tag `udta` children are preserved byte-for-byte.

The cheap relocation classifier is not the complete sample oracle. Before direct authoring, the selected
container driver runs ADR-251's full demux validation and closes immediately: `stsz`/`stsc` plus
`stco`/`co64` must place each complete sample inside a declared `mdat`. Thus a scalar chunk offset that is
inside media but too late for its first sample is rejected rather than blessed by the fast path.

B-frames, open GOP, and VFR require no retiming: the route never parses or reconstructs samples and only
relocates the `moov` metadata box, with chunk offsets patched by the exact byte delta. Multi-track,
multi-`mdat`, leading-empty edits, nonzero source clocks, 64-bit `co64`, and tail-`moov` layouts are covered
by the same structural rules. A 32-bit `stco` overflow remains a typed `MediaError`. Truncated or malformed
boxes decline the shortcut and retain the existing typed remux behavior. Encryption/auxiliary-offset shapes
decline until every protected absolute offset has an independent oracle.

The metadata operation already buffers its completed target; this route does not weaken backpressure. A
one-shot stream is materialized exactly once and replayed only from owned bytes on a decline. Abort is checked
before/after source collection and before/after synchronous rewriting. No decoder, encoder, `VideoFrame`, or
`AudioData` is created, so frame ownership is unchanged. Peak full-file storage falls from input + remux +
tagged output to input + tagged output on the accepted path.

## Validation and benchmark plan

The fail-first public test uses real MP4 fixtures spanning faststart/tail-`moov`, B-frames/VFR, AV1, and
multiple sizes. It compares a strict independent re-import of source/output: track configuration and exact
container clocks plus every sample payload, key flag, DTS, PTS, and duration. It also proves requested tag
readback and preservation of unrelated top-level bytes. Focused negative tests cover mixed media placement,
fragment/index/auxiliary offsets, `qt  `→MP4, malformed tables, abort, and one-shot replay on decline.

The committed benchmark uses at least five real MP4s, warmup five and `n=21`, alternates the public direct
route with an explicit full-remux-plus-tag control, consumes output checksums, and runs a separate peak-RSS
pass. Strict truth is checked before timing, never inferred from a checksum or loose duration tolerance.
Fresh same-export Chromium evidence remains required to close the speed-ledger row.
