# WebM / MKV Driver

> Shard S24 · benchmark families: **demux, mux** · docPath: `docs/drivers/webm-mkv.md`
> Owned code: `src/drivers/webm/*.ts` — `ebml.ts`, `ebml-write.ts`, `h264-sps.ts`,
> `video-codec-qualification.ts`, `webm-driver.ts`, `webm-mux-driver.ts`, `webm-sniff.ts`.
>
> This document is the **target spec** (the best design) plus an **honest delta** against today's
> code — not a description of the current implementation. Every claim traces to a `path:line`
> citation in the owned code or to a cited external source. Measured numbers are rescued from
> `docs/measured-evidence.md` (cited `(measured-evidence.md)`); anything not verifiable is marked `UNVERIFIED`.

## 1. Purpose & scope

This shard is the single **container driver for the EBML/Matroska family** — WebM (the
VP8/VP9/AV1 + Opus/Vorbis subset) and full Matroska (`.mkv`/`.mka`, adding H.264/HEVC/AAC/MP3/FLAC/
PCM/AC-3 and attachments). It is pure byte plumbing in TypeScript: it turns container bytes into
`TrackInfo` + timed `Packet`s (`demux`), and turns encoded packet streams back into a WebM/MKV byte
stream (`mux`). It **never decodes, encodes, or filters** a single sample; codec work is downstream
at the WebCodecs/WASM tiers, which this driver feeds by surfacing the exact `codec` string plus the
codec-private `description` a decoder needs.

Benchmark families served (per `docs/architecture/COVERAGE.md`): **demux** and **mux**. The same driver object
(`WebmDriver`, `webm-driver.ts:2285`) also underpins four other families whose *runner* logic lives
in other shards but whose container work is here:

- **probe** — `WebmDriver.probe` (`webm-driver.ts:2291`) via the bounded metadata prefix ladder
  (`readMetadataInfo`, `webm-driver.ts:1842`), never reading Clusters when header declarations suffice.
- **remux / trim** — `WebmDriver.streamCopy` (`webm-driver.ts:2323` → `streamCopyWebm`,
  `webm-driver.ts:2110`), a driver-native container→container copy with keyframe-aligned trim.
- **streaming-output** — fragmented/CMAF WebM (`fragmentWebm`, `ebml-write.ts:1380`; the bounded
  `WebmStreamingMuxer`, `ebml-write.ts:1413`), ADR-091.
- **metadata** — Matroska attachments and `Colour` preservation carried through the demux→mux seam.

Selective registration: the whole driver registers as `WebmModule` (`webm-driver.ts:2333`); a
mux-only proxy `WebmMuxOnlyDriver` (`webm-mux-driver.ts:26`) exists so output-only callers pull the
EBML writer without importing the parser/probe (ADR-290, lazy default registration).

Measured standing (fresh, `(measured-evidence.md)`): `demux/realworld_mdn_flower_webm` **won** 2.305 ms vs
6.695 ms fastest rival, `vp8_720p_10s` 2.405 vs 12.220, `size_large_large_vp9_1080p_120s` 81.595 vs
155.080 — all via payload-free `Demuxer.packetTable()`. `mux/opus_to_webm_audio` 5.765 ms vs
mediabunny 7.540 vs ffmpeg.wasm 15.805; `mux/flac_to_mkv_audio` 2.725 vs 6.420 vs 9.755;
`swap_opus_to_mkv` +8% (653 vs 606). Small standing losses: `seek_mkv` 21.5 vs 20.1, `seek_av1` 24.5
vs 22.5 (moov/index-bound, see §5).

## 2. Spec & references

Governing standards (every external reference linked):

- **EBML** — IETF RFC 8794, the binary grammar Matroska/WebM are built on: element =
  `ID(vint) · size(vint) · data`, variable-length integers, and the all-ones "unknown size" vint used
  by live/streamed Segments and Clusters. <https://www.rfc-editor.org/rfc/rfc8794.html>
