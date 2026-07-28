# MP4 / MOV Driver

> Shard S23. Owned code: `src/drivers/mp4/*.ts` **except** `cenc.ts` (owned by the encryption
> shard S19). This document is the **target spec** (the best design) plus an **honest delta** vs the
> code that exists today. It is not a description of today's code.

## 1. Purpose & scope

The MP4/MOV driver is the ISO-BMFF (`.mp4`, `.m4a`, `.m4v`) and QuickTime (`.mov`, `.qt`) container
engine: a hand-written, pure-TypeScript box parser and writer with **no browser dependency**, so it
runs in Node, Workers, and the main thread identically. It maps the container's sample tables to and
from the WebCodecs coded-unit seam (`EncodedVideoChunk`/`EncodedAudioChunk` + a DTS side-channel),
and it never decodes or encodes media itself — codecs live behind the capability router.

Benchmark families served (per `docs/architecture/COVERAGE.md`):

- **demux** — parse `moov` (or `moof`/`traf`/`trun` for fragmented/CMAF), expand `stts`/`ctts`/
  `stsz`/`stsc`/`stco`/`co64`/`stss` into a flat per-sample list, stream packets with correct
  PTS/DTS and keyframe flags. Also serves **probe** (header-only track facts) and packet-info
  (payload-free packet tables) via the same parser at three fidelity levels.
- **mux** — accept `Packet`s (decode order) and author metadata-last, in-memory faststart, positioned
  reserved-faststart MP4/MOV, or a fragmented/CMAF stream of `moof`+`mdat` segments.
- **remux** — lossless demux→mux stream-copy: preserve every sample byte, DTS, composition offset
  (B-frame reorder), codec-private box, edit list, and display matrix, with optional trim,
  fragmentation, and a same-family compatible-brand MOV→MP4 rewrite.

