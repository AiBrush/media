# Metadata (tag read/write & rewrite)

> Shard S20 · serves the **metadata** benchmark family. Target spec + honest delta vs today's
> `src/metadata/*.ts` and `src/util/digest.ts`. Every claim is cited to `path:line`, to an external
> spec, or to rescued measured facts in `docs/measured-evidence.md` (cited `(measured-evidence.md)`). Unverifiable
> claims are marked `UNVERIFIED`.

## 1. Purpose & scope

This family reads and **rewrites descriptive container-level metadata tags** — title, artist, album,
comment, date, genre, track number, and (target) cover art — across every container the engine can
mux, **without re-encoding or re-muxing a single media payload byte**. It is byte surgery on the
container's tag structures (ID3v2 frames, Vorbis comments, MP4 `meta`/`ilst`, Matroska `\Tags`, RIFF
`LIST/INFO`+`bext`, AIFF text chunks, CAF `info`), not signal processing.

It serves the `metadata` benchmark family (write_mkv_tags, write_wav_info_bext, write_aiff_tags,
write_caf_info, meta_consistent_mp4_to_mkv, and the FLAC/Ogg/MP3 tag-write cells). The engine surfaces
it as an option on `remux`/convert (`remux(src, { tags })`), where tags are applied **after** track
selection and target muxing so cross-container remux tags land on the *output* container, not the input
(`(measured-evidence.md)` — session12-remux-select-tags; `remux-metadata.ts` orchestrates it). Bit-exactness of
each rewrite is proven by the SHA-256 oracle in `src/util/digest.ts`
(`src/util/digest.ts:7`,`:13`,`:22`) — the family's goldens are pinned output digests, e.g. the
Matroska three-generation rewrite baked at SHA-256 `f613…298b` `(measured-evidence.md)`.

Adjacent concerns that are **out of scope** for this shard (owned elsewhere, cited here only for the
seam): container structural parsing/muxing (drivers S23–S29), the display **rotation matrix** in `tkhd`
(`src/util/rotation.ts`, S18 / `src/drivers/mp4/display-transform.ts`, S23), and Matroska `Colour`
metadata preservation (a driver stream-copy concern, `(measured-evidence.md)` — matroska-colour-preservation).
The tag writers here deliberately **preserve** those bytes untouched (§3, §4).

## 2. Spec & references

Governing standards (one per container tag dialect):