- **Matroska** — IETF RFC 9559 (the Matroska Media Container) and the authoritative element registry:
  `Segment`, `SeekHead`, `Info` (`TimecodeScale`/`Duration`), `Tracks`/`TrackEntry`, `Cluster`,
  `SimpleBlock`, `BlockGroup`/`Block`/`ReferenceBlock`/`BlockAdditions`/`DiscardPadding`, `Cues`,
  `Attachments`/`AttachedFile`. <https://www.rfc-editor.org/rfc/rfc9559.html> ·
  <https://www.matroska.org/technical/elements.html>
- **Matroska codec mappings** — the `CodecID` → codec vocabulary (`V_VP9`, `V_AV1`,
  `V_MPEG4/ISO/AVC`, `V_MPEGH/ISO/HEVC`, `A_OPUS`, `A_VORBIS`, `A_AAC`, `A_PCM/*`, …) and what each
  `CodecPrivate` carries. <https://www.matroska.org/technical/codec_specs.html>
- **WebM** — the VP8/VP9/AV1 + Opus/Vorbis Matroska subset, plus WebM's VP9 `CodecPrivate`
  feature-TLV `[id,len,payload]` list (distinct from ISO `vpcC`).
  <https://www.webmproject.org/docs/container/> · <https://www.webmproject.org/vp9/mp4/>
- **AV1** — the AV1 Codec ISO Media File Format Binding (`av1C` / AV1CodecConfigurationRecord, shared
  verbatim as Matroska AV1 `CodecPrivate`) and the AV1 bitstream sequence-header syntax.
  <https://aomediacodec.github.io/av1-isobmff/> · <https://aomediacodec.github.io/av1-spec/>
- **H.264 / codec config** — ISO/IEC 14496-10 (SPS VUI `max_num_reorder_frames`) and 14496-15
  (`avcC`/`hvcC` records that Matroska stores verbatim in `CodecPrivate`).
  <https://www.iso.org/standard/83336.html>
- **Opus** — RFC 6716 (TOC/frame-count packet framing, used for exact sample counting) and RFC 7845
  (`OpusHead`, pre-skip). <https://www.rfc-editor.org/rfc/rfc6716.html> ·
  <https://www.rfc-editor.org/rfc/rfc7845.html>
- **Video colour** — ITU-T H.273 code points for Matroska `Colour` primaries/transfer/matrix.
  <https://www.itu.int/rec/T-REC-H.273>
- **W3C WebCodecs** — `EncodedVideoChunk`/`EncodedAudioChunk` (PTS-only, no DTS) and
  `VideoDecoderConfig`/`AudioDecoderConfig` (`codec` + `description`), the seam this driver wraps.
  <https://www.w3.org/TR/webcodecs/>
- **WHATWG Streams** — `ReadableStream`/`desiredSize` backpressure and `AbortSignal` cancellation.
  <https://streams.spec.whatwg.org/>

OSS exemplars (studied; §3/§5 note where the target design should match or beat them):

- **mediabunny** — a pure-TS in-browser muxer/demuxer; its Matroska module is the closest peer.
  `src/matroska/ebml.ts`, `src/matroska/matroska-demuxer.ts`, `src/matroska/matroska-muxer.ts`,
  `src/matroska/matroska-misc.ts`. <https://github.com/Vanilagy/mediabunny>
- **web-demuxer** — Bilibili's FFmpeg-in-WASM demuxer for WebCodecs; the "wrap libavformat" baseline
  this driver deliberately avoids (no WASM on the demux path). <https://github.com/bilibili/web-demuxer>

Where we beat mediabunny: mediabunny's demuxer walks `Cues`/`SeekHead` for random access but builds
host `EncodedChunk` objects per packet; our payload-free `packetTable()` (`webm-driver.ts:2315`) wins
the demux rows by never constructing those objects `(measured-evidence.md)`. Where mediabunny is ahead today:
it **has** a `Cues`/`SeekHead` seek index, so its large-file seek does not read the whole file — our
gap in §5 (`seek_mkv`/`seek_av1` losses).

## 3. Target design

### 3.1 Data model & layering

Four layers, bottom-up:

