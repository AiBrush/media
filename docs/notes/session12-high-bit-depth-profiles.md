# Session 12 — truthful high-bit-depth profiles and VP9/AV1 levels

## Goal and truth boundary

Replace the static VP9/AV1 encode strings with exact profile/depth/level strings derived from the
post-filter output dimensions, requested/source frame rate, and the effective configured bitrate
bitrate. `VideoTarget.bitDepth` must select a codec profile that can actually carry 8-, 10-, or 12-bit
4:2:0 output, while the normal exact `VideoEncoder.isConfigSupported()` route remains the final host
capability oracle. A fully qualified source codec remains byte-for-byte unchanged only while depth,
geometry, cadence, and explicit bitrate facts remain unchanged; the implicit bitrate is capped to that
declared level. A changed fact preserves the codec family/depth intent but authors a newly qualified target
profile/level. Bare decode-token defaults and preload representative strings are deliberately unchanged.

## Chosen design

The pure encoder-config planner owns two ordered, immutable level tables. The VP9 table is the WebM
Project's 14-level 4:2:0 table and checks maximum luma picture samples, maximum width/height, luma display
sample rate, and bitrate. The AV1 table is Annex A's defined levels (2.0–6.3) and checks `MaxPicSize`,
`MaxHSize`, `MaxVSize`, `MaxDisplayRate`, and Main-tier bitrate; Professional profile 2 applies Annex A's
3× bitrate profile factor. Level selection uses the actual configured bitrate, including the implicit
quality-budget bitrate; an implicit value above the largest envelope is capped rather than contradicted.
Unknown cadence selects the highest defined level because inventing 30 fps would under-declare VFR/high-rate
output. VP9 uses profile 0 for 8-bit and
profile 2 for 10/12-bit (`vp09.<profile>.<level>.<depth>`). AV1 uses Main profile 0 for 8/10-bit 4:2:0 and
Professional profile 2 for 12-bit (`av01.<profile>.<seq_level_idx>M.<depth>`). We reject requests outside
the defined tables instead of advertising an under-level string. The rejected alternative was retaining
one low default and trusting the encoder to rewrite it: that makes `isConfigSupported()` probe the wrong
configuration and can author container metadata that contradicts the produced sequence.

Primary facts:

- [WebM VP9 levels](https://www.webmproject.org/vp9/levels/) defines the 14 luma size/rate/bitrate and
  width/height limits used here.
- [WebM VP9 profiles](https://www.webmproject.org/vp9/profiles/) assigns 8-bit 4:2:0 to profile 0 and
  10/12-bit 4:2:0 to profile 2.
- [AV1 Annex A](https://aomediacodec.github.io/av1-spec/av1-spec.pdf) assigns 8/10-bit 4:2:0 to Main
  profile 0, requires Professional profile 2 for 12-bit, defines the size/rate tables, and gives profile
  2 a 3× Main-tier bitrate factor.
- [AV1 ISOBMFF binding](https://aomediacodec.github.io/av1-isobmff/v1.3.0.html) defines the mandatory
  profile, `seq_level_idx`, tier, and bit-depth codec-string fields.

## Pixel-depth and lifecycle model

This change configures encoders; it never restamps frames or changes packet order. B-frame DTS/PTS,
open-GOP behavior, and VFR timestamps therefore remain owned by the existing demux/retime/mux seams.
An 8-bit sample is exactly representable by a 10- or 12-bit encoder, and a 10-bit sample is exactly
representable by a 12-bit encoder, so 8→10/12 and 10→12 are classified as encoder widening with no pixel
copy. A 10/12→8 request uses the existing one-frame-at-a-time canvas-backed RGBA8 transform. A 12→10
request is a typed capability miss because the package has no proven 10-bit pixel conversion stage.
Every current crop/resize/pad/rotate/flip/colorspace/tonemap filter and the general VPx alpha merge/split
path is treated conservatively as an 8-bit pixel boundary; a high-depth source targeting high depth through such a boundary rejects rather than
silently discarding precision, while an 8-bit source may still filter and widen at the encoder. FPS-only
retiming is not a pixel boundary. The stream transform holds one reusable canvas plus the backpressured
output frame, closes each consumed input exactly once, closes an output that cannot be enqueued, and
propagates cancellation/abort through the existing stream graph. No full-frame sequence buffer is added.

VP8 remains 8-bit only. H.264 10/12-bit output and HEVC 12-bit output remain typed misses: although AVC
High10 profile 110 has a known identifier, this repository does not yet have an independently proven
browser encode plus mux/reimport path for it. HEVC Main10 keeps its existing exact string and host probe.
The software VPx/AV1 tails stay honestly decode-only and 8-bit-only; these strings do not manufacture a
software encoder.

Alpha preservation keeps the existing VP8/VP9-only policy. VP9 profile 2 may carry the colour stream at
10/12-bit; the separate alpha encoder receives the same high-depth config and exactly widens its 8-bit
alpha luma. AV1/H.264/HEVC alpha requests remain typed misses.

## Failure modes and validation

Invalid depths and non-finite/non-positive rate facts raise `InputError`. A family/depth mismatch,
undefined level envelope, 12→10 conversion, or precision-losing high-depth filter graph raises
`CapabilityError` before frame consumption. The normal router still raises a typed miss when the browser
rejects the exact generated config.

Fail-first tests cover 720p, 1080p60, 4K, and 8K level boundaries; post-rotation dimensions; explicit
bitrate promotion; 8/10/12 VP9 and AV1 profile selection; omitted-codec family preservation; invalid and
unsupported depths; no-filter widening/downconversion; and the 8-bit filter-boundary lifecycle
classification (including fps-only retiming). A fresh multi-sample benchmark measures pure config
planning over the complete boundary matrix and records median/p95 time, operations per second, checksum,
and a positive process-heap sample using the repository's accepted benchmark pattern. Browser follow-up must probe
and encode/reimport each exact high-depth config on a host that reports it supported; unsupported hosts
remain truthful typed misses rather than blocking the pure planning gate.

## Fresh focused evidence

- `bun test src/api/codec-pipeline.test.ts src/api/video-stream-plan.test.ts src/api/video-two-pass.test.ts`:
  **191/191 green** before the additional alpha error-lifecycle matrix, including effective-bitrate levels,
  unknown-cadence upper envelopes, qualified-source re-levelling, high-depth VP9 alpha, and disjoint AV1
  alpha rejection.
- Strict production and test TypeScript: green. Biome on all owned implementation/tests/docs: green.
- `bun scripts/bench-session12-high-bit-depth-profiles.ts --check` (Bun 1.3.14, 5 warmups, 21 fresh
  samples, 10,000 iterations/sample): profile/level config matrix median **48.858 ms**
  (**3,274,777 plans/s**, p95 53.869 ms, 0.89 MB positive process-heap sample); depth/filter/alpha lifecycle
  matrix median **3.233 ms** (**52,575,959 plans/s**, p95 3.732 ms, 1.05 MB positive process-heap
  sample); public encode-route guards median **0.454 ms** (**132,085,856 plans/s**, p95 0.585 ms,
  1.00 MB positive process-heap sample). The route guard proves declared `fit`, `bitDepth`, `bitrateMode`,
  `twoPass:true`, and alpha intent cannot take the packet-copy shortcut, while `twoPass:false` remains a
  no-op. Geometric mean: **28,331,859 plans/s**; exact checksum `-502217872`; no regression against the
  committed baseline.