It is also the demux/decrypt front end for CENC-protected (`cenc`/`cens`/`cbcs`) and HLS-AES-128
MP4/CMAF (the AES work itself is S19's `cenc.ts`), and the metadata carrier for `colr`, `pasp`,
`clap`, `tkhd` display matrix, and edit-list gapless (AAC priming/padding).

## 2. Spec & references

Governing standards (every reference links):

- **ISO/IEC 14496-12 — ISO Base Media File Format (ISO-BMFF).** The box grammar, `moov`/`trak`/
  `mdia`/`minf`/`stbl` hierarchy, sample tables (§8.7–8.8), movie fragments (§8.8), edit lists
  (§8.6.6), and the track header matrix (§8.3.2). ISO catalogue:
  <https://www.iso.org/standard/83102.html>. Free box-type/codec registry: **MP4RA**
  <https://mp4ra.org/>.
- **QuickTime File Format (QTFF), Apple.** The `qt  ` brand superset: sound-description v0/v1/v2
  layouts, `wave`/`enda`/`frma` PCM atoms, `tmcd` timecode traks, and the classic display matrix.
  <https://developer.apple.com/documentation/quicktime-file-format>.
- **ISO/IEC 23000-19 — Common Media Application Format (CMAF).** The fragmented-MP4 constraint set
  (init segment + one decodable media segment per keyframe run) the fragmented writer targets.
  <https://www.iso.org/standard/85623.html>.
- **RFC 6381 — the `codecs` and `profiles` parameters.** The `avc1.PPCCLL`, `hvc1.*`, `av01.*`,
  `mp4a.40.N` string grammar the codec-string mapper emits. <https://www.rfc-editor.org/rfc/rfc6381>.
- **AV1 Codec ISO Media File Format Binding** (`av1C` → `av01.*`).
  <https://aomediacodec.github.io/av1-isobmff/>.
- **W3C WebCodecs** — the `VideoDecoderConfig`/`AudioDecoderConfig` (with `description`) and
  `EncodedVideoChunk`/`EncodedAudioChunk` seam the driver maps to. <https://www.w3.org/TR/webcodecs/>.
- **faststart / moov placement** — not a standalone standard; ISO-BMFF §8.1 permits `moov` before or
  after `mdat`. "Faststart" (`moov` first, so playback begins without the whole file) matches
  FFmpeg's `-movflags +faststart` post-pass. FFmpeg `movenc`:
  <https://ffmpeg.org/ffmpeg-formats.html>.

OSS exemplar to study & beat:

- **mp4box.js (GPAC)** — <https://github.com/gpac/mp4box.js>. The reference JS ISO-BMFF library.
  Study `src/box.js` / `src/parsing/*` (per-box parsers), `src/isofile.js` (`ISOFile`,
  `appendBuffer`, `getInfo`, `seek`, `setExtractionOptions`/`start`), `src/isofile-write.js`
  (serialization), and `src/isofile-advanced-creation.js` +
  `setSegmentOptions`/`initializeSegmentation`/`onSegment` (fragmentation). mp4box.js is the
  incumbent this engine already beats on some rows and loses on others: `demux/h264_4k_10s`
  aibrush 50.965 ms vs mp4box **28.925 ms**, `h264_rotated90` 19.565 vs **12.275**,
  `realworld_mdn_flower_mp4` 12.610 vs **4.410** (measured-evidence.md_); in the 558-feature suite mp4box
  won 16 features (2.9%) (measured-evidence.md_). The demux gap is measured to be fetch/range-request
  round-trips inside the window, **not** the pure-TS parse (`mp4PacketInfoFromBytes` is
  ~2000–2500 pkt/ms in Node) (measured-evidence.md_).

Where the SOTA design should match or beat mp4box.js: mp4box.js exposes one mutable `ISOFile`
accumulator with `onReady`/`onSegment` callbacks. Our design is stricter — a pull-based
`ReadableStream` packet seam with a zero high-water-mark for backpressure, three parse fidelities
(metadata / packet-info / full) so a one-hour file's probe never materializes sample tables, and a
range-window planner that reads only the bytes a consumer pulls. Those are the levers that turn the
range-read losses above into wins.

## 3. Target design

### 3.1 Data model (the seams)

Bytes flow through four typed layers; each is pure and independently testable:

1. **`Reader` + box iteration** (`reader.ts`). A big-endian cursor (`u8`/`u16`/`u24`/`u32`/`u64`/
   `i16`/`i32`/`fixed16`/`fourcc`, `reader.ts:41-96`) with bounds-checked `#need` that throws a typed
   `MediaError('demux-error', …)` on truncation (`reader.ts:114-121`). `readBoxHeader` handles
   64-bit `largesize` (`size===1`) and to-EOF `size===0` (`reader.ts:139-151`); `boxes()` stops on a
   malformed box instead of throwing (`reader.ts:154-161`). **This is the one canonical box parser**
   — everything else must use it.
2. **`Movie` / `ParsedTrack` / `SampleTable`** (`parse.ts:41-187`). The parsed container model:
   per-track `timescale`, `durationSec`, `edit` (`TrackEdit`, `parse.ts:113-126`), `codec` +
   WebCodecs `config`, `codecPrivate` (raw `avcC`/`esds`/`hvcC`/`av1C`/`vpcC`/`dOps` for verbatim
   remux, `parse.ts:53-56`), geometry (`width`/`height`/`displayTransform`/`rotation`/`pasp`/`clap`/
   `colr`/`colorSpace`), and the raw sample tables. `OtherTrack` (`parse.ts:95-110`) surfaces
   non-media traks (`tmcd`/`text`/`meta`) so probe's stream count matches ffprobe (ADR-185).
3. **Flat sample list** (`samples.ts`). `buildSampleData` (native ticks, exact — what the muxer
   round-trips, `samples.ts:190-244`) and `buildSamples` (WebCodecs µs — the codec seam,
   `samples.ts:247-303`) expand the tables; DTS accumulates `stts` deltas, `ctts` is preserved so
   **B-frame reorder survives**, keyframes come from `stss` (absent ⇒ every sample sync). Zero-alloc
   `walkSampleRanges`/`walkSampleClassificationRanges` (`samples.ts:105-187`) exist for the paths
   that need only byte ownership or sync membership without materializing objects.
4. **`Packet` seam** — `{ chunk: Encoded*Chunk, dtsUs?, sizeBytes? }` (ADR-045). WebCodecs
   `Encoded*Chunk` is sealed and carries only `timestamp` (=PTS); `dtsUs` supplies the decode
   timestamp across the container↔codec boundary; `dtsUs === undefined` means DTS==PTS (measured-evidence.md_).
   The muxer's inverse — `buildMuxSamples` (`mux.ts:754-817`) — reconstructs `stts` from cumulative
   DTS and lays down `ctts = PTS − DTS` so a non-reordered stream yields exactly zero at any
   timescale (ADR-045).

The public surface is the `ContainerDriver` object `Mp4Driver` (`mp4-driver.ts:4267-4518`):
`supports` (sync magic/mime, `mp4-sniff.ts:7`), `probe`, `packetInfo`, `packetInfoBatches`, `demux`, `streamCopy`,
`decrypt`, `createMuxer`. A **mux-only** twin `Mp4MuxOnlyDriver` (`mp4-mux-driver.ts:31-48`) registers
the writer without importing the parser (ADR-290 selective registration).

### 3.2 Capability routing (WebCodecs → GPU → WASM, miss-only)

The container driver is **codec-agnostic and backend-free by construction**: it emits/consumes
`Encoded*Chunk` + `description` bytes and never decodes. The only decode this family performs is
**decode-validation** of recovered AVC access units for MP4 *trim* and *CENC* (AES-CTR is
unauthenticated, so corrupt ciphertext is only observable at the codec seam). In the target design
that validation is a **seam injected by the router**, not a decoder the driver constructs:

- Today the driver names `VideoDecoder`/`EncodedVideoChunk`/`AudioData` directly
  (`mp4-driver.ts:2320`, `:2402`, `:2512`, `:2816`). That is a **capability leak** — a backend
  (WebCodecs) named in the container layer. The target: the executor passes a
  `decodeValidate(config, chunks, signal)` capability the router resolved (hardware WebCodecs → GPU
  → WASM, miss-only); the driver calls it and stays name-free. On a true miss the router raises a
  typed `CapabilityError`; the driver's Node/no-WebCodecs path keeps the bit-exact crypto-only copy
  (`mp4-driver.ts:2319-2327` guards `typeof VideoDecoder === 'undefined'`).
- `esds`/`avcC`/`hvcC`/`av1C`/`vpcC` → codec strings + `description` (`codec-strings.ts`) is the
  routing input: the string carries profile/level (`avc1.42E01E`, `mp4a.40.2`) so
  `isConfigSupported` answers precisely. H.264 encode is floored to Level 3.0 for tiny-MP4 seek
  compatibility (ADR-084, measured-evidence.md_) — but that floor belongs to the encoder-config layer, not
  here.

### 3.3 Edge cases (explicit treatment)

- **B-frames.** Demux: `ctts` (composition offset) read **signed for both v0 and v1** (`parse.ts:1389`)
  — real muxers write two's-complement negative offsets into a v0 `ctts`; reading unsigned turned
  −40 ticks into 4294967256 and exploded PTS (ADR-185, measured-evidence.md_). PTS = DTS + `ctts`
  (`samples.ts:292`). Mux: `buildMuxSamples` computes `ctts = (PTS − DTS)` in µs first so
  non-reordered → 0, reordered → true offset, and `writeMp4` emits a **version-1 `ctts`** for
  negative offsets (`mux.ts:742-816`). Fragmented: `trun` composition offset is unsigned in v0,
  signed in v1 (`fragment-samples.ts:179`).
- **VFR (variable frame rate).** The muxer never trusts a stale nominal `duration`: for
  monotonic-PTS output each sample's duration is the **gap to the next PTS**, only the final sample
  uses its declared duration (`mux.ts:766-775`); reordered output falls back to
  `recoverDurationsUs` (`mux.ts:717-739`). This keeps DTS contiguous and stops a stale duration from
  fabricating reorder. Verbatim remux uses the source's true `dtsUs` gaps directly (`mux.ts:782-797`).
  Validated: `bench-session11-mp4-vfr-mux` — 626 packets, one keyframe, zero PTS/DTS differences
  (ADR-191, measured-evidence.md_).
- **Seek.** No decoder here; the driver provides the *substrate* for seek: `stss` (+ non-IDR I-picture
  classification via `h264-access-unit.ts`) gives keyframe positions, and the read-window planner
  lets a consumer read one keyframe-anchored range without draining the file. `stss` is a
  sync/random-access table, **not** a complete picture-type table — encoders emit non-IDR I pictures
  at scene cuts without listing them (`h264-access-unit.ts:5-9`), so packet metadata inspects
  `slice_type` for samples `stss` omits.
- **Cancel.** Every async surface is `AbortSignal`-aware. `throwIfAborted` (`mp4-driver.ts:2286-2288`)
  guards each parse/read step; the packet `ReadableStream` registers an abort listener in `start`,
  flips `state.cancelled`, releases retained buffers, and `controller.error(abortedError())`
  (`mp4-driver.ts:2831-2841`, `:2858-2863`), and its `cancel()` releases the source lease
  (`mp4-driver.ts:2927-2930`). Decode-validation races an abort promise against the decoder dequeue
  (`mp4-driver.ts:2333-2352`).
- **Frame lifetime (`close()` exactly once).** The container driver **emits `Encoded*Chunk`s, not
  `VideoFrame`s**, so the "every frame closed once" rule applies only to internal decode-validation:
  both `VideoDecoder` output callbacks close each frame synchronously in the callback
  (`mp4-driver.ts:2405`, `:2513`) and the decoder is closed in `finally` (`closeDecoder`,
  `mp4-driver.ts:2329-2331`). No frame escapes the validator; there is exactly one `close()` per
  frame. `EncodedVideoChunk`/`EncodedAudioChunk` are not disposable, so no chunk lifetime obligation.
- **Backpressure.** The packet stream is constructed with `{ highWaterMark: 0 }`
  (`mp4-driver.ts:2932`): `pull` runs only when a consumer asks, and it keeps **one pull inside one
  retained source window** so queued `Packet.data` views from a prior window can't pin many 8 MiB
  backings for sparse layouts (`mp4-driver.ts:2888-2892`). The streaming/fragmented writers pull one
  ~256 KiB payload chunk per `pull` (`prepared-stream.ts:7`, `:42-66`), and CMAF yields one
  `moof`+`mdat` per fragment so a `StreamTarget` never buffers the whole movie
  (`fragment.ts:564-595`, ADR-034).

### 3.4 Three parse fidelities + faststart fast paths

A single `parseMovieInternal(brand, moov, mode)` (`parse.ts:259-299`) drives three depths so a probe
never pays for sample tables it won't read:

- `parseMovieMetadata` (`parse.ts:236`) — timing/geometry/count only; per-sample tables stay
  unmaterialized. `readMovieMetadata` brought a one-hour M4A metadata probe to ~24 ms median
  (ADR-112, measured-evidence.md_).
- `parseMoviePacketInfo` (`parse.ts:241`) — packet timing without chunk-offset (byte-placement)
  tables, for payload-free packet tables over huge files.
- `parseMovie` (`parse.ts:223`) — full tables, for demux/stream-copy.

`packetInfoBatches` walks the parsed `stts`/`ctts`/`stsc`/`stsz`/`stco` primitive tables with persistent
cursors in declared track order and creates at most one requested batch of packet row objects. Unknown
AVC pictures read bounded payload windows for that pulled batch; other rows stay payload-free. Early
return/abort stops range reads. Legacy `packetInfo` collects this same path, so
DTS/PTS/duration/keyframe/offset truth has one implementation. Large non-AVC and complete-`sdtp` sources
retain the offset-free metadata parse.

On top, `probe()` tries header-only faststart shortcuts before any full read
(`mp4-driver.ts:4274-4301`): bounded video-metadata, `readSimpleVideoFaststartProbe`
(`simple-video-probe.ts:77-103`), tiny-audio and sparse-audio faststart probes — each parses only the
head `moov` from an 8–128 KiB prefetch window. A keyed `movieParseHandoff` lets a faststart probe hand
its owned raw `moov` to a following demux without a re-read (`mp4-driver.ts:160-168`,
`:440-467`).

### 3.5 Write path & faststart

`writeMp4` (`write.ts:991-1010`) builds `ftyp`/`moov` as small `number[]`s but copies the `mdat`
payload straight from each sample's `Uint8Array` via `.set` (never a giant `number[]`, which crashed
the huge/massive rungs). Faststart is **one-pass**: build `moov` with zero-offset chunk tables to
learn its exact length, then patch the absolute chunk offsets for `mdat` placed right after it
(`write.ts:944-954`, `patchGeneratedMoovChunkOffsets`). This removed the prior faststart penalty
(0.894 vs 0.903 ms after the fix; an array-only MOV specialization was reverted after it regressed)
(measured-evidence.md_). `planMp4ByteStreamLayout` (`write.ts:969-982`) exposes the same layout for the
streaming writer so the byte layout is identical whether emitted whole or chunked.