1. **EBML primitives** (`ebml.ts`, read; `ebml-write.ts:113-303`, write). Read side: `readVint`
   (`ebml.ts:18`, `keepMarker` distinguishes IDs from sizes; all-ones size → `-1` "unknown size",
   `ebml.ts:41`), the lazy `elements()` generator (`ebml.ts:47`) yielding `{id,dataStart,dataEnd,
   complete,unknownSize}` (`ebml.ts:7-15`), and typed readers `readUint`/`readInt`
   (sign-extending, `ebml.ts:78-87`)/`readFloat`/`readAscii`/`findChild`. Write side: `vintBytes`
   (`ebml-write.ts:148`, the exact inverse of `readVint`), `element`/`elementHeader`, and a
   single-pass pre-sized `ByteWriter` (`ebml-write.ts:253`) that plans total length then writes once
   (no recopy cascade).
2. **Matroska semantics** — parse (`parseWebm`, `webm-driver.ts:1023`; `parseTrackEntry`,
   `webm-driver.ts:293`; `parseAttachments`, `webm-driver.ts:405`; block/lacing decode
   `blockFrames`/`laceSizes`, `webm-driver.ts:683`/`628`) and serialize (`writeWebm`,
   `ebml-write.ts:1190`; `trackEntryElement`, `ebml-write.ts:845`; `buildBlockTimeline`,
   `ebml-write.ts:418`; `planClusters`, `ebml-write.ts:1137`).
3. **Codec qualification** — `video-codec-qualification.ts`: VP9/AV1 profile/level/depth strings from
   either `CodecPrivate` or the first key access unit, plus H.264 DTS depth from the SPS
   (`h264-sps.ts`). This is the only place a codec token is minted.
4. **Driver seam** — `WebmDriver` (`webm-driver.ts:2285`) implementing `ContainerDriver`
   (`contracts/driver.ts:411`): `probe`/`demux`/`streamCopy`/`createMuxer`, plus `WebmMuxer`
   (`ebml-write.ts:1669`) and `WebmStreamingMuxer` (`ebml-write.ts:1413`).

The internal `WebmTrack`/`WebmInfo`/`WebmFrame` shapes (`webm-driver.ts:188-235,591-599`) are the
private model; the public seam is always `TrackInfo` + `Packet` (`toTrackInfos`, `webm-driver.ts:1649`).
Frame bytes are **no-copy views** into the parsed source buffer (`readBytes`, `webm-driver.ts:238`;
`bytes.subarray`, `webm-driver.ts:716`); only retained side data (attachment payloads) is copied
(`.slice()`, `webm-driver.ts:1654`) so a kept `TrackInfo` does not pin the whole file.

### 3.2 Capability routing (WebCodecs → GPU → WASM, miss-only)

The container driver is **codec-agnostic** and names no backend. Its routing contribution is to
publish, per track, the exact `config.codec` + `config.description` the router probes with
`VideoDecoder.isConfigSupported`:

- H.264/HEVC/AAC/Vorbis/FLAC/Opus: `CodecPrivate` **is** the `description` (`avcC`/`hvcC`/ASC/Xiph
  headers/`OpusHead`), surfaced verbatim (`webm-driver.ts:363-374`, `toTrackInfo` config
  `webm-driver.ts:1606-1625`). The router then expands `h264`→`avc1.PPCCLL` etc. from the record —
  the driver deliberately does **not** pin a profile string (`webm-driver.ts:141-149`).
- VP9/AV1: qualified to an exact `vp09.PP.LL.DD` / `av01.P.LLT.DD` string from `CodecPrivate`, else
  from the first key frame's sequence header (`qualifyWebmVideoCodec`, `video-codec-qualification.ts:737`).
  When neither proves profile/depth, the token is the **fourcc-only miss** `vp09`/`av01`
  (`webm-driver.ts:1162-1166`, config default `webm-driver.ts:1612-1614`) so the router returns a
  typed `CapabilityError` instead of silently mis-probing 8-bit profile 0 `(measured-evidence.md, ADR-276)`.

