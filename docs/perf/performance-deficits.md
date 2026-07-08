# Deficit worklist — functional reds + speed gaps (Chromium)

> **Auto-generated** by `docs/perf/gen-deficits.mjs` from `chromium-2026-07-08T08-48-05-624Z.json + chromium-2026-07-08T16-14-20-821Z.json + chromium-2026-07-08T16-23-11-213Z.json`
> (latest included export 2026-07-08T16:29:04.830Z). Re-run the generator against a
> fresher export to refresh. Do not hand-edit the tables.

## Functional reds — fix before any speed work

A FAIL/ERROR (including timeout and OOM) is a functional defect and outranks
every wall-time deficit below. The generator **exits non-zero while any row
remains here**.

| # | Status | Kind | Scenario | Family | File | Reason |
|--:|--------|------|----------|--------|------|--------|
| 1 | FAIL | red | `audio-dsp/edge_gapless_aac_decode` | audio-dsp | `02.mp4` | oracle 'property-invariant' failed: [invariant gapless sample count] decoded samples 48128 vs priming-removed expected 2654203 at 44100Hz (delta 2606075 > 1); d |
| 2 | FAIL | red | `decode-seek/decode_mov_h264` | decode-seek | `03.mov` | oracle 'ssim-psnr' failed: SSIM min 0.8539 < 0.99 (mean 0.9350); 0/12 frames digest-exact |
| 3 | FAIL | red | `encryption/cenc_cbcs_decrypt` | encryption | `03.mp4` | oracle 'property-invariant' failed: [decrypt-eq-cleartext-decode] 23/24 frame digests differ; frame 1: sha256 0521dbf3…2fc8 vs golden dbbc7607…388d; frame 2: sh |
| 4 | FAIL | red | `encryption/cenc_cens_decrypt` | encryption | `02.mp4` | oracle 'playback-smoke' failed: <video> playback did not advance / failed to play the output |
| 5 | FAIL | red | `encryption/cenc_ctr_protection_zeroed_graceful` | encryption | `cenc_ctr_protection_zeroed.mp4` | robustness oracle 'graceful-failure' failed: operation produced output from malformed/mutated input (expected a clean throw/reject) |
| 6 | FAIL | red | `encryption/cenc_ctr_senc_bitflip_graceful` | encryption | `cenc_ctr_senc_bitflip.mp4` | robustness oracle 'graceful-failure' failed: operation produced output from malformed/mutated input (expected a clean throw/reject) |
| 7 | FAIL | red | `mux/edge_hevc_decode_mux_mkv` | mux | `hevc_1080p_10s.mp4` | oracle 'property-invariant' failed: [decode(mux(x))==decode(x)] platform decode of output failed: <video> has zero intrinsic size (not enough data decoded) |
| 8 | ERROR | red | `mux/size_longform_audio_to_mp4` | mux | `03.mp4` | track 1 has no samples to stream-copy |
| 9 | FAIL | timeout | `performance/op-sweep-transcode-webm` | performance | `h264_1080p_30s.mp4` | timeout: operation exceeded timeout of 120000ms |
| 10 | FAIL | red | `probe/h264_1080p_5s` | probe | `01.mov` | oracle 'golden-metadata' failed: duration: measured 9.4667s vs golden 6.4670s (Δ 2.9997s > tol 0.0417s) |
| 11 | ERROR | red | `probe/hls_aes128` | probe | `hls_aes128.m3u8` | not an MPEG-TS stream (no transport sync run found — encrypted, scrambled, or not a transport stream) |
| 12 | FAIL | red | `probe/huge_h264_1080p_600s` | probe | `01.mov` | oracle 'golden-metadata' failed: track count: measured 2 vs golden 3; track[1].type: 'audio' vs 'other'; track[1].codec: 'aac' vs '' |
| 13 | FAIL | red | `remux/h264_ts_ts_to_mp4` | remux | `02.ts` | oracle 'reference-reimport' failed: duration: reimport 10.0100s vs golden 10.1290s (Δ 0.1190s > tol 0.1000s) |
| 14 | FAIL | red | `transcode/extreme_fps_1` | transcode | `02.mp4` | oracle 'property-invariant' failed: [invariant probe(out).dur≈probe(x).dur] out 23.0000s vs 22.5070s (Δ 0.4930s > 0.1500s) |
| 15 | ERROR | red | `transcode/h264_crop_center` | transcode | `03.mp4` | crop rect 240,135 1440×810 is outside the 1080×1920 source |
| 16 | FAIL | red | `transcode/h264_resize_720p` | transcode | `03.mp4` | oracle 'ssim-psnr' failed: vs in-browser reference (source decoded + resized to 1280x720): SSIM mean 0.9684 (min 0.9617); PSNR mean 29.0 dB (advisory) over 8 fr |
| 17 | FAIL | red | `transcode/selfcheck_h264_resize_720p_tie` | transcode | `03.mp4` | oracle 'ssim-psnr' failed: vs in-browser reference (source decoded + resized to 1280x720): SSIM mean 0.9684 (min 0.9617); PSNR mean 29.0 dB (advisory) over 8 fr |

