# Trim

> Target spec for the `trim` operation family. This document describes the **best** design and an
> honest **delta** against the code as it stands in `src/api/trim-runner.ts` and
> `src/api/trim-streams.ts`. It is what a coding agent implements against — not a description of
> today's code.

## 1. Purpose & scope

**Trim** cuts a media asset to the half-open time window `[start, end)` (seconds) and re-authors a
valid container, preserving every non-cut coded sample losslessly where possible. It serves the
benchmark **`trim`** family (42 harness features; mediabunny currently wins 31/42 and trim is a
concentration of "weak-gate" oracles — 31 of the 206 weak-gate cells) (measured-evidence.md). The public
entrypoint is `Engine.trim(input, opts, o)` which lazily imports `runTrim`
(`src/api/engine.ts:680`), and the option shape is `TrimOptions { start; end; mode?: 'keyframe' |
'accurate'; sink? }` (`src/api/types.ts:203`).

Two modes, two contracts:

- **`keyframe` (default).** Lossless. Cut snaps outward to the sync-sample (keyframe) boundaries so
  no frame is re-encoded; output begins at the first keyframe at/before `start`. Realized by
  driver-native container **stream-copy** (`ContainerDriver.streamCopy(src, { trim })`,
  `src/contracts/driver.ts:441`), PCM byte-window transform (`transformPcm`,
  `src/contracts/driver.ts:454`), or the audio EncodedChunk packet seam
  (`trimAudioPacketsViaSeam`, `src/api/trim-runner.ts:195`).
- **`accurate`.** Frame-exact video start/end. A decode→trim→re-encode graph
  (`trimViaCodec`, `src/api/trim-runner.ts:252`) that decodes from a keyframe **preroll**, drops
  frames outside the window, rebases the survivors to timestamp 0, and re-encodes.

Out of scope: multi-segment (gap) edit lists, joins/concat (that is the job/chain layer), and
per-track trimming with different windows (single window applies to all tracks).

## 2. Spec & references

Trim is governed less by a single RFC than by the container timing model it must not corrupt.

- **ISO/IEC 14496-12 — ISO Base Media File Format.** Edit List Box `elst` / Edit Box `edts`
  (presentation remapping; the mechanism for hiding pre-`start` samples of a keyframe-aligned copy),
  Sync Sample Box `stss` (the keyframe table that defines legal copy boundaries), and Composition
  Time to Sample `ctts` (B-frame composition offsets that a copy must carry through). Catalog:
  <https://www.iso.org/standard/83102.html>. Box registry: MP4RA <https://mp4ra.org/#/atoms>.
- **QuickTime File Format (Apple)** — edit lists and gapless (`iTunSMPB`) semantics that `elst`
  mirrors: <https://developer.apple.com/documentation/quicktime-file-format>.
- **W3C WebCodecs** — `EncodedVideoChunk`/`EncodedAudioChunk` carry **only** a presentation
  `timestamp` and **no DTS**; `VideoFrame`/`AudioData` are explicit-lifetime and must be `close()`d
  exactly once: <https://www.w3.org/TR/webcodecs/>. This is why keyframe trim must use driver-native
  stream-copy (which preserves DTS / `ctts` / codec-private) and not the codec seam (ADR-021,
  measured-evidence.md).
- **WHATWG Streams** — backpressure and `highWaterMark`; every trim stream in the codebase is
  pull-driven at `highWaterMark: 0`: <https://streams.spec.whatwg.org/>.
- **RFC 7845 — Ogg Opus** — `pre-skip` priming that a gapless trim must not double-remove:
  <https://www.rfc-editor.org/rfc/rfc7845>. General gapless (encoder delay + padding) is handled by
  `trimAudioGaplessFrameStream` (`src/api/trim-streams.ts:424`).
- **OSS exemplar — mediabunny (Vanilagy).** `Conversion.init({ input, output, trim: { start, end }
  })` (seconds); output "always begins at timestamp 0" unless `trim: { start: 0 }` is passed; it
  **transmuxes (copies packets) when codecs match and only transcodes when necessary**, snapping
  lossless cuts to keyframe boundaries; `forceTranscode: true` and `keyFrameInterval` force the
  decode/re-encode (sample-accurate) path. Repo: <https://github.com/Vanilagy/mediabunny>. Guide:
  <https://mediabunny.dev/guide/converting-media-files>. Our `keyframe` vs `accurate` split is the
  same axis as mediabunny's copy-vs-`forceTranscode`; where we should **beat** it is edit-list
  authoring (below) and the byte-window range-read fast path.

