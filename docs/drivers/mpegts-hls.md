# Driver: MPEG-TS & HLS (S25)

> Target spec for the MPEG-2 Transport Stream container driver and the HLS manifest source adapter.
> This is the **best** design plus an honest delta against today's code — not a description of today's code.
> Owned code: `src/drivers/mpegts/{mpegts-driver,mpegts-sniff,ts-framing,ts-parse,ts-write}.ts`
> (NOT `mpegts-decrypt.ts` → S19) and `src/drivers/hls/{hls-driver,hls-source,m3u8-parse}.ts`.

## 1. Purpose & scope

MPEG-TS is a flat run of fixed-size transport packets (188 B; 192 B for m2ts/mts with a 4-byte
timestamp prefix; 204 B with Reed-Solomon parity) with **no front index and no stored duration**
(`ts-parse.ts:2-7`, `ts-framing.ts:3-6`). It carries elementary streams (H.264/HEVC video, ADTS-AAC /
AC-3 / E-AC-3 / MP3 / Opus audio) multiplexed by PID, described by PSI tables (PAT → PMT), and timed by
33-bit / 90 kHz PTS/DTS carried in PES headers. This shard owns:

- **The MPEG-TS container driver** — sniff, demux (PID → reassembled access units → WebCodecs
  `Encoded*Chunk`), same-container stream-copy/trim, and a TS muxer (`mpegts-driver.ts`, `ts-parse.ts`,
  `ts-write.ts`, `ts-framing.ts`, `mpegts-sniff.ts`).
- **The HLS adapter** — HLS is **not a byte container**; it is a UTF-8 `.m3u8` text manifest pointing at
  media segments. So there is no `hls` `ContainerDriver`. Instead, `HlsModule` registers the MPEG-TS
  driver (`hls-driver.ts:46-51`) and a **source-level** transform resolves a manifest → one demuxable
  `Source` by parsing the playlist, picking a variant, fetching + decrypting + stitching segments
  (`hls-source.ts:116-152`, `m3u8-parse.ts:265-405`). Segment AES-128 / TS SAMPLE-AES decrypt is
  delegated to `src/crypto/hls-aes.ts` (S19); container-level PES decrypt to `mpegts-decrypt.ts` (S19).

**Benchmark families served: `demux` and `remux`.** Demux drives `demux/h264_ts.ts`,
`demux/hls_vod.m3u8`, and `demux/hls_aes128.m3u8` against the golden packet-table oracle
(`../media-test/src/scenarios/demux/index.ts:128,178,188`). Remux drives TS→TS copy/trim and
`ADTS→MPEG-TS` and `prop_ts_to_mp4_duration_materialized`
(`../media-test/src/scenarios/remux/{audio.ts:76,metamorphic.ts:67}`). The driver's parsed tracks also
back `probe` via the `demux().tracks` fallback (see §3), and its writer backs `mux` (S14) via
`writeMpegTsPacketTracks` and the CMAF/HLS `streaming-output` family (S07).

## 2. Spec & references

Governing standards (every reference linked):

- **ISO/IEC 13818-1** — *Information technology — Generic coding of moving pictures and associated audio
  information: Systems* (MPEG-2 Systems / Transport Stream). Freely mirrored as **ITU-T Rec. H.222.0**:
  <https://www.itu.int/rec/T-REC-H.222.0>. ISO landing page: <https://www.iso.org/standard/75928.html>.
  Defines the 188-byte packet, sync byte `0x47`, PID, adaptation field + PCR, PAT (table_id 0x00), PMT
  (table_id 0x02), `stream_type` table (2-34), PES header + 33-bit PTS/DTS marker layout (§2.4.3.7), and
  the MPEG-2 section CRC-32.
- **ISO/IEC 13818-7** (ADTS AAC) — the ADTS frame syntax the TS-embedded AAC de-framer parses
  (`ts-parse.ts:875-945`). **ISO/IEC 14496-3** — AudioSpecificConfig for the WebCodecs `description`
  (`ts-parse.ts:1101-1107`). ISO catalog: <https://www.iso.org/standard/43345.html>.
