# Remux

> Target spec for the `remux` benchmark family. This is the *best* design plus an honest delta vs the
> code that exists today under `src/api/`. Every claim traces to code (`path:line`), a cited spec, or a
> rescued measured fact in `docs/measured-evidence.md`. Unverifiable claims are marked `UNVERIFIED`.

## 1. Purpose & scope

**Remux** (a.k.a. *transmux* / *stream copy*) changes the **container** of a media asset **without
decoding or re-encoding** any coded sample. It re-wraps the already-coded packets — H.264/HEVC/AV1/VP9
video NAL/OBU units, AAC/Opus/FLAC/MP3 audio access units — from one container framing into another,
preserving every coded byte, the codec-private configuration (`avcC`/`hvcC`/`av1C`/`dfLa`/`OpusHead`…),
the decode-order timeline (PTS **and** DTS), display rotation, gapless priming, and non-media side data
(Matroska attachments). It is the cheapest genuine operation the engine performs: no codec is ever
instantiated, so **no `VideoFrame`/`AudioData` is ever constructed and no WASM is ever downloaded**.

Serves exactly one benchmark family: **remux** (per `docs/architecture/COVERAGE.md` line 76, 129). Adjacent families
that share machinery but are **out of scope** here: **mux** (S14 — assembling packets from independent
sources), **trim** (S16 — a keyframe-aligned *range* of a stream copy via `streamCopy(..., { trim })`),
**metadata** (S20 — tag rewriting; remux only *composes* a metadata rewrite onto its output), and
**convert** (S12/S13 — which may *route into* remux via the semantic-no-op stream-copy proof but is not
itself remux). This shard owns `remux-runner.ts`, `remux-metadata.ts`, `semantic-stream-copy.ts`, and
`mpegts-packet-info-remux.ts` (all under `src/api/`).

Historical context (rescued): widening the harness adapter's `containersOut` to webm/mkv/ogg raised remux
from 7→25 PASS (`measured-evidence.md`); in the 7-engine benchmark, remux was won 25/… by mediabunny with
ffmpeg.wasm at 22 (`measured-evidence.md`). Three competitor remux "wins" are **SUSPECT** passthrough cheats we
must not emulate — e.g. `remux/huge_h264_1080p_600s_mov_to_mp4` "won" by flipping 8 `ftyp` bytes and
returning the input unchanged (`measured-evidence.md`).

## 2. Spec & references

Remux has no single governing RFC; it is defined by (a) the **container** specs the packets are re-wrapped
into and (b) the **codec bitstream** framing each container mandates. The authoritative references:

- **ISO/IEC 14496-12** — ISO Base Media File Format (MP4/MOV boxes, `stts`/`ctts` timing, `stsc`/`stsz`/
  `stco`/`co64` sample tables): <https://www.iso.org/standard/83102.html> (freely mirrored as the MP4
  registration authority at <https://mp4ra.org/>).
- **RFC 9559** — Matroska/WebM (EBML, Blocks, `CodecPrivate`, `AttachedFile`, `CodecDelay`,
  `DiscardPadding`): <https://www.rfc-editor.org/rfc/rfc9559.html> (attachment preservation cites §5.1.6 /
  §8, per `measured-evidence.md`).
- **ISO/IEC 13818-1** — MPEG-2 Transport Stream (188-byte packets, PES, PMT/PAT):
  <https://www.iso.org/standard/75928.html>. HLS segment containers: **RFC 8216**
  <https://www.rfc-editor.org/rfc/rfc8216.html>.
- **RFC 3533 / RFC 7845** — Ogg framing and Opus-in-Ogg mapping (granule positions, pre-skip):
  <https://www.rfc-editor.org/rfc/rfc3533.html>, <https://www.rfc-editor.org/rfc/rfc7845.html>.
- **W3C WebCodecs** — <https://www.w3.org/TR/webcodecs/>. Cited here **only to state what remux does NOT
  use**: `EncodedVideoChunk`/`EncodedAudioChunk` carry a presentation timestamp but **no DTS**, so remux
  deliberately bypasses that seam (ADR-021, `measured-evidence.md`).