`faststart:'reserve'` is the progressive, bounded-memory alternative. The public API requires a
positive per-track `maximumPacketCount` and a positioned callback, seekable writable, or OPFS sink
before it pulls input. `planReservedMp4ByteStreamLayout` reserves a deterministic metadata region,
places the `mdat` header and payload after it, then emits a positioned `moov` patch followed by a valid
`free` box filling unused reservation bytes. The driver streams payload forward, keeps one destination
write outstanding, enforces the per-track packet ceiling, and returns a standard `ftyp`→`moov`→`free`
→`mdat` file. Ordinary boolean faststart retains the small-input in-memory path; fragmentation remains
the append-only live/CMAF path.

## 4. Current state

What exists today, with the layering smells named honestly.

### 4.1 The god-file: `mp4-driver.ts` (4,528 lines)

`mp4-driver.ts` is a single 4,528-line module (`wc -l`) that owns, in one file: random-access source
adaptation (`RandomAccess`, `mp4-driver.ts:122-158`), five probe fast paths and their eager-read
heuristics (`:204-467`), the parse-handoff cache, packet-metadata and packet-info table builders
(`:1956-2216`), inline AVC picture classification (`classifyAvcSample`, `:1616`), four distinct
read-window planners (sample `:1499`, packet `:1545`, interleaved-progressive `:3544`, ordered
`:3867`), the whole CENC/HLS decrypt orchestration inside the `decrypt` method (`:4386-4512`),
AVC decode-validation with a live `VideoDecoder` (`:2379-2596`), trim (`:2227-2277`), the packet
`ReadableStream` (`:2784-2988`), the demuxer factory (`:2997`), and six `streamCopy` layout variants
(`:3980-4265`). It should be decomposed into: `source-access.ts`, `probe-fastpath.ts`,
`read-window-plan.ts`, `packet-stream.ts`, `packet-info.ts`, `decode-validate.ts`, `decrypt.ts`,
`streamcopy.ts`, and a thin `mp4-driver.ts` that only wires the `ContainerDriver` object.