- **HLS — RFC 8216** — *HTTP Live Streaming*: <https://www.rfc-editor.org/rfc/rfc8216>. Basic tag
  `#EXTM3U` (§4.3.1.1), attribute lists (§4.2), `#EXT-X-KEY` + AES-128 / SAMPLE-AES + implicit
  media-sequence IV (§4.3.2.4), encrypted `#EXT-X-MAP` requiring explicit IV (§4.3.2.5), `#EXT-X-BYTERANGE`
  continuation (§4.3.2.2), packed-audio renditions (§3.4). The newer *HLS 2nd Edition* draft
  (RFC 8216bis) supersedes RFC 8216 but is behavior-compatible for this scope:
  <https://datatracker.ietf.org/doc/draft-pantos-hls-rfc8216bis/>.
- **RFC 3986** (URI resolution) for relative segment/key URIs: <https://www.rfc-editor.org/rfc/rfc3986>.
  **RFC 6381** for the `CODECS="…"` attribute: <https://www.rfc-editor.org/rfc/rfc6381>.

OSS exemplars (studied; cite where the SOTA design should match or beat them):

- **mux.js** (videojs) — <https://github.com/videojs/mux.js>. The canonical browser MPEG-TS demux /
  transmuxer. Its decisive property is a **clean three-layer split**: `lib/m2ts/m2ts.js`
  (`TransportPacketStream` → `TransportParseStream` → `ElementaryStream`) parses transport + PES only;
  `lib/codecs/adts.js` and `lib/codecs/h264.js` parse codec framing; `lib/mp4/transmuxer.js` remuxes to
  fMP4. `lib/m2ts/probe.js` reads PAT/PMT/PES timing cheaply for a metadata-only probe. Our `ts-parse.ts`
  collapses all three layers into one file — the primary layering delta (§4, §5).