Hardware WebCodecs first, GPU/WASM only on a miss, is enforced downstream; the driver's job is to
never lie about what the stream is. No heavy WASM is imported here on any path — demux is pure TS,
beating web-demuxer's libavformat-in-WASM baseline on both bundle and small-file latency.

### 3.3 Edge cases

**B-frames.** Matroska stores blocks in **decode** order and each `SimpleBlock` carries **only** a
presentation timecode — there is no DTS/`ctts` (`ebml-write.ts:14-15,361-368`). On demux, DTS is
reconstructed from the H.264 SPS VUI `max_num_reorder_frames` (`h264MaxNumReorderFramesFromAvcC`,
`h264-sps.ts:14`; applied `webm-driver.ts:375-378`) and projected as `Packet.dtsUs` by sorting the
PTS timeline and shifting by the reorder depth (`webm-driver.ts:1399-1402`). Tested reorder depths
0/1/2 `(measured-evidence.md)`. On mux, the block timeline is laid down in decode order — blocks sort by
`(dtsMs, trackNumber)` while the written `SimpleBlock` timecode stays the PTS
(`buildBlockTimeline`, `ebml-write.ts:480`; `ChunkStruct.dtsUs`, `ebml-write.ts:361-367`). *Known
delta:* the `Duration`/`endMs` computation overshoots under B-frame reorder — `remux/
h264_bframes_1080p_mp4_to_mkv` reimports 10.134 s vs a 10.0 s golden `(measured-evidence.md)` (§5 item 3).

**VFR (variable frame rate).** `fps` is `1e9 / DefaultDuration` when the header declares it
(`webm-driver.ts:354`); MediaRecorder WebM omit `DefaultDuration`, so a fallback estimates cadence
from block timing `(count−1)/span` (`fpsFromBlockTiming`, `webm-driver.ts:905`) and snaps to an
integer cadence only within a ±2 % band to absorb capture jitter without forcing a genuinely
fractional rate (`snapFpsToCadence`, `webm-driver.ts:893`; `FPS_SNAP_REL_TOLERANCE`,
`webm-driver.ts:890`). Per-packet duration is always the gap to the next distinct PTS
(`frameDurationUs`, `webm-driver.ts:1981`), never a nominal constant, so VFR packets keep exact
spacing. Because no bounded header prefix can prove terminal cadence or a missing `Duration`, probe
returns `needs-terminal-scan` and the ladder jumps straight to a full read (`metadataReadiness`,
`webm-driver.ts:1819-1827`; ADR-279 terminal-timeline jump `(measured-evidence.md)`).

**Seek.** Trim/seek is keyframe-aligned by scanning decoded frames: `effectiveCopyRange`
(`webm-driver.ts:2030`) snaps the start back to the video keyframe at/before the requested time
(`firstVideoKeyframeAtOrAfter`, `webm-driver.ts:2013`; `videoDecodeStartUs`, `webm-driver.ts:1958`)
and clamps the end to source duration. *Gap:* there is **no `Cues`/`SeekHead` index parsing** — the
driver reads the entire file for demux/seek (`readAll`, `webm-driver.ts:2303`), which is why
`seek_mkv`/`seek_av1` lose small margins to mediabunny's index-based seek (§5 item 1).

**Cancel.** Every read and emission is `AbortSignal`-threaded: `assertNotAborted`
(`webm-driver.ts:1918`) guards read boundaries, `readStreamAll` cancels the underlying reader on
abort (`webm-driver.ts:1701-1704`), `streamCopyWebm` re-checks between packets
(`webm-driver.ts:2149,2177`), and `packetStream`'s `pull` errors the controller on
`signal.aborted` (`webm-driver.ts:2229-2231`).

**Frame lifetime (`close()` exactly once).** **Not applicable to this layer.** A container driver
produces **encoded** `Packet`s wrapping `EncodedVideoChunk`/`EncodedAudioChunk`
(`webm-driver.ts:2242-2244`), which are immutable GC-managed host objects with no `close()`; it
never constructs a `VideoFrame`/`AudioData`. The lifetime invariant it *does* owe: packet `data` is a
view into the whole-file buffer, so a retained packet pins the entire source — the target design
copies packet bytes at the sink or bounds retention (relevant to the `aac_to_opus_webm` peak-memory
loss, `(measured-evidence.md)`; §5 item 6).

