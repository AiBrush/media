# Design note - QuickTime `.mov` track enumeration + pixel/colour truth

> ADR-185. Two real-world QuickTime/ISO-BMFF parser defects: (A) a real 600 s `.mov` enumerated 2 tracks
> vs ffprobe's 3, with the audio track mis-typed `other`/codec `''`; (B) real H.264 decoded to the wrong
> colours (SSIM ~0.85). Both are fixed in `src/drivers/mp4/parse.ts` + `codec-strings.ts`, validated
> against ffprobe 8.0 truth in `golden-metadata.test.ts`. Enumeration stays O(index) — no payload scan.

## Goal

- Enumerate **every declared `trak`**, in file order, matching ffprobe's `nb_streams` (which counts
  `data`/`tmcd` timecode streams). A non-AV handler is surfaced honestly, never dropped.
- Classify a QuickTime **sound sample description** (`stsd` entry) from its real fourcc + handler across
  description **versions 0/1/2**, finding the `esds` even when QuickTime nests it inside a `wave` atom.
- Expose the container **colour truth** (`colr`), **pixel aspect** (`pasp`), and **clean aperture**
  (`clap`) on the track, map `colr` into a WebCodecs `VideoColorSpaceInit`, and ride it on the
  `VideoDecoderConfig` the decoder consumes.

## Design

**Track routing.** `parseTrak` reads the `mdia/hdlr` component subtype first. `vide`/`soun` keep the
strict decode-grade parse; **any other (or unreadable) handler** becomes a lenient `OtherTrack` via
`parseOtherTrak` — id (`tkhd`), timing (`mdhd`), sample count (`stsz` count, else Σ `stts`), and the
`stsd` first-entry fourcc (== ffprobe `codec_tag_string`, e.g. `tmcd`). Every field degrades
independently through `attempt()`, so a malformed data trak can never break AV probing, and a header-only
file (no `mdat`) still enumerates — proving no sample payload is read.

**Sound descriptions (v0/v1/v2).** After the 8-byte preamble a sound entry carries a `version`. v0/v1
keep `channelcount`/`samplesize`/`sampleRate(16.16)` in the classic slots (v1 appends 16 bytes before the
sub-boxes). v2 overwrites them with constants (`always3`, `always65536`) and stores the real values in a
wider struct: `audioSampleRate` as `float64`, `numAudioChannels`, `constBitsPerChannel`,
`formatSpecificFlags` — sub-boxes start at `base+64`. The old v0-only parser mis-read v2 as
`channels=3`/`sampleRate=1` (the `always3`/`always65536>>16` constants), then failed to find the codec →
`audio:unknown`. `findAudioConfigBox` looks for the config box (`esds`/`dOps`/`enda`) as a direct child
**and** inside a `wave` wrapper, so QuickTime and Apple/ffmpeg `wave`-nested `esds` both resolve.

**QuickTime PCM.** Uncompressed sound fourccs classify to the engine's honest PCM tokens via
`qtPcmCodec` (`codec-strings.ts`), the same tokens WAV/AIFF/CAF use: `sowt`→`pcm-s16`, `twos`→`pcm-s16be`,
`raw `→`pcm-u8`, and the wide `in24`/`in32`/`fl32`/`fl64` default to big-endian unless a sibling `enda`
atom (value 1) flips them. `lpcm` (v2) derives everything from `constBitsPerChannel` +
`formatSpecificFlags`. A non-PCM/unrepresentable combination returns undefined (honest fourcc fallback),
never a wrong guess.

**Colour / geometry.** `parseVisualEntry` scans the sample entry's extension atoms after the codec box:
`colr` (nclc/nclx only — an ICC-profile `colr` has no code points, so it is ignored, not faked; `nclx`
appends the 1-byte `full_range_flag`, QuickTime `nclc` has none), `pasp`, and `clap` (QTFF: width/height
numerators unsigned, centre offsets signed). `videoColorSpaceFromColr` maps the H.273 code points
per-field (`h273Primaries`/`h273Transfer`/`h273Matrix`); an unmappable point is **omitted** so the
decoder applies its own default rather than a wrong value. The mapped `colorSpace` is set on the track
**and** mirrored onto `config.colorSpace` — and because the demux `TrackInfo` carries `config` through
untouched (`toTrackInfo` → `decodeConfigOf` → `normalizeVideoDecoderConfig` all spread the config), the
hint reaches `VideoDecoder.configure()` with no decode-path edit. This is the colour fix.

lib.dom's colour enums predate several H.273 tokens WebCodecs accepts (`bt2020`, `smpte432`, `pq`, `hlg`,
`bt2020-ncl`); those are asserted to their WebCodecs type at the one boundary that produces them, so
tokens already in lib.dom stay literal-checked and no `any` appears.

## Edge Cases

- A `moov` whose only trak is non-media still raises the `no decodable tracks` demux error.
- AV traks keep strict structure errors (a `vide` trak without `stbl` fails); only non-media traks are
  lenient.