- **hls.js** — <https://github.com/video-dev/hls.js>. `src/demux/tsdemuxer.ts` (single-pass TS demux to
  elementary tracks), `src/demux/audio/adts.ts` (shared ADTS framing), `src/demux/sample-aes.ts`
  (SAMPLE-AES), `src/loader/m3u8-parser.ts` (the reference `.m3u8` parser). hls.js owns adaptive
  bitrate + live sliding windows + DRM (EME) — **out of scope** here (`measured-evidence.md`: "hls.js/Shaka/dash.js
  own adaptive streaming/DRM (out of scope)"). We match hls.js on structural `#EXTM3U` sniffing and RFC
  key inheritance, and deliberately stop at single-finite-source VOD/EVENT resolution.

## 3. Target design

### Data model & seams

Three layers, one direction of dependency (container → codec-framing → WebCodecs), mirroring mux.js:

1. **Framing** (`ts-framing.ts`) — pure grid detection: find the `0x47` sync column and packet stride
   (188/192/204) from a bounded head *or* a full segment (`ts-framing.ts:21-44`). Shared by cheap routing
   (`mpegts-sniff.matchesMpegTs` → `detectFraming`, `mpegts-sniff.ts:18-22`) and the full parser.
2. **Transport + PSI + PES** (`ts-parse.ts` core) — one linear pass demultiplexes every PID:
   `parsePacket` (TEI/scrambled/adaptation/PCR, `ts-parse.ts:139-186`) → PAT/PMT (`parsePat` 199-211,
   `parsePmt` 251-273) → per-PID PES reassembly with a PUSI-flush builder (`parseTs` 561-726) →
   `splitPes` timestamps (`ts-parse.ts:328-356`).
3. **Codec framing** (today embedded in `ts-parse.ts`; target: extracted) — H.264 Annex-B AU
   de-framing + IDR detection (`deframeH264PesUnits` 406-479, `h264HasIdr` 359-369), HEVC IRAP
   (`hevcHasIrap` 482-491), the stateful ADTS de-framer (`AdtsDeframer` 979-1099), and probe-only
   bitstream readers (SPS dims `parseH264SpsDimensions` 757-810, `BitReader` 840-868). **In the target
   design these live in codec-owned modules (S23/S28/S30 share them); the TS parser imports them.**

The parse product is `TsParse` — an ordered `TsTrack[]` (video-first, then by PID; `ts-parse.ts:721-724`)
each carrying its access units, a container `durationSec`, optional `fps`, and a WebCodecs
`VideoDecoderConfig`/`AudioDecoderConfig` (`ts-parse.ts:107-121`). The driver maps this to the contract:
`toTrackInfo` (`mpegts-driver.ts:76-85`), `demux()` returns a `Demuxer` whose `packets(trackId)` streams
`Encoded*Chunk` (`mpegts-driver.ts:329-343`), and `streamCopy()`/`createMuxer()` route through the writer.

**Probe seam:** the target adds `MpegTsDriver.probe()` and `MpegTsDriver.packetInfo()` (both optional on
`ContainerDriver`, `contracts/driver.ts:416-424`). Today the driver implements **neither**
(`mpegts-driver.ts:323-357`), so probe falls back to `demux()` + `tracks` and a packet-info probe
reassembles full AU payloads it never needs — the demux perf deficit in §5 (`measured-evidence.md`:
`demux/hls_vod` 63.850 ms vs mediabunny 43.345 ms).

### Capability routing (WebCodecs → GPU → WASM, miss-only)

Per ADR-002 (`measured-evidence.md`), **containers are hand-written TS**; this driver never downloads WASM. It is
a byte↔packet transform: it produces `EncodedVideoChunk`/`EncodedAudioChunk` and `Uint8Array`, and the
router hands those chunks to the codec ladder (WebCodecs hardware → GPU filters → WASM tail, S30/S31)
elsewhere. The one platform gate is the `Encoded*Chunk` constructors, which exist only in a
browser/worker: their absence raises a typed `CapabilityError('capability-miss', …, {op:'demux'})`
(`mpegts-driver.ts:275-281`) rather than a silent fallback. The developer never names TS, H.264, or AAC;
the container router selects this driver from MIME/extension/`0x47`-run sniff (`mpegts-sniff.ts:18-22`),
and unsupported cross-container or fragmented copy targets fail loudly
(`assertStreamCopyOptions`, `mpegts-driver.ts:91-107`; `MpegTsMuxer` fragmented guard, `ts-write.ts:110-117`).

**Capability leak to fix (§5):** the writer hardcodes `SupportedCodec = 'h264' | 'aac'`
(`ts-write.ts:28`, `normalizeCodec` 845-858), so HEVC/AC-3/MP3/Opus tracks the *parser* recognizes
(`ts-parse.ts:38-49`) cannot be remuxed TS→TS — the codec set is named in the container writer. And
`configForStream` parses dims only for H.264, publishing `0×0` for HEVC (`ts-parse.ts:1115-1125`).

### Edge cases

- **B-frames** — handled and load-bearing. TS PES carries a real DTS; `splitPes` keeps PTS≠DTS
  (`ts-parse.ts:337-355`) and tags `pesHadExplicitDts` (`ts-parse.ts:606-608`). Because a broadcast TS
  muxer may span an AU across PES packets and only some PES carry an explicit DTS, `deframeH264PesUnits`
  reconstructs a monotone decode cadence for reordered streams: it advances a `dtsCursor` from each AU's
  exact PTS to avoid ±1 µs drift on 30000/1001 cadences (`ts-parse.ts:439-469`). `packetStream` then
  carries `dtsUs` onto every `Packet` for lossless decode-order remux (`mpegts-driver.ts:304-311`). Oracle:
  demux packet-table `maxPtsDrift=0` and DTS monotone.
- **VFR** — handled. Timing is per-AU from PES PTS, never from an assumed constant frame rate. `fps` is
  advisory only, from the track's own median PTS gap (`ptsSpan.medianGap`, `ts-parse.ts:525-536`;
  `fps = 90000/gap`, `ts-parse.ts:708-711`). Container duration is the all-track PTS span plus one
  finest-cadence display interval (`containerDuration`, `ts-parse.ts:544-551`) — the ffprobe measure,
  correct for VFR.
- **Seek** — no random access in-container: a TS has no front index, so both probe and demux read the
  **whole bounded segment** (`readAll`, `mpegts-driver.ts:47-73`). Keyframe-aligned **trim** is supported
  in `streamCopy`: it snaps the start to the last IDR at/before the requested start and computes the
  window against the *earliest source PTS* (`firstPresentationUs`, `mpegts-driver.ts:131-145`;
  `selectTrimmedUnits`, 159-198) — TS often starts at a nonzero timestamp (`measured-evidence.md`). Frame-accurate
  *decode* seek runs through the demuxed packet stream via `replayable-video-decoder` (S10), not here.
  Target improvement: a sparse PCR/IDR index so a large TS can be range-scanned instead of fully buffered.
