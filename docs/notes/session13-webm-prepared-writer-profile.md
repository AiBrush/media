# Session 13 prepared Matroska writer profile

The qualified baseline recorded `mux/swap_audio_video_with_opus_to_mkv` at 202.400 ms for aibrush-media
versus 53.115 ms for mediabunny, with both engines passing the exact duration/reference-reimport oracle.
The public product route already accepted complete multitrack packet arrays and selected
`muxPreparedWebmPacketStreams`; adding another array route would duplicate existing behavior.

Two exact-product controls locate the cost without inspecting the harness. The Bun control uses the selected
30-second H.264 and Opus payloads (900 + 501 packets) and requires byte identity between bare host chunks,
packet-owned byte views, and direct prepared views. Every path emits 30,906,411 bytes with SHA-256
`3d6916790939be115045c4d53442b22e40a2414b60a116bcf1fc5a4a1680ddb3`. Bare host extraction measures
3.902 ms median versus 1.825 ms for direct views: the complete double-copy penalty is only 2.077 ms, far
below the 149.285 ms public gap.

The Chromium control obtains real native encoded chunks through product MP4/Ogg demux, then compares
packet-owned and bare-native prepared mux. Warmup three plus nine measured samples gives 15.100 ms owned
versus 16.200 ms bare; avoiding host extraction is not a durable browser win on this shape. One measured
phase decomposition reports video demux/drain at 10.0/4.1 ms and audio demux/drain at 3.4/1.0 ms. Five fresh
complete source-bytes → demux → packet materialization → mux → Blob-readback operations measure 19.600 ms
median and reproduce the same output digest. That current product result is already 33.515 ms below the
recorded passing rival, but it is not a same-export black-box result and therefore does not close the row.

ADR-257 rejects a prepared-only payload union or second writer based on this evidence. Such a change would
touch Block ordering, lacing, codec-private data, B-frame/VFR timing, cancellation, and payload lifetime for
at most a two-millisecond local opportunity that disappears in native Chromium. The next honest action is to
build/vendor the stabilized current bundle and run the unchanged scenario, rotation on, warm `n>=5`, against
all passing rivals with qualified memory. If that fresh row remains slow, profiling must begin at the public
operation boundary with product instrumentation; fixture recognition, adapter/harness inspection, cached
answers, passthrough, and weakened re-import truth remain forbidden.
