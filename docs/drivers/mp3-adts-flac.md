# MP3 / ADTS / FLAC Drivers

> Shard S28 — the three **self-framed elementary audio-stream** container drivers.
> Owned code: `src/drivers/mp3/*.ts`, `src/drivers/adts/*.ts`, `src/drivers/flac/*.ts`.
> This document is the **target spec** (the best design) plus an **honest delta** vs today's code.

## 1. Purpose & scope

This family covers three containers that are not really containers at all: they are **elementary
streams of self-describing coded audio frames** concatenated back-to-back, with no front index and no
per-frame timestamp table.

- **MP3** — MPEG-1/2/2.5 Audio Layer III. Each frame carries its own 4-byte MPEG header; VBR duration
  is recovered from a leading Xing/Info metadata frame (or LAME gapless tuple), else from a full-frame
  clock walk, else CBR byte-rate estimation (`src/drivers/mp3/mp3-driver.ts:258`).
- **ADTS** — raw AAC wrapped in a 7- or 9-byte ADTS header (`0xFFF` syncword). The first header carries
  audio-object-type / sampling-frequency-index / channel-config; duration is the exact per-frame sample
  sum (`src/drivers/adts/adts-frames.ts:191`).
- **FLAC** — native FLAC: `fLaC` magic + metadata blocks (STREAMINFO first) + coded audio frames.
  Duration comes from STREAMINFO's 36-bit total-sample count (`src/drivers/flac/flac-sniff.ts:73`).

**Benchmark families served: `demux` and `mux`** (per the shard map in `docs/architecture/COVERAGE.md`). Because
these are elementary streams, the same owned code also feeds several adjacent families the manifest
routes elsewhere: `probe` (metadata) via `probe()`; `decode-seek` via `packetInfo()`/`packetTable()`;
`trim` via `streamCopy({ trim })`; `remux` via verbatim frame copy and FLAC→Ogg stream-copy
(`src/drivers/flac/flac-driver.ts:699`); `transcode`/`convert` via ADTS→WAV `decodePcm`
(`src/drivers/adts/adts-driver.ts:860`), FLAC→WAV/FLAC `transformPcm` (`.../flac-driver.ts:772`), and
native FLAC **encode** (`src/drivers/flac/flac-codec.ts:233`). MP3 **encode** is a deliberate
capability-miss (no permissive encoder exists — `docs/measured-evidence.md` ADR-105/ADR-031).

The unifying design fact: **every audio frame is an independently-decodable sync sample** (`type:'key'`),
DTS == PTS, so the demux/mux seam is "walk frames → emit key chunks" / "concatenate frames verbatim".

## 2. Spec & references

### Governing standards
- **MPEG-1 Audio (Layer III framing):** ISO/IEC 11172-3. Header field layout (version/layer/bitrate/
  sample-rate/padding/channel-mode) — mirrored in `parseFrameHeader` (`src/drivers/mp3/mp3-driver.ts:73`).
- **MPEG-2 Audio (lower sample rates):** ISO/IEC 13818-3, giving the 576-sample MPEG-2 frames and the
  MPEG-2 bitrate table (`BITRATES_MPEG2_L3`, `src/drivers/mp3/mp3-driver.ts:39`). MPEG-2.5 (version code
  `0`, 8/11.025/12 kHz) is a de-facto Fraunhofer extension, not in an ISO text — handled at
  `src/drivers/mp3/mp3-driver.ts:36`.
- **Xing/Info VBR header** — de-facto (Xing SDK / LAME). Frame-count + flags layout: `xingFrameCount`
  (`src/drivers/mp3/mp3-driver.ts:133`). Field reference:
  <http://www.mp3-tech.org/programmer/frame_header.html> and the Xing/LAME tag description at
  <https://www.hydrogenaud.io/knowledge/lame_tag> (LAME encoder-delay/padding tuple, 12 bits each —
  `parseVbrHeader`, `src/codecs/wasm-mp3/mp3.ts:341`).