- **Cancel** — cooperative `AbortSignal` throughout: `assertNotAborted` guards each stage and each written
  unit (`mpegts-driver.ts:43-45, 242-259`), `packetStream.pull` errors the stream on abort
  (`mpegts-driver.ts:287-289`), and the HLS resolver `throwIfAborted`s between every segment/key fetch
  (`hls-source.ts:143-149, 547-549`). Gap: `readAll`'s single `src.range(0,size)` is not interruptible
  mid-read (only between chunked reads), §5.
- **Frame lifetime (`close()` exactly once)** — **N/A by construction**: this family creates **no**
  `VideoFrame`/`AudioData`. It only constructs `Encoded*Chunk` from copied bytes (`mpegts-driver.ts:304`)
  and `Uint8Array`, none of which own GPU/decoder resources needing `close()`. The one ownership rule:
  `MpegTsMuxer.write()` copies caller bytes via `packet.chunk.copyTo(data)` and does **not** close the
  caller's chunk (`ts-write.ts:153-165`) — chunk lifetime stays with the caller. Keep it that way.
- **Backpressure** — the writer is lazy: `MpegTsMuxer.output` is a pull-driven `ReadableStream` fed by a
  packetizing generator that emits ~87×188 ≈ 16 KB packet-aligned chunks (`ts-write.ts:88, 125-140,
  322-353`), so a `StreamTarget` sink observes incremental positioned writes. **Read-side gap:** demux
  eagerly parses the entire source and pre-materializes every AU (`parse` 319-321 → `packetStream` merely
  replays an in-memory array, `mpegts-driver.ts:291-314`), and the HLS resolver concatenates **all**
  decrypted segments into one buffer (`concat`, `hls-source.ts:150, 504-514`). Backpressure controls
  emission but not peak memory — the target streams parse + segment stitch (§5).

### HLS specifics

`resolveHlsSource` (`hls-source.ts:116-152`): parse → (master ⇒ pick variant + fetch sub-playlist,
`resolveMediaPlaylist` 310-327, `pickVariant` 330-350) → for each segment fetch + `decryptSegmentIfNeeded`
→ `concat` → `fromBytes` tagged with the sniffed segment MIME (`mimeForStitched` 300-305: `0x47`→TS,
`0xFFF` layer-0→packed-audio `audio/aac`, `#EXT-X-MAP`→`video/mp4`). Encrypted `#EXT-X-MAP` requires an
explicit IV (`appendInitSection` 363-387). Implicit segment IV is the media-sequence number as a 128-bit
big-endian integer via `setBigUint64` (`ivForSegment` 484-493). Detection is **structural** — the leading
`#EXTM3U` token, BOM-tolerant, boundary-checked (`isHlsPlaylist` 85-101) — never extension/MIME alone.
Live sliding playlists (no `#EXT-X-ENDLIST`) are a typed `InputError` (`hls-source.ts:122-127`): a growing
manifest is not one finite source. AES-128 / TS SAMPLE-AES decrypt calls `src/crypto/hls-aes.ts` (S19);
fMP4 SAMPLE-AES and SAMPLE-AES-CTR remain **typed non-claims** until real vectors exist (`hls-source.ts:113`,
`m3u8-parse.ts:36`, `measured-evidence.md`).

## 4. Current state

Everything in §3 exists and works on the real corpus (`measured-evidence.md`: focused HLS matrix 79/79; probe/
hls_aes128 wins 23.235 ms vs mediabunny 48.765; ADTS-in-TS de-framer ~540 MB/s single-pass). The
architecture is sound; the smells are size and layering, not correctness.

**God-files.**
- `src/drivers/mpegts/ts-parse.ts` — **1145 lines** doing eight jobs: PSI (`parsePat`/`parsePmt`
  199-273), PES reassembly (`parseTs` 561-726), H.264 Annex-B AU de-framing (`deframeH264PesUnits`
  406-479), HEVC IRAP scan (482-491), an H.264 SPS Exp-Golomb reader (`parseH264SpsDimensions` +
  `BitReader` + `stripEmulation`, 757-868), a full stateful ADTS de-framer (`AdtsDeframer` 979-1099),
  AudioSpecificConfig assembly (1101-1107), and duration/fps math (504-551). Layers 2 and 3 of §3 are
  fused. mux.js splits these across `lib/m2ts/*` and `lib/codecs/{adts,h264}.js`.
