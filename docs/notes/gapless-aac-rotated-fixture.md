# Rotated long HE-AAC gapless cell: product decode vs reported cell count

## Fresh failure

`audio-dsp/edge_gapless_aac_decode` reports the same truncated result for rotated `01.mp4`, `02.mp4`,
and `03.mp4`: 52,384 decoded samples at 48 kHz (1.091333 s) versus roughly 60.14 s. The baked
`gapless_aac.m4a` remains green at 48,623 samples, within one sample of its independent expected count.

## Independent fixture truth

The selected `03.mp4` checksum is
`402a6ad46ad4b817e77f3622953fcf3d7159bf6e8248e3df58363f5b45f1c2c7`. `ffprobe` identifies a valid
fragmented HE-AAC stereo track at 44.1 kHz, 60.139683 s, with 1,295 packets. The sibling rotations have
the same valid shape. There is no packet `skip_samples` side data and the MP4 demux track contains no
supported edit-list gapless window, so a product cannot infer an arbitrary priming cut from the container.

The independent aibrush fragment parser reconstructs all 1,295 packet ranges and the public
`createMedia().decode(bytes)` call, run in the explicitly requested in-app browser against the exact
selected fixture, drains:

- 1,295 `AudioData` frames;
- 2,652,160 samples;
- 44,100 Hz;
- natural end-of-stream with every frame closed by the consumer.

That is the complete coded timeline and agrees with the MP4 fragment durations (`1,295 × 2,048` output
samples). Temporary product-side diagnostics were then placed at all three possible live seams—MP4 packet
stream completion, native WebCodecs AAC completion, and WASM AAC start/completion—and removed after the
focused Chromium run. The cell still reported 52,384 samples but executed none of those observable seams.

## Conclusion

The 1.091333 s count is not produced by aibrush's MP4 fragment enumeration or public decode stream. Under
the binding black-box rule, the adapter/scenario implementation was not inspected. Changing the correct
decode stream to emit a fixture-specific 48 kHz duration, inventing absent priming metadata, or padding a
one-second prefix to 60 seconds would be fake and is rejected. The rotated fixtures need either a real
gapless edit/skip declaration plus a public decode invocation, or the cell boundary must consume the
complete stream that the product already returns.

## Fresh-port bundle confirmation (`01.mp4`)

The later fresh-port selection `01.mp4` has SHA-256
`7c301053c21373a27029feeb73cd8b982339449463509f8db931dc8e729540fd`. It is not a hybrid
`stbl`+`trun` movie: `stbl` is empty and the complete track is 1,295 `trun` samples. Current source parses
`hasFragments=true`, `fragmentSampleCount=1295`, `fragmentMediaTicks=2652160`; its public decode returns
1,295 frames / 2,652,160 samples at 44.1 kHz. The built MP4 chunk and vendored harness chunk are byte-for-
byte identical. Source and built public full-range accurate trim were exercised with `Uint8Array`, Blob,
File, and a range-capable URL; every path returned the original 367,594 bytes with the same SHA-256 and
re-decoded the complete timeline. Thus the fresh-port 52,384-at-48-kHz report is also outside the product
source/build/vendor boundary.
