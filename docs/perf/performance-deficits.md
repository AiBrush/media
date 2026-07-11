# Deficit worklist — rotated correctness, wall time, and peak memory

> **Auto-generated** by `docs/perf/gen-deficits.mjs` from 62 public result export(s).
> Newest export: `chromium-2026-07-11T04-43-07-191Z.json` (2026-07-11T04:43:08.503Z). Freshness window:
> 24 h. Same-work comparisons never combine engines from different exports.

## Measurement integrity

- Fresh exports used: `chromium-2026-07-10T19-49-46-246Z.json`, `chromium-2026-07-10T20-13-31-425Z.json`, `chromium-2026-07-10T20-48-47-717Z.json`, `chromium-2026-07-10T20-54-40-438Z.json`, `chromium-2026-07-10T20-55-11-634Z.json`, `chromium-2026-07-10T21-00-14-370Z.json`, `chromium-2026-07-10T21-02-11-401Z.json`, `chromium-2026-07-10T21-02-27-729Z.json`, `chromium-2026-07-10T21-02-57-779Z.json`, `chromium-2026-07-10T21-03-04-204Z.json`, `chromium-2026-07-10T21-03-08-736Z.json`, `chromium-2026-07-10T21-03-15-281Z.json`, `chromium-2026-07-10T21-06-49-841Z.json`, `chromium-2026-07-10T21-07-06-969Z.json`, `chromium-2026-07-10T21-12-56-281Z.json`, `chromium-2026-07-10T21-13-16-797Z.json`, `chromium-2026-07-10T21-13-35-161Z.json`, `chromium-2026-07-10T21-57-37-459Z.json`, `chromium-2026-07-10T22-37-45-942Z.json`, `chromium-2026-07-10T22-41-39-743Z.json`, `chromium-2026-07-10T23-19-52-428Z.json`, `chromium-2026-07-10T23-20-18-871Z.json`, `chromium-2026-07-10T23-20-46-282Z.json`, `chromium-2026-07-10T23-21-07-792Z.json`, `chromium-2026-07-10T23-22-34-796Z.json`, `chromium-2026-07-10T23-25-04-841Z.json`, `chromium-2026-07-11T00-22-57-847Z.json`, `chromium-2026-07-11T00-24-43-117Z.json`, `chromium-2026-07-11T00-28-57-939Z.json`, `chromium-2026-07-11T02-41-51-790Z.json`, `chromium-2026-07-11T02-43-00-871Z.json`, `chromium-2026-07-11T03-41-51-764Z.json`, `chromium-2026-07-11T03-45-12-796Z.json`, `chromium-2026-07-11T03-45-58-911Z.json`, `chromium-2026-07-11T03-48-04-202Z.json`, `chromium-2026-07-11T03-49-52-685Z.json`, `chromium-2026-07-11T03-50-53-058Z.json`, `chromium-2026-07-11T03-51-47-950Z.json`, `chromium-2026-07-11T03-52-55-162Z.json`, `chromium-2026-07-11T03-53-46-587Z.json`, `chromium-2026-07-11T03-54-37-378Z.json`, `chromium-2026-07-11T03-55-13-372Z.json`, `chromium-2026-07-11T03-56-05-656Z.json`, `chromium-2026-07-11T04-02-15-106Z.json`, `chromium-2026-07-11T04-02-46-223Z.json`, `chromium-2026-07-11T04-03-20-540Z.json`, `chromium-2026-07-11T04-03-59-062Z.json`, `chromium-2026-07-11T04-04-33-684Z.json`, `chromium-2026-07-11T04-05-09-499Z.json`, `chromium-2026-07-11T04-34-54-366Z.json`, `chromium-2026-07-11T04-39-10-727Z.json`, `chromium-2026-07-11T04-41-11-351Z.json`, `chromium-2026-07-11T04-41-41-517Z.json`, `chromium-2026-07-11T04-41-45-954Z.json`, `chromium-2026-07-11T04-41-50-308Z.json`, `chromium-2026-07-11T04-41-54-937Z.json`, `chromium-2026-07-11T04-41-59-164Z.json`, `chromium-2026-07-11T04-42-03-117Z.json`, `chromium-2026-07-11T04-42-07-151Z.json`, `chromium-2026-07-11T04-42-14-328Z.json`, `chromium-2026-07-11T04-43-07-191Z.json`
- Stale exports excluded from current cells: `stored-test-data-chromium-2026-07-01T08-33-45-588Z.json`
- Required samples per timed participant: **n≥5**, with warmup ≥1
- Correctness rotation gaps: **271**
- Timed rotation gaps: **480**
- Under-sampled timed participants: **0**
- Fresh same-export rival wall evidence: **missing**

### Missing correctness rotations