**OSS exemplar — ffmpeg `-c copy`** (<https://ffmpeg.org/ffmpeg.html>). ffmpeg's stream copy is
"copying one input elementary stream's packets **without decoding, filtering, or encoding them**" and
"when doing stream copy … [timestamps] will be preserved" (verified via WebFetch of ffmpeg.html, 2026-07).
Crucially, ffmpeg **automatically inserts codec bitstream filters** when the target container demands a
different framing of the *same* codec:
- **`h264_mp4toannexb`** converts H.264 from MP4 "length prefixed mode" (AVCC) to "start code prefixed
  mode (Annex B)", "required by … the MPEG-2 transport stream format" and "automatically applied when
  outputting to MPEG-TS or raw H.264" (<https://ffmpeg.org/ffmpeg-bitstream-filters.html>, verified).
- **`aac_adtstoasc`** builds an "MPEG-4 AudioSpecificConfig from an MPEG-2/4 ADTS header and removes the
  ADTS header" when "copying an AAC stream from a raw ADTS AAC or an MPEG-TS container … to MOV/MP4"
  (same source). The inverse (raw-AU→ADTS, and per-PID ADTS deframing) is what our TS path must do
  (`measured-evidence.md` ADR-184).

The lesson for the SOTA design: **verbatim packet copy is not always verbatim *payload* copy** — the coded
bitstream framing must be transformed per target container. Any remux path that `subarray`-copies bytes
straight through across a framing boundary is a latent correctness bug (see §5 item 6).

**OSS exemplar — mediabunny remux** (<https://github.com/Vanilagy/mediabunny>, docs
<https://mediabunny.dev/guide/converting-media-files>). mediabunny's Conversion API "copies media data
whenever possible, otherwise transcoding it"; it copies when "the input codec works with the output
container (transmuxing)" and **discards** a track with reason `no_encodable_target_codec` when the codec
"cannot be contained within the output format", inspectable via `discardedTracks` before running (verified
via WebFetch, 2026-07). Our SOTA design should **match** the copy-when-possible default and **beat** it by
also carrying DTS/ctts, attachments, CodecDelay/pre-skip, and rotation verbatim (things a PTS-only seam
loses), and by declining >1 GiB materializations with a typed error instead of buffering.

## 3. Target design

### 3.1 Data model & seams

Remux is a two-stage pipeline behind one flat task entry (`runRemux`, `remux-runner.ts:51`):

```
Source ──demux──▶ Demuxer.tracks / Demuxer.packets(id)  ──[Packet w/ dtsUs]──▶ Muxer.write ──▶ Output
             (or)  ContainerDriver.streamCopy(src, {container})  ──▶ ReadableStream<Uint8Array>
```

Two distinct seams, chosen by capability:

1. **Driver-native `streamCopy`** (`contracts/driver.ts:441`) — the source container's own driver emits
   the target bytes directly (`remux-runner.ts:225-238`). Used when the target is the same family
   (`container.formats.includes(opts.to)`) or the driver explicitly advertises it via
   `streamCopyTargets` (`driver.ts:434`, e.g. native FLAC frames into Ogg-FLAC, `measured-evidence.md`
   `session9-flac-ogg-streamcopy-target`). This is the fastest, most faithful path — the driver reuses the
   sample tables it already parsed and never leaves its own byte domain.
2. **Generic demux→mux packet seam** (`remuxViaSeam`, `remux-runner.ts:244-320`) — cross-family remux.
   `demuxer.packets(track.id)` yields **`Packet`** objects that carry `dtsUs`, drained one at a time into
   the target `Muxer` by `drainEncoderToMuxer` (`codec-pipeline.ts:2526`). The seam preserves DTS because
   a demuxer `Packet` passes through `toPacket` unchanged (`codec-pipeline.ts:1693`), unlike the
   encoder→muxer direction which must reconstruct DTS from arrival order.

**Packet provenance** is the `TrackInfo` descriptor attached to each track: `config` (the exact
`DecoderConfig` with codec-private description), `rotation`, `alpha`, `gapless`, `containerSideData`
(Matroska attachments), `nonMedia`/`containerProjection` flags, and `encrypted`. The semantic-copy proof
reads all of these to decide eligibility (`semantic-stream-copy.ts:130-137, 167-201`). Track selection
(`selectTrackInfos`) filters this list; only tracks with a described `config` are muxable
(`remux-runner.ts:289-291`).

### 3.2 Capability routing — the honest version for remux

The engine's global ladder is **hardware WebCodecs → GPU → WASM (download heavy WASM only on a hardware
miss)**. **Remux sits *below* that ladder entirely**: it performs no codec work, so it never queries an
encoder/decoder, never touches GPU, and — this is the load-bearing point — **never triggers a hardware
miss and therefore never downloads WASM**. The developer names no backend; they call `remux({ to })` and
the router chooses among *container* seams. The remux-specific ladder is:

1. **Metadata-only same-container rewrite** — target equals source family and the only change is tags;
   re-serialize just the metadata structure (`remux-runner.ts:92-97, 178-180`; MP4/MOV copy-free Blob and
   byte-direct fast paths at `102-174`, proving `moov` relocation preserves every media reference,
   ADR-274/ADR-280, `measured-evidence.md`).
2. **Driver-native `streamCopy`** — same family or declared `streamCopyTargets` (`225-238`).
3. **Specialized cross-family fast paths** — MP4→TS packet-info remux
   (`mpegts-packet-info-remux.ts:54`), streaming WebM/MKV for fragmented or >1 GiB
   (`remux-runner.ts:258-265`).
4. **Generic demux→mux packet seam** (`remuxViaSeam`, `244-320`).
5. **Typed `CapabilityError('capability-miss')`** — no muxer for the target
   (`252-257`), no muxable track (`292-298`), or the input is a raw live `MediaStream`
   (`normalizeByteInput`, `322-330`). Fail loudly; never silently passthrough.

`containerHasChunkMuxer` (`codec-routing.ts:24`) gates whether a target has a real muxer at all;
**codec-container legality is the muxer's `addTrack`/`mapCodec`, the single source of truth**
(`codec-routing.ts:19`) — mirroring mediabunny's `no_encodable_target_codec` discard, but as a typed
throw rather than a silent drop.

### 3.3 Edge cases

- **B-frames.** *Central to remux.* The whole reason remux uses the `Packet` (not `EncodedChunk`) seam is
  that `EncodedVideoChunk` carries only a presentation timestamp with **no DTS**, so it cannot preserve
  decode order / composition offsets (`ctts`) or the raw codec-config box (ADR-021, `measured-evidence.md`;
  `codec-pipeline.ts:1687-1695`). Demuxer `Packet`s carry `dtsUs` verbatim and MP4 `ctts` is read/written
  **signed** even in v0 boxes (ADR-185, `measured-evidence.md`) so a −40-tick composition offset is not misread as
  4294967256. Known open defect: WebM output currently lengthens under B-frame reorder —
  `remux/h264_bframes_1080p_mp4_to_mkv` reimports 10.134 s vs a 10.0 s golden (`measured-evidence.md`,
  BUILD_INSTRUCTIONS_SESSION3).
- **VFR (variable frame rate).** Preserved for free: per-packet `dtsUs`/`durationUs`/`ptsUs` are copied
  verbatim, so cadence is never normalized. The failure mode is *muxer* rounding, not remux: cumulative
  rounded frame durations once pushed parsed PTS 11 µs behind DTS by frame 17 on a 626-frame VFR MP4
  (ADR-191, `measured-evidence.md`). The remux path must forward the demuxer's exact timestamps and let the muxer
  carry microsecond truth (the MP4 driver computes `ctts` in µs first, ADR-028).
- **Seek.** *Does not apply.* Remux copies the entire stream start-to-end; there is no random access into
  output. Keyframe-aligned *range* selection is **trim** (S16), implemented as `streamCopy(..., { trim })`
  (`driver.ts:436, 443`). One-liner: remux = full copy, trim = ranged copy.
- **Cancel.** Threaded end-to-end. `readSourceChunk` races `reader.read()` against an abort promise and
  removes its listener in `finally` (`remux-runner.ts:390-406`); `readAllSource` cancels the reader on
  error and always `releaseLock`s (`357-388`); `createDrainTaskGroup` links siblings so the first failure
  aborts every other reader, awaits teardown, and rethrows (`codec-pipeline.ts:1665-1685`);
  `drainEncoderToMuxer` registers an abort listener that cancels the packet reader and checks
  `isAborted()` around every read/write (`codec-pipeline.ts:2560-2587`); the metadata module
  `assertNotAborted`s before and after each rewrite and cancels the incoming stream on a pre-aborted
  signal (`remux-metadata.ts:121-125, 365-367`).
- **Frame lifetime (`close()` exactly once).** *Trivially satisfied by construction — the defining
  advantage of remux.* Remux **never constructs a `VideoFrame` or `AudioData`**; it moves `Uint8Array`
  packet payloads (e.g. `sourceBytes.subarray(...)`, `mpegts-packet-info-remux.ts:98`) and host
  `EncodedChunk`/`Packet` objects, none of which own a GPU surface needing `close()`. The only lifecycle
  discipline is stream/reader hygiene: every reader is released and every `Demuxer` is `close()`d in a
  `finally` (`remux-runner.ts:293, 302-318`; `377-379`). This is exactly why remux is the memory-cheapest
  operation and why it categorically cannot leak a decoder surface the way transcode can.
- **Backpressure.** The packet drain is one-packet-at-a-time — `drainEncoderToMuxer` `await`s
  `muxer.write` per packet before the next `reader.read()` (`codec-pipeline.ts:2564-2578`) and the
  unwrap/seam streams run at `highWaterMark: 0` (`codec-pipeline.ts:1736`), so a slow muxer naturally
  pauses the demuxer. Sink mode is explicit: a `stream-target` sink streams, otherwise the copy is
  buffered (`streamCopySinkMode`, `remux-runner.ts:341-343`). **Bounded materialization**: sources larger
  than `REMUX_BUFFER_ALL_MAX_OUTPUT_BYTES` = 1 GiB (`remux-runner.ts:15`) raise a typed
  `capability-miss` rather than allocating one giant `Uint8Array` (`276-281`), except WebM/MKV which route
  to the fragmented streaming remux path (`258-265`, ADR-034/CMAF bounded-memory streaming). This mirrors
  the harness's own ~512 MiB / >1 GB typed-decline policy (ADR-053 / ADR-102, `measured-evidence.md`).

## 4. Current state

All four owned files exist and are wired into the eager engine via lazy dynamic imports (the runner lives
behind a literal `import()` so the eager kernel stays under budget, `measured-evidence.md`
`session12-eager-budget-recovery`).

- **`remux-runner.ts`** (425 lines) — the entry `runRemux` (`51-242`) is a **god-function**: a single
  ~190-line nested decision tree over five overlapping boolean predicates (`wantsTrackSelection` 91,
  `directMetadataTarget` 92-97, `directMp4MetadataCandidate` 102-108, `keepsCompleteOrder` 203-205, plus
  the `streamCopy` guard 225-229). Branch order is load-bearing and implicit. `remuxViaSeam` (`244-320`)
  is a second dispatcher. Module constants: `REMUX_BUFFER_ALL_MAX_OUTPUT_BYTES` (`15`) and the
  `CONTAINER_MIME` map (`17-35`). No **mutable** module-global state and no per-asset caches exist here
  (honest: the maps are frozen/`const`).
- **`remux-metadata.ts`** (376 lines) — tag validation (`planRemuxMetadata:68`, `snapshotTagRecord:81`
  hardens against getter/proto injection), the composed rewrite (`rewriteRemuxMetadata:115`,
  `rewriteRemuxMetadataBytes:140`), and MP4/MOV copy-free fast paths (`tryRewriteMp4MetadataBlobDirectly:188`,
  `tryRewriteMp4MetadataBytesDirectly:157`, plus the sibling semantic-reuse helpers `tryReuseMp4Semantic*`
  `228-278`). `METADATA_TARGETS` is a frozen `Set` (`11-22`). Clean, well-factored; the smell is only that
  it is *also* where `convert()`'s semantic Blob-reuse lands (`254`, `reuseBlob` calls into it from
  `semantic-stream-copy.ts:14`), so "remux-metadata" is doing double duty as a general MP4-reuse module.