**Backpressure.** `packetStream` is a `highWaterMark: 0` `ReadableStream` whose `pull` emits a
bounded batch (≤ 32 packets / ≤ 128 KiB, `webm-driver.ts:2215-2216,2225-2227`), so a slow consumer
is never overrun. The **streaming** muxer is demand-gated: `WebmStreamingMuxer.#enqueue` awaits
`#waitForDemand`, which parks on `controller.desiredSize ≤ 0` and is released by the readable's
`pull` (`ebml-write.ts:1618-1638`), holding peak output to one Cluster + one packet per reader. *Delta:*
the non-streaming `WebmMuxer` buffers **all** packets before serializing on `finalize`
(`ebml-write.ts:1762,1765-1791`), and even `{ fragmented: true }` on `WebmMuxer` first buffers every
chunk then calls `fragmentWebm` (`ebml-write.ts:1779-1782`) — only `WebmStreamingMuxer` is truly
bounded (§5 item 5).

### 3.4 Muxing model & preservation invariants

- **Definite sizes throughout** — every payload is built first, then length-prefixed, so output is
  fully seekable and re-parses with `parseWebm` (the round-trip oracle, `ebml-write.ts:9-10`).
  Fragmented output instead writes an **unknown-size** `Segment` (`SEGMENT_UNKNOWN_SIZE`,
  `ebml-write.ts:1226`) with live top-level Clusters (ADR-091).
- **Cluster planning** — blocks accumulate greedily while their PTS span stays within the signed
  int16 `SimpleBlock` relative-timecode range (`MAX_CLUSTER_REL_MS = 30000`, `ebml-write.ts:106`;
  `planClusters`, `ebml-write.ts:1137`), so a long stream never overflows the field and priming
  packets with small negative relatives remain legal.
- **Opus gapless** — `CodecDelay`/`SeekPreRoll`/`DiscardPadding` are projected to
  `leadingSamples`/`trailingSamples`/`totalSamples` on demux (`opusGapless`, `webm-driver.ts:1505`)
  and re-emitted as `OpusHead` pre-skip + `CodecDelay` + `SeekPreRoll` (80 ms,
  `ebml-write.ts:101,583-630`) + terminal `DiscardPadding` on mux, without touching payloads
  `(measured-evidence.md)`. Opus timestamps preserve sub-tick 48 kHz delay (`preserveSubTick`,
  `webm-driver.ts:706-709,1293`).
- **Colour** — Matroska `Colour` (range/primaries/transfer/matrix/chroma-siting) is preserved
  losslessly (`parseColor`, `webm-driver.ts:242`; `colorElement`, `ebml-write.ts:816`) because
  dropping it changes a decoder's YUV→RGB and chroma upsampling `(measured-evidence.md)`; H.273 code points
  bridge to `VideoColorSpaceInit` (`videoColorSpace`, `webm-driver.ts:1555`).
- **Attachments** — every `AttachedFile` payload is retained opaquely and re-wrapped byte-identically
  for stream-copy (RFC 9559 §5.1.6/§8), carried on `TrackInfo.containerSideData` +
  `containerProjection` so track selection can't silently drop it (`parseAttachments`,
  `webm-driver.ts:405`; `WebmContainerSideData`, `ebml-write.ts:934`). WebM (non-Matroska) output
  **rejects** attachments with a typed `CapabilityError` (`ebml-write.ts:959-964`).
- **Alpha** — declared `Video/AlphaMode=1` is proof only under strict conditions (single complete
  unsigned `1` in a complete `Video` master, `webm-driver.ts:323-333`); VPx alpha side data rides
  `BlockAdditions` `BlockAddID=1` (`readMainBlockAdditional`, `webm-driver.ts:862`;
  `blockAdditionsElement`, `ebml-write.ts:1056`).
