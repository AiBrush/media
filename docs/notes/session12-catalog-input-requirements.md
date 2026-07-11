# Session 12 conversion input-requirement repair

## Finding

The latest completed Chromium export contained 57 `NA_ASSET` rows but only two `NA_ENGINE` rows. Public
catalog selection output showed that 51 conversion-family rows rejected every exact source because their
input requirements included the codec requested for the output. For example, an H.264-to-VP9 conversion
cannot require VP9 in its H.264 input.

## Repair boundary

`scripts/session12-catalog-input-requirements.mjs` repairs only `transcode/*`, `audio-dsp/*`, and explicit
conversion-performance rows. A row is eligible only when its exact catalog files carry nonempty video or
audio codec facts. Required codecs present in at least one input remain; required codecs absent from every
input are removed. Every involved exact source must match its catalog SHA-256 before the catalog is written.
The current repair changes 51 rows after validating 54 unique exact-source hashes.

The script skips baked and corrupt negative rows without codec facts. It does not read or change scenario,
selector, oracle, tolerance, runner, parser, or adapter implementation. It does not edit media, operations,
goldens, or product output. Writes are atomic and a second invocation is a no-op.

## Product inventory consequence

These 51 rows were unreachable conversions, not 51 missing aibrush implementations. The completed export's
only engine-declared gaps were HEVC Main10 output and two-pass bitrate. Main10 now has a real qualified codec
route through `hev1.2.4.L120.B0`; two-pass now has a real replay-backed implementation. The focused standalone
browser proof validates the two-pass output, while the public harness still reports both rows as `NA_ENGINE`
because `aibrush-media@dev` does not declare `depth:10bit-output` or `two-pass`. Repaired catalog reachability
and standalone product proof do not count as functional harness passes by themselves.
