# Mux

> Shard S14 · benchmark family: **mux** · docPath: `docs/operations/mux.md`
> Owned code: `src/api/mux-packet-streams.ts`, `mux-runner.ts`, `native-packet-mux.ts`,
> `mp4-prepared-mux.ts`, `mpegts-prepared-mux.ts`, `flac-mkv-mux.ts` (under `src/api/`);
> `src/drivers/audio-container-mux-validation.ts`.
>
> This document is the **target spec** (the best design) plus an **honest delta** against today's
> code — not a description of the current implementation.

## 1. Purpose & scope

The **mux** family is the write-only assembly seam: it takes one or more caller-owned *encoded
packet streams* — each an already-coded elementary stream (`EncodedChunk`s from an encoder, or
`Packet`s carrying DTS from a demuxer) plus its `TrackInfo` — and interleaves them into a single
container byte stream (MP4/MOV, WebM/MKV, Ogg, MPEG-TS, WAV, MP3, ADTS, FLAC-in-MKV, AVI). It does
**not** decode, encode, or filter. It is the public `MediaEngine.mux(streams, opts)` operation
(`src/api/engine.ts:892`), distinct from *remux* (S15, driver-native container→container stream-copy)
and *transcode* (S11–S13, decode→filter→encode→mux).

The unit of work is the packet, never the raw frame: the input contract is `PacketStreams`
(`src/api/types.ts:327`), whose members are `PacketStream`s of `ReadableStream<EncodedChunk | Packet>`
or a materialized `packetsArray` (`src/api/types.ts:308-317`). Because the input is already coded,
this family carries **DTS, per-packet duration, keyframe flags, codec-private boxes, and VPx alpha
side-data** through to the target container's layout rules; a lossy or reordered stream must survive
byte-faithfully (ADR-045, ADR-021).

Benchmark family served: `mux` only (rows such as `mux/audio_only_aac_to_mp4`,
`mux/video_plus_audio_to_mp4`, `mux/swap_audio_video_with_opus_to_mkv`, `mux/flac_to_mkv_audio`,
`mux/opus_to_ogg`, `mux/h264_aac_to_ts`, `mux/pcm_s16_to_wav`). Measured baselines and known losses
for these rows are cited from `docs/measured-evidence.md` throughout.

## 2. Spec & references

Governing container standards (every mux target the family can author):

- **ISO base media file format (ISO-BMFF)** — ISO/IEC 14496-12: `ftyp`/`moov`/`mdat` boxes, sample
  tables (`stts`/`ctts`/`stsc`/`stsz`/`stco`/`co64`/`stss`), and the `moof`/`mdat` fragmentation
  grammar. https://www.iso.org/standard/83102.html
- **QuickTime File Format (MOV)** — Apple's ISO-BMFF sibling (different `ftyp` brand, same box tree).
  https://developer.apple.com/documentation/quicktime-file-format
- **Matroska** — IETF RFC 9559 (Matroska container) and the element registry: `Segment` /
  `SeekHead` / `Tracks` / `Cluster` / `SimpleBlock` / `BlockGroup` / `BlockAdditions`.
  https://www.rfc-editor.org/rfc/rfc9559.html · https://www.matroska.org/technical/elements.html
- **EBML** — RFC 8794 (the binary grammar Matroska/WebM are built on, including the unknown-size
  vint used by live/streaming Clusters). https://www.rfc-editor.org/rfc/rfc8794.html
- **WebM** — the VP8/VP9/AV1 + Opus/Vorbis Matroska subset.
  https://www.webmproject.org/docs/container/
- **MPEG-2 Systems / Transport Stream** — ISO/IEC 13818-1 (188-byte TS packets, PAT/PMT, PES with
  90 kHz PTS/DTS). https://www.iso.org/standard/75928.html
- **Ogg** — RFC 3533 (page grammar, granule positions) with Opus-in-Ogg RFC 7845 and Vorbis-in-Ogg
  mappings. https://www.rfc-editor.org/rfc/rfc3533.html · https://www.rfc-editor.org/rfc/rfc7845.html
- **RIFF/WAVE** — the PCM `fmt `/`data` chunk layout (WAV mux). https://www.rfc-editor.org/rfc/rfc2361
- **W3C WebCodecs** — the `EncodedVideoChunk`/`EncodedAudioChunk` (PTS-only) types that the packet
  seam wraps. https://www.w3.org/TR/webcodecs/