- **`semantic-stream-copy.ts`** (244 lines) — the `convert()`-side proof that a requested conversion is
  *already* satisfied and can be routed through `streamCopy` without decode (ADR-263, `measured-evidence.md`).
  `isSemanticStreamCopy` (`127`) is a careful positive predicate. **Layering smell**: it embeds its own
  codec-string parser — `videoFamily` (`203`), `audioFamily` (`212`), `videoBitDepth` (`226`) — with
  regexes for `avc1`/`hev1`/`vp09`/`av01`, duplicating knowledge that belongs in the codec-strings driver
  module.
- **`mpegts-packet-info-remux.ts`** (148 lines) — the MP4→TS packet-info fast path
  (`tryRemuxPacketInfoToMpegTs:54`). **Capability leak**: hardcodes `container.id !== 'mp4'` (`60`) and
  re-normalizes bytes with the literal mime `'video/mp4'` (`125`), so it cannot serve MOV→TS or any other
  source. It copies packet bytes with `sourceBytes.subarray(row.offset, end)` (`98`) — a **verbatim
  payload copy across a framing boundary** (see §5 item 6). `MPEGTS_PACKET_INFO_MAX_SOURCE_BYTES` = 64 MiB
  (`19`).

**Layering / capability leaks (summary).** The runner **names container tokens directly** in its routing
tree — `'webm'|'mkv'` (`259`), `'ts'` (`266`), `'mp4'|'mov'` (`107`) — instead of drivers advertising the
capability; the MIME map (`17-35`) duplicates knowledge the drivers already own; the MP4-only coupling in
the TS path (`60, 125`) prevents reuse; and codec-string parsing leaks into the api-layer semantic module.
No god-file mutable caches, but the two dispatcher functions and the string-literal branching are the
principal debts.