- `nclc` carries no range flag → `fullRange` stays undefined; the parser must not invent one from the
  bitstream VUI (which is what ffprobe's `color_range` then reflects).
- Unknown/unspecified (code 2) colour points map to undefined exactly where ffprobe reports nothing.
- No `pasp` atom ⇒ track SAR is undefined; a non-square ffprobe SAR requires the atom to be present.
- Encrypted `enca`/`encv` entries parse the original format's config + extensions through the `frma`
  wrapper, so colour/PCM classification survives CENC signalling.

## Validation

- Independent-tool oracle: `fixtures/golden/metadata/qtff-mov-truth.json` pins ffprobe 8.0 output for 10
  real files (2 QuickTime-authored headers, 1 Apple `avconvert`, 6 `ffmpeg`, 1 OBS remux), baked by
  `scripts/bake-qtff-mov-goldens.ts`; the golden re-bakes byte-identically. Tests run **our** parser on the
  same committed bytes and match — never the reverse.
- Anti-overfit across ≥5 distinct `.mov`: v0/v1/v2 sound descriptions, `wave`-nested `esds`, `tmcd`
  timecode traks, BT.601-flagged and BT.709-partial and untagged colour, `nclx` full-range, and every QT
  PCM fourcc — each vs ffprobe per-stream type/codec/tag/colr/SAR and byte-exact `avcC` ↔ `extradata`.
- Can-fail: `golden-metadata.test.ts` tampers a copy (extra stream / wrong `colr`) and asserts rejection;
  `audio-entry.test.ts` asserts the v2 channels are genuinely 6, not the old-bug 3.
- Benchmark: `scripts/bench-qtff-mov-probe.ts` times `parseMovieMetadata` on the 395 KB Big Buck Bunny
  header (3 traks incl. `tmcd`); header-only input guarantees no `mdat` scan (O(index)).

## Addendum — fair-harness real-`.mov` regressions (ADR-185)

The first ADR-185 pass validated only crafted moovs + header-only fixtures, so three defects that live in the
*sample tables and edit lists* of the fair harness's real `.mov` files slipped through. Root-caused against
ffprobe 8.0 truth on the actual harness files (ffmpeg-authored variants of `h264_1080p_5s.mov` /
`huge_h264_1080p_600s.mov`):

**Signed version-0 `ctts` (decode/seek).** A real `.mov` B-frame reorder stores genuinely-*negative*
composition offsets (e.g. −40 ticks at ts 600, −100 at ts 2400) in a **version-0** `ctts`. ISO defines
version-0 offsets unsigned, but every real muxer/demuxer treats them signed — ffmpeg's mov *muxer* writes the
two's-complement value into a version-0 box, and its mov *demuxer* reads `avio_rb32` straight into a signed
`int`. Reading them unsigned turned −40 into 4294967256, exploding a 0.0667 s PTS to ~7.16e6 s; the
decode-seek oracle then selected the wrong frames (SSIM ~0.85, 0/12 digest-exact — the symptom mis-read as a
"colour" defect). `parseCtts` now reads the offset as **signed int32 regardless of version** (a legitimate
composition offset never nears 2³¹ ticks, so positive values are unaffected). After the fix our per-sample
PTS is byte-for-byte ffprobe's for `03.mov` (`0, 0.1333, 0.0667, …`) and `huge/01.mov` (`0, 0.0833, 0.0417,
…`). The container `colr`→`config.colorSpace` plumbing was already correct (`smpte170m`/`bt709` rides the
`VideoDecoderConfig` through `toTrackInfo`→`decodeConfigOf`→`normalizeVideoDecoderConfig`); colour was a red
herring — the PTS was the defect.

**Edit-list stream duration (probe).** ffprobe reports a stream's duration as the **edit-list presentation**
duration (segment_duration ÷ movie timescale), while `avg_frame_rate` stays frames ÷ **media** span. A real
variant presents 6.4667 s of a 9.4667 s media track (`mediaTime` = 3.0 s leading skip); ffprobe says 6.4667 s
but the media (mdhd) is 9.4667 s. The parser deliberately keeps `ParsedTrack.durationSec` = **media** duration
(lossless remux round-trips it; `fps = sampleCount / mediaDurationSec` = ffprobe `avg_frame_rate` = 20.49) and
exposes the presentation duration as **`edit.durationSec`** (already computed by `parseTrackEdit`, e.g.
6.466710 = exact ffprobe match, and 6.453696 for the paired audio). The container **`probe()`** path is the
one that must report ffprobe's stream duration, so it reads `edit?.durationSec ?? durationSec`; the demux /
round-trip / AAC-gapless paths keep the media `durationSec` untouched (so no muxer edit-preservation is
required and nothing regresses). Splitting the two roles is deliberate: `durationSec` is container-native
media time, `edit.durationSec` is presentation time.

**Non-media trak order (probe).** `parseOtherTrak` already enumerates the real `tmcd` timecode trak
(`otherTracks = [{handler:'tmcd', codec:'tmcd', trakIndex:1, …}]`, so AV + other = 3, matching ffprobe's
`nb_streams`). The gap is purely downstream: the demux `TrackInfo.mediaType` is `'video' | 'audio'` only, so
`probe()` must merge `otherTracks` into the reported list **in `trakIndex` order** and surface them as a
non-media (`'other'`) kind — the [video, tmcd(other), audio] order ffprobe lists.

## Non-goal

This does not resolve H.273 points WebCodecs cannot name (SMPTE-240M transfer/matrix, BT.2020-CL) — the
raw code points stay on `ColrInfo` for remux while `colorSpace` omits the field. ICC-profile `colr`,
gamma-only QuickTime colour, and live EME are out of scope.