- **ID3v2.4** — tag structure and text/`COMM`/`TXXX`/`PRIV` frames:
  [id3v2.4.0-structure](https://id3.org/id3v2.4.0-structure) ·
  [id3v2.4.0-frames](https://id3.org/id3v2.4.0-frames). Synchsafe integers are §6.2 of the structure
  document.
- **Vorbis comment** — the `VENDOR`/`FIELD=value` UTF-8 model shared by FLAC and Ogg:
  [xiph.org/vorbis/doc/v-comment.html](https://www.xiph.org/vorbis/doc/v-comment.html).
- **FLAC format** — `fLaC` marker, metadata block headers, `VORBIS_COMMENT` (block type 4) and
  `STREAMINFO` (type 0): [xiph.org/flac/format.html](https://xiph.org/flac/format.html) ·
  [RFC 9639](https://www.rfc-editor.org/rfc/rfc9639.html).
- **Ogg** — page framing, lacing, CRC-32: [RFC 3533](https://www.rfc-editor.org/rfc/rfc3533). Opus
  `OpusHead`/`OpusTags` comment header: [RFC 7845 §5.2](https://www.rfc-editor.org/rfc/rfc7845#section-5.2).
- **MP4 / QuickTime iTunes-style metadata** — `meta`+`hdlr('mdir')`+`ilst`+`data`, the `©`-prefixed
  atoms and `----` freeform atoms: [ISO/IEC 14496-12 (ISO-BMFF)](https://www.iso.org/standard/83102.html)
  for `meta`/box structure, and Apple
  [QuickTime File Format — Metadata](https://developer.apple.com/documentation/quicktime-file-format/metadata)
  for the atom vocabulary. The 3×3 display matrix that must be preserved is the `tkhd` matrix in
  ISO/IEC 14496-12 §8.3.2.
- **Matroska Tags** — `\Tags\Tag\SimpleTag(TagName,TagString,TagLanguage,TagDefault)` and target
  scoping: [matroska.org/technical/tagging.html](https://www.matroska.org/technical/tagging.html) ·
  [RFC 9559](https://www.rfc-editor.org/rfc/rfc9559.html) (Matroska), atop
  [EBML — RFC 8794](https://www.rfc-editor.org/rfc/rfc8794.html).
- **RIFF/WAVE tags** — `LIST/INFO` chunks: [ExifTool RIFF tag names](https://exiftool.org/TagNames/RIFF.html);
  Broadcast-WAVE `bext` chunk: [EBU Tech 3285 (BWF)](https://tech.ebu.ch/docs/tech/tech3285.pdf).
- **AIFF/AIFF-C** — `NAME`/`AUTH`/`ANNO`/`(c) ` text chunks and the `ID3 ` chunk:
  [Audio Interchange File Format AIFF-1.3](https://www-mmsp.ece.mcgill.ca/Documents/AudioFormats/AIFF/AIFF.html).
- **Apple CAF** — `info` chunk, signed 64-bit big-endian chunk sizes, `-1` final-chunk size:
  [Core Audio Format Specification 1.0](https://developer.apple.com/library/archive/documentation/MusicAudio/Reference/CAFSpec/CAF_intro/CAF_intro.html).

**OSS exemplar — mediabunny metadata.** Repo: [github.com/Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny);
read seam `Input.getMetadataTags()`
([guide](https://mediabunny.dev/guide/reading-media-files)); write seam `Output.setMetadataTags(tags)`
([guide](https://mediabunny.dev/guide/writing-media-files)); the canonical
[`MetadataTags`](https://mediabunny.dev/api/MetadataTags) type. Mediabunny's shape is the SOTA target to
match/beat — a **typed structured model**, not a flat string map:

```
MetadataTags = {
  title?, description?, artist?, album?, albumArtist?: string;
  trackNumber?, tracksTotal?, discNumber?, discsTotal?: number;
  genre?, comment?, lyrics?: string; date?: Date;
  images?: AttachedImage[];        // { data: Uint8Array; mimeType: string; kind: 'coverFront' | … }
  raw?: Record<string, string | Uint8Array | RichImageData | AttachedFile | null>;
}
```
(field list per [mediabunny.dev/api/MetadataTags](https://mediabunny.dev/api/MetadataTags)). Note the
typed numerics/dates, the first-class **cover art** array, and the `raw` escape hatch that round-trips
container-specific tags mediabunny does not normalize. aibrush today ships only
`Readonly<Record<string,string>>` — the delta in §5 closes that gap.

## 3. Target design

### 3.1 Data model

One canonical typed model, `MediaTags`, replaces the flat `Record<string,string>`
(`tag-map.ts:3`). It mirrors mediabunny's shape: typed text fields, numeric `trackNumber`/`discNumber`,
`Date`, an `images: AttachedImage[]` cover-art array, and a `raw` map for container-specific tags the
normalizer does not understand. The flat string record is retained only as a **lossy convenience input**
that is up-converted at the boundary. Rationale: cover art (`APIC` / `METADATA_BLOCK_PICTURE` /
`covr` / Matroska attachments) and multi-valued fields are unrepresentable in a `string` value, and
numeric/date fields silently stringify today (e.g. `trkn` clamps `parseInt(value)` at `mp4-tags.ts:354`).

Three layers, strictly separated:

1. **Normalization (`tag-map.ts`)** — the container-agnostic vocabulary. `normalizePublicKey`
   folds aliases (`album_artist`→`albumArtist`) via `STANDARD_KEYS` (`tag-map.ts:10`,`:61`);
   `normalizeTags` sorts deterministically and rejects NUL bytes with a typed `MediaError('mux-error')`
   (`tag-map.ts:67`,`:72`-`:78`,`:81`); `vorbisKeyFor`/`publicKeyFromVorbis` bridge public keys and the
   uppercase Vorbis/`TagName` dialect (`tag-map.ts:85`,`:96`). This layer knows **no container format**.
2. **Per-container codec modules** — `id3`, `vorbis-comment` (FLAC), `ogg-vorbis-comment`, `mp4-tags`,
   `matroska-tags`, `pcm-tags` (WAV/AIFF/CAF). Each exposes a pure `write*(bytes, tags) → bytes` and a
   pure `read*(bytes) → tags`. No I/O, no async, deterministic.
3. **Cold dispatch (`metadata-rewrite.ts`)** — `rewriteMetadataTags(bytes, container, tags)` lazily
   `import()`s exactly the one writer needed and raises a typed `CapabilityError('capability-miss')` for
   any other container (`metadata-rewrite.ts:7`,`:32`). This keeps every tag dialect out of the eager
   bundle (the eager-budget guard is binding — `(measured-evidence.md)` session12-eager-budget-recovery). The
   target adds the **symmetric** `readMetadataTags(bytes, container)` dispatcher, which does not exist
   today (§5.1).

### 3.2 Seams

- **Public write seam:** `remux(src, { tags })` → `planRemuxMetadata` snapshots and validates the
  caller's tag record against a frozen plain-object allowlist *before* any source byte is read
  (`remux-metadata.ts:68`,`:81`), then muxes the target and calls the target-native writer.
- **Public read seam (target):** a probe-time `getTags()` that dispatches through
  `readMetadataTags`. Reads should be **bounded head/tail range reads** (like the metadata-light probe
  path — `(measured-evidence.md)` ADR-112, ADR-258's 8 KiB WebM window), never a whole-file materialization; the
  pure `read*` functions here operate on the already-fetched window.
- **MP4 performance tiers (not capability tiers):** for an *ordinary same-brand* MP4/MOV the writer
  skips the demux→mux round trip entirely by **relocating only `moov`** and patching `stco`/`co64`
  (ADR-274, `mp4-tags.ts:459`), or — for the default `Blob` output — composing a fresh `Blob` from
  immutable source slices plus one patched `moov`, never touching `mdat` (ADR-280,
  `remux-metadata.ts:188`). Measured: Blob-direct **1.860 ms** vs byte-direct 3.917 ms vs full-remux
  8.108 ms `(measured-evidence.md)`; direct MP4 tag write 0.558 ms vs public path 3.098 ms `(measured-evidence.md)`. Any
  structurally unsafe shape (fragmented, `mvex`/`iloc`/`saio`/external chunk refs, mixed pre/post-`moov`
  media, brand mismatch) declines to `undefined` and falls back to normal remux
  (`mp4-tags.ts:42`,`:51`,`:244`,`:288`).

### 3.3 Capability routing (WebCodecs → GPU → WASM)

**This family is 100% pure TypeScript byte surgery — there is no WebCodecs, GPU, or WASM tier, and
none should ever be introduced.** Metadata never decodes or encodes; it never constructs a
`VideoDecoder`/`AudioEncoder`. The only capability decision is *container support*: an unknown target
container is a loud typed `CapabilityError('capability-miss')` naming what was tried
(`metadata-rewrite.ts:32`; `remux-metadata.ts:73`) — never a silent no-op. The MP4 direct/Blob paths are
**performance tiers**, selected by structural predicates that return `undefined` (fall through), *not*
capability tiers. A developer never names a backend; they name a container on `remux`.

### 3.4 Edge cases

- **B-frames — N/A (by construction).** Tag rewrite never inspects coded picture types or reorders
  samples. The direct MP4 path preserves every `moov` child except `udta`
  (`mp4-tags.ts:404`-`:419`), so `stts`/`ctts`/`stss` sample timing (which encodes B-frame reorder) is
  bit-preserved; only `stco`/`co64` chunk *offsets* are shifted by the `moov` size delta
  (`mp4-tags.ts:421`-`:453`,`:514`).
- **VFR — N/A.** No frame timing is read or written. Variable frame duration lives in sample tables
  that the writers copy verbatim.
- **Seek — applies to the read path only.** Tag *reading* should exploit bounded seeks (head for
  ID3/`ftyp`+`moov`/Ogg headers/EBML head; tail for ID3v1/APE, `moov`-at-end MP4) rather than a linear
  whole-file scan; today the pure readers take a full buffer (§5). Tag *writing* is not a seek problem.
- **Cancel.** The pure `write*`/`read*` functions are synchronous and bounded (whole rewrite medians
  0.05–0.83 ms `(measured-evidence.md)`), so they run to completion; **cancellation is enforced at the async
  seam** — `remux-metadata.ts` checks `signal.aborted` before collecting, before importing the writer,
  and before returning (`remux-metadata.ts:121`,`:146`,`:157`,`:204`), throwing
  `MediaError('aborted')`. Target: keep writers pure/sync and fast; never add a cancellable long loop
  here.
- **Frame lifetime (`VideoFrame`/`AudioData` `close()`) — N/A.** This family constructs **zero**
  codec objects; there is nothing to `close()`. Reviewers can assert the metadata modules import no
  WebCodecs types.
- **Backpressure — the one real tension.** Tag writers require **random access** to the whole target,
  so the remux-with-tags path buffers the entire muxed output into one `Uint8Array` via `collect(...)`
  before rewriting (`remux-metadata.ts:126`; rationale `(measured-evidence.md)` session12-remux-select-tags),
  defeating streaming for tagged output. The target mitigations, in order: (a) MP4/MOV keep the
  copy-free `Blob` `moov`-relocation path that never materializes `mdat` (ADR-280,
  `remux-metadata.ts:188`); (b) other containers get a **two-region (head+tail) splice** so the
  untouched media payload is streamed/`Blob`-sliced rather than copied through JS; (c) where neither is
  possible, tagging is documented as an explicitly non-streaming, whole-file operation with a size
  ceiling consistent with the whole-output materialization guard `(measured-evidence.md)` (ADR-053).

## 4. Current state

`src/metadata/` is eight source modules plus the shared oracle helper `src/util/digest.ts`. It works
and is fast, but carries real smells.

**Shared layer.** `tag-map.ts` is the clean core: `MetadataTags = Readonly<Record<string,string>>`
(`tag-map.ts:3`), key maps (`tag-map.ts:10`,`:26`,`:38`), `normalizeTags` with deterministic sort and
NUL rejection (`tag-map.ts:67`), and byte helpers `u32le`/`readU32le`/`concatBytes`
(`tag-map.ts:115`-`:140`). Module-global `UTF8`/`UTF8_DECODER` (`tag-map.ts:50`-`:51`) are stateless
shared encoders — safe, not mutable cache.

**God-files / oversized modules.**
- `mp4-tags.ts` — 554 lines: box parsing, direct-rewrite qualification (`qualifyDirectLayout`
  `mp4-tags.ts:244`), chunk-offset validation/patching (`mp4-tags.ts:190`,`:421`), `ilst` build
  (`mp4-tags.ts:372`), *and* read (`mp4-tags.ts:519`) all in one file.
- `matroska-tags.ts` — 535 lines: EBML vint/element writers, an inline IEEE CRC-32
  (`matroska-tags.ts:201`), CRC validation/refresh (`matroska-tags.ts:214`,`:381`), offset-stable
  `Void`-padded in-place replacement (`writeMkvTags` `matroska-tags.ts:404`-`:499`), and read
  (`matroska-tags.ts:505`).
- `pcm-tags.ts` — 409 lines and a **layering smell**: it packs **three** container families (WAV RIFF,
  AIFF/AIFF-C IFF, CAF) into one module, each with its own chunk model
  (`pcm-tags.ts:249`,`:308`,`:379`). WAV/AIFF/CAF tag logic belongs closer to their drivers (S27), or at
  least in three files.

**Layering violations (metadata reaching *into* drivers).** Two tag modules import driver internals:
- `vorbis-comment.ts:2` imports `ascii`, `flacOffset` from `../drivers/flac/flac-sniff.ts`.
- `matroska-tags.ts:2` imports `readVint` from `../drivers/webm/ebml.ts`.
  Metadata is a cross-cutting concern; it should depend on a shared byte/EBML utility layer, not on a
  specific container driver's sniffer. This is an upward dependency from `metadata/` into `drivers/`.

**Duplicated helpers (no module-global mutable cache, but copy-paste sprawl).** `ascii`,
`readU32le`/`readU32be`, `writeU32le`/`writeU32be`, `u32le`, `fourcc`/`fourccBytes`, `concatBytes`, and
CRC tables are re-implemented across files instead of shared: `ascii` in
`id3.ts:34`, `ogg-vorbis-comment.ts:39`, `pcm-tags.ts:68`; local `u32le` in `ogg-vorbis-comment.ts:46`
duplicating `tag-map.ts:115`; local `concatLocal` in `ogg-vorbis-comment.ts:308` duplicating
`concatBytes` (`tag-map.ts:130`); `readU32`/`readU64`/`fourcc` re-declared in the consumer
`remux-metadata.ts:336`-`:363`. The Ogg CRC lookup table is a module-global immutable `Uint32Array` IIFE
(`ogg-vorbis-comment.ts:10`) while Matroska computes CRC bit-by-bit inline (`matroska-tags.ts:201`) — two
CRC implementations, neither shared.

**Reader/writer asymmetries and write-only output (correctness smells).**
- **ID3 `PRIV` is write-only dead output.** For a custom key `buildId3Payload` writes *both* a `TXXX`
  frame and a `PRIV` frame (`id3.ts:118`-`:121`), but `readMp3Id3Tags` reads `TXXX` and never `PRIV`
  (`id3.ts:199`-`:206`). The `PRIV` frame is emitted but unreadable by this engine — redundant bytes.
- **WAV `bext` is never read back.** `writeWavTags` emits a fixed 602-byte Broadcast-WAVE `bext`
  chunk (`pcm-tags.ts:223`,`:260`), but `readWavTags` reads only `LIST/INFO` and ignores `bext`
  entirely (`pcm-tags.ts:272`-`:291`). The `bext` write does not round-trip through the reader.
- **CAF keys bypass the Vorbis dialect.** `cafInfoBody` stores the normalized *public* key verbatim
  (`pcm-tags.ts:355`) and `readCafInfoBody` returns it verbatim without `publicKeyFromVorbis`
  (`pcm-tags.ts:373`), unlike every other container which maps through the uppercase dialect — an
  inconsistency in the canonical key surface.
- **ID3v1/APE not stripped.** `writeMp3Id3Tags` strips a leading ID3v2 tag only (`id3.ts:148`-`:151`);
  a trailing 128-byte ID3v1 `TAG` or APEv2 footer is left in place, so a re-read can surface stale tags.
- **Custom-key case is not preserved.** `vorbisKeyFor` uppercases and `publicKeyFromVorbis` lowercases
  unknown keys (`tag-map.ts:85`,`:96`), so `MyTag` round-trips as `mytag`. Standardized keys are fine;
  arbitrary keys lose case.

**Read dispatch is missing.** `metadata-rewrite.ts` dispatches **writes** by container
(`metadata-rewrite.ts:12`-`:37`); there is no symmetric read dispatcher — the `read*` functions exist
per module but nothing routes container→reader, so a public "get tags" seam must hand-wire eight
imports.

**`src/util/digest.ts` (owned here, unused by writers).** `sha256Hex`/`toHex`/`digestsEqual`
(`src/util/digest.ts:7`,`:13`,`:22`) is the **validation oracle helper**, not imported by any metadata
module; it powers the pinned output-digest goldens that prove each rewrite bit-exact (e.g. Matroska
`f613…298b`, semantic no-op `25dd20c3…` `(measured-evidence.md)`). It is fine as-is; it just sits in this shard
by inventory, not by call graph.

**Known harness boundary (not a product defect).** `metadata/write_mkv_tags` reports fewer tracks than
its golden in the *black-box* harness because the public invocation drops additive
`TrackInfo.containerSideData` (the JSON+JPEG attachments) before mux; the product preserves both
`AttachedFile` payloads through the real routes `(measured-evidence.md)` (session11/12 boundary audits). This is a
harness invocation seam, tracked in §6, not a bug in these modules.

## 5. Delta / punch-list (ordered)

1. **Add the symmetric read dispatcher.** Create `readMetadataTags(bytes, container)` in
   `metadata-rewrite.ts` that lazy-`import()`s the one `read*` and raises
   `CapabilityError('capability-miss')` for unknown containers, mirroring the write dispatch
   (`metadata-rewrite.ts:12`). **Acceptance:** unit test asserting `readMetadataTags(bytes, c)` equals
   the direct `read*(bytes)` for every `c ∈ {mp4,mov,webm,mkv,mp3,flac,ogg,wav,aiff,caf}`, and that an
   unsupported container throws `CapabilityError` with `code==='capability-miss'` and `detail.tried`.
2. **Kill ID3 `PRIV` write-only output OR make it read.** Either stop emitting `PRIV`
   (`id3.ts:120`) and rely on `TXXX`, or teach `readMp3Id3Tags` to decode `PRIV`. **Acceptance:**
   `readMp3Id3Tags(writeMp3Id3Tags(mp3, {custom:'v'}))` returns exactly one `custom→'v'`, and a
   byte-count assertion proves no unreadable frame is emitted (SHA-256 golden via
   `src/util/digest.ts:7`).
3. **Make WAV `bext` round-trip or drop it.** Either parse `bext` in `readWavTags`
   (`pcm-tags.ts:272`) into `description`/`artist`/`date`, or stop writing it (`pcm-tags.ts:260`).
   **Acceptance:** `readWavTags(writeWavTags(wav, tags))` recovers every field the writer persisted (no
   silently-dropped chunk), asserted field-by-field.
4. **Normalize CAF keys through the Vorbis dialect.** Route `cafInfoBody`/`readCafInfoBody`
   (`pcm-tags.ts:355`,`:373`) through `vorbisKeyFor`/`publicKeyFromVorbis` like the other containers.
   **Acceptance:** a cross-container test asserting the *same* public key surface out of
   `readCafTags`/`readWavTags`/`readMkvTags`/`readMp4Tags` for identical input tags.
5. **Strip trailing ID3v1/APE before writing ID3v2.** Extend `writeMp3Id3Tags` (`id3.ts:148`) to detect
   and remove a trailing 128-byte `TAG` and APEv2 footer so re-read is unambiguous. **Acceptance:** feed
   an MP3 with a stale ID3v1 `TAG`; assert `readMp3Id3Tags(output)` reflects only the new tags and the
   `TAG` bytes are gone (offset assertion + digest).
6. **Extract a shared byte/EBML utility layer; remove metadata→driver imports.** Move `ascii`,
   `readU32le/be`, `writeU32le/be`, `u32le`, `fourcc(Bytes)`, `concatBytes`, `readVint`, `flacOffset`,
   and one canonical CRC-32 into a shared util the metadata modules and drivers both import; delete the
   local copies (`id3.ts:34`, `ogg-vorbis-comment.ts:39`,`:46`,`:308`, `pcm-tags.ts:68`,
   `remux-metadata.ts:336`) and the upward imports (`vorbis-comment.ts:2`, `matroska-tags.ts:2`).
   **Acceptance:** `grep` proves no `from '../drivers/` import remains under `src/metadata/`; all tag
   round-trip tests stay green; the eager bundle does not grow (`(measured-evidence.md)` budget guard).
7. **Split `pcm-tags.ts` by container.** Break WAV / AIFF / CAF into three modules (or push each into
   its S27 driver), each lazy-imported by the read/write dispatchers. **Acceptance:** three files,
   unchanged public behavior, and dispatch imports exactly one per container; existing WAV/AIFF/CAF
   digests unchanged (write_wav_info_bext 0.254 ms, write_aiff_tags 0.252 ms, write_caf_info 0.053 ms
   remain the perf baseline `(measured-evidence.md)`).
8. **Adopt the typed `MediaTags` model (cover art + numerics + `date` + `raw`).** Introduce the
   mediabunny-shaped structured type ([MetadataTags](https://mediabunny.dev/api/MetadataTags)) as the
   canonical model, up-converting the flat `Record<string,string>` (`tag-map.ts:3`) at the boundary; add
   cover-art encode/decode (`APIC`/`covr`/`METADATA_BLOCK_PICTURE`/Matroska attached image) and typed
   `trackNumber`/`discNumber`/`date`. **Acceptance:** a fixture with JPEG cover art round-trips through
   MP4 `covr` and FLAC `METADATA_BLOCK_PICTURE` with the image bytes bit-identical (SHA-256 via
   `src/util/digest.ts:7`), and `trackNumber` survives as a number, not a stringified `parseInt`
   (`mp4-tags.ts:354`).
9. **Two-region (head+tail) splice for non-MP4 backpressure.** For FLAC/Ogg/WAV/AIFF/CAF, splice the
   rewritten header region against a `Blob`-sliced/streamed untouched media tail instead of collecting
   the whole output into one `Uint8Array` (`remux-metadata.ts:126`). **Acceptance:** a large-file tag
   write shows peak RSS bounded to header size + delta (not whole-file), measured like the MP4 Blob path
   (Blob-direct RSS +0.41 MiB vs full-remux `(measured-evidence.md)`); output digest unchanged.
10. **Preserve-and-prove the untouched byte oracle for every writer.** Bake, for each container, a
    strict "bytes-elsewhere-unchanged" oracle: rewrite tags, then assert every non-tag region is
    byte-identical to source (the whole-file digest changes only within the tag structure). This
    hardens the `(measured-evidence.md)` "bytes elsewhere unchanged" intent (session8-metadata-write) and guards
    the MP4 `tkhd` rotation matrix and Matroska `Colour` from accidental disturbance. **Acceptance:**
    per-container region-diff test proving only the tag structure (and, for MP4, `moov` size + shifted
    `stco`/`co64`) differs; all other bytes SHA-256-equal.

## 6. Open questions (→ `docs/decisions/`)

1. **Canonical tag model: flat vs typed.** Adopt mediabunny's typed `MetadataTags` (numerics, `Date`,
   `images`, `raw`) as the engine's canonical model, or keep the flat `Record<string,string>`
   (`tag-map.ts:3`) and treat cover art as out of scope? Decision gates delta #8. Recommendation: adopt
   typed; the flat map cannot represent cover art or multi-valued tags.
2. **Custom-key case preservation.** Standard keys map cleanly, but arbitrary keys round-trip
   lowercased (`tag-map.ts:85`,`:96`). Do we preserve original case (needs a case-carrying `raw` map) or
   document lossy folding as intended? Ties to `raw` in delta #8.
3. **`bext` and CAF key policy.** Should WAV keep writing a Broadcast-WAVE `bext` at all if we do not
   read it (delta #3), and should CAF join the Vorbis-dialect key surface (delta #4) or keep verbatim
   public keys for interoperability with Apple tools? Log the interop trade-off.
4. **ID3 tag stripping scope.** Which legacy MP3 side-tags do we strip before writing ID3v2.4 —
   ID3v1, ID3v1.1, APEv2, Lyrics3 — and do we ever *migrate* their values into the new tag rather than
   discarding (delta #5)?
5. **Backpressure ceiling for tagged output.** For containers without a head+tail splice (delta #9),
   what is the whole-file materialization ceiling for tagging, and does it inherit ADR-053's ~512 MiB
   guard `(measured-evidence.md)` or get its own?
6. **`write_mkv_tags` harness boundary.** The public black-box invocation drops additive
   `containerSideData` (attachments) so the golden sees fewer tracks `(measured-evidence.md)`; decide whether to
   fix the harness invocation seam or formally classify the cell, so the metadata family's aggregate is
   not penalized for a non-product defect.