## 5. Delta / punch-list (ordered)

1. **Kill the container-token capability leak in the runner.** Replace the literal `opts.to === 'webm' |
   'mkv' | 'ts'` and `opts.to === 'mp4' | 'mov'` branches (`remux-runner.ts:107, 259, 266`) with
   capability queries the driver advertises (extend the pattern of `streamCopyTargets`/`streamCopy` on
   `ContainerDriver`, e.g. an optional `remuxFastPaths` or per-target flag).
   *Acceptance:* a fake `ContainerDriver` that advertises a native cross-format copy to a brand-new
   container token is routed correctly through `runRemux` with **zero edits** to `remux-runner.ts`; a grep
   asserts no target container string literal remains in the routing tree.

2. **Remove the `CONTAINER_MIME` map; source MIME from the driver/registry.** Delete
   `remux-runner.ts:17-35` and have `mimeOptions` (`421-424`) look up the output mime from the resolved
   target driver.
   *Acceptance:* for each supported target container, a test asserts `(output as Blob).type` equals the
   driver-declared mime; a grep proves no second hardcoded container→mime table exists in `src/api/`.

3. **Extract `runRemux`'s decision tree into a pure `planRemuxRoute`.** Return a discriminated union
   `{ kind: 'metadata-direct' | 'mp4-blob-direct' | 'mp4-bytes-direct' | 'stream-copy' | 'ts-packet-info'
   | 'webm-streaming' | 'seam' }` computed from `(container.formats, container.streamCopy?, opts,
   metadata)`; `runRemux` becomes a thin dispatcher. This dissolves the five overlapping booleans
   (`remux-runner.ts:91-229`).
   *Acceptance:* a table-driven Node test enumerates `(formats, opts)` → expected `kind` for ≥15 cases
   (same-family, cross-family, tags-only, trackSelect subset vs full, fragmented, >1 GiB); the planner is
   tested with no I/O and `runRemux` has no remaining nested `if` deeper than one level.