## 3. Target design

### Data model

- **`TrimBoundsUs { startUs; endUs }`** — the window rounded to integer microseconds
  (`trimBoundsUs`, `src/api/trim-streams.ts:79`). All internal gating is microsecond-integer to keep
  cuts deterministic across float timescales.
- **`TrimVideoPacketInfoRow` / `TrimAudioPacketInfoRow`** — metadata-only packet descriptors
  (`offset`, `size`, `timestampUs`, `dtsUs`, `durationUs`, `keyframe`, coalesced read `window`)
  produced from a demuxer's packet-info table *without reading `mdat`*
  (`src/api/trim-streams.ts:46`, `:56`). These drive the **targeted byte-window range read** that
  beats bulk fetch for large files (measured-evidence.md).
- **`TimedFrameForTrim`** — the minimal `{ timestamp, duration?, close() }` surface over both
  `VideoFrame` and `AudioData` so the frame-lifetime trim logic is codec/media-agnostic
  (`src/api/trim-streams.ts:20`).

### Seams & capability routing (WebCodecs → GPU → WASM, miss-only)

Trim is a **capability ladder**, evaluated most-lossless-first. The developer never names a route;
the runner picks the highest-fidelity capability the source container advertises:

1. **Driver-native container stream-copy** (`streamCopy({ trim })`, `validatesStreamCopyTrim`) — the
   lossless keyframe path. Zero codec, zero decode; preserves DTS / `ctts` / codec-private box
   (ADR-021). FLAC and any `validatesStreamCopyTrim` driver route here
   (`src/api/trim-runner.ts:109`).
2. **PCM byte-window transform** (`transformPcm({ timeBounds })`, `validatesPcmTrim`) for WAV/AIFF/
   CAF — a sample-exact byte slice, no decode (`src/api/trim-runner.ts:127`, `:167`).
3. **Audio EncodedChunk packet seam** for `mp3`/`adts`/`ogg` — demux packets, keep those overlapping
   the window, rebase, re-mux (`trimAudioPacketsViaSeam` → `trimAudioPacketStream`,
   `src/api/trim-runner.ts:195`, `src/api/trim-streams.ts:102`).
4. **Accurate decode→encode** (`trimViaCodec`) — the only route that touches a **codec**. Here the
   routing is WebCodecs-first: `context.codec(decodeQuery, …)` resolves a **hardware WebCodecs**
   decoder/encoder; a **WASM** decoder is pulled *only on a hardware miss* for a codec WebCodecs
   cannot decode (miss-only tail). **GPU is not a trim stage** — trim moves no pixels; a GPU stage
   only appears if trim is fused with a pixel filter in a chain, which is out of this family's scope.
   A true miss (no muxer for the target, `!containerHasChunkMuxer`) raises a typed `CapabilityError`
   (`src/api/trim-runner.ts:262`).

The output container is the sink; a non-`stream` sink materializes via `materialize`, a `stream`
sink passes the byte stream straight through (`materializeOutput`, `src/api/trim-runner.ts:532`).
**Worker offload:** only the heavy `accurate` decode→encode graph offloads
(`context.offload(src, 'trim', …)`, `src/api/trim-runner.ts:268`; `#offloadStream` gates on
`kind: 'convert' | 'trim'`, `src/api/engine.ts:1079`). Keyframe/PCM/packet trims stay inline because
the worker round-trip is not worth it, and offload ships **input bytes, never frames** — no
`VideoFrame`/`AudioData` crosses the worker boundary (measured-evidence.md, ADR-019/087).

### Edge cases

- **B-frames.** Keyframe trim never routes B-frames through the PTS-only codec seam — driver-native
  stream-copy preserves decode order and `ctts` (`src/contracts/driver.ts:435`, ADR-021). In the
  accurate path, the decoder receives packets from the **keyframe at/before `startUs`** (preroll):
  `planTrimVideoPacketInfoRows` sets `startIndex` to the last keyframe with `timestampUs <=
  startUs` and `endIndex` to the first keyframe with `timestampUs >= endUs`
  (`src/api/trim-streams.ts:158`–`:174`), so every kept delta/B-frame has its references. The
  decoder emits in **presentation order**, and `trimTimedFrameStream` gates on `frame.timestamp`
  (`src/api/trim-streams.ts:378`), so B-frame reorder is transparent.
- **VFR (variable frame rate).** Explicitly handled: a rounded container timescale can place a
  frame's PTS microscopically before the exclusive `endUs`; `trimTimedFrameStream` keeps that frame
  but clamps its declared duration to the residual span `endUs - frame.timestamp` so the authored
  subclip never overruns the window (`src/api/trim-streams.ts:390`–`:397`). Durations are never
  assumed constant.
