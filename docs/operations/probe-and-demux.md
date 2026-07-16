# Probe & Demux (S09)

> Target spec for the **`probe`** and **`demux`** benchmark families. This is the **best** design plus
> an honest delta versus today's code. Every claim traces to a `path:line` in this repo or a cited
> external source. Owned code: `src/drivers/audio-container-sniff.ts` (the long-tail audio container
> *sniffers*) and `src/internal/packet-provenance.ts` (the cross-container demux→mux *packet-provenance
> seam*). Container-specific parsers (MP4/WebM/MPEG-TS/…) are cited for context but owned by the driver
> docs (S23–S29).

## 1. Purpose & scope

**Probe** answers *"what is in these bytes?"* without decoding: container format, track list, per-track
codec/dimensions/sample-rate/duration/rotation, and container tags. **Demux** answers *"give me the
coded packets, in decode order, with correct timestamps"* without decoding either. Both are pure
container parses: they read bytes and emit descriptors (`TrackInfo`) and sealed encoded units
(`EncodedChunk`), and they never mint a `VideoFrame`/`AudioData` (that is the decode seam, S10/S30).

This shard owns the two cross-cutting seams that every container driver shares:

1. **Container sniffing** — `src/drivers/audio-container-sniff.ts` exports six cheap, synchronous,
   exact predicates (`matchesWav`/`matchesMp3`/`matchesOgg`/`matchesAdts`/`matchesAiff`/`matchesCaf`,
   `audio-container-sniff.ts:41`–`82`) that decide, from a MIME/extension hint plus a magic-byte head,
   whether a long-tail audio container driver claims the input. They are the `ContainerDriver.supports()`
   implementations (`driver.ts:414`) for the audio family and are consumed both eagerly
   (`defaults.ts:297`,`314`,`325`,`337`,`353`,`363`) and by each lazily-registered driver
   (e.g. `adts-driver.ts:775`, `ogg-driver.ts:1033`, `wav-driver.ts:835`, `caf-driver.ts:60`).

2. **Packet provenance** — `src/internal/packet-provenance.ts` is the demux→mux fast-path seam. A
   first-party demuxer registers a `NativePacketSource` on the `ReadableStream<Packet>` it hands out
   (`packet-provenance.ts:253`); the multi-source muxer later retrieves it *iff* the caller's
   `TrackInfo` is byte-and-structure identical to the demuxer's (`packet-provenance.ts:260`). When it
   matches, packet-copy remux/mux fuses without ever constructing per-packet WebCodecs host objects
   (ADR-282/287, measured-evidence.md).

Benchmark families served (`../media-test/src/scenarios/probe/`, `.../demux/`):

- **`probe`** — golden-metadata oracle: track count/order, codec, dims, fps, channels, duration, tags
  match committed independent ffprobe/mediainfo truth; score is `probes/sec`, correctness-gated so a
  fast-but-wrong probe FAILs (`scenarios/probe/index.ts:17`,`:384`).
- **`demux`** — golden-packets oracle: the exact ordered packet table (per-track PTS/DTS/size/keyframe)
  matches golden; catches reordering, dropped/duplicated packets, and fabrication (`0 == 0` passes)
  (`scenarios/demux/index.ts:6`,`:23`). Includes huge/OOM-prone assets, the `demux(mux(x))` round-trip,
  and MPEG-TS 33-bit/90 kHz PTS-wraparound cases (`scenarios/demux/index.ts:20`,`:34`).

Aggregate stakes: pure-TS parsers win only ~8% of the 558-feature suite but at *zero* bundle cost and
*zero* WASM download (measured-evidence.md); web-demuxer wins 10 features (1.8%), so probe/demux is where a
lean pure-TS engine must beat the WASM demuxers decisively (measured-evidence.md).

## 2. Spec & references

Governing standards (magic-byte sniffing + packet timing + track model):

- **WHATWG MIME Sniffing Standard** — the algorithm for identifying a resource from leading bytes
  ("byte pattern matching table"), which our `head`-based predicates implement.
  <https://mimesniff.spec.whatwg.org/>
- **W3C WebCodecs** — `EncodedVideoChunk`/`EncodedAudioChunk` are immutable and expose only
  `timestamp` (the **presentation** time / PTS), never DTS; this is *why* the seam adds a `Packet`
  view carrying `dtsUs` (`driver.ts:72`–`100`). <https://www.w3.org/TR/webcodecs/>
