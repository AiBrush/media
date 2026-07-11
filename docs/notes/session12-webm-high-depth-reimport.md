# Session 12 — truthful high-depth VP9/AV1 WebM reimport

## Goal and audited boundary

Qualify every WebM/Matroska VP9 or AV1 `VideoDecoderConfig` from container or coded-stream facts before
the codec router probes it. The current demuxer maps `V_VP9`/`V_AV1` to bare `vp9`/`av1`; the generic
normalizer then substitutes profile-0 8-bit strings, which is false for VP9 profile 2 and 10/12-bit AV1.
The WebM writer also copies `VideoDecoderConfig.description` without interpreting its origin: AV1's
`av1C` is the Matroska `CodecPrivate`, but an MP4 VP9 `vpcC` is not WebM's VP9 codec-feature list. The
local real WebM corpus is 8-bit. The pinned BSD-licensed Chromium `bear-av1-10bit.mp4` supplies real
10-bit AV1 packets plus an exact `av1C`; normative VP9 uncompressed-header and AV1 sequence-header
vectors cover 10/12-bit parsing. The Chromium BSD profile-2 VP9 WebM is the desired later real-browser
control, but this session's external download was unavailable after the sandbox escalation allowance was
exhausted, so no downloaded VP9-browser PASS is claimed here.

## Chosen design

A small pure-TypeScript WebM codec-qualification module owns four strict boundaries. First, it parses and
writes WebM's VP9 TLV `CodecPrivate` (profile, level, depth, optional chroma) and AV1's four-byte-or-longer
`AV1CodecConfigurationRecord`. Second, when private data is absent, it parses VP9's key-frame
uncompressed header or finds and parses an AV1 low-overhead sequence-header OBU. Third, it emits only a
fully qualified `vp09.PP.LL.DD` or `av01.P.LLT.DD`; VP9 level comes from a valid private declaration or
the minimum official envelope containing proven dimensions, cadence, and the whole-container bitrate
upper bound. Unknown cadence or bitrate selects level 6.2 instead of inventing 30 fps. Fourth, an
unqualifiable stream retains its canonical public family token but receives an invalid-for-probing
fourcc-only decoder string (`vp09`/`av01`), so the ordinary router returns a typed capability miss instead
of silently probing 8-bit profile 0. Valid private data always wins; malformed/truncated private data and
malformed coded headers raise typed `MediaError`/`InputError` values.

The rejected alternatives are changing the generic bare-token defaults globally (that seam is shared and
would not establish bitstream truth), trusting decoders to ignore a contradictory codec string, copying
MP4 `vpcC` bytes into WebM, guessing a 30 fps VP9 level, or scanning/decoding frames. The writer converts a
qualified VP9 string to WebM codec-feature metadata and preserves or synthesizes a valid AV1 record, so a
muxed high-depth track reparses to the same exact configuration.

## Timing, streaming, ownership, and failure model

Qualification reads bounded metadata and at most the first suitable coded packet per video track. It never
reorders, copies, decodes, or rewrites packet payloads; DTS/PTS, B-frame/VFR order, alpha side data, and
container timing remain in the existing demux/mux seams. Prefix probe still stops once complete `Tracks`,
duration/cadence facts, and one usable codec header are present. Full demux remains backpressured at the
packet stream, cancellation remains on the existing source read, and no `VideoFrame`/`AudioData` is
created or changes owner. CodecPrivate/header disagreement, reserved bits, illegal profile/depth pairs,
truncation, malformed OBU sizes, and impossible level envelopes fail typed before decode; unknown facts
never become a false 8-bit default.

## Validation and benchmark plan

Fail-first tests cover exact VP9 profile-2 10/12-bit feature records, VP9 specified key headers, AV1
profile-0 10-bit and profile-2 12-bit configuration/sequence records, reserved/truncated/mismatch errors,
unknown-cadence level 6.2, and no-default behavior. A real `bear-av1-10bit.mp4` mux-to-WebM-to-reparse test
preserves every coded packet byte and VFR timestamp while proving `av01.0.00M.10` survives in TrackInfo.
Existing real VP9/AV1 WebM probe/demux tests remain the 8-bit regression controls. The focused benchmark
uses the real AV1 record plus the complete specified-vector matrix with warmups, multiple fresh samples,
checksum consumption, and a separately positive process-heap sample.

Primary specifications:

- [WebM VP9 CodecPrivate feature format](https://www.webmproject.org/docs/container/#vp9-codec-feature-metadata-codecprivate)
- [VP9 bitstream specification](https://storage.googleapis.com/downloads.webmproject.org/docs/vp9/vp9-bitstream-specification-v0.7-20170222-draft.pdf)
- [AV1 bitstream and decoding process](https://aomediacodec.github.io/av1-spec/av1-spec/)
- [AV1 ISOBMFF configuration record](https://aomediacodec.github.io/av1-isobmff/v1.3.0.html)
- [Matroska AV1 mapping](https://www.ietf.org/archive/id/draft-ietf-cellar-codec-18.html#name-v_av1)