| Scenario | Family | Measured | Required |
|----------|--------|---------:|---------:|
| `audio-dsp/aiff_container_probe` | audio-dsp | 3 | 4 |
| `audio-dsp/caf_container_probe` | audio-dsp | 3 | 4 |
| `audio-dsp/downmix_5_1_to_stereo` | audio-dsp | 3 | 4 |
| `audio-dsp/downmix_stereo_to_mono` | audio-dsp | 3 | 4 |
| `audio-dsp/edge_longform_audio_probe` | audio-dsp | 3 | 4 |
| `audio-dsp/edge_longform_audio_resample_16k` | audio-dsp | 1 | 4 |
| `audio-dsp/edge_variable_channel_count_downmix` | audio-dsp | 3 | 4 |
| `audio-dsp/fade_in_out_f32` | audio-dsp | 2 | 4 |
| `audio-dsp/gain_half_f32` | audio-dsp | 1 | 4 |
| `audio-dsp/gain_minus6db_s16` | audio-dsp | 3 | 4 |
| `audio-dsp/negative_image_into_audio_transcode` | audio-dsp | 2 | 4 |
| `audio-dsp/resample_44k1_to_48k` | audio-dsp | 2 | 4 |
| `audio-dsp/resample_48k_to_16k` | audio-dsp | 3 | 4 |
| `audio-dsp/resample_48k_to_44k1` | audio-dsp | 2 | 4 |
| `audio-dsp/throughput_decode_s16be` | audio-dsp | 3 | 4 |
| `audio-dsp/upmix_mono_to_stereo` | audio-dsp | 3 | 4 |
| `audio-dsp/upmix_stereo_to_5_1` | audio-dsp | 3 | 4 |
| `decode-seek/decode_av1` | decode-seek | 2 | 4 |
| `decode-seek/decode_bframes_reorder` | decode-seek | 2 | 4 |
| `decode-seek/decode_h264_4k` | decode-seek | 3 | 4 |
| `decode-seek/decode_h264_first_frames` | decode-seek | 3 | 4 |
| `decode-seek/decode_hevc` | decode-seek | 2 | 4 |
| `decode-seek/decode_image_jpeg` | decode-seek | 3 | 4 |
| `decode-seek/decode_image_webp` | decode-seek | 1 | 4 |
| `decode-seek/decode_mkv_h264` | decode-seek | 3 | 4 |
| `decode-seek/decode_mov_h264` | decode-seek | 3 | 4 |
| `decode-seek/decode_size_tiny_h264_360p` | decode-seek | 2 | 4 |
| `decode-seek/decode_size_tiny_vp9_360p` | decode-seek | 3 | 4 |
| `decode-seek/decode_vp8` | decode-seek | 2 | 4 |
| `decode-seek/decode_vp9` | decode-seek | 2 | 4 |
| `decode-seek/meta_decode_remux_eq_decode_anchored` | decode-seek | 3 | 4 |
| `decode-seek/meta_pts_monotonic_after_reorder` | decode-seek | 2 | 4 |
| `demux/aac_adts` | demux | 3 | 4 |
| `demux/av1_720p_5s` | demux | 2 | 4 |
| `demux/flac_noseektable` | demux | 2 | 4 |
| `demux/flac_seektable` | demux | 2 | 4 |
| `demux/graceful_webm_header_destroyed` | demux | 3 | 4 |
| `demux/h264_1080p_30s` | demux | 3 | 4 |
| `demux/h264_1080p_5s` | demux | 3 | 4 |
| `demux/h264_4k_10s` | demux | 3 | 4 |
| `demux/h264_bframes_1080p` | demux | 2 | 4 |
| `demux/h264_in_mkv` | demux | 3 | 4 |
| `demux/h264_multitrack` | demux | 3 | 4 |
| `demux/h264_rotated90` | demux | 2 | 4 |
| `demux/h264_ts` | demux | 2 | 4 |
| `demux/h264_vfr` | demux | 3 | 4 |
| `demux/metamorphic_flac_seektable_invariance` | demux | 3 | 4 |
| `demux/mp3_cbr_notoc` | demux | 2 | 4 |
| `demux/mp3_xing` | demux | 3 | 4 |
| `demux/opus` | demux | 3 | 4 |
| `demux/pcm_s16be` | demux | 3 | 4 |
| `demux/realworld_mdn_flower_mp4` | demux | 3 | 4 |
| `demux/realworld_mdn_flower_webm` | demux | 3 | 4 |
| `demux/realworld_mdn_trex_mp3` | demux | 3 | 4 |
| `demux/size_huge_huge_h264_1080p_600s` | demux | 2 | 4 |
| `demux/size_large_large_h264_1080p_120s` | demux | 3 | 4 |
| `demux/size_large_large_vp9_1080p_120s` | demux | 3 | 4 |
| `demux/size_micro_micro_audio_short` | demux | 2 | 4 |
| `demux/size_tiny_tiny_h264_360p_2s` | demux | 3 | 4 |
| `demux/size_tiny_tiny_vp9_360p_2s` | demux | 3 | 4 |
| `demux/vp8_720p_10s` | demux | 3 | 4 |
| `demux/wav_f32` | demux | 2 | 4 |
| `demux/wav_s16` | demux | 3 | 4 |
| `demux/wav_s24` | demux | 3 | 4 |
| `encryption/cenc_cens_decrypt_na` | encryption | 3 | 4 |
| `encryption/clearkey_decrypt_na` | encryption | 3 | 4 |
| `encryption/perf_cenc_ctr_decrypt_throughput` | encryption | 3 | 4 |
| `encryption/unencrypted_left_untouched_noop` | encryption | 3 | 4 |
| `metadata/meta_consistent_mp4_to_mkv` | metadata | 2 | 4 |
| `metadata/neg_garbled_id3_mp3_probe` | metadata | 3 | 4 |
| `metadata/neg_garbled_ilst_mp4_probe` | metadata | 3 | 4 |
| `metadata/read_flac_seektable` | metadata | 3 | 4 |
| `metadata/read_h264_1080p_30s` | metadata | 3 | 4 |
| `metadata/read_h264_1080p_5s` | metadata | 3 | 4 |
| `metadata/read_h264_in_mkv` | metadata | 3 | 4 |
| `metadata/read_h264_multitrack` | metadata | 3 | 4 |
| `metadata/read_no_tags_wav` | metadata | 2 | 4 |
| `metadata/read_opus` | metadata | 2 | 4 |
| `metadata/read_pcm_s16be` | metadata | 2 | 4 |
| `metadata/read_vp9_1080p_10s` | metadata | 2 | 4 |
| `metadata/rotation_survives_mp4_mkv` | metadata | 3 | 4 |
| `metadata/tagedit_no_corrupt_audio_flac` | metadata | 3 | 4 |
| `metadata/tracks_attribution_multitrack` | metadata | 3 | 4 |
| `metadata/tracks_packet_attribution_multitrack` | metadata | 3 | 4 |
| `metadata/write_flac_vorbiscomment` | metadata | 3 | 4 |
| `metadata/write_mp3_id3` | metadata | 3 | 4 |
| `metadata/write_ogg_vorbiscomment` | metadata | 2 | 4 |
| `mux/aac_to_adts` | mux | 2 | 4 |
| `mux/audio_only_aac_to_mp4` | mux | 2 | 4 |
| `mux/av1_opus_to_mp4` | mux | 2 | 4 |
| `mux/edge_bframes_decode_mux_mp4` | mux | 3 | 4 |
| `mux/edge_multitrack_keep_all_to_mp4` | mux | 2 | 4 |
| `mux/edge_rotation_decode_mux_mkv` | mux | 3 | 4 |
| `mux/flac_to_mkv_audio` | mux | 3 | 4 |
| `mux/h264_aac_to_mkv` | mux | 3 | 4 |
| `mux/h264_aac_to_mov` | mux | 3 | 4 |
| `mux/h264_aac_to_mp4` | mux | 3 | 4 |
| `mux/h264_aac_to_ts` | mux | 3 | 4 |
| `mux/mp3_to_mp3` | mux | 3 | 4 |
| `mux/mp3_to_mp4_audio` | mux | 3 | 4 |