- **ISO/IEC 14496-12 (ISO Base Media File Format)** — sample tables: `stts` (decode durations),
  `ctts` (composition offset = PTS−DTS, the B-frame reorder), `stss` (sync/keyframe), `elst` (edit
  list). PTS = DTS + composition offset. <https://www.iso.org/standard/83102.html>
- **ISO/IEC 13818-1 (MPEG-2 Systems / TS)** — 90 kHz PTS/DTS clock and 33-bit wraparound.
  <https://www.iso.org/standard/74427.html>
- **Matroska (RFC 9559)** + **EBML (RFC 8794)** — block timestamps, `CodecDelay`/`SeekPreRoll`
  (surfaced as `codecDelayNs`/`seekPreRollNs`, `driver.ts:257`,`:259`).
  <https://www.rfc-editor.org/rfc/rfc9559.html>, <https://www.rfc-editor.org/rfc/rfc8794.html>
- **Ogg (RFC 3533)** + Opus-in-Ogg (RFC 7845) — `OggS` capture pattern; granule-position timing.
  <https://www.rfc-editor.org/rfc/rfc3533>, <https://www.rfc-editor.org/rfc/rfc7845>
- **ID3v2.4** — the synchsafe tag-size layout that `adtsHeadOffset` decodes to skip a leading tag
  before the ADTS sync scan (`audio-container-sniff.ts:88`–`102`).
  <https://id3.org/id3v2.4.0-structure>
- **RIFF/WAVE** (`RIFF…WAVE`), **AIFF/AIFF-C** (`FORM…AIFF`/`AIFC`), **Apple CAF** (`caff`) — the
  magic patterns matched by `matchesWav`/`matchesAiff`/`matchesCaf`. Apple CAF spec:
  <https://developer.apple.com/library/archive/documentation/MusicAudio/Reference/CAFSpec/>

OSS exemplars to match/beat:

- **mediabunny** (probe/Input model) — <https://github.com/Vanilagy/mediabunny>,
  <https://mediabunny.dev/guide/reading-media-files>. Its `Input`/`getMetadataTags`/duration path reads
  `getDurationFromMetadata()` **first** and only walks fragments when metadata lacks a duration, so a
  probe of a fragmented/CMAF input does not pay a full sample-table scan
  (`../media-test/src/engines/mediabunny/adapter.ts:34`). Our `probe()` metadata hook is the same idea
  (ADR-112, measured-evidence.md).
- **web-demuxer** (FFmpeg-in-WASM demux) — <https://github.com/bilibili/web-demuxer>. It loads an
  FFmpeg WASM worker, then `getMediaInfo()`/`getAVStreams()`/`readAVPacket()` return a
  `ReadableStream<WebAVPacket>`. Two documented weaknesses our SOTA design beats:
  (a) `WebAVPacket` carries **only** a presentation timestamp, so its demux reports `dtsUs === ptsUs`
  — an honest approximation that *cannot* losslessly remux B-frames
  (`../media-test/src/engines/web-demuxer/adapter.ts` timestamp note); our packet table carries real
  DTS from the container's `ctts`/`stts`. (b) Any probe/demux pulls the whole FFmpeg WASM worker; our
  pure-TS parse pulls **zero** WASM (measured-evidence.md).

Measured leadership already recorded (all fresh, cited in measured-evidence.md): `probe/opus` 2.320 ms vs
mediabunny 3.690 vs ffmpeg.wasm 6.785; `demux/aac_adts` 4.015 ms vs mediabunny 5.920 (maxPtsDrift=0);
`demux/opus` 6.690 vs mediabunny 7.235 vs ffmpeg.wasm 12.235; `demux/flac_noseektable` 4.645 vs
ffmpeg.wasm 11.520. Known remaining loss: `demux/size_massive_massive_h264_1080p_2h` 1349 ms vs
remotion-webcodecs 40.685 (33.159×) — see §5 item 5 (measured-evidence.md).

## 3. Target design

### 3.1 Data model

Three descriptor layers, narrowing as work commits:

