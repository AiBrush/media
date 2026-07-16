# AVI Driver

> Shard S29. Owned code: `src/drivers/avi/*.ts` (`avi-driver.ts`, `avi-parse.ts`, `avi-mux.ts`,
> `avi.test.ts`). This document is the **target spec** (the best design) plus an **honest delta** vs the
> code that exists today. It is not a description of today's code.

## 1. Purpose & scope

The AVI driver is the container engine for Microsoft's RIFF `AVI ` format (`.avi`) and its OpenDML
AVI 2.0 extension (multi-`RIFF('AVIX')` segments, `indx` super-index). Like every container in this
engine it is **hand-written pure TypeScript on top of a RIFF walk** with **no browser dependency**
(ADR-002: "containers are ours"), so parse/validate/write run identically in Node, Workers, and the
main thread. It maps AVI's interleaved `movi` data chunks to and from the WebCodecs coded-unit seam
(`EncodedVideoChunk`/`EncodedAudioChunk`); it never decodes or encodes media itself — MJPEG, MPEG-4,
H.264, PCM, MP3, AAC all live behind the capability router.

Benchmark families served (per `docs/architecture/COVERAGE.md`, S29):

- **demux** — read `hdrl` (the `avih` main header + one `strl` per stream), then walk every `movi`
  LIST (including OpenDML `AVIX` tails), attributing each `##dc`/`##db`/`##wb` chunk to its stream
  with a derived PTS, and stream them as `Encoded*Chunk` packets. This same parser backs **probe**
  (header-only track facts: codec, dims/sample params, duration, fps).
- **mux** — accept `Packet`s (decode order) and author a single `RIFF('AVI ')` with `hdrl`/`movi`/
  `idx1`, splitting into OpenDML `RIFF('AVIX')` segments once a `movi` list passes a byte threshold.

AVI is a **decode-order, no-DTS, nominally-constant-frame-rate** container. That shapes every seam
below: there is no composition-offset table (no B-frame reorder metadata), no per-frame duration
(cadence comes from `strh` `dwScale`/`dwRate` or the `avih` `dwMicroSecPerFrame`), and keyframe truth
lives in the *index* (`idx1` `AVIIF_KEYFRAME` / OpenDML index length sign bit), **not** in the `movi`
chunk stream. Getting those three facts right — and honestly admitting where AVI cannot express what a
modern codec needs — is the whole job.

Coverage note (honest): there is **no committed runnable AVI case in the `media-test` corpus** today —
`demux/index.ts:43-44` records that AVI has "NO manifest asset and NO golden … so no runnable case can
point at [it] without fabricating an input." Acceptance today is the driver's own strict, can-fail
suite (`avi.test.ts`) on two real ffmpeg-authored fixtures plus a local mux micro-benchmark
(`scripts/bench-containers.ts`, geomean 226.0 MB/s, worst 123.6 MB/s, peak RSS 0.16 MB — measured-evidence.md_).
Closing that corpus gap is a delta item (§5).

## 2. Spec & references

Governing standards (every reference links):

- **Microsoft AVI RIFF File Reference (DirectShow).** The canonical AVI 1.0 grammar:
  `RIFF('AVI ')` → `LIST('hdrl')` (`avih` + per-stream `LIST('strl')` with `strh`+`strf`[+`strd`/
  `strn`]) → `LIST('movi')` → optional `idx1`; the `##db`/`##dc`/`##pc`/`##wb` chunk-id suffixes; and
  the rule that `strl` order fixes the stream number.
  <https://learn.microsoft.com/en-us/windows/win32/directshow/avi-riff-file-reference>.
- **`AVIMAINHEADER` (`avih`)** — `dwMicroSecPerFrame`, `dwTotalFrames`, `dwStreams`, `dwWidth`,
  `dwHeight`, `dwFlags` (`AVIF_HASINDEX = 0x10`).
  <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/api/aviriff/ns-aviriff-avimainheader>.
- **`AVISTREAMHEADER` (`strh`)** — `fccType` (`vids`/`auds`), `fccHandler`, `dwScale`, `dwRate`,
  `dwLength`, `dwSampleSize`, `rcFrame`.
  <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/api/avifmt/ns-avifmt-avistreamheader>.
- **`AVIOLDINDEX` (`idx1`)** — the 16-byte `AVIINDEXENTRY` (`ckid`, `dwFlags` with
  `AVIIF_KEYFRAME = 0x10`, `dwChunkOffset`, `dwChunkLength`). `dwChunkOffset` is conventionally
  relative to the `movi` list, but real files use both movi-relative and file-relative bases — see
  §5/§6. <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/api/aviriff/ns-aviriff-avioldindex>.
- **`BITMAPINFOHEADER`** (video `strf`) — `biWidth`, `biHeight` (may be negative for top-down DIB),
  `biCompression` (the video 4CC).
  <https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapinfoheader>.