### 4.2 Module-global mutable state

Four module-scope mutable singletons live at the top of `mp4-driver.ts`:

- `const movieParseHandoff = new Map<string, MovieParseHandoff>()` (`mp4-driver.ts:168`) — a
  cross-call parse cache keyed by a source cache key, **shared across all engine instances** in the
  process.
- `const trimDecodeValidationCache = new Map<string, number>()` (`mp4-driver.ts:169`) — a
  time-pruned cache of already-validated trim decodes (`pruneTrimDecodeValidationCache`, `:369-379`),
  also process-global.
- `let faststartProbeModulePromise` / `let faststartProbeModule` (`mp4-driver.ts:170-171`) — lazy
  import memo.
- `let cencModulePromise` (`mp4-driver.ts:176`) — lazy import memo for the S19 `cenc.ts`.

The import memos are benign; the two `Map` caches are genuine module-global mutable state that leaks
between independent engines and cannot be evicted per-engine.

### 4.3 Capability leak (backend named in the wrong layer)

The container driver constructs WebCodecs decoders itself: `new VideoDecoder({...})`
(`mp4-driver.ts:2402`, `:2512`), `VideoDecoder.isConfigSupported` (`:2322`), and builds
`EncodedVideoChunk` for validation (`:2816` builds both `EncodedVideoChunk`/`EncodedAudioChunk` for
the packet seam too). Per the routing philosophy the developer never names a backend and the driver
should not either — decode-validation must be an injected router capability.