| Layer | Type | Purpose |
|-------|------|---------|
| Sniff query | `ContainerQuery { direction, mime?, extension?, head? }` (`driver.ts:192`) | Cheapest possible format decision from a hint + magic bytes. |
| Track model | `TrackInfo` (`driver.ts:231`) | Full internal track truth: codec, `config` (`DecoderConfig`), `fps`, `rotation`, `durationSec`, `gapless`, `codecDelayNs`/`seekPreRollNs`, `color`, `containerSideData`, `nonMedia`. |
| Public probe | `MediaInfo`/`MediaInfoTrack` (`types.ts:278`,`:260`) | The flattened, serialization-safe view returned to the caller. |
| Packet | `Packet { chunk, data?, alpha?, dtsUs?, sizeBytes? }` (`driver.ts:89`) | A sealed `EncodedChunk` (PTS) plus the DTS/size/alpha facts WebCodecs cannot carry. |
| Payload-free row | `PacketInfoMetadata`/`PacketMetadata` (`driver.ts:118`,`:103`) | A timeline row (PTS/DTS/size/keyframe/offset) with **no** payload bytes. |

The **packet is the container↔codec seam**. Because `EncodedVideoChunk`/`EncodedAudioChunk` are sealed
host objects exposing only `timestamp` (PTS) and never DTS, a reordered stream (B-frames/open-GOP)
carries its decode timestamp in `Packet.dtsUs`; **`undefined` ⇒ DTS == PTS** (`driver.ts:96`, ADR-045).
`sizeBytes` distinguishes the on-disk container packet size from the decoder access-unit size
(ADTS reports header+payload on disk but hands WebCodecs the bare AU) (`driver.ts:98`, ADR-055).

### 3.2 Seams

**Sniff seam.** The engine reads a bounded head once and passes it to every registered driver's
synchronous `supports(q)` (`driver.ts:414`); the router returns the first match or throws a typed
`CapabilityError('capability-miss', 'no container driver for demux …')` (`router.ts:131`–`135`). Head
size is chosen by `routeHeadBytes()`: **4 KiB** when a MIME/extension hint exists, **64 KiB** blind
(`engine.ts:182`,`:183`,`:2158`). Each audio predicate combines `matchesHint()` (MIME set ∪ extension
set, `audio-container-sniff.ts:18`) with an exact magic check on `q.head` via `tag()`
(`audio-container-sniff.ts:33`). `matchesAdts` additionally skips fully-visible stacked ID3v2 tags —
decoding the synchsafe length and optional footer — before checking ADTS sync
(`audio-container-sniff.ts:88`–`102`).

**Probe seam.** `MediaEngine.probe()` prefers the driver's optional metadata-only `probe(src)` hook
(`driver.ts:420`) and falls back to `demux(src).tracks` only when a driver omits it
(`engine.ts:384`–`392`). The hook exists because building a full live `Demuxer` to read a one-hour
file's duration timed out the harness at 479 957 ms; the metadata hook dropped it to 178 ms
(ADR-112, measured-evidence.md). Probe **never** uses a `<video>`/`loadedmetadata` element — that path is
600–7000× slower than reading bytes (ADR-013, measured-evidence.md).

**Demux seam.** `demux(src)` returns a `Demuxer` with lazy per-track `packets(trackId)` streams
(`driver.ts:308`) plus an optional payload-free `packetTable()` (`driver.ts:307`) / `packetInfo()`
(`driver.ts:425`) fast path that returns metadata without reading `mdat` — required so a 2-hour /
553 501-packet asset does not issue hundreds of thousands of range reads (ADR-056, measured-evidence.md).

**Provenance seam.** After demux, a first-party driver calls `registerNativePacketSource(stream, src)`
(`packet-provenance.ts:253`) recording `{ track, isClaimable(), claim(signal) }`. The muxer calls
`nativePacketSource(stream, track)` (`packet-provenance.ts:260`), which returns the source **only** if
the stream is unlocked (`packet-provenance.ts:264`) and `sameTrackInfo(source.track, track)` proves a
deep structural + byte-exact identity (`packet-provenance.ts:266`,`231`). On a match, `claim(signal)`
yields `NativePacketChunk[]` (`packet-provenance.ts:4`) carrying `timestampUs`/`durationUs`/`key`/`data`
and optional `dtsUs` — zero WebCodecs host objects constructed (ADR-282: 4.962 ms / zero chunks vs
8.550 ms / 1370 chunks, measured-evidence.md).