- **MPEG-4 Audio / ADTS:** ISO/IEC 14496-3 §1.A (ADTS syntax) and ISO/IEC 13818-7 (MPEG-2 AAC ADTS).
  Sampling-frequency-index table + AudioSpecificConfig (§1.6.2.1) — `ADTS_SAMPLE_RATES`
  (`src/drivers/adts/adts-frames.ts:19`), `audioSpecificConfig` (`src/drivers/adts/adts-driver.ts:131`).
- **RFC 6381** (codec strings): the `mp4a.40.2` (AAC-LC) token the ADTS driver publishes
  (`src/drivers/adts/adts-driver.ts:157`). <https://www.rfc-editor.org/rfc/rfc6381>
- **FLAC:** **RFC 9639** — *Free Lossless Audio Codec (FLAC)*. STREAMINFO packing, metadata-block chain,
  frame headers + block-size codes (§9.1.1, cited in code at `src/drivers/flac/flac-driver.ts:659`), and
  the STREAMINFO unencoded-audio MD5. <https://www.rfc-editor.org/rfc/rfc9639.html> ·
  format page <https://xiph.org/flac/format.html>
- **W3C WebCodecs** — the `EncodedAudioChunk` / `AudioData` / `AudioDecoder` / `AudioEncoder` seam these
  drivers marshal frames across. <https://www.w3.org/TR/webcodecs/>

### OSS exemplars (studied)
- **Symphonia** (Rust) — <https://github.com/pdeljanov/Symphonia>
  - MP3: `symphonia-bundle-mp3/src/demuxer.rs` (reader/frame walk), `header.rs` (frame-header parse) —
    *verified structure*. A single header parser feeds both demux and decode; the reader builds a seek
    index. (`symphonia-bundle-mp3/src/decoder.rs` is the codec, out of this shard.)
  - ADTS: `symphonia-codec-aac/src/adts.rs` (ADTS reader/framing) + `aac/` (decoder) — *verified*. The
    transport (ADTS framing) is cleanly separated from the codec.
  - FLAC: `symphonia-bundle-flac` — STREAMINFO + frame parsing with MD5 verification. (Exact file names
    UNVERIFIED; the crate is correct.)
- **mediabunny** (TypeScript, in-browser) — <https://github.com/Vanilagy/mediabunny>
  - MP3: `src/mp3/{mp3-reader,mp3-demuxer,mp3-muxer,mp3-writer}.ts` — *verified*.
  - ADTS: `src/adts/{adts-reader,adts-demuxer,adts-muxer}.ts` — *verified*.
  - FLAC: `src/flac/{flac-demuxer,flac-misc,flac-muxer}.ts` — *verified*.
  - mediabunny splits **reader** (byte parse) from **demuxer** (track/packet model) from **muxer**, and
    streams mux output through a `Target`/`Writer` rather than materializing the whole file. Our design
    should match that reader/demuxer split (we currently fuse them) and its streaming output.

Where SOTA should **beat** the exemplars: our ADTS walker already does bounded-read incremental probing
with resync (`src/drivers/adts/adts-frames.ts:131`) that Symphonia/mediabunny do per-read but not with a
seek-over-tag fast-path; our FLAC probe reads only the 42-byte STREAMINFO prefix
(`src/drivers/flac/flac-sniff.ts:108`, `docs/measured-evidence.md`). The gap to close is the **shared framing
seam** and **streaming mux**, both of which the exemplars have and we do not.

## 3. Target design

### 3.1 Data model — one shared "elementary audio stream" abstraction

All three formats are the same shape:

```
[optional leading tag(s)] [optional header/metadata frame] frame₀ frame₁ … frameₙ [optional trailing tag]
```

Target model (the seam every driver implements exactly once):