4. **De-duplicate codec-string parsing out of `semantic-stream-copy.ts`.** `videoFamily`/`audioFamily`/
   `videoBitDepth` (`203-243`) must delegate to the single canonical codec-string parser (the codec-strings
   driver module) instead of re-implementing the `avc1`/`hev1`/`vp09`/`av01` regexes.
   *Acceptance:* a property test feeds identical strings (`avc1.6e0033`, `hev1.2.4.L120`,
   `vp09.02.10.10`, `av01.0.04M.10`) to both `semantic-stream-copy` and the codec-strings module and
   asserts identical `family` + `bitDepth`; a grep proves only one codec-string regex table remains.

5. **Generalize the MP4→TS packet-info path off the `'mp4'` literal.** Parametrize
   `tryRemuxPacketInfoToMpegTs` on `container.formats`/`container.packetInfo` capability and use
   `src.mimeHint` instead of the literal `'video/mp4'` (`mpegts-packet-info-remux.ts:60, 125`) so MOV→TS
   uses the same fast path.
   *Acceptance:* a MOV→TS remux of a real AVCC+AAC `.mov` routes through the packet-info path (assert via a
   spy that `container.packetInfo` was called and no generic `demux()` seam ran) and produces a valid TS.

6. **Prove/implement bitstream framing transforms (exemplar parity with `h264_mp4toannexb` /
   `aac_adtstoasc`).** The MP4→TS path `subarray`-copies packet payload verbatim
   (`mpegts-packet-info-remux.ts:97-104`), but MP4 stores H.264 as AVCC length-prefixed NAL units and raw
   AAC AUs, whereas MPEG-TS requires **Annex B start codes** and **ADTS headers**. Verify `ts-write`
   performs both transforms; if it does not, the output is invalid. (The inverse — per-PID ADTS deframing
   into raw AUs — is already fixed for TS→MP4, ADR-184, `measured-evidence.md`; the MP4→TS direction needs the same
   rigor.)
   *Acceptance:* a golden test remuxes a real AVCC+raw-AAC MP4 to TS and a structural oracle (ffprobe /
   NAL scanner) asserts (a) H.264 NAL units are Annex-B start-code framed, (b) each AAC AU carries a 7-byte
   ADTS header, and (c) the output is **not** a byte-passthrough of the MP4 payload (checksum differs).