### 4.4 Duplication / layering smells

- **Four+ box-header parsers.** Canonical `readBoxHeader` (`reader.ts:139`) is duplicated by
  `topBoxHeader`/`probeBoxAt` (`simple-video-probe.ts:60-75`, `:105-120`), `readTopLevelBox`
  (`compatible-mov-rewrite.ts:44-65`), and `topBoxHeader`/`declaredProbeBoxAt`
  (`mp4-driver.ts:512`, `:727`). Each re-implements the `size===1`/`size===0` logic with its own
  bounds handling.
- **Two trun/tfhd fragment parsers.** `parseTraf` for aggregate timing (`parse.ts:357`) and
  `appendTrafSamples` for per-sample recovery (`fragment-samples.ts:128-199`) parse the same boxes
  with duplicated flag constants (`parse.ts:331-339` vs `fragment-samples.ts:24-41`).
- **Two AVC key-picture classifiers.** `h264-access-unit.ts` (standalone, `:23-145`) and inline
  `classifyAvcSample` (`mp4-driver.ts:1616`).
- **Codec bitstream reframing inside the container muxer.** `mux.ts` embeds Annex-B→AVCC transmux
  (`annexBNalUnits`/`avcCFromParameterSets`/`prepareAvcSamples`, `mux.ts:179-517`) and ADTS→raw-AAC
  (`parseAdtsAccessUnit`/`audioSpecificConfig`, `mux.ts:518-707`). That is codec-layer bitstream work
  living in the container layer, and it re-implements H.264 NAL parsing that `h264-access-unit.ts`
  already has.