_…and 171 more._

### Missing same-export timed rotations

| Metric | Scenario | Family | Measured | Required |
|--------|----------|--------|---------:|---------:|
| peakMemory | `audio-dsp/pcm_s24_to_s16` | audio-dsp | 0 | 1 |
| peakMemory | `audio-dsp/upmix_mono_to_stereo` | audio-dsp | 0 | 4 |
| peakMemory | `decode-seek/decode_av1` | decode-seek | 0 | 4 |
| peakMemory | `decode-seek/decode_bframes_reorder` | decode-seek | 0 | 4 |
| peakMemory | `decode-seek/decode_extreme_fps_1` | decode-seek | 0 | 1 |
| peakMemory | `decode-seek/decode_extreme_fps_240` | decode-seek | 0 | 1 |
| peakMemory | `decode-seek/decode_h264_10bit` | decode-seek | 0 | 1 |
| peakMemory | `decode-seek/decode_h264_4k` | decode-seek | 0 | 4 |
| peakMemory | `decode-seek/decode_h264_first_frames` | decode-seek | 0 | 4 |
| peakMemory | `decode-seek/decode_mkv_h264` | decode-seek | 0 | 4 |
| peakMemory | `decode-seek/decode_mov_h264` | decode-seek | 0 | 4 |
| peakMemory | `decode-seek/decode_multitrack_select_video` | decode-seek | 0 | 1 |
| peakMemory | `decode-seek/decode_rotated_display_matrix` | decode-seek | 0 | 1 |
| peakMemory | `decode-seek/decode_size_large_h264_120s` | decode-seek | 0 | 4 |
| peakMemory | `decode-seek/decode_size_tiny_h264_360p` | decode-seek | 0 | 4 |
| peakMemory | `decode-seek/decode_size_tiny_vp9_360p` | decode-seek | 0 | 4 |
| peakMemory | `decode-seek/decode_vfr_timing` | decode-seek | 0 | 1 |
| peakMemory | `decode-seek/decode_vp9` | decode-seek | 0 | 4 |
| peakMemory | `decode-seek/meta_pts_monotonic_after_reorder` | decode-seek | 0 | 4 |
| peakMemory | `demux/size_large_large_h264_1080p_120s` | demux | 0 | 4 |
| peakMemory | `mux/edge_bframes_decode_mux_mkv` | mux | 0 | 4 |
| peakMemory | `mux/h264_aac_to_ts` | mux | 0 | 4 |
| peakMemory | `mux/pcm_f32_to_wav` | mux | 0 | 4 |
| peakMemory | `mux/prop_vfr_mux_duration_mp4_to_mp4` | mux | 0 | 4 |
| peakMemory | `mux/size_tiny_360p_to_mp4` | mux | 0 | 4 |
| peakMemory | `mux/video_a_plus_audio_b_to_mkv` | mux | 0 | 1 |
| peakMemory | `remux/av1_720p_5s_webm_to_mkv` | remux | 0 | 4 |
| peakMemory | `remux/h264_1080p_30s_mp4_to_mkv` | remux | 0 | 4 |
| peakMemory | `remux/h264_1080p_30s_mp4_to_ts` | remux | 0 | 4 |
| peakMemory | `remux/h264_in_mkv_mkv_to_ts` | remux | 0 | 4 |
| peakMemory | `remux/h264_multitrack_mp4_to_mkv` | remux | 0 | 4 |
| peakMemory | `remux/prop_recorder_headerless_duration_materialized` | remux | 0 | 1 |
| peakMemory | `streaming-output/mp4_ttfb_buffer_target` | streaming-output | 0 | 1 |
| peakMemory | `transcode/aac_to_pcm_wav_extract` | transcode | 0 | 1 |
| peakMemory | `trim/av1_keyframe_aligned` | trim | 0 | 3 |
| peakMemory | `trim/h264_to_eof_copy` | trim | 0 | 1 |
| wall | `audio-dsp/aiff_container_probe` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/caf_container_probe` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/downmix_5_1_to_stereo` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/downmix_stereo_to_mono` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/edge_gapless_aac_decode` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/edge_longform_audio_probe` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/edge_longform_audio_resample_16k` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/edge_variable_channel_count_downmix` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/fade_in_out_f32` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/gain_half_f32` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/gain_minus6db_s16` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/meta_idempotent_resample_same_rate` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/meta_probe_duration_across_wav_aiff` | audio-dsp | 0 | 1 |
| wall | `audio-dsp/meta_roundtrip_endianness_s16` | audio-dsp | 0 | 1 |
| wall | `audio-dsp/pcm_f32_to_s16` | audio-dsp | 0 | 1 |
| wall | `audio-dsp/pcm_s16_to_f32` | audio-dsp | 0 | 1 |
| wall | `audio-dsp/pcm_s16be_to_s16le` | audio-dsp | 0 | 1 |
| wall | `audio-dsp/pcm_s16le_to_s16be` | audio-dsp | 0 | 1 |
| wall | `audio-dsp/pcm_s24_to_f32` | audio-dsp | 0 | 1 |
| wall | `audio-dsp/pcm_s24_to_s16` | audio-dsp | 0 | 1 |
| wall | `audio-dsp/pcm_s24be_to_s16le` | audio-dsp | 0 | 1 |
| wall | `audio-dsp/resample_44k1_to_48k` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/resample_48k_to_16k` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/resample_48k_to_44k1` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/throughput_decode_s16be` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/throughput_decode_s24` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/throughput_encode_s16be` | audio-dsp | 0 | 1 |
| wall | `audio-dsp/throughput_encode_s24` | audio-dsp | 0 | 1 |
| wall | `audio-dsp/upmix_mono_to_stereo` | audio-dsp | 0 | 4 |
| wall | `audio-dsp/upmix_stereo_to_5_1` | audio-dsp | 0 | 4 |
| wall | `decode-seek/decode_av1` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_bframes_reorder` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_extreme_fps_1` | decode-seek | 0 | 1 |
| wall | `decode-seek/decode_extreme_fps_240` | decode-seek | 0 | 1 |
| wall | `decode-seek/decode_h264_10bit` | decode-seek | 0 | 1 |
| wall | `decode-seek/decode_h264_4k` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_h264_first_frames` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_hevc` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_mkv_h264` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_mov_h264` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_multitrack_select_video` | decode-seek | 0 | 1 |
| wall | `decode-seek/decode_open_gop_first_frame` | decode-seek | 0 | 1 |
| wall | `decode-seek/decode_rotated_display_matrix` | decode-seek | 0 | 1 |
| wall | `decode-seek/decode_size_huge_h264_600s` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_size_large_h264_120s` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_size_large_vp9_120s` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_size_micro_h264_1frame` | decode-seek | 0 | 1 |
| wall | `decode-seek/decode_size_tiny_h264_360p` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_size_tiny_vp9_360p` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_tiny_dims_1x1` | decode-seek | 0 | 1 |
| wall | `decode-seek/decode_tiny_dims_2x2_h264` | decode-seek | 0 | 1 |
| wall | `decode-seek/decode_vfr_timing` | decode-seek | 0 | 1 |
| wall | `decode-seek/decode_vp8` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_vp9` | decode-seek | 0 | 4 |
| wall | `decode-seek/decode_vp9_alpha` | decode-seek | 0 | 4 |
| wall | `decode-seek/meta_decode_remux_eq_decode_anchored` | decode-seek | 0 | 4 |
| wall | `decode-seek/meta_pts_monotonic_after_reorder` | decode-seek | 0 | 4 |
| wall | `decode-seek/meta_seek_vs_linear_decode` | decode-seek | 0 | 1 |
| wall | `decode-seek/meta_vfr_seek_lands_on_true_pts` | decode-seek | 0 | 1 |
| wall | `decode-seek/seek_av1_keyframe` | decode-seek | 0 | 1 |
| wall | `decode-seek/seek_backward_then_forward` | decode-seek | 0 | 1 |
| wall | `decode-seek/seek_bframes_midgop` | decode-seek | 0 | 1 |
| wall | `decode-seek/seek_h264_keyframe` | decode-seek | 0 | 1 |
| wall | `decode-seek/seek_h264_nonkeyframe` | decode-seek | 0 | 1 |