- **Seek.** Trim's start is a seek: the fallback path is `startAtSeekKeyframe`
  (`src/api/codec-pipeline.ts:2593`), which buffers the head and re-emits from the last keyframe at/
  before the target; the fast path is `trimVideoPacketInfoChunkStream` over planned rows
  (`src/api/trim-runner.ts:327`). `planSeekVideoPacketInfoRows` (`src/api/trim-streams.ts:181`) is
  the shared 1-µs-window degenerate of the trim planner used by the seek family.
- **Cancel.** `trimViaCodec` runs drains under a `createDrainTaskGroup(signal)` child controller
  (`src/api/codec-pipeline.ts:1665`); on any task failure the group aborts its peers, and the
  `finally` disposes the group and `await demuxer.close()` (`src/api/trim-runner.ts:392`–`:404`).
  Before drains start, `openStreams` are `cancel()`ed (`src/api/trim-runner.ts:399`). Every readable
  is `highWaterMark: 0` with a `cancel()` that cancels the upstream reader
  (`src/api/trim-streams.ts:416`, `:511`, `:258`, `:295`).
- **Frame lifetime (`close()` exactly once).** `trimTimedFrameStream` is the ownership authority:
  a pre-`start` frame is closed and skipped (`src/api/trim-streams.ts:379`); the first on/after
  `endUs` is closed then upstream cancelled (`:383`); when `restamp` returns a **new** frame the
  original is closed (`if (out !== frame) frame.close()`, `:406`); an enqueue race closes the
  outgoing frame (`:411`). `restampVideoFrame`/`restampAudioData` are the only constructors of new
  frames (`:542`, `:520`). No `VideoFrame`/`AudioData` crosses the worker boundary.
- **Backpressure.** All trim readables pull one unit at a time (`highWaterMark: 0`), and the
  accurate path drains into the encoder via `drainEncoderToMuxer` which respects encoder
  backpressure (`src/api/codec-pipeline.ts:2526`). The window reader coalesces adjacent packet byte
  ranges into ≤8 MiB windows with ≤256 KiB gap tolerance
  (`assignTrimPacketInfoWindows`, `src/api/trim-streams.ts:632`; constants `:12`–`:13`).

### What the target adds over today (see §5)

The best design **authors an MP4 `elst` edit list** for a keyframe cut so the pre-`start` GOP frames
are decoded-but-not-presented, giving a frame-exact *playback* start with **zero re-encode** — the
QuickTime/ISO-BMFF mechanism mediabunny leans on. Today keyframe trim is keyframe-granular at
presentation, and only `accurate` (re-encode) achieves a frame-exact start.

## 4. Current state

`src/api/trim-runner.ts` (552 lines) is the eager-imported-lazily orchestrator; `src/api/trim-streams.ts`
(738 lines) holds the pure stream transforms and packet-info planners. Neither file holds
module-global **mutable** state — planners are pure and the only stateful object,
`TrimPacketInfoWindowReader`, is per-call (`src/api/trim-streams.ts:657`). That is genuinely good.
The smells are structural:

- **`runTrim` is a branch ladder / near-god-function** (`src/api/trim-runner.ts:98`–`:193`): nine
  routes (FLAC copy, `validatesStreamCopyTrim`, PCM `transformPcm` ×2, whole-source identity,
  accurate FLAC, accurate codec, audio packet seam, generic copy) each hand-rolling the same tail
  `materializeOutput(opts.sink ?? toBlob(), stream, mimeOptions(signal, target))`. The tail is
  duplicated ~9 times.
- **Module-level container allow-list (capability leak).** `AUDIO_PACKET_TRIM_CONTAINERS = new
  Set(['mp3','adts','ogg'])` (`src/api/trim-runner.ts:26`) hardcodes a routing decision by
  container *name* in the API layer, instead of a driver flag like the adjacent
  `validatesStreamCopyTrim`/`validatesPcmTrim` (`src/contracts/driver.ts:447`, `:460`).
- **Target-container guess.** `const target = (container.formats[0] ?? 'mp4') as Container`
  (`src/api/trim-runner.ts:107`) infers the output container by indexing the demux driver's format
  list and casting — a fragile capability guess, not a router decision.
- **Duplicated MIME map.** `CONTAINER_MIME` (`src/api/trim-runner.ts:30`–`:48`) restates
  container→MIME knowledge that the engine's `mimeOpts` also owns.