- **`ElementaryFrame`** — `{ offset, size, headerBytes, ptsUs, durationUs, samples }`. Today this is
  three near-identical types: `Mp3Packet` (`src/drivers/mp3/mp3-driver.ts:155`), `AdtsPacket`
  (`src/drivers/adts/adts-driver.ts:97`) / `AdtsWalkedFrame` (`src/drivers/adts/adts-frames.ts:52`), and
  `FastFlacFrameSpan`/`FlacFrame` (`src/drivers/flac/flac-sniff.ts:29`). They should be one type.
- **`FrameHeaderParser`** — pure `(bytes, at) => Header | undefined`, per codec. Today there are **three
  MP3 parsers** (`mp3-driver.ts:73`, `mp3-mux.ts:201`, `src/codecs/wasm-mp3/mp3.ts:145`) and **two FLAC
  block-size decoders** (`flac-driver.ts:660`, `flac-sniff.ts:281`). Target: one per codec.
- **`ElementaryFramer`** — the incremental, bounded-read, resyncing walker. `AdtsFrameWalker`
  (`src/drivers/adts/adts-frames.ts:131`) is the reference implementation (carry buffer, tag skip,
  double-syncword resync confirmation, exact per-rate duration accumulation, truncated-tail handling).
  MP3 and FLAC should be *parameterizations* of this walker, not bespoke whole-buffer loops
  (`enumerateMp3Packets` `mp3-driver.ts:229`; `fastFlacFrames` `flac-sniff.ts:182`).
- **Track facts** come from the first locked header (codec string, rate, channels, ASC/STREAMINFO
  description). `TrackInfo.config.description` carries the codec-private prelude: ADTS synthesizes a
  2-byte ASC (`adts-driver.ts:131`); FLAC carries the native `fLaC`+metadata prelude (`flac-sniff.ts:214`);
  MP3 needs none.

### 3.2 Seams (layering)

```
                 sniff (matchesMp3/matchesAdts/matchesFlac — src/drivers/audio-container-sniff.ts, flac-sniff.ts:65)
                                   │
  ByteSource ──► ContainerDriver ──┼── probe()        → TrackInfo[]              (bounded head read)
                                   ├── packetInfo()   → PacketInfoTable          (payload-free rows)
                                   ├── demux()        → Demuxer{ packets()→ReadableStream<Packet>, packetTable() }
                                   ├── streamCopy()   → verbatim frame copy (+trim, +declared targets)
                                   ├── decodePcm/decodePcmAudio/transformPcm → PCM/WAV/FLAC (codec-routed)
                                   ├── decrypt()      → HLS-AES128 bridge (ADTS only)
                                   └── createMuxer()  → Muxer{ addTrack, write, finalize }
```

Rules the target enforces:
- The **framer is pure and Node-testable** (no WebCodecs). Only the `packets()` stream and `Muxer.write`
  touch `EncodedAudioChunk`/`copyTo`, guarded so Node raises a typed `CapabilityError`
  (`mp3-driver.ts:405`, `adts-driver.ts:710`, `flac-driver.ts:256`).
- **No container driver statically names a codec backend.** Codec cores are reached only through the
  router on a hardware miss (see 3.3). *(Today ADTS violates this — `adts-driver.ts:12`.)*
- **Decode returns PCM samples, not another container's bytes.** `decodePcmAudio` → `PcmAudio` is the
  clean seam (FLAC has it — `flac-driver.ts:767`); a WAV/PCM sink authors bytes. *(Today ADTS `decodePcm`
  bakes WAV authoring into the container — `adts-driver.ts:880`.)*

### 3.3 Capability routing (WebCodecs → GPU → WASM, miss-only)

The developer never names a backend; the router picks. GPU tier does not apply (pure audio — no shader
stage). Miss-only means the heavy WASM core downloads only after the native probe fails.

