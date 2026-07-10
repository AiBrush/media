# Session 11 — design-note index (finish the fair harness: 0 functional reds, then fastest/leanest)

Planning docs: [`SESSION11_GOAL.md`](../../SESSION11_GOAL.md) · [`BUILD_INSTRUCTIONS_SESSION11.md`](../../BUILD_INSTRUCTIONS_SESSION11.md) (inherits [`BUILD_INSTRUCTIONS.md`](../../BUILD_INSTRUCTIONS.md)).
Worklist: [`docs/perf/performance-deficits.md`](../perf/performance-deficits.md) + [`docs/perf/_deficit-data.json`](../perf/_deficit-data.json) (regenerate via `docs/perf/gen-deficits.mjs`, §11.A).
ADRs: **187–193** ([`docs/architecture/02-decision-records.md`](../architecture/02-decision-records.md)).

> The harness (`../media-test/media-browser-test`) is a **BLACK BOX** — run it, read only its result output + exported results JSON; never open its scenario/oracle/tolerance/runner/selection/output-parser/adapter code. Validate against real-world truth (ffmpeg/ffprobe/openssl/mediainfo + specs + our own baked goldens).

## Starting state (2026-07-08 base — RE-MEASURE first, §11.A)

Session 10 landed a large win: catastrophic transcode timeouts + OOM **gone**; active speed deficits 289 → **22**. Remaining tail = **18 functional reds** (2 of them PASS→FAIL regressions Session 10 introduced) + a fixed-overhead speed tail (0 catastrophic · 2 severe · 1 moderate · 19 minor · 1 timeout). This round is **Root-cause B** (real bugs) + **B′** (per-op overhead), **not** the Session-10 non-streaming crisis. The base run is single-sample/partial — regenerate the worklist before trusting a number.

## Red clusters → phase (add a per-fix note as each lands)

| Cluster | Cells | Phase | Note |
|---|---|---|---|
| **P0 — CENC-CTR graceful regressions** | `encryption/cenc_ctr_protection_zeroed_graceful`, `encryption/cenc_ctr_senc_bitflip_graceful` | 11.B | [`cenc-ciphertext-decode-validation.md`](cenc-ciphertext-decode-validation.md) |
| **HLS-AES128 pipeline** | `demux/hls_aes128`, `probe/hls_aes128` | 11.B | [`hls-aes128-iv.md`](hls-aes128-iv.md) — product URL/context paths green; originless/raw-ciphertext boundary defect recorded |
| **Encryption decrypt** | `encryption/cenc_cbcs_decrypt`, `encryption/cenc_cens_decrypt` | 11.C | _pending_ |
| **`.mov` decode + mux** | `decode-seek/decode_mov_h264`, `mux/edge_hevc_decode_mux_mkv`, `mux/size_longform_audio_to_mp4` | 11.C | _pending_ |
| **Probe enum / duration** | `probe/huge_h264_1080p_600s`, `audio-dsp/edge_gapless_aac_decode`, `remux/h264_ts_ts_to_mp4` | 11.C | [`gapless-aac-rotated-fixture.md`](gapless-aac-rotated-fixture.md); probe/remux green |
| **Transcode quality** | `transcode/h264_resize_720p`, `transcode/selfcheck_h264_resize_720p_tie`, `transcode/extreme_fps_1`, `transcode/h264_bitrate_2mbps` | 11.C | [`h264-resize-quality.md`](h264-resize-quality.md); [`h264-2mbps-quality-bound.md`](h264-2mbps-quality-bound.md) |
| **MP4 AAC metadata** | massive/tiny size-ladder + massive probe cells | 11.C | [`mp4-aac-asc-geometry.md`](mp4-aac-asc-geometry.md) — four former reds green, all 8 files independently covered |
| **MP4 VFR mux timing** | monotonic WebCodecs output with stale nominal durations | 11.C | [`mp4-vfr-encoder-mux.md`](mp4-vfr-encoder-mux.md) — 626/626 packets, zero synthetic CTO |
| **Lone timeout (hot path)** | `performance/op-sweep-transcode-webm` | 11.C | _pending_ |
| **VERIFY corpus/golden first** | `probe/h264_1080p_5s` (9.47 vs 6.47), `transcode/h264_crop_center` (portrait crop-rect) | 11.C | _pending_ |
| **Speed — severe** | `performance/size-ladder-iterate-packets-huge` (19.5×), `streaming-output/prop_webm_headerless_duration_materialized` (10.2×) | 11.D | _pending_ |
| **Speed — moderate** | `demux/flac_noseektable` (3.6×) | 11.D | _pending_ |
| **Speed — minor tail (19)** | fixed per-op overhead across families | 11.D | _pending_ |

Rule: every fix passes **all** rotated files for its scenario; a one-file pass is overfitting = FAIL. Correctness (0 FAIL/ERROR/timeout/OOM) outranks every speed win. Fix corpus/golden defects in the harness corpus, never in engine code.