- **WHATWG Streams** — `ReadableStream`/`WritableStream`, `desiredSize`, backpressure — the transport
  the packet streams and muxer output ride on. https://streams.spec.whatwg.org/

OSS exemplar: **mediabunny** `Output` + per-format muxers.
https://github.com/Vanilagy/mediabunny (`src/output.ts`, `src/output-format.ts`, `src/muxer/`).
Key parallels confirmed from its docs/source:

- `Output` owns one `_muxer` created by `format._createMuxer(this)`; `addVideoTrack`/`addAudioTrack`
  route through `_addTrack`, which verifies codec legality via `format.getSupportedVideoCodecs()` /
  `getSupportedAudioCodecs()` — the format's `addTrack` is the **single arbiter of codec-in-container
  legality** (mirrors our muxer `addTrack`/`mapCodec`, `src/api/codec-routing.ts:19`).
- MP4 `fastStart` has four modes: `false` (metadata at end, least memory), `'in-memory'` (buffer
  chunks, write `moov` first at finalize), `'reserve'` (pre-allocate `moov` space given
  `maximumPacketCount`), and `'fragmented'` (fMP4). https://mediabunny.dev/guide/output-formats
- Fragmented/append-only formats guarantee "the byte offset of any write equals the number of bytes
  written before it," enabling streaming with no whole-file buffering.

Where the SOTA design should **beat** mediabunny: our packet seam carries an explicit `dtsUs`
side-channel on `Packet` (`src/contracts/driver.ts:89-100`) and a **native zero-host-chunk fusion**
path (`src/api/native-packet-mux.ts`) that constructs *zero* `Encoded*Chunk` objects for a
demux→mux round-trip — a copy mediabunny cannot avoid at its public boundary
(`docs/measured-evidence.md`: native fusion built zero host chunks vs. per-packet construction).

## 3. Target design

### 3.1 Data model & seams

One seam type flows end-to-end: the **packet**.

```ts
// src/contracts/driver.ts:89-100
export interface Packet {
  readonly chunk: EncodedChunk;      // sealed WebCodecs unit: coded bytes, key flag, timestamp = PTS
  readonly data?: Uint8Array;        // owned byte view == chunk.copyTo(); packet-copy muxers read it directly
  readonly alpha?: EncodedVideoChunk;// VPx alpha side-data → WebM BlockAdditions (BlockAddID=1)
  readonly dtsUs?: number;           // decode timestamp; undefined ⇒ DTS == PTS (no reorder)
  readonly sizeBytes?: number;       // container packet byte length; undefined ⇒ chunk.byteLength
}
```

The public input is `PacketStreams { video?, audio?, tracks? }` (`src/api/types.ts:327-331`); the
`tracks[]` arm is the multi-source / multi-track assembly seam (≥2 video, ≥2 audio, or tracks
demuxed from several sources). The muxer contract is minimal and honors DTS:

```ts
// src/contracts/driver.ts:324-331
export interface Muxer {
  readonly output: ReadableStream<Uint8Array>;
  addTrack(info: TrackInfo): number;
  write(trackId: number, packet: Packet): Promise<void>; // preserves PTS/DTS/duration
  writePcm?(trackId: number, data: Uint8Array): Promise<void>;
  finalize(): Promise<void>;
}
```

**Layering (target):**

1. **Router** (`mux-runner.ts::runMux`) — the only place that maps a container token to a mux route.
   It should own a *declarative table* `token → { native?, prepared, general }`, not nested ternaries.
2. **Normalization** (one shared module) — `Packet | EncodedChunk → ChunkStruct` and stream-drain
   helpers, used by every prepared muxer. Today this is duplicated in five files (see §4).
3. **Container muxers** (S23–S29 drivers) — the real ISO-BMFF/Matroska/TS/Ogg/RIFF writers; `addTrack`
   is the single arbiter of codec legality.
4. **Sink materialization** (S07) — `materialize(sink, stream, opts)` turns `Muxer.output` into a
   Blob/OPFS/stream target.

The developer names **only the target container** (`MuxSpec.container`, `src/api/types.ts:226`);
never a driver or backend. A token with no chunk-seam muxer raises a typed `CapabilityError`
(`mux-runner.ts:43-48`), and an illegal codec-in-container is rejected by the muxer's own `addTrack`
(`src/api/codec-routing.ts:19`) — the single source of codec-legality truth.