- **Repeated scalar helpers.** `toUs` is defined three times (`samples.ts:56`,
  `fragment-samples.ts:300`, `mp4-driver.ts:2278`); `u32`/`u64`/`fourcc` byte helpers recur in
  `compatible-mov-rewrite.ts:22-42` and `write.ts` (`generatedU32`/`generatedFourcc`,
  `write.ts:744-765`).
- **Inconsistent `supports()` predicates.** `matchesMp4` (`mp4-sniff.ts:3-4`) accepts MIMEs
  `{video/mp4, video/quicktime, audio/mp4, audio/x-m4a}` and extensions `{mp4,mov,m4a,m4v,qt}`;
  `supportsMux` (`mp4-mux-driver.ts:17-28`) accepts `{video/mp4, audio/mp4, application/mp4,
  video/quicktime}` and extensions `{mp4,mov}`. `application/mp4` and `audio/x-m4a` are each accepted
  by exactly one — a divergence that will route inconsistently.

### 4.5 Known bounds

`assertSingleBufferSize` (`write.ts:602-609`) caps a single-buffer write at `0xffffffff`
(`write.ts:599`) and `writeMp4` always emits a **32-bit `stco`** and an **8-byte `mdat` header**
(`write.ts:939` comment: "size ≤ 4.29 GB"). Non-fragmented output above 4 GiB is therefore
unsupported (it would need `co64` + a 64-bit `mdat` largesize). The read path already handles `co64`
on input (`parse.ts:1432`).

## 5. Delta / punch-list

Ordered for a coding agent. Each item names the change, the `path:line`, and a concrete acceptance
oracle. Behavior-preserving refactors (items 1, 4–8) must keep the existing MP4 test suite green and
produce **byte-identical** output on the corpus.

1. **Decompose `mp4-driver.ts` (4,528 lines).** Split into the modules named in §4.1, leaving a thin
   `ContainerDriver` wiring file. _Acceptance:_ no owned file over ~800 lines; every extracted module
   has its own unit test; `parse(write(x)) === x` and all existing `roundtrip.test.ts` /
   `mp4.test.ts` / `demux-resident-ranges.test.ts` pass with byte-identical goldens; typecheck + lint
   green; zero `any`.

2. **Remove or engine-scope the two module-global `Map` caches.** `movieParseHandoff`
   (`mp4-driver.ts:168`) and `trimDecodeValidationCache` (`:169`) must not be process-global mutable
   state. Thread the parse-handoff token through the `demux()`/`StageOptions` so a probe→demux handoff
   is explicit, and make the trim-validation memo engine-scoped (or drop it). _Acceptance:_ a test
   that runs two independent `createMedia()` engines over the same URL asserts no cache entry from
   engine A is observable to engine B (probe engine B still issues its own range reads); `grep -nE
   'new (Map|Set)\(' src/drivers/mp4/mp4-driver.ts` at module scope returns 0.

