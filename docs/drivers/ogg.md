# Ogg Driver (`ogg`)

> Shard S26 · owned code: `src/drivers/ogg/ogg-driver.ts`, `src/drivers/ogg/ogg-write.ts`,
> `src/drivers/ogg/ogg-prepared-mux.ts`. Benchmark families served: **demux**, **mux**.
> This document is the **target spec** (the best design) plus an **honest delta** against the code
> as it exists today. Every claim is traced to `path:line` or an external source; unverifiable
> claims are marked `UNVERIFIED`.

## 1. Purpose & scope

The Ogg driver is a **hand-written TypeScript container driver** for the Ogg bitstream format. An Ogg
file is a sequence of little-endian **pages**; each logical stream opens with a **BOS** (beginning-of-stream)
page whose first packet is the codec identification header (`src/drivers/ogg/ogg-driver.ts:1-7`). The
driver demuxes and muxes single-logical-stream **audio** Ogg for three Ogg-mapped codecs — **Vorbis**,
**Opus**, and **FLAC** — with Theora deferred until its fixtures land (`src/drivers/ogg/ogg-driver.ts:147`).

It participates in the capability router purely as a **container** (`kind: 'container'`,
`src/drivers/ogg/ogg-driver.ts:1030`): all page/lacing/granule work is pure TS, and the only browser-only
seam is the per-chunk `EncodedAudioChunk` construction / `copyTo`. It serves two benchmark families:

- **demux** — `probe()` (track facts + duration), `packetInfo()` (timeline packet rows without payload
  materialization), and `demux()` (live per-track `EncodedAudioChunk` streams). Entry points:
  `src/drivers/ogg/ogg-driver.ts:1035,1044,1049`.
- **mux** — `createMuxer()` returns an `OggMuxer` over the pure page writer `writeOgg`
  (`src/drivers/ogg/ogg-driver.ts:1073`, `src/drivers/ogg/ogg-write.ts:481,555`); plus prepared
  (already-own-the-bytes) authoring via `muxPreparedOggAudioPacketTrack`
  (`src/drivers/ogg/ogg-prepared-mux.ts:12`); plus lossless `streamCopy()` for remux/trim and
  cross-container copy into WebM/Matroska (`src/drivers/ogg/ogg-driver.ts:1078`).

Out of scope for this driver: Ogg *video* (Theora), chained/multiplexed logical streams (A/V mux inside one
Ogg file), skeleton streams, and any decode/encode — codecs are the codec drivers' job (S30/S31/S32). This
driver only laces coded packets into pages and de-laces pages into coded packets.

## 2. Spec & references

Governing standards (every reference links):

- **RFC 3533 — The Ogg Encapsulation Format Version 0.** Page structure, capture pattern `OggS`, the
  segment/lacing table, header-type flags (continued/BOS/EOS), `granule_position`, `bitstream_serial_number`,
  `page_sequence_number`, and the page **CRC-32 (generator polynomial `0x04c11db7`, no bit-reflection,
  init 0, no final XOR)**. <https://datatracker.ietf.org/doc/html/rfc3533>
- **RFC 7845 — Ogg Encapsulation for the Opus Audio Codec.** The `OpusHead` identification header layout
  (magic, version, channel count, **pre-skip** at byte 10, input sample rate, output gain, channel mapping),
  the `OpusTags` comment header, the 48 kHz granule clock, and pre-skip / end-trim granule semantics.
  <https://datatracker.ietf.org/doc/html/rfc7845>
- **RFC 6716 — Definition of the Opus Audio Codec, §3.1 (the TOC byte).** Config→frame-duration table and
  frame-packing codes (0/1/2/3) used to derive per-packet sample counts.
  <https://datatracker.ietf.org/doc/html/rfc6716#section-3.1>
