# MP4/MOV packet truth: auxiliary tracks and AVC intra pictures

Session 11 reduced the remaining packet-oracle failures to two independent facts that ISO-BMFF
sample-table enumeration did not yet expose:

- QuickTime files can carry packet-bearing non-audio/video `trak`s such as `tmcd`. Probe already
  enumerated those tracks, but packet-info counted only decodable AV tracks and therefore omitted a
  real source packet.
- An H.264 `stss` table identifies sync/random-access samples, but real demux tools can additionally
  report a non-IDR access unit as a key picture when its primary slice is I or SI. Treating `stss` as
  the complete picture-type oracle therefore under-reported scene-cut intra frames.

## Design

Non-media tracks remain excluded from decode and mux paths. Full and packet-info movie parses retain
their sample tables, however, and packet-info merges AV and non-media tracks by `moov`/`trak` order.
That makes each packet's `trackIndex` refer to the corresponding returned track without inventing a
decoder configuration for timecode or metadata.

For AVC packet reporting, `stss` remains authoritative for declared sync samples. Samples not listed
in `stss` are inspected using the `avcC` NAL-length size: the first VCL NAL's Exp-Golomb-coded
`slice_type` is parsed, and I/SI pictures are added to the reported key-picture set. Malformed or
truncated NALs are never promoted. In-memory sources use bounded batches of zero-copy sample views;
I/O-backed sources use the existing bounded read-window planner. Peak working memory therefore stays
bounded independently of source duration.

## Validation

- The real ffmpeg-authored `mov-tmcd-copy.mov` fixture must expose all 232 packets: 120 video, 111
  audio, and one four-byte `tmcd` packet at its declared stream index.
- AVC access-unit unit tests cover IDR, I, SI, P/B, non-VCL prefixes, emulation-prevention bytes, and
  malformed lengths with 1-, 2-, and 4-byte NAL lengths.
- The rotated two-hour H.264 corpus is compared against independently baked ffprobe packet truth in
  the black-box browser harness.

Fresh nine-sample local benchmark (`bun run bench-session11-mp4-packet-truth`): 250,000 AVC
classifications plus all 232 packets from the real MOV fixture completed in a 7.001 ms median with a
4.05 MiB measured RSS delta. The selected 725 MiB/two-hour rotation produced its full 535,606-row
table in 263.1 ms and reported exactly 1,941 video key pictures (the 1,680 declared sync samples plus
261 non-IDR intra pictures).

## Baked-base discrepancy

All three rotated two-hour files pass the black-box golden-packet oracle after slice classification.
The baked base still reports “214646 packets had a size mismatch,” identically before and after this
change (exported Chromium results at 19:31, 22:21, and 22:23). An independent fresh ffprobe walk of
that exact base file proves 553,501/553,501 packets, per-stream counts 216,000 + 337,501, zero size
mismatches in sample order, zero key-flag mismatches, and exact first/last timelines. The product must
not reorder or falsify 214,646 correct sample sizes to match a stale/misaligned baked vector; the
black-box golden/output alignment needs regeneration through its own independent tooling.