| Op | Native (WebCodecs) | WASM tail (miss-only) | Pure-TS | Notes |
|----|--------------------|-----------------------|---------|-------|
| MP3 **decode** | `AudioDecoder('mp3')` | `wasm-mp3` (Symphonia, decode-only) | — | MP3 is decode-only everywhere. |
| MP3 **encode** | — (no browser MP3 encoder) | — (LAME is LGPL) | — | Honest `CapabilityError` (ADR-105/031). |
| AAC (ADTS) **decode → PCM** | `AudioDecoder(mp4a.40.2)` | `wasm-aac` (Symphonia, AAC-LC) | — | Plan: `adtsAacPcmDecodePlan` (`adts-driver.ts:219`). Firefox / `force-software` → wasm-only; small (≤256 KiB) no-DSP s16 → direct wasm WAV (`adts-pcm-direct.ts:24`). |
| AAC **encode** | `AudioEncoder(aac)` | `wasm-aac` | — | (Authoring path is S12/S31, not this shard's mux.) |
| FLAC **decode → PCM** | — (Chrome 149 has no FLAC decoder) | — | **pure-TS** `decodeFlac` (ADR-024) | Always pure-TS (`flac-driver.ts:307`). |
| FLAC **encode** | — (no browser FLAC encoder) | — | **pure-TS** `FlacFrameEncoder`, `tier:'native'` | Miss-only behind `AudioEncoder.isConfigSupported('flac')`=false (`flac-codec.ts:351`). |

The ADTS PCM plan is the model to generalize: try native, catch `CapabilityError`, fall to the wasm tail,
and if the whole plan misses raise one aggregated `CapabilityError` naming every rung tried
(`aacPcmPlanMiss`, `adts-driver.ts:630`). MP3 decode should route the same way through the codec seam.

### 3.4 Edge cases (explicit)

- **B-frames / reordering — N/A.** Audio is never reordered; every frame is a key sample and DTS == PTS,
  so packets omit `dtsUs` (`adts-driver.ts:740` comment; `mp3-driver.ts:402`). No CTS/`ctts` logic exists
  or is needed.
- **VFR (variable framing).** The audio analogue of VFR is per-frame variable *frame length* / *block
  size*. Handled by re-parsing each header at its own offset rather than striding a constant: MP3
  honors per-frame VBR bitrate (`enumerateMp3Packets`, `mp3-driver.ts:237`); ADTS closes/opens a
  constant-rate run when the header rate changes (`AdtsFrameWalker.#closeRun`, `adts-frames.ts:217`,
  `#emit` `:381`); FLAC uses each frame header's own block-size code (`frameBlockSize` `flac-driver.ts:660`,
  `parseFastFlacFrameHeader` `flac-sniff.ts:281`). PTS is a cumulative sample counter — the only clock
  these formats have.
- **Seek.** These containers have **no front index**. MP3's Xing TOC is approximate; FLAC's optional
  SEEKTABLE is too sparse to enumerate packets (the benchmark fixture has 10 seek points for 105
  packets — `docs/measured-evidence.md`), so packet tables are derived from native frame headers, not SEEKTABLE
  (`fastFlacFrames`, `flac-sniff.ts:182`). Seek granularity is **every frame** (all sync samples); the
  decode-seek family (S10) uses `packetInfo()`/`packetTable()` rows to map a target time to a frame
  offset. Trim exploits this with keyframe-accurate frame selection
  (`selectAdtsFrames` `adts-driver.ts:421`; `writeFlacPacketCopy` `flac-driver.ts:92`). Target: expose a
  `seekToTime(us) → frameIndex` helper on the shared framer instead of each caller re-filtering.
- **Cancel.** `AbortSignal` is checked before/around every read and inside every `pull` (throwIfAborted:
  `mp3-driver.ts:311`, `adts-frames.ts:442`, `flac-driver.ts:704`; per-window in `probeAdtsStream`
  `adts-frames.ts:467`). Streams surface abort via `controller.error(new MediaError('aborted', …))`
  (`mp3-driver.ts:418`). FLAC encode removes its abort listener in `teardown` (`flac-codec.ts:258`).
  Gap: `readAll` fully buffers before the first mid-read abort check on non-range MP3/FLAC sources
  (`mp3-driver.ts:291`) — the ADTS windowed reader is the correct model.
