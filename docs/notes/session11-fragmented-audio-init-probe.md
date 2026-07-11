# Session 11 — bounded fragmented-audio MP4 probe

## Goal

Close the fresh `probe/longform_1h_audio` fixed-overhead loss without changing demux, fragment sample
recovery, or metadata semantics. The selected real rotation took 70.375 ms because metadata probe parsed a
complete 699-byte initialization `moov`, saw empty sample tables plus `mvex`, and then range-read the entire
65,765,571-byte file only to rediscover the positive duration already declared by `mvhd` and `mdhd`.

The four fair-corpus inputs are distinct real AAC/MP4 files:

| File | SHA-256 | Bytes | ffprobe presentation |
|---|---|---:|---:|
| `01.mp4` | `971828672090c51b609970760b7702bd637829202a86325ef93830db2220540d` | 65,765,571 | 4,063.584943 s, AAC 44.1 kHz stereo |
| `02.mp4` | `97020df9cb0c8cbc0fb52dae709160438b1232728a967907f1f269b75cb0ff45` | 58,145,485 | 3,592.753923 s, AAC 44.1 kHz stereo |
| `03.mp4` | `8fd38eb92852942c66d43109548745768c07e24614b76af78eac007cc72ddf56` | 59,301,639 | 3,664.178503 s, AAC 44.1 kHz stereo |
| `longform_1h_audio.m4a` | `74cf9cc3bd689083dc0da0b620e0bd99e29c6fd50891be324fa56f0068ae71ad` | 29,659,705 | 3,600.000000 s, AAC 48 kHz mono |

The three rotated DASH files have `ftyp` + a 699-byte `moov`, one `soun` track, `mvex`, completely empty
`stts/stsc/stco/stsz`, no `edts`, and equal positive movie/track duration. The canonical file is progressive
with a 675,922-byte `moov` and retains the pre-existing bounded-prefix path.

## Chosen approach

After the ordinary metadata parser has parsed a complete initialization `moov`, trust its positive duration
only when all of these independently checkable ISO-BMFF facts hold:

1. `mvex` is declared and the metadata parser says fragment timing would ordinarily be consulted.
2. There is at least one track, every track is audio, and there are no non-media tracks.
3. Every initial sample-table component is empty and `stsz` declares zero samples.
4. Movie and per-track timescales and durations are finite and positive; the movie duration equals the
   longest track duration within one tick of either clock.
5. No track carries an edit list. AAC gapless calculation uses the edit plus coded fragment ticks, so an edit
   always requires the existing fragment scan.

The fast path returns the same parsed `MovieMetadata`; it does not synthesize timing, inspect a filename,
cache a result, or alter `toProbeTracks`. Both faststart and tail-`moov` metadata branches use the same
predicate. Demux, packet-info, stream-copy, decode, trim, CENC, fragment sample recovery, and hybrid merging
are untouched.

## Rejected alternatives

- Parsing every `moof/trun` remains correct but repeats 58–66 MiB of I/O for a bounded metadata query.
- Trusting any positive `mvhd` alone would be unsafe for video fps, shorter/mismatched tracks, hybrid files,
  and edited/gapless audio.
- Using a complete prefix `sidx` could be valid, but the existing metadata prefix API does not separately
  prove and expose a complete index. Broadening that parser is unnecessary for these authoritative init
  durations.
- Caching parsed metadata or routing by the scenario/fixture name would overfit benchmark iterations.

## Edge cases and failure behavior

- Empty-table video and A/V files retain the whole-file scan because fps and presentation offsets come from
  fragment samples.
- Zero/non-finite duration retains the whole-file scan.
- Any edit list retains the whole-file scan, including AAC priming/padding.
- Hybrid `stbl + trun` files retain the whole-file scan even when their provisional init duration is
  positive.
- Multiple or non-media tracks, contradictory movie/track durations, malformed metadata, unknown boxes,
  B-frames, VFR, and fragment truncation all retain the existing behavior.
- Probe has no frame ownership, decoder, cancellation, or backpressure change; the existing abort checks
  remain before and after the driver call.

## Validation and benchmark

`fragmented-audio-init-probe.test.ts` is fail-first on the three rotations: a prefix-only source throws if
probe asks for payload-scale bytes, which the old path did. It validates all four real files against pinned
size/prefix hashes and ffprobe facts. Real/video, real-derived zero-duration audio, positive-duration edited
audio, and real hybrid AAC counterexamples assert an exact `[0,fileSize)` fallback request; a whole-source
control confirms edited gapless metadata still materializes correctly.

The focused benchmark is warmup 3 + median of 9 over all four range-backed files, with an independent RSS
pass and checksum sink. Fresh local result:

```text
median=0.500 ms for all four probes; rangeCalls=5; rangeBytes=807022;
maxEnd=675950; peakRSS+=0.02 MiB; checksum=901134169
```

The external Chromium cell must still be re-measured by the lead; this Node number establishes the bounded
algorithm and a repeatable regression guard, not a browser leaderboard claim.