MP4/MOV exposes three deliberate layout choices through `faststart?: boolean | 'reserve'` plus
`fragmented?: boolean`: ordinary metadata-last output, in-memory `moov`-first output, reserved
progressive output, or fragmented output. Reserved output requires a positive per-track
`maximumPacketCount` and a positioned callback/seekable/OPFS sink. Validation runs before any
caller-owned packet stream is pulled; the generic writer enforces the ceiling again while packets
arrive and raises the stable `MP4_FASTSTART_RESERVE_PACKET_OVERFLOW` failure on overflow.

### 3.2 Capability routing (WebCodecs → GPU → WASM, miss-only)

Muxing is **container serialization in pure TypeScript** — there is no WebCodecs/GPU/WASM tier for
writing boxes, so the usual hardware→GPU→WASM ladder does not gate the *writer*. The routing that
does apply is a **fast-path ladder by input shape**, cheapest first:

1. **Native zero-copy fusion** — when every input packet stream is a first-party demuxer stream whose
   provenance is claimable, `muxNativeFirstPartyPacketStreams` (`native-packet-mux.ts:14`) claims the
   already-validated `NativePacketChunk[]` (`src/internal/packet-provenance.ts:4-16`) and authors the
   container with **zero `Encoded*Chunk` host objects** constructed. MP4/MOV, blob/undefined sink only,
   `faststart !== false` (`native-packet-mux.ts:22`). *Target: extend to WebM/MKV/Ogg (§5).*
2. **Prepared fast muxers** — when packets are already materialized arrays or small streams, drain
   once into a `ChunkStruct[]` and call the container's whole-buffer writer
   (`mp4-prepared-mux.ts`, `mpegts-prepared-mux.ts`, `flac-mkv-mux.ts`). Chosen for latency on small
   inputs and to avoid one promise-backed pull per already-resident packet
   (`MP4_PREPARED_MULTITRACK_MIN_PACKETS = 256`, `flac-mkv-mux.ts:41`, ADR-256).
3. **General streaming muxer** — the fallback for arbitrary `ReadableStream` packet sources: build the
   live `Muxer`, drain every track concurrently through `drainEncoderToMuxer`
   (`src/api/codec-pipeline.ts:2526`) into the shared muxer under one-packet backpressure, then
   `finalize()` (`mux-runner.ts:99-133`).

The WASM/GPU tiers appear only *upstream* of mux (a decoder/encoder that produced the packets), never
in the writer. WebCodecs is present only as the *type* of the packet (`EncodedChunk`), not as a tier.

### 3.3 Edge cases

- **B-frames / reordering (DTS).** This is the defining correctness requirement of the family.
  `EncodedChunk` exposes only PTS; the muxer needs decode order and, for MP4, the per-sample
  composition offset (`ctts`). `dtsUs` carries it (`src/contracts/driver.ts:96`). The prepared and
  native paths preserve it verbatim: `chunkStructFrom` copies `dtsUs` when present
  (`mp4-prepared-mux.ts:252`, `flac-mkv-mux.ts:728`, `mpegts-prepared-mux.ts:178`); the native chunk
  carries `dtsUs` (`packet-provenance.ts:9`). `undefined ⇒ DTS == PTS` (no reorder). The generic path
  wraps bare encoder chunks with `toPacket` (`codec-pipeline.ts:1693`) so the muxer recovers DTS from
  arrival order/durations. Routing remux/trim through this seam is *only* valid because `dtsUs` exists
  — WebCodecs alone cannot preserve B-frame order (ADR-021, ADR-045).

- **VFR (variable frame rate).** Per-packet `durationUs` flows through unchanged
  (`mp4-prepared-mux.ts:249`, `flac-mkv-mux.ts:715`). The hazard (ADR-191): a VFR encoder may keep a
  *nominal* constant duration (e.g. 16667µs) while emitting monotonic-but-corrected PTS; cumulative
  rounded durations can push a parsed PTS a tick behind DTS and fabricate a phantom reorder
  (`docs/measured-evidence.md`: 626 VFR frames, PTS 11µs behind DTS by frame 17). The muxer must derive DTS
  from actual PTS spacing, never from summed nominal durations. `ctts` is computed in microseconds
  first so a non-reordered stream yields exactly `ctts == 0` at any timescale (ADR-028).