- `src/drivers/mpegts/ts-write.ts` — **988 lines** doing PSI section build + MPEG-2 CRC-32
  (`patSection`/`pmtSection`/`crc32Mpeg2` 601-641, 952-962), PES packetization + PCR adaptation
  (`pesPacket`/`packetizePayloadPackets`/`writePcr` 518-599, 668-676), ADTS header synthesis
  (`adtsHeader` 678-693), and avcC→Annex-B conversion (`parseAvcDecoderConfig`/`h264AnnexBAccessUnit`
  482-509, 705-755). Codec framing again lives in the container writer.

**Module-global mutable state.** Honestly, **little to none** in the owned files: `AdtsDeframer` state is
per-instance (`ts-parse.ts:979-999`), the HLS key cache is a per-call local `Map`
(`hls-source.ts:133, 460-470`), and the parser uses only local `Map`s (`ts-parse.ts:571-579`). The lazy
`loadPromise` module global lives in `defaults.ts` (S04), not here. The debt is god-files + layering, not
shared caches.

**Layering / capability smells.**
- Codec bitstream knowledge (H.264 SPS/Annex-B, HEVC NAL, ADTS header) is embedded in the container
  driver instead of imported from codec modules — duplicated with `mp4/h264-access-unit.ts`,
  `webm/h264-sps.ts`, and the `adts` driver (S23/S24/S28). `ts-parse.ts` even keeps its **own** AAC
  sample-rate table (`AAC_SAMPLE_RATES`, 871-873) while `ts-write.ts` imports a **different** one
  (`MPEG4_SAMPLE_RATES` from `wasm-aac/aac.ts`, `ts-write.ts:1`) — two tables for one fact.
- Writer codec allow-list `'h264' | 'aac'` (`ts-write.ts:28, 845-858`) hardcodes the codec set in the
  container layer; HEVC/AC-3/MP3/Opus tracks the parser recognizes cannot round-trip TS→TS.
- Byte helpers (`concat`, whole-source drain, `subarray` slicing) are re-implemented in
  `mpegts-driver.ts:65-73`, `ts-parse.ts:301-310`, `ts-write.ts:975-987`, and `hls-source.ts:278-291,
  504-514` — four near-identical copies.

**Known functional gaps (honest).** Non-AAC audio (AC-3/E-AC-3/MP3/Opus) is demuxed as one AU per PES
with no frame-level de-framing and a `sampleRate:0` config (`ts-parse.ts:1139-1143`); HEVC dims are `0×0`
(`ts-parse.ts:1115-1125`); the `remux/h264_ts_ts_to_mp4` duration row was historically ±0.119 s over gate
(`measured-evidence.md`); the black-box `probe/hls_aes128` harness invocation is information-theoretically
undecryptable because it supplies segment ciphertext without the manifest/key/IV (`measured-evidence.md`), so the
public path is the standalone `fromURL()` manifest resolve.

## 5. Delta / punch-list (ordered; each item has an acceptance test)

1. **Extract codec framing out of `ts-parse.ts` into shared codec modules.** Move `h264HasIdr`,
   `h264AnnexBNalStarts`, `deframeH264PesUnits`, `parseH264SpsDimensions`, `BitReader`, `stripEmulation`
   (`ts-parse.ts:359-479, 734-868`) and `hevcHasIrap` (482-491) into a codec-owned Annex-B helper reused
   by mp4/webm/mpegts; move `AdtsDeframer` + `parseAdtsHeaderAt` + `audioSpecificConfig`
   (`ts-parse.ts:875-1107`) into the shared ADTS module used by the `adts` driver (S28). `ts-parse.ts`
   *imports* them. **Acceptance:** `ts-parse.ts` drops below ~500 lines and contains no `BitReader`/NAL/
   ADTS-header definitions (grep asserts zero); the demux golden-packets oracle for `demux/h264_ts.ts` and
   `demux/aac_adts` stays byte-identical (same packet count, `maxPtsDrift=0`), and the ADTS de-framer
   micro-benchmark holds ≥540 MB/s on the 30 s fixture (`measured-evidence.md` ADR-184 regression guard).

2. **Unify the AAC sample-rate table.** Delete `AAC_SAMPLE_RATES` (`ts-parse.ts:871-873`); import the one
   table both sides use (`MPEG4_SAMPLE_RATES`, already imported by `ts-write.ts:1`). **Acceptance:** one
   definition remains (grep); parse of every ADTS `sampling_frequency_index` 0–12 yields the identical Hz
   value as before on a table-driven unit test; index 13–15 still returns `undefined` (reserved).

