# Deficit worklist — rotated correctness, wall time, and peak memory

> **Auto-generated** by `docs/perf/gen-deficits.mjs` from 193 public result export(s).
> Newest export: `chromium-2026-07-11T18-29-37-500Z.json` (2026-07-11T18:29:39.282Z). Freshness window:
> 24 h. Same-work comparisons never combine engines from different exports.

## Measurement integrity

- Fresh exports used: `chromium-2026-07-10T19-49-46-246Z.json`, `chromium-2026-07-10T20-13-31-425Z.json`, `chromium-2026-07-10T20-48-47-717Z.json`, `chromium-2026-07-10T20-54-40-438Z.json`, `chromium-2026-07-10T20-55-11-634Z.json`, `chromium-2026-07-10T21-00-14-370Z.json`, `chromium-2026-07-10T21-02-11-401Z.json`, `chromium-2026-07-10T21-02-27-729Z.json`, `chromium-2026-07-10T21-02-57-779Z.json`, `chromium-2026-07-10T21-03-04-204Z.json`, `chromium-2026-07-10T21-03-08-736Z.json`, `chromium-2026-07-10T21-03-15-281Z.json`, `chromium-2026-07-10T21-06-49-841Z.json`, `chromium-2026-07-10T21-07-06-969Z.json`, `chromium-2026-07-10T21-12-56-281Z.json`, `chromium-2026-07-10T21-13-16-797Z.json`, `chromium-2026-07-10T21-13-35-161Z.json`, `chromium-2026-07-10T21-57-37-459Z.json`, `chromium-2026-07-10T22-37-45-942Z.json`, `chromium-2026-07-10T22-41-39-743Z.json`, `chromium-2026-07-10T23-19-52-428Z.json`, `chromium-2026-07-10T23-20-18-871Z.json`, `chromium-2026-07-10T23-20-46-282Z.json`, `chromium-2026-07-10T23-21-07-792Z.json`, `chromium-2026-07-10T23-22-34-796Z.json`, `chromium-2026-07-10T23-25-04-841Z.json`, `chromium-2026-07-11T00-22-57-847Z.json`, `chromium-2026-07-11T00-24-43-117Z.json`, `chromium-2026-07-11T00-28-57-939Z.json`, `chromium-2026-07-11T02-41-51-790Z.json`, `chromium-2026-07-11T02-43-00-871Z.json`, `chromium-2026-07-11T03-41-51-764Z.json`, `chromium-2026-07-11T03-45-12-796Z.json`, `chromium-2026-07-11T03-45-58-911Z.json`, `chromium-2026-07-11T03-48-04-202Z.json`, `chromium-2026-07-11T03-49-52-685Z.json`, `chromium-2026-07-11T03-50-53-058Z.json`, `chromium-2026-07-11T03-51-47-950Z.json`, `chromium-2026-07-11T03-52-55-162Z.json`, `chromium-2026-07-11T03-53-46-587Z.json`, `chromium-2026-07-11T03-54-37-378Z.json`, `chromium-2026-07-11T03-55-13-372Z.json`, `chromium-2026-07-11T03-56-05-656Z.json`, `chromium-2026-07-11T04-02-15-106Z.json`, `chromium-2026-07-11T04-02-46-223Z.json`, `chromium-2026-07-11T04-03-20-540Z.json`, `chromium-2026-07-11T04-03-59-062Z.json`, `chromium-2026-07-11T04-04-33-684Z.json`, `chromium-2026-07-11T04-05-09-499Z.json`, `chromium-2026-07-11T04-34-54-366Z.json`, `chromium-2026-07-11T04-39-10-727Z.json`, `chromium-2026-07-11T04-41-11-351Z.json`, `chromium-2026-07-11T04-41-41-517Z.json`, `chromium-2026-07-11T04-41-45-954Z.json`, `chromium-2026-07-11T04-41-50-308Z.json`, `chromium-2026-07-11T04-41-54-937Z.json`, `chromium-2026-07-11T04-41-59-164Z.json`, `chromium-2026-07-11T04-42-03-117Z.json`, `chromium-2026-07-11T04-42-07-151Z.json`, `chromium-2026-07-11T04-42-14-328Z.json`, `chromium-2026-07-11T04-43-07-191Z.json`, `chromium-2026-07-11T05-16-58-040Z.json`, `chromium-2026-07-11T05-17-28-517Z.json`, `chromium-2026-07-11T05-20-43-154Z.json`, `chromium-2026-07-11T05-21-02-809Z.json`, `chromium-2026-07-11T05-21-22-631Z.json`, `chromium-2026-07-11T05-31-24-206Z.json`, `chromium-2026-07-11T05-31-35-994Z.json`, `chromium-2026-07-11T05-48-16-130Z.json`, `chromium-2026-07-11T05-49-57-693Z.json`, `chromium-2026-07-11T05-51-13-075Z.json`, `chromium-2026-07-11T06-29-00-427Z.json`, `chromium-2026-07-11T06-42-56-308Z.json`, `chromium-2026-07-11T07-05-31-902Z.json`, `chromium-2026-07-11T07-07-12-144Z.json`, `chromium-2026-07-11T07-09-55-540Z.json`, `chromium-2026-07-11T07-35-30-582Z.json`, `chromium-2026-07-11T07-37-53-218Z.json`, `chromium-2026-07-11T07-40-46-094Z.json`, `chromium-2026-07-11T07-43-35-172Z.json`, `chromium-2026-07-11T10-56-07-595Z.json`, `chromium-2026-07-11T11-03-19-800Z.json`, `chromium-2026-07-11T11-06-29-495Z.json`, `chromium-2026-07-11T11-15-33-165Z.json`, `chromium-2026-07-11T11-16-06-165Z.json`, `chromium-2026-07-11T11-25-16-916Z.json`, `chromium-2026-07-11T11-42-17-493Z.json`, `chromium-2026-07-11T11-43-53-375Z.json`, `chromium-2026-07-11T11-44-46-076Z.json`, `chromium-2026-07-11T11-45-45-076Z.json`, `chromium-2026-07-11T12-00-36-980Z.json`, `chromium-2026-07-11T12-13-58-292Z.json`, `chromium-2026-07-11T12-20-43-098Z.json`, `chromium-2026-07-11T12-34-13-191Z.json`, `chromium-2026-07-11T12-39-26-341Z.json`, `chromium-2026-07-11T12-40-08-386Z.json`, `chromium-2026-07-11T12-41-17-105Z.json`, `chromium-2026-07-11T12-44-56-912Z.json`, `chromium-2026-07-11T12-47-39-048Z.json`, `chromium-2026-07-11T12-48-05-910Z.json`, `chromium-2026-07-11T12-50-04-884Z.json`, `chromium-2026-07-11T12-52-44-541Z.json`, `chromium-2026-07-11T13-00-07-322Z.json`, `chromium-2026-07-11T13-00-12-283Z.json`, `chromium-2026-07-11T13-00-17-258Z.json`, `chromium-2026-07-11T13-01-24-785Z.json`, `chromium-2026-07-11T13-05-28-005Z.json`, `chromium-2026-07-11T13-05-50-451Z.json`, `chromium-2026-07-11T13-06-19-121Z.json`, `chromium-2026-07-11T13-11-59-846Z.json`, `chromium-2026-07-11T13-15-53-910Z.json`, `chromium-2026-07-11T13-26-10-276Z.json`, `chromium-2026-07-11T13-26-41-391Z.json`, `chromium-2026-07-11T13-29-41-633Z.json`, `chromium-2026-07-11T13-34-58-547Z.json`, `chromium-2026-07-11T13-35-13-842Z.json`, `chromium-2026-07-11T13-35-21-607Z.json`, `chromium-2026-07-11T13-35-31-238Z.json`, `chromium-2026-07-11T13-35-38-208Z.json`, `chromium-2026-07-11T13-35-48-126Z.json`, `chromium-2026-07-11T13-39-38-414Z.json`, `chromium-2026-07-11T13-40-16-250Z.json`, `chromium-2026-07-11T13-40-55-480Z.json`, `chromium-2026-07-11T13-41-42-889Z.json`, `chromium-2026-07-11T13-47-01-823Z.json`, `chromium-2026-07-11T13-51-29-064Z.json`, `chromium-2026-07-11T13-51-56-295Z.json`, `chromium-2026-07-11T13-52-10-271Z.json`, `chromium-2026-07-11T13-52-27-974Z.json`, `chromium-2026-07-11T13-53-22-571Z.json`, `chromium-2026-07-11T13-53-32-325Z.json`, `chromium-2026-07-11T13-53-40-171Z.json`, `chromium-2026-07-11T13-53-48-544Z.json`, `chromium-2026-07-11T13-54-08-716Z.json`, `chromium-2026-07-11T13-54-15-487Z.json`, `chromium-2026-07-11T13-54-23-943Z.json`, `chromium-2026-07-11T13-54-30-833Z.json`, `chromium-2026-07-11T13-56-09-688Z.json`, `chromium-2026-07-11T13-56-37-470Z.json`, `chromium-2026-07-11T13-57-04-427Z.json`, `chromium-2026-07-11T13-57-34-076Z.json`, `chromium-2026-07-11T14-03-00-682Z.json`, `chromium-2026-07-11T14-03-13-055Z.json`, `chromium-2026-07-11T14-03-24-914Z.json`, `chromium-2026-07-11T14-04-05-785Z.json`, `chromium-2026-07-11T14-04-17-166Z.json`, `chromium-2026-07-11T14-04-29-618Z.json`, `chromium-2026-07-11T14-04-42-228Z.json`, `chromium-2026-07-11T14-05-19-316Z.json`, `chromium-2026-07-11T14-05-32-001Z.json`, `chromium-2026-07-11T14-05-42-667Z.json`, `chromium-2026-07-11T14-05-53-926Z.json`, `chromium-2026-07-11T14-06-17-220Z.json`, `chromium-2026-07-11T14-06-25-932Z.json`, `chromium-2026-07-11T14-06-34-803Z.json`, `chromium-2026-07-11T14-06-43-640Z.json`, `chromium-2026-07-11T14-11-41-575Z.json`, `chromium-2026-07-11T14-55-07-785Z.json`, `chromium-2026-07-11T14-55-47-618Z.json`, `chromium-2026-07-11T15-30-31-366Z.json`, `chromium-2026-07-11T15-31-37-866Z.json`, `chromium-2026-07-11T15-32-00-752Z.json`, `chromium-2026-07-11T15-32-21-074Z.json`, `chromium-2026-07-11T15-32-45-336Z.json`, `chromium-2026-07-11T15-33-12-072Z.json`, `chromium-2026-07-11T15-33-35-057Z.json`, `chromium-2026-07-11T15-33-55-431Z.json`, `chromium-2026-07-11T17-03-47-498Z.json`, `chromium-2026-07-11T17-07-33-807Z.json`, `chromium-2026-07-11T17-09-27-679Z.json`, `chromium-2026-07-11T17-27-14-120Z.json`, `chromium-2026-07-11T17-27-27-588Z.json`, `chromium-2026-07-11T17-27-47-772Z.json`, `chromium-2026-07-11T17-28-29-230Z.json`, `chromium-2026-07-11T17-28-52-863Z.json`, `chromium-2026-07-11T17-30-17-570Z.json`, `chromium-2026-07-11T17-39-27-944Z.json`, `chromium-2026-07-11T17-47-01-583Z.json`, `chromium-2026-07-11T17-47-26-560Z.json`, `chromium-2026-07-11T17-47-42-602Z.json`, `chromium-2026-07-11T17-55-45-690Z.json`, `chromium-2026-07-11T18-04-54-256Z.json`, `chromium-2026-07-11T18-05-15-884Z.json`, `chromium-2026-07-11T18-05-49-370Z.json`, `chromium-2026-07-11T18-12-21-940Z.json`, `chromium-2026-07-11T18-15-02-994Z.json`, `chromium-2026-07-11T18-16-33-517Z.json`, `chromium-2026-07-11T18-26-02-864Z.json`, `chromium-2026-07-11T18-29-37-500Z.json`, `firefox-2026-07-11T14-11-01-338Z.json`, `firefox-2026-07-11T17-10-07-090Z.json`, `webkit-2026-07-11T14-10-58-627Z.json`, `webkit-2026-07-11T17-10-04-545Z.json`
- Stale exports excluded from current cells: _none_
- Required samples per timed participant: **n≥5**, with warmup ≥1
- Correctness rotation gaps: **176**
- Timed rotation gaps: **1**
- Under-sampled timed participants: **0**
- Fresh same-export rival wall evidence: **present**

