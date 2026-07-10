# Deficit worklist — functional reds + speed gaps (Chromium)

> **Auto-generated** by `docs/perf/gen-deficits.mjs` from `chromium-2026-07-08T08-48-05-624Z.json + chromium-2026-07-08T16-14-20-821Z.json + chromium-2026-07-08T16-23-11-213Z.json + chromium-2026-07-08T17-47-10-038Z.json + chromium-2026-07-09T19-31-28-117Z.json + chromium-2026-07-09T20-38-13-594Z.json + chromium-2026-07-10T06-42-40-459Z.json`
> (latest included export 2026-07-10T07:02:31.350Z). Re-run the generator against a
> fresher export to refresh. Do not hand-edit the tables.

## Functional reds — fix before any speed work

A FAIL/ERROR (including timeout and OOM) is a functional defect and outranks
every wall-time deficit below. The generator **exits non-zero while any row
remains here**.

| # | Status | Kind | Scenario | Family | File | Reason |
|--:|--------|------|----------|--------|------|--------|
| 1 | FAIL | red | `audio-dsp/edge_gapless_aac_decode` | audio-dsp | `01.mp4` | oracle 'property-invariant' failed: [invariant gapless sample count] decoded samples 52384 vs priming-removed expected 2886720 at 48000Hz (delta 2834336 > 1); d |
| 2 | FAIL | red | `audio-dsp/throughput_decode_s24` | audio-dsp | `01.wav` | oracle 'decoded-audio-pcm' failed: [audio PCM decode] 4096/4096 frame digests differ; frame 0: sha256 2c3498ed…3e41 vs golden c660ee15…0d79; frame 1: sha256 a8b |
| 3 | FAIL | red | `demux/graceful_mp4_header_destroyed` | demux | `03.mp4` | robustness oracle 'graceful-failure' failed: operation produced output from malformed/mutated input (expected a clean throw/reject) |
| 4 | FAIL | red | `demux/graceful_webm_header_destroyed` | demux | `01.webm` | robustness oracle 'graceful-failure' failed: operation produced output from malformed/mutated input (expected a clean throw/reject) |
| 5 | FAIL | red | `mux/edge_hevc_decode_mux_mkv` | mux | `hevc_1080p_10s.mp4` | oracle 'property-invariant' failed: [decode(mux(x))==decode(x)] platform decode of output failed: <video> has zero intrinsic size (not enough data decoded) |
| 6 | FAIL | red | `probe/aac_adts` | probe | `02.aac` | oracle 'golden-metadata' failed: duration: measured 19.9924s vs golden 17.1360s (Δ 2.8564s > tol 2.5704s) [estimate-only container 'adts': loose band max(±0.5s, |
| 7 | ERROR | red | `probe/hls_aes128` | probe | `hls_aes128.m3u8` | not an MPEG-TS stream (no transport sync run found — encrypted, scrambled, or not a transport stream) |
| 8 | FAIL | red | `remux/prop_adts_to_mp4_duration_invariant` | remux | `02.aac` | oracle 'property-invariant' failed: [invariant probe(out).dur≈probe(x).dur] out 19.9920s vs 17.1360s (Δ 2.8560s > 2.5704s) |
| 9 | FAIL | red | `trim/h264_vfr_frame_accurate` | trim | `h264_vfr.mp4` | oracle 'trim-boundaries' failed: duration: out 3.1000s vs requested 3.0000s (Δ 0.1000s > 0.1000s) |
| 10 | FAIL | red | `trim/vp9_noop_full_range_idempotent` | trim | `02.webm` | oracle 'property-invariant' failed: [invariant probe(out).dur≈probe(x).dur] out 10.0000s vs 46.5480s (Δ 36.5480s > 0.0500s) |

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
| `decode-seek/decode_h264_4k` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_h264_first_frames` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/decode_size_tiny_h264_360p` | decode-seek | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `decode-seek/meta_decode_remux_eq_decode_anchored` | decode-seek | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/decode-seek/meta_d |
| `metadata/rotation_survives_mp4_mkv` | metadata | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/metadata/rotation_ |
| `metadata/tagedit_no_corrupt_audio_flac` | metadata | oracle 'property-invariant' unavailable: golden absent: [probe-duration] output duration undeterminable (no mp4/webm con |
| `metadata/tracks_packet_attribution_multitrack` | metadata | oracle 'golden-packets' unavailable: no golden packets (fixtures/golden/<id>.packets.json absent) |
| `metadata/write_flac_vorbiscomment` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_mp3_id3` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `metadata/write_ogg_vorbiscomment` | metadata | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `mux/aac_to_adts` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/edge_bframes_decode_mux_mp4` | mux | oracle 'property-invariant' unavailable: [decode(mux(x))==decode(x)] no golden frames for scenarios/mux/edge_bframes_dec |
| `mux/edge_rotation_decode_mux_mkv` | mux | oracle 'property-invariant' unavailable: [decode(mux(x))==decode(x)] no golden frames for scenarios/mux/edge_rotation_de |
| `mux/h264_aac_to_ts` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/mp3_to_mp3` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/opus_to_ogg` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/prop_h264_decode_mux_mp4_to_mp4` | mux | oracle 'property-invariant' unavailable: [decode(mux(x))==decode(x)] no golden frames for scenarios/mux/prop_h264_decode |
| `mux/prop_h264_mux_duration_mp4_to_ts` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `mux/prop_vp9_decode_mux_webm_to_webm` | mux | oracle 'property-invariant' unavailable: [decode(mux(x))==decode(x)] no golden frames for scenarios/mux/prop_vp9_decode_ |
| `mux/vorbis_to_ogg` | mux | oracle 'property-invariant' unavailable: golden absent: [probe(mux(x)).dur≈probe(x).dur] output duration undeterminable  |
| `performance/decode-fps` | performance | decodeFrames oracle unavailable: no golden frame digests/signatures to compare (frame-bake pending) |
| `remux/aac_adts_adts_to_ts` | remux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `remux/h264_1080p_30s_mp4_to_ts` | remux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `remux/h264_1080p_5s_mov_to_ts` | remux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `remux/h264_in_mkv_mkv_to_ts` | remux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `remux/micro_audio_short_mp4_to_adts` | remux | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `remux/prop_bframes_decode_remux_mp4_mkv` | remux | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/remux/prop_bframes |
| `remux/prop_bframes_decode_remux_mp4_mov` | remux | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/remux/prop_bframes |
| `remux/prop_rotation_survives_mp4_mov` | remux | oracle 'property-invariant' unavailable: [decode(remux(x))==decode(x)] no golden frames for scenarios/remux/prop_rotatio |
| `streaming-output/prop_probe_dur_stream_shape` | streaming-output | oracle 'property-invariant' unavailable: golden absent: [probe-duration] output duration undeterminable (no mp4/webm con |
| `streaming-output/prop_ts_stream_duration_materialized` | streaming-output | oracle 'property-invariant' unavailable: golden absent: [probe-duration] output duration undeterminable (no mp4/webm con |
| `streaming-output/ts_continuity_many_writes` | streaming-output | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `streaming-output/ts_tiny_writes` | streaming-output | oracle 'reference-reimport' unavailable: golden absent: reference-reimport remux needs a golden track/duration layout or |
| `transcode/aac_to_pcm_wav_extract` | transcode | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `transcode/h264_to_ts` | transcode | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `transcode/wav_to_flac` | transcode | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `transcode/wav_to_opus_ogg` | transcode | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `transcode/wav_to_vorbis_ogg` | transcode | oracle 'property-invariant' unavailable: golden absent: [transcode-output-metadata] transcode output metadata not byte-r |
| `trim/audio_aac_adts_copy` | trim | oracle 'trim-boundaries' unavailable: golden absent: trim-boundaries output duration undeterminable (no mp4/webm contain |
| `trim/audio_flac_noseektable_copy` | trim | oracle 'trim-boundaries' unavailable: golden absent: trim-boundaries output duration undeterminable (no mp4/webm contain |
| `trim/audio_flac_seektable_copy` | trim | oracle 'trim-boundaries' unavailable: golden absent: trim-boundaries output duration undeterminable (no mp4/webm contain |
| `trim/audio_mp3_copy` | trim | oracle 'trim-boundaries' unavailable: golden absent: trim-boundaries output duration undeterminable (no mp4/webm contain |
| `trim/audio_opus_ogg_copy` | trim | oracle 'trim-boundaries' unavailable: golden absent: trim-boundaries output duration undeterminable (no mp4/webm contain |
| `trim/ts_keyframe_aligned` | trim | oracle 'trim-boundaries' unavailable: golden absent: trim-boundaries output duration undeterminable (no mp4/webm contain |

## Speed deficits

A cell is a *deficit* iff, on Chromium, we and at least one
competitor **both PASS the identical golden oracle** (same work) and the
competitor's median wall-time is lower than ours. NA/FAIL cells and cells no
rival timed are excluded — so every row below is an honest, same-work loss.

## Headline

- **Functional reds (FAIL/ERROR/timeout/OOM): 10** — 0 timeout · 0 OOM · 10 other
- **Bake-blocked (harness NA_ASSET):** 64
- **Contested scenarios** (we + ≥1 rival both timed & passing): **251**
- **Active deficits where a rival is faster than us: 12 (5%)**
- **ADR-backed parity exemptions:** 0
- **Raw faster-rival rows before exemptions:** 12 (5%)
- Severity split: **1 catastrophic** (≥100×) · **0 severe** (10–100×) · **0 moderate** (3–10×) · **11 minor** (<3×)

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
This explains the 11 "minor" losses smeared across *every* family.

Fixing **A** collapses the tail of the distribution; fixing **B** shifts the whole
curve left. Attack **A first** (algorithmic, few code paths, 100–1000× cells),
then **B** (profile the ~100 ms floor on a trivial op and amortize it).

## Deficits by family

| Family | # deficits | Worst slowdown |
|--------|-----------:|---------------:|
| decode-seek | 5 | 2× |
| transcode | 2 | 2× |
| probe | 2 | 2× |
| performance | 1 | 105× |
| demux | 1 | 1× |
| streaming-output | 1 | 1× |

## Tier 1 — Catastrophic (≥100× slower) — fix first

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|
| 1 | `performance/size-ladder-iterate-packets-huge` | performance | 828.1 | remotion-webcodecs | 7.9 | 104.6× |

## Tier 2 — Severe (10–100× slower)

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|

## Tier 3 — Moderate (3–10× slower)

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|

## Tier 4 — Minor (<3× slower) — the long tail (mostly root-cause B)

| # | Scenario | Family | Ours (ms) | Fastest rival | Theirs (ms) | Slowdown |
|--:|----------|--------|----------:|---------------|------------:|---------:|
| 1 | `decode-seek/decode_vp9_alpha` | decode-seek | 252.2 | mediabunny | 123.5 | 2.0× |
| 2 | `decode-seek/decode_size_large_vp9_120s` | decode-seek | 1359.7 | ffmpeg.wasm | 666.7 | 2.0× |
| 3 | `decode-seek/decode_mov_h264` | decode-seek | 538.6 | ffmpeg.wasm | 272.2 | 2.0× |
| 4 | `transcode/h264_resize_720p` | transcode | 756.3 | remotion-webcodecs | 433.0 | 1.7× |
| 5 | `decode-seek/decode_size_tiny_vp9_360p` | decode-seek | 103.3 | mediabunny | 61.8 | 1.7× |
| 6 | `probe/recorder_headerless` | probe | 4.7 | mediabunny | 2.9 | 1.6× |
| 7 | `transcode/hevc_to_vp9_webm` | transcode | 1859.8 | mediabunny | 1356.8 | 1.4× |
| 8 | `decode-seek/seek_vp9_keyframe` | decode-seek | 49.7 | mediabunny | 37.3 | 1.3× |
| 9 | `probe/longform_1h_audio` | probe | 66.0 | mediabunny | 50.2 | 1.3× |
| 10 | `demux/vp9_1080p_10s` | demux | 118.7 | mediabunny | 100.8 | 1.2× |
| 11 | `streaming-output/prop_webm_headerless_duration_materialized` | streaming-output | 8.1 | mediabunny | 7.1 | 1.1× |

## ADR-backed parity exemptions

_No parity exemptions are currently recorded._