- **`WAVEFORMATEX`** (audio `strf`) — `wFormatTag`, `nChannels`, `nSamplesPerSec`, `nBlockAlign`,
  `wBitsPerSample`, `cbSize`.
  <https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatex>.
- **RFC 2361 — WAVE and AVI Codec Registries.** The registered `wFormatTag` values the audio-codec
  mapper reads (`0x0001` PCM, `0x0003` IEEE-float, `0x0055` MP3, `0x2000` AC-3, `0x00FF` AAC, …).
  <https://www.rfc-editor.org/rfc/rfc2361>.
- **OpenDML AVI File Format Extensions v1.02 (AVI 2.0)**, OpenDML AVI M-JPEG File Format Subcommittee
  (Sept 1997). Defines multi-`RIFF('AVIX')` segments, `LIST('odml')`/`dmlh` extended header (grand
  total frame count), and the `indx` super-index + `ix##` standard field indexes for >1 GiB / >2 GB
  files. Commonly cited mirror: <http://www.jmcgowan.com/odmlff2.pdf>. UNVERIFIED: the exact mirror
  URL/edition was not fetched here; the structural claims below are cross-checked against ffmpeg and
  the Microsoft "AVI 2.0 index" note (`indx` super-index) on the AVI RIFF reference page above.
- **W3C WebCodecs** — the `VideoDecoderConfig`/`AudioDecoderConfig` and `EncodedVideoChunk`/
  `EncodedAudioChunk` seam the driver maps to. <https://www.w3.org/TR/webcodecs/>.

OSS exemplar to study & beat:

- **FFmpeg AVI (de)muxer** — the reference implementation.
  - Demuxer `libavformat/avidec.c`
    <https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/avidec.c>. Study `avi_read_header`
    (hdrl/strl parse), `avi_read_packet` (the chunk-by-chunk `movi` state machine),
    `avi_load_index` (idx1 → per-stream index), `read_odml_index` (OpenDML `indx`/`ix##` recursion,
    with `MAX_ODML_DEPTH` nesting guard and keyframe from the entry-length sign bit), and its
    handling of `AVIX` RIFF segments, `rec ` grouping, and packed-B-frame (DivX/XVID) splitting.
    ffmpeg **prefers a valid index for seeking but falls back to walking `movi`** when the index is
    missing/broken — the same robustness stance this driver takes by default.
  - Muxer `libavformat/avienc.c`
    <https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/avienc.c>. Study `avi_write_header`
    (hdrl + `JUNK` alignment + `indx` super-index reservation), `avi_write_packet` (movi chunk +
    per-segment `ix##` field index), and `avi_write_trailer` (idx1 for AVI 1.0 compatibility + the
    OpenDML `dmlh` grand-frame patch), including the ~1 GiB `AVI_MAX_RIFF_SIZE` roll to a new
    `RIFF('AVIX')`.

**Where the SOTA design must match or beat ffmpeg.** ffmpeg emits **both** an AVI 1.0 `idx1` **and**
the OpenDML `indx`/`ix##` super-index so a >1 GiB file is seekable by every player; our muxer today
writes only `idx1` (covering the first RIFF) plus an `odml/dmlh` frame count — technically
non-conformant for seeking into `AVIX` tails (§4, §5). On read, ffmpeg *uses* the index for keyframe
flags and seek; our parser deliberately ignores `idx1`/`indx` for payload (walking `movi` directly,
which is strictly more robust for streamed/corrupt-index AVIs — measured-evidence.md_) but then must recover
keyframe truth some other way, and today falls back to a heuristic (§3.3). The design goal: keep the
robust index-free `movi` walk **and** read the index (when present and sane) purely to stamp accurate
keyframe flags and expose a payload-free packet table — beating ffmpeg's robustness without inheriting
its "trust the index" fragility.

## 3. Target design

### 3.1 Data model (the seams)

Bytes flow through three pure, independently testable layers:

1. **RIFF walk (reader).** A little-endian cursor over `Uint8Array` with a bounds-checked chunk reader.
   `readChunk` (`avi-parse.ts:130-143`) reads `id`+`size`, computes the WORD-aligned `next`
   (`size + (size & 1)`, `avi-parse.ts:141`), and on a declared size that overruns the container
   returns a **clamped truncated body** (`bodyEnd = end`, `next = end`, `avi-parse.ts:136-140`) so a
   cut file recovers what is present instead of throwing. `asList` (`avi-parse.ts:153-159`) interprets
   a `LIST`/`RIFF` chunk as `{listType, childrenStart, childrenEnd}`. Every required fixed-width header
   read is length-guarded before decode (`avih`≥40, `strh`≥48, video `strf`≥20, audio `strf`≥14 —
   `avi-parse.ts:251,257,262,469`) and raises a typed `MediaError('demux-error', …)` on truncation
   (ADR-073 fixed raw `RangeError` leaks here — measured-evidence.md_). **This is the one canonical RIFF reader
   for the AVI driver.**