- **Vorbis I specification — Xiph.** Codec identification header (`0x01 "vorbis"`, channels, sample rate),
  the Ogg mapping (3 setup headers: identification / comment / setup), and the **per-packet blocksize** rule:
  a packet's decoded length is `(prev_blocksize + curr_blocksize) / 4`, with the current blocksize selected
  by the packet's mode number against the setup header's mode/blocksize tables (Appendix A, "Embedding Vorbis
  into an Ogg stream"). <https://xiph.org/vorbis/doc/Vorbis_I_spec.html> ·
  comment header: <https://xiph.org/vorbis/doc/v-comment.html>
- **FLAC-in-Ogg mapping — Xiph.** The mapping identification packet: `0x7F "FLAC"` + mapping version
  (major/minor) + **16-bit big-endian header-packet count** + native `"fLaC"` marker + STREAMINFO metadata
  block; remaining metadata blocks each go in their own packet on the following page(s).
  <https://xiph.org/flac/ogg_mapping.html>

OSS exemplar (studied and cited):

- **mediabunny — `Vanilagy/mediabunny`, `src/ogg/`.** Files: `ogg-demuxer.ts`, `ogg-muxer.ts`,
  `ogg-reader.ts`, `ogg-misc.ts`. <https://github.com/Vanilagy/mediabunny/tree/main/src/ogg>
  - `ogg-misc.ts` defines `OGG_CRC_POLYNOMIAL = 0x04c11db7` and a non-reflected table CRC
    (`computeOggPageCrc`) that zeroes the checksum field at offset 22 before computing — **structurally
    identical to our `oggCrc`/`CRC_TABLE`** (`src/drivers/ogg/ogg-write.ts:44-64,101-121`).
    <https://github.com/Vanilagy/mediabunny/blob/main/src/ogg/ogg-misc.ts>
  - `ogg-demuxer.ts` computes **exact Vorbis per-packet durations** via `extractSampleMetadata()`:
    `modeNumber = (data[0] & modeMask) >> 1`, `blocksize = vorbisInfo.blocksizes[blockflag]`,
    `durationInSamples = (prevBlocksize + currentBlocksize) >> 2`, threading `vorbisLastBlocksize` across
    packets — the exact partial-decode our driver deliberately does **not** do today (it even-splits;
    §4/§5). Opus durations come from the TOC; `granulePositionToTimestampInSamples` subtracts `preSkip`
    for Opus. <https://github.com/Vanilagy/mediabunny/blob/main/src/ogg/ogg-demuxer.ts>

Cross-cutting engine context: container contract `src/contracts/driver.ts` (`ContainerDriver` :411,
`Demuxer` :304, `Muxer` :324, `PacketInfoTable` :131, `PacketInfoMetadata` :118, `StreamCopyOptions` :334);
container sniff `matchesOgg` (`OggS` magic) in `src/drivers/audio-container-sniff.ts:56`; mux validation
`oggMuxCodec`/`validateOggMuxTrack`/`assertAudioMuxOptions` in
`src/drivers/audio-container-mux-validation.ts:20,98,116`.

## 3. Target design

### 3.1 Data model (the pure core)

The driver's spine is a set of **pure, Node-validated** functions over a byte buffer / `DataView`; only the
final per-chunk WebCodecs bridge is browser-only. Keep this split — it is the reason Ogg is bit-exactly
testable without a browser.

- **Page** — `parsePage(dv, at)` (`src/drivers/ogg/ogg-driver.ts:66`) returns
  `{ headerType, granule, serial, dataStart, pageEnd }`; `readGranule` maps all-ones to `-1`
  ("no packet completes on this page", `:58`).
- **De-laced packet** — `delacePackets(dv, serial)` (`:197`) walks the segment table, concatenating
  segments until a lace `< 255` terminates a packet, and carrying a run across pages when a page's last
  lace is `255` (HT_CONTINUED). A packet owns **ordered payload spans** (`OggPacketSpan`, `:172`) so a
  cross-page packet excludes intervening page headers/lacing bytes; each packet records the
  `pageGranule` of the page it **completed** on. A run still open at EOF is emitted `complete:false` and
  dropped (`:247-251`).
- **Framed packet** — `OggPacket` (`:305`): payload spans/size + `ptsUs`/`durationUs`. `oggAudioPackets`
  (`:485`) is the timing oracle.
- **Stream identity** — `identifyStream` (`:95`) recognizes Vorbis/Opus/FLAC BOS packets and fixes the
  **granule rate** (sampleRate for Vorbis/FLAC; **48000 for Opus** regardless of the input-rate field,
  `:109-119`).
- **Codec-private** — `codecPrivateDescription` (`:434`) extracts the WebCodecs `description`: Opus keeps
  its raw `OpusHead`; Vorbis is Xiph-laced id/comment/setup (`xiphLacedHeaders`, `:407`); FLAC concatenates
  native metadata blocks. The Ogg **muxer** reverses each of these (`headerPackets`,
  `src/drivers/ogg/ogg-write.ts:457`).

### 3.2 Seams

- **`probe`** → `parseOgg(head, tail?)` (`:598`): identify the first stream from the head, take the max valid
  `granule_position` across head+tail, duration `= granule / granuleRate`. Head+tail range probing only when
  both a finite `size` and `range` exist; otherwise read to EOS (`:1035-1043`).
- **`packetInfo`** → `oggPacketInfoTable` (`:627`): full de-lace, one row per audio packet
  (`OggPacketInfoMetadata` retains private `spans`, `:315`), no payload materialization.
- **`demux`** → live per-track `ReadableStream<Packet>` built by `packetStreamFromInfo` (`:988`), each
  packet wrapped as an `EncodedAudioChunk` with `type:'key'` (all Ogg audio packets are sync samples).
- **`createMuxer`/`streamCopy`** → the `OggMuxer` adapter (`src/drivers/ogg/ogg-write.ts:555`) over the pure
  `writeOgg`/`buildPages` page writer, and lossless remux/trim.

### 3.3 Capability routing (WebCodecs → GPU → WASM, miss-only)

Ogg is a **container** driver: page/lacing/granule/CRC arithmetic is *always* pure TS and never routes to a
backend. The routing surface is narrow and correct today:

- The **demux packet seam** needs `EncodedAudioChunk` (a browser/WebCodecs primitive) to hand coded audio to
  a decoder. In Node it fails loudly with a typed `CapabilityError('capability-miss', …, {op:'demux',
  tried:['ogg']})` **before** touching bytes (`:993-999`), mirroring the mpegts driver; the emission body is
  `v8 ignore` and validated under browser-mode. The developer never names "WebCodecs" — they call `demux()`
  and either get chunks (browser) or a typed miss (Node).
- The **mux write seam** likewise only needs `EncodedAudioChunk.copyTo()`; that single step is guarded and
  `v8 ignore`d (`src/drivers/ogg/ogg-write.ts:588-603`). The pure `addChunkStruct` path is what Node tests
  drive directly.
- **No GPU/WASM tier** exists or is needed for Ogg containering. Decode/encode (which *may* route to WASM on
  a hardware miss) is the codec drivers' concern (S31 Vorbis/Opus WASM), not this driver.

Capability-miss taxonomy the driver must keep raising as typed `CapabilityError`s (never generic throws):
non-audio track (`oggMuxCodec`, `audio-container-mux-validation.ts:98`), unsupported audio codec (`:107`),
a second logical stream (`validateOggMuxTrack`, `:116`), fragmented Ogg requested
(`assertAudioMuxOptions`, `:20`), WebM target for FLAC audio (`ogg-driver.ts:767`), and an unsupported
stream-copy target (`validateOggStreamCopyTarget`, `:675`).

### 3.4 Edge cases

- **B-frames — N/A (audio, no reordering).** Every Ogg audio packet is an independent sync sample; DTS ≡ PTS.
  The demux emits `{ chunk }` with `dtsUs` omitted (`:984-986`); the muxer ignores `packet.dtsUs`
  (`ogg-write.ts:594-595`). Target design keeps DTS out of the Ogg timeline entirely.
- **VFR — partially applicable.** There are no video frames, but Opus/Vorbis packets carry **variable
  per-packet durations** (Opus 2.5–60 ms per TOC; Vorbis short/long blocks). The timeline must therefore be
  built from *real* per-packet sample counts, not a fixed frame period. Opus is exact today
  (`opusPacketSamples`, `:293`); Vorbis is **approximated** today (§4) — the target is exact blocksize-based
  durations (§5, item 1).
- **Seek — target: granule bisection; today: none.** A correct Ogg seeker binary-searches byte offsets,
  resynchronizing on `OggS`, reading `granule_position`, and converging on the target sample, then
  backward-scans to the previous page whose granule ≤ target so the decoder starts on a packet boundary.
  Today the driver has **no random-access seek**: `demux`/`packetInfo`/`streamCopy` all call `readAll` and
  materialize the whole file (`:948,1050,1081`). Target design adds a granule-indexed seek path (§5, item 4).
- **Cancel — supported, keep it.** `AbortSignal` is honored on entry and between reads:
  `readAll`/`readOggChunk` race the read against abort and cancel+releaseLock the reader
  (`:929-979`); `packetInfo`/`demux`/`streamCopy` and `selectOggTrimPackets` re-check `aborted`
  (`:1046,1054,1080-1089,708`); the demux `pull` errors the stream on abort (`:1004-1006`). Target keeps
  every long-running loop abort-checked.
- **Frame lifetime (`close()` exactly once) — N/A for this driver.** Ogg produces **`EncodedAudioChunk`**
  (encoded packets, `:1020`) and consumes them on write — it never creates or owns a `VideoFrame`/`AudioData`.
  `EncodedAudioChunk` has no `close()`; there is nothing to close exactly once here. (The close()-exactly-once
  discipline lives in the codec/decode layers, S10/S30, that turn these chunks into frames.)
- **Backpressure — pull-based emit, but unbounded source read.** The demux stream is **pull-driven**
  (`ReadableStream({ pull })`, `:1002`): one `EncodedAudioChunk` is constructed per downstream pull, so
  chunk construction is naturally backpressured. **However** the source is fully buffered first (`readAll`,
  `:1050`), so peak memory is O(file). Target design streams pages incrementally so both emit *and* source
  read are bounded (§5, item 5). The mux side is single-shot: it buffers all chunks and serializes on
  `finalize` (`ogg-write.ts:614-635`) — acceptable for one-track audio but not a true streaming sink (§5,
  item 6).

### 3.5 Timing model (the crux — match/beat mediabunny)

- **Opus (exact + end-trim).** Per-packet samples from the TOC (`opusPacketSamples`, `:293`); the running
  decode granule starts at `-pre_skip` (from `OpusHead+10`, `readOpusPreSkip`, `:554`) so t0 is negative and
  matches ffprobe (`:499-511`). *Target adds end-trim:* the last packet's effective duration must be clamped
  so the accumulated granule equals the terminal page granule (the last page granule < accumulated samples
  when the file was end-trimmed). Today this clamp is missing on the **demux** Opus path (§5, item 2).
- **Vorbis / FLAC-in-Ogg.** Today: **even-split** of each page's granule delta across the packets that
  completed on that page (`:514-540`) — packet *count* and *byte size* are exact, per-packet PTS is an honest
  approximation whose **sum equals the true total**, and this is explicitly documented as not sample-exact
  (`:468-484`). Target: exact Vorbis durations from setup-header blocksizes like mediabunny (§5, item 1).
  We deliberately emit **every** coded audio packet including Vorbis's first priming packet (which produces
  no PCM but seeds the IMDCT overlap), so our container-true count is `ffprobe_output_count + 1` — keep this,
  it is correct for feeding a decoder (`:478-484`).

