# Session 13 AAC-to-Opus codec-phase staging rejection

The `transcode/aac_to_opus_webm` memory gap was attributed to overlapping native AAC decoder and Opus
encoder lifetimes. A general experiment staged only exact-duration, unchanged-geometry ADTS tracks whose
decoded f32-equivalent storage fit a 4 MiB cap. It drained and closed the decoder before configuring the
encoder, retained actual `AudioData` handles under the same cap, and fell back to ordinary streaming on
unexpected geometry or size.

A product-only Chromium A/B on the pinned 163,811-byte `aac_adts.aac` corpus rejected the design. The staged
and streaming paths were byte- and playback-identical: 128,350-byte WebM SHA-256
`f7723973eec2837b13e0fbce5ddcf9d4f8bcb1e83d4727fc4665adf96ad32fc0`; 502 Opus packets with payload
SHA-256 `110be036f9951f350b3418f192ee93ecbebbafccd0c0427a0f41de85e0fd8d74`; 502 decoded output frames,
481,296 sample frames, PCM SHA-256 `9d57b3d9977e094838c93a59981009738b01f9b18d69dcd6629ea255b91f6305`;
and every delivered frame closed exactly once. Instrumented lifecycle order proved 470/470 internal decoded
frames closed and `decoder:close` before `encoder:configure` only on the staged path.

Despite that invariance, staged warm wall was 56.37 ms median (MAD 2.69, n=9) versus streaming 46.64 ms
(MAD 0.335, n=9), a 20.9% regression. Precise JS-heap diagnostics also rejected it: median peak delta was
2,735,883 bytes staged versus 2,339,651 streaming (n=5); terminal absolute medians were effectively equal
at 2,305,620 and 2,305,652 bytes. Chromium exposed `measureUserAgentSpecificMemory` but rejected calls with
`SecurityError`, so native/UA memory is unavailable and was not coerced to zero. The staging code, tests,
benchmark command, and engine integration were removed; ordinary streaming remains the selected product
path.