3. **Add `MpegTsDriver.packetInfo()` (payload-free) and `MpegTsDriver.probe()`.** Implement the optional
   contract methods (`contracts/driver.ts:416-424`) so a metadata/packet-info request does not copy AU
   payloads. `packetInfo` returns rows of `{ptsUs, dtsUs, sizeBytes, key}` from the parse without slicing
   payload bytes; `probe` returns `TrackInfo[]` only. **Acceptance:** `demux/hls_vod` and `demux/h264_ts.ts`
   packet-info paths allocate zero AU payload copies (instrument the parse), the golden packet table
   (470-row shape, `maxPtsDrift=0`) is unchanged, and `demux/hls_vod` median beats the stored 63.850 ms
   deficit toward mediabunny's 43.345 ms (`measured-evidence.md`).

4. **Stream the parse instead of `readAll`.** Replace whole-source buffering (`mpegts-driver.ts:47-73`,
   `parse` 319-321) with an incremental packet-fed parser so demux emits packets as PIDs complete and peak
   memory is bounded by the in-flight PES, not the segment size. Preserve the "no index ⇒ full scan for
   duration" contract by finishing the pass before reporting `durationSec`. **Acceptance:** a
   backpressure test that reads one packet then stalls shows resident memory well below full-segment size
   on a multi-MB TS; the abort test cancels mid-stream and the range read is interrupted (closes the §3
   `readAll` gap); demux packet table unchanged.

5. **Bound HLS segment stitching memory / stream it.** `resolveHlsSource` concatenates every decrypted
   segment into one `Uint8Array` (`hls-source.ts:150, 504-514`) — unbounded for a long VOD. Emit a
   streaming `Source` (segment-at-a-time `ReadableStream`) with only the fMP4 init prepended once, or cap
   the eager path to a bounded window. **Acceptance:** stitching a synthetic N-segment VOD holds peak
   memory near one segment (+ init), not N segments; `hls_vod`/`hls_aes128` demux goldens and the
   probe-first-segment path (`resolveHlsProbeSource`, `hls-source.ts:160-187`) stay byte-identical.

6. **Lift the writer codec allow-list out of the container layer.** `SupportedCodec='h264'|'aac'`
   (`ts-write.ts:28, 845-858`) should not encode the codec set. Either extend the writer to the
   `stream_type`s the parser already maps (`ts-parse.ts:38-49`) — at minimum HEVC (`stream_type 0x24`,
   Annex-B) — or move the "TS carries only H.264/AAC today" decision into an explicit capability table the
   router reads, so a TS→TS HEVC copy raises a *routed* `CapabilityError` rather than an ad-hoc
   `normalizeCodec` throw. **Acceptance:** an HEVC-in-TS `streamCopy` either round-trips (parse ⇒ write ⇒
   re-parse to identical AUs) or fails with a `capability-miss` carrying `{op:'stream-copy:mpegts',
   tried:['mpegts'], codec:'hevc'}`; unit test asserts the typed detail, never a bare `MediaError`.

7. **Parse HEVC coded dimensions for probe.** `configForStream` publishes `0×0` for HEVC
   (`ts-parse.ts:1115-1125`). Add HEVC SPS dimension parsing (reuse the extracted Annex-B/BitReader from
   item 1). **Acceptance:** probing an HEVC TS fixture reports non-zero `codedWidth`/`codedHeight` matching
   ffprobe; a mid-GOP TS range with no leading SPS still degrades to `0×0` (not a throw), matching the
   H.264 mid-GOP behavior (`ts-parse.ts:1117-1124`).

8. **De-frame non-AAC TS audio (AC-3/E-AC-3/MP3), or emit an honest partial.** Today each is one AU per PES
   with `sampleRate:0` (`ts-parse.ts:1139-1143`). Add frame-boundary parsing for at least AC-3 (syncframe)
   and MP3 (frame header) to produce per-frame AUs + a real config, or mark the config a typed capability
   gap the router surfaces. **Acceptance:** an AC-3 TS demux yields per-syncframe packets with a non-zero
   `sampleRate`, or a `probe` on it returns a config flagged as an explicit gap (no silent `sampleRate:0`).