### Missing correctness rotations

| Scenario | Family | Measured | Required |
|----------|--------|---------:|---------:|
| `audio-dsp/caf_container_probe` | audio-dsp | 3 | 4 |
| `audio-dsp/downmix_5_1_to_stereo` | audio-dsp | 3 | 4 |
| `audio-dsp/downmix_stereo_to_mono` | audio-dsp | 3 | 4 |
| `audio-dsp/edge_gapless_aac_decode` | audio-dsp | 1 | 2 |
| `audio-dsp/edge_gapless_aac_decode` | audio-dsp | 1 | 2 |
| `audio-dsp/edge_longform_audio_resample_16k` | audio-dsp | 3 | 4 |
| `audio-dsp/fade_in_out_f32` | audio-dsp | 3 | 4 |
| `audio-dsp/gain_half_f32` | audio-dsp | 2 | 4 |
| `audio-dsp/gain_minus6db_s16` | audio-dsp | 3 | 4 |
| `audio-dsp/negative_image_into_audio_transcode` | audio-dsp | 3 | 4 |
| `audio-dsp/resample_44k1_to_48k` | audio-dsp | 2 | 4 |
| `audio-dsp/resample_48k_to_44k1` | audio-dsp | 2 | 4 |
| `audio-dsp/throughput_decode_s16be` | audio-dsp | 3 | 4 |
| `decode-seek/decode_av1` | decode-seek | 3 | 4 |
| `decode-seek/decode_bframes_reorder` | decode-seek | 3 | 4 |
| `decode-seek/decode_h264_4k` | decode-seek | 3 | 4 |
| `decode-seek/decode_h264_first_frames` | decode-seek | 1 | 4 |
| `decode-seek/decode_h264_first_frames` | decode-seek | 1 | 4 |
| `decode-seek/decode_hevc` | decode-seek | 3 | 4 |
| `decode-seek/decode_image_jpeg` | decode-seek | 3 | 4 |
| `decode-seek/decode_image_webp` | decode-seek | 2 | 4 |
| `decode-seek/decode_mkv_h264` | decode-seek | 3 | 4 |
| `decode-seek/decode_mov_h264` | decode-seek | 3 | 4 |
| `decode-seek/decode_size_tiny_h264_360p` | decode-seek | 2 | 4 |
| `decode-seek/decode_size_tiny_vp9_360p` | decode-seek | 3 | 4 |
| `decode-seek/decode_vp8` | decode-seek | 3 | 4 |
| `decode-seek/meta_decode_remux_eq_decode_anchored` | decode-seek | 3 | 4 |
| `decode-seek/meta_pts_monotonic_after_reorder` | decode-seek | 2 | 4 |
| `demux/av1_720p_5s` | demux | 3 | 4 |
| `demux/flac_noseektable` | demux | 3 | 4 |
| `demux/flac_seektable` | demux | 3 | 4 |
| `demux/graceful_webm_header_destroyed` | demux | 3 | 4 |
| `demux/h264_1080p_5s` | demux | 3 | 4 |
| `demux/h264_multitrack` | demux | 3 | 4 |
| `demux/h264_rotated90` | demux | 3 | 4 |
| `demux/mp3_cbr_notoc` | demux | 3 | 4 |
| `demux/mp3_xing` | demux | 3 | 4 |
| `demux/realworld_mdn_flower_mp4` | demux | 3 | 4 |
| `demux/realworld_mdn_trex_mp3` | demux | 3 | 4 |
| `demux/size_huge_huge_h264_1080p_600s` | demux | 3 | 4 |
| `demux/size_large_large_vp9_1080p_120s` | demux | 3 | 4 |
| `demux/size_micro_micro_audio_short` | demux | 3 | 4 |
| `demux/size_tiny_tiny_vp9_360p_2s` | demux | 3 | 4 |
| `demux/vp8_720p_10s` | demux | 3 | 4 |
| `demux/wav_f32` | demux | 3 | 4 |
| `demux/wav_s16` | demux | 3 | 4 |
| `demux/wav_s24` | demux | 3 | 4 |
| `encryption/perf_cenc_ctr_decrypt_throughput` | encryption | 3 | 4 |
| `encryption/unencrypted_left_untouched_noop` | encryption | 3 | 4 |
| `metadata/meta_consistent_mp4_to_mkv` | metadata | 2 | 4 |
| `metadata/neg_garbled_id3_mp3_probe` | metadata | 3 | 4 |
| `metadata/neg_garbled_ilst_mp4_probe` | metadata | 3 | 4 |
| `metadata/read_h264_1080p_5s` | metadata | 3 | 4 |
| `metadata/read_opus` | metadata | 3 | 4 |
| `metadata/read_pcm_s16be` | metadata | 3 | 4 |
| `metadata/tagedit_no_corrupt_audio_flac` | metadata | 3 | 4 |
| `metadata/tracks_packet_attribution_multitrack` | metadata | 3 | 4 |
| `metadata/write_mkv_tags` | metadata | 1 | 4 |
| `metadata/write_mkv_tags` | metadata | 1 | 4 |
| `metadata/write_mp3_id3` | metadata | 3 | 4 |
| `mux/aac_to_adts` | mux | 3 | 4 |
| `mux/audio_only_aac_to_mp4` | mux | 1 | 4 |
| `mux/audio_only_aac_to_mp4` | mux | 1 | 4 |
| `mux/av1_opus_to_mp4` | mux | 3 | 4 |
| `mux/edge_bframes_decode_mux_mp4` | mux | 3 | 4 |
| `mux/edge_multitrack_keep_all_to_mp4` | mux | 2 | 4 |
| `mux/flac_to_mkv_audio` | mux | 3 | 4 |
| `mux/mp3_to_mp3` | mux | 3 | 4 |
| `mux/mp3_to_mp4_audio` | mux | 3 | 4 |
| `mux/mp4_faststart_reserve` | mux | 3 | 4 |
| `mux/mp4_progressive_buffer` | mux | 3 | 4 |
| `mux/mp4_streaming_target` | mux | 3 | 4 |
| `mux/neg_h264_into_ogg_illegal` | mux | 3 | 4 |
| `mux/neg_vp9_into_adts_illegal` | mux | 2 | 4 |
| `mux/pcm_s24_to_wav` | mux | 3 | 4 |
| `mux/prop_h264_mux_duration_mp4_to_ts` | mux | 3 | 4 |
| `mux/prop_vfr_mux_duration_mp4_to_mkv` | mux | 3 | 4 |
| `mux/prop_vfr_mux_duration_mp4_to_mp4` | mux | 3 | 4 |
| `mux/prop_vp9_mux_duration_webm_to_webm` | mux | 3 | 4 |
| `mux/size_large_1080p_to_mp4` | mux | 3 | 4 |
| `mux/size_tiny_360p_to_mp4` | mux | 2 | 4 |
| `mux/vorbis_to_ogg` | mux | 3 | 4 |
| `performance/bundle-size` | performance | 3 | 4 |
| `performance/extract-metadata` | performance | 3 | 4 |
| `performance/metamorphic-probe-duration-cross-container` | performance | 3 | 4 |
| `performance/metamorphic-vfr-iterate-packets` | performance | 3 | 4 |
| `performance/metamorphic-vfr-probe-duration` | performance | 3 | 4 |
| `performance/op-sweep-remux-mp4-to-mkv` | performance | 3 | 4 |
| `performance/size-ladder-demux-peak-memory-huge` | performance | 2 | 4 |
| `performance/size-ladder-demux-peak-memory-large` | performance | 3 | 4 |
| `performance/size-ladder-demux-peak-memory-large4k` | performance | 2 | 4 |
| `performance/size-ladder-extract-metadata-large` | performance | 3 | 4 |
| `performance/size-ladder-iterate-packets-large4k` | performance | 3 | 4 |
| `performance/size-ladder-iterate-packets-tiny` | performance | 3 | 4 |
| `probe/aac_adts` | probe | 3 | 4 |
| `probe/cenc_ctr` | probe | 3 | 4 |
| `probe/flac_seektable` | probe | 3 | 4 |
| `probe/h264_1080p_30s` | probe | 3 | 4 |
| `probe/h264_4k_10s` | probe | 3 | 4 |
| `probe/h264_in_mkv` | probe | 3 | 4 |