### 3.3 Capability routing (WebCodecs → GPU → WASM, miss-only)

**Probe and demux are substrate-independent pure-TS parses and therefore sit *before* the capability
ladder, not on it.** Sniffing and container parsing need no WebCodecs, no GPU, and no WASM; a
probe-only application must pull **zero** WASM (measured-evidence.md). The developer never names a backend
here, and the only miss this family raises is a *container* miss — a typed
`CapabilityError('capability-miss', …)` when **no** registered `ContainerDriver.supports()` the head
(`router.ts:131`) — never a codec miss.

The codec/substrate question is deferred: demux attaches a *descriptive* `DecoderConfig` to each
`TrackInfo.config` (`driver.ts:261`) but performs **no** `isConfigSupported` check. The WebCodecs → GPU
→ WASM decision (S01 router) is made only when that config is later handed to a decoder (S10/S30). This
is the correct layering: the demuxer states facts; the router decides substrates. A demuxer that named
`webcodecs`/`dav1d`/`wasm-aac` would be a capability leak into the container layer.

### 3.4 Edge cases

- **B-frames / reorder.** *Central to this family.* Demux must enumerate packets in **decode** order
  and carry DTS so a lossless remux can restore composition order. `Packet.dtsUs` (`driver.ts:96`) and
  `NativePacketChunk.dtsUs` (`packet-provenance.ts:9`) carry it; `undefined` ⇒ DTS == PTS. MP4 derives
  DTS/PTS from `stts`+`ctts` (composition offset must be read **signed** even in v0 boxes — reading it
  unsigned turned −40 ticks into 4.29e9 and exploded PTS, ADR-350/185, measured-evidence.md; owned by S23). Audio
  never reorders, so ADTS registration omits `dtsUs` (`adts-driver.ts:745`). Exemplar gap: web-demuxer
  cannot do this — it flattens `dtsUs === ptsUs` (§2).
- **VFR (variable frame rate).** *Applies.* Probe reports `fps` = frames ÷ duration, an **average**
  (`driver.ts:245`); it must not assume CFR. Per-packet `durationUs` (`driver.ts:113`,`:126`) preserves
  the real cadence; the golden-packets oracle compares the exact per-packet table so a demuxer that
  synthesizes a constant cadence FAILs. A headerless/live capture may legitimately report a `null`
  duration and probe must still surface a sane track list (`scenarios/probe/index.ts:479`).
- **Seek.** *Mostly downstream (S10).* Demux's contribution is the keyframe/`stss` truth exposed via
  `packetTable()`/`packetInfo()` (`driver.ts:307`,`:425`): a payload-free keyframe index the seek
  planner uses to pick the pre-roll keyframe. Demux itself performs no time→packet seek.
- **Cancel.** *Applies.* Every `packets()` stream and `claim(signal)` must honor an `AbortSignal`:
  `NativePacketSource.claim(signal)` takes one (`packet-provenance.ts:15`), and when one fused provider
  fails the muxer must abort its siblings and settle them before rejecting — proven by
  `native-packet-mux.test.ts:197`–`238` (sibling abort) and the locked/changed-track decline at
  `native-packet-mux.test.ts:169`–`195`. `demuxer.close()` (`driver.ts:309`) releases source readers.
- **Frame lifetime (`close()` exactly once).** *Does not apply at this seam, by construction.* Probe
  and demux never produce a `VideoFrame`/`AudioData`; they produce sealed `EncodedChunk`s that **own
  their bytes and have no resource to release** — "a pure data view — no resources to release (chunks
  own their bytes)" (`driver.ts:87`). `NativePacketChunk.data` is an owned immutable `Uint8Array`
  (`packet-provenance.ts:8`). The close-exactly-once invariant is a decode-seam (S10/S30) obligation;
  the one hazard here is *not copying the same payload twice*, which the provenance seam exists to avoid.
- **Backpressure.** *Applies.* Packet streams are pull-driven with `highWaterMark: 0`
  (`adts-driver.ts:743`, `mp4-driver.ts:2933`) so container bytes are read only as the consumer pulls,
  keeping a 2-hour file's resident memory bounded. The MP4 native path amortizes with a
  zero-HWM 256 KiB / 256-packet batch (ADR-278, measured-evidence.md); larger batches were rejected because they
  break post-delivery abort. `packetInfo()` sidesteps backpressure entirely by never materializing
  payload.