### 3.6 Muxer / writer target

`writeOgg` (`ogg-write.ts:481`) lays the identification header alone on the BOS page, comment/setup header(s)
on the next page(s) at granule 0, then audio pages with EOS on the last (`:530-538`). `buildPages`
(`:150`) is the pure lacing unit: it batches packets until the 255-entry segment table fills, splits a large
packet across pages with HT_CONTINUED, and stamps each page with the granule of the last packet that
*completed* on it (mid-packet pages carry `-1`) — matching RFC 3533. `serializePage` computes the Ogg CRC
over the assembled page with the CRC field zeroed (`:101-121`). Target keeps this exact shape and adds a
random, non-fixed `bitstream_serial_number` (§5, item 7).

## 4. Current state

What exists today, with the smells called out.

**God-file: `ogg-driver.ts` (1101 lines).** It mixes six concerns that should be separate layers:
1. Ogg **page/de-lace primitives** (`parsePage` :66, `delacePackets` :197, `readGranule` :58).
2. **Codec identification + codec-private** (`identifyStream` :95, `codecPrivateDescription` :434,
   `headerPacketCount` :327).
3. **Timing/framing** (`oggAudioPackets` :485, `opusPacketSamples` :293, `readOpusPreSkip` :554).
4. **Source I/O** (`readHead` :903, `readTail` :917, `readAll` :948, `readOggChunk` :929) — belongs to the
   sources layer (S06), not a container driver.