9. **Deduplicate byte helpers.** Collapse the four `concat`/whole-drain implementations
   (`mpegts-driver.ts:65-73`, `ts-parse.ts:301-310`, `ts-write.ts:975-987`, `hls-source.ts:278-291,
   504-514`) into one shared util. **Acceptance:** a single `concat`/`drain` definition remains (grep);
   all existing TS/HLS tests pass unchanged.

10. **Add a sparse PCR/IDR seek index for large TS (target improvement).** Build an optional index mapping
    IDR PTS → byte offset during the scan so a future range-based seek can skip to a GOP without buffering
    the whole file. **Acceptance:** on a multi-GOP TS the index lists every IDR with the byte offset of its
    first transport packet; a keyframe-trim using the index selects the same start AU as today's
    `selectTrimmedUnits` (`mpegts-driver.ts:159-198`) — regression-identical output bytes.

11. **Surface `#EXT-X-DISCONTINUITY` to the stitch/parse boundary.** The parser records `discontinuity`
    per segment (`m3u8-parse.ts:59, 434`) but the resolver ignores it when concatenating (a PID/timeline
    reset across a discontinuity can break the single-TS assumption). Either reject a discontinuity-bearing
    VOD with a typed miss or handle the PTS reset via the parser's 2^33 unwrap contract
    (`ts-parse.ts:504-514`). **Acceptance:** a two-part playlist with `#EXT-X-DISCONTINUITY` between
    segments of different PID layout either resolves to correct per-part timelines or fails with a typed
    `InputError` naming the discontinuity — never silently mis-stitches.

12. **Split the two god-files along the §3 layers once items 1–2 land.** `ts-parse.ts` → `ts-transport.ts`
    (framing/PSI/PES) + thin re-exports; `ts-write.ts` → `ts-psi-write.ts` (PAT/PMT/CRC) + `ts-packetize.ts`
    (PES/PCR/packetizer). **Acceptance:** no owned file exceeds ~500 lines; the public exports
    (`parseTs`, `MpegTsMuxer`, `writeMpegTsPacketTracks`, `deframeH264PesUnits`, `AdtsDeframer`) keep the
    same import paths so S14/S15 consumers (`api/mpegts-prepared-mux.ts`, `api/mpegts-packet-info-remux.ts`)
    compile unchanged; full gate green.

## 6. Open questions (seed `docs/decisions/`)

1. **Live/EVENT HLS scope.** RFC 8216 EVENT and live sliding playlists are rejected as non-finite
   (`hls-source.ts:122-127`). Do we keep VOD-only (matching our single-`Source` engine model) or add a
   bounded live-window resolver? hls.js owns this today (`measured-evidence.md`: adaptive/DRM out of scope). Decide
   and log the boundary.

2. **fMP4 SAMPLE-AES / SAMPLE-AES-CTR.** Currently typed non-claims (`hls-source.ts:113`,
   `m3u8-parse.ts:36`, `measured-evidence.md`). What real test vectors would justify implementing them, and does
   that belong here or in the MP4/CENC path (S19)?

3. **HEVC/AC-3/MP3/Opus in TS.** How far do we take non-H.264/AAC TS support (items 6-8) before it stops
   earning benchmark wins? A capability matrix that the router reads (vs a hardcoded `SupportedCodec`)
   would let us grow it incrementally — log the matrix as the source of truth.

4. **Where does codec framing live?** Item 1 assumes a shared Annex-B/ADTS module owned by the codec
   shards. Confirm the ownership boundary (S23 mp4 vs S28 adts vs a new `src/codecs/framing/*`) so mp4,
   webm, mpegts, and adts stop each carrying a private copy. Log the module home.

5. **Sparse seek index vs "TS has no index" purity.** Item 10 adds an in-memory IDR index. Is that a
   driver responsibility or should range-seek stay a source/decoder (S10) concern? Decide who owns the
   index and its memory budget.

6. **`m2ts`/`204`-byte round-trip.** The parser reads 192-byte m2ts (4-byte prefix) and 204-byte RS TS
   (`ts-framing.ts:4-6, 22-23`) but the writer always emits bare 188-byte packets (`ts-write.ts:5`). Is a
   192/204 *output* ever required (Blu-ray/broadcast targets), or is 188-only output the permanent
   contract? Log the decision.
</content>
</invoke>