### Bake-blocked cells (harness-side `NA_ASSET`: golden absent — run the harness bake, not a code fix)

| Scenario | Family | Reason |
|----------|--------|--------|
| `audio-dsp/downmix_5_1_to_stereo` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/downmix_stereo_to_mono` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_longform_audio_resample_16k` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/edge_variable_channel_count_downmix` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/fade_in_out_f32` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/gain_half_f32` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/gain_minus6db_s16` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_f32_to_s16` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_s16_to_f32` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_s16be_to_s16le` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_s24_to_f32` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_s24_to_s16` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/pcm_s24be_to_s16le` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_44k1_to_48k` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_48k_to_16k` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/resample_48k_to_44k1` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/throughput_encode_s24` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_mono_to_stereo` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `audio-dsp/upmix_stereo_to_5_1` | audio-dsp | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `decode-seek/decode_bframes_reorder` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_h264_first_frames` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_size_huge_h264_600s` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `metadata/rotation_survives_mp4_mkv` | metadata | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/metadata/rotation_ |
| `metadata/tagedit_no_corrupt_audio_flac` | metadata | oracle 'property-invariant' unavailable: golden absent: [probe-duration] output duration undeterminable (no mp4/webm con |
| `metadata/write_flac_vorbiscomment` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_mp3_id3` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `mux/aac_to_adts` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/edge_bframes_decode_mux_mkv` | mux | oracle 'property-invariant' unavailable: [decode(mux(x))==decode(x)] no golden frames for scenarios/mux/edge_bframes_dec |
| `mux/edge_rotation_decode_mux_mov` | mux | oracle 'property-invariant' unavailable: [decode(mux(x))==decode(x)] no golden frames for scenarios/mux/edge_rotation_de |
| `mux/h264_aac_to_ts` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/mp3_to_mp3` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/opus_to_ogg` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/prop_h264_decode_mux_mp4_to_mp4` | mux | oracle 'property-invariant' unavailable: [decode(mux(x))==decode(x)] no golden frames for scenarios/mux/prop_h264_decode |
| `mux/prop_h264_mux_duration_mp4_to_ts` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/prop_vp9_decode_mux_webm_to_webm` | mux | oracle 'property-invariant' unavailable: [decode(mux(x))==decode(x)] no golden frames for scenarios/mux/prop_vp9_decode_ |
| `mux/vorbis_to_ogg` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `remux/aac_adts_adts_to_ts` | remux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `remux/h264_1080p_30s_mp4_to_ts` | remux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `remux/h264_1080p_5s_mov_to_ts` | remux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `remux/h264_in_mkv_mkv_to_ts` | remux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `remux/micro_audio_short_mp4_to_adts` | remux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `remux/prop_bframes_decode_remux_mp4_mkv` | remux | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/remux/prop_bframes |
| `remux/prop_bframes_decode_remux_mp4_mov` | remux | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/remux/prop_bframes |
| `remux/prop_roundtrip_mp4_mkv_mp4` | remux | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/remux/prop_roundtr |
| `transcode/aac_to_pcm_wav_extract` | transcode | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `transcode/h264_to_ts` | transcode | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `transcode/wav_to_flac` | transcode | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `transcode/wav_to_opus_ogg` | transcode | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `transcode/wav_to_vorbis_ogg` | transcode | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `trim/audio_flac_seektable_copy` | trim | oracle 'trim-boundaries' unavailable: golden absent: trim-boundaries output duration undeterminable (no mp4/webm contain |

## Speed deficits

A cell is a *deficit* iff, on Chromium, we and at least one
competitor **both PASS the identical golden oracle** (same work) and the
competitor's median wall-time is lower than ours. NA/FAIL cells and cells no
rival timed are excluded — so every row below is an honest, same-work loss.

## Headline

- **Functional reds (FAIL/ERROR/timeout/OOM): 17** — 1 timeout · 0 OOM · 16 other
- **Bake-blocked (harness NA_ASSET):** 50
- **Contested scenarios** (we + ≥1 rival both timed & passing): **190**
- **Active deficits where a rival is faster than us: 22 (12%)**
- **ADR-backed parity exemptions:** 0
- **Raw faster-rival rows before exemptions:** 22 (12%)
- Severity split: **0 catastrophic** (≥100×) · **2 severe** (10–100×) · **1 moderate** (3–10×) · **19 minor** (<3×)

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

**B. High fixed per-operation overhead.** On tiny inputs we are still often
5–30× slower even though the real work is microseconds — especially micro mux,
probe, demux, and one-frame decode/seek rows where init / WASM / WebCodecs
config / worker spin-up / buffer copies with no reuse can dominate the useful
work.
This explains the 19 "minor" losses smeared across *every* family.

Fixing **A** collapses the tail of the distribution; fixing **B** shifts the whole
curve left. Attack **A first** (algorithmic, few code paths, 100–1000× cells),
then **B** (profile the ~100 ms floor on a trivial op and amortize it).

## Deficits by family

| Family | # deficits | Worst slowdown |
|--------|-----------:|---------------:|
| demux | 7 | 4× |
| decode-seek | 4 | 2× |
| transcode | 3 | 1× |
| streaming-output | 2 | 10× |
| probe | 2 | 2× |
| performance | 1 | 20× |
| metadata | 1 | 3× |
| trim | 1 | 1× |
| remux | 1 | 1× |

## Tier 1 — Catastrophic (≥100× slower) — fix first

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|

## Tier 2 — Severe (10–100× slower)

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|
| 1 | `performance/size-ladder-iterate-packets-huge` | performance | 154.8 | remotion-webcodecs | 7.9 | 19.5× |
| 2 | `streaming-output/prop_webm_headerless_duration_materialized` | streaming-output | 72.5 | mediabunny | 7.1 | 10.2× |

## Tier 3 — Moderate (3–10× slower)

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|
| 1 | `demux/flac_noseektable` | demux | 39.5 | remotion-webcodecs | 11.0 | 3.6× |

## Tier 4 — Minor (<3× slower) — the long tail (mostly root-cause B)

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|
| 1 | `metadata/meta_consistent_mp4_to_mkv` | metadata | 332.3 | mediabunny | 120.4 | 2.8× |
| 2 | `streaming-output/mp4_fragmented_cmaf` | streaming-output | 1132.1 | mp4box | 534.7 | 2.1× |
| 3 | `decode-seek/decode_size_large_vp9_120s` | decode-seek | 1282.4 | ffmpeg.wasm | 666.7 | 1.9× |
| 4 | `decode-seek/decode_size_tiny_vp9_360p` | decode-seek | 108.7 | mediabunny | 61.8 | 1.8× |
| 5 | `demux/flac_seektable` | demux | 60.3 | remotion-webcodecs | 36.5 | 1.7× |
| 6 | `probe/longform_1h_audio` | probe | 81.5 | mediabunny | 50.2 | 1.6× |
| 7 | `demux/h264_bframes_1080p` | demux | 109.3 | mp4box | 78.3 | 1.4× |
| 8 | `probe/recorder_headerless` | probe | 3.9 | mediabunny | 2.9 | 1.4× |
| 9 | `transcode/h264_rotate_normalize` | transcode | 561.0 | remotion-webcodecs | 421.9 | 1.3× |
| 10 | `transcode/hevc_to_vp9_webm` | transcode | 1696.2 | mediabunny | 1356.8 | 1.3× |
| 11 | `demux/vp9_1080p_10s` | demux | 123.4 | mediabunny | 100.8 | 1.2× |
| 12 | `trim/h264_multitrack_keyframe_aligned` | trim | 89.2 | ffmpeg.wasm | 73.2 | 1.2× |
| 13 | `decode-seek/decode_h264_4k` | decode-seek | 2411.9 | remotion-webcodecs | 2033.1 | 1.2× |
| 14 | `demux/size_tiny_tiny_vp9_360p_2s` | demux | 26.0 | remotion-webcodecs | 22.3 | 1.2× |
| 15 | `remux/h264_1080p_5s_mov_to_mp4` | remux | 20.7 | mp4box | 18.0 | 1.1× |
| 16 | `demux/opus` | demux | 41.4 | mediabunny | 37.3 | 1.1× |
| 17 | `demux/size_micro_micro_h264_1frame` | demux | 36.4 | mp4box | 34.6 | 1.1× |
| 18 | `transcode/extreme_fps_240` | transcode | 8963.7 | mediabunny | 8680.9 | 1.0× |
| 19 | `decode-seek/decode_size_large_h264_120s` | decode-seek | 4522.2 | web-demuxer | 4463.5 | 1.0× |

## ADR-backed parity exemptions

_No parity exemptions are currently recorded._
