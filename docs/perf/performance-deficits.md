# Performance deficits — where rivals beat aibrush-media (Chromium)

> **Auto-generated** by `docs/perf/gen-deficits.mjs` from `stored-test-data-chromium-2026-07-01T08-33-45-588Z.json + chromium-2026-07-01T09-52-13-355Z.json + chromium-2026-07-01T09-57-08-951Z.json + chromium-2026-07-01T10-39-35-760Z.json + chromium-2026-07-01T10-40-26-545Z.json + chromium-2026-07-01T10-42-56-723Z.json + chromium-2026-07-01T10-43-44-532Z.json`
> (latest included export 2026-07-01T10:44:00.484Z). Re-run the generator against a
> fresher export to refresh. Do not hand-edit the tables.

We rank **#1 on correctness** (100% conformance). This file is the opposite view:
the **speed** gaps. A cell is a *deficit* iff, on Chromium, we and at least one
competitor **both PASS the identical golden oracle** (same work) and the
competitor's median wall-time is lower than ours. NA/FAIL cells and cells no
rival timed are excluded — so every row below is an honest, same-work loss.

## Headline

- **Contested scenarios** (we + ≥1 rival both timed & passing): **444**
- **Active deficits where a rival is faster than us: 314 (71%)**
- **ADR-backed parity exemptions:** 0
- **Raw faster-rival rows before exemptions:** 314 (71%)
- Severity split: **0 catastrophic** (≥100×) · **17 severe** (10–100×) · **86 moderate** (3–10×) · **211 minor** (<3×)

⚠️ **Caveat:** this export is **single-sample (`n=1`)** per cell — exact ratios are
noisy; the *direction* and the *tiering* are reliable. Re-measure multi-sample
before locking any specific number.

## Two root causes (this is the whole story)

**A. Eager, whole-file processing where rivals seek to the index/`moov`.**
The original Session 9 export exposed catastrophic whole-file scans on
`massive`/`huge` files; overlay exports in this header record which of those
have been closed. Remaining large-file rows should still be treated as index
routing work first: metadata/probe should seek to the header or index, and
packet-table scenarios should enumerate timeline facts without materializing
payload bytes. Any full-body read on these rows is a real speed loss.

**B. High fixed per-operation overhead.** On tiny inputs we are still 5–30×
slower even though the real work is microseconds — e.g. `mux/pcm_s16_to_wav`
(a header + copy): **us 110 ms** vs mediabunny 4 ms. A large constant (init /
WASM / WebCodecs config / worker spin-up / buffer copies with no reuse) dominates.
This explains the 211 "minor" losses smeared across *every* family.

Fixing **A** collapses the tail of the distribution; fixing **B** shifts the whole
curve left. Attack **A first** (algorithmic, few code paths, 100–1000× cells),
then **B** (profile the ~100 ms floor on a trivial op and amortize it).

## Deficits by family

| Family | # deficits | Worst slowdown |
|--------|-----------:|---------------:|
| transcode | 45 | 4× |
| probe | 44 | 17× |
| mux | 43 | 28× |
| decode-seek | 35 | 8× |
| demux | 33 | 16× |
| audio-dsp | 26 | 7× |
| trim | 23 | 24× |
| performance | 19 | 19× |
| remux | 19 | 7× |
| metadata | 16 | 8× |
| streaming-output | 8 | 3× |
| encryption | 3 | 1× |

## Tier 1 — Catastrophic (≥100× slower) — fix first

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|

## Tier 2 — Severe (10–100× slower)

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|
| 1 | `mux/pcm_s16_to_wav` | mux | 110.4 | mediabunny | 4.0 | 27.8× |
| 2 | `trim/audio_flac_seektable_copy` | trim | 167.4 | ffmpeg.wasm | 6.9 | 24.3× |
| 3 | `performance/size-ladder-extract-metadata-huge` | performance | 130.2 | mediabunny | 6.8 | 19.0× |
| 4 | `probe/perf-extract-metadata-huge` | probe | 118.5 | mediabunny | 7.0 | 16.8× |
| 5 | `probe/flac_seektable` | probe | 38.5 | remotion-media-parser | 2.3 | 16.8× |
| 6 | `demux/metamorphic_flac_seektable_invariance` | demux | 92.3 | mediabunny | 5.7 | 16.3× |
| 7 | `probe/flac_noseektable` | probe | 34.5 | remotion-media-parser | 2.1 | 16.1× |
| 8 | `mux/flac_to_mkv_audio` | mux | 109.5 | mediabunny | 7.0 | 15.7× |
| 9 | `trim/audio_flac_noseektable_copy` | trim | 157.1 | ffmpeg.wasm | 10.3 | 15.3× |
| 10 | `probe/huge_h264_1080p_600s` | probe | 124.4 | remotion-webcodecs | 8.2 | 15.2× |
| 11 | `mux/size_micro_1frame_to_mp4` | mux | 50.1 | mediabunny | 3.4 | 14.8× |
| 12 | `probe/opus` | probe | 47.4 | mediabunny | 3.2 | 14.8× |
| 13 | `demux/flac_seektable` | demux | 63.7 | mediabunny | 5.1 | 12.5× |
| 14 | `demux/flac_noseektable` | demux | 76.4 | ffmpeg.wasm | 6.7 | 11.4× |
| 15 | `demux/size_tiny_tiny_h264_360p_2s` | demux | 55.0 | mp4box | 4.8 | 11.3× |
| 16 | `demux/size_micro_micro_h264_1frame` | demux | 28.0 | mp4box | 2.5 | 11.3× |
| 17 | `mux/opus_to_webm_audio` | mux | 84.7 | mediabunny | 7.9 | 10.7× |