_…and 76 more._

### Missing same-export timed rotations

| Metric | Scenario | Family | Measured | Required |
|--------|----------|--------|---------:|---------:|
| wall | `audio-dsp/throughput_decode_s24` | audio-dsp | 1 | 4 |

### Under-sampled timed participants

_Every timed participant is multi-sample with warmup._

## Functional reds — fix before speed work

| # | Status | Kind | Scenario | Rotation | Family | Reason |
|--:|--------|------|----------|----------|--------|--------|
| 1 | FAIL | red | `audio-dsp/edge_gapless_aac_decode` | `rotated:01.mp4@7a5b8dd34a` | audio-dsp | oracle 'property-invariant' failed: [invariant gapless sample count] decoded samples 49040 vs priming-removed expected 7690464 at 48000Hz (delta 7641424 > 1); decoded duration 1.02 |
| 2 | FAIL | red | `audio-dsp/edge_gapless_aac_decode` | `rotated:02.mp4@f34444c8c4` | audio-dsp | oracle 'property-invariant' failed: [invariant gapless sample count] decoded samples 49040 vs priming-removed expected 18432000 at 48000Hz (delta 18382960 > 1); decoded duration 1. |
| 3 | FAIL | red | `audio-dsp/edge_gapless_aac_decode` | `rotated:03.mp4@e471b83ad7` | audio-dsp | oracle 'property-invariant' failed: [invariant gapless sample count] decoded samples 49040 vs priming-removed expected 427968 at 48000Hz (delta 378928 > 1); decoded duration 1.0216 |
| 4 | FAIL | red | `audio-dsp/edge_gapless_aac_decode` | `rotated:05.mp4@c35fe072c2` | audio-dsp | oracle 'property-invariant' failed: [invariant gapless sample count] decoded samples 48128 vs priming-removed expected 50784 at 48000Hz (delta 2656 > 1); decoded duration 1.002667s |
| 5 | FAIL | red | `audio-dsp/edge_gapless_aac_decode` | `rotated:05.mp4@c35fe072c2` | audio-dsp | oracle 'property-invariant' failed: [invariant gapless sample count] decoded samples 49152 vs priming-removed expected 50784 at 48000Hz (delta 1632 > 1); decoded duration 1.024000s |
| 6 | FAIL | red | `audio-dsp/throughput_decode_s24` | `rotated:01.wav@3cb89a79d3` | audio-dsp | oracle 'decoded-audio-pcm' failed: [audio PCM decode] 4096/4096 frame digests differ; frame 0: sha256 2c3498ed…3e41 vs golden c660ee15…0d79; frame 1: sha256 a8b8bc09…1817 vs golden |
| 7 | FAIL | red | `metadata/write_mkv_tags` | `rotated:03.mkv@15ac6672ae` | metadata | oracle 'reference-reimport' failed: media track type 'video' count: reimport 1 vs golden 2 |
| 8 | FAIL | red | `mux/edge_hevc_decode_mux_mkv` | `baked:hevc_1080p_10s.mp4@no-sha` | mux | oracle 'property-invariant' failed: [decode(mux(x))==decode(x)] platform decode of output failed: <video> has zero intrinsic size (not enough data decoded) |
| 9 | FAIL | red | `performance/size-ladder-iterate-packets-massive` | `baked:massive_h264_1080p_2h.mp4@no-sha` | performance | oracle 'golden-packets' failed: 214646 packets had a size mismatch |
| 10 | ERROR | red | `probe/hls_aes128` | `baked:hls_aes128.m3u8@no-sha` | probe | not an MPEG-TS stream (no transport sync run found — encrypted, scrambled, or not a transport stream) |
| 11 | ERROR | red | `probe/hls_aes128` | `baked:hls_aes128.m3u8@no-sha` | probe | not an MPEG-TS stream (no transport sync run found — encrypted, scrambled, or not a transport stream) |
| 12 | ERROR | red | `probe/hls_aes128` | `baked:hls_aes128.m3u8@no-sha` | probe | not an MPEG-TS stream (no transport sync run found — encrypted, scrambled, or not a transport stream) |