2. **Parsed model — `AviParse`/`AviTrack`/`AviStream`/`AviChunk`** (`avi-parse.ts:28-72`). `parseAvi`
   (`avi-parse.ts:337-423`) produces `{ tracks: AviTrack[] }`, video-first then by stream index
   (`mediaRank`, `avi-parse.ts:417-421,543-545`). Each `AviStream` (`avi-parse.ts:28-48`) carries the
   time base (`scale`/`rate`), `length`, `sampleSize`, and geometry/audio params; each `AviChunk`
   (`avi-parse.ts:51-56`) is `{ data: Uint8Array, ptsUs, keyframe }` where `data` is a **subarray view
   into the whole-file buffer** (`avi-parse.ts:357`). `config` is the probe-facing WebCodecs
   `VideoDecoderConfig`/`AudioDecoderConfig` (`configForStream`, `avi-parse.ts:548-557`). This layer
   has **zero WebCodecs types**, so it is fully Node-unit-testable.
3. **`Packet` seam** — the container↔codec boundary (`Packet`, `driver.ts:89-100`): a sealed
   `Encoded*Chunk` whose `timestamp` is the PTS. AVI has no DTS, so `dtsUs` is left **implicit
   (= PTS)** (`avi-driver.ts:107`), which is the correct encoding of a no-reorder container.

The public surface is the `ContainerDriver` object `AviDriver` (`avi-driver.ts:133-156`): `supports`
(sync RIFF/`AVI ` magic + mime + extension, `avi-driver.ts:115-126`), `demux`, and `createMuxer`.
The mux path is `avi-mux.ts` — `AviMuxer` (`avi-mux.ts:616-762`) over the packet seam plus the pure
`writeAviFromTracks(tracks, samples, options)` (`avi-mux.ts:591-613`) that emits the byte layout.

### 3.2 Capability routing (WebCodecs → GPU → WASM, miss-only)

The AVI driver is **codec-agnostic and backend-free by construction**: parse/walk/write are pure TS
that runs in every environment (ADR-002), and the driver only *emits/consumes* `Encoded*Chunk`s. The
`WebCodecs → GPU → WASM (miss-only)` ladder is exercised **downstream** by whatever decodes/encodes
MJPEG/MPEG-4/H.264/PCM/MP3/AAC — never inside this driver. The developer never names a backend, and
this driver names none.

The one capability gate is the presence of the `EncodedVideoChunk`/`EncodedAudioChunk` constructors,
which exist only in a browser/worker. `packetStream` checks for them and raises a **typed
`CapabilityError('capability-miss', …, { op: 'demux', tried: [] })`** when absent
(`avi-driver.ts:75-81`), mirroring the mp4/mpegts drivers — a loud, honest miss, never a silent wrong
result. Track enumeration (`demux().tracks`, and thus `probe`) needs no WebCodecs and works in Node.
On the mux side, unsupported shapes fail loudly with `CapabilityError`: fragmented output
(`avi-mux.ts:628-637`), 64-bit-float PCM (`avi-mux.ts:250-254`), >100 streams (the 2-digit chunk-id
ceiling, `avi-mux.ts:652-657`), an unmappable video/audio codec (`avi-mux.ts:660-665,679-684`), and a
single packet larger than one RIFF segment (`avi-mux.ts:529-534`).

### 3.3 Edge cases (explicit treatment)

- **B-frames.** AVI has **no composition-offset / DTS mechanism** — chunks are stored in decode order
  and the container cannot express PTS≠DTS. The target design therefore emits packets in `movi` order
  with `dtsUs` implicit (= PTS) (`avi-driver.ts:107`); any reorder for B-frame codecs (MPEG-4/XVID,
  H.264-in-AVI) must come from the **decoder**, not the container. Two honest consequences the doc
  must own: (1) **packed B-frames** (DivX/XVID "packed bitstream", where one `##dc` chunk carries a
  P+B VOP pair and null `0-byte` chunks stand in for the delayed frame) are **not unpacked** — ffmpeg
  splits them in `avidec.c`; we pass the chunk through verbatim and rely on the decoder. (2) keyframe
  truth for inter-coded video is **not** in `movi`. Today the parser uses a heuristic
  (`defaultKeyframe`, `avi-parse.ts:317-322`): intra-only codecs (`mjpeg`/`rawvideo`) → every frame
  key; everything else → **first chunk key, rest delta** (`avi-parse.ts:363-366`). That is a guess,
  not truth, and it is the biggest correctness gap (see §5 item 2): the SOTA design reads
  `AVIIF_KEYFRAME` from `idx1` (or the OpenDML index length sign bit, per ffmpeg `read_odml_index`)
  when a sane index is present, and only falls back to the heuristic when it is missing/broken.