_…and 380 more._

### Under-sampled timed participants

_Every timed participant is multi-sample with warmup._

## Functional reds — fix before speed work

| # | Status | Kind | Scenario | Rotation | Family | Reason |
|--:|--------|------|----------|----------|--------|--------|
| 1 | FAIL | red | `audio-dsp/edge_gapless_aac_decode` | `rotated:01.mp4@7c301053c2` | audio-dsp | oracle 'property-invariant' failed: [invariant gapless sample count] decoded samples 52384 vs priming-removed expected 2886720 at 48000Hz (delta 2834336 > 1); decoded duration 1.09 |
| 2 | FAIL | red | `audio-dsp/edge_gapless_aac_decode` | `rotated:03.mp4@402a6ad46a` | audio-dsp | oracle 'property-invariant' failed: [invariant gapless sample count] decoded samples 52384 vs priming-removed expected 2886720 at 48000Hz (delta 2834336 > 1); decoded duration 1.09 |
| 3 | FAIL | red | `audio-dsp/throughput_decode_s24` | `rotated:01.wav@3cb89a79d3` | audio-dsp | oracle 'decoded-audio-pcm' failed: [audio PCM decode] 4096/4096 frame digests differ; frame 0: sha256 2c3498ed…3e41 vs golden c660ee15…0d79; frame 1: sha256 a8b8bc09…1817 vs golden |
| 4 | FAIL | red | `demux/graceful_mp4_header_destroyed` | `rotated:03.mp4@17cd9e84ed` | demux | robustness oracle 'graceful-failure' failed: operation produced output from malformed/mutated input (expected a clean throw/reject) |
| 5 | FAIL | red | `metadata/rotation_survives_mp4_mkv` | `rotated:01.mp4@0cd83d944a` | metadata | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 c9a8f91b…6d1a vs golden 7dd9bb63…8bba; frame 1: sha256 cfeb5 |
| 6 | FAIL | red | `metadata/rotation_survives_mp4_mkv` | `rotated:02.mp4@f9c534ebc1` | metadata | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 d1b388b6…4405 vs golden e0a38c56…6b3c; frame 1: sha256 3e397 |
| 7 | FAIL | red | `metadata/tagedit_no_corrupt_video_mp4_mkv` | `rotated:03.mp4@58dc001d18` | metadata | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 aebe29ce…8d43 vs golden f2432588…64c4; frame 1: sha256 0b1de |
| 8 | FAIL | red | `metadata/write_mkv_tags` | `rotated:03.mkv@15ac6672ae` | metadata | oracle 'reference-reimport' failed: media track type 'video' count: reimport 1 vs golden 2 |
| 9 | FAIL | red | `metadata/write_mp4_tags` | `rotated:02.mp4@d01b447eda` | metadata | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 5f374b5e…6677 vs golden bff5a07c…daf2; frame 1: sha256 82681 |
| 10 | FAIL | red | `mux/edge_bframes_decode_mux_mkv` | `rotated:02.mp4@d01b447eda` | mux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 5f374b5e…6677 vs golden bff5a07c…daf2; frame 1: sha256 82681 |
| 11 | FAIL | red | `mux/edge_bframes_decode_mux_mp4` | `rotated:03.mp4@58dc001d18` | mux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 aebe29ce…8d43 vs golden f2432588…64c4; frame 1: sha256 0b1de |
| 12 | FAIL | red | `mux/edge_hevc_decode_mux_mkv` | `baked:hevc_1080p_10s.mp4@no-sha` | mux | oracle 'property-invariant' failed: [decode(mux(x))==decode(x)] platform decode of output failed: <video> has zero intrinsic size (not enough data decoded) |
| 13 | FAIL | red | `mux/edge_rotation_decode_mux_mkv` | `rotated:01.mp4@0cd83d944a` | mux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 c9a8f91b…6d1a vs golden 7dd9bb63…8bba; frame 1: sha256 cfeb5 |
| 14 | FAIL | red | `mux/edge_rotation_decode_mux_mov` | `rotated:01.mp4@0cd83d944a` | mux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 c9a8f91b…6d1a vs golden 7dd9bb63…8bba; frame 1: sha256 cfeb5 |
| 15 | FAIL | red | `mux/prop_h264_decode_mux_mp4_to_mp4` | `rotated:03.mp4@58dc001d18` | mux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 aebe29ce…8d43 vs golden f2432588…64c4; frame 1: sha256 0b1de |
| 16 | FAIL | red | `mux/prop_vp9_decode_mux_webm_to_webm` | `rotated:01.webm@5f083475a1` | mux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 11/12 frame digests differ; frame 1: sha256 dbe3a7ba…811c vs golden 82488010…3a96; frame 2: sha256 e0543 |
| 17 | FAIL | red | `mux/prop_vp9_decode_mux_webm_to_webm` | `rotated:02.webm@999d4e779a` | mux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 e98a1aff…83de vs golden 9577c2d6…416c; frame 1: sha256 11c17 |
| 18 | FAIL | red | `performance/decode-fps` | `rotated:01.mp4@f9bac3dfa3` | performance | oracle 'decoded-frames-bitexact' failed: 12/12 frame digests differ; frame 0: sha256 9f1bd3df…8bf3 vs golden 99733ae9…95ea; frame 1: sha256 d16e290f…f496 vs golden 472bab38…8a9c; f |
| 19 | FAIL | red | `performance/decode-fps` | `rotated:02.mp4@d01b447eda` | performance | oracle 'decoded-frames-bitexact' failed: 12/12 frame digests differ; frame 0: sha256 5f374b5e…6677 vs golden bff5a07c…daf2; frame 1: sha256 82681444…5ac6 vs golden 5127f00b…84db; f |
| 20 | FAIL | red | `performance/metamorphic-decode-remux` | `rotated:02.mp4@d01b447eda` | performance | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 5f374b5e…6677 vs golden bff5a07c…daf2; frame 1: sha256 82681 |
| 21 | FAIL | red | `performance/size-ladder-iterate-packets-massive` | `baked:massive_h264_1080p_2h.mp4@no-sha` | performance | oracle 'golden-packets' failed: 214646 packets had a size mismatch |
| 22 | ERROR | red | `probe/hls_aes128` | `baked:hls_aes128.m3u8@no-sha` | probe | not an MPEG-TS stream (no transport sync run found — encrypted, scrambled, or not a transport stream) |
| 23 | FAIL | red | `remux/aac_adts_adts_to_mp4` | `rotated:02.aac@052f9c7c53` | remux | oracle 'reference-reimport' failed: duration: reimport 19.9920s vs golden 17.1360s (Δ 2.8560s > tol 0.1000s) |
| 24 | FAIL | red | `remux/prop_adts_to_mp4_duration_invariant` | `rotated:02.aac@052f9c7c53` | remux | oracle 'property-invariant' failed: [invariant probe(out).dur≈probe(x).dur] out 19.9920s vs 17.1360s (Δ 2.8560s > 2.5704s) |
| 25 | FAIL | red | `remux/prop_bframes_decode_remux_mp4_mov` | `rotated:01.mp4@f9bac3dfa3` | remux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 9f1bd3df…8bf3 vs golden 99733ae9…95ea; frame 1: sha256 d16e2 |
| 26 | FAIL | red | `remux/prop_bframes_decode_remux_mp4_mov` | `rotated:02.mp4@d01b447eda` | remux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 5f374b5e…6677 vs golden bff5a07c…daf2; frame 1: sha256 82681 |
| 27 | FAIL | red | `remux/prop_multitrack_survives_mp4_mkv` | `rotated:03.mp4@baf03cd8ba` | remux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 3a45121a…aeb2 vs golden 1ca92139…ee5b; frame 1: sha256 dbbc7 |
| 28 | FAIL | red | `remux/prop_rotation_survives_mp4_mov` | `rotated:02.mp4@f9c534ebc1` | remux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 d1b388b6…4405 vs golden e0a38c56…6b3c; frame 1: sha256 3e397 |
| 29 | FAIL | red | `remux/prop_roundtrip_mp4_mkv_mp4` | `rotated:02.mp4@d01b447eda` | remux | oracle 'property-invariant' failed: [invariant decode(remux(x))==decode(x)] 12/12 frame digests differ; frame 0: sha256 5f374b5e…6677 vs golden bff5a07c…daf2; frame 1: sha256 82681 |

