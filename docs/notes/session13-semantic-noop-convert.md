# Session 13 — source-aware semantic no-op convert

Decision: ADR-263. MP4 metadata-writer correction: ADR-264. Metadata-proved redundant track exclusion:
ADR-283.

## Goal

Make `convert()` recognize a request whose declared video/audio result is already exactly satisfied by
the source, then perform the normal driver-native container rewrite without opening a decoder, filter, or
encoder. This is not byte passthrough: the selected container driver must parse the input and author a
fresh output. The optimization is source-aware and applies to any compatible input, never to a fixture,
filename, hash, size, or benchmark scenario.

## Design

The eager convert router keeps its existing cheap exact-container-copy predicate. A second cheap predicate
identifies requests that *might* be semantic no-ops. Only those requests lazily load a small eligibility
module, call the already-routed container driver's metadata-only `probe()`, and compare the request with
the exact source track descriptors. A positive result enters the existing `streamCopy()` path, preserving
encoded packet payloads, DTS/PTS, codec-private data, B-frames, VFR cadence, and container metadata while
retaining the driver's existing bounded I/O, sink backpressure, and abort semantics.

Metadata proof is allowed only on a re-readable source. A `Source.kind === 'stream'` is single-use: probing
it and then opening the copy writer would consume it twice, so that shape stays on the ordinary codec path.
The pre-existing pure container-copy route needs no preliminary probe and remains available to streams.

Eligibility is deliberately proof-based. There must be exactly one decodable video track, no more than one
decodable audio track, and no additional/non-media tracks because the current re-encode graph selects only
the first A/V tracks. Requested codec families, coded geometry, zero display rotation, bit depth, alpha,
audio sample rate, and channel count must be equal when present. An unknown fact is a rejection, not a
guess. Frame-rate requests, bitrate/rate-control/CRF/two-pass, crop/pad/non-zero rotation/flip,
colorspace/tonemap, audio bitrate, DSP, actual track drops, and any actual geometry change remain on the full
decode/filter/encode path. The selected MP4 driver must expose its metadata-only probe and native copy
writer; otherwise behavior is unchanged.

Rejected alternatives: treating every explicit same-family codec request as copy is unsafe because the
source geometry, rotation, track count, or audio layout may differ. Probing by opening a demuxer would
create packet streams and lifecycle state merely to answer metadata; the existing bounded `probe()` hook
is both faster and safer. Reusing the input bytes directly would violate convert/remux integrity and is not
considered.

## Edge cases and ownership

- B-frame/open-GOP and VFR inputs keep their original encoded packet ordering and timing; explicit `fps`
  is never copy-eligible.
- Rotation metadata is normalized modulo 360; explicit `rotate: 0` is eligible only when the source's
  effective display rotation is also zero. A real rotation or normalization remains a pixel operation.
- Multiple, attached-picture, timecode, encrypted, or otherwise unproved tracks decline the fast path.
- A separate `containerProjection` track declines explicitly. `containerSideData` attached to the selected
  media track remains eligible because both the ordinary mux graph and native writer carry it with that
  same track; it does not create a track-count mismatch.
- Alpha discard is eligible only when absence is proved; alpha keep requires a proved source alpha plane
  in a codec family that can carry one.
- An explicit `audio:false` or `video:false` is eligible only when the same metadata proof contains zero
  tracks of that media type. A corresponding source track is a real drop and still declines.
- Aborting during probe or copy follows the existing `StageOptions.signal`; copy output remains a
  backpressured `ReadableStream`. No `VideoFrame` or `AudioData` is created, so frame ownership is
  unchanged.
- Single-use streams never enter source-aware proof. URL/range, bytes, Blob/File, and other re-readable
  sources may probe and then copy without source-lifetime ambiguity.
- A probe error, truncated source, or unsupported container remains a typed existing operation error; the
  optimization does not catch and downgrade it.

## Validation and benchmark

Unit tests cover each positive fact and every disqualifier, including source/profile family mismatch,
geometry mismatch, non-zero metadata rotation, VFR/fps, bit depth, alpha, audio layout, extra tracks,
rate control, transforms, and track drops. Public API tests prove the eligible route calls `probe()` then
`streamCopy()` without demux/codec work, propagates cancellation, and declines negative cases. Real MP4
tests compare source and output packet tables and payload hashes across ordinary H.264/AAC, B-frame, VFR,
and rotation-metadata corpus inputs. The focused benchmark uses at least five warm samples after warmup and
checks fresh output truth before recording wall time.

Fresh evidence: ten focused tests / 67 assertions pass. Across five real H.264 MP4 inputs, warmup two and
seven wall samples measure 0.080-1.628 ms medians; a separate three-sample RSS pass records 0.11-1.23 MiB
positive deltas. Packet rows and every encoded packet SHA-256 are identical, including B-frame DTS reorder
and VFR durations, and MP4 `colr` plus edit-list duration reimport exactly after ADR-264. The selected
4,376,205-byte product shape measures 2.136 ms median over 21 samples after three warmups. Qualified focused
browser evidence remains the close gate; the unrelated 1080x1920→1920x1080 metamorphic source remains a
real resize and is intentionally ineligible.

ADR-283 additionally validates the selected video-only VP9-alpha rotation with redundant `audio:false`.
The pre-gate now requests metadata proof instead of treating the selector as an unconditional mutation;
the post-probe predicate requires exactly zero audio tracks. Warmup-three/`n=21` measures 0.388 ms median
(MAD 0.038) locally versus the qualified pre-fix browser wall of 300.495 ms and the passing rival at 74.120
ms. The fresh 3,862-byte rewrite has SHA-256
`25dd20c3ed93ef38f371036c8b41b7f53523ca472658af59493d613f1dda9152`; all 60 color packets, all 60
alpha packets, track facts, keys, PTS, DTS, and durations match the 5,487-byte source exactly. Browser
leadership remains pending the central same-export rerun.
