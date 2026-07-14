# aibrush-media lost features — Chromium export

Source: `stored-test-data-chromium-2026-07-13T07-41-44-237Z.json`  
Generated at: `2026-07-13T07:41:44.237Z`  
Engine: `aibrush-media@dev`

The table reproduces the requested 56 losses using the scoreboard-style rule: only `PASS` results are eligible; exhaustive coverage is compared first; wall time (`bench.wall.aggregate`, then median, then duration) breaks equal-coverage ties. Feature names are the scenario IDs with the `#exhaustive...` file-selection suffix removed.

| # | Feature | Family | Winning framework | aibrush result | aibrush wall | Winner wall | Winner coverage | Note |
|---:|---|---|---|---|---:|---:|---:|---|
| 1 | `demux/aac_adts` | demux | `mediabunny@1.48.0` | PASS (4/4) | 19.58 ms | 15.97 ms | 4/4 | |
| 2 | `demux/av1_720p_5s` | demux | `mediabunny@1.48.0` | PASS (4/4) | 91.79 ms | 36.43 ms | 4/4 | |
| 3 | `demux/h264_4k_10s` | demux | `mp4box@2.3.0` | PASS (4/4) | 265.61 ms | 213.86 ms | 4/4 | |
| 4 | `demux/h264_multitrack` | demux | `mp4box@2.3.0` | PASS (4/4) | 50.5 ms | 44.38 ms | 4/4 | |
| 5 | `demux/h264_rotated90` | demux | `mp4box@2.3.0` | PASS (4/4) | 44.12 ms | 43.26 ms | 4/4 | |
| 6 | `demux/h264_vfr` | demux | `mp4box@2.3.0` | PASS (4/4) | 86.1 ms | 63.14 ms | 4/4 | |
| 7 | `demux/hls_vod` | demux | `mediabunny@1.48.0` | PASS (1/1) | 53.05 ms | 42.42 ms | 1/1 | |
| 8 | `demux/metamorphic_flac_seektable_invariance` | demux | `mediabunny@1.48.0` | PASS (4/4) | 15.07 ms | 12.66 ms | 4/4 | |
| 9 | `demux/realworld_mdn_flower_mp4` | demux | `mp4box@2.3.0` | PASS (4/4) | 37.5 ms | 32.79 ms | 4/4 | |
| 10 | `demux/realworld_mdn_flower_webm` | demux | `mediabunny@1.48.0` | PASS (4/4) | 47.09 ms | 23.52 ms | 4/4 | |
| 11 | `demux/size_large_large_vp9_1080p_120s` | demux | `mediabunny@1.48.0` | PASS (4/4) | 1030.33 ms | 627.19 ms | 4/4 | provisional: missing remotion result |
| 12 | `demux/size_micro_micro_audio_short` | demux | `mediabunny@1.48.0` | PASS (4/4) | 181.87 ms | 23.92 ms | 4/4 | |
| 13 | `demux/size_tiny_tiny_h264_360p_2s` | demux | `mp4box@2.3.0` | PASS (4/4) | 20.97 ms | 19.42 ms | 4/4 | |
| 14 | `demux/size_tiny_tiny_vp9_360p_2s` | demux | `mediabunny@1.48.0` | PASS (4/4) | 26.09 ms | 21.6 ms | 4/4 | |
| 15 | `demux/vp8_720p_10s` | demux | `mediabunny@1.48.0` | PASS (4/4) | 37.43 ms | 29.59 ms | 4/4 | |
| 16 | `demux/vp9_1080p_10s` | demux | `mediabunny@1.48.0` | PASS (4/4) | 146.65 ms | 116.98 ms | 4/4 | |
| 17 | `probe/aac_adts` | probe | `mediabunny@1.48.0` | PASS (4/4) | 16.73 ms | 13.67 ms | 4/4 | |
| 18 | `probe/empty-audio-wav` | probe | `mediabunny@1.48.0` | PASS (1/1) | 3.46 ms | 2.37 ms | 1/1 | |
| 19 | `probe/flac_noseektable` | probe | `remotion@4.0.479` | PASS (4/4) | 10.91 ms | 10.73 ms | 4/4 | |
| 20 | `probe/h264_multitrack` | probe | `remotion@4.0.479` | PASS (4/4) | 17.88 ms | 16.3 ms | 4/4 | |
| 21 | `probe/hls_aes128` | probe | `mediabunny@1.48.0` | ERROR (0/1) | — | 46.56 ms | 1/1 | |
| 22 | `probe/hls_vod` | probe | `mediabunny@1.48.0` | PASS (1/1) | 20.48 ms | 13.98 ms | 1/1 | |
| 23 | `probe/mp3_cbr_notoc` | probe | `mediabunny@1.48.0` | PASS (4/4) | 25.38 ms | 10.43 ms | 4/4 | |
| 24 | `probe/mp3_xing` | probe | `mediabunny@1.48.0` | PASS (4/4) | 14.83 ms | 11.91 ms | 4/4 | |
| 25 | `probe/realworld_mdn_trex_mp3` | probe | `mediabunny@1.48.0` | PASS (4/4) | 13.17 ms | 11.46 ms | 4/4 | |
| 26 | `probe/recorder_headerless` | probe | `ffmpeg.wasm@0.12.15` | PASS (1/1) | 4.15 ms | 2.73 ms | 1/1 | |
| 27 | `probe/wav_s16` | probe | `remotion@4.0.479` | PASS (4/4) | 16.38 ms | 15.5 ms | 4/4 | |
| 28 | `probe/wav_s24` | probe | `mediabunny@1.48.0` | PASS (4/4) | 18.2 ms | 11.39 ms | 4/4 | |
| 29 | `remux/aac_adts_adts_to_mp4` | remux | `mediabunny@1.48.0` | PASS (4/4) | 21.65 ms | 21.05 ms | 4/4 | |
| 30 | `remux/av1_720p_5s_webm_to_mp4` | remux | `mediabunny@1.48.0` | PASS (4/4) | 81.15 ms | 65.95 ms | 4/4 | |
| 31 | `remux/h264_1080p_5s_mov_to_mp4` | remux | `mp4box@2.3.0` | PASS (4/4) | 93.89 ms | 77.8 ms | 4/4 | |
| 32 | `remux/opus_ogg_to_webm` | remux | `mediabunny@1.48.0` | PASS (4/4) | 19.26 ms | 18.37 ms | 4/4 | |
| 33 | `remux/vp9_1080p_10s_webm_to_mp4` | remux | `mediabunny@1.48.0` | PASS (4/4) | 147.44 ms | 128.92 ms | 4/4 | |
| 34 | `transcode/av1_to_vp9_webm` | transcode | `remotion@4.0.479` | PASS (4/4) | 20785.7 ms | 13972.28 ms | 4/4 | |
| 35 | `transcode/extreme_fps_240` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 24171.39 ms | 24150.85 ms | 4/4 | |
| 36 | `transcode/h264_bitrate_2mbps` | transcode | `remotion@4.0.479` | FAIL (3/4) | — | 1252.54 ms | 4/4 | |
| 37 | `transcode/h264_fps_15_to_30` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 16466.98 ms | 14833.09 ms | 4/4 | |
| 38 | `transcode/h264_fps_30_to_60` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 21897.62 ms | 17895.76 ms | 4/4 | |
| 39 | `transcode/h264_resize_4k_to_1080p` | transcode | `remotion@4.0.479` | PASS (4/4) | 63282.36 ms | 8417.18 ms | 4/4 | |
| 40 | `transcode/h264_rotate_180` | transcode | `remotion@4.0.479` | PASS (4/4) | 11819.34 ms | 10412.59 ms | 4/4 | |
| 41 | `transcode/h264_rotate_90_dimswap` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 14648.07 ms | 12879.63 ms | 4/4 | |
| 42 | `transcode/h264_to_hevc_mp4` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 20609.66 ms | 9372.85 ms | 4/4 | |
| 43 | `transcode/h264_vfr_to_cfr_30` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 14917.46 ms | 14258.28 ms | 4/4 | |
| 44 | `transcode/hdr10_to_sdr_tonemap` | transcode | `ffmpeg.wasm@0.12.15` | PASS (1/1) | 53.36 ms | 40.99 ms | 1/1 | |
| 45 | `transcode/hevc_to_vp9_webm` | transcode | `mediabunny@1.48.0` | PASS (1/1) | 1651.39 ms | 1199.7 ms | 1/1 | |
| 46 | `transcode/ladder_large_h264_1080p_120s_resize_720p` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 47298.91 ms | 39368.91 ms | 4/4 | provisional: missing remotion result |
| 47 | `transcode/ladder_tiny_h264_360p_resize_180p` | transcode | `remotion@4.0.479` | PASS (4/4) | 1912.64 ms | 868.61 ms | 4/4 | |
| 48 | `transcode/ladder_tiny_vp9_360p_to_h264_180p` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 1158.12 ms | 1136.32 ms | 4/4 | |
| 49 | `transcode/metamorphic_duration_preserved_h264_to_vp9` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 12433.16 ms | 10485.65 ms | 4/4 | |
| 50 | `transcode/mp3_to_aac_mp4` | transcode | `ffmpeg.wasm@0.12.15` | FAIL (3/4) | — | 974.93 ms | 4/4 | |
| 51 | `transcode/mp3_to_opus_webm` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 293.56 ms | 267.28 ms | 4/4 | |
| 52 | `transcode/multitrack_select_default_audio` | transcode | `remotion@4.0.479` | PASS (4/4) | 1039.53 ms | 186.71 ms | 4/4 | |
| 53 | `transcode/opus_to_aac_mp4` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 121.83 ms | 113.99 ms | 4/4 | |
| 54 | `transcode/roundtrip_leg2_vp9_to_h264` | transcode | `remotion@4.0.479` | PASS (4/4) | 30088.01 ms | 18788.99 ms | 4/4 | |
| 55 | `transcode/vp9_alpha_to_vp9_keepalpha` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 1721.42 ms | 813.03 ms | 4/4 | |
| 56 | `transcode/wav_to_aac_mp4` | transcode | `mediabunny@1.48.0` | PASS (4/4) | 204.44 ms | 169.46 ms | 4/4 | |

## Summary

| Winning framework | Lost-feature count |
|---|---:|
| `mediabunny@1.48.0` | 36 |
| `remotion@4.0.479` | 10 |
| `mp4box@2.3.0` | 7 |
| `ffmpeg.wasm@0.12.15` | 3 |
| **Total** | **56** |

Two rows are marked provisional because the export has no `remotion@4.0.479` result for them. If the comparison is restricted to rows containing all six engine results, the export supports 54 confirmed losses; the requested 56-count scoreboard includes these two rows.