- **Frame lifetime (`close()` exactly once).** `EncodedAudioChunk` has no `close()`; the only owned
  `AudioData` sites are: (a) native AAC decode output — closed in `finally` per callback
  (`adts-driver.ts:558-564`); (b) FLAC encode input — closed in `finally` right after its planes are read
  (`flac-codec.ts:320-322`). Both are close-exactly-once even on throw/abort. No `VideoFrame` in this
  shard.
- **Backpressure.** ADTS `packets()` is pull-driven with `highWaterMark:0` (`adts-driver.ts:743`) — the
  best form. MP3/FLAC `packets()` use default-HWM pull streams (`mp3-driver.ts:415`, `flac-driver.ts:265`)
  and should adopt `highWaterMark:0` too. **Muxers do not stream:** each buffers every frame and emits the
  whole file in one `enqueue` at `finalize` (`assembleMp3` `mp3-mux.ts:376`, `assembleAdts`
  `adts-mux.ts:164`, `FlacMuxer.#serialize` `flac-driver.ts:480`). Backpressure is trivially satisfied but
  memory is O(file). Target: stream frames to the output `Target` as they arrive (Xing/STREAMINFO
  header backpatched), matching mediabunny.

## 4. Current state (with citations)

What exists today, and the smells.

### MP3 (`src/drivers/mp3/`, 2 product files)
- `mp3-driver.ts` (488 lines): bounded-head probe with ID3v2-skip + Xing/LAME gapless + full-frame-walk
  or CBR fallback (`:258`, `:319`); whole-file `enumerateMp3Packets` (`:229`); `demux`/`packetInfo`/
  `packets()` (`:452`,`:457`,`:404`); `Mp3Muxer` re-export.
- `mp3-mux.ts` (388 lines): synthesizes a Xing frame (with LAME gapless tuple) then concatenates verbatim
  audio frames (`buildXingFrame` `:346`, `assembleMp3` `:376`).
- **Smells:** the MPEG frame-header parser + `SAMPLE_RATES`/`BITRATES_*` tables are **duplicated three
  ways** — `mp3-driver.ts:73`/`:33-39`, `mp3-mux.ts:201`/`:23-29`, and `src/codecs/wasm-mp3/mp3.ts:145`.
  `enumerateMp3Packets` has **no mid-stream resync** (`:240` stops at the first non-parsing byte), unlike
  the ADTS walker, so a bit error or embedded tag silently truncates the frame list. `buildXingFrame`
  writes a **fabricated `LAME3.99r` version string** (`mp3-mux.ts:366`) it did not encode with.

### ADTS (`src/drivers/adts/`, 3 product files) — a god-file
- `adts-driver.ts` (901 lines) is the god-file: it fuses the pure framer entry, native+wasm AAC PCM
  decode (`:530`,`:602`,`:658`), a URL-keyed **module-global trim byte cache** (`adtsTrimUrlByteCache`
  `:75`, TTL/entry caps `:52-54`), lazily-loaded direct-WAV module handles (**module-global mutable**
  `adtsPcmDirectModule`/`…Promise` `:76-77`), the HLS-AES128 decrypt bridge (`:839`), stream-copy+trim
  (`:827`), packet-provenance registration (`:745`), and WAV authoring on decode (`:880`).
- `adts-frames.ts` (496 lines): the **excellent** incremental `AdtsFrameWalker` (`:131`) + bounded-read
  `probeAdtsStream` (`:451`) + `adtsHeadOffset` (`:406`). This is the SOTA framer the other two should reuse.