- **Seek.** Not applicable — mux is write-only assembly with no random access into the source. (Seek
  is a decode-side concern, S10.) One line, by design.

- **Cancel.** An `AbortSignal` threads from `MediaChain`/`CallOptions` into every path. The generic
  path uses `createDrainTaskGroup` (`codec-pipeline.ts:1665`): the first task failure aborts every
  sibling reader, waits for teardown, then rethrows. Undrained packet streams are cancelled on the
  error path (`mux-runner.ts:104`, `128-131`, `156-158`). The native path links a fresh
  `AbortController` to the parent signal and aborts sibling claims on failure
  (`native-packet-mux.ts:34-49`). Prepared paths poll `assertNotAborted` inside their drain loops
  (`flac-mkv-mux.ts:398`, `mpegts-prepared-mux.ts:149`, `mp4-prepared-mux.ts:271`) and cancel the
  reader on error (`flac-mkv-mux.ts:423-427`).

- **Frame lifetime (`close()` exactly once).** No `VideoFrame`/`AudioData` ever enters this family —
  the input is coded `EncodedChunk`/`Packet` (immutable, GC-reclaimed, **no `close()`**). The lifetime
  obligation here is instead **`ReadableStream` reader hygiene**: every drain acquires a reader, and on
  every exit (done, error, cancel) it `reader.cancel(...)` (on error) and `reader.releaseLock()`
  (`flac-mkv-mux.ts:415-428`, `mpegts-prepared-mux.ts:146-159`, `codec-pipeline.ts:2554-2586`). A
  packet stream that is validated-away before draining must still be cancelled so its producer unwinds
  (`mux-runner.ts:104`). State it plainly: **mux `close()`-exactly-once applies to stream readers, not
  to media frames.**

- **Backpressure.** The general path is strict one-packet backpressure: `drainEncoderToMuxer` reads one
  packet, `await muxer.write(...)`, reads the next (`codec-pipeline.ts:2565-2578`); the seam streams
  run at `highWaterMark: 0` (`codec-pipeline.ts:1736`). The **prepared/native fast paths deliberately
  buffer the whole track** into an array before writing (`packetValues`, `packetChunks`) and emit the
  finished container as a *single* `streamFromBytes` chunk (`flac-mkv-mux.ts:762`) — no incremental
  emission. That is acceptable for the small/bounded inputs they target and for the buffered-Blob
  path (ADR-268 one exact-owned buffer), but it is the family's main backpressure gap for large
  outputs (see §5.4). The bounded-materialization safety valve (decline >~512 MiB rather than OOM,
  ADR-053/ADR-102) lives at the sink boundary (S07), not here.

## 4. Current state

**Router — `mux-runner.ts` (163 lines).** `runMux` (`:35-133`) is the single dispatch point. It
guards the target (`containerHasChunkMuxer`, `:43`), then decides the route via **nested ternaries**
(`:49-97`): native-first-party for MP4/MOV blob sinks (`:56-68`), a `fastMux` prepared dispatch that
picks `muxPreparedMp4PacketStreams` / `muxSingleTrackOggAudio` / `muxPreparedWebmPacketStreams` by
more string comparison (`:69-87`), a separate MPEG-TS block (`:88-97`), and finally the general
`createMuxer` + `drainEncoderToMuxer` path (`:99-133`). It also owns the `CONTAINER_MIME` table
(`:8-26`). Smells: the container→route decision is **imperative nested ternaries with `target === 'mp4'
|| target === 'mov'` literals scattered across five branches** — a routing capability spread.

**`mux-packet-streams.ts` (133 lines).** `muxPacketStreams` (`:30`) validates and normalizes
`PacketStreams` into `MuxPacketStream[]` for the generic path; `readablePacketStreams` (`:45`) collects
undrained streams for cancellation. It re-implements `isObject`/`isReadableStreamLike`/`isTrackInfoLike`
(`:97-133`) and a `packetArrayStream` wrapper (`:107`).

**`native-packet-mux.ts` (68 lines).** `muxNativeFirstPartyPacketStreams` (`:14`) is the zero-copy MP4/MOV
fusion: preflight every input's provenance (`:27-32`), claim all sources under a linked abort controller
(`:34-49`), author via `muxPreparedMp4NativeTracks`, emit one buffer (`:59-64`). Clean and focused.