5. **Cross-container remux into WebM/Matroska** (`writeOggWebmPacketCopy` :753, `resetOpusPreSkip` :732,
   `selectOggTrimPackets` :697) — a **layering violation / inter-driver dependency**: the Ogg driver
   dynamically `import`s the WebM muxer (`await import('../webm/ebml-write.ts')`, `:780`). A container driver
   should not hardcode knowledge of a *sibling* container. This belongs in the generic demux→mux packet seam
   / remux runner (S14/S15).
6. The **driver object + registration** (`OggDriver` :1027, `OggModule` :1094).

**Typing smell / contract leak.** `demux()` bolts a `packetInfoTable` method onto the returned `Demuxer`
via an `as` cast (`:1058-1060`) because the `Demuxer` contract (`src/contracts/driver.ts:304`) only declares
`packetTable?`. This is an untyped extension of a public contract — either the contract declares it or the
driver must not add it.

**Duplication across the two owned files.** `OPUS_FRAME_SAMPLES` (the RFC 6716 TOC table) is defined **twice**
— `ogg-driver.ts:265` and `ogg-write.ts:32`; `opusPacketSamples` exists in two shapes (`ogg-driver.ts:293`
reading a `RawPacket` over spans; `ogg-write.ts:416` over a flat `Uint8Array`); `concatBytes` is duplicated
(`ogg-driver.ts:38`, `ogg-write.ts:78`). This is DRY debt in a correctness-critical table.