3. **Close the capability leak: stop constructing `VideoDecoder` in the driver.** Replace the inline
   decoders (`mp4-driver.ts:2402`, `:2512`) and `isConfigSupported` (`:2322`) with a
   `decodeValidate` capability injected via `StageOptions`/executor, resolved by the router
   (WebCodecs → GPU → WASM, miss-only). _Acceptance:_ `grep -rn 'new VideoDecoder\|VideoDecoder\.'
   src/drivers/mp4` returns 0; a corrupt-ciphertext CENC fixture still rejects at the codec seam (a
   test flips one `senc` IV byte and asserts the decrypt throws before emitting output); a Node run
   with no `VideoDecoder` still takes the crypto-only path and passes the bit-exact twin.

4. **Unify box-header parsing on `reader.ts:139`.** Delete `topBoxHeader`/`probeBoxAt`
   (`simple-video-probe.ts:60`, `:105`), `readTopLevelBox` (`compatible-mov-rewrite.ts:44`), and
   `topBoxHeader`/`declaredProbeBoxAt` (`mp4-driver.ts:512`, `:727`); route all header reads through
   `readBoxHeader` (adding a random-access variant if a box header can straddle a read window).
   _Acceptance:_ one box-header implementation remains; the fuzz corpus (`test-support/fuzz/corrupt.ts`)
   of truncated / `size===1` / `size===0` / oversized boxes passes through the single parser without a
   crash and with identical probe output on the clean corpus.

5. **Collapse the two fragment (trun/tfhd) parsers into one.** Have `parse.ts` aggregate timing
   (`parseTraf`, `:357`) and per-sample recovery (`appendTrafSamples`,
   `fragment-samples.ts:128`) share one `trun`/`tfhd` reader and one set of flag constants.
   _Acceptance:_ on the fragmented corpus, `sum(fragmentSamplesToDemuxSamples(...).durationUs)` equals
   the `FragmentTiming.mediaTicks` the aggregate path reports for every track; `hybrid-fragmented` and
   `fragmented-probe` tests stay green.

6. **Deduplicate the AVC key-picture classifier.** Route `classifyAvcSample` (`mp4-driver.ts:1616`)
   through `h264AccessUnitRangeIsKeyPicture` (`h264-access-unit.ts:34`). _Acceptance:_ the
   packet-truth fixture still reports exactly 1,941 video key pictures (1,680 declared sync + 261
   non-IDR intra) on the 725 MiB/two-hour rotation (measured-evidence.md_).

7. **Lift codec bitstream reframing out of `mux.ts`.** Move Annex-B→AVCC (`mux.ts:179-517`) and
   ADTS→raw-AAC (`mux.ts:518-707`) behind a codec-owned transmux seam; the container muxer accepts
   already-elementary samples + `description`. _Acceptance:_ `mux.ts` no longer imports/implements NAL
   or ADTS parsing; `mux-avc-passthrough.test.ts` and the ADTS→MP4 mux fixture
   (`mux/audio_only_aac_to_mp4`, 6.240 ms vs ffmpeg 10.140 ms, measured-evidence.md_) round-trip
   byte-identically.

8. **Consolidate scalar helpers.** One shared `toUs` (drop `samples.ts:56`, `fragment-samples.ts:300`,
   `mp4-driver.ts:2278` duplicates) and one big-endian byte-write helper set. _Acceptance:_ `grep -rn
   'function toUs' src/drivers/mp4` returns 1; typecheck green.

9. **Reconcile the two `supports()` predicates.** `matchesMp4` (`mp4-sniff.ts:7`) and `supportsMux`
   (`mp4-mux-driver.ts:17`) must agree on the MIME/extension universe (mux-vs-demux direction gating
   aside). _Acceptance:_ a table-driven test asserts `application/mp4` and `audio/x-m4a` are treated
   consistently by both; the container-selection matrix (`container-integrity.test.ts`) stays green.