## 4. Current state

### `src/drivers/audio-container-sniff.ts` (108 lines) — clean, but a *partial* sniff surface

- Six exact predicates over `ContainerQuery`: `matchesWav` (`:41`, `RIFF…WAVE`), `matchesMp3` (`:47`,
  `ID3` **or** MPEG-1/2 frame sync `:52`–`53`), `matchesOgg` (`:56`, `OggS`), `matchesAdts` (`:61`,
  ID3-skipped ADTS sync), `matchesAiff` (`:71`, `FORM…AIFF`/`AIFC`), `matchesCaf` (`:79`, `caff`).
- Module-const `Set`s of MIME strings and extensions (`:5`–`16`); `matchesHint` normalizes the MIME by
  stripping parameters and lowercasing (`:18`,`:29`). **No module-global mutable state** — all pure
  functions; good.
- `adtsHeadOffset` (`:88`) correctly walks *fully-visible* stacked ID3v2 tags (synchsafe size `:93`–`97`
  + optional footer `:98`) and returns `undefined` when a tag overruns the head (`:101`), so a huge
  leading tag makes ADTS **decline** rather than false-positive.

Smells:

1. **Fragmented sniff surface (layering).** This file is the single source of truth for the *long-tail
   audio* family only. The core containers' sniffers live elsewhere: `matchesMp4`/`matchesWebm`/
   `matchesMpegTs`/`matchesAvi` in `defaults.ts` (`:107`,`:121`,`:522`,`:704`) and FLAC's `supports`
   inline (`defaults.ts:557`). There is no one place a reviewer can see "what magic bytes map to what
   driver," and each new driver re-imports its own matcher. Container detection is a distributed concern.
2. **Head-length contract is implicit and remote.** `HEAD_BYTES`/`HINTED_HEAD_BYTES` (`engine.ts:182`,
   `:183`) are chosen in the engine, far from the predicates that depend on them. No sniffer declares
   its minimum head; each silently copes with a short/undefined `q.head`. An ADTS or MP3 file whose
   leading ID3v2 tag exceeds the head cannot be sniffed by magic and depends entirely on the MIME/
   extension hint.
3. **ID3-prefix ambiguity (correctness hazard).** `matchesMp3` returns `true` for *any* `ID3`-prefixed
   head (`:51`), but ID3v2 does not distinguish MP3 from AAC. An ID3-prefixed **ADTS/AAC** file matches
   *both* `matchesMp3` (`:51`) and `matchesAdts` (`:61`, via `adtsHeadOffset`). The tie is resolved by
   registration order, and MP3 is registered before ADTS (`defaults.ts:314` before `:337`), so such a
   file is claimed by the MP3 driver. See §5 item 2.

### `src/internal/packet-provenance.ts` (267 lines) — a correct but heavy shadow-schema comparator

- The seam: a **module-global mutable `WeakMap`** `sources` keyed by stream identity
  (`packet-provenance.ts:18`). It self-cleans (GC of a stream drops its entry), but it is a hidden
  global side channel between the demux and mux modules — mux reaches into a global registry rather than
  the demux result carrying an explicit token.
- `sameTrackInfo` (`:231`) is a hand-rolled deep structural + byte comparator: prototype-guarded
  `knownRecord` (`:98`), scalar compare with `Object.is` (`:109`), `sameBufferSource` byte compare
  (`:139`), `sameConfig` for video/audio `DecoderConfig` (`:157`), `sameSideData` for Matroska
  attachments (`:185`). It correctly rejects a stream whose reader is already locked (`:264`).
- **Shadow schema.** Eleven module-const key arrays — `TRACK_KEYS` (`:20`), `TRACK_SCALAR_KEYS` (`:39`),
  `VIDEO_CONFIG_KEYS` (`:53`), `AUDIO_CONFIG_KEYS` (`:65`), `VIDEO_COLOR_SPACE_KEYS` (`:66`),
  `TRACK_COLOR_KEYS` (`:67`), `GAPLESS_KEYS` (`:82`), `PROJECTION_KEYS` (`:83`), `SIDE_DATA_KEYS` (`:84`)
  — *duplicate the `TrackInfo`/`DecoderConfig` shape from `driver.ts` as runtime strings*. They are the
  allowlist `knownRecord` enforces (`:102`–`105`): an object with an unknown key returns `undefined` and
  the comparison fails. This **fails safe** (an unrecognized field ⇒ fusion declines ⇒ the generic
  demux→mux path runs, correct but slower), and the test asserts exactly that (`native-packet-mux.test.ts:139`,
  `futureMuxFact` ⇒ `undefined`). But it means **any new `TrackInfo` field silently disables the fast
  path until these arrays are updated** — a latent performance regression with no compile-time guard.