- **VFR (variable frame rate).** AVI is nominally **constant** frame rate: cadence is `dwScale`/
  `dwRate` (or `avih.dwMicroSecPerFrame`). Video PTS is `frame_index × scale/rate` (`chunkPts`,
  `avi-parse.ts:521-524`; `ticksToUs`, `avi-parse.ts:327-329`). The only VFR-ish mechanism AVI has is
  **null/drop frames** — zero-length `##dc` chunks that repeat the previous picture. The parser
  **counts** a zero-length chunk (it still advances the per-stream sample counter, so following frames
  keep the right timeline hole), while the packet seam **skips** emitting empty chunks
  (`avi-driver.ts:91-96`) because a 0-byte access unit is a timing placeholder, not a coded frame.
  PCM audio is the exception to "one chunk = one sample": a `##wb` chunk holds many fixed blocks, so
  its PTS accumulates by **bytes ÷ `nBlockAlign`** for sample-accurate timing (`chunkPts`,
  `avi-parse.ts:514-519`). Genuine per-frame VFR (as WebM/MP4 express) cannot be represented in AVI;
  a VFR source muxed to AVI is quantized to the nominal cadence — state that limit, don't fake it.
- **Seek.** No decoder lives here; the driver provides the seek *substrate*. AVI's real seek index is
  `idx1`/`indx`, but demux deliberately **does not require it** — it walks `movi` chunk headers so a
  missing/corrupt index (all streamed AVIs, many real files) still demuxes (an idx1-only demux was
  explicitly rejected — measured-evidence.md_; matches ffmpeg's index-optional fallback). Accurate seek then
  depends on accurate **keyframe flags**, which today are heuristic (see B-frames above) — so a
  keyframe-accurate seek into an MPEG-4/H.264 AVI is not yet honest. The target: read the index for
  keyframe positions (payload still from the `movi` walk), and expose a payload-free packet table
  (`packetInfo`) so a consumer can pick a keyframe-anchored range without draining the file.
- **Cancel.** Every async surface must honor `AbortSignal`. Today `packetStream`'s `pull` checks
  `signal?.aborted` and errors the stream with `MediaError('aborted', …)` (`avi-driver.ts:87-90`), but
  the whole-file `readAll` (`avi-driver.ts:33-51`) and `parse` (`avi-driver.ts:129-131`) **ignore the
  signal**, so an abort during a multi-GB buffering read is not observed until parsing finishes. The
  target threads `signal` into `readAll` (range-read loop and stream-read loop both `throwIfAborted`)
  — see §5.
- **Frame lifetime (`close()` exactly once).** **Not applicable.** This is a container driver: it
  emits/consumes `EncodedVideoChunk`/`EncodedAudioChunk`, which are immutable and non-disposable, and
  it never constructs a `VideoFrame`/`AudioData`. There is no frame to close, so the "every frame
  closed exactly once" obligation lands entirely on the downstream codec layer, not here.
- **Backpressure.** The packet `ReadableStream` must be pull-driven with a **zero high-water mark** so
  `pull` runs only when a consumer asks (as the mp4 driver does with `{ highWaterMark: 0 }`). Today
  `packetStream` constructs a **default** `ReadableStream` (`avi-driver.ts:85`, no strategy), so it
  queues one packet ahead of demand — a backpressure leak. Worse, the whole file is `readAll`-buffered
  up front and every `AviChunk.data` is a **subarray view into that one backing buffer**
  (`avi-parse.ts:357`), so a single retained packet pins the entire file in memory. AVI's absolute
  `movi` offsets make a whole-`movi` walk somewhat inherent, but the design should (a) set
  `highWaterMark: 0`, and (b) for a seekable/`range`-capable source, window the `movi` read and copy
  small payloads out so queued packets don't pin a multi-GB backing (§5). On the mux side, the writer
  is **single-shot** — `AviMuxer` buffers all samples in `#samples` (`avi-mux.ts:621,733`) and
  `finalize` enqueues one whole `Uint8Array` (`avi-mux.ts:736-751`); it has no streaming/segment-at-a-
  time output, so a large mux materializes the whole file in RAM (§5, §6).

### 3.4 Codec ↔ 4CC/format-tag mapping (one table, both directions)

AVI identifies codecs by `biCompression` 4CC (video) and `wFormatTag` (audio), per RFC 2361 and the
registered-4CC lists. The **read** map (`videoCodec`, `avi-parse.ts:77-89`; `audioCodec`,
`avi-parse.ts:92-117`) is case-insensitive, folds the common aliases (`XVID/DIVX/DX50/MP4V/FMP4/MP42/
DIV3` → `mpeg4`; `MJPG/JPEG/DMB1` → `mjpeg`; `H264/AVC1/X264` → `h264`; `HEVC/HVC1/H265` → `hevc`;
`VP80/VP90/AV01`; `MPG1/MPG2/MPEG` → `mpeg2video`), and — critically — **never drops an unknown 4CC**:
it returns the lowercased 4CC (`avi-parse.ts:88`) / a `0xNNNN` string for an unregistered format tag
(`avi-parse.ts:115`), so probe stays honest. The **write** map is the inverse (`videoFourCC`,
`avi-mux.ts:171-182`; `audioFormat`, `avi-mux.ts:244-277`). In the target design these are **one
shared bidirectional table** (see §5 item 4), because two hand-maintained inverse tables in two files
drift (the writer already recognizes fewer codecs than the reader).

## 4. Current state

What exists today, with the layering smells named honestly.

### 4.1 The mux god-file: `avi-mux.ts` (762 lines)

`avi-mux.ts` (`wc -l` = 762) owns, in one module: the RIFF byte-writer primitives (`riffChunk`/
`listChunk`/`riffFile`/`writeFourCC`/`asciiBytes`/`concatParts`, `avi-mux.ts:111-165`), the
codec→4CC/format-tag mapping (`videoFourCC`/`audioFormat`/`pcmBits`/`compressedAudioFormat`,
`avi-mux.ts:171-292`), timing derivation for video and both audio flavors (`videoTiming`/
`audioTiming`/`compressedAudioTiming`/`reduce`/`gcd`, `avi-mux.ts:294-383`), every header builder
(`buildAvih`/`buildStrh`/`buildVideoStrf`/`buildAudioStrf`/`buildStrl`/`buildDmlh`/`buildHdrl`,
`avi-mux.ts:391-517`), the OpenDML segment splitter and `movi`/`idx1` writers (`splitSegments`/
`buildMovi`/`buildIdx1`, `avi-mux.ts:519-580`), the top-level `writeAviFromTracks`
(`avi-mux.ts:591-613`), **and** the stateful `AviMuxer` class (`avi-mux.ts:616-762`). It should be
decomposed (§5 item 1) into a shared `riff-write.ts`, a shared `avi-codec-map.ts`, an
`avi-timing.ts`, an `avi-layout.ts` (headers + movi + index), and a thin `avi-mux.ts` that only wires
the `Muxer`. By comparison `avi-driver.ts` (166) and `avi-parse.ts` (557) are appropriately sized.

### 4.2 Module-global mutable state: none (good — keep it that way)

A `grep` for module-scope mutable state finds **only immutable `const`s**: two frozen `Set`s of
mimes/extensions (`avi-driver.ts:29-30`) and numeric constants (`avi-mux.ts:4-8`). The single `new
Map` is function-local (`writeAviFromTracks`, `avi-mux.ts:604`). Unlike the mp4 driver's
process-global caches, the AVI driver has **no leaking singletons** — a real strength to preserve.

### 4.3 Duplication / layering smells

- **Two inverse codec tables in two files.** `avi-parse.ts` maps 4CC/tag→codec
  (`avi-parse.ts:77-117`) and `avi-mux.ts` maps codec→4CC/tag (`avi-mux.ts:171-277`). They already
  disagree in coverage (the reader knows `DIV3/FMP4/MP42/DMB1/DAVC/mpeg2video`; the writer emits a
  narrower set), and nothing keeps them in sync.
- **Two RIFF chunk toolkits.** The reader has `fourCC`/`readChunk`/`asList` (`avi-parse.ts:23-25,
  130-159`); the writer has `writeFourCC`/`asciiBytes`/`riffChunk`/`listChunk`/`riffFile`
  (`avi-mux.ts:111-165`). RIFF is also WAV's container (S27), so a **shared `riff` core** could serve
  AVI + WAV + AIFF/CAF read and write — a cross-driver dedup opportunity.
- **Whole-file probe.** `AviDriver` implements **no `probe()` and no `packetInfo()`**
  (`avi-driver.ts:133-156`), so `MediaEngine.probe()` falls back to `demux()`, which `readAll`s the
  **entire file** (`avi-driver.ts:33-51,129-131`) — even to answer a header-only probe on a multi-GB
  movie. There is no bounded/header-window read.
- **Heuristic keyframe flags presented as fact.** `defaultKeyframe` (`avi-parse.ts:317-322`) +
  `list.length === 0` (`avi-parse.ts:366`) mark only the first inter-coded frame as key. The comment
  calls it "honest, not a fabricated flag," but for a real MPEG-4/H.264 AVI it **is** a guess that
  contradicts `idx1` `AVIIF_KEYFRAME` — the index is ignored on read.
- **Ad-hoc chunk introspection via casts in the muxer.** `packetKeyframe`/`packetDurationUs` cast the
  sealed chunk to a hand-rolled `EncodedChunkMeta { type?: unknown; duration?: unknown }`
  (`avi-mux.ts:88-109`) to read `.type`/`.duration`, instead of using the typed `EncodedVideoChunk`
  fields. `unknown`-typed reads defeat the strict-types bar even though no `any` appears.
- **Double copy on the mux write path.** `write()` copies bytes out of the WebCodecs host object with
  `copyChunkBytes` (`packet.chunk.copyTo`, `avi-mux.ts:93-97,707-716`) **ignoring** the contract's
  owned `Packet.data` view (`driver.ts:79-80,92-93`), then `addChunkStruct` copies **again** with
  `chunk.data.slice()` (`avi-mux.ts:726`). Two copies per packet; the Ogg muxer's measured win from
  preferring `Packet.data` (measured-evidence.md_) applies here.
- **Non-standard `movi` chunk-id suffixes treated as media.** `streamIndexOf` accepts `dc/db/wb/sb/sd`
  (`avi-parse.ts:310`); `sb`/`sd` are not the standard `db/dc/pc/wb` payload suffixes (the MS
  reference reserves arbitrary two-char codes for *text* streams), so they could misattribute a
  subtitle/aux chunk to an a/v track.

### 4.4 Known conformance bounds (mux)

- **OpenDML index is incomplete.** For a multi-segment file the muxer writes `AVIX` RIFFs
  (`avi-mux.ts:609-612`), an `odml/dmlh` grand-frame count (`buildDmlh`, `avi-mux.ts:502-506`), and a
  single `idx1` in the **first** RIFF (`avi-mux.ts:608`) — but **no `indx` super-index and no per-
  segment `ix##` field indexes**. Per OpenDML AVI 2.0 (and ffmpeg `avienc.c`), the `idx1` cannot
  address `AVIX` tails (its offsets are 32-bit within the first RIFF), so seeking into segments
  ≥2 relies on `indx`, which is absent. The file plays via a linear walk (ours does) but is
  non-conformant for indexed seek.
- **`idx1` offset base is unvalidated end-to-end.** `buildIdx1` writes `dwChunkOffset` = offset from
  the `movi` list start (`offsetFromMoviType` begins at 4, i.e. just past the `movi` FourCC —
  `avi-mux.ts:550,556-564,569-580`). Because our **own** demux ignores `idx1`, nothing in-repo proves
  the authored offsets are what a third-party reader (ffmpeg) expects (movi-relative vs file-relative
  is the classic AVI ambiguity ffmpeg guards against).
- **Compressed-audio codec-private is dropped.** `buildAudioStrf` writes a bare 18-byte `WAVEFORMATEX`
  with `cbSize = 0` (`avi-mux.ts:482-492`); AAC (`wFormatTag 0x00FF`, `avi-mux.ts:270-272`) needs its
  `AudioSpecificConfig` appended after `cbSize`, so AAC-in-AVI output is structurally incomplete for a
  strict decoder. Video `strf` likewise carries no `strd`/extradata.
- **Single-buffer whole-file mux.** No streaming output (§3.3 Backpressure).

## 5. Delta / punch-list

Ordered for a coding agent. Each item names the change, the `path:line`, and a concrete acceptance
oracle. Behavior-preserving refactors (items 1, 4) must keep `avi.test.ts` green and produce
**byte-identical** mux output on the fixtures.

1. **Decompose the `avi-mux.ts` god-file (762 lines).** Extract `riff-write.ts` (the
   `riffChunk`/`listChunk`/`riffFile`/`writeFourCC` primitives, `avi-mux.ts:111-165`), `avi-codec-map.ts`
   (shared with the parser, see item 4), `avi-timing.ts` (`videoTiming`/`audioTiming`/
   `compressedAudioTiming`, `avi-mux.ts:313-383`), and `avi-layout.ts` (header + movi + idx1 builders),
   leaving a thin `avi-mux.ts` that only wires the `Muxer`. _Acceptance:_ no owned non-test file over
   ~350 lines; each extracted module has its own unit test; `writeAviFromTracks` produces
   byte-identical output to `git HEAD` on all five `avi.test.ts` mux cases (MJPEG+PCM, MPEG-4+MP3,
   video-only, audio-only PCM, audio-only MP3); typecheck + lint green; zero `any`.

2. **Read the index for real keyframe flags; keep the index-free `movi` walk.** Replace the
   `defaultKeyframe` first-frame heuristic (`avi-parse.ts:317-322,363-366`) with `AVIIF_KEYFRAME` read
   from `idx1` (or OpenDML index length sign bit, per ffmpeg `read_odml_index`) **when a sane index is
   present**, falling back to the heuristic only when it is missing/inconsistent. _Acceptance:_ a
   golden test on a real MPEG-4/XVID AVI asserts the set of keyframe chunk indices equals
   `ffprobe -show_frames`' `key_frame=1` set (not just `{0}`); on an AVI with the `idx1` chunk stripped,
   the walk still demuxes and the heuristic set is reported (a "degraded, documented" flag); the
   existing MJPEG all-key behavior is unchanged.

3. **Add `probe()` (bounded, header-only) and `packetInfo()` (payload-free) to `AviDriver`.**
   `AviDriver` (`avi-driver.ts:133-156`) has neither, forcing a whole-file `readAll` for a probe
   (`avi-driver.ts:33-51`). Add `probe(src)` that reads only enough for `hdrl` (via `src.range` when
   available), deriving duration from `avih.dwTotalFrames`/`strh.dwLength` without walking `movi`; add
   `packetInfo(src)` that walks `movi` headers only (offsets + sizes + PTS + keyframe), never
   materializing payload. _Acceptance:_ `probe()` on the two fixtures returns tracks/dims/fps/duration
   equal to today's demux-backed probe within `FRAME_TOLERANCE_SEC` (mjpeg 1.000 s, mpeg4 1.083 s —
   measured-evidence.md_) while issuing a bounded read (assert bytes read ≪ file size on a `range`-capable
   source); `packetInfo().packets` row count/sizes equal the `movi` chunk table with **zero** payload
   subarrays retained.