### Bake-blocked rotations

| Scenario | Rotation | Family | Reason |
|----------|----------|--------|--------|
| `audio-dsp/downmix_5_1_to_stereo` | `baked:wav_5_1.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/downmix_5_1_to_stereo` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/downmix_5_1_to_stereo` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/downmix_stereo_to_mono` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/downmix_stereo_to_mono` | `baked:wav_s16.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/downmix_stereo_to_mono` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_gapless_aac_decode` | `rotated:02.mp4@125e368ec2` | audio-dsp | oracle 'property-invariant' unavailable: [gapless-decoded-sample-count-priming-removed] no golden sample rate/duration t |
| `audio-dsp/edge_longform_audio_resample_16k` | `rotated:02.wav@e5346c53c3` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_variable_channel_count_downmix` | `rotated:02.wav@d8e17efdcd` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_variable_channel_count_downmix` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_variable_channel_count_downmix` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/fade_in_out_f32` | `rotated:03.wav@75e6b77450` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/fade_in_out_f32` | `rotated:01.wav@97b7271647` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/gain_half_f32` | `rotated:01.wav@97b7271647` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
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
| `audio-dsp/resample_48k_to_44k1` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_48k_to_44k1` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/throughput_encode_s24` | `baked:wav_f32.wav@no-sha` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_mono_to_stereo` | `rotated:02.wav@d8e17efdcd` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_mono_to_stereo` | `rotated:01.wav@dde9e17f7d` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_mono_to_stereo` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_stereo_to_5_1` | `rotated:03.wav@edfbc6745f` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_stereo_to_5_1` | `rotated:02.wav@d8e17efdcd` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `decode-seek/decode_bframes_reorder` | `rotated:03.mp4@17cd9e84ed` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_h264_4k` | `rotated:02.mp4@d7a57cdb16` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_h264_first_frames` | `rotated:01.mp4@6b2dd241b8` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_h264_first_frames` | `rotated:03.mp4@17cd9e84ed` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_hevc` | `rotated:03.mp4@9e5b077bee` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_size_huge_h264_600s` | `rotated:01.mov@9bbd7d5070` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_size_tiny_h264_360p` | `rotated:03.mp4@feafb02bbc` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/meta_decode_remux_eq_decode_anchored` | `rotated:03.mp4@17cd9e84ed` | decode-seek | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/decode-seek/meta_d |
| `decode-seek/meta_decode_remux_eq_decode_anchored` | `rotated:02.mp4@2379315a58` | decode-seek | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/decode-seek/meta_d |
| `demux/flac_noseektable` | `rotated:02.flac@c01f4a0ef9` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/h264_1080p_30s` | `rotated:03.mp4@58dc001d18` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/h264_4k_10s` | `rotated:01.mp4@05f832e490` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/h264_in_mkv` | `rotated:01.mkv@8c4e020a1c` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/h264_multitrack` | `rotated:03.mp4@baf03cd8ba` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/h264_vfr` | `rotated:03.mp4@60c7223c96` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/mp3_xing` | `rotated:03.mp3@4d174395b4` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/opus` | `rotated:02.ogg@51b0f318c6` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/size_large_large_h264_1080p_120s` | `rotated:03.mp4@dcea729fb3` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/size_tiny_tiny_h264_360p_2s` | `rotated:02.mp4@917689d008` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `demux/wav_s24` | `rotated:01.wav@3cb89a79d3` | demux | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `metadata/meta_consistent_mp4_to_mkv` | `rotated:03.mp4@58dc001d18` | metadata | oracle 'property-invariant' unavailable: [probe-duration] no golden/source duration to compare |
| `metadata/read_h264_1080p_5s` | `rotated:02.mov@16ef3b0ae0` | metadata | oracle 'golden-metadata' unavailable: no golden meta (fixtures/golden/<id>.meta.json absent) |
| `metadata/tagedit_no_corrupt_audio_flac` | `rotated:02.flac@c01f4a0ef9` | metadata | oracle 'property-invariant' unavailable: [probe-duration] no golden/source duration to compare |
| `metadata/tagedit_no_corrupt_audio_flac` | `baked:flac_seektable.flac@no-sha` | metadata | oracle 'property-invariant' unavailable: golden absent: [probe-duration] output duration undeterminable (no mp4/webm con |
| `metadata/tagedit_no_corrupt_audio_flac` | `rotated:03.flac@7bcba20a7d` | metadata | oracle 'property-invariant' unavailable: golden absent: [probe-duration] output duration undeterminable (no mp4/webm con |
| `metadata/tracks_attribution_multitrack` | `rotated:01.mp4@0cd83d944a` | metadata | oracle 'golden-metadata' unavailable: no golden meta (fixtures/golden/<id>.meta.json absent) |
| `metadata/tracks_packet_attribution_multitrack` | `rotated:02.mp4@f9c534ebc1` | metadata | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `metadata/write_flac_vorbiscomment` | `rotated:03.flac@7bcba20a7d` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_flac_vorbiscomment` | `rotated:02.flac@c01f4a0ef9` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_flac_vorbiscomment` | `baked:flac_seektable.flac@no-sha` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_mp3_id3` | `rotated:02.mp3@40e37511b1` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_mp3_id3` | `rotated:01.mp3@56d38ee4eb` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_mp3_id3` | `baked:mp3_xing.mp3@no-sha` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_ogg_vorbiscomment` | `rotated:01.ogg@864f91c797` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_ogg_vorbiscomment` | `rotated:02.ogg@51b0f318c6` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `mux/aac_to_adts` | `rotated:02.aac@052f9c7c53` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/aac_to_adts` | `rotated:01.aac@423b0786df` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/drop_audio_track_subset_to_mp4` | `rotated:01.mp4@0cd83d944a` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/h264_aac_to_mkv` | `rotated:02.mp4@d01b447eda` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/h264_aac_to_mp4` | `rotated:03.mp4@58dc001d18` | mux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport mux round-trip: no golden packet table to com |
| `mux/h264_aac_to_ts` | `rotated:02.mp4@d01b447eda` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/h264_aac_to_ts` | `rotated:01.mp4@f9bac3dfa3` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/h264_aac_to_ts` | `rotated:03.mp4@58dc001d18` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/mp3_to_mp3` | `baked:mp3_xing.mp3@no-sha` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/mp3_to_mp3` | `rotated:01.mp3@56d38ee4eb` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/mp3_to_mp3` | `rotated:03.mp3@4d174395b4` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/opus_to_ogg` | `rotated:02.ogg@51b0f318c6` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/opus_to_ogg` | `rotated:03.ogg@b641673b0f` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/opus_to_webm_audio` | `rotated:02.ogg@51b0f318c6` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/pcm_s16_to_wav` | `rotated:03.wav@edfbc6745f` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/prop_h264_mux_duration_mp4_to_ts` | `rotated:02.mp4@d01b447eda` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/prop_h264_mux_duration_mp4_to_ts` | `rotated:03.mp4@58dc001d18` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/prop_h264_mux_duration_mp4_to_ts` | `baked:h264_1080p_30s.mp4@no-sha` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/prop_vfr_mux_duration_mp4_to_mp4` | `rotated:02.mp4@0c8d9df09f` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/prop_vp9_mux_duration_webm_to_webm` | `rotated:03.webm@1e549042f6` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/size_longform_audio_to_mp4` | `rotated:03.mp4@8fd38eb928` | mux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport mux round-trip: no golden packet table to com |
| `mux/vorbis_to_ogg` | `rotated:02.webm@08eb6657d9` | mux | oracle 'property-invariant' unavailable: [probe(mux(x)).dur≈probe(x).dur] no golden/source duration to compare |
| `mux/vorbis_to_ogg` | `rotated:03.webm@4ec46fce5d` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/vorbis_to_ogg` | `rotated:01.webm@42b0dd1803` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `performance/bundle-size` | `rotated:03.mp4@0cd83d944a` | performance | oracle 'golden-metadata' unavailable: no golden meta (fixtures/golden/<id>.meta.json absent) |
| `performance/metamorphic-vfr-iterate-packets` | `rotated:01.mp4@e1d99ac98a` | performance | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `performance/op-sweep-demux` | `rotated:02.mp4@d01b447eda` | performance | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `performance/op-sweep-probe` | `rotated:01.mp4@f9bac3dfa3` | performance | oracle 'golden-metadata' unavailable: no golden meta (fixtures/golden/<id>.meta.json absent) |
| `performance/size-ladder-demux-peak-memory-huge` | `rotated:02.mov@45c8bafeb9` | performance | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |

_…and 77 more._

## Headline

- Functional reds: **29** (0 timeout · 0 OOM · 29 other)
- Non-exempt coverage gaps (ours NA while a rival PASSes): **0**
- ADR-backed honest-NA coverage exemptions: **0**
- Contested exact rotations: **0 wall** · **0 peak memory**
- Active losses: **0 wall** · **0 peak memory**
- Wall severity: **0 catastrophic** (≥100×) · **0 severe** (10–100×) · **0 moderate** (3–10×) · **0 minor** (<3×)
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

_None._

## Peak-memory losses

_None._

## ADR-backed parity exemptions

_None._