**`mp4-prepared-mux.ts` (298 lines).** The MP4/MOV whole-buffer + streaming writers
(`muxPreparedMp4PacketTracks` `:73`, `muxPreparedMp4NativeTracks` `:87`,
`muxPreparedMp4PacketTracksStream` `:116`). **Layering smell:** it also hosts *demux-side*
`mp4PacketInfoFromBytes`/`mp4PacketInfoFromUrl` (`:192-229`) — packet-info probing that belongs to the
demux/probe shard (S09), not a mux file. Re-implements `chunkStructFrom`/`packetBytes`/`encodedChunkBytes`
(`:245-294`).

**`mpegts-prepared-mux.ts` (228 lines).** `muxPreparedMpegTsPacketStreams` (`:76`) drains and calls
`muxPreparedMpegTsPacketTracks` (`:31`). Re-implements `preparedPacketStreams`/`isPreparedPacketStream`
(`:94-131`), `packetValues` (`:133-161`), `mpegTsChunkFrom`/`packetBytes`/`encodedChunkBytes`
(`:169-205`), `isObject`/`isReadableStream`/`assertNotAborted`/`streamFromBytes` (`:207-228`).

**`flac-mkv-mux.ts` (769 lines) — the god-file.** Its name says "flac + mkv," but it is the *catch-all
prepared-muxer* module: it hosts **MP4/MOV** (`muxSingleTrackMp4` `:79`, `muxPreparedMp4PacketStreams`
`:124` — importing from `mp4-prepared-mux.ts`), **Ogg** (`muxSingleTrackOggAudio` `:176`), **WebM/MKV**
(`muxPreparedWebmPacketTracks` `:225`, `muxPreparedWebmChunkTracks` `:255`, `muxPreparedWebmPacketStreams`
`:285`, `muxSingleTrackWebmAudio` `:306`), and **FLAC-in-MKV** (`muxFlacMkv` `:156`). It re-implements
`packetChunks`/`packetValues` (two near-identical drain loops, `:402-460`),
`chunkStructFrom`/`packetBytes`/`encodedChunkBytes` (`:713-753`), `isObject`/`isReadableStream`/
`assertNotAborted`/`streamFromBytes` (`:388-400`, `:762-769`), and hardcodes container→codec-id
mapping in `webmAudioCodecId` (`:542-548`). This is the single biggest structural liability in the shard.

**`audio-container-mux-validation.ts` (208 lines, `src/drivers/`).** The one genuinely-shared piece:
synchronous mux-contract validation reused by lazy proxies and the real audio muxers so an invalid
fragmented/duplicate-track/wrong-codec request fails *before* the concrete muxer loads
(`assertAudioMuxOptions` `:20`, `wavMuxTrackConfig` `:37`, `validateMp3MuxTrack` `:82`, `oggMuxCodec`/
`validateOggMuxTrack` `:98-124`, `adtsMuxTrackConfig` `:132`, `rejectRawPcmChunkMux` `:171`,
`pcmWireFormat` `:178`). Rationale: `docs/measured-evidence.md` (lazy audio containers keep the synchronous mux
contract via shared validation; AIFF/CAF raw PCM is authored by `transformPcm`, never the chunk seam).

**Module-global mutable state.** The mux-family files themselves are stateless (pure functions +
per-call streams). The one process-global is the `nativePacketSource` `WeakMap`
(`src/internal/packet-provenance.ts:18`), owned by S09 but consumed here (`native-packet-mux.ts:29`);
a `WeakMap` keyed by stream identity is a defensible design, not a leak.

**Layering smells summary.** (1) `flac-mkv-mux.ts` god-file spanning four container families under a
two-family name. (2) Demux-side `mp4PacketInfo*` living in a mux file. (3) Five copies of the
packet→chunk-struct + stream-drain helpers. (4) Container routing as nested ternaries in `runMux`
rather than a table. (5) `webmAudioCodecId` codec-id literals in the API layer duplicating the driver's
own codec map.

## 5. Delta / punch-list (ordered, each with an acceptance test)