4. **Unify the codec↔4CC/format-tag map into one bidirectional module.** Merge `videoCodec`/
   `audioCodec` (`avi-parse.ts:77-117`) and `videoFourCC`/`audioFormat` (`avi-mux.ts:171-277`) into one
   `avi-codec-map.ts` with a single source-of-truth table. _Acceptance:_ a table-driven round-trip test
   asserts `fourCCToCodec(codecToFourCC(c)) === c` for every muxable codec and that every 4CC the
   reader recognizes has a defined inverse (or an explicit "read-only" marker); the anti-cheat tests
   (`avi.test.ts:1242,1262`, 4CC/format-tag mutation flips the reported codec) stay green.

5. **Fix backpressure + frame-pinning in the packet stream.** Construct the packet `ReadableStream`
   with `{ highWaterMark: 0 }` (today default, `avi-driver.ts:85`) and, for a `range`-capable source,
   window the `movi` read and copy small payloads out instead of subarray-viewing the whole-file
   backing (`avi-parse.ts:357`). _Acceptance:_ a heap/retention test asserts that after pulling and
   dropping one packet from a large synthetic AVI, the full-file buffer has zero strong retainers;
   `pull` is invoked exactly once per consumer `read()` (assert via an instrumented reader), not
   eagerly.

6. **Thread `AbortSignal` through the whole-file read.** `readAll` (`avi-driver.ts:33-51`) and `parse`
   (`avi-driver.ts:129-131`) must `throwIfAborted` in both the `range` and `stream` loops. _Acceptance:_
   a test aborts mid-read of a chunked stream source and asserts `demux()` rejects with
   `MediaError('aborted', …)` before parsing, and that no further reads occur after abort.