**Approximate Vorbis timing.** `oggAudioPackets` even-splits page granule deltas for Vorbis/FLAC
(`:514-540`) rather than doing the exact blocksize decode the setup header enables. Honest and documented,
but strictly less accurate than the exemplar.

**Whole-file buffering.** `probe` (when random access is unavailable), `packetInfo`, `demux`, and
`streamCopy` all read the entire source into one `Uint8Array` (`readAll`, `:948`; call sites
`:1039,1045,1050,1081`). Memory is O(file); there is no incremental page streaming and no seek index.

**Module-global state — mostly benign.** The only module-level mutable object is `CRC_TABLE`
(`ogg-write.ts:44`), built once in an IIFE and never mutated after — effectively frozen, not a cache smell.
There is **no** mutable module-global registry/cache in this driver. Good.

**`ogg-write.ts` (642 lines)** is the pure page writer + `OggMuxer`. Well-factored: `buildPages` (:150),
`serializePage` (:101), codec header construction (`synthOpusHead` :222, `splitVorbisHeaders` :260,
`splitFlacMetadata` :303, `flacHeaderPackets` :347), `trackStateFrom` (:400), `writeOgg` (:481), and the
single-shot `OggMuxer` (:555). The Vorbis granule distribution in `writeOgg` is **weighted** by sample spans
when durations are absent (`:489-512`) — the mux-side analog of the demux even-split; approximate for the
same reason.

**`ogg-prepared-mux.ts` (53 lines)** is a thin, clean adapter: `muxPreparedOggAudioPacketTrack` (:12) builds
a `TrackState`, pushes `ChunkStruct`s from `Packet`/`EncodedChunk`, and calls `writeOgg`. It reuses
demuxer-supplied `packet.data` when its length matches the chunk (`:49-53`) — the correct zero-recopy path.
No smells.

## 5. Delta / punch-list (ordered, each with an acceptance test)

1. **Exact Vorbis per-packet durations (replace even-split).** Parse the Vorbis setup header for the
   mode→blockflag map and the two blocksizes; for each audio packet compute
   `duration = (prevBlocksize + currBlocksize) / 4`, threading the previous blocksize (mediabunny
   `extractSampleMetadata`). Keep the priming packet in the count. Reference `ogg-driver.ts:514-540`.
   *Acceptance:* a strict oracle on `sound_5.oga` (the existing Vorbis fixture, see
   `ogg.test.ts:784`) asserts **per-packet** `durationUs` equals ffmpeg/ffprobe's `pkt_duration` for every
   audio packet (not just the running sum), and the final accumulated granule equals the terminal page
   granule exactly. The current even-split test at `ogg.test.ts:784` must be upgraded from "approximation"
   to bit-exact per packet.