10. **Support >4 GiB non-fragmented output (or fail loudly and route to CMAF).** `writeMp4`
    (`write.ts:991`) + `assertSingleBufferSize` (`write.ts:602`) cap at 4 GiB with a 32-bit `stco`.
    Either emit `co64` + a 64-bit `mdat` largesize when `mdatPayloadLen > 0xffffffff`, or raise a
    typed `CapabilityError` steering the caller to `fragmented: true`. _Acceptance:_ a synthetic layout
    *plan* (no real bytes) whose payload exceeds 4 GiB asserts `co64` selection and a 16-byte `mdat`
    header (or the typed error); sub-4 GiB layouts stay `stco` and byte-identical.

11. **Prove the demuxer releases its source lease on terminal/cancel.** The revocable `sourceCell`
    (`mp4-driver.ts:3000`, `:2994` comment) and packet-stream `release()` (`:2792-2800`) are the
    memory contract. _Acceptance:_ a heap-snapshot test (per measured-evidence.md_, JSC may defer `WeakRef`
    clearing so use a self-describing V8 snapshot checking zero strong inbound retainers) asserts that
    after a full drain **and** after an early `cancel()`, the full-source `RandomAccess` and its
    window buffers have zero strong retainers.

12. **Golden the packet-info table against ffprobe truth on the massive rung.** `mp4PacketInfoTable`
    (`mp4-driver.ts:2647`) must preserve all 553,501 payload-free packet sizes of the two-hour MP4
    (measured-evidence.md_, `performance/size-ladder-iterate-packets-massive`). _Acceptance:_ the table matches
    independent `ffprobe -show_packets` sizes row-for-row; the header-only path
    (`readMoviePacketInfo`, `:1059`) and the offset path (`readMovie`, `:965`) agree on counts.

## 6. Open questions

Each seeds a decision record in `docs/decisions/`.

1. **Where does decode-validation live?** Trim and CENC need to decode-validate recovered AVC, but the
   container layer must not name WebCodecs. Should the router expose a first-class
   `decodeValidate(config, chunks, signal)` capability, or should validation move up into the
   trim/decrypt operations (S16/S19) that already own a decode seam? Decide the seam and its typed
   miss behavior. (Relates to Delta 3.)

2. **Parse-handoff lifetime and scope.** The probe→demux `moov` handoff is a real latency win
   (avoids a re-read) but is currently a process-global `Map`. Is the right home an explicit token in
   `StageOptions`, an engine-scoped cache with a documented eviction policy, or dropping it in favor
   of a source-layer read cache (S06)? Quantify the re-read cost before removing. (Relates to Delta 2.)

3. **>4 GiB non-fragmented MP4.** Do we implement `co64`/64-bit-`mdat` writing, or make >4 GiB a
   deliberate `CapabilityError` that routes to fragmented/CMAF output? mp4box.js writes `co64`;
   FFmpeg selects it automatically. Decide whether the single-buffer `writeMp4` grows a chunked
   large-file path or delegates to `fragmentMp4`. (Relates to Delta 10.)

4. **`ParsedTrack.durationSec` = media vs presentation.** The parser keeps `durationSec` = media
   duration and exposes presentation duration via `edit.durationSec`; only `probe()` reports
   `edit?.durationSec ?? durationSec` while demux/round-trip/gapless keep media duration (ADR-185,
   measured-evidence.md_). Confirm this split is still the intended contract for every consumer, or unify on
   one field with an explicit flag.

5. **UNVERIFIED: HEVC/AV1/VP9 write coverage in `writeMp4`.** The parser maps `hvcC`/`av1C`/`vpcC`
   (`codec-strings.ts`, `parse.ts:939`), and `mux.ts` synthesizes `av1C`/`vpcC` from codec strings
   (`mux.ts:332-379`), but I did not verify that a full HEVC/AV1/VP9 **remux** round-trips
   byte-identically through `write.ts` on a real fixture (the read tests cover parse; the write tests
   I inspected focus on AVC/AAC). Add a per-codec remux golden or record the gap.

6. **UNVERIFIED: exact ISO/QTFF catalogue URLs.** The standard **numbers** (ISO/IEC 14496-12,
   23000-19; RFC 6381) are authoritative, but the specific `iso.org/standard/<id>` edition pages can
   shift between editions and were not fetched here. Confirm the current-edition links when the
   references section is finalized.
