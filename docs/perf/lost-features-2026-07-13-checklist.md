# Chromium lost-feature checklist

Authoritative remediation checklist for `lost-features-chromium-2026-07-13.md`.

Legend: `PENDING` means not yet freshly revalidated; `ERROR`/`FAIL` are the prior export status, not an
acceptance result. A row becomes `WON` only when the fresh Chromium export reports aibrush-media as the
winner with every competitor result present and the corresponding strict validation and benchmark gates
are green.

| # | Scenario | Prior export | Fresh status | Cause | Validation / benchmark evidence | Commit |
|---:|---|---|---|---|---|---|
| 1 | `demux/aac_adts` | PASS, competitor winner | WON (fresh) | performance; payload-free ADTS packet metadata reuses the parsed frame layout | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 1.805 ms vs fastest competitor 7.540 ms; strict packet golden PASS) | pending packet-table perf |
| 2 | `demux/av1_720p_5s` | PASS, competitor winner | PASS (fresh; not winner) | performance; current AV1 WebM path is slower than Mediabunny | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 6.150 ms vs mediabunny 3.860 ms; strict packet golden PASS) | — |
| 3 | `demux/h264_4k_10s` | PASS, competitor winner | PASS (fresh; not winner) | performance; MP4Box is faster on the 4K H.264 timing path | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 50.965 ms vs mp4box 28.925 ms; strict packet golden PASS) | — |
| 4 | `demux/h264_multitrack` | PASS, competitor winner | WON (fresh) | startup/registration; selective MP4 registration wins the passing competitors | `results/raw/chromium-2026-07-13T11-32-44-194Z.json` (`n=5`, all 6 engine cells; aibrush 9.475 ms vs mp4box 10.365 ms; strict packet golden PASS) | `297895b` |
| 5 | `demux/h264_rotated90` | PASS, competitor winner | PASS (fresh; not winner) | performance; MP4Box is faster on rotated H.264 metadata | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 19.565 ms vs mp4box 12.275 ms; strict packet golden PASS) | — |
| 6 | `demux/h264_vfr` | PASS, competitor winner | PASS (fresh; not winner) | performance; MP4Box is narrowly faster on VFR timing | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 16.580 ms vs mp4box 15.750 ms; strict packet golden PASS) | — |
| 7 | `demux/hls_vod` | PASS, competitor winner | PASS (fresh; not winner) | performance; Mediabunny is faster on HLS VOD traversal | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 63.850 ms vs mediabunny 43.345 ms; strict packet golden PASS) | — |
| 8 | `demux/metamorphic_flac_seektable_invariance` | PASS, competitor winner | WON (fresh) | performance; payload-free FLAC packet metadata reuses the parsed frame layout | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 4.075 ms vs fastest competitor 5.030 ms; strict packet golden PASS) | pending packet-table perf |
| 9 | `demux/realworld_mdn_flower_mp4` | PASS, competitor winner | PASS (fresh; not winner) | performance; MP4Box is faster on the MDN H.264 input | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 12.610 ms vs mp4box 4.410 ms; strict packet golden PASS) | — |
| 10 | `demux/realworld_mdn_flower_webm` | WON | WON (fresh) | bounded WebM packet pulls plus payload-free packet metadata; strict packet golden passes | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 2.305 ms vs fastest competitor 6.695 ms) | `perf: expose WebM packet metadata` |
| 11 | `demux/size_large_large_vp9_1080p_120s` | WON | WON (fresh) | payload-free WebM packet metadata avoids encoded-chunk construction; strict packet golden passes; Remotion is still skipped by the public guard | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 81.595 ms vs fastest competitor 155.080 ms) | `perf: expose WebM packet metadata` |
| 12 | `demux/size_micro_micro_audio_short` | PASS, competitor winner | WON (fresh) | performance; bounded WebM packet pulls and payload-free metadata | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 3.760 ms vs fastest competitor 3.925 ms; strict packet golden PASS) | `perf: expose WebM packet metadata` |
| 13 | `demux/size_tiny_tiny_h264_360p_2s` | PASS, competitor winner | PASS (fresh; not winner) | performance; MP4Box is faster on tiny H.264 | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 5.260 ms vs mp4box 3.295 ms; strict packet golden PASS) | — |
| 14 | `demux/size_tiny_tiny_vp9_360p_2s` | PASS, competitor winner | WON (fresh) | performance; bounded WebM packet pulls and payload-free metadata | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 2.290 ms vs fastest competitor 7.150 ms; strict packet golden PASS) | `perf: expose WebM packet metadata` |
| 15 | `demux/vp8_720p_10s` | WON | WON (fresh) | payload-free WebM packet metadata avoids encoded-chunk construction; strict packet golden passes | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 2.405 ms vs fastest competitor 12.220 ms) | `perf: expose WebM packet metadata` |
| 16 | `demux/vp9_1080p_10s` | WON | PASS (fresh; not winner) | performance; Mediabunny is faster on the current VP9 timing path | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 35.545 ms vs mediabunny 19.230 ms; strict packet golden PASS) | — |
| 17 | `probe/aac_adts` | PASS, competitor winner | PASS (fresh; not winner) | performance; Mediabunny is narrowly faster on ADTS probing | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 6.465 ms vs mediabunny 6.250 ms; strict metadata golden PASS) | — |
| 18 | `probe/empty-audio-wav` | PASS, competitor winner | WON (fresh) | performance; WAV probe remains within the strict fast path | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 3.595 ms vs fastest competitor 3.935 ms; strict metadata golden PASS) | — |
| 19 | `probe/flac_noseektable` | PASS, competitor winner | WON (fresh) | performance; FLAC probe reuses the parsed frame/header facts | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 1.535 ms vs fastest competitor 3.905 ms; strict metadata golden PASS) | — |
| 20 | `probe/h264_multitrack` | PASS, competitor winner | WON (fresh) | startup/registration; selective MP4 registration wins all passing competitors | `results/raw/chromium-2026-07-13T09-30-11-172Z.json` (`n=5`, all 6 engines; aibrush 4.785 ms vs mediabunny 5.590 ms; strict metadata golden PASS) | `297895b` |
| 21 | `probe/hls_aes128` | ERROR | ERROR (fresh) | capability/provenance; detached encrypted HLS media has relative key/segment references with no authorized base URL | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, aibrush typed ERROR; all 6 engine cells present; Mediabunny 46.735 ms and FFmpeg PASS) | — |
| 22 | `probe/hls_vod` | PASS, competitor winner | WON (fresh) | performance; HLS probe uses bounded manifest/segment inspection | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 24.795 ms vs fastest passing competitor 30.810 ms; strict metadata golden PASS) | — |
| 23 | `probe/mp3_cbr_notoc` | PASS, competitor winner | WON (fresh) | performance; CBR MP3 probe avoids unnecessary full payload work | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 4.290 ms vs fastest competitor 4.355 ms; strict metadata golden PASS) | — |
| 24 | `probe/mp3_xing` | PASS, competitor winner | WON (fresh) | performance; Xing/Info facts are read from the bounded header path | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 3.795 ms vs fastest competitor 4.385 ms; strict metadata golden PASS) | — |
| 25 | `probe/realworld_mdn_trex_mp3` | PASS, competitor winner | WON (fresh) | performance; real-world MP3 probe remains on the bounded header path | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 3.985 ms vs fastest competitor 4.215 ms; strict metadata golden PASS) | — |
| 26 | `probe/recorder_headerless` | PASS, competitor winner | PASS (fresh; not winner) | performance; Mediabunny is faster on headerless recorder WAV detection | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 11.985 ms vs mediabunny 6.345 ms; strict metadata golden PASS) | — |
| 27 | `probe/wav_s16` | PASS, competitor winner | PASS (fresh; not winner) | performance; Mediabunny is faster on PCM S16 probing | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 4.645 ms vs mediabunny 1.970 ms; strict metadata golden PASS) | — |
| 28 | `probe/wav_s24` | PASS, competitor winner | WON (fresh) | performance; PCM S24 probe remains within the strict fast path | `results/raw/chromium-2026-07-13T13-03-56-825Z.json` (`n=5`, all 6 engine cells; aibrush 3.535 ms vs fastest competitor 3.970 ms; strict metadata golden PASS) | — |
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