- **Untyped structural augmentation.** The packet-info fast path reaches through a hand-declared
  `DemuxerWithPacketInfoTable` interface and casts `(demuxer as DemuxerWithPacketInfoTable)`
  (`src/api/trim-runner.ts:50`–`:52`, `:299`) because `packetInfoTable?()` is not on the `Demuxer`
  contract — a layering hole.
- **Dead duplication.** `trimPacketCopyTrack` and `trimAudioPacketInfoTrack`
  (`src/api/trim-streams.ts:86`–`:100`) are byte-for-byte identical.
- **Encoder policy in a stream helper.** `trimVideoEncodeTarget`'s VBR bitrate heuristic
  (`src/api/trim-streams.ts:309`–`:334`, constants `:6`–`:11`) is transcode-encoder policy living in
  `trim-streams`, duplicating the implicit-bitrate logic owned elsewhere (ADR-084/123, measured-evidence.md).
- **Accurate audio is not sample-exact.** In `trimViaCodec` the accurate audio route prefers a
  **packet copy** (`src/api/trim-runner.ts:358`–`:368`) whose planner keeps a packet straddling
  `startUs` **whole** (`endUs > bounds.startUs` gate, `src/api/trim-streams.ts:619`); the decode
  fallback rebases whole `AudioData` frames via `restampAudioData` (`src/api/trim-runner.ts:377`,
  `src/api/trim-streams.ts:520`) and `trimTimedFrameStream` never splits the boundary frame. The
  sample-exact splitter (`trimAudioGaplessFrameStream` + `restampAudioDataRange`,
  `src/api/trim-streams.ts:424`, `:528`) exists but is wired only for gapless priming/padding, not
  for arbitrary `accurate` audio cuts.
- **No edit-list authoring.** Keyframe trim emits no `elst`; the presentation cut is
  keyframe-granular (see §3).

Honest limitations already recorded (keep): FLAC `accurate` still needs the decode/slice/re-author
path (ADR-096) and a partial FLAC trim writes the legal all-zero "unknown MD5" STREAMINFO; trim on
an entropy-coded bit-flipped source is an undetectable-at-container-level honest miss (ADR-043); MPEG-TS
computes the window against the earliest source PTS, not zero (all measured-evidence.md).

## 5. Delta / punch-list (ordered)

1. **Collapse the `runTrim` ladder into a declarative route table.** Replace the nine inline branches
   (`src/api/trim-runner.ts:109`–`:192`) with an ordered `{ guard, execute }` strategy list and one
   shared tail. **Acceptance:** a table test enumerates every route and asserts (a) exactly one guard
   fires per `(container, mode, capabilityFlags)` tuple, and (b) `materialize`/`toBlob`/`mimeOptions`
   appears once in the module (grep count == 1). Existing `trim-accurate.test.ts` / `trim-robustness.test.ts`
   stay green.
2. **Turn `AUDIO_PACKET_TRIM_CONTAINERS` into a driver capability flag.** Add
   `ContainerDriver.supportsAudioPacketTrim?: boolean` and route on it, deleting the module Set
   (`src/api/trim-runner.ts:26`). **Acceptance:** registering a fake container driver with the flag
   set routes through `trimAudioPacketsViaSeam` **without editing the runner**; a grep proves zero
   container string-literals in `runTrim`'s routing predicates.
3. **Replace the `formats[0]` target guess with an explicit container decision.**
   (`src/api/trim-runner.ts:107`.) Same-container trim must target the *source* container even when a
   driver lists another format first. **Acceptance:** a fake driver whose `formats[0]` differs from
   the sniffed source container still trims to the source container; assert output MIME == source
   container MIME.
4. **Make `accurate` audio sample-exact.** Route the accurate audio cut through a boundary-splitting
   transform built from `restampAudioDataRange`/`trimAudioGaplessFrameStream`
   (`src/api/trim-streams.ts:528`, `:424`) instead of whole-packet copy
   (`src/api/trim-runner.ts:358`) / whole-frame drop (`:377`). **Acceptance:** a 48 kHz fixture with
   a cut landing mid-packet yields `outputSampleCount == round((end - start) * sampleRate)` with a
   **0-sample** delta (today it can be off by up to one packet). Add the oracle to `trim-accurate.test.ts`.
5. **De-duplicate `trimPacketCopyTrack` / `trimAudioPacketInfoTrack`** (`src/api/trim-streams.ts:86`–`:100`).
   **Acceptance:** one exported function; both call sites reference it; no test change.