- **Rotation** — Matroska CCW `ProjectionPoseRoll` ↔ clockwise display degrees
  (`clockwiseFromMatroskaRoll`, `webm-driver.ts:337`; `matroskaRollFromClockwise`,
  `ebml-write.ts:862`).

## 4. Current state

Everything described in §3 exists today. Precise map and the smells a coder must fix:

**God-files.**
- `webm-driver.ts` — **2341 lines** in one module mixing: the Matroska ID table
  (`webm-driver.ts:50-115`), codec map (`webm-driver.ts:150-186`), `TrackEntry`/attachment/colour
  parse, block+lacing decode (`webm-driver.ts:602-763`), fps estimation, Opus gapless
  (`webm-driver.ts:1477-1553`), `TrackInfo` projection, source I/O + the metadata prefix ladder
  (`webm-driver.ts:1684-1912`), trim-range math (`webm-driver.ts:1922-2078`), the browser-only
  `packetStream` (`webm-driver.ts:2199`), and the driver object. At least six modules (parse,
  blocks, timeline, source-io, trim, driver) are fused.
- `ebml-write.ts` — **1814 lines** fusing write primitives, the read↔write codec map
  (`ebml-write.ts:308`), block timeline + cluster planning, fragmentation, `WebmContainerSideData`,
  and **three** muxer classes (`WebmMuxer`, `WebmStreamingMuxer`, plus the plain function surface).

**Duplication / drift risk (layering smells).**
- **Two Matroska ID tables**: `ID` (`webm-driver.ts:50-115`) and `EBML_ID` (`ebml-write.ts:31-93`)
  hand-maintained separately — any new element must be added in both.
- **Two inverse codec maps**: `mapCodec` (`webm-driver.ts:178`) reads `A_AC3`/`A_EAC3`/`A_DTS`/
  `A_TRUEHD`/`A_MPEG/L2` but `toCodecId` (`ebml-write.ts:308`) cannot **write** ac-3/eac-3/dts/
  truehd/mp2 — an asymmetric, silently-lossy map (§5 item 7).
- **Reorder/DTS timeline triplicated**: the `presentationTimeline` + `dtsUs` computation is
  re-implemented in `packetMetadataRows` (`webm-driver.ts:1387-1402`), `packetPayloadRows`
  (`webm-driver.ts:1434-1444`), and `packetStream` (`webm-driver.ts:2217-2266`).
- **Two `BitReader` classes**: `h264-sps.ts:170` and `video-codec-qualification.ts:237`.
- **Duplicated Opus constants**: `OPUS_SAMPLE_RATE`/`OPUS_FRAME_SAMPLES` (`webm-driver.ts:119-124`)
  vs `OPUS_SAMPLE_RATE`/`OPUS_SEEK_PREROLL_NS` (`ebml-write.ts:100-101`).

**Functional gaps.**
- **No `Cues`/`SeekHead` parsing** — neither ID appears in the read table; demux/seek always
  `readAll` the whole file (`webm-driver.ts:2303`). Metadata is assumed to sit at the Segment head
  (`webm-driver.ts:4-5`); a legal `SeekHead`-referenced Tracks-after-Clusters layout is unhandled.
  `UNVERIFIED:` whether the current corpus contains a Clusters-first MKV — no fixture proves the
  head-only assumption fails, but nothing proves it holds either.
- **Mux never laces** — `FlagLacing=0` and one `SimpleBlock` per packet always
  (`ebml-write.ts:850,1095-1106`); a laced source round-trips to unlaced blocks (payloads preserved,
  block layout not byte-identical).
- **Demux packet emission is not Node-validated** — `packetStream` throws `CapabilityError` without
  WebCodecs and the emission body is `v8 ignore`d (`webm-driver.ts:2204-2211`); only pure frame
  extraction (`demuxWebm`) runs in Node.

**Positives (keep).** There is **no module-global mutable state / cache** — the module-level bindings
(`ID`, `CODEC_MAP`, prefix-window arrays `webm-driver.ts:128-139`) are all `const`, so the driver is
re-entrant and worker-safe. Frame lifetime is clean: side data is copied once (`webm-driver.ts:1654`),
packet bytes are zero-copy views. The metadata ladder is measured and tight (8 KiB first window
ADR-258; 256 KiB unknown-remote crossover ADR-312; partial-keyframe qualification from 8 KiB
ADR-276 `(measured-evidence.md)`).