2. **Opus end-trim on the demux path.** Clamp the last Opus packet's effective duration so the accumulated
   granule equals the terminal page `granule_position` (RFC 7845 end-trim), matching what `parseOgg` already
   reports as duration. Reference `ogg-driver.ts:499-511` (accumulation) vs `parseOgg` `:613-624`.
   *Acceptance:* on an end-trimmed Opus fixture, `sum(oggAudioPackets.durationUs)` equals
   `round(parseOgg.durationSec * 1e6)` within ±1 µs; assert the last packet's duration is shorter than its
   raw TOC duration when the granule demands it.

3. **Move cross-container remux out of the Ogg driver.** Delete the WebM/Matroska authoring from
   `ogg-driver.ts` (`writeOggWebmPacketCopy` :753, `resetOpusPreSkip` :732, `selectOggTrimPackets` :697,
   and the `import('../webm/ebml-write.ts')` :780). Ogg's `streamCopy` should return native Ogg
   (full-copy or Ogg-native trim via `writeOggPacketCopyTrim` :846) and hand cross-container targets to the
   generic packet-mux/remux seam (S14/S15), which already owns `packetInfoTable`→muxer wiring.
   *Acceptance:* `grep -R "webm" src/drivers/ogg/` returns nothing; the cross-container tests
   (`ogg.test.ts:335,389,428,472,495`) still pass by routing through the shared remux runner, proving the
   generic seam covers Ogg→WebM/MKV including Opus pre-skip reset and FLAC→WebM rejection.

4. **Granule-bisection seek (random-access demux).** Add a seek path that binary-searches byte offsets,
   resyncs on `OggS`, reads `granule_position`, and returns the packet index whose granule ≤ target sample,
   without `readAll`. Reference the whole-file reads at `ogg-driver.ts:948,1050`.
   *Acceptance:* on a large (>1 MB) Opus/Vorbis fixture, `seek(tSec)` reads O(log n) ranges (assert the
   `ByteSource.range` call count is bounded, not O(file)) and returns a packet whose PTS ≤ `tSec` and whose
   successor's PTS > `tSec`; decoded output from the seek point matches decoding from file start then
   skipping.

5. **Streaming (bounded-memory) demux.** Replace `readAll` in `demux`/`packetInfo` with an incremental page
   reader that de-laces page-by-page as ranges arrive, so peak memory is O(one page + one continued packet),
   not O(file). Reference `ogg-driver.ts:948,1050`.
   *Acceptance:* demuxing an N-MB file with a `ByteSource` that counts bytes held live asserts peak retained
   bytes < a small constant (e.g. ≤ 256 KiB) independent of N; packet output is byte-identical to the
   whole-file path.

6. **True streaming mux sink.** `OggMuxer.finalize` currently serializes the whole stream in one
   `controller.enqueue` (`ogg-write.ts:629`). Emit pages incrementally as packets arrive so the muxer is a
   real streaming sink (S07). *Acceptance:* muxing K packets enqueues ≥ 2 chunks before `finalize` and the
   concatenation is byte-identical to today's single-buffer output (round-trip via `parseOgg` + independent
   CRC scan, as in `ogg-write.test.ts:325`).

7. **Random `bitstream_serial_number`.** `writeOgg` hardcodes `DEFAULT_SERIAL = 0x00000001`
   (`ogg-write.ts:29,481`). RFC 3533 §4 wants a serial chosen to be unique so streams can be chained/muxed.
   *Acceptance:* two independent `createMuxer()` outputs of the same input have **different** serials
   (assert the 32-bit serial at page-header offset 14 differs), and both still round-trip through `parseOgg`.