- `adts-mux.ts` (180 lines): 7-byte ADTS header synthesis + verbatim AU concatenation (`:37`,`:164`).
- `adts-pcm-direct.ts` (160 lines): batched wasm-AAC→s16-WAV fast path (`:111`).
- **Smells:** **capability leak** — `adts-driver.ts:12` statically imports `loadAacCore` from
  `../../codecs/wasm-aac/wasm-aac-driver.ts`, so merely loading the container driver references the WASM
  AAC backend by name (contrast the *lazy* `import()` for `adts-pcm-direct` `:81` and `runtime-detect`
  `:654`). `payload()` is duplicated (`adts-driver.ts:385` and `adts-pcm-direct.ts:82`) and
  `ADTS_DIRECT_WASM_S16_MAX_BYTES` is defined twice (`adts-driver.ts:55`, `adts-pcm-direct.ts:8`), with an
  overlapping double gate `mayUseAdtsDirectWasmS16Wav` (`:372`) + `canUseAdtsWasmDirectS16Wav` (`:24`).
  `decodePcm` returns finished **WAV bytes** (`:880`) instead of `PcmAudio`, coupling the ADTS chunk to the
  WAV driver (`import { writeWav }` `:37`).

### FLAC (`src/drivers/flac/`, 3 product files) — a god-file
- `flac-driver.ts` (810 lines) fuses: container probe/demux/packetInfo (`:701`,`:712`,`:707`); the native
  `FlacMuxer` with STREAMINFO backfill (`:391`); packet-copy trim + STREAMINFO rewrite (`:92`); FLAC→Ogg
  stream-copy (`:201`); FLAC→WAV/PCM decode (`:755`,`:767`); PCM→FLAC authoring for the cross-container
  route (`:334`,`:350`); and `transformPcm` (`:772`).
- `flac-sniff.ts` (366 lines): 42-byte STREAMINFO-prefix seekable probe (`:121`), `flacMetadataLayout`
  (`:147`), CRC-8-validated frame walk `fastFlacFrames` (`:182`,`parseFastFlacFrameHeader` `:281`).
- `flac-codec.ts` (371 lines): the pure-TS FLAC **encode** codec driver (`tier:'native'`, miss-only) —
  `PlanarBlockAccumulator` (`:99`), `quantizePlanes` (`:155`), `createEncoder` `TransformStream` (`:233`).
- **Smells:** the FLAC **block-size decoder + `FLAC_BLOCK_SIZE_TABLE` are duplicated** — `flac-driver.ts:660`
  /`:504` vs `flac-sniff.ts:281`/`:363`. `backfillStreamInfoMd5` **fully re-decodes the just-assembled
  stream** to compute the MD5 (`flac-driver.ts:518-531`) even though `flac-codec.ts` already streams the
  PCM — and its own top comment claims it hashes the MD5 incrementally (`flac-codec.ts:231`) while the
  code actually publishes MD5 `0` and defers to the muxer (`:270-276`, `:330-331`): a self-contradictory
  double-work. STREAMINFO field packing lives in three places (`flac-driver.ts` `buildMuxStreamInfo` `:541`
  & `streamInfoForPacketCopy` `:158`; `flac-sniff.ts` `parseFlacStreamInfo` `:73`).

### Cross-cutting
- Three separate `readAll()` implementations (`mp3-driver.ts:291`, `adts-driver.ts:176`, `flac-driver.ts:220`)
  with subtly different stream-drain logic.
- Three separate `ascii`/`asciiAt` helpers (`mp3-driver.ts:41`, `mp3-mux.ts:242`, `flac-sniff.ts:45`).

## 5. Delta / punch-list (ordered, each with an acceptance test)

Ordered by leverage (shared seam first, then per-driver correctness, then streaming).

1. **Extract one `FrameHeaderParser` per codec; delete the duplicates.**
   Collapse the three MP3 parsers (`mp3-driver.ts:73`, `mp3-mux.ts:201`, `codecs/wasm-mp3/mp3.ts:145`) to
   one, and the two FLAC block-size decoders (`flac-driver.ts:660`, `flac-sniff.ts:281`) to one; share the
   `SAMPLE_RATES`/`BITRATES_*` and `FLAC_BLOCK_SIZE_TABLE` constants.
   **Acceptance:** a test imports the single parser and asserts byte-identical header fields on the real
   `sound_5.mp3` / `sfx.flac` fixtures; `grep -c "BITRATES_MPEG1_L3\|FLAC_BLOCK_SIZE_TABLE ="` across
   `src/drivers/{mp3,flac}` returns 1 each. All existing golden tests (`mp3.test.ts`, `flac.test.ts`) stay
   green.