7. **Single shared bounded-materialization ceiling.** Fold `REMUX_BUFFER_ALL_MAX_OUTPUT_BYTES`
   (`remux-runner.ts:15`) into one engine-wide `MAX_BUFFERED_OUTPUT_BYTES` policy referenced by
   remux/mux/trim, aligned with the harness ADR-053/ADR-102 decline.
   *Acceptance:* a source above the ceiling (non-webm target) raises
   `CapabilityError('capability-miss', … 'over buffer limit')` and allocates no whole-output buffer (assert
   peak RSS delta ≪ source size); the same constant is imported by ≥2 other runners.

8. **Nail the anti-passthrough invariant (ADR-155).** The MP4 blob/byte-direct fast paths already run a
   validation demux (`remux-runner.ts:119-123, 143-147`); make the guarantee a first-class test: a same-
   container no-op remux must return either a genuine re-layout or the exact bytes *only after* structural
   + sample-range validation, never a raw passthrough.
   *Acceptance:* (a) a bit-flip inside `mdat` makes the validation `demux()` throw (no output emitted);
   (b) an `ftyp`-only-flipped input is rejected as a cheat by the anti-cheat oracle; (c) a legitimate
   MOV→MP4 brand rewrite passes only after sample-range validation.

9. **Fold the redundant `metadata !== undefined` re-guard.** `remux-runner.ts:109` re-checks a condition
   already implied by `directMp4MetadataCandidate`; carry `metadata` non-optionally on the route union
   (item 3) so TS narrowing is structural.
   *Acceptance:* no `if (<candidate> && metadata !== undefined)` double-guard remains; typecheck passes
   with the tightened union.

10. **Bound the trackSelect+metadata buffering path.** The full-source materialize-then-validate route
    (`remux-runner.ts:181-223`) defeats streaming for large `trackSelect` inputs.
    *Acceptance:* a `>ceiling` source with `trackSelect` raises a typed decline rather than buffering the
    whole input; a genuine subset selection produces output whose structural oracle shows the dropped
    track's packets are **absent** and the kept track's coded bytes are **byte-identical** to source.

## 6. Open questions (seed `docs/decisions/`)

1. **Where do container↔codec framing transforms live?** ffmpeg models AVCC↔AnnexB and rawAAC↔ADTS as
   explicit *bitstream filters* between demux and mux. Should we introduce a shared `bitstream-filter`
   seam (composable, per (source-codec, target-container)) rather than burying the transform inside each
   muxer (`ts-write`, `mp4/write`)? Decision affects items 5 & 6.
2. **Should `streamCopyTargets` be registry-discoverable / bidirectional** so the runner never enumerates
   targets and a new driver's cross-container copies light up automatically (item 1)?
3. **Fragmented/CMAF remux for MP4**, not just WebM/MKV — should the >1 GiB path fragment-remux MP4 to
   stay under the materialization ceiling instead of declining (`remux-runner.ts:258-281`)? Trade-off:
   bounded memory (ADR-034) vs. a non-fragmented output some players prefer.
4. **Attachment / side-data preservation across all remux routes.** Matroska attachments are preserved
   MKV→MKV (ADR-208/attachment-seam, `measured-evidence.md`) but WebM output raises a typed `CapabilityError` for
   attachments, and MP4↔MKV attachment mapping is undefined. What is the target policy for non-media side
   data on a cross-family remux?
5. **Should `remux-metadata.ts` be split** so the general MP4 semantic-Blob-reuse (`tryReuseMp4Semantic*`,
   used by `convert()` via `semantic-stream-copy.ts:14`) is not owned by a file named "remux-metadata"?
   Naming/layering decision, no behavior change.
6. **B-frame WebM duration truth** — resolve the `remux/h264_bframes_1080p_mp4_to_mkv` over-length
   (10.134 s vs 10.0 s, `measured-evidence.md`): is the fix in the WebM muxer's `endMs` accounting (S24) or in how
   remux forwards terminal DTS+duration? Owner boundary between S15 and S24 needs a logged decision.