### 5.1 Extract one shared packet-normalization + stream-drain module
`chunkStructFrom`, `packetBytes`, `encodedChunkBytes`, `isPacket`, `isObject`, `isReadableStream(Like)`,
`assertNotAborted`, `streamFromBytes`, and the `packetValues`/`packetChunks` drain loops are duplicated
across `mux-packet-streams.ts` (`:97-133`), `mp4-prepared-mux.ts` (`:245-298`),
`mpegts-prepared-mux.ts` (`:133-228`), and `flac-mkv-mux.ts` (`:388-460`, `:713-769`). Consolidate into
`src/api/mux-packet-normalize.ts`.
**Acceptance:** `grep -rc 'function encodedChunkBytes' src/api` returns exactly 1; a unit test feeds a
`Packet` whose `data` aliases `chunk` and asserts `packetBytes` returns the *same* buffer (zero copy,
`mp4-prepared-mux.ts:284-288`), and a bare `EncodedChunk` and asserts the `copyTo` path allocates once;
typecheck + full mux suite stay green with byte-identical golden outputs.

### 5.2 Rename & split the `flac-mkv-mux.ts` god-file
Move `muxSingleTrackMp4`/`muxPreparedMp4PacketStreams` (`flac-mkv-mux.ts:79-153`) into
`mp4-prepared-mux.ts`; move `muxSingleTrackOggAudio` (`:176-188`) into an `ogg-prepared-mux` wrapper;
keep WebM/MKV/FLAC-in-MKV in a `webm-prepared-mux.ts`. No file named for FLAC+MKV should export MP4 or
Ogg muxers.
**Acceptance:** each prepared module imports/exports exactly one container family; `runMux` imports MP4
wrappers from `mp4-prepared-mux.ts`, not `flac-mkv-mux.ts`; eager-kernel + default/probe bundle sizes
stay within their caps (`docs/measured-evidence.md` records 49.66 kB / 50.00 kB for the FLAC-MKV fast path); all
`mux/*` goldens byte-identical.

### 5.3 Replace `runMux` nested ternaries with a declarative route table
`mux-runner.ts:49-97` decides the route with `target === 'mp4' || target === 'mov'` literals in five
places. Replace with `const MUX_ROUTES: Record<Container, MuxRoute>` where `MuxRoute` names
`{ native?, prepared, streamOnly? }`, and iterate.
**Acceptance:** `runMux` contains no bare container string-equality for routing; a test enumerates every
token in `CODEC_MUX_CONTAINERS` (`src/api/codec-routing.ts:21`) and asserts each resolves to a concrete
route (or a typed `CapabilityError` with `op:'mux'` and `tried:[token]`), proving the table is total.

### 5.4 Give prepared muxers incremental (streaming) output
Prepared/native paths emit the whole container as one `streamFromBytes` chunk
(`flac-mkv-mux.ts:762`, `native-packet-mux.ts:59-64`) and fully buffer packets
(`packetValues`/`packetChunks`). For a `'stream'` sink this defeats backpressure and pins peak RSS to
output size. Add incremental cluster/fragment emission (mediabunny's append-only guarantee: byte offset
of each write == bytes previously written) for `'stream'` sinks; keep the single exact-owned buffer only
for the buffered-Blob path (ADR-268).
**Acceptance:** muxing N=100k packets into a `'stream'` sink yields > 1 output chunk and peak RSS grows
sub-linearly vs. N; the buffered Blob path still produces exactly one `ArrayBuffer`; goldens unchanged.

### 5.5 Extend native zero-copy fusion to WebM/MKV and Ogg
`muxNativeFirstPartyPacketStreams` covers only MP4/MOV (`native-packet-mux.ts:22`). The WebM/Ogg swap
rows still construct per-packet host objects at the public boundary — `docs/measured-evidence.md` records
`mux/swap_audio_video_with_opus_to_mkv` at 202.4 ms vs. mediabunny 53.1 ms (3.6×) and
`mux/video_plus_audio_to_mp4` at 228.7 ms vs. 49.8 ms (4.2×), attributed to that copy. Add native
`NativePacketChunk` fusion for the WebM/MKV and Ogg writers.
**Acceptance:** the MKV/Ogg fusion path constructs **zero** `Encoded*Chunk` objects (assert via a
provenance-claim spy), a fresh multi-sample benchmark beats the recorded 202.4 ms with oracle PASS
(packets/frames/colour/HDR preserved), and DTS/alpha survive byte-exact.

### 5.6 Prove the faststart one-pass `moov` (no double serialize)
`docs/measured-evidence.md` records `mux/h264_aac_to_mov` as a 1.52× loss from "faststart serializing the
complete `moov` twice." The current writer serializes `moov` once with zero offsets then **patches
offsets in place** (`src/drivers/mp4/write.ts:944-950`), which should be one pass. Confirm and lock it.
**Acceptance:** an instrumented run counts exactly **one** `moov(...)` serialization for a faststart mux;
`mux/h264_aac_to_mov` bench median beats mediabunny fresh; output byte-identical to the two-pass golden.