## 5. Delta / punch-list (ordered)

1. **Consolidate all container sniffers behind one registry with a declared head contract.** Move
   `matchesMp4`/`matchesWebm`/`matchesMpegTs`/`matchesAvi`/FLAC (`defaults.ts:107`,`:121`,`:522`,`:704`,
   `:557`) and the six audio predicates (`audio-container-sniff.ts:41`–`82`) behind a single exported
   table of `{ driverId, minHeadBytes, matches(q) }`, and have the engine read `max(minHeadBytes)` rather
   than a magic `64 * 1024` (`engine.ts:182`). *Acceptance:* a magic-byte fixture table
   (`RIFF…WAVE`, `ID3`, MPEG sync, `OggS`, ADTS sync, `FORM…AIFF`, `caff`, `…ftyp`, EBML `1A45DFA3`)
   asserts **exactly one** driver matches each entry; a test enumerates every registered
   `ContainerDriver` and asserts its `supports` is sourced from the single sniff module (no inline
   matcher survives).

2. **Disambiguate ID3-prefixed MP3 vs ADTS by content, not registration order.** `matchesMp3` must not
   claim on `ID3` alone (`audio-container-sniff.ts:51`); it should skip the leading ID3v2 tag (reuse the
   `adtsHeadOffset` synchsafe walk, `:88`) and require an **MPEG audio** frame sync at the post-tag
   offset, symmetric to `matchesAdts`. *Acceptance:* a fixture = ID3v2 header + raw ADTS AAC sync frames,
   `mime` unset, `extension` `'aac'` **or** unset, resolves to the **ADTS** driver; the mirror fixture
   (ID3v2 + MPEG-1 Layer-3 frames) resolves to **MP3**; assert via `router.pickContainer(q)` returning the
   expected `driver.id`. (Today both predicates return `true` and `defaults.ts:314`-before-`:337` order
   wins for MP3 — `UNVERIFIED`: the end-to-end mis-route needs a run to confirm the router's first-match
   pick; the double-match is CONFIRMED from code.)

3. **Kill the provenance shadow schema — make it exhaustive at compile time.** Replace the eleven runtime
   key arrays in `packet-provenance.ts:20`–`84` with keys derived from the `TrackInfo`/`DecoderConfig`
   contract (or add a `satisfies`-backed exhaustiveness guard) so a new `TrackInfo` field cannot silently
   disable fusion. *Acceptance:* a test constructs a `TrackInfo` populated in **every** optional field
   (extend the existing `native-packet-mux.test.ts:24`–`83` fixture) and asserts an identity clone is
   still claimable for each field mutated in isolation; a type-level check fails to compile if a
   `TrackInfo` key is added without being routed into exactly one comparator group.

4. **Encapsulate the provenance WeakMap behind a typed façade (or carry an explicit token).** No module
   should read the raw `sources` `WeakMap` (`packet-provenance.ts:18`) directly; expose only
   `register`/`lookup` (already the public functions `:253`,`:260`) and consider attaching the provenance
   capability to the demux result (`Demuxed`, `types.ts:286`) as a non-enumerable token instead of a
   global side channel. *Acceptance:* a test asserts (a) a locked stream declines (`:264`), (b) a
   semantically changed `TrackInfo` declines (already `native-packet-mux.test.ts:92`–`140`), and (c)
   grep proves no source file outside `packet-provenance.ts` references the `WeakMap` symbol.