7. **Emit a conformant OpenDML index (`indx` super-index + `ix##` field indexes), or fail loudly.**
   The muxer writes only `idx1`+`odml/dmlh` for multi-segment output (`avi-mux.ts:502-506,608-612`).
   Either author the `indx` super-index in each `strl` plus per-segment `ix##` (matching ffmpeg
   `avienc.c`), or raise a typed `CapabilityError` when a mux would exceed one RIFF and the caller has
   not opted into a documented "idx1-only, linear-seek" mode. _Acceptance:_ ffmpeg (or another AVI 2.0
   reader) can seek into an `AVIX` segment of the muxer's >threshold output and reports the correct
   frame; a sub-threshold single-RIFF mux is byte-identical to today.

8. **Cross-validate the authored `idx1` against a third-party reader.** Because our demux ignores
   `idx1`, add an oracle that proves `buildIdx1` offsets (`avi-mux.ts:569-580`) are correct.
   _Acceptance:_ `ffprobe`/`ffmpeg` seeking by the authored `idx1` lands on the byte-exact chunk for
   every entry on the five mux fixtures; a unit test recomputes each `dwChunkOffset` from the emitted
   layout and asserts it points at the chunk's FourCC relative to the documented base.

9. **Collapse the mux double-copy; prefer `Packet.data`.** `write()` should read `packet.data`
   (`driver.ts:92-93`) when present instead of `copyChunkBytes` (`avi-mux.ts:93-97,707-716`), and
   `addChunkStruct` should store the already-owned bytes without a second `slice()`
   (`avi-mux.ts:726`). _Acceptance:_ a packet whose `data` view is a distinct owned buffer is stored
   with **one** copy (assert via a spy/`copyTo` counter = 0 when `data` is present); mux output stays
   byte-identical on the fixtures; the mux micro-benchmark geomean does not regress below the 226 MB/s
   baseline (measured-evidence.md_).