2. **Fix the ADTS capability leak — lazy-load `wasm-aac`.**
   Replace the top-level `import { loadAacCore }` (`adts-driver.ts:12`) with a `import()` reached only on a
   native miss (mirror `loadAdtsPcmDirectModule` `:79`).
   **Acceptance:** a bundler/static-analysis test asserts `src/drivers/adts/adts-driver.ts` has **no static
   import** of any `src/codecs/wasm-aac/*`; the eager-kernel/default-closure size budget
   (`docs/measured-evidence.md`: ≤50 KiB eager, ≤256 KiB closure) is re-measured and does not regress; ADTS→WAV
   decode on `sfx.adts` still passes via the lazy path.

3. **Give ADTS a `decodePcmAudio` and stop returning WAV from the container.**
   Add `AdtsDriver.decodePcmAudio → PcmAudio` (like `flac-driver.ts:767`); keep `decodePcm` as a thin WAV
   author in the sink layer so the ADTS chunk drops `import { writeWav }` (`adts-driver.ts:37`).
   **Acceptance:** `AdtsDriver.decodePcmAudio(sfx.adts)` returns `PcmAudio` whose interleaved bytes hash
   equal to the current `decodePcm` WAV payload (minus the 44-byte header); `grep writeWav
   src/drivers/adts/adts-driver.ts` returns nothing.

4. **De-duplicate the ADTS direct-WAV gate.**
   Keep exactly one `ADTS_DIRECT_WASM_S16_MAX_BYTES` and one `payload()`; fold `mayUseAdtsDirectWasmS16Wav`
   (`adts-driver.ts:372`) into `canUseAdtsWasmDirectS16Wav` (`adts-pcm-direct.ts:24`).
   **Acceptance:** a unit test drives the single predicate across `{wasm-only, force-software,
   size≤256KiB, size>256KiB, container≠wav, DSP present}` and asserts the exact route chosen for each;
   `sfx.adts` extraction bytes are unchanged (byte-equal to the committed golden).

5. **MP3 framer must resync mid-stream like ADTS.**
   Replace the whole-buffer `enumerateMp3Packets` (`mp3-driver.ts:229`) with the shared incremental walker
   so a mid-stream ID3/APE block or a bit error recovers the trailing frames instead of truncating at
   `:240`.
   **Acceptance:** a crafted fixture = `[valid frames][8 junk bytes][valid frames]` yields a packet count
   equal to the sum of both runs (fails today, which stops at the junk), matching how the ADTS walker
   resyncs (`adts-frames.ts:342`).

6. **Thread the FLAC encoder's incremental MD5 to the muxer; delete the re-decode.**
   `flac-codec.ts` streams the PCM — have it hash MD5 incrementally (its comment already claims this,
   `:231`) and hand the digest to the muxer (via `onConfig`/a finalize hook) so `backfillStreamInfoMd5`
   (`flac-driver.ts:518`) no longer calls `decodeFlac` on the whole output.
   **Acceptance:** with a spy on `decodeFlac`, `media.encode(pcm → flac)` produces a stream whose
   STREAMINFO MD5 round-trips (`decodeFlac(out).md5` equals `md5(interleavedPcmBytes)`) **without**
   `decodeFlac` being called during finalize (it is called once today). The remux path (non-zero supplied
   MD5) is untouched.

7. **Unify `readAll`, `ascii`, and the `ElementaryFrame` type.**
   One `readAll(src)` and one `ascii()` helper shared across the shard; one `ElementaryFrame` replacing
   `Mp3Packet`/`AdtsPacket`/`FlacFrame`.
   **Acceptance:** `grep -rc "async function readAll" src/drivers/{mp3,adts,flac}` == 0 (moved to a shared
   module); all three drivers' `packetInfo`/`demux` golden tables (`toEqual` in the `*.test.ts`) stay
   byte-identical.

