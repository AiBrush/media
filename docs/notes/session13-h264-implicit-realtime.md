# Session 13 implicit H.264 realtime encode

## Goal and measured root cause

Close the common native H.264 wall behind `transcode/h264_to_mkv` and `performance/encode-fps`
without changing the caller's codec/profile, configured bitrate, cadence, mux layout, explicit quality
controls, or frame ownership. A headed product-only profile of the real 321-frame H.264/AAC input
attributes essentially the whole operation to the native encoder: packet extraction costs 3.0-4.5 ms and
Matroska finalization plus Blob materialization costs 5.4-12.9 ms, while the encoder spans 1.59-2.26 s.

The routing support probe already accepts `prefer-hardware`, but forcing that accepted hint measures
2,298.9 ms versus 2,278.5 ms for the existing `no-preference` configuration. Hardware-hint caching is
therefore rejected. With only `latencyMode` changed, keeping the exact 18,432,000 bit/s configuration,
`quality` measures 2,259.5 ms and `realtime` measures 1,606.2 ms (`warmup=1`, alternating `n=7`): a
653.3 ms / 28.9% general native-encoder reduction.

## Design

Wholly implicit H.264 targets select WebCodecs `latencyMode:'realtime'`. Eligibility requires all four
caller quality/rate controls to be absent: `bitrate`, `bitrateMode`, `crf`, and `twoPass`. Any explicit
control retains `quality`. HEVC, VP8, VP9, unknown codecs, high-cadence AV1, and unknown-cadence AV1 retain
their existing policies; ordinary implicit AV1 retains its established realtime policy. The resolved
codec/profile, width/height, framerate, bitrate, bitrate mode, three-picture H.264 rate-controller preroll,
queue high-water mark eight, decoder route, filters, muxer, and sink are otherwise byte-for-byte the same
configuration and pipeline.

This policy is shape-based, not asset-based: no filename, digest, duration, resolution, frame count, source
bitrate, scenario, browser result, or threshold participates. Lowering the implicit bitrate in quality mode
is rejected because it changes two rate-control variables at once and weakens the established visual budget.

## B-frames, VFR, ownership, cancellation, and memory

`latencyMode` changes only the native encoder implementation policy. The input presentation timestamps and
durations remain the same, the real first frame remains forced key, and the muxer still derives decode order
from encoded callback arrival while carrying exact PTS/duration. Post-change browser proof must cover a real
B-frame source and a 377-frame VFR source with exact packet count, normalized PTS, duration, first-key, and
decoded-frame count. It must also cover the 900-frame 1080p/30 performance shape and an independent 82-frame
720p source.

Every source frame and all three disposable preroll clones retain the existing consume-and-close-exactly-once
`finally`. The A/B observes 324/324 submitted frames closed, zero pending frames, zero duplicate submissions,
and zero duplicate closes in both modes. Encoder/decode queues remain bounded below eight. Abort, downstream
cancel, encoder error, and mux failure continue through the unchanged stream teardown. Realtime produces a
smaller retained coded stream on the measured input (6,688,844 versus 27,468,322 bytes), so it does not buy
wall time by retaining more output memory; positive public browser memory remains a separate acceptance gate.

## Output truth and acceptance

Both A/B modes emit exactly 321 packets at 25 fps over 12.841667 seconds, start with a key packet, preserve
the normalized frame timestamp sequence, and decode every output frame through the public playback/decode
path. Twelve independently sampled decoded frames measure minimum SSIM 0.999708 in quality mode and 0.999346
in realtime mode. The `0.000362` delta is recorded rather than hidden; realtime remains well above the public
quality floor and preserves the stronger near-lossless result class.

Fail-first policy tests prove the narrow eligibility boundary. On the integrated post-change artifact, an
alternating 900-frame control measures realtime at 6,331.7 ms versus forced quality at 11,856.1 ms, a 46.6%
same-run native win. Both modes emit 900 packets over exactly 30 seconds, play through HTML media, close all
903 submitted frames once, and measure minimum sampled SSIM 0.999978/0.999976 respectively. This product
transcode is not the public `performance/encode-fps` operation despite sharing its real input, so its absolute
wall cannot replace the qualified public row.

The independent 82-frame 720p B-frame control emits every frame with exact cadence, plays through HTML,
closes all 85 submitted frames once, and measures minimum sampled SSIM 0.999869. The 377-frame VFR/B-frame
control emits and decodes all 377 frames, starts key, and preserves the complete normalized frame PTS sequence;
the stricter packet-row diagnostic reports the source's first declared duration as 16 ms and the re-encoded
timestamp-derived duration as 17 ms. A final alternating `n=7` comparison proves that projection is identical
in realtime and forced-quality modes, including every sorted packet PTS/duration row. Realtime measures
2,685.3 ms versus quality at 4,353.7 ms (38.3% faster); both play through HTML, close 380/380 submissions,
and measure minimum sampled SSIM 0.99999947. The source-to-output representation difference is recorded rather
than hidden and is not used as speed evidence. A fresh same-export public harness run remains authoritative
for wall leadership, memory, and PASS/FAIL truth. No local product number alone closes either ledger row.

## Rejected alternatives

- caching or forcing the accepted hardware hint (no measured win);
- raising the queue high-water mark above eight (previously regressed the shared native path);
- removing three quality-repair preroll frames;
- lowering bitrate, dropping/duplicating frames, changing cadence, or lying about framerate;
- parallel packet writes or a new mux writer for a 3-13 ms tail;
- applying realtime to explicit bitrate/bitrate-mode/CRF/two-pass contracts;
- fixture recognition, output caching, passthrough, or weakening SSIM/playback/timeline gates.