6. **Hoist `trimVideoEncodeTarget` into the shared implicit-bitrate policy** (ADR-084/123) so trim
   and convert cannot diverge (`src/api/trim-streams.ts:309`). **Acceptance:** a single bitrate
   function is called by both entrypoints; a test asserts identical `VideoTarget` for identical
   `(width, height, fps, sourceBitrate)` across trim and convert.
7. **Promote `packetInfoTable()` onto the `Demuxer` contract** and delete the
   `DemuxerWithPacketInfoTable` cast (`src/api/trim-runner.ts:50`, `:299`). **Acceptance:** `tsc`
   passes with the cast removed; a demuxer without the method falls back to `startAtSeekKeyframe`
   (assert the fallback fires via a spy).
8. **Author an MP4 `elst` edit list for keyframe video trim** so the pre-`start` GOP is
   decoded-but-hidden, giving a frame-exact playback start with no re-encode (the §3 target).
   **Acceptance:** a keyframe trim whose `start` lands mid-GOP produces an MP4 whose first *presented*
   frame is at `start` (probe the `elst` `media_time`/`segment_duration`), while byte-identical coded
   samples prove no re-encode occurred. Log ADR first (edit-list vs re-encode fidelity trade).
9. **Centralize `CONTAINER_MIME`** with the engine `mimeOpts` map (`src/api/trim-runner.ts:30`).
   **Acceptance:** one MIME source of truth; a test iterating all containers asserts trim and convert
   emit identical MIME per container.
10. **Lock the VFR trailing-duration clamp and cancel frame-safety with dedicated oracles.**
    **Acceptance (VFR):** a VFR fixture whose last kept frame's declared duration overruns `endUs`
    yields a muxed final-sample duration == `endUs - lastFrameTs` exactly (pins
    `src/api/trim-streams.ts:394`). **Acceptance (cancel):** an abort injected after the first decoded
    frame in `trimViaCodec` leaves **zero** un-closed `VideoFrame`/`AudioData` (frame-leak counter
    oracle) and calls `demuxer.close()` exactly once (`src/api/trim-runner.ts:398`–`:404`).

## 6. Open questions (seed `docs/decisions/`)

1. **Is `accurate` trim's audio contract sample-exact or packet-exact?** Today it is packet/frame
   granular (§4, delta 4). Decide whether `accurate` guarantees `±0` samples at the audio cut, or
   whether packet-accurate audio + frame-accurate video is the documented contract. Log the decision
   and the oracle tolerance.
2. **Should keyframe trim author an `elst`?** (Delta 8.) An edit list gives frame-exact playback with
   zero re-encode but adds container complexity and depends on player `elst` support; re-encoding the
   leading partial GOP is an alternative "hybrid" cut. Decide the default and whether it is
   codec/container-gated.
3. **FLAC `accurate` MD5 policy.** Partial trims write the all-zero "unknown MD5" STREAMINFO
   (ADR-096/measured-evidence.md) because recomputing requires a full PCM decode. Confirm this stays the
   contract vs an opt-in exact-MD5 (full-decode) mode.
4. **Native AAC priming suppression on the trim path.** Chromium can natively suppress AAC
   encoder-delay/priming, risking a double-trim; ADR-213 added a bounded preflight for convert. Decide
   whether `accurate` trim must run the same preflight and log it.
5. **Keyframe-trim-inline for huge sources.** Only `accurate` trim offloads to a worker
   (`src/api/engine.ts:1079`). Confirm keyframe/PCM/packet trims never need offload even for
   multi-GB inputs, or define a size threshold.
6. **Harness corpus defect `trim/vp9_noop_full_range_idempotent`.** The fixture exports duration 10 s
   but demands equality with a 26.019/46.548/224.107 s input, so `{start:0,end:10}` is a prefix, not a
   full-range no-op (measured-evidence.md). Track the upstream harness fix so this row is not gamed.

---

*Verification notes:* mediabunny's `trim` option, "begins at timestamp 0", copy-when-possible /
`forceTranscode` / `keyFrameInterval` behaviors are confirmed from its guide
(<https://mediabunny.dev/guide/converting-media-files>). `UNVERIFIED:` mediabunny's exact internal
choice between edit-list authoring vs re-encode for a mid-GOP lossless start is not documented in the
guide and was not read from its source — treat the §2 "snaps lossless cuts to keyframe boundaries"
claim as guide-level, not source-verified. `UNVERIFIED:` the precise ISO/IEC 14496-12 clause numbers
for `elst`/`stss`/`ctts` (§8.6.x) are cited from memory of the standard, not from the paywalled text.
