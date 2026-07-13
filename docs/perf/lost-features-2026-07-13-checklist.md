# Chromium lost-feature checklist

Authoritative remediation checklist for `lost-features-chromium-2026-07-13.md`.

Legend: `PENDING` means not yet freshly revalidated; `ERROR`/`FAIL` are the prior export status, not an
acceptance result. A row becomes `WON` only when the fresh Chromium export reports aibrush-media as the
winner with every competitor result present and the corresponding strict validation and benchmark gates
are green.

| # | Scenario | Prior export | Fresh status | Cause | Validation / benchmark evidence | Commit |
|---:|---|---|---|---|---|---|
| 1 | `demux/aac_adts` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 2 | `demux/av1_720p_5s` | PASS, competitor winner | WON (fresh) | performance; fused WebM demux timing scan plus selective registration | `results/raw/chromium-2026-07-13T11-32-44-194Z.json` (`n=5`, all 6 engine cells; aibrush 10.800 ms vs mediabunny 13.440 ms; strict packet golden PASS) | `c507755` |
| 3 | `demux/h264_4k_10s` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 4 | `demux/h264_multitrack` | PASS, competitor winner | WON (fresh) | startup/registration; selective MP4 registration wins the passing competitors | `results/raw/chromium-2026-07-13T11-32-44-194Z.json` (`n=5`, all 6 engine cells; aibrush 9.475 ms vs mp4box 10.365 ms; strict packet golden PASS) | `297895b` |
| 5 | `demux/h264_rotated90` | PASS, competitor winner | WON (fresh) | startup/registration; selective MP4 registration wins the passing competitors | `results/raw/chromium-2026-07-13T11-32-44-194Z.json` (`n=5`, all 6 engine cells; aibrush 11.690 ms vs mp4box 14.990 ms; strict packet golden PASS) | `297895b` |
| 6 | `demux/h264_vfr` | PASS, competitor winner | PASS (fresh; not winner) | performance; MP4Box is narrowly faster after the registration change | `results/raw/chromium-2026-07-13T09-30-11-172Z.json` (`n=5`, all 6 engines; aibrush 16.465 ms vs mp4box 16.075 ms) | — |
| 7 | `demux/hls_vod` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 8 | `demux/metamorphic_flac_seektable_invariance` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 9 | `demux/realworld_mdn_flower_mp4` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 10 | `demux/realworld_mdn_flower_webm` | WON | WON (fresh) | bounded WebM packet pulls plus payload-free packet metadata; strict packet golden passes | `results/raw/chromium-2026-07-13T12-24-38-119Z.json` (`n=5`, all 6 engine cells; aibrush 6.270 ms vs mediabunny 10.290 ms) | `perf: expose WebM packet metadata` |
| 11 | `demux/size_large_large_vp9_1080p_120s` | WON | WON (fresh) | payload-free WebM packet metadata avoids encoded-chunk construction; strict packet golden passes; Remotion is still skipped by the public guard | `results/raw/chromium-2026-07-13T12-24-38-119Z.json` (`n=5`, all 6 engine cells; aibrush 93.330 ms vs mediabunny 157.535 ms) | `perf: expose WebM packet metadata` |
| 12 | `demux/size_micro_micro_audio_short` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 13 | `demux/size_tiny_tiny_h264_360p_2s` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 14 | `demux/size_tiny_tiny_vp9_360p_2s` | PASS, competitor winner | WON (fresh) | performance; fused WebM demux timing scan | `results/raw/chromium-2026-07-13T11-32-44-194Z.json` (`n=5`, all 6 engine cells; aibrush 5.515 ms vs mediabunny 7.035 ms; strict packet golden PASS) | `c507755` |
| 15 | `demux/vp8_720p_10s` | WON | WON (fresh) | payload-free WebM packet metadata avoids encoded-chunk construction; strict packet golden passes | `results/raw/chromium-2026-07-13T12-29-26-564Z.json` (`n=5`, all 6 engine cells; aibrush 5.880 ms vs mediabunny 8.950 ms) | `perf: expose WebM packet metadata` |
| 16 | `demux/vp9_1080p_10s` | WON | WON (fresh) | payload-free WebM packet metadata avoids encoded-chunk construction; strict packet golden passes | `results/raw/chromium-2026-07-13T12-24-38-119Z.json` (`n=5`, all 6 engine cells; aibrush 25.715 ms vs mediabunny 38.650 ms) | `perf: expose WebM packet metadata` |
| 17 | `probe/aac_adts` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 18 | `probe/empty-audio-wav` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 19 | `probe/flac_noseektable` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 20 | `probe/h264_multitrack` | PASS, competitor winner | WON (fresh) | startup/registration; selective MP4 registration wins all passing competitors | `results/raw/chromium-2026-07-13T09-30-11-172Z.json` (`n=5`, all 6 engines; aibrush 4.785 ms vs mediabunny 5.590 ms; strict metadata golden PASS) | `297895b` |
| 21 | `probe/hls_aes128` | ERROR | ERROR (fresh) | browser AES/HLS path under investigation | `results/raw/chromium-2026-07-13T08-26-16-278Z.json`; source URL probe passes in local browser, detached File reports typed relative-resource miss | — |
| 22 | `probe/hls_vod` | PASS, competitor winner | PASS (fresh) | performance | `results/raw/chromium-2026-07-13T08-34-33-463Z.json`; winner not yet verified | — |
| 23 | `probe/mp3_cbr_notoc` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 24 | `probe/mp3_xing` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 25 | `probe/realworld_mdn_trex_mp3` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 26 | `probe/recorder_headerless` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 27 | `probe/wav_s16` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 28 | `probe/wav_s24` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 29 | `remux/aac_adts_adts_to_mp4` | PASS, competitor winner | PASS (fresh; not winner) | performance; mediabunny is narrowly faster | `results/raw/chromium-2026-07-13T09-38-46-061Z.json` (`n=5`, all 6 engines; aibrush 10.315 ms vs mediabunny 9.385 ms) | — |
| 30 | `remux/av1_720p_5s_webm_to_mp4` | PASS, competitor winner | PASS (fresh; not winner) | performance; Mediabunny is faster on the current selected AV1 remux input | `results/raw/chromium-2026-07-13T11-32-44-194Z.json` (`n=5`, all 6 engine cells; aibrush 34.920 ms vs mediabunny 26.850 ms; strict output packet PASS) | — |
| 31 | `remux/h264_1080p_5s_mov_to_mp4` | PASS, competitor winner | PASS (fresh; not winner) | performance; MP4Box is faster on MOV timing/edit-list remux | `results/raw/chromium-2026-07-13T09-38-46-061Z.json` (`n=5`, all 6 engines; aibrush 29.710 ms vs mp4box 27.895 ms) | — |
| 32 | `remux/opus_ogg_to_webm` | PASS, competitor winner | WON (fresh) | performance; selective routing wins the applicable competitors | `results/raw/chromium-2026-07-13T11-32-44-194Z.json` (`n=5`, all 6 engine cells; aibrush 4.845 ms vs mediabunny 6.130 ms; strict output packet PASS) | `297895b` |
| 33 | `remux/vp9_1080p_10s_webm_to_mp4` | PASS, competitor winner | PASS (fresh; not winner) | performance; mediabunny remains faster on the long VP9 remux | `results/raw/chromium-2026-07-13T09-38-46-061Z.json` (`n=5`, all 6 engines; aibrush 47.390 ms vs mediabunny 25.900 ms) | — |
| 34 | `transcode/av1_to_vp9_webm` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 35 | `transcode/extreme_fps_240` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 36 | `transcode/h264_bitrate_2mbps` | FAIL | PASS (fresh; not winner) | performance after stale-bundle correctness fix | `results/raw/chromium-2026-07-13T08-18-29-095Z.json`; aibrush 37,946 ms aggregate vs remotion 14,466 ms | — |
| 37 | `transcode/h264_fps_15_to_30` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 38 | `transcode/h264_fps_30_to_60` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 39 | `transcode/h264_resize_4k_to_1080p` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 40 | `transcode/h264_rotate_180` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 41 | `transcode/h264_rotate_90_dimswap` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 42 | `transcode/h264_to_hevc_mp4` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 43 | `transcode/h264_vfr_to_cfr_30` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 44 | `transcode/hdr10_to_sdr_tonemap` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 45 | `transcode/hevc_to_vp9_webm` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 46 | `transcode/ladder_large_h264_1080p_120s_resize_720p` | PROVISIONAL | PENDING | PENDING | PENDING | — |
| 47 | `transcode/ladder_tiny_h264_360p_resize_180p` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 48 | `transcode/ladder_tiny_vp9_360p_to_h264_180p` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 49 | `transcode/metamorphic_duration_preserved_h264_to_vp9` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 50 | `transcode/mp3_to_aac_mp4` | FAIL | PASS (fresh; not winner) | correctness fixed; residual performance gap after exact Xing/LAME gapless propagation | `results/raw/chromium-2026-07-13T10-43-44-285Z.json` (`n=5`, all 6 engine cells; aibrush 63.590 ms vs mediabunny 59.810 ms and remotion 69.825 ms; strict output metadata/playback PASS) | pending perf |
| 51 | `transcode/mp3_to_opus_webm` | PASS, competitor winner | WON (fresh) | correctness; source MP3 sample-unit gapless facts were incorrectly inherited by 48 kHz Opus output | `results/raw/chromium-2026-07-13T10-42-42-481Z.json` (`n=5`, all 6 engine cells; aibrush 42.345 ms vs mediabunny 41.725 ms and remotion 46.855 ms; strict output metadata/playback PASS; within 3% noise) | `3b18f78` |
| 52 | `transcode/multitrack_select_default_audio` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 53 | `transcode/opus_to_aac_mp4` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 54 | `transcode/roundtrip_leg2_vp9_to_h264` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 55 | `transcode/vp9_alpha_to_vp9_keepalpha` | PASS, competitor winner | PENDING | PENDING | PENDING | — |
| 56 | `transcode/wav_to_aac_mp4` | PASS, competitor winner | PENDING | PENDING | PENDING | — |

## Fresh evidence index

- Chromium 149, suite 0.1.0, corpus checksum `6f4a1cdb`: focused exports are under
  `/Users/tarek/Home/software/projects/aibrush/aibrush.lib/media-test/results/raw/`.
- The report export that this checklist supersedes is the user-provided
  `lost-features-chromium-2026-07-13.md`.
- Three rows are marked `WON` from the qualified post-fix export; each still requires the green commit and
  the final full-suite rerun before close-out.
