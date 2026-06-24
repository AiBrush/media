# Derived test fixtures (committed)

Small, real-bytes artifacts derived from corpus/acceptance assets for a focused validation test, where
adding the full multi-hundred-MB source to the git-ignored `fixtures/media/` corpus would be wasteful.
These are **real bytes extracted verbatim** from the source files — never synthetic.

| File | Derived from | What | Provenance |
|---|---|---|---|
| `big_buck_bunny_1080p_h264.header.mov` | `big_buck_bunny_1080p_h264.mov` (725 MB) | verbatim `ftyp` + `moov` only (a valid probe input; probe reads no `mdat`) | Big Buck Bunny © Blender Foundation, [CC BY 3.0](https://peach.blender.org/about/); the harness asset under `../../../media-test/media-browser-test/fixtures/media/` |
| `h264_1080p_5s.header.mov` | `h264_1080p_5s.mov` (4.4 MB) | verbatim `ftyp` + `moov` only | harness asset under `../../../media-test/media-browser-test/fixtures/media/` |

Both carry a QuickTime (`qt  `) major brand and a `mp4a` audio entry: the bunny header is a **version 2**
sound sample description (5.1ch, f64 sample rate, `wave`-nested `esds`); the 5 s header is a **version 1**
entry (stereo, 16 extra bytes before the sub-boxes). They exercise `parse.ts` `parseAudioEntry` for the
v1/v2 QuickTime layouts (`audio-entry.test.ts`).

Expected metadata (the test's oracle) comes from the harness goldens, not a guess:
`media-browser-test/fixtures/golden/big_buck_bunny_1080p_h264.mov.meta.json` and `…/h264_1080p_5s.mov.meta.json`
→ audio `aac`, 48000 Hz, 6 and 2 channels respectively.

To regenerate, extract the first top-level `ftyp` and `moov` boxes from the source asset and concatenate
them (no re-encoding, no field edits).