### 5.7 VFR monotonic-DTS guard at the mux seam (ADR-191)
A muxer must not derive DTS from summed *nominal* durations (fabricates PTS<DTS reorder,
`docs/measured-evidence.md`: 626 VFR frames). Add an assertion at the packet→sample-table conversion that DTS is
monotonic and never exceeds the packet's PTS unless a real reorder (`dtsUs < ptsUs`) was supplied.
**Acceptance:** the ADR-191 oracle — mux 626 VFR frames with nominal 16667µs duration + cadence
corrections — parses back with **zero** PTS/DTS inversions and one keyframe (the recorded fix result).

### 5.8 Standardize the mux `CapabilityError`/`MediaError` shape
`mux-runner.ts:43-48` throws `CapabilityError('capability-miss', ..., { op:'mux', tried:[target] })`
while the prepared muxers throw `{ op:{ op:'mux', container }, tried:[...] }`
(`mp4-prepared-mux.ts:88-97`, `mpegts-prepared-mux.ts:33-51`, `flac-mkv-mux.ts:194-215`). Pick the
structured `op` object form everywhere.
**Acceptance:** a test drives every mux rejection (no muxer, wrong container, fragmented-unsupported,
zero tracks, illegal codec) and asserts each error's `op` is a structured `{ op:'mux', container?, codec?
}` with a non-empty `tried[]`.

### 5.9 Relocate demux-side helpers out of `mp4-prepared-mux.ts`
`mp4PacketInfoFromBytes`/`mp4PacketInfoFromUrl` (`mp4-prepared-mux.ts:192-229`) probe packet-info; they
belong to S09 (probe/demux), not a mux module.
**Acceptance:** `mp4-prepared-mux.ts` imports no `readMovie`/`mp4PacketInfoTable`; the probe helpers live
under demux ownership and their tests move with them; mux bundle shrinks or is unchanged.

### 5.10 Assert DTS-ordered interleave from the concurrent generic drain
The generic path drains all tracks concurrently into a shared muxer (`mux-runner.ts:116-122`); writes
arrive interleaved and the muxer must order by DTS (MP4 sample tables per track; WebM Clusters in
decode order; TS PES by PTS/DTS). Add a golden proving correct cross-track interleave.
**Acceptance:** muxing two tracks with interleaved DTS produces a spec-valid layout (WebM Cluster block
order / MP4 `stco`+`ctts`) that a reference demux reads back with `maxPtsDrift == 0` and correct
per-track packet counts.

## 6. Open questions (seed `docs/decisions/`)

1. **Retire prepared fast muxers once native fusion + streaming muxers cover every family?** Three
   parallel code paths (native, prepared-buffered, general-streaming) exist for perf. If §5.4 + §5.5
   land, is the prepared-buffered tier still worth its duplication, or does one streaming muxer per
   family with an optional buffered-Blob finalize suffice? Decide the target path count.
2. **Own a formal container↔codec capability registry in the mux layer?** Codec legality is currently
   asserted late by each muxer's `addTrack` plus ad-hoc literals (`webmAudioCodecId`,
   `flac-mkv-mux.ts:542-548`; `CODEC_MUX_CONTAINERS`, `codec-routing.ts:21`). Should a single declarative
   registry (mirroring mediabunny's `format.getSupportedVideo/AudioCodecs()`) be the one arbiter, with
   the API layer holding no codec-id strings?
3. **Prepared-path fragmented (CMAF / live) output.** Fragmented WebM/MKV and MP4 currently fall to the
   general muxer (`mux-runner.ts:49-53`); the prepared muxers reject `fragmented` outright
   (`mp4-prepared-mux.ts:144-153`). Should the streaming muxer become the sole fragmented author for
   live/MSE targets, sharing S07's streaming sink? (Ties to streaming-output S07.)
4. **Is `MP4_PREPARED_MULTITRACK_MIN_PACKETS = 256` a robust device-independent crossover?**
   (`flac-mkv-mux.ts:41`, ADR-256.) A single baked constant governs prepared-vs-stream selection; should
   it be tier-threshold-driven (S01) or measured per session rather than a compiled literal?
