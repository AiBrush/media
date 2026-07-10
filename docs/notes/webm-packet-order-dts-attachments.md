# Matroska packet order, synthesized DTS, codec delay, and attachments

## Session 11 design note

The rotated `h264_in_mkv` corpus exposed four independent Matroska facts that the original WebM driver
collapsed: blocks from different tracks are interleaved in file/decode order, H.264 stores PTS but relies
on the SPS `max_num_reorder_frames` restriction to reconstruct DTS, `CodecDelay` shifts a track's exposed
timestamps, and Matroska attachments are declared streams even though they are not `TrackEntry` elements.
Independent `mkvinfo`, `ffprobe`, and H.264 `trace_headers` inspection confirms all four: the tested AVC
streams declare reorder depths 0, 1, or 2; one AAC stream declares a 21,333,333 ns codec-inherent delay;
and the attachment-bearing file contains an `application/json` attachment plus a valid 480x360 JPEG.

The implementation therefore keeps per-track frame arrays for the public `packets(trackId)` API, but
forms the packet-info table by stable source-byte order. For reordered H.264, it parses the standards-
defined SPS VUI bitstream restriction and maps decode-order access unit `i` to the already quantized,
sorted Matroska presentation clock at `i - max_num_reorder_frames`; leading access units whose DTS is
not declared retain their PTS, matching the typed `undefined => DTS equals PTS` contract. `CodecDelay`
is subtracted in nanoseconds and then quantized once to `TimecodeScale`, avoiding both floating-point
drift and a false whole-tick truncation. Attachments are appended after regular tracks in declared stream
order: non-image attachments become `nonMedia` probe entries, while a valid JPEG becomes an attached
MJPEG video entry and a single key packet backed by the original `FileData` view. Invalid or unsupported
image attachments remain honest non-media entries rather than fabricated decodable video.

Validation compares all four real H.264-in-Matroska packet lists byte-for-byte against independently
baked ffprobe goldens, including global order, size, PTS, DTS, keyframe, codec delay, and the attached
picture packet. A separate probe assertion covers the four-stream attachment file. The existing WebM,
VP8/VP9/AV1, alpha-side-data, lacing, and browser packet-stream tests remain the regression boundary.