**Sniffing / registration.** `matchesWebm` (`webm-sniff.ts:4`) matches MIME `video/webm`/
`audio/webm`/`video/x-matroska`, extensions `webm`/`mkv`/`mka`, or the EBML magic `1A 45 DF A3`.
`WebmMuxOnlyDriver` (`webm-mux-driver.ts:26`) is the mux-only lazy proxy; `supportsMux`
(`webm-mux-driver.ts:17`) gates on `direction === 'mux'`.

## 5. Delta / punch-list

Ordered, each with a concrete acceptance test (oracle).

1. **Add a `Cues`/`SeekHead` seek index for range-based partial demux/seek.** Parse `Cues`
   (`0x1C53BB6B`) → `CuePoint`/`CueTrackPositions`, and follow `SeekHead` (`0x114D9B74`) so metadata
   after Clusters is reachable. Then `demux`/`seek` should range-read only the Cluster(s) covering the
   requested window instead of `readAll` (`webm-driver.ts:2303`). *Acceptance:* on a Cues-bearing
   1080p/120 s MKV, a seek to t=60 s issues a bounded range request (assert total bytes read ≪ file
   size) and returns the keyframe-aligned frame identical to the full-read path; `seek_mkv`/`seek_av1`
   medians beat mediabunny (currently 21.5 vs 20.1 / 24.5 vs 22.5 `(measured-evidence.md)`). Add a
   Clusters-first (SeekHead-referenced Tracks) fixture that probe currently cannot parse and assert it
   now probes correctly.

2. **Extract shared EBML/Matroska constants + primitives into one module.** Collapse the two ID tables
   (`webm-driver.ts:50-115`, `ebml-write.ts:31-93`), the two `BitReader`s (`h264-sps.ts:170`,
   `video-codec-qualification.ts:237`), and the Opus constants (`webm-driver.ts:119-124`,
   `ebml-write.ts:100-101`) into `src/drivers/webm/matroska-ids.ts` + a shared bit-reader. *Acceptance:*
   a test importing the shared table asserts `read`/`write` reference the *same* object for every
   element ID used on both sides (grep-guard: no second `0x1A45DFA3` literal in the tree); existing
   `ebml-write.test.ts`/`webm.test.ts` stay green.

3. **Fix the B-frame `endMs` overshoot.** `remux/h264_bframes_1080p_mp4_to_mkv` reimports 10.134 s vs a
   10.0 s golden `(measured-evidence.md)`. The end time must be `max(PTS + duration)` over the true presentation
   timeline, not a decode-order artifact (`buildBlockTimeline` end computation,
   `ebml-write.ts:457-482`). *Acceptance:* a Node oracle feeds a synthetic reorder-depth-2 stream
   (PTS/DTS diverging) and asserts the emitted `Info/Duration` equals the last-PTS + last-duration to
   the millisecond; the `h264_bframes` remux reimport reports 10.0 s within tolerance.

4. **Split the two god-files.** Carve `webm-driver.ts` into `parse.ts` / `blocks.ts` (lacing+DTS) /
   `source-io.ts` (the prefix ladder) / `trim.ts` / `driver.ts`, and `ebml-write.ts` into
   `ebml-primitives.ts` / `timeline.ts` / `muxer.ts` / `streaming-muxer.ts`. Deduplicate the
   triplicated `presentationTimeline`/`dtsUs` logic (`webm-driver.ts:1387,1434,2217`) into one
   `assignDecodeTimestamps(frames, reorderDepth)`. *Acceptance:* each new file ≤ ~400 lines; a single
   `packet-timeline.test.ts` covers the one shared DTS function; full gate (typecheck/lint/test) green
   with no behavior change (byte-identical mux output on the corpus).