5. **Close the massive-file demux drain gap.** `demux/size_massive_massive_h264_1080p_2h` loses 33.159×
   (1349 ms vs 40.685) because the public drain constructs immutable native chunks for 1.14 GiB while the
   consumer performs 553 501 `read()`/`await` steps (measured-evidence.md). Push consumers toward payload-free
   `packetInfo()`/`packetTable()` (`driver.ts:307`,`:425`) for metadata-only work, and keep the
   256 KiB/256-packet batching (ADR-278). *Acceptance:* `performance/size-ladder-iterate-packets-massive`
   preserves all 553 501 payload-free packet sizes matching ffprobe (`golden-packets`), and the metadata
   path resolves in ≤ ~35 ms (the metadata-only demux+`packetTable` measured 32.0 ms, measured-evidence.md);
   `demux/…_2h` full-drain regression-gated to not exceed its current median.

6. **Guarantee a metadata-only `probe()` hook on every container driver.** The `probe?`/`packetInfo?`
   hooks are optional (`driver.ts:420`,`:425`) and drivers that omit them fall back to a full `demux()`
   (`engine.ts:390`). *Acceptance:* a conformance test enumerates all registered container drivers and
   asserts each implements `probe`; `probe/edge_longform` (1 h AAC M4A) resolves in < 200 ms (ADR-112:
   178 ms) via the hook, proven by a range-read counter, **not** a whole-file read.

7. **Populate `dtsUs` in first-party video fusion.** `NativePacketChunk.dtsUs` (`packet-provenance.ts:9`)
   must be set from the container's decode timeline for reordered video (the MP4 `claim` at
   `mp4-driver.ts:2934`), while audio keeps it omitted (`adts-driver.ts:745`). *Acceptance:* a B-frame
   MP4 fused-mux round-trip reports `maxDtsDrift = 0` and one keyframe (cf. the VFR mux bench: 626
   packets, zero PTS/DTS differences, ADR-191, measured-evidence.md), and the demuxed vs re-demuxed packet tables
   are byte-identical under `golden-packets`.

8. **Enumerate `nonMedia` tracks with parity.** Probe must surface a declared non-media trak (e.g.
   QuickTime `tmcd`) as `MediaInfoTrack.type: 'other'` (`types.ts:266`, `driver.ts:243`) so the probe
   track count/order matches ffprobe `nb_streams`, but such a track must never emit a packet in `demux()`.
   *Acceptance:* `golden-metadata` on a timecode-trak fixture matches ffprobe's stream count/order, and
   `golden-packets` on the same asset shows zero packets for the `tmcd` track.

## 6. Open questions (seed `docs/decisions/`)

1. **Provenance capability: global registry vs explicit token.** Should the demux→mux fast path stay a
   module-global `WeakMap` keyed by stream identity (`packet-provenance.ts:18`), or should the
   `Demuxed`/`PacketStream` result carry an explicit, non-enumerable provenance token? Trade-off:
   the WeakMap self-cleans and needs no API surface change, but is spooky action at a distance; an
   explicit token is auditable but widens the public seam. Decision needed before §5 item 4 lands.

2. **Shadow-schema source of truth.** Can the eleven comparator key arrays (`packet-provenance.ts:20`–`84`)
   be *generated* from the `TrackInfo`/`DecoderConfig` types (build-time codegen or a `keyof`-driven
   const) without importing DOM `DecoderConfig` internals that TypeScript cannot enumerate at runtime?
   If not, what is the cheapest compile-time exhaustiveness guard (§5 item 3)?

3. **ID3-ambiguity resolution locus.** Should MP3/ADTS disambiguation (§5 item 2) live in the sniffer
   (peek past ID3 to the first sync frame) or in the router (try a deeper parse when two drivers both
   claim)? The sniffer is cheaper and synchronous; the router is more general for future ambiguous
   pairs. `UNVERIFIED` how often real ADTS/AAC files carry an ID3v2 prelude in the wild.

4. **Uniform head-length contract.** Is a per-driver `minHeadBytes` (§5 item 1) sufficient, or do some
   containers need an *unbounded* re-read when the magic is only decidable past the head (e.g. a
   multi-megabyte leading ID3v2 tag on a hint-less ADTS source)? Define the maximum head the engine will
   read blind before declaring a `capability-miss` (`router.ts:131`).

5. **Payload-free everywhere.** Should `packetInfo()`/`packetTable()` (`driver.ts:307`,`:425`) become
   **mandatory** on `ContainerDriver` (removing the `demux().tracks` fallback), given §5 items 5–6, or
   stay optional for third-party drivers that only implement full demux? Decide the contract version bump.