8. **De-duplicate the Opus TOC table + helpers into one module.** Hoist `OPUS_FRAME_SAMPLES`
   (`ogg-driver.ts:265` / `ogg-write.ts:32`), `opusPacketSamples` (`ogg-driver.ts:293` /
   `ogg-write.ts:416`), and `concatBytes` (`ogg-driver.ts:38` / `ogg-write.ts:78`) into a shared
   `ogg-common.ts`. *Acceptance:* `grep -c "OPUS_FRAME_SAMPLES = \[" src/drivers/ogg/*.ts` == 1; existing
   Opus timing tests (`ogg.test.ts:753`, `ogg-write.test.ts:378`) still pass unchanged.

9. **Type the `packetInfoTable` extension in the contract.** Remove the `as` cast at
   `ogg-driver.ts:1058-1060` by adding an optional `packetInfoTable?(): readonly PacketInfoMetadata[]` to the
   `Demuxer` interface (`src/contracts/driver.ts:304`) — a doc-only note here; the change lands in S04.
   *Acceptance:* the driver compiles with `zero any` and no `as` cast around `packetInfoTable`; a type test
   asserts `Demuxer['packetInfoTable']` is the declared optional method.

10. **Split the god-file into layers.** Extract source I/O (`readHead`/`readTail`/`readAll`/`readOggChunk`
    :903-979) toward the sources layer (S06) or a small `ogg-source.ts`, and page primitives into
    `ogg-page.ts`, leaving `ogg-driver.ts` as the `ContainerDriver` wiring. *Acceptance:* `ogg-driver.ts`
    drops below ~400 lines and imports its primitives; the full Ogg test suite
    (`ogg.test.ts`, `ogg-write.test.ts`) passes with no behavior change.

## 6. Open questions (seed `docs/decisions/`)

1. **Exact vs approximate Vorbis timing — is a partial Vorbis setup-header parse worth the code?** Exemplar
   does it (`(prev+curr)/4`). Decide: implement the blocksize decode (delta item 1) or keep the documented
   even-split with a strict *sum-exact* oracle only. Recommendation: implement exact — the demux benchmark
   is graded on per-packet correctness.

2. **Where does cross-container Ogg→WebM/MKV remux live?** Today it lives inside the Ogg driver with a hard
   dependency on the WebM muxer (`ogg-driver.ts:780`). Decide the ownership boundary: generic packet-mux
   seam (S14/S15) vs per-source driver. Recommendation: generic seam; drivers expose `packetInfoTable`, not
   sibling-container knowledge.

3. **Negative Opus t0 downstream.** The demux emits a negative first PTS (`= -pre_skip`, `:502`) into
   `EncodedAudioChunk.timestamp` (`:1017`). Confirm every downstream consumer (WebCodecs decoder,
   re-muxers) tolerates negative timestamps, or decide on a normalization/anchor policy.
   `UNVERIFIED: whether all target browsers' AudioDecoder accept a negative EncodedAudioChunk.timestamp` —
   needs a browser-mode check.

4. **Tail-window sizing for `readTail`.** `readTail` fetches a fixed 64 KiB tail (`HEAD_BYTES = 1<<16`,
   `:900,917`). A maximal Ogg page is 27 + 255 + 255·255 = 65307 bytes, so a single final page fits, but
   confirm the window is always ≥ max page size and document the invariant, or make it adaptive.
   `UNVERIFIED: that no real fixture has a terminal page whose granule is unreachable within a 64 KiB tail`.

5. **Fixed serial number policy.** Is a deterministic serial (current `0x00000001`) preferable for
   reproducible/byte-golden mux tests, or should we randomize (RFC 3533) and make goldens serial-agnostic?
   Decide the golden strategy alongside delta item 7.

6. **Chained / multiplexed Ogg.** The driver assumes a single logical audio stream (`firstRecognizedStream`
   :344; second track is a typed miss, `audio-container-mux-validation.ts:116`). Decide whether chained Ogg
   (concatenated logical streams) or A/V-multiplexed Ogg is in scope; today it is explicitly not. Log the
   scope boundary.

7. **Theora activation.** `identifyStream` reserves Theora for "when its fixtures land"
   (`ogg-driver.ts:147`). Decide the trigger (fixture + golden availability) and whether Theora video makes
   Ogg a *video* container in the router, which reshapes §3.4 (B-frames become relevant for Theora).