5. **Make `WebmMuxer({ fragmented: true })` bounded-memory.** Today it buffers all chunks then calls
   `fragmentWebm` (`ebml-write.ts:1779-1782`); route it through `WebmStreamingMuxer`
   (`ebml-write.ts:1413`) so peak output is one Cluster. *Acceptance:* a streaming-output test muxes
   an N-fragment WebM through a `StreamTarget` and asserts peak retained bytes ≈ one Cluster (not the
   whole file), while output re-parses byte-for-byte against the buffered path.

6. **Bound packet-byte retention on the whole-file demux.** Packet `data` views pin the entire source
   buffer (`webm-driver.ts:716`); `aac_to_opus_webm` peaks 32.4 MB vs a 25.4 MB rival `(measured-evidence.md)`.
   Copy packet bytes at emission (or slice per-Cluster) so a consumed packet releases the file buffer.
   *Acceptance:* a benchmark asserts post-GC RSS for the transcode row drops below the leanest rival's
   peak; demux output stays byte-identical.

7. **Close the read↔write codec-map asymmetry.** `mapCodec` reads ac-3/eac-3/dts/truehd/mp2
   (`webm-driver.ts:150-186`) that `toCodecId` cannot write (`ebml-write.ts:308-335`). Either add the
   inverse write mappings (pass-through mux) or make `toCodecId` raise a *specific* typed
   `CapabilityError` naming the unsupported MKV codec at `probe` time, not silently. *Acceptance:* a
   round-trip test demuxes an AC-3-in-MKV and asserts `mux` either reproduces `A_AC3` or raises
   `capability-miss` with `codec: 'ac-3'` — never a generic failure.

8. **Optionally lace small audio packets on write.** Match FFmpeg/mediabunny block layout for many
   tiny Opus/AAC frames (EBML or fixed lacing) to shrink overhead. *Acceptance:* a laced-source
   round-trip reproduces the source's frames-per-block within one, and total Cluster overhead drops
   measurably vs the one-block-per-packet path; decode parity unchanged.

## 6. Open questions

Each seeds a decision record (`docs/decisions/`):

1. **`Cues`/`SeekHead` support scope.** Do we parse a full seek index (range-read Clusters) or keep
   whole-file demux and only add `SeekHead` so head-anchored parsing survives Clusters-first files?
   Trade-off: index code + a partial-read source contract vs the current simplicity. Blocks §5 item 1.

2. **Exact end-time semantics under reorder / open-GOP / audio-tail.** What is the authoritative
   `Info/Duration`: `max(PTS+dur)` across tracks, the longest declared media track, or the gapless
   presentation count? Reconcile with the AAC-tail rule (`ebml-write.ts:457-469`) and the B-frame
   overshoot (§5 item 3).

3. **Should the WebM/MKV muxer ever lace?** Never lacing is simplest and lossless per-packet, but
   diverges from FFmpeg/mediabunny block layout and adds per-block overhead. Decide default + opt-out.

4. **Single shared Matroska element/codec registry vs per-side tables.** Confirm the read/write ID
   and codec maps should be unified (§5 items 2, 7), and where the canonical table lives (this shard
   vs a cross-container `contracts` registry).

5. **`WebmMuxer` vs `WebmStreamingMuxer` convergence.** Should there be one muxer with a
   bounded/unbounded mode, or do the buffered (seekable, definite-size) and streaming
   (unknown-size, live) layouts justify two classes? Blocks §5 item 5.

6. **Non-media / exotic Matroska codecs in MKV output.** Do we commit to pass-through mux of
   ac-3/eac-3/dts/truehd/mp2 (broaden `toCodecId`), or hold MKV output to the WebCodecs-decodable set
   and raise a typed miss? Blocks §5 item 7.

7. **HEVC-in-MKV platform boundary.** Valid `V_MPEGH/ISO/HEVC` output (CodecPrivate = `hvcC`,
   `hvc1.*` expansion) is byte-correct and ffprobe-verified but Chromium `<video>` reports zero
   intrinsic size `(measured-evidence.md, mux/edge_hevc_decode_mux_mkv)`. Record this as a platform-oracle
   boundary (NA_BROWSER), not a product defect, so the benchmark classifies it correctly.