## Tier 3 — Moderate (3–10× slower)

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|
| 1 | `trim/h264_noop_full_range_idempotent` | trim | 799.3 | mediabunny | 80.2 | 10.0× |
| 2 | `performance/size-ladder-iterate-packets-tiny` | performance | 33.8 | mediabunny | 4.3 | 7.9× |
| 3 | `decode-seek/decode_size_micro_h264_1frame` | decode-seek | 38.5 | platform | 4.9 | 7.9× |
| 4 | `metadata/read_h264_1080p_30s` | metadata | 31.8 | remotion-media-parser | 4.1 | 7.8× |
| 5 | `decode-seek/decode_tiny_dims_2x2_h264` | decode-seek | 39.4 | platform | 5.0 | 7.8× |
| 6 | `metadata/tagedit_no_corrupt_audio_flac` | metadata | 45.6 | mediabunny | 5.9 | 7.7× |
| 7 | `demux/empty_audio_zero_packets` | demux | 19.2 | remotion-media-parser | 2.6 | 7.4× |
| 8 | `probe/h264_1080p_30s` | probe | 31.6 | mediabunny | 4.3 | 7.3× |
| 9 | `remux/flac_seektable_flac_to_ogg` | remux | 36.3 | ffmpeg.wasm | 5.0 | 7.3× |
| 10 | `audio-dsp/edge_longform_audio_probe` | audio-dsp | 17.5 | mediabunny | 2.5 | 7.0× |
| 11 | `metadata/read_flac_seektable` | metadata | 32.4 | remotion-webcodecs | 4.8 | 6.7× |
| 12 | `demux/opus` | demux | 35.5 | mediabunny | 5.5 | 6.5× |
| 13 | `probe/micro_audio_short` | probe | 15.0 | remotion-media-parser | 2.4 | 6.4× |
| 14 | `mux/opus_to_ogg` | mux | 65.5 | mediabunny | 10.4 | 6.3× |
| 15 | `audio-dsp/meta_idempotent_resample_same_rate` | audio-dsp | 33.3 | mediabunny | 5.3 | 6.3× |
| 16 | `probe/tiny_h264_360p_2s` | probe | 20.4 | mediabunny | 3.3 | 6.2× |
| 17 | `demux/h264_vfr` | demux | 44.5 | remotion-media-parser | 7.2 | 6.1× |
| 18 | `mux/size_tiny_360p_to_mp4` | mux | 84.4 | mp4box | 13.7 | 6.1× |
| 19 | `demux/h264_1080p_30s` | demux | 33.6 | web-demuxer | 5.5 | 6.1× |
| 20 | `probe/big_buck_bunny_1080p_h264` | probe | 28.9 | mediabunny | 4.8 | 6.1× |
| 21 | `decode-seek/decode_tiny_dims_1x1` | decode-seek | 24.7 | platform | 4.1 | 6.0× |
| 22 | `performance/size-ladder-extract-metadata-large` | performance | 34.0 | mediabunny | 5.8 | 5.9× |
| 23 | `probe/realworld_mdn_flower_webm` | probe | 25.4 | mediabunny | 4.3 | 5.9× |
| 24 | `demux/size_micro_micro_audio_short` | demux | 25.1 | mp4box | 4.4 | 5.7× |
| 25 | `remux/flac_seektable_flac_to_mkv` | remux | 43.2 | ffmpeg.wasm | 7.6 | 5.7× |
| 26 | `probe/h264_bframes_1080p` | probe | 16.2 | mediabunny | 2.9 | 5.7× |
| 27 | `probe/realworld_mdn_trex_mp3` | probe | 14.6 | mediabunny | 2.6 | 5.6× |
| 28 | `probe/large_h264_1080p_120s` | probe | 21.6 | mediabunny | 3.9 | 5.6× |
| 29 | `metadata/read_h264_multitrack` | metadata | 17.8 | remotion-media-parser | 3.4 | 5.3× |
| 30 | `probe/h264_vfr` | probe | 18.5 | mediabunny | 3.6 | 5.2× |
| 31 | `probe/longform_1h_audio` | probe | 25.6 | mediabunny | 4.9 | 5.2× |
| 32 | `mux/prop_vfr_mux_duration_mp4_to_mkv` | mux | 69.3 | mediabunny | 13.5 | 5.1× |
| 33 | `mux/size_micro_1frame_to_mkv` | mux | 48.1 | ffmpeg.wasm | 9.4 | 5.1× |
| 34 | `demux/aac_adts` | demux | 29.9 | mediabunny | 5.9 | 5.1× |
| 35 | `demux/realworld_mdn_flower_mp4` | demux | 35.3 | mp4box | 7.1 | 5.0× |
| 36 | `demux/realworld_mdn_trex_mp3` | demux | 16.6 | mediabunny | 3.3 | 5.0× |
| 37 | `probe/perf-extract-metadata-large` | probe | 18.1 | mediabunny | 3.6 | 5.0× |
| 38 | `audio-dsp/edge_gapless_aac_decode` | audio-dsp | 52.2 | mediabunny | 10.6 | 4.9× |
| 39 | `performance/metamorphic-vfr-iterate-packets` | performance | 22.2 | remotion-webcodecs | 4.6 | 4.8× |
| 40 | `probe/hevc_1080p_10s` | probe | 24.1 | mediabunny | 5.0 | 4.8× |
| 41 | `demux/wav_s24` | demux | 14.5 | mediabunny | 3.0 | 4.8× |
| 42 | `trim/audio_aac_adts_copy` | trim | 27.8 | ffmpeg.wasm | 6.0 | 4.6× |
| 43 | `probe/vp9_alpha` | probe | 13.6 | mediabunny | 3.0 | 4.5× |
| 44 | `mux/mp3_to_mp3` | mux | 33.6 | mediabunny | 7.5 | 4.5× |
| 45 | `trim/h264_multitrack_keyframe_aligned` | trim | 123.3 | ffmpeg.wasm | 27.8 | 4.4× |
| 46 | `performance/extract-metadata` | performance | 15.3 | remotion-media-parser | 3.5 | 4.4× |
| 47 | `metadata/read_opus` | metadata | 18.4 | ffmpeg.wasm | 4.3 | 4.3× |
| 48 | `transcode/aac_to_pcm_wav_extract` | transcode | 84.0 | ffmpeg.wasm | 19.6 | 4.3× |
| 49 | `metadata/tracks_attribution_multitrack` | metadata | 17.1 | remotion-media-parser | 4.0 | 4.2× |
| 50 | `probe/metamorphic-recorder-headerless-sane-duration` | probe | 14.6 | mediabunny | 3.5 | 4.2× |
| 51 | `probe/tiny_vp9_360p_2s` | probe | 13.3 | mediabunny | 3.2 | 4.1× |
| 52 | `mux/mp3_to_mp4_audio` | mux | 26.1 | mediabunny | 6.5 | 4.0× |
| 53 | `performance/op-sweep-demux` | performance | 30.7 | remotion-media-parser | 7.7 | 4.0× |
| 54 | `transcode/mp3_to_aac_mp4` | transcode | 341.2 | mediabunny | 85.7 | 4.0× |
| 55 | `mux/mp4_streaming_target` | mux | 264.9 | mediabunny | 66.8 | 4.0× |
| 56 | `mux/aac_to_adts` | mux | 28.8 | mediabunny | 7.4 | 3.9× |
| 57 | `performance/size-ladder-extract-metadata-medium` | performance | 14.0 | mediabunny | 3.7 | 3.8× |
| 58 | `performance/op-sweep-probe` | performance | 14.4 | mediabunny | 3.8 | 3.8× |
| 59 | `probe/mp3_xing` | probe | 11.2 | mediabunny | 3.0 | 3.8× |
| 60 | `remux/aac_adts_adts_to_ts` | remux | 27.2 | mediabunny | 7.3 | 3.7× |
| 61 | `probe/aac_adts` | probe | 15.3 | mediabunny | 4.2 | 3.6× |
| 62 | `metadata/read_mp3_xing` | metadata | 13.8 | remotion-webcodecs | 3.8 | 3.6× |
| 63 | `transcode/hdr10_to_sdr_tonemap` | transcode | 145.6 | ffmpeg.wasm | 40.9 | 3.6× |
| 64 | `demux/mp3_cbr_notoc` | demux | 18.0 | mediabunny | 5.1 | 3.5× |
| 65 | `remux/huge_h264_1080p_600s_mov_to_mp4` | remux | 1478.7 | remotion-webcodecs | 423.5 | 3.5× |
| 66 | `trim/h264_rotated_keyframe_aligned` | trim | 119.7 | ffmpeg.wasm | 34.4 | 3.5× |
| 67 | `mux/audio_only_aac_to_mp4` | mux | 26.9 | ffmpeg.wasm | 7.8 | 3.5× |
| 68 | `probe/micro_h264_1frame` | probe | 17.6 | mediabunny | 5.1 | 3.5× |
| 69 | `trim/mov_keyframe_aligned` | trim | 147.6 | ffmpeg.wasm | 42.7 | 3.5× |
| 70 | `mux/prop_h264_decode_mux_mp4_to_mp4` | mux | 326.2 | mediabunny | 95.5 | 3.4× |
| 71 | `trim/audio_wav_pcm_copy` | trim | 25.2 | mediabunny | 7.4 | 3.4× |
| 72 | `trim/h264_start_zero_copy` | trim | 134.2 | mediabunny | 39.6 | 3.4× |
| 73 | `transcode/opus_to_aac_mp4` | transcode | 323.6 | mediabunny | 96.8 | 3.3× |
| 74 | `performance/size-ladder-iterate-packets-medium` | performance | 43.6 | web-demuxer | 13.1 | 3.3× |
| 75 | `performance/size-ladder-extract-metadata-tiny` | performance | 14.8 | mediabunny | 4.5 | 3.3× |
| 76 | `probe/realworld_mdn_flower_mp4` | probe | 13.0 | mp4box | 4.0 | 3.3× |
| 77 | `metadata/read_no_tags_wav` | metadata | 14.1 | mediabunny | 4.4 | 3.2× |
| 78 | `decode-seek/decode_size_tiny_h264_360p` | decode-seek | 334.2 | ffmpeg.wasm | 105.9 | 3.2× |
| 79 | `transcode/wav_to_flac` | transcode | 127.4 | ffmpeg.wasm | 40.5 | 3.1× |
| 80 | `audio-dsp/edge_longform_audio_resample_16k` | audio-dsp | 12843.1 | ffmpeg.wasm | 4117.0 | 3.1× |
| 81 | `metadata/read_h264_1080p_5s` | metadata | 29.2 | mp4box | 9.4 | 3.1× |
| 82 | `demux/size_tiny_tiny_vp9_360p_2s` | demux | 30.1 | ffmpeg.wasm | 9.7 | 3.1× |
| 83 | `probe/recorder_headerless` | probe | 17.0 | mediabunny | 5.5 | 3.1× |
| 84 | `mux/drop_audio_track_subset_to_mp4` | mux | 122.3 | mediabunny | 40.2 | 3.0× |
| 85 | `mux/edge_bframes_decode_mux_mkv` | mux | 131.1 | mediabunny | 43.2 | 3.0× |
| 86 | `probe/av1_720p_5s` | probe | 20.9 | mediabunny | 6.9 | 3.0× |