10. **Type the chunk introspection.** Replace the `EncodedChunkMeta` `unknown` cast
    (`avi-mux.ts:88-109`) with the real `EncodedVideoChunk`/`EncodedAudioChunk` `type`/`duration`
    fields (browser-gated like the demux seam). _Acceptance:_ `grep -n 'unknown' src/drivers/avi/avi-mux.ts`
    returns 0 for the chunk-meta shape; typecheck green; keyframe/duration behavior unchanged on the
    mux tests.

11. **Author compressed-audio codec-private (AAC `AudioSpecificConfig`) or reject.** `buildAudioStrf`
    writes `cbSize = 0` with no extradata (`avi-mux.ts:482-492`) while accepting AAC
    (`avi-mux.ts:270-272`). Either append the ASC after `cbSize`, or raise a typed `CapabilityError`
    for AAC-in-AVI until it can be authored conformantly. _Acceptance:_ an AAC AVI mux either produces
    a `strf` whose trailing bytes equal the source ASC (byte-compared) and decodes in ffmpeg, or throws
    `CapabilityError` with `op.codec === 'aac'`; PCM/MP3 mux is unchanged.

12. **Commit a runnable AVI case to the `media-test` corpus.** AVI has no manifest asset/golden
    (`demux/index.ts:43-44`), so it never runs in the 558/563-cell suite. Register a `demux` and a
    `mux` scenario over `mjpeg_pcm_160p.avi`/`mpeg4_mp3_160p.avi` with ffprobe-derived goldens (mjpeg
    dur 1.000 s, mpeg4 dur 1.083 s — measured-evidence.md_). _Acceptance:_ the AVI rows appear in the harness,
    pass their strict oracle, and the driver wins/ties the demux+mux aggregate vs the reference
    engines; the local mux bench (`scripts/bench-containers.ts`) remains ≥226 MB/s geomean.