8. **Stream the muxers instead of materializing the whole file.**
   Emit each frame to the output `Target` as it is written; for MP3, write the Xing frame with a
   placeholder frame/byte count and backpatch on `finalize` (mediabunny's approach); for FLAC, backpatch
   STREAMINFO total-samples/min-max at the front.
   **Acceptance:** muxing a 10-minute source measures **peak RSS bounded** (e.g. < 4 MiB over a
   single-frame baseline) via the benchmark harness memory probe, while the output bytes remain
   byte-identical to today's single-`enqueue` result on `mux/mp3_to_mp3` and `mux/flac_to_mkv_audio`
   (`docs/measured-evidence.md` medians 3.900 ms / 2.725 ms as the perf floor to hold).

9. **`highWaterMark:0` on the MP3/FLAC packet streams.**
   Match ADTS (`adts-driver.ts:743`).
   **Acceptance:** a slow consumer reading one packet at a time causes exactly one `pull` per `read`
   (assert `pull` call count == packets consumed), demonstrating no eager buffering.

10. **Split each god-file along the seam.**
    Move ADTS PCM-decode routing, the trim URL cache, and the decrypt bridge out of `adts-driver.ts`;
    move FLAC muxing/STREAMINFO packing and PCM-authoring out of `flac-driver.ts`, leaving each
    `*-driver.ts` as the thin `ContainerDriver` object over the shared framer + a codec seam.
    **Acceptance:** `adts-driver.ts` and `flac-driver.ts` each drop below ~350 lines; the module-global
    `adtsTrimUrlByteCache`/`adtsPcmDirectModule` (`adts-driver.ts:75-77`) live in a single owned cache
    module with an explicit `clear()` used by tests; full shard test + bench gate stays green.

## 6. Open questions (→ `docs/decisions/`)

1. **Shared framer vs per-codec walkers.** Should MP3/FLAC be forced through the `AdtsFrameWalker`
   generalized to a `ByteSyncFramer<Header>`, or is the coupling risk (three very different
   sync/tag/resync rules) worth keeping them separate but sharing only the header parsers? Decide the
   seam boundary before item 1/5/7 land.
2. **MP3 encode license boundary.** MP3 encode stays an honest `CapabilityError` (no permissive encoder;
   LAME/Shine are LGPL — `docs/measured-evidence.md` ADR-105/031). Log whether an *opt-in, separately-licensed,
   lazily-loaded* LGPL LAME tail is ever in scope, and if so how the router advertises it without leaking
   a backend name.
3. **Fabricated `LAME3.99r` tag.** `buildXingFrame` writes a LAME version string it did not encode with
   (`mp3-mux.ts:366`). Is emitting a plausible-but-untrue encoder magic acceptable to carry the gapless
   tuple (decoders key on the `LAME` magic), or should we write only the `Xing` frame + a neutral/blank
   version? Weigh decoder compatibility vs the "NEVER FAKE" directive.
4. **ADTS `channel_configuration 0`.** Rejected today (`adts-driver.ts:228`) because the PCE-inline channel
   map isn't parsed. Decide whether to parse the PCE (some real streams use config 0) or keep the typed
   miss.
5. **FLAC SEEKTABLE.** We deliberately ignore SEEKTABLE for packet enumeration (too sparse —
   `docs/measured-evidence.md`). Should we *use* it as a coarse seek hint for `seekToTime` (item under 3.4) while
   still deriving exact frames from headers? Log the trade-off.
6. **Streaming mux backpatch mechanism.** Item 8 needs a `Target` that supports a seek-and-rewrite of the
   header region (Xing count / STREAMINFO totals). Decide whether the sink layer exposes a
   backpatchable-header primitive or whether these formats keep a bounded two-region buffer (header held,
   frames streamed). Coordinate with S07 (streaming-output) and S14 (mux).