## Tier 4 — Minor (<3× slower) — the long tail (mostly root-cause B)

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|
| 1 | `performance/metamorphic-vfr-probe-duration` | performance | 9.2 | mediabunny | 3.1 | 3.0× |
| 2 | `audio-dsp/pcm_s16be_to_s16le` | audio-dsp | 30.9 | ffmpeg.wasm | 10.3 | 3.0× |
| 3 | `streaming-output/buffer_massive_h264_mp4` | streaming-output | 19850.2 | ffmpeg.wasm | 6705.3 | 3.0× |
| 4 | `demux/wav_f32` | demux | 15.9 | mediabunny | 5.4 | 2.9× |
| 5 | `mux/edge_bframes_decode_mux_mp4` | mux | 159.5 | mediabunny | 54.7 | 2.9× |
| 6 | `trim/audio_opus_ogg_copy` | trim | 20.6 | mediabunny | 7.3 | 2.8× |
| 7 | `mux/video_a_plus_audio_b_to_mkv` | mux | 325.8 | mediabunny | 115.7 | 2.8× |
| 8 | `trim/audio_aiff_pcm_be_copy` | trim | 32.3 | ffmpeg.wasm | 11.5 | 2.8× |
| 9 | `mux/prop_av1_mux_duration_webm_to_mp4` | mux | 45.8 | mediabunny | 16.3 | 2.8× |
| 10 | `trim/large_h264_frame_accurate_throughput` | trim | 2059.2 | mediabunny | 738.2 | 2.8× |
| 11 | `demux/mp3_xing` | demux | 16.3 | mediabunny | 6.0 | 2.7× |
| 12 | `decode-seek/decode_vp9_alpha` | decode-seek | 524.5 | mediabunny | 195.6 | 2.7× |
| 13 | `probe/wav_s16` | probe | 6.8 | mediabunny | 2.6 | 2.7× |
| 14 | `probe/mp3_cbr_notoc` | probe | 10.9 | remotion-webcodecs | 4.1 | 2.6× |
| 15 | `mux/three_track_assembly_to_mkv` | mux | 318.8 | mediabunny | 121.7 | 2.6× |
| 16 | `probe/h264_rotated90` | probe | 14.3 | remotion-media-parser | 5.5 | 2.6× |
| 17 | `audio-dsp/pcm_s24_to_s16` | audio-dsp | 31.6 | ffmpeg.wasm | 12.2 | 2.6× |
| 18 | `transcode/aac_to_opus_webm` | transcode | 302.6 | remotion-webcodecs | 117.5 | 2.6× |
| 19 | `probe/hls_vod` | probe | 54.5 | mediabunny | 21.2 | 2.6× |
| 20 | `demux/wav_s16` | demux | 14.4 | mediabunny | 5.6 | 2.6× |
| 21 | `demux/h264_1080p_5s` | demux | 38.4 | mediabunny | 15.0 | 2.6× |
| 22 | `remux/micro_audio_short_mp4_to_adts` | remux | 29.9 | mediabunny | 11.7 | 2.5× |
| 23 | `probe/h264_4k_10s` | probe | 14.8 | mediabunny | 5.8 | 2.5× |
| 24 | `mux/mp4_fragmented_cmaf` | mux | 336.3 | mediabunny | 132.6 | 2.5× |
| 25 | `audio-dsp/pcm_s24be_to_s16le` | audio-dsp | 36.4 | ffmpeg.wasm | 14.6 | 2.5× |
| 26 | `audio-dsp/meta_roundtrip_endianness_s16` | audio-dsp | 25.1 | mediabunny | 10.1 | 2.5× |
| 27 | `transcode/wav_to_vorbis_ogg` | transcode | 159.7 | ffmpeg.wasm | 65.3 | 2.4× |
| 28 | `mux/mp4_progressive_buffer` | mux | 217.7 | mediabunny | 89.5 | 2.4× |
| 29 | `probe/wav_f32` | probe | 9.9 | mediabunny | 4.1 | 2.4× |
| 30 | `transcode/vp9_alpha_to_vp8_keepalpha` | transcode | 1327.1 | mediabunny | 551.9 | 2.4× |
| 31 | `performance/size-ladder-extract-metadata-large4k` | performance | 8.7 | remotion-media-parser | 3.6 | 2.4× |
| 32 | `probe/cenc_cbcs` | probe | 15.6 | mediabunny | 6.6 | 2.4× |
| 33 | `performance/iterate-video-packets` | performance | 23.9 | web-demuxer | 10.1 | 2.4× |
| 34 | `mux/av1_opus_to_mp4` | mux | 34.8 | mediabunny | 14.7 | 2.4× |
| 35 | `mux/h264_aac_to_mkv` | mux | 226.8 | mediabunny | 96.4 | 2.4× |
| 36 | `probe/empty-audio-wav` | probe | 6.6 | remotion-webcodecs | 2.8 | 2.3× |
| 37 | `probe/h264_1080p_5s` | probe | 19.2 | remotion-webcodecs | 8.2 | 2.3× |
| 38 | `mux/mp4_faststart_reserve` | mux | 253.6 | mediabunny | 108.9 | 2.3× |
| 39 | `demux/realworld_mdn_flower_webm` | demux | 14.2 | ffmpeg.wasm | 6.1 | 2.3× |
| 40 | `audio-dsp/resample_44k1_to_48k` | audio-dsp | 112.2 | ffmpeg.wasm | 49.4 | 2.3× |
| 41 | `transcode/h264_resize_4k_to_1080p` | transcode | 2469.5 | mediabunny | 1090.8 | 2.3× |
| 42 | `transcode/h264_rotate_normalize` | transcode | 931.8 | remotion-webcodecs | 413.4 | 2.3× |
| 43 | `mux/h264_aac_to_ts` | mux | 318.3 | mediabunny | 141.5 | 2.2× |
| 44 | `decode-seek/seek_past_eof` | decode-seek | 129.1 | mediabunny | 57.5 | 2.2× |
| 45 | `probe/wav_s24` | probe | 9.3 | remotion-webcodecs | 4.2 | 2.2× |
| 46 | `demux/h264_rotated90` | demux | 23.4 | mediabunny | 10.6 | 2.2× |
| 47 | `remux/opus_ogg_to_mkv` | remux | 16.7 | ffmpeg.wasm | 7.6 | 2.2× |
| 48 | `audio-dsp/pcm_s24_to_f32` | audio-dsp | 31.7 | ffmpeg.wasm | 14.5 | 2.2× |
| 49 | `audio-dsp/gain_half_f32` | audio-dsp | 34.3 | ffmpeg.wasm | 15.8 | 2.2× |
| 50 | `metadata/write_mp3_id3` | metadata | 11.5 | mediabunny | 5.3 | 2.2× |
| 51 | `mux/vorbis_to_ogg` | mux | 50.2 | ffmpeg.wasm | 23.5 | 2.1× |
| 52 | `audio-dsp/resample_48k_to_16k` | audio-dsp | 71.5 | remotion-webcodecs | 33.8 | 2.1× |
| 53 | `mux/edge_rotation_decode_mux_mov` | mux | 83.5 | mediabunny | 39.4 | 2.1× |
| 54 | `metadata/write_flac_vorbiscomment` | metadata | 11.9 | mediabunny | 5.7 | 2.1× |
| 55 | `decode-seek/seek_zero` | decode-seek | 67.8 | mediabunny | 33.4 | 2.0× |
| 56 | `mux/h264_aac_to_mov` | mux | 222.9 | mediabunny | 110.5 | 2.0× |
| 57 | `mux/size_large_1080p_to_mp4` | mux | 637.8 | mediabunny | 317.2 | 2.0× |
| 58 | `demux/pcm_s16be` | demux | 14.5 | ffmpeg.wasm | 7.2 | 2.0× |
| 59 | `mux/edge_rotation_decode_mux_mkv` | mux | 83.8 | mediabunny | 41.9 | 2.0× |
| 60 | `audio-dsp/caf_container_probe` | audio-dsp | 10.7 | ffmpeg.wasm | 5.3 | 2.0× |
| 61 | `demux/vp8_720p_10s` | demux | 19.7 | platform | 9.9 | 2.0× |
| 62 | `demux/vp9_alpha` | demux | 18.4 | platform | 9.3 | 2.0× |
| 63 | `demux/av1_720p_5s` | demux | 26.1 | ffmpeg.wasm | 13.2 | 2.0× |
| 64 | `metadata/read_no_tags_recorder_webm` | metadata | 10.5 | ffmpeg.wasm | 5.3 | 2.0× |
| 65 | `mux/swap_audio_video_with_opus_to_mkv` | mux | 365.0 | mediabunny | 185.2 | 2.0× |
| 66 | `remux/opus_ogg_to_webm` | remux | 17.8 | ffmpeg.wasm | 9.1 | 2.0× |
| 67 | `mux/prop_vfr_mux_duration_mp4_to_mp4` | mux | 47.2 | mediabunny | 24.2 | 1.9× |
| 68 | `audio-dsp/resample_48k_to_44k1` | audio-dsp | 69.5 | ffmpeg.wasm | 35.8 | 1.9× |
| 69 | `trim/vp9_noop_full_range_idempotent` | trim | 52.9 | mediabunny | 27.5 | 1.9× |
| 70 | `mux/edge_multitrack_keep_all_to_mp4` | mux | 77.6 | mediabunny | 40.3 | 1.9× |
| 71 | `mux/prop_h264_mux_duration_mp4_to_mkv` | mux | 239.1 | mediabunny | 125.1 | 1.9× |
| 72 | `probe/cenc_ctr` | probe | 17.4 | remotion-webcodecs | 9.2 | 1.9× |
| 73 | `remux/prop_mp3_to_mp4_duration_invariant` | remux | 12.5 | ffmpeg.wasm | 6.6 | 1.9× |
| 74 | `decode-seek/seek_repeated_same_target` | decode-seek | 70.0 | mediabunny | 37.4 | 1.9× |
| 75 | `transcode/mp3_to_opus_webm` | transcode | 242.2 | mediabunny | 131.5 | 1.8× |
| 76 | `audio-dsp/pcm_f32_to_s16` | audio-dsp | 28.8 | ffmpeg.wasm | 16.1 | 1.8× |
| 77 | `probe/vp8_720p_10s` | probe | 9.1 | ffmpeg.wasm | 5.2 | 1.8× |
| 78 | `audio-dsp/throughput_encode_s24` | audio-dsp | 36.0 | ffmpeg.wasm | 20.6 | 1.8× |
| 79 | `audio-dsp/upmix_stereo_to_5_1` | audio-dsp | 60.6 | ffmpeg.wasm | 34.7 | 1.7× |
| 80 | `probe/pcm_s16be` | probe | 10.8 | ffmpeg.wasm | 6.2 | 1.7× |
| 81 | `streaming-output/mp4_faststart_none_control` | streaming-output | 266.7 | ffmpeg.wasm | 155.0 | 1.7× |
| 82 | `probe/h264_in_mkv` | probe | 17.3 | mediabunny | 10.1 | 1.7× |
| 83 | `mux/prop_h264_mux_duration_mp4_to_ts` | mux | 319.1 | mediabunny | 186.0 | 1.7× |
| 84 | `demux/hls_vod` | demux | 110.4 | ffmpeg.wasm | 64.9 | 1.7× |
| 85 | `remux/aac_adts_adts_to_mp4` | remux | 13.2 | ffmpeg.wasm | 7.8 | 1.7× |
| 86 | `transcode/selfcheck_h264_resize_720p_tie` | transcode | 3297.4 | mediabunny | 1953.9 | 1.7× |
| 87 | `trim/audio_mp3_copy` | trim | 10.1 | mediabunny | 6.1 | 1.7× |
| 88 | `mux/pcm_f32_to_wav` | mux | 30.2 | mediabunny | 18.3 | 1.6× |
| 89 | `transcode/wav_to_aac_mp4` | transcode | 65.5 | mediabunny | 39.9 | 1.6× |
| 90 | `decode-seek/seek_hevc_keyframe` | decode-seek | 62.6 | mediabunny | 38.2 | 1.6× |
| 91 | `decode-seek/meta_seek_vs_linear_decode` | decode-seek | 70.1 | mediabunny | 42.8 | 1.6× |
| 92 | `audio-dsp/pcm_s16_to_f32` | audio-dsp | 50.1 | ffmpeg.wasm | 30.8 | 1.6× |
| 93 | `audio-dsp/pcm_s16le_to_s16be` | audio-dsp | 48.1 | ffmpeg.wasm | 29.6 | 1.6× |
| 94 | `transcode/wav_to_opus_ogg` | transcode | 75.3 | mediabunny | 46.5 | 1.6× |
| 95 | `remux/mp3_xing_mp3_to_mp4` | remux | 12.6 | ffmpeg.wasm | 7.9 | 1.6× |
| 96 | `transcode/gapless_pcm_to_aac_priming` | transcode | 57.6 | mediabunny | 36.3 | 1.6× |
| 97 | `demux/hevc_1080p_10s` | demux | 39.6 | mediabunny | 25.0 | 1.6× |
| 98 | `transcode/vp8_to_vp9_webm` | transcode | 136.8 | remotion-webcodecs | 87.0 | 1.6× |
| 99 | `transcode/h264_rotate_90_dimswap` | transcode | 3995.0 | mediabunny | 2558.6 | 1.6× |
| 100 | `metadata/write_ogg_vorbiscomment` | metadata | 13.0 | ffmpeg.wasm | 8.5 | 1.5× |
| 101 | `transcode/vp9_alpha_to_vp9_keepalpha` | transcode | 1627.3 | mediabunny | 1068.4 | 1.5× |
| 102 | `trim/h264_single_gop_frame_accurate` | trim | 244.3 | mediabunny | 162.3 | 1.5× |
| 103 | `transcode/h264_fps_15_to_30` | transcode | 1077.5 | mediabunny | 717.2 | 1.5× |
| 104 | `performance/op-sweep-transcode-webm` | performance | 2615.5 | mediabunny | 1757.7 | 1.5× |
| 105 | `transcode/ladder_tiny_vp9_360p_to_h264_180p` | transcode | 225.9 | mediabunny | 152.1 | 1.5× |
| 106 | `mux/video_plus_audio_to_mp4` | mux | 219.5 | mediabunny | 148.0 | 1.5× |
| 107 | `streaming-output/mp4_faststart_reserve` | streaming-output | 136.2 | mediabunny | 92.1 | 1.5× |
| 108 | `audio-dsp/upmix_mono_to_stereo` | audio-dsp | 40.3 | ffmpeg.wasm | 27.3 | 1.5× |
| 109 | `remux/vp8_720p_10s_webm_to_mkv` | remux | 19.2 | ffmpeg.wasm | 13.1 | 1.5× |
| 110 | `audio-dsp/downmix_stereo_to_mono` | audio-dsp | 32.7 | ffmpeg.wasm | 22.5 | 1.4× |
| 111 | `remux/prop_adts_to_mp4_duration_invariant` | remux | 9.6 | mediabunny | 6.7 | 1.4× |
| 112 | `remux/h264_1080p_30s_mp4_to_ts` | remux | 210.1 | ffmpeg.wasm | 146.0 | 1.4× |
| 113 | `performance/size-ladder-iterate-packets-large4k` | performance | 48.2 | mediabunny | 34.1 | 1.4× |
| 114 | `transcode/multitrack_select_default_audio` | transcode | 702.3 | remotion-webcodecs | 497.7 | 1.4× |
| 115 | `audio-dsp/gain_minus6db_s16` | audio-dsp | 36.0 | ffmpeg.wasm | 25.5 | 1.4× |
| 116 | `transcode/h264_rotate_270_dimswap` | transcode | 957.9 | mediabunny | 682.8 | 1.4× |
| 117 | `audio-dsp/throughput_decode_s24` | audio-dsp | 41.7 | mediabunny | 29.8 | 1.4× |
| 118 | `encryption/cenc_ctr_decrypt` | encryption | 42.4 | ffmpeg.wasm | 30.3 | 1.4× |
| 119 | `trim/fmp4_fragment_boundary_copy` | trim | 146.0 | ffmpeg.wasm | 105.0 | 1.4× |
| 120 | `probe/vp9_1080p_10s` | probe | 22.9 | remotion-webcodecs | 16.5 | 1.4× |
| 121 | `remux/av1_720p_5s_webm_to_mkv` | remux | 14.9 | mediabunny | 10.8 | 1.4× |
| 122 | `demux/h264_multitrack` | demux | 31.8 | mp4box | 23.1 | 1.4× |
| 123 | `transcode/h264_resize_720p` | transcode | 2464.1 | mediabunny | 1794.1 | 1.4× |
| 124 | `mux/prop_vp9_mux_duration_webm_to_webm` | mux | 61.6 | mediabunny | 45.2 | 1.4× |
| 125 | `demux/h264_ts` | demux | 76.9 | ffmpeg.wasm | 56.8 | 1.4× |
| 126 | `remux/h264_1080p_5s_mov_to_mp4` | remux | 48.7 | mp4box | 36.0 | 1.4× |
| 127 | `transcode/ladder_tiny_h264_360p_resize_180p` | transcode | 255.9 | mediabunny | 190.4 | 1.3× |
| 128 | `streaming-output/prop_faststart_reserve_duration_invariant` | streaming-output | 104.0 | mediabunny | 77.7 | 1.3× |
| 129 | `decode-seek/seek_h264_nonkeyframe` | decode-seek | 93.4 | mediabunny | 70.4 | 1.3× |
| 130 | `decode-seek/seek_av1_keyframe` | decode-seek | 30.8 | mediabunny | 23.2 | 1.3× |
| 131 | `trim/ts_keyframe_aligned` | trim | 109.4 | ffmpeg.wasm | 83.7 | 1.3× |
| 132 | `decode-seek/decode_extreme_fps_1` | decode-seek | 63.7 | web-demuxer | 48.9 | 1.3× |
| 133 | `probe/h264_ts` | probe | 40.4 | mediabunny | 31.0 | 1.3× |
| 134 | `probe/h264_multitrack` | probe | 17.1 | remotion-webcodecs | 13.1 | 1.3× |
| 135 | `decode-seek/decode_mov_h264` | decode-seek | 1318.5 | remotion-webcodecs | 1020.7 | 1.3× |
| 136 | `transcode/av_downmix_stereo_to_mono` | transcode | 3354.5 | mediabunny | 2598.1 | 1.3× |
| 137 | `transcode/h264_pad_letterbox_4x3_to_16x9` | transcode | 4071.1 | mediabunny | 3179.6 | 1.3× |
| 138 | `transcode/h264_to_ts` | transcode | 3435.0 | mediabunny | 2684.0 | 1.3× |
| 139 | `transcode/extreme_fps_240` | transcode | 21105.1 | mediabunny | 16590.0 | 1.3× |
| 140 | `audio-dsp/edge_variable_channel_count_downmix` | audio-dsp | 79.3 | ffmpeg.wasm | 62.5 | 1.3× |
| 141 | `remux/mp3_xing_mp3_to_mkv` | remux | 9.9 | mediabunny | 7.8 | 1.3× |
| 142 | `performance/seek-ms` | performance | 72.4 | mediabunny | 57.4 | 1.3× |
| 143 | `decode-seek/seek_negative` | decode-seek | 56.9 | mediabunny | 45.1 | 1.3× |
| 144 | `transcode/h264_bitrate_2mbps` | transcode | 2625.2 | remotion-webcodecs | 2092.7 | 1.3× |
| 145 | `transcode/metamorphic_resize_same_1080p_idempotent` | transcode | 3790.1 | mediabunny | 3055.8 | 1.2× |
| 146 | `performance/convert-longtasks` | performance | 2187.5 | mediabunny | 1764.5 | 1.2× |
| 147 | `decode-seek/decode_h264_10bit` | decode-seek | 627.7 | mediabunny | 509.3 | 1.2× |
| 148 | `probe/metamorphic-duration-across-containers` | probe | 30.9 | remotion-media-parser | 25.4 | 1.2× |
| 149 | `remux/prop_recorder_headerless_duration_materialized` | remux | 9.7 | ffmpeg.wasm | 8.0 | 1.2× |
| 150 | `streaming-output/prop_faststart_in_memory_duration_invariant` | streaming-output | 182.7 | ffmpeg.wasm | 150.9 | 1.2× |
| 151 | `streaming-output/prop_probe_dur_fragmented_shape` | streaming-output | 167.0 | mp4box | 138.2 | 1.2× |
| 152 | `transcode/h264_to_vp9_webm` | transcode | 5507.4 | mediabunny | 4571.6 | 1.2× |
| 153 | `mux/size_longform_audio_to_mp4` | mux | 741.6 | ffmpeg.wasm | 617.3 | 1.2× |
| 154 | `decode-seek/decode_bframes_reorder` | decode-seek | 1357.0 | platform | 1145.1 | 1.2× |
| 155 | `trim/h264_keyframe_aligned` | trim | 162.0 | ffmpeg.wasm | 136.7 | 1.2× |
| 156 | `decode-seek/decode_multitrack_select_video` | decode-seek | 363.1 | mediabunny | 307.1 | 1.2× |
| 157 | `trim/h264_to_eof_copy` | trim | 145.3 | ffmpeg.wasm | 123.7 | 1.2× |
| 158 | `transcode/ladder_large_h264_1080p_120s_resize_720p` | transcode | 8920.7 | mediabunny | 7618.8 | 1.2× |
| 159 | `decode-seek/meta_vfr_seek_lands_on_true_pts` | decode-seek | 54.7 | mediabunny | 46.9 | 1.2× |
| 160 | `decode-seek/decode_size_tiny_vp9_360p` | decode-seek | 137.4 | remotion-webcodecs | 117.8 | 1.2× |
| 161 | `remux/h264_multitrack_mp4_to_mkv` | remux | 45.6 | ffmpeg.wasm | 39.4 | 1.2× |
| 162 | `decode-seek/decode_extreme_fps_240` | decode-seek | 237.1 | web-demuxer | 205.7 | 1.2× |
| 163 | `transcode/fanout_h264_abr_ladder` | transcode | 9444.1 | mediabunny | 8194.4 | 1.2× |
| 164 | `decode-seek/decode_size_huge_h264_600s` | decode-seek | 1628.8 | web-demuxer | 1421.5 | 1.1× |
| 165 | `audio-dsp/throughput_decode_s16be` | audio-dsp | 41.1 | ffmpeg.wasm | 35.9 | 1.1× |
| 166 | `transcode/h264_crop_center` | transcode | 2266.6 | mediabunny | 1986.6 | 1.1× |
| 167 | `demux/h264_4k_10s` | demux | 31.6 | mediabunny | 27.8 | 1.1× |
| 168 | `transcode/ladder_large_vp9_1080p_120s_to_h264_720p` | transcode | 10836.1 | mediabunny | 9530.1 | 1.1× |
| 169 | `transcode/h264_rotate_180` | transcode | 3048.6 | mediabunny | 2684.5 | 1.1× |
| 170 | `streaming-output/mp4_fragmented_cmaf` | streaming-output | 174.8 | mp4box | 155.2 | 1.1× |
| 171 | `performance/convert-webm-resize-320x180` | performance | 1937.6 | mediabunny | 1735.0 | 1.1× |
| 172 | `decode-seek/decode_size_large_vp9_120s` | decode-seek | 1510.1 | mediabunny | 1359.6 | 1.1× |
| 173 | `transcode/h264_to_fragmented_mp4` | transcode | 4720.1 | mediabunny | 4274.2 | 1.1× |
| 174 | `mux/h264_aac_to_mp4` | mux | 190.8 | mediabunny | 172.8 | 1.1× |
| 175 | `metadata/read_pcm_s16be` | metadata | 12.1 | ffmpeg.wasm | 10.9 | 1.1× |
| 176 | `decode-seek/decode_vp8` | decode-seek | 291.7 | mediabunny | 264.3 | 1.1× |
| 177 | `transcode/hevc_to_vp9_webm` | transcode | 1718.7 | mediabunny | 1559.7 | 1.1× |
| 178 | `metadata/tracks_packet_attribution_multitrack` | metadata | 26.2 | mediabunny | 23.8 | 1.1× |
| 179 | `trim/vp8_keyframe_aligned` | trim | 16.6 | ffmpeg.wasm | 15.1 | 1.1× |
| 180 | `transcode/roundtrip_leg1_h264_to_vp9` | transcode | 4742.4 | mediabunny | 4323.2 | 1.1× |
| 181 | `decode-seek/seek_vfr_arbitrary` | decode-seek | 58.6 | platform | 53.5 | 1.1× |
| 182 | `audio-dsp/fade_in_out_f32` | audio-dsp | 34.4 | ffmpeg.wasm | 31.5 | 1.1× |
| 183 | `decode-seek/decode_vfr_timing` | decode-seek | 619.6 | mediabunny | 569.2 | 1.1× |
| 184 | `encryption/perf_cenc_ctr_decrypt_throughput` | encryption | 42.2 | ffmpeg.wasm | 39.0 | 1.1× |
| 185 | `mux/prop_vp9_decode_mux_webm_to_webm` | mux | 61.0 | mediabunny | 56.4 | 1.1× |
| 186 | `metadata/rotation_decode_read_h264_rotated90` | metadata | 132.4 | platform | 122.5 | 1.1× |
| 187 | `decode-seek/decode_rotated_display_matrix` | decode-seek | 368.5 | mediabunny | 341.3 | 1.1× |
| 188 | `decode-seek/decode_hevc` | decode-seek | 673.1 | platform | 625.2 | 1.1× |
| 189 | `decode-seek/decode_open_gop_first_frame` | decode-seek | 391.8 | remotion-webcodecs | 364.0 | 1.1× |
| 190 | `streaming-output/prop_decode_equals_buffer_shape` | streaming-output | 274.2 | ffmpeg.wasm | 255.4 | 1.1× |
| 191 | `decode-seek/seek_bframes_midgop` | decode-seek | 115.7 | platform | 108.1 | 1.1× |
| 192 | `transcode/roundtrip_leg2_vp9_to_h264` | transcode | 1062.1 | mediabunny | 993.2 | 1.1× |
| 193 | `demux/h264_in_mkv` | demux | 24.4 | mediabunny | 22.8 | 1.1× |
| 194 | `decode-seek/decode_size_large_h264_120s` | decode-seek | 1245.1 | mediabunny | 1170.3 | 1.1× |
| 195 | `mux/vp9_video_plus_opus_audio_to_webm` | mux | 100.9 | mediabunny | 94.9 | 1.1× |
| 196 | `decode-seek/decode_h264_first_frames` | decode-seek | 1398.3 | platform | 1316.6 | 1.1× |
| 197 | `decode-seek/seek_backward_then_forward` | decode-seek | 62.4 | mediabunny | 59.1 | 1.1× |
| 198 | `transcode/extreme_fps_1` | transcode | 866.3 | mediabunny | 821.7 | 1.1× |
| 199 | `demux/size_large_large_vp9_1080p_120s` | demux | 283.0 | ffmpeg.wasm | 268.5 | 1.1× |
| 200 | `trim/hevc_frame_accurate` | trim | 506.6 | mediabunny | 480.8 | 1.1× |
| 201 | `decode-seek/decode_av1` | decode-seek | 287.6 | mediabunny | 273.7 | 1.1× |
| 202 | `decode-seek/decode_vp9` | decode-seek | 642.7 | platform | 613.5 | 1.0× |
| 203 | `remux/prop_multitrack_survives_mp4_mkv` | remux | 40.3 | ffmpeg.wasm | 38.5 | 1.0× |
| 204 | `transcode/av1_to_vp9_webm` | transcode | 517.1 | mediabunny | 495.8 | 1.0× |
| 205 | `transcode/h264_to_mov` | transcode | 2705.8 | mediabunny | 2596.2 | 1.0× |
| 206 | `transcode/vp9_to_av1_webm` | transcode | 2811.1 | mediabunny | 2733.7 | 1.0× |
| 207 | `encryption/cenc_ctr_decrypt_eq_cleartext` | encryption | 27.4 | ffmpeg.wasm | 26.8 | 1.0× |
| 208 | `performance/decode-fps` | performance | 352.9 | web-demuxer | 346.4 | 1.0× |
| 209 | `transcode/av1_to_h264_mp4` | transcode | 312.1 | remotion-webcodecs | 307.8 | 1.0× |
| 210 | `trim/h264_open_gop_frame_accurate` | trim | 507.7 | mediabunny | 502.8 | 1.0× |
| 211 | `trim/hevc_keyframe_aligned` | trim | 43.4 | ffmpeg.wasm | 43.2 | 1.0× |

## ADR-backed parity exemptions

_No parity exemptions are currently recorded._