## 6. Open questions

Each seeds a decision record in `docs/decisions/`.

1. **Index-free demux vs. index-derived keyframes.** We keep the robust `movi` walk (idx1-only demux
   rejected — measured-evidence.md_) but need `idx1`/`indx` for accurate keyframe/seek. Should the parser
   always read the index (when present and self-consistent) purely to stamp keyframe flags, with a
   documented divergence check when index and walk disagree — and what is the tie-breaker when they do?
   (Relates to Delta 2.)

2. **OpenDML index conformance level.** Do we implement the full `indx`+`ix##` super-index on write to
   match ffmpeg, or make >1 RIFF a deliberate `CapabilityError` steering large output to a more
   seekable container (MP4/Matroska)? AVI 2.0's benefit is legacy-tool interop; quantify who actually
   consumes multi-GB AVI before investing. (Relates to Delta 7.)

3. **`idx1` offset base.** Author movi-relative (our current base, `avi-mux.ts:550`) is the AVI 2.0
   convention, but a large corpus of real files is file-relative and ffmpeg tolerates both. Pin the
   base we emit, document it, and decide whether the reader (once it consults `idx1` for keyframes,
   Delta 2) auto-detects the base the way ffmpeg does. (Relates to Delta 8.)

4. **Streaming mux output.** `AviMuxer` is single-shot (whole file in `#samples`, one `finalize`
   enqueue — `avi-mux.ts:621,733,736-751`). AVI's `avih`/`idx1` need the final frame/byte counts, so a
   true streaming writer must either buffer headers and backpatch a seekable sink, or emit AVIX
   segments incrementally. Decide whether AVI gets a streaming target at all, or documents single-shot
   as the intended contract. (Relates to §3.3 Backpressure.)

5. **Packed B-frame (DivX/XVID) handling.** ffmpeg unpacks packed-bitstream MPEG-4 in `avidec.c`;
   we pass chunks through verbatim and rely on the decoder. Is verbatim-passthrough acceptable for our
   decode path, or must the demuxer split packed VOPs and synthesize the delayed-frame timing to keep
   PTS honest? (Relates to §3.3 B-frames.)

6. **Non-standard `movi` suffixes.** `streamIndexOf` treats `sb`/`sd` as media (`avi-parse.ts:310`).
   Confirm which non-`db/dc/pc/wb` suffixes should attribute to a decodable track vs. be surfaced as a
   `nonMedia`/text stream (`TrackInfo.nonMedia`, `driver.ts:243`), so probe's stream count matches
   ffprobe.

7. **UNVERIFIED: OpenDML AVI 2.0 spec URL/edition.** The structural claims (`AVIX`, `odml/dmlh`,
   `indx`/`ix##`) are cross-checked against ffmpeg and the Microsoft "AVI 2.0 index" note, but the
   exact `odmlff2.pdf` mirror/edition was not fetched here. Confirm the canonical citation when the
   references section is finalized.