### Bake-blocked rotations

| Scenario | Rotation | Family | Reason |
|----------|----------|--------|--------|
| `audio-dsp/downmix_5_1_to_stereo` | `baked:wav_5_1.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/downmix_5_1_to_stereo` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/downmix_5_1_to_stereo` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/downmix_stereo_to_mono` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/downmix_stereo_to_mono` | `baked:wav_s16.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/downmix_stereo_to_mono` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_gapless_aac_decode` | `baked:gapless_aac.m4a@no-sha` | audio-dsp | selected file missing on disk: 'scenarios/audio-dsp/edge_gapless_aac_decode/gapless_aac.m4a' (404 Not Found) |
| `audio-dsp/edge_gapless_aac_decode` | `rotated:04.mp4@74c2effc1a` | audio-dsp | oracle 'property-invariant' unavailable: [gapless-decoded-sample-count-priming-removed] no golden sample rate/duration t |
| `audio-dsp/edge_gapless_aac_decode` | `baked:gapless_aac.m4a@no-sha` | audio-dsp | selected file missing on disk: 'scenarios/audio-dsp/edge_gapless_aac_decode/gapless_aac.m4a' (404 Not Found) |
| `audio-dsp/edge_longform_audio_resample_16k` | `rotated:02.wav@e5346c53c3` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_longform_audio_resample_16k` | `rotated:01.wav@1a747a8969` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_longform_audio_resample_16k` | `rotated:03.wav@bf9da1d195` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_variable_channel_count_downmix` | `rotated:02.wav@d8e17efdcd` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_variable_channel_count_downmix` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_variable_channel_count_downmix` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_variable_channel_count_downmix` | `baked:wav_5_1.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/fade_in_out_f32` | `rotated:03.wav@75e6b77450` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/fade_in_out_f32` | `rotated:01.wav@97b7271647` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/fade_in_out_f32` | `baked:wav_f32.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/gain_half_f32` | `rotated:01.wav@97b7271647` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/gain_half_f32` | `rotated:02.wav@b2521dfb3e` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/gain_minus6db_s16` | `rotated:02.wav@d8e17efdcd` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/gain_minus6db_s16` | `baked:wav_s16.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/gain_minus6db_s16` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_f32_to_s16` | `baked:wav_f32.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_s16_to_f32` | `baked:wav_s16.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_s16be_to_s16le` | `baked:pcm_s16be.aiff@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_s24_to_f32` | `baked:wav_s24.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_s24_to_s16` | `baked:wav_s24.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_s24be_to_s16le` | `baked:pcm_s24be.aiff@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_44k1_to_48k` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_44k1_to_48k` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_48k_to_16k` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_48k_to_16k` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_48k_to_16k` | `rotated:02.wav@d8e17efdcd` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_48k_to_16k` | `baked:wav_s16.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_48k_to_44k1` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_48k_to_44k1` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/throughput_encode_s24` | `baked:wav_f32.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_mono_to_stereo` | `rotated:02.wav@d8e17efdcd` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_mono_to_stereo` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_mono_to_stereo` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_mono_to_stereo` | `baked:wav_s16_mono.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_stereo_to_5_1` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_stereo_to_5_1` | `rotated:02.wav@d8e17efdcd` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_stereo_to_5_1` | `baked:wav_s16.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `decode-seek/decode_bframes_reorder` | `rotated:03.mp4@17cd9e84ed` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_bframes_reorder` | `rotated:02.mp4@2379315a58` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_h264_4k` | `rotated:02.mp4@d7a57cdb16` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_h264_first_frames` | `rotated:01.mp4@6b2dd241b8` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_h264_first_frames` | `rotated:03.mp4@17cd9e84ed` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_h264_first_frames` | `rotated:02.mp4@2379315a58` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_h264_first_frames` | `rotated:02.mp4@2379315a58` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_h264_first_frames` | `rotated:01.mp4@6b2dd241b8` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_hevc` | `rotated:03.mp4@9e5b077bee` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_size_huge_h264_600s` | `rotated:01.mov@9bbd7d5070` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_size_tiny_h264_360p` | `rotated:03.mp4@feafb02bbc` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/meta_decode_remux_eq_decode_anchored` | `rotated:03.mp4@17cd9e84ed` | decode-seek | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/decode-seek/meta_d |
| `decode-seek/meta_decode_remux_eq_decode_anchored` | `rotated:02.mp4@2379315a58` | decode-seek | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/decode-seek/meta_d |
| `demux/flac_noseektable` | `rotated:02.flac@c01f4a0ef9` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/h264_in_mkv` | `rotated:01.mkv@8c4e020a1c` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/h264_multitrack` | `rotated:03.mp4@baf03cd8ba` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/h264_vfr` | `rotated:03.mp4@60c7223c96` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/mp3_xing` | `rotated:03.mp3@4d174395b4` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/opus` | `rotated:02.ogg@51b0f318c6` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/size_large_large_h264_1080p_120s` | `rotated:03.mp4@dcea729fb3` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/size_tiny_tiny_h264_360p_2s` | `rotated:02.mp4@917689d008` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `metadata/meta_consistent_mp4_to_mkv` | `rotated:03.mp4@58dc001d18` | metadata | oracle 'property-invariant' unavailable: [probe-duration] no golden/source duration to compare |
| `metadata/tagedit_no_corrupt_audio_flac` | `rotated:02.flac@c01f4a0ef9` | metadata | oracle 'property-invariant' unavailable: golden absent: [probe-duration] output duration undeterminable (no mp4/webm con |
| `metadata/tagedit_no_corrupt_audio_flac` | `baked:flac_seektable.flac@no-sha` | metadata | oracle 'property-invariant' unavailable: golden absent: [probe-duration] output duration undeterminable (no mp4/webm con |
| `metadata/tagedit_no_corrupt_audio_flac` | `rotated:03.flac@7bcba20a7d` | metadata | oracle 'property-invariant' unavailable: golden absent: [probe-duration] output duration undeterminable (no mp4/webm con |
| `metadata/tracks_attribution_multitrack` | `rotated:01.mp4@0cd83d944a` | metadata | oracle 'golden-metadata' unavailable: no golden meta (fixtures/golden/<id>.meta.json absent) |
| `metadata/write_flac_vorbiscomment` | `rotated:03.flac@7bcba20a7d` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_flac_vorbiscomment` | `rotated:02.flac@c01f4a0ef9` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_flac_vorbiscomment` | `baked:flac_seektable.flac@no-sha` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_flac_vorbiscomment` | `rotated:01.flac@78b4641a28` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_mp3_id3` | `rotated:02.mp3@40e37511b1` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_mp3_id3` | `rotated:01.mp3@56d38ee4eb` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_mp3_id3` | `baked:mp3_xing.mp3@no-sha` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_ogg_vorbiscomment` | `rotated:01.ogg@864f91c797` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_ogg_vorbiscomment` | `rotated:02.ogg@51b0f318c6` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_ogg_vorbiscomment` | `baked:opus.ogg@no-sha` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_ogg_vorbiscomment` | `rotated:03.ogg@b641673b0f` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `mux/aac_to_adts` | `rotated:02.aac@052f9c7c53` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/aac_to_adts` | `rotated:01.aac@423b0786df` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/aac_to_adts` | `baked:aac_adts.aac@no-sha` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/drop_audio_track_subset_to_mp4` | `rotated:01.mp4@0cd83d944a` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/h264_aac_to_mkv` | `rotated:02.mp4@d01b447eda` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/h264_aac_to_mp4` | `rotated:03.mp4@58dc001d18` | mux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport mux round-trip: no golden packet table to com |
| `mux/h264_aac_to_ts` | `rotated:02.mp4@d01b447eda` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/h264_aac_to_ts` | `rotated:01.mp4@f9bac3dfa3` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/h264_aac_to_ts` | `rotated:03.mp4@58dc001d18` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/h264_aac_to_ts` | `baked:h264_1080p_30s.mp4@no-sha` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/mp3_to_mp3` | `baked:mp3_xing.mp3@no-sha` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/mp3_to_mp3` | `rotated:01.mp3@56d38ee4eb` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/mp3_to_mp3` | `rotated:03.mp3@4d174395b4` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/opus_to_ogg` | `rotated:02.ogg@51b0f318c6` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/opus_to_ogg` | `rotated:03.ogg@b641673b0f` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/opus_to_ogg` | `baked:opus.ogg@no-sha` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/opus_to_ogg` | `rotated:01.ogg@864f91c797` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |

_…and 75 more._

## Headline

- Functional reds: **12** (0 timeout · 0 OOM · 12 other)
- Non-exempt coverage gaps (ours NA while a rival PASSes): **0**
- ADR-backed honest-NA coverage exemptions: **0**
- Contested exact rotations: **1 wall** · **0 peak memory**
- Active losses: **1 wall** · **0 peak memory**
- Wall severity: **0 catastrophic** (≥100×) · **0 severe** (10–100×) · **0 moderate** (3–10×) · **1 minor** (<3×)
- ADR-backed parity exemptions: **0**

An absent or zero-sample `peakMemory` metric is **unmeasured**, never zero. A row is
contested only when both our engine and a rival PASSed the same rotation in the
same export and both reported that metric.

## Coverage parity

### Active gaps

_None._

### ADR-backed honest-NA exemptions

_None._


## Wall-time losses

| # | Scenario | Rotation | Family | Ours | Fastest/leanest rival | Theirs | Ratio |
|--:|----------|----------|--------|-----:|------------------------|-------:|------:|
| 1 | `audio-dsp/throughput_decode_s24` | `rotated:03.wav@27d24a15c1` | audio-dsp | 58.3 ms | mediabunny | 27.7 ms | 2.11× |

## Peak-memory losses

_None._

## ADR-backed parity exemptions

_None._
